// W8 AI Tile: płynne pojawienie się kafelka (fade-in) na KAŻDYM kliencie, bez zapisu dokumentu.
// (a) u MG, który go wkleił (createTile, kafelek ukryty: dochodzi do półprzezroczystości MG),
// (b) u wszystkich, gdy MG go odkryje (updateTile hidden true -> false).
// Tylko alfa siatki na tym kliencie: dokument zostaje z alpha 1, więc błąd / zamknięcie sceny nie zostawi
// półprzezroczystego kafelka (siatka i tak powstaje od nowa, a na końcu Foundry przelicza swój stan).
// Czyste funkcje (krzywa, decyzje) na górze: testowane w dev/test-ai-tile-fade.mjs bez Foundry.
import { MODULE_ID } from "../constants.mjs";

export const TILE_FLAG = "aiTile";
export const FADE_DEFAULT_S = 5;
export const FADE_MAX_S = 30;
/** Ile czekać na siatkę z wczytaną teksturą, zanim zegar ruszy; potem zanikanie porzucone (kafelek zostaje widoczny). */
export const READY_TIMEOUT_MS = 15000;

/** Ustawienie (sekundy) -> sekundy w [0, FADE_MAX_S]; zła wartość = domyślne 5 s. 0 = bez animacji. */
export function fadeSeconds(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return FADE_DEFAULT_S;
  return Math.min(FADE_MAX_S, Math.max(0, n));
}

/** Krzywa: 0 -> 1 przez `durMs` (smoothstep: łagodny start i koniec). durMs <= 0 = od razu 1. */
export function fadeFactor(elapsedMs, durMs) {
  if (!(durMs > 0)) return 1;
  const t = Math.min(1, Math.max(0, Number(elapsedMs) / durMs || 0));
  return t * t * (3 - 2 * t);
}

const isAiTile = (doc) => !!doc?.flags?.[MODULE_ID]?.[TILE_FLAG];

/** Fade po utworzeniu: tylko kafelek AI i tylko u użytkownika, który go utworzył (MG). */
export function fadeOnCreate(doc, userId, myId) {
  return isAiTile(doc) && !!userId && userId === myId;
}

/** Fade po zmianie: kafelek AI właśnie odkryty (hidden -> false) — u wszystkich. */
export function fadeOnUpdate(doc, changes) {
  return isAiTile(doc) && !!changes && Object.prototype.hasOwnProperty.call(changes, "hidden") && changes.hidden === false;
}

/** Zmiana, która kończy trwające zanikanie od razu (ponowne ukrycie). */
export function stopOnUpdate(changes) {
  return !!changes && changes.hidden === true;
}

// ---------------------------------------------------------------- runtime (Foundry)

const fades = new Map();   // tileId -> { created, start|null, dur }
let ticking = false;
let installed = false;

function durMs() {
  let s = FADE_DEFAULT_S;
  try { s = fadeSeconds(game.settings.get(MODULE_ID, "tileFadeSeconds")); } catch { /* przed rejestracją */ }
  return s * 1000;
}

const now = () => performance.now();
const tileObj = (id) => canvas?.tiles?.get?.(id) ?? null;
const liveMesh = (o) => (o && !o.destroyed && o.mesh && !o.mesh.destroyed ? o.mesh : null);
/** Alfa, którą Foundry nadaje siatce kafelka (Tile#_refreshState: alfa obiektu × 0,5 dla ukrytego); cel zanikania. */
const targetAlpha = (o) => (o._aiFadeBase !== undefined ? o._aiFadeBase : (o.alpha ?? 1) * (o.document?.hidden ? 0.5 : 1));

/** Koniec zanikania jednego kafelka: alfa siatki wraca do tej, którą wyliczył Foundry. */
function finish(id) {
  fades.delete(id);
  const o = tileObj(id), m = liveMesh(o);
  if (m && o._aiFadeBase !== undefined) m.alpha = o._aiFadeBase;
  if (o) {
    delete o._aiFadeBase;
    try { o.renderFlags?.set?.({ refreshState: true }); } catch { /* best effort */ }
  }
}

function finishAll() { for (const id of [...fades.keys()]) finish(id); }

function tick() {
  try {
    const t = now();
    for (const [id, f] of fades) {
      const o = tileObj(id), m = liveMesh(o);
      if (!m || !m.texture?.valid) {
        if (t - f.created > READY_TIMEOUT_MS) finish(id);
        else if (m) m.alpha = 0;
        continue;
      }
      if (f.start === null) f.start = t;
      const k = fadeFactor(t - f.start, f.dur);
      if (k >= 1) finish(id);
      else m.alpha = targetAlpha(o) * k;
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | AI Tile fade stopped`, e);
    finishAll();
  }
  if (!fades.size) stopTicker();
}

function startTicker() {
  if (ticking || !canvas?.app?.ticker) return;
  canvas.app.ticker.add(tick);
  ticking = true;
}
function stopTicker() {
  if (!ticking) return;
  try { canvas.app?.ticker?.remove(tick); } catch { /* app gone */ }
  ticking = false;
}

/** Zacznij zanikanie kafelka `id` na tym kliencie (od 0 do alfy, którą wylicza Foundry). */
export function startTileFade(id, ms = durMs()) {
  if (!id || !(ms > 0) || !canvas?.ready) return false;
  const o = tileObj(id);
  if (o) delete o._aiFadeBase;
  fades.set(id, { created: now(), start: null, dur: ms });
  startTicker();
  return true;
}

export const fadeState = () => ({ active: [...fades.keys()], ticking });

/** Hooki (raz, przy init): create/update/refresh/teardown. */
export function installTileFade() {
  if (installed) return;
  installed = true;
  Hooks.on("createTile", (doc, _opts, userId) => {
    if (doc.parent?.id === canvas?.scene?.id && fadeOnCreate(doc, userId, game.user?.id)) startTileFade(doc.id);
  });
  Hooks.on("updateTile", (doc, changes) => {
    if (doc.parent?.id !== canvas?.scene?.id) return;
    if (stopOnUpdate(changes) && fades.has(doc.id)) finish(doc.id);
    else if (fadeOnUpdate(doc, changes)) startTileFade(doc.id);
  });
  Hooks.on("deleteTile", (doc) => { fades.delete(doc.id); });
  // siatka narysowana (z alfą 1 Foundry): zgaś ją od razu, zanim zobaczy ją choć jedna klatka
  Hooks.on("drawTile", (obj) => { const m = liveMesh(obj); if (m && fades.has(obj.document?.id)) m.alpha = 0; });
  // Foundry ustawia alfę siatki w refreshState: zapamiętaj ją jako cel i zastosuj bieżący stopień zanikania.
  Hooks.on("refreshTile", (obj, flags) => {
    const f = fades.get(obj?.document?.id);
    const m = liveMesh(obj);
    if (!f || !m || !flags?.refreshState) return;
    obj._aiFadeBase = m.alpha;
    m.alpha = f.start === null ? 0 : m.alpha * fadeFactor(now() - f.start, f.dur);
  });
  Hooks.on("canvasTearDown", () => { finishAll(); stopTicker(); });
}
