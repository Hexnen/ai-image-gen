// W6-G: settings of the future "Add depth" feature (depth map + parallax window), stored per image type under
// `cfg.depth`. Pure module (no Foundry globals): defaults, validation, model catalogue. Nothing here computes depth or
// downloads anything; the editor stores these values for the implementation that will read them later.
// Source of every model id, size and licence: dev/depth-model-research.md (commit 0ab5239) and the links it cites.
// Sizes marked `estimated` and every speed class are OUR estimates (research tag [W]), not measurements.

/** Schema version of `cfg.depth`; bump only with a migration in normalizeDepth.
 *  v2 (W6-I): engine "generative" + `gen` (provider, model, quality, imageSize, prompt). A v1 save normalises to v2 with the
 *  generative defaults and keeps every v1 value. */
export const DEPTH_SCHEMA = 2;

/** "generative" (W6-I, experimental) = an image model of the module's own providers draws the depth map (paid call). */
export const ENGINES = Object.freeze(["browser", "comfyui", "generative"]);
export const GEN_PROVIDERS = Object.freeze(["openai", "gemini", "openrouter"]);
/** Default prompt of the generative engine. Kept short and literal: image models follow plain constraints best. */
export const GEN_PROMPT_DEFAULT = "Convert this image into a depth map. Output only the depth map: a smooth grayscale image where white is nearest to the camera and black is farthest. Keep exactly the same framing, composition, proportions and outlines as the input image, pixel-aligned. No colour, no text, no labels, no borders, no lighting or shading changes, no added or removed objects, no stylisation.";
export const GEN_PROMPT_MAX = 2000;
export const PRECISIONS = Object.freeze(["fp16", "q4f16", "fp32"]);
/** Lossless only: 16-bit grayscale PNG, or 16 bit packed into R (high) + G (low) of an 8-bit PNG (mask in B). */
export const OUTPUT_FORMATS = Object.freeze(["png16", "png-rg16"]);
export const SPEEDS = Object.freeze(["fast", "medium", "slow"]);
export const COMFY_URL_DEFAULT = "http://127.0.0.1:8188";

/**
 * Depth models. `sizes` = download size in MB per precision (research §3.1, §3.2, §5.3); `resolutions` = processing
 * size in px with a quality tier; `speed` = rough class on the owner's RTX 3070 Ti, an estimate (research §5, [W]).
 */
export const DEPTH_MODELS = Object.freeze([
  Object.freeze({
    key: "da2-large", id: "onnx-community/depth-anything-v2-large", label: "Depth Anything V2 Large",
    engine: "browser", runtime: "transformers.js", licence: "CC BY-NC 4.0",
    source: "https://huggingface.co/onnx-community/depth-anything-v2-large",
    sizes: Object.freeze({ fp16: 669, q4f16: 235, fp32: 1340 }), defaultPrecision: "fp16",
    resolutions: Object.freeze([{ px: 518, tier: "standard" }, { px: 770, tier: "high", experimental: true }]), defaultResolution: 518,
    speed: "medium", output: "disparity", note: "da2Large"
  }),
  Object.freeze({
    key: "da2-small", id: "onnx-community/depth-anything-v2-small", label: "Depth Anything V2 Small",
    engine: "browser", runtime: "transformers.js", licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/depth-anything-v2-small",
    sizes: Object.freeze({ fp16: 49.6, q4f16: 19.1, fp32: 99.1 }), defaultPrecision: "fp16",
    resolutions: Object.freeze([{ px: 518, tier: "standard" }]), defaultResolution: 518,
    speed: "fast", output: "disparity", note: "da2Small", wasm: true
  }),
  Object.freeze({
    key: "da3-mono-large-onnx", id: "Jens-Duttke/Depth-Anything-3-MONO-ONNX", label: "Depth Anything 3 Mono-Large (ONNX)",
    engine: "browser", runtime: "onnxruntime-web", licence: "Apache-2.0", experimental: true,
    source: "https://huggingface.co/Jens-Duttke/Depth-Anything-3-MONO-ONNX",
    sizes: Object.freeze({ fp16: 688, q4f16: 352 }), defaultPrecision: "q4f16",
    // only these square sizes work (other sizes give NaN, research §3.2)
    resolutions: Object.freeze([{ px: 252, tier: "draft" }, { px: 364, tier: "fast" }, { px: 518, tier: "standard" }, { px: 728, tier: "high" }, { px: 1036, tier: "max" }]),
    defaultResolution: 518, speed: "medium", output: "disparity", note: "da3OnnxExp"
  }),
  Object.freeze({
    key: "da3-mono-large", id: "depth-anything/DA3MONO-LARGE", label: "Depth Anything 3 Mono-Large (ComfyUI)",
    engine: "comfyui", runtime: "comfyui", licence: "Apache-2.0", file: "depth_anything_3_mono_large.safetensors",
    source: "https://huggingface.co/depth-anything/DA3MONO-LARGE",
    // ~0.35B params: ~0.7 GB fp16 / ~1.4 GB fp32 is our estimate (research §5.3 [W])
    sizes: Object.freeze({ fp16: 700, fp32: 1400 }), sizesEstimated: true, defaultPrecision: "fp16",
    resolutions: Object.freeze([{ px: 504, tier: "standard" }, { px: 1036, tier: "high" }, { px: 1260, tier: "max" }]), defaultResolution: 1036,
    speed: "fast", output: "depth", note: "da3Comfy"
  })
]);

/** Figure-mask models (research §7.1). ToonOut is the test candidate (full BiRefNet tuned on anime); size unknown. */
export const MASK_MODELS = Object.freeze([
  Object.freeze({
    key: "birefnet-lite", id: "onnx-community/BiRefNet_lite", label: "BiRefNet lite", licence: "MIT",
    source: "https://huggingface.co/onnx-community/BiRefNet_lite", sizes: Object.freeze({ fp16: 115, fp32: 224 }), note: "birefnet"
  }),
  Object.freeze({
    key: "toonout", id: "joelseytre/toonout", label: "ToonOut (BiRefNet, anime)", licence: "MIT", experimental: true,
    source: "https://huggingface.co/joelseytre/toonout", sizes: Object.freeze({}), note: "toonout"
  })
]);

/** Ranges of the numeric settings: [min, max, step]. Gamma 0.7-0.9 per research §7.2 step 6. */
export const RANGES = Object.freeze({
  lowPct: [0, 10, 0.5],
  highPct: [90, 100, 0.5],
  edgeSnap: [0, 1, 0.05],
  dilatePx: [0, 8, 1],
  smoothPx: [0, 8, 1],
  gamma: [0.7, 0.9, 0.01],
  strength: [0, 1, 0.05],
  sway: [0, 1, 0.05]
});

export const modelByKey = (key) => DEPTH_MODELS.find((m) => m.key === key) ?? null;
export const maskByKey = (key) => MASK_MODELS.find((m) => m.key === key) ?? null;
export const modelsFor = (engine) => DEPTH_MODELS.filter((m) => m.engine === engine);

/** Default model of an engine: in the browser V2 Large with WebGPU, V2 Small without it (research §1). */
export function defaultModelKey(engine, { webgpu = true } = {}) {
  if (engine === "comfyui") return "da3-mono-large";
  // generative: `model` keeps the local browser model (used for the side-by-side compare); the image model is in `gen`
  return webgpu ? "da2-large" : "da2-small";
}

/** Fresh defaults. `webgpu` = does this browser have navigator.gpu (only decides the default model). */
export function depthDefaults({ webgpu = true } = {}) {
  const model = modelByKey(defaultModelKey("browser", { webgpu }));
  return {
    v: DEPTH_SCHEMA,
    enabled: false,
    engine: "browser",
    model: model.key,
    precision: model.defaultPrecision,
    resolution: model.defaultResolution,
    fallback: true,              // browser: no WebGPU / out of memory -> V2 Small
    comfyUrl: COMFY_URL_DEFAULT, // loopback only (normalizeDepth)
    mask: { enabled: true, model: "birefnet-lite" },
    post: { normalize: true, lowPct: 1, highPct: 99, flyingPixels: true, guided: true, edgeSnap: 1, dilatePx: 3, smoothPx: 3, gamma: 0.8 },
    output: { format: "png16", maskChannel: true },
    gen: { provider: "openai", model: "gpt-image-2.6-flare", quality: "medium", imageSize: "1K", prompt: GEN_PROMPT_DEFAULT },
    parallax: { strength: 0.5, sway: 0.3, light: true, rim: true, dust: false }
  };
}

const bool = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === "on" || v === 1 || v === "1");
const pick = (v, list, d) => (list.includes(v) ? v : d);
function num(v, [min, max, step], d) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return d;
  const snapped = Math.round((Math.min(max, Math.max(min, n)) - min) / step) * step + min;
  return Math.round(Math.min(max, snapped) * 1000) / 1000;
}

/** Only a loopback ComfyUI address is stored (the config is readable by every client of the world). */
export function cleanComfyUrl(v) {
  const s = String(v ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(s) ? s : COMFY_URL_DEFAULT;
}

/** Precisions a model offers, in PRECISIONS order. */
export const precisionsOf = (model) => PRECISIONS.filter((p) => model?.sizes?.[p] != null);

/**
 * Clamp any stored / submitted value into the schema. Unknown keys are dropped, a model that does not belong to the
 * engine is replaced by the engine's default, precision and resolution must be ones the model has, the output is
 * never lossy. Idempotent: normalizeDepth(normalizeDepth(x)) deep-equals normalizeDepth(x).
 */
export function normalizeDepth(raw, env = {}) {
  const d = depthDefaults(env);
  const r = raw && typeof raw === "object" ? raw : {};
  const engine = pick(r.engine, ENGINES, d.engine);
  let model = modelByKey(r.model);
  const modelEngine = engine === "generative" ? "browser" : engine;
  if (!model || model.engine !== modelEngine) model = modelByKey(defaultModelKey(modelEngine, env));
  const precs = precisionsOf(model);
  const res = model.resolutions.map((x) => x.px);
  const p = r.post ?? {};
  const o = r.output ?? {};
  const x = r.parallax ?? {};
  const m = r.mask ?? {};
  const g = r.gen ?? {};
  const gid = (v, dflt) => (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(v.trim()) ? v.trim() : dflt);
  const gprompt = typeof g.prompt === "string" && g.prompt.trim() ? g.prompt.trim().slice(0, GEN_PROMPT_MAX) : d.gen.prompt;
  const gprovider = pick(g.provider, GEN_PROVIDERS, d.gen.provider);
  const post = {
    normalize: bool(p.normalize, d.post.normalize),
    lowPct: num(p.lowPct, RANGES.lowPct, d.post.lowPct),
    highPct: num(p.highPct, RANGES.highPct, d.post.highPct),
    flyingPixels: bool(p.flyingPixels, d.post.flyingPixels),
    guided: bool(p.guided, d.post.guided),
    edgeSnap: num(p.edgeSnap, RANGES.edgeSnap, d.post.edgeSnap),
    dilatePx: num(p.dilatePx, RANGES.dilatePx, d.post.dilatePx),
    smoothPx: num(p.smoothPx, RANGES.smoothPx, d.post.smoothPx),
    gamma: num(p.gamma, RANGES.gamma, d.post.gamma)
  };
  return {
    v: DEPTH_SCHEMA,
    enabled: bool(r.enabled, d.enabled),
    engine,
    model: model.key,
    precision: precs.includes(r.precision) ? r.precision : model.defaultPrecision,
    resolution: res.includes(Number(r.resolution)) ? Number(r.resolution) : model.defaultResolution,
    fallback: bool(r.fallback, d.fallback),
    comfyUrl: cleanComfyUrl(r.comfyUrl ?? d.comfyUrl),
    mask: { enabled: bool(m.enabled, d.mask.enabled), model: maskByKey(m.model) ? m.model : d.mask.model },
    post,
    output: { format: pick(o.format, OUTPUT_FORMATS, d.output.format), maskChannel: bool(o.maskChannel, d.output.maskChannel) },
    // provider/model/quality are checked against the live provider catalogue where they are used (depth/generative.mjs):
    // this module stays free of the provider code. A model id from another provider falls back there.
    gen: {
      provider: gprovider,
      model: gid(g.model, gprovider === d.gen.provider ? d.gen.model : ""),
      quality: gid(g.quality, d.gen.quality),
      imageSize: gid(g.imageSize, d.gen.imageSize),
      prompt: gprompt
    },
    parallax: {
      strength: num(x.strength, RANGES.strength, d.parallax.strength),
      sway: num(x.sway, RANGES.sway, d.parallax.sway),
      light: bool(x.light, d.parallax.light),
      rim: bool(x.rim, d.parallax.rim),
      dust: bool(x.dust, d.parallax.dust)
    }
  };
}

/**
 * Merge the flat form fields named `depth.<path>` (FormDataExtended: checkboxes are booleans, disabled fields are
 * absent) over the previous value, then normalise. A field missing from the form keeps its previous value.
 */
export function depthFromForm(flat, prev, env = {}) {
  const out = structuredClone(normalizeDepth(prev, env));
  for (const [k, v] of Object.entries(flat ?? {})) {
    if (!k.startsWith("depth.")) continue;
    const path = k.slice(6).split(".");
    let node = out;
    // own keys of the normalised schema only (no __proto__ / constructor walk)
    for (const seg of path.slice(0, -1)) {
      if (!Object.hasOwn(node, seg) || !node[seg] || typeof node[seg] !== "object") { node = null; break; }
      node = node[seg];
    }
    const leaf = path.at(-1);
    if (node && Object.hasOwn(node, leaf) && typeof node[leaf] !== "object") node[leaf] = v;
  }
  return normalizeDepth(out, env);
}

/** "669 MB", "1.34 GB", "19.1 MB"; null/undefined -> "". */
export function fmtMB(mb) {
  if (mb == null || !Number.isFinite(Number(mb))) return "";
  const n = Number(mb);
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/\.?0+$/, "")} GB`;
  return `${n % 1 ? n.toFixed(1) : n} MB`;
}

/** "fp16 669 MB · q4f16 235 MB · fp32 1.34 GB" (with a leading "~" when the sizes are our estimate). */
export function sizeLine(model) {
  const t = (model.sizesEstimated ? "~" : "");
  return PRECISIONS.filter((p) => model.sizes?.[p] != null).map((p) => `${p} ${t}${fmtMB(model.sizes[p])}`).join(" · ");
}
