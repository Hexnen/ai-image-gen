// W6-I: local depth in the GM's browser with the vendored transformers.js 4.3.2 (vendor/transformers/). The library and
// the ONNX runtime (JS + WASM) are served from this module; the only remote requests are the model files from
// huggingface.co (first use; the browser keeps them in Cache Storage "transformers-cache"). No generation API, no key.
import { MODULE_ID } from "../constants.mjs";
import { HF_HOST, fileUrl } from "./plan.mjs";

const VENDOR = `modules/${MODULE_ID}/vendor/transformers/`;
const vendorUrl = (f) => new URL(foundry.utils.getRoute(`${VENDOR}${f}`), window.location.href).href;

let libPromise = null;
/** Load the vendored library once and pin it to local runtime files + the Hugging Face host. */
export function loadLib() {
  libPromise ??= import(vendorUrl("transformers.min.js")).then((T) => {
    const env = T.env;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = HF_HOST;
    env.useBrowserCache = true;
    // ONNX runtime WASM from this module, never the library's default jsDelivr URL
    env.backends.onnx.wasm.wasmPaths = { mjs: vendorUrl("ort-wasm-simd-threaded.asyncify.mjs"), wasm: vendorUrl("ort-wasm-simd-threaded.asyncify.wasm") };
    env.backends.onnx.wasm.proxy = false;
    return T;
  }).catch((e) => { libPromise = null; throw e; });
  return libPromise;
}

/** WebGPU in this browser: adapter, shader-f16, adapter info. Never throws. */
export async function probeWebGPU() {
  const out = { ok: false, f16: false, reason: "", secure: !!globalThis.isSecureContext };
  try {
    if (!navigator.gpu) { out.reason = "no navigator.gpu"; return out; }
    const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!ad) { out.reason = "no adapter"; return out; }
    const info = ad.info ?? {};
    Object.assign(out, {
      ok: true, f16: ad.features.has("shader-f16"), vendor: info.vendor ?? "", architecture: info.architecture ?? "", description: info.description ?? "",
      // W6-I live: BiRefNet lite needs 17 storage buffers in one shader; an RTX 3070 Ti adapter allows 16 (ORT error, and the
      // failed run poisons the WebGPU runtime of the page until a reload). plan.mjs skips the mask below MASK_MIN_SB (WASM fp32 runs out of memory).
      maxStorageBuffers: ad.limits?.maxStorageBuffersPerShaderStage ?? 0
    });
  } catch (e) { out.reason = String(e?.message ?? e); }
  return out;
}

/** Is this model file already in the browser cache (no download needed)? */
export async function isCached(repo, dtype) {
  try {
    const c = await caches.open("transformers-cache");
    return !!(await c.match(fileUrl(repo, dtype)));
  } catch { return false; }
}

const loaded = new Map();
const keyOf = (s) => `${s.repo}|${s.device}|${s.dtype}`;

/** Load (or reuse) a pipeline. `onProgress({file, loaded, total})` during the download. @returns {{pipe, ms:number, cached:boolean}} */
async function getPipe(task, s, onProgress) {
  const k = `${task}|${keyOf(s)}`;
  if (loaded.has(k)) return { pipe: loaded.get(k), ms: 0, reused: true };
  const T = await loadLib();
  const t0 = performance.now();
  const pipe = await T.pipeline(task, s.repo, {
    device: s.device, dtype: s.dtype,
    progress_callback: (p) => { if (p?.status === "progress" && onProgress) onProgress({ file: p.file, loaded: p.loaded, total: p.total }); }
  });
  loaded.set(k, pipe);
  return { pipe, ms: performance.now() - t0, reused: false };
}

/** ORT errors after which no other session of this page works until a reload (measured on lane 8, 2026-11-18). */
export const runtimeBroken = (e) => /bad_alloc|Too many storage buffers|Device (is )?lost|out of memory/i.test(String(e?.message ?? e));

/** Free the GPU / WASM memory of every loaded model. */
export async function releaseAll() {
  for (const p of loaded.values()) { try { await p.dispose?.(); } catch { /* ignore */ } }
  loaded.clear();
}

async function dropPipe(task, s) {
  const k = `${task}|${keyOf(s)}`;
  const p = loaded.get(k);
  loaded.delete(k);
  try { await p?.dispose?.(); } catch { /* ignore */ }
}

/** RGB RawImage from RGBA bytes. */
async function rawImage(rgba, w, h) {
  const T = await loadLib();
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) { rgb[i * 3] = rgba[j]; rgb[i * 3 + 1] = rgba[j + 1]; rgb[i * 3 + 2] = rgba[j + 2]; }
  return new T.RawImage(rgb, w, h, 3);
}

/**
 * Depth with the plan's primary step, then its fallbacks on failure (out of memory, missing WebGPU feature).
 * @returns {Promise<{D:Float32Array, step:object, loadMs:number, inferMs:number, reused:boolean, errors:string[]}>}
 */
export async function estimateDepth(plan, img, { onProgress, onStep, confirmStep } = {}) {
  const errors = [];
  const image = await rawImage(img.rgba, img.w, img.h);
  for (const [i, s] of [plan.primary, ...plan.fallbacks].entries()) {
    try {
      // a fallback model that is not cached yet is a new download: the GM is asked again (never silent)
      if (i > 0 && !(await isCached(s.repo, s.dtype)) && !(await confirmStep?.(s))) { errors.push(`${s.label} (${s.device}, ${s.dtype}): download declined`); break; }
      onStep?.(s);
      const { pipe, ms, reused } = await getPipe("depth-estimation", s, onProgress);
      const ip = pipe.processor?.image_processor;
      if (ip && s.resolution && s.resolution !== 518) ip.size = { height: s.resolution, width: s.resolution };
      const t0 = performance.now();
      const out = await pipe(image);
      const inferMs = performance.now() - t0;
      const pd = out.predicted_depth;
      const [h, w] = pd.dims.slice(-2);
      if (w !== img.w || h !== img.h) throw new Error(`depth size ${w}×${h} ≠ image ${img.w}×${img.h}`);
      return { D: Float32Array.from(pd.data), step: s, loadMs: ms, inferMs, reused, errors };
    } catch (e) {
      console.warn(`${MODULE_ID} | depth ${s.repo} ${s.device}/${s.dtype} failed`, e);
      errors.push(`${s.label} (${s.device}, ${s.dtype}): ${e?.message ?? e}`);
      // W6-I live: after these the page's ONNX runtime is broken for every model (sticky WebGPU error, exhausted WASM
      // heap): trying the fallbacks only downloads more. Free what we hold and ask for a page reload.
      if (runtimeBroken(e)) {
        await releaseAll();
        throw Object.assign(new Error(errors.join(" · ")), { errors, code: "runtimeBroken" });
      }
    }
  }
  throw Object.assign(new Error(errors.join(" · ") || "No depth model could run."), { errors });
}

/**
 * Figure mask (BiRefNet lite through the background-removal pipeline). Never throws: on failure the run goes on
 * without a mask and `error` says why. @returns {Promise<{A:Float32Array|null, loadMs?:number, inferMs?:number, error?:string}>}
 */
export async function figureMask(step, img, { onProgress } = {}) {
  if (!step) return { A: null };
  try {
    const { pipe, ms } = await getPipe("background-removal", step, onProgress);
    const t0 = performance.now();
    const out = await pipe(await rawImage(img.rgba, img.w, img.h));
    const inferMs = performance.now() - t0;
    // the mask session is the big one (BiRefNet at a fixed 1024²): free it after each run so the next depth run has the memory
    await dropPipe("background-removal", step);
    const res = Array.isArray(out) ? out[0] : out;
    if (!res || res.width !== img.w || res.height !== img.h || res.channels !== 4) throw new Error(`unexpected mask output ${res?.width}×${res?.height}×${res?.channels}`);
    const A = new Float32Array(img.w * img.h);
    for (let i = 0; i < A.length; i++) A[i] = res.data[i * 4 + 3] / 255;
    return { A, loadMs: ms, inferMs };
  } catch (e) {
    console.warn(`${MODULE_ID} | figure mask failed, continuing without it`, e);
    await dropPipe("background-removal", step);
    return { A: null, error: String(e?.message ?? e) };
  }
}
