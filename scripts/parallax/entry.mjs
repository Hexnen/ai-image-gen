// W6-L: entry points of the parallax portrait window: `api.parallax.open({image, depths})`, the sheet button (shown when
// `<name>_depth.png` exists next to the image) and the button in the depth result window. The window code loads on first use.
import { depthIndex } from "../depth/depth-index.mjs";
import { portraitApi } from "./portrait.mjs";
import { tokenApi } from "./token-parallax.mjs";
import { resolveTypeKey } from "../image-types.mjs";
import { getConfig } from "../config-store.mjs";

export const openParallax = (o) => import("./parallax-app.mjs").then((m) => m.ParallaxApp.open(o));

/** The type's stored parallax settings (cfg.depth.parallax), or null. */
export function typeParallax(typeKey) {
  if (!typeKey) return null;
  try { return getConfig(typeKey).depth?.parallax ?? null; } catch { return null; }
}

/** Forget cached depth lookups (after a depth file was written). W6-N: the shared index (depth/depth-index.mjs). */
export const forgetDepthChecks = () => depthIndex.invalidate();

/**
 * Button for a document's image when it has a depth map (resolves to null otherwise). GM only, like the other sheet
 * buttons. W6-N: found through the shared index (world index, then the GM's directory listing; no 404).
 */
export async function parallaxButtonFor(doc) {
  if (!game.user.isGM) return null;
  const img = doc?.img;
  if (!img || /^icons\/svg\//.test(img) || /\.svg$/i.test(img)) return null;
  const info = await depthIndex.lookup(img);
  if (!info) return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "aiimg-btn aiimg-parallax-btn";
  b.dataset.tooltip = game.i18n.localize("AIIMG.Parallax.Button");
  b.setAttribute("aria-label", b.dataset.tooltip);
  b.innerHTML = '<i class="fa-solid fa-cube"></i>';
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const key = resolveTypeKey(doc);
    openParallax({ image: img, depths: [{ name: info.depth.split("/").pop(), path: info.depth, format: info.format }], parallax: typeParallax(key) });
  });
  return b;
}

let registered = false;
export function registerParallax() {
  if (registered) return;
  registered = true;
  Hooks.on("aiImageGen.ready", (api) => {
    if (!api) return;
    api.parallax = {
      /**
       * Open the window. `image` = path (or {path, crop}); `depths` = [{name, path, crop?, invert?, format?}] (crop:
       * [x, y, w, h] px, {x, y, w, h} fractions, "top-square"); `typeKey` seeds the sliders from that type's settings
       * the first time in this page session. @returns {Promise<ParallaxApp>}
       */
      open: ({ image, depths = [], typeKey = "", crop = null, view = null } = {}) => openParallax({ image, depths, crop, view, parallax: typeParallax(typeKey) }),
      /** The open window (or null): setLook, setView, setCompare, benchmark, status for macros and checks. */
      get app() { return import("./parallax-app.mjs").then((m) => m.ParallaxApp.instance); },
      /** W6-N: sheet portraits: status(), refresh(), resume(), drawNow(look?), benchmark(frames?) */
      portraits: portraitApi,
      /** W6-O: canvas tokens: status(), refresh(), resume(), setPointer(p), stepNow(n, dt), whyNot(token) */
      tokens: tokenApi
    };
    /**
     * W6-N: the shared image -> depth map lookup (every client; writes are GM only). For the sheet portraits and the
     * canvas tokens. See depth/depth-index.mjs.
     */
    api.depthMaps = {
      /** @returns {Promise<{image, depth, format, mask, sidecar, source}|null>} */
      lookup: (src) => depthIndex.lookup(src),
      /** cached answer, no I/O: info | null | undefined (not looked up yet) */
      peek: (src) => depthIndex.peek(src),
      keyOf: (src) => depthIndex.keyOf(src),
      pathsFor: (src) => depthIndex.pathsFor(src),
      /** fn(keys|null) after any change; returns unsubscribe */
      onChange: (fn) => depthIndex.onChange(fn),
      entries: () => depthIndex.entries(),
      stats: () => depthIndex.stats(),
      invalidate: (src) => depthIndex.invalidate(src),
      reportMissing: (src) => depthIndex.reportMissing(src),
      /** load a found map: {D, mask, w, h, bits, format, meta, path} (Float32 0..1, 1 = near) */
      load: (info) => import("./parallax-load.mjs").then((m) => m.loadDepth({ path: info.depth, format: info.format, sidecar: info.sidecar, rev: info.rev || null })),
      ...(game.user.isGM ? { remember: (src, info) => depthIndex.remember(src, info), forget: (src) => depthIndex.forget(src) } : {})
    };
  });
}
