// W7-A/W7-B AI Tile: czysta geometria i planowanie (bez Foundry, bez canvas; testy: dev/test-ai-tile-core.mjs).
// Układ współrzędnych: px sceny (jak Tile.x/y/width/height). Kształt = zamknięty wielokąt [{x,y}, ...] bez powtórzonego
// pierwszego punktu na końcu. Decyzja właściciela (2026-11-19): na razie TYLKO prostokąt; geometria (bbox, punkty
// w batchu) zostaje ogólna, żeby inne kształty dało się dodać później, ale nie są zaimplementowane.
//
// W7-B (zmiana właściciela 2026-11-19, po teście na żywo): do modelu idzie JEDEN obraz = otoczenie zaznaczenia
// (domyślnie 2× szersze i 2× wyższe wokół tego samego środka, przycięte do granic płótna, potem dopasowane do proporcji
// modelu) z czerwonym obrysem tuż POZA zaznaczeniem; bez maski i bez drugiego obrazu. Model zwraca cały obraz; z wyniku
// wycinamy dokładnie zaznaczenie (znamy jego położenie w obrazie), skalujemy do kafelka, miękka krawędź jak dotąd.
import { normalizeOpenAISize, getModel } from "../providers/models.mjs";
import { openaiInputTokens, rulesFor } from "../image-cost.mjs";

export const TILE_TYPE_KEY = "moinens-ai-gen.tile";
/** Kształty dostępne w UI (na razie tylko prostokąt). */
export const SHAPES = Object.freeze(["rect"]);
/** Najmniejszy sensowny kształt (px sceny): krótszy bok bbox i pole. */
export const MIN_SIDE = 8;
export const MIN_AREA = 64;
/** Otoczenie: ile razy większe (szer. i wys.) od zaznaczenia; domyślnie 2, w oknie do wyboru. */
export const CONTEXT_FACTOR = 2;
export const CONTEXT_FACTORS = Object.freeze([1.5, 2, 3]);
/** Dłuższy bok wysyłanego obrazu dla dostawców z aspektem (Gemini / OpenRouter), najwyżej. */
export const GENERIC_EDIT_EDGE = 1536;
/** Obrys zaznaczenia w wysyłanym obrazie: kolor, grubość = ułamek dłuższego boku obrazu, minimum px. */
export const OUTLINE_COLOR = "#ff0000";
export const OUTLINE_FRAC = 0.004;
export const OUTLINE_MIN = 4;
/** Dozwolone aspekty (jak providers): Gemini wg katalogu, OpenRouter bazowe. */
export const ASPECTS_BASE = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const GEMINI_PX = { "0.5K": 512, "1K": 1024, "2K": 2048, "4K": 4096 };
const GEMINI_ORDER = ["0.5K", "1K", "2K", "4K"];

/**
 * Opcje okna. W7-B: maski już nie ma (test na żywo: maska całego prostokąta = model rysuje kadr od nowa), dawny klucz
 * `mask` z zapisów jest pomijany. `context` = współczynnik otoczenia (CONTEXT_FACTORS).
 */
export const DEFAULT_TILE_OPTS = Object.freeze({
  feather: 8,       // px sceny: miękka krawędź DO ŚRODKA prostokąta; 0 = ostra krawędź
  context: CONTEXT_FACTOR,
  count: 1
});

/** Opcje okna z zapisu `tileOptions` (albo z formularza) + domyślne; nieznane klucze (dawne `mask`, `tokens`) pomijane. */
export function normalizeTileOptions(saved = {}) {
  const s = saved && typeof saved === "object" ? saved : {};
  const d = DEFAULT_TILE_OPTS;
  const f = Number(s.context);
  return {
    feather: s.feather != null && Number.isFinite(Number(s.feather)) ? Math.min(256, Math.max(0, Math.round(Number(s.feather)))) : d.feather,
    context: CONTEXT_FACTORS.includes(f) ? f : d.context,
    count: Math.min(8, Math.max(1, Math.floor(Number(s.count)) || d.count))
  };
}

/**
 * Domyślny szablon (W7-B, wg promptu sprawdzonego na żywo przez właściciela, gpt-image-2.6-flare medium).
 * Pola: {description} {grid} {distance} {units} {scene} {pos}; {guide} zostaje tylko dla starych własnych szablonów (pusty).
 */
export const DEFAULT_TILE_PROMPT = [
  "This is a top-down battle map.",
  "Edit ONLY the area inside the red rectangle: {description}.",
  "Everything outside the red rectangle must stay exactly the same, pixel for pixel.",
  "Keep the same camera, zoom and scale (one grid square is about {grid} px, which is {distance} {units}), lighting and art style.",
  "Do not zoom out, do not crop, do not add or remove objects unless asked.",
  "Return the whole image with the same framing and remove the red rectangle outline.",
  "No grid lines, text or labels."
].join(" ");

/** Wcześniejsze domyślne szablony (W7-A, dwa obrazy): zapis równy któremuś z nich = nie zmieniany -> nowy domyślny. */
export const LEGACY_TILE_PROMPTS = Object.freeze([
  [
    "You get two images of the same top-down battle map.",
    "Image 1 is the exact area to edit. Image 2 is a wider view of the map around it, for context only: the red rectangle in image 2 ({pos}) marks exactly where image 1 is.",
    "{guide}",
    "Edit image 1 like this: {description}.",
    "Keep the exact top-down orthographic camera, the lighting direction, colour palette, art style and scale of the map",
    "(one grid square is about {grid} px in image 1, which is {distance} {units}).",
    "Make the edges of image 1 continue seamlessly into the surrounding map shown in image 2.",
    "Return only the edited image 1 with the same framing. Do not reproduce image 2 or the red rectangle. No grid lines, text, labels, borders or frames."
  ].join(" ")
]);

const normTpl = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
const LEGACY_SET = new Set(LEGACY_TILE_PROMPTS.map(normTpl));

/** Czy szablon to dawny domyślny (porównanie bez różnic w białych znakach, np. \r\n z pola tekstowego). */
export const isLegacyTilePrompt = (t) => LEGACY_SET.has(normTpl(t));

/** Szablon do użycia: pusty albo dawny domyślny -> obecny DEFAULT_TILE_PROMPT; własny szablon bez zmian. */
export const tilePromptTemplate = (t) => (!normTpl(t) || isLegacyTilePrompt(t) ? DEFAULT_TILE_PROMPT : t);


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

// ---------- wysyłany obraz: otoczenie, region i rozmiar żądania ----------

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
 * Otoczenie zaznaczenia przed dopasowaniem proporcji: prostokąt `factor`× szerszy i wyższy wokół środka zaznaczenia,
 * PRZYCIĘTY do `bounds` (nie przesuwany), zawsze zawierający zaznaczenie. Przy krawędzi płótna zaznaczenie nie jest
 * wtedy pośrodku (pozycję liczy `selIn`).
 */
export function contextRect(bbox, bounds, factor = CONTEXT_FACTOR) {
  const f = Math.max(1, num(factor, CONTEXT_FACTOR));
  const cx = bbox.x + bbox.width / 2, cy = bbox.y + bbox.height / 2;
  const w = bbox.width * f, h = bbox.height * f;
  const full = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h) };
  let r = bounds ? intersect(full, bounds) ?? { ...bbox } : full;
  // zaznaczenie (nawet wystające poza bounds) zawsze w całości w środku
  const x0 = Math.min(r.x, bbox.x), y0 = Math.min(r.y, bbox.y);
  const x1 = Math.max(r.x + r.width, bbox.x + bbox.width), y1 = Math.max(r.y + r.height, bbox.y + bbox.height);
  r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const clipped = r.width !== full.width || r.height !== full.height || r.x !== full.x || r.y !== full.y;
  return { rect: r, full, clipped };
}

/** Położenie `bbox` w prostokącie `region` w ułamkach 0..1 (x0,y0 = lewy górny róg, x1,y1 = prawy dolny). */
export function selIn(bbox, region) {
  return {
    x0: (bbox.x - region.x) / region.width, y0: (bbox.y - region.y) / region.height,
    x1: (bbox.x + bbox.width - region.x) / region.width, y1: (bbox.y + bbox.height - region.y) / region.height
  };
}

/**
 * Plan wysyłanego obrazu (jedynego). Region = otoczenie zaznaczenia (`contextRect`) powiększone TYLKO do proporcji,
 * które model naprawdę zwraca (OpenAI: rozmiar po regułach API; Gemini/OpenRouter: najbliższy dozwolony aspekt),
 * w granicach płótna, nigdy nie odsłaniając otoczenia; dzięki temu wynik da się dokładnie odwzorować na scenę.
 * Rozmiar: OpenAI = px sceny regionu (bez powiększania), ograniczone dłuższym bokiem typu i regułami API, więc
 * zaznaczenie ma swoją natywną rozdzielczość, o ile region mieści się w limicie; Gemini: najmniejszy imageSize
 * ≥ dłuższy bok regionu (≤ limit typu); OpenRouter: 1024.
 * @param {object} p
 * @param {{x:number,y:number}[]} p.points  kształt (px sceny)
 * @param {{x,y,width,height}} [p.bounds]  gdzie region może leżeć (canvas.dimensions.rect)
 * @param {{provider:string, model:string, width:number, height:number, imageSize?:string}} p.cfg  konfiguracja typu
 * @param {number} [p.factor]  współczynnik otoczenia (domyślnie 2)
 * @returns {{bbox, context, region, request:{width,height,aspect?:string,imageSize?:string}, edit:{width,height},
 *   ratio:number, sel:{x0,y0,x1,y1}, factor:number, clipped:boolean}}
 */
export function planRegion({ points, bounds, cfg, factor = CONTEXT_FACTOR }) {
  const bbox = bboxOf(points);
  const ctx = contextRect(bbox, bounds, factor);
  const base = ctx.rect;
  const cap = Math.max(256, num(Math.max(num(cfg?.width, 1024), num(cfg?.height, 1024)), 2048));
  const provider = cfg?.provider ?? "openai";
  let request, ratio, edit;
  if (provider === "openai") {
    // rozmiar = otoczenie w px sceny, ograniczone limitem typu, potem reguły API (×16, < 2,9:1, min/max pikseli)
    const k = Math.min(1, cap / Math.max(base.width, base.height));
    const n = normalizeOpenAISize(base.width * k, base.height * k);
    request = { width: n.width, height: n.height };
    ratio = n.width / n.height;
    edit = { width: n.width, height: n.height };   // wysyłany obraz = rozmiar żądania (wynik 1:1 z wejściem)
  } else {
    const aspect = nearestAspect(base.width / base.height, aspectsFor(provider, cfg?.model));
    ratio = parseAspect(aspect);
    request = { aspect, width: 0, height: 0 };
    if (provider === "gemini") request.imageSize = geminiSizeFor(cfg?.model, Math.max(base.width, base.height), cfg?.imageSize ?? "1K");
    const long = provider === "gemini" ? Math.min(GENERIC_EDIT_EDGE, GEMINI_PX[request.imageSize] ?? 1024) : 1024;
    request.width = ratio >= 1 ? long : Math.round(long * ratio);
    request.height = ratio >= 1 ? Math.round(long / ratio) : long;
    edit = { width: request.width, height: request.height };
  }
  const region = expandToAspect(base, ratio, bounds);
  if (provider !== "openai") {
    // wymiary wysyłanego obrazu są tu dowolne: mały region nie potrzebuje 1536 px (najwyżej px sceny, min. 512)
    const long = Math.min(Math.max(edit.width, edit.height), Math.max(512, Math.max(region.width, region.height)));
    edit = ratio >= 1 ? { width: long, height: Math.max(1, Math.round(long / ratio)) } : { width: Math.max(1, Math.round(long * ratio)), height: long };
  }
  return { bbox, context: base, region, request, edit, ratio, sel: selIn(bbox, region), factor: num(factor, CONTEXT_FACTOR), clipped: ctx.clipped };
}

/**
 * Obrys zaznaczenia w obrazie w×h (px obrazu): 4 pasy tuż POZA zaznaczeniem, więc żaden czerwony piksel nie leży
 * w zaznaczeniu. Granice zaznaczenia zaokrąglone NA ZEWNĄTRZ (floor/ceil), grubość = max(OUTLINE_MIN,
 * round(OUTLINE_FRAC × dłuższy bok)); pasy przycięte do obrazu (zaznaczenie przy krawędzi płótna = brak pasa).
 * @returns {{lw:number, inner:{x0,y0,x1,y1}, bands:{x,y,width,height}[]}}
 */
export function outlineBands(sel, w, h) {
  const lw = Math.max(OUTLINE_MIN, Math.round(OUTLINE_FRAC * Math.max(w, h)));
  const ix0 = Math.floor(clamp(sel.x0, 0, 1) * w + 1e-6), iy0 = Math.floor(clamp(sel.y0, 0, 1) * h + 1e-6);
  const ix1 = Math.ceil(clamp(sel.x1, 0, 1) * w - 1e-6), iy1 = Math.ceil(clamp(sel.y1, 0, 1) * h - 1e-6);
  const raw = [
    { x: ix0 - lw, y: iy0 - lw, width: ix1 - ix0 + 2 * lw, height: lw },   // góra
    { x: ix0 - lw, y: iy1, width: ix1 - ix0 + 2 * lw, height: lw },        // dół
    { x: ix0 - lw, y: iy0, width: lw, height: iy1 - iy0 },                 // lewo
    { x: ix1, y: iy0, width: lw, height: iy1 - iy0 }                       // prawo
  ];
  const img = { x: 0, y: 0, width: w, height: h };
  return { lw, inner: { x0: ix0, y0: iy0, x1: ix1, y1: iy1 }, bands: raw.map((b) => intersect(b, img)).filter(Boolean) };
}

/** Położenie zaznaczenia w obrazie słowami (pole {pos}): "from 25% to 75% of its width and from 25% to 75% of its height". */
export function positionText(sel) {
  const p = (v) => `${Math.round(clamp(v, 0, 1) * 100)}%`;
  return `from ${p(sel.x0)} to ${p(sel.x1)} of its width and from ${p(sel.y0)} to ${p(sel.y1)} of its height`;
}

// ---------- koszt wejścia ----------

/** Obrazy wejściowe AI Tile: jeden (otoczenie z obrysem). */
export const INPUT_IMAGES = 1;

/**
 * Szacunek tokenów obrazu wejściowego (reguły OpenAI z image-cost.mjs; inni dostawcy: null). Obraz idzie bez zmniejszania.
 * @returns {{images:number, tokens:number|null, sent:{width,height}}}
 */
export function inputEstimate(cfg, edit) {
  const sent = { width: edit.width, height: edit.height };
  if (rulesFor(cfg?.provider ?? "openai", cfg?.model) !== "openai") return { images: INPUT_IMAGES, tokens: null, sent };
  return { images: INPUT_IMAGES, tokens: openaiInputTokens(edit.width, edit.height).tokens, sent };
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
 * Jak wyciąć zaznaczenie z wyniku do pliku kafelka. Wynik (kadr `crop`) = region; zaznaczenie `bbox` leży w nim
 * w znanym miejscu, więc źródło = dokładnie prostokąt zaznaczenia w px wyniku (`sx..sx+sw`), cel = cały plik.
 * Skala pliku s = px wyniku na px sceny, ograniczona `maxEdge` pliku; plik ma wymiary bbox × s.
 * @returns {{scale:number, out:{width,height}, draw:{sx,sy,sw,sh,dx,dy,dw,dh}}}
 */
export function tileRaster({ bbox, region, resultW, resultH, ratio, maxEdge = 4096 }) {
  const crop = resultCrop(resultW, resultH, ratio ?? region.width / region.height);
  const kx = crop.sw / region.width, ky = crop.sh / region.height;   // px wyniku na px sceny
  let s = kx;
  const longOut = Math.max(bbox.width, bbox.height) * s;
  if (maxEdge > 0 && longOut > maxEdge) s *= maxEdge / longOut;
  const out = { width: Math.max(1, Math.round(bbox.width * s)), height: Math.max(1, Math.round(bbox.height * s)) };
  return {
    scale: s,
    out,
    draw: {
      sx: crop.sx + (bbox.x - region.x) * kx, sy: crop.sy + (bbox.y - region.y) * ky, sw: bbox.width * kx, sh: bbox.height * ky,
      dx: 0, dy: 0, dw: out.width, dh: out.height
    }
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

// ---------- co trafia na wysyłany obraz (render canvas.primary) ----------

/**
 * W8: warstwy moinen-maps w canvas.primary, które SĄ mapą (zostają na obrazie): 240 malowana woda, 245 drogi.
 * W8 (właściciel, po teście na The Warehouse): 247 NIE idzie do modelu. To cała warstwa zniszczeń moinen-maps
 * (destruction/display.mjs `layer(247)`: obiekty uszkodzeń - gruz, kratery, spalenizna, zalane dziury, rysy, cięcia -
 * plus ich statyczny cache i „gumki” z czystą mapą); nic z mapy w stanie nienaruszonym tam nie leży (tło sceny
 * destruction nie zmienia), więc bez 247 model widzi czystą mapę, a nie gruz jako jej część.
 * Reszta tej grupy to efekty / znaczniki / interfejs: 247 zniszczenia (j.w.),
 * 248 odbicia w wodzie i odłamki, 249 cząstki zniszczeń, 250 dzielnice (nakładka), 251 poświaty świateł, 252/253,
 * 255 auta i zmarszczki wody, 256/750/800 ogień i dym, 258 strefy (numery, ikony, podświetlenia), 705 zanurzenie,
 * 801 para, 819-825 presety (rakiety, błyskawice...), 990-1000 pogoda, 100 życie sceny Orbita (gwiazdy, chmury),
 * a także rysunki, Sequencer / pixel-vfx i wszystko z innych modułów.
 */
export const CAPTURE_MAP_LAYERS = Object.freeze([240, 245]);

/**
 * Czy dziecko canvas.primary narysować na wysyłanym obrazie. Właściciel (W8): do modelu idzie WYŁĄCZNIE mapa (tło sceny
 * + warstwy mapy moinen-maps) i kafelki w rejonie. Kafelki: wszystkie poniżej „overhead” (elewacja < foregroundElevation),
 * także UKRYTE przed graczami (MG je widzi i buduje z nich mapę; nowy AI Tile jest ukryty), w swojej kolejności
 * (elewacja, sort) i z alfą dokumentu. Nigdy: pierwszy plan / dachy, tokeny, pogoda, efekty, VFX, ogień, dym, znaczniki
 * stref, pinezki, rysunki, światła i wszystko nieznane.
 * @param {{kind:"background"|"foreground"|"tile"|"token"|"weather"|"other", sortLayer?:number, elevation?:number,
 *          overhead?:boolean}} c
 */
export function captureInclude(c) {
  switch (c?.kind) {
    case "background": return true;
    case "tile": return !c.overhead;
    case "foreground": case "token": case "weather": return false;
    default: return CAPTURE_MAP_LAYERS.includes(num(c?.sortLayer, NaN)) && num(c?.elevation, 0) === 0;
  }
}

// ---------- Tile ----------

/**
 * Dane Tile: bbox kształtu w px sceny, rotacja 0, elewacja `elevation` (domyślnie 0), sort nad kafelkami tej elewacji.
 * v14: x/y Tile to punkt KOTWICY kształtu (`texture.anchorX/Y`, domyślnie 0.5 = środek), nie lewy górny róg
 * (sprawdzone na żywo, lane 8: x/y = róg dało kafelek przesunięty o pół rozmiaru). Kotwica 0.5 podana jawnie.
 * @param {{x,y,width,height}} bbox
 * W8: `hidden` (domyślnie true): nowy kafelek widzi tylko MG (półprzezroczysty), gracze dopiero po odkryciu.
 * @param {{elevation?:number, sort?:number}[]} existing  kafelki sceny
 */
export function tileData({ bbox, src, existing = [], elevation = 0, hidden = true, flags }) {
  const same = existing.filter((t) => num(t.elevation, 0) === elevation).map((t) => num(t.sort, 0));
  const sort = same.length ? Math.max(...same) + 1 : 0;
  return {
    x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2, width: bbox.width, height: bbox.height,
    rotation: 0, elevation, sort, hidden: !!hidden,
    texture: { src, anchorX: 0.5, anchorY: 0.5 },
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
