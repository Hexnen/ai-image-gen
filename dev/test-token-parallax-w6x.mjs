// W6-X: token depth parallax after the 30-token test (W6-W): status counts from the live views, the camera drive cap
// (pickCamera + eased camera amount: bounded number of filters, no pop when a token joins / leaves / enters the screen),
// the filter switched on one frame early (never at a visibly shifted look). Pure Node + static wiring checks.
// Run from the module folder: node dev/test-token-parallax-w6x.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  pickCamera, cameraEffLook, shouldArm, stepLook, stepAmp, pointerLook, cameraLook, lookIsRest, tokenOnScreen,
  MAX_CAMERA_TOKENS, CAMERA_OMEGA, AMP_ON
} from "../scripts/parallax/token-core.mjs";
import { withBreath, MAX_ANIMATED_TOKENS } from "../scripts/parallax/parallax-fx.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mag = (l) => Math.hypot(l.x, l.y);

await test("finding 1: status counts come from the live views (no counter that survives detachAll)", () => {
  const src = read("scripts/parallax/token-parallax.mjs");
  assert.doesNotMatch(src, /let animatedCount|animatedCount =/, "no separate animated counter");
  assert.match(src, /const animatedNow = \(\) => countViews\(\(v\) => v\.animated\);/);
  assert.match(src, /animated: animatedNow\(\), maxAnimated: MAX_ANIMATED_TOKENS,/, "status reads the views");
  assert.match(src, /cameraSelected: cameraNow\(\)/);
  assert.match(src, /function detachAll\(\{ dropDepth = false \} = \{\}\) \{\s+for \(const t of \[\.\.\.views\.keys\(\)\]\) detach\(t\);/, "detachAll empties the views");
  assert.match(src, /views\.delete\(token\);/);
  // the same rule, as a model: counting the views after they are gone gives 0
  const views = new Map([[1, { animated: true }], [2, { animated: true }], [3, { animated: false }]]);
  const count = () => [...views.values()].filter((v) => v.animated).length;
  assert.equal(count(), 2);
  views.clear();
  assert.equal(count(), 0);
});

await test("finding 2: pickCamera: on-screen only, nearest the centre (to the edge), capped, hysteresis", () => {
  assert.equal(MAX_CAMERA_TOKENS, MAX_ANIMATED_TOKENS, "same cap as the pointer drive");
  const center = { x: 500, y: 500 };
  const items = [];
  for (let i = 0; i < 30; i++) items.push({ key: i, x: 500 + (i % 6) * 120 - 300, y: 500 + Math.floor(i / 6) * 120 - 240, r: 40, onScreen: true, selected: false });
  const s = pickCamera(items, { center, cap: 12 });
  assert.equal(s.size, 12);
  const d = (it) => Math.hypot(it.x - center.x, it.y - center.y);
  const worstIn = Math.max(...items.filter((it) => s.has(it.key)).map(d));
  const bestOut = Math.min(...items.filter((it) => !s.has(it.key)).map(d));
  assert.ok(worstIn <= bestOut, "nearest win");
  // off screen never
  const off = items.map((it) => ({ ...it, onScreen: it.key !== 14 && it.key !== 15 ? it.onScreen : false }));
  const s2 = pickCamera(off, { center, cap: 12 });
  assert.ok(!s2.has(14) && !s2.has(15));
  // edge distance: a big token a bit further out beats a small one nearer
  const s3 = pickCamera([{ key: "small", x: 600, y: 500, r: 10, onScreen: true }, { key: "big", x: 650, y: 500, r: 120, onScreen: true }], { center, cap: 1 });
  assert.ok(s3.has("big"));
  // hysteresis: a selected token stays while a newcomer is only slightly nearer
  const s4 = pickCamera([{ key: "old", x: 700, y: 500, r: 0, onScreen: true, selected: true }, { key: "new", x: 690, y: 500, r: 0, onScreen: true }], { center, cap: 1 });
  assert.ok(s4.has("old"), "no churn");
  const s5 = pickCamera([{ key: "old", x: 900, y: 500, r: 0, onScreen: true, selected: true }, { key: "new", x: 600, y: 500, r: 0, onScreen: true }], { center, cap: 1 });
  assert.ok(s5.has("new"), "a clearly nearer token wins");
  assert.equal(pickCamera(items, { center, cap: 0 }).size, 0);
  assert.equal(pickCamera(null).size, 0);
  // ≤ cap on screen: all of them (the look for ≤ cap tokens is the same as before W6-X once the fade settled)
  assert.equal(pickCamera(items.slice(0, 9), { center, cap: 12 }).size, 9);
});

/**
 * Camera drive model (the view's rules, token-parallax.mjs): per frame the set is re-picked (every 250 ms), each
 * token's camera amount eases towards 1 in the set / 0 outside (CAMERA_OMEGA), leaving the screen drops it to 0
 * (invisible), the filter is on while on screen with amount > AMP_ON, a disabled filter turns on one frame early.
 */
function simulateCamera({ n = 30, fps = 55, seconds = 8, cap = MAX_CAMERA_TOKENS, pan = (t) => 0 } = {}) {
  const W = 1200, H = 900, dt = 1 / fps;
  const toks = [];
  for (let i = 0; i < n; i++) toks.push({ x0: 100 + (i % 6) * 200, y: 100 + Math.floor(i / 6) * 170, r: 40, sel: false, a: 0, av: 0, on: false, shown: { x: 0, y: 0 } });
  let enables = 0, enablesAbove = 0, maxOn = 0, maxStep = 0, lastPick = -1, sumOn = 0, frames = 0;
  for (let f = 0; f < seconds * fps; f++) {
    const t = f * dt, px = pan(t);
    for (const k of toks) {
      k.x = k.x0 - px;
      const onS = tokenOnScreen({ x: k.x, y: k.y }, k.r, W, H);
      if (!onS) { k.sel = false; k.a = 0; k.av = 0; }
      k.onScreen = onS;
    }
    if (t - lastPick >= 0.25 || lastPick < 0) {
      lastPick = t;
      const s = pickCamera(toks.map((k, i) => ({ key: i, x: k.x, y: k.y, r: k.r, onScreen: k.onScreen, selected: k.sel })), { center: { x: W / 2, y: H / 2 }, cap });
      toks.forEach((k, i) => { k.sel = s.has(i); });
    }
    let on = 0;
    for (const k of toks) {
      const was = k.on, before = [k.a, k.av];
      const r = stepAmp(k.a, k.av, k.sel ? 1 : 0, dt, CAMERA_OMEGA);
      k.a = r.a; k.av = r.v;
      k.on = k.onScreen && k.a > AMP_ON;
      if (shouldArm(was, k.on)) { [k.a, k.av] = before; }
      const look = cameraEffLook(cameraLook({ x: k.x, y: k.y }, W, H), k.a, null, withBreath);
      if (k.on && !was) { enables++; if (mag(look) > 0.01) enablesAbove++; }
      if (k.on && was) maxStep = Math.max(maxStep, mag({ x: look.x - k.shown.x, y: look.y - k.shown.y }));
      k.shown = k.on ? look : { x: 0, y: 0 };
      if (k.on) on++;
    }
    maxOn = Math.max(maxOn, on);
    sumOn += on; frames++;
  }
  return { enables, enablesAbove, maxOn, maxStep, meanOn: sumOn / frames };
}

await test("finding 2+3: camera drive with 30 tokens: ≤ cap filters, enables at a flat look, bounded steps while panning", () => {
  const still = simulateCamera({});
  console.log(`     still: max filters ${still.maxOn}, enables ${still.enables} (above 0.01: ${still.enablesAbove})`);
  assert.equal(still.maxOn, 12);
  assert.equal(still.enablesAbove, 0);
  const panning = simulateCamera({ pan: (t) => 600 * Math.sin(t * 0.9) });
  console.log(`     panning: mean filters ${panning.meanOn.toFixed(1)}, max ${panning.maxOn}, enables ${panning.enables} (above 0.01: ${panning.enablesAbove}), max per-frame look change ${panning.maxStep.toFixed(4)}`);
  // the set itself never exceeds the cap; tokens fading OUT keep their filter for ~1 s (as in the pointer drive)
  assert.ok(panning.maxOn <= 2 * 12 && panning.meanOn <= 1.5 * 12, "bounded by the cap plus the fading-out tokens");
  const panning60 = simulateCamera({ n: 60, pan: (t) => 600 * Math.sin(t * 0.9) });
  console.log(`     60 tokens panning: mean filters ${panning60.meanOn.toFixed(1)}, max ${panning60.maxOn}`);
  assert.ok(panning60.maxOn <= 2 * 12, "does not grow with the number of tokens");
  assert.ok(panning.enables > 12, "the set changes while panning");
  assert.equal(panning.enablesAbove, 0, "every switch-on at a flat look");
  assert.ok(panning.maxStep < 0.05, "no pop while joining / leaving / panning");
  // ≤ cap tokens: every on-screen token in the set, the settled look is the plain camera look (as before W6-X)
  const few = simulateCamera({ n: 9 });
  assert.equal(few.maxOn, 9);
  const camL = cameraLook({ x: 100, y: 100 }, 1200, 900);
  assert.deepEqual(cameraEffLook(camL, 1, null, withBreath), camL);
  const b = { x: 0.03, y: -0.02 };
  assert.deepEqual(cameraEffLook(camL, 1, b, withBreath), withBreath(camL, b), "breathing as before");
  assert.deepEqual(cameraEffLook(camL, 0, null, withBreath), { x: 0, y: 0 });
});

await test("finding 3: pointer drive: the filter switches on one frame early (look still at rest)", () => {
  // the W6-W case: a pointer jump onto a token at 55 fps; one long frame (dt clamp 0.1) as the worst case
  for (const dt of [1 / 55, 0.036, 0.1]) {
    let look = { x: 0, y: 0 }, vel = { x: 0, y: 0 }, on = false, enablesAbove = 0, naiveAbove = 0;
    const target = pointerLook({ x: 40, y: 0 }, { x: 0, y: 0 }, 100);
    for (let f = 0; f < 60; f++) {
      const was = on, before = [look, vel];
      const r = stepLook(look, vel, f < 3 ? { x: 0, y: 0 } : target, dt);
      look = r.look; vel = r.vel;
      on = !(r.settled && lookIsRest(look));
      if (!was && on && mag(look) > 0.01) naiveAbove++;     // pre-W6-X: enabled with the first step's look
      if (shouldArm(was, on)) [look, vel] = before;
      if (!was && on && mag(look) > 0.01) enablesAbove++;
    }
    console.log(`     dt ${dt.toFixed(3)}: enables above 0.01 look: old ${naiveAbove}, now ${enablesAbove}`);
    assert.equal(enablesAbove, 0);
  }
  assert.equal(shouldArm(false, true), true);
  assert.equal(shouldArm(true, true), false);
  assert.equal(shouldArm(false, false), false);
});

await test("wiring: arm in step(), camera set in repick, fresh stage transform, off-screen drop", () => {
  const src = read("scripts/parallax/token-parallax.mjs");
  assert.match(src, /const before = wasOn \? null : this\.motionState\(\);/);
  assert.match(src, /if \(before && shouldArm\(wasOn, this\.filter\?\.enabled\)\) \{\s+this\.setMotionState\(before\);\s+this\.settled = false;\s+this\.arming = true;/);
  assert.match(src, /this\.arming = false;\s+const ampsSettled/, "the arm lasts until the next step (a pan's sync must not undo it)");
  assert.match(src, /\? this\.onScreen && \(this\.arming \|\|/, "sync keeps an armed filter on");
  assert.match(src, /const camSet = camera \? pickCamera\(items, \{ center, cap: MAX_CAMERA_TOKENS \}\) : new Set\(\);/);
  assert.match(src, /const pick = camera \? \(fx\.animates \? camSet : new Set\(\)\)/, "camera: the same capped set breathes");
  assert.match(src, /const c = stageClient\(t\.center\);/, "camera boxes from the next render's transform");
  assert.match(src, /t\.updateLocalTransform\(\);\s+return t\.localTransform\.apply/);
  assert.match(src, /this\.ampC = this\.ampCV = this\.ampB = this\.ampBV = this\.ampD = this\.ampDV = 0;/, "leaving the screen drops the amounts");
  assert.match(src, /const look = v\.effLook\(\);/, "apply shows the eased camera look");
  assert.match(src, /stepAmp\(this\.ampC, this\.ampCV, this\.drive === "camera" && this\.camSel \? 1 : 0, dt, CAMERA_OMEGA\)/);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
