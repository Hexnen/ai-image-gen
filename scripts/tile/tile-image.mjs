// W7-A/W7-B AI Tile: obrazy w przeglądarce (wycinek otoczenia, obrys zaznaczenia, wynik -> plik kafelka).
// Geometria w tile-core.mjs (czysta); tu tylko canvas 2D i PIXI.
import {
  tileRaster, alphaRect, outlineBands, OUTLINE_COLOR, captureInclude, resultCrop, selIn, expandFromDiff, expandTileRect,
  EXPAND_DEFAULTS, EXPAND_ANALYSIS_EDGE
} from "./tile-core.mjs";

export function newCanvas(w, h) {
  return Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
}

export function canvasToBlob(c, type = "image/png", quality) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, quality));
}

/** Ułamek pikseli z alfą > 0 i odchylenie jasności (czy obraz nie jest pusty / jednolity). */
export function imageStats(c) {
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let opaque = 0, sum = 0, sum2 = 0, n = 0;
  const step = Math.max(4, Math.floor(d.length / 4 / 20000) * 4);
  for (let i = 0; i < d.length; i += step) {
    n++;
    if (d[i + 3] > 0) opaque++;
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += l; sum2 += l * l;
  }
  const mean = sum / n;
  return { opaque: opaque / n, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), mean };
}

// ---------- wycinek sceny ----------

/**
 * Render grupy `canvas.primary` do RenderTexture z macierzą region -> [0,w]x[0,h]. W8 (właściciel): WYŁĄCZNIE mapa
 * (tło, warstwy mapy moinen-maps: woda, drogi; BEZ gruzu / zniszczeń 247-249) i kafelki poniżej „overhead”, także ukryte, z alfą dokumentu
 * (`captureInclude` w tile-core). Bez tokenów, pogody, efektów, ognia/dymu, VFX, znaczników stref, pinezek, rysunków,
 * świateł, siatki, ścian i interfejsu (nie są w tej grupie albo są pomijane). Pominięte dzieci po prostu nie są
 * renderowane; jedyna zmiana stanu (alfa / `hidden` siatek kafelków na czas renderu) wraca w `finally`, także po błędzie.
 * @returns {HTMLCanvasElement}
 */
export function renderRegion(region, w, h) {
  const renderer = canvas.app.renderer;
  const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1 });
  const restore = [];
  try {
    const kinds = captureKinds();
    const sx = w / region.width, sy = h / region.height;
    const m = new PIXI.Matrix(sx, 0, 0, sy, -region.x * sx, -region.y * sy);
    // v14: canvas.primary is a cached group that is not displayed itself (the environment group composites its texture),
    // so rendering the group draws nothing: render its children one by one, in its own sorted order (live check, lane 8).
    renderer.renderTexture.bind(rt);
    renderer.renderTexture.clear([0, 0, 0, 0]);
    for (const c of canvas.primary.children) {
      const k = kinds.get(c) ?? { kind: "other" };
      if (!captureInclude({ sortLayer: c.sortLayer, elevation: c.elevation, ...k })) continue;
      if (k.kind === "tile") {
        // a tile as the players see it: mesh alpha 1 (not the GM's half-transparent hidden look, not a fade in progress);
        // the document alpha is applied by the mesh itself (unoccludedAlpha, Tile#_refreshMesh)
        if (!c.texture?.valid || !(k.alpha > 0)) continue;
        restore.push([c, c.alpha, c.hidden, c.visible, c.renderable]);
        c.alpha = 1; c.hidden = false; c.visible = true; c.renderable = true;
      } else if (!c.visible || !c.renderable || c.worldAlpha === 0) continue;
      renderer.render(c, { renderTexture: rt, transform: m, clear: false });
    }
    const out = newCanvas(w, h);
    const src = renderer.extract.canvas(rt);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
  } finally {
    for (const [c, alpha, hidden, visible, renderable] of restore) {
      if (c.destroyed) continue;
      c.alpha = alpha; c.hidden = hidden; c.visible = visible; c.renderable = renderable;
    }
    rt.destroy(true);
    // przywróć zwykły render ekranu (render do RT zmienia stan renderera)
    try { canvas.app.renderer.render(canvas.app.stage); } catch { /* następna klatka i tak narysuje */ }
  }
}

/** Dzieci canvas.primary rozpoznane po obiektach Foundry: tło, pierwszy plan, kafelki, tokeny, pogoda. */
function captureKinds() {
  const P = canvas.primary, map = new Map();
  if (P.background) map.set(P.background, { kind: "background" });
  if (P.foreground) map.set(P.foreground, { kind: "foreground" });
  const fg = canvas.scene?.foregroundElevation ?? Infinity;
  for (const t of canvas.tiles?.placeables ?? []) {
    if (t.mesh) map.set(t.mesh, { kind: "tile", overhead: (t.document.elevation ?? 0) >= fg, alpha: t.document.alpha ?? 1 });
  }
  for (const t of canvas.tokens?.placeables ?? []) if (t.mesh) map.set(t.mesh, { kind: "token" });
  const WE = foundry.canvas?.layers?.WeatherEffects ?? globalThis.WeatherEffects;
  for (const c of P.children) {
    if (map.has(c)) continue;
    if (c === canvas.weather || (WE && c instanceof WE) || c.constructor?.name === "WeatherEffects") map.set(c, { kind: "weather" });
  }
  return map;
}

const loadImg = (src) => new Promise((res, rej) => {
  const i = new Image();
  i.crossOrigin = "anonymous";
  i.onload = () => res(i);
  i.onerror = () => rej(new Error(`Could not load ${src}`));
  i.src = /^(https?:|data:|blob:)/.test(src) ? src : foundry.utils.getRoute(src);
});

/**
 * Plan B: złożenie 2D z plików: kolor tła płótna, obraz tła sceny w sceneRect, kafelki (także ukryte, bez „overhead”)
 * wg elewacji i sort, z rotacją, alfą i odbiciem. Bez tokenów, rysunków i efektów.
 */
export async function composeRegion(region, w, h) {
  const scene = canvas.scene;
  const d = canvas.dimensions;
  const c = newCanvas(w, h);
  const ctx = c.getContext("2d");
  const sx = w / region.width, sy = h / region.height;
  ctx.setTransform(sx, 0, 0, sy, -region.x * sx, -region.y * sy);
  ctx.fillStyle = scene.backgroundColor ?? "#999999";
  ctx.fillRect(region.x, region.y, region.width, region.height);
  const bg = scene.background?.src;
  if (bg) {
    try { const img = await loadImg(bg); ctx.drawImage(img, d.sceneX, d.sceneY, d.sceneWidth, d.sceneHeight); }
    catch (e) { console.warn("moinens-ai-gen | AI Tile: background", e); }
  }
  const fg = scene.foregroundElevation ?? Infinity;
  const tiles = scene.tiles.contents.filter((t) => t.texture?.src && (t.elevation ?? 0) < fg)   // W8: ukryte też (jak w renderRegion)
    .sort((a, b) => (a.elevation - b.elevation) || (a.sort - b.sort));
  for (const t of tiles) {
    try {
      const img = await loadImg(t.texture.src);
      ctx.save();
      ctx.globalAlpha = t.alpha ?? 1;
      // v14: x/y = punkt kotwicy (texture.anchorX/Y), środek = x + (0.5 - kotwica) * rozmiar
      const ax = t.texture.anchorX ?? 0.5, ay = t.texture.anchorY ?? 0.5;
      ctx.translate(t.x + (0.5 - ax) * t.width, t.y + (0.5 - ay) * t.height);
      ctx.rotate(((t.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(Math.sign(t.texture.scaleX ?? 1) || 1, Math.sign(t.texture.scaleY ?? 1) || 1);
      ctx.drawImage(img, -t.width / 2, -t.height / 2, t.width, t.height);
      ctx.restore();
    } catch (e) { console.warn("moinens-ai-gen | AI Tile: tile", t.id, e); }
  }
  return c;
}

/**
 * Wycinek regionu w rozmiarze w×h: render płótna, a gdy wyjdzie pusty / jednolity albo rzuci, złożenie z plików.
 * @returns {Promise<{canvas:HTMLCanvasElement, method:"render"|"compose"}>}
 */
export async function captureRegion(region, w, h, { method = "auto" } = {}) {
  if (method !== "compose") {
    try {
      const c = renderRegion(region, w, h);
      const st = imageStats(c);
      if (method === "render" || (st.opaque > 0.5 && st.std > 1)) return { canvas: c, method: "render", stats: st };
      console.warn("moinens-ai-gen | AI Tile: canvas render looks empty, composing from files", st);
    } catch (e) {
      if (method === "render") throw e;
      console.warn("moinens-ai-gen | AI Tile: canvas render failed, composing from files", e);
    }
  }
  return { canvas: await composeRegion(region, w, h), method: "compose" };
}

// ---------- obrys zaznaczenia ----------

/**
 * Wysyłany obraz: wycinek otoczenia spłaszczony na kolor tła sceny (bez przezroczystości: przezroczyste piksele
 * u OpenAI działałyby jak maska) z czerwonym obrysem tuż POZA zaznaczeniem (`sel` w ułamkach 0..1, pasy z
 * tile-core `outlineBands`: żaden czerwony piksel w zaznaczeniu). Zwraca NOWĄ kanwę.
 */
export function outlinedImage(src, sel, background = "#000000") {
  const w = src.width, h = src.height;
  const c = newCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = OUTLINE_COLOR;
  for (const b of outlineBands(sel, w, h).bands) ctx.fillRect(b.x, b.y, b.width, b.height);
  return c;
}
// ---------- W9: zmiany poza obrysem -> powiększony prostokąt kafelka ----------

/**
 * Porównaj wysłany obraz (`send`, kanwa z obrysem) z wynikiem modelu w tym samym kadrze (wynik przycięty jak w
 * tileRaster: `resultCrop`), oba zmniejszone do EXPAND_ANALYSIS_EDGE (zmniejszenie = dodatkowe rozmycie), i policz
 * prostokąt kafelka (tile-core `expandFromDiff` + `expandTileRect`). Na powiększonych bokach margines = miękka krawędź
 * + jedna komórka analizy (px sceny), żeby wygaszanie leżało na niezmienionej mapie.
 * @param {HTMLCanvasElement} send
 * @param {ImageBitmap|HTMLCanvasElement} result
 * @param {{region, tileRect, ratio, feather}} geom
 * @param {{bounds?:{x,y,width,height}}} [o]
 * @returns {{rect, expanded:boolean, grow, diff}}
 */
export function measureExpansion(send, result, geom, { bounds } = {}) {
  const k = Math.min(1, EXPAND_ANALYSIS_EDGE / Math.max(send.width, send.height));
  const w = Math.max(1, Math.round(send.width * k)), h = Math.max(1, Math.round(send.height * k));
  const read = (draw) => {
    const c = newCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    draw(ctx);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const crop = resultCrop(result.width, result.height, geom.ratio ?? geom.region.width / geom.region.height);
  const a = read((ctx) => ctx.drawImage(send, 0, 0, w, h));
  const b = read((ctx) => ctx.drawImage(result, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h));
  const sel = selIn(geom.tileRect, geom.region);
  const lw = outlineBands(sel, send.width, send.height).lw * k;
  const diff = expandFromDiff({ a, b, w, h, sel, lw });
  const cellScene = (EXPAND_DEFAULTS.cell / w) * geom.region.width;
  const pad = Math.ceil(Math.max(0, Number(geom.feather) || 0) + cellScene);
  // bok rośnie dopiero o co najmniej jedną komórkę analizy (mniej = zaokrąglenie przy zmniejszeniu, nie zmiana)
  const minGrow = Math.max(2, Math.ceil(cellScene));
  return { ...expandTileRect({ bbox: geom.tileRect, region: geom.region, frac: diff.changed ? diff.rect : null, bounds, pad, minGrow }), diff };
}

// ---------- wynik -> plik kafelka ----------

/**
 * Wynik modelu (Blob) -> kanwa kafelka (zaznaczenie × skala) z miękką krawędzią `feather` px sceny do środka.
 * @param {Blob|HTMLCanvasElement|ImageBitmap} result
 * @param {{points, region, tileRect, ratio, feather}} geom
 * @returns {Promise<{canvas:HTMLCanvasElement, scale:number}>}
 */
export async function processResult(result, geom, { maxEdge = 4096 } = {}) {
  const bmp = result instanceof Blob ? await createImageBitmap(result) : result;
  try {
    const r = tileRaster({ bbox: geom.tileRect, region: geom.region, resultW: bmp.width, resultH: bmp.height, ratio: geom.ratio, maxEdge });
    const c = newCanvas(r.out.width, r.out.height);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const dr = r.draw;
    ctx.drawImage(bmp, dr.sx, dr.sy, dr.sw, dr.sh, dr.dx, dr.dy, dr.dw, dr.dh);
    // alfa: prostokąt pliku z miękką krawędzią do środka (tile-core alphaRect)
    const a = alphaRect(r.out, Math.max(0, Number(geom.feather) || 0) * r.scale);
    const m = newCanvas(r.out.width, r.out.height);
    const mc = m.getContext("2d");
    if (a.blur > 0) mc.filter = `blur(${a.blur.toFixed(2)}px)`;
    mc.fillStyle = "#fff";
    mc.fillRect(a.x, a.y, a.width, a.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(m, 0, 0);
    return { canvas: c, scale: r.scale };
  } finally {
    if (result instanceof Blob) bmp.close?.();
  }
}
