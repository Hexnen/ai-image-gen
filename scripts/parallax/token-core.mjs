// W6-O: pure parts of the depth parallax on canvas TOKENS (parallax/token-parallax.mjs): who gets the effect (world /
// scene / token switches, unsupported tokens), the look vector (pointer near the token, or the token's place on the
// screen), the uv offset in the token texture for any token transform (scale, mirror, rotation), half-float packing of
// the conditioned depth map, the depth texture size, and the PIXI filter's GLSL (a port of the parallax window's ray
// search, parallax-gl.mjs FS, to GLSL ES 1.0 for Foundry's PIXI 7 context). No PIXI, no Foundry: tested in Node
// (dev/test-token-parallax.mjs). W6-P: the optional light / rim / dust use the window's own GLSL (parallax-fx.mjs
// GLSL_FX, included verbatim), gated by their amounts (all 0 = the W6-O output) and applied before the input alpha.
import { clampLook, MAX_SHIFT, conditionDepth, downscaleMap } from "./parallax-core.mjs";
import { GLSL_FX } from "./parallax-fx.mjs";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => clamp(v, 0, 1);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export const TOKEN_MODES = Object.freeze(["", "on", "off"]);
export const DRIVES = Object.freeze(["pointer", "camera"]);
export const STRENGTH_RANGE = Object.freeze([0.1, 1, 0.05]);
export const STRENGTH_DEFAULT = 0.5;

/**
 * Does this token want the effect? World switch first (off = nothing anywhere), then the token's own "off" (honoured
 * from anyone: an owner may always switch his own token off), then the scene switch (default off). W6-U: the token's
 * "on" beats an OFF scene only when a GM confirmed it (`gmOn`: the token id is in the scene's GM-only list, see
 * gmOnList; scenes can only be updated by a GM, so an owner cannot forge it). A plain "on" without that confirmation
 * (an owner's setFlag, or a flag set before W6-U) works like "like the scene".
 */
export function tokenWanted({ world = true, scene = false, token = "", gmOn = false } = {}) {
  if (!world) return false;
  if (token === "off") return false;
  if (token === "on" && gmOn) return true;
  return !!scene;
}

/** W6-U: the scene flag holding the ids of tokens a GM switched "on" (tolerant reader: junk = empty). */
export function gmOnList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 64))];
}

/** W6-U: the list after a GM set a token's mode to `mode` (null = no change needed). */
export function gmOnListAfter(raw, tokenId, mode) {
  const list = gmOnList(raw);
  if (!tokenId) return null;
  const has = list.includes(tokenId);
  if (mode === "on" && !has) return [...list, tokenId];
  if (mode !== "on" && has) return list.filter((x) => x !== tokenId);
  return null;
}

// ------------------------------------------------------------------ W6-U: smoothing (dt-based, frame-rate independent)

/** Look spring (|look| units): ω 11 rad/s ≈ the old 0.12 s half-life ease in lag, but with no velocity jump at the start. */
export const LOOK_OMEGA = 11;
/** Breathing / dust amplitude (0..1) when a token joins or leaves the animated set, or an extra is switched: ~1.5 s fade. */
export const AMP_OMEGA = 4;
export const REST_EPS = 1e-3;

/**
 * One step of a critically damped spring towards `target` (exact solution for a constant target over `dt` seconds, so
 * the motion is the same at 30, 60 or 144 fps and the velocity is continuous: no snap when the target jumps).
 * @returns {{x:number, v:number}}
 */
export function springStep(x, v, target, dt, omega) {
  if (!(dt > 0) || !(omega > 0)) return { x, v };
  const d = x - target, e = Math.exp(-omega * dt), k = v + omega * d;
  return { x: target + (d + k * dt) * e, v: (v - omega * k * dt) * e };
}

/** Is a spring (practically) settled on its target? */
export const springSettled = (x, v, target, eps = REST_EPS) => Math.abs(x - target) < eps && Math.abs(v) < eps * 10;

/** 2D look spring: {look, vel} -> {look, vel, settled}; settled snaps exactly onto the target. */
export function stepLook(look, vel, target, dt, omega = LOOK_OMEGA) {
  const sx = springStep(look.x, vel.x, target.x, dt, omega), sy = springStep(look.y, vel.y, target.y, dt, omega);
  const settled = springSettled(sx.x, sx.v, target.x) && springSettled(sy.x, sy.v, target.y);
  return settled ? { look: { x: target.x, y: target.y }, vel: { x: 0, y: 0 }, settled }
    : { look: { x: sx.x, y: sy.x }, vel: { x: sx.v, y: sy.v }, settled };
}

/**
 * W6-X: the filter is switched on ONE FRAME EARLY: when a step would turn a disabled filter on, the view keeps its
 * previous (rest) state for that frame (the picture is identical to no filter: zero offset, no light, no dust) and the
 * motion starts in the next frame. So no frame ever jumps from "no filter" straight to a visibly shifted picture.
 * @returns {boolean} arm this frame (keep the old state, enable the filter)
 */
export const shouldArm = (wasEnabled, nowEnabled) => !wasEnabled && !!nowEnabled;

/** Scalar amplitude spring 0..1 (clamped), settled snaps onto the target. */
export function stepAmp(a, v, target, dt, omega = AMP_OMEGA) {
  const s = springStep(a, v, target, dt, omega);
  if (springSettled(s.x, s.v, target)) return { a: target, v: 0, settled: true };
  return { a: clamp01(s.x), v: s.v, settled: false };
}

/** Breathing look scaled by its fade amplitude (0 = none). */
export const scaleLook = (l, k) => (k > 0 && l ? { x: l.x * k, y: l.y * k } : { x: 0, y: 0 });

/**
 * W6-U (perf d): does a view need a pointer-drive step this frame? Settled views AT REST far from the pointer (beyond
 * the fade radius plus a margin) and without any animation keep their state without work (a tilted one must return).
 */
export function needsStep({ settled = true, atRest = true, animated = false, amp = 0, pointer = null, center = null, size = 0, far = 2.5 } = {}) {
  if (!settled || !atRest || animated || amp > 0) return true;
  if (!pointer || !center || !(size > 0)) return false;
  return Math.hypot(pointer.x - center.x, pointer.y - center.y) < (far + 0.25) * size;
}

/** W6-U (perf c): camera drive: is the token's screen box (client px, centre + half size) on screen, with a margin? */
export const tokenOnScreen = (c, r, w, h, margin = 32) => !!c && c.x + r > -margin && c.y + r > -margin && c.x - r < w + margin && c.y - r < h + margin;

// ------------------------------------------------------------------ W6-X: camera drive cap

/** W6-X: tokens that carry the camera tilt at once (like the pointer drive's cap of animated tokens). */
export const MAX_CAMERA_TOKENS = 12;
/** W6-X: camera tilt amount (0..1) fade when a token joins / leaves the camera set: ~1 s, no pop. */
export const CAMERA_OMEGA = 6;
/** W6-X: an eased amount above this switches the filter on (the first step of a fade from 0 is far below 0.01 look). */
export const AMP_ON = 1e-3;

/**
 * W6-X: which tokens carry the camera tilt (and, in camera drive, breathing / dust). `items` = [{key, x, y, r, onScreen,
 * selected}] in screen px (r = half the token's size on screen). Only tokens on screen qualify; the nearest to the
 * screen centre `center` win, measured to the token's EDGE (so a big token near the middle beats a small one), at most
 * `cap`. Hysteresis: a token already in the set counts its distance × `keep` minus `keepPx` (no churn at the border
 * while panning). Ties keep the input order. @returns {Set} of keys.
 */
export function pickCamera(items, { center = { x: 0, y: 0 }, cap = MAX_CAMERA_TOKENS, keep = 0.8, keepPx = 24 } = {}) {
  const n = Math.max(0, Math.floor(Number(cap) || 0));
  if (!n || !Array.isArray(items)) return new Set();
  const list = [];
  items.forEach((it, i) => {
    if (!it || !it.onScreen) return;
    let d = Math.max(0, Math.hypot((it.x ?? 0) - center.x, (it.y ?? 0) - center.y) - Math.max(0, it.r || 0));
    if (it.selected) d = d * keep - keepPx;
    list.push({ it, i, d });
  });
  list.sort((a, b) => a.d - b.d || a.i - b.i);
  return new Set(list.slice(0, n).map((e) => e.it.key));
}

/**
 * W6-X: the look a token shows in camera drive: its screen-place look scaled by its camera amount, then the breathing.
 * (camera look + breath as before W6-X once the amount has settled at 1.)
 */
export function cameraEffLook(camLook, ampC, breath, combine) {
  let l = ampC > 0 && camLook ? { x: camLook.x * ampC, y: camLook.y * ampC } : { x: 0, y: 0 };
  if (breath && (breath.x || breath.y)) l = combine(l, breath);
  return l;
}

// ------------------------------------------------------------------ W6-U: depth texture identity (W6-R `rev`)

/** Cache key of a depth texture: the map file plus its revision (a new revision = a new texture; 0 / none = old entry). */
export const depthKey = (info) => `${info?.depth ?? ""}${info?.rev ? `#${info.rev}` : ""}`;

/**
 * W6-U: shared depth textures with reference counts. `acquire(info)` returns the ENTRY ({key, refs, p, value, dead,
 * timer}); `release(entry)` drops exactly that entry's reference (never "whatever entry has this path now"); the last
 * release destroys it after `releaseMs` (or at once), `destroyAll()` on scene tear-down. `build(info)` -> Promise of
 * the value, `dispose(value)` frees it. Timers injectable for tests.
 */
export function createDepthCache({ build, dispose, releaseMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const map = new Map();
  const kill = (e) => {
    if (e.timer) clearTimer(e.timer);
    e.timer = 0;
    if (e.dead) return;
    e.dead = true;
    if (map.get(e.key) === e) map.delete(e.key);
    e.p.then((v) => { try { dispose(v); } catch { /* gone */ } }, () => {});
  };
  return {
    acquire(info) {
      const key = depthKey(info);
      let e = map.get(key);
      if (!e) {
        const entry = { key, refs: 0, timer: 0, value: null, p: null, dead: false };
        entry.p = Promise.resolve().then(() => build(info)).then((v) => { entry.value = v; return v; });
        entry.p.catch(() => { if (map.get(key) === entry) map.delete(key); });
        map.set(key, entry);
        e = entry;
      }
      if (e.timer) clearTimer(e.timer);
      e.timer = 0;
      e.refs++;
      return e;
    },
    release(e, now = false) {
      if (!e || e.dead) return;
      e.refs = Math.max(0, e.refs - 1);
      if (e.refs > 0) return;
      if (e.timer) clearTimer(e.timer);
      if (now) kill(e);
      else e.timer = setTimer(() => { e.timer = 0; if (e.refs === 0) kill(e); }, releaseMs);
    },
    destroyAll() { for (const e of [...map.values()]) kill(e); },
    get: (key) => map.get(key),
    entries: () => [...map.values()]
  };
}

// ------------------------------------------------------------------ W6-U: frame guard decision from the module's OWN cost

/**
 * The page's frames were slow while we animated (the plain gap guard said "bad"). Is it us? `base` = median frame gap
 * with our filters as they are, `probe` = median gap while every enabled filter of ours ran TWICE (an invisible A/B:
 * the second pass writes the same pixels). Our cost ≈ probe − base. We are guilty when that cost is a large part of the
 * frame (≥ `share` of base and ≥ `minMs`). `ownCpuMs` = mean CPU ms per frame inside our filter applies: a last-resort
 * hard limit (`hardCpuMs`) that needs no probe.
 * @returns {"slow"|"notUs"|"probe"}
 */
export function guardVerdict({ base = null, probe = null, ownCpuMs = 0, minMs = 6, share = 0.25, hardCpuMs = 8 } = {}) {
  if (ownCpuMs > hardCpuMs) return "slow";
  if (!(base > 0) || !(probe > 0)) return "probe";
  const cost = probe - base;
  return cost >= minMs && cost >= share * base ? "slow" : "notUs";
}

/**
 * Why a token cannot carry the filter ("" = supported). Skipped silently: previews (drag / config clones), videos,
 * dynamic token rings (the ring shader scales the subject inside the mesh: the map would not line up), no real image.
 */
export function unsupportedReason({ preview = false, video = false, ring = false, src = "", meshOk = true } = {}) {
  if (preview) return "preview";
  if (!meshOk) return "mesh";
  if (!src || /^(data|blob):/i.test(src) || /\.svg(\?|#|$)/i.test(src)) return "image";
  if (/\.(webm|mp4|m4v|ogv|ogg|mov)(\?|#|$)/i.test(src) || video) return "video";
  if (ring) return "ring";
  return "";
}

/**
 * Pointer mode: look vector of a token from the pointer (canvas coords). Direction = towards the pointer, full tilt at
 * `reach` × half the token size from its centre; fades out between `near` and `far` token sizes away (tokens far from
 * the pointer stay flat, so only a handful carry an active filter).
 */
export function pointerLook(pointer, center, size, { reach = 1.25, near = 1, far = 2.5 } = {}) {
  if (!pointer || !center || !(size > 0)) return { x: 0, y: 0 };
  const dx = pointer.x - center.x, dy = pointer.y - center.y;
  const r = (size / 2) * reach;
  const dir = clampLook(dx / r, dy / r);
  const fade = 1 - smooth(near * size, far * size, Math.hypot(dx, dy));
  return { x: dir.x * fade, y: dir.y * fade };
}

/**
 * Camera mode: look vector from where the token sits on the screen (centre of the screen = flat, the short half-side
 * away = full tilt). Panning the view moves the layers.
 */
export function cameraLook(client, screenW, screenH) {
  if (!client || !(screenW > 0 && screenH > 0)) return { x: 0, y: 0 };
  const half = Math.min(screenW, screenH) / 2;
  return clampLook((client.x - screenW / 2) / half, (client.y - screenH / 2) / half);
}

/**
 * uv offset in the token texture (depth 1 vs depth 0) for a SCREEN-space look: the shift is |look| × strength ×
 * MAX_SHIFT × the token's shorter displayed side, along the look direction on screen, mapped back through the inverse
 * of the mesh's linear transform (PIXI matrix: x' = a·x + c·y, y' = b·x + d·y). So the layers always move towards the
 * pointer on screen, whatever the token's scale, mirror or rotation. {0, 0} for a degenerate transform.
 */
export function uvOffset(look, strength, wt, origW, origH) {
  if (!wt || !(origW > 0 && origH > 0)) return { x: 0, y: 0 };
  const l = clampLook(Number(look?.x) || 0, Number(look?.y) || 0);
  const sw = Math.hypot(wt.a, wt.b) * origW, sh = Math.hypot(wt.c, wt.d) * origH;
  const px = clamp01(strength) * MAX_SHIFT * Math.min(sw, sh);
  const vx = l.x * px, vy = l.y * px;
  const det = wt.a * wt.d - wt.b * wt.c;
  if (!det || !Number.isFinite(det)) return { x: 0, y: 0 };
  const lx = (wt.d * vx - wt.c * vy) / det, ly = (-wt.b * vx + wt.a * vy) / det;
  return { x: lx / origW, y: ly / origH };
}

/** Normalise the strength setting into its range (default for junk). */
export function cleanStrength(v) {
  const n = Number(v);
  if (v === null || v === "" || !Number.isFinite(n)) return STRENGTH_DEFAULT;
  const [min, max, step] = STRENGTH_RANGE;
  return Math.round((Math.round((clamp(n, min, max) - min) / step) * step + min) * 1000) / 1000;
}

/** Integer box-downscale factor so the depth texture's longer side is ≤ `maxSide` (tokens are small on screen). */
export function depthFactor(w, h, maxSide = 512) {
  const m = Math.max(w || 0, h || 0);
  return m > maxSide ? Math.ceil(m / maxSide) : 1;
}

// W6-U (perf a): one shared scratch view (was two typed arrays allocated per call: ~1M calls per map, 300 ms -> ~9 ms)
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
/** IEEE 754 binary16 bits of a float (round to nearest even, clamped to ±65504, NaN kept). */
export function floatToHalf(v) {
  if (Number.isNaN(v)) return 0x7e00;
  F32[0] = v;
  return bitsToHalf(U32[0]);
}

/** binary16 bits from the binary32 bits `x` (shared by floatToHalf and the one-pass toHalfArray). */
function bitsToHalf(x) {
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00; // inf
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7bff;  // clamp to max finite
  if (exp <= 0) {
    if (exp < -10) return sign;             // underflow to zero
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (h & 1))) h++;
    return sign | h;
  }
  let h = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return sign | h;
}

/** binary16 bits -> float (tests). */
export function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Float32Array -> Uint16Array of binary16 (the RGBA16F upload of the conditioned depth). */
export function toHalfArray(src) {
  const out = new Uint16Array(src.length);
  // one pass over the float bits (a Float32Array source is read in place; other arrays are copied once)
  const f = src instanceof Float32Array ? src : Float32Array.from(src);
  const bits = new Uint32Array(f.buffer, f.byteOffset, f.length);
  for (let i = 0; i < bits.length; i++) {
    const x = bits[i];
    out[i] = ((x >>> 23) & 0xff) === 0xff && (x & 0x7fffff) ? 0x7e00 : bitsToHalf(x);
  }
  return out;
}

/** W6-V: conditioning of token maps (worker loader and the inline / own-worker fallback): normals from the guided,
 *  display-scale smoothed copy (parallax-core normalSource), no extra box blur. */
export const TOKEN_CONDITION = Object.freeze({ dilatePx: 2, normalBlurPx: 0, normals: "guided" });

/**
 * W6-U: the CPU part of a depth texture, off the main thread (token-depth-worker.mjs) or inline as a fallback:
 * box-downscale to ≤ `maxSide`, condition (W6-V: normals from the guided smoothed copy), pack as binary16.
 * `src` = {D, mask, w, h, bits, format}. @returns {{half: Uint16Array, w: number, h: number}}
 */
export function prepareDepthTexture(src, maxSide = 512) {
  const f = depthFactor(src.w, src.h, maxSide);
  if (f >= 2) {
    const d = downscaleMap(src.D, src.w, src.h, f);
    src = { ...src, D: d.M, mask: src.mask ? downscaleMap(src.mask, src.w, src.h, f).M : null, w: d.w, h: d.h };
  }
  const c = conditionDepth(src, TOKEN_CONDITION);
  return { half: toHalfArray(c.rgba), w: c.w, h: c.h };
}

/**
 * W6-U guard probe: frame `i` of the A/B probe. Blocks of 8 frames alternate normal / doubled filter passes; the first
 * 2 frames of each block are dropped (GPU work spills into the next frame). `done` after `blocks` blocks.
 */
export function probeFrame(i, { block = 8, skip = 2, blocks = 8 } = {}) {
  const b = Math.floor(i / block);
  return { double: b % 2 === 1, use: i % block >= skip, done: b >= blocks };
}

/** Is a look (practically) zero? Then the filter is disabled: the token renders exactly as without the module. */
export const lookIsRest = (l, eps = 0.002) => !l || Math.hypot(l.x || 0, l.y || 0) < eps;

// ------------------------------------------------------------------ GLSL (PIXI 7 legacy filter, GLSL ES 1.0)

/**
 * Vertex: the same as PIXI's SpriteMaskFilter; `otherMatrix` (FilterSystem.calculateSpriteMatrix) maps the filter's
 * input uv to the token texture's uv (0..1 over the texture's orig frame), whatever the mesh transform.
 */
export const TOKEN_VS = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
uniform mat3 otherMatrix;
varying vec2 vTextureCoord;
varying vec2 vTokUv;
void main(void){
  gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = aTextureCoord;
  vTokUv = (otherMatrix * vec3(aTextureCoord, 1.0)).xy;
}`;

/**
 * Fragment: ray search from the near plane down (linear steps + 6 bisections, as parallax-gl.mjs FS / parallax-core
 * marchRay), then the colour is read from the filter's INPUT (the token as Foundry drew it: tint, alpha, other effects)
 * at the found position, plus the far-side hole fill. The output alpha is ALWAYS the input's own alpha at this pixel:
 * the silhouette, transparent areas, borders and hit areas stay exactly as they were; only colours inside move.
 */
export const TOKEN_FS = `precision highp float;
varying vec2 vTextureCoord;
varying vec2 vTokUv;
uniform sampler2D uSampler;
uniform sampler2D uDepth;     // r depth, g blurred, b mask, a background depth (parallax-core conditionDepth)
uniform vec4 inputClamp;
uniform vec4 inputPixel;
uniform mat3 uTokToIn;        // token uv -> input uv (inverse of otherMatrix)
uniform vec2 uOff;            // uv shift between depth 1 and depth 0
uniform vec2 uDTexel;
uniform float uFocus;
uniform float uGamma;
uniform float uContrast;
uniform float uHoleFill;
uniform float uSteps;
uniform vec2 uLook;           // W6-P: look in token-texture space (light direction), unit disc
uniform float uLight;         // W6-P: light / rim / dust amounts (0 = off: the pre-W6-P output, untouched)
uniform float uRim;
uniform float uRelief;       // W6-V: height of depth 1 as a fraction of the short side (parallax-fx LIGHT.relief)
uniform float uDust;
uniform float uDustScale;
uniform float uTime;

float cond(float d){ float g = pow(clamp(d, 0.0, 1.0), uGamma); return clamp((g - 0.5) * uContrast + 0.5, 0.0, 1.0); }
float H(vec2 p){ return cond(texture2D(uDepth, p).r); }
float G(vec2 p){ return cond(texture2D(uDepth, p).g); }
vec2 at(vec2 uv, float h){ return uv - uOff * (h - uFocus); }
// W6-U: PIXI's autoFit cuts the input to the screen; a shifted read that falls outside the input (token partly off
// screen) takes the fallback (the unshifted colour) instead of a clamped, stretched border pixel
vec4 inpOr(vec2 t, vec4 fb){
  vec2 q = (uTokToIn * vec3(t, 1.0)).xy, hp = inputPixel.zw * 0.5;
  if (q.x < inputClamp.x - hp.x || q.y < inputClamp.y - hp.y || q.x > inputClamp.z + hp.x || q.y > inputClamp.w + hp.y) return fb;
  return texture2D(uSampler, clamp(q, inputClamp.xy, inputClamp.zw));
}
${GLSL_FX}

void main(void){
  vec4 orig = texture2D(uSampler, vTextureCoord);
  vec2 uv = vTokUv;
  if (orig.a <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = orig; return; }

  float n = max(uSteps, 1.0), hPrev = 1.0, hit = -1.0;
  for (int i = 0; i <= 64; i++) {
    float fi = float(i);
    if (fi > n) break;
    float hh = 1.0 - fi / n;
    if (H(at(uv, hh)) >= hh) { hit = hh; break; }
    hPrev = hh;
  }
  float h = 0.0;
  if (hit >= 1.0) h = 1.0;
  else if (hit >= 0.0) {
    float lo = hit, hi = hPrev;
    for (int k = 0; k < 6; k++) { float m = 0.5 * (lo + hi); if (H(at(uv, m)) >= m) lo = m; else hi = m; }
    h = 0.5 * (lo + hi);
  }
  vec2 s = clamp(at(uv, h), 0.0, 1.0);
  vec4 c = inpOr(s, orig);

  if (uHoleFill > 0.0) {
    vec4 dep = texture2D(uDepth, s);
    float d = cond(dep.r);
    vec2 e = uDTexel * 1.5;
    vec2 grad = vec2(H(s + vec2(e.x, 0.0)) - H(s - vec2(e.x, 0.0)), H(s + vec2(0.0, e.y)) - H(s - vec2(0.0, e.y))) / (2.0 * e);
    float stretch = 1.0 + dot(uOff, grad);
    float hole = smoothstep(1.6, 3.5, stretch) * uHoleFill;
    if (hole > 0.002) {
      vec2 gt = grad * uDTexel;
      vec2 dir = -gt / max(length(gt), 1e-6) * uDTexel;
      float bgL = cond(dep.a);
      float travel = length(uOff / uDTexel) * max(d - bgL, 0.0) + 3.0;
      float stepL = max(1.0, travel / 10.0);
      vec2 p = s;
      float target = mix(bgL, d, 0.25);
      for (int k = 0; k < 12; k++) { p += dir * stepL; if (H(p) <= target) break; }
      p = clamp(p + dir * 2.0, 0.0, 1.0);
      vec2 side = vec2(-dir.y, dir.x) * 1.5;
      vec4 bgc = (inpOr(p, c) * 2.0 + inpOr(clamp(p + side, 0.0, 1.0), c) + inpOr(clamp(p - side, 0.0, 1.0), c)) * 0.25;
      c = mix(c, bgc, hole);
    }
  }

  float a = orig.a;
  vec3 rgb = c.a > 0.004 ? c.rgb / c.a : orig.rgb / a;
  // W6-P: light / rim / dust only recolour this pixel (straight colour, clamped, then times the INPUT alpha below)
  if (uLight > 0.001 || uRim > 0.001 || uDust > 0.001) {
    vec4 dep2 = texture2D(uDepth, s);
    float d2 = cond(dep2.r);
    if (uLight > 0.001 || uRim > 0.001) {
      float nk = fxNormalK(uDTexel);
      vec2 e2 = uDTexel * nk;
      float dx = G(s + vec2(e2.x, 0.0)) - G(s - vec2(e2.x, 0.0));
      float dy = G(s + vec2(0.0, e2.y)) - G(s - vec2(0.0, e2.y));
      rgb = fxLightRim(rgb, dx, dy, dep2.b * smoothstep(0.1, 0.3, d2) * fxOnSurface(d2, cond(dep2.g)), uLook, uLight, uRim, uRelief / (2.0 * nk * max(uDTexel.x, uDTexel.y)));
    }
    if (uDust > 0.001) rgb += fxDustColor() * fxDust(uv, uOff, uFocus, d2, uTime, uDustScale) * uDust;
    rgb = clamp(rgb, 0.0, 1.0);
  }
  gl_FragColor = vec4(rgb * a, a);
}`;
