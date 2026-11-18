// W6-I: which model / device / precision a depth run uses (browser engine), and the Hugging Face files it needs.
// Pure (no Foundry, no DOM): tested in Node (dev/test-depth-post.mjs). Model ids and sizes come from depth-settings.mjs.
import { modelByKey, maskByKey } from "../depth-settings.mjs";

/** The only remote host the browser engine talks to (model files; the library and the ONNX runtime are vendored). */
export const HF_HOST = "https://huggingface.co/";

/** Repository that actually holds the ONNX files of a mask model (onnx-community/BiRefNet_lite redirects here). */
export const MASK_REPOS = Object.freeze({ "birefnet-lite": "onnx-community/BiRefNet_lite-ONNX" });
/** Mask sizes in MB per dtype (HF tree of BiRefNet_lite-ONNX, 2026-11-18: model.onnx 224.0, model_fp16.onnx 114.5). */
const MASK_SIZES = Object.freeze({ "birefnet-lite": { fp16: 114.5, fp32: 224 } });

/** Storage buffers per shader stage BiRefNet lite needs on WebGPU (measured 2026-11-18: ORT asked for 17). */
export const MASK_MIN_SB = 17;

/** ONNX file name of a dtype in an onnx-community repo (transformers.js naming). */
export const onnxFile = (dtype) => ({ fp32: "model.onnx", fp16: "model_fp16.onnx", q4f16: "model_q4f16.onnx", q8: "model_quantized.onnx" })[dtype] ?? "model.onnx";
export const fileUrl = (repo, dtype) => `${HF_HOST}${repo}/resolve/main/onnx/${onnxFile(dtype)}`;

/**
 * Plan of a browser run.
 * @param {object} depth  normalised cfg.depth
 * @param {{ok:boolean, f16?:boolean}} gpu  WebGPU probe
 * @returns {{error?:string, primary?:object, fallbacks:object[], mask:object|null, notes:string[]}}
 *   a step = {key, repo, device:"webgpu"|"wasm", dtype, sizeMB, label}
 */
export function planBrowserRun(depth, gpu) {
  const notes = [];
  const fallbacks = [];
  let key = depth.model;
  if (key === "da3-mono-large-onnx") { notes.push("da3NotBuilt"); key = "da2-large"; }
  const m = modelByKey(key);
  if (!m || m.engine !== "browser") return { error: "notBrowserModel", fallbacks, mask: null, notes };
  const step = (mm, device, dtype) => ({ key: mm.key, repo: mm.id, device, dtype, sizeMB: mm.sizes[dtype] ?? null, label: mm.label, resolution: mm.resolutions.some((r) => r.px === depth.resolution) ? depth.resolution : mm.defaultResolution });
  const small = modelByKey("da2-small");
  let primary;
  if (gpu?.ok) {
    let dtype = depth.precision;
    if ((dtype === "fp16" || dtype === "q4f16") && !gpu.f16) { notes.push("noShaderF16"); dtype = "fp32"; }
    if (!m.sizes[dtype]) dtype = m.defaultPrecision;
    primary = step(m, "webgpu", dtype);
    if (depth.fallback && m.key !== "da2-small") fallbacks.push(step(small, "webgpu", gpu.f16 ? "fp16" : "fp32"));
    if (depth.fallback) fallbacks.push(step(small, "wasm", "fp32"));
  } else if (m.key === "da2-small") {
    primary = step(m, "wasm", "fp32");
  } else if (depth.fallback) {
    notes.push("noWebGPUSmall");
    primary = step(small, "wasm", "fp32");
  } else {
    return { error: "largeNeedsWebGPU", fallbacks, mask: null, notes };
  }
  let mask = null;
  if (depth.mask?.enabled) {
    const mm = maskByKey(depth.mask.model);
    const repo = MASK_REPOS[mm?.key];
    if (!repo) notes.push("maskNotBuilt");
    else {
      // Measured on lane 8 (2026-11-18, RTX 3070 Ti): BiRefNet_lite-ONNX takes a FIXED 1024² input; on WebGPU it needs 17
      // storage buffers per shader stage (the adapter allows 16), on WASM fp32 it dies with std::bad_alloc. Either failure
      // breaks the page's ONNX runtime until a reload, so the mask runs only on an adapter with enough buffers, else it is
      // skipped up front (no download, the depth map is made without it).
      const gpuOk = !!gpu?.ok && (gpu.maxStorageBuffers ?? 0) >= MASK_MIN_SB;
      if (!gpuOk) notes.push("maskUnsupported");
      else {
        const dtype = gpu.f16 ? "fp16" : "fp32";
        mask = { key: mm.key, repo, device: "webgpu", dtype, sizeMB: MASK_SIZES[mm.key][dtype], label: mm.label, licence: mm.licence };
      }
    }
  }
  return { primary, fallbacks, mask, notes };
}
