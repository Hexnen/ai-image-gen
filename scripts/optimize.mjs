// Optymalizacja obrazów AI PRZED zapisem: zmniejszenie dłuższego boku + WebP. Obrazy od AI bywają niepotrzebnie duże
// (2K/4K PNG po kilka MB), a na tokenie czy portrecie liczy się ułamek tego. Nie zmienia tego, co idzie do API,
// tylko to, co zapisujemy do Data/.
//
// Współpraca z modułem local-media-optimizer (>= 1.1.0): jeśli jest aktywny, delegujemy do jego API
// (jedna implementacja i jedne ustawienia kodowania), a w ready rejestrujemy w nim profil folderu `ai-image-gen/`.
// Wgrywamy z `{ optimized: true }`, żeby jego hook uploadu nie kodował pliku drugi raz. Bez niego działa
// wbudowany fallback (canvas -> WebP/JPEG/PNG). Nigdy nie powiększa; gdy wynik nie jest mniejszy, zostaje oryginał.
import { MODULE_ID, DATA_ROOT } from "./constants.mjs";

export const OPTIMIZER_ID = "local-media-optimizer";
export const PROFILE_ID = DATA_ROOT; // profile id in local-media-optimizer: unchanged by the rename
export const MIN_OPTIMIZER_VERSION = "1.1.0";

export const DEFAULT_OUTPUT = Object.freeze({ maxEdge: 0, quality: 0.85, format: "webp" });
/** Upper safety cap of the folder profile registered in local-media-optimizer: it only applies to uploads that
 *  did not go through our own flow (those carry the per-type limit and `optimized: true`). */
export const PROFILE_EDGE = 2048;
/** Referencje wgrywane do _refs/ trzymamy trochę większe: to materiał wejściowy dla modelu. */
export const REF_OUTPUT = Object.freeze({ maxEdge: 2048, quality: 0.9, format: "webp" });
/** Wartości z listy w konfiguracji typu; 0 = bez zmniejszania. */
export const MAX_EDGES = Object.freeze([0, 128, 256, 512, 768, 1024, 1536, 2048, 3072]);
export const FORMATS = Object.freeze(["webp", "jpeg", "png"]);

const MIME = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png" };
const NO_LIMIT_EDGE = 16384;

const versionParts = (v) => String(v ?? "0").split(".").map((n) => parseInt(n, 10) || 0);
export function versionAtLeast(have, min) {
  const a = versionParts(have), b = versionParts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** API local-media-optimizer, jeśli moduł jest aktywny i dość nowy; inaczej null. */
export function optimizerApi() {
  try {
    const m = game.modules?.get(OPTIMIZER_ID);
    if (!m?.active || !versionAtLeast(m.version, MIN_OPTIMIZER_VERSION)) return null;
    const api = m.api;
    return typeof api?.optimizeImage === "function" ? api : null;
  } catch { return null; }
}

/** Ustawienie świata „Optimize AI images” (domyślnie włączone). */
export function optimizeEnabled() {
  try { return !!game.settings.get(MODULE_ID, "optimizeImages"); } catch { return true; }
}

/** Opcje optymalizacji z konfiguracji typu (stare zapisy bez pól dostają domyślne). */
export function outputOptsFromConfig(cfg = {}, kind = "result") {
  const edge = Number(cfg.outMaxEdge);
  const q = Number(cfg.outQuality);
  return {
    maxEdge: Number.isFinite(edge) && edge >= 0 ? edge : DEFAULT_OUTPUT.maxEdge,
    quality: Number.isFinite(q) && q > 0 ? Math.min(1, q) : DEFAULT_OUTPUT.quality,
    format: FORMATS.includes(cfg.outFormat) ? cfg.outFormat : DEFAULT_OUTPUT.format,
    ...(cfg.transparent ? { alpha: true } : {}),
    kind
  };
}

/** Pola wpisu logu z wyniku optymalizacji. */
export const statsPatch = (s) => (s ? { bytesBefore: s.bytesBefore, bytesAfter: s.bytesAfter, optimizedVia: s.via } : {});

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

const unchanged = (blob, via, extra = {}) => ({
  blob, changed: false, bytesBefore: blob.size, bytesAfter: blob.size, width: null, height: null, via,
  format: (blob.type || "").replace("image/", "") || null, ...extra
});

async function encodeCanvas(bmp, w, h, mime, quality) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    return c.convertToBlob({ type: mime, quality });
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Promise((res) => c.toBlob(res, mime, quality));
}

/** Wbudowany fallback (bez local-media-optimizer). */
async function builtin(blob, { maxEdge, quality, format }) {
  const mime = MIME[format] ?? MIME.webp;
  const bmp = await createImageBitmap(blob);
  try {
    const longest = Math.max(bmp.width, bmp.height);
    const scale = maxEdge > 0 ? Math.min(1, maxEdge / longest) : 1;
    if (scale === 1 && blob.type === mime) return unchanged(blob, "builtin", { width: bmp.width, height: bmp.height });
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const out = await encodeCanvas(bmp, w, h, mime, quality);
    if (!out || out.type !== mime) return unchanged(blob, "builtin", { width: bmp.width, height: bmp.height });
    if (scale === 1 && out.size >= blob.size) return unchanged(blob, "builtin", { width: bmp.width, height: bmp.height });
    return {
      blob: out, changed: true, bytesBefore: blob.size, bytesAfter: out.size, width: w, height: h,
      via: "builtin", format
    };
  } finally { bmp.close?.(); }
}

/**
 * Zmniejsz/rekoduj obraz przed zapisem. NIE rzuca: przy błędzie zwraca oryginał z `via: "error"` i `error`.
 * @param {Blob} blob
 * @param {{maxEdge?:number, quality?:number, format?:"webp"|"jpeg"|"png", kind?:string}} [opts] maxEdge 0 = bez zmniejszania
 * @returns {Promise<{blob:Blob, changed:boolean, bytesBefore:number, bytesAfter:number, width:number|null,
 *   height:number|null, via:"local-media-optimizer"|"builtin"|"error", format:string|null, error?:string}>}
 */
export async function optimizeForSave(blob, opts = {}) {
  const o = { ...DEFAULT_OUTPUT, ...opts };
  // `alpha: true` (transparent background): JPEG would turn transparent areas black, so use WebP instead.
  if (o.alpha && o.format === "jpeg") o.format = "webp";
  const maxEdge = Number(o.maxEdge) > 0 ? Number(o.maxEdge) : 0;
  const quality = Math.min(1, Math.max(0.1, Number(o.quality) || DEFAULT_OUTPUT.quality));
  const format = FORMATS.includes(o.format) ? o.format : "webp";
  try {
    const api = optimizerApi();
    if (api) {
      const r = await api.optimizeImage(blob, { maxEdge: maxEdge || NO_LIMIT_EDGE, quality, format, keepIfLarger: true });
      return {
        blob: r.blob ?? blob, changed: !!r.changed, bytesBefore: r.bytesBefore ?? blob.size, bytesAfter: r.bytesAfter ?? (r.blob ?? blob).size,
        width: r.width ?? null, height: r.height ?? null, via: "local-media-optimizer", format: r.format ?? format
      };
    }
    return await builtin(blob, { maxEdge, quality, format });
  } catch (e) {
    console.warn(`${MODULE_ID} | optimization failed, saving the original`, e);
    return unchanged(blob, "error", { error: String(e?.message ?? e) });
  }
}

/**
 * Zarejestruj (albo zdejmij) profil folderu `ai-image-gen/` w local-media-optimizer: uploady do tego folderu, których
 * sami nie optymalizowaliśmy (np. ręcznie z file pickera), dostają ostrożny górny limit (PROFILE_EDGE). Limit per typ
 * stosujemy sami w optimizeForSave i wgrywamy z `optimized: true`. Wołać w ready i przy zmianie ustawienia.
 */
export function syncOptimizerProfile() {
  try {
    const api = optimizerApi();
    if (!api?.registerProfile) return false;
    if (!optimizeEnabled()) { api.unregisterProfile?.(PROFILE_ID); return false; }
    api.registerProfile(PROFILE_ID, {
      label: "Moinens AI Gen", prefix: `${DATA_ROOT}/`,
      maxEdge: PROFILE_EDGE, quality: DEFAULT_OUTPUT.quality, format: DEFAULT_OUTPUT.format
    });
    return true;
  } catch (e) {
    console.warn(`${MODULE_ID} | could not register the optimizer profile`, e);
    return false;
  }
}
