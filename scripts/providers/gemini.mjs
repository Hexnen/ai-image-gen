// Gemini (Nano Banana) bezpośrednio: models/<model>:generateContent. Port z roleplay imageGen/gemini.ts.
import { GEN_TIMEOUT_MS, withTimeout, httpError, b64ToBlob, blobToB64, mimeOf, nearestAspect } from "./util.mjs";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
// Sync, USD za token (flash-lite-image: out obraz $30/M, in $0.25/M wg roleplay).
const IN_RATE = 0.25 / 1e6, OUT_RATE = 30 / 1e6;
const FALLBACK_COST = 0.0336; // 1 obraz 1K = 1120 tok.

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, signal }) {
  const parts = [];
  for (const blob of refs) {
    parts.push({ inline_data: { mime_type: await mimeOf(blob), data: await blobToB64(blob) } });
  }
  parts.push({ text: prompt });
  const body = {
    contents: [{ parts }],
    generationConfig: {
      response_modalities: ["IMAGE"],
      // Flash Lite umie tylko 1K; to ŻĄDANIE aspektu, realne wymiary mogą się różnić.
      image_config: { aspect_ratio: nearestAspect({ aspectRatio, width, height }, ASPECTS), image_size: "1K" },
    },
  };
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(GEN_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw await httpError(`Gemini ${model}`, res);
  const json = await res.json();
  const rp = json?.candidates?.[0]?.content?.parts ?? [];
  const img = rp.find((x) => x?.inlineData?.data || x?.inline_data?.data);
  const b64 = img?.inlineData?.data || img?.inline_data?.data;
  if (!b64) {
    const txt = rp.map((x) => (typeof x?.text === "string" ? x.text : "")).filter(Boolean).join(" ");
    throw new Error(`Gemini: brak obrazu w odpowiedzi${txt ? ` — ${txt.slice(0, 300)}` : ` (${JSON.stringify(json).slice(0, 300)})`}`);
  }
  const mime = img?.inlineData?.mimeType || img?.inline_data?.mime_type || "image/png";
  return { blob: b64ToBlob(b64, mime), cost: costOf(json), raw: json };
}

function costOf(json) {
  const u = json?.usageMetadata;
  const out = Number(u?.candidatesTokenCount), inp = Number(u?.promptTokenCount) || 0;
  if (isFinite(out) && out > 0) return inp * IN_RATE + out * OUT_RATE;
  return FALLBACK_COST;
}
