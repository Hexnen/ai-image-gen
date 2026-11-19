// W6-P: breathing / light / dust extras of the depth parallax on portraits and tokens, the pure parts
// (scripts/parallax/parallax-fx.mjs): settings normalisation and defaults, the reduced-motion rule, the breathing look
// (small, smooth), the cap on animated tokens, the dust scale, GLSL parity (the window and the token filter use ONE copy
// of the dust and light/rim code, equal to the window's pre-W6-P maths), plus static checks of the wiring and lang.
// Pure Node. Run from the module folder: node dev/test-parallax-fx.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FX_DEFAULTS, FX_RANGES, FX_KEYS, FX_DEVICE_OFF_KEY, fxSettingKey, cleanFxStrength, normalizeFx, effectiveFx, breathLook, withBreath,
  phaseOf, pickAnimated, inView, dustScale, BREATH_MAX, IDLE_FRAME_MS, MAX_ANIMATED_TOKENS, GLSL_FX
} from "../scripts/parallax/parallax-fx.mjs";
import { TOKEN_FS } from "../scripts/parallax/token-core.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

await test("W6-Q defaults: breathing, light and dust ON for portraits and tokens; strengths unchanged; device opt-out", () => {
  const p = normalizeFx(undefined, "portrait"), t = normalizeFx(null, "token");
  assert.deepEqual([p.breath, p.light, p.dust], [true, true, true]);
  assert.deepEqual([t.breath, t.light, t.dust], [true, true, true]);
  assert.deepEqual([p.breathStrength, p.lightStrength, p.dustStrength], [0.5, 1, 0.4], "portrait strengths as in W6-P");
  assert.deepEqual([t.breathStrength, t.lightStrength, t.dustStrength], [0.5, 0.6, 0.4], "token strengths as in W6-P");
  assert.equal(effectiveFx(t).animates, true);
  assert.equal(effectiveFx(p).animates, true);
  // reduced motion still forces breathing + dust off (light stays); the device opt-out turns all three off
  const rm = effectiveFx(p, { reducedMotion: true });
  assert.deepEqual([rm.breath, rm.light, rm.dust, rm.animates], [false, true, false, false]);
  for (const x of [p, t]) {
    const d = effectiveFx(x, { deviceOff: true });
    assert.deepEqual([d.breath, d.light, d.dust, d.animates], [false, false, false, false]);
  }
  // a saved false (a client / world that chose off) is kept: defaults only fill missing values, no migration
  assert.equal(normalizeFx({ breath: false, dust: false, light: false }, "token").breath, false);
  assert.equal(FX_DEVICE_OFF_KEY, "parallaxFxDeviceOff");
  assert.doesNotMatch(FX_DEVICE_OFF_KEY, /\./);
  assert.deepEqual(Object.keys(p).sort(), [...FX_KEYS].sort());
});

await test("normalizeFx: booleans only from booleans, strengths clamped and snapped, junk = default, idempotent", () => {
  const n = normalizeFx({ breath: "yes", light: 0, dust: true, breathStrength: 7, lightStrength: "0.333", dustStrength: NaN, junk: 1 }, "token");
  assert.equal(n.breath, FX_DEFAULTS.token.breath, "a non-boolean = the default");
  assert.equal(n.light, FX_DEFAULTS.token.light, "a non-boolean = the default");
  assert.equal(n.dust, true);
  const off = normalizeFx({ breath: false, light: false, dust: false }, "portrait");
  assert.deepEqual([off.breath, off.light, off.dust], [false, false, false], "saved booleans win over the defaults");
  assert.equal(n.breathStrength, 1);
  assert.equal(n.lightStrength, 0.35);
  assert.equal(n.dustStrength, FX_DEFAULTS.token.dustStrength);
  assert.equal(n.junk, undefined);
  assert.deepEqual(normalizeFx(n, "token"), n);
  assert.equal(cleanFxStrength("breathStrength", -3, 0.5), 0.1);
  assert.equal(cleanFxStrength("breathStrength", "", 0.5), 0.5);
  assert.equal(cleanFxStrength("breathStrength", true, 0.5), 0.5);
  assert.equal(cleanFxStrength("nope", 0.3, 0.5), 0.5);
  for (const [k, [min, max]] of Object.entries(FX_RANGES)) {
    for (const v of [min - 1, min, (min + max) / 2, max, max + 1]) {
      const c = cleanFxStrength(k, v, -1);
      assert.ok(c >= min && c <= max, `${k} ${v} -> ${c}`);
    }
  }
  for (const t of ["portrait", "token"]) for (const k of ["breathStrength", "lightStrength", "dustStrength"]) {
    const [min, max] = FX_RANGES[k];
    assert.ok(FX_DEFAULTS[t][k] >= min && FX_DEFAULTS[t][k] <= max, `${t}.${k} default in range`);
  }
});

await test("setting keys: no dots (no clash with portraitParallax / tokenParallax under dotted-key expansion), unique", () => {
  const keys = ["portrait", "token"].flatMap((t) => FX_KEYS.map((k) => fxSettingKey(t, k)));
  assert.equal(new Set(keys).size, 12);
  for (const k of keys) {
    assert.doesNotMatch(k, /\./);
    assert.ok(!["portraitParallax", "tokenParallax", "tokenParallaxDrive", "tokenParallaxStrength"].includes(k));
  }
  assert.equal(fxSettingKey("portrait", "breath"), "portraitFxBreath");
  assert.equal(fxSettingKey("token", "dustStrength"), "tokenFxDustStrength");
});

await test("reduced motion forces breathing and dust OFF, light stays", () => {
  const all = normalizeFx({ breath: true, light: true, dust: true }, "token");
  const e = effectiveFx(all, { reducedMotion: true });
  assert.deepEqual([e.breath, e.light, e.dust, e.animates], [false, true, false, false]);
  const f = effectiveFx(all, { reducedMotion: false });
  assert.deepEqual([f.breath, f.light, f.dust, f.animates], [true, true, true, true]);
  assert.equal(effectiveFx(normalizeFx({ dust: true }, "portrait")).animates, true);
  assert.equal(all.animates, undefined, "input not mutated");
});

await test("breathing: tiny (well under the cursor's full tilt), smooth (no jitter), off at strength 0", () => {
  assert.ok(BREATH_MAX <= 0.25);
  let maxLen = 0, maxStep = 0, maxCurv = 0, prev = null, prev2 = null;
  for (let t = 0; t < 120000; t += 16) {
    const l = breathLook(t, 1);
    maxLen = Math.max(maxLen, Math.hypot(l.x, l.y));
    if (prev) maxStep = Math.max(maxStep, Math.hypot(l.x - prev.x, l.y - prev.y));
    if (prev2) maxCurv = Math.max(maxCurv, Math.hypot(l.x - 2 * prev.x + prev2.x, l.y - 2 * prev.y + prev2.y));
    prev2 = prev; prev = l;
  }
  assert.ok(maxLen <= BREATH_MAX + 1e-9 && maxLen > BREATH_MAX * 0.5, `amplitude ${maxLen}`);
  assert.ok(maxStep < 0.004, `per-frame change ${maxStep} (slow)`);
  assert.ok(maxCurv < 1e-4, `second difference ${maxCurv} (smooth)`);
  assert.deepEqual(breathLook(5000, 0), { x: 0, y: 0 });
  const half = breathLook(7777, 0.5), full = breathLook(7777, 1);
  assert.ok(Math.abs(half.x * 2 - full.x) < 1e-12 && Math.abs(half.y * 2 - full.y) < 1e-12, "scales with strength");
  assert.notDeepEqual(breathLook(1000, 1, phaseOf("a")), breathLook(1000, 1, phaseOf("b")), "phase desynchronises tokens");
  assert.deepEqual(breathLook(NaN, 1), { x: 0, y: 0 });
});

await test("withBreath: pointer wins as it comes near, breathing where it is away, continuous", () => {
  const b = { x: 0.1, y: -0.05 };
  assert.deepEqual(withBreath({ x: 0, y: 0 }, b), b);
  assert.deepEqual(withBreath({ x: 1, y: 0 }, b), { x: 1, y: 0 });
  assert.deepEqual(withBreath({ x: 0.3, y: 0 }, { x: 0, y: 0 }), { x: 0.3, y: 0 });
  let prev = null;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const l = withBreath({ x: p, y: 0 }, b);
    if (prev) assert.ok(Math.hypot(l.x - prev.x, l.y - prev.y) < 0.02);
    prev = l;
  }
});

await test("phaseOf: stable, 0..60 s", () => {
  assert.equal(phaseOf("tok1"), phaseOf("tok1"));
  for (const id of ["", "a", "abcdefghijklmnop", null, 42]) { const p = phaseOf(id); assert.ok(p >= 0 && p < 60000); }
});

await test("cap: only tokens in view, nearest the pointer (else the screen centre), at most the cap", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ key: `t${i}`, x: i * 50, y: 100, r: 25, inView: i % 3 !== 0 }));
  const byPointer = pickAnimated(items, { pointer: { x: 1000, y: 100 }, cap: 4 });
  assert.equal(byPointer.size, 4);
  for (const k of byPointer) { const i = Number(k.slice(1)); assert.ok(i % 3 !== 0, "in view only"); assert.ok(Math.abs(i * 50 - 1000) <= 150, k); }
  assert.ok(byPointer.has("t20") && byPointer.has("t19") && byPointer.has("t22"), "nearest first");
  const byCenter = pickAnimated(items, { pointer: null, center: { x: 0, y: 100 }, cap: 3 });
  assert.deepEqual([...byCenter], ["t1", "t2", "t4"]);
  assert.equal(pickAnimated(items, { cap: 0 }).size, 0);
  assert.equal(pickAnimated(items, {}).size, Math.min(MAX_ANIMATED_TOKENS, items.filter((i) => i.inView).length));
  assert.equal(pickAnimated(null).size, 0);
  assert.equal(pickAnimated(items.map((i) => ({ ...i, inView: false })), { cap: 5 }).size, 0);
  // ties keep the input order
  assert.deepEqual([...pickAnimated([{ key: "a", x: 1, y: 0, inView: true }, { key: "b", x: -1, y: 0, inView: true }], { center: { x: 0, y: 0 }, cap: 1 })], ["a"]);
  assert.ok(MAX_ANIMATED_TOKENS >= 4 && MAX_ANIMATED_TOKENS <= 32);
  assert.equal(IDLE_FRAME_MS, 33, "idle loop capped at ~30 fps");
});

await test("inView / dustScale", () => {
  assert.equal(inView(-10, 50, 20, 100, 100), true);
  assert.equal(inView(-30, 50, 20, 100, 100), false);
  assert.equal(inView(50, 130, 20, 100, 100), false);
  assert.equal(dustScale(450), 1);
  assert.equal(dustScale(10), 0.3);
  assert.equal(dustScale(1e5), 1.5);
  assert.equal(dustScale("x"), 0.3);
});

// The window's dust / light code BEFORE W6-P (verbatim from parallax-gl.mjs at a0aeb2d, W6-O), and the renames applied
// when it moved into GLSL_FX (uniforms became parameters; the local `rim` became `rr`).
const OLD = {
  hash: "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
  plane: `float dustPlane(vec2 uv, float sc, float sp, float seed){
  vec2 q = uv * sc + vec2(uTime * 0.02 * sp, -uTime * 0.035 * sp) + seed;
  vec2 i = floor(q), f = fract(q);
  float r = hash(i + seed);
  vec2 c = vec2(hash(i + 1.3), hash(i + 7.7)) * 0.8 + 0.1 + vec2(sin(uTime * 0.5 + r * 6.0), cos(uTime * 0.4 + r * 6.0)) * 0.08;
  float tw = 0.5 + 0.5 * sin(uTime * (1.0 + r * 2.0) + r * 20.0);
  return step(0.82, r) * smoothstep(0.06, 0.0, length(f - c)) * tw;
}`,
  dust: `float b = dustPlane(du + uOff * (0.25 - uFocus) * 0.9, 26.0, 1.0, 0.0) * smoothstep(0.3, 0.2, d) * 0.35
            + dustPlane(du + uOff * (0.6 - uFocus) * 0.9, 18.0, 1.4, 3.0) * smoothstep(0.65, 0.55, d) * 0.5
            + dustPlane(du + uOff * (1.25 - uFocus) * 0.9, 11.0, 1.9, 9.0) * 0.7;
    c += vec3(1.0, 0.72, 0.6) * b * uDust;`,
  light: `vec3 N = normalize(vec3(-dx * uRelief, -dy * uRelief, 1.0));
    vec3 L = normalize(vec3(uLook.x, uLook.y, 0.8));
    float nl = dot(N, L);
    c *= mix(1.0, 0.8 + 0.36 * max(nl, 0.0), fig * uLight);
    float facing = length(N.xy) > 1e-4 ? smoothstep(0.0, 0.7, dot(normalize(N.xy), normalize(uLook + vec2(1e-4)))) : 0.0;
    float rim = (pow(1.0 - N.z, 1.4) * facing * 1.4 + pow(clamp(nl, 0.0, 1.0), 6.0) * 0.35) * fig * uRim;
    c += vec3(1.0, 0.58, 0.44) * rim * 0.6;`
};
const squash = (s) => s.replace(/\s+/g, " ").trim();

await test("GLSL parity: GLSL_FX = the window's pre-W6-P dust and light/rim maths (renamed only)", () => {
  const plane = OLD.plane.replace(/\buTime\b/g, "t").replace(/\bhash\(/g, "fxHash(")
    .replace("float dustPlane(vec2 uv, float sc, float sp, float seed){", "float fxDustPlane(vec2 uv, float sc, float sp, float seed, float t){");
  assert.ok(squash(GLSL_FX).includes(squash(plane)), "dust plane");
  assert.ok(squash(GLSL_FX).includes(squash(OLD.hash.replace("hash(", "fxHash("))), "hash");
  // the three planes: same scales (× sc; the window passes 1.0), speeds, seeds, depth gates and weights
  const dustNew = squash(GLSL_FX.slice(GLSL_FX.indexOf("float fxDust("), GLSL_FX.indexOf("vec3 fxDustColor")));
  for (const m of OLD.dust.matchAll(/dustPlane\(du \+ uOff \* \(([\d.]+) - uFocus\) \* 0\.9, ([\d.]+), ([\d.]+), ([\d.]+)\)/g)) {
    assert.ok(dustNew.includes(`fxDustPlane(du + off * (${m[1]} - focus) * 0.9, ${m[2]} * sc, ${m[3]}, ${m[4]}, t)`), m[0]);
  }
  for (const g of ["smoothstep(0.3, 0.2, d) * 0.35", "smoothstep(0.65, 0.55, d) * 0.5", "* 0.7;"]) assert.ok(dustNew.includes(g), g);
  assert.match(GLSL_FX, /vec3 fxDustColor\(\)\{ return vec3\(1\.0, 0\.72, 0\.6\); \}/);
  const light = OLD.light.replace(/\buRelief\b/g, "relief").replace(/\buLook\b/g, "look").replace(/\buLight\b/g, "light")
    .replace(/\buRim\b/g, "rim").replace("float rim = (", "float rr = (").replace("c += vec3(1.0, 0.58, 0.44) * rim * 0.6;", "return c + vec3(1.0, 0.58, 0.44) * rr * 0.6;");
  assert.ok(squash(GLSL_FX).includes(squash(light)), "light / rim");
});

await test("GLSL: one shared copy, common subset of GLSL ES 1.0 and 3.0", () => {
  assert.doesNotMatch(GLSL_FX, /#version|\btexture(2D|Lod|Grad)?\s*\(|\bin\s+vec|\bout\s+vec|\buniform\b|precision|gl_Frag/, "no version-specific syntax, no texture reads, no uniforms");
  const gl = read("scripts/parallax/parallax-gl.mjs");
  assert.match(gl, /import \{ GLSL_FX \} from "\.\/parallax-fx\.mjs";/);
  assert.equal((gl.match(/\$\{GLSL_FX\}/g) ?? []).length, 1, "window shader includes it once");
  assert.doesNotMatch(gl, /float dustPlane\(|float hash\(|vec3 L = normalize/, "no second copy left in the window shader");
  assert.match(gl, /if \(uDust > 0\.001\) c \+= fxDustColor\(\) \* fxDust\(q, uOff, uFocus, d, uTime, 1\.0\) \* uDust;/, "window: same inputs, scale 1");
  assert.match(gl, /c = fxLightRim\(c, dx, dy, fig, uLook, uLight, uRim, uRelief\);/);
  assert.ok(TOKEN_FS.includes(GLSL_FX), "token filter includes the same text");
  assert.ok(TOKEN_FS.indexOf("precision highp float;") < TOKEN_FS.indexOf("float fxHash("), "after the precision statement");
  assert.doesNotMatch(TOKEN_FS.replace(GLSL_FX, ""), /fxHash\(vec2|float fxDustPlane\(vec2/, "no forked copy in the token shader");
});

await test("GLSL token: extras only recolour inside the token, alpha out = alpha in, 0 amounts = pre-W6-P output", () => {
  const outs = TOKEN_FS.match(/gl_FragColor = [^;]+;/g);
  assert.deepEqual(outs, ["gl_FragColor = orig;", "gl_FragColor = vec4(rgb * a, a);"], "only the two pre-W6-P outputs");
  const i0 = TOKEN_FS.indexOf("float a = orig.a;"), i1 = TOKEN_FS.indexOf("if (uLight > 0.001 || uRim > 0.001 || uDust > 0.001) {"), i2 = TOKEN_FS.indexOf("gl_FragColor = vec4(rgb * a, a);");
  assert.ok(i0 > 0 && i1 > i0 && i2 > i1, "extras sit between the alpha and the output, gated by their amounts");
  const block = TOKEN_FS.slice(i1, i2);
  assert.match(block, /rgb = clamp\(rgb, 0\.0, 1\.0\);/, "straight colour clamped: rgb * a never exceeds a");
  assert.doesNotMatch(block, /\ba\s*=|orig\s*=/, "alpha untouched");
  assert.match(block, /fxDust\(uv, uOff, uFocus, d2, uTime, uDustScale\)/, "dust in token uv (inside the token texture)");
  for (const u of ["uLook", "uLight", "uRim", "uRelief", "uDust", "uDustScale", "uTime"]) assert.match(TOKEN_FS, new RegExp(`uniform \\w+ ${u};`), u);
  // transparent pixels return before anything (dust never shows over empty token corners)
  assert.ok(TOKEN_FS.indexOf("if (orig.a <= 0.0") < i1);
});

await test("wiring: W6-Q world settings (GM) + one device opt-out next to the parallax ones, reduced motion, cap, idle frame rate", () => {
  const portrait = read("scripts/parallax/portrait.mjs"), token = read("scripts/parallax/token-parallax.mjs");
  assert.match(portrait, /registerFxSettings\("portrait"/);
  assert.match(portrait, /scope: "world", config: true, restricted: true, type, onChange/);
  assert.doesNotMatch(portrait, /fxSettingKey\(target, k\), \{[^}]*scope: "client"/);
  assert.match(portrait, /register\(MODULE_ID, FX_DEVICE_OFF_KEY, \{[\s\S]{0,200}scope: "client", config: true/);
  assert.match(portrait, /deviceOff: fxDeviceOff\(\)/);
  assert.match(token, /deviceOff: fxDeviceOff\(\)/);
  assert.match(token, /registerFxSettings\("token"/);
  assert.ok(token.indexOf('registerFxSettings("token"') > token.indexOf("STRENGTH_SETTING, {"), "after the token strength setting");
  assert.ok(portrait.indexOf('registerFxSettings("portrait"') > portrait.indexOf("game.settings.register(MODULE_ID, SETTING"), "after the portrait switch");
  assert.match(portrait, /effectiveFx\(normalizeFx\(raw, "portrait"\), \{ reducedMotion:/);
  assert.match(token, /effectiveFx\(normalizeFx\(raw, "token"\), \{ reducedMotion: reducedMotion\(\), deviceOff: fxDeviceOff\(\) \}\)/);
  // W6-T: portrait draws ~60 / s while easing, ~30 / s (IDLE_DRAW_MS = IDLE_FRAME_MS) for idle breathing / dust only
  assert.match(portrait, /const minGap = m\.idle && !layout && !this\.dirty \? IDLE_DRAW_MS : MOVE_FRAME_MS;/, "portrait idle draws capped");
  assert.match(token, /fxTimeMs = now;/, "token idle clock (W6-U)");
  assert.match(token, /cap: MAX_ANIMATED_TOKENS/);
  // W6-T: the portrait guard samples every drawn frame (idle runs included) from the module's own cost
  assert.match(portrait, /if \(drew\) host\.prev = \{ cpu, gpu: host\.gl\.timerSupported \? host\.gpuMs : null \};/, "guard also during idle runs");
  assert.match(token, /\(moving \|\| panning \|\| animating\) && enabled > 0 && guardFrame\(gap, now\)/, "token guard also while animating at rest");
  // all switches off: nothing new runs (no extra loop, filter enabled exactly as before)
  assert.match(token, /this\.filter\.enabled = this\.drive === "camera" \? this\.onScreen\s+: !\(this\.settled && lookIsRest\(this\.look\)\) \|\| this\.ampD > 0\.001;/);
  assert.match(portrait, /const busy = !m\.settled \|\| layout \|\| fx\.animates;/);
  for (const f of ["scripts/parallax/parallax-fx.mjs"]) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//, `${f}: no network`);
    assert.doesNotMatch(src, /\bgame\.|\bPIXI\.|\bdocument\.|\bcanvas\./, `${f}: pure`);
  }
});

await test("lang: every extra has name + hint in en and pl; token hints state the constant cost and the cap", () => {
  for (const l of ["en", "pl"]) {
    const j = JSON.parse(read(`lang/${l}.json`));
    for (const T of ["Portrait", "Token"]) for (const k of FX_KEYS) for (const s of ["Name", "Hint"]) {
      const key = `AIIMG.ParallaxFx.${T}.${k[0].toUpperCase()}${k.slice(1)}.${s}`;
      assert.ok(typeof j[key] === "string" && j[key].length > 3, `${l}: ${key}`);
    }
    for (const s of ["Name", "Hint"]) assert.ok(typeof j[`AIIMG.ParallaxFx.DeviceOff.${s}`] === "string", `${l}: DeviceOff.${s}`);
    for (const T of ["Portrait", "Token"]) for (const k of FX_KEYS) {
      const h = j[`AIIMG.ParallaxFx.${T}.${k[0].toUpperCase()}${k.slice(1)}.Hint`];
      assert.match(h, l === "en" ? /Set by the GM for all players\./ : /Ustawia MG dla wszystkich graczy\./, `${l}: ${T}.${k} hint says the GM sets it`);
    }
    for (const k of ["Breath", "Dust"]) {
      const h = j[`AIIMG.ParallaxFx.Token.${k}.Hint`];
      assert.ok(h.includes(String(MAX_ANIMATED_TOKENS)), `${l}: ${k} hint names the cap ${MAX_ANIMATED_TOKENS}`);
      assert.match(h, l === "en" ? /GPU all the time/ : /Stale kosztuje GPU/, `${l}: ${k} hint states the constant cost`);
    }
  }
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
