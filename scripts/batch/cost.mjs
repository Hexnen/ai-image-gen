import { OPENAI_RATES, getModel, fitGeminiSize, fitOpenAIQuality, openaiSizeFor, openaiPriceFloor, openai25OutputTokens, isOpenAI25, openrouterEstimate } from "../providers/models.mjs";

// Stawki batch (USD / token) i koszt z usage. Port z roleplay workshopBatch/cost.ts.
// OpenAI batch = sync ÷ 2: text-in $2.50, image-in $4, image-out $15 za 1M tok.
// gpt-image-2.5 ma te same stawki (OPENAI_RATES w providers/models.mjs).
export const OPENAI_BATCH_TEXT_IN = OPENAI_RATES.batch.textIn / 1e6;
export const OPENAI_BATCH_IMAGE_IN = OPENAI_RATES.batch.imageIn / 1e6;
export const OPENAI_BATCH_OUT = OPENAI_RATES.batch.imageOut / 1e6;

// Stawki batch Gemini (USD / token) wg modelu (oficjalny cennik 2026-10; tier z models.mjs).
const GEMINI_BATCH = {
  nb21: { in: 0.75 / 1e6, outImage: 15 / 1e6, outText: 3.75 / 1e6 },
  nano: { in: 0.125 / 1e6, outImage: 15 / 1e6, outText: 0.75 / 1e6 },
  flash: { in: 0.25 / 1e6, outImage: 30 / 1e6, outText: 1.5 / 1e6 },
  pro: { in: 1.0 / 1e6, outImage: 60 / 1e6, outText: 6.0 / 1e6 },
};

export function geminiTierOf(model = "") {
  const m = String(model).toLowerCase();
  if (m.includes("nano-banana-2.1")) return "nb21";
  if (m.includes("pro")) return "pro";
  if (m.includes("lite")) return "nano";
  if (m.includes("flash")) return "flash";
  return "pro"; // nieznany model Gemini: ostrożnie jak najdroższy tier
}

const num = (...v) => { for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n > 0) return n; } return 0; };

/**
 * Koszt jednej odpowiedzi Gemini z usageMetadata (stawki batch). Brak rozbicia → całość jak obraz.
 * Tokeny „thinking" (thoughtsTokenCount) rozliczane są jak wyjście tekstowe; działa też dla wiersza
 * bez obrazu (odmowa/sam tekst), bo tokeny i tak zostały naliczone. Alternatywne nazwy pól
 * (Interactions API: input_tokens/output_tokens) są NIEZWERYFIKOWANE.
 */
export function geminiBatchCost(u, model) {
  const r = GEMINI_BATCH[geminiTierOf(model)];
  const inTok = num(u?.promptTokenCount, u?.prompt_token_count, u?.total_input_tokens, u?.input_tokens);
  const outTok = num(u?.candidatesTokenCount, u?.candidates_token_count, u?.total_output_tokens, u?.output_tokens);
  const thoughts = num(u?.thoughtsTokenCount, u?.thoughts_token_count, u?.total_thought_tokens, u?.thought_tokens);
  const details = u?.candidatesTokensDetails ?? u?.candidates_tokens_details ?? [];
  const outImg = Array.isArray(details)
    ? details.filter((d) => d?.modality === "IMAGE").reduce((s, d) => s + (Number(d?.tokenCount ?? d?.token_count) || 0), 0)
    : 0;
  const img = outImg || outTok;
  const text = Math.max(0, outTok - img);
  return inTok * r.in + img * r.outImage + (text + thoughts) * r.outText;
}

/** Koszt odpowiedzi Gemini SYNC z usage: stawki standard = 2× batch (zgodne z cennikiem). */
export const geminiSyncCost = (u, model) => geminiBatchCost(u, model) * 2;

/** Koszt jednej odpowiedzi OpenAI batch z usage (rozbicie text/image gdy jest). */
export function openaiBatchCost(u) {
  const inTok = Number(u?.input_tokens) || 0;
  const outTok = Number(u?.output_tokens) || 0;
  const det = u?.input_tokens_details;
  const img = Number(det?.image_tokens);
  const txt = Number(det?.text_tokens);
  const inCost = isFinite(img) && isFinite(txt) && img + txt > 0
    ? img * OPENAI_BATCH_IMAGE_IN + txt * OPENAI_BATCH_TEXT_IN
    : inTok * OPENAI_BATCH_IMAGE_IN;
  return inCost + outTok * OPENAI_BATCH_OUT;
}

// Mnożniki liczby tokenów wyjścia względem "medium" dla gpt-image-2 i starszych (z roleplay; rodzina 2.5 ma własną
// tabelę tokenów w models.mjs, a xhigh/max nie istnieją poza nią).
const QUALITY_FACTOR = { low: 0.3, medium: 1, high: 4, auto: 1 };
const BASE_PIXELS = 1024 * 1536; // 1372 tok. zmierzone w roleplay dla 1024x1536 medium

/**
 * SZACUNEK kosztu batcha przed wysłaniem (do limitów). OpenAI: tokeny skalowane jakością i
 * polem obrazu; Gemini: tokeny wg rozmiaru z katalogu modeli, ~260 tok. na obraz wejściowy.
 */
export function estimateBatchCost(provider, model, items) {
  let total = 0;
  for (const it of items) {
    const refs = it.refs?.length ?? 0;
    if (provider === "openai") {
      const quality = fitOpenAIQuality(model, it.quality ?? "medium");
      const [w, h] = openaiSizeFor(model, { width: it.width, height: it.height }).split("x").map(Number);
      let outCost;
      if (isOpenAI25(model)) {
        // 2.5: tokeny z pomiarów niezależnych testerów (models.mjs), bez skalowania liniowego po polu
        outCost = openai25OutputTokens(quality, w, h) * OPENAI_BATCH_OUT;
      } else {
        const q = QUALITY_FACTOR[quality] ?? 1;
        const area = (w * h) / BASE_PIXELS;
        // dolna granica: tabela cen sync / 2 (szacunek tokenowy zaniżał kwadrat ~2×)
        outCost = Math.max(1372 * q * area * OPENAI_BATCH_OUT, openaiPriceFloor(quality, w, h, model) / 2);
      }
      total += outCost + refs * 1536 * OPENAI_BATCH_IMAGE_IN + 150 * OPENAI_BATCH_TEXT_IN;
    } else if (provider === "gemini") {
      const r = GEMINI_BATCH[geminiTierOf(model)];
      const m = getModel("gemini", model);
      const tokens = m?.tokens?.[fitGeminiSize(model, it.imageSize)] ?? 2000; // nieznany model: ostrożnie
      total += tokens * r.outImage + (260 * refs + 150) * r.in;
    }
  }
  return total;
}

/**
 * SZACUNEK kosztu żądania SYNC (Fast) do limitów: OpenAI/Gemini = 2× batch (stawki standard);
 * OpenRouter nie ma cennika w kodzie, więc stała ostrożna kwota za obraz (openrouterEstimate).
 */
export function estimateSyncCost(provider, model, items) {
  if (provider === "openrouter") return items.length * openrouterEstimate(model);
  return estimateBatchCost(provider, model, items) * 2;
}
