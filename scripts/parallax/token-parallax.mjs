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
// - W6-U: every change eases (critically damped springs, dt-based): the look, and the breathing / dust / light amounts
//   when a token joins or leaves the animated set or an extra is switched; the filter is disabled only once the token
//   has settled at rest. Breathing / dust run on a continuous clock (no 30 fps steps). The void (ERASE) pass renders
//   the mesh without our filter (alpha is the same, the ray search ran twice). Camera drive enables the filter only on
//   tokens on screen; pointer drive steps only tokens near the pointer, moving or animated. Depth maps are conditioned
//   in a Worker. Depth textures are released by the entry a view acquired (not by path). The frame guard switches off
//   only when the module's OWN cost is large (invisible A/B probe: our passes doubled), not on unrelated slow frames.
//   A token's "on" beats an off scene only when a GM confirmed it (scene flag list, GM-only).
// - W6-X: camera drive is capped like the pointer drive: at most MAX_CAMERA_TOKENS on-screen tokens (nearest the screen
//   centre, with hysteresis) carry the tilt, breathing and dust; joining / leaving fades a camera amount (spring), a
//   token entering the screen starts flat and fades in. A disabled filter is switched on one frame EARLY, still showing
//   the rest state (no frame jumps from "no filter" to a shifted picture). Counts in status() come from the live views.
// - GM: a token HUD button opens the "Generate depth" window on the token image (its own estimate + confirmation before
//   every paid call; nothing runs in bulk).
import { MODULE_ID } from "../constants.mjs";
import { depthIndex } from "../depth/depth-index.mjs";
import { stepsFor } from "./parallax-core.mjs";
import { createFrameGuard, effectAmount } from "./portrait-core.mjs";
import { registerFxSettings, fxDeviceOff } from "./portrait.mjs";
import {
  FX_KEYS, fxSettingKey, normalizeFx, effectiveFx, breathLook, withBreath, phaseOf, pickAnimated, inView, dustScale,
  MAX_ANIMATED_TOKENS, LIGHT
} from "./parallax-fx.mjs";
import {
  tokenWanted, unsupportedReason, pointerLook, cameraLook, uvOffset, cleanStrength, lookIsRest, gmOnList, gmOnListAfter,
  stepLook, stepAmp, scaleLook, needsStep, tokenOnScreen, depthKey, guardVerdict, probeFrame, createDepthCache,
  prepareDepthTexture, TOKEN_CONDITION, TOKEN_MODES, DRIVES, STRENGTH_RANGE, STRENGTH_DEFAULT, TOKEN_VS, TOKEN_FS,
  pickCamera, cameraEffLook, shouldArm, MAX_CAMERA_TOKENS, CAMERA_OMEGA, AMP_ON
} from "./token-core.mjs";

export const SETTING = "tokenParallax";
export const DRIVE_SETTING = "tokenParallaxDrive";
export const STRENGTH_SETTING = "tokenParallaxStrength";
export const FLAG = "tokenParallax";
/** W6-U: scene flag, ids of tokens whose "on" a GM confirmed (scenes are GM-only: an owner cannot forge it). */
export const FLAG_GM_ON = "tokenParallaxGmOn";
const DEPTH_MAX_SIDE = 512;
const RELEASE_MS = 10_000;
const FOCUS = 0.45;
/** W6-P: base light / rim of the token filter (times the viewer's light strength; they fade in with the tilt).
 *  W6-V: base 1 (the strength setting is the light's own amount, default 0.8), rim gain LIGHT.rimGain, relief per short side. */
const TOKEN_LIGHT = 1, TOKEN_RIM = LIGHT.rimGain, TOKEN_RELIEF = LIGHT.relief;
const ZERO = Object.freeze({ x: 0, y: 0 });
const PICK_MS = 250;

const views = new Map();        // Token (placeable) -> TokenView
const attachSeq = new WeakMap();
let disabled = "";              // "", "slow" (this page)
let notified = false;
let pointer = null;             // canvas coords, or null when the pointer is off the board
let loopOn = false;
let guard = null;
let panUntil = 0;
let lastTickT = 0;
let fxCache = null;             // W6-P: effective extras on this client
let fxTimeMs = 0;               // W6-P: clock of breathing / dust (W6-U: continuous, every frame)
let lastPickT = 0;
let panStale = false;           // W6-U: a pan / zoom happened; re-read the pointer and camera boxes in the next tick
let pointerClient = null;       // W6-P: pointer in client px while it is on the board (cap selection; W6-U: re-read on pan)
let pickDue = false;            // W6-X: camera drive: the set must be re-picked (pan, resize, a token moved)
let lastBreathS = 0, lastDustS = 0;   // W6-U: strengths kept while an extra fades out after being switched off
const counters = { attached: 0, detached: 0, depthLoads: 0, depthDestroyed: 0, frames: 0, stepped: 0, applies: 0, voidSkips: 0, workerMaps: 0, inlineMaps: 0, armed: 0, offScreenDrops: 0 };

/** W6-X: counts read from the live views (the old `animatedCount` variable survived a detachAll: stale 12 at 0 views). */
function countViews(pred) { let n = 0; for (const v of views.values()) if (pred(v)) n++; return n; }
const animatedNow = () => countViews((v) => v.animated);
const cameraNow = () => countViews((v) => v.camSel);

/**
 * W6-X: client px of a canvas point for the NEXT render: the stage's local transform rebuilt from its current pivot /
 * scale (canvas.pan sets them before the canvasPan hook; `worldTransform` is only refreshed by the render). The stage
 * has no parent (rendered under PIXI's identity temp parent), so local = world.
 */
function stageClient(pt) {
  try {
    const t = canvas.stage.transform;
    t.updateLocalTransform();
    return t.localTransform.apply({ x: pt.x, y: pt.y });
  } catch {
    try { return canvas.clientCoordinatesFromCanvas(pt); } catch { return null; }
  }
}
// W6-U guard: own CPU per frame inside our applies, the A/B probe, the last verdict
let frameCpu = 0;
const cpuHist = [];
let probe = null;               // {i, base, a: [], b: []}
let probeDouble = false;
let probeUntil = 0;             // no new probe before this time (after a "not us" verdict)
let lastVerdict = null;
let testCostMs = 0;             // checks: simulated GPU cost per filter pass (busy wait, outside the CPU timer)
let testLoadDelayMs = 0;        // checks: delay every depth map load (the torn-down-while-loading repro)

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
const get = (k, d) => { try { return game.settings.get(MODULE_ID, k); } catch { return d; } };
const worldOn = () => get(SETTING, true) !== false;
const drive = () => (DRIVES.includes(get(DRIVE_SETTING, "pointer")) ? get(DRIVE_SETTING, "pointer") : "pointer");
const strength = () => cleanStrength(get(STRENGTH_SETTING, STRENGTH_DEFAULT));

/** W6-P: the extras for tokens (W6-Q: world settings set by the GM), after the reduced-motion and device rules. */
export function tokenFx() {
  if (!fxCache) {
    const raw = {};
    for (const k of FX_KEYS) raw[k] = get(fxSettingKey("token", k), undefined);
    fxCache = effectiveFx(normalizeFx(raw, "token"), { reducedMotion: reducedMotion(), deviceOff: fxDeviceOff() });
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

/** Token override, tolerant: "" / "on" / "off" (also an object {v} written by other tools). */
function tokenMode(doc) {
  let m = doc?.getFlag?.(MODULE_ID, FLAG) ?? "";
  if (m && typeof m === "object") m = m.v ?? "";
  return TOKEN_MODES.includes(m) ? m : "";
}

/** W6-U: did a GM confirm this token's "on"? (its id in the scene's GM-only list) */
function gmOn(doc) {
  const id = doc?.id;
  return !!id && gmOnList(doc?.parent?.getFlag?.(MODULE_ID, FLAG_GM_ON)).includes(id);
}

/** W6-U (GM, own action): keep the scene's GM list in step with the mode the GM gave a token. */
async function mirrorGmOn(doc, mode) {
  const scene = doc?.parent;
  if (!game.user?.isGM || !scene || scene.documentName !== "Scene" || !doc.id) return;
  const next = gmOnListAfter(scene.getFlag(MODULE_ID, FLAG_GM_ON), doc.id, mode);
  if (next) await scene.setFlag(MODULE_ID, FLAG_GM_ON, next);
}

function isVideo(token) {
  try { return !!game.video?.getVideoSource?.(token.texture); } catch { return false; }
}

/** "" when this token may carry the filter, else why not. */
function whyNot(token) {
  if (!token || token.destroyed) return "gone";
  if (!tokenParallaxActive()) return disabled || (reducedMotion() ? "reducedMotion" : "setting");
  if (!tokenWanted({ world: true, scene: sceneOn(token.document?.parent), token: tokenMode(token.document), gmOn: gmOn(token.document) })) return "off";
  return unsupportedReason({
    preview: !!token.isPreview || !!token._original,
    video: isVideo(token),
    ring: !!token.document?.ring?.enabled,
    src: token.document?.texture?.src ?? "",
    meshOk: !!token.mesh && !token.mesh.destroyed
  });
}

// ------------------------------------------------------------------ depth textures (shared per map file)

// W6-U (perf a): the CPU work (downscale, conditioning, binary16) runs in a Worker; inline after a yield as a fallback
let worker = null, workerBroken = false, workerSeq = 0;
const workerJobs = new Map();
function getWorker() {
  if (worker || workerBroken || typeof Worker !== "function") return worker;
  try {
    worker = new Worker(new URL("./token-depth-worker.mjs", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      const j = workerJobs.get(ev.data?.id);
      if (!j) return;
      workerJobs.delete(ev.data.id);
      if (ev.data.error) j.reject(new Error(ev.data.error));
      else j.resolve(ev.data);
    };
    worker.onerror = (ev) => {
      console.warn(`${MODULE_ID} | token parallax: depth worker failed, conditioning on the page`, ev?.message ?? ev);
      workerBroken = true;
      try { worker.terminate(); } catch { /* gone */ }
      worker = null;
      for (const j of workerJobs.values()) j.reject(Object.assign(new Error("worker"), { retryInline: true }));
      workerJobs.clear();
    };
  } catch { workerBroken = true; worker = null; }
  return worker;
}

async function prepareOffThread(src) {
  const w = getWorker();
  if (w) {
    // copies: the source arrays stay usable for the inline fallback if the worker dies mid-job
    const D = Float32Array.from(src.D);
    const mask = src.mask ? Float32Array.from(src.mask) : null;
    try {
      const id = ++workerSeq;
      const msg = { id, maxSide: DEPTH_MAX_SIDE, src: { D, mask, w: src.w, h: src.h, bits: src.bits, format: src.format } };
      const r = await new Promise((resolve, reject) => {
        workerJobs.set(id, { resolve, reject });
        w.postMessage(msg, [D.buffer, ...(mask ? [mask.buffer] : [])]);
      });
      counters.workerMaps++;
      return r;
    } catch (e) {
      if (!e?.retryInline) throw e;
    }
  }
  await new Promise((r) => setTimeout(r, 0));
  counters.inlineMaps++;
  return prepareDepthTexture(src, DEPTH_MAX_SIDE);
}

async function buildDepthTexture(info) {
  const L = await import("./parallax-load.mjs");
  // the loader encodes the path segments and adds `?v=<rev>` (W6-R/T; an older loader ignores `rev`: plain path)
  const spec = { path: info.depth, rev: info.rev || null, format: info.format, sidecar: info.sidecar };
  let c;
  if (typeof L.loadDepthConditioned === "function") {
    // W6-T loader: fetch + decode + downscale + condition + binary16 all in its worker
    const r = await L.loadDepthConditioned(spec, { maxSide: DEPTH_MAX_SIDE, condition: TOKEN_CONDITION, half: true });
    c = r?.cond?.half ? { half: r.cond.half, w: r.cond.w, h: r.cond.h } : await prepareOffThread(await L.loadDepth(spec));
    if (r?.cond?.half) counters.workerMaps++;
  } else {
    c = await prepareOffThread(await L.loadDepth(spec));
  }
  if (testLoadDelayMs > 0) await new Promise((r) => setTimeout(r, testLoadDelayMs));
  const base = PIXI.BaseTexture.fromBuffer(c.half, c.w, c.h, {
    format: PIXI.FORMATS.RGBA, type: PIXI.TYPES.HALF_FLOAT, scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF, wrapMode: PIXI.WRAP_MODES.CLAMP, alphaMode: PIXI.ALPHA_MODES.NO_PREMULTIPLIED_ALPHA
  });
  counters.depthLoads++;
  return { tex: new PIXI.Texture(base), w: c.w, h: c.h };
}

/**
 * W6-U: one entry per depth map revision (token-core createDepthCache); a view keeps the ENTRY OBJECT it acquired and
 * releases exactly that one (a view torn down while loading used to release by path, i.e. the NEXT entry of the same
 * file after a redraw, whose texture was then destroyed under a live view).
 */
const depthCache = createDepthCache({
  build: (info) => buildDepthTexture(info),
  dispose: (r) => { r.tex.destroy(true); counters.depthDestroyed++; },
  releaseMs: RELEASE_MS
});
const acquireDepth = (info) => depthCache.acquire(info);
const releaseDepth = (e, now = false) => depthCache.release(e, now);
const destroyAllDepth = () => depthCache.destroyAll();

// ------------------------------------------------------------------ the filter

const busyWait = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* checks only */ } };

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
      const t0 = performance.now();
      const v = this.view, mesh = v?.mesh, u = this.uniforms;
      let off = { x: 0, y: 0 }, light = 0, rim = 0, dust = 0;
      // W6-U (Z3): Foundry pads the mesh during its image-change transition (Token.#updatePadding, ~0.4 s); the sprite
      // matrix ignores the padding, so the map would sit off: pass the picture through untouched meanwhile
      const padded = !!(mesh?._paddingX || mesh?._paddingY);
      if (mesh && !mesh.destroyed && mesh._texture?.orig?.width && !padded) {
        const m = filterManager.calculateSpriteMatrix(this._m, mesh);
        u.otherMatrix = m;
        u.uTokToIn = this._inv.copyFrom(m).invert();
        const look = v.effLook();
        const o = mesh._texture.orig, wt = mesh.worldTransform;
        off = uvOffset(look, v.strength, wt, o.width, o.height);
        // W6-P extras (W6-U: light / dust amounts eased by the view's fades)
        const fx = tokenFx();
        const lightK = v.ampL, dustK = v.ampD;
        if (lightK > 0.001 || dustK > 0.001) {
          const tx = off.x * o.width, ty = off.y * o.height, tl = Math.hypot(tx, ty), ll = Math.min(1, Math.hypot(look.x, look.y));
          u.uLook[0] = tl > 1e-9 ? (tx / tl) * ll : 0; u.uLook[1] = tl > 1e-9 ? (ty / tl) * ll : 0;
          if (lightK > 0.001) {
            light = effectAmount(TOKEN_LIGHT * fx.lightStrength, look) * lightK;
            rim = effectAmount(TOKEN_RIM * fx.lightStrength, look) * lightK;
          }
          if (dustK > 0.001) {
            dust = (fx.dust ? fx.dustStrength : lastDustS) * dustK;
            u.uDustScale = dustScale(Math.min(Math.hypot(wt.a, wt.b) * o.width, Math.hypot(wt.c, wt.d) * o.height));
            u.uTime = (fxTimeMs / 1000) % 3600;
          }
        }
      } else if (mesh && padded) {
        u.otherMatrix = this._m.identity();
        u.uTokToIn = this._inv.identity();
      }
      u.uOff[0] = off.x; u.uOff[1] = off.y;
      u.uLight = light; u.uRim = rim; u.uDust = dust;
      u.uSteps = stepsFor(off, this.dw, this.dh);
      if (v) v.applied++;
      counters.applies++;
      filterManager.applyFilter(this, input, output, clearMode);
      frameCpu += performance.now() - t0;
      if (testCostMs > 0) busyWait(testCostMs);
      // W6-U guard probe: the same pass again (writes the same pixels: invisible); the frame-time difference = our cost
      if (probeDouble) {
        filterManager.applyFilter(this, input, output, clearMode);
        if (testCostMs > 0) busyWait(testCostMs);
      }
    }
  };
  return FilterClass;
}

// ------------------------------------------------------------------ one token

class TokenView {
  constructor(token, info) {
    this.token = token;
    this.info = info;
    this.key = depthKey(info);
    this.src = token.document.texture.src;
    this.mesh = null;
    this.filter = null;
    this.entry = null;              // W6-U: the depth entry THIS view acquired (released exactly once)
    this.look = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };      // W6-U: look spring velocity
    this.target = { x: 0, y: 0 };
    this.settled = true;
    this.drive = drive();
    this.strength = strength();
    this.status = "loading";
    this.error = "";
    this.applied = 0;
    this.destroyed = false;
    this.animated = false;          // W6-P: one of the tokens allowed to animate at rest (cap)
    this.breath = ZERO;
    // W6-U: eased amounts (0..1) of breathing, dust and light; light starts where it is (no fade at load)
    this.ampB = 0; this.ampBV = 0; this.ampD = 0; this.ampDV = 0;
    this.ampL = tokenFx().light ? 1 : 0; this.ampLV = 0;
    this.onScreen = true;           // W6-U: camera drive, filter only on tokens on screen
    // W6-X: camera drive cap: in the set of MAX_CAMERA_TOKENS (nearest the screen centre), tilt amount eased 0..1
    this.camSel = false; this.ampC = 0; this.ampCV = 0;
    this.arming = false;            // W6-X: switched on early this frame (rest state shown), motion from the next step
    this.phase = phaseOf(token.document?.id ?? token.id);
    this._voidWrap = null; this._voidBase = null; this._voidOwn = false;
  }

  async load() {
    const e = this.entry = acquireDepth(this.info);
    try {
      const d = await e.p;
      if (this.destroyed) return;     // destroy() already released `e` (by object)
      if (e.dead || !d?.tex?.baseTexture) throw new Error("depth texture gone");
      this.filter = new (filterClass())(d.tex, d.w, d.h);
      this.filter.view = this;
      this.status = "ready";
      this.bindMesh();
      this.cameraRefresh();
      this.sync();
      kick();
    } catch (err) {
      this.releaseEntry();
      if (this.destroyed) return;
      this.status = "error";
      this.error = String(err?.message ?? err);
      if (err?.status === 404 || err?.status === 403) depthIndex.reportMissing(this.src);
      console.warn(`${MODULE_ID} | token parallax: ${this.src}`, err);
      this.unbindMesh();
    }
  }

  releaseEntry(now = false) {
    const e = this.entry;
    this.entry = null;
    if (e) releaseDepth(e, now);
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
    this.wrapVoid(mesh);
  }

  /**
   * W6-U (perf b): Foundry renders the token mesh a second time for the void (ERASE) pass, with its filters. That pass
   * only needs alpha and our filter keeps alpha unchanged: render it with our filter switched off for the call.
   */
  wrapVoid(mesh) {
    if (this._voidWrap && mesh._renderVoid === this._voidWrap) return;
    if (typeof mesh._renderVoid !== "function") return;
    const base = mesh._renderVoid, view = this;
    this._voidOwn = Object.prototype.hasOwnProperty.call(mesh, "_renderVoid");
    this._voidBase = base;
    this._voidWrap = function (renderer) {
      const f = view.filter;
      if (!f || !f.enabled) return base.call(this, renderer);
      f.enabled = false;
      counters.voidSkips++;
      try { return base.call(this, renderer); } finally { f.enabled = true; }
    };
    mesh._renderVoid = this._voidWrap;
  }

  unwrapVoid(mesh) {
    if (!mesh || !this._voidWrap) return;
    if (mesh._renderVoid === this._voidWrap) {
      if (this._voidOwn) mesh._renderVoid = this._voidBase;
      else delete mesh._renderVoid;
    }
    this._voidWrap = null; this._voidBase = null; this._voidOwn = false;
  }

  unbindMesh() {
    const mesh = this.mesh;
    this.mesh = null;
    if (!mesh) return;
    this.unwrapVoid(mesh);
    if (mesh.destroyed || !Array.isArray(mesh.filters)) return;
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

  /** W6-U (perf c): camera drive, is the token on screen (with a margin)? W6-X: for the NEXT render (fresh stage
   *  transform); a token that left the screen drops its camera / breathing / dust amounts at once (it is not drawn:
   *  invisible), so it can only come back from zero (fade in, no pop at the edge). */
  cameraRefresh() {
    if (this.drive !== "camera") { this.onScreen = true; return; }
    const t = this.token;
    try {
      const c = stageClient(t.center);
      const r = (Math.max(t.w || 0, t.h || 0) / 2) * (canvas.stage?.scale?.x || 1);
      this.onScreen = tokenOnScreen(c, r, globalThis.innerWidth || 1, globalThis.innerHeight || 1);
    } catch { this.onScreen = true; }
    if (!this.onScreen && (this.camSel || this.ampC || this.ampB || this.ampD || this.animated)) {
      this.camSel = false; this.animated = false; this.arming = false;
      this.ampC = this.ampCV = this.ampB = this.ampBV = this.ampD = this.ampDV = 0;
      this.breath = ZERO;
      counters.offScreenDrops++;
      pickDue = true;
    }
  }

  /** W6-X: the look the filter shows (pointer: the eased look; camera: screen place × camera amount + breathing). */
  effLook() {
    return this.drive === "camera" ? cameraEffLook(this.cameraLook(), this.ampC, this.breath, withBreath) : this.look;
  }

  /** Enabled only when it changes the picture (W6-U: and only once settled at rest; camera: only on screen;
   *  W6-X camera: and only while its eased camera / breathing / dust amount is above zero, i.e. in the capped set or
   *  fading out of it). */
  sync() {
    if (!this.filter) return;
    this.filter.enabled = this.drive === "camera"
      ? this.onScreen && (this.arming || this.ampC > AMP_ON || this.ampB > AMP_ON || this.ampD > AMP_ON)
      : !(this.settled && lookIsRest(this.look)) || this.ampD > 0.001;
  }

  /** W6-U: ease the extras' amounts (W6-X: and the camera amount); @returns {boolean} all settled */
  stepAmps(dt, fx) {
    const b = stepAmp(this.ampB, this.ampBV, this.animated && fx.breath ? 1 : 0, dt);
    const d = stepAmp(this.ampD, this.ampDV, this.animated && fx.dust ? 1 : 0, dt);
    const l = stepAmp(this.ampL, this.ampLV, fx.light ? 1 : 0, dt);
    const c = stepAmp(this.ampC, this.ampCV, this.drive === "camera" && this.camSel ? 1 : 0, dt, CAMERA_OMEGA);
    this.ampB = b.a; this.ampBV = b.v; this.ampD = d.a; this.ampDV = d.v; this.ampL = l.a; this.ampLV = l.v;
    this.ampC = c.a; this.ampCV = c.v;
    const bs = fx.breath ? fx.breathStrength : lastBreathS;
    this.breath = this.ampB > 0 && bs > 0 ? scaleLook(breathLook(fxTimeMs, bs, this.phase), this.ampB) : ZERO;
    return b.settled && d.settled && l.settled && c.settled;
  }

  /** W6-X: the eased state (to keep it for one frame when the filter is switched on: see shouldArm). */
  motionState() {
    return [this.look, this.vel, this.ampB, this.ampBV, this.ampD, this.ampDV, this.ampL, this.ampLV, this.ampC, this.ampCV, this.breath];
  }

  setMotionState(s) {
    [this.look, this.vel, this.ampB, this.ampBV, this.ampD, this.ampDV, this.ampL, this.ampLV, this.ampC, this.ampCV, this.breath] = s;
  }

  /** One eased step. @returns {boolean} still moving (look, or an extra's amount) */
  step(dt, fx = tokenFx()) {
    if (this.status !== "ready" || this.destroyed) return false;
    const t = this.token;
    if (!t || t.destroyed) return false;
    counters.stepped++;
    const wasOn = !!this.filter?.enabled;
    const before = wasOn ? null : this.motionState();
    this.arming = false;
    const ampsSettled = this.stepAmps(dt, fx);
    if (this.drive !== "pointer") {
      this.settled = ampsSettled;
    } else {
      let target = pointer ? pointerLook(pointer, t.center, Math.max(t.w || 0, t.h || 0)) : { x: 0, y: 0 };
      if (this.breath !== ZERO) target = withBreath(target, this.breath);
      this.target = target;
      const r = stepLook(this.look, this.vel, target, dt);
      this.look = r.look; this.vel = r.vel;
      this.settled = r.settled && ampsSettled;
    }
    this.sync();
    // W6-X: a disabled filter turns on one frame early, still showing the rest state; the motion starts next frame
    if (before && shouldArm(wasOn, this.filter?.enabled)) {
      this.setMotionState(before);
      this.settled = false;
      this.arming = true;             // sync() keeps it on until the next step (a pan's sync must not undo the arm)
      counters.armed++;
    }
    return !this.settled;
  }

  /** W6-U (perf d): pointer drive, does this view need a step this frame? */
  wantsStep(fx) {
    const t = this.token;
    if (this.status !== "ready" || !t || t.destroyed) return false;
    const ampWork = this.ampB + this.ampD + Math.abs(this.ampL - (fx.light ? 1 : 0));
    return needsStep({
      settled: this.settled, atRest: lookIsRest(this.look) && lookIsRest(this.vel), animated: this.animated, amp: ampWork,
      pointer, center: t.center, size: Math.max(t.w || 0, t.h || 0)
    });
  }

  destroy() {
    this.destroyed = true;
    this.unbindMesh();
    if (this.filter) {
      this.filter.view = null;
      try { this.filter.destroy(); } catch { /* gone */ }
      this.filter = null;
    }
    this.releaseEntry();
  }

  report() {
    return {
      token: this.token?.document?.uuid, image: this.src, depth: this.info.depth, rev: this.info.rev ?? null, status: this.status, error: this.error,
      enabled: !!this.filter?.enabled, onMesh: !!this.mesh?.filters?.includes?.(this.filter), look: { ...this.effLook() }, animated: this.animated,
      amp: { breath: this.ampB, dust: this.ampD, light: this.ampL, camera: this.ampC }, camSel: this.camSel, settled: this.settled, onScreen: this.onScreen,
      depthOk: !!this.filter?.uniforms?.uDepth?.baseTexture && !this.entry?.dead,
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
  pickDue = false;
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
  // W6-U: a new revision of the map (task D's `rev`) = a new texture
  if (v && (v.src !== src || v.key !== depthKey(info) || v.status === "error")) { detach(token); v = null; }
  if (v) { v.drive = drive(); v.strength = strength(); v.bindMesh(); v.cameraRefresh(); v.sync(); return; }
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

// ------------------------------------------------------------------ frame loop + guard

function maxGapMs() {
  const fps = Number(canvas?.app?.ticker?.maxFPS) || 0;
  return Math.max(55, fps > 0 ? 1600 / fps : 0);
}

function ensureGuard() {
  if (!guard) guard = createFrameGuard({ maxGapMs: maxGapMs(), maxDrawMs: Infinity });
  return guard;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const meanCpu = () => (cpuHist.length ? cpuHist.reduce((s, x) => s + x, 0) / cpuHist.length : 0);

/**
 * W6-U (perf e): decide from the module's OWN cost. The page-gap guard only raises the question; an invisible A/B
 * probe (our passes doubled in alternating 8-frame blocks) answers it. Unrelated slow frames = "notUs" (the guard
 * resets and waits 15 s before asking again). Last resort: our CPU time in the applies alone > 8 ms per frame.
 * @returns {boolean} switched off
 */
function guardFrame(gap, now) {
  cpuHist.push(frameCpu);
  if (cpuHist.length > 90) cpuHist.shift();
  if (probe) {
    const f = probeFrame(probe.i);
    if (f.use && gap > 0 && gap <= 250) (probe.cur ? probe.b : probe.a).push(gap);
    probe.i++;
    const next = probeFrame(probe.i);
    if (next.done) {
      const v = guardVerdict({ base: median(probe.a), probe: median(probe.b), ownCpuMs: meanCpu() });
      lastVerdict = { verdict: v, base: median(probe.a), probe: median(probe.b), ownCpuMs: meanCpu(), at: Date.now() };
      probe = null; probeDouble = false;
      if (v === "slow") { tooSlow(); return true; }
      guard?.reset();
      probeUntil = now + 15_000;
      return false;
    }
    probe.cur = next.double;
    probeDouble = next.double;
    return false;
  }
  if (cpuHist.length >= 30 && guardVerdict({ ownCpuMs: meanCpu() }) === "slow") {
    lastVerdict = { verdict: "slow", hard: true, ownCpuMs: meanCpu(), at: Date.now() };
    tooSlow();
    return true;
  }
  if (gap > 0 && ensureGuard().push(gap, 0) === "bad" && now >= probeUntil) {
    probe = { i: 0, a: [], b: [], cur: false };
    probeDouble = false;
  }
  return false;
}

/**
 * W6-P: which tokens may animate at rest (breathing / dust): in view and visible, nearest the pointer (else the screen
 * centre), at most MAX_ANIMATED_TOKENS. The others keep the pre-W6-P behaviour (flat unless the pointer is near).
 * W6-U: a token leaving the set fades its breathing / dust out (and one joining fades in) instead of switching.
 */
function repick() {
  const fx = tokenFx();
  const camera = drive() === "camera";
  pickDue = false;
  const W = globalThis.innerWidth || 1, H = globalThis.innerHeight || 1;
  const items = [];
  if ((fx.animates || camera) && canvas?.ready) {
    const zoom = canvas.stage?.scale?.x || 1;
    for (const v of views.values()) {
      const t = v.token;
      if (v.status !== "ready" || !t || t.destroyed) continue;
      // W6-X: the stage transform of the next render (a pan since the last render already counts)
      const c = stageClient(t.center);
      if (!c) continue;
      const r = (Math.max(t.w || 0, t.h || 0) / 2) * zoom;
      const shown = t.visible !== false;
      items.push({ key: v, x: c.x, y: c.y, r, inView: shown && inView(c.x, c.y, r, W, H), onScreen: shown && v.onScreen, selected: v.camSel });
    }
  }
  const center = { x: W / 2, y: H / 2 };
  // W6-X: camera drive: at most MAX_CAMERA_TOKENS carry the tilt (nearest the centre, hysteresis); the same set
  // breathes / gathers dust, so a camera scene never has more than the cap of filters on. Pointer drive as before.
  const camSet = camera ? pickCamera(items, { center, cap: MAX_CAMERA_TOKENS }) : new Set();
  const pick = camera ? (fx.animates ? camSet : new Set())
    : pickAnimated(items, { pointer: pointerClient, center, cap: MAX_ANIMATED_TOKENS });
  for (const v of views.values()) {
    const a = pick.has(v), c = camSet.has(v);
    if (a !== v.animated) { v.animated = a; v.settled = false; }
    if (c !== v.camSel) { v.camSel = c; v.settled = false; }
    v.sync();
  }
}

/** Ticker callback: eases looks and amounts and feeds the frame guard while the effect moves. */
function tick() {
  const ticker = canvas?.app?.ticker;
  const now = performance.now();
  const gap = lastTickT ? now - lastTickT : 0;
  lastTickT = now;
  const dt = Math.min(0.1, Math.max(0, (ticker?.deltaMS ?? 16) / 1000));
  counters.frames++;
  const fx = tokenFx();
  if (fx.breath) lastBreathS = fx.breathStrength;
  if (fx.dust) lastDustS = fx.dustStrength;
  // W6-U: continuous clock for breathing / dust (the 30 fps clock made the motion visibly stepped)
  fxTimeMs = now;
  if (panStale) {
    panStale = false;
    rereadAfterPan();
  }
  const camera = drive() === "camera";
  if ((fx.animates || (camera && pickDue)) && now - lastPickT >= PICK_MS) { lastPickT = now; repick(); }
  let moving = false, enabled = 0, extras = false;
  for (const v of views.values()) {
    const go = v.drive === "pointer" ? v.wantsStep(fx) : (!v.settled || (fx.animates && (v.animated || v.ampB > 0 || v.ampD > 0)));
    if (go) moving = v.step(dt, fx) || moving;
    if (v.filter?.enabled) enabled++;
    if (v.ampB > 0 || v.ampD > 0) extras = true;
  }
  const panning = now < panUntil;
  const animating = (fx.animates && animatedNow() > 0) || extras;
  // the guard only listens while the effect moves on screen (frames of a still scene say nothing about us)
  if ((moving || panning || animating) && enabled > 0 && guardFrame(gap, now)) return;
  frameCpu = 0;
  // W6-X: camera drive keeps the loop until a pending re-pick ran (pan / resize / a token moved)
  if (!moving && !panning && !animating && !(camera && pickDue)) stopLoop();
}

/** W6-U: after a pan / zoom (fresh worldTransform): the pointer under the unmoved mouse, camera on-screen boxes. */
function rereadAfterPan() {
  if (pointerClient) {
    try { pointer = canvas.canvasCoordinatesFromClient(pointerClient); } catch { /* torn down */ }
  }
  for (const v of views.values()) if (v.drive === "camera") { v.cameraRefresh(); v.sync(); pickDue = true; }
}

/** W6-U: the view moved without a pointer event (wheel zoom, keys, animatePan, pings): re-read the pointer, camera boxes. */
function onPan() {
  if (!views.size) return;
  // the stage's worldTransform is only updated by the next render: re-read in the tick (it runs after the render)
  panStale = true;
  // W6-X: camera boxes at once from the fresh stage transform (a token leaving the screen drops its amounts before
  // the render that no longer shows it; one coming in starts from zero)
  for (const v of views.values()) if (v.drive === "camera") { v.cameraRefresh(); v.sync(); pickDue = true; }
  if (tokenFx().animates) lastPickT = 0;   // W6-P: tokens panned into view may start animating
  if ([...views.values()].some((v) => v.drive === "camera" && v.filter?.enabled)) panUntil = performance.now() + 500;
  kick();
}

function kick() {
  if (loopOn || !views.size || !canvas?.app?.ticker) return;
  if (document.hidden) return;
  loopOn = true;
  lastTickT = 0;
  frameCpu = 0;
  canvas.app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY?.LOW ?? -25);
}

function stopLoop() {
  if (!loopOn) return;
  loopOn = false;
  lastTickT = 0;
  probe = null; probeDouble = false;
  try { canvas?.app?.ticker?.remove(tick); } catch { /* torn down */ }
}

function tooSlow() {
  disabled = "slow";
  probe = null; probeDouble = false;
  console.warn(`${MODULE_ID} | token parallax turned off on this page: the effect itself is too slow`, guard?.state(), lastVerdict);
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
  // W6-U: saving the form as a GM confirms "on" in the scene's GM-only list (also for an unchanged, older plain "on")
  const form = root.tagName === "FORM" ? root : root.querySelector("form");
  // The AppV2 <form> survives re-renders: one listener per form, reading the select that is in the form at submit time
  // (a listener per render would also fire with the detached, stale selects of earlier renders).
  if (form && doc.parent?.documentName === "Scene" && !form.dataset.aiimgPlxSubmit) {
    form.dataset.aiimgPlxSubmit = "1";
    form.addEventListener("submit", () => {
      const cur = form.querySelector(`select[name="flags.${MODULE_ID}.${FLAG}"]`);
      if (cur) mirrorGmOn(doc, cur.value).catch((e) => console.warn(`${MODULE_ID} | token parallax`, e));
    });
  }
}

// ------------------------------------------------------------------ registration

const flagChanged = (changes, flag = FLAG) => foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${flag}`)
  || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=${flag}`) || foundry.utils.hasProperty(changes, `flags.-=${MODULE_ID}`);

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
    if (v.drive === "camera") { v.cameraRefresh(); v.sync(); pickDue = true; kick(); }   // W6-U: moved into / out of the screen (W6-X: re-pick the capped set)
    if (v.drive === "pointer" && pointer) kick();
  });
  Hooks.on("updateToken", (doc, changes, _options, userId) => {
    // W6-U: a GM's own change of the mode keeps the scene's GM list in step (other users' changes never add to it)
    if (flagChanged(changes) && userId === game.user?.id) mirrorGmOn(doc, tokenMode(doc)).catch(() => {});
    if (doc.parent !== canvas?.scene) return;
    if (flagChanged(changes) || foundry.utils.hasProperty(changes, "texture.src") || foundry.utils.hasProperty(changes, "ring")) {
      if (doc.object) attach(doc.object).catch(() => {});
    }
  });
  // W6-U: a token a GM places with "on" (e.g. from a prototype) is confirmed by that GM
  Hooks.on("createToken", (doc, _options, userId) => {
    if (userId === game.user?.id && tokenMode(doc) === "on") mirrorGmOn(doc, "on").catch(() => {});
  });
  Hooks.on("updateScene", (scene, changes) => {
    if (scene === canvas?.scene && (flagChanged(changes) || flagChanged(changes, FLAG_GM_ON))) refreshTokens();
  });
  Hooks.on("canvasPan", () => onPan());
  Hooks.on("renderTokenHUD", hudButton);
  Hooks.on("renderSceneConfig", sceneConfigField);
  Hooks.on("renderTokenConfig", tokenConfigField);
  depthIndex.onChange(() => refreshTokens());
  try { globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", () => { fxCache = null; refreshTokens(); }); } catch { /* old engine */ }
  globalThis.addEventListener?.("pointermove", onPointerMove, { passive: true });
  globalThis.document?.addEventListener?.("pointerout", onPointerOut, { passive: true });
  globalThis.document?.addEventListener?.("visibilitychange", () => { if (!document.hidden) kick(); });
  globalThis.addEventListener?.("resize", () => onPan(), { passive: true });
}

/** World settings (init, from settings.mjs). */
export function registerTokenSettings() {
  const onChange = () => {
    if (worldOn() && disabled === "slow") { disabled = ""; guard = null; }
    for (const v of views.values()) {
      v.drive = drive(); v.strength = strength(); v.settled = false;
      if (v.drive !== "camera") { v.camSel = false; v.ampC = v.ampCV = 0; }
      v.cameraRefresh(); v.sync();
    }
    pickDue = true; lastPickT = 0;   // W6-X: camera set picked again
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
  // W6-P extras for tokens (W6-Q: world scope, set by the GM; + the per-device opt-out), next to the token parallax settings
  registerFxSettings("token", () => {
    fxCache = null;
    lastPickT = 0;
    // W6-U: no hard switch: the views' amounts fade to the new settings in the loop
    if (!tokenFx().animates) for (const v of views.values()) v.animated = false;
    for (const v of views.values()) { v.settled = false; v.sync(); }
    pickDue = true;
    kick();
  });
}

/** For macros / checks: `api.parallax.tokens`. */
export const tokenApi = {
  status: () => ({
    active: tokenParallaxActive(), setting: worldOn(), scene: sceneOn(), drive: drive(), strength: strength(), disabled,
    reducedMotion: reducedMotion(), loop: loopOn, pointer: pointer ? { ...pointer } : null, guard: guard?.state() ?? null,
    fx: { ...tokenFx() }, animated: animatedNow(), maxAnimated: MAX_ANIMATED_TOKENS,
    cameraSelected: cameraNow(), maxCamera: MAX_CAMERA_TOKENS, enabled: countViews((v) => !!v.filter?.enabled),
    depthTextures: depthCache.entries().map((e) => ({ key: e.key, refs: e.refs, ready: !!e.value, alive: !!e.value?.tex?.baseTexture, releasing: !!e.timer })),
    guardProbe: probe ? { i: probe.i, a: probe.a.length, b: probe.b.length } : null, lastVerdict, probeUntil, ownCpuMs: meanCpu(),
    worker: workerBroken ? "broken" : worker ? "on" : "idle",
    counters: { ...counters },
    views: [...views.values()].map((v) => v.report())
  }),
  refresh: () => refreshTokens(),
  /** Turn the feature back on after the slow-frame guard switched it off (this page). */
  resume: () => { if (disabled === "slow") disabled = ""; guard = null; probe = null; probeDouble = false; probeUntil = 0; cpuHist.length = 0; refreshTokens(); },
  /** Checks: put the pointer at a canvas point (null = off the board) and run the easing, as a real move would. */
  setPointer: (p) => { pointer = p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : null; kick(); return !!pointer; },
  /** Checks in a throttled tab: step the easing `n` times by `dt` seconds without the ticker. */
  stepNow: (n = 1, dt = 0.05) => {
    let moving = false;
    const fx = tokenFx();
    for (let i = 0; i < n; i++) {
      moving = false;
      fxTimeMs += dt * 1000;
      if (fx.animates || drive() === "camera") repick();
      for (const v of views.values()) if (v.drive === "pointer" ? v.wantsStep(fx) : (!v.settled || (fx.animates && (v.animated || v.ampB > 0 || v.ampD > 0)))) moving = v.step(dt, fx) || moving;
    }
    return { moving, enabled: countViews((v) => !!v.filter?.enabled), animated: animatedNow(), camera: cameraNow() };
  },
  /** W6-P checks: re-pick the tokens allowed to animate at rest now; optional pointer in client px. */
  pick: (client) => { if (client !== undefined) pointerClient = client ? { x: Number(client.x) || 0, y: Number(client.y) || 0 } : null; repick(); return animatedNow(); },
  /** Why a token does / does not carry the filter ("" = it may). */
  whyNot: (token) => whyNot(token),
  /** W6-U checks: simulated GPU cost per filter pass in ms (guard test), delay of every depth load in ms (F2 repro). */
  _test: ({ costMs, loadDelayMs } = {}) => {
    if (costMs !== undefined) testCostMs = Math.max(0, Number(costMs) || 0);
    if (loadDelayMs !== undefined) testLoadDelayMs = Math.max(0, Number(loadDelayMs) || 0);
    return { costMs: testCostMs, loadDelayMs: testLoadDelayMs };
  }
};
