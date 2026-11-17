// T6: Invincible in-place writer (plan / apply / undo / undoStatus), replace -> ops, partial selection, journal, plus-ultra bridge.
// Node, no Foundry, no network. A fake Actor/Item layer below behaves like Foundry embedded documents (createEmbeddedDocuments with
// keepId, updateEmbeddedDocuments with dotted paths and "-=" deletion, deleteEmbeddedDocuments, actor.update, prepared derived max).
// Fixtures: dev/fixtures/invincible-sheets.mjs (invented names only, no book text).
// Run: node dev/test-build-ops.mjs
import assert from "node:assert/strict";
import { createWriter, selectOps, levelFlips, normRef, JOURNAL_PATH, LOCK_PATH } from "../scripts/systems/invincible/writer.mjs";
import { toOps } from "../scripts/systems/invincible/replace.mjs";
import { createBridge } from "../scripts/systems/invincible/pu-bridge.mjs";
import { fingerprint, pruneJournal, UNDO_TTL, UNDO_RUNS } from "../scripts/systems/invincible/undo.mjs";
import { buildCatalog } from "../scripts/systems/invincible/catalog.mjs";
import { chargenStateFromActor, getPath, readActor } from "../scripts/systems/invincible/reader.mjs";
import { typicalHero, bigNpc, CATALOG_ROWS, item as fxItem, idGen } from "./fixtures/invincible-sheets.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ================================================================ fake Foundry documents */
let idSeq = idGen(4242);
function setDotted(obj, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let cur = obj;
  for (const k of parts) cur = (cur[k] && typeof cur[k] === "object") ? cur[k] : (cur[k] = {});
  if (last.startsWith("-=")) delete cur[last.slice(2)];
  else if (value && typeof value === "object" && !Array.isArray(value) && cur[last] && typeof cur[last] === "object" && !Array.isArray(cur[last])) mergeInto(cur[last], value);
  else cur[last] = expand(value);
}
/** Foundry's update expands dotted keys at ANY depth, inside arrays too (foundry.utils.expandObject): a journal entry keyed by
    "system.attributes.x.value" is stored nested. The fake does the same so the writer cannot rely on dotted keys surviving. */
function expand(v) {
  if (Array.isArray(v)) return v.map(expand);
  if (!v || typeof v !== "object") return clone(v);
  const o = {};
  for (const [k, x] of Object.entries(v)) { if (k.includes(".")) setDotted(o, k, x); else o[k] = expand(x); }
  return o;
}
function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k.includes(".")) { setDotted(target, k, v); continue; }
    if (k.startsWith("-=")) { delete target[k.slice(2)]; continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) mergeInto(target[k], v);
    else target[k] = expand(v);
  }
}
let clock = 1_000_000;
class FakeItem {
  constructor(src, parent) { this._source = src; this.parent = parent; this.documentName = "Item"; }
  get id() { return this._source._id; } get name() { return this._source.name; } get type() { return this._source.type; }
  get system() { return this._source.system; } get effects() { return this._source.effects ?? []; }
  get uuid() { return this.parent ? `${this.parent.uuid}.Item.${this.id}` : `Item.${this.id}`; }
  get _stats() { return this._source._stats; }
  toObject() { return clone(this._source); }
  async update(data) { this.parent?._maybeFail("itemUpdate"); mergeInto(this._source, data); this._source._stats = { modifiedTime: ++clock }; this.updates = (this.updates ?? 0) + 1; return this; }
  async delete() { this.deleted = true; return this; }
}
class Collection extends Map {
  filter(fn) { return [...this.values()].filter(fn); }
  map(fn) { return [...this.values()].map(fn); }
  find(fn) { return [...this.values()].find(fn); }
  [Symbol.iterator]() { return this.values(); }
}
class FakeActor {
  constructor(fx) {
    this.documentName = "Actor";
    this._source = clone(fx._source); delete this._source.items;
    this.items = new Collection();
    for (const i of fx.items) { const s = clone(i._source); s._stats = { modifiedTime: 1 }; this.items.set(s._id, new FakeItem(s, this)); }
    this.effects = clone(fx.effects ?? []);
    this.isOwner = true; this.calls = []; this.failOn = null;
  }
  get id() { return this._source._id; } get name() { return this._source.name; } get type() { return this._source.type; }
  get uuid() { return `Actor.${this.id}`; }
  get system() {
    const s = clone(this._source.system);
    const a = (k) => Number(s.attributes?.[k]?.value) || 0;
    s.derived ??= {};
    for (const [k, list] of Object.entries({ health: ["fighting", "agility", "strength"], resolve: ["reason", "intuition", "presence"] })) {
      s.derived[k] = { ...(s.derived[k] ?? {}), max: Math.ceil(list.reduce((t, x) => t + a(x), 0) / 2) };
    }
    return s;
  }
  _maybeFail(what) { if (this.failOn === what) { this.failOn = null; throw new Error(`injected failure in ${what}`); } }
  async update(data) { this.calls.push(["update", Object.keys(data)]); this._maybeFail("update"); mergeInto(this._source, data); return this; }
  async createEmbeddedDocuments(type, data, { keepId = false } = {}) {
    this.calls.push(["create", data.length, keepId]); this._maybeFail("create");
    const out = [];
    for (const d of data) {
      const s = clone(d);
      if (keepId && s._id) { if (this.items.has(s._id)) throw new Error(`id ${s._id} exists`); }
      else s._id = idSeq();
      s._stats = { modifiedTime: ++clock };
      s.effects ??= []; s.flags ??= {};
      const it = new FakeItem(s, this);
      this.items.set(s._id, it); out.push(it);
    }
    return out;
  }
  async updateEmbeddedDocuments(type, rows) {
    this.calls.push(["updateItems", rows.length]); this._maybeFail("updateItems");
    for (const r of rows) {
      const it = this.items.get(r._id);
      if (!it) throw new Error(`no item ${r._id}`);
      const { _id, ...rest } = r;
      for (const [k, v] of Object.entries(rest)) setDotted(it._source, k, v);
      it._source._stats = { modifiedTime: ++clock };
    }
    return rows.map((r) => this.items.get(r._id));
  }
  async deleteEmbeddedDocuments(type, ids) {
    this.calls.push(["delete", ids.length]); this._maybeFail("delete");
    for (const id of ids) { if (!this.items.has(id)) throw new Error(`no item ${id}`); this.items.delete(id); }
    return ids;
  }
}
const itemFps = (a) => Object.fromEntries([...a.items.values()].map((i) => [i.id, fingerprint(i._source)]));
const byName = (a, n) => [...a.items.values()].find((i) => i.name === n);

/* ================================================================ fake catalogue (from the fixture rows) */
const TYPE = { "power-sources": "powerSource", powers: "power", boosts: "boost", limits: "limit", talents: "talent", drawbacks: "drawback" };
function fakeSource() {
  const folders = {};
  const packs = {};
  for (const [pack, rows] of Object.entries(CATALOG_ROWS)) {
    const fl = new Map();
    packs[pack] = rows.map((r) => {
      let folder = null;
      if (r.folder) { if (!fl.has(r.folder)) fl.set(r.folder, { id: `f${fl.size}${pack.length}`, name: r.folder, parent: null }); folder = fl.get(r.folder).id; }
      return { _id: r._id, name: r.name, type: r.type ?? TYPE[pack], folder, system: clone(r.system), _stats: { modifiedTime: 1 } };
    });
    folders[pack] = [...fl.values()];
  }
  return {
    has: (p) => !!packs[p],
    async index(p) { return clone(packs[p] ?? []); },
    folders: (p) => folders[p] ?? [],
    async document(p, id) { const d = packs[p]?.find((x) => x._id === id); return d ? clone(d) : null; },
    async page() { return null; },
    packs
  };
}
const SRC = fakeSource();
const cat = await buildCatalog(SRC, { feedRules: false });
const refOf = (kind, name, power = null) => cat.findByName(kind, name, { power })?.ref;
async function fetchData(uuid) {
  const m = /^Compendium\.invincible-core\.([^.]+)\.Item\.(.+)$/.exec(uuid);
  if (!m) return null;
  const d = SRC.packs[m[1]]?.find((x) => x._id === m[2]);
  return d ? { ...clone(d), effects: [], flags: { core: { sourceId: "x" } } } : null;
}

function mkWriter(over = {}) {
  let n = 0;
  return createWriter({
    getCatalog: async () => cat, fetchData, toOps,
    isGM: () => true, userId: () => "gm1", userName: () => "Gamemaster",
    liveForm: () => null, validate: null,
    randomID: () => `rid${String(++n).padStart(13, "0")}`,
    now: () => clock, sleep: async () => {}, lockSettle: 0,
    log: { warn() {}, error() {} },
    ...over
  });
}
const W = mkWriter();
const hero = () => new FakeActor(typicalHero());

/* ================================================================ tests */
await test("catalogue fixture: split power, boosts by folder, refs", () => {
  const ih = cat.findByName("power", "Iron Hide");
  assert.ok(ih.split && ih.levelDocs.basic && ih.levelDocs.major);
  assert.ok(refOf("boost", "Wider Arc", "Spark Bolt"));
  assert.equal(normRef("power-sources:abc"), "sources:abc");
});

await test("plan: per-op detail, projection, expect; writes nothing", async () => {
  const a = hero();
  const before = { src: JSON.stringify(a._source), items: itemFps(a) };
  const src = byName(a, "Strange Meteor"), bolt = byName(a, "Spark Bolt"), street = byName(a, "Streetwise");
  const p = await W.plan(a, { mode: "ops", ops: [
    { opId: "a1", kind: "addItem", ref: refOf("power", "Quick Step"), sourceItemId: src.id },
    { opId: "a2", kind: "addItem", ref: refOf("boost", "Wider Arc", "Spark Bolt"), powerItemId: bolt.id },
    { opId: "u1", kind: "updateItem", itemId: bolt.id, set: { level: "basic" } },
    { opId: "r1", kind: "removeItem", itemId: street.id },
    { opId: "x1", kind: "updateActor", set: { "system.attributes.fighting.value": 7, appearance: "A <b>new</b> look" } }
  ] });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(JSON.stringify(a._source), before.src); assert.deepEqual(itemFps(a), before.items);
  assert.equal(a.calls.length, 0);
  assert.deepEqual(p.ops.map((o) => [o.opId, o.action]), [["a1", "add"], ["a2", "add"], ["u1", "update"], ["r1", "remove"], ["x1", "actor"]]);
  assert.equal(p.creates.find((c) => c.opId === "a1").source, "Strange Meteor");
  assert.equal(p.creates.find((c) => c.opId === "a2").power, "Spark Bolt");
  const u = p.updates[0];
  assert.ok(u.changes.some((c) => c.path === "system.level" && c.from === "major" && c.to === "basic"));
  assert.ok(u.changes.some((c) => /showAsSelection$/.test(c.path)));
  assert.equal(p.deletes.length, 1); assert.equal(p.destructive, true);
  assert.equal(p.keeps.length, a.items.size - 2);
  assert.deepEqual(Object.keys(p.expect.items).sort(), [bolt.id, street.id].sort());
  assert.deepEqual(p.expect.deletes, [street.id]);
  assert.equal(p.expect.actor["system.attributes.fighting.value"], 6);
  // projection: reader-compatible, links to placeholders, removed item gone
  assert.equal(p.projected.items.length, a.items.size + 2 - 1);
  const pb = p.projected.items.find((i) => i.id === "+a2");
  assert.equal(pb._source.system.power, bolt.id);
  const model = readActor(p.projected);
  assert.ok(model.items.some((i) => i.id === "+a1" && i.sourceId === src.id));
  assert.equal(p.projected._source.system.attributes.fighting.value, 7);
  assert.ok(p.counts.create === 2 && p.counts.update === 1 && p.counts.delete === 1 && p.counts.fields === 2);
});

await test("apply: in place, untouched and edited items keep ids, links and levels right, journal written", async () => {
  const a = hero();
  const keepIds = [...a.items.keys()];
  const src = byName(a, "Strange Meteor"), bolt = byName(a, "Spark Bolt"), street = byName(a, "Streetwise"), wings = byName(a, "Glide Wings");
  const proposal = { mode: "ops", ops: [
    { opId: "s1", kind: "addItem", ref: refOf("powerSource", "Tinkerer Genius") },
    { opId: "a1", kind: "addItem", ref: refOf("power", "Quick Step"), sourceOpId: "s1", level: "major" },
    { opId: "a2", kind: "addItem", ref: refOf("boost", "Wider Arc", "Spark Bolt"), powerItemId: bolt.id },
    { opId: "a3", kind: "addItem", ref: refOf("drawback", "Haunted"), note: "by the pier" },
    { opId: "u1", kind: "updateItem", itemId: bolt.id, set: { level: "basic" } },
    { opId: "u2", kind: "updateItem", itemId: wings.id, set: { powerSourceOpId: "s1" } },
    { opId: "r1", kind: "removeItem", itemId: street.id },
    { opId: "x1", kind: "updateActor", set: { name: "Amber Kestrel II", "system.resources": 4 } }
  ] };
  const p = await W.plan(a, proposal);
  const r = await W.apply(a, proposal, { confirmed: true, expect: p.expect });
  assert.equal(r.ok, true, r.message);
  for (const id of keepIds) if (id !== street.id) assert.ok(a.items.has(id), `kept id ${id}`);
  assert.ok(!a.items.has(street.id));
  const newSrc = a.items.get(r.idMap.s1), newPow = a.items.get(r.idMap.a1), newBoost = a.items.get(r.idMap.a2), hd = a.items.get(r.idMap.a3);
  assert.equal(newPow.system.powerSource, newSrc.id);
  assert.equal(newPow.system.level, "major");
  assert.equal(newBoost.system.power, bolt.id);
  assert.equal(hd.name, "Haunted (by the pier)");
  assert.equal(a.items.get(wings.id).system.powerSource, newSrc.id);
  assert.equal(a.items.get(bolt.id).system.level, "basic");
  const autos = Object.values(a.items.get(bolt.id).system.automations);
  assert.equal(autos.find((x) => /^Basic/.test(x.name)).showAsSelection, true);
  assert.equal(autos.find((x) => /^Major/.test(x.name)).showAsSelection, false, "plus-ultra rule: only the chosen level (and basic attacks)");
  assert.equal(a.name, "Amber Kestrel II"); assert.equal(a._source.system.resources, 4);
  assert.ok(!getPath(newPow._source, "flags.core.sourceId"), "pack sourceId flag not copied");
  // write order: creates by phase, then updates, delete, actor, journal; no pack copies of _id
  const kinds = a.calls.map((c) => c[0]);
  assert.deepEqual(kinds.slice(0, 1), ["update"]);   // lock
  const creates = a.calls.filter((c) => c[0] === "create").map((c) => c[1]);
  assert.deepEqual(creates, [1, 1, 1, 1]);   // source, power, boost, drawback phases
  const j = getPath(a._source, JOURNAL_PATH);
  assert.equal(j.runs.length, 1); assert.equal(j.runs[0].runId, r.runId);
  assert.ok(j.runs[0].ops.every((e) => e.kind === "remove" || e.kind === "actor" || typeof e.after === "string"));
  assert.equal(getPath(a._source, LOCK_PATH), undefined, "lock released");
  // the journal never holds conversation text, only game data
  assert.ok(!JSON.stringify(j).includes("rationale"));
});

await test("cascade: removing a power with boosts needs cascade; cascade removes them; confirm required", async () => {
  const a = hero();
  const wings = byName(a, "Glide Wings"), silent = byName(a, "Silent Flight");
  const bad = await W.plan(a, { ops: [{ opId: "r", kind: "removeItem", itemId: wings.id }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, "remove.dependants"); assert.deepEqual(bad.errors[0].names, ["Silent Flight"]);
  const prop = { ops: [{ opId: "r", kind: "removeItem", itemId: wings.id, cascade: true }] };
  const p = await W.plan(a, prop);
  assert.equal(p.ok, true);
  assert.deepEqual(p.ops[0].cascade.map((c) => c.name), ["Silent Flight"]);
  assert.equal(p.deletes.find((d) => d.cascadeOf === "r").id, silent.id);
  const nc = await W.apply(a, prop, { expect: p.expect });
  assert.equal(nc.ok, false); assert.equal(nc.needsConfirm, true); assert.ok(a.items.has(wings.id));
  const r = await W.apply(a, prop, { expect: p.expect, confirmed: true });
  assert.equal(r.ok, true); assert.ok(!a.items.has(wings.id) && !a.items.has(silent.id));
  // source removal cascades through powers to their boosts/limits
  const b = hero();
  const src = byName(b, "Strange Meteor");
  const p2 = await W.plan(b, { ops: [{ opId: "r", kind: "removeItem", itemId: src.id, cascade: true }] });
  assert.deepEqual(p2.ops[0].cascade.map((c) => c.name).sort(), ["Echo Sense", "Glide Wings", "Needs Charging", "Silent Flight", "Spark Bolt"]);
});

await test("re-point instead of cascade: new source + powers moved, old source removed without cascade", async () => {
  const a = hero();
  const old = byName(a, "Strange Meteor");
  const powers = [...a.items.values()].filter((i) => i.type === "power");
  const ops = [{ opId: "s", kind: "addItem", ref: refOf("powerSource", "Ancient Bloodline") },
    ...powers.map((pw, i) => ({ opId: `m${i}`, kind: "updateItem", itemId: pw.id, set: { powerSourceOpId: "s" } })),
    { opId: "r", kind: "removeItem", itemId: old.id }];
  const p = await W.plan(a, { ops });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  const r = await W.apply(a, { ops }, { confirmed: true });
  assert.equal(r.ok, true);
  for (const pw of powers) assert.equal(a.items.get(pw.id).system.powerSource, r.idMap.s);
  // a link to an item the same list removes is refused
  const b = hero();
  const bad = await W.plan(b, { ops: [{ opId: "r", kind: "removeItem", itemId: byName(b, "Spark Bolt").id, cascade: true }, { opId: "a", kind: "addItem", ref: refOf("boost", "Wider Arc", "Spark Bolt"), powerItemId: byName(b, "Spark Bolt").id }] });
  assert.ok(bad.errors.some((e) => e.code === "link.removed"));
});

await test("split-level power: level change swaps the document under the SAME id, source and boost links kept; undo swaps back", async () => {
  const fx = typicalHero();
  const nid = idGen(9);
  const src = fx.items.find((i) => i.type === "powerSource");
  const ihRow = CATALOG_ROWS.powers.find((r) => r.name === "Iron Hide" && r.system.level === "basic");
  const ih = fxItem(nid(), "power", "Iron Hide (dented)", { ...clone(ihRow.system), powerSource: src.id });
  const bst = fxItem(nid(), "boost", "Plating", { power: ih.id, description: "<p>own boost</p>" });
  fx.items.push(ih, bst);
  const a = new FakeActor(fx);
  const prop = { ops: [{ opId: "lv", kind: "updateItem", itemId: ih.id, set: { level: "major" } }] };
  const p = await W.plan(a, prop);
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(p.ops[0].action, "swap"); assert.equal(p.swaps[0].from, "basic"); assert.equal(p.swaps[0].to, "major");
  assert.equal(p.destructive, true);
  const r = await W.apply(a, prop, { confirmed: true, expect: p.expect });
  assert.equal(r.ok, true, r.message);
  const now = a.items.get(ih.id);
  assert.ok(now, "same id");
  assert.equal(now.system.level, "major"); assert.equal(now.system.powerSource, src.id);
  assert.equal(now.name, "Iron Hide (dented)");
  const majorRow = CATALOG_ROWS.powers.find((x) => x.name === "Iron Hide" && x.system.level === "major");
  assert.equal(now.system.description, majorRow.system.description);
  assert.equal(a.items.get(bst.id).system.power, ih.id, "boost link intact without re-pointing");
  assert.ok(a.calls.some((c) => c[0] === "create" && c[2] === true), "keepId create");
  const u = await W.undo(a, r.runId);
  assert.equal(u.ok, true, u.message);
  assert.equal(a.items.get(ih.id).system.level, "basic");
  assert.equal(a.items.get(ih.id).system.description, ihRow.system.description);
});

await test("stale: an item changed since the preview -> the whole write is refused, naming it", async () => {
  const a = hero();
  const bolt = byName(a, "Spark Bolt"), quick = byName(a, "Quick Wits");
  const prop = { ops: [{ opId: "u", kind: "updateItem", itemId: bolt.id, set: { level: "basic" } }, { opId: "r", kind: "removeItem", itemId: quick.id }] };
  const p = await W.plan(a, prop);
  await a.updateEmbeddedDocuments("Item", [{ _id: bolt.id, "system.description": "<p>edited by hand</p>" }]);
  const snap = itemFps(a);
  const r = await W.apply(a, prop, { confirmed: true, expect: p.expect });
  assert.equal(r.ok, false); assert.ok(r.stale?.length);
  assert.match(r.message, /Spark Bolt/);
  assert.deepEqual(itemFps(a), snap, "nothing written");
  // a deleted item named by an op
  const b = hero();
  const q = byName(b, "Quick Wits");
  const p2 = await W.plan(b, { ops: [{ opId: "r", kind: "removeItem", itemId: q.id }] });
  await b.deleteEmbeddedDocuments("Item", [q.id]);
  const r2 = await W.apply(b, { ops: [{ opId: "r", kind: "removeItem", itemId: q.id }] }, { confirmed: true, expect: p2.expect });
  assert.equal(r2.ok, false); assert.match(r2.message, /Quick Wits|not on this sheet/);
  // plan touching more than the preview showed
  const c = hero();
  const p3 = await W.plan(c, { ops: [{ opId: "r", kind: "removeItem", itemId: byName(c, "Glide Wings").id, cascade: true }] });
  const expectNarrow = { ...p3.expect, items: { [byName(c, "Glide Wings").id]: p3.expect.items[byName(c, "Glide Wings").id] }, deletes: [byName(c, "Glide Wings").id] };
  const r3 = await W.apply(c, { ops: [{ opId: "r", kind: "removeItem", itemId: byName(c, "Glide Wings").id, cascade: true }] }, { confirmed: true, expect: expectNarrow });
  assert.equal(r3.ok, false); assert.match(r3.message, /Silent Flight/);
});

await test("unsaved sheet input: plan flags it, apply and undo refuse until saved", async () => {
  const a = hero();
  let live = { "system.appearance": "typed but not saved" };
  const w = mkWriter({ liveForm: () => live });
  const prop = { ops: [{ opId: "x", kind: "updateActor", set: { "system.resources": 5 } }] };
  const p = await w.plan(a, prop);
  assert.equal(p.unsaved.length, 1); assert.ok(p.warnings.some((x) => x.code === "sheet.unsaved"));
  const r = await w.apply(a, prop, { expect: p.expect });
  assert.equal(r.ok, false); assert.equal(r.errors[0].code, "sheet.unsaved"); assert.equal(a.calls.length, 0);
  live = null;
  const r2 = await w.apply(a, prop, { expect: p.expect });
  assert.equal(r2.ok, true);
  live = { "system.civilianName": "x" };
  const u = await w.undo(a, r2.runId);
  assert.equal(u.ok, false); assert.equal(u.errors[0].code, "sheet.unsaved");
});

await test("undo one item: a removed talent returns with its OLD id; the rest of the run stays; then undo all", async () => {
  const a = hero();
  const origin = itemFps(a);
  const originSrc = JSON.stringify({ ...a._source, flags: {} });
  const street = byName(a, "Streetwise"), wings = byName(a, "Glide Wings");
  const prop = { ops: [
    { opId: "t", kind: "removeItem", itemId: street.id },
    { opId: "p", kind: "addItem", ref: refOf("power", "Mind Static"), sourceItemId: byName(a, "Strange Meteor").id },
    { opId: "w", kind: "removeItem", itemId: wings.id, cascade: true },
    { opId: "f", kind: "updateActor", set: { "system.attributes.presence.value": 4 } }
  ] };
  const r = await W.apply(a, prop, { confirmed: true });
  assert.equal(r.ok, true, r.message);
  const st = W.undoStatus(a);
  assert.equal(st.available, true); assert.equal(st.runId, r.runId); assert.equal(st.clean, true);
  // presence 5 -> 4 lowers the Resolve max below the current value: the run re-clamps it (own journal entry)
  assert.deepEqual(st.runs[0].ops.map((o) => o.opId).sort(), ["_clamp", "f", "p", "t", "w", "w"].sort());
  const u1 = await W.undo(a, r.runId, { opIds: ["t"] });
  assert.equal(u1.ok, true, u1.message);
  assert.ok(a.items.has(street.id), "old id back"); assert.equal(a.items.get(street.id).name, "Streetwise");
  assert.ok(a.items.has(r.idMap.p), "other ops untouched");
  // undoing the cascade root restores the cascade with it, links intact
  const u2 = await W.undo(a, r.runId, { opIds: ["w"] });
  assert.equal(u2.ok, true);
  assert.equal(a.items.get(byName(a, "Silent Flight").id).system.power, wings.id);
  const st2 = W.undoStatus(a);
  assert.deepEqual(st2.runs[0].ops.map((o) => o.opId).sort(), ["_clamp", "f", "p"]);
  const u3 = await W.undo(a);
  assert.equal(u3.ok, true);
  assert.deepEqual(Object.keys(itemFps(a)).sort(), Object.keys(origin).sort(), "same item ids as before the run");
  for (const [id, fp] of Object.entries(origin)) assert.equal(fingerprint(a.items.get(id)._source), fp, `item ${a.items.get(id).name} identical`);
  assert.equal(JSON.stringify({ ...a._source, flags: {} }), originSrc);
  assert.equal(W.undoStatus(a).available, false);
});

await test("undo of an added power takes the boosts added under it (group), and of a source the powers added under it", async () => {
  const a = hero();
  const prop = { ops: [
    { opId: "s", kind: "addItem", ref: refOf("powerSource", "Tinkerer Genius") },
    { opId: "p", kind: "addItem", ref: refOf("power", "Spark Bolt"), sourceOpId: "s", note: "second" },
    { opId: "b", kind: "addItem", ref: refOf("boost", "Wider Arc", "Spark Bolt"), powerOpId: "p" },
    { opId: "t", kind: "addItem", ref: refOf("talent", "Tough Skin") }
  ] };
  const r = await W.apply(a, prop);
  assert.equal(r.ok, true, r.message);
  assert.equal(a.items.get(r.idMap.b).system.power, r.idMap.p);
  const u = await W.undo(a, r.runId, { opIds: ["s"] });
  assert.equal(u.ok, true);
  assert.ok(!a.items.has(r.idMap.s) && !a.items.has(r.idMap.p) && !a.items.has(r.idMap.b));
  assert.ok(a.items.has(r.idMap.t));
});

await test("undo drift: an item edited after apply needs confirmation", async () => {
  const a = hero();
  const r = await W.apply(a, { ops: [{ opId: "t", kind: "addItem", ref: refOf("talent", "Tough Skin") }, { opId: "x", kind: "updateActor", set: { "system.resources": 2 } }] });
  await a.updateEmbeddedDocuments("Item", [{ _id: r.idMap.t, name: "Tough Skin (renamed)" }]);
  const st = W.undoStatus(a);
  assert.equal(st.clean, false); assert.deepEqual(st.drift.map((d) => d.why), ["edited"]);
  const u = await W.undo(a, r.runId);
  assert.equal(u.ok, false); assert.equal(u.needsConfirm, true); assert.ok(a.items.has(r.idMap.t));
  const u2 = await W.undo(a, r.runId, { confirmDrift: true });
  assert.equal(u2.ok, true); assert.ok(!a.items.has(r.idMap.t)); assert.equal(a._source.system.resources, 3);
});

await test("rollback: a failure mid-write restores the actor exactly (ids and data)", async () => {
  for (const failAt of ["create", "updateItems", "delete", "update"]) {
    const a = hero();
    const origin = itemFps(a);
    const srcBefore = JSON.stringify(a._source.system);
    const prop = { ops: [
      { opId: "p", kind: "addItem", ref: refOf("power", "Quick Step"), sourceItemId: byName(a, "Strange Meteor").id },
      { opId: "u", kind: "updateItem", itemId: byName(a, "Spark Bolt").id, set: { level: "basic" } },
      { opId: "r", kind: "removeItem", itemId: byName(a, "Glide Wings").id, cascade: true },
      { opId: "f", kind: "updateActor", set: { "system.attributes.agility.value": 3 } }
    ] };
    let armed = false;
    const orig = a._maybeFail.bind(a);
    a._maybeFail = (what) => { if (armed && what === failAt) { armed = false; throw new Error(`boom ${what}`); } return orig(what); };
    // the lock write is an actor update: arm after it
    const realUpdate = a.update.bind(a);
    let n = 0;
    a.update = async (d) => { n++; if (n === 1) { const x = await realUpdate(d); armed = true; return x; } return realUpdate(d); };
    const r = await W.apply(a, prop, { confirmed: true });
    assert.equal(r.ok, false, failAt); assert.equal(r.rolledBack, true, `${failAt}: ${r.message}`);
    assert.deepEqual(Object.keys(itemFps(a)).sort(), Object.keys(origin).sort(), `${failAt}: ids`);
    for (const [id, fp] of Object.entries(origin)) assert.equal(fingerprint(a.items.get(id)._source), fp, `${failAt}: ${a.items.get(id).name}`);
    assert.equal(JSON.stringify(a._source.system), srcBefore, `${failAt}: actor fields`);
  }
});

await test("GM only, read-only documents, busy lock (ours and plus-ultra's)", async () => {
  const a = hero();
  const prop = { ops: [{ opId: "x", kind: "updateActor", set: { "system.resources": 5 } }] };
  const r = await mkWriter({ isGM: () => false }).apply(a, prop);
  assert.equal(r.ok, false); assert.equal(r.errors[0].code, "user.notGM"); assert.equal(a.calls.length, 0);
  const u = await mkWriter({ isGM: () => false }).undo(a);
  assert.equal(u.errors[0].code, "user.notGM");
  a.isOwner = false;
  assert.equal((await W.apply(a, prop)).errors[0].code, "doc.readOnly");
  a.isOwner = true;
  a._source.flags["invincible-plus-ultra"] = { chargenLock: { runId: "pu", userId: "u2", at: clock } };
  const b1 = await W.apply(a, prop);
  assert.equal(b1.busy, true);
  a._source.flags["invincible-plus-ultra"].chargenLock.at = clock - 100_000;
  assert.equal((await W.apply(a, prop)).ok, true, "stale lock ignored");
  // two applies at once in one client: the second is busy
  const slow = mkWriter({ sleep: () => new Promise((res) => setTimeout(res, 20)), lockSettle: 5 });
  const b = hero();
  const [x, y] = await Promise.all([slow.apply(b, prop), slow.apply(b, prop)]);
  assert.equal([x, y].filter((z) => z.busy).length, 1);
});

await test("whitelist: guarded actor fields, flags, custom only for gear/source, safe text, one rollAttack automation", async () => {
  const a = hero();
  const p = await W.plan(a, { ops: [
    { opId: "k", kind: "updateActor", set: { "system.karma": 3, "flags.x": 1, img: "evil.png", "system.derived.health.max": 99 } },
    { opId: "c", kind: "addItem", custom: { type: "power", name: "Homebrew" } },
    { opId: "g", kind: "addItem", custom: { type: "gear", name: "Hook", extraConfiguration: "alert(1)" } },
    { opId: "u", kind: "updateItem", itemId: byName(a, "Spark Bolt").id, set: { "system.automations": {} } },
    { opId: "n", kind: "updateItem", itemId: byName(a, "Echo Sense").id, set: { name: "Renamed" } }
  ] });
  const codes = p.errors.map((e) => e.code);
  for (const c of ["actor.field", "op.add.custom", "op.add.custom.field", "set.field", "set.name.type"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.equal(p.errors.filter((e) => e.code === "actor.field").length, 3);
  // karma / current Health / Resolve: allowed (the GM's click is the gate) but flagged in the preview (O25)
  const vit = await W.plan(a, { ops: [{ op: "updateActor", opId: "k", set: { karma: 3, health: 5 } }] });
  assert.equal(vit.ok, true); assert.equal(vit.warnings.filter((w) => w.code === "field.sensitive").length, 2);
  assert.deepEqual(vit.fields.map((f) => f.path).sort(), ["system.derived.health.value", "system.karma"]);
  assert.equal((await W.plan(a, { ops: [{ opId: "k", kind: "updateActor", set: { "system.karma": 3 } }] }, { allowVitals: true })).warnings.length, 0);
  const prop = { ops: [{ opId: "g", kind: "addItem", custom: { type: "gear", name: "Hook‮ gun", description: "Fires @UUID[Actor.x]{boom} and [[/r 1d6]] <script>x</script>", cost: 2, restricted: true, attack: { bonus: 1, damage: 2, minRange: 0, maxRange: 3, attribute: ["agility", "evil"] } } }] };
  const r = await W.apply(a, prop);
  assert.equal(r.ok, true, r.message);
  const g = a.items.get(r.idMap.g);
  assert.equal(g.name, "Hook gun");
  assert.ok(!g.system.description.includes("<script>")); assert.ok(g.system.description.includes("&lt;script&gt;"));
  assert.ok(!/@UUID\[/.test(g.system.description) && !g.system.description.includes("[[/r"));
  const autos = Object.values(g.system.automations);
  assert.equal(autos.length, 1); assert.equal(autos[0].type, "rollAttack");
  assert.deepEqual(Object.keys(autos[0]).sort(), ["_id", "actualDamage", "attribute", "baseDamage", "bypassArmor", "maxRange", "minRange", "name", "open", "origin", "rollBonus", "showAsSelection", "type"]);
  assert.deepEqual(autos[0].attribute, ["agility"]);
  assert.equal(g.img, undefined); assert.deepEqual(g._source.flags, {}); assert.deepEqual(g._source.effects, []);
  // gear edit in place: cost, attack on the existing automation, renamed, description appended; id kept
  const baton = byName(a, "Stun Baton");
  const r2 = await W.apply(a, { ops: [{ opId: "e", kind: "updateItem", itemId: baton.id, set: { name: "Shock Baton", descriptionAppend: "Upgraded.", gear: { cost: 3, attack: { damage: 4 } } } }] });
  assert.equal(r2.ok, true, r2.message);
  const b = a.items.get(baton.id);
  assert.equal(b.name, "Shock Baton"); assert.equal(b.system.cost, 3); assert.ok(b.system.description.endsWith("<p>Upgraded.</p>"));
  assert.equal(Object.values(b.system.automations)[0].baseDamage, 4); assert.equal(Object.values(b.system.automations)[0].rollBonus, 1);
  // undo removes an automation the run added (gear without one)
  const line = byName(a, "Grapple Line");
  const r3 = await W.apply(a, { ops: [{ opId: "e", kind: "updateItem", itemId: line.id, set: { gear: { attack: { damage: 1 } } } }] });
  assert.equal(Object.keys(a.items.get(line.id).system.automations).length, 1);
  await W.undo(a, r3.runId);
  assert.equal(Object.keys(a.items.get(line.id).system.automations).length, 0);
});

await test("Health/Resolve: re-clamped only when the new max is lower; undo restores", async () => {
  const a = hero();
  a._source.system.derived.health.value = 9;
  const r = await W.apply(a, { ops: [{ opId: "f", kind: "updateActor", set: { "system.attributes.fighting.value": 2 } }] });
  assert.equal(r.ok, true);
  assert.equal(a.system.derived.health.max, 7); assert.equal(a._source.system.derived.health.value, 7);
  assert.equal(a._source.system.derived.resolve.value, 8, "resolve untouched");
  await W.undo(a, r.runId);
  assert.equal(a._source.system.derived.health.value, 9); assert.equal(a._source.system.attributes.fighting.value, 6);
});

await test("validation hook: apply re-runs the pack validator and refuses on its errors", async () => {
  const a = hero();
  let seen = null;
  const w = mkWriter({ validate: async (doc, proposal, opts) => { seen = opts; return { ok: false, errors: [{ code: "attr.unspent", message: "3 points unspent" }] }; } });
  const r = await w.apply(a, { ops: [{ opId: "x", kind: "updateActor", set: { "system.resources": 5 } }] }, { profile: "in-play" });
  assert.equal(r.ok, false); assert.equal(r.errors[0].code, "attr.unspent"); assert.equal(seen.profile, "in-play");
  assert.equal(a._source.system.resources, 3);
});

await test("partial selection: dependants of an unticked op are dropped with it", async () => {
  const ops = [{ opId: "s", kind: "addItem", ref: "x" }, { opId: "p", kind: "addItem", ref: "y", sourceOpId: "s" }, { opId: "b", kind: "addItem", ref: "z", powerOpId: "p" }, { opId: "t", kind: "addItem", ref: "w" }];
  const r = selectOps(ops, ["p", "b", "t"]);
  assert.deepEqual(r.ops.map((o) => o.opId), ["t"]);
  assert.deepEqual(r.dropped.map((d) => [d.opId, d.because]), [["s", "unticked"], ["p", "s"], ["b", "p"]]);
  const a = hero();
  const p = await W.plan(a, { ops: [{ opId: "s", kind: "addItem", ref: refOf("powerSource", "Tinkerer Genius") }, { opId: "p", kind: "addItem", ref: refOf("power", "Echo Sense"), sourceOpId: "s" }, { opId: "t", kind: "addItem", ref: refOf("talent", "Tough Skin") }] }, { only: ["p", "t"] });
  assert.equal(p.ok, true); assert.deepEqual(p.creates.map((c) => c.opId), ["t"]); assert.equal(p.dropped.length, 2);
});

await test("replace -> ops: same build = nothing written; changed build keeps every matching item id", async () => {
  const a = hero();
  const st = chargenStateFromActor(a, {});
  // the state's names resolve to refs (as the model would send them)
  const withRefs = clone(st);
  for (const s of withRefs.sources) s.ref = refOf("powerSource", s.name);
  for (const pw of withRefs.powers) { pw.ref = refOf("power", pw.name); for (const b of pw.boosts) b.ref = refOf("boost", b.name, pw.name); for (const l of pw.limits) l.ref = refOf("limit", l.name, pw.name); }
  const conv = toOps(a, withRefs, cat);
  assert.deepEqual(conv.errors, []);
  assert.deepEqual(conv.ops.filter((o) => o.kind !== "updateActor"), [], JSON.stringify(conv.ops));
  // change: drop Echo Sense, add Quick Step at major, Spark Bolt to basic, new drawback
  const ids = new Map([...a.items.values()].map((i) => [i.name, i.id]));
  withRefs.powers = withRefs.powers.filter((pw) => pw.name !== "Echo Sense");
  withRefs.powers.find((pw) => pw.name === "Spark Bolt").level = 0;
  withRefs.powers.push({ key: "p9", name: "Quick Step", ref: refOf("power", "Quick Step"), level: 1, sourceKey: withRefs.sources[0].key, boosts: [], limits: [] });
  withRefs.drawbacks.push({ name: "Haunted", ref: refOf("drawback", "Haunted"), note: "ghost" });
  withRefs.attrs.fighting = 5;
  const p = await W.plan(a, { mode: "replace", proposal: withRefs });
  assert.equal(p.ok, true, JSON.stringify(p.errors)); assert.equal(p.derived, true);
  assert.deepEqual(p.deletes.map((d) => d.name), ["Echo Sense"]);
  assert.deepEqual(p.creates.map((c) => c.name).sort(), ["Haunted (ghost)", "Quick Step"]);
  assert.deepEqual(p.updates.map((u) => u.name), ["Spark Bolt"]);
  const r = await W.apply(a, { mode: "replace", proposal: withRefs }, { confirmed: true, expect: p.expect });
  assert.equal(r.ok, true, r.message);
  for (const [n, id] of ids) if (n !== "Echo Sense") assert.equal(a.items.get(id)?.name, n, `${n} kept its id`);
  assert.equal(a.items.get(ids.get("Spark Bolt")).system.level, "basic");
  // gear / injuries never touched by a replace
  for (const n of ["Grapple Line", "Stun Baton", "Pocket Camera"]) assert.ok(a.items.has(ids.get(n)));
});

await test("replace -> ops for an NPC (structure only), special abilities appended, gear kept", async () => {
  const a = new FakeActor(bigNpc(202, { customGear: 2, descLen: 100 }));
  const before = new Map([...a.items.values()].map((i) => [i.id, i.name]));
  const prop = {
    name: "The Clockmaster", attributes: { fighting: 5, agility: 4, strength: 6, reason: 9, intuition: 7, presence: 6 },
    sources: [{ key: "blood", ref: refOf("powerSource", "Ancient Bloodline") }],
    powers: [{ key: "bolt", ref: refOf("power", "Spark Bolt"), level: "major", source: "blood" }, { key: "hide", ref: refOf("power", "Iron Hide"), level: "major", source: "blood" }],
    boosts: [{ ref: refOf("boost", "Wider Arc", "Spark Bolt"), power: "bolt" }], limits: [],
    talents: [{ name: "Quick Wits" }], drawbacks: [], texts: { personality: "Patient, Vain" }, specialAbilities: "Rewinds a second once per scene."
  };
  const p = await W.plan(a, { mode: "replace", proposal: prop });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  const kept = [...before].filter(([id]) => p.keeps.some((k) => k.id === id) || p.updates.some((u) => u.itemId === id)).map(([, n]) => n);
  for (const n of ["Ancient Bloodline", "Spark Bolt", "Quick Wits", "Cracked Mainspring", "Contraption A"]) assert.ok(kept.includes(n), `${n} kept`);
  assert.ok(p.fields.some((f) => f.path === "system.biography" && f.to.includes("Rewinds a second")));
  assert.ok(p.deletes.some((d) => d.name === "Gearwright"));
});

await test("item drawer (gear): in-place edit with whitelist, undo; newItem creates a world item", async () => {
  const src = { _id: "gearAAAAAAAAAAAA", name: "Grapple Line", type: "gear", system: { description: "<p>old</p>", cost: 1, restricted: false, singleUse: false, automations: {} }, flags: {}, effects: [] };
  const it = new FakeItem(clone(src), null);
  it.isOwner = true;
  const p = await W.plan(it, { proposal: { name: "Grapple Line Mk II", description: "New line.", cost: 2, attack: { damage: 1, maxRange: 2 } } });
  assert.equal(p.ok, true, JSON.stringify(p.errors)); assert.equal(p.mode, "item");
  assert.ok(p.fields.some((f) => f.path === "system.cost" && f.to === 2));
  const r = await W.apply(it, { proposal: { name: "Grapple Line Mk II", description: "New line.", cost: 2, attack: { damage: 1, maxRange: 2 } } }, { expect: p.expect });
  assert.equal(r.ok, true, r.message);
  assert.equal(it.name, "Grapple Line Mk II"); assert.equal(Object.keys(it.system.automations).length, 1);
  assert.equal(W.undoStatus(it).available, true);
  const u = await W.undo(it, r.runId);
  assert.equal(u.ok, true, u.message);
  assert.equal(it.name, "Grapple Line"); assert.equal(it.system.cost, 1); assert.equal(it.system.description, "<p>old</p>");
  assert.equal(Object.keys(it.system.automations).length, 0);
  const bad = await W.plan(it, { proposal: { name: "x", effects: [{}] } });
  assert.equal(bad.ok, false);
  // newItem
  const made = [];
  const w = mkWriter({ createWorldItem: async (data) => { const d = new FakeItem({ ...clone(data), _id: "worldIIIIIIIIIII" }, null); made.push(d); return d; }, fromUuid: async (uuid) => made.find((m) => m.uuid === uuid) ?? null });
  const r2 = await w.apply(it, { target: "newItem", proposal: { name: "Spare Hook", cost: 1, description: "Spare." } });
  assert.equal(r2.ok, true, r2.message); assert.equal(made[0].name, "Spare Hook"); assert.equal(made[0].type, "gear");
  const u2 = await w.undo(it, r2.runId);
  assert.equal(u2.ok, true); assert.equal(made[0].deleted, true);
});

await test("journal: newest 10 runs, 24 h TTL, size cap keeps the newest", () => {
  const runs = Array.from({ length: 13 }, (_, i) => ({ runId: `r${i}`, at: 1_000 + i, ops: [{ opId: "x", kind: "add", itemId: "a" }] }));
  const { journal } = pruneJournal({ runs }, 2_000);
  assert.equal(journal.runs.length, UNDO_RUNS); assert.equal(journal.runs.at(-1).runId, "r12");
  const { journal: j2 } = pruneJournal({ runs }, 1_012 + UNDO_TTL + 1);
  assert.equal(j2.runs.length, 0);
  const big = [{ runId: "old", at: 5, ops: [{ opId: "x", kind: "remove", before: { d: "x".repeat(300_000) } }] }, { runId: "new", at: 6, ops: [{ opId: "y", kind: "remove", before: { d: "y".repeat(300_000) } }] }];
  const { journal: j3, dropped } = pruneJournal({ runs: big }, 10);
  assert.deepEqual(j3.runs.map((r) => r.runId), ["new"]); assert.deepEqual(dropped, ["old"]);
});

await test("expired run: undo refuses, status not available", async () => {
  let t = clock;
  const w = mkWriter({ now: () => t });
  const a = hero();
  const r = await w.apply(a, { ops: [{ opId: "x", kind: "updateActor", set: { "system.resources": 5 } }] });
  assert.equal(r.ok, true);
  t += UNDO_TTL + 10;
  assert.equal(w.undoStatus(a).available, false);
  const u = await w.undo(a, r.runId);
  assert.equal(u.ok, false); assert.equal(u.errors[0].code, "undo.expired");
});

await test("levelFlips follows plus-ultra's level rule", () => {
  const sys = { automations: { a: { _id: "a", name: "Basic Bolt", type: "rollAttack", showAsSelection: true }, b: { _id: "b", name: "Major Bolt", type: "rollAttack", showAsSelection: false }, c: { _id: "c", name: "Basic", type: "usePower", showAsSelection: true }, d: { _id: "d", name: "Major", type: "usePower", showAsSelection: false } } };
  const f = levelFlips(sys, "major", true);
  assert.deepEqual(f.map((x) => x.id).sort(), ["b", "c", "d"]);
  assert.equal(sys.automations.a.showAsSelection, true); assert.equal(sys.automations.c.showAsSelection, false);
});

/* ---------------------------------------------------------------- plus-ultra bridge */
await test("bridge without plus-ultra: everything degrades, nothing throws", async () => {
  const game = { modules: new Map(), user: { isGM: true } };
  const b = createBridge({ game: () => game, getCatalog: async () => cat, refToUuid: () => null, hooks: () => null });
  assert.equal(b.status().usable, false);
  assert.equal((await b.selfTest()).ok, false);
  const r = await b.fullRebuild.apply({ type: "superhero" }, {});
  assert.equal(r.ok, false); assert.equal(r.unavailable, true);
  assert.deepEqual(await b.lists("archetype"), []);
  assert.equal(b.canOpenWizard({ type: "superhero" }), false);
  assert.equal(await b.openWizard({ type: "superhero" }), null);
  assert.equal(typeof b.installWizardButton(() => {}), "function");
  assert.equal(b.fullRebuild.undoStatus({}).available, false);
});

await test("bridge with a fake plus-ultra: self-test, refs -> packUuid, full rebuild delegates, lists, wizard", async () => {
  const calls = [];
  const chargen = {
    apply: {
      async plan(actor, state) { calls.push(["plan", actor.type, state]); return actor.type !== "superhero" ? { ok: false, errors: [{ code: "WrongType" }] } : { ok: true, deletes: [] }; },
      async apply(actor, state, o) { calls.push(["apply", state, o]); return { ok: true, runId: "pu1" }; },
      async undo(actor, o) { calls.push(["undo", o]); return { ok: true }; },
      undoStatus() { return { available: true }; }
    },
    catalog: {}, provider: () => ({ list: async (k) => (k === "archetypes" ? [{ name: "Speedster" }, { name: "" }] : [{ name: "Courier", data: { resources: 3 } }]) }),
    open: async (actor, o) => { calls.push(["open", o]); return { id: "w" }; }, canUse: () => true
  };
  const game = { modules: new Map([["invincible-plus-ultra", { active: true, version: "0.20.2", api: { chargen } }]]), user: { isGM: true } };
  const { refToUuid } = await import("../scripts/systems/invincible/catalog.mjs");
  const b = createBridge({ game: () => game, getCatalog: async () => cat, refToUuid, hooks: () => null });
  assert.equal((await b.selfTest()).ok, true);
  assert.equal(b.status().usable, true);
  const state = { rank: "global", sources: [{ key: "s1", ref: refOf("powerSource", "Strange Meteor") }], powers: [{ key: "p1", ref: refOf("power", "Iron Hide"), level: 1, sourceKey: "s1", boosts: [], limits: [] }], heroTalent: { ref: refOf("talent", "Quick Wits") }, drawbacks: [] };
  const r = await b.fullRebuild.apply({ type: "superhero" }, { proposal: state }, { confirmed: true });
  assert.equal(r.ok, true);
  const sent = calls.find((c) => c[0] === "apply")[1];
  assert.match(sent.sources[0].packUuid, /^Compendium\.invincible-core\.power-sources\.Item\./);
  assert.equal(sent.sources[0].name, "Strange Meteor");
  const majorId = cat.findByName("power", "Iron Hide").levelDocs.major;
  assert.equal(sent.powers[0].packUuid, `Compendium.invincible-core.powers.Item.${majorId}`);
  assert.equal(sent.heroTalent.name, "Quick Wits"); assert.ok(!("ref" in sent.heroTalent));
  assert.ok(sent.locks && typeof sent.locks === "object" && sent.seed, "UI fields filled from createState");
  assert.deepEqual(await b.lists("archetype"), [{ name: "Speedster" }]);
  assert.deepEqual(await b.lists("occupations"), [{ name: "Courier", data: { resources: 3 } }]);
  assert.equal(b.canOpenWizard({ type: "superhero" }), true); assert.equal(b.canOpenWizard({ type: "npc" }), false);
  await b.openWizard({ type: "superhero" }, state);
  assert.ok(calls.find((c) => c[0] === "open")[1].state.powers[0].packUuid);
  // a plus-ultra whose plan no longer answers as expected switches the extras off
  chargen.apply.plan = async () => ({ ok: true });
  assert.equal((await b.selfTest()).ok, false); assert.equal(b.status().usable, false);
  assert.equal((await b.fullRebuild.apply({ type: "superhero" }, { proposal: state })).unavailable, true);
});

/* ---------------------------------------------------------------- the validator's format (T5, proposal.mjs / validate.mjs) */
const T5 = await import("../scripts/systems/invincible/validate.mjs").catch(() => null);
const T5P = await import("../scripts/systems/invincible/proposal.mjs").catch(() => null);
await test("validator format: `op` key, structured updateActor set, boost re-point, deselect", async () => {
  const a = hero();
  const bolt = byName(a, "Spark Bolt"), silent = byName(a, "Silent Flight");
  const prop = { target: "this", mode: "ops", rationale: "x", ops: [
    { op: "updateActor", opId: "a", set: { attributes: { fighting: 7 }, texts: { drive: "Protect the pier" }, resources: 4 } },
    { op: "updateItem", opId: "b", itemId: silent.id, set: { powerItemId: bolt.id } },
    { op: "addItem", opId: "c", ref: refOf("talent", "Tough Skin") }
  ] };
  const p = await W.plan(a, prop, { deselect: ["c"] });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.deepEqual(p.fields.map((f) => f.path).sort(), ["system.attributes.fighting.value", "system.drive", "system.resources"]);
  assert.deepEqual(p.dropped.map((d) => d.opId), ["c"]);
  const r = await W.apply(a, prop, { deselect: ["c"] });
  assert.equal(r.ok, true, r.message);
  assert.equal(a.items.get(silent.id).system.power, bolt.id);
  assert.equal(a._source.system.drive, "Protect the pier");
  assert.equal(Object.keys(r.idMap).length, 0);
});
await test("validator replaceToOps output plans and applies in place (ids kept)", async () => {
  if (!T5P?.replaceToOps) { console.log("     (skipped: proposal.mjs not present)"); return; }
  const a = hero();
  const ids = new Map([...a.items.values()].map((i) => [i.name, i.id]));
  const src = byName(a, "Strange Meteor");
  const P = {
    name: "Amber Kestrel", attributes: { fighting: 6, agility: 7, strength: 5, reason: 5, intuition: 5, presence: 5 },
    sources: [{ key: "s", ref: refOf("powerSource", "Strange Meteor") }],
    powers: [{ ref: refOf("power", "Glide Wings"), level: "basic", source: "s", boosts: [{ ref: refOf("boost", "Silent Flight", "Glide Wings") }] },
      { ref: refOf("power", "Spark Bolt"), level: "basic", source: "s", limits: [{ ref: refOf("limit", "Needs Charging", "Spark Bolt"), grants: "boost" }] },
      { ref: refOf("power", "Quick Step"), level: "basic", source: "s" }],
    talents: [{ ref: refOf("talent", "Quick Wits") }, { ref: refOf("talent", "Streetwise") }], drawbacks: [{ ref: refOf("drawback", "Lean Times") }]
  };
  const conv = T5P.replaceToOps(a, P, { catalog: cat });
  assert.deepEqual(conv.errors, []);
  const w = mkWriter({ toOps: (doc, prop, c) => T5P.replaceToOps(doc, prop, { catalog: c }) });
  const p = await w.plan(a, { mode: "replace", proposal: P });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.deepEqual(p.deletes.map((d) => d.name), ["Echo Sense"]);
  assert.deepEqual(p.creates.map((c) => c.name), ["Quick Step"]);
  const r = await w.apply(a, { mode: "replace", proposal: P }, { confirmed: true, expect: p.expect });
  assert.equal(r.ok, true, r.message);
  for (const [n, id] of ids) if (n !== "Echo Sense") assert.ok(a.items.has(id), `${n} kept`);
  assert.equal(a.items.get(r.idMap[p.creates[0].opId]).system.powerSource, src.id);
});
await test("validator pipeline (T5 validateProposal) calls this writer's plan as its L3 dry run", async () => {
  if (!T5?.validateProposal) { console.log("     (skipped: validate.mjs not present)"); return; }
  const { makeLookup } = await import("./fixtures/invincible-sheets.mjs");
  const a = hero();
  const calls = [];
  const plan = async (doc, prop, o) => { calls.push(o); return W.plan(doc, prop, o); };
  const input = { target: "this", mode: "ops", rationale: "test", ops: [{ op: "addItem", opId: "c", ref: refOf("boost", "Wider Arc", "Spark Bolt"), powerItemId: byName(a, "Spark Bolt").id }] };
  const res = await T5.validateProposal(a, input, { catalog: cat, lookup: makeLookup(), plan, profile: "in-play" });
  assert.equal(calls.length, 1, `writer plan called (layer ${res.layer}, errors ${JSON.stringify(res.errors)})`);
  assert.ok(res.plan?.creates?.length === 1 || res.layer !== "L4", JSON.stringify(res.errors));
  // a writer-only error comes back through the validator
  const bad = { ...input, ops: [{ op: "removeItem", opId: "r", itemId: byName(a, "Glide Wings").id }] };
  const res2 = await T5.validateProposal(a, bad, { catalog: cat, lookup: makeLookup(), plan, profile: "in-play" });
  assert.equal(res2.ok, false);
});

/* ---------------------------------------------------------------- pack contract */
await test("pack.mjs: writer group complete, selfTest hook, contract valid", async () => {
  const { validatePack } = await import("../scripts/build/registry.mjs");
  const pack = (await import("../scripts/systems/invincible/pack.mjs")).default;
  const v = validatePack(pack);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.capabilities.writer, true);
  assert.equal(typeof pack.selfTest, "function");
  pack.init({ game: { modules: new Map(), system: { id: "invincible" }, user: { isGM: true } } });
  assert.deepEqual(await pack.selfTest(), { ok: true, skipped: true, plusUltra: pack.plusUltra.status() });
  assert.equal(typeof pack.plusUltra.fullRebuild.apply, "function");
});

await test("live regressions (lane 20): nested _stats ignored by the fingerprint; actor journal survives Foundry's key expansion", async () => {
  const a = { name: "X", type: "drawback", system: { description: "d" }, effects: [{ _id: "e1", name: "fx", _stats: { createdTime: 1 } }], _stats: { createdTime: 1 } };
  const b = { ...JSON.parse(JSON.stringify(a)), effects: [{ _id: "e1", name: "fx", _stats: { createdTime: 2 } }], _stats: { createdTime: 2 }, sort: 5 };
  assert.equal(fingerprint(a), fingerprint(b), "re-created item (keepId) is not drift");
  assert.notEqual(fingerprint(a), fingerprint({ ...b, name: "Y" }));
  // apply an updateActor, then a whole-run undo: the attribute must come back (the stored entry is nested by the fake's expand)
  const act = hero();
  const before = act.system.attributes.fighting.value;
  const r = await W.apply(act, { ops: [{ opId: "x", kind: "updateActor", set: { attributes: { fighting: before === 6 ? 5 : 6 } } }] }, { confirmed: true });
  assert.equal(r.ok, true, r.message);
  const stored = act._source.flags["moinens-ai-gen"].undo.runs[0].ops[0];
  assert.ok(stored.after.system, "stored nested (as Foundry does)");
  assert.equal(W.undoStatus(act).clean, true, "no false drift");
  const u = await W.undo(act, r.runId);
  assert.equal(u.ok, true, u.message);
  assert.equal(act.system.attributes.fighting.value, before);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
