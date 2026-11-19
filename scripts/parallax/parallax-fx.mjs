// W6-P: the three optional extras of the depth parallax on actor PORTRAITS and canvas TOKENS: breathing ("oddech": a
// slow, tiny idle tilt while the pointer is away), light ("światło": shading from the depth normals + a rim that follows
// the tilt) and dust ("pył": drifting particles in three depth planes). Pure parts only (no DOM, no PIXI, no Foundry):
// the per-viewer settings schema and its normalisation, the reduced-motion rule, the breathing look, the cap on how
// many tokens animate at once, and the GLSL shared by the parallax window (parallax-gl.mjs, GLSL ES 3.0) and the token
// filter (token-core.mjs, GLSL ES 1.0): one copy of the dust and light/rim code, written in the common subset of both.
// Tested in Node by dev/test-parallax-fx.mjs.
import { clampLook } from "./parallax-core.mjs";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Ranges [min, max, step] of the strengths. Light = multiplier of the base light / rim; breath / dust = amount 0..1. */
export const FX_RANGES = Object.freeze({
  breathStrength: Object.freeze([0.1, 1, 0.05]),
  lightStrength: Object.freeze([0.25, 1.5, 0.05]),
  dustStrength: Object.freeze([0.1, 1, 0.05])
});

/**
 * Defaults per target. Portraits: light on (as before W6-P, multiplier 1 = the type's own light / rim), breathing and
 * dust off. Tokens: everything off (a token with breathing / dust keeps its filter running at rest).
 */
export const FX_DEFAULTS = Object.freeze({
  // W6-Q (owner: "uruchom efekty"): breathing, light and dust ON by default for portraits and tokens
  // W6-V: light strength = the light's own amount now (no hidden 0.6 / 0.5 base): portraits 1, tokens 0.8
  portrait: Object.freeze({ breath: true, breathStrength: 0.5, light: true, lightStrength: 1, dust: true, dustStrength: 0.4 }),
  token: Object.freeze({ breath: true, breathStrength: 0.5, light: true, lightStrength: 0.8, dust: true, dustStrength: 0.4 })
});

/**
 * W6-Q: the 12 extras are WORLD settings (the GM sets them for everyone). The one per-device escape hatch (client
 * setting, default off): on = breathing, light and dust off on this device (the tilt itself stays).
 */
export const FX_DEVICE_OFF_KEY = "parallaxFxDeviceOff";

export const FX_TARGETS = Object.freeze(["portrait", "token"]);
export const FX_KEYS = Object.freeze(["breath", "breathStrength", "light", "lightStrength", "dust", "dustStrength"]);

/** Foundry setting key of one option ("portraitFxBreath", "tokenFxDustStrength", ...). No dots: no clash with the
 *  existing `portraitParallax` / `tokenParallax` keys when a form expands dotted names. */
export const fxSettingKey = (target, key) => `${target}Fx${key[0].toUpperCase()}${key.slice(1)}`;

/** Clamp one strength into its range, snapped to the step; junk = the default. */
export function cleanFxStrength(key, v, fallback) {
  const r = FX_RANGES[key];
  const n = Number(v);
  if (!r || v === null || v === "" || typeof v === "boolean" || !Number.isFinite(n)) return fallback;
  const [min, max, step] = r;
  return Math.round(Math.min(max, Math.round((clamp(n, min, max) - min) / step) * step + min) * 1000) / 1000;
}

/** Any partial / junk input -> a full options object for `target` ("portrait" | "token"). Idempotent. */
export function normalizeFx(raw, target = "portrait") {
  const base = FX_DEFAULTS[target] ?? FX_DEFAULTS.portrait;
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...base };
  for (const k of ["breath", "light", "dust"]) if (typeof r[k] === "boolean") out[k] = r[k];
  for (const k of ["breathStrength", "lightStrength", "dustStrength"]) out[k] = cleanFxStrength(k, r[k], base[k]);
  return out;
}

/**
 * What actually runs: `prefers-reduced-motion: reduce` forces breathing and dust OFF (light stays, it only follows a
 * tilt the viewer made). `animates` = needs a frame loop at rest.
 */
export function effectiveFx(fx, { reducedMotion = false, deviceOff = false } = {}) {
  const f = { ...fx };
  if (reducedMotion) { f.breath = false; f.dust = false; }
  if (deviceOff) { f.breath = false; f.dust = false; f.light = false; }   // W6-Q: this device opted out of the extras
  f.animates = !!(f.breath || f.dust);
  return f;
}

/** Largest breathing tilt (look units, unit disc) at strength 1: well under the cursor's full tilt of 1. */
export const BREATH_MAX = 0.2;
/** The idle loop draws at most this often (ms): ~30 fps. */
export const IDLE_FRAME_MS = 33;
/** Tokens that may animate at rest (breathing / dust) at once: in view, nearest the pointer, else nearest the centre. */
export const MAX_ANIMATED_TOKENS = 12;

/**
 * Breathing look at time `tMs`: a slow closed figure (periods ~7.5 s and ~11 s, mostly vertical like a breath), smooth
 * (no jitter: sums of sines), amplitude `strength` × BREATH_MAX. `phase` (ms) desynchronises several tokens.
 */
export function breathLook(tMs, strength, phase = 0) {
  const a = clamp(Number(strength) || 0, 0, 1) * BREATH_MAX;
  if (!(a > 0) || !Number.isFinite(tMs)) return { x: 0, y: 0 };
  const t = (tMs + (Number(phase) || 0)) / 1000;
  // |(0.5, 0.75 + 0.1)| < 1 by construction: no clamp (a clamp would put kinks into the motion)
  return { x: Math.sin(t * 0.57 + 0.4) * 0.5 * a, y: (Math.sin(t * 0.84) * 0.75 + Math.sin(t * 0.31 + 1.1) * 0.1) * a };
}

/**
 * Combine the pointer's look with the breathing: the pointer wins as it comes near (|pointer| → 1), breathing fills
 * in where the pointer is away. Continuous in both inputs.
 */
export function withBreath(pointerLook, breath) {
  const p = pointerLook ?? { x: 0, y: 0 }, b = breath ?? { x: 0, y: 0 };
  const k = 1 - clamp(Math.hypot(p.x, p.y), 0, 1);
  return clampLook(p.x + b.x * k, p.y + b.y * k);
}

/** Stable per-id phase in ms (0..60 s), so tokens do not breathe in lockstep. */
export function phaseOf(id) {
  let h = 2166136261;
  for (const ch of String(id ?? "")) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 60000);
}

/**
 * Which tokens may animate at rest. `items` = [{key, x, y, r, inView}] in screen pixels (r = half the token's size);
 * only tokens in view qualify; with the pointer on the board the nearest to it win, else the nearest to the screen
 * centre `center`. Ties keep the input order. @returns {Set} of keys, at most `cap`.
 */
export function pickAnimated(items, { pointer = null, center = { x: 0, y: 0 }, cap = MAX_ANIMATED_TOKENS } = {}) {
  const n = Math.max(0, Math.floor(Number(cap) || 0));
  if (!n || !Array.isArray(items)) return new Set();
  const ref = pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y) ? pointer : center;
  const list = items
    .map((it, i) => ({ it, i, d: Math.hypot((it.x ?? 0) - ref.x, (it.y ?? 0) - ref.y) }))
    .filter((e) => e.it && e.it.inView);
  list.sort((a, b) => a.d - b.d || a.i - b.i);
  return new Set(list.slice(0, n).map((e) => e.it.key));
}

/** Is a screen rect (centre x, y, half size r) on a w × h screen? */
export const inView = (x, y, r, w, h) => x + r > 0 && y + r > 0 && x - r < w && y - r < h;

/** Dust cell scale for a picture `sidePx` screen pixels across: the window's density at ~450 px, sparser and bigger
 *  particles on small tokens (never sub-pixel). */
export const dustScale = (sidePx) => clamp((Number(sidePx) || 0) / 450, 0.3, 1.5);

/**
 * GLSL shared by the parallax window (GLSL ES 3.0) and the token filter (GLSL ES 1.0): no texture reads, no version-
 * specific syntax, only plain functions. The window's math before W6-P, moved here unchanged (the window passes scale 1).
 * - fxDust(du, off, focus, d, t, sc): brightness of the dust in three depth planes at panel uv `du` (the planes shift
 *   with the parallax offset `off`; the two far planes are hidden behind nearer surfaces, `d` = conditioned depth at
 *   the sample); `sc` = cell scale (1 = the window).
 * - fxLightRim(c, dx, dy, fig, look, light, rim, relief) (W6-V): shading RELATIVE TO A FLAT SURFACE, so the picture
 *   never gets an overall tint or haze: c × (1 + fig·light·1.5·clamp(N·L − L.z, −0.35, 0.6)); N from the slope of the
 *   smoothed depth (dx, dy = differences across ±fxNormalK texels, `relief` = height of depth 1 per unit of stencil
 *   distance), slope limited to 0.8; L = a light 41° above the picture on the pointer's side (fixed elevation, only the
 *   side follows the look). Darkening fades out on steep slopes (0.7..1.6: outlines, thin strands, no dark lines);
 *   callers weight `fig` with fxOnSurface (no light on the far side of an outline: no dark halo). Plus a neutral rim
 *   (gain 1) on slopes facing the pointer. `fig` = figure weight.
 */

/**
 * W6-V: the light's constants (the GLSL above hardcodes the same numbers; dev/test-parallax-fx.mjs checks them).
 * relief = height of depth 0..1 as a fraction of the map's SHORT side (the shader turns it into a slope with the stencil
 * size: reliefFor), normalStep = half-stencil as a fraction of the short side.
 */
export const LIGHT = Object.freeze({ relief: 0.13, normalStep: 0.005, slopeMax: 0.8, gain: 1.5, elevationDeg: 41, shadeMin: -0.35, shadeMax: 0.6, rimGain: 1 });

/** Stencil in texels for a depth map w × h (mirror of the GLSL fxNormalK). */
export const normalK = (w, h) => Math.max(1, LIGHT.normalStep * Math.min(w, h));

/** The `relief` argument of fxLightRim for a map w × h: slope = (G(+k) − G(−k)) × reliefFor. */
export const reliefFor = (w, h, relief = LIGHT.relief) => (relief * Math.min(w, h)) / (2 * normalK(w, h));

/** JS mirror of fxLightRim (tests and tools): shade factor and the rim added, for slope differences dx, dy. */
export function lightShade(dx, dy, { fig = 1, look = { x: 1, y: 0 }, light = 1, rim = 1, relief = LIGHT.relief / (2 * LIGHT.normalStep) } = {}) {
  let sx = -dx * relief, sy = -dy * relief;
  const sm = Math.hypot(sx, sy);
  const k = sm > LIGHT.slopeMax ? LIGHT.slopeMax / sm : 1;
  const nx = sx * k, ny = sy * k, nl = Math.hypot(nx, ny, 1);
  const N = [nx / nl, ny / nl, 1 / nl];
  const ll = Math.hypot(look.x, look.y), ld = ll > 1e-5 ? [look.x / ll, look.y / ll] : [0, 0];
  const e = (LIGHT.elevationDeg * Math.PI) / 180, L = [ld[0] * Math.cos(e), ld[1] * Math.cos(e), Math.sin(e)];
  const sst = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  let sh = clamp(N[0] * L[0] + N[1] * L[1] + N[2] * L[2] - L[2], LIGHT.shadeMin, LIGHT.shadeMax);
  if (sh < 0) sh *= 1 - sst(0.7, 1.6, sm);
  const facing = sm > 1e-4 ? sst(0, 0.7, (sx / sm) * ld[0] + (sy / sm) * ld[1]) : 0;
  return { shade: 1 + fig * light * LIGHT.gain * sh, rim: Math.pow(1 - N[2], 1.4) * facing * fig * rim * LIGHT.rimGain, sh };
}
export const GLSL_FX = `
float fxHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fxDustPlane(vec2 uv, float sc, float sp, float seed, float t){
  vec2 q = uv * sc + vec2(t * 0.02 * sp, -t * 0.035 * sp) + seed;
  vec2 i = floor(q), f = fract(q);
  float r = fxHash(i + seed);
  vec2 c = vec2(fxHash(i + 1.3), fxHash(i + 7.7)) * 0.8 + 0.1 + vec2(sin(t * 0.5 + r * 6.0), cos(t * 0.4 + r * 6.0)) * 0.08;
  float tw = 0.5 + 0.5 * sin(t * (1.0 + r * 2.0) + r * 20.0);
  return step(0.82, r) * smoothstep(0.06, 0.0, length(f - c)) * tw;
}
float fxDust(vec2 du, vec2 off, float focus, float d, float t, float sc){
  return fxDustPlane(du + off * (0.25 - focus) * 0.9, 26.0 * sc, 1.0, 0.0, t) * smoothstep(0.3, 0.2, d) * 0.35
       + fxDustPlane(du + off * (0.6 - focus) * 0.9, 18.0 * sc, 1.4, 3.0, t) * smoothstep(0.65, 0.55, d) * 0.5
       + fxDustPlane(du + off * (1.25 - focus) * 0.9, 11.0 * sc, 1.9, 9.0, t) * 0.7;
}
vec3 fxDustColor(){ return vec3(1.0, 0.72, 0.6); }
// W6-V: stencil of the light's normals in depth texels: ±0.5% of the map's short side (at least one texel)
float fxNormalK(vec2 texel){ return max(1.0, 0.005 / max(texel.x, texel.y)); }
// W6-V: a pixel BELOW the smoothed surface (d < g) is the far side of an outline (background or far hair behind a near
// edge): the smoothed slope there belongs to the edge, not to this pixel, so the light leaves it alone (no dark halo)
float fxOnSurface(float d, float g){ return 1.0 - smoothstep(0.02, 0.08, g - d); }
vec3 fxLightRim(vec3 c, float dx, float dy, float fig, vec2 look, float light, float rim, float relief){
  vec2 sl = vec2(-dx, -dy) * relief;
  float sm = length(sl);
  vec3 N = normalize(vec3(sm > 0.8 ? sl * (0.8 / sm) : sl, 1.0));
  float ll = length(look);
  vec2 ld = ll > 1e-5 ? look / ll : vec2(0.0);
  vec3 L = vec3(ld * 0.7547, 0.6561);
  float sh = clamp(dot(N, L) - L.z, -0.35, 0.6);
  if (sh < 0.0) sh *= 1.0 - smoothstep(0.7, 1.6, sm);
  c *= 1.0 + fig * light * 1.5 * sh;
  float facing = sm > 1e-4 ? smoothstep(0.0, 0.7, dot(sl / sm, ld)) : 0.0;
  return c + vec3(pow(1.0 - N.z, 1.4) * facing * fig * rim);
}
`;
