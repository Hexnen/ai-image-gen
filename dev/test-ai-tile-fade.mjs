// W8 AI Tile fade-in: curve, timing, setting clamp and which create/update events fade (scripts/tile/tile-fade.mjs).
// Run from the module folder: node dev/test-ai-tile-fade.mjs
import assert from "node:assert/strict";
import {
  fadeSeconds, fadeFactor, fadeOnCreate, fadeOnUpdate, stopOnUpdate, FADE_DEFAULT_S, FADE_MAX_S, TILE_FLAG
} from "../scripts/tile/tile-fade.mjs";
import { MODULE_ID } from "../scripts/constants.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("default 5 s; setting clamped to 0..30; junk -> default", () => {
  assert.equal(FADE_DEFAULT_S, 5);
  assert.equal(fadeSeconds(undefined), 5);
  assert.equal(fadeSeconds(null), 5);
  assert.equal(fadeSeconds(""), 5);
  assert.equal(fadeSeconds("abc"), 5);
  assert.equal(fadeSeconds(2.5), 2.5);
  assert.equal(fadeSeconds("7"), 7);
  assert.equal(fadeSeconds(-3), 0);
  assert.equal(fadeSeconds(999), FADE_MAX_S);
});

test("curve: 0 at start, 1 at the end, monotonic, smooth ends, 0.5 in the middle", () => {
  const D = 5000;
  assert.equal(fadeFactor(0, D), 0);
  assert.equal(fadeFactor(-100, D), 0);
  assert.equal(fadeFactor(D, D), 1);
  assert.equal(fadeFactor(D * 3, D), 1);
  near(fadeFactor(D / 2, D), 0.5);
  let prev = -1;
  for (let t = 0; t <= D; t += 50) { const k = fadeFactor(t, D); assert.ok(k >= prev, `not monotonic at ${t}`); prev = k; }
  // smoothstep: slow start and end (slope 0), so the first and last 5 % move < 1 %
  assert.ok(fadeFactor(D * 0.05, D) < 0.01);
  assert.ok(fadeFactor(D * 0.95, D) > 0.99);
  // ~1 s after paste (of 5 s) the tile is still faint; ~6 s it is fully there
  assert.ok(fadeFactor(1000, D) > 0.05 && fadeFactor(1000, D) < 0.15);
  assert.equal(fadeFactor(6000, D), 1);
});

test("duration 0 (or junk) = appears at once", () => {
  assert.equal(fadeFactor(0, 0), 1);
  assert.equal(fadeFactor(10, -5), 1);
  assert.equal(fadeFactor(10, NaN), 1);
  assert.equal(fadeFactor(NaN, 1000), 0);
});

const ai = { flags: { [MODULE_ID]: { [TILE_FLAG]: { key: "k" } } } };
const plain = { flags: {} };

test("create: fades only an AI tile, only for the user who created it", () => {
  assert.equal(TILE_FLAG, "aiTile");
  assert.equal(fadeOnCreate(ai, "gm1", "gm1"), true);
  assert.equal(fadeOnCreate(ai, "gm1", "player"), false);
  assert.equal(fadeOnCreate(plain, "gm1", "gm1"), false);
  assert.equal(fadeOnCreate(ai, undefined, undefined), false);
  assert.equal(fadeOnCreate(null, "a", "a"), false);
});

test("update: fades on reveal (hidden -> false) for everyone; not on other changes; re-hide stops", () => {
  assert.equal(fadeOnUpdate(ai, { hidden: false }), true);
  assert.equal(fadeOnUpdate(ai, { hidden: true }), false);
  assert.equal(fadeOnUpdate(ai, { x: 5 }), false);
  assert.equal(fadeOnUpdate(ai, { elevation: 5, _id: "x" }), false);
  assert.equal(fadeOnUpdate(plain, { hidden: false }), false);
  assert.equal(fadeOnUpdate(ai, null), false);
  assert.equal(stopOnUpdate({ hidden: true }), true);
  assert.equal(stopOnUpdate({ hidden: false }), false);
  assert.equal(stopOnUpdate({}), false);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
