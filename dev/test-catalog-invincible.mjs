// Invincible catalogue + read tools tests (spec 6, 9; task T4). Node, no Foundry, no network.
// Run: node dev/test-catalog-invincible.mjs (from the module folder)
// The fixture is INVENTED placeholder data (names, ids, texts): no rulebook text and no system/pack data in this file.
// Live check against the real compendia: dev/live-catalog-invincible.js (prints sizes and counts only).
import assert from "node:assert/strict";
import {
  buildCatalog, indexText, search, getEntries, htmlToText, summaryOf, cut, h2Sections, refToUuid, KINDS, bookMaxLevel, hash
} from "../scripts/systems/invincible/catalog.mjs";
import { rulesDigest, readRules, RULE_TOPICS, TOPIC_KEYS, splitParts } from "../scripts/systems/invincible/rules-digest.mjs";
import { readToolDefs, makeReadTools, readDocument, toolResultText } from "../scripts/systems/invincible/tools.mjs";
import { promptGroup } from "../scripts/systems/invincible/prompt.mjs";
import { powerMaxLevel } from "../scripts/systems/invincible/vendor/chargen/rules.mjs";
import { validatePack } from "../scripts/build/registry.mjs";
import invPack from "../scripts/systems/invincible/pack.mjs";
import { estimateTokens } from "../scripts/anthropic/pricing.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

/* ---------------------------------------------------------------- invented fixture */
const id = (s) => (s + "0000000000000000").slice(0, 16);
const SCRIPT = "console.log('SECRET-SCRIPT-BODY')";
const P = (t) => `<p>${t}</p>`;
function fixture({ shuffle = false, quickstartBook = false } = {}) {
  const packs = {
    powers: {
      folders: [{ id: "fAtk", name: "Attack Powers", parent: null }, { id: "fMov", name: "Movement Powers", parent: null }, { id: "fZap", name: "Zap Wall", parent: "fAtk" }],
      docs: [
        { _id: id("pwrGlide"), name: "Glide Step", type: "power", folder: "fMov", system: { level: "", description: P("Alpha placeholder sentence about moving. More words here.") + P("Major: bigger placeholder.") + P("Massive: biggest placeholder."), automations: { a1: { type: "usePower", name: "Basic", showAsSelection: true, extraConfiguration: "" } } }, effects: [] },
        { _id: id("pwrZapB"), name: "Zap Wall", type: "power", folder: "fZap", system: { level: "basic", description: P("Zap placeholder basic text &amp; more."), automations: { a: { type: "rollAttack", name: "Zap", rollBonus: 1, baseDamage: 2, minRange: 0, maxRange: 2, extraConfiguration: SCRIPT } } }, effects: [] },
        { _id: id("pwrZapM"), name: "Zap Wall", type: "power", folder: "fZap", system: { level: "major", description: P("Zap placeholder major text.") }, effects: [] },
        { _id: id("pwrZapX"), name: "Zap Wall", type: "power", folder: "fZap", system: { level: "massive", description: P("Zap placeholder massive text.") }, effects: [] },
        { _id: id("pwrEcho"), name: "Écho Sense", type: "power", folder: "fAtk", system: { level: "", description: P("Echo placeholder. " + "Long filler text. ".repeat(300)) }, effects: [{ name: "Echo fx", changes: [{ key: "system.derived.health.bonus", type: "add", value: 1 }] }] }
      ]
    },
    boosts: {
      folders: [{ id: "bG", name: "Glide Step", parent: null }, { id: "bZ", name: "Zap Wall", parent: null }],
      docs: [
        { _id: id("bstFar"), name: "Far Reach (Glide)", type: "boost", folder: "bG", system: { description: P("Boost placeholder one."), extraConfiguration: SCRIPT } },
        { _id: id("bstWide"), name: "Wide Zap", type: "boost", folder: "bZ", system: { description: P("Boost placeholder two.") } }
      ]
    },
    limits: { folders: [{ id: "lZ", name: "Zap Wall", parent: null }], docs: [{ _id: id("limSlow"), name: "Slow Zap", type: "limit", folder: "lZ", system: { description: P("Limit placeholder.") } }] },
    "power-sources": { folders: [], docs: [{ _id: id("srcOdd"), name: "Odd Accident", type: "powerSource", system: { description: P("Source placeholder | with pipe.") } }] },
    talents: { folders: [], docs: [{ _id: id("talQuick"), name: "Quick Placeholder", type: "talent", system: { description: P("Talent placeholder.") }, effects: [] }] },
    drawbacks: { folders: [], docs: [
      { _id: id("drwFrail"), name: "Frail Thing", type: "drawback", system: { description: P("Tie it to a power source (choose one) placeholder.") } },
      { _id: id("drwPlain"), name: "Plain Trouble", type: "drawback", system: { description: P("Plain placeholder.") } }
    ] },
    gears: { folders: [{ id: "gW", name: "Weapons", parent: null }, { id: "gV", name: "Vehicle Weapons", parent: null }], docs: [
      { _id: id("gerStick"), name: "Placeholder Stick", type: "gear", folder: "gW", system: { description: P("Gear placeholder."), cost: 1, restricted: false, singleUse: false, automations: { x: { type: "rollAttack", rollBonus: 1, baseDamage: 2, minRange: 0, maxRange: 0 } } } },
      { _id: id("gerCannon"), name: "Placeholder Cannon", type: "vehicleWeapon", folder: "gV", system: { description: P("Vehicle gun placeholder."), cost: 3, restricted: true, automations: {} } }
    ] },
    "npcs-creatures": { folders: [{ id: "nN", name: "NPCs", parent: null }, { id: "nM", name: "Minions", parent: null }], docs: [
      { _id: id("npcThug"), name: "Placeholder Thug", type: "npc", folder: "nN", system: { attributes: { fighting: { value: 3 } } }, items: [{ _id: id("npcThugI1"), type: "power", name: "Glide Step", system: { level: "major" } }] },
      { _id: id("minGang"), name: "Placeholder Gang", type: "minions", folder: "nM", system: {}, items: [] }
    ] },
    "heroes-villans": { folders: [], docs: [{ _id: id("heroSample"), name: "Sample Placeholder", type: "superhero", system: { attributes: { agility: { value: 5 } }, biography: P("Hero bio placeholder.") }, items: [{ _id: id("heroI1"), type: "power", name: "Zap Wall", system: { level: "basic" } }] }] }
  };
  const archHtml = "<h2>The Placeholder Hero</h2><p>Archetype one placeholder sentence. Second.</p><p>Role: Striker</p><h2>The Other Mock</h2><ul><li>item a</li><li>item b</li></ul>";
  const occHtml = "<h2>Mock Job</h2><p>Occupation placeholder text.</p><h2>Fake Trade</h2><p>Another placeholder.</p>";
  const pages = {
    "0FCrBQzpjPzPkxWi": { name: "Archetypes", html: archHtml },
    "0YDxkdD5Fw55l8ig": { name: "Occupation", html: occHtml },
    "qmOhEV4M6DCQuMyC": { name: "2: Your Superhero", html: P("Overview placeholder. ") + ("<p>" + "Filler paragraph placeholder words. ".repeat(40) + "</p>").repeat(12) },
    "R9r1Q30fr2xjoeK0": { name: "Your Hero’s Growth", html: P("Growth placeholder @UUID[Compendium.x.y.Item.abc]{Linked Name} end.") }
  };
  const order = (a) => (shuffle ? [...a].reverse() : a);
  const reads = [];
  const source = {
    reads,
    has: (p) => p === "core-book" || !!packs[p],
    async index(p, fields) { reads.push(`index:${p}`); return order(packs[p]?.docs ?? []).map((d) => ({ ...d, _stats: { modifiedTime: 1000 } })); },
    folders: (p) => order(packs[p]?.folders ?? []),
    async document(p, docId) { reads.push(`doc:${p}:${docId}`); const d = packs[p]?.docs.find((x) => x._id === docId); return d ? structuredClone(d) : null; },
    async page(j, pageId, pageName) {
      reads.push(`page:${pageId}`);
      const pg = pages[pageId];
      if (!pg) return null;
      return { name: pg.name, journal: quickstartBook ? "Quickstart" : "2: Your Superhero", html: pg.html };
    }
  };
  return { source, packs };
}

/* ---------------------------------------------------------------- text helpers */
await test("htmlToText: structure kept, enricher labels, entities, no tags", () => {
  const t = htmlToText("<h3>Head</h3><p>A &amp; B&nbsp;c @UUID[Compendium.a.b.Item.x]{Label} @Check[agility]</p><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table><script>x()</script>");
  assert.ok(!/[<>]/.test(t), t);
  assert.match(t, /## Head/); assert.match(t, /A & B c Label agility/); assert.match(t, /- one\n- two/); assert.match(t, /a \| b/);
  assert.ok(!t.includes("x()"));
});
await test("summaryOf / cut / h2Sections / bookMaxLevel", () => {
  assert.equal(summaryOf("First sentence here. Second one."), "First sentence here.");
  assert.equal(summaryOf("one two three four five six seven eight nine ten eleven twelve thirteen fourteen."), "one two three four five six seven eight nine ten eleven twelve…");
  assert.ok(!summaryOf("a | b").includes("|"));
  assert.match(cut("x".repeat(50) + " tail", 20), /\(truncated, 55 chars\)$/);
  assert.deepEqual(h2Sections("<p>pre</p><h2>A</h2><p>a</p><h2 class='x'>B &amp; C</h2><p>b</p>").map((s) => s.name), ["A", "B & C"]);
  assert.equal(bookMaxLevel("<p>Major: x</p><p>Massive: y</p>"), 2);
  assert.equal(bookMaxLevel("<p>No levels.</p>"), 0);
  assert.equal(hash("abc"), hash("abc")); assert.notEqual(hash("abc"), hash("abd"));
});

/* ---------------------------------------------------------------- catalogue */
const { source } = fixture();
const cat = await buildCatalog(source);
await test("build: kinds, refs, split powers, folders, needs, gear split, npc filter, book sections", () => {
  assert.deepEqual(cat.meta.counts, { power: 3, boost: 2, limit: 1, powerSource: 1, talent: 1, drawback: 2, gear: 1, vehicleWeapon: 1, archetype: 2, occupation: 2, npcProfile: 1, sampleHero: 1 });
  assert.deepEqual(cat.meta.missing, []);
  const zap = cat.findByName("power", "Zap Wall");
  assert.equal(zap.split, true); assert.equal(zap.maxLevel, 2); assert.equal(zap.ref, `powers:${id("pwrZapB")}`); assert.equal(zap.type, "Attack");
  const glide = cat.findByName("power", "glide step");
  assert.equal(glide.maxLevel, 2); assert.equal(glide.split, false); assert.equal(glide.type, "Movement");
  assert.equal(cat.get(`powers:${id("pwrZapM")}`), zap, "level ref resolves to its power");
  assert.equal(cat.levelOf(`powers:${id("pwrZapM")}`), "major");
  assert.equal(cat.findByName("boost", "Far Reach").power, "Glide Step", "boost power = folder name; base-name match");
  assert.deepEqual(cat.boostsFor("Zap Wall").map((b) => b.name), ["Wide Zap"]);
  assert.equal(cat.findByName("drawback", "Frail Thing").needs, "source");
  assert.equal(cat.findByName("drawback", "Plain Trouble").needs, undefined);
  assert.equal(cat.findByName("vehicleWeapon", "Placeholder Cannon").gear.restricted, true);
  assert.deepEqual(cat.findByName("gear", "Placeholder Stick").gear.attack, { bonus: 1, damage: 2, range: null });
  assert.equal(cat.byKind("npcProfile").length, 1, "minions are not NPC profiles");
  assert.equal(cat.get(`npcs:${id("npcThug")}`).summaryText, "powers: Glide Step");
  const arch = cat.byKind("archetype");
  assert.deepEqual(arch.map((a) => a.ref), ["archetype:other-mock", "archetype:placeholder-hero"]);
  assert.equal(cat.get("archetype:placeholder-hero").type, "Striker");
  assert.equal(cat.get("archetype:placeholder-hero").name, "Placeholder Hero");
  assert.equal(refToUuid(cat, `powers:${id("pwrZapM")}`), `Compendium.invincible-core.powers.Item.${id("pwrZapM")}`);
  assert.equal(refToUuid(cat, `heroes:${id("heroSample")}`), `Compendium.invincible-core.heroes-villans.Actor.${id("heroSample")}`);
  assert.equal(refToUuid(cat, "archetype:other-mock"), null);
  for (const e of cat.entries) assert.ok(KINDS.includes(e.kind));
});
await test("build feeds the VENDORED rules' power max levels (spec 8.2)", () => {
  assert.equal(powerMaxLevel({ name: "Zap Wall" }), 2);
  assert.equal(powerMaxLevel({ name: "Écho Sense" }), 0);
});
await test("index text: byte-stable across builds and source order; every ref present; no sheet/world data; no HTML", async () => {
  const a = indexText(cat);
  const b = indexText(await buildCatalog(fixture({ shuffle: true }).source));
  assert.equal(a, b);
  for (const e of cat.entries) assert.ok(a.includes(`${e.ref}|`), e.ref);
  assert.ok(!/<(?!\/?catalog>)[a-z]/i.test(a), "no HTML tags except the catalog wrapper");
  assert.ok(!/<sheet/i.test(a));
  assert.match(a, /^@Zap Wall$/m, "boosts grouped under their power");
  assert.ok(!a.includes("Source placeholder | with"), "pipes inside summaries are replaced");
  assert.equal(cat.meta.sourceFingerprint, (await buildCatalog(fixture({ shuffle: true }).source)).meta.sourceFingerprint);
});
await test("search: exact first, accent-insensitive, kinds, forPower, limit cap", () => {
  assert.equal(search(cat, { query: "zap wall" }).results[0].name, "Zap Wall");
  assert.equal(search(cat, { query: "echo" }).results[0].name, "Écho Sense");
  assert.ok(search(cat, { query: "placeholder", kinds: ["talent"] }).results.every((r) => r.kind === "talent"));
  const fp = search(cat, { query: "", forPower: "Zap Wall" });
  assert.deepEqual(fp.results.map((r) => r.name).sort(), ["Slow Zap", "Wide Zap"]);
  assert.deepEqual(search(cat, { query: "", forPower: `powers:${id("pwrZapB")}` }).results.length, 2, "forPower accepts a ref");
  assert.equal(search(cat, { query: "placeholder", limit: 99 }).results.length <= 25, true);
  assert.deepEqual(search(cat, { query: "zap", kinds: ["power"] }).results[0].levels, ["basic", "major", "massive"]);
});
await test("get_entries: plain rules text, cap marker, split levels, automations without script body, effects, unknown refs", async () => {
  const r = await getEntries(cat, source, [`powers:${id("pwrZapB")}`, `powers:${id("pwrEcho")}`, `boosts:${id("bstFar")}`, "powers:nope", "archetype:placeholder-hero", `heroes:${id("heroSample")}`]);
  assert.deepEqual(r.unknown, ["powers:nope"]);
  const [zap, echo, far, arch, hero] = r.entries;
  assert.deepEqual(zap.levels, { basic: `powers:${id("pwrZapB")}`, major: `powers:${id("pwrZapM")}`, massive: `powers:${id("pwrZapX")}` });
  assert.equal(zap.rulesText, "Zap placeholder basic text & more.");
  assert.deepEqual(zap.automations, [{ type: "rollAttack", name: "Zap", bonus: 1, damage: 2, range: "0-2", script: true }]);
  assert.match(echo.rulesText, /\(truncated, \d+ chars\)$/); assert.ok(echo.rulesText.length < 2600);
  assert.deepEqual(echo.effects, [{ name: "Echo fx", changes: [{ key: "system.derived.health.bonus", type: "add", value: 1 }] }]);
  assert.equal(far.script, true); assert.equal(far.power, "Glide Step"); assert.match(far.slotNote, /1 power slot/);
  assert.match(arch.rulesText, /Archetype one placeholder/); assert.ok(!arch.rulesText.includes("Other Mock"), "section ends at the next h2");
  assert.equal(hero.attributes.agility, 5); assert.deepEqual(hero.items, [{ type: "power", name: "Zap Wall", level: "basic" }]);
  assert.ok(!JSON.stringify(r).includes("SECRET-SCRIPT-BODY"));
  const many = await getEntries(cat, source, Array.from({ length: 12 }, () => `talents:${id("talQuick")}`).concat([`sources:${id("srcOdd")}`]));
  assert.equal(many.entries.length, 2, "deduped, max 8 refs");
});
await test("get_entries: archetype gets plus-ultra structured data when the extra is present", async () => {
  const r = await getEntries(cat, source, ["archetype:placeholder-hero"], { extras: { archetype: async () => ({ role: "Striker", attrs: { fighting: 5 }, powers: [{ name: "Zap Wall", level: 1, boosts: [{ name: "Wide Zap" }] }] }) } });
  assert.deepEqual(r.entries[0].structured.powers[0], { name: "Zap Wall", level: "major", ref: `powers:${id("pwrZapB")}`, boosts: [{ name: "Wide Zap", ref: `boosts:${id("bstWide")}` }] });
});

/* ---------------------------------------------------------------- rules */
await test("rules digest: deterministic, numbers from the vendored rules, no sheet, sane size", () => {
  const d = rulesDigest();
  assert.equal(d, rulesDigest());
  assert.match(d, /global\|Global Guardian\|32\|10\|4\|2\|2/);
  assert.match(d, /cosmic\|Cosmic Champion\|38\|12\|5\|3\|3/);
  assert.ok(!/<sheet/i.test(d));
  assert.ok(estimateTokens(d) < 4000);
});
await test("read_rules: whitelist only, parts, enricher labels, Quickstart refused, unknown topic", async () => {
  assert.ok(TOPIC_KEYS.every((k) => !/quickstart/i.test(k + RULE_TOPICS[k].name)));
  const r1 = await readRules(source, { topic: "creation_overview" });
  assert.equal(r1.ok, true); assert.ok(r1.parts > 1); assert.ok(r1.text.length <= 6000); assert.match(r1.more, /part 2/);
  const last = await readRules(source, { topic: "creation_overview", part: 99 });
  assert.equal(last.part, r1.parts); assert.equal(last.more, undefined);
  const g = await readRules(source, { topic: "growth" });
  assert.match(g.text, /Growth placeholder Linked Name end\./);
  assert.equal((await readRules(source, { topic: "nope" })).ok, false);
  assert.equal((await readRules(source, { topic: "weapons" })).error.code, "rules.missing");
  const q = await readRules(fixture({ quickstartBook: true }).source, { topic: "growth" });
  assert.equal(q.error.code, "rules.refused");
  const parts = splitParts("a ".repeat(7000), 6000);
  assert.ok(parts.every((p) => p.length <= 6000)); assert.equal(parts.join(" ").replace(/\s+/g, " ").trim(), "a ".repeat(7000).trim());
});

/* ---------------------------------------------------------------- tool schemas */
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "minItems", "uniqueItems", "pattern"];
function walk(schema, path, fn) {
  fn(schema, path);
  for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, `${path}.${k}`, fn);
  if (schema.items) walk(schema.items, `${path}[]`, fn);
}
await test("tool defs: strict, additionalProperties:false + required on every object, no unsupported keywords, static, sorted", () => {
  const defs = readToolDefs();
  assert.deepEqual(defs.map((d) => d.name), ["get_entries", "read_document", "read_rules", "search_catalog"]);
  assert.equal(JSON.stringify(defs), JSON.stringify(readToolDefs()));
  for (const d of defs) {
    assert.equal(d.strict, true); assert.equal(typeof d.description, "string");
    walk(d.input_schema, d.name, (s, p) => {
      if (s.type === "object") { assert.equal(s.additionalProperties, false, p); assert.ok(Array.isArray(s.required), p); for (const r of s.required) assert.ok(r in s.properties, `${p}.${r}`); }
      for (const k of UNSUPPORTED) assert.ok(!(k in s), `${p} uses ${k}`);
    });
  }
  assert.deepEqual(defs.find((d) => d.name === "read_rules").input_schema.properties.topic.enum, TOPIC_KEYS);
  assert.deepEqual(defs.find((d) => d.name === "search_catalog").input_schema.properties.kinds.items.enum, KINDS);
});

/* ---------------------------------------------------------------- tool runner + read_document */
const mkDoc = (data, extra = {}) => ({ ...extra, documentName: extra.documentName ?? "Actor", uuid: extra.uuid ?? `Actor.${data._id}`, name: data.name, toObject: () => structuredClone(data), testUserPermission: () => extra.visible !== false });
const thisData = { _id: id("actThis"), name: "ZZ Hero", type: "superhero", system: { attributes: { fighting: { value: 4 } } }, effects: [{ name: "Act fx", disabled: true, changes: [{ key: "k", mode: 2, value: "1" }] }],
  items: [{ _id: id("itmA"), type: "power", name: "Zap Wall", system: { level: "major", description: P("Hand-edited " + "long ".repeat(3000)), automations: { a: { type: "rollAttack", rollBonus: 2, extraConfiguration: SCRIPT } }, extraConfiguration: SCRIPT }, effects: [] }] };
const thisDoc = mkDoc(thisData);
const otherDoc = mkDoc({ _id: id("actOther"), name: "Other Placeholder", type: "npc", system: {}, items: [{ _id: id("itmB"), type: "gear", name: "Mock Gear", system: { cost: 2 } }] });
const twinA = mkDoc({ _id: id("twinA"), name: "Twin", type: "npc", system: {}, items: [] });
const twinB = mkDoc({ _id: id("twinB"), name: "Twin", type: "npc", system: {}, items: [] });
const hidden = mkDoc({ _id: id("hid"), name: "Hidden One", type: "npc", system: {}, items: [] }, { visible: false });
const game = { user: {}, actors: [thisDoc, otherDoc, twinA, twinB, hidden], items: [] };
const ctx = { doc: thisDoc, game, fromUuid: async (u) => game.actors.find((a) => a.uuid === u) ?? null };
const tools = makeReadTools({ getCatalog: async () => cat, source });

await test("runner: search/get_entries/read_rules inputs validated, results JSON-safe", async () => {
  assert.equal((await tools.run("search_catalog", { query: "" }, ctx)).error.code, "search.empty");
  assert.equal((await tools.run("search_catalog", { query: "x", kinds: ["spell"] }, ctx)).error.code, "search.kind");
  const s = await tools.run("search_catalog", { query: "zap", limit: 2 }, ctx);
  assert.equal(s.ok, true); assert.equal(s.shown, 2);
  assert.equal((await tools.run("get_entries", { refs: [] }, ctx)).error.code, "entries.none");
  const g = await tools.run("get_entries", { refs: [`limits:${id("limSlow")}`, "x:y"] }, ctx);
  assert.deepEqual(g.unknownRefs, ["x:y"]); assert.equal(g.entries[0].kind, "limit");
  assert.equal((await tools.run("read_rules", { topic: "growth" }, ctx)).ok, true);
  assert.equal(await tools.run("submit_proposal", {}, ctx), null, "not a read tool");
  assert.doesNotThrow(() => JSON.parse(toolResultText(s)));
});
await test("PA1 (W2-7): empty forPower result says 'no boosts or limits' vs 'unknown power'; non-empty has no note", async () => {
  const none = await tools.run("search_catalog", { forPower: "Écho Sense" }, ctx);
  assert.equal(none.ok, true); assert.equal(none.total, 0);
  assert.equal(none.note, "This power has no boosts or limits.");
  const byRef = await tools.run("search_catalog", { forPower: `powers:${id("pwrEcho")}` }, ctx);
  assert.equal(byRef.note, "This power has no boosts or limits.", "a power ref works the same");
  const unknown = await tools.run("search_catalog", { forPower: "No Such Power" }, ctx);
  assert.equal(unknown.total, 0); assert.match(unknown.note, /^No power with the name or ref "No Such Power"/);
  const filtered = await tools.run("search_catalog", { forPower: "Zap Wall", query: "zzzz" }, ctx);
  assert.equal(filtered.total, 0); assert.match(filtered.note, /match the words or kinds/);
  const some = await tools.run("search_catalog", { forPower: "Zap Wall" }, ctx);
  assert.ok(some.total > 0); assert.ok(!("note" in some));
  assert.equal(search(cat, { query: "", forPower: "Nope" }).powerFound, false);
  assert.equal(search(cat, { query: "", forPower: "Écho Sense" }).powerFound, true);
  assert.ok(!("powerFound" in search(cat, { query: "zap" })), "no field without forPower");
});
await test("read_document: this needs itemIds; deep fields; no script body; result capped", async () => {
  assert.equal((await readDocument({ target: "this" }, ctx)).error.code, "doc.self");
  const r = await readDocument({ target: "this", itemIds: [id("itmA"), "missingId"], fields: ["description", "automations", "effects", "system"] }, ctx);
  assert.equal(r.ok, true); assert.deepEqual(r.unknownItemIds, ["missingId"]);
  const it = r.items[0];
  assert.equal(it.system.level, "major"); assert.equal(it.system.script, true); assert.ok(!("description" in it.system));
  assert.deepEqual(it.automations, [{ type: "rollAttack", bonus: 2, script: true }]);
  assert.match(it.description, /truncated/);
  assert.deepEqual(r.actorEffects, [{ name: "Act fx", disabled: true, changes: [{ key: "k", type: 2, value: "1" }] }]);
  assert.ok(!JSON.stringify(r).includes("SECRET-SCRIPT-BODY"));
  assert.ok(JSON.stringify(r).length <= 16000 + 200);
});
await test("read_document: other world docs by name / uuid; ambiguous, hidden, compendium refused; snapshot hook used", async () => {
  const byName = await readDocument({ target: "other placeholder" }, ctx);
  assert.equal(byName.ok, true); assert.match(byName.sheet, /I .* gear "Mock Gear"/);
  const byUuid = await readDocument({ target: `Actor.${id("actOther")}`, itemIds: [id("itmB")], fields: ["system"] }, ctx);
  assert.equal(byUuid.items[0].system.cost, 2);
  assert.equal((await readDocument({ target: "Twin" }, ctx)).error.code, "doc.ambiguous");
  assert.equal((await readDocument({ target: "Hidden One" }, ctx)).error.code, "doc.notFound");
  assert.equal((await readDocument({ target: "Compendium.invincible-core.powers.Item.abc" }, ctx)).error.code, "doc.compendium");
  const snap = await readDocument({ target: "Other Placeholder" }, ctx, { snapshot: async () => ({ text: "<sheet>SNAP</sheet>" }) });
  assert.equal(snap.sheet, "<sheet>SNAP</sheet>");
  const item = await readDocument({ target: "this" }, { ...ctx, doc: mkDoc({ _id: id("gearDoc"), name: "G", type: "gear", system: { description: P("d"), cost: 1 } }, { documentName: "Item" }) });
  assert.equal(item.item.description, "d");
});

/* ---------------------------------------------------------------- pack wiring */
await test("pack: prompt capability complete; staticPrompt stable; proposal tools merged; unknown tool", async () => {
  const v = validatePack(invPack);
  assert.equal(v.ok, true, v.errors.join("; ")); assert.equal(v.capabilities.prompt, true);
  const fake = { version: 1, proposalTools: () => [{ name: "submit_proposal", description: "x", input_schema: { type: "object", additionalProperties: false, required: [], properties: {} }, strict: true }], runProposalTool: async (n) => ({ ok: true, ran: n }) };
  const grp = promptGroup(() => fake, { source, game });
  const s1 = await grp.staticPrompt(), s2 = await grp.staticPrompt();
  assert.equal(s1.fingerprint, s2.fingerprint); assert.equal(s1.catalogIndex, s2.catalogIndex);
  assert.ok(s1.rulesDigest.startsWith("<rules")); assert.ok(s1.catalogIndex.startsWith("<catalog>"));
  assert.deepEqual(grp.tools().map((t) => t.name), ["get_entries", "read_document", "read_rules", "search_catalog", "submit_proposal"]);
  assert.deepEqual(await grp.runTool("submit_proposal", {}, ctx), { ok: true, ran: "submit_proposal" });
  assert.equal((await grp.runTool("nope", {}, ctx)).error.code, "tool.unknown");
  const sizes = { digest: estimateTokens(s1.rulesDigest), index: estimateTokens(s1.catalogIndex), tools: estimateTokens(JSON.stringify(grp.tools())) };
  console.log(`     fixture sizes (chars/3.5 tokens): ${JSON.stringify(sizes)}`);
});

/* ---------------------------------------------------------------- fixes 2 (analysis-1 P1-D, P1-E, P1-F) */
await test("P1-E: a ref written with the long pack name is the same ref (get / levelOf / refToUuid); shortRef", async () => {
  const { shortRef } = await import("../scripts/systems/invincible/catalog.mjs");
  assert.equal(shortRef("power-sources:abc"), "sources:abc");
  assert.equal(shortRef(" npcs-creatures:x "), "npcs:x");
  assert.equal(shortRef("powers:x"), "powers:x");
  assert.equal(shortRef("occupation:mock-job"), "occupation:mock-job");
  const viaLong = cat.get(`power-sources:${id("srcOdd")}`);
  assert.ok(viaLong && viaLong.ref === `sources:${id("srcOdd")}`);
  assert.equal(cat.levelOf(`powers:${id("pwrZapM")}`), "major");
  assert.equal(refToUuid(cat, `power-sources:${id("srcOdd")}`), `Compendium.invincible-core.power-sources.Item.${id("srcOdd")}`);
  const r = await getEntries(cat, source, [`power-sources:${id("srcOdd")}`]);
  assert.deepEqual(r.unknown, []); assert.equal(r.entries[0].ref, `sources:${id("srcOdd")}`);
});
await test("P1-D: findByName / normBase use the balanced trailing bracket group (nested note)", async () => {
  const { normBase } = await import("../scripts/systems/invincible/catalog.mjs");
  assert.equal(normBase("Plain Trouble (Kingpin (Wilson Fisk))"), "plain trouble");
  assert.equal(normBase("Plain Trouble (one) (two)"), "plain trouble (one)");
  assert.equal(cat.findByName("drawback", "Plain Trouble (Kingpin (Wilson Fisk))")?.ref, `drawbacks:${id("drwPlain")}`);
  assert.equal(cat.findByName("boost", "Far Reach (Glide)")?.ref, `boosts:${id("bstFar")}`);   // a catalogue name that itself ends in brackets
});
await test("P1-F: occupationFacts reads Resources and the occupation talent list (one line, per line, list items)", async () => {
  const { occupationFacts } = await import("../scripts/systems/invincible/catalog.mjs");
  assert.deepEqual(occupationFacts("Intro placeholder.\nOccupation Talent ([[D3]]):\n1. Alpha Knack, 2. Beta Knack, 3. Knowing (any)\nResources: 3\nKey Relationship ([[D3]]):\n1. x"), { resources: 3, talents: ["Alpha Knack", "Beta Knack", "Knowing (any)"] });
  assert.deepEqual(occupationFacts("Occupation Talent:\n1. One\n2. Two\nResources: 5"), { resources: 5, talents: ["One", "Two"] });
  assert.deepEqual(occupationFacts("Occupation Talent: 1. One, 2. Two\nResources: 2"), { resources: 2, talents: ["One", "Two"] });
  assert.deepEqual(occupationFacts("Occupation Talent\n- One\n- Two\nResources: 4"), { resources: 4, talents: ["One", "Two"] });
  assert.deepEqual(occupationFacts("No facts here."), { resources: null, talents: [] });
  // through buildCatalog: occupation entries carry the facts, the index text does not change (cached prefix)
  const f = fixture();
  const occHtml = "<h2>Mock Job</h2><p>Occupation placeholder text.</p><p>Occupation Talent ([[D3]]):</p><p>1. Quick Placeholder, 2. Other Knack, 3. Third Knack</p><p>Resources: 4</p>";
  const src2 = { ...f.source, page: async (j, pid, name) => (name === "Occupation" ? { name, journal: "2: Your Superhero", html: occHtml } : f.source.page(j, pid, name)) };
  const c2 = await buildCatalog(src2, { feedRules: false });
  const occ = c2.byKind("occupation")[0];
  assert.equal(occ.resources, 4); assert.deepEqual(occ.talents, ["Quick Placeholder", "Other Knack", "Third Knack"]);
  assert.ok(!indexText(c2).includes("Other Knack"));
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
