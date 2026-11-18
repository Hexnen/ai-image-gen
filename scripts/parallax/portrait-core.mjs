// W6-N: pure helpers of the sheet-portrait parallax (parallax/portrait.mjs): where the picture is drawn inside an <img>
// (object-fit / object-position), clipping by scrolling / overflow-hidden ancestors, the look from the pointer, the
// sheet's view settings, texture size and the frame-time guard. No DOM, no Foundry: tested in Node
// (dev/test-portrait-parallax.mjs).
import { clampLook, viewFromTypeParallax } from "./parallax-core.mjs";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** "50% 50%", "left top", "10px 20%", "center" ... -> [{f}|{px}, {f}|{px}] (f = fraction of the free space). */
export function parsePosition(pos) {
  const kw = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const parts = String(pos ?? "").trim().split(/\s+/).filter(Boolean);
  const one = (t) => {
    if (t in kw) return { f: kw[t] };
    const m = /^(-?[\d.]+)(%|px)?$/.exec(t);
    if (!m) return { f: 0.5 };
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return { f: 0.5 };
    return m[2] === "px" ? { px: n } : m[2] === "%" ? { f: n / 100 } : n === 0 ? { f: 0 } : { f: 0.5 };
  };
  if (!parts.length) return [{ f: 0.5 }, { f: 0.5 }];
  if (parts.length === 1) {
    if (parts[0] === "top" || parts[0] === "bottom") return [{ f: 0.5 }, one(parts[0])];
    return [one(parts[0]), { f: 0.5 }];
  }
  let [a, b] = parts;
  if ((a === "top" || a === "bottom") || (b === "left" || b === "right")) [a, b] = [b, a]; // "top left"
  return [one(a), one(b)];
}

/**
 * Where an image of natural size natW × natH is painted inside a content box for CSS `object-fit` / `object-position`.
 * Same units as `box` ({x, y, w, h}). Unknown fit = fill.
 */
export function objectFitRect(box, natW, natH, fit = "fill", position = "50% 50%") {
  if (!(natW > 0 && natH > 0) || !(box.w > 0 && box.h > 0)) return { ...box };
  let w = box.w, h = box.h;
  const sx = box.w / natW, sy = box.h / natH;
  switch (fit) {
    case "contain": { const s = Math.min(sx, sy); w = natW * s; h = natH * s; break; }
    case "cover": { const s = Math.max(sx, sy); w = natW * s; h = natH * s; break; }
    case "none": w = natW; h = natH; break;
    case "scale-down": { const s = Math.min(1, Math.min(sx, sy)); w = natW * s; h = natH * s; break; }
    default: return { ...box };
  }
  const [px, py] = parsePosition(position);
  const x = box.x + ("px" in px ? px.px : (box.w - w) * px.f);
  const y = box.y + ("px" in py ? py.px : (box.h - h) * py.f);
  return { x, y, w, h };
}

/** Intersection of two rects ({x, y, w, h}), or null when empty. */
export function intersectRect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r - x > 0.5 && btm - y > 0.5 ? { x, y, w: r - x, h: btm - y } : null;
}

/**
 * Screen placement of the parallax canvas for one portrait.
 * @param {object} o
 * @param {{x,y,w,h}} o.content   the <img>'s content box on screen (after its own transform)
 * @param {number} o.natW  @param {number} o.natH   natural image size
 * @param {string} [o.fit] @param {string} [o.position]  computed object-fit / object-position
 * @param {Array<{x,y,w,h}>} [o.clips]  padding boxes of ancestors that clip (overflow not visible), and the viewport
 * @returns {{drawn, visible, panel}|null}  drawn = painted picture; visible = the canvas rect (drawn ∩ content ∩ clips);
 *   panel = drawn relative to visible in 0..1 units (the renderer's `rectFor`); null when nothing is visible
 */
export function placementFor({ content, natW, natH, fit = "fill", position = "50% 50%", clips = [] }) {
  if (!content || !(content.w > 1 && content.h > 1)) return null;
  const drawn = objectFitRect(content, natW, natH, fit, position);
  let visible = intersectRect(drawn, content); // replaced content is clipped to the content box
  for (const c of clips) { if (!visible) break; visible = intersectRect(visible, c); }
  if (!visible || visible.w < 2 || visible.h < 2) return null;
  const panel = { x: (drawn.x - visible.x) / visible.w, y: (drawn.y - visible.y) / visible.h, w: drawn.w / visible.w, h: drawn.h / visible.h };
  return { drawn, visible, panel };
}

/** Canvas pixels of the panel rect (clamped to the canvas): the only part copied to the sheet (letterbox stays clear). */
export function panelPixels(panel, w, h) {
  const x0 = clamp(Math.floor(panel.x * w), 0, w), y0 = clamp(Math.floor(panel.y * h), 0, h);
  const x1 = clamp(Math.ceil((panel.x + panel.w) * w), 0, w), y1 = clamp(Math.ceil((panel.y + panel.h) * h), 0, h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Look vector from the pointer: the picture's centre = (0, 0), its edge = 1 (unit disc, y down). Beyond the picture the
 * direction keeps following the pointer at full tilt.
 */
export function lookFromPointer(x, y, rect) {
  if (!rect || !(rect.w > 0 && rect.h > 0)) return { x: 0, y: 0 };
  return clampLook(((x - rect.x) / rect.w - 0.5) * 2, ((y - rect.y) / rect.h - 0.5) * 2);
}

/** True when the look has (practically) reached its target. */
export const settled = (look, target, eps = 0.002) => Math.hypot(look.x - target.x, look.y - target.y) < eps;

/**
 * View settings for a sheet portrait from the type's `cfg.depth.parallax` (same seed as the parallax window), with what
 * a small picture in a sheet must not do: no idle sway, no dust (both need a never-ending frame loop), no vignette (the
 * picture keeps its own edges).
 */
export function portraitView(typeParallax) {
  const v = viewFromTypeParallax(typeParallax);
  v.sway = 0;
  v.on.dust = false;
  v.on.vignette = false;
  v.view = "image";
  return v;
}

/**
 * Light and rim fade in with the look (0 at rest): a portrait at rest looks like the plain picture (only the overscan
 * zoom of a few percent).
 */
export const effectAmount = (base, look) => base * clamp(Math.hypot(look.x, look.y), 0, 1);

/** Longest side of the portrait texture: about 1.5 × its device-pixel size on the sheet, 256..1024. */
export function portraitTextureSide(cssW, cssH, dpr = 1) {
  const px = Math.max(cssW || 0, cssH || 0) * Math.min(Math.max(1, dpr || 1), 2);
  if (!(px > 0)) return 768;
  return clamp(Math.ceil((px * 1.5) / 64) * 64, 256, 1024);
}

/**
 * Frame-time guard. `push(gapMs, drawMs)` for frames drawn back to back; gaps above `ignoreGapMs` (a stall, a tab
 * switch) are skipped. After `warmup` frames, once `window` samples are in: "bad" when the median gap is above
 * `maxGapMs` (sustained low frame rate) or the mean draw time is above `maxDrawMs`; else "ok". "warmup" before that.
 */
export function createFrameGuard({ warmup = 20, window = 90, maxGapMs = 55, maxDrawMs = 8, ignoreGapMs = 250 } = {}) {
  let seen = 0, gaps = [], draws = [], last = "warmup";
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return {
    push(gapMs, drawMs) {
      if (!(gapMs > 0) || gapMs > ignoreGapMs) return last;
      seen++;
      if (seen <= warmup) return (last = "warmup");
      gaps.push(gapMs); draws.push(Math.max(0, drawMs || 0));
      if (gaps.length > window) { gaps.shift(); draws.shift(); }
      if (gaps.length < window) return (last = "warmup");
      const meanDraw = draws.reduce((s, x) => s + x, 0) / draws.length;
      return (last = median(gaps) > maxGapMs || meanDraw > maxDrawMs ? "bad" : "ok");
    },
    reset() { seen = 0; gaps = []; draws = []; last = "warmup"; },
    state() {
      return { last, samples: gaps.length, medianGapMs: gaps.length ? median(gaps) : null, meanDrawMs: draws.length ? draws.reduce((s, x) => s + x, 0) / draws.length : null };
    }
  };
}

/**
 * Does an <img> src show this document image? Compares canonical Data paths (`normalize` = depth-index
 * normalizeImagePath bound to the page origin / route prefix).
 */
export function sameImage(src, docImg, normalize) {
  const a = normalize(src), b = normalize(docImg);
  return !!a && a === b;
}
