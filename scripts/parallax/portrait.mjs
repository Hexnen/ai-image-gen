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
// - W6-T: smooth for ALL effects: tilt, light / rim, dust, breathing amplitude and the overlay's opacity are critically
//   damped springs stepped by the elapsed time (portrait-core stepMotion): entering / leaving the picture never jumps;
//   on leave everything eases to rest and only then the canvas fades out, hides and the loop stops. Draws ~60 / s while
//   anything eases, ~30 / s for idle breathing / dust only. The pointer target fades out smoothly beyond the picture.
// - W6-T: the depth map is decoded, downscaled (≤ 1024 px) and conditioned in a worker (no main-thread long task); the
//   picture + map textures are shared by every sheet showing the same image (and kept, with the context, for a few
//   seconds after the last sheet closes). The frame guard judges the module's OWN cost (CPU + GPU timer query, or an
//   on / off comparison), not the page frame rate alone. A sheet in a v14 detached window uses that window's viewport,
//   animation frames and visibility.
// - GM: "Generate depth" in the sheet's header controls opens the depth window on the portrait (its own estimate +
//   confirmation before every paid call). The finished map lands in the index and every client's open sheet picks it up.
import { MODULE_ID } from "../constants.mjs";
import { FX_DEFAULTS, FX_KEYS, FX_RANGES, FX_DEVICE_OFF_KEY, fxSettingKey, normalizeFx, effectiveFx, breathLook } from "./parallax-fx.mjs";
import { depthIndex, normalizeImagePath } from "../depth/depth-index.mjs";
import { offsetFor, overscanFor, stepsFor, backingSize, normalizeView } from "./parallax-core.mjs";
import {
  placementFor, panelPixels, portraitView, effectAmount, portraitTextureSide, sameImage, cssBoxFor, OVERLAY_STYLE, cropForLook,
  pointerTarget, createMotion, stepMotion, MOTION, MOVE_FRAME_MS, IDLE_DRAW_MS, createCostGuard
} from "./portrait-core.mjs";

export const SETTING = "portraitParallax";

/** Portrait selectors, most certain first (same family as the sheet buttons). */
const SELECTORS = ['img[data-edit="img"]', "img.profile-img", ".profile-img img", "img.document-image", "img.actor-img", "img.portrait"];

const views = new Map();    // app -> PortraitView
const attachSeq = new WeakMap();
let host = null;            // {canvas, gl, raf, win, lastT, clock, prev, gpuMs, timing, linger}
let hostPromise = null;
const assets = new Map();   // W6-T: shared picture + map textures by image / map / revision / conditioning
const LINGER_MS = 10000;    // W6-T: context + textures kept this long after the last view closed
const DEPTH_SIDE = 1024;    // W6-T: longest side of the conditioned depth map (the depth is smooth)
const counters = { contexts: 0, builds: 0 };
let trace = null;           // W6-T: per-frame motion series for checks (api.parallax.portraits.trace)
let debugDrawCostMs = 0;    // W6-T: simulated draw cost (api, guard checks only)
let disabled = "";          // "", "slow", "nogl" (this page only)
let notified = false;
let refreshTimer = 0;
let seq = 0;
const guard = createCostGuard();
let fxNow = null;           // W6-P: effective extras (breathing / light / dust) on this client

/** W6-Q: this device opted out of breathing / light / dust (the one client setting). */
export function fxDeviceOff() {
  try { return game.settings.get(MODULE_ID, FX_DEVICE_OFF_KEY) === true; } catch { return false; }
}

/** W6-P: the extras for portraits (W6-Q: world settings set by the GM), after the reduced-motion and device rules. */
export function portraitFx() {
  if (!fxNow) {
    const raw = {};
    for (const k of FX_KEYS) { try { raw[k] = game.settings.get(MODULE_ID, fxSettingKey("portrait", k)); } catch { /* not registered */ } }
    fxNow = effectiveFx(normalizeFx(raw, "portrait"), { reducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false, deviceOff: fxDeviceOff() });
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

/** W6-T: the window an element lives in (a v14 detached sheet has its own window: viewport, rAF, visibility). */
const winOf = (el) => el?.ownerDocument?.defaultView ?? globalThis;

function ensureHost() {
  if (host) { clearTimeout(host.linger); host.linger = 0; return host; }
  if (disabled) return null;
  if (hostPromise) return hostPromise;
  const canvas = document.createElement("canvas");
  canvas.width = 2; canvas.height = 2;
  hostPromise = import("./parallax-gl.mjs").then(({ ParallaxRenderer }) => {
    hostPromise = null;
    if (host) return host;
    let gl = null;
    try { gl = ParallaxRenderer.create(canvas, { alpha: true, premultipliedAlpha: false }); }
    catch (e) { console.warn(`${MODULE_ID} | portrait parallax: WebGL2 renderer failed`, e); }
    if (!gl) { disabled = "nogl"; dropAll(); return null; }
    counters.contexts++;
    host = { canvas, gl, raf: 0, win: null, lastT: 0, clock: 0, prev: null, gpuMs: null, timing: false, linger: 0 };
    canvas.addEventListener("webglcontextlost", (ev) => { ev.preventDefault(); if (host?.gl) host.gl.lost = true; });
    canvas.addEventListener("webglcontextrestored", () => restoreContext());
    return host;
  });
  return hostPromise;
}

function restoreContext() {
  if (!host) return;
  import("./parallax-gl.mjs").then(({ ParallaxRenderer }) => {
    try { host.gl = ParallaxRenderer.create(host.canvas, { alpha: true, premultipliedAlpha: false }); } catch { host.gl = null; }
    if (!host.gl) { disabled = "nogl"; dropAll(); return; }
    for (const a of assets.values()) { a.uploaded = false; uploadAsset(a); }
    for (const v of views.values()) v.dirty = true;
    kick();
  });
}

function destroyHost() {
  for (const a of [...assets.values()]) dropAsset(a);
  if (!host) return;
  clearTimeout(host.linger);
  try { if (host.raf) (host.win ?? globalThis).cancelAnimationFrame(host.raf); } catch { /* window gone */ }
  try { host.gl?.destroy(); } catch { /* lost already */ }
  host.canvas.width = host.canvas.height = 1;
  host = null;
}

/**
 * W6-T: the last view closed: keep the context, the shader and the textures for a few seconds (a re-render / reopen /
 * the next sheet of the same picture then costs nothing), then free everything.
 */
function lingerHost() {
  if (!host || views.size) return;
  clearTimeout(host.linger);
  host.linger = setTimeout(() => { if (host && !views.size) destroyHost(); }, LINGER_MS);
}

// ------------------------------------------------------------------ shared picture + map per image (W6-T)

/** One upload per picture / map / revision / conditioning: sheets of the same image share textures. */
function assetKey(info, view) {
  return JSON.stringify([info.image, info.depth, info.rev || 0, info.format ?? null, info.sidecar ? 1 : 0, view.dilate, view.normalBlur]);
}

function acquireAsset(info, view) {
  const key = assetKey(info, view);
  let a = assets.get(key);
  if (!a) {
    const id = ++seq;
    a = { key, id, imgKey: `pi${id}`, depKey: `pd${id}`, refs: 0, timer: 0, status: "loading", error: "", tex: null, depthSize: null, bitmap: null, cond: null, uploaded: false, timing: null, dropped: false };
    assets.set(key, a);
    a.promise = buildAsset(a, info, view);
  }
  a.refs++;
  clearTimeout(a.timer); a.timer = 0;
  return a;
}

async function buildAsset(a, info, view) {
  const t0 = performance.now();
  try {
    const L = await import("./parallax-load.mjs");
    const rev = info.rev || null;
    // W6-Q: natural resolution (capped by MAX_TEXTURE_SIZE / 4096 only)
    const side = portraitTextureSide(0, 0, host?.gl?.maxTextureSize ?? 0);
    const [pr, dr] = await Promise.allSettled([
      L.loadPortrait(info.image, { maxSide: side, colorManaged: true, rev }),
      // W6-T: decode + downscale (≤ DEPTH_SIDE) + condition in the depth worker: no main-thread long task
      L.loadDepthConditioned({ path: info.depth, format: info.format, sidecar: info.sidecar, rev }, { maxSide: DEPTH_SIDE, condition: { dilatePx: view.dilate, normalBlurPx: view.normalBlur }, half: true })
    ]);
    if (pr.status === "rejected" || dr.status === "rejected") {
      if (pr.status === "fulfilled") pr.value.bitmap?.close?.();
      const e = dr.status === "rejected" ? dr.reason : pr.reason;
      if (dr.status === "rejected" && (dr.reason?.status === 404 || dr.reason?.status === 403)) depthIndex.reportMissing(info.image);
      throw e;
    }
    const p = pr.value, d = dr.value;
    if (a.dropped) { p.bitmap?.close?.(); return a; }
    a.bitmap = p.bitmap;
    a.tex = { w: p.w, h: p.h, natural: p.natural };
    a.cond = d.cond;
    a.depthSize = [d.w, d.h];
    const tU = performance.now();
    uploadAsset(a);
    a.timing = { totalMs: Math.round(performance.now() - t0), uploadMs: Math.round((performance.now() - tU) * 10) / 10, depthFetchMs: d.fetchMs ?? null, workerMs: d.ms ?? null, depthBytes: d.bytes ?? null };
    a.status = "ready";
    counters.builds++;
  } catch (e) {
    a.status = "error";
    a.error = String(e?.message ?? e);
    a.code = e?.code ?? (e?.status ? `http-${e.status}` : null);
    console.warn(`${MODULE_ID} | portrait parallax: ${info.image}`, e);
    if (assets.get(a.key) === a) assets.delete(a.key);   // a later attach tries again
  }
  return a;
}

function uploadAsset(a) {
  if (!host?.gl || host.gl.lost || !a.bitmap || !a.cond || a.uploaded) return;
  host.gl.setImage(a.bitmap, a.imgKey);
  host.gl.setDepth(a.depKey, { half: a.cond.half, rgba: a.cond.rgba, w: a.cond.w, h: a.cond.h });
  a.uploaded = true;
}

function releaseAsset(a) {
  if (!a) return;
  a.refs = Math.max(0, a.refs - 1);
  if (a.refs > 0) return;
  clearTimeout(a.timer);
  a.timer = setTimeout(() => { if (a.refs === 0) dropAsset(a); }, LINGER_MS);
}

function dropAsset(a) {
  clearTimeout(a.timer);
  a.dropped = true;
  if (assets.get(a.key) === a) assets.delete(a.key);
  if (host?.gl && !host.gl.lost) { try { host.gl.dropImage(a.imgKey); host.gl.dropDepth(a.depKey); } catch { /* lost */ } }
  a.bitmap?.close?.();
  a.bitmap = null;
  a.cond = null;
  a.uploaded = false;
}

// ------------------------------------------------------------------ the frame loop

/** The window whose animation frames drive the loop: the main one when it shows a view, else a detached one. */
function loopWin() {
  let w = null;
  for (const v of views.values()) {
    const vw = v.win;
    if (!vw || vw.closed || vw.document?.hidden) continue;
    if (vw === globalThis) return vw;
    w ??= vw;
  }
  return w;
}

/** rAF time of window W on the main window's clock (a detached window has its own time origin). */
function mainClock(t, W) {
  if (!W || W === globalThis) return t;
  const a = W.performance?.timeOrigin, b = globalThis.performance?.timeOrigin;
  return Number.isFinite(a) && Number.isFinite(b) ? t + (a - b) : performance.now();
}

function kick() {
  if (!host || !views.size) return;
  const W = loopWin();
  if (!W) return;
  if (host.raf) {
    if (host.win === W && performance.now() - host.lastT < 1000) return;
    try { (host.win ?? globalThis).cancelAnimationFrame(host.raf); } catch { /* window gone */ }  // a request that never ran
    host.raf = 0;
  }
  host.win = W;
  host.lastT = performance.now();
  host.prev = null;
  host.raf = W.requestAnimationFrame(frame);
}

function frame(tRaf) {
  if (!host) return;
  host.raf = 0;
  if (!host.gl || host.gl.lost) return;
  const t = mainClock(tRaf, host.win);
  const gap = t - host.lastT;
  const dt = Math.min(0.1, Math.max(0, gap / 1000));
  host.lastT = t;
  for (const ms of host.gl.timerPoll()) host.gpuMs = host.gpuMs === null ? ms : host.gpuMs * 0.7 + ms * 0.3;
  // W6-T guard: this frame's gap follows the previous frame's draw (or its skipped draw while comparing on / off)
  if (host.prev) {
    const prev = host.prev;
    host.prev = null;
    const verdict = prev.probe ? guard.probeSample(gap, t) : guard.sample({ tMs: t, gapMs: gap, cpuMs: prev.cpu, gpuMs: prev.gpu });
    if (verdict === "bad") { tooSlow(); return; }
  }
  const probing = guard.probing;
  const step = probing ? 0 : dt;
  host.clock += step * 1000;                     // the motion clock (breathing, dust) pauses while the guard compares
  let busy = false, drew = false, active = false;
  const t0 = performance.now();
  for (const v of views.values()) {
    const r = v.step(t, step, host.clock, probing);
    busy ||= r.busy;
    drew ||= r.drew;
    active ||= r.active;
  }
  if (host.timing) { host.gl.timerEnd(); host.timing = false; }
  const cpu = performance.now() - t0;
  if (drew) host.prev = { cpu, gpu: host.gl.timerSupported ? host.gpuMs : null };
  else if (probing && active) host.prev = { probe: true };
  if (trace) traceRow(t, gap, drew, probing);
  if (busy || (probing && active)) {
    const W = loopWin();
    if (W) { host.win = W; host.raf = W.requestAnimationFrame(frame); }
  }
}

function traceRow(t, gap, drew, probing) {
  const v = views.values().next().value;
  if (!v || trace.rows.length >= trace.max) return;
  const M = v.motion;
  trace.rows.push({
    t: Math.round(t * 100) / 100, gap: Math.round(gap * 100) / 100, drew: drew && v.lastDrawT === t, probing,
    lx: M.look.x, ly: M.look.y, op: M.opacity, light: M.light, dust: M.dust, breath: M.breath, inside: v.inside,
    shown: v.canvas.style.visibility !== "hidden", cssOpacity: Number(v.canvas.style.opacity || 0),
    lightU: v.lastU?.light ?? 0, rimU: v.lastU?.rim ?? 0, dustU: v.lastU?.dust ?? 0
  });
}

function tooSlow() {
  disabled = "slow";
  const st = guard.state();
  console.warn(`${MODULE_ID} | portrait parallax turned off on this page: its own frame cost was too high`, st);
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
    this.asset = null;
    this.img = null;
    this.root = null;
    this.win = null;
    this.#makeCanvas(document);
    this.view = portraitView(null);
    this.motion = createMotion();
    this.pointer = { x: 0, y: 0, k: 0 };
    this.inside = false;
    this.visible = true;
    this.dirty = true;
    this.layoutUntil = 0;
    this.drawnSig = null;
    this.lastDrawT = -1e9;
    this.lastU = null;
    this.place = null;
    this.style = null;
    this.clipEls = [];
    this.unbind = [];
    this.scrollUnbind = [];
    this.ro = null;
    this.roParent = null;      // the offsetParent the ResizeObserver watches (found only once the picture is shown)
    this.settleTimer = 0;
    this.destroyed = false;
    this.draws = 0;
    this.openT = performance.now();
    this.readyMs = null;
  }

  get status() { return this.asset?.status ?? "loading"; }
  get error() { return this.asset?.error ?? ""; }

  #makeCanvas(doc) {
    const old = this.canvas;
    this.canvas = doc.createElement("canvas");
    this.canvas.className = "aiimg-portrait-plx";
    this.canvas.setAttribute("aria-hidden", "true");
    // W6-Q: positioning inline (+ important): never depends on styles/parallax.css being loaded / current
    for (const [k, val] of Object.entries(OVERLAY_STYLE)) this.canvas.style.setProperty(k, val, "important");
    this.canvas.style.visibility = "hidden";
    this.ctx = this.canvas.getContext("2d");
    if (old) { old.remove(); old.width = old.height = 0; }
  }

  /** Attach to (a new) <img> of the sheet. W6-T: also when the sheet moved to another (detached) window. */
  bind(img, root) {
    const win = winOf(img);
    if (this.img === img && this.root === root && this.win === win && this.canvas.isConnected) { this.relayout(); return; }
    this.#unbindAll();
    this.img = img;
    this.root = root;
    this.win = win;
    if (this.canvas.ownerDocument !== img.ownerDocument) this.#makeCanvas(img.ownerDocument);
    img.after(this.canvas);
    this.#readStyle();
    // W6-Q: every layout trigger also re-places the canvas right away (no frame needed: a hidden / throttled page has
    // no animation frames) and once more when transitions are over
    const dirty = () => this.relayout();
    const on = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); this.unbind.push(() => el.removeEventListener(type, fn, opt)); };
    // W6-T: the pointer target fades out smoothly beyond the picture's edge; leaving the sheet / the window = away
    on(root, "pointermove", (ev) => {
      if (!this.place) return;
      this.pointer = pointerTarget(ev.clientX, ev.clientY, this.place.drawn);
      this.inside = this.pointer.k > 0;
      kick();
    }, { passive: true });
    const away = () => { if (!this.inside) return; this.inside = false; kick(); };
    on(root, "pointerleave", away, { passive: true });
    on(win, "blur", away);
    on(win.document, "visibilitychange", () => { if (!win.document.hidden) { this.dirty = true; kick(); } });
    on(img, "load", () => { this.#readStyle(); dirty(); });
    on(root, "transitionend", dirty, { passive: true });
    on(root, "animationend", dirty, { passive: true });
    on(win, "resize", dirty, { passive: true });
    const appEl = this.app.element instanceof HTMLElement || this.app.element?.nodeType === 1 ? this.app.element : root;
    const RO = win.ResizeObserver ?? globalThis.ResizeObserver;
    if (typeof RO === "function") {
      const ro = new RO(() => { this.#readStyle(); dirty(); });
      this.ro = ro;
      for (const el of new Set([img, img.parentElement, appEl].filter(Boolean))) ro.observe(el);
      this.unbind.push(() => { ro.disconnect(); if (this.ro === ro) { this.ro = null; this.roParent = null; } });
    }
    const IO = win.IntersectionObserver ?? globalThis.IntersectionObserver;
    if (typeof IO === "function") {
      // a tab switch (display: none <-> shown) lands here in both directions
      const io = new IO((ents) => {
        const last = ents[ents.length - 1];
        this.visible = !!last?.isIntersecting;
        if (this.visible) dirty();
        else if (!(last?.boundingClientRect?.width > 1)) this.#hide(); // hidden (no box), not just scrolled away
      });
      io.observe(img);
      this.unbind.push(() => io.disconnect());
    }
    const MO = win.MutationObserver ?? globalThis.MutationObserver;
    // the window moving / scaling / minimising (style + class of the app element), other modules' CSS variables on it
    const mo = new MO(dirty);
    mo.observe(appEl, { attributes: true, attributeFilter: ["style", "class"] });
    this.unbind.push(() => mo.disconnect());
    // tab switches toggle classes inside the sheet (the picture's own box may keep its size)
    const mo2 = new MO(dirty);
    mo2.observe(root, { attributes: true, attributeFilter: ["class", "hidden"], subtree: true });
    this.unbind.push(() => mo2.disconnect());
    // the picture's own style / class / src (object-fit, border, a new image) may change without resizing its box
    const mo3 = new MO(() => { this.#readStyle(); dirty(); });
    mo3.observe(img, { attributes: true, attributeFilter: ["style", "class", "src"] });
    this.unbind.push(() => mo3.disconnect());
    this.unbind.push(() => { clearTimeout(this.settleTimer); this.settleTimer = 0; });
    dirty();
  }

  /**
   * W6-Q: layout changed: re-place the canvas now (synchronously, in the observer / event that saw the change), mark it
   * for a redraw, run the loop briefly, and re-place once more after transitions (window minimise / restore, fades).
   */
  relayout() {
    if (this.destroyed) return;
    // W6-T: the sheet was moved into a detached window (Foundry adopts the element): bind again in that window
    if (this.img && this.win && winOf(this.img) !== this.win) { this.bind(this.img, this.root); return; }
    this.layoutUntil = performance.now() + 450;
    this.dirty = true;
    this.reposition();
    kick();
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settleTimer = 0; if (!this.destroyed) { this.reposition(); this.dirty = true; kick(); } }, 500);
  }

  /** W6-Q: place / size the canvas over the picture without drawing (a hidden picture = canvas hidden, nothing drawn). */
  reposition() {
    if (this.destroyed) return null;
    const p = this.#placement();
    if (!p) { this.place = null; this.#hide(); return null; }
    const before = [this.canvas.width, this.canvas.height];
    const b = this.#applyPlacement(p);
    if (!b) { this.place = null; this.#hide(); return null; }
    this.place = p;
    // a changed backing store is cleared until the next draw: keep it hidden (the plain <img> shows) till then
    if (before[0] !== this.canvas.width || before[1] !== this.canvas.height) { this.dirty = true; this.#hide(); }
    return p;
  }

  #hide() { this.canvas.style.visibility = "hidden"; }

  #readStyle() {
    const img = this.img;
    if (!img) return;
    const win = this.win ?? globalThis;
    const cs = win.getComputedStyle(img);
    const px = (v) => parseFloat(v) || 0;
    this.style = {
      fit: cs.objectFit || "fill", position: cs.objectPosition || "50% 50%", radius: cs.borderRadius,
      l: px(cs.borderLeftWidth) + px(cs.paddingLeft), r: px(cs.borderRightWidth) + px(cs.paddingRight),
      t: px(cs.borderTopWidth) + px(cs.paddingTop), b: px(cs.borderBottomWidth) + px(cs.paddingBottom)
    };
    // ancestors that clip their content (overflow other than visible), up to the sheet's root
    const clips = [];
    const body = img.ownerDocument?.body;
    for (let el = img.parentElement; el && el !== body; el = el.parentElement) {
      const s = win.getComputedStyle(el);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") clips.push(el);
      if (el === this.root) break;
    }
    this.clipEls = clips;
    // scrolling containers move the picture without resizing anything (re-bound when the clipping ancestors change)
    for (const f of this.scrollUnbind.splice(0)) f();
    const fn = () => this.relayout();
    for (const el of clips) { el.addEventListener("scroll", fn, { passive: true }); this.scrollUnbind.push(() => el.removeEventListener("scroll", fn)); }
  }

  #unbindAll() {
    for (const f of [...this.unbind.splice(0), ...this.scrollUnbind.splice(0)]) { try { f(); } catch { /* gone */ } }
  }

  /** Load (or share) the picture and its conditioned map. */
  async load() {
    try {
      const vp = await typeParallaxOf(this.doc);
      if (this.destroyed) return;
      this.view = portraitView(vp);
      const a = acquireAsset(this.info, this.view);
      this.asset = a;
      await a.promise;
      if (this.destroyed || this.asset !== a) return;
      if (a.status !== "ready") { this.#hide(); return; }
      uploadAsset(a);
      this.readyMs = Math.round(performance.now() - this.openT);
      this.dirty = true;
      kick();
    } catch (e) {
      console.warn(`${MODULE_ID} | portrait parallax: ${this.imagePath}`, e);
      this.#hide();
    }
  }

  /** setView changed dilate / normal blur: a differently conditioned map (its own shared asset). */
  recondition() {
    const old = this.asset;
    this.asset = acquireAsset(this.info, this.view);
    releaseAsset(old);
    this.asset.promise.then((a) => { if (!this.destroyed && this.asset === a && a.status === "ready") { uploadAsset(a); this.dirty = true; kick(); } });
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
    // W6-T: the viewport of the window the sheet is in (a detached window has its own)
    const win = this.win ?? globalThis;
    clips.push({ x: 0, y: 0, w: win.innerWidth || 1e5, h: win.innerHeight || 1e5 });
    const tex = this.asset?.tex;
    const natW = tex?.natural?.w || img.naturalWidth || tex?.w, natH = tex?.natural?.h || img.naturalHeight || tex?.h;
    const p = placementFor({ content, natW, natH, fit: st.fit, position: st.position, clips });
    if (p) p.content = content;
    return p;
  }

  #applyPlacement(p) {
    const cv = this.canvas;
    if (cv.style.getPropertyValue("position") !== "absolute") cv.style.setProperty("position", "absolute", "important");
    const op = cv.offsetParent;
    if (!op) return null;
    // W6-Q: the containing block is known only while the picture is shown: watch its size from then on
    if (this.ro && this.roParent !== op) { if (this.roParent) this.ro.unobserve(this.roParent); this.ro.observe(op); this.roParent = op; }
    const css = cssBoxFor(p.visible, {
      rect: op.getBoundingClientRect(), offsetWidth: op.offsetWidth, offsetHeight: op.offsetHeight,
      clientLeft: op.clientLeft, clientTop: op.clientTop, scrollLeft: op.scrollLeft, scrollTop: op.scrollTop
    });
    if (!css) return null;
    const s = cv.style;
    s.setProperty("left", `${css.left}px`, "important"); s.setProperty("top", `${css.top}px`, "important");
    s.setProperty("width", `${css.width}px`, "important"); s.setProperty("height", `${css.height}px`, "important");
    const whole = Math.abs(p.visible.w - p.content.w) < 1 && Math.abs(p.visible.h - p.content.h) < 1;
    s.setProperty("border-radius", whole ? this.style.radius : "0", "important");
    const b = backingSize(p.visible.w, p.visible.h, (this.win ?? globalThis).devicePixelRatio ?? 1, { cap: 4, maxPixels: 8.3e6 });
    if (cv.width !== b.w || cv.height !== b.h) { cv.width = b.w; cv.height = b.h; }
    return b;
  }

  /**
   * One frame (W6-T). Advances the motion by `dt` (springs: tilt, light, dust, breathing, opacity), then draws at most
   * ~60 / s while anything eases or follows the pointer and ~30 / s for pure idle breathing / dust. At rest without
   * extras the canvas hides only after everything has faded to 0 (no pop). `probing` = the frame guard compares the
   * page without our draws: nothing is drawn (motion paused by the caller).
   * @returns {{busy:boolean, drew:boolean, active:boolean}}
   */
  step(t, dt, clock, probing = false) {
    const none = { busy: false, drew: false, active: false };
    if (this.destroyed || this.status !== "ready" || !host?.gl) return none;
    if (this.img && this.win && winOf(this.img) !== this.win) this.bind(this.img, this.root);
    if (!this.img?.isConnected || !this.app.rendered || this.app.minimized || !this.visible || this.win?.document?.hidden) return none;
    const fx = portraitFx();
    const M = this.motion;
    const m = stepMotion(M, dt, {
      pointer: this.inside ? this.pointer : null,
      breathLook: fx.breath ? breathLook(clock, 1) : null,
      breath: fx.breath ? fx.breathStrength : 0,
      light: fx.light ? fx.lightStrength : 0,
      dust: fx.dust ? fx.dustStrength : 0,
      animates: fx.animates
    });
    const layout = t < this.layoutUntil;
    const busy = !m.settled || layout || fx.animates;
    if (m.settled) {
      // fully at rest, no extras: the plain <img> shows (the canvas faded to 0 before this)
      if (layout || this.dirty) this.reposition();
      this.#hide();
      this.dirty = false;
      this.drawnSig = null;
      return { busy, drew: false, active: false };
    }
    if (probing) return { busy, drew: false, active: true };
    const q = (x) => Math.round(x * 1e4);
    const sig = `${q(M.look.x)},${q(M.look.y)},${q(M.light)},${q(M.dust)},${q(M.opacity)}`;
    if (sig === this.drawnSig && !layout && !this.dirty && !(M.dust > 0.001)) return { busy, drew: false, active: true };
    const minGap = m.idle && !layout && !this.dirty ? IDLE_DRAW_MS : MOVE_FRAME_MS;
    if (t - this.lastDrawT < minGap - 0.5) return { busy, drew: false, active: true };
    const ok = this.draw(clock);
    if (ok) { this.lastDrawT = t; this.drawnSig = sig; }
    return { busy, drew: ok, active: true };
  }

  draw(clock = host?.clock ?? 0) {
    const a = this.asset;
    if (!a?.uploaded || !host?.gl) return false;
    const p = this.#placement();
    this.place = p;
    if (!p) { this.#hide(); return false; }
    const b = this.#applyPlacement(p);
    if (!b) { this.#hide(); return false; }
    const g = host.gl, hc = host.canvas;
    if (hc.width < b.w || hc.height < b.h) { hc.width = Math.max(hc.width, b.w); hc.height = Math.max(hc.height, b.h); }
    const v = this.view, tw = a.tex.w, th = a.tex.h, M = this.motion, look = M.look;
    if (!host.timing) { g.timerBegin(); host.timing = true; }
    // W6-T: light / rim / dust amounts are the eased motion values (no switching on / off between frames)
    const u = {
      light: v.on.light ? effectAmount(v.light * M.light, look) : 0,
      rim: v.on.rim ? effectAmount(v.rim * M.light, look) : 0,
      dust: M.dust > 0.001 ? M.dust : 0
    };
    // the panel sits at the top-left of the shared canvas (the renderer's panels are y-down from the top)
    g.draw([{ key: a.depKey, image: a.imgKey, x: 0, y: 0, w: b.w, h: b.h }], {
      off: offsetFor(look, v.strength, tw, th), crop: cropForLook(overscanFor(v.strength, v.focus, tw, th), look), look,
      bg: [0, 0, 0], focus: v.focus, gamma: v.gamma, contrast: v.contrast,
      light: u.light, rim: u.rim, dust: u.dust, vignette: 0, holeFill: v.on.holeFill ? 1 : 0, time: clock / 1000, relief: 10, view: 0, alphaOut: 1,
      rectFor: () => p.panel,
      stepsFor: (d) => stepsFor(offsetFor({ x: 1, y: 0 }, v.strength, tw, th), d.w, d.h)
    });
    if (debugDrawCostMs > 0) { const e = performance.now() + debugDrawCostMs; while (performance.now() < e) { /* simulated cost (api) */ } }
    const px = panelPixels(p.panel, b.w, b.h);
    this.ctx.clearRect(0, 0, b.w, b.h);
    if (px.w > 0 && px.h > 0) this.ctx.drawImage(hc, px.x, px.y, px.w, px.h, px.x, px.y, px.w, px.h);
    // W6-T: the opacity is a spring too (fade in on tilt / open, fade out on return; never a one-frame pop)
    const op = M.opacity;
    this.canvas.style.setProperty("opacity", String(Math.round(op * 1000) / 1000), "important");
    this.canvas.style.visibility = op >= MOTION.hideBelow ? "" : "hidden";
    this.lastU = u;
    this.dirty = false;
    this.draws++;
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.#unbindAll();
    this.canvas.remove();
    this.canvas.width = this.canvas.height = 0;
    releaseAsset(this.asset);
    this.asset = null;
  }

  report() {
    const a = this.asset;
    return {
      actor: this.doc?.uuid, image: this.imagePath, depth: this.info.depth, format: this.info.format, rev: this.info.rev ?? null, status: this.status, error: this.error,
      texture: a?.tex ? [a.tex.w, a.tex.h] : null, depthSize: a?.depthSize ?? null, shared: a ? a.refs : 0, asset: a?.id ?? null, readyMs: this.readyMs, timing: a?.timing ?? null,
      canvas: [this.canvas.width, this.canvas.height], placed: !!this.place, shown: this.canvas.style.visibility !== "hidden", opacity: Number(this.canvas.style.opacity || 0), visible: this.visible, inside: this.inside,
      look: { ...this.motion.look }, motion: { opacity: this.motion.opacity, light: this.motion.light, dust: this.motion.dust, breath: this.motion.breath },
      draws: this.draws, bound: !!this.img?.isConnected && this.canvas.isConnected, detached: !!this.win && this.win !== globalThis
    };
  }
}

// ------------------------------------------------------------------ attach / detach

function drop(app) {
  const v = views.get(app);
  if (!v) return;
  v.destroy();
  views.delete(app);
  if (!views.size) lingerHost();
}

function dropAll() {
  for (const app of [...views.keys()]) drop(app);
  if (disabled) destroyHost();
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
  // W6-T: a new revision of the map (depth index `rev`) = a new view (and a new shared asset)
  if (v && (v.imagePath !== info.image || v.info.depth !== info.depth || (v.info.rev || 0) !== (info.rev || 0) || v.status === "error")) { drop(app); v = null; }
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
    if (!portraitParallaxActive()) { dropAll(); destroyHost(); return; }
    for (const app of openActorSheets()) attach(app, app.element instanceof HTMLElement || app.element?.nodeType === 1 ? app.element : app.element?.[0]).catch((e) => console.warn(`${MODULE_ID} | portrait parallax`, e));
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { for (const v of views.values()) v.dirty = true; kick(); } else kick(); });
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
 * W6-P extras, registered right after the target's parallax settings so they sit next to them in Configure Settings.
 * Shared with token-parallax.mjs. W6-Q: WORLD scope (the GM sets them for all players; onChange runs on every client,
 * so open views update live), plus ONE client setting registered after the token extras: "no extras on this device".
 */
const fxListeners = [];
export function registerFxSettings(target, onChange) {
  fxListeners.push(onChange);
  const D = FX_DEFAULTS[target];
  const T = target === "token" ? "Token" : "Portrait";
  for (const k of FX_KEYS) {
    const L = `AIIMG.ParallaxFx.${T}.${k[0].toUpperCase()}${k.slice(1)}`;
    const type = k.endsWith("Strength")
      ? new foundry.data.fields.NumberField({ initial: D[k], min: FX_RANGES[k][0], max: FX_RANGES[k][1], step: FX_RANGES[k][2], nullable: false })
      : new foundry.data.fields.BooleanField({ initial: D[k] });
    game.settings.register(MODULE_ID, fxSettingKey(target, k), { name: `${L}.Name`, hint: `${L}.Hint`, scope: "world", config: true, restricted: true, type, onChange });
  }
  if (target === "token" && !game.settings.settings.has(`${MODULE_ID}.${FX_DEVICE_OFF_KEY}`)) {
    game.settings.register(MODULE_ID, FX_DEVICE_OFF_KEY, {
      name: "AIIMG.ParallaxFx.DeviceOff.Name", hint: "AIIMG.ParallaxFx.DeviceOff.Hint", scope: "client", config: true,
      type: new foundry.data.fields.BooleanField({ initial: false }),
      onChange: () => { for (const f of fxListeners) { try { f(); } catch (e) { console.warn(`${MODULE_ID} | parallax extras`, e); } } }
    });
  }
}

/** drawNow / benchmark: put a view's motion at a fixed look with the extras at their targets (no easing). */
function pinMotion(v, look) {
  const fx = portraitFx(), M = v.motion;
  M.look = { x: Number(look.x) || 0, y: Number(look.y) || 0 };
  M.vel = { x: 0, y: 0 };
  M.light = fx.light ? fx.lightStrength : 0; M.dust = fx.dust ? fx.dustStrength : 0; M.opacity = 1;
  M.lightV = M.dustV = M.opacityV = 0;
  v.drawnSig = null;
}

/** For macros / checks: `api.parallax.portraits`. */
export const portraitApi = {
  status: () => ({
    active: portraitParallaxActive(), setting: settingOn(), disabled, reducedMotion: reducedMotion(), fx: { ...portraitFx() }, deviceOff: fxDeviceOff(),
    context: !!host?.gl && !host.gl.lost, running: !!host?.raf, lingering: !!host?.linger, gpuTimer: !!host?.gl?.timerSupported, gpuMs: host?.gpuMs ?? null,
    guard: guard.state(), counters: { ...counters },
    assets: [...assets.values()].map((a) => ({ id: a.id, refs: a.refs, status: a.status, error: a.error, code: a.code ?? null, texture: a.tex ? [a.tex.w, a.tex.h] : null, depthSize: a.depthSize, timing: a.timing })),
    views: [...views.values()].map((v) => v.report())
  }),
  refresh: () => refreshPortraits(),
  /** Override view settings of the open portraits (parallax-core view schema; this page, until they re-open). */
  setView: (partial = {}) => {
    for (const v of views.values()) {
      v.view = normalizeView({ ...v.view, ...partial, on: { ...v.view.on, ...(partial.on ?? {}) } }, v.view);
      if ("dilate" in partial || "normalBlur" in partial) v.recondition();
      v.dirty = true;
    }
    kick();
    return [...views.values()].map((v) => structuredClone(v.view));
  },
  /** Turn the feature back on after the frame guard switched it off (this page). */
  resume: () => { if (disabled === "slow") disabled = ""; guard.reset(); refreshPortraits(); },
  /** Draw every view now (outside the loop; checks in a throttled tab). Optional fixed look for all. */
  drawNow: (look = null) => {
    let n = 0;
    for (const v of views.values()) {
      if (v.status !== "ready" || !host?.gl) continue;
      if (look) pinMotion(v, look);
      if (v.draw()) n++;
    }
    if (host?.timing) { host.gl.timerEnd(); host.timing = false; }
    return n;
  },
  /** Synchronous GPU-bound timing of one view (readPixels after each draw). */
  benchmark: (frames = 60) => {
    const v = [...views.values()].find((x) => x.status === "ready");
    if (!v || !host?.gl) return null;
    const times = [];
    for (let i = 0; i < frames; i++) {
      const s = performance.now();
      pinMotion(v, { x: Math.sin(i / 7), y: Math.cos(i / 11) * 0.4 });
      v.draw();
      if (host.timing) { host.gl.timerEnd(); host.timing = false; }
      host.gl.finish();
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    return { avgMs: Math.round((times.reduce((s, x) => s + x, 0) / times.length) * 100) / 100, p95Ms: Math.round(times[Math.floor(times.length * 0.95)] * 100) / 100, canvas: [v.canvas.width, v.canvas.height] };
  },
  /**
   * W6-T: per-frame series of the first view (t, gap, drew, look, opacity, light, dust, breath, uniforms) for
   * smoothness checks. `trace(true, max)` starts (clears), `trace(false)` stops and returns the rows.
   */
  trace: (on = true, max = 6000) => {
    if (on) { trace = { max, rows: [] }; return true; }
    const rows = trace?.rows ?? [];
    trace = null;
    return rows;
  },
  /** W6-T (checks only): add `ms` of busy CPU time to every draw, to prove the guard trips on an expensive effect. */
  simulateDrawCost: (ms = 0) => { debugDrawCostMs = Math.max(0, Number(ms) || 0); return debugDrawCostMs; }
};
