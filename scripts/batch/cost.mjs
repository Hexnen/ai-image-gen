// Stawki batch (USD / token) i koszt z usage. Port z roleplay workshopBatch/cost.ts.
// OpenAI batch = sync ÷ 2: text-in $2.50, image-in $4, image-out $15 za 1M tok.
export const OPENAI_BATCH_TEXT_IN = 2.5 / 1e6;
export const OPENAI_BATCH_IMAGE_IN = 4 / 1e6;
export const OPENAI_BATCH_OUT = 15 / 1e6;

const GEMINI_BATCH = {
  nano: { in: 0.125 / 1e6, outImage: 15 / 1e6, outText: 0.75 / 1e6 },
  flash: { in: 0.25 / 1e6, outImage: 30 / 1e6, outText: 1.5 / 1e6 },
  pro: { in: 1.0 / 1e6, outImage: 60 / 1e6, outText: 6.0 / 1e6 },
};

export function geminiTierOf(model = "") {
  const m = String(model).toLowerCase();
  if (m.includes("pro")) return "pro";
  if (m.includes("lite")) return "nano";
  if (m.includes("flash")) return "flash";
  return "nano";
}

/** Koszt jednej odpowiedzi Gemini z usageMetadata (batch). Brak rozbicia → całość jak obraz. */
export function geminiBatchCost(u, model) {
  const r = GEMINI_BATCH[geminiTierOf(model)];
  const inTok = Number(u?.promptTokenCount ?? u?.prompt_token_count) || 0;
  const outTok = Number(u?.candidatesTokenCount ?? u?.candidates_token_count) || 0;
  const details = u?.candidatesTokensDetails ?? u?.candidates_tokens_details ?? [];
  const outImg = Array.isArray(details)
    ? details.filter((d) => d?.modality === "IMAGE").reduce((s, d) => s + (Number(d?.tokenCount ?? d?.token_count) || 0), 0)
    : 0;
  const img = outImg || outTok;
  const text = Math.max(0, outTok - img);
  return inTok * r.in + img * r.outImage + text * r.outText;
}

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

const QUALITY_FACTOR = { low: 0.3, medium: 1, high: 4 };

/**
 * SZACUNEK kosztu batcha przed wysłaniem (do limitów). Przybliżenie: ~1372 tok. wyjścia
 * (zmierzone w roleplay dla 1024x1536 medium), ~1536 tok. na obraz wejściowy.
 */
export function estimateBatchCost(provider, model, items) {
  let total = 0;
  for (const it of items) {
    const refs = it.refs?.length ?? 0;
    if (provider === "openai") {
      const q = QUALITY_FACTOR[it.quality ?? "medium"] ?? 1;
      total += 1372 * q * OPENAI_BATCH_OUT + refs * 1536 * OPENAI_BATCH_IMAGE_IN + 150 * OPENAI_BATCH_TEXT_IN;
    } else if (provider === "gemini") {
      const r = GEMINI_BATCH[geminiTierOf(model)];
      total += 1120 * r.outImage + (260 * refs + 150) * r.in;
    }
  }
  return total;
}
