// W7-A AI Tile: czysta geometria i planowanie (bez Foundry, bez canvas; testy: dev/test-ai-tile-core.mjs).
// Układ współrzędnych: px sceny (jak Tile.x/y/width/height). Kształt = zamknięty wielokąt [{x,y}, ...] bez powtórzonego
// pierwszego punktu na końcu. Decyzja właściciela (2026-11-19): na razie TYLKO prostokąt; geometria (bbox, maska z punktów,
// zapis punktów w batchu) zostaje ogólna, żeby inne kształty dało się dodać później, ale nie są zaimplementowane.
//
// Do modelu idą DWA obrazy: 1 = wycięty zaznaczony prostokąt (to on jest edytowany; + maska u OpenAI), 2 = kontekst:
// obszar sceny 2× szerszy i 2× wyższy wokół tego samego środka (przycięty do granic płótna), z czerwonym obrysem
// zaznaczenia; prompt podaje też położenie zaznaczenia w obrazie 2 w procentach.
import { normalizeOpenAISize, getModel } from "../providers/models.mjs";
import { openaiInputTokens, planRef, rulesFor, fitPurpose, clampMaxEdge } from "../image-cost.mjs";

export const TILE_TYPE_KEY = "moinens-ai-gen.tile";
/** Kształty dostępne w UI (na razie tylko prostokąt). */
export const SHAPES = Object.freeze(["rect"]);
/** Najmniejszy sensowny kształt (px sceny): krótszy bok bbox i pole. */
export const MIN_SIDE = 8;
export const MIN_AREA = 64;
/** Kontekst: ile razy większy (szer. i wys.) od zaznaczenia. */
export const CONTEXT_FACTOR = 2;
/** Dłuższy bok renderowanego obrazu kontekstu (potem zwykłe zmniejszanie referencji z ref-convert). */
export const CONTEXT_EDGE = 1024;
/** Dłuższy bok obrazu do edycji dla dostawców bez maski (Gemini / OpenRouter). */
export const GENERIC_EDIT_EDGE = 1536;
/** Dozwolone aspekty (jak providers): Gemini wg katalogu, OpenRouter bazowe. */
export const ASPECTS_BASE = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const GEMINI_PX = { "0.5K": 512, "1K": 1024, "2K": 2048, "4K": 4096 };
const GEMINI_ORDER = ["0.5K", "1K", "2K", "4K"];

export const DEFAULT_TILE_OPTS = Object.freeze({
  feather: 8,       // px sceny: miękka krawędź DO ŚRODKA prostokąta; 0 = ostra krawędź
  tokens: false,    // tokeny w obu obrazach
  mask: true,       // maska OpenAI (images/edits, tryb Teraz)
  count: 1
});

export const DEFAULT_TILE_PROMPT = [
  "You get two images of the same top-down battle map.",
  "Image 1 is the exact area to edit. Image 2 is a wider view of the map around it, for context only: the red rectangle in image 2 ({pos}) marks exactly where image 1 is.",
  "{guide}",
  "Edit image 1 like this: {description}.",
  "Keep the exact top-down orthographic camera, the lighting direction, colour palette, art style and scale of the map",
  "(one grid square is about {grid} px in image 1, which is {distance} {units}).",
  "Make the edges of image 1 continue seamlessly into the surrounding map shown in image 2.",
  "Return only the edited image 1 with the same framing. Do not reproduce image 2 or the red rectangle. No grid lines, text, labels, borders or frames."
].join(" ");

export const GUIDE_MASK = "The transparent area of the mask marks the part of image 1 that may change.";
export const GUIDE_NONE = "";

// ---------- liczby i prostokąty ----------

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Bounding box wielokąta (zaokrąglony NA ZEWNĄTRZ do całych px). */
export function bboxOf(points) {
  if (!points?.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const x = Math.floor(x0), y = Math.floor(y0);
  return { x, y, width: Math.ceil(x1) - x, height: Math.ceil(y1) - y };
}

/** Pole wielokąta (wartość bezwzględna, wzór Gaussa). */
export function polygonArea(points) {
  let a = 0;
  for (let i = 0, n = points?.length ?? 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Punkt w wielokącie (even-odd). */
export function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Czy kształt nadaje się do wysłania: >= 3 punkty, pole i boki powyżej minimum. */
export function validShape(points) {
  if (!Array.isArray(points) || points.length < 3) return { ok: false, reason: "points" };
  if (points.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) return { ok: false, reason: "points" };
  const b = bboxOf(points);
  if (Math.min(b.width, b.height) < MIN_SIDE || polygonArea(points) < MIN_AREA) return { ok: false, reason: "small" };
  return { ok: true };
}

/** Prostokąt z dwóch narożników (dowolna kolejność), zaokrąglony do całych px sceny. */
export function rectPoints(a, b) {
  const x0 = Math.round(Math.min(a.x, b.x)), x1 = Math.round(Math.max(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y)), y1 = Math.round(Math.max(a.y, b.y));
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

export const rectOf = (r) => rectPoints({ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height });

/** Przecięcie dwóch prostokątów (null = rozłączne). */
export function intersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

// ---------- obraz 1: region i rozmiar żądania ----------

const parseAspect = (a) => { const [w, h] = String(a).split(":").map(Number); return w / h; };

/** Najbliższy dozwolony aspekt (log-odległość, jak providers/util.mjs nearestAspect). */
export function nearestAspect(ratio, allowed = ASPECTS_BASE) {
  let best = allowed[0], bd = Infinity;
  for (const a of allowed) {
    const d = Math.abs(Math.log(parseAspect(a) / ratio));
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

/** Dozwolone aspekty dla dostawcy/modelu (null = dowolny WxH, OpenAI). */
export function aspectsFor(provider, model) {
  if (provider === "openai") return null;
  if (provider === "gemini") return getModel("gemini", model)?.aspects ?? ASPECTS_BASE;
  return ASPECTS_BASE;
}

/**
 * Powiększ prostokąt (nigdy nie zmniejszaj) do proporcji `ratio` (w/h), symetrycznie wokół środka; potem przesuń, by
 * mieścił się w `bounds` (gdy się da: większy od bounds zostaje wyśrodkowany na bounds). Wynik w całych px.
 */
export function expandToAspect(rect, ratio, bounds) {
  let w = rect.width, h = rect.height;
  if (w / h < ratio) w = h * ratio; else h = w / ratio;
  w = Math.ceil(w); h = Math.ceil(h);
  if (ratio >= 1) h = Math.max(rect.height, Math.round(w / ratio)); else w = Math.max(rect.width, Math.round(h * ratio));
  let x = Math.round(rect.x + rect.width / 2 - w / 2), y = Math.round(rect.y + rect.height / 2 - h / 2);
  if (bounds) {
    x = w <= bounds.width ? clamp(x, bounds.x, bounds.x + bounds.width - w) : Math.round(bounds.x + bounds.width / 2 - w / 2);
    y = h <= bounds.height ? clamp(y, bounds.y, bounds.y + bounds.height - h) : Math.round(bounds.y + bounds.height / 2 - h / 2);
    // przesunięcie nie może odsłonić zaznaczenia
    x = Math.min(x, rect.x); y = Math.min(y, rect.y);
    x = Math.max(x, rect.x + rect.width - w); y = Math.max(y, rect.y + rect.height - h);
  }
  return { x, y, width: w, height: h };
}

/** Gemini imageSize: najmniejszy z modelu >= dłuższy bok, nie większy niż `cap` (konfiguracja typu). */
export function geminiSizeFor(model, longEdge, cap = "1K") {
  const sizes = getModel("gemini", model)?.sizes ?? ["1K"];
  const capIdx = GEMINI_ORDER.indexOf(cap);
  const allowed = sizes.filter((s) => capIdx < 0 || GEMINI_ORDER.indexOf(s) <= capIdx);
  const list = allowed.length ? allowed : [sizes[0]];
  return list.find((s) => GEMINI_PX[s] >= longEdge) ?? list[list.length - 1];
}

/**
 * Plan obrazu 1 (edytowanego). Region = zaznaczenie powiększone tylko do proporcji, które model naprawdę zwraca
 * (OpenAI: rozmiar po regułach API ≈ proporcje zaznaczenia; Gemini/OpenRouter: najbliższy dozwolony aspekt), żeby wynik
 * dało się dokładnie odwzorować na scenę; po wyniku i tak przycinamy do zaznaczenia.
 * @param {object} p
 * @param {{x:number,y:number}[]} p.points  kształt (px sceny)
 * @param {{x,y,width,height}} [p.bounds]  gdzie region może leżeć (canvas.dimensions.rect)
 * @param {{provider:string, model:string, width:number, height:number, imageSize?:string}} p.cfg  konfiguracja typu
 * @returns {{bbox, region, request:{width,height,aspect?:string,imageSize?:string}, edit:{width,height}, ratio:number}}
 */
export function planRegion({ points, bounds, cfg }) {
  const bbox = bboxOf(points);
  const cap = Math.max(256, num(Math.max(num(cfg?.width, 1024), num(cfg?.height, 1024)), 2048));
  const provider = cfg?.provider ?? "openai";
  let request, ratio, edit;
  if (provider === "openai") {
    // rozmiar = zaznaczenie w px sceny, ograniczone limitem typu, potem reguły API (×16, < 2,9:1, min/max pikseli)
    const k = Math.min(1, cap / Math.max(bbox.width, bbox.height));
    const n = normalizeOpenAISize(bbox.width * k, bbox.height * k);
    request = { width: n.width, height: n.height };
    ratio = n.width / n.height;
    edit = { width: n.width, height: n.height };   // maska musi mieć wymiary obrazu
  } else {
    const aspect = nearestAspect(bbox.width / bbox.height, aspectsFor(provider, cfg?.model));
    ratio = parseAspect(aspect);
    request = { aspect, width: 0, height: 0 };
    if (provider === "gemini") request.imageSize = geminiSizeFor(cfg?.model, Math.max(bbox.width, bbox.height), cfg?.imageSize ?? "1K");
    const long = provider === "gemini" ? Math.min(GENERIC_EDIT_EDGE, GEMINI_PX[request.imageSize] ?? 1024) : 1024;
    request.width = ratio >= 1 ? long : Math.round(long * ratio);
    request.height = ratio >= 1 ? Math.round(long / ratio) : long;
    edit = { width: request.width, height: request.height };
  }
  const region = expandToAspect(bbox, ratio, bounds);
  if (provider !== "openai") {
    // bez maski wymiary obrazu są dowolne: mały region nie potrzebuje wejścia 1536 px (najwyżej 2 × px sceny, min. 512)
    const long = Math.min(Math.max(edit.width, edit.height), Math.max(512, 2 * Math.max(region.width, region.height)));
    edit = ratio >= 1 ? { width: long, height: Math.max(1, Math.round(long / ratio)) } : { width: Math.max(1, Math.round(long * ratio)), height: long };
  }
  return { bbox, region, request, edit, ratio };
}

// ---------- obraz 2: kontekst ----------

/**
 * Kontekst: prostokąt `factor`× szerszy i wyższy wokół środka zaznaczenia, przycięty do `bounds` (nie przesuwany:
 * zaznaczenie przy krawędzi sceny nie jest wtedy pośrodku). `sel` = położenie zaznaczenia w kontekście w ułamkach 0..1.
 * @returns {{rect:{x,y,width,height}, sel:{x0,y0,x1,y1}, size:{width,height}, clipped:boolean}}
 */
export function contextPlan(bbox, bounds, { factor = CONTEXT_FACTOR, maxEdge = CONTEXT_EDGE } = {}) {
  const cx = bbox.x + bbox.width / 2, cy = bbox.y + bbox.height / 2;
  const w = bbox.width * factor, h = bbox.height * factor;
  const full = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h) };
  const rect = (bounds ? intersect(full, bounds) : full) ?? { ...bbox };
  const sel = {
    x0: (bbox.x - rect.x) / rect.width, y0: (bbox.y - rect.y) / rect.height,
    x1: (bbox.x + bbox.width - rect.x) / rect.width, y1: (bbox.y + bbox.height - rect.y) / rect.height
  };
  // rozmiar obrazu: dłuższy bok ≤ maxEdge, nigdy więcej px niż scena (bez powiększania)
  const k = Math.min(1, maxEdge / Math.max(rect.width, rect.height));
  const size = { width: Math.max(1, Math.round(rect.width * k)), height: Math.max(1, Math.round(rect.height * k)) };
  const clipped = rect.width !== full.width || rect.height !== full.height || rect.x !== full.x || rect.y !== full.y;
  return { rect, sel, size, clipped };
}

/** Położenie zaznaczenia w obrazie 2 słowami dla modelu: "from 25% to 75% of the width and from 25% to 75% of the height". */
export function positionText(sel) {
  const p = (v) => `${Math.round(clamp(v, 0, 1) * 100)}%`;
  return `from ${p(sel.x0)} to ${p(sel.x1)} of its width and from ${p(sel.y0)} to ${p(sel.y1)} of its height`;
}

// ---------- koszt wejścia ----------

/**
 * Szacunek tokenów obrazów wejściowych (reguły OpenAI z image-cost.mjs; inni dostawcy: null).
 * Obraz 1 idzie bez zmniejszania, obraz 2 przez zwykłe zmniejszanie referencji (przeznaczenie/limit typu).
 * @returns {{images:number, edit:number|null, context:number|null, total:number|null, contextSent:{width,height}}}
 */
export function inputEstimate(cfg, edit, ctxSize) {
  const rules = rulesFor(cfg?.provider, cfg?.model);
  const plan = planRef(ctxSize, { rules, purpose: fitPurpose(cfg?.refPurpose), maxEdge: clampMaxEdge(cfg?.refMaxEdge) });
  const contextSent = { width: plan.width, height: plan.height };
  if (rules !== "openai") return { images: 2, edit: null, context: null, total: null, contextSent };
  const e = openaiInputTokens(edit.width, edit.height).tokens, c = openaiInputTokens(plan.width, plan.height).tokens;
  return { images: 2, edit: e, context: c, total: e + c, contextSent };
}

// ---------- wynik modelu -> plik kafelka ----------

/**
 * Część wyniku odpowiadająca regionowi: przy różnicy proporcji > tol (1 %) środek wyniku przycięty do oczekiwanych
 * proporcji (model zwykle trzyma kadr wyśrodkowany). @returns {{sx,sy,sw,sh}} w px wyniku
 */
export function resultCrop(resultW, resultH, ratio, tol = 0.01) {
  const r = resultW / resultH;
  if (Math.abs(Math.log(r / ratio)) <= tol) return { sx: 0, sy: 0, sw: resultW, sh: resultH };
  if (r > ratio) { const sw = Math.round(resultH * ratio); return { sx: Math.round((resultW - sw) / 2), sy: 0, sw, sh: resultH }; }
  const sh = Math.round(resultW / ratio);
  return { sx: 0, sy: Math.round((resultH - sh) / 2), sw: resultW, sh };
}

/**
 * Jak narysować wynik w pliku kafelka. Skala s = px wyniku na px sceny (z kadru), ograniczona `maxEdge` pliku.
 * Plik ma wymiary bbox × s; wynik (kadr `crop`) rysowany w (region - bbox) × s w rozmiarze region × s.
 * @returns {{scale:number, out:{width,height}, draw:{sx,sy,sw,sh,dx,dy,dw,dh}}}
 */
export function tileRaster({ bbox, region, resultW, resultH, ratio, maxEdge = 4096 }) {
  const crop = resultCrop(resultW, resultH, ratio ?? region.width / region.height);
  let s = crop.sw / region.width;
  const longOut = Math.max(bbox.width, bbox.height) * s;
  if (maxEdge > 0 && longOut > maxEdge) s *= maxEdge / longOut;
  const out = { width: Math.max(1, Math.round(bbox.width * s)), height: Math.max(1, Math.round(bbox.height * s)) };
  return {
    scale: s,
    out,
    draw: { ...crop, dx: (region.x - bbox.x) * s, dy: (region.y - bbox.y) * s, dw: region.width * s, dh: region.height * s }
  };
}

/**
 * Alfa kafelka z miękką krawędzią DO ŚRODKA: prostokąt pliku zwężony o połowę krawędzi i rozmyty (sigma = 1/4
 * krawędzi), więc alfa ≈ 0 na brzegu pliku i 1 w odległości `featherPx` od brzegu. 0 = ostro (cały plik).
 * @returns {{x,y,width,height,blur:number}} w px pliku
 */
export function alphaRect(out, featherPx) {
  const f = Math.max(0, Math.min(num(featherPx, 0), Math.min(out.width, out.height) / 2));
  if (f < 0.5) return { x: 0, y: 0, width: out.width, height: out.height, blur: 0 };
  return { x: f / 2, y: f / 2, width: out.width - f, height: out.height - f, blur: f / 4 };
}

/** Punkty kształtu w układzie prostokąta `rect` przeskalowanego o `scale` (maska, kontekst, plik kafelka). */
export function pointsIn(points, rect, scale = 1, scaleY = scale) {
  return points.map((p) => ({ x: (p.x - rect.x) * scale, y: (p.y - rect.y) * scaleY }));
}

// ---------- Tile ----------

/**
 * Dane Tile: bbox kształtu w px sceny, rotacja 0, elewacja `elevation` (domyślnie 0), sort nad kafelkami tej elewacji.
 * @param {{x,y,width,height}} bbox
 * @param {{elevation?:number, sort?:number}[]} existing  kafelki sceny
 */
export function tileData({ bbox, src, existing = [], elevation = 0, flags }) {
  const same = existing.filter((t) => num(t.elevation, 0) === elevation).map((t) => num(t.sort, 0));
  const sort = same.length ? Math.max(...same) + 1 : 0;
  return {
    x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height, rotation: 0, elevation, sort,
    texture: { src },
    ...(flags ? { flags } : {})
  };
}

// ---------- prompt ----------

/** Szablon promptu z polami {description} {grid} {distance} {units} {scene} {guide} {pos}. */
export function renderTilePrompt(template, vars = {}) {
  const v = {
    description: String(vars.description ?? "").trim().replace(/[.\s]+$/, ""),
    grid: String(Math.round(num(vars.grid, 0)) || "?"),
    distance: String(vars.distance ?? ""),
    units: String(vars.units ?? ""),
    scene: String(vars.scene ?? ""),
    guide: String(vars.guide ?? ""),
    pos: String(vars.pos ?? ""),
    name: String(vars.scene ?? ""),
    type: "map tile"
  };
  return String(template || DEFAULT_TILE_PROMPT).replace(/\{(description|grid|distance|units|scene|guide|pos|name|type)\}/g, (_, k) => v[k])
    .replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,])/g, "$1").trim();
}

/** Rozmiar pola siatki w px OBRAZU 1: grid.size × (szer. obrazu / szer. regionu). */
export const gridInEdit = (gridSize, edit, region) => num(gridSize, 100) * (edit.width / region.width);

/** Dane geometrii zapisywane w batchu (małe: punkty względem bbox, zaokrąglone do 0,1 px). */
export function packGeometry({ sceneId, bbox, region, ratio, points, feather }) {
  return {
    sceneId, bbox, region, ratio: Math.round(ratio * 1e6) / 1e6, feather: num(feather, 0),
    points: points.map((p) => [Math.round((p.x - bbox.x) * 10) / 10, Math.round((p.y - bbox.y) * 10) / 10])
  };
}

export function unpackGeometry(g) {
  return { ...g, points: (g?.points ?? []).map(([x, y]) => ({ x: x + g.bbox.x, y: y + g.bbox.y })) };
}
