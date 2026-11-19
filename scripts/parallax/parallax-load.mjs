// W6-L: loading for the parallax window (browser): the portrait as an ImageBitmap, depth maps in every format we meet:
// - the module's own `<name>_depth.png`: 16-bit grey (png16) or 8-bit RGB with 16 bit in R+G and the mask in B
//   (png-rg16), decoded by our own PNG reader (a canvas would cut 16 bit to 8); the `_depth.json` sidecar names the
//   encoding when it exists, otherwise parallax-core detects it;
// - plain 8-bit grey maps (Flare / reference maps, PNG / WebP / JPEG; white = near) through the browser's decoder.
// W6-T: decoding (and for sheet portraits also the conditioning) runs in a module worker (parallax-worker.mjs) with
// size limits checked from the file header first (parallax-core DEPTH_LIMITS); without a worker the same pipeline runs
// here. Fetch URLs get the depth index revision (`?v=<rev>`) and encoded path segments (depth-index `encodeDataPath`,
// when that helper exists).
import { isPng, prepareDepth, withRev, DEPTH_LIMITS, tooLarge, imageSize, resolveCrop } from "./parallax-core.mjs";
import * as depthIndexModule from "../depth/depth-index.mjs";

/** Data path / URL -> fetch URL (route prefix, encoded segments when depth-index offers `encodeDataPath`, `?v=rev`). */
export function fetchUrl(path, rev = null) {
  let p = String(path ?? "");
  if (!/^(https?:|data:|blob:)/i.test(p)) {
    p = p.replace(/^\/+/, "");
    const enc = depthIndexModule.encodeDataPath;
    if (typeof enc === "function") { try { p = enc(p) || p; } catch { /* keep the raw path */ } }
    p = foundry.utils.getRoute(p);
  }
  return withRev(p, rev);
}

async function fetchBytes(path, { rev = null, maxBytes = Infinity } = {}) {
  const res = await fetch(fetchUrl(path, rev));
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status });
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) {
    try { await res.body?.cancel(); } catch { /* gone */ }
    throw tooLarge(`${path}: ${Math.round(len / 1048576)} MB is over the limit of ${Math.round(maxBytes / 1048576)} MB.`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw tooLarge(`${path}: ${Math.round(bytes.length / 1048576)} MB is over the limit of ${Math.round(maxBytes / 1048576)} MB.`);
  return { bytes, type: res.headers.get("content-type") ?? "" };
}

/** Portrait images: decoded by the browser like an <img>; refuse absurd sizes before decoding (100 MP). */
const PORTRAIT_MAX_PIXELS = 100e6;
const PORTRAIT_MAX_BYTES = 128 * 1048576;

/**
 * Portrait → {bitmap, w, h}. `crop` as in resolveCrop (pixels / fractions / "top-square").
 * W6-Q: `colorManaged` = decode like an <img> does (embedded ICC profile / gAMA converted to sRGB); without it the raw
 * bytes are used (a Display-P3 or Adobe-RGB picture then looks washed out next to the same <img>). Sheet portraits use
 * it; the W6-L window keeps its old decoding. W6-T: `rev` = cache-busting revision; when the header says the picture is
 * bigger than `maxSide`, it is decoded straight to the smaller size.
 */
export async function loadPortrait(path, { crop = null, maxSide = 0, colorManaged = false, rev = null } = {}) {
  const { bytes, type } = await fetchBytes(path, { rev, maxBytes: PORTRAIT_MAX_BYTES });
  const sz = imageSize(bytes);
  if (sz && sz.w * sz.h > PORTRAIT_MAX_PIXELS) throw tooLarge(`${path}: ${sz.w}×${sz.h} is over the limit of 100 MP.`);
  const blob = new Blob([bytes], { type: type || "image/png" });
  const csc = colorManaged ? "default" : "none";
  const natural = sz ? { w: sz.w, h: sz.h } : null;
  let bmp;
  if (!crop && sz && maxSide > 0 && Math.max(sz.w, sz.h) > maxSide) {
    const k = maxSide / Math.max(sz.w, sz.h);
    bmp = await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(sz.w * k)), resizeHeight: Math.max(1, Math.round(sz.h * k)), resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: csc });
    return { bitmap: bmp, w: bmp.width, h: bmp.height, natural };
  }
  bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: csc });
  const nat = natural ?? { w: bmp.width, h: bmp.height };
  const rect = resolveCrop(crop, bmp.width, bmp.height);
  if (rect) {
    const full = bmp;
    bmp = await createImageBitmap(full, rect[0], rect[1], rect[2], rect[3], { premultiplyAlpha: "none", colorSpaceConversion: csc });
    full.close?.();
  }
  // W6-N: a sheet portrait shown at ~200 px does not need a 2048 px texture
  if (maxSide > 0 && Math.max(bmp.width, bmp.height) > maxSide) {
    const k = maxSide / Math.max(bmp.width, bmp.height);
    const full = bmp;
    bmp = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: csc });
    full.close?.();
  }
  return { bitmap: bmp, w: bmp.width, h: bmp.height, natural: nat };
}

/** The `_depth.json` sidecar of a module depth file, or null (missing / not ours / unreadable). */
async function sidecarOf(path, rev) {
  if (!/_depth\.png$/i.test(String(path).split(/[?#]/)[0])) return null;
  try {
    const { bytes } = await fetchBytes(String(path).split(/[?#]/)[0].replace(/_depth\.png$/i, "_depth.json"), { rev, maxBytes: 1048576 });
    const meta = JSON.parse(new TextDecoder().decode(bytes));
    return meta && typeof meta === "object" ? meta : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ the depth worker (one, shared, ended when idle)

let worker = null;
let workerState = "none";      // none | starting | ready | broken
let workerSeq = 0;
let workerIdle = 0;
const pending = new Map();
const WORKER_IDLE_MS = 30000;
export const workerStats = { jobs: 0, fallbacks: 0, lastMs: null, state: () => workerState };

function failAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker() {
  if (workerState === "broken" || typeof Worker !== "function") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./parallax-worker.mjs", import.meta.url), { type: "module", name: "aiimg-depth" });
  } catch (e) {
    console.warn("moinens-ai-gen | depth worker unavailable, decoding on the main thread", e);
    workerState = "broken";
    return null;
  }
  workerState = "starting";
  worker.onmessage = (ev) => {
    const { id, ok, r, error, code } = ev.data ?? {};
    workerState = "ready";
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(r); else p.reject(Object.assign(new Error(error), code ? { code } : {}));
    armIdle();
  };
  worker.onerror = (ev) => {
    // a module that failed to load / a crash: every job in flight goes to the main-thread fallback
    console.warn("moinens-ai-gen | depth worker failed, decoding on the main thread", ev?.message ?? ev);
    ev?.preventDefault?.();
    workerState = "broken";
    try { worker.terminate(); } catch { /* gone */ }
    worker = null;
    failAll(Object.assign(new Error("worker failed"), { workerFailed: true }));
  };
  return worker;
}

function armIdle() {
  clearTimeout(workerIdle);
  workerIdle = setTimeout(() => {
    if (pending.size || !worker) return;
    worker.terminate();
    worker = null;
    if (workerState !== "broken") workerState = "none";
  }, WORKER_IDLE_MS);
}

/** Run prepareDepth in the worker (bytes transferred once the worker is known to work), else here. */
async function runPrepare(bytes, opts) {
  workerStats.jobs++;
  const w = getWorker();
  if (w) {
    clearTimeout(workerIdle);
    // until the worker answered once, send a copy: if it fails to start, the bytes are still here for the fallback
    const send = workerState === "ready" ? bytes : bytes.slice();
    try {
      const r = await new Promise((resolve, reject) => {
        const id = ++workerSeq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, bytes: send.buffer, opts }, [send.buffer]);
      });
      workerStats.lastMs = r.ms ?? null;
      return r;
    } catch (e) {
      if (!e?.workerFailed || bytes.byteLength === 0) throw e;
    }
  }
  workerStats.fallbacks++;
  // fallback: same pipeline on the main thread (one yield first so the caller's frame can finish)
  await new Promise((r) => setTimeout(r, 0));
  return prepareDepth(bytes, opts);
}

/**
 * Depth map → {D, mask, w, h, bits, format, meta, path, bytes}. `spec` = {path, crop?, invert?, format?, sidecar?, rev?,
 * limits?} (format forces "png16" | "png-rg16" | "gray8"; limits = "map" (default: portraits, tokens, api) or "window"
 * (the W6-L comparison window: bigger reference maps)). Maps larger than 2048 px are box-downscaled ×2.
 * W6-N: `sidecar: false` skips the `_depth.json` request (the depth index knows it does not exist: no 404).
 */
export async function loadDepth(spec) {
  const { path, crop = null, invert = false, format = null, sidecar = true, rev = null, limits = "map" } = spec;
  const L = typeof limits === "object" && limits ? limits : DEPTH_LIMITS[limits] ?? DEPTH_LIMITS.map;
  const { bytes, type } = await fetchBytes(path, { rev, maxBytes: L.maxFileBytes });
  const png = isPng(bytes);
  const meta = png && sidecar !== false ? await sidecarOf(path, rev) : null;
  const n = bytes.length;
  const src = await runPrepare(bytes, {
    type, hint: format ?? meta?.encoding?.format ?? null, invert: invert || (png && meta?.near === "dark"), crop, limits: L
  });
  return { ...src, meta, path, bytes: n };
}

/**
 * W6-T (sheet portraits): depth map → conditioned shader map, all in the worker: {cond: {half | rgba, w, h, info}, w, h,
 * bits, format, meta, path, bytes, ms}. `maxSide` = longest side after the box downscale (the depth is smooth: ~1024
 * is plenty for a sheet portrait); `condition` = conditionDepth options; `half` = Uint16 half floats (RGBA16F upload).
 */
export async function loadDepthConditioned(spec, { maxSide = 1024, condition = {}, half = true } = {}) {
  const { path, crop = null, invert = false, format = null, sidecar = true, rev = null, limits = "map" } = spec;
  const L = typeof limits === "object" && limits ? limits : DEPTH_LIMITS[limits] ?? DEPTH_LIMITS.map;
  const t0 = performance.now();
  const { bytes, type } = await fetchBytes(path, { rev, maxBytes: L.maxFileBytes });
  const tFetch = performance.now() - t0;
  const png = isPng(bytes);
  const meta = png && sidecar !== false ? await sidecarOf(path, rev) : null;
  const n = bytes.length;
  const r = await runPrepare(bytes, {
    type, hint: format ?? meta?.encoding?.format ?? null, invert: invert || (png && meta?.near === "dark"), crop, limits: L,
    maxSide, condition: condition ?? {}, half
  });
  return { ...r, meta, path, bytes: n, fetchMs: Math.round(tFetch), totalMs: Math.round(performance.now() - t0) };
}

/** Does `path` exist on the server? Uses the file browser (socket) so no HTTP 404 noise; false on any error. */
export async function fileExists(path) {
  const clean = String(path ?? "").split(/[?#]/)[0].replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  if (slash < 0) return false;
  const dir = clean.slice(0, slash);
  try {
    const FP = foundry.applications.apps.FilePicker.implementation;
    const res = await FP.browse("data", dir);
    const want = decodeURIComponent(clean);
    return (res?.files ?? []).some((f) => decodeURIComponent(String(f).split(/[?#]/)[0]).replace(/^\/+/, "") === want);
  } catch { return false; }
}
