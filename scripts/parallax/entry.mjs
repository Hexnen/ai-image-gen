// W6-L: entry points of the parallax portrait window: `api.parallax.open({image, depths})`, the sheet button (shown when
// `<name>_depth.png` exists next to the image) and the button in the depth result window. The window code loads on first use.
import { depthPathsFor } from "../depth/post.mjs";
import { resolveTypeKey } from "../image-types.mjs";
import { getConfig } from "../config-store.mjs";

export const openParallax = (o) => import("./parallax-app.mjs").then((m) => m.ParallaxApp.open(o));

/** The type's stored parallax settings (cfg.depth.parallax), or null. */
export function typeParallax(typeKey) {
  if (!typeKey) return null;
  try { return getConfig(typeKey).depth?.parallax ?? null; } catch { return null; }
}

const EXISTS_TTL = 30_000;
const existsCache = new Map(); // path -> {at, p}

/** Cached existence check of a Data file (GM file browser; 30 s). */
export function depthFileExists(path) {
  const hit = existsCache.get(path);
  if (hit && performance.now() - hit.at < EXISTS_TTL) return hit.p;
  const p = import("./parallax-load.mjs").then((m) => m.fileExists(path)).catch(() => false);
  existsCache.set(path, { at: performance.now(), p });
  return p;
}

/** Forget cached checks (after a depth file was written). */
export const forgetDepthChecks = () => existsCache.clear();

/**
 * Button for a document's image when its `<name>_depth.png` exists (resolves to null otherwise). GM only, like the
 * other sheet buttons.
 */
export async function parallaxButtonFor(doc) {
  if (!game.user.isGM) return null;
  const img = doc?.img;
  if (!img || /^icons\/svg\//.test(img) || /\.svg$/i.test(img)) return null;
  const paths = depthPathsFor(img);
  if (!(await depthFileExists(paths.depth))) return null;
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
    openParallax({ image: img, depths: [{ name: paths.depth.split("/").pop(), path: paths.depth }], parallax: typeParallax(key) });
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
      get app() { return import("./parallax-app.mjs").then((m) => m.ParallaxApp.instance); }
    };
  });
}
