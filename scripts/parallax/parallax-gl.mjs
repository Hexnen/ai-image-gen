// W6-L: WebGL2 renderer of the parallax portrait window. One canvas, one context, one image texture and one texture per
// depth map; every compare panel is a viewport of the same canvas, so 1-3 panels share the frame, the clock and the
// pointer. The window (parallax-app.mjs) owns layout, input and the settings; this file only draws.
//
// Shader, compared with the owner's prototype (10 fixed-point iterations p = uv − off·(d(p) − 0.45)):
// - ray search instead of a fixed point: the view ray is walked from the near plane down in clamped steps (one per
//   ~1.5 depth texels of travel, 8..64, parallax-core.mjs stepsFor) and refined by 6 bisections. The first surface met
//   wins, so a near edge occludes the far side without the tearing / doubled contours of the fixed point at big offsets.
// - stretched pixels: the stretch factor 1 + off·∇H (core.stretchFactor) says how many screen pixels one source pixel
//   covers. Where a hole opens behind an edge (stretch > 1.6) the colour is taken from the far side of the edge (a short
//   walk down the depth gradient to the background level, uDep.a = local minimum) and blended in: no rubber smear.
// - overscan instead of a frame: the image is zoomed by the largest possible shift, so samples never leave it.
// - depth conditioning: gamma + contrast as uniforms (instant sliders); de-quantise, dilate and normal blur at load.
// - light, rim, dust, vignette each with its own amount (0 = off); normals from a smoothed copy (uDep.g; W6-V: guided
//   filter at display scale for portraits / tokens), uRelief = height of depth 1 as a fraction of the short side.
// - texture LOD from the undisplaced uv (textureGrad): no mip seams along depth edges.
// `cond`, the stretch factor and the ray search mirror parallax-core.mjs (condition, stretchFactor, marchRay), which the
// Node tests cover. W6-P: the dust and light/rim code lives in parallax-fx.mjs (GLSL_FX), shared with the token filter.
import { GLSL_FX } from "./parallax-fx.mjs";

const VS = `#version 300 es
out vec2 vP;
void main(){
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vP = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);   // panel coords, y down
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vP;
out vec4 outColor;
uniform sampler2D uImg;     // portrait, sRGB bytes
uniform sampler2D uDep;     // r depth, g blurred depth, b mask, a background depth (local min); y down
uniform vec4 uRect;         // drawn image rect in panel coords (contain fit)
uniform vec2 uCrop;         // overscan margin in image uv
uniform vec2 uOff;          // uv shift between depth 1 and depth 0
uniform vec2 uDTexel;       // 1 / depth size
uniform vec2 uLook;         // pointer / sway, unit disc, y down (light direction)
uniform vec3 uBg;
uniform float uFocus, uGamma, uContrast, uLight, uRim, uDust, uVignette, uHoleFill, uTime, uRelief, uAlphaOut;
uniform int uSteps, uView;

float cond(float d){ float g = pow(clamp(d, 0.0, 1.0), uGamma); return clamp((g - 0.5) * uContrast + 0.5, 0.0, 1.0); }
float H(vec2 p){ return cond(textureLod(uDep, p, 0.0).r); }
float G(vec2 p){ return cond(textureLod(uDep, p, 0.0).g); }
vec2 at(vec2 uv, float h){ return uv - uOff * (h - uFocus); }
${GLSL_FX}
void main(){
  vec2 q = (vP - uRect.xy) / uRect.zw;
  vec2 uv = mix(uCrop, 1.0 - uCrop, q);
  vec2 gx = dFdx(uv), gy = dFdy(uv);               // LOD from the undisplaced uv (uniform control flow)
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) { outColor = vec4(uBg, 1.0); return; }

  // --- ray search: first surface from the near plane down ---
  float n = float(uSteps), hPrev = 1.0, hit = -1.0;
  for (int i = 0; i <= 64; i++) {
    if (i > uSteps) break;
    float hh = 1.0 - float(i) / n;
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
  vec4 dep = textureLod(uDep, s, 0.0);
  float d = cond(dep.r);

  // --- stretch (holes revealed behind edges) and the fill from the far side ---
  vec2 e = uDTexel;
  // 1.5-texel stencil: catches a 1-3 texel wall without flipping pixel to pixel along an edge (jagged fill borders)
  vec2 e15 = e * 1.5;
  vec2 grad = vec2(H(s + vec2(e15.x, 0.0)) - H(s - vec2(e15.x, 0.0)), H(s + vec2(0.0, e15.y)) - H(s - vec2(0.0, e15.y))) / (2.0 * e15);
  float stretch = 1.0 + dot(uOff, grad);
  float hole = smoothstep(1.6, 3.5, stretch) * uHoleFill;
  vec4 src = textureGrad(uImg, s, gx, gy);
  vec3 c = src.rgb;
  if (hole > 0.002) {
    vec2 gt = grad * e;                             // per-texel change
    vec2 dir = -gt / max(length(gt), 1e-6) * e;     // one texel towards the far side
    float bgL = cond(dep.a);
    float travel = length(uOff / e) * max(d - bgL, 0.0) + 3.0;
    float stepL = max(1.0, travel / 10.0);
    vec2 p = s;
    float target = mix(bgL, d, 0.25);
    for (int k = 0; k < 12; k++) { p += dir * stepL; if (H(p) <= target) break; }
    p = clamp(p + dir * 2.0, 0.0, 1.0);             // past the antialiased outline
    vec2 side = vec2(-dir.y, dir.x) * 1.5;
    vec3 bgc = (textureLod(uImg, p, 0.0).rgb * 2.0 + textureLod(uImg, clamp(p + side, 0.0, 1.0), 0.0).rgb + textureLod(uImg, clamp(p - side, 0.0, 1.0), 0.0).rgb) * 0.25;
    c = mix(c, bgc, hole);
  }

  // --- light + rim from normals of the smoothed depth (W6-V: stencil ±0.5% of the short side, relief per short side) ---
  float fig = dep.b * smoothstep(0.1, 0.3, d);
  if (uLight > 0.001 || uRim > 0.001) {
    float nk = fxNormalK(e);
    vec2 e2 = e * nk;
    float dx = G(s + vec2(e2.x, 0.0)) - G(s - vec2(e2.x, 0.0));
    float dy = G(s + vec2(0.0, e2.y)) - G(s - vec2(0.0, e2.y));
    c = fxLightRim(c, dx, dy, fig * fxOnSurface(d, cond(dep.g)), uLook, uLight, uRim, uRelief / (2.0 * nk * max(e.x, e.y)));   // W6-P: shared with the token filter
  }

  // --- dust in three depth planes, hidden behind nearer surfaces (W6-P: shared code, scale 1 = as before) ---
  if (uDust > 0.001) c += fxDustColor() * fxDust(q, uOff, uFocus, d, uTime, 1.0) * uDust;

  vec2 vv = q - 0.5;
  c *= 1.0 - dot(vv, vv) * 0.7 * uVignette;
  if (uView == 1) c = vec3(d);
  else if (uView == 2) {
    float st = smoothstep(1.2, 3.5, stretch);
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114)) * 0.45), vec3(1.0, 0.25, 0.1), st);
    c = mix(c, vec3(0.2, 0.8, 1.0), hole * 0.5);
  }
  outColor = vec4(c, mix(1.0, src.a, uAlphaOut));   // W6-N: sheet portraits keep the image's own transparency
}`;

const UNIFORMS = ["uImg", "uDep", "uRect", "uCrop", "uOff", "uDTexel", "uLook", "uBg", "uFocus", "uGamma", "uContrast", "uLight", "uRim", "uDust", "uVignette", "uHoleFill", "uTime", "uRelief", "uSteps", "uView", "uAlphaOut"];

export class ParallaxRenderer {
  /** @param {HTMLCanvasElement} canvas  @returns {ParallaxRenderer|null} null when WebGL2 is missing (caller shows a message) */
  static create(canvas, attrs = {}) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance", ...attrs });
    if (!gl) return null;
    return new ParallaxRenderer(canvas, gl);
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.depths = new Map();
    /** W6-N: image textures by key; the window uses one ("main"), the sheet portraits share the context (one per view) */
    this.images = new Map();
    this.lost = false;
    this.#build();
  }

  /** W6-Q: the GPU's largest texture side (portraits upload at natural size up to this). */
  get maxTextureSize() { try { return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 0; } catch { return 0; } }

  /** The window's portrait texture (key "main"). */
  get image() { return this.images.get("main") ?? null; }

  #build() {
    const gl = this.gl;
    const sh = (type, src) => {
      const o = gl.createShader(type);
      gl.shaderSource(o, src);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(`Parallax shader: ${gl.getShaderInfoLog(o)}`);
      return o;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Parallax program: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    this.vao = gl.createVertexArray();
    this.u = Object.fromEntries(UNIFORMS.map((k) => [k, gl.getUniformLocation(p, k)]));
  }

  /** Portrait (ImageBitmap / image element) under a key (default "main"). Mipmapped. */
  setImage(img, key = "main") {
    const gl = this.gl;
    const old = this.images.get(key);
    if (old) gl.deleteTexture(old.tex);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.#params(gl.LINEAR_MIPMAP_LINEAR);
    // W6-Q: anisotropic filtering where available (sharper when the picture is minified unevenly)
    const an = gl.getExtension("EXT_texture_filter_anisotropic");
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));
    this.images.set(key, { tex, w: img.width, h: img.height });
  }

  dropImage(key = "main") {
    const t = this.images.get(key);
    if (t) this.gl.deleteTexture(t.tex);
    this.images.delete(key);
  }

  /** Conditioned depth (parallax-core conditionDepth: 4 floats per pixel) under a key. Half-float, linear filtering. */
  setDepth(key, { rgba, half, w, h }) {
    const gl = this.gl;
    const old = this.depths.get(key);
    if (old) gl.deleteTexture(old.tex);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // W6-T: `half` = Uint16 half floats from the depth worker (half the upload size); `rgba` = Float32 as before
    if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, half);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, rgba);
    this.#params(gl.LINEAR);
    this.depths.set(key, { tex, w, h });
  }

  /**
   * W6-T: GPU time of draws (EXT_disjoint_timer_query_webgl2, when the browser exposes it). `timerBegin()` before a
   * draw, `timerEnd()` after; `timerPoll()` returns the finished results in ms (a few frames later; disjoint = dropped).
   * `timerSupported` false = no GPU times on this browser (the frame guard then uses its on/off comparison).
   */
  get timerSupported() {
    if (this.tq === undefined) {
      let ext = null;
      try { ext = this.gl.getExtension("EXT_disjoint_timer_query_webgl2"); } catch { ext = null; }
      this.tq = ext ? { ext, active: null, pending: [] } : null;
    }
    return !!this.tq;
  }

  timerBegin() {
    if (!this.timerSupported || this.tq.active || this.lost) return;
    if (this.tq.pending.length >= 6) return;               // results lag: do not pile up queries
    const gl = this.gl, q = gl.createQuery();
    gl.beginQuery(this.tq.ext.TIME_ELAPSED_EXT, q);
    this.tq.active = q;
  }

  timerEnd() {
    if (!this.tq?.active) return;
    this.gl.endQuery(this.tq.ext.TIME_ELAPSED_EXT);
    this.tq.pending.push(this.tq.active);
    this.tq.active = null;
  }

  timerPoll() {
    const out = [];
    if (!this.tq || this.lost) return out;
    const gl = this.gl;
    while (this.tq.pending.length) {
      const q = this.tq.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.tq.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      this.tq.pending.shift();
      if (!disjoint) out.push(ns / 1e6);
    }
    return out;
  }

  dropDepth(key) {
    const d = this.depths.get(key);
    if (d) this.gl.deleteTexture(d.tex);
    this.depths.delete(key);
  }

  #params(min) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Draw a frame. `panels` = [{key, x, y, w, h}] in canvas pixels (y down); `u` = per-frame uniforms shared by every
   * panel: {rect(panel w,h → contain rect), crop, off, look, bg, focus, gamma, contrast, light, rim, dust, vignette,
   * holeFill, time, relief, steps, view}. `u.rectFor(panel)` gives the contain rect of a panel. W6-N: a panel may name
   * its image texture (`panel.image`, default "main"); `u.alphaOut` 1 = write the image's alpha (default 0 = opaque).
   */
  draw(panels, u) {
    const gl = this.gl;
    if (this.lost || !this.images.size) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    const H = this.canvas.height;
    gl.viewport(0, 0, this.canvas.width, H);
    gl.scissor(0, 0, this.canvas.width, H);
    gl.clearColor(u.bg[0], u.bg[1], u.bg[2], u.alphaOut ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const U = this.u;
    gl.uniform1f(U.uAlphaOut, u.alphaOut ? 1 : 0);
    gl.uniform1i(U.uImg, 0);
    gl.uniform1i(U.uDep, 1);
    gl.uniform2f(U.uCrop, u.crop.x, u.crop.y);
    gl.uniform2f(U.uOff, u.off.x, u.off.y);
    gl.uniform2f(U.uLook, u.look.x, u.look.y);
    gl.uniform3f(U.uBg, u.bg[0], u.bg[1], u.bg[2]);
    gl.uniform1f(U.uFocus, u.focus);
    gl.uniform1f(U.uGamma, u.gamma);
    gl.uniform1f(U.uContrast, u.contrast);
    gl.uniform1f(U.uLight, u.light);
    gl.uniform1f(U.uRim, u.rim);
    gl.uniform1f(U.uDust, u.dust);
    gl.uniform1f(U.uVignette, u.vignette);
    gl.uniform1f(U.uHoleFill, u.holeFill);
    gl.uniform1f(U.uTime, u.time);
    gl.uniform1f(U.uRelief, u.relief);
    gl.uniform1i(U.uView, u.view);
    for (const p of panels) {
      const d = this.depths.get(p.key);
      const im = this.images.get(p.image ?? "main");
      if (!d || !im || p.w < 2 || p.h < 2) continue;
      const vx = Math.round(p.x), vy = Math.round(H - p.y - p.h), vw = Math.round(p.w), vh = Math.round(p.h);
      gl.viewport(vx, vy, vw, vh);
      gl.scissor(vx, vy, vw, vh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, im.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, d.tex);
      const r = u.rectFor(p);
      gl.uniform4f(U.uRect, r.x, r.y, r.w, r.h);
      gl.uniform2f(U.uDTexel, 1 / d.w, 1 / d.h);
      gl.uniform1i(U.uSteps, u.stepsFor(d));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Wait for the GPU (frame-time measurement only). */
  finish() {
    const px = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
  }

  destroy() {
    const gl = this.gl;
    try { if (this.tq) { if (this.tq.active) gl.endQuery(this.tq.ext.TIME_ELAPSED_EXT); for (const q of [this.tq.active, ...this.tq.pending]) if (q) gl.deleteQuery(q); } } catch { /* lost */ }
    this.tq = null;
    for (const k of [...this.depths.keys()]) this.dropDepth(k);
    for (const k of [...this.images.keys()]) this.dropImage(k);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
