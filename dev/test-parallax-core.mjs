// W6-L: parallax portrait window, the pure part (scripts/parallax/parallax-core.mjs): PNG decoding (our png16 / png-rg16
// writers, every filter, bit depths 1-16, palette, Adam7), depth format detection, crops, conditioning, and the shader
// maths (offset limits, overscan, step count, normals, stretch, ray search, easing, sway). Pure Node, synthetic data.
// Run from the module folder: node dev/test-parallax-core.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync, deflateSync, deflateRawSync, constants as zlibConstants } from "node:zlib";
import {
  isPng, decodePng, detectDepthFormat, depthFromPng, depthFromRGBA, resolveCrop, cropMap, downscaleMap, rankFilter,
  dilateForeground, conditionDepth, MAX_SHIFT, condition, clampLook, offsetFor, overscanFor, stepsFor, normalFromGradient,
  stretchFactor, holeWeight, marchRay, easeToward, idleBlend, swayAt, backingSize, containRect, VIEW_RANGES, viewDefaults,
  normalizeView, viewFromTypeParallax, depthNameFor, inflateZlib, pngInfo, pngRawSize, imageSize, DEPTH_LIMITS, prepareDepth,
  toHalf, halfToFloat, withRev, boxFactorFor
} from "../scripts/parallax/parallax-core.mjs";
import { encodeDepthPng16, encodeDepthRG16, encodeGray8, crc32 } from "../scripts/depth/post.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const inflate = async (b) => new Uint8Array(inflateSync(b));
const deflate = async (b) => new Uint8Array(deflateSync(b));
const fill = (w, h, f) => { const a = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = f(x, y); return a; };

// ---------- a test PNG writer with a chosen filter per row, any colour type / bit depth, optional Adam7 ----------
function pngBytes({ w, h, colorType, bitDepth, samples, filter = (y) => y % 5, interlace = 0, palette = null }) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPP = ch * bitDepth, bpp = Math.max(1, bitsPP >> 3);
  const pack = (xs, ys, pw) => { // rows of a (sub)image → filtered bytes
    const stride = Math.ceil((pw * bitsPP) / 8);
    const rows = [];
    let prev = new Uint8Array(stride);
    ys.forEach((y, ri) => {
      const raw = new Uint8Array(stride);
      xs.forEach((x, xi) => {
        for (let c = 0; c < ch; c++) {
          const v = samples[(y * w + x) * ch + c], s = xi * ch + c;
          if (bitDepth === 16) { raw[2 * s] = v >> 8; raw[2 * s + 1] = v & 255; }
          else if (bitDepth === 8) raw[s] = v;
          else { const bit = s * bitDepth; raw[bit >> 3] |= v << (8 - bitDepth - (bit & 7)); }
        }
      });
      const f = filter(ri);
      const out = new Uint8Array(stride + 1);
      out[0] = f;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
        out[i + 1] = (raw[i] - pr) & 255;
      }
      rows.push(out);
      prev = raw;
    });
    return rows;
  };
  let rows = [];
  if (interlace) {
    for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
      const xs = [], ys = [];
      for (let x = x0; x < w; x += dx) xs.push(x);
      for (let y = y0; y < h; y += dy) ys.push(y);
      if (xs.length && ys.length) rows.push(...pack(xs, ys, xs.length));
    }
  } else rows = pack([...Array(w).keys()], [...Array(h).keys()], w);
  const body = Buffer.concat(rows.map((r) => Buffer.from(r)));
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); Buffer.from(data).copy(b, 8);
    b.writeUInt32BE((crc32(b.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0, 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (palette) parts.push(chunk("PLTE", palette));
  const z = deflateSync(body);
  parts.push(chunk("IDAT", z.subarray(0, 7)), chunk("IDAT", z.subarray(7)), chunk("IEND", Buffer.alloc(0))); // split IDAT on purpose
  return new Uint8Array(Buffer.concat(parts));
}
const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();

// ---------- PNG decoding ----------

await test("decodes our png16 writer exactly (16 bit grey), detects png16", async () => {
  const w = 37, h = 23;
  const D = fill(w, h, (x, y) => ((x * 131 + y * 977) % 65536) / 65535);
  const png = await decodePng(await encodeDepthPng16(D, w, h, deflate), inflate);
  assert.equal(png.bitDepth, 16); assert.equal(png.colorType, 0);
  const r = depthFromPng(png);
  assert.equal(r.format, "png16"); assert.equal(r.bits, 16); assert.equal(r.mask, null);
  for (let i = 0; i < D.length; i++) assert.equal(Math.round(r.D[i] * 65535), Math.round(D[i] * 65535), `px ${i}`);
});

await test("decodes our png-rg16 writer: 16 bit from R+G, mask from B; without a mask B=0 → mask null", async () => {
  const w = 29, h = 17;
  const D = fill(w, h, (x, y) => ((x * 4099 + y * 337) % 65536) / 65535);
  const A = fill(w, h, (x) => (x > 14 ? 1 : x > 12 ? 0.5 : 0));
  const png = await decodePng(await encodeDepthRG16(D, A, w, h, deflate), inflate);
  const r = depthFromPng(png, { hint: "png-rg16" });
  assert.equal(r.format, "rg16"); assert.equal(r.bits, 16);
  for (let i = 0; i < D.length; i++) assert.equal(Math.round(r.D[i] * 65535), Math.round(D[i] * 65535));
  near(r.mask[20], 1, 1e-7); near(r.mask[13], 128 / 255, 1e-7); near(r.mask[0], 0, 1e-7);
  // no sidecar: the heuristic finds the packing (G = low byte is unrelated to R)
  assert.equal(detectDepthFormat(png), "rg16");
  const r2 = depthFromPng(await decodePng(await encodeDepthRG16(D, null, w, h, deflate), inflate));
  assert.equal(r2.format, "rg16"); assert.equal(r2.mask, null);
});

await test("plain 8-bit maps: grey PNG and grey stored as RGB both read as gray8 (white = near), invert works", async () => {
  const w = 16, h = 8;
  const M = fill(w, h, (x) => x / 15);
  const g = depthFromPng(await decodePng(await encodeGray8(M, w, h, deflate), inflate));
  assert.equal(g.format, "gray8"); assert.equal(g.bits, 8);
  near(g.D[15], 1, 1e-9); near(g.D[0], 0, 1e-9);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.fill(Math.round(M[i] * 255), 3 * i, 3 * i + 3);
  const p = await decodePng(pngBytes({ w, h, colorType: 2, bitDepth: 8, samples: rgb }), inflate);
  assert.equal(detectDepthFormat(p), "gray8");
  const inv = depthFromPng(p, { invert: true });
  near(inv.D[15], 0, 1e-9); near(inv.D[0], 1, 1e-9);
  // a sidecar hint "png16" on an RGB file never turns a grey picture into a packed one
  assert.equal(detectDepthFormat(p, "png16"), "gray8");
  // browser-decoded RGBA (WebP / JPEG path)
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba.fill(Math.round(M[i] * 255), 4 * i, 4 * i + 3); rgba[4 * i + 3] = 255; }
  const b = depthFromRGBA(rgba, w, h);
  assert.equal(b.bits, 8); near(b.D[15], 1, 1e-9);
});

await test("every filter type, RGBA 8, grey+alpha 16, RGB 16, palette, 1/2/4-bit grey, Adam7", async () => {
  const cases = [
    { colorType: 6, bitDepth: 8 }, { colorType: 4, bitDepth: 16 }, { colorType: 2, bitDepth: 16 }, { colorType: 0, bitDepth: 1 },
    { colorType: 0, bitDepth: 2 }, { colorType: 0, bitDepth: 4 }, { colorType: 3, bitDepth: 8 }, { colorType: 0, bitDepth: 16, interlace: 1 },
    { colorType: 2, bitDepth: 8, interlace: 1 }
  ];
  for (const c of cases) {
    const w = 13, h = 11, ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[c.colorType];
    const max = (1 << c.bitDepth) - 1;
    const samples = Array.from({ length: w * h * ch }, () => Math.floor(rnd() * (c.colorType === 3 ? 4 : max + 1)));
    const palette = c.colorType === 3 ? new Uint8Array([0, 0, 0, 255, 255, 255, 30, 60, 90, 9, 9, 9]) : null;
    const png = await decodePng(pngBytes({ w, h, ...c, samples, palette }), inflate);
    assert.deepEqual([...png.data], samples, JSON.stringify(c));
  }
  // palette → mean of the palette colour
  const pal = depthFromPng(await decodePng(pngBytes({ w: 2, h: 1, colorType: 3, bitDepth: 8, samples: [1, 2], palette: new Uint8Array([0, 0, 0, 255, 255, 255, 30, 60, 90]) }), inflate));
  near(pal.D[0], 1, 1e-9); near(pal.D[1], 60 / 255, 1e-9);
  // 16-bit RGB reads at full precision
  const r16 = depthFromPng(await decodePng(pngBytes({ w: 1, h: 1, colorType: 2, bitDepth: 16, samples: [1000, 2000, 3000] }), inflate));
  assert.equal(r16.bits, 16); near(r16.D[0], 2000 / 65535, 1e-9);
});

await test("decodePng refuses junk: not a PNG, truncated data, bad filter", async () => {
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), inflate), /Not a PNG/);
  assert.equal(isPng(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])), true);
  const good = pngBytes({ w: 4, h: 4, colorType: 0, bitDepth: 8, samples: new Array(16).fill(7) });
  await assert.rejects(decodePng(good.subarray(0, 40), inflate));
  const bad = pngBytes({ w: 4, h: 4, colorType: 0, bitDepth: 8, samples: new Array(16).fill(7), filter: () => 9 });
  await assert.rejects(decodePng(bad, inflate), /bad filter/);
});

// ---------- crops ----------

await test("crops: top-square of the 941×1672 reference, arrays and fractions clamp, cropMap copies the rectangle", () => {
  assert.deepEqual(resolveCrop("top-square", 941, 1672), [0, 0, 941, 941]);
  assert.deepEqual(resolveCrop("center-square", 941, 1672), [0, 365, 941, 941]);
  assert.deepEqual(resolveCrop([-5, 10, 5000, 20], 100, 50), [0, 10, 100, 20]);
  assert.deepEqual(resolveCrop({ x: 0.5, y: 0, w: 0.5, h: 1 }, 200, 100), [100, 0, 100, 100]);
  assert.equal(resolveCrop(null, 10, 10), null);
  assert.equal(resolveCrop([NaN, 0, 1, 1], 10, 10), null);
  const M = fill(5, 4, (x, y) => y * 10 + x);
  assert.deepEqual([...cropMap(M, 5, 4, [1, 2, 3, 2])], [21, 22, 23, 31, 32, 33]);
  const d = downscaleMap(fill(4, 2, (x) => x), 4, 2, 2);
  assert.deepEqual([d.w, d.h, ...d.M], [2, 1, 0.5, 2.5]);
});

// ---------- conditioning ----------

await test("rank filters and foreground dilation: the near side grows over a step, smooth relief stays", () => {
  const w = 20, h = 3;
  const step = fill(w, h, (x) => (x >= 10 ? 0.9 : 0.1));
  const dil = dilateForeground(step, w, h, 2, 0.06);
  assert.equal(dil[1 * w + 8], Math.fround(0.9)); assert.equal(dil[1 * w + 7], Math.fround(0.1));
  assert.deepEqual([...rankFilter(step, w, h, 1, "min")].slice(w + 9, w + 12), [0.1, 0.1, 0.9].map(Math.fround));
  const ramp = fill(w, h, (x) => 0.3 + x * 0.01); // 0.02 per 2 px < threshold
  assert.deepEqual([...dilateForeground(ramp, w, h, 2, 0.06)], [...ramp]);
  assert.deepEqual([...dilateForeground(step, w, h, 0)], [...step]);
});

await test("conditionDepth: normalised R, blurred G, mask B (1 without one), background A ≤ R; 8-bit terraces smoothed", () => {
  const w = 64, h = 64;
  // an 8-bit map spanning 0.2..0.6 with a figure step
  const raw = fill(w, h, (x, y) => Math.round((0.2 + 0.4 * (Math.hypot(x - 40, y - 32) < 14 ? 1 - Math.hypot(x - 40, y - 32) / 40 : 0.1 * y / h)) * 255) / 255);
  const c = conditionDepth({ D: raw, mask: null, w, h, bits: 8, format: "gray8" }, { dilatePx: 0 });
  assert.equal(c.rgba.length, w * h * 4);
  let mx = -1, mn = 2, distinctRaw = new Set(raw), distinct = new Set();
  for (let i = 0; i < w * h; i++) {
    const r = c.rgba[4 * i], a = c.rgba[4 * i + 3];
    mx = Math.max(mx, r); mn = Math.min(mn, r);
    assert.equal(c.rgba[4 * i + 2], 1);
    assert.ok(a <= r + 1e-7, `A ${a} > R ${r}`);
    distinct.add(Math.round(r * 1e5));
  }
  near(mx, 1, 0.02); near(mn, 0, 0.02);
  assert.ok(c.info.dequantized);
  assert.ok(distinct.size > distinctRaw.size * 2, `de-quantised levels ${distinct.size} vs ${distinctRaw.size}`);
  // 16-bit maps are not de-quantised; a mask lands in B
  const m = fill(w, h, (x) => (x > 30 ? 1 : 0));
  const c16 = conditionDepth({ D: fill(w, h, (x) => x / w), mask: m, w, h, bits: 16, format: "png16" }, { dilatePx: 0, normalBlurPx: 0 });
  assert.ok(!c16.info.dequantized); assert.ok(c16.info.hasMask);
  assert.equal(c16.rgba[4 * 40 + 2], 1); assert.equal(c16.rgba[4 * 2 + 2], 0);
  assert.equal(c16.rgba[4 * 10], c16.rgba[4 * 10 + 1], "normalBlur 0 = G equals R");
  // flat map: no crash, values kept in 0..1
  const flat = conditionDepth({ D: new Float32Array(w * h).fill(0.5), mask: null, w, h, bits: 8 });
  assert.ok(flat.info.flat);
});

await test("condition(): gamma then contrast, monotonic, ends pinned with contrast 1", () => {
  near(condition(0, 0.8, 1), 0); near(condition(1, 0.8, 1), 1);
  near(condition(0.5, 1, 2), 0.5); near(condition(0.75, 1, 2), 1); near(condition(0.25, 1, 2), 0);
  assert.ok(condition(0.5, 0.7, 1) > 0.5, "gamma < 1 lifts the mid range (the face)");
  let prev = -1;
  for (let i = 0; i <= 100; i++) { const v = condition(i / 100, 0.8, 1.3); assert.ok(v >= prev); prev = v; }
});

// ---------- shader maths ----------

await test("offset limits: unit disc, pixel circle on non-square images, strength scaling", () => {
  assert.deepEqual(clampLook(0.5, 0), { x: 0.5, y: 0 });
  const c = clampLook(1, 1); near(Math.hypot(c.x, c.y), 1, 1e-12);
  const w = 941, h = 1672;
  const o = offsetFor({ x: 1, y: 1 }, 1, w, h);
  near(Math.hypot(o.x * w, o.y * h), MAX_SHIFT * 941, 1e-6, "diagonal shift in px = straight shift");
  const half = offsetFor({ x: 1, y: 0 }, 0.5, 512, 512);
  near(half.x * 512, 0.5 * MAX_SHIFT * 512, 1e-9);
  assert.deepEqual(offsetFor({ x: 1, y: 0 }, 0, 512, 512), { x: 0, y: 0 });
  near(offsetFor({ x: 1, y: 0 }, 7, 512, 512).x, MAX_SHIFT, 1e-12, "strength clamps to 1");
});

await test("overscan covers every displacement, so samples never leave the image", () => {
  for (const [w, h] of [[512, 512], [941, 1672], [1920, 600]]) for (const strength of [0.2, 0.5, 1]) for (const focus of [0, 0.45, 1]) {
    const m = overscanFor(strength, focus, w, h);
    for (let a = 0; a < 64; a++) {
      const o = offsetFor({ x: Math.cos(a / 10), y: Math.sin(a / 10) }, strength, w, h);
      for (const hh of [0, 0.5, 1]) {
        assert.ok(Math.abs(o.x * (hh - focus)) <= m.x + 1e-12 && Math.abs(o.y * (hh - focus)) <= m.y + 1e-12, `${w}x${h} s${strength} f${focus}`);
      }
    }
  }
});

await test("step count: about one step per 1.5 texels of travel, clamped 8..64", () => {
  assert.equal(stepsFor({ x: 0, y: 0 }, 512, 512), 8);
  const o = offsetFor({ x: 1, y: 0 }, 0.5, 512, 512); // 15.4 px
  assert.equal(stepsFor(o, 512, 512), Math.ceil(0.5 * MAX_SHIFT * 512 / 1.5) + 6);
  assert.equal(stepsFor({ x: 0.5, y: 0 }, 4096, 4096), 64);
});

await test("normals: flat = up, slope tilts away from the rising side, always unit length", () => {
  assert.deepEqual(normalFromGradient(0, 0, 10).map((v) => v + 0), [0, 0, 1]);
  const n = normalFromGradient(0.05, 0, 10); // height rises to the right → faces left
  assert.ok(n[0] < 0 && n[2] > 0); near(Math.hypot(...n), 1, 1e-12);
  const m = normalFromGradient(0, -0.1, 10); // rises upwards (y down) → faces down
  assert.ok(m[1] > 0);
});

await test("stretch factor: a hole opens on the side the near layer moves away from, folds on the other", () => {
  const off = { x: 0.03, y: 0 }; // near moves +x
  const rising = { x: 0.5 / (1 / 512), y: 0 }; // 1-texel step up to the right
  assert.ok(stretchFactor(off, rising) > 3.5, "behind the edge: big stretch");
  assert.equal(holeWeight(stretchFactor(off, rising)), 1);
  assert.equal(stretchFactor(off, { x: -rising.x, y: 0 }), 0, "covered side folds");
  assert.equal(stretchFactor(off, { x: 0, y: 0 }), 1);
  assert.equal(holeWeight(1.2), 0);
  const soft = { x: 0.5 / (12 / 512), y: 0 }; // the same step spread over 12 texels (soft 8-bit map)
  assert.ok(stretchFactor(off, soft) < 1.8, "a soft ramp only stretches mildly (rubber, no hole)");
});

/** Prototype fixed point: p = u − off·(H(p) − f), 10 iterations (index.html). */
function prototype(H, u, off, f) {
  const sample = (s) => { const n = H.length, x = Math.min(1, Math.max(0, s)) * (n - 1), i = Math.floor(x), t = x - i; return H[i] * (1 - t) + H[Math.min(n - 1, i + 1)] * t; };
  let p = u;
  for (let i = 0; i < 10; i++) p = u - off * (sample(p) - f);
  return p;
}

await test("ray search: near occludes far (no doubled contour), sample positions never run backwards; the prototype's fixed point does", () => {
  const n = 512;
  const H = Float32Array.from({ length: n }, (_, i) => (i >= 256 ? 0.95 : 0.05)); // figure right, background left
  for (const off of [0.06, -0.06, 0.02, -0.02]) {
    const steps = stepsFor({ x: off, y: 0 }, n, 1);
    let prev = -Infinity, back = 0;
    for (let k = 0; k < 600; k++) {
      const u = 0.15 + (0.7 * k) / 599;
      const r = marchRay(H, u, off, 0.45, steps);
      if (r.s < prev - 1e-6) back++;
      prev = r.s;
      // where the ray reaches the near layer it must show the near layer (occlusion order)
      const hn = u - off * (0.95 - 0.45);
      if (hn > 256 / 511 + 2 / 511) assert.ok(r.h > 0.9, `off ${off} u ${u}: near hidden (h ${r.h})`);
    }
    assert.equal(back, 0, `off ${off}: ${back} backward jumps (tearing)`);
  }
  // the prototype at a large offset: a non-monotonic map (content repeats = doubled edges / tearing)
  let prev = -Infinity, back = 0;
  for (let k = 0; k < 600; k++) { const u = 0.15 + (0.7 * k) / 599; const s = prototype(H, u, 0.06, 0.45); if (s < prev - 1e-6) back++; prev = s; }
  assert.ok(back > 0, "the fixed point jumps backwards at a hard edge");
});

await test("ray search does not step over a thin near feature (2 texels) at full strength", () => {
  const n = 512;
  const H = new Float32Array(n).fill(0.05);
  H[300] = H[301] = 1;
  const off = offsetFor({ x: 1, y: 0 }, 1, n, n).x;
  const steps = stepsFor({ x: off, y: 0 }, n, 1);
  let seen = 0;
  for (let k = 0; k < 2000; k++) { const r = marchRay(H, k / 1999, off, 0.45, steps); if (r.h > 0.6) seen++; }
  assert.ok(seen >= 2, `thin feature visible on ${seen} of 2000 samples`);
});

await test("easing is frame-rate independent; idle blend and sway stay in range", () => {
  near(easeToward(0, 1, 0.12, 0.12), 0.5, 1e-12);
  const a = easeToward(easeToward(0, 1, 0.05, 0.12), 1, 0.05, 0.12), b = easeToward(0, 1, 0.1, 0.12);
  near(a, b, 1e-12, "two 50 ms frames = one 100 ms frame");
  assert.equal(easeToward(0.3, 1, 0, 0.12), 0.3);
  assert.equal(idleBlend(1000, 0), 0); assert.equal(idleBlend(1499, 0), 0); assert.equal(idleBlend(3500, 0), 1);
  for (let t = 0; t < 60000; t += 777) { const s = swayAt(t, 1); assert.ok(Math.hypot(s.x, s.y) <= 1); }
  assert.deepEqual(swayAt(1234, 0), { x: 0, y: 0 });
});

await test("backing size caps DPR at 2 and the canvas at ~4.2 MP; contain fit", () => {
  assert.deepEqual(backingSize(800, 600, 3), { w: 1600, h: 1200, ratio: 2 });
  assert.deepEqual(backingSize(800, 600, 0), { w: 800, h: 600, ratio: 1 });
  const big = backingSize(2560, 1440, 2); assert.ok(big.w * big.h <= 4.2e6 + 5000);
  assert.deepEqual(containRect(200, 100, 1), { x: 0.25, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(containRect(100, 200, 1), { x: 0, y: 0.25, w: 1, h: 0.5 });
});

await test("view settings: defaults, clamping, idempotence, seeding from cfg.depth.parallax", () => {
  const d = viewDefaults();
  assert.deepEqual(normalizeView({}), d);
  const v = normalizeView({ strength: 5, gamma: "0.123", dilate: 2.6, focus: "x", on: { dust: true, light: "yes" }, view: "holes", junk: 1 });
  assert.equal(v.strength, 1); assert.equal(v.gamma, VIEW_RANGES.gamma[0]); assert.equal(v.dilate, 3); assert.equal(v.focus, d.focus);
  assert.equal(v.on.dust, true); assert.equal(v.on.light, d.on.light); assert.equal(v.view, "holes"); assert.equal(v.junk, undefined);
  assert.deepEqual(normalizeView(v), v);
  assert.equal(normalizeView({ view: "nope" }).view, "image");
  const s = viewFromTypeParallax({ strength: 0.7, sway: 0.1, light: false, rim: true, dust: true });
  assert.equal(s.strength, 0.7); assert.equal(s.sway, 0.1); assert.deepEqual([s.on.light, s.on.rim, s.on.dust], [false, true, true]);
  assert.deepEqual(viewFromTypeParallax(null), d);
});

await test("depth file name next to an image", () => {
  assert.equal(depthNameFor("worlds/x/a b.webp?v=2"), "a b_depth.png");
  assert.equal(depthNameFor(""), "");
});

// ---------- W6-T: decoder safety (bombs, header-first size checks, early downscale) ----------

/** A PNG with a hand-made header and an arbitrary (possibly huge-when-inflated) IDAT stream. */
function rawPng(w, h, bitDepth, colorType, idat) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); Buffer.from(data).copy(b, 8);
    b.writeUInt32BE((crc32(b.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0, 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bitDepth; ihdr[9] = colorType;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]));
}

await test("W6-T inflateZlib streams with a hard cap: a 1 GB deflate bomb (≈1 MB) stops at the cap, fast", async () => {
  // ~1 GB of zeros as a zlib stream built from 16 non-final 64 MB raw blocks (the test never holds 1 GB)
  const zero = Buffer.alloc(64 * 1024 * 1024);
  const block = deflateRawSync(zero, { level: 9, finishFlush: zlibConstants.Z_SYNC_FLUSH });
  const parts = [new Uint8Array([0x78, 0xda])];
  for (let i = 0; i < 16; i++) parts.push(new Uint8Array(block));
  const total = parts.reduce((s, p) => s + p.length, 0);
  assert.ok(total < 2_000_000, `compressed bomb ${total} bytes`);
  const t0 = performance.now();
  const out = await inflateZlib(parts, { maxBytes: 4096 });
  const ms = performance.now() - t0;
  assert.equal(out.length, 4096);
  assert.ok(out.every((x) => x === 0));
  assert.ok(ms < 1500, `stopped early (${Math.round(ms)} ms)`);
  // unbounded mode still returns everything for a normal stream; a short stream under the cap returns what is there
  assert.equal(Buffer.from(await inflateZlib(new Uint8Array(deflateSync(Buffer.from("hello hello hello"))))).toString(), "hello hello hello");
  assert.equal(Buffer.from(await inflateZlib(new Uint8Array(deflateSync(Buffer.from("abc"))), { maxBytes: 100 })).toString(), "abc");
});

await test("W6-T PNG bomb: 1×1 grey PNG whose IDAT inflates to 64 MB decodes from its first 2 bytes only", async () => {
  const png = rawPng(1, 1, 8, 0, deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 }));
  assert.ok(png.length < 200000);
  assert.equal(pngRawSize(pngInfo(png)), 2);
  const t0 = performance.now();
  const r = await decodePng(png);                         // default inflate = streamed, capped at 2 bytes
  assert.equal(r.w, 1); assert.equal(r.data.length, 1); assert.equal(r.data[0], 0);
  assert.ok(performance.now() - t0 < 1500);
  // an injected inflate is told the cap
  let asked = null;
  const spy = async (z, o) => { asked = o?.maxBytes; return new Uint8Array(inflateSync(z, { maxOutputLength: o.maxBytes })).subarray(0, o.maxBytes); };
  await decodePng(png, spy).catch(() => {});
  assert.equal(asked, 2);
});

await test("W6-T sizes are checked from the header BEFORE inflating: over-limit pixels / bytes refused, nothing inflated", async () => {
  let calls = 0;
  const spy = async (z) => { calls++; return new Uint8Array(inflateSync(z)); };
  const tiny = deflateSync(Buffer.alloc(10));
  const big = rawPng(8000, 8000, 16, 6, tiny);          // a legal 64 MP 16-bit RGBA header (≈ 512 MB of scanlines)
  await assert.rejects(decodePng(big, spy), (e) => e.code === "too-large");
  await assert.rejects(decodePng(big, spy, DEPTH_LIMITS.map), (e) => e.code === "too-large" && /MP/.test(e.message));
  // under the pixel cap but over the byte cap: 4000×4000 16-bit RGBA = 128 MB > 64 MB (map limits)
  await assert.rejects(decodePng(rawPng(4000, 4000, 16, 6, tiny), spy, DEPTH_LIMITS.map), (e) => e.code === "too-large" && /MB/.test(e.message));
  // within the window limits: reaches inflate, then fails cleanly on the (short) data
  await assert.rejects(decodePng(rawPng(4000, 4000, 16, 6, tiny), spy, DEPTH_LIMITS.window), /too short/);
  assert.equal(calls, 1, "only the in-limit file reached inflate");
  await assert.rejects(prepareDepth(big, { inflate: spy }), (e) => e.code === "too-large");
  await assert.rejects(prepareDepth(new Uint8Array(65 * 1024 * 1024), {}), (e) => e.code === "too-large" && /file/.test(e.message));
  assert.equal(calls, 1);
  assert.ok(DEPTH_LIMITS.map.maxPixels <= 4096 * 4096 && DEPTH_LIMITS.map.maxRawBytes <= 64 * 1024 * 1024);
  assert.ok(DEPTH_LIMITS.window.maxPixels < 64e6);
});

await test("W6-T non-PNG maps: header size read without decoding; over-limit refused before the browser decoder runs", async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x13, 0x88, 0x0b, 0xb8, 3, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { w: 3000, h: 5000, type: "jpeg" });
  const webp = (kind, set) => { const b = new Uint8Array(30); b.set([82, 73, 70, 70], 0); b.set([87, 69, 66, 80], 8); b.set([...kind].map((c) => c.charCodeAt(0)), 12); for (const [i, v] of set) b[i] = v; return b; };
  assert.deepEqual(imageSize(webp("VP8X", [[24, 0xff], [25, 0x0f], [27, 0x3f], [28, 0x06]])), { w: 4096, h: 1600, type: "webp" });
  assert.deepEqual(imageSize(webp("VP8 ", [[26, 0x00], [27, 0x04], [28, 0x00], [29, 0x03]])), { w: 1024, h: 768, type: "webp" });
  const v = 1023 | (511 << 14);
  assert.deepEqual(imageSize(webp("VP8L", [[21, v & 255], [22, (v >> 8) & 255], [23, (v >> 16) & 255], [24, (v >>> 24) & 255]])), { w: 1024, h: 512, type: "webp" });
  assert.deepEqual(imageSize(new Uint8Array([71, 73, 70, 56, 57, 97, 0x20, 0x03, 0x58, 0x02, 0])), { w: 800, h: 600, type: "gif" });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
  let raster = 0;
  const fake = async (b, type, o) => {
    raster++;
    const k = o.maxSide && o.w ? o.maxSide / Math.max(o.w, o.h) : 1, w = Math.round((o.w || 4) * Math.min(1, k)), h = Math.round((o.h || 4) * Math.min(1, k));
    return { rgba: new Uint8Array(w * h * 4).fill(128), w, h };
  };
  const huge = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0x4e, 0x20, 0x4e, 0x20, 3, 0, 0, 0, 0]); // 20000×20000
  await assert.rejects(prepareDepth(huge, { rasterize: fake }), (e) => e.code === "too-large");
  assert.equal(raster, 0, "the decoder never ran");
  const ok = await prepareDepth(jpg, { rasterize: fake, maxSide: 1024 });
  assert.equal(raster, 1);
  assert.ok(Math.max(ok.w, ok.h) <= 1024, `decoded straight to ≤ 1024: ${ok.w}×${ok.h}`);
});

await test("W6-T early downscale: depthFromPng factor = box downscale of the full map; prepareDepth ≤ maxSide + conditioned half floats", async () => {
  const w = 41, h = 30;
  const D = fill(w, h, (x, y) => ((x * 37 + y * 101) % 997) / 996);
  const png = await decodePng(await encodeDepthPng16(D, w, h, deflate), inflate);
  const full = depthFromPng(png);
  for (const f of [2, 3, 4]) {
    const a = depthFromPng(png, { factor: f }), b = downscaleMap(full.D, w, h, f);
    assert.equal(a.w, b.w); assert.equal(a.h, b.h);
    for (let i = 0; i < a.D.length; i++) near(a.D[i], b.M[i], 1e-6);
  }
  const A = fill(w, h, (x) => (x < 20 ? 1 : 0));
  const rg = depthFromPng(await decodePng(await encodeDepthRG16(D, A, w, h, deflate), inflate), { factor: 2 });
  assert.ok(rg.mask && rg.mask.length === rg.w * rg.h, "rg16 mask kept through the factor");
  near(rg.mask[0], 1); near(rg.mask[rg.w - 1], 0);
  assert.equal(boxFactorFor(941, 1672, 1024), 2);
  assert.equal(boxFactorFor(1000, 800, 1024), 1);
  const big = fill(300, 200, (x, y) => (x + y) / 500);
  const bytes = await encodeDepthPng16(big, 300, 200, deflate);
  const r = await prepareDepth(bytes, { maxSide: 128, condition: { dilatePx: 2, normalBlurPx: 3 }, half: true });
  assert.ok(Math.max(r.w, r.h) <= 128, `${r.w}×${r.h}`);
  assert.equal(r.D, null);
  assert.ok(r.cond.half instanceof Uint16Array && r.cond.half.length === r.w * r.h * 4);
  const plain = await prepareDepth(bytes, { maxSide: 128, condition: { dilatePx: 2, normalBlurPx: 3 } });
  for (let i = 0; i < plain.cond.rgba.length; i += 97) near(halfToFloat(r.cond.half[i]), plain.cond.rgba[i], 1e-3);
});

await test("W6-T half floats and cache-busting revisions", () => {
  const xs = new Float32Array([0, 1, 0.5, 0.333333, 1e-5, 1e-8, 65504, 1e6, -2.5, 0.0001234]);
  const h = toHalf(xs);
  near(halfToFloat(h[0]), 0); near(halfToFloat(h[1]), 1); near(halfToFloat(h[2]), 0.5);
  near(halfToFloat(h[3]), 0.333333, 2e-4); near(halfToFloat(h[4]), 1e-5, 1e-7); near(halfToFloat(h[5]), 0, 1e-7);
  near(halfToFloat(h[6]), 65504); assert.equal(halfToFloat(h[7]), Infinity); near(halfToFloat(h[8]), -2.5); near(halfToFloat(h[9]), 0.0001234, 1e-6);
  for (let i = 0; i <= 1000; i++) near(halfToFloat(toHalf(new Float32Array([i / 1000]))[0]), i / 1000, 5e-4);
  assert.equal(withRev("/worlds/a/b_depth.png", 1731), "/worlds/a/b_depth.png?v=1731");
  assert.equal(withRev("/x.png?raw=1#f", "a b"), "/x.png?raw=1&v=a%20b#f");
  assert.equal(withRev("/x.png", null), "/x.png");
  assert.equal(withRev("/x.png", ""), "/x.png");
  assert.equal(withRev("data:image/png;base64,AA", 3), "data:image/png;base64,AA");
});

await test("W6-T wiring: loaders go through the worker with limits; the window keeps bigger ones; rev + encoded paths", () => {
  const load = readFileSync(new URL("../scripts/parallax/parallax-load.mjs", import.meta.url), "utf8");
  assert.ok(load.includes('new Worker(new URL("./parallax-worker.mjs", import.meta.url), { type: "module"'));
  assert.ok(load.includes("return prepareDepth(bytes, opts);"), "main-thread fallback = the same pipeline");
  assert.ok(load.includes("depthIndexModule.encodeDataPath"));
  assert.ok(load.includes("withRev(p, rev)"));
  const app = readFileSync(new URL("../scripts/parallax/parallax-app.mjs", import.meta.url), "utf8");
  assert.ok(app.includes('loadDepth({ ...m, limits: "window" })'));
  const worker = readFileSync(new URL("../scripts/parallax/parallax-worker.mjs", import.meta.url), "utf8");
  assert.ok(worker.includes('import { prepareDepth } from "./parallax-core.mjs";'));
  assert.doesNotMatch(worker, /fetch\(|foundry\.|game\./);
  // the worker's import graph stays free of Foundry / DOM modules
  for (const f of ["../scripts/parallax/parallax-core.mjs", "../scripts/depth/post.mjs", "../scripts/constants.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/^import .* from "(.+)";/gm)) assert.ok(["../depth/post.mjs", "../constants.mjs"].includes(m[1]), `${f} imports ${m[1]}`);
  }
});

await test("shader mirrors the tested maths; the parallax code makes no network calls of its own", () => {
  const gl = readFileSync(new URL("../scripts/parallax/parallax-gl.mjs", import.meta.url), "utf8");
  assert.match(gl, /float g = pow\(clamp\(d, 0\.0, 1\.0\), uGamma\); return clamp\(\(g - 0\.5\) \* uContrast \+ 0\.5, 0\.0, 1\.0\)/, "cond = condition()");
  assert.match(gl, /float stretch = 1\.0 \+ dot\(uOff, grad\);/, "stretch = stretchFactor()");
  assert.match(gl, /smoothstep\(1\.6, 3\.5, stretch\)/, "hole weight = holeWeight()");
  assert.match(gl, /vec2 at\(vec2 uv, float h\)\{ return uv - uOff \* \(h - uFocus\); \}/, "ray = marchRay()");
  const dir = new URL("../scripts/parallax/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /https?:\/\//, `${f} names a host`);
    assert.doesNotMatch(src, /XMLHttpRequest|WebSocket|sendBeacon/, `${f}`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
