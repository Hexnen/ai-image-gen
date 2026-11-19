// W6-I: "Dodaj głębię" run in the GM's browser: read the image, compute disparity (browser engine or the experimental
// generative engine), optional figure mask, post-processing (post.mjs), lossless PNG next to the image + a JSON sidecar.
//
// W6-R (store): every run writes NEW files named after the full image key, the engine and the run
// (`<base>-<ext>-<hash>.<engine>-<run>_depth.png` / `_mask.png` / `_depth.json`, depthPathsFor): no two images share a
// file, a run never overwrites another map, a paid map or a hand-made file (a listed name is never reused: the next free
// `-2`, `-3` suffix is taken), the sidecar always sits next to its own map. The index entry gets the run time as its
// revision `r`, the format actually written, and `s` only when the sidecar really was written.
// The paid picture of the generative engine is stored under `ai-image-gen/_candidates/depth/` BEFORE post-processing;
// any later failure (flat, encode, mask, upload, session lost) leaves `e.recover`, and `runDepth({recover})` saves it
// again from that picture without a new paid call.
import { MODULE_ID, DATA_ROOT } from "../constants.mjs";
import { postProcess, luminance, encodeDepthPng16, encodeDepthRG16, encodeGray8, depthPathsFor, imageToDepth } from "./post.mjs";
import { planBrowserRun } from "./plan.mjs";
import { depthIndex, encodeDataPath, normalizeImagePath } from "./depth-index.mjs";

const FP = () => foundry.applications.apps.FilePicker.implementation;
const now = () => performance.now();
/** Where paid generative pictures are kept until their map is saved (W6-R). */
export const DEPTH_CANDIDATE_DIR = `${DATA_ROOT}/_candidates/depth`;
/** Upload retry delays for errors that may pass (network / unknown); session and permission errors are not retried. */
export const UPLOAD_RETRY_MS = [1000, 3000];

/** Read an image path (Data-relative key or URL) into RGBA bytes. */
export async function loadImage(path) {
  const url = /^(https?:|data:|blob:)/.test(path) ? path : foundry.utils.getRoute(encodeDataPath(path));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const blob = await res.blob();
  return { ...(await decodeBlob(blob)), blob, url };
}

/** Blob → {rgba, w, h} through a canvas (no colour management surprises: the canvas is sRGB, alpha unpremultiplied). */
export async function decodeBlob(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close?.();
  return { rgba: data, w: c.width, h: c.height };
}

/** A 0..1 map as an 8-bit grey PNG object URL (preview only; the saved file is 16 bit). */
export async function previewUrl(M, w, h) {
  return URL.createObjectURL(new Blob([await encodeGray8(M, w, h)], { type: "image/png" }));
}

async function ensureDir(path) {
  let cur = "";
  for (const p of path.split("/")) {
    cur = cur ? `${cur}/${p}` : p;
    try { await FP().createDirectory("data", cur); } catch { /* exists */ }
  }
}

/** Default file I/O (Foundry). Tests pass their own. */
const foundryIO = {
  ensureDir,
  /** Normalised paths of the files in a Data folder (empty when missing). */
  async list(dir) {
    try {
      const res = await FP().browse("data", dir);
      return new Set((res?.files ?? []).map((f) => normalizeImagePath(String(f))));
    } catch { return new Set(); }
  },
  /** W6-K uploadOrThrow: real reason (session / permission / refused / network / unknown). */
  async upload(dir, file, options) {
    const { uploadOrThrow } = await import("../save-image.mjs");
    return uploadOrThrow(dir, file, options);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};

/**
 * Upload with the W6-K error reasons: "session" / "permission" stop at once (another try cannot help), the others are
 * retried after UPLOAD_RETRY_MS. @returns {Promise<string>} the stored path (key form)
 */
export async function uploadWithRetry(io, path, bytes, type, { delays = UPLOAD_RETRY_MS } = {}) {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash), name = path.slice(slash + 1);
  await io.ensureDir(dir);
  for (let attempt = 0; ; attempt++) {
    try {
      // W6-N: skipOptimize = Media Optimizer (Local) must not re-encode a 16-bit depth PNG into an 8-bit lossy WebP (it
      // also renames it to `_depth.webp`, which the depth lookup would then not find by name); seen live on lane 8
      const res = await io.upload(dir, new File([bytes], name, { type }), { notify: false, skipOptimize: true });
      if (!res?.path) throw Object.assign(new Error(`Upload failed: ${path}`), { reason: "unknown" });
      return normalizeImagePath(res.path);
    } catch (e) {
      const stop = e?.reason === "session" || e?.reason === "permission" || e?.retryable === false;
      if (stop || attempt >= delays.length) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { code: e?.reason === "session" ? "uploadSession" : "upload", path });
      }
      await io.sleep(delays[attempt]);
    }
  }
}

/** Run names that are free in the target folder (a listed name is never overwritten). */
export function freeRunPaths(key, engine, runId, listed) {
  for (let n = 1; n < 100; n++) {
    const p = depthPathsFor(key, { engine, run: n === 1 ? runId : `${runId}-${n}` });
    if (![p.depth, p.mask, p.meta].some((f) => listed.has(f))) return p;
  }
  throw new Error(`No free depth file name for ${key}`);
}

const MIME_EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };

/**
 * The whole run. `ui` callbacks: status(code, data), progress({file, loaded, total}), confirmDownload(items) → bool,
 * confirmPaid(estimate) → bool. `signal` (the window): cancels before the paid call / before post-processing.
 * `recover` ({blob?, candidatePath?, cost?, estimate?, model?}): save a generative result again from its stored picture
 * (no generation, no cost). `deps` (tests): {loadImage, decode, engine, generative, io, index, now}.
 * @returns {Promise<object>} result for the window (paths, timings, model, preview data)
 */
export async function runDepth({ path, depth, typeKey = "", ui = {}, signal = null, recover = null, deps = {} }) {
  if (!game.user.isGM) throw new Error("Only a GM can add depth.");
  const io = deps.io ?? foundryIO;
  const index = deps.index ?? depthIndex;
  const load = deps.loadImage ?? loadImage;
  const decode = deps.decode ?? decodeBlob;
  const clock = deps.now ?? (() => Date.now());
  const aborted = () => !!signal?.aborted;
  const cancelled = () => Object.assign(new Error("Cancelled."), { name: "AbortError", cancelled: true });
  const t = {};
  const status = (c, d) => ui.status?.(c, d);
  const key = index.keyOf(path);
  if (!key) throw new Error("No image path.");
  status("read");
  let t0 = now();
  const img = await load(key);
  t.readMs = now() - t0;
  const engine = recover ? "generative" : depth.engine;
  if (engine === "comfyui") throw Object.assign(new Error("ComfyUI engine is not built yet."), { code: "comfyNotBuilt" });
  const runAt = clock();
  const runId = runAt.toString(36);
  const E = deps.engine ?? (await import("./engine.mjs"));
  const gpu = await E.probeWebGPU();
  const res = { source: key, key, engine, runId, rev: runAt, w: img.w, h: img.h, gpu, notes: [], timings: t };

  // mask plan (both engines can use the local BiRefNet)
  const plan = planBrowserRun(depth, gpu);
  res.notes.push(...plan.notes);

  // downloads the GM has to agree to (first use only)
  const steps = engine === "browser" ? [plan.primary, plan.mask].filter(Boolean) : [plan.mask].filter(Boolean);
  if (engine === "browser" && plan.error) throw Object.assign(new Error(plan.error), { code: plan.error });
  const missing = [];
  for (const s of steps) if (!(await E.isCached(s.repo, s.dtype))) missing.push(s);
  if (missing.length && !(await ui.confirmDownload?.(missing))) throw cancelled();
  if (aborted()) throw cancelled();

  let D, modelSize = 518, paid = null;
  if (recover) {
    // W6-R: save again from the stored paid picture: no generation, no cost
    status("post");
    const blob = recover.blob ?? (recover.candidatePath ? (await load(recover.candidatePath)).blob : null);
    if (!blob) throw new Error("The paid picture is not available any more.");
    const pic = await decode(blob);
    if (!(pic?.w > 0 && pic?.h > 0)) throw new Error("The stored picture could not be read.");
    D = imageToDepth(pic.rgba, pic.w, pic.h, img.w, img.h);
    modelSize = Math.min(pic.w, pic.h);
    paid = { ...recover, blob, returned: { w: pic.w, h: pic.h } };
    Object.assign(res, { model: recover.model ?? (recover.estimate ? `${recover.estimate.modelLabel} (${recover.estimate.provider})` : "generative"), device: "api", dtype: recover.estimate?.quality ?? "", cost: 0, recovered: true, candidatePath: recover.candidatePath ?? null, returned: paid.returned });
    res.notes.push("recovered");
  } else if (engine === "generative") {
    const G = deps.generative ?? (await import("./generative.mjs"));
    const gdeps = deps.genDeps ?? (await (async () => {
      const F = await import("../generate-flow.mjs");
      const { estimateSettings } = await import("../ref-convert.mjs");
      return { estimate: (cfg, refCount = 1) => F.estimateInfo(cfg, refCount, "sync"), execute: (args) => F.executeGeneration(args), prices: estimateSettings() };
    })());
    // W6-M: optional style-example depth map (path in the Depth settings), loaded before the estimate so its size is costed
    let style = null;
    const stylePath = depth.gen?.styleRef ?? "";
    if (stylePath) {
      try { style = { ...(await load(normalizeImagePath(stylePath) || stylePath)), path: stylePath }; }
      catch (e) {
        console.warn(`${MODULE_ID} | depth style example ${stylePath}`, e);
        throw Object.assign(new Error(`Style example: ${e?.message ?? e}`), { code: "styleRef" });
      }
    }
    status("generate");
    const stem = depthPathsFor(key).stem;
    const r = await G.runGenerativeDepth({ depth, typeKey, name: depthPathsFor(key).base, img, style }, {
      ...gdeps,
      confirm: (est) => ui.confirmPaid ? ui.confirmPaid(est) : Promise.resolve(false),
      decode,
      signal,
      // W6-R: the paid picture goes to disk first (kept until a map from it is saved; the server cannot delete files)
      keep: async (blob) => {
        const ext = MIME_EXT[blob.type] ?? "png";
        const p = `${DEPTH_CANDIDATE_DIR}/${stem}.${runId}.${ext}`;
        return uploadWithRetry(io, p, new Uint8Array(await blob.arrayBuffer()), blob.type || "image/png");
      }
    });
    D = r.D;
    modelSize = Math.min(r.returned.w, r.returned.h);
    t.generateMs = r.ms;
    paid = { blob: r.blob, candidatePath: r.candidatePath, keepError: r.keepError, cost: r.cost, estimate: r.estimate, returned: r.returned };
    Object.assign(res, { model: `${r.estimate.modelLabel} (${r.estimate.provider})`, device: "api", dtype: r.estimate.quality, cost: r.cost, estimate: r.estimate, returned: r.returned, styleRef: style ? stylePath : null, candidatePath: r.candidatePath });
    if (r.keepError) res.notes.push("candidateNotKept");
  } else {
    status("depth");
    const r = await E.estimateDepth(plan, img, { onProgress: ui.progress, onStep: (s) => status("load", s), confirmStep: (s) => ui.confirmDownload ? ui.confirmDownload([s]) : Promise.resolve(false) });
    D = r.D;
    modelSize = r.step.resolution ?? 518;
    t.loadMs = r.loadMs; t.inferMs = r.inferMs;
    Object.assign(res, { model: r.step.label, repo: r.step.repo, device: r.step.device, dtype: r.step.dtype, resolution: r.step.resolution, reused: r.reused, fallbackErrors: r.errors });
  }
  res.raw = D;

  // W6-R: from here on a generative result is paid for: every failure carries `recover` (save again, no new call)
  const withRecover = (e) => {
    if (paid && e && typeof e === "object" && !e.recover) {
      e.recover = { blob: paid.blob, candidatePath: paid.candidatePath ?? null, cost: paid.cost ?? 0, estimate: paid.estimate ?? null, model: res.model };
    }
    return e;
  };
  try {
    if (aborted()) throw cancelled();
    let A = null;
    if (plan.mask) {
      status("mask");
      const m = await E.figureMask(plan.mask, img, { onProgress: ui.progress });
      A = m.A;
      t.maskLoadMs = m.loadMs; t.maskInferMs = m.inferMs;
      res.mask = { model: plan.mask.label, repo: plan.mask.repo, device: plan.mask.device, dtype: plan.mask.dtype, ok: !!A, error: m.error };
    }
    if (aborted()) throw cancelled();

    status("post");
    t0 = now();
    const guide = depth.post.guided ? luminance(img.rgba, img.w, img.h) : null;
    const p = postProcess(D, { w: img.w, h: img.h, mask: A, guide, post: depth.post, modelSize, now });
    t.postMs = now() - t0;
    res.postSteps = p.steps;
    if (p.flat) throw Object.assign(new Error("The depth map is flat (no depth difference)."), { code: "flat" });

    status("save");
    t0 = now();
    const fmt = depth.output.format === "png-rg16" ? "png-rg16" : "png16";
    const bytes = fmt === "png-rg16" ? await encodeDepthRG16(p.depth, depth.output.maskChannel ? A : null, img.w, img.h) : await encodeDepthPng16(p.depth, img.w, img.h);
    t.encodeMs = now() - t0;
    t0 = now();
    // W6-R: new names for every run; a name already on disk (hand-made file, earlier run) is never reused
    const dir = depthPathsFor(key).dir;
    await io.ensureDir(dir);
    const listed = await io.list(dir);
    const paths = freeRunPaths(key, engine, runId, listed);
    res.paths = paths;
    res.depthPath = await uploadWithRetry(io, paths.depth, bytes, "image/png");
    if (A && depth.output.maskChannel && fmt === "png16") res.maskPath = await uploadWithRetry(io, paths.mask, await encodeGray8(A, img.w, img.h), "image/png");
    const meta = {
      v: 2, module: MODULE_ID, source: key, depth: res.depthPath, run: paths.run, rev: runAt, createdAt: new Date(runAt).toISOString(),
      size: [img.w, img.h], near: "bright",
      encoding: fmt === "png-rg16" ? { format: "png-rg16", decode: "d = (r*255*256 + g*255) / 65535", mask: A && depth.output.maskChannel ? "B" : null } : { format: "png16", decode: "d = gray / 65535", mask: res.maskPath ?? null },
      engine, model: res.model, repo: res.repo, device: res.device, dtype: res.dtype, resolution: res.resolution,
      ...(engine === "generative" ? { generated: res.returned ? [res.returned.w, res.returned.h] : null, styleRef: res.styleRef ?? null, candidate: res.candidatePath ?? null, recovered: !!recover } : {}),
      maskModel: res.mask?.ok ? res.mask.repo : null, post: depth.post, timings: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v ?? 0)]))
    };
    // the sidecar has a fresh name, so it is written next to its own map; if it still fails the map is fine and the
    // index records "no sidecar" (loaders then use the index format)
    try {
      res.metaPath = await uploadWithRetry(io, paths.meta, new TextEncoder().encode(JSON.stringify(meta, null, 2)), "application/json", { delays: [] });
    } catch (e) {
      console.warn(`${MODULE_ID} | depth sidecar not written: ${paths.meta}`, e);
      res.notes.push("metaFailed");
      res.metaPath = null;
    }
    t.uploadMs = now() - t0;
    res.format = fmt;
    // W6-N: remember image -> map in the shared world index: every client's sheet portrait and token finds it.
    // W6-R: rev = this run (consumers refresh), the format actually written, sidecar only when it exists.
    try {
      await index.remember(key, { depth: res.depthPath, format: fmt, mask: res.maskPath ?? null, sidecar: !!res.metaPath, rev: runAt });
    } catch (e) { console.warn(`${MODULE_ID} | depth index not updated`, e); }
    res.depth = p.depth;
    res.maskA = A;
    res.bytes = bytes.length;
    status("done");
    return res;
  } catch (e) {
    throw withRecover(e);
  }
}
