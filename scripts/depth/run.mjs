// W6-I: "Dodaj głębię" run in the GM's browser: read the image, compute disparity (browser engine or the experimental
// generative engine), optional figure mask, post-processing (post.mjs), lossless PNG next to the image + a JSON sidecar.
import { MODULE_ID } from "../constants.mjs";
import { postProcess, luminance, encodeDepthPng16, encodeDepthRG16, encodeGray8, depthPathsFor } from "./post.mjs";
import { planBrowserRun } from "./plan.mjs";

const FP = () => foundry.applications.apps.FilePicker.implementation;
const now = () => performance.now();

/** Read an image path (Data-relative or URL) into RGBA bytes. */
export async function loadImage(path) {
  const url = /^(https?:|data:|blob:)/.test(path) ? path : foundry.utils.getRoute(path);
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

async function upload(path, bytes, type) {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash), name = path.slice(slash + 1);
  await ensureDir(dir);
  const res = await FP().upload("data", dir, new File([bytes], name, { type }), {}, { notify: false });
  if (!res?.path) throw new Error(`Upload failed: ${path}`);
  return res.path;
}

/**
 * The whole run. `ui` callbacks: status(code, data), progress({file, loaded, total}), confirmDownload(items) → bool,
 * confirmPaid(estimate) → bool. @returns {Promise<object>} result for the window (paths, timings, model, preview data)
 */
export async function runDepth({ path, depth, typeKey = "", ui = {} }) {
  if (!game.user.isGM) throw new Error("Only a GM can add depth.");
  const t = {};
  const status = (c, d) => ui.status?.(c, d);
  status("read");
  let t0 = now();
  const img = await loadImage(path);
  t.readMs = now() - t0;
  const paths = depthPathsFor(path);
  const engine = depth.engine;
  if (engine === "comfyui") throw Object.assign(new Error("ComfyUI engine is not built yet."), { code: "comfyNotBuilt" });
  const E = await import("./engine.mjs");
  const gpu = await E.probeWebGPU();
  const res = { source: path, paths, w: img.w, h: img.h, engine, gpu, notes: [], timings: t };

  // mask plan (both engines can use the local BiRefNet)
  const plan = planBrowserRun(depth, gpu);
  res.notes.push(...plan.notes);

  // downloads the GM has to agree to (first use only)
  const steps = engine === "browser" ? [plan.primary, plan.mask].filter(Boolean) : [plan.mask].filter(Boolean);
  if (engine === "browser" && plan.error) throw Object.assign(new Error(plan.error), { code: plan.error });
  const missing = [];
  for (const s of steps) if (!(await E.isCached(s.repo, s.dtype))) missing.push(s);
  if (missing.length && !(await ui.confirmDownload?.(missing))) throw Object.assign(new Error("Cancelled."), { name: "AbortError", cancelled: true });

  let D, modelSize = 518;
  if (engine === "generative") {
    const G = await import("./generative.mjs");
    const F = await import("../generate-flow.mjs");
    const { estimateSettings } = await import("../ref-convert.mjs");
    status("generate");
    const name = paths.base;
    const r = await G.runGenerativeDepth({ depth, typeKey, name, img }, {
      estimate: (cfg) => F.estimateInfo(cfg, 1, "sync"),
      execute: (args) => F.executeGeneration(args),
      confirm: (est) => ui.confirmPaid ? ui.confirmPaid(est) : Promise.resolve(false),
      decode: decodeBlob,
      prices: estimateSettings()
    });
    D = r.D;
    modelSize = Math.min(r.returned.w, r.returned.h);
    t.generateMs = r.ms;
    Object.assign(res, { model: `${r.estimate.modelLabel} (${r.estimate.provider})`, device: "api", dtype: r.estimate.quality, cost: r.cost, estimate: r.estimate, returned: r.returned });
  } else {
    status("depth");
    const r = await E.estimateDepth(plan, img, { onProgress: ui.progress, onStep: (s) => status("load", s), confirmStep: (s) => ui.confirmDownload ? ui.confirmDownload([s]) : Promise.resolve(false) });
    D = r.D;
    modelSize = r.step.resolution ?? 518;
    t.loadMs = r.loadMs; t.inferMs = r.inferMs;
    Object.assign(res, { model: r.step.label, repo: r.step.repo, device: r.step.device, dtype: r.step.dtype, resolution: r.step.resolution, reused: r.reused, fallbackErrors: r.errors });
  }
  res.raw = D;

  let A = null;
  if (plan.mask) {
    status("mask");
    const m = await E.figureMask(plan.mask, img, { onProgress: ui.progress });
    A = m.A;
    t.maskLoadMs = m.loadMs; t.maskInferMs = m.inferMs;
    res.mask = { model: plan.mask.label, repo: plan.mask.repo, device: plan.mask.device, dtype: plan.mask.dtype, ok: !!A, error: m.error };
  }

  status("post");
  t0 = now();
  const guide = depth.post.guided ? luminance(img.rgba, img.w, img.h) : null;
  const p = postProcess(D, { w: img.w, h: img.h, mask: A, guide, post: depth.post, modelSize, now });
  t.postMs = now() - t0;
  res.postSteps = p.steps;
  if (p.flat) throw Object.assign(new Error("The depth map is flat (no depth difference)."), { code: "flat" });

  status("save");
  t0 = now();
  const fmt = depth.output.format;
  const bytes = fmt === "png-rg16" ? await encodeDepthRG16(p.depth, depth.output.maskChannel ? A : null, img.w, img.h) : await encodeDepthPng16(p.depth, img.w, img.h);
  t.encodeMs = now() - t0;
  t0 = now();
  res.depthPath = await upload(paths.depth, bytes, "image/png");
  if (A && depth.output.maskChannel && fmt === "png16") res.maskPath = await upload(paths.mask, await encodeGray8(A, img.w, img.h), "image/png");
  const meta = {
    v: 1, module: MODULE_ID, source: path, depth: res.depthPath, createdAt: new Date().toISOString(),
    size: [img.w, img.h], near: "bright",
    encoding: fmt === "png-rg16" ? { format: "png-rg16", decode: "d = (r*255*256 + g*255) / 65535", mask: A && depth.output.maskChannel ? "B" : null } : { format: "png16", decode: "d = gray / 65535", mask: res.maskPath ?? null },
    engine, model: res.model, repo: res.repo, device: res.device, dtype: res.dtype, resolution: res.resolution,
    maskModel: res.mask?.ok ? res.mask.repo : null, post: depth.post, timings: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v ?? 0)]))
  };
  res.metaPath = await upload(paths.meta, new TextEncoder().encode(JSON.stringify(meta, null, 2)), "application/json");
  t.uploadMs = now() - t0;
  res.depth = p.depth;
  res.maskA = A;
  res.bytes = bytes.length;
  status("done");
  return res;
}
