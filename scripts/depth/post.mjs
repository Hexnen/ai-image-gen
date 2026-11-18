// W6-I: post-processing of a depth map (research dev/depth-model-research.md §7.2). Pure: typed arrays in, typed
// arrays out, no Foundry, no DOM (the PNG encoder takes an injectable zlib deflate). Tested in Node: dev/test-depth-post.mjs.
import { DATA_ROOT } from "../constants.mjs";

/** Folder for depth files of images we may not write next to (URLs, core/system/module folders). */
export const DEPTH_FALLBACK_DIR = `${DATA_ROOT}/_depth`;
//
// Conventions: D = disparity, Float32Array of w*h, row-major, near = LARGE (after normalisation 0..1, near = 1 = white).
// A = figure mask alpha, Float32Array 0..1 (1 = figure) or null. I = guide luminance 0..1 or null.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear-interpolated percentile (p in 0..100) of the finite values; large inputs are sampled (≤ 1M values). */
export function percentile(values, p, select = null) {
  const n = values.length;
  const stride = Math.max(1, Math.floor(n / 1_000_000));
  const buf = [];
  for (let i = 0; i < n; i += stride) {
    const v = values[i];
    if (Number.isFinite(v) && (!select || select(i))) buf.push(v);
  }
  if (!buf.length) return NaN;
  const a = Float64Array.from(buf).sort();
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (a.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Share of mask pixels in each class (A ≥ 0.5 figure, A < 0.5 background). */
export function maskShare(A) {
  if (!A) return { fg: 0, bg: 0 };
  let fg = 0;
  for (let i = 0; i < A.length; i++) if (A[i] >= 0.5) fg++;
  return { fg: fg / A.length, bg: 1 - fg / A.length };
}

/** A mask is usable when both classes hold at least 0.5% of the pixels (else snapping has nothing to separate). */
export const maskUsable = (A) => { if (!A) return false; const s = maskShare(A); return s.fg >= 0.005 && s.bg >= 0.005; };

/**
 * Step 1, robust normalisation: clip at percentiles and rescale to 0..1. With a usable mask the low bound comes from the
 * background (A < 0.5) and the high bound from the figure (A ≥ 0.5); otherwise from all pixels. `robust: false` = min-max.
 * @returns {{out:Float32Array, lo:number, hi:number, flat:boolean}}
 */
export function normalizeRobust(D, { lowPct = 1, highPct = 99, mask = null, robust = true } = {}) {
  let lo, hi;
  if (!robust) { lo = percentile(D, 0); hi = percentile(D, 100); }
  else if (maskUsable(mask)) {
    lo = percentile(D, lowPct, (i) => mask[i] < 0.5);
    hi = percentile(D, highPct, (i) => mask[i] >= 0.5);
    if (!(hi > lo)) { lo = percentile(D, lowPct); hi = percentile(D, highPct); }
  } else { lo = percentile(D, lowPct); hi = percentile(D, highPct); }
  const out = new Float32Array(D.length);
  const span = hi - lo;
  if (!(span > 1e-12) || !Number.isFinite(span)) return { out, lo, hi, flat: true };
  for (let i = 0; i < D.length; i++) out[i] = Number.isFinite(D[i]) ? clamp01((D[i] - lo) / span) : 0;
  return { out, lo, hi, flat: false };
}

/** Sobel gradient magnitude per pixel (divided by 8, so a unit step between neighbours reads ~0.5). Borders clamp. */
export function sobel(D, w, h) {
  const g = new Float32Array(w * h);
  const at = (x, y) => D[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    g[y * w + x] = Math.hypot(gx, gy) / 8;
  }
  return g;
}

/**
 * Step 2, flying pixels: pixels whose Sobel gradient is above `threshold` (in normalised depth per pixel) take the value
 * of the nearest stable pixel (multi-source BFS, 8-connected). A blurred depth step becomes a sharp one.
 * @returns {{out:Float32Array, count:number}}
 */
export function fillFlyingPixels(D, w, h, { threshold = 0.06 } = {}) {
  const g = sobel(D, w, h);
  const out = Float32Array.from(D);
  const N = w * h;
  const done = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0, tail = 0, count = 0;
  for (let i = 0; i < N; i++) {
    if (g[i] <= threshold) { done[i] = 1; queue[tail++] = i; } else count++;
  }
  if (!count || !tail) return { out, count: tail ? 0 : count };
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
        const j = ny * w + nx;
        if (!done[j]) { done[j] = 1; out[j] = out[i]; queue[tail++] = j; }
      }
    }
  }
  return { out, count };
}

/** Box mean with radius r (window clipped at the borders, divided by the real pixel count). Separable, O(N). */
export function boxMean(src, w, h, r) {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      const a = x - r, b = x + r;
      tmp[row + x] = s / (Math.min(w - 1, b) - Math.max(0, a) + 1);
      if (b + 1 < w) s += src[row + b + 1];
      if (a >= 0) s -= src[row + a];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = y - r, b = y + r;
      out[y * w + x] = s / (Math.min(h - 1, b) - Math.max(0, a) + 1);
      if (b + 1 < h) s += tmp[(b + 1) * w + x];
      if (a >= 0) s -= tmp[a * w + x];
    }
  }
  return out;
}

/**
 * Step 3, guided filter (He et al.): output follows the edges of the guide I. Used as image-guided upsampling of the
 * bilinear model output, and (self-guided) as edge-preserving smoothing.
 */
export function guidedFilter(p, I, w, h, r, eps = 1e-3) {
  if (r <= 0) return Float32Array.from(p);
  const N = w * h;
  const Ip = new Float32Array(N), II = new Float32Array(N);
  for (let i = 0; i < N; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = ma[i] * I[i] + mb[i];
  return out;
}

/** Mean of D over pixels with sel(i), box radius r (normalised convolution); NaN where the window has none. */
export function maskedMean(D, sel, w, h, r) {
  const N = w * h;
  const num = new Float32Array(N), den = new Float32Array(N);
  for (let i = 0; i < N; i++) if (sel(i)) { num[i] = D[i]; den[i] = 1; }
  const mn = boxMean(num, w, h, r), md = boxMean(den, w, h, r);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = md[i] > 1e-6 ? mn[i] / md[i] : NaN;
  return out;
}

/** Max filter of D over pixels with sel(i), square window radius r (separable); -Infinity where none. */
export function maskedMax(D, sel, w, h, r) {
  const N = w * h;
  const src = new Float32Array(N).fill(-Infinity);
  for (let i = 0; i < N; i++) if (sel(i)) src[i] = D[i];
  if (r <= 0) return src;
  const tmp = new Float32Array(N), out = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = src[y * w + k]; if (v > m) m = v; }
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = tmp[k * w + x]; if (v > m) m = v; }
    out[y * w + x] = m;
  }
  return out;
}

/**
 * Step 4, snap to the figure mask: background becomes a heavily smoothed field never in front of the figure
 * (cap = min(p10 background, p5 figure) − margin), the figure's disparity is dilated `dilatePx` outwards so outline pixels
 * move with the figure, and D' = A·fg + (1−A)·bg. `edgeSnap` (0..1) blends D' over the input.
 * @returns {{out:Float32Array, skipped:boolean, cap?:number}}
 */
export function snapToMask(D, A, w, h, { dilatePx = 3, edgeSnap = 1, bgRadius = null, margin = 0.02 } = {}) {
  if (!maskUsable(A) || !(edgeSnap > 0)) return { out: Float32Array.from(D), skipped: true };
  const isFg = (i) => A[i] >= 0.5, isBg = (i) => A[i] < 0.5;
  const cap = Math.min(percentile(D, 10, isBg), percentile(D, 5, isFg)) - margin;
  const r = bgRadius ?? Math.max(8, Math.round(Math.max(w, h) / 32));
  // two box passes ≈ a smooth (tent) blur
  const m1 = maskedMean(D, isBg, w, h, r);
  const filled = new Float32Array(w * h);
  for (let i = 0; i < filled.length; i++) filled[i] = Number.isFinite(m1[i]) ? m1[i] : cap;
  const bgField = boxMean(filled, w, h, r);
  const fgMax = maskedMax(D, isFg, w, h, Math.round(dilatePx));
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const a = clamp01(A[i]);
    const bg = Math.min(bgField[i], cap);
    const fg = isFg(i) ? D[i] : (fgMax[i] > -Infinity ? fgMax[i] : D[i]);
    const snapped = a * fg + (1 - a) * bg;
    out[i] = clamp01(D[i] + edgeSnap * (snapped - D[i]));
  }
  return { out, skipped: false, cap };
}

/**
 * Step 5, smoothing of the inside: with a mask, a class-aware box blur (figure pixels average only figure pixels,
 * background only background, soft-edge pixels 0.02 < A < 0.98 untouched: the silhouette stays sharp); without a mask,
 * a self-guided filter (keeps depth steps larger than ~0.05).
 */
export function smoothInterior(D, A, w, h, r) {
  if (!(r > 0)) return Float32Array.from(D);
  if (!A) return guidedFilter(D, D, w, h, r, 2.5e-3);
  const fg = maskedMean(D, (i) => A[i] >= 0.5, w, h, r);
  const bg = maskedMean(D, (i) => A[i] < 0.5, w, h, r);
  const out = Float32Array.from(D);
  for (let i = 0; i < out.length; i++) {
    if (A[i] >= 0.98) out[i] = Number.isFinite(fg[i]) ? fg[i] : D[i];
    else if (A[i] <= 0.02) out[i] = Number.isFinite(bg[i]) ? bg[i] : D[i];
  }
  return out;
}

/** Step 6, curve: D^gamma (gamma < 1 gives the near range, the face, more of the 0..1 scale). */
export function applyGamma(D, gamma = 1) {
  const out = new Float32Array(D.length);
  for (let i = 0; i < D.length; i++) out[i] = Math.pow(clamp01(D[i]), gamma);
  return out;
}

/** Bilinear resize of a single-channel float map (align-corners false, like the transformers.js pipeline). */
export function resizeBilinear(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** RGBA (or RGB with channels=3) bytes → luminance 0..1 (Rec. 709). */
export function luminance(rgba, w, h, channels = 4) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += channels) out[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  return out;
}

/**
 * A depth image produced by an image model (generative engine): bytes → single channel 0..1 at the source size.
 * Takes the mean of R, G, B (a grey picture with a colour cast still reads right); `invert` for "white = far" output.
 */
export function imageToDepth(rgba, iw, ih, w, h, { channels = 4, invert = false } = {}) {
  const g = new Float32Array(iw * ih);
  for (let i = 0, j = 0; i < g.length; i++, j += channels) {
    const v = (rgba[j] + rgba[j + 1] + rgba[j + 2]) / 765;
    g[i] = invert ? 1 - v : v;
  }
  return resizeBilinear(g, iw, ih, w, h);
}

/** Default post settings (= depthDefaults().post), so the pipeline can run without the settings module. */
export const POST_DEFAULTS = Object.freeze({ normalize: true, lowPct: 1, highPct: 99, flyingPixels: true, guided: true, edgeSnap: 1, dilatePx: 3, smoothPx: 3, gamma: 0.8 });

/**
 * The whole §7.2 recipe in order: normalise → flying pixels → guided upsampling → mask snap → smoothing → gamma.
 * @param {Float32Array} D  disparity at image size
 * @param {{w:number, h:number, mask?:Float32Array|null, guide?:Float32Array|null, post?:object, modelSize?:number, now?:()=>number}} o
 *   `modelSize` = the short side the model worked at (scales the flying-pixel threshold and the guided radius).
 * @returns {{depth:Float32Array, steps:{name:string, ms:number, info?:object}[], flat:boolean}}
 */
export function postProcess(D, { w, h, mask = null, guide = null, post = {}, modelSize = 518, now = () => Date.now() } = {}) {
  if (!(D?.length === w * h)) throw new Error(`Depth size ${D?.length} does not match ${w}×${h}.`);
  const p = { ...POST_DEFAULTS, ...post };
  const steps = [];
  const step = (name, fn) => { const t = now(); const r = fn(); steps.push({ name, ms: now() - t, ...(r.info ? { info: r.info } : {}) }); return r.out; };
  const scale = Math.max(1, Math.min(w, h) / Math.max(1, modelSize));
  const useMask = maskUsable(mask);
  let flat = false;
  let d = step("normalize", () => {
    const r = normalizeRobust(D, { lowPct: p.lowPct, highPct: p.highPct, mask: useMask ? mask : null, robust: !!p.normalize });
    flat = r.flat;
    return { out: r.out, info: { lo: r.lo, hi: r.hi, flat: r.flat } };
  });
  if (flat) return { depth: d, steps, flat };
  if (p.flyingPixels) d = step("flyingPixels", () => { const r = fillFlyingPixels(d, w, h, { threshold: 0.12 / scale }); return { out: r.out, info: { count: r.count } }; });
  if (p.guided && guide) d = step("guided", () => ({ out: guidedFilter(d, guide, w, h, Math.min(8, Math.max(2, Math.round(scale * 2))), 1e-3) }));
  if (useMask && p.edgeSnap > 0) d = step("maskSnap", () => { const r = snapToMask(d, mask, w, h, { dilatePx: p.dilatePx, edgeSnap: p.edgeSnap }); return { out: r.out, info: { cap: r.cap } }; });
  if (p.smoothPx > 0) d = step("smooth", () => ({ out: smoothInterior(d, useMask ? mask : null, w, h, Math.round(p.smoothPx)) }));
  if (p.gamma !== 1) d = step("gamma", () => ({ out: applyGamma(d, p.gamma) }));
  for (let i = 0; i < d.length; i++) d[i] = clamp01(d[i]);
  return { depth: d, steps, flat };
}

// ---------- lossless PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

/** zlib deflate (RFC 1950) through CompressionStream("deflate"); works in browsers and Node ≥ 18. */
export async function deflateZlib(bytes) {
  const cs = new CompressionStream("deflate");
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/**
 * Minimal PNG writer. `raw` = unfiltered pixel bytes (big-endian for 16 bit), rows top to bottom. Every row uses the Paeth
 * filter. colorType 0 = grey, 2 = RGB. @returns {Promise<Uint8Array>}
 */
export async function encodePng({ width, height, colorType, bitDepth, raw }, deflate = deflateZlib) {
  const ch = colorType === 2 ? 3 : 1;
  const bpp = ch * (bitDepth / 8);
  const stride = width * bpp;
  if (raw.length !== stride * height) throw new Error(`PNG: ${raw.length} bytes for ${width}×${height}×${bpp}`);
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1), r = y * stride;
    filtered[o] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? raw[r + x - bpp] : 0, b = y ? raw[r - stride + x] : 0, c = x >= bpp && y ? raw[r - stride + x - bpp] : 0;
      filtered[o + 1 + x] = (raw[r + x] - paeth(a, b, c)) & 0xff;
    }
  }
  const idat = await deflate(filtered);
  const chunks = [];
  const chunk = (type, data) => {
    const b = new Uint8Array(12 + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(data, 8);
    dv.setUint32(8 + data.length, (crc32(b.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
    chunks.push(b);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr.set([bitDepth, colorType, 0, 0, 0], 8);
  chunk("IHDR", ihdr);
  chunk("IDAT", idat);
  chunk("IEND", new Uint8Array(0));
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = new Uint8Array(sig.length + chunks.reduce((s, c) => s + c.length, 0));
  out.set(sig, 0);
  let o = sig.length;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** 0..1 → 0..65535 integers. */
export function toUint16(D) {
  const out = new Uint16Array(D.length);
  for (let i = 0; i < D.length; i++) out[i] = Math.round(clamp01(D[i]) * 65535);
  return out;
}

/** 16-bit grayscale PNG (near = white). */
export function encodeDepthPng16(D, w, h, deflate) {
  const q = toUint16(D);
  const raw = new Uint8Array(w * h * 2);
  for (let i = 0; i < q.length; i++) { raw[2 * i] = q[i] >> 8; raw[2 * i + 1] = q[i] & 0xff; }
  return encodePng({ width: w, height: h, colorType: 0, bitDepth: 16, raw }, deflate);
}

/** 8-bit RGB PNG with 16-bit depth packed in R (high byte) + G (low byte) and the mask in B (0 without a mask).
 *  Shader decode: d = (r * 255.0 * 256.0 + g * 255.0) / 65535.0. */
export function encodeDepthRG16(D, A, w, h, deflate) {
  const q = toUint16(D);
  const raw = new Uint8Array(w * h * 3);
  for (let i = 0; i < q.length; i++) {
    raw[3 * i] = q[i] >> 8; raw[3 * i + 1] = q[i] & 0xff; raw[3 * i + 2] = A ? Math.round(clamp01(A[i]) * 255) : 0;
  }
  return encodePng({ width: w, height: h, colorType: 2, bitDepth: 8, raw }, deflate);
}

/** 8-bit grayscale PNG of a 0..1 map (mask file, preview). */
export function encodeGray8(M, w, h, deflate) {
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.round(clamp01(M[i]) * 255);
  return encodePng({ width: w, height: h, colorType: 0, bitDepth: 8, raw }, deflate);
}

// ---------- file names ----------

/**
 * Where the depth files of an image go: next to it, `<name>_depth.png` (+ `_mask.png`, `_depth.json`).
 * `writable` = the path is a plain relative Data path we may upload into (no URL, no `..`, not core folders).
 */
export function depthPathsFor(src, { fallbackDir = DEPTH_FALLBACK_DIR } = {}) {
  const clean = decodeURIComponent(String(src ?? "").split(/[?#]/)[0]).replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  const dir = slash >= 0 ? clean.slice(0, slash) : "";
  const file = clean.slice(slash + 1);
  const base = (file.replace(/\.[^.]+$/, "") || "image").replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const external = /^[a-z][a-z0-9+.-]*:/i.test(String(src ?? "")) || /^(blob|data):/i.test(clean);
  const writable = !external && !!dir && !dir.split("/").includes("..") && !/^(icons|systems|modules|ui|cards|sounds|fonts|scripts|css|lang|common|dist)(\/|$)/.test(dir);
  const d = writable ? dir : fallbackDir;
  return { dir: d, base, writable, depth: `${d}/${base}_depth.png`, mask: `${d}/${base}_mask.png`, meta: `${d}/${base}_depth.json` };
}
