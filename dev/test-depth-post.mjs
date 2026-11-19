// W6-I: depth post-processing (scripts/depth/post.mjs), run planning (scripts/depth/plan.mjs) and the "no external API
// except the Hugging Face model download" checks of the browser engine. Pure Node, synthetic arrays, no network.
// Run from the module folder: node dev/test-depth-post.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  percentile, maskShare, maskUsable, normalizeRobust, sobel, fillFlyingPixels, boxMean, guidedFilter, maskedMean, maskedMax,
  snapToMask, smoothInterior, applyGamma, resizeBilinear, luminance, imageToDepth, postProcess, POST_DEFAULTS,
  crc32, encodePng, toUint16, encodeDepthPng16, encodeDepthRG16, encodeGray8, depthPathsFor, DEPTH_FALLBACK_DIR
} from "../scripts/depth/post.mjs";
import { planBrowserRun, onnxFile, fileUrl, HF_HOST, MASK_REPOS } from "../scripts/depth/plan.mjs";
import { depthDefaults, normalizeDepth } from "../scripts/depth-settings.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const fill = (w, h, f) => { const a = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = f(x, y); return a; };

// ---------- PNG reader for the round trips (only what our writer produces: Paeth rows, grey 8/16, RGB 8) ----------
function readPng(bytes) {
  const b = Buffer.from(bytes);
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "signature");
  let o = 8, ihdr = null; const idat = []; const types = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
    const crc = b.readUInt32BE(o + 8 + len);
    assert.equal((crc32(b.subarray(o + 4, o + 8 + len)) ^ 0xffffffff) >>> 0, crc, `crc ${type}`);
    types.push(type);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  const raw = inflateSync(Buffer.concat(idat));
  const ch = ihdr.color === 2 ? 3 : 1, bpp = ch * ihdr.depth / 8, stride = ihdr.w * bpp;
  const out = new Uint8Array(stride * ihdr.h);
  const paeth = (a, b2, c) => { const p = a + b2 - c, pa = Math.abs(p - a), pb = Math.abs(p - b2), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c; };
  for (let y = 0; y < ihdr.h; y++) {
    assert.equal(raw[y * (stride + 1)], 4, "Paeth filter");
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b2 = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      out[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + paeth(a, b2, c)) & 0xff;
    }
  }
  return { ...ihdr, data: out };
}

// ---------- step by step ----------
await test("percentile: linear interpolation, NaN ignored, selector", () => {
  const v = Float32Array.from([5, 1, NaN, 3, 2, 4]);
  near(percentile(v, 0), 1); near(percentile(v, 100), 5); near(percentile(v, 50), 3); near(percentile(v, 25), 2);
  near(percentile(v, 100, (i) => i !== 0), 4);
  assert.ok(Number.isNaN(percentile(new Float32Array([NaN]), 50)));
});

await test("normalise: percentile clip to 0..1, outliers do not stretch the range; mask picks bg low / figure high", () => {
  const w = 100, h = 1;
  const D = fill(w, h, (x) => x);
  D[0] = -1000; D[99] = 1000; // single extreme pixels
  const r = normalizeRobust(D, { lowPct: 1, highPct: 99 });
  assert.equal(r.flat, false);
  assert.ok(r.lo > -20 && r.hi < 1000, `${r.lo} ${r.hi}`);
  assert.ok(r.out.every((v) => v >= 0 && v <= 1));
  near(r.out[50], (50 - r.lo) / (r.hi - r.lo), 1e-5);
  // mask: background 0..10, figure 50..60, a far outlier in the figure is clipped by the 99th percentile
  const D2 = fill(2000, 1, (x) => (x < 1000 ? x / 100 : 50 + (x - 1000) / 100)); D2[1500] = 9999;
  const A = fill(2000, 1, (x) => (x < 1000 ? 0 : 1));
  const m = normalizeRobust(D2, { lowPct: 1, highPct: 99, mask: A });
  assert.ok(m.lo < 1 && m.hi > 59 && m.hi < 61, `${m.lo} ${m.hi}`);
  assert.equal(m.out[1500], 1);
  // flat input
  const f = normalizeRobust(new Float32Array(16).fill(3));
  assert.equal(f.flat, true);
  assert.ok(f.out.every((v) => v === 0));
  // robust off = min-max
  const mm = normalizeRobust(Float32Array.from([2, 4, 6]), { robust: false });
  assert.deepEqual([...mm.out], [0, 0.5, 1]);
});

await test("mask usability: both classes need ≥ 0.5% of the pixels", () => {
  assert.deepEqual(maskShare(Float32Array.from([1, 1, 0, 0])), { fg: 0.5, bg: 0.5 });
  assert.equal(maskUsable(new Float32Array(1000).fill(1)), false);
  const a = new Float32Array(1000); a.fill(1, 0, 10);
  assert.equal(maskUsable(a), true);
  assert.equal(maskUsable(null), false);
});

await test("Sobel: a unit ramp reads 1 per pixel inside, 0 on flat", () => {
  const w = 8, h = 5;
  const g = sobel(fill(w, h, (x) => x), w, h);
  near(g[2 * w + 3], 1, 1e-6);
  assert.ok(sobel(new Float32Array(w * h).fill(0.4), w, h).every((v) => v === 0));
});

await test("flying pixels: a blurred step becomes a sharp step with values only from the two plateaus", () => {
  const w = 20, h = 6;
  // background 0.1 for x<8, a 4-px linear ramp, figure 0.9 for x>=12
  const D = fill(w, h, (x) => (x < 8 ? 0.1 : x >= 12 ? 0.9 : 0.1 + (x - 7) * 0.16));
  const { out, count } = fillFlyingPixels(D, w, h, { threshold: 0.06 });
  assert.ok(count > 0);
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - 0.1) < 1e-6 || Math.abs(out[i] - 0.9) < 1e-6, `pixel ${i} = ${out[i]}`);
  // monotone per row: once figure, stays figure
  for (let y = 0; y < h; y++) { let seen = false; for (let x = 0; x < w; x++) { const f = out[y * w + x] > 0.5; if (seen) assert.ok(f); seen ||= f; } }
  // nothing above the threshold: unchanged
  const smooth = fill(w, h, (x) => x * 0.01);
  assert.deepEqual([...fillFlyingPixels(smooth, w, h, { threshold: 0.06 }).out], [...smooth]);
});

await test("box mean equals the brute-force clipped window mean", () => {
  const w = 9, h = 7, r = 2;
  const src = fill(w, h, (x, y) => Math.sin(x * 1.3 + y * 0.7) + y * 0.1);
  const got = boxMean(src, w, h, r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += src[yy * w + xx]; n++; }
    near(got[y * w + x], s / n, 1e-5, `(${x},${y})`);
  }
});

await test("guided filter: flat guide = box mean of the box mean; edge in the guide keeps the depth edge sharp", () => {
  const w = 24, h = 8;
  const p = fill(w, h, (x) => (x < 12 ? 0.2 : 0.8));
  const flat = guidedFilter(p, new Float32Array(w * h).fill(0.5), w, h, 3, 1e-3);
  const bm = boxMean(p, w, h, 3);
  const bm2 = boxMean(bm, w, h, 3); // zero guide variance: a = 0, b = mean(p), output = mean(b)
  for (let i = 0; i < p.length; i++) near(flat[i], bm2[i], 1e-4);
  const guide = fill(w, h, (x) => (x < 12 ? 0 : 1));
  const g = guidedFilter(p, guide, w, h, 3, 1e-3);
  near(g[4 * w + 11], 0.2, 0.02, "left of edge");
  near(g[4 * w + 12], 0.8, 0.02, "right of edge");
  assert.ok(Math.abs(bm[4 * w + 11] - 0.2) > 0.1, "plain blur would smear it");
});

await test("masked mean / max respect the selection", () => {
  const w = 5, h = 1, D = Float32Array.from([1, 2, 3, 4, 5]);
  const mm = maskedMean(D, (i) => i >= 3, w, h, 1);
  assert.ok(Number.isNaN(mm[0]) && Number.isNaN(mm[1]));
  near(mm[2], 4); near(mm[4], 4.5);
  const mx = maskedMax(D, (i) => i <= 1, w, h, 1);
  assert.deepEqual([...mx], [2, 2, 2, -Infinity, -Infinity]);
});

await test("mask snap: background never in front of the figure, figure dilated outwards, edgeSnap blends, bad mask skips", () => {
  const w = 40, h = 40;
  // figure = disc in the middle at 0.8..0.9; background 0.2..0.5 with a halo of 0.6 around the disc
  const r2 = (x, y) => (x - 20) ** 2 + (y - 20) ** 2;
  const A = fill(w, h, (x, y) => (r2(x, y) <= 100 ? 1 : 0));
  const D = fill(w, h, (x, y) => (r2(x, y) <= 100 ? 0.8 + 0.1 * (1 - r2(x, y) / 100) : r2(x, y) <= 169 ? 0.6 : 0.2 + 0.3 * y / h));
  const { out, skipped, cap } = snapToMask(D, A, w, h, { dilatePx: 2, edgeSnap: 1, bgRadius: 6 });
  assert.equal(skipped, false);
  assert.ok(cap < 0.8, `cap ${cap}`);
  let maxBg = 0, minFg = 1;
  for (let i = 0; i < out.length; i++) { if (A[i] < 0.5) maxBg = Math.max(maxBg, out[i]); else minFg = Math.min(minFg, out[i]); }
  assert.ok(maxBg <= cap + 1e-6 && maxBg < minFg, `bg ${maxBg} figure ${minFg}`);
  for (let i = 0; i < out.length; i++) if (A[i] >= 0.5) near(out[i], D[i], 1e-6, "figure kept");
  // soft edge pixel just outside the disc: dilated figure value dominates as A grows
  const Asoft = Float32Array.from(A); const edge = 20 * w + 31; Asoft[edge] = 0.4;
  const s = snapToMask(D, Asoft, w, h, { dilatePx: 2, edgeSnap: 1, bgRadius: 6 }).out;
  assert.ok(s[edge] > out[edge] + 0.1, `${s[edge]} vs ${out[edge]}`);
  // edgeSnap 0 and an unusable mask leave the input
  assert.deepEqual([...snapToMask(D, A, w, h, { edgeSnap: 0 }).out], [...D]);
  assert.equal(snapToMask(D, new Float32Array(w * h).fill(1), w, h).skipped, true);
  const half = snapToMask(D, A, w, h, { dilatePx: 2, edgeSnap: 0.5, bgRadius: 6 }).out;
  const i0 = 2 * w + 2; near(half[i0], (D[i0] + out[i0]) / 2, 1e-5, "half blend");
});

await test("smoothing: noise inside the figure drops, the mask edge stays sharp; no mask = self-guided", () => {
  const w = 30, h = 30;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
  const A = fill(w, h, (x) => (x < 15 ? 0 : 1));
  const D = fill(w, h, (x) => (x < 15 ? 0.2 : 0.8) + rnd());
  const out = smoothInterior(D, A, w, h, 3);
  const sd = (arr, sel) => { const v = []; for (let i = 0; i < arr.length; i++) if (sel(i)) v.push(arr[i]); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
  const inFig = (i) => i % w >= 18;
  assert.ok(sd(out, inFig) < sd(D, inFig) * 0.6, `${sd(out, inFig)} vs ${sd(D, inFig)}`);
  for (let y = 0; y < h; y++) assert.ok(out[y * w + 15] - out[y * w + 14] > 0.5, "edge stays a step");
  const soft = Float32Array.from(A); soft[5 * w + 15] = 0.5;
  assert.equal(smoothInterior(D, soft, w, h, 3)[5 * w + 15], D[5 * w + 15], "soft-edge pixel untouched");
  const self = smoothInterior(D, null, w, h, 3);
  for (let y = 2; y < h - 2; y++) assert.ok(self[y * w + 16] - self[y * w + 13] > 0.4, "self-guided keeps the step");
  assert.deepEqual([...smoothInterior(D, A, w, h, 0)], [...D]);
});

await test("gamma: endpoints fixed, mid-tones lifted for gamma < 1, clamped", () => {
  const g = applyGamma(Float32Array.from([0, 0.25, 1, 1.5, -1]), 0.8);
  assert.equal(g[0], 0); near(g[2], 1); near(g[1], Math.pow(0.25, 0.8), 1e-6); assert.ok(g[1] > 0.25);
  near(g[3], 1); assert.equal(g[4], 0);
});

await test("bilinear resize: identity, constant, and a 2x upsample of a ramp stays monotone", () => {
  const src = Float32Array.from([0, 1, 2, 3]);
  assert.deepEqual([...resizeBilinear(src, 2, 2, 2, 2)], [0, 1, 2, 3]);
  assert.ok(resizeBilinear(new Float32Array(9).fill(0.3), 3, 3, 7, 5).every((v) => Math.abs(v - 0.3) < 1e-6));
  const up = resizeBilinear(Float32Array.from([0, 1, 2, 3]), 4, 1, 8, 1);
  for (let i = 1; i < 8; i++) assert.ok(up[i] >= up[i - 1]);
});

await test("luminance and image→depth (generative output): grey mean, optional invert, resized to the source", () => {
  const rgba = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 128, 128, 128, 255]);
  const L = luminance(rgba, 2, 2);
  near(L[0], 1, 1e-6); near(L[1], 0, 1e-6); near(L[2], 0.2126, 1e-4);
  const d = imageToDepth(rgba, 2, 2, 2, 2);
  near(d[0], 1, 1e-6); near(d[1], 0, 1e-6); near(d[2], 1 / 3, 1e-6);
  near(imageToDepth(rgba, 2, 2, 2, 2, { invert: true })[0], 0, 1e-6);
  assert.equal(imageToDepth(rgba, 2, 2, 6, 4).length, 24);
});

await test("postProcess: the §7.2 order, mask steps only with a usable mask, output in 0..1, size check", () => {
  const w = 48, h = 64;
  const A = fill(w, h, (x, y) => ((x - 24) ** 2 / 225 + (y - 30) ** 2 / 400 <= 1 ? 1 : 0));
  const raw = fill(w, h, (x, y) => (A[y * w + x] ? 5 + Math.cos(x / 9) : 1 + y / h) + (x === 3 && y === 3 ? 100 : 0));
  const guide = fill(w, h, (x, y) => A[y * w + x] * 0.7 + 0.1);
  let t = 0; const now = () => (t += 1);
  const r = postProcess(raw, { w, h, mask: A, guide, post: depthDefaults().post, modelSize: 32, now });
  assert.deepEqual(r.steps.map((s) => s.name), ["normalize", "flyingPixels", "guided", "maskSnap", "smooth", "gamma"]);
  assert.ok(r.depth.every((v) => v >= 0 && v <= 1));
  assert.ok(r.steps.every((s) => s.ms === 1));
  let fg = 0, bg = 0, nf = 0, nb = 0;
  for (let i = 0; i < A.length; i++) if (A[i]) { fg += r.depth[i]; nf++; } else { bg += r.depth[i]; nb++; }
  assert.ok(fg / nf > bg / nb + 0.3, "figure in front");
  const noMask = postProcess(raw, { w, h, guide: null, post: { ...POST_DEFAULTS, gamma: 1 } });
  assert.deepEqual(noMask.steps.map((s) => s.name), ["normalize", "flyingPixels", "smooth"]);
  const off = postProcess(raw, { w, h, post: { normalize: false, flyingPixels: false, guided: false, edgeSnap: 0, smoothPx: 0, gamma: 1 } });
  assert.deepEqual(off.steps.map((s) => s.name), ["normalize"]);
  assert.equal(postProcess(new Float32Array(w * h).fill(2), { w, h }).flat, true);
  assert.throws(() => postProcess(new Float32Array(5), { w, h }), /does not match/);
  // the settings schema's post block is what postProcess reads
  assert.deepEqual(Object.keys(POST_DEFAULTS).sort(), Object.keys(normalizeDepth({}).post).sort());
});

// ---------- lossless files ----------
await test("16-bit grey PNG round trip: exact 16-bit values, near = white", async () => {
  const w = 37, h = 11;
  const D = fill(w, h, (x, y) => ((x * 131 + y * 977) % 1000) / 999);
  const png = readPng(await encodeDepthPng16(D, w, h));
  assert.deepEqual([png.w, png.h, png.depth, png.color], [w, h, 16, 0]);
  const q = toUint16(D);
  for (let i = 0; i < q.length; i++) assert.equal((png.data[2 * i] << 8) | png.data[2 * i + 1], q[i]);
  assert.equal(toUint16(Float32Array.from([1]))[0], 65535);
  assert.equal(toUint16(Float32Array.from([2, -1]))[0], 65535);
});

await test("RG16 PNG: R high byte, G low byte, mask in B; the shader formula restores the depth to 1/65535", async () => {
  const w = 16, h = 9;
  const D = fill(w, h, (x, y) => (x + y * w) / (w * h - 1));
  const A = fill(w, h, (x) => x / (w - 1));
  const png = readPng(await encodeDepthRG16(D, A, w, h));
  assert.deepEqual([png.depth, png.color], [8, 2]);
  for (let i = 0; i < w * h; i++) {
    const r = png.data[3 * i] / 255, g = png.data[3 * i + 1] / 255;
    const d = (r * 255 * 256 + g * 255) / 65535;
    assert.ok(Math.abs(d - D[i]) <= 1 / 65535 + 1e-9, `${d} vs ${D[i]}`);
    assert.equal(png.data[3 * i + 2], Math.round(A[i] * 255));
  }
  const noMask = readPng(await encodeDepthRG16(D, null, w, h));
  for (let i = 0; i < w * h; i++) assert.equal(noMask.data[3 * i + 2], 0);
});

await test("8-bit grey PNG (mask / preview) and the writer's size guard", async () => {
  const M = Float32Array.from([0, 0.5, 1, 0.25]);
  const png = readPng(await encodeGray8(M, 2, 2));
  assert.deepEqual([...png.data], [0, 128, 255, 64]);
  await assert.rejects(encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 8, raw: new Uint8Array(3) }), /PNG/);
  // CRC-32 of "123456789" is the standard check value
  assert.equal((crc32(new TextEncoder().encode("123456789")) ^ 0xffffffff) >>> 0, 0xcbf43926);
});

await test("file names: <name>_depth.png next to the image; URLs and core folders go to the data fallback", () => {
  const p = depthPathsFor("ai-image-gen/invincible/Actor/hero-ab12.webp?v=3");
  assert.deepEqual([p.dir, p.base, p.depth, p.mask, p.meta, p.writable], ["ai-image-gen/invincible/Actor", "hero-ab12", "ai-image-gen/invincible/Actor/hero-ab12_depth.png", "ai-image-gen/invincible/Actor/hero-ab12_mask.png", "ai-image-gen/invincible/Actor/hero-ab12_depth.json", true]);
  // W6-R: depthPathsFor takes the KEY (decoded once by normalizeImagePath) and never decodes again
  assert.equal(depthPathsFor("worlds/x/portraits/Pani Z.png").depth, "worlds/x/portraits/Pani-Z_depth.png");
  assert.equal(depthPathsFor("worlds/x/portraits/Pani%20Z.png").depth, "worlds/x/portraits/Pani-20Z_depth.png", "a literal %20 stays");
  assert.doesNotThrow(() => depthPathsFor("worlds/x/100%.webp"));
  for (const s of ["https://example.com/a.png", "icons/svg/mystery-man.svg", "systems/invincible/art/a.webp", "modules/x/a.png", "../etc/a.png", "a.png", "blob:abc"]) {
    const q = depthPathsFor(s);
    assert.equal(q.writable, false, s);
    assert.ok(q.depth.startsWith(`${DEPTH_FALLBACK_DIR}/`), s);
  }
});

// ---------- plan ----------
await test("plan: WebGPU uses the setting's model + precision, falls back to Small webgpu then wasm; no WebGPU -> Small wasm or an error", () => {
  const d = normalizeDepth({ model: "da2-large", precision: "q4f16" });
  const p = planBrowserRun(d, { ok: true, f16: true, maxStorageBuffers: 32 });
  assert.deepEqual([p.primary.repo, p.primary.device, p.primary.dtype, p.primary.sizeMB], ["onnx-community/depth-anything-v2-large", "webgpu", "q4f16", 235]);
  assert.deepEqual(p.fallbacks.map((s) => `${s.key}/${s.device}/${s.dtype}`), ["da2-small/webgpu/fp16", "da2-small/wasm/fp32"]);
  assert.deepEqual([p.mask.repo, p.mask.dtype, p.mask.sizeMB, p.mask.licence], ["onnx-community/BiRefNet_lite-ONNX", "fp16", 114.5, "MIT"]);
  // RTX 3070 Ti adapter: 16 storage buffers per stage < 17 BiRefNet needs; WASM fp32 runs out of memory -> no mask, no download
  const ti = planBrowserRun(d, { ok: true, f16: true, maxStorageBuffers: 16 });
  assert.equal(ti.primary.device, "webgpu");
  assert.equal(ti.mask, null);
  assert.ok(ti.notes.includes("maskUnsupported"));
  const fp16 = planBrowserRun(normalizeDepth({ model: "da2-large", precision: "fp16" }), { ok: true, f16: false });
  assert.equal(fp16.primary.dtype, "fp32"); assert.ok(fp16.notes.includes("noShaderF16"));
  const noGpu = planBrowserRun(normalizeDepth({ model: "da2-large" }), { ok: false });
  assert.deepEqual([noGpu.primary.key, noGpu.primary.device, noGpu.primary.dtype], ["da2-small", "wasm", "fp32"]);
  assert.equal(noGpu.mask, null, "no WASM mask (bad_alloc at the fixed 1024² input)");
  assert.equal(planBrowserRun(normalizeDepth({ model: "da2-large", fallback: false }), { ok: false }).error, "largeNeedsWebGPU");
  assert.equal(planBrowserRun(normalizeDepth({ model: "da2-large", fallback: false }), { ok: true, f16: true }).fallbacks.length, 0);
  const da3 = planBrowserRun(normalizeDepth({ model: "da3-mono-large-onnx" }), { ok: true, f16: true });
  assert.equal(da3.primary.key, "da2-large"); assert.ok(da3.notes.includes("da3NotBuilt"));
  const toon = planBrowserRun(normalizeDepth({ mask: { enabled: true, model: "toonout" } }), { ok: true, f16: true, maxStorageBuffers: 32 });
  assert.equal(toon.mask, null); assert.ok(toon.notes.includes("maskNotBuilt"));
  assert.equal(planBrowserRun(normalizeDepth({ mask: { enabled: false } }), { ok: true, f16: true }).mask, null);
  assert.equal(planBrowserRun(normalizeDepth({ resolution: 770 }), { ok: true, f16: true }).primary.resolution, 770);
});

await test("model file URLs are Hugging Face resolve URLs with transformers.js dtype names", () => {
  assert.deepEqual(["fp32", "fp16", "q4f16", "q8"].map(onnxFile), ["model.onnx", "model_fp16.onnx", "model_q4f16.onnx", "model_quantized.onnx"]);
  assert.equal(fileUrl("onnx-community/depth-anything-v2-large", "q4f16"), "https://huggingface.co/onnx-community/depth-anything-v2-large/resolve/main/onnx/model_q4f16.onnx");
  assert.equal(HF_HOST, "https://huggingface.co/");
  assert.equal(MASK_REPOS["birefnet-lite"], "onnx-community/BiRefNet_lite-ONNX");
});

// ---------- network: nothing external except the Hugging Face model download ----------
const MOD = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, MOD), "utf8");
const strip = (code) => code.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

await test("depth code: the only absolute URL is huggingface.co; fetch only for the image path; no provider/API host", () => {
  const dir = new URL("scripts/depth/", MOD);
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 7, files.join(","));
  for (const f of files) {
    const code = strip(readFileSync(new URL(f, dir), "utf8"));
    const urls = code.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    for (const u of urls) assert.ok(u.startsWith("https://huggingface.co/"), `${f}: ${u}`);
    assert.ok(!/api\.openai\.com|generativelanguage|openrouter\.ai|anthropic|jsdelivr|unpkg/.test(code), `${f}: external API host`);
    const fetches = code.match(/\bfetch\(/g)?.length ?? 0;
    if (f === "run.mjs") assert.equal(fetches, 1, "run.mjs: one fetch (the source image)");
    else if (f === "depth-index.mjs") assert.equal(fetches, 1, "depth-index.mjs: one fetch (an old-form sidecar listed in the Data folder)");
    else assert.equal(fetches, 0, `${f}: no fetch`);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(code), `${f}: other transport`);
  }
  // the generative engine reaches providers only through generate-flow (getKey, budget, call log): no own provider calls
  const gen = strip(read("scripts/depth/generative.mjs"));
  assert.ok(!/providers\/index|generate\(\{|getKey/.test(gen), "generative.mjs does not call providers directly");
  const run = strip(read("scripts/depth/run.mjs"));
  assert.ok(/F\.executeGeneration\(/.test(run) && /confirmPaid/.test(run), "run.mjs: generative path = executeGeneration after confirmPaid");
});

await test("engine: vendored library, local ONNX runtime files, remote host pinned to huggingface.co, browser cache", () => {
  const eng = strip(read("scripts/depth/engine.mjs"));
  assert.match(eng, /vendor\/transformers\//);
  assert.match(eng, /wasmPaths = \{ mjs: vendorUrl\("ort-wasm-simd-threaded\.asyncify\.mjs"\), wasm: vendorUrl\("ort-wasm-simd-threaded\.asyncify\.wasm"\) \}/);
  assert.match(eng, /env\.remoteHost = HF_HOST/);
  assert.match(eng, /env\.allowLocalModels = false/);
  assert.match(eng, /env\.useBrowserCache = true/);
  assert.ok(!/import\s*\(\s*["'`]https?:/.test(eng), "no CDN import");
  // wasmPaths are set inside the import().then, before any pipeline() can run
  const i = eng.indexOf("wasmPaths"), j = eng.indexOf("T.pipeline(");
  assert.ok(i > 0 && j > i);
});

await test("vendored transformers.js 4.3.2 + onnxruntime-web: files, versions, licences, hashes, hosts", () => {
  const v = new URL("vendor/transformers/", MOD);
  const need = ["transformers.min.js", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm", "LICENSE", "LICENSE-onnxruntime.txt", "VENDOR.md"];
  for (const f of need) assert.ok(statSync(new URL(f, v)).size > 0, f);
  const lib = readFileSync(new URL("transformers.min.js", v), "utf8");
  assert.ok(lib.includes('"4.3.2"'), "library version");
  assert.ok(lib.includes('"1.31.0-dev.20260914-8d85527a0"'), "bundled ORT version = vendored WASM");
  assert.ok(lib.includes('remoteHost:"https://huggingface.co/"'));
  const hosts = new Set((lib.match(/https?:\/\/[a-zA-Z0-9.-]+/g) ?? []).map((u) => u.replace(/^https?:\/\//, "")));
  // documentation links aside, the bundle's only runtime hosts are huggingface.co and the jsDelivr WASM default we override
  for (const h of hosts) assert.ok(["huggingface.co", "cdn.jsdelivr.net", "developer.mozilla.org", "gist.github.com", "github.com", "web.dev"].includes(h), h);
  const sha = (f) => createHash("sha256").update(readFileSync(new URL(f, v))).digest("hex");
  assert.equal(sha("transformers.min.js"), "8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb");
  assert.equal(sha("ort-wasm-simd-threaded.asyncify.mjs"), "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611");
  assert.equal(sha("ort-wasm-simd-threaded.asyncify.wasm"), "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082");
  assert.match(readFileSync(new URL("LICENSE", v), "utf8"), /Apache License\s+Version 2\.0/);
  assert.match(readFileSync(new URL("LICENSE-onnxruntime.txt", v), "utf8"), /MIT License[\s\S]*Microsoft Corporation/);
  const att = read("ATTRIBUTION.md");
  for (const s of ["@huggingface/transformers", "4.3.2", "onnxruntime-web", "CC BY-NC 4.0", "Apache-2.0", "MIT", "depth-anything-v2-large", "depth-anything-v2-small", "BiRefNet_lite"]) assert.ok(att.includes(s), `ATTRIBUTION: ${s}`);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
