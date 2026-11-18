// W6-O: depth parallax on canvas TOKENS. A token whose image has a depth map (the shared lookup, depth/depth-index.mjs;
// a map made for an actor portrait is reused when the token shows the same file) gets a PIXI filter on its mesh in the
// primary group (Foundry's own PIXI 7 context, not the parallax window's WebGL2 renderer): the image layers shift
// slightly with a view offset. Tokens without a map are untouched (no filter, no listener work, no cost).
//
// - The filter only recolours pixels INSIDE the token's own drawing: the output alpha is the input alpha (token-core
//   TOKEN_FS), so the silhouette, borders, hit areas, selection, targeting, the void (ERASE) pass, fog, vision and
//   lighting see the same token. Foundry's own mesh filters (invisibility etc.) and other modules' filters stay; ours
//   goes first (on the raw mesh).
// - Unsupported tokens (video, dynamic token ring, previews) are skipped silently.
// - Drive (world setting): "pointer" (default) = the pointer near a token tilts it, only tokens within a few token sizes
//   of the pointer carry an ENABLED filter; eased; the frame loop (canvas ticker) runs only while looks move and stops
//   at rest. "camera" = the token's place on the screen (panning moves the layers), computed inside the filter's apply.
// - Switches: world `tokenParallax` (off = nothing anywhere), scene flag `tokenParallax` (default off), token flag
//   `tokenParallax` ("" inherit / "on" / "off"). `prefers-reduced-motion: reduce` = off. A frame guard turns the
//   feature off for this page with one notice when frames get slow while it animates.
// - Depth textures: one per map file (RGBA16F, ≤ 512 px), shared by every token showing that image, destroyed 10 s
//   after the last user is gone and at once on scene tear-down.
// - W6-P extras (client settings, parallax-fx.mjs; all OFF by default): breathing (slow idle tilt while the pointer is
//   away), light (shading from the depth normals + rim following the tilt) and dust (particles in depth planes). All
//   inside the filter, so they only recolour the token's own pixels (output alpha = input alpha; dust shows only over
//   non-transparent token pixels). Breathing / dust keep the filter ENABLED at rest and the ticker callback running;
//   at most MAX_ANIMATED_TOKENS tokens (in view, nearest the pointer, else nearest the screen centre) animate at once,
//   their time / breath advance at most ~30 fps; the rest stay as before. Reduced motion = the whole feature off.
// - GM: a token HUD button opens the "Generate depth" window on the token image (its own estimate + confirmation before
//   every paid call; nothing runs in bulk).
import { MODULE_ID } from "../constants.mjs";
import { depthIndex } from "../depth/depth-index.mjs";
import { conditionDepth, downscaleMap, stepsFor, easeToward } from "./parallax-core.mjs";
import { createFrameGuard, effectAmount } from "./portrait-core.mjs";
import { registerFxSettings } from "./portrait.mjs";
import {
  FX_KEYS, fxSettingKey, normalizeFx, effectiveFx, breathLook, withBreath, phaseOf, pickAnimated, inView, dustScale,
  IDLE_FRAME_MS, MAX_ANIMATED_TOKENS
} from "./parallax-fx.mjs";
import {
  tokenWanted, unsupportedReason, pointerLook, cameraLook, uvOffset, cleanStrength, depthFactor, toHalfArray, lookIsRest,
  TOKEN_MODES, DRIVES, STRENGTH_RANGE, STRENGTH_DEFAULT, TOKEN_VS, TOKEN_FS
} from "./token-core.mjs";

export const SETTING = "tokenParallax";
export const DRIVE_SETTING = "tokenParallaxDrive";
export const STRENGTH_SETTING = "tokenParallaxStrength";
export const FLAG = "tokenParallax";
const DEPTH_MAX_SIDE = 512;
const RELEASE_MS = 10_000;
const FOCUS = 0.45;
/** W6-P: base light / rim of the token filter (times the viewer's light strength; they fade in with the tilt). */
const TOKEN_LIGHT = 0.6, TOKEN_RIM = 0.5, TOKEN_RELIEF = 10;
const ZERO = Object.freeze({ x: 0, y: 0 });
const PICK_MS = 250;

const views = new Map();        // Token (placeable) -> TokenView
const depthCache = new Map();   // depth path -> {refs, p: Promise<{tex, w, h}>, timer, tex?}
const attachSeq = new WeakMap();
let disabled = "";              // "", "slow" (this page)
let notified = false;
let pointer = null;             // canvas coords, or null when the pointer is off the board
let loopOn = false;
let guard = null;
let panUntil = 0;
let lastTickT = 0;
let fxCache = null;             // W6-P: effective extras on this client
let fxTimeMs = 0;               // W6-P: clock of breathing / dust, advanced at most every IDLE_FRAME_MS
let lastIdleT = 0;
let lastPickT = 0;
let pointerClient = null;       // W6-P: pointer in client px while it is on the board (cap selection)
let animatedCount = 0;
const counters = { attached: 0, detached: 0, depthLoads: 0, depthDestroyed: 0, frames: 0 };

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
const get = (k, d) => { try { return game.settings.get(MODULE_ID, k); } catch { return d; } };
const worldOn = () => get(SETTING, true) !== false;
const drive = () => (DRIVES.includes(get(DRIVE_SETTING, "pointer")) ? get(DRIVE_SETTING, "pointer") : "pointer");
const strength = () => cleanStrength(get(STRENGTH_SETTING, STRENGTH_DEFAULT));

/** W6-P: the viewer's extras for tokens (client settings), after the reduced-motion rule. */
export function tokenFx() {
  if (!fxCache) {
    const raw = {};
    for (const k of FX_KEYS) raw[k] = get(fxSettingKey("token", k), undefined);
    fxCache = effectiveFx(normalizeFx(raw, "token"), { reducedMotion: reducedMotion() });
  }
  return fxCache;
}

/** Is the feature live on this client (any scene)? */
export function tokenParallaxActive() {
  return worldOn() && !disabled && !reducedMotion();
}

function sceneOn(scene = canvas?.scene) {
  return !!scene?.getFlag?.(MODULE_ID, FLAG);
}

function tokenMode(doc) {
  const m = doc?.getFlag?.(MODULE_ID, FLAG) ?? "";
  return TOKEN_MODES.includes(m) ? m : "";
}

function isVideo(token) {
  try { return !!game.video?.getVideoSource?.(token.texture); } catch { return false; }
}

/** "" when this token may carry the filter, else why not. */
function whyNot(token) {
  if (!token || token.destroyed) return "gone";
  if (!tokenParallaxActive()) return disabled || (reducedMotion() ? "reducedMotion" : "setting");
  if (!tokenWanted({ world: true, scene: sceneOn(token.document?.parent), token: tokenMode(token.document) })) return "off";
  return unsupportedReason({
    preview: !!token.isPreview || !!token._original,
    video: isVideo(token),
    ring: !!token.document?.ring?.enabled,
    src: token.document?.texture?.src ?? "",
    meshOk: !!token.mesh && !token.mesh.destroyed
  });
}

// ------------------------------------------------------------------ depth textures (shared per map file)

async function buildDepthTexture(info) {
  const L = await import("./parallax-load.mjs");
  let src = await L.loadDepth({ path: info.depth, format: info.format, sidecar: info.sidecar });
  const f = depthFactor(src.w, src.h, DEPTH_MAX_SIDE);
  if (f >= 2) {
    const d = downscaleMap(src.D, src.w, src.h, f);
    src = { ...src, D: d.M, mask: src.mask ? downscaleMap(src.mask, src.w, src.h, f).M : null, w: d.w, h: d.h };
  }
  await new Promise((r) => setTimeout(r, 0));
  // W6-P: normals for the light come from a lightly blurred copy (G channel); depth (R) is unchanged by the blur
  const c = conditionDepth(src, { dilatePx: 2, normalBlurPx: 2 });
  const base = PIXI.BaseTexture.fromBuffer(toHalfArray(c.rgba), c.w, c.h, {
    format: PIXI.FORMATS.RGBA, type: PIXI.TYPES.HALF_FLOAT, scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF, wrapMode: PIXI.WRAP_MODES.CLAMP, alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED_ALPHA
  });
  counters.depthLoads++;
  return { tex: new PIXI.Texture(base), w: c.w, h: c.h };
}

function acquireDepth(info) {
  let e = depthCache.get(info.depth);
  if (!e) {
    e = { refs: 0, timer: 0, tex: null, p: null };
    e.p = buildDepthTexture(info).then((r) => { e.tex = r.tex; return r; });
    e.p.catch(() => { if (depthCache.get(info.depth) === e) depthCache.delete(info.depth); });
    depthCache.set(info.depth, e);
  }
  clearTimeout(e.timer);
  e.timer = 0;
  e.refs++;
  return e.p;
}

function destroyDepthEntry(path, e) {
  clearTimeout(e.timer);
  if (depthCache.get(path) === e) depthCache.delete(path);
  e.p.then((r) => { try { r.tex.destroy(true); counters.depthDestroyed++; } catch { /* gone */ } }, () => {});
}

function releaseDepth(path, now = false) {
  const e = depthCache.get(path);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  if (e.refs > 0) return;
  clearTimeout(e.timer);
  if (now) destroyDepthEntry(path, e);
  else e.timer = setTimeout(() => { if (e.refs === 0) destroyDepthEntry(path, e); }, RELEASE_MS);
}

function destroyAllDepth() {
  for (const [path, e] of [...depthCache]) destroyDepthEntry(path, e);
}

// ------------------------------------------------------------------ the filter

let FilterClass = null;
function filterClass() {
  if (FilterClass) return FilterClass;
  FilterClass = class TokenDepthFilter extends PIXI.Filter {
    constructor(depthTex, dw, dh) {
      super(TOKEN_VS, TOKEN_FS, {
        uDepth: depthTex, otherMatrix: new PIXI.Matrix(), uTokToIn: new PIXI.Matrix(),
        uOff: new Float32Array(2), uDTexel: new Float32Array([1 / dw, 1 / dh]),
        uFocus: FOCUS, uGamma: 1, uContrast: 1, uHoleFill: 1, uSteps: 8,
        uLook: new Float32Array(2), uLight: 0, uRim: 0, uRelief: TOKEN_RELIEF, uDust: 0, uDustScale: 1, uTime: 0
      });
      this.padding = 0;
      this.dw = dw; this.dh = dh;
      this.view = null;
      this._m = new PIXI.Matrix();
      this._inv = new PIXI.Matrix();
    }

    apply(filterManager, input, output, clearMode) {
      const v = this.view, mesh = v?.mesh, u = this.uniforms;
      let off = { x: 0, y: 0 }, light = 0, rim = 0, dust = 0;
      if (mesh && !mesh.destroyed && mesh._texture?.orig?.width) {
        const m = filterManager.calculateSpriteMatrix(this._m, mesh);
        u.otherMatrix = m;
        u.uTokToIn = this._inv.copyFrom(m).invert();
        let look = v.drive === "camera" ? v.cameraLook() : v.look;
        if (v.drive === "camera" && (v.breath.x || v.breath.y)) look = withBreath(look, v.breath);
        const o = mesh._texture.orig, wt = mesh.worldTransform;
        off = uvOffset(look, v.strength, wt, o.width, o.height);
        // W6-P extras: light direction in token-texture space (the look turned like the uv offset), amounts
        const fx = tokenFx();
        if (fx.light || (fx.dust && v.animated)) {
          const tx = off.x * o.width, ty = off.y * o.height, tl = Math.hypot(tx, ty), ll = Math.min(1, Math.hypot(look.x, look.y));
          u.uLook[0] = tl > 1e-9 ? (tx / tl) * ll : 0; u.uLook[1] = tl > 1e-9 ? (ty / tl) * ll : 0;
          if (fx.light) { light = effectAmount(TOKEN_LIGHT * fx.lightStrength, look); rim = effectAmount(TOKEN_RIM * fx.lightStrength, look); }
          if (fx.dust && v.animated) {
            dust = fx.dustStrength;
            u.uDustScale = dustScale(Math.min(Math.hypot(wt.a, wt.b) * o.width, Math.hypot(wt.c, wt.d) * o.height));
            u.uTime = (fxTimeMs / 1000) % 3600;
          }
        }
      }
      u.uOff[0] = off.x; u.uOff[1] = off.y;
      u.uLight = light; u.uRim = rim; u.uDust = dust;
      u.uSteps = stepsFor(off, this.dw, this.dh);
      v && (v.applied++);
      filterManager.applyFilter(this, input, output, clearMode);
    }
  };
  return FilterClass;
}

// ------------------------------------------------------------------ one token

class TokenView {
  constructor(token, info) {
    this.token = token;
    this.info = info;
    this.src = token.document.texture.src;
    this.mesh = null;
    this.filter = null;
    this.look = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.drive = drive();
    this.strength = strength();
    this.status = "loading";
    this.error = "";
    this.applied = 0;
    this.destroyed = false;
    this.animated = false;          // W6-P: one of the tokens allowed to animate at rest (cap)
    this.breath = ZERO;
    this.phase = phaseOf(token.document?.id ?? token.id);
  }

  async load() {
    try {
      const d = await acquireDepth(this.info);
      if (this.destroyed) { releaseDepth(this.info.depth); return; }
      this.filter = new (filterClass())(d.tex, d.w, d.h);
      this.filter.view = this;
      this.status = "ready";
      this.bindMesh();
      this.sync();
      kick();
    } catch (e) {
      if (this.destroyed) return;
      this.status = "error";
      this.error = String(e?.message ?? e);
      if (e?.status === 404 || e?.status === 403) depthIndex.reportMissing(this.src);
      console.warn(`${MODULE_ID} | token parallax: ${this.src}`, e);
      this.unbindMesh();
    }
  }

  /** Put the filter first on the token's current mesh (again, if another module replaced the array). */
  bindMesh() {
    if (!this.filter) return;
    const mesh = this.token?.mesh;
    if (this.mesh && this.mesh !== mesh) this.unbindMesh();
    if (!mesh || mesh.destroyed) return;
    this.mesh = mesh;
    const fs = Array.isArray(mesh.filters) ? mesh.filters : [];
    if (!fs.includes(this.filter)) mesh.filters = [this.filter, ...fs];
  }

  unbindMesh() {
    const mesh = this.mesh;
    this.mesh = null;
    if (!mesh || mesh.destroyed || !Array.isArray(mesh.filters)) return;
    const i = mesh.filters.indexOf(this.filter);
    if (i >= 0) {
      const rest = mesh.filters.filter((f) => f !== this.filter);
      mesh.filters = rest.length ? rest : null;
    }
  }

  cameraLook() {
    try {
      const p = canvas.clientCoordinatesFromCanvas(this.token.center);
      return cameraLook(p, globalThis.innerWidth || 1, globalThis.innerHeight || 1);
    } catch { return { x: 0, y: 0 }; }
  }

  /** Enabled only when it changes the picture. */
  sync() {
    if (!this.filter) return;
    // W6-P: dust needs the filter at rest too (only on the capped, animated tokens)
    this.filter.enabled = this.drive === "camera" ? true : !lookIsRest(this.look) || (this.animated && tokenFx().dust);
  }

  /** One eased step (pointer drive). @returns {boolean} still moving */
  step(dt) {
    if (this.status !== "ready" || this.destroyed) return false;
    const t = this.token;
    if (!t || t.destroyed) return false;
    const fx = tokenFx();
    this.breath = this.animated && fx.breath ? breathLook(fxTimeMs, fx.breathStrength, this.phase) : ZERO;
    if (this.drive !== "pointer") { this.sync(); return false; }   // camera: the breath is added in the filter's apply
    this.target = pointer ? pointerLook(pointer, t.center, Math.max(t.w || 0, t.h || 0)) : { x: 0, y: 0 };
    if (this.breath !== ZERO) this.target = withBreath(this.target, this.breath);
    this.look = { x: easeToward(this.look.x, this.target.x, dt, 0.12), y: easeToward(this.look.y, this.target.y, dt, 0.12) };
    const moving = Math.hypot(this.look.x - this.target.x, this.look.y - this.target.y) > 0.002;
    if (!moving) this.look = { ...this.target };
    this.sync();
    return moving;
  }

  destroy() {
    this.destroyed = true;
    this.unbindMesh();
    if (this.filter) {
      this.filter.view = null;
      try { this.filter.destroy(); } catch { /* gone */ }
      this.filter = null;
      releaseDepth(this.info.depth);
    }
  }

  report() {
    return {
      token: this.token?.document?.uuid, image: this.src, depth: this.info.depth, status: this.status, error: this.error,
      enabled: !!this.filter?.enabled, onMesh: !!this.mesh?.filters?.includes?.(this.filter), look: { ...this.look }, animated: this.animated,
      drive: this.drive, strength: this.strength, applied: this.applied
    };
  }
}

// ------------------------------------------------------------------ attach / detach

function detach(token) {
  const v = views.get(token);
  if (!v) return;
  v.destroy();
  views.delete(token);
  counters.detached++;
}

function detachAll({ dropDepth = false } = {}) {
  for (const t of [...views.keys()]) detach(t);
  stopLoop();
  if (dropDepth) destroyAllDepth();
}

/** Create / keep / drop the view of one token. */
async function attach(token) {
  if (!token) return;
  const n = (attachSeq.get(token) ?? 0) + 1;
  attachSeq.set(token, n);
  if (whyNot(token)) { detach(token); return; }
  const src = token.document.texture.src;
  const info = await depthIndex.lookup(src);
  if (attachSeq.get(token) !== n || token.destroyed) return;
  if (!info || whyNot(token)) { detach(token); return; }
  let v = views.get(token);
  if (v && (v.src !== src || v.info.depth !== info.depth || v.status === "error")) { detach(token); v = null; }
  if (v) { v.drive = drive(); v.strength = strength(); v.bindMesh(); v.sync(); return; }
  v = new TokenView(token, info);
  views.set(token, v);
  counters.attached++;
  await v.load();
}

let scanTimer = 0;
/** Re-check every token of the viewed scene (index changed, a switch changed, scene ready). */
export function refreshTokens() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (!canvas?.ready) return;
    if (!tokenParallaxActive()) { detachAll(); return; }
    for (const t of [...views.keys()]) if (t.destroyed || !canvas.tokens?.placeables?.includes(t)) detach(t);
    for (const t of canvas.tokens?.placeables ?? []) attach(t).catch((e) => console.warn(`${MODULE_ID} | token parallax`, e));
    kick();
  }, 60);
}

// ------------------------------------------------------------------ frame loop (pointer drive) + guard

function maxGapMs() {
  const fps = Number(canvas?.app?.ticker?.maxFPS) || 0;
  return Math.max(55, fps > 0 ? 1600 / fps : 0);
}

function ensureGuard() {
  if (!guard) guard = createFrameGuard({ maxGapMs: maxGapMs(), maxDrawMs: Infinity });
  return guard;
}

/**
 * W6-P: which tokens may animate at rest (breathing / dust): in view and visible, nearest the pointer (else the screen
 * centre), at most MAX_ANIMATED_TOKENS. The others keep the pre-W6-P behaviour (flat unless the pointer is near).
 */
function repick() {
  const fx = tokenFx();
  const W = globalThis.innerWidth || 1, H = globalThis.innerHeight || 1;
  const items = [];
  if (fx.animates && canvas?.ready) {
    const zoom = canvas.stage?.scale?.x || 1;
    for (const v of views.values()) {
      const t = v.token;
      if (v.status !== "ready" || !t || t.destroyed) continue;
      let c = null;
      try { c = canvas.clientCoordinatesFromCanvas(t.center); } catch { /* torn down */ }
      if (!c) continue;
      const r = (Math.max(t.w || 0, t.h || 0) / 2) * zoom;
      items.push({ key: v, x: c.x, y: c.y, r, inView: t.visible !== false && inView(c.x, c.y, r, W, H) });
    }
  }
  const pick = pickAnimated(items, { pointer: pointerClient, center: { x: W / 2, y: H / 2 }, cap: MAX_ANIMATED_TOKENS });
  animatedCount = pick.size;
  for (const v of views.values()) {
    const a = pick.has(v);
    if (a !== v.animated) { v.animated = a; if (!a) v.breath = ZERO; }
    v.sync();
  }
}

/** Ticker callback: eases the looks (pointer drive) and feeds the frame guard while the effect animates. */
function tick() {
  const ticker = canvas?.app?.ticker;
  const now = performance.now();
  const gap = lastTickT ? now - lastTickT : 0;
  lastTickT = now;
  const dt = Math.min(0.1, Math.max(0, (ticker?.deltaMS ?? 16) / 1000));
  counters.frames++;
  const fx = tokenFx();
  // W6-P: breathing / dust clock advances at most ~30 fps; the animated set is re-picked a few times a second
  if (fx.animates) {
    if (now - lastIdleT >= IDLE_FRAME_MS) { lastIdleT = now; fxTimeMs = now; }
    if (now - lastPickT >= PICK_MS) { lastPickT = now; repick(); }
  }
  let moving = false, enabled = 0;
  for (const v of views.values()) {
    if (v.drive === "pointer" || fx.animates) moving = v.step(dt) || moving;
    if (v.filter?.enabled) enabled++;
  }
  const panning = now < panUntil;
  const animating = fx.animates && animatedCount > 0;
  // the guard only listens while the effect animates on screen (frames of a still scene say nothing about us)
  if ((moving || panning || animating) && enabled > 0 && gap > 0 && ensureGuard().push(gap, 0) === "bad") { tooSlow(); return; }
  if (!moving && !panning && !animating) stopLoop();
}

/** Camera drive: the filters read the pan in their apply(); the loop only runs the guard while the view moves. */
function onPan() {
  if (tokenFx().animates && views.size) { lastPickT = 0; kick(); }   // W6-P: tokens panned into view may start animating
  if (![...views.values()].some((v) => v.drive === "camera" && v.filter?.enabled)) return;
  panUntil = performance.now() + 500;
  kick();
}

function kick() {
  if (loopOn || !views.size || !canvas?.app?.ticker) return;
  if (document.hidden) return;
  loopOn = true;
  lastTickT = 0;
  canvas.app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY?.LOW ?? -25);
}

function stopLoop() {
  if (!loopOn) return;
  loopOn = false;
  lastTickT = 0;
  try { canvas?.app?.ticker?.remove(tick); } catch { /* torn down */ }
}

function tooSlow() {
  disabled = "slow";
  console.warn(`${MODULE_ID} | token parallax turned off on this page: frames too slow`, guard?.state());
  detachAll();
  if (!notified) { notified = true; ui.notifications?.info(game.i18n.localize("AIIMG.TokenParallax.Slow")); }
}

// ------------------------------------------------------------------ input

function onPointerMove(ev) {
  if (!views.size || !canvas?.ready) return;
  const board = canvas.app?.view;
  if (board && ev.target !== board) { pointerClient = null; if (pointer) { pointer = null; kick(); } return; }
  try { pointer = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY }); } catch { pointer = null; }
  pointerClient = pointer ? { x: ev.clientX, y: ev.clientY } : null;
  if ([...views.values()].some((v) => v.drive === "pointer")) kick();
}

function onPointerOut(ev) {
  if (ev.relatedTarget) return;   // still inside the page
  if (!pointer) return;
  pointer = null;
  pointerClient = null;
  kick();
}

// ------------------------------------------------------------------ GM: generate the token's map

const realImage = (src) => !!src && !/^icons\/svg\//.test(src) && !/\.(svg|webm|mp4|m4v|ogv|ogg|mov)(\?|#|$)/i.test(src);

function openDepthForToken(doc) {
  if (!game.user.isGM || !realImage(doc?.texture?.src)) return;
  const actor = doc.actor;
  const typeKey = actor ? `${game.system.id}.Actor.${actor.type}` : "";
  import("../depth/depth-app.mjs").then((m) => m.DepthApp.open({ path: doc.texture.src, typeKey }));
}

function hudButton(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const doc = hud?.document ?? hud?.object?.document;
  if (!root || !doc || !realImage(doc.texture?.src)) return;
  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if (!col || col.querySelector(".aiimg-token-depth")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "control-icon aiimg-token-depth";
  const label = game.i18n.localize("AIIMG.TokenParallax.Generate");
  b.dataset.tooltip = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = '<i class="fa-solid fa-layer-group" inert></i>';
  b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openDepthForToken(doc); });
  col.append(b);
}

// ------------------------------------------------------------------ config forms (scene switch, token override)

function rootOf(html, app) {
  const el = html instanceof HTMLElement ? html : html?.[0] ?? app?.element;
  return el instanceof HTMLElement ? el : el?.[0] ?? null;
}

function formGroup(labelText, hintText, input) {
  const g = document.createElement("div");
  g.className = "form-group aiimg-token-parallax";
  const l = document.createElement("label");
  l.textContent = labelText;
  const f = document.createElement("div");
  f.className = "form-fields";
  f.append(input);
  g.append(l, f);
  if (hintText) { const p = document.createElement("p"); p.className = "hint"; p.textContent = hintText; g.append(p); }
  return g;
}

function sceneConfigField(app, html) {
  if (!game.user.isGM) return;
  const root = rootOf(html, app);
  const doc = app?.document;
  if (!root || doc?.documentName !== "Scene" || root.querySelector(".aiimg-token-parallax")) return;
  const tab = root.querySelector('.tab[data-tab="basics"]') ?? root.querySelector("form .tab") ?? root.querySelector("form");
  if (!tab) return;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = `flags.${MODULE_ID}.${FLAG}`;
  input.checked = !!doc.getFlag(MODULE_ID, FLAG);
  tab.append(formGroup(game.i18n.localize("AIIMG.TokenParallax.Scene.Label"), game.i18n.localize("AIIMG.TokenParallax.Scene.Hint"), input));
}

function tokenConfigField(app, html) {
  if (!game.user.isGM) return;
  const root = rootOf(html, app);
  const doc = app?.document ?? app?.token;
  if (!root || !doc || root.querySelector(".aiimg-token-parallax")) return;
  const tab = root.querySelector('.tab[data-tab="appearance"]');
  if (!tab) return;
  const sel = document.createElement("select");
  sel.name = `flags.${MODULE_ID}.${FLAG}`;
  const cur = tokenMode(doc);
  for (const [v, k] of [["", "Inherit"], ["on", "On"], ["off", "Off"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = game.i18n.localize(`AIIMG.TokenParallax.Token.${k}`);
    if (v === cur) o.selected = true;
    sel.append(o);
  }
  tab.append(formGroup(game.i18n.localize("AIIMG.TokenParallax.Token.Label"), game.i18n.localize("AIIMG.TokenParallax.Token.Hint"), sel));
}

// ------------------------------------------------------------------ registration

const flagChanged = (changes) => foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG}`)
  || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=${FLAG}`) || foundry.utils.hasProperty(changes, `flags.-=${MODULE_ID}`);

let registered = false;
export function registerTokenParallax() {
  if (registered) return;
  registered = true;
  Hooks.on("canvasReady", () => refreshTokens());
  Hooks.on("canvasTearDown", () => { detachAll({ dropDepth: true }); pointer = null; });
  Hooks.on("drawToken", (token) => { if (canvas?.ready) attach(token).catch((e) => console.warn(`${MODULE_ID} | token parallax`, e)); });
  Hooks.on("destroyToken", (token) => detach(token));
  Hooks.on("refreshToken", (token) => {
    const v = views.get(token);
    if (!v) return;
    if (token.document?.texture?.src !== v.src || token.mesh !== v.mesh || whyNot(token)) { attach(token).catch(() => {}); return; }
    if (v.filter && !v.mesh?.filters?.includes(v.filter)) v.bindMesh();
    if (v.drive === "pointer" && pointer) kick();
  });
  Hooks.on("updateToken", (doc, changes) => {
    if (doc.parent !== canvas?.scene) return;
    if (flagChanged(changes) || foundry.utils.hasProperty(changes, "texture.src") || foundry.utils.hasProperty(changes, "ring")) {
      if (doc.object) attach(doc.object).catch(() => {});
    }
  });
  Hooks.on("updateScene", (scene, changes) => { if (scene === canvas?.scene && flagChanged(changes)) refreshTokens(); });
  Hooks.on("canvasPan", () => onPan());
  Hooks.on("renderTokenHUD", hudButton);
  Hooks.on("renderSceneConfig", sceneConfigField);
  Hooks.on("renderTokenConfig", tokenConfigField);
  depthIndex.onChange(() => refreshTokens());
  try { globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", () => { fxCache = null; refreshTokens(); }); } catch { /* old engine */ }
  globalThis.addEventListener?.("pointermove", onPointerMove, { passive: true });
  globalThis.document?.addEventListener?.("pointerout", onPointerOut, { passive: true });
  globalThis.document?.addEventListener?.("visibilitychange", () => { if (!document.hidden) kick(); });
}

/** World settings (init, from settings.mjs). */
export function registerTokenSettings() {
  const onChange = () => {
    if (worldOn() && disabled === "slow") { disabled = ""; guard = null; }
    for (const v of views.values()) { v.drive = drive(); v.strength = strength(); v.sync(); }
    refreshTokens();
  };
  game.settings.register(MODULE_ID, SETTING, {
    name: "AIIMG.TokenParallax.Setting.Name",
    hint: "AIIMG.TokenParallax.Setting.Hint",
    scope: "world", config: true, restricted: true,
    type: new foundry.data.fields.BooleanField({ initial: true }),
    onChange
  });
  game.settings.register(MODULE_ID, DRIVE_SETTING, {
    name: "AIIMG.TokenParallax.Drive.Name",
    hint: "AIIMG.TokenParallax.Drive.Hint",
    scope: "world", config: true, restricted: true,
    type: new foundry.data.fields.StringField({
      initial: "pointer", required: true, blank: false,
      choices: { pointer: "AIIMG.TokenParallax.Drive.Pointer", camera: "AIIMG.TokenParallax.Drive.Camera" }
    }),
    onChange
  });
  const [min, max, step] = STRENGTH_RANGE;
  game.settings.register(MODULE_ID, STRENGTH_SETTING, {
    name: "AIIMG.TokenParallax.Strength.Name",
    hint: "AIIMG.TokenParallax.Strength.Hint",
    scope: "world", config: true, restricted: true,
    type: new foundry.data.fields.NumberField({ initial: STRENGTH_DEFAULT, min, max, step, nullable: false }),
    onChange
  });
  // W6-P: the viewer's extras for tokens (client scope), next to the token parallax settings
  registerFxSettings("token", () => {
    fxCache = null;
    lastPickT = 0;
    if (!tokenFx().animates) { animatedCount = 0; for (const v of views.values()) { v.animated = false; v.breath = ZERO; } }
    for (const v of views.values()) v.sync();
    kick();
  });
}

/** For macros / checks: `api.parallax.tokens`. */
export const tokenApi = {
  status: () => ({
    active: tokenParallaxActive(), setting: worldOn(), scene: sceneOn(), drive: drive(), strength: strength(), disabled,
    reducedMotion: reducedMotion(), loop: loopOn, pointer: pointer ? { ...pointer } : null, guard: guard?.state() ?? null,
    fx: { ...tokenFx() }, animated: animatedCount, maxAnimated: MAX_ANIMATED_TOKENS,
    depthTextures: [...depthCache].map(([path, e]) => ({ path, refs: e.refs, ready: !!e.tex, releasing: !!e.timer })),
    counters: { ...counters },
    views: [...views.values()].map((v) => v.report())
  }),
  refresh: () => refreshTokens(),
  /** Turn the feature back on after the slow-frame guard switched it off (this page). */
  resume: () => { if (disabled === "slow") disabled = ""; guard = null; refreshTokens(); },
  /** Checks: put the pointer at a canvas point (null = off the board) and run the easing, as a real move would. */
  setPointer: (p) => { pointer = p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : null; kick(); return !!pointer; },
  /** Checks in a throttled tab: step the easing `n` times by `dt` seconds without the ticker. */
  stepNow: (n = 1, dt = 0.05) => {
    let moving = false;
    const fx = tokenFx();
    for (let i = 0; i < n; i++) {
      moving = false;
      if (fx.animates) { fxTimeMs += dt * 1000; repick(); }
      for (const v of views.values()) if (v.drive === "pointer" || fx.animates) moving = v.step(dt) || moving;
    }
    return { moving, enabled: [...views.values()].filter((v) => v.filter?.enabled).length, animated: animatedCount };
  },
  /** W6-P checks: re-pick the tokens allowed to animate at rest now; optional pointer in client px. */
  pick: (client) => { if (client !== undefined) pointerClient = client ? { x: Number(client.x) || 0, y: Number(client.y) || 0 } : null; repick(); return animatedCount; },
  /** Why a token does / does not carry the filter ("" = it may). */
  whyNot: (token) => whyNot(token)
};
