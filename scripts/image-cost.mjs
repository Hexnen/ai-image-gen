// W6-D: czysta matematyka rozmiaru i kosztu obrazów (referencje na wejściu + obraz na wyjściu). Bez Foundry, bez canvas:
// testy w dev/test-image-cost.mjs działają w zwykłym Node. Cienka warstwa canvas: ref-convert.mjs.
//
// WSZYSTKIE liczby tutaj to SZACUNKI z pomiarów osób trzecich (podsumowanie właściciela z 10.11.2026, źródła: forum OpenAI
// i blogi testerów). OpenAI nie publikuje sposobu liczenia obrazów wejściowych. Nic z tego nie zostało sprawdzone przez nas
// prawdziwym kluczem: prawdę mówi dopiero usage.input_tokens / usage.output_tokens odpowiedzi (log pokazuje oba obok siebie).
//
// Reguły referencji dla modeli OpenAI gpt-image (także openai/* przez OpenRouter), wg zreverse-engineerowanego algorytmu:
//   1 token = kafelek 16x16 po normalizacji; dłuższy bok ≤512 bez zmian, 513–1023 → 512 (pułapka), ≥1024 → połowa;
//   limit 1536 tokenów na obraz (większe są dodatkowo zmniejszane); proporcje szersze niż 3:1 są dopełniane (płatny padding).
// Co z tego robimy przy wysyłce (planRef): drabinka progów 512 → 384 → 304 → 208, cel wg „przeznaczenia” referencji,
// nigdy nie powiększamy (poza dociągnięciem do pełnego kafelka, < 16 px), boki w wielokrotnościach 16, nigdy 513–1023.
// Proporcje szersze niż 3:1 są tylko oznaczane (wide): obcinać ich nie wolno, a padding i tak dolicza openaiInputTokens.
import { OPENAI_25_TOKENS } from "./providers/models.mjs";

export const TILE = 16;
/** Progi dłuższego boku wysyłanej referencji (OpenAI). Kolejność: od największego. */
export const REF_TIERS = Object.freeze([512, 384, 304, 208]);
/** Przeznaczenie referencji → próg. detail = edycja postaci/twarzy (domyślne), style = styl/poza/paleta, color = tylko kompozycja i kolory. */
export const REF_PURPOSES = Object.freeze({ max: 512, detail: 384, style: 304, color: 208 });
export const PURPOSE_IDS = Object.freeze(Object.keys(REF_PURPOSES));

export const DEFAULTS = Object.freeze({
  purpose: "detail",
  maxEdge: 512,
  inPrice: 8,        // USD / 1M tokenów obrazu wejściowego (sync). Batch: połowa.
  outPrice: 30,      // USD / 1M tokenów obrazu wyjściowego (sync). Batch: połowa.
  tokenCap: 1536,    // limit tokenów na jeden obraz wejściowy
  maxAspect: 3,      // szersze niż 3:1 = padding
  genericMaxEdge: 1536, // Gemini / Google przez OpenRouter: tylko ostrożny górny limit, bez drabinki
  partialTokens: 100 // każdy partial image (+100 tokenów wyjścia); moduł ich nie używa
});

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const ceil16 = (v) => Math.ceil(v / TILE) * TILE;
export const round16 = (v) => Math.round(v / TILE) * TILE;

/** Która rodzina reguł: "openai" (kafelki gpt-image) albo "generic" (Gemini, Google przez OpenRouter, nieznane). */
export function rulesFor(provider, model = "") {
  if (provider === "openai") return "openai";
  if (provider === "openrouter" && /^openai\//i.test(String(model))) return "openai";
  return "generic";
}

/** Dozwolony limit dłuższego boku dla reguł OpenAI: największy próg ≤ wartości (min. 208). Nigdy nic z 513–1023. */
export function clampMaxEdge(v) {
  const n = num(v, DEFAULTS.maxEdge);
  return REF_TIERS.find((t) => t <= n) ?? REF_TIERS[REF_TIERS.length - 1];
}

export const fitPurpose = (p) => (PURPOSE_IDS.includes(p) ? p : DEFAULTS.purpose);

/**
 * Plan wysyłki jednej referencji: wymiary docelowe (bez pikseli). Czysta funkcja.
 * @param {{width:number, height:number}} src  wymiary źródła
 * @param {{purpose?:string, maxEdge?:number, rules?:"openai"|"generic", genericMaxEdge?:number}} [o]
 * @returns {{width:number, height:number, resize:boolean, target:number, tier:number|null, wide:boolean, aspect:number,
 *   reason:"cap"|"ladder"|"small"|"keep"}}  (generic: "cap"|"keep")
 */
export function planRef(src, o = {}) {
  const sw = Math.max(1, Math.round(Number(src?.width) || 0)), sh = Math.max(1, Math.round(Number(src?.height) || 0));
  const L = Math.max(sw, sh), S = Math.min(sw, sh), land = sw >= sh;
  const aspect = L / S;
  const wide = aspect > DEFAULTS.maxAspect;
  const out = (w, h, extra) => ({ width: w, height: h, resize: w !== sw || h !== sh, aspect, wide, ...extra });
  if ((o.rules ?? "openai") !== "openai") {
    const cap = num(o.genericMaxEdge, DEFAULTS.genericMaxEdge);
    if (L <= cap) return out(sw, sh, { target: L, tier: null, reason: "keep" });
    const k = cap / L;
    return out(land ? cap : Math.max(1, Math.round(sw * k)), land ? Math.max(1, Math.round(sh * k)) : cap, { target: cap, tier: null, reason: "cap" });
  }
  const cap = Math.min(REF_PURPOSES[fitPurpose(o.purpose)], clampMaxEdge(o.maxEdge ?? DEFAULTS.maxEdge));
  // Największy próg, który da się osiągnąć bez prawdziwego powiększania: ≤ dłuższy bok zaokrąglony w górę do kafelka.
  const reach = REF_TIERS.find((t) => t <= ceil16(L));
  if (!reach) return out(sw, sh, { target: L, tier: null, reason: "small" }); // < 193 px: zostaje jak jest (nie powiększamy)
  const target = Math.min(cap, reach);
  const k = target / L;
  // Krótszy bok do NAJBLIŻSZEJ wielokrotności 16 (pełne kafelki, nic nie jest płatne „na pusto”); najbliższa zamiast „w górę”
  // daje zniekształcenie proporcji ≤ 8 px zamiast ≤ 15 px i czasem o rząd kafelków mniej. Nie ponad cel ani ponad kafelki źródła.
  const short = Math.max(TILE, Math.min(target, round16(S * k), ceil16(S)));
  // "cap": ograniczył próg przeznaczenia / limit; "ladder": źródło mniejsze od progu, więc zeszło na niższy próg drabinki
  return out(land ? target : short, land ? short : target, { target, tier: target, reason: target === cap ? "cap" : "ladder" });
}

/**
 * Szacunek tokenów, za które OpenAI policzy obraz wejściowy o danych wymiarach (tak jak go WYSYŁAMY).
 * @returns {{tokens:number, seenW:number, seenH:number, tilesW:number, tilesH:number, padded:boolean, capped:boolean, trap:boolean}}
 */
export function openaiInputTokens(width, height, { tokenCap = DEFAULTS.tokenCap, maxAspect = DEFAULTS.maxAspect } = {}) {
  const w = Math.max(1, Number(width) || 1), h = Math.max(1, Number(height) || 1);
  const L = Math.max(w, h), S = Math.min(w, h);
  const s = L <= 512 ? 1 : L < 1024 ? 512 / L : 0.5;
  // kafelki liczone na dłuższym/krótszym boku; krótszy dopełniony do 1/maxAspect dłuższego (padding)
  const tiles = (long, short) => {
    const tl = Math.ceil(long / TILE - 1e-9);
    let ts = Math.ceil(short / TILE - 1e-9);
    const min = Math.ceil(tl / maxAspect);
    const padded = ts < min;
    if (padded) ts = min;
    return { tl, ts, padded };
  };
  let long = L * s, short = S * s;
  let t = tiles(long, short), capped = false;
  if (t.tl * t.ts > tokenCap) {
    capped = true;
    const ratio = S / L;
    for (let k = t.tl - 1; k > 0; k--) {
      const c = tiles(k * TILE, k * TILE * ratio);
      if (c.tl * c.ts <= tokenCap) { t = c; long = k * TILE; short = long * ratio; break; }
    }
  }
  const sl = Math.round(long), ss = Math.round(short);
  return {
    tokens: t.tl * t.ts, seenW: w >= h ? sl : ss, seenH: w >= h ? ss : sl,
    tilesW: w >= h ? t.tl : t.ts, tilesH: w >= h ? t.ts : t.tl, padded: t.padded, capped, trap: L > 512 && L < 1024
  };
}

/** Koszt w USD dla liczby tokenów i ceny za 1M. */
export const usd = (tokens, pricePerM) => (Number(tokens) || 0) * (Number(pricePerM) || 0) / 1e6;

// ---------- wyjście ----------

/**
 * Tokeny wyjścia na obraz (SZACUNEK, pomiary osób trzecich). square = 1024x1024, wide = 1536x1024 (i 1024x1536).
 * gpt-image-2.6: tabela z podsumowania właściciela (sekcja 4; xhigh/max wide oznaczone tam „~”).
 * gpt-image-2.5: square = OPENAI_25_TOKENS z katalogu (ostrożna górna granica, jak dotąd); wide low/medium/high z
 * podsumowania (2.5 Flare 1536x1024: $0,0051 / $0,0107 / $0,0415 przy $30/1M → 170 / 357 / 1383); xhigh/max wide: brak
 * danych, więc = square (ostrożnie).
 */
export const OUTPUT_TABLES = Object.freeze({
  "gpt-image-2.6": {
    square: { low: 824, medium: 1449, high: 1756, xhigh: 3122, max: 7024 },
    wide: { low: 664, medium: 1132, high: 1353, xhigh: 2470, max: 5500 }
  },
  "gpt-image-2.5": {
    square: { low: OPENAI_25_TOKENS.low, medium: OPENAI_25_TOKENS.medium, high: OPENAI_25_TOKENS.high, xhigh: OPENAI_25_TOKENS.xhigh, max: OPENAI_25_TOKENS.max },
    wide: { low: 170, medium: 357, high: 1383, xhigh: OPENAI_25_TOKENS.xhigh, max: OPENAI_25_TOKENS.max }
  }
});

/** Rodzina tabeli wyjścia dla modelu (null = brak tabeli, np. Gemini: ma własny cennik per obraz). */
export function outputFamily(provider, model = "") {
  if (rulesFor(provider, model) !== "openai") return null;
  const m = String(model).toLowerCase();
  if (/gpt-image-2\.6/.test(m)) return "gpt-image-2.6";
  if (/gpt-image/.test(m)) return "gpt-image-2.5";
  return null;
}

/** Tabele z nadpisaniami (JSON z ustawienia świata). Złe wpisy są pomijane, nigdy nie rzuca. */
export function mergeTables(override, base = OUTPUT_TABLES) {
  const out = JSON.parse(JSON.stringify(base));
  let o = override;
  if (typeof o === "string") { try { o = o.trim() ? JSON.parse(o) : null; } catch { o = null; } }
  if (!o || typeof o !== "object") return out;
  for (const [fam, t] of Object.entries(o)) {
    if (!t || typeof t !== "object") continue;
    out[fam] ??= { square: {}, wide: {} };
    for (const col of ["square", "wide"]) {
      for (const [q, v] of Object.entries(t[col] ?? {})) if (Number(v) > 0) out[fam][col][q] = Number(v);
    }
  }
  return out;
}

const PX_FLAT = 2_400_000, PX_4K = 3840 * 2160, GROWTH_4K = 1.9;

/**
 * Tokeny wyjścia jednego obrazu. Proporcje między 1:1 a 3:2 interpolowane (w skali log) między kolumnami; szersze niż 3:2
 * jak 3:2 (brak danych). Powyżej ~2,4 Mpx rośnie do ~1,9× przy 4K (jak dotychczasowy szacunek w models.mjs).
 * auto liczymy jak high. Partial images: +100 tokenów każdy.
 */
export function outputTokens(family, quality, width, height, { partialImages = 0, tables = OUTPUT_TABLES } = {}) {
  const t = tables?.[family];
  if (!t) return null;
  const q = quality === "auto" ? "high" : quality;
  const sq = t.square?.[q] ?? t.square?.medium;
  const wd = t.wide?.[q] ?? sq;
  if (!(sq > 0)) return null;
  const w = Number(width) || 1024, h = Number(height) || 1024;
  const r = Math.max(w, h) / Math.min(w, h);
  const k = Math.min(1, Math.max(0, Math.log(r) / Math.log(1.5)));
  let tok = sq + (wd - sq) * k;
  const px = w * h;
  if (px > PX_FLAT) tok *= 1 + (GROWTH_4K - 1) * Math.min(1, (px - PX_FLAT) / (PX_4K - PX_FLAT));
  return Math.round(tok + Math.max(0, Math.floor(Number(partialImages) || 0)) * DEFAULTS.partialTokens);
}

/**
 * Szacunek całego żądania. OpenAI Fast = JEDNO żądanie z n obrazami: referencje płatne raz, wyjście ×count.
 * Batch (i Gemini/OpenRouter Fast) = osobne żądania: referencje płatne przy każdym. Batch = połowa stawek.
 * @param {{outTokens:number|null, refTokens:number[], count?:number, mode?:"fast"|"batch", inPrice?:number, outPrice?:number, refsShared?:boolean}} o
 */
export function estimateRequest({ outTokens, refTokens = [], count = 1, mode = "fast", inPrice = DEFAULTS.inPrice, outPrice = DEFAULTS.outPrice, refsShared = true }) {
  const half = mode === "batch" ? 0.5 : 1;
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  const refTok = refTokens.reduce((s, v) => s + (Number(v) || 0), 0);
  const refUSD = usd(refTok, inPrice) * half;
  const outUSD = outTokens == null ? null : usd(outTokens, outPrice) * half;
  const perImage = outUSD == null ? null : outUSD + refUSD;
  const shared = refsShared && mode !== "batch";
  const total = outUSD == null ? null : outUSD * n + refUSD * (shared ? 1 : n);
  return { refTokens: refTok, refUSD, outTokens, outUSD, perImage, total, count: n };
}

/**
 * Podpowiedź tańszego kadru (nic nie zmienia): dla kwadratu (±10%) sprawdza 1536x1024 i 1024x1536.
 * @returns {null | {width:number, height:number, tokens:number, savingTokens:number, savingUSD:number, pct:number}}
 */
export function cheaperSize(family, quality, width, height, { outPrice = DEFAULTS.outPrice, tables = OUTPUT_TABLES } = {}) {
  const w = Number(width) || 0, h = Number(height) || 0;
  if (!w || !h || Math.max(w, h) / Math.min(w, h) > 1.1) return null;
  const cur = outputTokens(family, quality, w, h, { tables });
  if (cur == null) return null;
  const [cw, ch] = w >= h ? [1536, 1024] : [1024, 1536];
  const alt = outputTokens(family, quality, cw, ch, { tables });
  if (alt == null || alt >= cur) return null;
  return { width: cw, height: ch, tokens: alt, savingTokens: cur - alt, savingUSD: usd(cur - alt, outPrice), pct: Math.round((1 - alt / cur) * 100) };
}
