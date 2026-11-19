// W10 AI Tile: kafelek AI jako „łata mapy” pod nakładkami sceny (wygląd zgodny z otoczeniem, bez pieczenia barw).
//
// Przyczyna (lane 8, The Warehouse, ciemność 0,9): ciemność / światła Foundry v14 działają na kafelek DOKŁADNIE jak na
// tło (filtr grupy `canvas.primary`; ten sam shader siatki; kafelek-kopia czystej mapy = identyczne piksele, gdy ukryte są
// wszystkie warstwy moinen-maps). Jaśniejszy prostokąt robią nakładki moinen-maps rysowane NA mapie, ale POD kafelkami
// (sortLayer kafelków 500): 252 mokra ziemia (deszcz przyciemnia barwy mapy), 258 zabarwienie stref (czerwone „ogień”),
// 250/251 dzielnice i poświaty świateł, 253/255 rozbryzgi i zmarszczki, 248/249 odbicia i pył. Kafelek na 500 je zakrywał.
//
// Zasada: siatka kafelka AI (flaga `aiTile`) dostaje na TYM kliencie sortLayer AI_TILE_SORT_LAYER = 247,5: nad tłem (0),
// wodą (240), drogami (245) i warstwą zniszczeń (247: gruz i jej „łaty czystej mapy”, które nad kafelkiem odsłoniłyby
// starą mapę), pod wszystkimi nakładkami (248-258), ogniem/dymem (256/750/800), rysunkami (600), tokenami (700) i pogodą
// (990-1000). Silnik i moinen-maps same nakładają na kafelek ciemność, strefy i deszcz, także po ich zmianie. Na scenie
// bez takich warstw nic się nie zmienia (między 0 a 500 nic nie leży).
// Wyjątek: inny, ZWYKŁY kafelek na tej samej elewacji, nachodzący na kafelek AI i leżący pod nim (sort <=) -> 500 jak
// dotąd (kafelek AI musi zostać nad nim; wtedy zakrywa nakładki jak przed W10). Dokument nie jest zmieniany.
// Czyste funkcje na górze: testy w dev/test-ai-tile-layer.mjs.
import { MODULE_ID } from "../constants.mjs";
import { TILE_FLAG } from "./tile-fade.mjs";

/** sortLayer kafelków w Foundry (PrimaryCanvasGroup.SORT_LAYERS.TILES). */
export const TILES_SORT_LAYER = 500;
/** sortLayer siatki kafelka AI: tuż nad warstwą zniszczeń moinen-maps (247), pod jej nakładkami (248+). */
export const AI_TILE_SORT_LAYER = 247.5;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const isAiTileDoc = (doc) => !!doc?.flags?.[MODULE_ID]?.[TILE_FLAG];

/** Czy dwa prostokąty {x,y,width,height} mają wspólne pole (> 0; samo stykanie się krawędzią się nie liczy). */
export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0;
}

/**
 * sortLayer siatki kafelka.
 * @param {{ai:boolean, rect:{x,y,width,height}, elevation:number, sort:number}} me
 * @param {{ai:boolean, rect, elevation, sort}[]} others  pozostałe kafelki sceny
 * @returns {number|null}  null = nie kafelek AI (nie ruszać, Foundry ustawia 500)
 */
export function aiTileSortLayer(me, others = []) {
  if (!me?.ai) return null;
  const el = num(me.elevation), so = num(me.sort);
  const under = others.some((o) => o && !o.ai && num(o.elevation) === el && num(o.sort) <= so && rectsOverlap(me.rect, o.rect));
  return under ? TILES_SORT_LAYER : AI_TILE_SORT_LAYER;
}

// ---------------------------------------------------------------- runtime (Foundry)

let installed = false;

const descr = (t) => {
  const b = t.bounds, d = t.document;
  return { ai: isAiTileDoc(d), rect: b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null, elevation: d.elevation, sort: d.sort };
};

/** Ustaw sortLayer siatki kafelka AI (po Tile#_refreshState, który zawsze wpisuje 500). */
export function applyTileLayer(obj) {
  const m = obj?.mesh;
  if (!m || m.destroyed || !isAiTileDoc(obj.document)) return null;
  const others = (canvas?.tiles?.placeables ?? []).filter((t) => t !== obj && t.document?.id !== obj.document.id);
  const layer = aiTileSortLayer(descr(obj), others.map(descr));
  if (layer !== null && m.sortLayer !== layer) m.sortLayer = layer;   // setter: canvas.primary.sortDirty
  return layer;
}

/** Przelicz wszystkie kafelki AI na scenie (po dodaniu / zmianie / usunięciu dowolnego kafelka). */
function reflowAll() {
  for (const t of canvas?.tiles?.placeables ?? []) {
    if (isAiTileDoc(t.document)) { try { t.renderFlags.set({ refreshState: true }); } catch { /* best effort */ } }
  }
}

/** Hooki (raz, przy init). */
export function installTileLayer() {
  if (installed) return;
  installed = true;
  Hooks.on("refreshTile", (obj, flags) => {
    if (!flags?.refreshState) return;
    try { applyTileLayer(obj); } catch (e) { console.warn(`${MODULE_ID} | AI Tile layer`, e); }
  });
  const onScene = (doc) => doc?.parent?.id === canvas?.scene?.id;
  Hooks.on("createTile", (doc) => { if (onScene(doc)) reflowAll(); });
  Hooks.on("updateTile", (doc) => { if (onScene(doc)) reflowAll(); });
  Hooks.on("deleteTile", (doc) => { if (onScene(doc)) reflowAll(); });
}
