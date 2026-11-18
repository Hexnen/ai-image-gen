// W6-D: cienka warstwa canvas nad image-cost.mjs: zmniejsza referencje PRZED wysłaniem do API i mierzy je dla UI
// (rozmiar oryginału → wysyłany, KB, szacowane tokeny i USD). Cała matematyka jest w image-cost.mjs (testy w Node).
//
// Format wysyłki: WebP q 0.9. Przezroczystość ZOSTAJE (WebP ma alfę; nie spłaszczamy na biało): moduł generuje też obrazy
// z przezroczystym tłem i wycięta postać jest wtedy znaczącą informacją. Wszyscy trzej dostawcy przyjmują WebP.
// Gdy obraz nie wymaga zmniejszenia, a WebP nie wychodzi mniejszy, wysyłamy oryginał (bez strat).
// Gemini / Google przez OpenRouter: bez drabinki i bez przekodowania, tylko ostrożny górny limit 1536 px (zachowanie
// bez zmian dla zwykłych referencji). Błąd konwersji nigdy nie blokuje generacji: wysyłamy oryginał i ostrzegamy w konsoli.
import { MODULE_ID } from "./constants.mjs";
import {
  planRef, openaiInputTokens, rulesFor, fitPurpose, clampMaxEdge, usd, outputFamily, outputTokens, estimateRequest,
  cheaperSize, mergeTables, DEFAULTS, REF_PURPOSES
} from "./image-cost.mjs";

const SEND_QUALITY = 0.9;
const SEND_MIME = "image/webp";

/** Ceny i tabele szacunków z ustawień świata (fallback: wartości domyślne z image-cost.mjs). */
export function estimateSettings() {
  const get = (k, d) => { try { const v = game.settings.get(MODULE_ID, k); return v ?? d; } catch { return d; } };
  const pos = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    inPrice: pos(get("est.imageInPrice", DEFAULTS.inPrice), DEFAULTS.inPrice),
    outPrice: pos(get("est.imageOutPrice", DEFAULTS.outPrice), DEFAULTS.outPrice),
    tables: mergeTables(get("est.outputTokens", ""))
  };
}

/** Opcje planu dla konfiguracji typu. */
export function refOptsFor(cfg = {}) {
  return { rules: rulesFor(cfg.provider, cfg.model), purpose: fitPurpose(cfg.refPurpose), maxEdge: clampMaxEdge(cfg.refMaxEdge ?? DEFAULTS.maxEdge) };
}

/** Przeznaczenie pojedynczej referencji z konfiguracji (nadpisanie per obraz) albo "" = domyślne typu. */
export function purposeOverride(cfg, path) {
  const e = (cfg?.refPurposes ?? []).find((x) => x?.path === path);
  return e && REF_PURPOSES[e.purpose] ? e.purpose : "";
}

async function encode(bmp, w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    return c.convertToBlob({ type: SEND_MIME, quality: SEND_QUALITY });
  }
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Promise((res) => c.toBlob(res, SEND_MIME, SEND_QUALITY));
}

/**
 * Przygotuj jedną referencję do wysłania.
 * @param {Blob} blob  png/jpeg/webp (po normalizeRef)
 * @param {{rules:string, purpose:string, maxEdge:number}} opts
 * @returns {Promise<{blob:Blob, src:{w:number,h:number,bytes:number}, sent:{w:number,h:number,bytes:number},
 *   plan:object, tokens:number|null, converted:boolean, error?:string}>}
 */
export async function convertRef(blob, opts) {
  const bmp = await createImageBitmap(blob);
  try {
    const src = { w: bmp.width, h: bmp.height, bytes: blob.size };
    const plan = planRef({ width: bmp.width, height: bmp.height }, opts);
    let out = blob, converted = false;
    const generic = opts.rules !== "openai";
    if (plan.resize || !generic) {
      const enc = await encode(bmp, plan.width, plan.height);
      if (enc && enc.type === SEND_MIME && (plan.resize || enc.size < blob.size)) { out = enc; converted = true; }
    }
    const w = converted ? plan.width : src.w, h = converted ? plan.height : src.h;
    // Gdy przekodowanie się nie uda, a plan wymagał zmniejszenia: liczymy tokeny tego, co faktycznie pójdzie (oryginału).
    const tokens = generic ? null : openaiInputTokens(w, h).tokens;
    return { blob: out, src, sent: { w, h, bytes: out.size }, plan, tokens, converted };
  } finally { bmp.close?.(); }
}

/**
 * Przygotuj wszystkie referencje żądania. Nigdy nie rzuca z powodu konwersji (oryginał + ostrzeżenie).
 * @param {Blob[]} blobs
 * @param {object} cfg  konfiguracja typu (provider, model, refPurpose, refMaxEdge)
 * @param {string[]} [purposes]  przeznaczenie per obraz ("" / brak = domyślne typu)
 * @returns {Promise<{blobs:Blob[], infos:object[], tokens:number|null}>}  tokens = suma (tylko reguły OpenAI)
 */
export async function prepareRefs(blobs, cfg, purposes = []) {
  const base = refOptsFor(cfg);
  const out = [], infos = [];
  let tokens = base.rules === "openai" ? 0 : null;
  for (const [i, b] of blobs.entries()) {
    const purpose = REF_PURPOSES[purposes[i]] ? purposes[i] : base.purpose;
    try {
      const r = await convertRef(b, { ...base, purpose });
      out.push(r.blob);
      infos.push({ ...r, blob: undefined, purpose });
      if (tokens != null) tokens += r.tokens ?? 0;
    } catch (e) {
      console.warn(`${MODULE_ID} | reference #${i + 1}: conversion failed, sending the original`, e);
      out.push(b);
      infos.push({ error: String(e?.message ?? e), purpose });
      if (tokens != null) tokens = null; // nieznane wymiary: bez sumy, żeby nie zaniżać
    }
  }
  return { blobs: out, infos, tokens };
}

// ---------- pomiar dla UI (z pamięcią podręczną na sesję) ----------

const cache = new Map();
const srcCache = new Map();
const MAX_CACHE = 200;

async function sourceBlob(path) {
  if (srcCache.has(path)) return srcCache.get(path);
  const p = (async () => {
    const url = /^(https?:|data:|blob:)/.test(path) ? path : foundry.utils.getRoute(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  })();
  srcCache.set(path, p);
  p.catch(() => srcCache.delete(path));
  return p;
}

/**
 * Zmierz referencję tak, jak zostanie wysłana (bez wysyłania). `ref` = ścieżka w Data albo {key, blob}.
 * @returns {Promise<object>} wynik convertRef bez blobu albo {error}
 */
export async function measureRef(ref, opts) {
  const key = `${typeof ref === "string" ? ref : ref.key}|${opts.rules}|${opts.purpose}|${opts.maxEdge}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    try {
      const blob = typeof ref === "string" ? await sourceBlob(ref) : ref.blob;
      const r = await convertRef(blob, opts);
      return { ...r, blob: undefined };
    } catch (e) { return { error: String(e?.message ?? e) }; }
  })();
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, p);
  return p;
}

/** Zapomnij pomiar ścieżki (np. po ponownym wgraniu pliku o tej samej nazwie). */
export function forgetRef(path) {
  srcCache.delete(path);
  for (const k of [...cache.keys()]) if (k.startsWith(`${path}|`)) cache.delete(k);
}

// ---------- teksty dla UI ----------

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0.1, n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);
export const fmtUsd = (v) => (v == null ? "?" : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`);

/** Jedna linia pomiaru referencji: „1920×1080 · 412 KB → 384×224 · 18 KB · ~336 tok ≈ $0.0027”. */
export function refLine(m, inPrice) {
  const L = game.i18n;
  if (!m || m.error) return { text: L.localize("AIIMG.RefSize.Unknown"), warn: "" };
  const from = `${m.src.w}×${m.src.h} · ${kb(m.src.bytes)}`;
  const to = `${m.sent.w}×${m.sent.h} · ${kb(m.sent.bytes)}`;
  const parts = [m.converted ? `${from} → ${to}` : `${from} (${L.localize("AIIMG.RefSize.AsIs")})`];
  if (m.tokens != null) parts.push(L.format("AIIMG.RefSize.Tokens", { tok: m.tokens, usd: fmtUsd(usd(m.tokens, inPrice)) }));
  const warn = [];
  if (m.plan?.wide) warn.push(L.localize("AIIMG.RefSize.Wide"));
  if (m.plan?.reason === "small" && m.tokens != null) warn.push(L.localize("AIIMG.RefSize.Small"));
  return { text: parts.join(" · "), warn: warn.join(" ") };
}

/**
 * Szacunek wyjścia + referencji dla UI. `refTokens` = tokeny poszczególnych referencji (null = nieznane / nie OpenAI).
 * @returns {null | {lines:string[], hint:string}}  null = brak tabeli dla tego modelu (np. Gemini)
 */
export function costBreakdown(cfg, { refTokens = [], count = 1, mode = "fast" } = {}) {
  const fam = outputFamily(cfg.provider, cfg.model);
  if (!fam) return null;
  const L = game.i18n;
  const s = estimateSettings();
  const out = outputTokens(fam, cfg.quality, cfg.width, cfg.height, { tables: s.tables });
  const known = refTokens.filter((t) => t != null);
  const r = estimateRequest({
    outTokens: out, refTokens: known, count, mode, inPrice: s.inPrice, outPrice: s.outPrice,
    refsShared: cfg.provider === "openai" // OpenAI Fast = jedno żądanie z n; OpenRouter = osobne żądania
  });
  const q = L.has(`AIIMG.Quality.${cfg.quality}`) ? L.localize(`AIIMG.Quality.${cfg.quality}`) : cfg.quality;
  const lines = [
    L.format("AIIMG.Est.Output", { size: `${cfg.width}×${cfg.height}`, quality: q, tok: out ?? "?", usd: fmtUsd(r.outUSD) }),
    L.format("AIIMG.Est.Refs", { n: refTokens.length, tok: r.refTokens, usd: fmtUsd(r.refUSD) }) + (known.length < refTokens.length ? ` ${L.localize("AIIMG.Est.RefsPartial")}` : ""),
    L.format("AIIMG.Est.PerImage", { usd: fmtUsd(r.perImage) }) + (r.count > 1 ? ` · ${L.format("AIIMG.Est.Total", { n: r.count, usd: fmtUsd(r.total) })}` : "")
  ];
  const c = cheaperSize(fam, cfg.quality, cfg.width, cfg.height, { outPrice: s.outPrice, tables: s.tables });
  const hint = c ? L.format("AIIMG.Est.Cheaper", { size: `${c.width}×${c.height}`, pct: c.pct, usd: fmtUsd(c.savingUSD * (mode === "batch" ? 0.5 : 1)) }) : "";
  return { lines, hint, outTokens: out, refTokens: r.refTokens };
}
