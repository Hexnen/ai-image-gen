// W6-O: pure parts of the depth parallax on canvas TOKENS (parallax/token-parallax.mjs): who gets the effect (world /
// scene / token switches, unsupported tokens), the look vector (pointer near the token, or the token's place on the
// screen), the uv offset in the token texture for any token transform (scale, mirror, rotation), half-float packing of
// the conditioned depth map, the depth texture size, and the PIXI filter's GLSL (a port of the parallax window's ray
// search, parallax-gl.mjs FS, to GLSL ES 1.0 for Foundry's PIXI 7 context). No PIXI, no Foundry: tested in Node
// (dev/test-token-parallax.mjs).
import { clampLook, MAX_SHIFT } from "./parallax-core.mjs";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => clamp(v, 0, 1);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export const TOKEN_MODES = Object.freeze(["", "on", "off"]);
export const DRIVES = Object.freeze(["pointer", "camera"]);
export const STRENGTH_RANGE = Object.freeze([0.1, 1, 0.05]);
export const STRENGTH_DEFAULT = 0.5;

/**
 * Does this token want the effect? World switch first (off = nothing anywhere), then the token's own override
 * ("on" / "off"), then the scene switch (default off).
 */
export function tokenWanted({ world = true, scene = false, token = "" } = {}) {
  if (!world) return false;
  if (token === "on") return true;
  if (token === "off") return false;
  return !!scene;
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

/** IEEE 754 binary16 bits of a float (round to nearest even, clamped to ±65504, NaN kept). */
export function floatToHalf(v) {
  if (Number.isNaN(v)) return 0x7e00;
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  f32[0] = v;
  const x = u32[0];
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
  for (let i = 0; i < src.length; i++) out[i] = floatToHalf(src[i]);
  return out;
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
uniform mat3 uTokToIn;        // token uv -> input uv (inverse of otherMatrix)
uniform vec2 uOff;            // uv shift between depth 1 and depth 0
uniform vec2 uDTexel;
uniform float uFocus;
uniform float uGamma;
uniform float uContrast;
uniform float uHoleFill;
uniform float uSteps;

float cond(float d){ float g = pow(clamp(d, 0.0, 1.0), uGamma); return clamp((g - 0.5) * uContrast + 0.5, 0.0, 1.0); }
float H(vec2 p){ return cond(texture2D(uDepth, p).r); }
vec2 at(vec2 uv, float h){ return uv - uOff * (h - uFocus); }
vec4 inp(vec2 t){ vec2 q = (uTokToIn * vec3(t, 1.0)).xy; return texture2D(uSampler, clamp(q, inputClamp.xy, inputClamp.zw)); }

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
  vec4 c = inp(s);

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
      vec4 bgc = (inp(p) * 2.0 + inp(clamp(p + side, 0.0, 1.0)) + inp(clamp(p - side, 0.0, 1.0))) * 0.25;
      c = mix(c, bgc, hole);
    }
  }

  float a = orig.a;
  vec3 rgb = c.a > 0.004 ? c.rgb / c.a : orig.rgb / a;
  gl_FragColor = vec4(rgb * a, a);
}`;
