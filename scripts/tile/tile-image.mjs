// W7-A AI Tile: obrazy w przeglądarce (wycinek sceny, maska OpenAI, przewodnik, przetworzenie wyniku do pliku kafelka).
// Geometria w tile-core.mjs (czysta); tu tylko canvas 2D i PIXI.
import { pointsIn, tileRaster, alphaRect } from "./tile-core.mjs";

export function newCanvas(w, h) {
  return Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
}

export function canvasToBlob(c, type = "image/png", quality) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, quality));
}

function pathOf(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
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
 * Render grupy `canvas.primary` (tło, kafelki, tokeny; bez oświetlenia, mgły i interfejsu) do RenderTexture z macierzą
 * region -> [0,w]x[0,h]. Tokeny (opcjonalnie) i kafelki „overhead” są ukryte na czas renderu.
 * @returns {HTMLCanvasElement}
 */
export function renderRegion(region, w, h, { tokens = false } = {}) {
  const renderer = canvas.app.renderer;
  const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1 });
  const hidden = [];
  const hide = (o) => { if (o && o.visible) { o.visible = false; hidden.push(o); } };
  try {
    if (!tokens) for (const t of canvas.tokens?.placeables ?? []) hide(t.mesh);
    const fg = canvas.scene?.foregroundElevation ?? Infinity;
    for (const t of canvas.tiles?.placeables ?? []) if ((t.document.elevation ?? 0) >= fg) hide(t.mesh);
    const sx = w / region.width, sy = h / region.height;
    const m = new PIXI.Matrix(sx, 0, 0, sy, -region.x * sx, -region.y * sy);
    renderer.render(canvas.primary, { renderTexture: rt, transform: m, clear: true });
    const out = newCanvas(w, h);
    const src = renderer.extract.canvas(rt);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
  } finally {
    for (const o of hidden) o.visible = true;
    rt.destroy(true);
    // przywróć zwykły render ekranu (render do RT zmienia stan renderera)
    try { canvas.app.renderer.render(canvas.app.stage); } catch { /* następna klatka i tak narysuje */ }
  }
}

const loadImg = (src) => new Promise((res, rej) => {
  const i = new Image();
  i.crossOrigin = "anonymous";
  i.onload = () => res(i);
  i.onerror = () => rej(new Error(`Could not load ${src}`));
  i.src = /^(https?:|data:|blob:)/.test(src) ? src : foundry.utils.getRoute(src);
});

/**
 * Plan B: złożenie 2D z plików: kolor tła płótna, obraz tła sceny w sceneRect, kafelki (bez ukrytych i „overhead”)
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
  const tiles = scene.tiles.contents.filter((t) => !t.hidden && t.texture?.src && (t.elevation ?? 0) < fg)
    .sort((a, b) => (a.elevation - b.elevation) || (a.sort - b.sort));
  for (const t of tiles) {
    try {
      const img = await loadImg(t.texture.src);
      ctx.save();
      ctx.globalAlpha = t.alpha ?? 1;
      ctx.translate(t.x + t.width / 2, t.y + t.height / 2);
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
export async function captureRegion(region, w, h, { tokens = false, method = "auto" } = {}) {
  if (method !== "compose") {
    try {
      const c = renderRegion(region, w, h, { tokens });
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

// ---------- maska i przewodnik ----------

/**
 * Maska OpenAI (PNG w×h): nieprzezroczysta wszędzie, PRZEZROCZYSTA w kształcie poszerzonym o `grow` px obrazu
 * (tam model może zmieniać).
 */
export function openaiMask(points, region, w, h, grow = 0) {
  const c = newCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "destination-out";
  pathOf(ctx, pointsIn(points, region, w / region.width, h / region.height));
  ctx.fill();
  if (grow > 0) { ctx.lineJoin = "round"; ctx.lineWidth = grow * 2; ctx.stroke(); }
  return c;
}

/**
 * Obraz 2 (kontekst): wycinek większego obszaru z czerwonym obrysem zaznaczenia (`sel` w ułamkach 0..1).
 * Obrys rysowany na zewnątrz zaznaczenia, żeby nie zasłaniał jego brzegów.
 */
export function contextImage(c, sel) {
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d");
  const lw = Math.max(2, Math.round(Math.max(w, h) / 300));
  ctx.strokeStyle = "#ff2020";
  ctx.lineWidth = lw;
  ctx.strokeRect(sel.x0 * w - lw / 2, sel.y0 * h - lw / 2, (sel.x1 - sel.x0) * w + lw, (sel.y1 - sel.y0) * h + lw);
  return c;
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
