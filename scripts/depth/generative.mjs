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
import { GEN_PROMPT_DEFAULT, GEN_STYLE_PREFIX, depthDefaults } from "../depth-settings.mjs";
import { imageToDepth } from "./post.mjs";

/** Reference tier for the source image: the largest one, ≤ 512 px (geometry matters more than tokens; the owner's tests
 *  sent the portrait at ≤ 512 px). */
export const GEN_REF_PURPOSE = "max";
/** W6-M: the optional style-example depth map goes at the same tier as the source (as in the owner's tests). */
export const GEN_STYLE_PURPOSE = "max";
/** Pixel budget of the requested depth image (same aspect as the source, then fitted to the model's size rules). */
export const GEN_AREA = 1024 * 1024;
/** W6-M: default cap of the longest output side (square 1024×1024, 9:16 → 720×1280 as in the owner's tests). */
export const GEN_MAX_LONG = 1280;

/** Models of a provider that take a reference image (all catalogue entries do today; OpenRouter entries have no caps). */
export const genModelsFor = (provider) => (MODELS[provider] ?? []).filter((m) => (m.maxRefs ?? 14) >= 1);

/**
 * W6-M: output size of the depth image from the SOURCE's shape. About GEN_AREA pixels with the source's aspect, the
 * longest side capped at `maxLong`, then fitted to the model's rules (OpenAI: sides ×16, 655 360-8 294 400 px, < 3:1;
 * the pixel minimum wins over the cap for very narrow images; Gemini / OpenRouter: nearest supported aspect).
 * Square → 1024×1024, 9:16 → 720×1280, 2:3 → 832×1248.
 * @returns {{width:number, height:number}}
 */
export function genOutputSize(provider, model, srcW, srcH, maxLong = GEN_MAX_LONG) {
  const sw = Math.max(1, Number(srcW) || 1024), sh = Math.max(1, Number(srcH) || 1024);
  const ar = sw / sh;
  let w = Math.sqrt(GEN_AREA * ar), h = Math.sqrt(GEN_AREA / ar);
  const cap = Math.max(16, Number(maxLong) || GEN_MAX_LONG);
  if (Math.max(w, h) > cap) { const k = cap / Math.max(w, h); w *= k; h *= k; }
  // ×16 by flooring the side that would otherwise exceed the cap, rounding the other (keeps the long side ≤ cap)
  const r16 = (v) => Math.max(16, Math.round(v / 16) * 16);
  const f16 = (v) => Math.max(16, Math.floor(v / 16) * 16);
  if (w >= h) { w = Math.min(r16(w), f16(cap)); h = r16(h); } else { h = Math.min(r16(h), f16(cap)); w = r16(w); }
  const fit = fitSizeFor(provider, model, w, h);
  return { width: fit.width, height: fit.height };
}

/**
 * Generation config for one depth call: the chosen provider/model (falling back to the provider's first model), quality /
 * Gemini size fitted to the model, size with the source's aspect inside the model's rules, no type references,
 * no transparency, nothing optimised on save (the result never goes to disk as an image).
 */
export function genDepthConfig(depth, src) {
  const g = depth?.gen ?? {};
  const provider = MODELS[g.provider] ? g.provider : "openai";
  const list = genModelsFor(provider);
  // W6-M: an unknown model falls back to the depth default (Sunburst 2.6) when the provider has it, else the provider's first
  const dflt = depthDefaults().gen;
  const fallback = provider === dflt.provider && list.some((m) => m.id === dflt.model) ? dflt.model : list[0]?.id;
  const model = list.some((m) => m.id === g.model) ? g.model : fallback;
  if (!model) throw new Error(`No image model of ${provider} takes a reference image.`);
  const fit = genOutputSize(provider, model, src?.width, src?.height, g.maxLong ?? GEN_MAX_LONG);
  const cfg = {
    provider, model, width: fit.width, height: fit.height,
    // W6-M: an unknown quality falls back to the depth default (low), not the model's image default (medium)
    quality: provider === "openai" ? fitOpenAIQuality(model, getModel("openai", model)?.qualities?.includes(g.quality) ? g.quality : dflt.quality) : (g.quality || "medium"),
    imageSize: provider === "gemini" ? fitGeminiSize(model, g.imageSize) : (g.imageSize || "1K"),
    thinkingLevel: provider === "gemini" ? fitGeminiThinking(model, "") : "",
    transparent: false, refs: [], refPurposes: [], refPurpose: GEN_REF_PURPOSE, refMaxEdge: EST.maxEdge,
    promptTemplate: "{description}", defaultMode: "fast", defaultCount: 1, outMaxEdge: 0
  };
  return cfg;
}

/**
 * The prompt sent. W6-M: with a style example (`{style: true}`) the owner's style prefix goes first, then the depth prompt
 * (image 1 = the source, image 2 = the style example: the order of the references in the request).
 */
export function genPrompt(depth, { style = false } = {}) {
  const p = String(depth?.gen?.prompt ?? "").trim() || GEN_PROMPT_DEFAULT;
  return style ? `${GEN_STYLE_PREFIX}\n\n${p}` : p;
}

/**
 * Token / USD breakdown of the request for the confirmation (OpenAI rules: the reference is planned like W6-D sends it).
 * `tableUSD` is the module's own estimate (estimateInfo: learned median or table) and is the number shown as the cost.
 * W6-M: `style` = size of the optional style-example image ({width, height}); its tokens are added to `refTokens`.
 */
export function genEstimate(cfg, src, tableUSD, { inPrice = EST.inPrice, outPrice = EST.outPrice } = {}, style = null) {
  const rules = rulesFor(cfg.provider, cfg.model);
  const plan = planRef({ width: src.width, height: src.height }, { rules, purpose: GEN_REF_PURPOSE, maxEdge: cfg.refMaxEdge });
  const splan = style ? planRef({ width: style.width, height: style.height }, { rules, purpose: GEN_STYLE_PURPOSE, maxEdge: cfg.refMaxEdge }) : null;
  const fam = outputFamily(cfg.provider, cfg.model);
  const out = fam ? outputTokens(fam, cfg.quality, cfg.width, cfg.height) : null;
  const tok = (p) => openaiInputTokens(p.width, p.height).tokens;
  const refList = rules === "openai" ? [tok(plan), ...(splan ? [tok(splan)] : [])] : null;
  const refTok = refList ? refList.reduce((a, b) => a + b, 0) : null;
  const req = out != null ? estimateRequest({ outTokens: out, refTokens: refList ?? [], count: 1, inPrice, outPrice }) : null;
  return {
    usd: Number.isFinite(tableUSD) ? tableUSD : (req?.perImage ?? null),
    tokensUSD: req?.perImage ?? null,
    outTokens: out, refTokens: refTok,
    ref: { width: plan.width, height: plan.height },
    styleRef: splan ? { width: splan.width, height: splan.height } : null,
    size: { width: cfg.width, height: cfg.height },
    provider: cfg.provider, model: cfg.model, quality: cfg.quality, imageSize: cfg.imageSize,
    modelLabel: getModel(cfg.provider, cfg.model)?.label ?? cfg.model
  };
}

const cancelled = () => Object.assign(new Error("Cancelled."), { name: "AbortError", cancelled: true });

/**
 * Run the generative engine.
 * @param {{depth:object, typeKey?:string, name:string, img:{w:number,h:number,blob:Blob}, style?:{w:number,h:number,blob:Blob,path?:string}|null}} o
 *   style = the loaded style-example depth map (W6-M, optional): sent as the SECOND reference with GEN_STYLE_PREFIX
 * @param {{estimate:(cfg:object, refCount:number)=>{display:number,source:string,n:number}, execute:(args:object)=>Promise<{candidates:{blob:Blob,cost:number}[],cost:number}>,
 *   confirm:(est:object)=>Promise<boolean>, decode:(blob:Blob)=>Promise<{rgba:Uint8ClampedArray,w:number,h:number}>, prices?:object, signal?:AbortSignal,
 *   keep?:(blob:Blob)=>Promise<string|null>}} deps
 *   W6-R: `signal` (the window) cancels BEFORE the paid call (checked before and after the confirmation); once the request
 *   is sent it is not aborted (the picture is paid for). `keep(blob)` stores the returned picture (e.g. under
 *   `_candidates/`) BEFORE anything else touches it; every error after the paid call carries `e.recover`
 *   ({blob, candidatePath, cost, estimate, returned?}) so the caller can save it again without paying. A window closed
 *   during the call -> the picture is kept, then AbortError (with `recover`), no post-processing.
 * @returns {Promise<{D:Float32Array, cost:number, estimate:object, returned:{w:number,h:number}, ms:number, blob:Blob, candidatePath:string|null, keepError:string|null}>}
 */
export async function runGenerativeDepth({ depth, typeKey = "", name = "image", img, style = null }, deps) {
  if (!img?.blob || !(img.w > 0) || !(img.h > 0)) throw new Error("No source image.");
  if (style && (!style.blob || !(style.w > 0) || !(style.h > 0))) throw new Error("The style example image could not be read.");
  if (deps.signal?.aborted) throw cancelled();
  const cfg = genDepthConfig(depth, { width: img.w, height: img.h });
  const refs = style ? [img.blob, style.blob] : [img.blob];
  const purposes = style ? [GEN_REF_PURPOSE, GEN_STYLE_PURPOSE] : [GEN_REF_PURPOSE];
  const info = deps.estimate(cfg, refs.length);
  const estimate = genEstimate(cfg, { width: img.w, height: img.h }, info?.display, deps.prices, style ? { width: style.w, height: style.h } : null);
  if (style) estimate.stylePath = style.path ?? "";
  estimate.source = info?.source ?? "table";
  estimate.samples = info?.n ?? 0;
  // ALWAYS ask: a paid call never starts without the GM's yes for this exact estimate
  const ok = await deps.confirm(estimate);
  if (ok !== true) throw cancelled();
  if (deps.signal?.aborted) throw cancelled();   // W6-R: window closed while the confirmation was open: nothing sent
  const t0 = Date.now();
  const res = await deps.execute({
    doc: { name: `${name} (depth)`, type: "depth", documentName: "", uuid: undefined },
    description: "depth map", key: typeKey || "depth.generative", cfg, prompt: genPrompt(depth, { style: !!style }),
    meta: { system: "depth", docType: "depth", name, typeKey },
    // W6-R: no signal here: an aborted fetch after the request left would lose a picture that is already paid for
    count: 1, extraRefs: refs, extraRefPurposes: purposes, runKind: "fast", caller: "depth"
  });
  const cand = res?.candidates?.[0];
  if (!cand?.blob) throw new Error("The image model returned no picture.");
  const cost = res.cost ?? cand.cost ?? 0;
  const ms = Date.now() - t0;
  // W6-R: the paid picture is stored before anything can fail
  let candidatePath = null, keepError = null;
  if (deps.keep) {
    try { candidatePath = (await deps.keep(cand.blob)) ?? null; }
    catch (e) { keepError = String(e?.message ?? e); }
  }
  const recover = { blob: cand.blob, candidatePath, keepError, cost, estimate };
  const fail = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { recover });
  if (deps.signal?.aborted) throw fail(cancelled());
  let pic;
  try { pic = await deps.decode(cand.blob); } catch (e) { throw fail(e); }
  if (!(pic?.w > 0 && pic?.h > 0) || pic.rgba?.length < pic.w * pic.h * 4) throw fail(new Error("The returned picture could not be read."));
  recover.returned = { w: pic.w, h: pic.h };
  let D;
  try { D = imageToDepth(pic.rgba, pic.w, pic.h, img.w, img.h); } catch (e) { throw fail(e); }
  return { D, cost, estimate, returned: { w: pic.w, h: pic.h }, ms, blob: cand.blob, candidatePath, keepError };
}
