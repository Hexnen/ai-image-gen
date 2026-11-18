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
  // W6-Q (owner: "uruchom efekty"): breathing, light and dust ON by default for portraits and tokens; strengths unchanged
  portrait: Object.freeze({ breath: true, breathStrength: 0.5, light: true, lightStrength: 1, dust: true, dustStrength: 0.4 }),
  token: Object.freeze({ breath: true, breathStrength: 0.5, light: true, lightStrength: 0.6, dust: true, dustStrength: 0.4 })
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
 * - fxLightRim(c, dx, dy, fig, look, light, rim, relief): diffuse light from the normal of the blurred-depth gradient
 *   (dx, dy) towards the look, plus a warm rim on edges facing the look; `fig` = figure weight.
 */
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
vec3 fxLightRim(vec3 c, float dx, float dy, float fig, vec2 look, float light, float rim, float relief){
  vec3 N = normalize(vec3(-dx * relief, -dy * relief, 1.0));
  vec3 L = normalize(vec3(look.x, look.y, 0.8));
  float nl = dot(N, L);
  c *= mix(1.0, 0.8 + 0.36 * max(nl, 0.0), fig * light);
  float facing = length(N.xy) > 1e-4 ? smoothstep(0.0, 0.7, dot(normalize(N.xy), normalize(look + vec2(1e-4)))) : 0.0;
  float rr = (pow(1.0 - N.z, 1.4) * facing * 1.4 + pow(clamp(nl, 0.0, 1.0), 6.0) * 0.35) * fig * rim;
  return c + vec3(1.0, 0.58, 0.44) * rr * 0.6;
}
`;
