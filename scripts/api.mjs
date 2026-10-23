// Public API for other modules: `game.modules.get("ai-image-gen").api` (see README, "API for other modules").
//
// Other modules register their own image types (they show up in the config window under their own group, with the
// usual provider/model/size/prompt settings) and ask for images with `generateImage`. It goes through the same core as
// the Fast mode: budget reservation and limits, the call log (with a `caller` field), optimization on save and
// `optimized: true` uploads. It never touches a document: the caller gets file paths back.
import { MODULE_ID } from "./constants.mjs";
import { getKey } from "./settings.mjs";
import { getVirtualType } from "./image-types.mjs";
import { getConfig, fitConfig, renderPrompt, isConfigured } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { executeGeneration, estimateInfo, loadRefs, normalizeRef, maxRefsFor, MAX_VERSIONS } from "./generate-flow.mjs";
import { saveImageBlobEx, slug } from "./save-image.mjs";
import { outputOptsFromConfig, statsPatch } from "./optimize.mjs";
import { updateCall } from "./call-log.mjs";
import { redact } from "./redact.mjs";
import { PickApp } from "./pick-app.mjs";

const round16 = (v) => Math.max(64, Math.round(v / 16) * 16);

/** "16:9", "1.5", 1.5, "1536x1024" → width/height ratio (or null). */
export function parseAspect(a) {
  if (a === undefined || a === null || a === "") return null;
  if (typeof a === "number") return a > 0 && Number.isFinite(a) ? a : null;
  const m = String(a).trim().match(/^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/i);
  if (m) return Number(m[1]) > 0 && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
  const n = Number(a);
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** Configuration of a type with the caller's size wishes applied (explicit width/height win over an aspect ratio). */
function configFor(typeKey, { width, height, aspectRatio, transparent } = {}) {
  const cfg = getConfig(typeKey);
  let w = Number(width), h = Number(height);
  if (!(w > 0 && h > 0)) {
    const ar = parseAspect(aspectRatio);
    if (ar) {
      // keep the pixel budget of the configured size, reshape it to the requested proportions
      const area = cfg.width * cfg.height;
      h = Math.sqrt(area / ar);
      w = h * ar;
    } else { w = cfg.width; h = cfg.height; }
  }
  return fitConfig({ ...cfg, width: round16(w), height: round16(h), custom: false, ...(transparent !== undefined ? { transparent: !!transparent } : {}) });
}

function assertGM() {
  if (!game.user.isGM) throw new Error("Only a GM can generate images.");
}

const cancelled = () => Object.assign(new Error("cancelled"), { name: "AbortError", cancelled: true });

/**
 * Estimated cost and readiness for a generation (no network call, no side effects).
 * @returns {{cost:number, perImage:number, source:"learned"|"table", samples:number, provider:string, providerLabel:string, model:string, modelLabel:string,
 *   width:number, height:number, hasKey:boolean, configured:boolean, requiresRef:boolean, maxRefs:number, estimated:true}}
 */
export function estimateGeneration({ typeKey, count = 1, refsCount = 0, width, height, aspectRatio } = {}) {
  assertGM();
  const cfg = configFor(typeKey, { width, height, aspectRatio });
  const info = estimateInfo(cfg, (cfg.refs?.length ?? 0) + Math.max(0, Number(refsCount) || 0), "sync");
  const perImage = info.display;
  return {
    cost: perImage * Math.max(1, Math.min(MAX_VERSIONS, Math.floor(Number(count)) || 1)),
    perImage,
    source: info.source,   // "learned" (median of real costs from the log) or "table"
    samples: info.n,
    provider: cfg.provider,
    providerLabel: providers.PROVIDERS[cfg.provider]?.label ?? cfg.provider,
    model: cfg.model,
    modelLabel: providers.listModels(cfg.provider).find((m) => m.id === cfg.model)?.label ?? cfg.model,
    width: cfg.width,
    height: cfg.height,
    hasKey: !!getKey(cfg.provider),
    configured: isConfigured(typeKey),
    requiresRef: !!getVirtualType(typeKey)?.requiresRef,
    maxRefs: maxRefsFor(cfg.provider, cfg.model),
    estimated: true
  };
}

async function toBlobs(refs) {
  const out = [];
  for (const [i, r] of refs.entries()) {
    if (typeof r === "string") out.push(...(await loadRefs([r])));
    else if (r instanceof Blob) out.push(await normalizeRef(r, `#${i + 1}`));
    else throw new Error("References must be file paths or Blobs.");
  }
  return out;
}

/**
 * Generate `count` versions for a registered (or any configured) image type and save them to Data/.
 * @param {object} o
 * @param {string} o.typeKey          image type key (e.g. "sketch-reveal.painted")
 * @param {string} [o.description]    goes into the type's prompt template ({description})
 * @param {string} [o.name]           file name stem and {name} in the template
 * @param {(Blob|string)[]} [o.refs]  extra reference images for this call (Blobs or Data paths), added to the type's own
 * @param {number} [o.width] [o.height] [o.aspectRatio]  size wish (the model's rules are applied)
 * @param {boolean} [o.transparent]   transparent background (only models that support it; others ignore it)
 * @param {number} [o.count=1]        versions, 1–8
 * @param {boolean} [o.pick=false]    open the picker window and resolve with the chosen one (rejects "cancelled" if closed)
 * @param {{dir?:string, name?:string, source?:"data"}} [o.saveTo]  folder (inside Data) and file name stem
 * @param {{maxEdge?:number, quality?:number, format?:string}} [o.output]  saved-file settings, over the type's own
 * @param {string} [o.caller]         shown in the call log
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{paths:string[], path:string, cost:number, candidates:{index:number, path?:string, cost:number}[],
 *   failed:{index:number, error:string}[], prompt:string, picked:boolean}>}
 */
export async function generateImage(o = {}) {
  assertGM();
  const { typeKey, description = "", name = "", refs = [], count = 1, pick = false, saveTo, output, signal } = o;
  if (!typeKey) throw new Error("typeKey is required.");
  if (saveTo?.source && saveTo.source !== "data") throw new Error('saveTo.source can only be "data".');
  const virtual = getVirtualType(typeKey);
  const caller = o.caller ?? virtual?.owner ?? "api";
  const cfg = configFor(typeKey, o);
  const extra = await toBlobs(refs);
  if (virtual?.requiresRef && !cfg.refs.length && !extra.length) {
    throw new Error(`"${virtual.label}" needs a reference image.`);
  }
  const prompt = renderPrompt(cfg.promptTemplate, {
    description: String(description).trim(), name, type: virtual?.label ?? typeKey.split(".").slice(1).join(".")
  }).trim();
  const owner = slug(virtual?.owner || caller, "module");
  const meta = { system: owner, docType: typeKey, name: name || "image", typeKey, description: String(description).trim() };
  const doc = { name: name || typeKey, type: typeKey, documentName: "", uuid: undefined };
  const run = (n) => executeGeneration({ doc, description: String(description), key: typeKey, cfg, prompt, meta, count: n, extraRefs: extra, signal, runKind: "fast", caller });

  const res = await run(count);
  let cost = res.cost;

  const dir = saveTo?.dir ?? `${MODULE_ID}/${owner}/${slug(typeKey.split(".").slice(1).join("-"), "image")}`;
  const outOpts = { ...outputOptsFromConfig(cfg) };
  for (const k of ["maxEdge", "quality", "format"]) if (output?.[k] !== undefined) outOpts[k] = output[k];
  const commit = async (cand) => {
    const { path, stats } = await saveImageBlobEx(cand.blob, { dir, name: saveTo?.name ?? name ?? "image", optimize: outOpts, preOptimized: cand.opt });
    cand.saved = stats;
    cand.path = path;
    if (cand.logId) await updateCall(cand.logId, statsPatch(stats));
    return path;
  };
  const summary = (paths, picked, cands, extraFailed = []) => ({
    paths, path: paths[0], cost, prompt, picked,
    candidates: cands.map((c) => ({ index: c.index, path: c.path, cost: c.cost })),
    failed: [...res.failed, ...extraFailed]
  });

  if (!pick) {
    // The images are already paid for: one failed save must not lose the others (or the paths already saved).
    const paths = [], saved = [], failedSaves = [];
    for (const c of res.candidates) {
      try {
        paths.push(await commit(c));
        saved.push(c);
      } catch (e) {
        const error = `Could not save the image: ${redact(e?.message ?? String(e))}`;
        failedSaves.push({ index: c.index, error });
        if (c.logId) await updateCall(c.logId, { status: "error", error: `After generation: ${error}` }).catch(() => {});
      }
    }
    if (!paths.length) {
      const e = new Error(failedSaves[0]?.error ?? "Could not save the generated images.");
      e.candidates = res.candidates; // paid for: the caller can still try to save them itself
      e.cost = cost;
      throw e;
    }
    return summary(paths, false, saved, failedSaves);
  }

  return new Promise((resolve, reject) => {
    PickApp.open({
      document: null,
      candidates: res.candidates,
      meta,
      source: "memory",
      outOpts,
      commit,
      title: o.title,
      regenerate: async () => {
        const more = await run(count);
        cost += more.cost;
        return { candidates: more.candidates };
      },
      onPicked: ({ path, others, candidate }) => resolve({ ...summary([path, ...others], true, [candidate]), path }),
      onCancel: () => reject(cancelled())
    });
  });
}
