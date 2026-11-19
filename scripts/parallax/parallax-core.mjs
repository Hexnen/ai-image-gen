// W6-L: pure helpers of the parallax portrait window ("okno portretu"): PNG decoding (8/16 bit, our png16 and png-rg16
// depth formats), depth detection and conditioning, and the maths the shader uses (offset limits, overscan, step count,
// normals, stretch factor, easing, idle sway). No Foundry, no DOM: tested in Node by dev/test-parallax-core.mjs.
// The shader in parallax-gl.mjs mirrors `condition`, `stretchFactor`, `normalFromGradient` and `marchRay` exactly.
import { normalizeRobust, boxMean, guidedFilter } from "../depth/post.mjs";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------------------------------------------------------
// PNG decoding (all colour types, bit depths 1..16, filters 0..4, Adam7 interlace). Inflate is injectable: the browser
// uses DecompressionStream("deflate"), the Node tests zlib.inflateSync.
// ---------------------------------------------------------------------------------------------------------------

export const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
export const isPng = (bytes) => bytes?.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

/**
 * zlib inflate (RFC 1950) through DecompressionStream; browsers, workers and Node ≥ 18. `bytes` = one Uint8Array or a
 * list of them (the IDAT chunks, fed in order without concatenating). W6-T: STREAMED with a hard output cap: reading
 * stops as soon as `maxBytes` bytes are out (the rest of the stream is cancelled, never inflated), so a deflate bomb
 * (1 MB -> 1 GB) costs at most `maxBytes`. `maxBytes` = Infinity keeps the old unbounded behaviour.
 */
export async function inflateZlib(bytes, { maxBytes = Infinity } = {}) {
  const parts = Array.isArray(bytes) ? bytes : [bytes];
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  // written concurrently with the reads below (backpressure); a cancelled read makes these writes reject: ignored
  const writing = (async () => { for (const p of parts) await writer.write(p); await writer.close(); })();
  writing.catch(() => {});
  const reader = ds.readable.getReader();
  const cap = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : Infinity;
  const fixed = cap !== Infinity ? new Uint8Array(cap) : null;
  const list = [];
  let n = 0;
  try {
    for (;;) {
      if (fixed && n >= cap) { await reader.cancel().catch(() => {}); break; }
      const { value, done } = await reader.read();
      if (done) break;
      if (fixed) {
        const take = Math.min(value.length, cap - n);
        fixed.set(take === value.length ? value : value.subarray(0, take), n);
        n += take;
      } else { list.push(value); n += value.length; }
    }
  } finally { try { reader.releaseLock(); } catch { /* cancelled */ } }
  if (fixed) return n === cap ? fixed : fixed.subarray(0, n);
  const out = new Uint8Array(n);
  let p = 0;
  for (const c of list) { out.set(c, p); p += c.length; }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** An error that says the file is over a size limit (`code: "too-large"`), so callers can tell it from a broken file. */
export function tooLarge(msg) { return Object.assign(new Error(msg), { code: "too-large" }); }

/**
 * W6-T: decode limits. `map` = sheet portraits / tokens / api.depthMaps.load (they need ≤ 1024-2048 px: anything up to
 * 4096² is decoded and box-downscaled at once, larger is refused); `window` = the W6-L comparison window (bigger
 * reference maps), still far below the old 64 MP x 16-bit RGBA (≈ 512 MB per buffer).
 * maxFileBytes = download size, maxPixels = declared width × height, maxRawBytes = inflated PNG scanlines.
 */
const MiB = 1024 * 1024;
export const DEPTH_LIMITS = Object.freeze({
  map: Object.freeze({ maxFileBytes: 64 * MiB, maxPixels: 4096 * 4096, maxRawBytes: 64 * MiB }),
  window: Object.freeze({ maxFileBytes: 160 * MiB, maxPixels: 40e6, maxRawBytes: 160 * MiB })
});

/** IHDR of a PNG (the first chunk by the spec) without touching the image data, or null. */
export function pngInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (!isPng(b) || b.length < 33) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20), bitDepth: b[24], colorType: b[25], interlace: b[28] };
}

/** Adam7 / plain passes: [x0, y0, dx, dy]. */
const passesOf = (interlace) => (interlace === 1
  ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
  : [[0, 0, 1, 1]]);

/** Exact size of the inflated scanlines (filter byte + stride per row, every pass) of a PNG header. */
export function pngRawSize({ w, h, bitDepth, colorType, interlace }) {
  const bitsPP = (CHANNELS[colorType] ?? 4) * bitDepth;
  let total = 0;
  for (const [x0, y0, dx, dy] of passesOf(interlace)) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    total += ph * (1 + Math.ceil((pw * bitsPP) / 8));
  }
  return total;
}

/**
 * W6-T: width / height from the header of a PNG, JPEG, WebP (VP8 / VP8L / VP8X) or GIF without decoding, or null.
 * Lets a loader refuse a huge non-PNG map BEFORE the browser decodes it.
 */
export function imageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const p = pngInfo(b);
  if (p) return { w: p.w, h: p.h, type: "png" };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8), type: "gif" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = (b[o + 2] << 8) | b[o + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[o + 5] << 8) | b[o + 6], w: (b[o + 7] << 8) | b[o + 8], type: "jpeg" };
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const kind = tag(12);
    if (kind === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), type: "webp" };
    if (kind === "VP8 ") return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff, type: "webp" };
    if (kind === "VP8L") {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1, type: "webp" };
    }
  }
  return null;
}

/**
 * Decode a PNG. @returns {Promise<{w:number, h:number, bitDepth:number, colorType:number, channels:number,
 *   data:Uint8Array|Uint16Array, palette?:Uint8Array, trns?:Uint8Array}>}  `data` = samples row-major, `channels` per
 *   pixel (palette images: 1 index channel, expanded by `pngToRGBA`). 16-bit samples are 0..65535, others 0..2^bd-1.
 */
export async function decodePng(bytes, inflate = inflateZlib, { maxPixels = DEPTH_LIMITS.window.maxPixels, maxRawBytes = DEPTH_LIMITS.window.maxRawBytes } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isPng(b)) throw new Error("Not a PNG file.");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (o + 8 <= b.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const data = b.subarray(o + 8, o + 8 + len);
    if (o + 12 + len > b.length) throw new Error("PNG: truncated chunk " + type);
    if (type === "IHDR") {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      ihdr = { w: d.getUint32(0), h: d.getUint32(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
      // W6-T: the size is checked from the header BEFORE any image data is touched
      checkPngHeader(ihdr, maxPixels, maxRawBytes);
    } else if (type === "PLTE") palette = data.slice();
    else if (type === "tRNS") trns = data.slice();
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (!ihdr) throw new Error("PNG: no IHDR.");
  const { w, h, bitDepth, colorType, interlace } = ihdr;
  const channels = CHANNELS[colorType];
  // W6-T: inflate only as many bytes as the scanlines can hold (filter byte + stride per row); a bomb stops there
  const expected = pngRawSize(ihdr);
  let raw = inflate === inflateZlib ? await inflateZlib(idat, { maxBytes: expected }) : await inflate(concatBytes(idat), { maxBytes: expected });
  if (raw.length > expected) raw = raw.subarray(0, expected);
  const out = bitDepth === 16 ? new Uint16Array(w * h * channels) : new Uint8Array(w * h * channels);
  const bitsPP = channels * bitDepth;
  const bpp = Math.max(1, bitsPP >> 3);
  let pos = 0;
  const passes = passesOf(interlace);
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      if (pos + 1 + stride > raw.length) throw new Error("PNG: image data too short.");
      const f = raw[pos++];
      for (let i = 0; i < stride; i++) {
        const x = raw[pos + i], a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        switch (f) {
          case 0: v = x; break;
          case 1: v = x + a; break;
          case 2: v = x + up; break;
          case 3: v = x + ((a + up) >> 1); break;
          case 4: { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); break; }
          default: throw new Error(`PNG: bad filter ${f}.`);
        }
        cur[i] = v & 0xff;
      }
      pos += stride;
      const oy = y0 + y * dy;
      for (let xi = 0; xi < pw; xi++) {
        const ox = x0 + xi * dx;
        const dst = (oy * w + ox) * channels;
        for (let ch = 0; ch < channels; ch++) {
          const s = xi * channels + ch;
          if (bitDepth === 16) out[dst + ch] = (cur[2 * s] << 8) | cur[2 * s + 1];
          else if (bitDepth === 8) out[dst + ch] = cur[s];
          else {
            const bit = s * bitDepth, byte = cur[bit >> 3], shift = 8 - bitDepth - (bit & 7);
            out[dst + ch] = (byte >> shift) & ((1 << bitDepth) - 1);
          }
        }
      }
      [prev, cur] = [cur, prev];
    }
  }
  return { w, h, bitDepth, colorType, channels, data: out, ...(palette ? { palette } : {}), ...(trns ? { trns } : {}) };
}

function concatBytes(list) {
  const out = new Uint8Array(list.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of list) { out.set(c, p); p += c.length; }
  return out;
}

/** W6-T: refuse a PNG header that is unsupported or over the limits (declared pixels, inflated bytes). */
function checkPngHeader(ihdr, maxPixels, maxRawBytes) {
  const { w, h, bitDepth, colorType } = ihdr;
  const channels = CHANNELS[colorType];
  if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG: unsupported colour type ${colorType} / ${bitDepth} bit.`);
  if (!(w > 0 && h > 0)) throw new Error(`PNG: bad size ${w}×${h}.`);
  if (w * h > maxPixels) throw tooLarge(`PNG: ${w}×${h} is over the limit of ${Math.round(maxPixels / 1e6 * 10) / 10} MP.`);
  const raw = pngRawSize(ihdr);
  if (raw > maxRawBytes) throw tooLarge(`PNG: ${w}×${h} × ${channels * bitDepth} bit needs ${Math.round(raw / MiB)} MB, over the limit of ${Math.round(maxRawBytes / MiB)} MB.`);
}

/** Max sample value of a decoded PNG. */
export const sampleMax = (png) => (1 << png.bitDepth) - 1;

// ---------------------------------------------------------------------------------------------------------------
// Depth from images
// ---------------------------------------------------------------------------------------------------------------

/**
 * Which encoding a decoded PNG of a depth map uses.
 * - `png16`: grey (or grey+alpha) 16 bit → d = grey / 65535.
 * - `rg16`: 8-bit RGB(A) with 16 bit packed in R (high) and G (low), mask in B (our png-rg16).
 * - `gray8`: anything else (8-bit grey, or 8-bit RGB whose channels are (almost) equal: a plain greyscale map).
 * `hint` (from the `_depth.json` sidecar: "png16" | "png-rg16") wins when it fits the file.
 * Heuristic for RGB without a hint: a plain grey map has R == G == B on (nearly) every pixel; a packed map has G (low
 * byte) unrelated to R, so fewer than half of the pixels have R == G.
 */
export function detectDepthFormat(png, hint = null) {
  const grey = png.colorType === 0 || png.colorType === 4;
  if (grey) return png.bitDepth === 16 ? "png16" : "gray8";
  if (png.colorType === 3) return "gray8";
  if (png.bitDepth === 16) return "gray8"; // 16-bit RGB: read as luminance at full precision (see depthFromPng)
  if (hint === "png-rg16" || hint === "rg16") return "rg16";
  if (hint === "png16" || hint === "gray8") return "gray8";
  const { data, channels } = png;
  const n = png.w * png.h;
  const stride = Math.max(1, Math.floor(n / 50000));
  let eq = 0, cnt = 0;
  for (let i = 0; i < n; i += stride, cnt++) {
    const j = i * channels;
    if (Math.abs(data[j] - data[j + 1]) <= 2 && Math.abs(data[j + 1] - data[j + 2]) <= 2) eq++;
  }
  return eq / Math.max(1, cnt) >= 0.5 ? "gray8" : "rg16";
}

/**
 * Decoded PNG → depth 0..1 (near = 1) and optional mask. @returns {{D:Float32Array, mask:Float32Array|null, w, h,
 * bits:number, format:string}}  `bits` = effective precision (16 for png16 / rg16 / 16-bit images, else 8).
 */
export function depthFromPng(png, { hint = null, invert = false, factor = 1 } = {}) {
  const { w, h, data, channels, bitDepth } = png;
  const n = w * h;
  const format = detectDepthFormat(png, hint);
  // W6-T: `factor` > 1 = box-downscale while converting (no full-size Float32 copy of a big map)
  const f = Math.max(1, Math.min(Math.floor(Number(factor) || 1), w, h));
  const dw = Math.max(1, Math.floor(w / f)), dh = Math.max(1, Math.floor(h / f));
  const D = new Float32Array(dw * dh);
  const M = format === "rg16" ? new Float32Array(dw * dh) : null;
  let any = false;
  const pal = png.colorType === 3 ? (png.palette ?? new Uint8Array(768)) : null;
  const max = sampleMax(png);
  const greyCh = channels <= 2 ? 1 : 3;
  const value = (i) => {
    const j = i * channels;
    if (format === "rg16") return (data[j] * 256 + data[j + 1]) / 65535;
    if (pal) { const k = data[i] * 3; return (pal[k] + pal[k + 1] + pal[k + 2]) / 765; }
    let s = 0;
    for (let c = 0; c < greyCh; c++) s += data[j + c];
    return s / (greyCh * max);
  };
  if (f === 1) {
    for (let i = 0; i < n; i++) {
      D[i] = value(i);
      if (M) { const b = data[i * channels + 2]; M[i] = b / 255; if (b) any = true; }
    }
  } else {
    const k = 1 / (f * f);
    for (let y = 0; y < dh * f; y++) {
      const row = ((y / f) | 0) * dw;
      for (let x = 0; x < dw * f; x++) {
        const i = y * w + x, o = row + ((x / f) | 0);
        D[o] += value(i) * k;
        if (M) { const b = data[i * channels + 2]; M[o] += (b / 255) * k; if (b) any = true; }
      }
    }
  }
  if (invert) for (let i = 0; i < D.length; i++) D[i] = 1 - D[i];
  const bits = format === "rg16" || bitDepth === 16 ? 16 : 8;
  return { D, mask: any ? M : null, w: dw, h: dh, bits, format };
}

/** RGBA bytes of a browser-decoded image (WebP, JPEG, 8-bit PNG) → depth 0..1 = mean of R, G, B (a tinted grey map still reads right). */
export function depthFromRGBA(rgba, w, h, { invert = false } = {}) {
  const D = new Float32Array(w * h);
  for (let i = 0, j = 0; i < D.length; i++, j += 4) {
    const v = (rgba[j] + rgba[j + 1] + rgba[j + 2]) / 765;
    D[i] = invert ? 1 - v : v;
  }
  return { D, mask: null, w, h, bits: 8, format: "gray8" };
}

/**
 * Crop rectangle in source pixels from a spec: `[x, y, w, h]` in pixels, `{x, y, w, h}` (values ≤ 1 = fractions of the
 * size), or "top-square" / "center-square" (the largest square at the top / in the middle). Clamped to the image.
 */
export function resolveCrop(crop, w, h) {
  if (!crop) return null;
  let r;
  if (crop === "top-square") { const s = Math.min(w, h); r = [Math.floor((w - s) / 2), 0, s, s]; }
  else if (crop === "center-square") { const s = Math.min(w, h); r = [Math.floor((w - s) / 2), Math.floor((h - s) / 2), s, s]; }
  else if (Array.isArray(crop)) r = crop.map(Number);
  else if (typeof crop === "object") {
    const f = (v, size) => (Number(v) <= 1 && Number(v) >= 0 && !Number.isInteger(Number(v)) ? Number(v) * size : Number(v));
    r = [f(crop.x ?? 0, w), f(crop.y ?? 0, h), f(crop.w ?? 1, w), f(crop.h ?? 1, h)];
    if (crop.w === 1) r[2] = w;
    if (crop.h === 1) r[3] = h;
  } else return null;
  if (!r.every(Number.isFinite)) return null;
  let [x, y, cw, ch] = r.map((v) => Math.round(v));
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
  cw = clamp(cw, 1, w - x); ch = clamp(ch, 1, h - y);
  return [x, y, cw, ch];
}

/** Cut a rectangle out of a single-channel map. */
export function cropMap(M, w, h, rect) {
  if (!M || !rect) return M;
  const [x, y, cw, ch] = rect;
  const out = new Float32Array(cw * ch);
  for (let r = 0; r < ch; r++) out.set(M.subarray((y + r) * w + x, (y + r) * w + x + cw), r * cw);
  return out;
}

/** Downscale a single-channel map by an integer box factor (keeps big maps cheap to condition). */
export function downscaleMap(M, w, h, f) {
  if (!(f > 1)) return { M, w, h };
  const dw = Math.max(1, Math.floor(w / f)), dh = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += M[(y * f + j) * w + x * f + i];
    out[y * dw + x] = s / (f * f);
  }
  return { M: out, w: dw, h: dh };
}

// ---------------------------------------------------------------------------------------------------------------
// Conditioning (once per map and per dilate / blur change; gamma, contrast and focus are uniforms)
// ---------------------------------------------------------------------------------------------------------------

/** Separable square min or max filter, radius r. */
export function rankFilter(D, w, h, r, mode = "max") {
  if (!(r > 0)) return Float32Array.from(D);
  const pick = mode === "min" ? Math.min : Math.max;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = D[row + x];
      for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) m = pick(m, D[row + k]);
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = tmp[y * w + x];
    for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) m = pick(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

/**
 * Dilate the foreground over its silhouette: a pixel whose neighbourhood (radius r) holds something nearer by more than
 * `threshold` takes that nearer value. The outline / antialiased edge pixels then move with the figure instead of being
 * stretched with the background (halo). Smooth interior relief (steps < threshold within r) is untouched.
 */
export function dilateForeground(D, w, h, r, threshold = 0.06) {
  if (!(r > 0)) return Float32Array.from(D);
  const m = rankFilter(D, w, h, Math.round(r), "max");
  const out = new Float32Array(D.length);
  for (let i = 0; i < D.length; i++) out[i] = m[i] - D[i] > threshold ? m[i] : D[i];
  return out;
}

/**
 * Prepare a raw depth map for the shader. @returns {{rgba:Float32Array, w, h, info:object}}  4 floats per pixel:
 *   R = depth (normalised, de-quantised, dilated), G = blurred depth for normals, B = figure mask (1 without a mask),
 *   A = background depth (local minimum, radius `bgRadius`): where the hole fill looks for the far surface.
 * Options: normalize (robust percentiles, default on), lowPct/highPct, dequantize ("auto" = only 8-bit maps: a light
 * edge-preserving filter that removes the 1/255 terraces), dilatePx, normalBlurPx, bgRadius.
 */
export function conditionDepth(src, o = {}) {
  const { w, h } = src;
  const opt = { normalize: true, lowPct: 1, highPct: 99.5, dequantize: "auto", dilatePx: 2, dilateThreshold: 0.06, normalBlurPx: 3, bgRadius: null, ...o };
  const info = { bits: src.bits, format: src.format };
  let d = src.D;
  if (opt.normalize) {
    const r = normalizeRobust(d, { lowPct: opt.lowPct, highPct: opt.highPct, mask: src.mask, robust: true });
    info.lo = r.lo; info.hi = r.hi; info.flat = r.flat;
    if (!r.flat) d = r.out;
  } else d = Float32Array.from(d, clamp01);
  const deq = opt.dequantize === "auto" ? src.bits <= 8 : !!opt.dequantize;
  if (deq) { d = guidedFilter(d, d, w, h, 2, 4e-4); info.dequantized = true; }
  if (opt.dilatePx > 0) d = dilateForeground(d, w, h, opt.dilatePx, opt.dilateThreshold);
  for (let i = 0; i < d.length; i++) d[i] = clamp01(d[i]);
  const nb = Math.max(0, Math.round(opt.normalBlurPx));
  const g = nb > 0 ? boxMean(boxMean(d, w, h, nb), w, h, nb) : d;
  const bgR = opt.bgRadius ?? Math.max(4, Math.round(Math.max(w, h) / 40));
  // min filter on a 1/4 grid is enough (the hole fill only needs the level of the far surface), then bilinear back up
  const f = Math.max(1, Math.min(4, Math.floor(Math.min(w, h) / 64)));
  const small = downscaleMap(d, w, h, f);
  const bgSmall = rankFilter(small.M, small.w, small.h, Math.max(1, Math.round(bgR / f)), "min");
  const bg = upsampleNearestBilinear(bgSmall, small.w, small.h, w, h);
  const rgba = new Float32Array(w * h * 4);
  const mask = src.mask;
  for (let i = 0, j = 0; i < d.length; i++, j += 4) {
    rgba[j] = d[i]; rgba[j + 1] = clamp01(g[i]); rgba[j + 2] = mask ? clamp01(mask[i]) : 1; rgba[j + 3] = Math.min(d[i], clamp01(bg[i]));
  }
  info.bgRadius = bgR;
  info.hasMask = !!mask;
  return { rgba, w, h, info };
}

/** Bilinear upsample (align-corners false). */
function upsampleNearestBilinear(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, sh - 1), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, sw - 1), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// W6-T: one load pipeline (bytes -> depth -> conditioned map) for the main thread and the depth worker
// ---------------------------------------------------------------------------------------------------------------

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/** Float32 -> IEEE half floats (Uint16, round to nearest), for RGBA16F uploads at half the memory / transfer size. */
export function toHalf(src) {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 112;
    const m = x & 0x7fffff;
    if (e >= 31) { out[i] = sign | ((x & 0x7fffffff) > 0x7f800000 ? 0x7e00 : 0x7c00); continue; }
    if (e <= 0) {
      if (e < -10) { out[i] = sign; continue; }
      const mm = m | 0x800000, shift = 14 - e;
      let hm = mm >>> shift;
      if ((mm >>> (shift - 1)) & 1) hm++;
      out[i] = sign | hm;
      continue;
    }
    let v = sign | (e << 10) | (m >>> 13);
    if (m & 0x1000) v++;            // round half up (carries into the exponent correctly)
    out[i] = v;
  }
  return out;
}

/** Half (Uint16) -> number. Tests / checks only. */
export function halfToFloat(hv) {
  const s = hv & 0x8000 ? -1 : 1, e = (hv >> 10) & 0x1f, m = hv & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * W6-T: cache-busting revision on a fetch URL (`?v=<rev>`, or `&v=` when the URL has a query). Empty / null rev = the
 * URL unchanged; data: / blob: URLs are never touched.
 */
export function withRev(url, rev) {
  const u = String(url ?? "");
  if (rev === null || rev === undefined || rev === "" || /^(data:|blob:)/i.test(u)) return u;
  const hash = u.indexOf("#");
  const base = hash >= 0 ? u.slice(0, hash) : u, tail = hash >= 0 ? u.slice(hash) : "";
  return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(rev))}${tail}`;
}

/** Integer box factor that brings the longer side to ≤ `maxSide` (1 = none). */
export const boxFactorFor = (w, h, maxSide) => (maxSide > 0 && Math.max(w, h) > maxSide ? Math.ceil(Math.max(w, h) / maxSide) : 1);

/**
 * Browser decode of a non-PNG map (WebP / JPEG / GIF / ...) to RGBA bytes, optionally straight to a smaller size
 * (`maxSide`). Works on the main thread and in a worker (createImageBitmap + OffscreenCanvas). Not used in Node.
 */
export async function rasterizeBytes(bytes, type, { w = 0, h = 0, maxSide = 0, maxPixels = DEPTH_LIMITS.map.maxPixels } = {}) {
  const blob = new Blob([bytes], { type: type || "image/webp" });
  const opts = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
  if (w > 0 && h > 0 && maxSide > 0 && Math.max(w, h) > maxSide) {
    const k = maxSide / Math.max(w, h);
    Object.assign(opts, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: "medium" });
  }
  const bmp = await createImageBitmap(blob, opts);
  try {
    if (bmp.width * bmp.height > maxPixels) throw tooLarge(`Image ${bmp.width}×${bmp.height} is over the limit of ${Math.round(maxPixels / 1e6 * 10) / 10} MP.`);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return { rgba: ctx.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
  } finally { bmp.close?.(); }
}

/**
 * Bytes of a depth file -> {D, mask, w, h, bits, format} and, with `condition`, the conditioned map for the shader
 * (`cond: {rgba | half, w, h, info}`, D / mask then dropped). Order: size checks from the header (no decode of an
 * over-limit file), decode (PNG: capped streaming inflate, box-downscaled while converting when `maxSide` asks for it;
 * other formats: the browser decoder via `rasterize`, resized while decoding), crop, ≤ 2048 px, ≤ `maxSide`, condition.
 * Throws `code: "too-large"` errors for over-limit files and plain errors for broken ones.
 */
export async function prepareDepth(bytes, {
  type = "", hint = null, invert = false, crop = null, maxSide = 0, limits = DEPTH_LIMITS.map, condition = null, half = false,
  inflate = inflateZlib, rasterize = rasterizeBytes
} = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const L = { ...DEPTH_LIMITS.map, ...(limits ?? {}) };
  if (b.length > L.maxFileBytes) throw tooLarge(`Depth file of ${Math.round(b.length / MiB)} MB is over the limit of ${Math.round(L.maxFileBytes / MiB)} MB.`);
  let src;
  if (isPng(b)) {
    const info = pngInfo(b);
    if (info) checkPngHeader(info, L.maxPixels, L.maxRawBytes);
    const f = !crop && info ? boxFactorFor(info.w, info.h, maxSide) : 1;
    const png = await decodePng(b, inflate, L);
    src = depthFromPng(png, { hint, invert, factor: f });
  } else {
    const sz = imageSize(b);
    if (sz && sz.w * sz.h > L.maxPixels) throw tooLarge(`Depth image ${sz.w}×${sz.h} is over the limit of ${Math.round(L.maxPixels / 1e6 * 10) / 10} MP.`);
    if (typeof rasterize !== "function") throw new Error("No image decoder for this format here.");
    const r = await rasterize(b, type, { w: sz?.w ?? 0, h: sz?.h ?? 0, maxSide: crop ? 0 : maxSide, maxPixels: L.maxPixels });
    src = depthFromRGBA(r.rgba, r.w, r.h, { invert });
  }
  const rect = resolveCrop(crop, src.w, src.h);
  if (rect) src = { ...src, D: cropMap(src.D, src.w, src.h, rect), mask: src.mask ? cropMap(src.mask, src.w, src.h, rect) : null, w: rect[2], h: rect[3] };
  const shrink = (f) => {
    const d = downscaleMap(src.D, src.w, src.h, f);
    src = { ...src, D: d.M, mask: src.mask ? downscaleMap(src.mask, src.w, src.h, f).M : null, w: d.w, h: d.h };
  };
  while (Math.max(src.w, src.h) > 2048) shrink(2);
  const f2 = boxFactorFor(src.w, src.h, maxSide);
  if (f2 > 1) shrink(f2);
  if (!condition) return src;
  const c = conditionDepth(src, condition);
  return { w: c.w, h: c.h, bits: src.bits, format: src.format, D: null, mask: null, cond: { w: c.w, h: c.h, info: c.info, ...(half ? { half: toHalf(c.rgba) } : { rgba: c.rgba }) } };
}

// ---------------------------------------------------------------------------------------------------------------
// Shader maths (mirrored in GLSL)
// ---------------------------------------------------------------------------------------------------------------

/** Largest shift at strength 1, as a fraction of the image's SHORT side (the prototype moved ~2.9% at full mouse). */
export const MAX_SHIFT = 0.06;

/** Gamma then contrast around 0.5 (the shader's `cond`). gamma < 1 gives the near range (face) more relief. */
export function condition(d, gamma = 1, contrast = 1) {
  const g = Math.pow(clamp01(d), gamma);
  return clamp01((g - 0.5) * contrast + 0.5);
}

/** Clamp a look vector to the unit disc (a diagonal never moves further than a straight push). */
export function clampLook(x, y) {
  const l = Math.hypot(x, y);
  return l > 1 ? { x: x / l, y: y / l } : { x, y };
}

/**
 * UV offset between depth 1 and depth 0 for a look vector: |shift| = strength · MAX_SHIFT · short side, in each axis's
 * own uv units (so a circle in pixels stays a circle on a non-square image).
 */
export function offsetFor(look, strength, w, h) {
  const l = clampLook(look.x, look.y);
  const px = clamp01(strength) * MAX_SHIFT * Math.min(w, h);
  return { x: (l.x * px) / w, y: (l.y * px) / h };
}

/** Overscan so a sample never leaves the image: uv margin per axis = max shift × max(focus, 1 − focus) (+ a texel). */
export function overscanFor(strength, focus, w, h) {
  const px = clamp01(strength) * MAX_SHIFT * Math.min(w, h) * Math.max(clamp01(focus), 1 - clamp01(focus)) + 1;
  return { x: Math.min(0.2, px / w), y: Math.min(0.2, px / h) };
}

/** Linear search steps for a ray: about one step per 1.5 depth texels of travel, clamped to [8, 64]. */
export function stepsFor(off, dw, dh) {
  const travel = Math.hypot(off.x * dw, off.y * dh);
  return clamp(Math.ceil(travel / 1.5) + 6, 8, 64);
}

/** Normal from the depth gradient (texel differences of the blurred depth), `k` = relief scale. Unit vector. */
export function normalFromGradient(gx, gy, k) {
  const n = [-gx * k, -gy * k, 1];
  const l = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / l, n[1] / l, n[2] / l];
}

/**
 * How much the image is stretched at a source position: the screen point is uv = s + off·(H(s) − focus), so along
 * `off` one source pixel covers du/ds = 1 + off·∇H screen pixels (∇H in uv units). 1 = untouched, > 1 = stretched (a
 * hole revealed behind an edge, filled with copies of the edge pixels), ≤ 0 = folded (hidden: the ray search shows the
 * nearer surface there). Returns 0 for a fold.
 */
export function stretchFactor(off, grad) {
  const k = 1 + (off.x * grad.x + off.y * grad.y);
  return k <= 0 ? 0 : k;
}

/** Fade weight of the hole fill for a stretch factor: 0 below 1.6, 1 above 3.5 (smoothstep). */
export function holeWeight(s) {
  if (!Number.isFinite(s)) return 1;
  const t = clamp01((s - 1.6) / (3.5 - 1.6));
  return t * t * (3 - 2 * t);
}

/**
 * CPU reference of the shader's ray search on a 1-D height profile H(u) (u in 0..1, sampled linearly): returns the
 * sample position whose height the ray meets first, scanning from the near plane (h = 1) down to the far (h = 0).
 * s(h) = u − off·(h − focus); hit where H(s(h)) ≥ h. Linear steps then `refine` bisections. Used by the tests to prove
 * that occlusion is ordered (near beats far) and the result never jumps over a thin near feature.
 */
export function marchRay(H, u, off, focus, steps, refine = 6) {
  const sample = (s) => {
    const n = H.length, f = clamp(s, 0, 1) * (n - 1), i = Math.floor(f), t = f - i;
    return H[i] * (1 - t) + H[Math.min(n - 1, i + 1)] * t;
  };
  const at = (hh) => u - off * (hh - focus);
  let hPrev = 1, hit = -1;
  for (let i = 0; i <= steps; i++) {
    const hh = 1 - i / steps;
    if (sample(at(hh)) >= hh) { hit = hh; break; }
    hPrev = hh;
  }
  if (hit < 0) return { s: at(0), h: 0 };
  if (hit === 1) return { s: at(1), h: 1 };
  let lo = hit, hi = hPrev; // H(at(lo)) >= lo (inside), H(at(hi)) < hi (above)
  for (let k = 0; k < refine; k++) {
    const mid = (lo + hi) / 2;
    if (sample(at(mid)) >= mid) lo = mid; else hi = mid;
  }
  const hh = (lo + hi) / 2;
  return { s: at(hh), h: hh };
}

/** Frame-rate independent exponential approach: after `halfLife` seconds half of the distance is covered. */
export function easeToward(x, target, dt, halfLife = 0.12) {
  if (!(dt > 0)) return x;
  if (!(halfLife > 0)) return target;
  return target + (x - target) * Math.pow(0.5, dt / halfLife);
}

/** Idle blend 0..1: 0 while the pointer moved within `delay` ms, then a smooth ramp over `ramp` ms. */
export function idleBlend(now, lastInput, delay = 1500, ramp = 2000) {
  const t = clamp01((now - lastInput - delay) / ramp);
  return t * t * (3 - 2 * t);
}

/** Idle sway look vector (a slow Lissajous figure), amplitude `amp` 0..1. */
export function swayAt(tMs, amp) {
  return { x: Math.sin(tMs / 4800) * 0.8 * amp, y: Math.sin(tMs / 6900 + 0.7) * 0.45 * amp };
}

/** Canvas backing size: CSS size × min(DPR, cap), and never more than `maxPixels` in total. */
export function backingSize(cssW, cssH, dpr = 1, { cap = 2, maxPixels = 4.2e6 } = {}) {
  let r = Math.min(Math.max(1, dpr || 1), cap);
  if (cssW * cssH * r * r > maxPixels) r = Math.sqrt(maxPixels / Math.max(1, cssW * cssH));
  return { w: Math.max(1, Math.round(cssW * r)), h: Math.max(1, Math.round(cssH * r)), ratio: r };
}

/** "Contain" fit of an image aspect into a panel: the drawn rectangle in panel-normalised units (0..1). */
export function containRect(panelW, panelH, imgAspect) {
  const pa = panelW / Math.max(1, panelH);
  if (imgAspect > pa) { const hh = pa / imgAspect; return { x: 0, y: (1 - hh) / 2, w: 1, h: hh }; }
  const ww = imgAspect / pa;
  return { x: (1 - ww) / 2, y: 0, w: ww, h: 1 };
}

/** Parallax view settings: defaults, ranges, normalisation (window session state; the type's cfg.depth.parallax seeds it). */
export const VIEW_RANGES = Object.freeze({
  strength: [0, 1, 0.01],
  sway: [0, 1, 0.01],
  light: [0, 1, 0.01],
  rim: [0, 1, 0.01],
  dust: [0, 1, 0.01],
  gamma: [0.4, 2, 0.01],
  contrast: [0.5, 2, 0.01],
  focus: [0, 1, 0.01],
  dilate: [0, 6, 1],
  normalBlur: [0, 8, 1]
});

export function viewDefaults() {
  return {
    strength: 0.5, sway: 0.3, light: 0.6, rim: 0.5, dust: 0.4, gamma: 1, contrast: 1, focus: 0.45, dilate: 2, normalBlur: 3,
    on: { light: true, rim: true, dust: false, vignette: true, holeFill: true },
    view: "image"
  };
}

export const VIEWS = Object.freeze(["image", "depth", "holes"]);

/** Clamp a settings object (any partial input) into the view schema. Idempotent. */
export function normalizeView(raw = {}, base = viewDefaults()) {
  const out = structuredClone(base);
  const r = raw && typeof raw === "object" ? raw : {};
  for (const [k, [min, max, step]] of Object.entries(VIEW_RANGES)) {
    const n = Number(r[k]);
    if (r[k] === undefined || r[k] === null || r[k] === "" || !Number.isFinite(n)) continue;
    const v = Math.round((clamp(n, min, max) - min) / step) * step + min;
    out[k] = Math.round(Math.min(max, v) * 1000) / 1000;
  }
  const on = r.on && typeof r.on === "object" ? r.on : {};
  for (const k of Object.keys(out.on)) if (typeof on[k] === "boolean") out.on[k] = on[k];
  if (VIEWS.includes(r.view)) out.view = r.view;
  return out;
}

/**
 * Seed the view from a type's stored `cfg.depth.parallax` ({strength, sway, light, rim, dust} with light/rim/dust as
 * on/off switches, depth-settings.mjs).
 */
export function viewFromTypeParallax(p, base = viewDefaults()) {
  if (!p || typeof p !== "object") return normalizeView({}, base);
  const on = { ...base.on };
  for (const k of ["light", "rim", "dust"]) if (typeof p[k] === "boolean") on[k] = p[k];
  return normalizeView({ strength: p.strength, sway: p.sway, on }, base);
}

/** Depth file name that the module writes next to an image (`<name>_depth.png`), for the sheet button check. */
export function depthNameFor(file) {
  const base = String(file ?? "").split(/[?#]/)[0].split("/").pop().replace(/\.[^.]+$/, "");
  return base ? `${base}_depth.png` : "";
}
