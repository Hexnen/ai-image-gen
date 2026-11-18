// OpenAI Images (gpt-image-2.6-flare / -sunburst, gpt-image-2.5-flare / -sunburst) bezpośrednio. Port z roleplay imageGen/openai.ts.
// Bez refs: JSON /images/generations; z refs: multipart /images/edits (max 16; dla 2.6 niezweryfikowane, wg resellera 1–16).
// 2.6 dostaje te same pola co 2.5 (model, prompt, size, quality, n, background/output_format). Nie wysyłamy `complexity`
// (pominięte = "high" wg przewodnika OpenAI), partial_images, SVG ani GIF.
import { GPT_IMAGE_TIMEOUT_MS, withTimeout, scaledTimeout, httpError, b64ToBlob, mimeOf } from "./util.mjs";
import { OPENAI_RATES, openaiSizeFor, fitOpenAIQuality, openaiPriceFloor, supportsTransparent } from "./models.mjs";
import { estimateSyncCost } from "../batch/cost.mjs";

export const OPENAI_BASE = "https://api.openai.com/v1";
const EDIT_REF_LIMIT = 16;

// Stawki za token (USD): OPENAI_RATES w models.mjs.
const TXT_IN = OPENAI_RATES.sync.textIn / 1e6, IMG_IN = OPENAI_RATES.sync.imageIn / 1e6, IMG_OUT = OPENAI_RATES.sync.imageOut / 1e6;
// Fallback per obraz, gdy brak usage: openaiPriceFloor (models.mjs) albo szacunek tokenowy, co wyższe.

// Mnożniki czasu generacji względem medium (dłuższe jakości i większe obrazy mielą dłużej).
const TIME_FACTOR = { low: 1, medium: 1, high: 1.5, xhigh: 2.5, max: 3.5, auto: 1.5 };
function requestTimeout(quality, size, n) {
  const [w, h] = size.split("x").map(Number);
  const area = Math.max(1, (w * h) / (1536 * 1024));
  return scaledTimeout(GPT_IMAGE_TIMEOUT_MS, { n, factor: (TIME_FACTOR[quality] ?? 1) * area, max: 600_000 });
}

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, quality = "medium", n = 1, transparent = false, signal }) {
  // `background: "transparent"` only for models that take it; it needs PNG (or WebP) output, so we ask for PNG.
  const alpha = !!transparent && supportsTransparent("openai", model);
  quality = fitOpenAIQuality(model, quality);
  n = Math.max(1, Math.min(10, Math.floor(Number(n)) || 1));
  if (refs.length > EDIT_REF_LIMIT) {
    throw new Error(`OpenAI ${model}: ${refs.length} referencji przekracza limit /images/edits (${EDIT_REF_LIMIT}).`);
  }
  // Dokładny rozmiar po normalizacji do reguł API (×16, limity).
  const size = openaiSizeFor(model, { width, height, aspectRatio });
  let res;
  const route = refs.length ? "images/edits" : "images/generations";
  if (refs.length) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    form.set("size", size);
    form.set("quality", quality);
    if (alpha) { form.set("background", "transparent"); form.set("output_format", "png"); }
    if (n > 1) form.set("n", String(n));
    let i = 0;
    for (const blob of refs) {
      const mime = await mimeOf(blob);
      const ext = mime === "image/webp" ? "webp" : mime === "image/jpeg" ? "jpg" : "png";
      form.append("image[]", new Blob([blob], { type: mime }), `ref${++i}.${ext}`);
    }
    res = await fetch(`${OPENAI_BASE}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: withTimeout(requestTimeout(quality, size, n), signal),
    });
  } else {
    res = await fetch(`${OPENAI_BASE}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, size, quality, n, ...(alpha ? { background: "transparent", output_format: "png" } : {}) }),
      signal: withTimeout(requestTimeout(quality, size, n), signal),
    });
  }
  if (!res.ok) throw await httpError(`OpenAI ${model}`, res);
  const json = await res.json();
  const blobs = (json?.data ?? []).map((d) => d?.b64_json).filter(Boolean).map((b64) => b64ToBlob(b64, "image/png"));
  if (!blobs.length) throw new Error(`OpenAI: brak b64_json w odpowiedzi (${JSON.stringify(json).slice(0, 300)})`);
  // usage obejmuje wszystkie obrazy żądania: cost = koszt CAŁEGO żądania (n obrazów).
  const { cost, estimated } = costOf(model, json, quality, size, blobs.length);
  return { blob: blobs[0], blobs, cost, ...(estimated ? { costEstimated: true } : {}), raw: json, route };
}

function costOf(model, json, quality, size, count = 1) {
  const inTok = Number(json?.usage?.input_tokens), outTok = Number(json?.usage?.output_tokens);
  const det = json?.usage?.input_tokens_details;
  const img = Number(det?.image_tokens), txt = Number(det?.text_tokens);
  const inCost = isFinite(img) && isFinite(txt) && img + txt > 0 ? img * IMG_IN + txt * TXT_IN : (inTok || 0) * IMG_IN;
  if (isFinite(inTok) && isFinite(outTok) && inTok + outTok > 0) return { cost: inCost + outTok * IMG_OUT, estimated: false };
  // Brak usage: nigdy 0 — tabela cen (skalowana polem dla nowych rozmiarów/jakości) albo szacunek tokenowy.
  const [w, h] = size.split("x").map(Number);
  const per = Math.max(openaiPriceFloor(quality, w, h, model), estimateSyncCost("openai", model, [{ quality, width: w, height: h }]));
  return { cost: per * count, estimated: true };
}
