// W6-T: smooth motion of the sheet-portrait parallax (owner: "it jumps; the return when the mouse leaves the portrait
// must be smooth for ALL effects") and the frame guard that judges the module's OWN cost. Pure parts of
// scripts/parallax/portrait-core.mjs: springStep, pointerTarget, stepMotion, createCostGuard. Simulated frame series at
// 30 / 60 / 144 / 166 Hz (with jitter), the old model (easeToward, half-life 0.14 s) for comparison. Pure Node.
// Run from the module folder: node dev/test-portrait-motion.mjs   (add --print for the series summary)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  springStep, pointerTarget, createMotion, stepMotion, MOTION, MOVE_FRAME_MS, IDLE_DRAW_MS, createCostGuard, FADE_AT, effectAmount
} from "../scripts/parallax/portrait-core.mjs";
import { easeToward } from "../scripts/parallax/parallax-core.mjs";
import { breathLook } from "../scripts/parallax/parallax-fx.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const PRINT = process.argv.includes("--print");

/** Deterministic frame intervals (ms) at `hz` with ±`jit` relative jitter. */
function frames(hz, seconds, jit = 0.08, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  let t = 0;
  while (t < seconds * 1000) { const dt = (1000 / hz) * (1 + (rnd() * 2 - 1) * jit); out.push(dt); t += dt; }
  return out;
}

const OFF = { breath: 0, light: 1, dust: 0, animates: false };                // extras off (light on: follows the tilt)
const ON = { breath: 0.5, light: 1, dust: 0.4, animates: true };              // W6-Q defaults

/**
 * Run a scenario: `script(tMs)` -> pointer target or null. Returns the per-frame series (what a draw would show).
 * The motion clock = elapsed time; breathing look at full strength from parallax-fx (as portrait.mjs).
 */
function run(hz, seconds, script, fx = OFF, init = null) {
  const s = init ?? createMotion();
  const rows = [];
  let t = 0;
  for (const dtMs of frames(hz, seconds)) {
    t += dtMs;
    const m = stepMotion(s, dtMs / 1000, { pointer: script(t), breathLook: fx.breath ? breathLook(t, 1) : null, ...fx });
    rows.push({ t, dt: dtMs, x: s.look.x, y: s.look.y, op: s.opacity, light: effectAmount(0.6 * s.light, s.look), dust: s.dust, breath: s.breath, settled: m.settled, idle: m.idle });
  }
  return { s, rows };
}

/** Largest change per frame, normalised to a 60 Hz frame (16.67 ms) so different rates compare. */
function maxDelta(rows, key, from = 0) {
  let m = 0, at = -1;
  for (let i = Math.max(1, from); i < rows.length; i++) {
    const d = Math.abs(rows[i][key] - rows[i - 1][key]) * (16.667 / rows[i].dt);
    if (d > m) { m = d; at = i; }
  }
  return { m, at };
}
/**
 * Largest acceleration between frames (units / s²): a velocity that jumps within one frame (the old exponential at the
 * moment of the leave) shows as a huge value that grows with the frame rate; a spring stays ≤ ω² × distance.
 */
function maxAccel(rows, key, from = 1) {
  let m = 0;
  for (let i = Math.max(2, from); i < rows.length; i++) {
    const v1 = (rows[i][key] - rows[i - 1][key]) / (rows[i].dt / 1000), v0 = (rows[i - 1][key] - rows[i - 2][key]) / (rows[i - 1].dt / 1000);
    m = Math.max(m, Math.abs(v1 - v0) / (((rows[i].dt + rows[i - 1].dt) / 2) / 1000));
  }
  return m;
}

const FULL = { x: 1, y: 0, k: 1 };
const leaveAt = (ms, target = FULL) => (t) => (t < ms ? target : null);

await test("springStep: exact critically damped closed form (any dt), no overshoot, frame-rate independent", () => {
  // two half steps = one full step (exact solution)
  const [a1, v1] = springStep(1, 0, 0, 0.05, 8);
  const [a2, v2] = springStep(...springStep(1, 0, 0, 0.025, 8), 0, 0.025, 8);
  near(a1, a2, 1e-12); near(v1, v2, 1e-12);
  // x(t) = (1 + ωt) e^{-ωt} from rest
  near(springStep(1, 0, 0, 0.2, 8)[0], (1 + 1.6) * Math.exp(-1.6), 1e-12);
  // from rest: monotone to the target, never past it, starts with zero velocity
  let x = 1, v = 0, last = 1;
  for (let i = 0; i < 400; i++) { [x, v] = springStep(x, v, 0, 1 / 60, MOTION.rest); assert.ok(x <= last + 1e-15 && x >= -1e-12); last = x; }
  assert.equal(springStep(0.3, 0.1, 0, 0, 8)[0], 0.3, "dt 0 = unchanged");
  assert.equal(springStep(0.3, 0.1, 0.7, 0.1, 0)[0], 0.7, "ω 0 = snap (guard)");
});

await test("pointerTarget: as before inside the picture; beyond the edge the tilt fades smoothly to 0 (leaving the PORTRAIT returns)", () => {
  const rect = { x: 100, y: 100, w: 200, h: 400 };
  const c = pointerTarget(200, 300, rect);
  near(c.x, 0); near(c.y, 0); assert.equal(c.k, 1);
  const edge = pointerTarget(300, 300, rect);
  near(edge.x, 1); assert.equal(edge.k, 1);
  // continuous across the edge and through the margin, monotone fade, 0 beyond
  let last = null, maxStep = 0;
  for (let px = 280; px <= 360; px += 0.5) {
    const p = pointerTarget(px, 300, rect);
    if (last) maxStep = Math.max(maxStep, Math.abs(p.x - last.x));
    if (px > 300) assert.ok(p.x <= last.x + 1e-12, "fades monotonically outside");
    last = p;
  }
  // continuous: the fade over the margin (30 % of the half width = 30 px here) changes ≤ 0.03 per half pixel
  assert.ok(maxStep < 0.03, `no step at the edge (max ${maxStep} per half pixel)`);
  const far = pointerTarget(300 + 100 * (MOTION && 0.31), 300, rect);
  assert.equal(far.k, 0); near(far.x, 0);
  assert.equal(pointerTarget(NaN, 1, rect).k, 0);
  assert.equal(pointerTarget(1, 1, null).k, 0);
});

await test("leave from full tilt: no frame jumps (look, opacity, light) at 30/60/144/166 Hz; zero velocity kick at the leave", () => {
  const out = [];
  for (const hz of [30, 60, 144, 166]) {
    // follow the pointer at full tilt for 1.5 s (steady), leave, watch 2.5 s
    const { rows } = run(hz, 4, leaveAt(1500), OFF);
    const iLeave = rows.findIndex((r) => r.t >= 1500);
    const dl = maxDelta(rows, "x", iLeave), dop = maxDelta(rows, "op", iLeave), dli = maxDelta(rows, "light", iLeave);
    const acc = maxAccel(rows, "x", iLeave - 1);
    const firstFrame = Math.abs(rows[iLeave].x - rows[iLeave - 1].x) * (16.667 / rows[iLeave].dt);
    out.push({ hz, maxLookPerFrame: +dl.m.toFixed(4), firstFrame: +firstFrame.toFixed(4), maxAccel: Math.round(acc), maxOpacityPerFrame: +dop.m.toFixed(4), maxLightPerFrame: +dli.m.toFixed(4) });
    assert.ok(dl.m < 0.05, `${hz} Hz: look per frame ${dl.m}`);
    assert.ok(firstFrame < 0.02, `${hz} Hz: the first frame after the leave moves ${firstFrame} (no velocity jump)`);
    assert.ok(acc <= MOTION.rest ** 2 * 1.05, `${hz} Hz: acceleration ${acc} (spring: ≤ ω² = ${MOTION.rest ** 2})`);
    assert.ok(dop.m < 0.06, `${hz} Hz: opacity per frame ${dop.m}`);
    assert.ok(dli.m < 0.03, `${hz} Hz: light per frame ${dli.m}`);
    // the canvas hides only after it has faded out; then the loop may stop
    const iHide = rows.findIndex((r, i) => i > iLeave && r.op < MOTION.hideBelow);
    const iStop = rows.findIndex((r) => r.settled);
    assert.ok(iHide > iLeave && iStop >= iHide, `${hz} Hz: hide ${iHide}, stop ${iStop}`);
    assert.ok(rows[iStop - 1].op < 0.01 && Math.hypot(rows[iStop - 1].x, rows[iStop - 1].y) < 0.003, "nothing visible is snapped away");
    assert.ok(rows[iStop].t - 1500 < 2200, `${hz} Hz: at rest after ${Math.round(rows[iStop].t - 1500)} ms`);
  }
  // the old model (exponential, half-life 0.14 s) for comparison: the full speed starts in one frame
  const old = [];
  for (const hz of [60, 166]) {
    const s = { x: 1 }, rows = [];
    let t = 0;
    for (const dtMs of frames(hz, 2)) { t += dtMs; s.x = easeToward(s.x, t < 500 ? 1 : 0, dtMs / 1000, 0.14); rows.push({ t, dt: dtMs, x: s.x }); }
    const i = rows.findIndex((r) => r.t >= 500);
    old.push({ hz, firstFrame: +(Math.abs(rows[i].x - rows[i - 1].x) * (16.667 / rows[i].dt)).toFixed(4), maxAccel: Math.round(maxAccel(rows, "x", i - 1)) });
  }
  assert.ok(old[0].firstFrame > 0.07 && old[0].maxAccel > 250, "the old model starts at full speed in one frame");
  assert.ok(old[1].maxAccel > old[0].maxAccel * 2, "and its kick grows with the frame rate");
  if (PRINT) console.log("leave, extras off:", JSON.stringify(out), "\nold model (easeToward 0.14 s):", JSON.stringify(old));
});

await test("enter (pointer arrives at the edge) and re-enter mid-decay: continuous, no kick", () => {
  for (const hz of [60, 166]) {
    // at rest, pointer enters at t = 500 ms, leaves at 1500, re-enters at 1700 (mid-decay) at the opposite side, leaves at 2600
    const tgt = (t) => (t < 500 ? null : t < 1500 ? FULL : t < 1700 ? null : t < 2600 ? { x: -0.8, y: 0.3, k: 1 } : null);
    const { rows } = run(hz, 4, tgt, OFF);
    const dl = maxDelta(rows, "x"), acc = maxAccel(rows, "x"), dop = maxDelta(rows, "op");
    // the pointer TELEPORTS across the picture here (worst case: a real pointer moves continuously); the follow spring
    // (ω 12) peaks at ω/e × distance per second: ≤ 0.11 per 60 Hz frame for this 1.5 jump, no velocity step
    assert.ok(dl.m < 0.11, `${hz} Hz: look per frame ${dl.m}`);
    assert.ok(acc <= MOTION.follow ** 2 * 1.9, `${hz} Hz: acceleration ${acc} ≤ ω² × distance`);
    assert.ok(dop.m < 0.12, `${hz} Hz: opacity per frame ${dop.m}`);
    const iEnter = rows.findIndex((r) => r.t >= 500);
    near(rows[iEnter - 1].x, 0, 1e-9, "starts from rest");
    assert.ok(rows[iEnter].x < 0.03, "the first frame after entering moves only a little (no velocity step)");
    const iRe = rows.findIndex((r) => r.t >= 1700);
    assert.ok(rows[iRe].x > 0.2 && rows[iRe].op > 0.5, "re-entered mid-decay: still tilted and shown");
    if (PRINT) console.log(`enter/re-enter ${hz} Hz:`, JSON.stringify({ maxLookPerFrame: +dl.m.toFixed(4), maxAccel: Math.round(acc), maxOpacityPerFrame: +dop.m.toFixed(4) }));
  }
});

await test("extras on (defaults): leave eases into breathing (no stop, no hide), idle only once settled; breathing fades as the pointer comes", () => {
  const { rows } = run(60, 6, leaveAt(1500), ON);
  const iLeave = rows.findIndex((r) => r.t >= 1500);
  assert.ok(maxDelta(rows, "x", iLeave).m < 0.05 && maxDelta(rows, "y", iLeave).m < 0.05);
  assert.ok(maxAccel(rows, "x", iLeave - 1) <= MOTION.rest ** 2 * 1.1 && maxAccel(rows, "y", iLeave - 1) <= MOTION.rest ** 2 * 1.1);
  assert.ok(rows.every((r) => !r.settled), "the loop never stops with breathing / dust");
  assert.ok(rows.slice(iLeave).every((r) => r.op > 0.99), "the canvas stays shown");
  const iIdle = rows.findIndex((r, i) => i > iLeave && r.idle);
  assert.ok(iIdle > iLeave && rows[iIdle].t - 1500 > 400, `idle (30 fps) only after the return settled: ${Math.round(rows[iIdle].t - 1500)} ms`);
  assert.ok(Math.hypot(rows.at(-1).x, rows.at(-1).y) <= 0.1 + 1e-9, "breathing amplitude ≤ 0.5 × 0.2");
  assert.ok(maxDelta(rows, "breath").m < 0.02 && maxDelta(rows, "dust").m < 0.02);
  // dust and breathing appear smoothly when a sheet opens (no pop)
  near(rows[0].dust, 0, 0.01); near(rows[0].op, 0, 0.05);
});

await test("switching extras off / the device opt-out at rest: dust, light, breathing ease out, then the canvas fades and the loop stops", () => {
  const { s } = run(60, 3, () => null, ON);
  const { rows } = run(60, 4, () => null, { breath: 0, light: 0, dust: 0, animates: false }, s);
  assert.ok(maxDelta(rows, "dust").m < 0.02, "dust fades");
  assert.ok(maxDelta(rows, "x").m < 0.01 && maxDelta(rows, "y").m < 0.01, "breathing tilt returns");
  assert.ok(maxDelta(rows, "op").m < 0.06, "opacity fades");
  const iStop = rows.findIndex((r) => r.settled);
  assert.ok(iStop > 10 && rows[iStop - 1].op < 0.01 && rows[iStop - 1].dust < 0.003, "stops only after everything faded");
});

await test("draw caps: ~60 / s while easing (display rate above it is not drawn every frame), 30 / s only for idle", () => {
  assert.ok(MOVE_FRAME_MS > 12 && MOVE_FRAME_MS < 16.6, "60 Hz displays draw every frame");
  assert.equal(IDLE_DRAW_MS, 33);
  // emulate portrait.mjs: draw when t - lastDraw >= cap - 0.5
  const draws = (hz) => { let last = -1e9, n = 0, t = 0; for (const d of frames(hz, 2, 0.03)) { t += d; if (t - last >= MOVE_FRAME_MS - 0.5) { last = t; n++; } } return n / 2; };
  const r60 = draws(60), r166 = draws(166), r144 = draws(144);
  assert.ok(r60 > 57 && r60 < 62, `60 Hz: ${r60}/s`);
  assert.ok(r166 > 50 && r166 < 62, `166 Hz: ${r166}/s (was 166)`);
  assert.ok(r144 < 75, `144 Hz: ${r144}/s`);
  if (PRINT) console.log("draws/s while easing:", { r60, r144, r166 });
});

// ------------------------------------------------------------------ frame guard

await test("cost guard: cheap effect at 60 fps = ok; an unrelated slow page does NOT trip (on/off comparison shows no gain)", () => {
  const g = createCostGuard({ warmup: 5, window: 20, probeFrames: 10, probeEveryMs: 30000 });
  let t = 0, r;
  for (let i = 0; i < 25; i++) r = g.sample({ tMs: (t += 16.7), gapMs: 16.7, cpuMs: 0.4, gpuMs: null });
  assert.equal(r, "ok");
  // something else makes the page slow (80 ms frames), our draw is cheap, the browser has no GPU timer
  for (let i = 0; i < 20; i++) r = g.sample({ tMs: (t += 80), gapMs: 80, cpuMs: 0.4, gpuMs: null });
  assert.equal(r, "probe");
  assert.ok(g.probing);
  for (let i = 0; i < 10; i++) r = g.probeSample(80 + (i % 3), (t += 80));
  assert.equal(r, "ok", "no gain without our draws: not our fault");
  assert.ok(!g.probing);
  // the page stays slow: no new probe for 30 s, no trip
  for (let i = 0; i < 200; i++) r = g.sample({ tMs: (t += 80), gapMs: 80, cpuMs: 0.4, gpuMs: null });
  assert.equal(r, "ok");
  assert.equal(g.state().probes, 1);
});

await test("cost guard: an expensive effect trips (own CPU / GPU cost; or the page gets faster without it)", () => {
  // heavy CPU draws: the hard own-cost threshold, whatever the page rate
  let g = createCostGuard({ warmup: 5, window: 20 }), r;
  for (let i = 0; i < 25; i++) r = g.sample({ gapMs: 30, cpuMs: 12, gpuMs: null });
  assert.equal(r, "bad");
  // GPU timer says our draws cost 25 ms
  g = createCostGuard({ warmup: 5, window: 20 });
  for (let i = 0; i < 25; i++) r = g.sample({ gapMs: 40, cpuMs: 0.3, gpuMs: 25 });
  assert.equal(r, "bad");
  // slow page and a GPU cost that is a big share of it (6 of 70 ms is fine, 25 of 70 is not)
  g = createCostGuard({ warmup: 5, window: 20, maxCostMs: 30 });
  for (let i = 0; i < 25; i++) r = g.sample({ gapMs: 70, cpuMs: 0.5, gpuMs: 5.5 });
  assert.equal(r, "ok", "known small GPU cost on a slow page: not ours, no probe");
  assert.equal(g.state().probes, 0);
  for (let i = 0; i < 25; i++) r = g.sample({ gapMs: 70, cpuMs: 0.5, gpuMs: 25 });
  assert.equal(r, "bad");
  // no GPU timer: slow page that recovers when we stop drawing = ours
  g = createCostGuard({ warmup: 5, window: 20, probeFrames: 10 });
  for (let i = 0; i < 25; i++) r = g.sample({ tMs: i * 70, gapMs: 70, cpuMs: 0.5, gpuMs: null });
  assert.equal(r, "probe");
  for (let i = 0; i < 10; i++) r = g.probeSample(17, 2000 + i * 17);
  assert.equal(r, "bad");
  // stalls / tab switches are ignored
  g = createCostGuard({ warmup: 2, window: 5 });
  for (let i = 0; i < 20; i++) r = g.sample({ gapMs: 5000, cpuMs: 50 });
  assert.equal(r, "warmup");
});

await test("wiring: portrait.mjs uses the springs, the caps, the cost guard (with GPU timer + on/off probe) and per-window frames", () => {
  const src = readFileSync(new URL("../scripts/parallax/portrait.mjs", import.meta.url), "utf8");
  assert.match(src, /const m = stepMotion\(M, dt, \{/);
  assert.match(src, /pointerTarget\(ev\.clientX, ev\.clientY, this\.place\.drawn\)/);
  assert.match(src, /const minGap = m\.idle && !layout && !this\.dirty \? IDLE_DRAW_MS : MOVE_FRAME_MS;/);
  assert.match(src, /const guard = createCostGuard\(\);/);
  assert.match(src, /prev\.probe \? guard\.probeSample\(gap, t\) : guard\.sample\(\{ tMs: t, gapMs: gap, cpuMs: prev\.cpu, gpuMs: prev\.gpu \}\)/);
  assert.match(src, /g\.timerBegin\(\)/);
  assert.match(src, /host\.clock \+= step \* 1000;/, "the motion clock pauses while probing (no jump after it)");
  assert.match(src, /W\.requestAnimationFrame\(frame\)/);
  assert.doesNotMatch(src, /globalThis\.innerWidth|[^.]requestAnimationFrame\(frame\)/, "no main-window viewport / frames for a detached sheet");
  assert.match(src, /win\.innerWidth/);
  assert.match(src, /on\(win, "resize", dirty/);
  assert.match(src, /visibility = op >= MOTION\.hideBelow \? "" : "hidden"/, "hidden only once faded");
  assert.doesNotMatch(src, /easeToward|overlayOpacity\(/, "no per-frame exponential / switch-style opacity left");
  assert.match(src, /LINGER_MS = 10000/);
  assert.match(src, /DEPTH_SIDE = 1024/);
  assert.match(src, /loadDepthConditioned\(/);
  assert.doesNotMatch(src, /conditionDepth\(/, "no conditioning on the main thread");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
