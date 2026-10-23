// What the "Max size of saved file" setting will do, from the generation size (pure, no Foundry globals).
// The saved file is only ever shrunk: the generation itself is whatever the model/size settings above ask for.

/** Default max edge of the saved file (0 = no resizing; per-kind overrides go in EDGE_BY_DOC), used when a type has no saved configuration yet. */
export const EDGE_BY_DOC = Object.freeze({}); // no per-kind shrinking by default: WebP + quality already save most of the bytes
export const FALLBACK_EDGE = 0; // 0 = no resizing

/** Type keys look like "<system>.<Document>.<type>" (macros: "core.Macro"). */
export function defaultEdgeForKey(key) {
  const doc = String(key ?? "").split(".")[1];
  return EDGE_BY_DOC[doc] ?? FALLBACK_EDGE;
}

/** Edge of a square image at each Gemini size tier (a tier fixes the pixel budget, the aspect only reshapes it). */
const TIER_EDGE = Object.freeze({ "0.5K": 512, "1K": 1024, "2K": 2048, "4K": 4096 });

/**
 * Size of the image the provider will return. OpenAI returns exactly WxH. Gemini (imageSize tier) and OpenRouter
 * only take an aspect, so this is an approximation at constant pixel area (`approx: true`).
 * @returns {null | {w:number, h:number, approx:boolean}}
 */
export function generatedSize({ provider, width, height, imageSize } = {}) {
  const w = Number(width), h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  if (provider === "openai") return { w: Math.round(w), h: Math.round(h), approx: false };
  const side = provider === "gemini" ? (TIER_EDGE[imageSize] ?? 1024) : 1024;
  const ar = w / h;
  return { w: Math.max(1, Math.round(side * Math.sqrt(ar))), h: Math.max(1, Math.round(side / Math.sqrt(ar))), approx: true };
}

/**
 * @param {{w:number,h:number,approx:boolean}|null} gen
 * @param {number} maxEdge 0 = no resizing
 * @returns {null | {state:"none"|"same"|"reduce", from:{w:number,h:number}, to:{w:number,h:number}, pct:number, approx:boolean}}
 *   `pct` is a rough file-size saving: pixel count scales with the square of the edge.
 */
export function outputPreview(gen, maxEdge) {
  if (!gen) return null;
  const edge = Number(maxEdge) > 0 ? Number(maxEdge) : 0;
  const from = { w: gen.w, h: gen.h };
  const long = Math.max(gen.w, gen.h);
  if (!edge) return { state: "none", from, to: from, pct: 0, approx: gen.approx };
  if (long <= edge) return { state: "same", from, to: from, pct: 0, approx: gen.approx };
  const scale = edge / long;
  const to = { w: Math.max(1, Math.round(gen.w * scale)), h: Math.max(1, Math.round(gen.h * scale)) };
  const pct = Math.min(99, Math.max(1, Math.round((1 - scale * scale) * 100)));
  return { state: "reduce", from, to, pct, approx: gen.approx };
}

/** A limit at or above the generated size changes nothing (still selectable: the same type may use other models). */
export function edgeIsNoop(gen, value) {
  const v = Number(value);
  return !!gen && v > 0 && v >= Math.max(gen.w, gen.h);
}
