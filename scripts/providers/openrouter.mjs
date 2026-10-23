// OpenRouter: POST /images dla wszystkich modeli obrazkowych (openai/gpt-image-2.5-*, google/gemini-*-image; lista: GET /images/models).
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

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, signal }) {
  const input_references = await Promise.all(refs.map(async (b) => ({ type: "image_url", image_url: { url: await dataUri(b) } })));
  const body = {
    model, prompt, n: 1, output_format: "png",
    aspect_ratio: nearestAspect({ aspectRatio, width, height }, ASPECTS),
    ...(input_references.length ? { input_references } : {}),
  };
  const res = await fetch(`${OPENROUTER_BASE}/images`, {
    method: "POST", headers: headers(apiKey), body: JSON.stringify(body),
    // modele openai/gpt-image-2.5-* potrafią mielić ponad 2 minuty (jak przy OpenAI bezpośrednio)
    signal: withTimeout(/^openai\//.test(model) ? GPT_IMAGE_TIMEOUT_MS : GEN_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw await httpError(`OpenRouter images ${model}`, res);
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenRouter images: brak b64_json (${JSON.stringify(json).slice(0, 300)})`);
  return { blob: b64ToBlob(b64, "image/png"), ...costOf(json, model), raw: json, route: "images" };
}
