// W6-U: token depth parallax fixes, the pure parts (scripts/parallax/token-core.mjs) + static wiring checks:
// smoothing (springs: no velocity jump at leave / enter, frame-rate independent, amounts fade at cap changes), the depth
// texture cache released by ENTRY (F2), the GM-confirmed "on" (F6, in test-token-parallax.mjs), binary16 packing
// identical to the old function and faster, the depth-texture preparation identical to the old inline pipeline, the
// frame guard deciding from the module's own cost. Pure Node. Run from the module folder: node dev/test-token-parallax-w6u.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  springStep, stepLook, stepAmp, scaleLook, needsStep, tokenOnScreen, pointerLook, lookIsRest, floatToHalf, toHalfArray,
  halfToFloat, prepareDepthTexture, depthFactor, guardVerdict, probeFrame, createDepthCache, depthKey, LOOK_OMEGA, AMP_OMEGA
} from "../scripts/parallax/token-core.mjs";
import { easeToward, conditionDepth, downscaleMap } from "../scripts/parallax/parallax-core.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mag = (l) => Math.hypot(l.x, l.y);

/** Simulate a token's look for a pointer path; `old` = the pre-W6-U ease (0.12 s half-life + snap at 0.002). */
function simulate(fps, seconds, pointerAt, { old = false } = {}) {
  const dt = 1 / fps, c = { x: 0, y: 0 }, size = 100;
  let look = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
  const out = [];
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const p = pointerAt(i * dt);
    const target = p ? pointerLook(p, c, size) : { x: 0, y: 0 };
    if (old) {
      look = { x: easeToward(look.x, target.x, dt, 0.12), y: easeToward(look.y, target.y, dt, 0.12) };
      if (Math.hypot(look.x - target.x, look.y - target.y) <= 0.002) look = { ...target };
    } else {
      const r = stepLook(look, vel, target, dt);
      look = r.look; vel = r.vel;
    }
    out.push({ t: (i + 1) * dt, look: { ...look }, rest: lookIsRest(look) && lookIsRest(vel) });
  }
  return out;
}
const deltas = (s) => s.slice(1).map((f, i) => mag({ x: f.look.x - s[i].look.x, y: f.look.y - s[i].look.y }));
const second = (s) => { const d = deltas(s); return d.slice(1).map((x, i) => Math.abs(x - d[i])); };

await test("spring: exact (frame-rate independent), continuous velocity, settles exactly on the target", () => {
  // one 0.5 s step == 30 steps of 1/60 == 72 steps of 1/144 (closed form for a constant target)
  let a = { x: 1, v: 0 }, b = { x: 1, v: 0 };
  a = springStep(a.x, a.v, 0, 0.5, LOOK_OMEGA);
  for (let i = 0; i < 72; i++) b = springStep(b.x, b.v, 0, 0.5 / 72, LOOK_OMEGA);
  near(a.x, b.x, 1e-12); near(a.v, b.v, 1e-12);
  // critically damped: never overshoots a step
  let s = { x: 1, v: 0 }, min = 1;
  for (let i = 0; i < 600; i++) { s = springStep(s.x, s.v, 0, 1 / 60, LOOK_OMEGA); min = Math.min(min, s.x); }
  assert.ok(min >= 0, `no overshoot (min ${min})`);
  const r = stepLook({ x: 0.0001, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 1 / 60);
  assert.equal(r.settled, true); assert.deepEqual(r.look, { x: 0, y: 0 });
  assert.deepEqual(springStep(0.3, 0.1, 0, 0, 5), { x: 0.3, v: 0.1 }, "dt 0 = no change");
});

// numbers printed for the notes (W6-U, finding 1)
const leave = (t) => (t < 1 ? { x: 40, y: 0 } : null);                     // full tilt, then the pointer leaves the board
const enter = (t) => (t < 0.3 ? null : { x: 40, y: 0 });                    // pointer appears at full tilt (jump into the zone)
const sweep = (t) => ({ x: 400 - 600 * Math.min(1, t / 0.4), y: 10 });       // fast sweep through the reach zone and out
await test("finding 1: leave / enter / sweep: no first-frame jump, per-frame steps bounded, at 60 and 144 fps", () => {
  for (const fps of [60, 144]) {
    for (const [name, path] of [["leave", leave], ["enter", enter], ["sweep", sweep]]) {
      const nu = simulate(fps, 3, path), ol = simulate(fps, 3, path, { old: true });
      const dn = deltas(nu), dold = deltas(ol), an = second(nu), aold = second(ol);
      const maxN = Math.max(...dn), maxO = Math.max(...dold), accN = Math.max(...an), accO = Math.max(...aold);
      console.log(`     ${name}@${fps}: max per-frame |Δlook| new ${maxN.toFixed(4)} old ${maxO.toFixed(4)}; max |Δ²| new ${accN.toFixed(4)} old ${accO.toFixed(4)}`);
      assert.ok(maxN <= maxO + 1e-12, `${name}@${fps}: per-frame step not larger than before`);
      // leave / enter: the target jumps; the old ease jumped to full speed in one frame, the spring accelerates smoothly.
      // sweep: the target itself turns sharply (pointer through the centre): only "not worse"
      assert.ok(accN < accO * (name === "sweep" ? 1 : 0.5), `${name}@${fps}: no velocity jump (Δ² ${accN} vs ${accO})`);
      // frame-rate independent: per second the same peak speed
      assert.ok(maxN * fps <= LOOK_OMEGA / Math.E * 1.05 + 1e-9 || name === "sweep", `${name}@${fps}: peak speed ≤ ω/e`);
    }
  }
  // leave: back at rest exactly, and only then (the filter is disabled after the last moving frame)
  const s = simulate(60, 3, leave);
  const firstRest = s.findIndex((f, i) => f.t > 1 && f.rest);
  assert.ok(firstRest > 0 && s.slice(firstRest).every((f) => f.rest && f.look.x === 0), "settles once, stays at 0");
  const tRest = s[firstRest].t - 1;
  console.log(`     leave: at rest ${tRest.toFixed(2)} s after the pointer left; |look| 1 frame before: ${mag(s[firstRest - 1].look).toFixed(5)}`);
  assert.ok(tRest < 1.2, `back to rest in ${tRest}`);
  assert.ok(mag(s[firstRest - 1].look) < 0.002, "the last moving frame is already invisible (< 0.002 look)");
});

await test("finding 1: breathing / dust amount fades when a token leaves / joins the animated set (cap re-pick)", () => {
  for (const fps of [60, 144]) {
    const dt = 1 / fps;
    let a = 0, v = 0;
    const series = [];
    for (let i = 0; i < 4.5 * fps; i++) {       // join at 0, leave at 1.5 s
      const r = stepAmp(a, v, i * dt < 1.5 ? 1 : 0, dt);
      a = r.a; v = r.v; series.push(a);
    }
    const d = series.slice(1).map((x, i) => Math.abs(x - series[i]));
    const maxD = Math.max(...d);
    console.log(`     amp@${fps}: max per-frame Δ ${maxD.toFixed(4)} (old: 1.0000, a switch); first frame ${series[0].toFixed(4)}; after leave first frame Δ ${d[Math.round(1.5 * fps) - 1].toFixed(4)}`);
    assert.ok(maxD <= AMP_OMEGA / Math.E / fps * 1.05, "bounded by the spring's peak speed");
    assert.ok(series[0] < 0.01, "no pop in");
    assert.equal(series.at(-1), 0, "faded out completely (then the filter may switch off)");
    assert.ok(series.every((x) => x >= 0 && x <= 1));
  }
  assert.deepEqual(scaleLook({ x: 0.1, y: -0.2 }, 0.5), { x: 0.05, y: -0.1 });
  assert.deepEqual(scaleLook({ x: 0.1, y: -0.2 }, 0), { x: 0, y: 0 });
});

await test("perf d: only views near the pointer, moving or animated are stepped; camera boxes", () => {
  const c = { x: 0, y: 0 };
  assert.equal(needsStep({ settled: true, atRest: true, pointer: { x: 1000, y: 0 }, center: c, size: 100 }), false, "far + at rest");
  assert.equal(needsStep({ settled: true, atRest: true, pointer: { x: 200, y: 0 }, center: c, size: 100 }), true, "inside the fade radius");
  assert.equal(needsStep({ settled: true, atRest: false, pointer: { x: 1000, y: 0 }, center: c, size: 100 }), true, "tilted: must return");
  assert.equal(needsStep({ settled: false, atRest: true, pointer: null }), true);
  assert.equal(needsStep({ settled: true, atRest: true, animated: true, pointer: null }), true);
  assert.equal(needsStep({ settled: true, atRest: true, amp: 0.2, pointer: null }), true, "fading extras");
  assert.equal(needsStep({ settled: true, atRest: true, pointer: null }), false);
  // the skip radius covers the whole fade (pointerLook is exactly 0 beyond it)
  const p = { x: 2.75 * 100 + 0.01, y: 0 };
  assert.deepEqual(pointerLook(p, c, 100), { x: 0, y: 0 });
  assert.equal(tokenOnScreen({ x: 500, y: 300 }, 50, 1000, 600), true);
  assert.equal(tokenOnScreen({ x: -100, y: 300 }, 50, 1000, 600), false);
  assert.equal(tokenOnScreen({ x: -60, y: 300 }, 50, 1000, 600), true, "margin");
  assert.equal(tokenOnScreen(null, 50, 1000, 600), false);
});

await test("finding 2: depth textures are released by ENTRY: a view torn down while loading never drops a newer entry", async () => {
  const timers = new Map(); let tid = 0;
  const setTimer = (fn) => { timers.set(++tid, fn); return tid; };
  const clearTimer = (id) => timers.delete(id);
  const runTimers = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  const resolvers = [];
  const disposed = [];
  const cache = createDepthCache({
    build: (info) => { const n = resolvers.length + 1; return new Promise((r) => resolvers.push(() => r({ tex: `${info.depth}#${n}` }))); },
    dispose: (v) => disposed.push(v.tex), releaseMs: 10_000, setTimer, clearTimer
  });
  const info = { depth: "maps/a_depth.png" };
  // view A starts loading; the scene is redrawn (tear-down destroys every entry); view B acquires the same map
  const eA = cache.acquire(info);
  await Promise.resolve();
  cache.destroyAll();
  const eB = cache.acquire(info);
  assert.notEqual(eA, eB, "a new entry after the tear-down");
  await Promise.resolve();
  resolvers.forEach((r) => r());
  await eB.p; await eA.p.catch(() => {});
  // A's late load: A releases ITS entry (dead: no-op) - the old code released by path = B's entry
  cache.release(eA);
  assert.equal(eB.refs, 1, "B keeps its reference");
  runTimers();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cache.get(depthKey(info)), eB, "B's entry still cached");
  assert.ok(!disposed.includes(eB.value.tex), "B's texture not destroyed");
  assert.ok(disposed.includes(eA.value.tex), "A's texture destroyed (after its build finished)");
  // same file without a tear-down: A torn down while loading, B arrives before the release delay: shared entry survives
  const c2 = cache.acquire({ depth: "maps/b_depth.png" });
  cache.release(c2);
  assert.equal(c2.refs, 0); assert.ok(c2.timer, "release timer running");
  const d2 = cache.acquire({ depth: "maps/b_depth.png" });
  assert.equal(d2, c2, "re-acquired before the delay: same entry"); assert.equal(d2.refs, 1); assert.equal(d2.timer, 0);
  runTimers();
  assert.equal(d2.dead, false);
  cache.release(d2); runTimers();
  assert.equal(d2.dead, true, "last release + delay = destroyed");
  cache.release(d2);
  assert.equal(d2.refs, 0, "releasing a dead entry is a no-op");
  // a new revision is a different texture
  assert.notEqual(depthKey({ depth: "x.png", rev: 5 }), depthKey({ depth: "x.png", rev: 6 }));
  assert.equal(depthKey({ depth: "x.png", rev: 0 }), "x.png", "rev 0 = an older entry without revision");
  // view code: no release by path left
  const src = read("scripts/parallax/token-parallax.mjs");
  assert.doesNotMatch(src, /releaseDepth\(this\.info/, "views release their entry object");
  assert.match(src, /const e = this\.entry = acquireDepth\(this\.info\);/);
  assert.match(src, /if \(this\.destroyed\) return;\s+\/\/ destroy\(\) already released `e`/);
});

// the pre-W6-U function, verbatim (allocating two typed arrays per call)
function floatToHalfOld(v) {
  if (Number.isNaN(v)) return 0x7e00;
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00;
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7bff;
  if (exp <= 0) {
    if (exp < -10) return sign;
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
const toHalfArrayOld = (src) => { const out = new Uint16Array(src.length); for (let i = 0; i < src.length; i++) out[i] = floatToHalfOld(src[i]); return out; };

await test("perf a: binary16 packing bit-identical to the old function, and faster", () => {
  const vals = new Float32Array(1 << 20);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < vals.length; i++) {
    const k = i % 8;
    vals[i] = k < 4 ? rnd() : k === 4 ? (rnd() - 0.5) * 1e5 : k === 5 ? (rnd() - 0.5) * 1e-6 : k === 6 ? halfToFloat(i & 0xffff) : -rnd();
  }
  vals.set([NaN, Infinity, -Infinity, 0, -0, 65504, 65520, 1e-8, 5.96e-8, 2.98e-8, 6.1e-5], 0);
  const t0 = performance.now(); const a = toHalfArrayOld(vals); const t1 = performance.now(); const b = toHalfArray(vals); const t2 = performance.now();
  for (let i = 0; i < 16; i++) assert.equal(floatToHalf(vals[i]), floatToHalfOld(vals[i]), `value ${vals[i]}`);
  let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.equal(diff, 0, "every one of 1M values identical");
  const arr = [0.1, NaN, 2];
  assert.deepEqual([...toHalfArray(arr)], arr.map(floatToHalfOld), "plain arrays too");
  console.log(`     1M values: old ${(t1 - t0).toFixed(0)} ms, new ${(t2 - t1).toFixed(0)} ms`);
  assert.ok(t2 - t1 < t1 - t0, "faster");
});

await test("perf a: prepareDepthTexture (worker / inline) = the old inline pipeline", () => {
  const w = 1100, h = 700, D = new Float32Array(w * h), mask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const e = ((x - 550) / 400) ** 2 + ((y - 350) / 260) ** 2;
    D[y * w + x] = e < 1 ? 0.8 - 0.3 * e : 0.1 + 0.05 * Math.sin(x / 30); mask[y * w + x] = e < 1 ? 1 : 0;
  }
  const src = { D, mask, w, h, bits: 16, format: "png16" };
  // old: token-parallax.mjs buildDepthTexture before W6-U
  let s = src;
  const f = depthFactor(s.w, s.h, 512);
  if (f >= 2) { const d = downscaleMap(s.D, s.w, s.h, f); s = { ...s, D: d.M, mask: downscaleMap(s.mask, s.w, s.h, f).M, w: d.w, h: d.h }; }
  // W6-V: the conditioning itself changed (normals from the guided, display-scale copy); the pipeline is still the same
  const c = conditionDepth(s, { dilatePx: 2, normalBlurPx: 0, normals: "guided" });
  const oldHalf = toHalfArrayOld(c.rgba);
  const r = prepareDepthTexture(src, 512);
  assert.equal(r.w, c.w); assert.equal(r.h, c.h);
  assert.ok(Math.max(r.w, r.h) <= 512);
  let diff = 0; for (let i = 0; i < oldHalf.length; i++) if (oldHalf[i] !== r.half[i]) diff++;
  assert.equal(diff, 0, "identical texture data");
  const wsrc = read("scripts/parallax/token-depth-worker.mjs");
  assert.match(wsrc, /import \{ prepareDepthTexture \} from "\.\/token-core\.mjs";/);
  assert.match(wsrc, /self\.postMessage\(\{ id, half: r\.half, w: r\.w, h: r\.h \}, \[r\.half\.buffer\]\)/, "transfers the result");
  assert.doesNotMatch(wsrc, /\bgame\.|\bPIXI\.|\bcanvas\.|\bfoundry\./, "worker is pure");
  const tp = read("scripts/parallax/token-parallax.mjs");
  assert.match(tp, /new Worker\(new URL\("\.\/token-depth-worker\.mjs", import\.meta\.url\), \{ type: "module" \}\)/);
  assert.match(tp, /loadDepthConditioned/, "uses the loader's own worker when it has one");
});

await test("perf e: the guard decides from the module's own cost (A/B probe), unrelated slow frames do not trip", () => {
  assert.equal(guardVerdict({ base: 58, probe: 59, ownCpuMs: 0.3 }), "notUs", "unrelated 58 ms load, effect ~1 ms");
  assert.equal(guardVerdict({ base: 58, probe: 62, ownCpuMs: 0.3 }), "notUs", "4 ms: under the minimum");
  assert.equal(guardVerdict({ base: 60, probe: 70, ownCpuMs: 0.3 }), "notUs", "10 ms but < 25 % of the frame");
  assert.equal(guardVerdict({ base: 46, probe: 76, ownCpuMs: 0.3 }), "slow", "expensive effect");
  assert.equal(guardVerdict({ ownCpuMs: 9 }), "slow", "last resort: own CPU > 8 ms per frame");
  assert.equal(guardVerdict({ ownCpuMs: 2 }), "probe");
  assert.equal(guardVerdict({ base: 58, probe: null }), "probe");
  // probe schedule: 8 blocks of 8 frames, alternating, first 2 of each block dropped
  const fr = Array.from({ length: 70 }, (_, i) => probeFrame(i));
  assert.equal(fr.findIndex((f) => f.done), 64);
  assert.equal(fr.slice(0, 64).filter((f) => f.use && f.double).length, 24);
  assert.equal(fr.slice(0, 64).filter((f) => f.use && !f.double).length, 24);
  assert.deepEqual(fr.slice(0, 10).map((f) => +f.double), [0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  const src = read("scripts/parallax/token-parallax.mjs");
  assert.match(src, /if \(probeDouble\) \{\s+filterManager\.applyFilter\(this, input, output, clearMode\);/, "probe = the same pass again (invisible)");
  assert.match(src, /if \(v === "slow"\) \{ tooSlow\(\); return true; \}/);
  assert.match(src, /guard\?\.reset\(\);\s+probeUntil = now \+ 15_000;/, "not us: reset and wait");
});

await test("wiring: void pass without our filter, transition padding, pan re-reads the pointer, continuous clock, camera on-screen", () => {
  const src = read("scripts/parallax/token-parallax.mjs");
  assert.match(src, /f\.enabled = false;\s+counters\.voidSkips\+\+;\s+try \{ return base\.call\(this, renderer\); \} finally \{ f\.enabled = true; \}/, "void pass skips our filter");
  assert.match(src, /if \(this\._voidOwn\) mesh\._renderVoid = this\._voidBase;\s+else delete mesh\._renderVoid;/, "unwrapped on unbind");
  assert.match(src, /const padded = !!\(mesh\?\._paddingX \|\| mesh\?\._paddingY\);/, "Foundry's transition padding: pass-through");
  assert.match(src, /if \(pointerClient\) \{\s+try \{ pointer = canvas\.canvasCoordinatesFromClient\(pointerClient\); \}/, "canvasPan re-reads the pointer");
  assert.match(src, /Hooks\.on\("canvasPan", \(\) => onPan\(\)\);/);
  assert.match(src, /fxTimeMs = now;/, "continuous breathing / dust clock");
  assert.doesNotMatch(src, /IDLE_FRAME_MS|lastIdleT/, "no 30 fps steps");
  assert.match(src, /this\.filter\.enabled = this\.drive === "camera" \? this\.onScreen/, "camera: only on screen");
  assert.match(src, /: !\(this\.settled && lookIsRest\(this\.look\)\) \|\| this\.ampD > 0\.001;/, "pointer: off only once settled at rest");
  assert.doesNotMatch(src, /easeToward/, "springs, not the per-frame ease");
  assert.match(src, /if \(a !== v\.animated\) \{ v\.animated = a; v\.settled = false; \}/, "cap re-pick: no hard switch of the breath");
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
