// W6-L: loading for the parallax window (browser): the portrait as an ImageBitmap, depth maps in every format we meet:
// - the module's own `<name>_depth.png`: 16-bit grey (png16) or 8-bit RGB with 16 bit in R+G and the mask in B
//   (png-rg16), decoded by our own PNG reader (a canvas would cut 16 bit to 8); the `_depth.json` sidecar names the
//   encoding when it exists, otherwise parallax-core detects it;
// - plain 8-bit grey maps (Flare / reference maps, PNG / WebP / JPEG; white = near) through the browser's decoder.
import { isPng, decodePng, depthFromPng, depthFromRGBA, resolveCrop, cropMap, downscaleMap } from "./parallax-core.mjs";

const routeOf = (path) => (/^(https?:|data:|blob:)/.test(path) ? path : foundry.utils.getRoute(String(path).replace(/^\/+/, "")));

async function fetchBytes(path) {
  const res = await fetch(routeOf(path));
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status });
  return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "" };
}

async function rgbaOf(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close?.();
  return { rgba: data, w: c.width, h: c.height };
}

/**
 * Portrait → {bitmap, w, h}. `crop` as in resolveCrop (pixels / fractions / "top-square").
 * W6-Q: `colorManaged` = decode like an <img> does (embedded ICC profile / gAMA converted to sRGB); without it the raw
 * bytes are used (a Display-P3 or Adobe-RGB picture then looks washed out next to the same <img>). Sheet portraits use
 * it; the W6-L window keeps its old decoding.
 */
export async function loadPortrait(path, { crop = null, maxSide = 0, colorManaged = false } = {}) {
  const { bytes, type } = await fetchBytes(path);
  const blob = new Blob([bytes], { type: type || "image/png" });
  const csc = colorManaged ? "default" : "none";
  let bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: csc });
  const natural = { w: bmp.width, h: bmp.height };
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
  return { bitmap: bmp, w: bmp.width, h: bmp.height, natural };
}

/** The `_depth.json` sidecar of a module depth file, or null (missing / not ours / unreadable). */
async function sidecarOf(path) {
  if (!/_depth\.png$/i.test(String(path).split(/[?#]/)[0])) return null;
  try {
    const { bytes } = await fetchBytes(String(path).split(/[?#]/)[0].replace(/_depth\.png$/i, "_depth.json"));
    const meta = JSON.parse(new TextDecoder().decode(bytes));
    return meta && typeof meta === "object" ? meta : null;
  } catch { return null; }
}

/**
 * Depth map → {D, mask, w, h, bits, format, meta}. `spec` = {path, crop?, invert?, format?} (format forces
 * "png16" | "png-rg16" | "gray8"). Maps larger than 2048 px are box-downscaled ×2 (conditioning stays fast).
 * W6-N: `sidecar: false` skips the `_depth.json` request (the depth index knows it does not exist: no 404).
 */
export async function loadDepth(spec) {
  const { path, crop = null, invert = false, format = null, sidecar = true } = spec;
  const { bytes, type } = await fetchBytes(path);
  const meta = isPng(bytes) && sidecar !== false ? await sidecarOf(path) : null;
  let src;
  if (isPng(bytes)) {
    const png = await decodePng(bytes);
    src = depthFromPng(png, { hint: format ?? meta?.encoding?.format ?? null, invert: invert || meta?.near === "dark" });
  } else {
    const { rgba, w, h } = await rgbaOf(new Blob([bytes], { type: type || "image/webp" }));
    src = depthFromRGBA(rgba, w, h, { invert });
  }
  const rect = resolveCrop(crop, src.w, src.h);
  if (rect) {
    src = { ...src, D: cropMap(src.D, src.w, src.h, rect), mask: src.mask ? cropMap(src.mask, src.w, src.h, rect) : null, w: rect[2], h: rect[3] };
  }
  while (Math.max(src.w, src.h) > 2048) {
    const d = downscaleMap(src.D, src.w, src.h, 2);
    const m = src.mask ? downscaleMap(src.mask, src.w, src.h, 2).M : null;
    src = { ...src, D: d.M, mask: m, w: d.w, h: d.h };
  }
  return { ...src, meta, path, bytes: bytes.length };
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
