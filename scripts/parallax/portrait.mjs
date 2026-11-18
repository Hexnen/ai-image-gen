// W6-N: depth parallax on the ACTOR PORTRAIT inside actor sheets (any system's sheet, also restyled ones; nothing of
// theirs is edited). The portrait <img> is found by `data-edit="img"` / the usual profile selectors / any <img> showing
// the actor's image, and only used when it really shows `actor.img`.
//
// - Only when the image has a depth map (depth/depth-index.mjs: the shared lookup, also for tokens later). Without one
//   nothing is created: no canvas, no listener on the sheet, the portrait is exactly as before.
// - One WebGL2 context for ALL sheets (parallax-gl.mjs, the same renderer and shader as the parallax window): a detached
//   canvas draws each portrait in turn and the frame is copied into a small 2D canvas laid over the <img>
//   (pointer-events: none, so clicks / drag / the image editor still reach the <img>).
// - The frame loop runs only while something moves (pointer over the sheet, easing back to rest, the sheet being moved
//   or resized). At rest it stops: zero cost. Paused while the sheet is minimised, the portrait is off screen / on a
//   hidden tab, or the browser tab is hidden.
// - Turned off for this page when frames are too slow (portrait-core createFrameGuard), when the world setting
//   `portraitParallax` is off, under `prefers-reduced-motion: reduce`, or without WebGL2.
// - Sheet closed / re-rendered: the view is dropped / re-bound to the new <img> (textures kept). The last view gone =
//   the context is destroyed.
// - W6-P extras (client settings, parallax-fx.mjs): breathing (slow idle tilt while the pointer is away), light (on by
//   default, as before: shading + rim that follow the tilt) and dust (particles in depth planes, clipped to the picture:
//   the shader writes the portrait's own alpha). Breathing / dust keep the frame loop running at rest, but draw at most
//   ~30 fps while idle; still paused when hidden / off screen / minimised, and the frame guard still applies.
//   `prefers-reduced-motion: reduce` = the whole effect off (as before), so breathing and dust are off too.
// - GM: "Generate depth" in the sheet's header controls opens the depth window on the portrait (its own estimate +
//   confirmation before every paid call). The finished map lands in the index and every client's open sheet picks it up.
import { MODULE_ID } from "../constants.mjs";
import { FX_DEFAULTS, FX_KEYS, FX_RANGES, IDLE_FRAME_MS, fxSettingKey, normalizeFx, effectiveFx, breathLook } from "./parallax-fx.mjs";
import { depthIndex, normalizeImagePath } from "../depth/depth-index.mjs";
import { offsetFor, overscanFor, stepsFor, easeToward, backingSize, downscaleMap, conditionDepth, normalizeView } from "./parallax-core.mjs";
import {
  placementFor, panelPixels, lookFromPointer, settled, portraitView, effectAmount, portraitTextureSide,
  createFrameGuard, sameImage
} from "./portrait-core.mjs";

export const SETTING = "portraitParallax";

/** Portrait selectors, most certain first (same family as the sheet buttons). */
const SELECTORS = ['img[data-edit="img"]', "img.profile-img", ".profile-img img", "img.document-image", "img.actor-img", "img.portrait"];

const views = new Map();    // app -> PortraitView
const attachSeq = new WeakMap();
let host = null;            // {canvas, gl, raf, lastT, lastDrew}
let disabled = "";          // "", "slow", "nogl" (this page only)
let notified = false;
let refreshTimer = 0;
let seq = 0;
const guard = createFrameGuard();
let fxNow = null;           // W6-P: effective extras (breathing / light / dust) on this client

/** W6-P: the viewer's extras for portraits (client settings), after the reduced-motion rule. */
export function portraitFx() {
  if (!fxNow) {
    const raw = {};
    for (const k of FX_KEYS) { try { raw[k] = game.settings.get(MODULE_ID, fxSettingKey("portrait", k)); } catch { /* not registered */ } }
    fxNow = effectiveFx(normalizeFx(raw, "portrait"), { reducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false });
  }
  return fxNow;
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
const norm = (s) => normalizeImagePath(s, { origin: globalThis.location?.origin ?? "", routePrefix: foundry.utils.getRoute("/").replace(/^\/+|\/+$/g, "") });

function settingOn() {
  try { return game.settings.get(MODULE_ID, SETTING) !== false; } catch { return false; }
}

/** Is the feature live on this client right now? */
export function portraitParallaxActive() {
  return settingOn() && !disabled && !reducedMotion();
}

function typeParallaxOf(doc) {
  try {
    const key = `${game.system.id}.${doc.documentName}.${doc.type}`;
    // config-store is GM-oriented but reading a world setting is fine for anyone; any failure = defaults
    return import("../config-store.mjs").then((m) => m.getConfig(key).depth?.parallax ?? null).catch(() => null);
  } catch { return Promise.resolve(null); }
}

function isActorSheet(app, v1) {
  const doc = app?.document;
  if (!doc || doc.documentName !== "Actor") return false;
  if (v1) return true; // reached through renderDocumentSheet / closeDocumentSheet
  const DS = foundry.applications?.api?.DocumentSheetV2;
  return !!DS && app instanceof DS;
}

function rootOf(app, html) {
  const el = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  return el instanceof HTMLElement ? el : el?.[0] ?? null;
}

/** The <img> that shows the actor's image, or null. */
export function findPortrait(root, doc) {
  if (!root || !doc?.img) return null;
  const shows = (img) => img?.tagName === "IMG" && (sameImage(img.getAttribute("src"), doc.img, norm) || sameImage(img.currentSrc || img.src, doc.img, norm));
  for (const sel of SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      const img = el.tagName === "IMG" ? el : el.querySelector("img");
      if (shows(img)) return img;
    }
  }
  // any other <img> with the actor's image (the biggest one: a portrait, not a tiny icon)
  let best = null, area = 0;
  for (const img of root.querySelectorAll("img")) {
    if (img.closest(".window-header")) continue;
    if (!shows(img)) continue;
    const a = (img.offsetWidth || 0) * (img.offsetHeight || 0);
    if (!best || a > area) { best = img; area = a; }
  }
  return best;
}

// ------------------------------------------------------------------ the shared context

function ensureHost() {
  if (host) return host;
  if (disabled) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 2; canvas.height = 2;
  return import("./parallax-gl.mjs").then(({ ParallaxRenderer }) => {
    if (host) return host;
    let gl = null;
    try { gl = ParallaxRenderer.create(canvas, { alpha: true, premultipliedAlpha: false }); }
    catch (e) { console.warn(`${MODULE_ID} | portrait parallax: WebGL2 renderer failed`, e); }
    if (!gl) { disabled = "nogl"; dropAll(); return null; }
    host = { canvas, gl, raf: 0, lastT: 0, lastDrew: false, idleRun: false };
    canvas.addEventListener("webglcontextlost", (ev) => { ev.preventDefault(); if (host?.gl) host.gl.lost = true; });
    canvas.addEventListener("webglcontextrestored", () => restoreContext());
    return host;
  });
}

function restoreContext() {
  if (!host) return;
  import("./parallax-gl.mjs").then(({ ParallaxRenderer }) => {
    try { host.gl = ParallaxRenderer.create(host.canvas, { alpha: true, premultipliedAlpha: false }); } catch { host.gl = null; }
    if (!host.gl) { disabled = "nogl"; dropAll(); return; }
    for (const v of views.values()) v.upload();
    kick();
  });
}

function destroyHost() {
  if (!host) return;
  cancelAnimationFrame(host.raf);
  try { host.gl?.destroy(); } catch { /* lost already */ }
  host.canvas.width = host.canvas.height = 1;
  host = null;
}

function kick() {
  if (!host || document.hidden || !views.size) return;
  if (host.raf) {
    if (performance.now() - host.lastT < 1000) return;
    cancelAnimationFrame(host.raf); // a request that never ran (page was hidden / frozen): ask again
    host.raf = 0;
  }
  host.lastT = performance.now();
  host.lastDrew = false;
  host.idleRun = false;
  host.raf = requestAnimationFrame(frame);
}

function frame(t) {
  if (!host) return;
  host.raf = 0;
  if (document.hidden || !host.gl || host.gl.lost) return;
  const dt = Math.min(0.1, Math.max(0, (t - host.lastT) / 1000));
  const gap = t - host.lastT;
  host.lastT = t;
  let busy = false, drew = false, idle = false;
  const t0 = performance.now();
  for (const v of views.values()) {
    const r = v.step(t, dt);
    busy ||= r.busy;
    drew ||= r.drew;
    idle ||= !!r.idle;
  }
  const drawMs = performance.now() - t0;
  // W6-P: while breathing / dust run, idle draws are throttled (~30 fps) and the frames in between draw nothing; the
  // guard then also judges a drawn frame that follows an idle-run frame (gap = one rAF interval of the page)
  if (drew && (host.lastDrew || host.idleRun) && guard.push(gap, drawMs) === "bad") { tooSlow(); return; }
  host.lastDrew = drew;
  host.idleRun = idle;
  if (busy) host.raf = requestAnimationFrame(frame);
}

function tooSlow() {
  disabled = "slow";
  const st = guard.state();
  console.warn(`${MODULE_ID} | portrait parallax turned off on this page: frames too slow`, st);
  dropAll();
  if (!notified) { notified = true; ui.notifications?.info(game.i18n.localize("AIIMG.PortraitParallax.Slow")); }
}

// ------------------------------------------------------------------ one portrait

class PortraitView {
  constructor(app, doc, info) {
    this.app = app;
    this.doc = doc;
    this.info = info;
    this.imagePath = info.image;
    this.id = ++seq;
    this.imgKey = `pi${this.id}`;
    this.depKey = `pd${this.id}`;
    this.status = "loading";
    this.error = "";
    this.img = null;
    this.root = null;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "aiimg-portrait-plx";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.visibility = "hidden";
    this.ctx = this.canvas.getContext("2d");
    this.bitmap = null;
    this.src = null;           // depth map before conditioning (kept for a context restore)
    this.tex = null;           // {w, h} portrait texture size
    this.view = portraitView(null);
    this.look = { x: 0, y: 0 };
    this.pointer = { x: 0, y: 0 };
    this.inside = false;
    this.visible = true;
    this.dirty = true;
    this.layoutUntil = 0;
    this.drawnLook = null;
    this.lastDrawT = 0;
    this.place = null;
    this.style = null;
    this.clipEls = [];
    this.unbind = [];
    this.destroyed = false;
    this.draws = 0;
  }

  /** Attach to (a new) <img> of the sheet. */
  bind(img, root) {
    if (this.img === img && this.root === root && this.canvas.isConnected) return;
    this.#unbindAll();
    this.img = img;
    this.root = root;
    img.after(this.canvas);
    this.#readStyle();
    const dirty = () => { this.layoutUntil = performance.now() + 450; this.dirty = true; kick(); };
    const on = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); this.unbind.push(() => el.removeEventListener(type, fn, opt)); };
    on(root, "pointermove", (ev) => {
      if (!this.place) return;
      this.pointer = lookFromPointer(ev.clientX, ev.clientY, this.place.drawn);
      this.inside = true;
      kick();
    }, { passive: true });
    on(root, "pointerleave", () => { this.inside = false; kick(); }, { passive: true });
    on(img, "load", () => { this.#readStyle(); dirty(); });
    on(root, "transitionend", dirty, { passive: true });
    on(root, "animationend", dirty, { passive: true });
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => { this.#readStyle(); dirty(); });
      for (const el of new Set([img, img.parentElement, this.canvas.offsetParent].filter(Boolean))) ro.observe(el);
      this.unbind.push(() => ro.disconnect());
    }
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver((ents) => { this.visible = ents.some((e) => e.isIntersecting); if (this.visible) dirty(); });
      io.observe(img);
      this.unbind.push(() => io.disconnect());
    }
    // the window moving / scaling (style attribute of the app element), other modules' CSS variables on it
    const appEl = this.app.element instanceof HTMLElement ? this.app.element : root;
    const mo = new MutationObserver(dirty);
    mo.observe(appEl, { attributes: true, attributeFilter: ["style", "class"] });
    this.unbind.push(() => mo.disconnect());
    // scrolling containers move the picture without resizing anything
    for (const el of this.clipEls) on(el, "scroll", dirty, { passive: true });
    dirty();
  }

  #readStyle() {
    const img = this.img;
    if (!img) return;
    const cs = getComputedStyle(img);
    const px = (v) => parseFloat(v) || 0;
    this.style = {
      fit: cs.objectFit || "fill", position: cs.objectPosition || "50% 50%", radius: cs.borderRadius,
      l: px(cs.borderLeftWidth) + px(cs.paddingLeft), r: px(cs.borderRightWidth) + px(cs.paddingRight),
      t: px(cs.borderTopWidth) + px(cs.paddingTop), b: px(cs.borderBottomWidth) + px(cs.paddingBottom)
    };
    // ancestors that clip their content (overflow other than visible), up to the sheet's root
    const clips = [];
    for (let el = img.parentElement; el && el !== document.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") clips.push(el);
      if (el === this.root) break;
    }
    this.clipEls = clips;
  }

  #unbindAll() {
    for (const f of this.unbind.splice(0)) { try { f(); } catch { /* gone */ } }
  }

  /** Load the picture and its map, condition, upload. */
  async load() {
    try {
      const L = await import("./parallax-load.mjs");
      const vp = await typeParallaxOf(this.doc);
      this.view = portraitView(vp);
      const side = portraitTextureSide(this.img?.offsetWidth, this.img?.offsetHeight, globalThis.devicePixelRatio ?? 1);
      const p = await L.loadPortrait(this.imagePath, { maxSide: side });
      if (this.destroyed) { p.bitmap.close?.(); return; }
      this.bitmap = p.bitmap;
      this.tex = { w: p.w, h: p.h, natural: p.natural };
      let src;
      try {
        src = await L.loadDepth({ path: this.info.depth, format: this.info.format, sidecar: this.info.sidecar });
      } catch (e) {
        if (e?.status === 404 || e?.status === 403) depthIndex.reportMissing(this.imagePath);
        throw e;
      }
      if (this.destroyed) return;
      const f = Math.floor(Math.min(src.w / p.w, src.h / p.h));
      if (f >= 2) {
        const d = downscaleMap(src.D, src.w, src.h, f);
        src = { ...src, D: d.M, mask: src.mask ? downscaleMap(src.mask, src.w, src.h, f).M : null, w: d.w, h: d.h };
      }
      this.src = src;
      await new Promise((r) => setTimeout(r, 0));
      if (this.destroyed) return;
      this.upload();
      this.status = "ready";
      this.dirty = true;
      kick();
    } catch (e) {
      if (this.destroyed) return;
      this.status = "error";
      this.error = String(e?.message ?? e);
      console.warn(`${MODULE_ID} | portrait parallax: ${this.imagePath}`, e);
      this.canvas.style.visibility = "hidden";
    }
  }

  upload() {
    if (!host?.gl || !this.bitmap || !this.src) return;
    const c = conditionDepth(this.src, { dilatePx: this.view.dilate, normalBlurPx: this.view.normalBlur });
    host.gl.setImage(this.bitmap, this.imgKey);
    host.gl.setDepth(this.depKey, c);
    this.dirty = true;
  }

  #placement() {
    const img = this.img, st = this.style;
    if (!img?.isConnected || !st) return null;
    const r = img.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1) || !img.offsetWidth) return null;
    const k = r.width / img.offsetWidth, kh = r.height / Math.max(1, img.offsetHeight);
    const content = { x: r.left + st.l * k, y: r.top + st.t * kh, w: r.width - (st.l + st.r) * k, h: r.height - (st.t + st.b) * kh };
    const clips = this.clipEls.map((el) => {
      const b = el.getBoundingClientRect();
      const sx = b.width / Math.max(1, el.offsetWidth), sy = b.height / Math.max(1, el.offsetHeight);
      return { x: b.left + el.clientLeft * sx, y: b.top + el.clientTop * sy, w: el.clientWidth * sx, h: el.clientHeight * sy };
    });
    clips.push({ x: 0, y: 0, w: globalThis.innerWidth || 1e5, h: globalThis.innerHeight || 1e5 });
    const natW = this.tex?.natural?.w || img.naturalWidth || this.tex?.w, natH = this.tex?.natural?.h || img.naturalHeight || this.tex?.h;
    const p = placementFor({ content, natW, natH, fit: st.fit, position: st.position, clips });
    if (p) p.content = content;
    return p;
  }

  #applyPlacement(p) {
    const cv = this.canvas;
    const op = cv.offsetParent;
    if (!op) return null;
    const o = op.getBoundingClientRect();
    const sx = o.width / Math.max(1, op.offsetWidth), sy = o.height / Math.max(1, op.offsetHeight);
    const css = {
      left: (p.visible.x - o.left) / sx - op.clientLeft + op.scrollLeft,
      top: (p.visible.y - o.top) / sy - op.clientTop + op.scrollTop,
      width: p.visible.w / sx, height: p.visible.h / sy
    };
    const s = cv.style;
    s.left = `${css.left}px`; s.top = `${css.top}px`; s.width = `${css.width}px`; s.height = `${css.height}px`;
    const whole = Math.abs(p.visible.w - p.content.w) < 1 && Math.abs(p.visible.h - p.content.h) < 1;
    s.borderRadius = whole ? this.style.radius : "";
    const b = backingSize(p.visible.w, p.visible.h, globalThis.devicePixelRatio ?? 1, { cap: 2, maxPixels: 1.5e6 });
    if (cv.width !== b.w || cv.height !== b.h) { cv.width = b.w; cv.height = b.h; }
    return b;
  }

  /** One frame. @returns {{busy:boolean, drew:boolean}} */
  step(t, dt) {
    if (this.status !== "ready" || this.destroyed || !host?.gl) return { busy: false, drew: false };
    if (!this.img?.isConnected || !this.app.rendered || this.app.minimized || !this.visible) return { busy: false, drew: false };
    const fx = portraitFx();
    // W6-P breathing: the pointer away = a slow tiny tilt (eased like the pointer); off = back to the centre as before
    const target = this.inside ? this.pointer : fx.breath ? breathLook(t, fx.breathStrength) : { x: 0, y: 0 };
    this.look = { x: easeToward(this.look.x, target.x, dt, 0.14), y: easeToward(this.look.y, target.y, dt, 0.14) };
    const done = settled(this.look, target);
    if (done && !this.inside) this.look = { ...target };
    const layout = t < this.layoutUntil;
    const moved = !this.drawnLook || !settled(this.look, this.drawnLook, 0.0005);
    const busy = !done || layout || fx.animates;
    if (!moved && !layout && !this.dirty && !fx.dust) return { busy, drew: false };
    // idle animation only (pointer away, no layout change, look near its breathing target): at most ~30 fps
    const idle = fx.animates && !this.inside && !layout && !this.dirty && Math.hypot(this.look.x - target.x, this.look.y - target.y) < 0.05;
    if (idle && t - this.lastDrawT < IDLE_FRAME_MS) return { busy, drew: false, idle };
    this.draw(t);
    this.lastDrawT = t;
    return { busy, drew: true, idle };
  }

  draw(t = performance.now()) {
    const p = this.#placement();
    this.place = p;
    if (!p) { this.canvas.style.visibility = "hidden"; return false; }
    const b = this.#applyPlacement(p);
    if (!b) { this.canvas.style.visibility = "hidden"; return false; }
    const g = host.gl, hc = host.canvas;
    if (hc.width < b.w || hc.height < b.h) { hc.width = Math.max(hc.width, b.w); hc.height = Math.max(hc.height, b.h); }
    const v = this.view, tw = this.tex.w, th = this.tex.h, fx = portraitFx();
    // the panel sits at the top-left of the shared canvas (the renderer's panels are y-down from the top)
    g.draw([{ key: this.depKey, image: this.imgKey, x: 0, y: 0, w: b.w, h: b.h }], {
      off: offsetFor(this.look, v.strength, tw, th), crop: overscanFor(v.strength, v.focus, tw, th), look: this.look,
      bg: [0, 0, 0], focus: v.focus, gamma: v.gamma, contrast: v.contrast,
      light: v.on.light && fx.light ? effectAmount(v.light * fx.lightStrength, this.look) : 0,
      rim: v.on.rim && fx.light ? effectAmount(v.rim * fx.lightStrength, this.look) : 0,
      dust: fx.dust ? fx.dustStrength : 0, vignette: 0, holeFill: v.on.holeFill ? 1 : 0, time: t / 1000, relief: 10, view: 0, alphaOut: 1,
      rectFor: () => p.panel,
      stepsFor: (d) => stepsFor(offsetFor({ x: 1, y: 0 }, v.strength, tw, th), d.w, d.h)
    });
    const px = panelPixels(p.panel, b.w, b.h);
    this.ctx.clearRect(0, 0, b.w, b.h);
    if (px.w > 0 && px.h > 0) this.ctx.drawImage(hc, px.x, px.y, px.w, px.h, px.x, px.y, px.w, px.h);
    this.canvas.style.visibility = "";
    this.drawnLook = { ...this.look };
    this.dirty = false;
    this.draws++;
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.#unbindAll();
    this.canvas.remove();
    this.canvas.width = this.canvas.height = 0;
    if (host?.gl) { host.gl.dropImage(this.imgKey); host.gl.dropDepth(this.depKey); }
    this.bitmap?.close?.();
    this.bitmap = null;
    this.src = null;
  }

  report() {
    return {
      actor: this.doc?.uuid, image: this.imagePath, depth: this.info.depth, format: this.info.format, status: this.status, error: this.error,
      texture: this.tex ? [this.tex.w, this.tex.h] : null, depthSize: this.src ? [this.src.w, this.src.h] : null,
      canvas: [this.canvas.width, this.canvas.height], placed: !!this.place, visible: this.visible, inside: this.inside,
      look: { ...this.look }, draws: this.draws, bound: !!this.img?.isConnected && this.canvas.isConnected
    };
  }
}

// ------------------------------------------------------------------ attach / detach

function drop(app) {
  const v = views.get(app);
  if (!v) return;
  v.destroy();
  views.delete(app);
  if (!views.size) destroyHost();
}

function dropAll() {
  for (const app of [...views.keys()]) drop(app);
}

/** Render of an actor sheet: find the portrait, look up its map, create / re-bind / drop the view. */
async function attach(app, root) {
  const n = (attachSeq.get(app) ?? 0) + 1;
  attachSeq.set(app, n);
  // views of sheets that closed without a close hook
  for (const a of [...views.keys()]) if (!a.rendered) drop(a);
  const doc = app.document;
  if (!portraitParallaxActive() || !doc?.img) { drop(app); return; }
  const info = await depthIndex.lookup(doc.img);
  if (attachSeq.get(app) !== n || !app.rendered) return;
  if (!info) { drop(app); return; }
  const img = findPortrait(root ?? app.element, doc);
  if (!img) { drop(app); return; }
  let v = views.get(app);
  if (v && (v.imagePath !== info.image || v.info.depth !== info.depth || v.status === "error")) { drop(app); v = null; }
  if (!v) {
    const h = await ensureHost();
    if (!h || attachSeq.get(app) !== n || !app.rendered || !portraitParallaxActive()) return;
    v = new PortraitView(app, doc, info);
    views.set(app, v);
    v.bind(img, root ?? app.element);
    v.load();
  } else v.bind(img, root ?? app.element);
}

function openActorSheets() {
  const out = new Set();
  for (const app of foundry.applications.instances?.values?.() ?? []) if (app.rendered && isActorSheet(app, false)) out.add(app);
  for (const app of Object.values(ui.windows ?? {})) if (app?.rendered && app.document?.documentName === "Actor") out.add(app);
  return out;
}

/** Re-check every open actor sheet (index changed, setting toggled, reduced-motion changed). */
export function refreshPortraits() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!portraitParallaxActive()) { dropAll(); return; }
    for (const app of openActorSheets()) attach(app, app.element instanceof HTMLElement ? app.element : app.element?.[0]).catch((e) => console.warn(`${MODULE_ID} | portrait parallax`, e));
  }, 60);
}

// ------------------------------------------------------------------ header control (GM)

const realImage = (img) => !!img && !/^icons\/svg\//.test(img) && !/\.svg$/i.test(img);

function openDepthFor(doc) {
  if (!game.user.isGM || !realImage(doc?.img)) return;
  const typeKey = `${game.system.id}.${doc.documentName}.${doc.type}`;
  import("../depth/depth-app.mjs").then((m) => m.DepthApp.open({ path: doc.img, typeKey }));
}

// ------------------------------------------------------------------ registration

let registered = false;
export function registerPortraitParallax() {
  if (registered) return;
  registered = true;
  Hooks.on("renderApplicationV2", (app, el) => {
    if (!isActorSheet(app, false)) return;
    attach(app, rootOf(app, el)).catch((e) => console.warn(`${MODULE_ID} | portrait parallax`, e));
  });
  Hooks.on("renderDocumentSheet", (app, html) => {
    if (!isActorSheet(app, true)) return;
    attach(app, rootOf(app, html)).catch((e) => console.warn(`${MODULE_ID} | portrait parallax`, e));
  });
  Hooks.on("closeApplicationV2", (app) => drop(app));
  Hooks.on("closeDocumentSheet", (app) => drop(app));
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    if (!game.user.isGM || !isActorSheet(app, false) || !realImage(app.document.img) || !Array.isArray(controls)) return;
    if (controls.some((c) => c.action === "aiimgPortraitDepth")) return;
    controls.push({ action: "aiimgPortraitDepth", icon: "fa-solid fa-layer-group", label: "AIIMG.PortraitParallax.Generate", onClick: () => openDepthFor(app.document) });
  });
  Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
    if (!game.user.isGM || !realImage(app.document?.img) || !Array.isArray(buttons)) return;
    buttons.unshift({ label: "AIIMG.PortraitParallax.Generate", class: "aiimg-portrait-depth", icon: "fa-solid fa-layer-group", onclick: () => openDepthFor(app.document) });
  });
  depthIndex.onChange(() => refreshPortraits());
  try { globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", () => { fxNow = null; refreshPortraits(); }); } catch { /* old engine */ }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { for (const v of views.values()) v.dirty = true; kick(); } });
}

/** World setting (init, from settings.mjs). */
export function registerPortraitSetting() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "AIIMG.PortraitParallax.Setting.Name",
    hint: "AIIMG.PortraitParallax.Setting.Hint",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.BooleanField({ initial: true }),
    onChange: () => { if (settingOn()) { disabled = disabled === "nogl" ? disabled : ""; guard.reset(); } refreshPortraits(); }
  });
  registerFxSettings("portrait", () => { fxNow = null; for (const v of views.values()) v.dirty = true; kick(); });
}

/**
 * W6-P: the viewer's extras (client scope: each viewer decides what their own screen / GPU does), registered right
 * after the target's parallax settings so they sit next to them in Configure Settings. Shared with token-parallax.mjs.
 */
export function registerFxSettings(target, onChange) {
  const D = FX_DEFAULTS[target];
  const T = target === "token" ? "Token" : "Portrait";
  for (const k of FX_KEYS) {
    const L = `AIIMG.ParallaxFx.${T}.${k[0].toUpperCase()}${k.slice(1)}`;
    const type = k.endsWith("Strength")
      ? new foundry.data.fields.NumberField({ initial: D[k], min: FX_RANGES[k][0], max: FX_RANGES[k][1], step: FX_RANGES[k][2], nullable: false })
      : new foundry.data.fields.BooleanField({ initial: D[k] });
    game.settings.register(MODULE_ID, fxSettingKey(target, k), { name: `${L}.Name`, hint: `${L}.Hint`, scope: "client", config: true, type, onChange });
  }
}

/** For macros / checks: `api.parallax.portraits`. */
export const portraitApi = {
  status: () => ({
    active: portraitParallaxActive(), setting: settingOn(), disabled, reducedMotion: reducedMotion(), fx: { ...portraitFx() },
    context: !!host?.gl && !host.gl.lost, running: !!host?.raf, guard: guard.state(),
    views: [...views.values()].map((v) => v.report())
  }),
  refresh: () => refreshPortraits(),
  /** Override view settings of the open portraits (parallax-core view schema; this page, until they re-open). */
  setView: (partial = {}) => {
    for (const v of views.values()) {
      v.view = normalizeView({ ...v.view, ...partial, on: { ...v.view.on, ...(partial.on ?? {}) } }, v.view);
      if ("dilate" in partial || "normalBlur" in partial) v.upload();
      v.dirty = true;
    }
    kick();
    return [...views.values()].map((v) => structuredClone(v.view));
  },
  /** Turn the feature back on after the slow-frame guard switched it off (this page). */
  resume: () => { if (disabled === "slow") disabled = ""; guard.reset(); refreshPortraits(); },
  /** Draw every view now (outside the loop; checks in a throttled tab). Optional fixed look for all. */
  drawNow: (look = null) => {
    let n = 0;
    for (const v of views.values()) {
      if (v.status !== "ready" || !host?.gl) continue;
      if (look) { v.look = { x: Number(look.x) || 0, y: Number(look.y) || 0 }; v.drawnLook = null; }
      if (v.draw()) n++;
    }
    return n;
  },
  /** Synchronous GPU-bound timing of one view (readPixels after each draw). */
  benchmark: (frames = 60) => {
    const v = [...views.values()].find((x) => x.status === "ready");
    if (!v || !host?.gl) return null;
    const times = [];
    for (let i = 0; i < frames; i++) {
      const s = performance.now();
      v.look = { x: Math.sin(i / 7), y: Math.cos(i / 11) * 0.4 };
      v.draw();
      host.gl.finish();
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    return { avgMs: Math.round((times.reduce((s, x) => s + x, 0) / times.length) * 100) / 100, p95Ms: Math.round(times[Math.floor(times.length * 0.95)] * 100) / 100, canvas: [v.canvas.width, v.canvas.height] };
  }
};
