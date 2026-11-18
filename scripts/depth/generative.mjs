// W6-I (owner: «zbuduj też od razu w depth opcję generacji modelem»): EXPERIMENTAL depth engine "generative". The source
// image goes as a reference to one of the module's own image models (an image EDIT call through generate-flow's
// executeGeneration: budget, limits, call log and the key from getKey, exactly like Fast mode) with a depth-map prompt.
// The returned picture is then treated like a model's depth output (post.mjs). Image models do not give geometrically
// consistent depth: proportions may drift and relative depth may be wrong, so the UI marks it experimental.
//
// Every call is paid: the caller ALWAYS gets an estimate and must confirm (deps.confirm) before the request; never batch.
// Pure except for the injected deps, so dev/test-depth-gen.mjs runs it in Node with stubs (no network, no key).
import { MODELS, getModel, fitSizeFor, fitOpenAIQuality, fitGeminiSize, fitGeminiThinking } from "../providers/models.mjs";
import { planRef, openaiInputTokens, rulesFor, outputFamily, outputTokens, estimateRequest, DEFAULTS as EST } from "../image-cost.mjs";
import { GEN_PROMPT_DEFAULT } from "../depth-settings.mjs";
import { imageToDepth } from "./post.mjs";

/** Reference tier for the source image: the largest one (geometry matters more than tokens here). */
export const GEN_REF_PURPOSE = "max";
/** Pixel budget of the requested depth image (same aspect as the source, then fitted to the model's size rules). */
export const GEN_AREA = 1024 * 1024;

/** Models of a provider that take a reference image (all catalogue entries do today; OpenRouter entries have no caps). */
export const genModelsFor = (provider) => (MODELS[provider] ?? []).filter((m) => (m.maxRefs ?? 14) >= 1);

/**
 * Generation config for one depth call: the chosen provider/model (falling back to the provider's first model), quality /
 * Gemini size fitted to the model, size with the source's aspect inside the model's rules, no type references,
 * no transparency, nothing optimised on save (the result never goes to disk as an image).
 */
export function genDepthConfig(depth, src) {
  const g = depth?.gen ?? {};
  const provider = MODELS[g.provider] ? g.provider : "openai";
  const list = genModelsFor(provider);
  const model = list.some((m) => m.id === g.model) ? g.model : list[0]?.id;
  if (!model) throw new Error(`No image model of ${provider} takes a reference image.`);
  const sw = Math.max(1, Number(src?.width) || 1024), sh = Math.max(1, Number(src?.height) || 1024);
  const ar = sw / sh;
  const fit = fitSizeFor(provider, model, Math.sqrt(GEN_AREA * ar), Math.sqrt(GEN_AREA / ar));
  const cfg = {
    provider, model, width: fit.width, height: fit.height,
    quality: provider === "openai" ? fitOpenAIQuality(model, g.quality) : (g.quality || "medium"),
    imageSize: provider === "gemini" ? fitGeminiSize(model, g.imageSize) : (g.imageSize || "1K"),
    thinkingLevel: provider === "gemini" ? fitGeminiThinking(model, "") : "",
    transparent: false, refs: [], refPurposes: [], refPurpose: GEN_REF_PURPOSE, refMaxEdge: EST.maxEdge,
    promptTemplate: "{description}", defaultMode: "fast", defaultCount: 1, outMaxEdge: 0
  };
  return cfg;
}

export const genPrompt = (depth) => String(depth?.gen?.prompt ?? "").trim() || GEN_PROMPT_DEFAULT;

/**
 * Token / USD breakdown of the request for the confirmation (OpenAI rules: the reference is planned like W6-D sends it).
 * `tableUSD` is the module's own estimate (estimateInfo: learned median or table) and is the number shown as the cost.
 */
export function genEstimate(cfg, src, tableUSD, { inPrice = EST.inPrice, outPrice = EST.outPrice } = {}) {
  const rules = rulesFor(cfg.provider, cfg.model);
  const plan = planRef({ width: src.width, height: src.height }, { rules, purpose: GEN_REF_PURPOSE, maxEdge: cfg.refMaxEdge });
  const fam = outputFamily(cfg.provider, cfg.model);
  const out = fam ? outputTokens(fam, cfg.quality, cfg.width, cfg.height) : null;
  const refTok = rules === "openai" ? openaiInputTokens(plan.width, plan.height).tokens : null;
  const req = out != null ? estimateRequest({ outTokens: out, refTokens: refTok != null ? [refTok] : [], count: 1, inPrice, outPrice }) : null;
  return {
    usd: Number.isFinite(tableUSD) ? tableUSD : (req?.perImage ?? null),
    tokensUSD: req?.perImage ?? null,
    outTokens: out, refTokens: refTok,
    ref: { width: plan.width, height: plan.height },
    size: { width: cfg.width, height: cfg.height },
    provider: cfg.provider, model: cfg.model, quality: cfg.quality, imageSize: cfg.imageSize,
    modelLabel: getModel(cfg.provider, cfg.model)?.label ?? cfg.model
  };
}

/**
 * Run the generative engine.
 * @param {{depth:object, typeKey?:string, name:string, img:{w:number,h:number,blob:Blob}}} o
 * @param {{estimate:(cfg:object)=>{display:number,source:string,n:number}, execute:(args:object)=>Promise<{candidates:{blob:Blob,cost:number}[],cost:number}>,
 *   confirm:(est:object)=>Promise<boolean>, decode:(blob:Blob)=>Promise<{rgba:Uint8ClampedArray,w:number,h:number}>, prices?:object, signal?:AbortSignal}} deps
 * @returns {Promise<{D:Float32Array, cost:number, estimate:object, returned:{w:number,h:number}, ms:number}>}
 */
export async function runGenerativeDepth({ depth, typeKey = "", name = "image", img }, deps) {
  if (!img?.blob || !(img.w > 0) || !(img.h > 0)) throw new Error("No source image.");
  const cfg = genDepthConfig(depth, { width: img.w, height: img.h });
  const info = deps.estimate(cfg);
  const estimate = genEstimate(cfg, { width: img.w, height: img.h }, info?.display, deps.prices);
  estimate.source = info?.source ?? "table";
  estimate.samples = info?.n ?? 0;
  // ALWAYS ask: a paid call never starts without the GM's yes for this exact estimate
  const ok = await deps.confirm(estimate);
  if (ok !== true) throw Object.assign(new Error("Cancelled."), { name: "AbortError", cancelled: true });
  const t0 = Date.now();
  const res = await deps.execute({
    doc: { name: `${name} (depth)`, type: "depth", documentName: "", uuid: undefined },
    description: "depth map", key: typeKey || "depth.generative", cfg, prompt: genPrompt(depth),
    meta: { system: "depth", docType: "depth", name, typeKey },
    count: 1, extraRefs: [img.blob], extraRefPurposes: [GEN_REF_PURPOSE], signal: deps.signal, runKind: "fast", caller: "depth"
  });
  const cand = res?.candidates?.[0];
  if (!cand?.blob) throw new Error("The image model returned no picture.");
  const pic = await deps.decode(cand.blob);
  if (!(pic?.w > 0 && pic?.h > 0) || pic.rgba?.length < pic.w * pic.h * 4) throw new Error("The returned picture could not be read.");
  const D = imageToDepth(pic.rgba, pic.w, pic.h, img.w, img.h);
  return { D, cost: res.cost ?? cand.cost ?? 0, estimate, returned: { w: pic.w, h: pic.h }, ms: Date.now() - t0 };
}
