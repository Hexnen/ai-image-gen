// OpenRouter. Modele openai/* nie mają /images, więc idą przez /chat/completions
// (modalities image+text; size/quality są wtedy dropowane). Reszta: POST /images.
// Port z roleplay imageGen/openrouter.ts. Brak batcha. Koszt: usage.cost (realny).
import { GEN_TIMEOUT_MS, GPT_IMAGE_TIMEOUT_MS, withTimeout, httpError, b64ToBlob, blobToB64, mimeOf, nearestAspect } from "./util.mjs";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const headers = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "X-Title": "Foundry ai-image-gen",
});
const dataUri = async (blob) => `data:${await mimeOf(blob)};base64,${await blobToB64(blob)}`;

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, signal }) {
  return model.startsWith("openai/")
    ? viaChat({ apiKey, model, prompt, refs, signal })
    : viaImages({ apiKey, model, prompt, refs, width, height, aspectRatio, signal });
}

async function viaImages({ apiKey, model, prompt, refs, width, height, aspectRatio, signal }) {
  const input_references = await Promise.all(refs.map(async (b) => ({ type: "image_url", image_url: { url: await dataUri(b) } })));
  const body = {
    model, prompt, n: 1, output_format: "png",
    aspect_ratio: nearestAspect({ aspectRatio, width, height }, ASPECTS),
    ...(input_references.length ? { input_references } : {}),
  };
  const res = await fetch(`${OPENROUTER_BASE}/images`, {
    method: "POST", headers: headers(apiKey), body: JSON.stringify(body),
    signal: withTimeout(GEN_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw await httpError(`OpenRouter images ${model}`, res);
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenRouter images: brak b64_json (${JSON.stringify(json).slice(0, 300)})`);
  return { blob: b64ToBlob(b64, "image/png"), cost: Number(json?.usage?.cost) || 0, raw: json };
}

async function viaChat({ apiKey, model, prompt, refs, signal }) {
  const content = [{ type: "text", text: prompt }];
  for (const b of refs) content.push({ type: "image_url", image_url: { url: await dataUri(b) } });
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST", headers: headers(apiKey),
    body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content }] }),
    signal: withTimeout(GPT_IMAGE_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw await httpError(`OpenRouter ${model}`, res);
  const json = await res.json();
  const msg = json?.choices?.[0]?.message ?? {};
  let uri = "";
  for (const im of Array.isArray(msg.images) ? msg.images : []) {
    const u = im?.image_url?.url;
    if (typeof u === "string" && u.startsWith("data:")) { uri = u; break; }
  }
  if (!uri && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      const u = b?.type === "image_url" ? b?.image_url?.url : undefined;
      if (typeof u === "string" && u.startsWith("data:")) { uri = u; break; }
    }
  }
  if (!uri) {
    const txt = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join(" ") : "";
    throw new Error(`OpenRouter: brak obrazu w odpowiedzi${txt ? ` — ${txt.slice(0, 300)}` : ` (${JSON.stringify(json).slice(0, 300)})`}`);
  }
  const m = /^data:([^;,]+)/.exec(uri);
  return { blob: b64ToBlob(uri.slice(uri.indexOf(",") + 1), m?.[1] || "image/png"), cost: Number(json?.usage?.cost) || 0, raw: json };
}
