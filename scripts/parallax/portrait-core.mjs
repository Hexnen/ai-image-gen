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

/**
 * W6-Q: CSS left / top / width / height (px, in the containing block's own units) that put an absolutely positioned
 * element exactly over the screen rect `visible`, given its containing block (`parent` = the element's offsetParent:
 * `rect` = its getBoundingClientRect, its offset size, border (clientLeft / clientTop) and scroll offsets). Handles a
 * scaled ancestor (rect / offset size). null when the parent is missing or has no size (hidden).
 */
export function cssBoxFor(visible, parent) {
  if (!visible || !parent?.rect) return null;
  const o = parent.rect;
  if (!(parent.offsetWidth > 0 && parent.offsetHeight > 0 && o.width > 0 && o.height > 0)) return null;
  const sx = o.width / parent.offsetWidth, sy = o.height / parent.offsetHeight;
  return {
    left: (visible.x - o.left) / sx - (parent.clientLeft || 0) + (parent.scrollLeft || 0),
    top: (visible.y - o.top) / sy - (parent.clientTop || 0) + (parent.scrollTop || 0),
    width: visible.w / sx, height: visible.h / sy
  };
}

/** W6-Q: does a screen rect `got` sit on `want` (both {x, y, w, h} or DOMRect-like) within `tol` px on every edge? */
export function rectsMatch(got, want, tol = 1) {
  if (!got || !want) return false;
  const g = { x: got.x ?? got.left, y: got.y ?? got.top, w: got.w ?? got.width, h: got.h ?? got.height };
  const w = { x: want.x ?? want.left, y: want.y ?? want.top, w: want.w ?? want.width, h: want.h ?? want.height };
  return Math.abs(g.x - w.x) <= tol && Math.abs(g.y - w.y) <= tol && Math.abs(g.x + g.w - (w.x + w.w)) <= tol && Math.abs(g.y + g.h - (w.y + w.h)) <= tol;
}

/**
 * W6-Q: the overlay canvas' positioning, set INLINE with `important` from JS so the placement never depends on our
 * stylesheet being loaded (a cached / stale CSS on a remote server left the canvas `position: static`, in the flow
 * below the picture) nor on another stylesheet's rules for canvases.
 */
export const OVERLAY_STYLE = Object.freeze({
  position: "absolute", display: "block", margin: "0", padding: "0", border: "0", "box-sizing": "content-box",
  "z-index": "1", "pointer-events": "none", "max-width": "none", "max-height": "none", "min-width": "0", "min-height": "0",
  transform: "none", opacity: "1", filter: "none", "mix-blend-mode": "normal", right: "auto", bottom: "auto", float: "none"
});

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

/**
 * W6-Q: longest side of the portrait texture = the picture's NATURAL size (an <img> / Tokenizer-style canvas samples the
 * full-resolution source; a pre-downscaled texture made the overlay softer than the plain picture), capped only by the
 * GPU's MAX_TEXTURE_SIZE and a memory limit (4096). 0 = no downscale needed (unknown natural size: the loader keeps
 * the source size). The old rule (1.5 × displayed px, 256..1024, 768 when the <img> was hidden) is gone: the size no
 * longer depends on the <img> being visible when the view loads.
 */
export const PORTRAIT_TEXTURE_CAP = 4096;
export function portraitTextureSide(natW, natH, maxTexture = PORTRAIT_TEXTURE_CAP) {
  const cap = Math.min(PORTRAIT_TEXTURE_CAP, maxTexture > 0 ? maxTexture : PORTRAIT_TEXTURE_CAP);
  const n = Math.max(natW || 0, natH || 0);
  if (!(n > 0)) return cap;
  return Math.min(n, cap);
}

/**
 * W6-Q: overscan margin for the current tilt: the full margin (overscanFor) scales with |look| (the shift is linear
 * in the look, so the margin always covers it), so an untilted portrait maps the texture 1:1 onto the picture's box,
 * exactly like the plain <img>.
 */
export function cropForLook(crop, look) {
  const k = clamp(Math.hypot(look?.x || 0, look?.y || 0), 0, 1);
  return { x: (crop?.x || 0) * k, y: (crop?.y || 0) * k };
}

/**
 * W6-Q: opacity of the overlay canvas. At rest (no tilt) the plain <img> shows and the canvas is transparent and not
 * drawn; it fades in over the first `fadeAt` of tilt (a few frames of easing) and out the same way. Breathing / dust
 * (an always-animating extra the viewer chose) keep it fully shown.
 */
export const FADE_AT = 0.06;
export function overlayOpacity(look, animates = false, fadeAt = FADE_AT) {
  if (animates) return 1;
  const m = Math.hypot(look?.x || 0, look?.y || 0);
  return m <= 1e-4 ? 0 : clamp(m / fadeAt, 0, 1);
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
