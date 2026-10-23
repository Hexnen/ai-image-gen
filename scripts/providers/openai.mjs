// OpenAI Images (gpt-image-*) bezpośrednio. Port z roleplay imageGen/openai.ts.
// Bez refs: JSON /images/generations; z refs: multipart /images/edits (max 16).
import { GPT_IMAGE_TIMEOUT_MS, withTimeout, httpError, b64ToBlob, mimeOf } from "./util.mjs";
import { OPENAI_RATES, openaiSizeFor, fitOpenAIQuality, bucketOpenAISize } from "./models.mjs";

export const OPENAI_BASE = "https://api.openai.com/v1";
const EDIT_REF_LIMIT = 16;

// Stawki za token (USD): gpt-image-2 i gpt-image-2.5 mają te same (OPENAI_RATES w models.mjs).
const TXT_IN = OPENAI_RATES.sync.textIn / 1e6, IMG_IN = OPENAI_RATES.sync.imageIn / 1e6, IMG_OUT = OPENAI_RATES.sync.imageOut / 1e6;
// Fallback per obraz, gdy brak usage.
const PRICES = {
  low: { "1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005 },
  medium: { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 },
  high: { "1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165 },
};

/** Zachowane dla zgodności: rozmiar-koszyk (starsze modele). */
export const pickSize = ({ width, height, aspectRatio }) => bucketOpenAISize(width, height, aspectRatio);

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, quality = "medium", n = 1, signal }) {
  quality = fitOpenAIQuality(model, quality);
  n = Math.max(1, Math.min(10, Math.floor(Number(n)) || 1));
  if (refs.length > EDIT_REF_LIMIT) {
    throw new Error(`OpenAI ${model}: ${refs.length} referencji przekracza limit /images/edits (${EDIT_REF_LIMIT}).`);
  }
  // 2.5: dokładny rozmiar po normalizacji (×16, limity API); starsze: 3 koszyki.
  const size = openaiSizeFor(model, { width, height, aspectRatio });
  let res;
  const route = refs.length ? "images/edits" : "images/generations";
  if (refs.length) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    form.set("size", size);
    form.set("quality", quality);
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
      signal: withTimeout(GPT_IMAGE_TIMEOUT_MS, signal),
    });
  } else {
    res = await fetch(`${OPENAI_BASE}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, size, quality, n }),
      signal: withTimeout(GPT_IMAGE_TIMEOUT_MS, signal),
    });
  }
  if (!res.ok) throw await httpError(`OpenAI ${model}`, res);
  const json = await res.json();
  const blobs = (json?.data ?? []).map((d) => d?.b64_json).filter(Boolean).map((b64) => b64ToBlob(b64, "image/png"));
  if (!blobs.length) throw new Error(`OpenAI: brak b64_json w odpowiedzi (${JSON.stringify(json).slice(0, 300)})`);
  // usage obejmuje wszystkie obrazy żądania: cost = koszt CAŁEGO żądania (n obrazów).
  return { blob: blobs[0], blobs, cost: costOf(json, quality, size, blobs.length), raw: json, route };
}

function costOf(json, quality, size, count = 1) {
  const inTok = Number(json?.usage?.input_tokens), outTok = Number(json?.usage?.output_tokens);
  const det = json?.usage?.input_tokens_details;
  const img = Number(det?.image_tokens), txt = Number(det?.text_tokens);
  const inCost = isFinite(img) && isFinite(txt) && img + txt > 0 ? img * IMG_IN + txt * TXT_IN : (inTok || 0) * IMG_IN;
  if (isFinite(inTok) && isFinite(outTok) && inTok + outTok > 0) return inCost + outTok * IMG_OUT;
  return (PRICES[quality]?.[size] ?? 0) * count;
}
