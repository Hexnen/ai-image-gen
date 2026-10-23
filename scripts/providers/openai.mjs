// OpenAI Images (gpt-image-*) bezpośrednio. Port z roleplay imageGen/openai.ts.
// Bez refs: JSON /images/generations; z refs: multipart /images/edits (max 16).
import { GPT_IMAGE_TIMEOUT_MS, withTimeout, httpError, b64ToBlob, mimeOf } from "./util.mjs";

export const OPENAI_BASE = "https://api.openai.com/v1";
const SIZES = ["1024x1024", "1024x1536", "1536x1024"];
const EDIT_REF_LIMIT = 16;

// Stawki za token (USD), cennik OpenAI gpt-image-2 (wg roleplay 2026-07-15).
const TXT_IN = 5 / 1e6, IMG_IN = 8 / 1e6, IMG_OUT = 30 / 1e6;
// Fallback per obraz, gdy brak usage.
const PRICES = {
  low: { "1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005 },
  medium: { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 },
  high: { "1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165 },
};

/** width/height/aspectRatio -> jeden z trzech rozmiarów API. */
export function pickSize({ width, height, aspectRatio }) {
  if (width && height && SIZES.includes(`${width}x${height}`)) return `${width}x${height}`;
  let r = 1;
  if (width && height) r = width / height;
  else if (aspectRatio && /^\d+:\d+$/.test(aspectRatio)) { const [w, h] = aspectRatio.split(":").map(Number); r = w / h; }
  return r > 1.2 ? "1536x1024" : r < 0.83 ? "1024x1536" : "1024x1024";
}

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, quality = "medium", signal }) {
  if (refs.length > EDIT_REF_LIMIT) {
    throw new Error(`OpenAI ${model}: ${refs.length} referencji przekracza limit /images/edits (${EDIT_REF_LIMIT}).`);
  }
  const size = pickSize({ width, height, aspectRatio });
  let res;
  if (refs.length) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    form.set("size", size);
    form.set("quality", quality);
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
      body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
      signal: withTimeout(GPT_IMAGE_TIMEOUT_MS, signal),
    });
  }
  if (!res.ok) throw await httpError(`OpenAI ${model}`, res);
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI: brak b64_json w odpowiedzi (${JSON.stringify(json).slice(0, 300)})`);
  return { blob: b64ToBlob(b64, "image/png"), cost: costOf(json, quality, size), raw: json };
}

function costOf(json, quality, size) {
  const inTok = Number(json?.usage?.input_tokens), outTok = Number(json?.usage?.output_tokens);
  const det = json?.usage?.input_tokens_details;
  const img = Number(det?.image_tokens), txt = Number(det?.text_tokens);
  const inCost = isFinite(img) && isFinite(txt) && img + txt > 0 ? img * IMG_IN + txt * TXT_IN : (inTok || 0) * IMG_IN;
  if (isFinite(inTok) && isFinite(outTok) && inTok + outTok > 0) return inCost + outTok * IMG_OUT;
  return PRICES[quality]?.[size] ?? 0;
}
