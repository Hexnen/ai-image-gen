// T11 loadability: the vendored chargen rules core imports in plain Node (no Foundry globals, no other files) and its pure functions work.
// Placeholder names only (no book text). Run: node dev/test-vendor-chargen-load.mjs   (also run by test-vendor-sync.mjs)
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = path.join(ROOT, "scripts/systems/invincible/vendor/chargen");
let n = 0;
const ok = (name) => { n++; console.log(`  ok ${name}`); };
console.log("vendor/chargen load");

const GLOBALS = ["game", "foundry", "Hooks", "CONFIG", "canvas", "ui", "window", "document"];
for (const g of GLOBALS) assert.equal(typeof globalThis[g], "undefined", `${g} is defined before the import`);
const rules = await import(pathToFileURL(path.join(V, "rules.mjs")).href);
const state = await import(pathToFileURL(path.join(V, "state.mjs")).href);
const { STAMP } = await import(pathToFileURL(path.join(V, "stamp.mjs")).href);
const { contentHash } = await import(pathToFileURL(path.join(V, "sync.mjs")).href);
for (const g of GLOBALS) assert.equal(typeof globalThis[g], "undefined", `${g} appeared after the import`);
ok("rules.mjs + state.mjs + stamp.mjs import in plain Node without Foundry globals");
assert.equal(STAMP.hash, contentHash(V));
ok(`stamp.mjs hash matches the files (${STAMP.hash})`);

// ---------- rules: rank table and budget oracle (chargen-spec 1.3: sum = P + 2(N - S)) ----------
assert.deepEqual(rules.RANK_ORDER, ["teen", "street", "global", "cosmic"]);
for (const rk of rules.RANK_ORDER) {
  const r = rules.RANKS[rk];
  for (let S = 1; S <= 7; S++) assert.equal(rules.budgetFor(rk, { S }), r.points + 2 * (r.powers - S));
}
assert.equal(rules.budgetFor("global", { S: 4, x: 1, e: 1, d: 2 }), 32);
assert.equal(rules.budgetFor("__proto__", { S: 1 }), 0);
assert.equal(rules.isRank("constructor"), false);
ok("budgetFor follows the oracle for every rank; prototype keys are not ranks");

// slots: levels count as powers, limits pay for levels/boosts
assert.equal(rules.powerSlots({ level: 1, boosts: [{}], limits: [] }), 3);
assert.equal(rules.powerSlots({ level: 1, boosts: [{}], limits: [{ grants: "level" }, { grants: "boost" }] }), 1);
assert.equal(rules.powerSlots({ level: 0, boosts: [], limits: [{ grants: "level" }] }), 1, "a level limit on a basic power pays nothing");
assert.equal(rules.levelCap("cosmic"), 2); assert.equal(rules.levelCap("global"), 1);
ok("powerSlots / limitsGranting / levelCap");

// reconcileAttributes: deterministic, exact target, clamps
const rec = rules.reconcileAttributes({ fighting: 9, agility: 1, strength: 30, reason: 2, intuition: 2, presence: 2 }, 32, 10);
assert.equal(rec.ok, true); assert.equal(rules.attrSum(rec.attrs), 32);
assert.ok(Object.values(rec.attrs).every((v) => v >= 1 && v <= 10));
assert.deepEqual(rules.reconcileAttributes({ fighting: 9, agility: 1, strength: 30, reason: 2, intuition: 2, presence: 2 }, 32, 10), rec);
assert.equal(rules.reconcileAttributes({}, 5, 10).ok, false);
assert.equal(rules.talentLimit("Knowledgeable (Anything)"), 1); assert.equal(rules.talentLimit("constructor"), 1);
assert.equal(rules.wordCase("hot-headed"), "Hot-headed");
ok("reconcileAttributes, talentLimit, wordCase");

// ---------- state reducers -> a valid hero; validate codes ----------
const empty = state.createState({ seed: "abc123", rank: "global" });
const v0 = rules.validate(empty);
assert.equal(v0.ok, false);
for (const c of ["powers.none", "talent.hero.missing", "occupation.missing", "personality.count", "heroName.empty"]) assert.ok(v0.errors.some((i) => i.code === c), c);
assert.ok(v0.errors.every((i) => i.key === `IPC.Rule.${i.code}`));
ok("empty state: expected error codes with IPC.Rule.* keys");

const deepFreeze = (o) => { if (o && typeof o === "object") { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
let s = deepFreeze(empty);
s = state.addSource(s, { name: "Test Source" });
s = state.addPower(s, { name: "Test Power A", level: 1 });
s = state.addPower(s, { name: "Test Power B" });
s = state.addPower(s, { name: "Test Power C" });
assert.equal(empty.powers.length, 0, "reducers must not mutate their input");
assert.equal(rules.slots(s), 4);
assert.equal(s.powers[0].sourceKey, "s1"); assert.deepEqual(s.powers.map((p) => p.key), ["p1", "p2", "p3"]);
s = state.setHeroTalent(s, { name: "Test Talent H" });
s = state.patch(s, { occupation: "Test Occupation", occTalent: { name: "Test Talent O", packUuid: null }, resources: 2,
  personality: ["Calm", "Bold"], drive: { name: "Test drive", text: "" }, flaw: { name: "Test flaw", text: "" }, heroName: "Test Hero", civilianName: "Test Civ" });
assert.equal(rules.budget(s), 32);
s = state.setAttrs(s, rules.reconcileAttributes(s.attrs, rules.budget(s), rules.rankOf(s).cap).attrs);
const v1 = rules.validate(s);
assert.equal(v1.ok, true, JSON.stringify(v1.errors));
assert.equal(rules.canApply(s), true);
ok("reducers build a valid Global hero (4 slots, 32 points spent)");

// a drawback adds a point, an extra source and talent cost one each
assert.equal(rules.budget(state.addDrawback(s, { name: "Test Drawback" })), 33);
assert.equal(rules.budget(state.addExtraTalent(state.addSource(s, { name: "Second Source" }), { name: "Test Talent X" })), 30);
// a third level on a Global hero is illegal; a power's book max level is fed by OUR catalogue through setPowerMaxLevels
assert.ok(rules.validate(state.setPowerLevel(s, "p1", 2)).errors.some((i) => i.code === "power.level.massive"));
rules.setPowerMaxLevels([["Test Power A", 0]]);
assert.equal(rules.powerMaxLevel({ name: "test  power a" }), 0);
assert.ok(rules.validate(s).errors.some((i) => i.code === "power.level.none" && i.path === "powers.0"));
rules.setPowerMaxLevels([]);
assert.equal(rules.validate(s).ok, true);
// removing a 2-slot power frees 4 points: they must be spent (decision 1: leftover is an error); one more power overspends
assert.ok(rules.validateStep(state.removePower(s, "p1"), "attributes").errors.some((i) => i.code === "attr.unspent" && i.params.left === 4));
assert.ok(rules.validateStep(state.addPower(s, { name: "Test Power D" }), "attributes").errors.some((i) => i.code === "attr.over" && i.params.over === 2));
ok("budget deltas, level cap, setPowerMaxLevels is this copy's own module state");

// serialize / deserialize round trip; untrusted input rejected
assert.deepEqual(state.deserialize(state.serialize(s)), JSON.parse(state.serialize(s)));
assert.throws(() => state.deserialize(JSON.stringify({ ...s, rank: "__proto__" })), /unknown rank/);
assert.throws(() => state.deserialize(JSON.stringify({ ...s, v: 2 })), /unsupported state version/);
assert.throws(() => state.deserialize(JSON.stringify({ ...s, powers: "x" })), /bad list/);
let h = state.createHistory(empty); h = state.pushHistory(h, s);
assert.equal(state.undo(h).present, empty); assert.equal(state.redo(state.undo(h)).present, s);
ok("serialize/deserialize round trip, hostile drafts rejected, history undo/redo");

console.log(`vendor/chargen load: ${n} checks passed`);
