// T5: Invincible validation layer + proposal tools (spec 7, 7.4, 7.5, 10.3, 12.1). Node, no Foundry, no network.
// Fixtures: dev/fixtures/invincible-sheets.mjs + a few extra rows defined here. ALL names and texts are invented placeholders
// (no rulebook text). The writer's plan (T6) is a FAKE here.
// Run: node dev/test-build-validate-invincible.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCatalog } from "../scripts/systems/invincible/catalog.mjs";
import * as rules from "../scripts/systems/invincible/vendor/chargen/rules.mjs";
import {
  PROPOSAL_SCHEMA, checkShape, normalize, customItemData, FORBIDDEN_ITEM_KEYS, project, replaceToOps, selectOps, dependants,
  expectFor, checkStale, toPlainActor, gearPatch, textToHtml
} from "../scripts/systems/invincible/proposal.mjs";
import {
  validateProposal, validateGroup, proposalToolDefs, MESSAGES, describe, STRUCTURAL, superheroIssues, stateOf
} from "../scripts/systems/invincible/validate.mjs";
import { validatePack } from "../scripts/build/registry.mjs";
import { CATALOG_ROWS, makeLookup, typicalHero, bigNpc, actor as mkActor, fromCatalog, item, idGen } from "./fixtures/invincible-sheets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------------------------------------------------------------- vendored rules must be in sync first (spec 12.1) */
execFileSync(process.execPath, [join(ROOT, "scripts/systems/invincible/vendor/chargen/sync.mjs"), "--check"], { stdio: "pipe" });

/* ---------------------------------------------------------------- invented catalogue source over the fixture rows */
const TYPE = { "power-sources": "powerSource", powers: "power", boosts: "boost", limits: "limit", talents: "talent", drawbacks: "drawback" };
const LEVEL_LABELS = { "Glide Wings": ["Major", "Massive"], "Spark Bolt": ["Major"], "Mind Static": ["Major", "Massive", "Monstrous"] };
function rows() {
  const r = clone(CATALOG_ROWS);
  r.drawbacks.push({ _id: "drwGrimDebt00000", name: "Grim Debt", system: { description: "<p>Invented placeholder drawback.</p>" } });
  r.drawbacks.push({ _id: "drwBoundSrc00000", name: "Bound Source", system: { description: "<p>Tie it to a power source (choose one) placeholder.</p>" } });
  for (const p of r.powers) for (const w of LEVEL_LABELS[p.name] ?? []) p.system.description += `<p>${w}: invented placeholder.</p>`;
  return r;
}
function fixtureSource(R) {
  const packs = {};
  for (const [pack, list] of Object.entries(R)) {
    const names = [...new Set(list.map((x) => x.folder).filter(Boolean))];
    packs[pack] = {
      folders: names.map((n) => ({ id: `f_${n}`, name: n, parent: null })),
      docs: list.map((x) => ({ ...clone(x), type: x.type ?? TYPE[pack], folder: x.folder ? `f_${x.folder}` : null, effects: [] }))
    };
  }
  return {
    has: (p) => !!packs[p] || p === "core-book",
    index: async (p) => packs[p]?.docs ?? [],
    folders: (p) => packs[p]?.folders ?? [],
    document: async (p, id) => clone(packs[p]?.docs.find((d) => d._id === id) ?? null),
    page: async (j, pid, name) => (name === "Archetypes" ? { name, journal: "x", html: "<h2>Invented Archetype</h2><p>Role: Brawn. Placeholder.</p>" } : null)
  };
}
const catalog = await buildCatalog(fixtureSource(rows()));
const lookup = makeLookup();
const ref = (kind, name, power = null) => { const e = catalog.findByName(kind, name, { power }); assert.ok(e, `no catalogue ${kind} ${name}`); return e.ref; };
const idOf = (a, name, type = null) => { const it = a.items.find((i) => i.name === name && (!type || i.type === type)); assert.ok(it, `no item ${name}`); return it.id; };
const V = (doc, input, o = {}) => validateProposal(doc, input, { catalog, lookup, itemCheck: () => null, ...o });
const ops = (...list) => ({ target: "this", mode: "ops", ops: list, rationale: "invented test" });
const codes = (r, k = "errors") => r[k].map((e) => e.code);
const has = (r, code, k = "errors") => assert.ok(codes(r, k).includes(code), `expected ${code} in ${k}: ${JSON.stringify(r[k].map((e) => [e.code, e.path, e.opId]))}`);

/** a superhero with no sources and nothing else (blank) */
const blankHero = () => mkActor({ id: "blankHero0000001", name: "Blank", attrs: { fighting: 2, agility: 2, strength: 2, reason: 2, intuition: 2, presence: 2 }, items: [] });
/** a small NPC without power sources */
function smallNpc() {
  const nid = idGen(505);
  const pw = fromCatalog(nid, "powers", "Quick Step");
  const t = fromCatalog(nid, "talents", "Quick Wits");
  return mkActor({ id: "smallNpc00000001", name: "Dock Brute", type: "npc", attrs: { fighting: 4, agility: 3, strength: 5, reason: 2, intuition: 3, presence: 2 }, items: [pw, t] });
}

/* ================================================================== baseline + happy path */
await test("typical hero baseline passes creation; a neutral edit is ok with budget before/after", async () => {
  const a = typicalHero();
  const st = stateOf(toPlainActor(a), "global");
  assert.equal(rules.validate(st).ok, true, JSON.stringify(rules.validate(st).errors));
  const r = await V(a, ops({ op: "updateActor", opId: "a1", set: { texts: { drive: "Protect the invented pier" } } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.layer, "L4");
  assert.deepEqual(r.budget.before, r.budget.after);
  assert.equal(r.budget.before.points, 33);
  assert.equal(r.budget.perOp[0].points, 0);
  assert.match(r.summary, /a1: actor drive/);
});

await test("add a power in creation: attr.over with a reconciled suggestion; adopting it passes (self-repair)", async () => {
  const a = typicalHero();
  const src = idOf(a, "Strange Meteor");
  const add = { op: "addItem", opId: "p1", ref: ref("power", "Quick Step"), sourceItemId: src };
  const r1 = await V(a, ops(add));
  assert.equal(r1.ok, false);
  assert.equal(r1.layer, "L2");
  has(r1, "attr.over");
  const e = r1.errors.find((x) => x.code === "attr.over");
  assert.match(e.message, /2 attribute points too many/);
  assert.ok(e.hint && e.suggest?.updateActor?.attributes);
  assert.equal(r1.budget.after.points, 31);
  assert.deepEqual(r1.budget.perOp, [{ opId: "p1", points: -2, slots: 1, spent: 0 }]);
  const sug = e.suggest.updateActor.attributes;
  assert.equal(rules.attrSum(sug), 31);
  const r2 = await V(a, ops(add, { op: "updateActor", opId: "a1", set: { attributes: sug } }));
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(r2.budget.after.spent, 31);
});

await test("per-op cost: talent -1, drawback +1, extra source -1, slot x2", async () => {
  const a = typicalHero();
  const r = await V(a, ops(
    { op: "addItem", opId: "t1", ref: ref("talent", "Steady Hands") },
    { op: "addItem", opId: "d1", ref: ref("drawback", "Haunted") },
    { op: "addItem", opId: "s1", ref: ref("powerSource", "Tinkerer Genius") },
    { op: "addItem", opId: "p1", ref: ref("power", "Quick Step"), sourceOpId: "s1" }
  ));
  const c = Object.fromEntries(r.budget.perOp.map((x) => [x.opId, x.points]));
  assert.deepEqual(c, { t1: -1, d1: 1, s1: -1, p1: -2 });
  has(r, "attr.over");
});

/* ================================================================== L0 */
await test("L0: schema shape, empty ops, duplicate/missing opId, too many ops, rationale on submit", async () => {
  const a = typicalHero();
  has(await V(a, { target: "this" }), "input.shape");
  has(await V(a, { target: "this", mode: "ops", ops: [], evil: 1 }), "input.shape");
  has(await V(a, { target: "this", mode: "ops", ops: [] }), "ops.empty");
  has(await V(a, ops({ op: "removeItem", opId: "x", itemId: "a" }, { op: "removeItem", opId: "x", itemId: "b" })), "opId.duplicate");
  has(await V(a, ops({ op: "removeItem", opId: "", itemId: "a" })), "opId.missing");
  const many = Array.from({ length: 61 }, (_, k) => ({ op: "updateActor", opId: `o${k}`, set: { reputation: 1 } }));
  has(await V(a, ops(...many)), "ops.tooMany");
  const noRat = await V(a, { target: "this", mode: "ops", ops: [{ op: "updateActor", opId: "a1", set: { reputation: 2 } }] }, { requireRationale: true });
  assert.ok(noRat.errors.some((e) => e.code === "input.shape" && e.path === "rationale"));
  // fields of other op kinds are rejected
  has(await V(a, ops({ op: "removeItem", opId: "r", itemId: idOf(a, "Quick Wits"), set: { note: "x" } })), "input.shape");
  // ref + custom together
  has(await V(a, ops({ op: "addItem", opId: "g", ref: ref("gear", "Grapple Line"), custom: { type: "gear", name: "X" } })), "input.shape");
  const r = await V(a, { target: "this", mode: "ops", ops: [{ op: "addItem", opId: "a", ref: 5 }] });
  assert.equal(r.layer, "L0");
});

await test("L0: mode / target support (item doc needs replace+item; actor replace with item; minions unsupported)", async () => {
  const gear = { documentName: "Item", type: "gear", name: "Loose Gear", uuid: "Item.g1", _source: { _id: "g1", name: "Loose Gear", type: "gear", system: { cost: 1 } } };
  has(await V(gear, ops({ op: "updateActor", opId: "a", set: { reputation: 1 } })), "mode.unsupported");
  has(await V(typicalHero(), { target: "this", mode: "replace", proposal: { item: { type: "gear", name: "x" } } }), "mode.unsupported");
  const minion = mkActor({ id: "minion0000000001", name: "Gang", type: "minions", attrs: { fighting: 1, agility: 1, strength: 1, reason: 1, intuition: 1, presence: 1 } });
  has(await V(minion, ops({ op: "updateActor", opId: "a", set: { reputation: 1 } })), "target.unsupported");
});

await test("L0 autoFixed: whitespace trimmed, duplicate personality words collapsed (then personality.count)", async () => {
  const a = typicalHero();
  const r = await V(a, ops({ op: "updateActor", opId: "a1", set: { texts: { personality: "  Restless, restless " } } }));
  assert.ok(r.autoFixed.some((x) => /whitespace/.test(x)));
  assert.ok(r.autoFixed.some((x) => /personality "Restless, restless" -> "Restless"/.test(x)), JSON.stringify(r.autoFixed));
  has(r, "personality.count");
  assert.equal(r.errors.find((e) => e.code === "personality.count").opId, "a1");
});

await test("local schema check mirrors the tool schema (strict: additionalProperties false everywhere)", () => {
  const walk = (s, p = "") => {
    if (s.type === "object") { assert.equal(s.additionalProperties, false, `${p} additionalProperties`); assert.ok(Array.isArray(s.required), `${p} required`); for (const [k, v] of Object.entries(s.properties)) walk(v, `${p}.${k}`); }
    if (s.type === "array") walk(s.items, `${p}[]`);
    for (const bad of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "$ref", "oneOf"]) assert.equal(s[bad], undefined, `${p} uses ${bad}`);
  };
  walk(PROPOSAL_SCHEMA);
  assert.deepEqual(checkShape({ target: "this", mode: "ops", ops: [{ op: "addItem", opId: "a", ref: "x" }] }, PROPOSAL_SCHEMA), []);
  assert.ok(checkShape({ target: "this", mode: "ops", ops: [{ op: "addItem", opId: "a", junk: 1 }] }, PROPOSAL_SCHEMA).some((x) => x.path === "ops[0].junk"));
  const defs = proposalToolDefs();
  assert.deepEqual(defs.map((d) => d.name), ["check_proposal", "submit_proposal"]);
  for (const d of defs) { assert.equal(d.strict, true); assert.equal(d.input_schema, PROPOSAL_SCHEMA); }
  assert.ok(JSON.stringify(defs).length < 16000, `tool defs size ${JSON.stringify(defs).length}`);
  assert.match(defs[1].description, /removeItem {itemId, cascade}/);
});

/* ================================================================== L1 */
await test("L1: ref.unknown, ref.kind, ref.level.none, ref.level.conflict, ref.power.mismatch", async () => {
  const a = typicalHero();
  const src = idOf(a, "Strange Meteor");
  has(await V(a, ops({ op: "addItem", opId: "x", ref: "powers:doesNotExist0001", sourceItemId: src })), "ref.unknown");
  has(await V(a, ops({ op: "addItem", opId: "x", ref: ref("archetype", "Invented Archetype") })), "ref.kind");
  has(await V(a, ops({ op: "addItem", opId: "x", ref: ref("power", "Echo Sense"), level: "major", sourceItemId: src })), "ref.level.none");
  const iron = catalog.findByName("power", "Iron Hide");
  const majorRef = `powers:${iron.levelDocs.major}`;
  has(await V(a, ops({ op: "addItem", opId: "x", ref: majorRef, level: "basic", sourceItemId: src })), "ref.level.conflict");
  const r = await V(a, ops({ op: "addItem", opId: "x", ref: ref("boost", "Silent Flight"), powerItemId: idOf(a, "Spark Bolt") }));
  has(r, "ref.power.mismatch");
  assert.equal(r.layer, "L1");
  assert.ok(r.budget.before && !r.budget.after);
  // updateItem re-point obeys the folder rule too
  has(await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Silent Flight"), set: { powerItemId: idOf(a, "Spark Bolt") } })), "ref.power.mismatch");
  // a split-level ref alone gives its level
  const ok = await V(blankHero(), ops({ op: "addItem", opId: "s", ref: ref("powerSource", "Strange Meteor") }, { op: "addItem", opId: "x", ref: majorRef, sourceOpId: "s" }));
  assert.equal(ok.opInfo.x.name, "Iron Hide");
  assert.equal(project(blankHero(), ok.ops, { catalog }).actor.items.find((i) => i._id === "new:x").system.level, "major");
});

await test("L1: links (source/power missing, opId unknown/kind), item.missing, item.removed", async () => {
  const a = typicalHero();
  has(await V(a, ops({ op: "addItem", opId: "x", ref: ref("power", "Quick Step") })), "link.source.missing");
  has(await V(a, ops({ op: "addItem", opId: "x", ref: ref("boost", "Silent Flight") })), "link.power.missing");
  has(await V(a, ops({ op: "addItem", opId: "x", ref: ref("power", "Quick Step"), sourceOpId: "nope" })), "link.opId.unknown");
  has(await V(a, ops({ op: "addItem", opId: "t", ref: ref("talent", "Steady Hands") }, { op: "addItem", opId: "x", ref: ref("power", "Quick Step"), sourceOpId: "t" })), "link.opId.kind");
  has(await V(a, ops({ op: "addItem", opId: "x", ref: ref("power", "Quick Step"), sourceItemId: idOf(a, "Quick Wits") })), "link.opId.kind");
  has(await V(a, ops({ op: "removeItem", opId: "r", itemId: "notOnThisSheet01" })), "item.missing");
  const q = idOf(a, "Quick Wits");
  has(await V(a, ops({ op: "removeItem", opId: "r1", itemId: q }, { op: "updateItem", opId: "u1", itemId: q, set: { note: "x" } })), "item.removed");
});

await test("L1: field whitelist (field.forbidden / field.value) for items and the actor", async () => {
  const a = typicalHero();
  has(await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Quick Wits"), set: { level: "major" } })), "field.forbidden");
  has(await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Spark Bolt"), set: { name: "Renamed" } })), "field.forbidden");
  // derived max values / flags are not even in the schema: refused at L0
  has(await V(a, ops({ op: "updateActor", opId: "u", set: { "system.derived.health.max": 30 } })), "input.shape");
  has(await V(a, ops({ op: "updateActor", opId: "u", set: { "flags.other.x": 1 } })), "input.shape");
  // ... and refused by the projection whitelist too when a caller bypasses the schema (GM-side / writer use)
  assert.deepEqual(project(a, [{ op: "updateActor", opId: "u", set: { "system.derived.health.max": 30, "flags.x": 1, img: "a.webp" } }], { catalog }).errors.map((e) => e.code), ["field.forbidden", "field.forbidden", "field.forbidden"]);
  has(await V(a, ops({ op: "updateActor", opId: "u", set: { resources: -1 } })), "field.value");
  has(await V(a, ops({ op: "updateActor", opId: "u", set: { name: "" } })), "field.value");
  has(await V(a, ops({ op: "updateActor", opId: "u", set: { texts: { appearance: "x".repeat(2001) } } })), "field.value");
});

await test("removeItem: dependants need cascade or re-pointing; cascade removes them (listed)", async () => {
  const a = typicalHero();
  const wings = idOf(a, "Glide Wings");
  const r1 = await V(a, ops({ op: "removeItem", opId: "r", itemId: wings }));
  has(r1, "remove.dependants");
  assert.equal(r1.errors[0].opId, "r");
  assert.match(r1.errors[0].message, /Silent Flight/);
  const r2 = await V(a, ops({ op: "removeItem", opId: "r", itemId: wings, cascade: true }));
  assert.deepEqual(r2.opInfo.r.cascade.map((c) => c.name), ["Silent Flight"]);
  has(r2, "attr.unspent");   // creation: points freed must be spent
  // source with cascade: all powers + their boosts/limits
  const r3 = await V(a, ops({ op: "removeItem", opId: "r", itemId: idOf(a, "Strange Meteor"), cascade: true }));
  assert.deepEqual(r3.opInfo.r.cascade.map((c) => c.name).sort(), ["Echo Sense", "Glide Wings", "Needs Charging", "Silent Flight", "Spark Bolt"]);
  // re-point in the same list: no cascade needed (move Echo Sense to a new source, remove nothing else)
  const r4 = await V(a, ops(
    { op: "addItem", opId: "s2", ref: ref("powerSource", "Tinkerer Genius") },
    { op: "updateItem", opId: "u1", itemId: idOf(a, "Glide Wings"), set: { powerSourceOpId: "s2" } },
    { op: "updateItem", opId: "u2", itemId: idOf(a, "Spark Bolt"), set: { powerSourceOpId: "s2" } },
    { op: "updateItem", opId: "u3", itemId: idOf(a, "Echo Sense"), set: { powerSourceOpId: "s2" } },
    { op: "removeItem", opId: "r", itemId: idOf(a, "Strange Meteor") }
  ));
  assert.ok(!codes(r4).includes("remove.dependants"), JSON.stringify(r4.errors));
  assert.equal(r4.ok, true, JSON.stringify(r4.errors));
});

/* ================================================================== L2 superhero rules */
await test("L2: level rules (massive at global, monstrous, level.none from the vendored max), limit grants, duplicates, drawbacks.max", async () => {
  const a = typicalHero();
  const src = idOf(a, "Strange Meteor");
  has(await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Glide Wings"), set: { level: "massive" } })), "power.level.massive");
  const cosmic = await V(a, ops({ op: "addItem", opId: "m", ref: ref("power", "Mind Static"), level: "monstrous", sourceItemId: src }), { rank: "cosmic" });
  has(cosmic, "power.level.monstrous");
  has(await V(a, ops({ op: "addItem", opId: "l", ref: ref("limit", "Needs Charging"), powerItemId: idOf(a, "Spark Bolt") })), "limit.grant.invalid");
  has(await V(a, ops({ op: "addItem", opId: "t", ref: ref("talent", "Quick Wits") })), "talent.duplicate");
  has(await V(a, ops({ op: "addItem", opId: "d", ref: ref("drawback", "Lean Times") })), "drawback.duplicate");
  has(await V(a, ops({ op: "addItem", opId: "d1", ref: ref("drawback", "Haunted") }, { op: "addItem", opId: "d2", ref: ref("drawback", "Grim Debt") })), "drawbacks.max");
  has(await V(a, ops({ op: "addItem", opId: "p", ref: ref("power", "Spark Bolt"), sourceItemId: src })), "power.duplicate");
  // power.level.none straight from the vendored rules (fed by the catalogue) when an existing item is above its max
  const nid = idGen(9);
  const s = fromCatalog(nid, "power-sources", "Strange Meteor");
  const bad = mkActor({ id: "badLevel00000001", name: "Bad", attrs: { fighting: 5, agility: 5, strength: 5, reason: 5, intuition: 5, presence: 5 }, items: [s, fromCatalog(nid, "powers", "Echo Sense", { level: "major", system: { powerSource: s.id } })] });
  assert.ok(superheroIssues(toPlainActor(bad), "global", catalog).issues.some((i) => i.code === "power.level.none"));
});

await test("L2: blame by opId and the error format the model gets (code, path, opId, message, hint)", async () => {
  const a = typicalHero();
  const r = await V(a, ops({ op: "updateItem", opId: "lvl", itemId: idOf(a, "Glide Wings"), set: { level: "massive" } }));
  const e = r.errors.find((x) => x.code === "power.level.massive");
  assert.equal(e.opId, "lvl");
  for (const k of ["code", "message", "hint"]) assert.equal(typeof e[k], "string");
  assert.match(e.message, /Glide Wings/);
});

await test("profiles: in-play tolerates baseline errors, turns budget into info, still blocks NEW errors", async () => {
  // a hero that already fails creation (personality one word + Massive at global)
  const a = typicalHero();
  a._source.system.personality = "Restless";
  a._source.items.find((i) => i.name === "Glide Wings").system.level = "massive";
  const add = { op: "addItem", opId: "p1", ref: ref("power", "Quick Step"), sourceItemId: idOf(a, "Strange Meteor") };
  const cr = await V(a, ops(add), { profile: "creation" });
  assert.equal(cr.ok, false);
  has(cr, "personality.count"); has(cr, "power.level.massive"); has(cr, "attr.over");
  has(cr, "profile.suggestInPlay", "info");
  const ip = await V(a, ops(add), { profile: "in-play" });
  assert.equal(ip.ok, true, JSON.stringify(ip.errors));
  has(ip, "baseline.tolerated", "info");
  has(ip, "budget.delta", "info");
  assert.match(ip.info.find((x) => x.code === "budget.delta").message, /costs 2 attribute point/);
  assert.equal(ip.profile, "in-play");
  // a NEW structural error still blocks in-play
  const ip2 = await V(a, ops(add, { op: "updateItem", opId: "u", itemId: idOf(a, "Spark Bolt"), set: { level: "major" } }, { op: "addItem", opId: "l", ref: ref("limit", "Needs Charging"), powerItemId: idOf(a, "Spark Bolt") }), { profile: "in-play" });
  has(ip2, "limit.grant.invalid");
  // a new non-budget error blocks too
  has(await V(a, ops({ op: "updateActor", opId: "a", set: { texts: { drive: "" } } }), { profile: "in-play" }), "drive.empty");
});

await test("split-level power: level change reported as a level-document swap (same item, boosts stay linked)", async () => {
  const nid = idGen(31);
  const s = fromCatalog(nid, "power-sources", "Strange Meteor");
  const iron = fromCatalog(nid, "powers", "Iron Hide", { level: "basic", system: { powerSource: s.id } });
  const a = mkActor({ id: "splitHero0000001", name: "Plate", attrs: { fighting: 6, agility: 6, strength: 6, reason: 5, intuition: 5, presence: 5 }, items: [s, iron] });
  const r = await V(a, ops({ op: "updateItem", opId: "u", itemId: iron.id, set: { level: "major" } }), { profile: "in-play" });
  const sw = r.opInfo.u.splitSwap;
  const e = catalog.findByName("power", "Iron Hide");
  assert.deepEqual(sw, { from: "basic", to: "major", fromRef: `powers:${e.levelDocs.basic}`, toRef: `powers:${e.levelDocs.major}` });
  assert.equal(r.budget.perOp[0].slots, 1);
});

/* ================================================================== NPC (spec 7.4) */
await test("NPC: structure only (attr.range, power.level.none, talent.duplicate, sources optional), threat is info", async () => {
  const n = smallNpc();
  const ok = await V(n, ops({ op: "addItem", opId: "p", ref: ref("power", "Mind Static"), level: "massive" }, { op: "updateActor", opId: "a", set: { attributes: { strength: 11 } } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.budget.kind, "npc");
  assert.ok(ok.info.filter((x) => x.code === "npc.threat").length >= 2);
  has(await V(n, ops({ op: "updateActor", opId: "a", set: { attributes: { strength: 13 } } })), "attr.range");
  has(await V(n, ops({ op: "addItem", opId: "t", ref: ref("talent", "Quick Wits") })), "talent.duplicate");
  has(await V(n, ops({ op: "addItem", opId: "p", ref: ref("power", "Echo Sense"), level: "major" })), "ref.level.none");
  // existing item above its level (hand-made sheet): power.level.none from the NPC rules
  n._source.items.find((i) => i.name === "Quick Step").system.level = "major";
  has(await V(n, ops({ op: "updateActor", opId: "a", set: { reputation: 1 } })), "power.level.none");
  // an NPC WITH sources must still link new powers
  has(await V(bigNpc(), ops({ op: "addItem", opId: "p", ref: ref("power", "Glide Wings") })), "link.source.missing");
  // drawback note (catalogue says it needs a source)
  const w = await V(smallNpc(), ops({ op: "addItem", opId: "d", ref: ref("drawback", "Bound Source") }));
  has(w, "drawback.note.missing", "warnings");
  const w2 = await V(smallNpc(), ops({ op: "addItem", opId: "d", ref: ref("drawback", "Bound Source"), note: "the meteor" }));
  assert.ok(!codes(w2, "warnings").includes("drawback.note.missing"));
  assert.equal(w2.opInfo.d.name, "Bound Source (the meteor)");
});

/* ================================================================== items / gear whitelist (spec 10.3) */
await test("gear whitelist: customItemData keeps only name/description/numbers/one rollAttack; strips forbidden fields", () => {
  const evil = {
    type: "gear", name: "Web Shooter", description: "Shoots <b>webs</b> @UUID[Actor.x]{pwn}", cost: 2, restricted: false, singleUse: false,
    attack: { damage: 2, bonus: 1, minRange: 0, maxRange: 3, extraConfiguration: "alert(1)", conditionToApply: "Compendium.x.y.Item.z" },
    img: "evil.webp", flags: { x: 1 }, effects: [{ changes: [] }], extraConfiguration: "alert(2)", automations: { a: { type: "runMacro" } }, postExecution: "Macro.x"
  };
  const { data, stripped } = customItemData(evil, { seed: "t" });
  const json = JSON.stringify(data);
  for (const k of FORBIDDEN_ITEM_KEYS.filter((x) => x !== "_id")) assert.ok(!json.includes(`"${k}"`), `${k} leaked`);
  assert.equal(data._id, undefined);
  assert.deepEqual(Object.keys(data).sort(), ["name", "system", "type"]);
  assert.ok(!json.includes("runMacro") && !json.includes("alert(") && !json.includes("evil.webp") && !json.includes("<b>"));
  assert.deepEqual(stripped, ["attack.conditionToApply", "attack.extraConfiguration", "automations", "effects", "extraConfiguration", "flags", "img", "postExecution"]);
  const autos = Object.values(data.system.automations);
  assert.equal(autos.length, 1);
  assert.equal(autos[0].type, "rollAttack");
  assert.deepEqual([autos[0].baseDamage, autos[0].rollBonus, autos[0].maxRange, autos[0].attribute[0]], [2, 1, 3, "agility"]);
  assert.equal(data.system.description, "<p>Shoots &lt;b&gt;webs&lt;/b&gt; @UUID[Actor.x]{pwn}</p>");
  assert.equal(textToHtml("a\n\nb"), "<p>a</p><p>b</p>");
  // patch on an existing gear item touches numbers only
  const p = gearPatch({ cost: 3, attack: { damage: 4 } }, { type: "gear", system: { automations: { k1: { type: "rollAttack", baseDamage: 2, extraConfiguration: "x()" } } } });
  assert.deepEqual(p, { cost: 3, "automations.k1": { baseDamage: 4 } });
});

await test("items: replace on a gear document; gear.range, gear.minmax, item.data.invalid, ref.unknown baseRef, newItem target", async () => {
  const gear = { documentName: "Item", type: "gear", name: "Loose Gear", uuid: "Item.g1", _source: { _id: "g1", name: "Loose Gear", type: "gear", system: { cost: 1 } } };
  const rep = (item, o) => V(gear, { target: "this", mode: "replace", proposal: { item }, rationale: "x" }, o);
  const ok = await rep({ type: "gear", name: "Web Shooter", description: "Invented.", cost: 2, attack: { damage: 2, maxRange: 3 } });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.budget.kind, "item");
  assert.equal(ok.itemData.type, "gear");
  has(await rep({ type: "gear", name: "X", cost: -1 }), "gear.range");
  has(await rep({ type: "gear", name: "X", attack: { damage: 1, minRange: 4, maxRange: 2 } }), "gear.minmax");
  has(await rep({ type: "gear", name: "X", attack: { damage: 1, bonus: 99 } }), "gear.range");
  has(await rep({ type: "gear", name: "X" }, { itemCheck: () => "cost: invalid" }), "item.data.invalid");
  has(await rep({ type: "vehicleWeapon", name: "X" }), "field.value");
  const nw = await V(typicalHero(), { target: "newItem", mode: "replace", proposal: { item: { type: "vehicleWeapon", name: "Hull Gun", cost: 3, restricted: true } }, rationale: "x" });
  assert.equal(nw.ok, true, JSON.stringify(nw.errors));
  // baseRef only on the item path schema? (custom schema has no baseRef: input.shape)
  has(await rep({ type: "gear", name: "X", baseRef: "gears:nope" }), "input.shape");
  // custom gear on an actor through addItem; custom on another type is impossible by schema
  const a = typicalHero();
  const add = await V(a, ops({ op: "addItem", opId: "g", custom: { type: "gear", name: "Web Shooter", cost: 2, attack: { damage: 2, maxRange: 2 } } }));
  assert.equal(add.ok, true, JSON.stringify(add.errors));
  has(await V(a, ops({ op: "addItem", opId: "g", custom: { type: "power", name: "Homebrew" } })), "input.shape");
  has(await V(a, ops({ op: "addItem", opId: "g", custom: { type: "gear", name: "X", cost: -2 } })), "gear.range");
  has(await V(a, ops({ op: "addItem", opId: "g", custom: { type: "gear", name: "X" } }), { itemCheck: () => "bad" }), "item.data.invalid");
  // gear edits: rename + append + numbers on a catalogue gear item
  const line = idOf(a, "Grapple Line");
  const ge = await V(a, ops({ op: "updateItem", opId: "u", itemId: line, set: { name: "Grapple Line Mk2", descriptionAppend: "Invented note.", gear: { cost: 2 } } }));
  assert.equal(ge.ok, true, JSON.stringify(ge.errors));
  assert.deepEqual(ge.opInfo.u.changed.map((c) => c.field), ["name", "description", "cost"]);
  has(await V(a, ops({ op: "updateItem", opId: "u", itemId: line, set: { gear: { attack: { damage: 1, minRange: 3, maxRange: 1 } } } })), "gear.minmax");
});

/* ================================================================== L3: stale + plan dry run */
await test("stale check: item changed / removed / actor field changed since the preview -> whole apply refused", async () => {
  const a = typicalHero();
  const q = idOf(a, "Quick Wits"), s = idOf(a, "Pocket Camera");
  const input = ops({ op: "updateItem", opId: "u", itemId: q, set: { note: "x" } }, { op: "removeItem", opId: "r", itemId: s }, { op: "updateActor", opId: "a", set: { texts: { drive: "Invented drive" } } });
  const prev = await V(a, input, { profile: "in-play" });
  assert.deepEqual(Object.keys(prev.expect.items).sort(), [q, s].sort());
  assert.deepEqual(Object.keys(prev.expect.actor), ["system.drive"]);
  assert.deepEqual(checkStale(a, prev.ops, prev.expect), []);
  const fresh = await V(a, input, { profile: "in-play", expect: prev.expect });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.errors));
  a._source.items.find((i) => i._id === q).system.description += "<p>edited elsewhere</p>";
  a._source.system.drive = "Changed elsewhere";
  const stale = await V(a, input, { profile: "in-play", expect: prev.expect });
  assert.equal(stale.ok, false);
  assert.equal(stale.layer, "L3");
  has(stale, "stale.item"); has(stale, "stale.actor");
  assert.equal(stale.errors.find((e) => e.code === "stale.item").opId, "u");
  a._source.items = a._source.items.filter((i) => i._id !== s);
  assert.ok(checkStale(a, prev.ops, prev.expect).some((x) => x.itemId === s && x.reason === "missing"));
  // cascade dependants are fingerprinted too
  const b = typicalHero();
  const c = await V(b, ops({ op: "removeItem", opId: "r", itemId: idOf(b, "Glide Wings"), cascade: true }), { profile: "in-play" });
  assert.ok(Object.keys(c.expect.items).includes(idOf(b, "Silent Flight")));
});

await test("plan dry run (fake T6): errors/warnings joined, throw -> plan.failed, recursion guarded, skipPlan honoured", async () => {
  const a = typicalHero();
  const input = ops({ op: "updateActor", opId: "a1", set: { texts: { drive: "Invented" } } });
  let seen = null;
  const fake = async (doc, prop, o) => { seen = { prop, o }; return { fields: [], creates: [], deletes: [], keeps: [], counts: {}, destructive: false, errors: [], warnings: [{ code: "plan.note", message: "Fake plan warning.", hint: "-" }] }; };
  const r = await V(a, input, { plan: fake });
  assert.equal(r.ok, true);
  assert.equal(seen.prop.mode, "ops");
  assert.equal(seen.o.dryRun, true);
  assert.ok(r.warnings.some((w) => w.code === "plan.note" && w.message === "Fake plan warning."));
  has(await V(a, input, { plan: async () => ({ errors: [{ code: "plan.locked", message: "Actor is locked by another write.", opId: "a1" }] }) }), "plan.locked");
  const failed = await V(a, input, { plan: async () => { throw new Error("boom"); } });
  has(failed, "plan.failed");
  assert.equal(failed.layer, "L3");
  let calls = 0;
  const recursive = async (doc, prop) => { calls++; const inner = await V(doc, { ...prop, rationale: "x" }, { plan: recursive }); return { errors: inner.errors, warnings: [] }; };
  assert.equal((await V(a, input, { plan: recursive })).ok, true);
  assert.equal(calls, 1);
  calls = 0;
  await V(a, input, { plan: recursive, skipPlan: true });
  assert.equal(calls, 0);
});

/* ================================================================== L4 */
await test("L4 warnings: removing custom / hand-edited items, sensitive fields, limit grant heuristic, rank.differs", async () => {
  const a = typicalHero();
  const r = await V(a, ops({ op: "removeItem", opId: "r1", itemId: idOf(a, "Pocket Camera") }, { op: "removeItem", opId: "r2", itemId: idOf(a, "Grapple Line") }, { op: "removeItem", opId: "r3", itemId: idOf(a, "Stun Baton") }));
  const w = r.warnings.filter((x) => x.code === "remove.handEdited");
  assert.deepEqual(w.map((x) => x.opId).sort(), ["r1", "r2"]);
  assert.match(w.find((x) => x.opId === "r1").message, /custom item "Pocket Camera"/);
  const s = await V(a, ops({ op: "updateActor", opId: "k", set: { karma: 2, health: 3 } }));
  assert.equal(s.ok, true);
  assert.equal(s.warnings.filter((x) => x.code === "field.sensitive").length, 2);
  const g = await V(a, ops({ op: "addItem", opId: "l", ref: ref("limit", "Loud"), powerItemId: idOf(a, "Glide Wings"), grants: "level" }), { profile: "in-play" });
  has(g, "grants.heuristic", "warnings");
  const rp = await V(blankHero(), { target: "this", mode: "replace", proposal: { rank: "cosmic", name: "Blank" }, rationale: "x" }, { rank: "global", profile: "in-play" });
  has(rp, "rank.differs", "warnings");
});

/* ================================================================== replace -> ops */
await test("replace: same build keeps every id (no ops); a rebuild on a blank actor validates as a full hero", async () => {
  const a = typicalHero();
  const P = {
    rank: "global", name: "Amber Kestrel",
    sources: [{ key: "s1", ref: ref("powerSource", "Strange Meteor") }],
    powers: [
      { ref: ref("power", "Glide Wings"), level: "basic", source: "s1", boosts: [{ ref: ref("boost", "Silent Flight", "Glide Wings") }] },
      { ref: ref("power", "Spark Bolt"), level: "major", source: "s1", limits: [{ ref: ref("limit", "Needs Charging", "Spark Bolt"), grants: "level" }] },
      { ref: ref("power", "Echo Sense"), source: "s1" }
    ],
    talents: [{ ref: ref("talent", "Quick Wits") }, { ref: ref("talent", "Streetwise") }],
    drawbacks: [{ ref: ref("drawback", "Lean Times") }]
  };
  const conv = replaceToOps(a, P, { catalog });
  assert.deepEqual(conv, { ops: [], errors: [] });
  // swap a talent: one remove + one add, every other item kept
  const P2 = { ...P, talents: [{ ref: ref("talent", "Quick Wits") }, { ref: ref("talent", "Steady Hands") }] };
  const c2 = replaceToOps(a, P2, { catalog });
  assert.deepEqual(c2.ops.map((o) => o.op).sort(), ["addItem", "removeItem"]);
  assert.equal(c2.ops.find((o) => o.op === "removeItem").itemId, idOf(a, "Streetwise"));
  // full build on a blank actor
  const full = {
    ...P, name: "Fresh Kestrel", attributes: { fighting: 6, agility: 7, strength: 5, reason: 5, intuition: 5, presence: 5 }, resources: 3,
    texts: { civilianName: "Invented Name", role: "Wildcard", occupation: "Courier", personality: "Restless, Loyal", drive: "Invented drive", flaw: "Invented flaw", team: "Invented team" }
  };
  const r = await V(blankHero(), { target: "this", mode: "replace", proposal: full, rationale: "x" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.budget.after.points, 33);
  assert.equal(r.ops.filter((o) => o.op === "addItem").length, 9);
  // a bad ref in the replace proposal is an L1 error with a proposal path
  const bad = await V(blankHero(), { target: "this", mode: "replace", proposal: { ...full, powers: [{ ref: "powers:nope0000000000000", source: "s1" }] }, rationale: "x" });
  assert.ok(bad.errors.some((e) => e.code === "ref.unknown" && e.path === "proposal.powers[0].ref"));
});

/* ================================================================== GM deselection */
await test("deselect: dependants unticked together, remaining set re-projected and re-validated", async () => {
  const a = typicalHero();
  const list = [
    { op: "addItem", opId: "s2", ref: ref("powerSource", "Tinkerer Genius") },
    { op: "addItem", opId: "p1", ref: ref("power", "Glide Wings"), sourceOpId: "s2" },
    { op: "addItem", opId: "b1", ref: ref("boost", "Silent Flight", "Glide Wings"), powerOpId: "p1" },
    { op: "updateActor", opId: "a1", set: { texts: { drive: "Invented" } } }
  ];
  assert.deepEqual([...dependants(list, ["s2"])].sort(), ["b1", "p1"]);
  const sel = selectOps(list, ["s2"]);
  assert.deepEqual(sel.ops.map((o) => o.opId), ["a1"]);
  assert.deepEqual(sel.withThem.map((x) => x.opId).sort(), ["b1", "p1"]);
  const full = await V(a, ops(...list), { profile: "in-play" });
  has(full, "power.duplicate");
  const r = await V(a, ops(...list), { profile: "in-play", deselect: ["s2"] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.selection.deselected, ["s2"]);
  assert.deepEqual(r.ops.map((o) => o.opId), ["a1"]);
});

/* ================================================================== tools through the pack interface */
await test("pack interface: validate group passes the registry contract; tools join the prompt group", async () => {
  const pack = (await import("../scripts/systems/invincible/pack.mjs")).default;
  const v = validatePack(pack);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.capabilities.validate, true);
  assert.deepEqual(pack.proposalTools().map((t) => t.name), ["check_proposal", "submit_proposal"]);
  assert.ok(pack.tools().some((t) => t.name === "submit_proposal") && pack.tools().some((t) => t.name === "get_entries"));
});

await test("self-repair loop shape through runProposalTool (what the T2 harness expects)", async () => {
  const fakePlan = async () => ({ errors: [], warnings: [] });
  const g = validateGroup(() => ({ plan: fakePlan }), { catalog, lookup, itemCheck: () => null });
  const a = typicalHero();
  const ctx = { doc: a, options: { rank: "global", profile: "creation" } };
  const add = { op: "addItem", opId: "p1", ref: ref("power", "Quick Step"), sourceItemId: idOf(a, "Strange Meteor") };
  // check_proposal: dry run, never a proposalId
  const chk = await g.runProposalTool("check_proposal", ops(add), ctx);
  assert.equal(chk.ok, false);
  assert.equal(chk.proposalId, undefined);
  // submit 1: invalid -> errors with code/message/hint + budget, JSON-serialisable, no GM-only fields
  const s1 = await g.runProposalTool("submit_proposal", ops(add), ctx);
  assert.equal(s1.ok, false);
  assert.equal(s1.layer, "L2");
  assert.ok(s1.errors.every((e) => e.code && e.message && typeof e.hint === "string"));
  assert.ok(s1.budget.before && s1.budget.after && s1.budget.perOp);
  for (const k of ["expect", "opInfo", "normalized", "ops", "plan"]) assert.equal(s1[k], undefined, k);
  assert.deepEqual(JSON.parse(JSON.stringify(s1)), s1);
  // submit 2: adopt the suggestion -> ok with proposalId, summary, warnings
  const sug = s1.errors.find((e) => e.code === "attr.over").suggest.updateActor;
  const fixed = ops(add, { op: "updateActor", opId: "a1", set: sug });
  const s2 = await g.runProposalTool("submit_proposal", fixed, ctx);
  assert.equal(s2.ok, true, JSON.stringify(s2.errors));
  assert.match(s2.proposalId, /^prop-[0-9a-z]+$/);
  assert.equal(typeof s2.summary, "string");
  assert.ok(Array.isArray(s2.warnings));
  assert.equal((await g.runProposalTool("submit_proposal", fixed, ctx)).proposalId, s2.proposalId, "deterministic id");
  // submit without rationale is refused at L0
  const { rationale, ...noRat } = fixed;
  assert.equal((await g.runProposalTool("submit_proposal", noRat, ctx)).layer, "L0");
  // unknown tool
  assert.equal((await g.runProposalTool("submit_other", fixed, ctx)).ok, false);
  // GM side: validate() returns the GM-only fields
  const full = await g.validate(a, fixed, { rank: "global" });
  assert.ok(full.expect && full.opInfo && full.ops);
});

await test("writer (T6) call shape: { plan: <Plan object>, only, allowVitals } joins the plan, keeps only ticked ops, no vitals warning", async () => {
  const a = typicalHero();
  const list = [
    { op: "addItem", opId: "s2", ref: ref("powerSource", "Tinkerer Genius") },
    { op: "addItem", opId: "p1", ref: ref("power", "Quick Step"), sourceOpId: "s2" },
    { op: "updateActor", opId: "k", set: { karma: 1 } }
  ];
  const planObj = { ok: true, errors: [], warnings: [{ code: "plan.overwrites", message: "Replaces a non-empty text.", opId: "k" }] };
  const r = await V(a, ops(...list), { profile: "in-play", plan: planObj, only: ["p1", "k"], allowVitals: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.ops.map((o) => o.opId), ["k"]);   // p1 needs s2 (unticked) -> unticked with it
  assert.deepEqual(r.selection.withThem, [{ opId: "p1", because: ["s2"] }]);
  assert.ok(r.warnings.some((w) => w.code === "plan.overwrites"));
  assert.ok(!r.warnings.some((w) => w.code === "field.sensitive"));
  has(await V(a, ops(...list), { profile: "in-play", plan: { errors: [{ code: "plan.unsaved", message: "Save the sheet first." }] } }), "plan.unsaved");
});

/* ================================================================== messages cover every code */
await test("every emitted code has an English message + hint; structural set is a subset of known codes", () => {
  const src = ["scripts/systems/invincible/vendor/chargen/rules.mjs", "scripts/systems/invincible/proposal.mjs", "scripts/systems/invincible/validate.mjs"]
    .map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  const found = new Set();
  for (const m of src.matchAll(/issue\("([a-zA-Z.]+)"/g)) found.add(m[1]);
  for (const m of src.matchAll(/code: "([a-zA-Z.]+)"/g)) found.add(m[1]);
  for (const m of src.matchAll(/err\("([a-zA-Z.]+)"/g)) found.add(m[1]);
  found.delete("plan.error"); found.delete("tool.unknown");   // pass-through / router codes carry their own text
  const missing = [...found].filter((c) => !MESSAGES[c]);
  assert.deepEqual(missing, []);
  for (const c of STRUCTURAL) assert.ok(MESSAGES[c], c);
  for (const [code, fn] of Object.entries(MESSAGES)) {
    const t = fn({ name: "X", attr: "fighting", count: 1, max: 2, budget: 3, over: 1, left: 1, cap: 10, level: "major", ref: "r", path: "p", field: "f", expected: "e" }, { rank: "global" });
    assert.ok(t.message && typeof t.hint === "string", code);
  }
  const d = describe({ code: "attr.unspent", path: "attrs", params: { left: 3, budget: 34 } });
  assert.deepEqual(d, { code: "attr.unspent", path: "attrs", message: "3 attribute points are unspent (budget 34).", hint: "Raise attributes by 3 in total, each within 1..cap." });
});

await test("projection never touches the document; normalize never throws on junk", async () => {
  const a = typicalHero();
  const before = JSON.stringify(a._source);
  await V(a, ops({ op: "removeItem", opId: "r", itemId: idOf(a, "Strange Meteor"), cascade: true }, { op: "updateActor", opId: "u", set: { name: "Changed", attributes: { fighting: 9 } } }));
  assert.equal(JSON.stringify(a._source), before);
  for (const junk of [null, 5, "x", [], { mode: "ops", ops: [null, 3] }]) assert.doesNotThrow(() => normalize(junk));
  const r = await V(a, null);
  assert.equal(r.layer, "L0");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
