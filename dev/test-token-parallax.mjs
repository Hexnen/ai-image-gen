// W6-O: depth parallax on canvas tokens, the pure parts (scripts/parallax/token-core.mjs): switches, unsupported
// tokens, look vectors (pointer / camera), the uv offset for any token transform, strength, depth texture size,
// half-float packing, the PIXI filter GLSL (mirrors the parallax window's ray search; alpha untouched), plus static
// checks of the wiring (settings, hooks, HUD -> depth window, lang en/pl, no own network / paid calls). Pure Node.
// Run from the module folder: node dev/test-token-parallax.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  tokenWanted, unsupportedReason, pointerLook, cameraLook, uvOffset, cleanStrength, depthFactor, floatToHalf, halfToFloat,
  toHalfArray, lookIsRest, TOKEN_VS, TOKEN_FS, STRENGTH_DEFAULT
} from "../scripts/parallax/token-core.mjs";
import { offsetFor, MAX_SHIFT, marchRay } from "../scripts/parallax/parallax-core.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** PIXI-style matrix {a, b, c, d}: x' = a·x + c·y, y' = b·x + d·y */
const mat = (sx, sy, rot = 0) => ({ a: sx * Math.cos(rot), b: sx * Math.sin(rot), c: -sy * Math.sin(rot), d: sy * Math.cos(rot) });
const apply = (m, v) => ({ x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y });

await test("switches: world off wins, token override, scene default off", () => {
  assert.equal(tokenWanted({}), false, "scene off by default");
  assert.equal(tokenWanted({ scene: true }), true);
  assert.equal(tokenWanted({ scene: true, token: "off" }), false);
  assert.equal(tokenWanted({ scene: false, token: "on" }), true);
  assert.equal(tokenWanted({ world: false, scene: true, token: "on" }), false);
  assert.equal(tokenWanted({ scene: true, token: "junk" }), true, "unknown = inherit");
});

await test("unsupported tokens are skipped with a reason", () => {
  assert.equal(unsupportedReason({ src: "tokens/hero.webp" }), "");
  assert.equal(unsupportedReason({ src: "tokens/hero.webp", preview: true }), "preview");
  assert.equal(unsupportedReason({ src: "tokens/hero.webp", meshOk: false }), "mesh");
  assert.equal(unsupportedReason({ src: "tokens/hero.webm" }), "video");
  assert.equal(unsupportedReason({ src: "tokens/hero.MP4?x=1" }), "video");
  assert.equal(unsupportedReason({ src: "tokens/hero.webp", video: true }), "video");
  assert.equal(unsupportedReason({ src: "tokens/hero.webp", ring: true }), "ring");
  assert.equal(unsupportedReason({ src: "icons/svg/mystery-man.svg" }), "image");
  assert.equal(unsupportedReason({ src: "data:image/png;base64,AAA" }), "image");
  assert.equal(unsupportedReason({ src: "" }), "image");
});

await test("pointer look: towards the pointer, full at reach, fades to 0 far away", () => {
  const c = { x: 1000, y: 1000 }, size = 100;
  assert.deepEqual(pointerLook(c, c, size), { x: 0, y: 0 });
  const r = pointerLook({ x: 1000 + 62.5, y: 1000 }, c, size); // reach 1.25 × half size
  near(r.x, 1, 1e-9); near(r.y, 0);
  const up = pointerLook({ x: 1000, y: 1000 - 40 }, c, size);
  assert.ok(up.y < 0 && up.x === 0, "up = negative y (screen y down)");
  const diag = pointerLook({ x: 1100, y: 1100 }, c, size);
  assert.ok(Math.hypot(diag.x, diag.y) <= 1 + 1e-9, "unit disc");
  assert.deepEqual(pointerLook({ x: 1000 + 250, y: 1000 }, c, size), { x: 0, y: 0 }, "2.5 token sizes away: flat");
  near(Math.hypot(...Object.values(pointerLook({ x: 1000 + 100, y: 1000 }, c, size))), 1, 1e-9, "1 token size: still full");
  let prev = Infinity;
  for (let d = 70; d <= 300; d += 10) { // beyond the reach (62.5): only the fade acts
    const m = Math.hypot(...Object.values(pointerLook({ x: 1000 + d, y: 1000 }, c, size)));
    assert.ok(m <= prev + 1e-12, `fade monotonic at ${d}`);
    prev = m;
  }
  assert.deepEqual(pointerLook(null, c, size), { x: 0, y: 0 });
  assert.deepEqual(pointerLook(c, c, 0), { x: 0, y: 0 });
});

await test("camera look: screen centre flat, half short side = full, clamped", () => {
  assert.deepEqual(cameraLook({ x: 960, y: 540 }, 1920, 1080), { x: 0, y: 0 });
  const r = cameraLook({ x: 960 + 540, y: 540 }, 1920, 1080);
  near(r.x, 1); near(r.y, 0);
  const far = cameraLook({ x: 1920, y: 1080 }, 1920, 1080);
  near(Math.hypot(far.x, far.y), 1, 1e-9);
  assert.deepEqual(cameraLook({ x: 1, y: 1 }, 0, 0), { x: 0, y: 0 });
});

await test("uv offset: equals the window's offsetFor for an unrotated token at any zoom", () => {
  for (const [w, h] of [[400, 400], [512, 768]]) {
    for (const s of [0.25, 1, 3.7]) {
      const o = uvOffset({ x: 0.6, y: -0.3 }, 0.5, mat(s, s), w, h);
      const e = offsetFor({ x: 0.6, y: -0.3 }, 0.5, w * s, h * s);
      near(o.x, e.x, 1e-12, "x"); near(o.y, e.y, 1e-12, "y");
    }
  }
});

await test("uv offset: on screen the shift is always along the look, size = strength × MAX_SHIFT × short side (scale, mirror, rotation)", () => {
  const look = { x: 0.8, y: 0.3 };
  for (const m of [mat(2, 2), mat(-2, 2), mat(1.5, -0.75), mat(1, 1, Math.PI / 2), mat(0.8, 1.3, 0.7), mat(-1, 1, -2.1)]) {
    const W = 300, H = 200;
    const o = uvOffset(look, 0.5, m, W, H);
    const scr = apply(m, { x: o.x * W, y: o.y * H }); // uv -> local px -> screen
    const sw = Math.hypot(m.a, m.b) * W, sh = Math.hypot(m.c, m.d) * H;
    const px = 0.5 * MAX_SHIFT * Math.min(sw, sh);
    near(scr.x, look.x * px, 1e-9, "screen x"); near(scr.y, look.y * px, 1e-9, "screen y");
  }
  // mirror: the uv offset flips, the screen motion does not
  const a = uvOffset({ x: 1, y: 0 }, 0.5, mat(1, 1), 100, 100), b = uvOffset({ x: 1, y: 0 }, 0.5, mat(-1, 1), 100, 100);
  near(a.x, -b.x);
  // degenerate transform / no texture: no shift
  assert.deepEqual(uvOffset({ x: 1, y: 0 }, 0.5, { a: 0, b: 0, c: 0, d: 0 }, 100, 100), { x: 0, y: 0 });
  assert.deepEqual(uvOffset({ x: 1, y: 0 }, 0.5, mat(1, 1), 0, 100), { x: 0, y: 0 });
  // look clamped to the unit disc, strength to 0..1
  const big = uvOffset({ x: 5, y: 0 }, 3, mat(1, 1), 100, 100);
  near(big.x, MAX_SHIFT, 1e-12);
});

await test("strength setting and depth texture size", () => {
  assert.equal(cleanStrength(0.5), 0.5);
  assert.equal(cleanStrength("0.42"), 0.4);
  assert.equal(cleanStrength(0), 0.1);
  assert.equal(cleanStrength(9), 1);
  assert.equal(cleanStrength("x"), STRENGTH_DEFAULT);
  assert.equal(cleanStrength(null), STRENGTH_DEFAULT);
  assert.equal(depthFactor(512, 300), 1);
  assert.equal(depthFactor(1024, 1024), 2);
  assert.equal(depthFactor(941, 1672), 4);
  assert.ok(Math.max(941, 1672) / depthFactor(941, 1672) <= 512);
});

await test("half floats: exact on the 1/1024 grid, < 1/2048 relative error in 0..1, specials", () => {
  for (let i = 0; i <= 1024; i++) near(halfToFloat(floatToHalf(i / 1024)), i / 1024, 0, `grid ${i}`);
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const v = Math.random();
    const r = halfToFloat(floatToHalf(v));
    if (v > 6.1e-5) worst = Math.max(worst, Math.abs(r - v) / v);
    else assert.ok(Math.abs(r - v) < 6e-8, "subnormal range");
  }
  assert.ok(worst <= 2 ** -11 + 1e-12, `worst ${worst}`);
  assert.equal(floatToHalf(0), 0);
  assert.equal(floatToHalf(-0), 0x8000);
  assert.equal(floatToHalf(1), 0x3c00);
  assert.equal(floatToHalf(65504), 0x7bff);
  assert.equal(floatToHalf(1e9), 0x7bff);
  assert.equal(floatToHalf(Infinity), 0x7c00);
  assert.ok(Number.isNaN(halfToFloat(floatToHalf(NaN))));
  near(halfToFloat(floatToHalf(1e-6)), 1e-6, 6e-8);
  const arr = toHalfArray(new Float32Array([0, 0.5, 1, 0.25]));
  assert.ok(arr instanceof Uint16Array && arr.length === 4);
  assert.deepEqual([...arr].map(halfToFloat), [0, 0.5, 1, 0.25]);
});

await test("rest: a zero look disables the filter (token renders exactly as without the module)", () => {
  assert.equal(lookIsRest({ x: 0, y: 0 }), true);
  assert.equal(lookIsRest({ x: 0.001, y: 0 }), true);
  assert.equal(lookIsRest({ x: 0.01, y: 0 }), false);
  assert.equal(lookIsRest(null), true);
});

await test("GLSL: legacy PIXI filter (SpriteMaskFilter vertex), GLSL ES 1.0, same ray search as the window", () => {
  assert.match(TOKEN_VS, /attribute vec2 aTextureCoord;/, "legacy filter attributes");
  assert.match(TOKEN_VS, /vTokUv = \(otherMatrix \* vec3\(aTextureCoord, 1\.0\)\)\.xy;/);
  assert.doesNotMatch(TOKEN_FS, /#version|texture\(|textureLod|out vec4/, "GLSL ES 1.0 only");
  for (const s of ["uSampler", "uDepth", "inputClamp", "uTokToIn", "uOff", "uDTexel", "uFocus", "uGamma", "uContrast", "uHoleFill", "uSteps"]) {
    assert.match(TOKEN_FS, new RegExp(`uniform \\w+ ${s};`), s);
  }
  const gl = read("scripts/parallax/parallax-gl.mjs");
  // the pieces that must stay identical to the window's shader
  for (const piece of [
    "float cond(float d){ float g = pow(clamp(d, 0.0, 1.0), uGamma); return clamp((g - 0.5) * uContrast + 0.5, 0.0, 1.0); }",
    "vec2 at(vec2 uv, float h){ return uv - uOff * (h - uFocus); }",
    "if (H(at(uv, hh)) >= hh) { hit = hh; break; }",
    "for (int k = 0; k < 6; k++) { float m = 0.5 * (lo + hi); if (H(at(uv, m)) >= m) lo = m; else hi = m; }",
    "float hole = smoothstep(1.6, 3.5, stretch) * uHoleFill;",
    "for (int k = 0; k < 12; k++) { p += dir * stepL; if (H(p) <= target) break; }"
  ]) {
    assert.ok(gl.includes(piece), `window shader has: ${piece}`);
    assert.ok(TOKEN_FS.includes(piece), `token shader has: ${piece}`);
  }
  assert.match(TOKEN_FS, /for \(int i = 0; i <= 64; i\+\+\)/, "same max steps as the window (64)");
});

await test("GLSL: the output alpha is the input alpha (silhouette, borders, hit areas untouched)", () => {
  assert.match(TOKEN_FS, /vec4 orig = texture2D\(uSampler, vTextureCoord\);/);
  assert.match(TOKEN_FS, /if \(orig\.a <= 0\.0 \|\| uv\.x < 0\.0 \|\| uv\.y < 0\.0 \|\| uv\.x > 1\.0 \|\| uv\.y > 1\.0\) \{ gl_FragColor = orig; return; \}/);
  const outs = TOKEN_FS.match(/gl_FragColor = [^;]+;/g);
  assert.deepEqual(outs, ["gl_FragColor = orig;", "gl_FragColor = vec4(rgb * a, a);"]);
  assert.match(TOKEN_FS, /float a = orig\.a;/);
  // displaced reads go through the clamped input sampler only
  assert.match(TOKEN_FS, /texture2D\(uSampler, clamp\(q, inputClamp\.xy, inputClamp\.zw\)\)/);
});

await test("ray search on a token-sized profile: zero offset returns the pixel itself (filter at rest = identity)", () => {
  const Hm = Array.from({ length: 64 }, (_, i) => (i > 20 && i < 40 ? 0.9 : 0.2));
  for (const u of [0.1, 0.33, 0.5, 0.9]) near(marchRay(Hm, u, 0, 0.45, 8).s, u, 1e-12);
});

await test("wiring: settings, hooks, cleanup, HUD -> depth window, api", () => {
  const src = read("scripts/parallax/token-parallax.mjs");
  assert.match(read("scripts/settings.mjs"), /registerTokenSettings\(\)/);
  assert.match(read("scripts/sheet-button.mjs"), /registerTokenParallax\(\)/);
  assert.match(read("scripts/parallax/entry.mjs"), /tokens: tokenApi/);
  for (const h of ["canvasReady", "canvasTearDown", "drawToken", "destroyToken", "refreshToken", "updateToken", "updateScene", "renderTokenHUD", "renderSceneConfig", "renderTokenConfig", "canvasPan"]) {
    assert.ok(src.includes(`Hooks.on("${h}"`), h);
  }
  assert.match(src, /canvasTearDown", \(\) => \{ detachAll\(\{ dropDepth: true \}\)/, "scene change destroys the depth textures");
  assert.match(src, /type: PIXI\.TYPES\.HALF_FLOAT/);
  assert.match(src, /scope: "world", config: true, restricted: true,\s+type: new foundry\.data\.fields\.BooleanField\(\{ initial: true \}\)/);
  assert.match(src, /initial: "pointer"/);
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /createFrameGuard/);
  assert.match(src, /DepthApp\.open\(\{ path: doc\.texture\.src, typeKey \}\)/, "the HUD opens the depth window (its own estimate + confirmation)");
  assert.match(src, /if \(!game\.user\.isGM\) return;\s+const root = html instanceof HTMLElement/, "HUD button GM only");
  for (const banned of ["executeGeneration", "fetch(", "XMLHttpRequest", "api.openai", "googleapis", "openrouter"]) {
    assert.ok(!src.includes(banned) && !read("scripts/parallax/token-core.mjs").includes(banned), `no ${banned}`);
  }
  assert.ok(!/forEach\(.*generate|for \(const t of .*\) .*DepthApp/.test(src), "no mass generation");
});

await test("lang: every AIIMG.TokenParallax.* key used exists in en and pl", () => {
  const src = read("scripts/parallax/token-parallax.mjs");
  const used = new Set(src.match(/AIIMG\.TokenParallax\.[A-Za-z.]+[A-Za-z]/g));
  used.delete("AIIMG.TokenParallax.Token"); // the template `AIIMG.TokenParallax.Token.${k}`
  for (const k of ["Inherit", "On", "Off"]) used.add(`AIIMG.TokenParallax.Token.${k}`);
  for (const lang of ["en", "pl"]) {
    const j = JSON.parse(read(`lang/${lang}.json`));
    for (const k of used) assert.ok(typeof j[k] === "string" && j[k].length > 0, `${lang}: ${k}`);
  }
  assert.ok(used.size >= 17, `keys ${used.size}`);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
