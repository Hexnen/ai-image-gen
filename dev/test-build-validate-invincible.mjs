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
  assert.deepEqual(r1.budget.perOp, [{ opId: "p1", points: -2, slots: 1, label: "+1 slot (slots 5/4, over the rank) -2 pts" }]);   // W2-5: no spent delta
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

await test("W2-1: split power: main (basic) ref + level is that level, not a conflict (ops, replace, writer agree)", async () => {
  const iron = catalog.findByName("power", "Iron Hide");
  assert.ok(iron.split && iron.levelDocs.basic && iron.levelDocs.major);
  const mainRef = iron.ref;
  assert.equal(mainRef, `powers:${iron.levelDocs.basic}`);
  // ops: basic ref + level major -> a Major Iron Hide
  const srcOp = { op: "addItem", opId: "s", ref: ref("powerSource", "Strange Meteor") };
  const r = await V(blankHero(), ops(srcOp, { op: "addItem", opId: "x", ref: mainRef, level: "major", sourceOpId: "s" }));
  assert.ok(!codes(r).includes("ref.level.conflict"), JSON.stringify(r.errors));
  assert.equal(project(blankHero(), r.ops, { catalog }).actor.items.find((i) => i._id === "new:x").system.level, "major");
  // main ref without level stays basic; the basic level named explicitly too
  for (const extra of [{}, { level: "basic" }]) {
    const b = await V(blankHero(), ops(srcOp, { op: "addItem", opId: "x", ref: mainRef, sourceOpId: "s", ...extra }));
    assert.ok(!codes(b).includes("ref.level.conflict"));
    assert.equal(project(blankHero(), b.ops, { catalog }).actor.items.find((i) => i._id === "new:x").system.level, "basic");
  }
  // the opposite case stays a conflict, and its hint names the main ref
  const c = await V(blankHero(), ops(srcOp, { op: "addItem", opId: "x", ref: `powers:${iron.levelDocs.major}`, level: "basic", sourceOpId: "s" }));
  has(c, "ref.level.conflict");
  assert.match(c.errors.find((e) => e.code === "ref.level.conflict").hint, new RegExp(`main ref "${mainRef}" with level basic`));
  // replace (the dry-run case: two Major powers given as main ref + level) -> no conflict, level major in the ops
  const rp = await V(blankHero(), { target: "this", mode: "replace", rationale: "invented", proposal: {
    sources: [{ key: "s", ref: ref("powerSource", "Strange Meteor") }],
    powers: [{ ref: mainRef, level: "major", source: "s" }]
  } });
  assert.ok(!codes(rp).includes("ref.level.conflict"), JSON.stringify(rp.errors));
  assert.equal(rp.ops.find((o) => o.ref === mainRef).level, "major");
  assert.equal(r.normalized.ops[1].ref, mainRef);   // the writer resolves the same input (writer.mjs resolveRef: asked level wins)
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
  has(g, "grants.heuristic", "info");   // W3-6: info, not a warning (grants never changes the cost)
  assert.ok(!codes(g, "warnings").includes("grants.heuristic"));
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
  assert.deepEqual({ ops: conv.ops, errors: conv.errors, defaulted: conv.defaulted }, { ops: [], errors: [], defaulted: [] });
  assert.deepEqual(conv.src, {});   // no ops; kept items still name their proposal entry (W2-2)
  assert.equal(conv.srcItems[idOf(a, "Quick Wits")].path, "proposal.talents[0]");
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

  // W2-2: projection (L1) and rules (L2) errors of a replace point at the proposal entry, with its name; opIds stay
  const at = (res, code) => res.errors.find((e) => e.code === code) ?? assert.fail(`no ${code}: ${JSON.stringify(res.errors)}`);
  const iron = catalog.findByName("power", "Iron Hide");
  const l1 = await V(blankHero(), { target: "this", mode: "replace", rationale: "x", proposal: { ...full, powers: [
    { ref: ref("power", "Spark Bolt"), source: "s1", boosts: [{ ref: ref("boost", "Silent Flight", "Glide Wings") }] },
    { ref: `powers:${iron.levelDocs.major}`, level: "basic", source: "s1" },
    { ref: ref("power", "Echo Sense"), level: "major", source: "s1" }
  ] } });
  const mm = at(l1, "ref.power.mismatch");
  assert.equal(mm.path, "proposal.powers[0].boosts[0].ref"); assert.equal(mm.entry, "Silent Flight"); assert.ok(mm.opId);
  const lc = at(l1, "ref.level.conflict");
  assert.equal(lc.path, "proposal.powers[1].level"); assert.equal(lc.entry, "Iron Hide");
  assert.equal(at(l1, "ref.level.none").path, "proposal.powers[2].level");
  assert.ok(!JSON.stringify(l1.errors).includes("ops["), "no internal op paths in a replace result");
  // L2: attribute budget -> proposal.attributes; a Massive power at Global -> its entry
  const l2 = await V(blankHero(), { target: "this", mode: "replace", rationale: "x", proposal: { ...full, attributes: { ...full.attributes, fighting: 7 },
    powers: [{ ref: ref("power", "Mind Static"), level: "massive", source: "s1" }, ...full.powers.slice(1)] } });
  assert.equal(at(l2, "attr.over").path, "proposal.attributes");
  const ms = at(l2, "power.level.massive");
  assert.equal(ms.path, "proposal.powers[0]"); assert.equal(ms.entry, "Mind Static");
  // the model-facing tool result carries the same paths
  const tr = await validateGroup(() => null, { catalog, lookup, itemCheck: () => null }).runProposalTool("submit_proposal",
    { target: "this", mode: "replace", rationale: "x", proposal: { ...full, powers: [{ ref: `powers:${iron.levelDocs.major}`, level: "basic", source: "s1" }] } }, { doc: blankHero(), options: { rank: "global" } });
  assert.equal(tr.errors[0].path, "proposal.powers[0].level"); assert.equal(tr.errors[0].entry, "Iron Hide");
  // a leftover the replace removes keeps its sheet path, with the item's name (L4 warning of a hand-made item)
  const th = typicalHero();
  const hand = mkActor({ id: th.id, name: th.name, attrs: Object.fromEntries(Object.entries(th._source.system.attributes).map(([k, v]) => [k, v.value])), system: th._source.system,
    items: [...th.items, item("handMade00000001", "power", "Odd Trinket Power", { powerSource: idOf(th, "Strange Meteor") })] });
  const lw = await V(hand, { target: "this", mode: "replace", rationale: "x", proposal: P }, { profile: "in-play" });
  const rh = lw.warnings.find((w) => w.code === "remove.handEdited") ?? assert.fail(JSON.stringify(lw.warnings.concat(lw.errors)));
  assert.equal(rh.path, "items.handMade00000001"); assert.equal(rh.entry, "Odd Trinket Power");
  // ops mode is unchanged: op paths and opIds
  const om = await V(typicalHero(), ops({ op: "addItem", opId: "x", ref: ref("power", "Echo Sense"), level: "major", sourceItemId: idOf(typicalHero(), "Strange Meteor") }));
  assert.equal(at(om, "ref.level.none").path, "ops[0].level"); assert.equal(at(om, "ref.level.none").entry, undefined);
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

/* ================================================================== fixes 2 (analysis-1 P1-C, P1-D, P1-E, P1-F, P1-G) */
// a catalogue that also has an (invented) occupation page: Courier = Resources 3, talents Quick Wits / Streetwise / Tough Skin
const occSource = () => {
  const s = fixtureSource(rows());
  const occHtml = "<h2>Courier</h2><p>Invented placeholder job.</p><p>Occupation Talent ([[D3]]):</p><p>1. Quick Wits, 2. Streetwise, 3. Tough Skin</p><p>Resources: 3</p><h2>Night Clerk</h2><p>Occupation Talent:</p><p>1. Steady Hands, 2. Tough Skin, 3. Quick Wits</p><p>Resources: 2</p>";
  return { ...s, page: async (j, pid, name) => (name === "Occupation" ? { name, journal: "x", html: occHtml } : s.page(j, pid, name)) };
};
const catOcc = await buildCatalog(occSource());
const VO = (doc, input, o = {}) => validateProposal(doc, input, { catalog: catOcc, lookup, itemCheck: () => null, ...o });
const fullBuild = (over = {}) => ({
  rank: "global", name: "Fresh Kestrel", attributes: { fighting: 6, agility: 7, strength: 5, reason: 5, intuition: 5, presence: 5 }, resources: 3, reputation: 2,
  texts: { civilianName: "Invented Name", role: "Wildcard", occupation: "Courier", personality: "Restless, Loyal", drive: "Invented drive", flaw: "Invented flaw", team: "Invented team", relationships: "NPC: Tomas Rel (mentor)" },
  sources: [{ key: "s1", ref: ref("powerSource", "Strange Meteor") }],
  powers: [
    { ref: ref("power", "Glide Wings"), level: "basic", source: "s1", boosts: [{ ref: ref("boost", "Silent Flight", "Glide Wings") }] },
    { ref: ref("power", "Spark Bolt"), level: "major", source: "s1", limits: [{ ref: ref("limit", "Needs Charging", "Spark Bolt"), grants: "level" }] },
    { ref: ref("power", "Echo Sense"), source: "s1" }
  ],
  talents: [{ ref: ref("talent", "Quick Wits") }, { ref: ref("talent", "Streetwise") }],
  drawbacks: [{ ref: ref("drawback", "Lean Times") }],
  ...over
});
const rep = (proposal) => ({ target: "this", mode: "replace", proposal, rationale: "x" });

await test("P1-D: brackets in notes are autoFixed, long notes cut at a word boundary with note.cut", async () => {
  const n = normalize({ target: "this", mode: "ops", ops: [{ op: "addItem", opId: "d", ref: "drawbacks:x", note: "Kingpin (Wilson Fisk)" }, { op: "updateItem", opId: "u", itemId: "i", set: { note: "an invented note that keeps going well beyond the sixty character limit here" } }] });
  assert.equal(n.proposal.ops[0].note, "Kingpin, Wilson Fisk");
  assert.ok(n.autoFixed.some((x) => /ops\[0\]\.note: brackets/.test(x)));
  assert.equal(n.proposal.ops[1].set.note, "an invented note that keeps going well beyond the sixty");
  assert.deepEqual(n.warnings.map((w) => [w.code, w.path, w.opId]), [["note.cut", "ops[1].set.note", "u"]]);
  const a = typicalHero();
  const r = await V(a, ops({ op: "addItem", opId: "d1", ref: ref("drawback", "Haunted"), note: "Kingpin (Wilson Fisk) and an invented long tail of extra words here" }, { op: "addItem", opId: "t1", ref: ref("talent", "Steady Hands") }), { profile: "in-play" });
  has(r, "note.cut", "warnings");
  assert.ok(r.warnings.find((w) => w.code === "note.cut").message.includes("cut to \"Kingpin, Wilson Fisk and an invented long tail of extra"));
  assert.equal(r.opInfo.d1.name, "Haunted (Kingpin, Wilson Fisk and an invented long tail of extra)");
  // replace path: same cleaning on proposal notes
  const rr = await V(blankHero(), rep({ ...fullBuild(), drawbacks: [{ ref: ref("drawback", "Lean Times"), note: "Boss (Big)" }] }));
  assert.ok(rr.autoFixed.some((x) => x.startsWith("proposal.drawbacks[0].note")));
  assert.ok(rr.ops.some((o) => o.note === "Boss, Big"));
});

await test("P1-D: an existing nested-bracket name is matched (replace keeps the item, no false custom remove)", async () => {
  const a = typicalHero();
  const lean = a.items.find((i) => i.name === "Lean Times");
  lean.name = lean._source.name = "Lean Times (Kingpin (Wilson Fisk))";
  const st = stateOf(toPlainActor(a), "global");
  assert.deepEqual(st.drawbacks.map((d) => d.name), ["Lean Times"]);
  const P = fullBuild({ name: "Amber Kestrel", drawbacks: [{ ref: ref("drawback", "Lean Times"), note: "Kingpin, Wilson Fisk" }] });
  const conv = replaceToOps(a, P, { catalog, rank: "global" });
  assert.ok(conv.ops.every((o) => o.op !== "removeItem" && o.op !== "addItem"), JSON.stringify(conv.ops));
  const upd = conv.ops.find((o) => o.op === "updateItem");
  assert.equal(upd.set.note, "Kingpin, Wilson Fisk");   // the bracketed note is rewritten without brackets
  const r = await V(a, ops({ op: "removeItem", opId: "r", itemId: lean.id }), { profile: "in-play" });
  assert.ok(!r.warnings.some((w) => w.code === "remove.handEdited"), "catalogue match kept: not reported as custom");
});

await test("P1-E: refs with the long pack name (power-sources:) validate like the short ones", async () => {
  const long = ref("powerSource", "Tinkerer Genius").replace(/^sources:/, "power-sources:");
  const a = typicalHero();
  const r = await V(a, ops({ op: "addItem", opId: "s", ref: long }), { profile: "in-play" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const rr = await V(blankHero(), rep(fullBuild({ sources: [{ key: "s1", ref: ref("powerSource", "Strange Meteor").replace(/^sources:/, "power-sources:") }] })), { rank: "global" });
  assert.equal(rr.ok, true, JSON.stringify(rr.errors));
});

await test("P1-C: replace puts the actor op first; occupation talent free, extra talent -1, readable labels", async () => {
  const r = await VO(blankHero(), rep(fullBuild({ talents: [{ ref: ref("talent", "Quick Wits") }, { ref: ref("talent", "Streetwise") }, { ref: ref("talent", "Steady Hands") }], attributes: { fighting: 6, agility: 7, strength: 5, reason: 5, intuition: 5, presence: 4 } })), { rank: "global" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.ops[0].op, "updateActor");
  assert.equal(r.ops[0].opId, "act1");
  const by = Object.fromEntries(r.budget.perOp.map((c) => [r.opInfo[c.opId].name ?? c.opId, c]));
  assert.equal(by["Quick Wits"].points, 0); assert.equal(by["Quick Wits"].label, "hero talent (free)");
  assert.equal(by["Streetwise"].points, 0); assert.equal(by["Streetwise"].label, "occupation talent (free)");
  assert.equal(by["Steady Hands"].points, -1); assert.equal(by["Steady Hands"].label, "extra talent -1 pt");
  assert.equal(by["Lean Times"].label, "drawback +1 pt");
  assert.equal(by["Strange Meteor"].label, "first power source (free)");
  assert.match(by["Glide Wings"].label, /^\+1 slot \(slots \d\/4\) -2 pts$/);
  assert.equal(r.budget.perOp.find((c) => c.opId === "act1").points, 0);   // the actor op no longer looks +1
  assert.equal(r.budget.perOp.reduce((s, c) => s + c.points, 0), r.budget.after.points - r.budget.before.points);
  assert.match(r.summary, /add talent "Streetwise" cost: occupation talent \(free\)/);
  assert.match(r.summary, /add talent "Steady Hands" cost: extra talent -1 pt/);
});

await test("P1-C: ops mode with updateActor LAST still prices the occupation talent as free (actor ops evaluated first)", async () => {
  const b = blankHero();
  const src = { op: "addItem", opId: "s", ref: ref("powerSource", "Strange Meteor") };
  const pw = { op: "addItem", opId: "p", ref: ref("power", "Echo Sense"), sourceOpId: "s" };
  const t1 = { op: "addItem", opId: "t1", ref: ref("talent", "Quick Wits") };
  const t2 = { op: "addItem", opId: "t2", ref: ref("talent", "Streetwise") };
  const act = { op: "updateActor", opId: "a", set: { texts: { occupation: "Courier" } } };
  const r = await V(b, ops(src, pw, t1, t2, act), { profile: "in-play", rank: "global" });
  const c = Object.fromEntries(r.budget.perOp.map((x) => [x.opId, x]));
  assert.deepEqual(r.budget.perOp.map((x) => x.opId), ["s", "p", "t1", "t2", "a"]);   // list order kept
  assert.equal(c.t2.points, 0); assert.equal(c.t2.label, "occupation talent (free)");
  assert.equal(c.a.points, 0);
});

await test("P1-F: occupation, Resources, occupation talent and reputation are checked (creation, warnings)", async () => {
  const ok = await VO(blankHero(), rep(fullBuild()), { rank: "global" });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  for (const c of ["occupation.unknown", "resources.occupation", "talent.occ.list", "reputation.rank"]) assert.ok(!codes(ok, "warnings").includes(c), c);
  const bad = await VO(blankHero(), rep(fullBuild({ resources: 5, reputation: 0, talents: [{ ref: ref("talent", "Quick Wits") }, { ref: ref("talent", "Steady Hands") }] })), { rank: "global" });
  assert.equal(bad.ok, true, "warnings, not errors (D-4 provisional)");
  has(bad, "resources.occupation", "warnings"); has(bad, "talent.occ.list", "warnings"); has(bad, "reputation.rank", "warnings");
  assert.match(bad.warnings.find((w) => w.code === "resources.occupation").message, /Resources 5 differ from the occupation's value \(Courier: 3\)/);
  assert.match(bad.warnings.find((w) => w.code === "reputation.rank").hint, /Set reputation to 2/);
  const own = await VO(blankHero(), rep(fullBuild({ texts: { ...fullBuild().texts, occupation: "Lighthouse Keeper" } })), { rank: "global" });
  has(own, "occupation.unknown", "warnings");
  assert.ok(!codes(own, "warnings").includes("resources.occupation"));
  const asRef = await VO(blankHero(), rep(fullBuild({ texts: { ...fullBuild().texts, occupation: "occupation:courier" } })), { rank: "global" });
  assert.match(asRef.warnings.find((w) => w.code === "occupation.unknown").hint, /Set texts.occupation to "Courier"/);
  // knowledgeable-style variants: the base name counts
  const kn = await VO(blankHero(), rep(fullBuild({ talents: [{ ref: ref("talent", "Quick Wits") }, { ref: ref("talent", "Streetwise"), note: "docks" }] })), { rank: "global" });
  assert.ok(!codes(kn, "warnings").includes("talent.occ.list"));
  // in-play: none of these checks
  const ip = await VO(blankHero(), rep(fullBuild({ resources: 5, reputation: 0 })), { rank: "global", profile: "in-play" });
  for (const c of ["resources.occupation", "reputation.rank"]) assert.ok(!codes(ip, "warnings").includes(c), c);
});

await test("P1-F: reputation defaults to the rank's value in a creation replace (validator and writer conversion agree)", async () => {
  const P = fullBuild(); delete P.reputation;
  const r = await VO(blankHero(), rep(P), { rank: "street" });
  has(r, "reputation.defaulted", "info");
  assert.equal(r.ops.find((o) => o.op === "updateActor").set.reputation, 1);
  assert.equal(replaceToOps(blankHero(), P, { catalog, rank: "street" }).ops[0].set.reputation, 1);
  assert.equal(replaceToOps(blankHero(), P, { catalog, rank: "street", profile: "in-play" }).ops[0].set.reputation, undefined);
  const npc = replaceToOps(smallNpc(), { name: "X" }, { catalog, rank: "street" });
  assert.deepEqual(npc.defaulted, []);
});

await test("P1-F: Hard Times info names the stored and the effective Resources (D-3 provisional)", async () => {
  const d = describe({ code: "drawback.hardTimes", params: { n: 1, stored: 3, effective: 2, book: 1 } });
  assert.match(d.message, /stored at 3/); assert.match(d.message, /sheet shows 2/);
  // W2-5: the book's -2 is a GM-only remark (`gm`), never in the model's message / hint
  assert.doesNotMatch(d.message + d.hint, /-2|book/); assert.match(d.gm, /-2 per Hard Times \(Resources would be 1\)/);
  const d0 = describe({ code: "drawback.hardTimes", params: {} });
  assert.equal(d0.message, "Hard Times lowers Resources by 1 through its effect."); assert.match(d0.gm, /-2/);
});

await test("W2-5: Hard Times in a submit result: the model's copy has no book number, the GM's validate result keeps it", async () => {
  const R = rows(); R.drawbacks.push({ _id: "drwHardTimes0000", name: "Hard Times", system: { description: "<p>Invented placeholder drawback.</p>" } });
  const catHT = await buildCatalog(fixtureSource(R));
  const P = fullBuild({ drawbacks: [{ ref: catHT.findByName("drawback", "Hard Times").ref }] });
  const gm = await validateProposal(blankHero(), rep(P), { catalog: catHT, lookup, itemCheck: () => null, rank: "global" });
  const ht = gm.info.find((i) => i.code === "drawback.hardTimes") ?? assert.fail(JSON.stringify(gm.info));
  assert.match(ht.gm, /-2 per Hard Times/);
  const model = await validateGroup(() => null, { catalog: catHT, lookup, itemCheck: () => null }).runProposalTool("submit_proposal", rep(P), { doc: blankHero(), options: { rank: "global" } });
  const mt = model.info.find((i) => i.code === "drawback.hardTimes");
  assert.ok(mt && !("gm" in mt)); assert.doesNotMatch(JSON.stringify(model), /-2 per|book/);
});

await test("W2-5: readable budget: budget.note, spentAfter instead of the spent delta, limit pays for X, kept reputation/resources", async () => {
  const r = await VO(blankHero(), rep(fullBuild()), { rank: "global" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.budget.note, /every unused rank slot adds 2/);
  assert.ok(r.budget.perOp.every((c) => !("spent" in c)), "no spent delta any more");
  const act = r.budget.perOp.find((c) => c.opId === "act1");
  assert.equal(act.spentAfter, 33); assert.equal(act.label, `attributes spent ${r.budget.before.spent} -> 33`);
  assert.ok(r.budget.perOp.filter((c) => c.opId !== "act1").every((c) => !("spentAfter" in c)));
  const lim = r.budget.perOp.find((c) => r.opInfo[c.opId].type === "limit");
  assert.equal(lim.label, 'pays for a level of "Spark Bolt" (no slot for it; slots 3/4) +2 pts');
  assert.equal(r.budget.perOp.reduce((s, c) => s + c.points, 0), r.budget.after.points - r.budget.before.points);
  assert.match(r.summary, /act1: actor .*resources 3, reputation 2/);
  assert.match(r.summary, /cost: pays for a level of "Spark Bolt"/);
  // a rebuild of the same hero: reputation / resources already on the sheet make no op, the summary says they are kept
  const th = typicalHero();
  const same = await VO(th, rep(fullBuild({ reputation: th._source.system.reputation, resources: th._source.system.resources })), { rank: "global", profile: "in-play" });
  assert.ok(same.summary.includes(`act1: kept resources ${th._source.system.resources}, reputation ${th._source.system.reputation} (already on the sheet)`), same.summary);
  // removing a limit: its level needs a slot again
  const rm = await V(th, ops({ op: "removeItem", opId: "r", itemId: idOf(th, "Needs Charging") }), { profile: "in-play", rank: "global" });
  assert.equal(rm.budget.perOp[0].label, 'limit gone: the level of "Spark Bolt" it paid for needs a slot again (slots 5/4) -2 pts');
  // a limit added in ops mode with grants boost on a Basic power
  const b = blankHero();
  const lb = await V(b, ops({ op: "addItem", opId: "s", ref: ref("powerSource", "Strange Meteor") }, { op: "addItem", opId: "p", ref: ref("power", "Glide Wings"), sourceOpId: "s" },
    { op: "addItem", opId: "bo", ref: ref("boost", "Silent Flight", "Glide Wings"), powerOpId: "p" }, { op: "addItem", opId: "li", ref: ref("limit", "Loud", "Glide Wings"), powerOpId: "p", grants: "boost" }), { profile: "in-play", rank: "global" });
  assert.equal(lb.budget.perOp.find((c) => c.opId === "li").label, 'pays for a boost of "Glide Wings" (no slot for it; slots 1/4) +2 pts');
});

await test("P1-F: creation + replace shows warnings the blank actor already had (npc.name.blank hint reaches the model)", async () => {
  const P = fullBuild({ texts: { ...fullBuild().texts, relationships: "" } });
  const r = await VO(blankHero(), rep(P), { rank: "global" });
  has(r, "npc.name.blank", "warnings");
  assert.match(r.warnings.find((w) => w.code === "npc.name.blank").hint, /NPC: Name \(type\)/);
  // ops mode keeps "new warnings only"
  const o = await V(blankHero(), ops({ op: "updateActor", opId: "a", set: { name: "Still Blank" } }), { rank: "global" });
  assert.ok(!codes(o, "warnings").includes("npc.name.blank"));
});

await test("P1-G: no suggest when the proposal names another rank; rank.defaulted when nobody chose a rank", async () => {
  const P = fullBuild({ rank: "street" });
  const r = await VO(blankHero(), rep(P), { rank: "global" });
  has(r, "rank.differs", "warnings");
  const e = r.errors.find((x) => x.code === "attr.unspent" || x.code === "attr.over");
  if (e) assert.equal(e.suggest, undefined);
  const r2 = await VO(blankHero(), rep(fullBuild({ attributes: { fighting: 6, agility: 7, strength: 5, reason: 5, intuition: 5, presence: 2 } })), { rank: "global" });
  assert.ok(r2.errors.find((x) => x.code === "attr.unspent").suggest, "same rank: the reconciled vector is still offered");
  const d = await VO(blankHero(), rep(fullBuild()));
  has(d, "rank.defaulted", "warnings");
  assert.match(d.warnings.find((w) => w.code === "rank.defaulted").message, /validated as global \(the default\)/);
  assert.ok(!codes(await VO(blankHero(), rep(fullBuild()), { rank: "global" }), "warnings").includes("rank.defaulted"));
  assert.ok(!codes(await V(typicalHero(), ops({ op: "updateActor", opId: "a", set: { texts: { drive: "x" } } })), "warnings").includes("rank.defaulted"), "plus-ultra flag counts as a chosen rank");
  assert.ok(!codes(await V(smallNpc(), ops({ op: "updateActor", opId: "a", set: { name: "Y" } })), "warnings").includes("rank.defaulted"), "npc: no rank budget");
});

/* ================================================================== wave 3, group C1 (analysis-3) */
const group = (cat) => validateGroup(() => null, { catalog: cat, lookup, itemCheck: () => null });

await test("W3-6: the limit label follows the sheet's reading, not the model's grants; grants.heuristic is info 'does not change the cost'", async () => {
  const P = fullBuild();
  P.powers[1].limits[0].grants = "boost";   // Spark Bolt is Major: the sheet reads the limit as paying for a level
  const r = await VO(blankHero(), rep(P), { rank: "global" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const lim = r.budget.perOp.find((c) => r.opInfo[c.opId].type === "limit");
  assert.equal(lim.label, 'pays for a level of "Spark Bolt" (no slot for it; slots 3/4) +2 pts');
  const gi = r.info.find((i) => i.code === "grants.heuristic") ?? assert.fail(JSON.stringify(r.info));
  assert.match(gi.message, /grants "boost" does not change the cost; the sheet reads it as paying for a level/);
  assert.equal(gi.hint, "Nothing to fix.");
  assert.ok(!codes(r, "warnings").includes("grants.heuristic"));
  // same budget whatever grants says
  const r2 = await VO(blankHero(), rep(fullBuild()), { rank: "global" });
  assert.deepEqual(r2.budget.after, r.budget.after);
});

await test("W3-7: Hard Times info only when drawbacks / Resources are touched or in a replace; rank.defaulted and npc.name.blank texts", async () => {
  const th = typicalHero();
  const hard = mkActor({ id: th.id, name: th.name, attrs: {}, system: th._source.system, flags: th._source.flags, items: [...th.items, item("drwHardTimes9999", "drawback", "Hard Times")] });
  const ht = (r) => codes(r, "info").includes("drawback.hardTimes");
  const plain = await V(hard, ops({ op: "updateActor", opId: "a", set: { texts: { drive: "Invented new drive" } } }), { profile: "in-play" });
  assert.equal(plain.ok, true, JSON.stringify(plain.errors)); assert.equal(ht(plain), false, "an unrelated edit: no Hard Times remark");
  assert.equal(ht(await V(hard, ops({ op: "updateActor", opId: "a", set: { resources: 2 } }), { profile: "in-play" })), true, "Resources touched");
  assert.equal(ht(await V(hard, ops({ op: "addItem", opId: "d", ref: ref("drawback", "Haunted"), note: "Invented rival" }), { profile: "in-play" })), true, "a drawback added");
  assert.equal(ht(await V(hard, ops({ op: "updateItem", opId: "u", itemId: idOf(hard, "Lean Times"), set: { note: "Invented" } }), { profile: "in-play" })), true, "a drawback changed");
  // rank.defaulted: no order to ask
  const d = await VO(blankHero(), rep(fullBuild()));
  assert.equal(d.warnings.find((w) => w.code === "rank.defaulted").hint, "Nothing to do unless the GM's message names another rank; then ask them to set it in the drawer.");
  // npc.name.blank: empty relationships = no NPC relationship written; an "NPC:" line without a name = nameless
  const none = await VO(blankHero(), rep(fullBuild({ texts: { ...fullBuild().texts, relationships: "" } })), { rank: "global" });
  const nb = none.warnings.find((w) => w.code === "npc.name.blank");
  assert.match(nb.message, /^No NPC relationship is written/); assert.match(nb.hint, /invent one original NPC and write "NPC: Name \(type\)"/);
  const nameless = await VO(blankHero(), rep(fullBuild({ texts: { ...fullBuild().texts, relationships: "NPC: (mentor)" } })), { rank: "global" });
  assert.equal(nameless.warnings.find((w) => w.code === "npc.name.blank").message, "The NPC relationship line has no name.");
});

await test("W3-8: a note-only change reads `change drawback \"X\" [note \"...\"]` (no [name])", async () => {
  const a = typicalHero();
  const r = await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Lean Times"), set: { note: "Invented debt" } }), { profile: "in-play" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.summary, /^u: change drawback "Lean Times" \[note "Invented debt"\]$/m);
  assert.doesNotMatch(r.summary, /\[name\]/);
  const r2 = await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Glide Wings"), set: { level: "major", note: "Invented arcs" } }), { profile: "in-play" });
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.match(r2.summary, /^u: change power "Glide Wings" \[level, note "Invented arcs"\]/m);
  // a gear rename still says [name]
  const g = await V(a, ops({ op: "updateItem", opId: "g", itemId: idOf(a, "Grapple Line"), set: { name: "Invented Hook" } }), { profile: "in-play" });
  assert.match(g.summary, /g: change gear "Grapple Line" \[name\]/);
});

await test("W3-10: applyConfirm in the submit result for removals (with cascade) and level swaps; none for plain edits", async () => {
  const a = typicalHero();
  const sub = (doc, input) => group(catalog).runProposalTool("submit_proposal", input, { doc, options: { rank: "global", profile: "in-play" } });
  const r = await sub(a, ops({ op: "removeItem", opId: "r", itemId: idOf(a, "Spark Bolt"), cascade: true }, { op: "removeItem", opId: "g", itemId: idOf(a, "Stun Baton") }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.applyConfirm, ['remove power "Spark Bolt"', 'remove limit "Needs Charging" (with "Spark Bolt")', 'remove gear "Stun Baton"']);
  assert.match(r.applyConfirmNote, /the GM confirms these at Apply/i);
  const nid = idGen(31);
  const s = fromCatalog(nid, "power-sources", "Strange Meteor");
  const iron = fromCatalog(nid, "powers", "Iron Hide", { level: "basic", system: { powerSource: s.id } });
  const plate = mkActor({ id: "splitHero0000001", name: "Plate", attrs: { fighting: 6, agility: 6, strength: 6, reason: 5, intuition: 5, presence: 5 }, items: [s, iron] });
  const sw = await sub(plate, ops({ op: "updateItem", opId: "u", itemId: iron.id, set: { level: "major" } }));
  assert.deepEqual(sw.applyConfirm, ['level swap power "Iron Hide" basic -> major']);
  const none = await sub(a, ops({ op: "updateActor", opId: "a", set: { texts: { drive: "Invented" } } }));
  assert.equal(none.ok, true); assert.equal(none.applyConfirm, undefined); assert.equal(none.applyConfirmNote, undefined);
  // check_proposal does not carry it
  const ck = await group(catalog).runProposalTool("check_proposal", ops({ op: "removeItem", opId: "g", itemId: idOf(a, "Stun Baton") }), { doc: a, options: { rank: "global", profile: "in-play" } });
  assert.equal(ck.applyConfirm, undefined);
});

await test("W3-11: attr.cap in-play says the cap applies in-play too and who changes the rank", async () => {
  const a = typicalHero();
  const r = await V(a, ops({ op: "updateActor", opId: "a", set: { attributes: { fighting: 9 } } }), { profile: "in-play", rank: "street" });
  const e = r.errors.find((x) => x.code === "attr.cap") ?? assert.fail(JSON.stringify(r.errors));
  assert.match(e.hint, /^The rank cap applies in-play too: keep every attribute within 1\.\.\d+\. If the GM wants a higher value, ask them to change the rank in the drawer\.$/);
  const c = await V(a, ops({ op: "updateActor", opId: "a", set: { attributes: { fighting: 9 } } }), { rank: "street" });
  assert.match(c.errors.find((x) => x.code === "attr.cap").hint, /^Keep every attribute within 1\.\.\d+\.$/);
});

await test("W3-12: gear cost next to Resources as info when gear is added or re-priced", async () => {
  const a = typicalHero();
  const res = a._source.system.resources;
  const r = await V(a, ops({ op: "addItem", opId: "g", ref: ref("gear", "Stun Baton") }), { profile: "in-play" });
  const gi = r.info.find((i) => i.code === "gear.cost") ?? assert.fail(JSON.stringify(r.info));
  assert.equal(gi.opId, "g");
  assert.equal(gi.message, `Gear "Stun Baton" cost ${catalog.findByName("gear", "Stun Baton").gear.cost ?? 0} at Resources ${res}.`);
  const p = await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Grapple Line"), set: { gear: { cost: 4 } } }), { profile: "in-play" });
  assert.match(p.info.find((i) => i.code === "gear.cost").message, new RegExp(`cost 4 at Resources ${res}\\.`));
  assert.ok(!codes(await V(a, ops({ op: "updateItem", opId: "u", itemId: idOf(a, "Grapple Line"), set: { name: "Invented" } }), { profile: "in-play" }), "info").includes("gear.cost"), "a rename is no re-pricing");
});

await test("W3-9: effect.placeholder warning for an added item whose effect key has [..]; model: note, GM: edit the effect", async () => {
  const R = rows(); R.talents.push({ _id: "talSignature0000", name: "Signature Knack", system: { description: "<p>Invented placeholder talent.</p>" } });
  const s = fixtureSource(R);
  s.documents = async (p) => (await s.index(p)).map((d) => (d._id === "talSignature0000" ? { ...d, effects: [{ name: "Pick", system: { changes: [{ key: "bonus.[attribute]", type: "add", value: "2" }] } }] } : d));
  const catPH = await buildCatalog(s);
  assert.deepEqual(catPH.findByName("talent", "Signature Knack").placeholders, ["bonus.[attribute]"]);
  const a = typicalHero();
  const input = ops({ op: "addItem", opId: "t", ref: catPH.findByName("talent", "Signature Knack").ref });
  const gm = await validateProposal(a, input, { catalog: catPH, lookup, itemCheck: () => null, profile: "in-play" });
  const w = gm.warnings.find((x) => x.code === "effect.placeholder") ?? assert.fail(JSON.stringify(gm.warnings));
  assert.equal(w.opId, "t"); assert.match(w.message, /Talent "Signature Knack" has an effect with a choice left open \(bonus\.\[attribute\]\)/);
  assert.match(w.hint, /in the item's note/); assert.match(w.gm, /edit the effect by hand after Apply/);
  const model = await group(catPH).runProposalTool("submit_proposal", input, { doc: a, options: { rank: "global", profile: "in-play" } });
  const mw = model.warnings.find((x) => x.code === "effect.placeholder");
  assert.ok(mw && !("gm" in mw));
  const noted = await validateProposal(a, ops({ op: "addItem", opId: "t", ref: catPH.findByName("talent", "Signature Knack").ref, note: "Reason" }), { catalog: catPH, lookup, itemCheck: () => null, profile: "in-play" });
  assert.match(noted.warnings.find((x) => x.code === "effect.placeholder").hint, /^Nothing to fix: the note names the choice/);
  // an item without a placeholder, and a sheet item (ops mode) do not warn
  assert.ok(!codes(await validateProposal(a, ops({ op: "addItem", opId: "t", ref: catPH.findByName("talent", "Steady Hands").ref }), { catalog: catPH, lookup, itemCheck: () => null, profile: "in-play" }), "warnings").includes("effect.placeholder"));
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
