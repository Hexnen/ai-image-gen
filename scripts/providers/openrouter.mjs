// OpenRouter. Modele openai/gpt-5* to modele czatu: /chat/completions (modalities image+text; size/quality dropowane).
// Reszta (w tym openai/gpt-image-*, google/gemini-*-image): POST /images (lista: GET /images/models).
// Port z roleplay imageGen/openrouter.ts. Brak batcha. Koszt: usage.cost (realny).
import { GEN_TIMEOUT_MS, GPT_IMAGE_TIMEOUT_MS, withTimeout, httpError, b64ToBlob, blobToB64, mimeOf, nearestAspect } from "./util.mjs";
import { openrouterEstimate } from "./models.mjs";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const headers = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "X-Title": "Foundry ai-image-gen",
});
/**
 * Koszt z usage.cost; przy BYOK bywa 0 (realny koszt w usage.cost_details.upstream_inference_cost,
 * nazwa pola NIEZWERYFIKOWANA). Brak jakiejkolwiek kwoty -> ostrożny szacunek oznaczony jako estimated.
 */
function costOf(json, model) {
  const u = json?.usage;
  const c = Number(u?.cost) || Number(u?.cost_details?.upstream_inference_cost) || 0;
  return c > 0 ? { cost: c } : { cost: openrouterEstimate(model), costEstimated: true };
}
const dataUri = async (blob) => `data:${await mimeOf(blob)};base64,${await blobToB64(blob)}`;

/** openai/gpt-5* image models are chat models (modalities image+text); everything else is on the Images API. */
export const openrouterRoute = (model) => (/^openai\/gpt-5/.test(model) ? "chat" : "images");

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, signal }) {
  return openrouterRoute(model) === "chat"
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
    // modele openai/gpt-image-* potrafią mielić ponad 2 minuty (jak przy OpenAI bezpośrednio)
    signal: withTimeout(/^openai\//.test(model) ? GPT_IMAGE_TIMEOUT_MS : GEN_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw await httpError(`OpenRouter images ${model}`, res);
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenRouter images: brak b64_json (${JSON.stringify(json).slice(0, 300)})`);
  return { blob: b64ToBlob(b64, "image/png"), ...costOf(json, model), raw: json, route: "images" };
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
    const e = new Error(`OpenRouter: brak obrazu w odpowiedzi${txt ? ` — ${txt.slice(0, 300)}` : ` (${JSON.stringify(json).slice(0, 300)})`}`);
    e.cost = Number(json?.usage?.cost) || 0; // odpowiedź bez obrazu bywa rozliczona
    throw e;
  }
  const m = /^data:([^;,]+)/.exec(uri);
  return { blob: b64ToBlob(uri.slice(uri.indexOf(",") + 1), m?.[1] || "image/png"), ...costOf(json, model), raw: json, route: "chat/completions" };
}
