// T12: sheet reader + compact serializer + line diff + full-vs-diff rule (spec 5.4, 6.0, 12.1). Node, no Foundry, no network.
// Fixtures: dev/fixtures/invincible-sheets.mjs (invented names and texts only, no book text).
// Run: node dev/test-build-snapshot.mjs            (prints measured sizes of the fixture sheets)
import assert from "node:assert/strict";
import {
  readActor, readItemDocument, chargenStateFromActor, unsavedFrom, plainText, automationSig, createCatalogLookup, entryFromIndex
} from "../scripts/systems/invincible/reader.mjs";
import {
  serializeSheet, estimateTokens, diffLines, formatUpdate, applyUpdate, sameLines, nextSheetBlock, diffSnapshots, parseSheet,
  snapshot, LIMITS, lineKey, markSupersedes
} from "../scripts/systems/invincible/snapshot.mjs";
import * as rules from "../scripts/systems/invincible/vendor/chargen/rules.mjs";
import { typicalHero, bigNpc, hugeNpc, makeLookup, item, idGen, filler, effect } from "./fixtures/invincible-sheets.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const lookup = makeLookup();
const snap = (a, o = {}) => serializeSheet(readActor(a, { lookup, ...o }), o);
const clone = (x) => JSON.parse(JSON.stringify(x));
/** rebuild a fixture actor after editing its raw parts (keeps the fixture helpers' prepare logic) */
import { actor as mkActor } from "./fixtures/invincible-sheets.mjs";
const rebuild = (a, { items = a.items, system = {}, flags = a._source.flags, effects = a.effects, name = a.name } = {}) => {
  const attrs = { ...a._source.system.attributes, ...(system.attributes ?? {}) };
  const sys = { ...clone(a._source.system), ...system };
  delete sys.attributes;
  return mkActor({ id: a.id, name, type: a.type, attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v.value])), system: sys, flags, items, effects });
};

/* ---------------------------------------------------------------- sizes (printed) */
const sizes = {};
await test("sizes: typical hero <= 2500 tokens, big NPC and huge NPC <= 6000 (cap)", () => {
  for (const [k, a] of [["typical superhero", typicalHero()], ["big NPC", bigNpc()], ["huge NPC (60 custom items x 1500 chars)", hugeNpc()]]) {
    const s = snap(a);
    sizes[k] = { chars: s.text.length, tokensEst: s.tokensEst, lines: s.lines.size, items: a.items.length, cutLevel: s.cutLevel };
    assert.ok(s.tokensEst <= LIMITS.capTokens, `${k}: ${s.tokensEst} > cap`);
  }
  assert.ok(sizes["typical superhero"].tokensEst <= 2500);
  assert.equal(sizes["typical superhero"].cutLevel, 0);
  assert.equal(sizes["big NPC"].cutLevel, 0);
  assert.ok(sizes["huge NPC (60 custom items x 1500 chars)"].cutLevel > 0);
});

/* ---------------------------------------------------------------- determinism */
await test("deterministic: same actor -> same bytes; rebuilt copy -> same bytes; fingerprint covers the body", () => {
  const a = typicalHero(), b = typicalHero();
  assert.equal(snap(a).text, snap(a).text);
  assert.equal(snap(a).text, snap(b).text);
  const s = snap(a);
  assert.match(s.text, new RegExp(`^<sheet doc="Actor\\.${a.id}" fp=${s.fingerprint}>\\n`));
  assert.ok(s.text.endsWith("\n</sheet>"));
  const c = rebuild(a, { system: { attributes: { fighting: { value: 5 } } } });
  assert.notEqual(snap(c).fingerprint, s.fingerprint);
});

await test("item order is independent of the collection order (tree: source -> power -> boosts/limits); talents excepted (W2-3)", () => {
  const a = typicalHero();
  const shuffled = rebuild(a, { items: [...a.items].reverse() });
  const I = (t) => t.split("\n").filter((l) => l.startsWith("I ") && !/^I \w+ talent /.test(l));
  assert.deepEqual(I(snap(shuffled).text), I(snap(a).text));
  // talents keep the collection order: that order is their role
  const T = (t) => t.split("\n").filter((l) => /^I \w+ talent /.test(l)).map((l) => l.match(/talent "([^"]+)" role=(\w+)/).slice(1).join(":"));
  assert.deepEqual(T(snap(a).text), ["Quick Wits:hero", "Streetwise:occupation"]);
  assert.deepEqual(T(snap(shuffled).text), ["Streetwise:hero", "Quick Wits:occupation"]);
  const lines = snap(a).text.split("\n").filter((l) => l.startsWith("I "));
  const at = (name) => lines.findIndex((l) => l.includes(`"${name}"`));
  assert.ok(at("Strange Meteor") < at("Glide Wings") && at("Glide Wings") < at("Silent Flight") && at("Spark Bolt") < at("Needs Charging"));
  assert.ok(at("Needs Charging") < at("Quick Wits") && at("Lean Times") < at("Grapple Line"));
});

/* ---------------------------------------------------------------- content */
await test("actor: stored vs prepared values separately, bonuses, text fields one per line, blanks listed", () => {
  const t = snap(typicalHero()).text;
  assert.match(t, /^ATTR fighting 6 agility 7 strength 5 reason 5 intuition 5 presence 5$/m);
  assert.match(t, /^STORED health 9 resolve 8 reputation 2 resources 3 karma 0$/m);
  assert.match(t, /^PREPARED healthMax 9 resolveMax 8 slugfest 3 slugfestDamage 3 resources 2 initiativeSize 1$/m);
  assert.match(t, /^BONUS initiativeSize: Quick Wits \+1; resources: Lean Times -1$/m);
  assert.match(t, /^TEXT relationships "NPC: Tomas Rel \(mentor\)\\nHero: Grey Lantern"$/m);
  assert.match(t, /^EMPTY biography$/m);
  assert.match(t, /^ACTOR type=superhero name="Amber Kestrel" rank=global\(flag\) profile=creation$/m);
});

await test("items: ids, levels, links, refs, gear numbers; catalogue items carry no description, custom/hand-edited do", () => {
  const a = typicalHero();
  const t = snap(a).text;
  const id = (n) => a.items.find((i) => i.name === n).id;
  assert.match(t, new RegExp(`^I ${id("Spark Bolt")} power "Spark Bolt" lvl=major src=${id("Strange Meteor")} ref=powers:\\w{16}$`, "m"));
  assert.match(t, new RegExp(`^I ${id("Glide Wings")} power "Glide Wings" lvl=basic `, "m"));
  assert.match(t, new RegExp(`^I ${id("Silent Flight")} boost "Silent Flight" pow=${id("Glide Wings")} ref=boosts:\\w{16}$`, "m"));
  assert.match(t, new RegExp(`^I ${id("Needs Charging")} limit "Needs Charging" pow=${id("Spark Bolt")} ref=limits:`, "m"));
  assert.match(t, /^I \w{16} talent "Quick Wits" role=hero ref=talents:\w{16} fx=initiativeSize\+1$/m);
  assert.match(t, /^I \w{16} gear "Grapple Line" ref=gears:\w{16} edited cost=1 desc="/m);
  assert.match(t, /^I \w{16} gear "Pocket Camera" custom cost=1 desc="/m);
  assert.match(t, /^I \w{16} gear "Stun Baton" ref=gears:\w{16} cost=2 restricted atk=\+1 dmg=2 rng=0-0$/m);
  for (const l of t.split("\n").filter((x) => x.startsWith("I ") && / ref=/.test(x) && !/ edited/.test(x))) assert.ok(!/ desc=/.test(l), l);
});

await test("boost/limit ref follows the linked power when two catalogue entries share a name; split-level power by level", () => {
  const a = bigNpc();
  const t = snap(a).text;
  const arcs = t.split("\n").filter((l) => l.includes(`boost "Wider Arc"`)).map((l) => l.match(/ref=(\S+)/)[1]);
  assert.equal(arcs.length, 2);
  assert.notEqual(arcs[0], arcs[1]);
  const L = makeLookup();
  const ironMajor = L.match({ type: "power", name: "Iron Hide", level: "major" }), ironBasic = L.match({ type: "power", name: "Iron Hide", level: "basic" });
  assert.notEqual(ironMajor.ref, ironBasic.ref);
  assert.ok(t.includes(`ref=${ironMajor.ref}`));
  // "Name (note)" matches the base name
  assert.match(t, /drawback "Haunted \(by the old foundry\)" ref=drawbacks:\w{16}/);
});

await test("dangling links are marked (missing); a power without source shows src=-", () => {
  const a = typicalHero();
  const items = a.items.filter((i) => i.name !== "Glide Wings" && i.name !== "Strange Meteor");
  const b = rebuild(a, { items });
  const t = snap(b).text;
  assert.match(t, /boost "Silent Flight" pow=\w{16}\(missing\)/);
  assert.match(t, /power "Spark Bolt" lvl=major src=\w{16}\(missing\)/);
  const c = rebuild(a, { items: [item("AAAAAAAAAAAAAAAA", "power", "Odd Power", { level: "" })] });
  assert.match(snap(c).text, /^I AAAAAAAAAAAAAAAA power "Odd Power" lvl=- src=- custom$/m);
});

await test("automations: never a script body, only flags; auto= only when different from the pack or custom", () => {
  const a = bigNpc();
  const t = snap(a).text;
  assert.ok(!t.includes("SECRET_SCRIPT_BODY"));
  assert.ok(!t.includes("console.log"));
  assert.ok(!t.includes("automation.baseDamage"));          // the pack's own boost script never appears either
  assert.match(t, /power "Clockwork Trick 1" lvl=basic src=\w{16} custom auto=\[rollAttack "Gear Shot 1"\* dmg1 rng0-2\] script desc=/);
  assert.match(t, /boost "Overwind 1" pow=\w{16} custom script desc=/);
  // a catalogue power whose level flipped showAsSelection is NOT "different" (level flips are ignored)
  assert.match(t, /power "Spark Bolt" lvl=major src=\w{16} ref=powers:\w{16}$/m);
  // a changed automation number on a catalogue copy shows auto=
  const h = typicalHero();
  const bolt = h.items.find((i) => i.name === "Spark Bolt");
  Object.values(bolt._source.system.automations)[0].baseDamage = 9;
  assert.match(snap(h).text, /power "Spark Bolt" lvl=major src=\w{16} ref=powers:\w{16} auto=\[rollAttack "Basic Bolt" dmg9 rng0-2; rollAttack "Major Bolt"\* dmg3 rng0-3\]$/m);
  // scripts hashed in the signature, bodies not kept in the model
  const m = readActor(a, { lookup });
  assert.ok(!JSON.stringify(m).includes("SECRET_SCRIPT_BODY"));
  assert.notEqual(automationSig({ extraConfiguration: "a" }), automationSig({ extraConfiguration: "b" }));
});

await test("flags: plus-ultra rank/archetype and our undo count only; other modules' flags never", () => {
  const t1 = snap(typicalHero()).text, t2 = snap(bigNpc()).text;
  assert.match(t1, /^FLAG pu rank=global archetype="Speedster"$/m);
  assert.ok(!t1.includes("OTHER_MODULE_SECRET") && !t1.includes("some-other-module") && !t1.includes("run-x"));
  assert.match(t2, /^FLAG undo runs=2 last=r2$/m);
});

await test("actor effects and statuses; disabled item effect marked !", () => {
  const t = snap(bigNpc()).text;
  assert.match(t, /^FX \w{16} "Overclocked" attributes\.strength\.value\+2$/m);
  assert.match(t, /^FX \w{16} "Stunned" statuses=stunned$/m);
  assert.match(t, /drawback "Rusting Joints" custom fx=!attributes\.agility\.value-1 desc=/);
  assert.match(t, /^PREPARED .*strength 8/m);
});

/* ---------------------------------------------------------------- VALID line */
await test("VALID: vendored rules on the actor read as a chargen state (valid hero ok=true, budget numbers)", () => {
  const t = snap(typicalHero()).text;
  assert.match(t, /^VALID baseline profile=creation rank=global ok=true budget=33 spent=33 slots=4\/4 cap=10 drawbacks=1\/2 xsrc=0 xtal=0$/m);
  const st = chargenStateFromActor(typicalHero());
  assert.equal(rules.validate(st).ok, true);
  assert.equal(st.heroTalent.name, "Quick Wits"); assert.equal(st.occTalent.name, "Streetwise");
  assert.equal(st.powers.find((p) => p.name === "Spark Bolt").limits[0].grants, "level");
  assert.deepEqual(st.npcRel, { name: "Tomas Rel", type: "mentor" });
});

await test("VALID: errors with params; drawer rank beats the flag; npc gets structural checks", () => {
  const a = rebuild(typicalHero(), { system: { attributes: { fighting: { value: 9 } } } });
  assert.match(snap(a).text, /^VALID baseline profile=creation rank=global ok=false errors=attr\.over\(3\) budget=33 spent=36 /m);
  assert.match(snap(typicalHero(), { rank: "teen" }).text, /rank=teen\(drawer\).*\n[\s\S]*VALID baseline profile=creation rank=teen ok=false errors=.*attr\.cap/);
  assert.match(snap(typicalHero(), { profile: "in-play" }).text, /^VALID baseline profile=in-play /m);
  assert.match(snap(bigNpc()).text, /^VALID npc ok=true$/m);
  const n = bigNpc();
  const broken = rebuild(n, { items: n.items.filter((i) => !i.name.startsWith("Clockwork Trick 1")) });
  assert.match(snap(broken).text, /^VALID npc ok=false errors=boost\.power\.missing\(Overwind 1\)$/m);
});

/* ---------------------------------------------------------------- unsaved form values */
await test("UNSAVED: live form values that differ from _source, with coercion; UI-only paths ignored; item sheets too", () => {
  const a = typicalHero();
  const bat = a.items.find((i) => i.name === "Stun Baton");
  const live = {
    "name": "Amber Kestrel", "system.attributes.fighting.value": "6", "system.appearance": "Red and blue suit",
    "system.resources": 3, "ui.someToggle": true, "system.karma": "",
    items: { [bat.id]: { "system.cost": "4", "system.restricted": true } }
  };
  const t = snap(a, { live }).text;
  const U = t.split("\n").filter((l) => l.startsWith("UNSAVED "));
  assert.deepEqual(U.map((l) => lineKey(l)), [`UNSAVED items.${bat.id}.system.cost`, "UNSAVED system.appearance", "UNSAVED system.karma"]);
  assert.match(t, /^UNSAVED system\.appearance stored="Flickers[^"]*" live="Red and blue suit"$/m);
  assert.match(t, new RegExp(`^UNSAVED items\\.${bat.id}\\.system\\.cost stored="2" live="4"$`, "m"));
  assert.equal(unsavedFrom(a, null).length, 0);
  // a schema field never written (absent from _source) is compared as "" when the document's schema knows it (live finding)
  const b = typicalHero();
  delete b._source.system.civilianName;
  b.system.schema = { getField: (p) => (p === "civilianName" ? {} : undefined) };
  assert.deepEqual(unsavedFrom(b, { "system.civilianName": "Typed", "system.nope": "x" }), [{ path: "system.civilianName", stored: "", live: "Typed" }]);
  assert.equal(unsavedFrom(b, { "system.civilianName": "" }).length, 0);
  assert.equal(unsavedFrom(a, { "system.resources": "3" }).length, 0);
});

/* ---------------------------------------------------------------- size cap and cut order */
await test("cap: custom descriptions are cut first (150, then out), effects folded only after that; NOTE says so", () => {
  const big = hugeNpc();
  const m = readActor(big, { lookup });
  const lvl = (cap) => serializeSheet(m, { capTokens: cap });
  const full = lvl(1e9);
  assert.equal(full.cutLevel, 0);
  const s1 = lvl(full.tokensEst - 1);
  assert.equal(s1.cutLevel, 1);
  assert.match(s1.text, /desc="[^"]{1,150}…\[cut, 1501 chars\]"/);
  assert.match(s1.text, /fx=!attributes/);                                     // effects still listed
  assert.match(s1.text, /^NOTE cut level 1: custom descriptions cut to 150 chars; read_document gives the full text$/m);
  const s3 = lvl(500);
  assert.equal(s3.cutLevel, 3);
  assert.match(s3.text, /drawback "Rusting Joints" custom fx=1 desc="\[cut, 351 chars\]"/);
  assert.match(s3.text, /^FX all count=2 disabled=0$/m);
  const def = serializeSheet(m);
  assert.ok(def.tokensEst <= LIMITS.capTokens && def.cutLevel >= 1);
  // descriptions of catalogue items are never in the block, cut or not
  assert.ok(!/ref=\S+ (?!edited)[^\n]*desc=/.test(full.text));
});

await test("descriptions: plain text from HTML, enrichers reduced to labels, 400-char cap marked", () => {
  assert.equal(plainText(`<p>Hit @UUID[Compendium.x.y.z]{the bell} for [[/r 1d6]] &amp; more&nbsp;now</p><ul><li>one</li></ul>`), "Hit the bell for 1d6 & more now - one");
  const a = typicalHero();
  a.items.find((i) => i.name === "Pocket Camera")._source.system.description = `<p>${filler(900, 5)}</p>`;
  const l = snap(a).text.split("\n").find((x) => x.includes(`"Pocket Camera"`));
  assert.match(l, /desc="[^"]{300,400}…\[cut, 901 chars\]"$/);
});

/* ---------------------------------------------------------------- diff and fold */
const twoStates = (mutate) => {
  const a = typicalHero();
  const s0 = snap(a);
  const b = mutate(a);
  return { s0, s1: snap(b), a, b };
};
await test("diff: unchanged -> <sheet_unchanged/>; one attribute -> one ~ line (+ VALID); fold == fresh", () => {
  const a = typicalHero(), s0 = snap(a);
  assert.equal(formatUpdate(s0.lines, s0), "<sheet_unchanged/>");
  const { s1 } = twoStates((x) => rebuild(x, { system: { attributes: { fighting: { value: 7 } }, derived: { health: { value: 9, max: 9 }, resolve: { value: 8, max: 8 }, slugfest: { value: 3, max: 3 } } } }));
  const up = formatUpdate(s0.lines, s1, { doc: "Actor.x", base: s0.fingerprint });
  assert.match(up, new RegExp(`^<sheet_update doc="Actor.x" fp=${s1.fingerprint} base=${s0.fingerprint}>\\n`));
  assert.match(up, /^~ ATTR fighting 7 /m);
  assert.match(up, /^~ VALID baseline .*errors=attr\.over\(1\)/m);
  assert.ok(sameLines(applyUpdate(s0.lines, up), s1.lines));
});

await test("diff: add / change / remove items fold back to the fresh snapshot; removal names the item", () => {
  const a = typicalHero(), s0 = snap(a);
  const nid = idGen(999);
  const newItem = item(nid(), "talent", "Gearwright", { description: "<p>invented</p>" });
  const items = a.items.filter((i) => i.name !== "Streetwise").concat(newItem);
  items.find((i) => i.name === "Pocket Camera")._source.system.cost = 2;
  const s1 = snap(rebuild(a, { items }));
  const d = diffLines(s0.lines, s1.lines);
  assert.ok(d.added.some((l) => l.includes(`"Gearwright"`)));
  assert.ok(d.changed.some((l) => l.includes(`"Pocket Camera" custom cost=2`)));
  const sw = a.items.find((i) => i.name === "Streetwise").id;
  assert.deepEqual(d.removed, [`I ${sw}`]);
  const up = formatUpdate(s0.lines, s1);
  assert.match(up, new RegExp(`^- I ${sw} "Streetwise"$`, "m"));
  assert.ok(sameLines(applyUpdate(s0.lines, up), s1.lines));
  assert.ok(sameLines(applyUpdate(s0.lines, "<sheet_unchanged/>"), s0.lines));
});

await test("contract diffSnapshots(oldText, newText) == the same update; parseSheet round-trips the keys", () => {
  const a = typicalHero(), s0 = snap(a);
  const s1 = snap(rebuild(a, { name: "Amber Kestrel II" }));
  const up = diffSnapshots(s0.text, s1.text);
  assert.match(up, /^~ ACTOR type=superhero name="Amber Kestrel II"/m);
  assert.ok(sameLines(applyUpdate(parseSheet(s0.text).lines, up), parseSheet(s1.text).lines));
  assert.equal(diffSnapshots(s0.text, s0.text), "<sheet_unchanged/>");
  assert.deepEqual([...parseSheet(s0.text).lines.keys()], s0.order);
});

await test("5.4 rule: first full; unchanged; small diff -> update; > 25 % lines -> full supersedes; > 1500 tokens -> full", () => {
  const a = typicalHero();
  const s0 = snap(a);
  let r = nextSheetBlock(null, s0);
  assert.equal(r.kind, "full"); assert.equal(r.reason, "first"); assert.ok(!r.text.includes("supersedes"));
  let held = r.held;
  r = nextSheetBlock(held, snap(a));
  assert.equal(r.kind, "unchanged"); assert.equal(r.text, "<sheet_unchanged/>");
  const s1 = snap(rebuild(a, { name: "New Name" }));
  r = nextSheetBlock(held, s1);
  assert.equal(r.kind, "update");
  assert.ok(sameLines(r.held.lines, s1.lines)); assert.equal(r.held.diffs, 1);
  // rebuild: every item replaced (new ids) -> big drift
  const nid = idGen(4242);
  const rebuilt = rebuild(a, { items: a.items.map((i) => item(nid(), i.type, i.name, clone(i._source.system))) });
  r = nextSheetBlock(held, snap(rebuilt));
  assert.equal(r.kind, "full"); assert.equal(r.reason, "drift-lines");
  assert.match(r.text, /^<sheet doc="[^"]+" fp=\w+ supersedes="all earlier sheet blocks">/);
  assert.equal(r.held.diffs, 0);
  // token threshold alone (few lines, long text)
  const s2 = snap(rebuild(a, { system: { appearance: filler(590, 77) } }));
  r = nextSheetBlock(held, s2, { limits: { ...LIMITS, diffTokens: 100 } });
  assert.equal(r.kind, "full"); assert.equal(r.reason, "drift-tokens");
  assert.equal(markSupersedes(markSupersedes(s0.text)), markSupersedes(s0.text));
});

await test("5.4 rule: a fresh full block after 8 diffs; folding full + 8 diffs equals the fresh full each step", () => {
  let a = typicalHero();
  let r = nextSheetBlock(null, snap(a));
  let held = r.held;
  for (let k = 1; k <= 8; k++) {
    a = rebuild(a, { name: `Kestrel ${k}` });
    const fresh = snap(a);
    r = nextSheetBlock(held, fresh);
    assert.equal(r.kind, "update", `step ${k}`);
    assert.ok(sameLines(r.held.lines, fresh.lines));
    held = r.held;
  }
  assert.equal(held.diffs, 8);
  a = rebuild(a, { name: "Kestrel 9" });
  r = nextSheetBlock(held, snap(a));
  assert.equal(r.kind, "full"); assert.equal(r.reason, "diff-count"); assert.equal(r.held.diffs, 0);
});

await test("UNSAVED lines appear and disappear through the diff", () => {
  const a = typicalHero();
  const s0 = snap(a);
  const s1 = snap(a, { live: { "system.appearance": "Typed but not saved" } });
  const up = formatUpdate(s0.lines, s1);
  assert.match(up, /^\+ UNSAVED system\.appearance stored="[^"]*" live="Typed but not saved"$/m);
  const back = formatUpdate(s1.lines, s0);
  assert.match(back, /^- UNSAVED system\.appearance$/m);
});

/* ---------------------------------------------------------------- item drawer, pack entry, estimator */
await test("item document (gear drawer): ITEM + item line + its full description", () => {
  const g = item("GGGGGGGGGGGGGGGG", "gear", "Signal Flare", { description: `<p>${filler(500, 9)}</p>`, cost: 1, singleUse: true });
  const m = readItemDocument({ ...g, uuid: "Item.GGGGGGGGGGGGGGGG", documentName: "Item" }, { lookup });
  const t = serializeSheet(m).text;
  assert.match(t, /^ITEM type=gear name="Signal Flare"$/m);
  assert.match(t, /^I GGGGGGGGGGGGGGGG gear "Signal Flare" custom cost=1 singleUse$/m);
  assert.match(t, /^DESC "[^"]{400,}"$/m);
});

await test("snapshot(doc, opts) entry: injected lookup + live values; pack contract has the sheet group", async () => {
  const a = typicalHero();
  const r = await snapshot(a, { lookup, liveForm: { "system.flaw": "Changed" } });
  assert.ok(r.text.startsWith("<sheet ") && r.lines instanceof Map && r.fingerprint && r.tokensEst > 0);
  assert.match(r.text, /^UNSAVED system\.flaw /m);
  const r2 = await snapshot(a, { lookup, liveForm: false });
  assert.ok(!r2.text.includes("UNSAVED"));
  // empty catalogue: everything reads as custom (still deterministic, nothing thrown)
  const r3 = await snapshot(a, { lookup: createCatalogLookup([]), liveForm: false });
  assert.ok(!r3.text.includes(" ref="));
  let pack, validatePack;
  try { ({ default: pack } = await import("../scripts/systems/invincible/pack.mjs")); ({ validatePack } = await import("../scripts/build/registry.mjs")); }
  catch (e) { throw new Error(`pack.mjs import failed (another group?): ${e.message}`); }
  assert.equal(typeof pack.snapshot, "function"); assert.equal(typeof pack.diffSnapshots, "function");
  assert.equal(validatePack(pack).capabilities.sheet, true);
  const r4 = await pack.snapshot(a, { lookup, liveForm: false });
  assert.equal(r4.text, r2.text);
  // harness path: pack.nextSheetBlock with a held picture that went through a JSON round-trip (Maps encoded like sheet-sync encodeHeld)
  const enc = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Map ? { __map: [...x.entries()] } : x)));
  const dec = (v) => (Array.isArray(v) ? v.map(dec) : v && typeof v === "object" ? (Array.isArray(v.__map) ? new Map(v.__map) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))) : v);
  const first = pack.nextSheetBlock(null, r4);
  assert.equal(first.kind, "full");
  const r5 = await pack.snapshot(a, { lookup, liveForm: { "system.flaw": "Changed" } });
  const next = pack.nextSheetBlock(dec(enc(first.held)), r5);
  assert.equal(next.kind, "update"); assert.match(next.text, /^\+ UNSAVED system\.flaw /m);
});

await test("estimator: prose ~3.5-5.5 chars/token, random 16-char ids ~8-12 tokens", () => {
  const prose = filler(4000, 1);
  const ratio = prose.length / estimateTokens(prose);
  assert.ok(ratio > 3.2 && ratio < 5.5, String(ratio));
  for (const id of ["aB3dE5fG7hJ9kL1m", "Zt34xIBbpsnKtuZH", "K0MZ6GmjZGGzsmLW"]) {
    const n = estimateTokens(id);
    assert.ok(n >= 7 && n <= 13, `${id}: ${n}`);
  }
});

await test("fixtures and output carry no book text markers (invented vocabulary only)", () => {
  const t = snap(bigNpc()).text + snap(typicalHero()).text;
  const vocab = new Set("the device hums softly while its owner adjusts a brass dial and lens glows with pale amber light that flickers when wind turns cold over rooftops near harbor market at dusk".split(" "));
  for (const m of t.matchAll(/desc="([^"]*)"/g)) {
    for (const w of m[1].replace(/…\[cut, \d+ chars\]/, "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean)) {
      // filler and cuts may end inside a word: a prefix of a vocabulary word counts
      assert.ok(vocab.has(w) || w === "invented" || [...vocab].some((v) => v.startsWith(w)), `unexpected word "${w}"`);
    }
  }
});

/* ---------------------------------------------------------------- fixes 2 (analysis-1 P1-D, P1-E) */
await test("P1-E: sheet refs use the catalogue prefix (sources:, never power-sources:)", () => {
  const t = snap(typicalHero()).text;
  assert.match(t, /powerSource "Strange Meteor" ref=sources:\w{16}/);
  assert.ok(!t.includes("power-sources:"));
  assert.equal(entryFromIndex("power-sources", { _id: "x".repeat(16), name: "N", system: {} }).ref, `sources:${"x".repeat(16)}`);
  assert.equal(entryFromIndex("power-sources", { _id: "x".repeat(16), name: "N", system: {} }).pack, "power-sources");
});
await test("P1-D: a note holding brackets keeps the catalogue match (no false custom); state split by balanced brackets", () => {
  const a = typicalHero();
  const nid = idGen(9191);
  const lean = a.items.find((i) => i.name === "Lean Times");
  const nested = item(nid(), "drawback", "Lean Times (Kingpin (Wilson Fisk))", clone(lean._source.system));
  const h = rebuild(a, { items: [...a.items.filter((i) => i !== lean), nested], system: { relationships: "NPC: Foggy Doe (friend (lawyer))\nHero: Grey Lantern" } });
  const t = snap(h).text;
  assert.match(t, /drawback "Lean Times \(Kingpin \(Wilson Fisk\)\)" ref=drawbacks:\w{16}$/m);
  assert.ok(!/Lean Times[^\n]* custom/.test(t));
  const st = chargenStateFromActor(h, { rank: "global" });
  assert.deepEqual(st.drawbacks.map((d) => [d.name, d.note]), [["Lean Times", "Kingpin (Wilson Fisk)"]]);
  assert.deepEqual(st.npcRel, { name: "Foggy Doe", type: "friend (lawyer)" });
});
await test("P1-D: ordinary names split exactly like plus-ultra's patterns (import.mjs / catalog.normBase)", async () => {
  const N = await import("../scripts/systems/invincible/names.mjs");
  const puBase = (s) => String(s).replace(/\s*\([^)]*\)\s*$/, "").trim();
  const puNote = (s) => String(s).match(/\(([^)]*)\)\s*$/)?.[1]?.trim() ?? "";
  const puPower = (s) => { const m = String(s).match(/^(.*?)\s+\(([^)]*)\)\s*$/); return m ? [m[1], m[2].trim()] : [s, ""]; };
  const names = ["Phobic (spiders)", "Extra Limb(s)", "Knowledgeable (Technology)", "Flight", "A (b) (c)", "Bar ()", "(x)", "A (b))", "Foo (bar", "Name ( spaced )  ", "Hard Times"];
  for (const n of names) {
    assert.equal(N.baseName(n), puBase(n), n);
    assert.equal(N.noteOf(n), puNote(n), n);
    const sp = N.splitNote(n, { space: true });
    const [pb, pn] = puPower(n);
    assert.deepEqual(sp.base === n.trim() ? [n, ""] : [sp.base, sp.note], [pb, pn], n);
  }
  // power with a note written without a space stays one name (import.mjs T011), drawbacks split either way
  const h = rebuild(typicalHero(), { items: [...typicalHero().items, item("LimbLimbLimbLimb", "power", "Extra Limb(s)", { level: "basic" })] });
  assert.ok(chargenStateFromActor(h, { rank: "global" }).powers.some((p) => p.name === "Extra Limb(s)" && !p.note));
});

/* ---------------------------------------------------------------- W2-3: talent role on the sheet line */
import { talentRoles, talentRolesOf, talentRoleShifts } from "../scripts/systems/invincible/reader.mjs";
import { buildCatalog } from "../scripts/systems/invincible/catalog.mjs";
import { validateProposal } from "../scripts/systems/invincible/validate.mjs";
import { CATALOG_ROWS, fromCatalog } from "./fixtures/invincible-sheets.mjs";
const talentLines = (t) => t.split("\n").filter((l) => /^I \w+ talent /.test(l));
await test("W2-3: role=hero|occupation|extra by collection order; no occupation -> 2nd is extra; NPC lines have no role", () => {
  const a = typicalHero();
  const nid = idGen(777);
  const extra = fromCatalog(nid, "talents", "Steady Hands");
  const h = rebuild(a, { items: [...a.items, extra] });
  assert.deepEqual(talentLines(snap(h).text).map((l) => l.match(/role=(\w+)/)[1]), ["hero", "occupation", "extra"]);
  const noOcc = rebuild(h, { system: { occupation: "" } });
  assert.deepEqual(talentLines(snap(noOcc).text).map((l) => l.match(/role=(\w+)/)[1]), ["hero", "extra", "extra"]);
  // the reader's chargen state agrees with the marker
  const st = chargenStateFromActor(h, { rank: "global" });
  assert.deepEqual([st.heroTalent.name, st.occTalent.name, st.extraTalents.map((x) => x.name)], ["Quick Wits", "Streetwise", ["Steady Hands"]]);
  for (const l of talentLines(snap(bigNpc()).text)) assert.ok(!/ role=/.test(l), l);
  assert.deepEqual([...talentRoles([{ id: "a" }, { id: "b" }, { id: "c" }], true).values()], ["hero", "occupation", "extra"]);
});
await test("W2-3: a role change is one changed line per talent in the update block (diff by item key, order-free)", () => {
  const a = typicalHero();
  const old = snap(a);
  const quick = a.items.find((i) => i.name === "Quick Wits");
  const h = rebuild(a, { items: [...a.items.filter((i) => i !== quick), quick] });   // re-created hero talent lands last
  const d = diffLines(old.lines, snap(h).lines);
  assert.equal(d.added.length + d.removed.length, 0);
  assert.deepEqual(d.changed.map((l) => l.match(/talent "([^"]+)" role=(\w+)/).slice(1).join(":")).sort(), ["Quick Wits:occupation", "Streetwise:hero"]);
});
await test("W2-3: talentRoleShifts: hero removed + new talent added -> old occupation talent becomes hero (pure)", () => {
  const before = { system: { occupation: "Courier" }, items: [{ _id: "h", type: "talent", name: "A" }, { _id: "o", type: "talent", name: "B" }, { _id: "p", type: "power", name: "P" }] };
  const after = { system: { occupation: "Courier" }, items: [{ _id: "o", type: "talent", name: "B" }, { _id: "p", type: "power", name: "P" }, { _id: "new:t1", type: "talent", name: "C" }] };
  assert.deepEqual(talentRoleShifts(before, after), [{ itemId: "o", name: "B", from: "occupation", to: "hero" }]);
  assert.deepEqual(talentRoleShifts(before, before), []);
  assert.equal(talentRolesOf(after).roles.get("new:t1"), "occupation");
});
/* invented catalogue over the fixture rows (same shape as test-build-validate-invincible) */
function catSource() {
  const TYPE = { "power-sources": "powerSource", powers: "power", boosts: "boost", limits: "limit", talents: "talent", drawbacks: "drawback" };
  const packs = {};
  for (const [pack, list] of Object.entries(clone(CATALOG_ROWS))) {
    const names = [...new Set(list.map((x) => x.folder).filter(Boolean))];
    packs[pack] = { folders: names.map((n) => ({ id: `f_${n}`, name: n, parent: null })), docs: list.map((x) => ({ ...x, type: x.type ?? TYPE[pack], folder: x.folder ? `f_${x.folder}` : null, effects: [] })) };
  }
  return { has: (p) => !!packs[p], index: async (p) => packs[p]?.docs ?? [], folders: (p) => packs[p]?.folders ?? [], document: async (p, id) => clone(packs[p]?.docs.find((d) => d._id === id) ?? null), page: async () => null };
}
await test("W2-3: validation warns talent.role.shift (ops: hero replaced; replace: listed order the sheet cannot keep); none when roles hold", async () => {
  const catalog = await buildCatalog(catSource(), { feedRules: false });
  const ref = (n) => catalog.findByName("talent", n).ref;
  const V = (doc, input) => validateProposal(doc, input, { catalog, lookup, itemCheck: () => null, profile: "in-play", rank: "global" });
  const a = typicalHero();
  const id = (n) => a.items.find((i) => i.name === n).id;
  const shift = (r) => r.warnings.filter((w) => w.code === "talent.role.shift");
  const ops = (...list) => ({ target: "this", mode: "ops", rationale: "t", ops: list });
  // ops: the hero talent swapped for another -> Streetwise becomes the hero talent
  const r1 = await V(a, ops({ op: "removeItem", opId: "r1", itemId: id("Quick Wits") }, { op: "addItem", opId: "a1", ref: ref("Steady Hands") }));
  assert.deepEqual(shift(r1).map((w) => w.path), [`items.${id("Streetwise")}`], JSON.stringify(r1.errors));
  assert.match(shift(r1)[0].message, /occupation talent now and will be the hero talent/);
  // ops: an extra talent added -> no shift
  assert.deepEqual(shift(await V(a, ops({ op: "addItem", opId: "a1", ref: ref("Steady Hands") }))), []);
  // ops: hero replaced AND the occupation talent re-added after it -> roles as intended, no shift on kept items
  const r3 = await V(a, ops({ op: "removeItem", opId: "r1", itemId: id("Quick Wits") }, { op: "removeItem", opId: "r2", itemId: id("Streetwise") }, { op: "addItem", opId: "a1", ref: ref("Steady Hands") }, { op: "addItem", opId: "a2", ref: ref("Streetwise") }));
  assert.deepEqual(shift(r3), []);
  // replace: both talents kept, listed the other way round. W5-A-V1: the writer writes the proposal's order (W5-A-3), so no
  // shift warning (applyConfirm "reorder": test-build-validate-invincible W5-A-V2)
  const rp = (talents) => ({ target: "this", mode: "replace", rationale: "t", proposal: { talents: talents.map((n) => ({ ref: ref(n) })) } });
  assert.deepEqual(shift(await V(a, rp(["Streetwise", "Quick Wits"]))), []);
  // replace keeping the order -> nothing
  assert.deepEqual(shift(await V(a, rp(["Quick Wits", "Streetwise"]))), []);
});

await test("W4-A-1: VALID line lists an empty team under info (solo hero), other warnings stay warns; ok unchanged", async () => {
  const { validLine } = await import("../scripts/systems/invincible/snapshot.mjs");
  const v = { kind: "creation", rank: "global", ok: true, errors: [], warnings: ["team.empty", "npc.name.blank"], info: ["x.y"], budget: null };
  assert.equal(validLine(v, "creation"), "VALID baseline profile=creation rank=global ok=true warns=npc.name.blank info=team.empty,x.y");
  assert.equal(validLine({ ...v, warnings: ["team.empty"], info: [] }, "in-play"), "VALID baseline profile=in-play rank=global ok=true info=team.empty");
  // a real solo hero sheet: no warns=team.empty
  const th = typicalHero(); th._source.system.team = ""; th._source.system.teamBase = "";
  const s = serializeSheet(readActor(th, { lookup: makeLookup(), rank: "global", profile: "creation" }));
  const line = s.body.split("\n").find((l) => l.startsWith("VALID"));
  assert.ok(!/warns=[^ ]*team\.empty/.test(line) && /info=[^ ]*team\.empty/.test(line), line);
});

/* ---------------------------------------------------------------- wave 4 group B */
await test("W4-B-4: LIMITED line when a power with a limit (or its boost) changes a sheet number; none without a limit or when off", async () => {
  const { limitedLines, preparedField } = await import("../scripts/systems/invincible/snapshot.mjs");
  const a = typicalHero();
  const bolt = a.items.find((i) => i.name === "Spark Bolt");   // carries the limit "Needs Charging" in the fixture
  const nid = idGen(4242);
  const fx = effect(nid(), "Bolt punch", [["system.derived.slugfest.damage", 3]]);
  const items = a.items.map((i) => (i === bolt ? { ...i, effects: [fx], _source: { ...i._source, effects: [fx] } } : i));
  const s = snap(rebuild(a, { items }));
  const line = s.body.split("\n").find((l) => l.startsWith("LIMITED"));
  assert.equal(line, `LIMITED slugfestDamage "Spark Bolt" +3 limits="Needs Charging" (the sheet counts it always; the limit's text may restrict it)`);
  assert.match(s.body, /^PREPARED .*slugfestDamage \d+/m, "the number itself stays as the system prepares it");
  assert.equal(snap(a).body.includes("LIMITED"), false, "no effect on the limited power: no line");
  // without the limit: no line; a disabled effect: no line
  assert.equal(snap(rebuild(a, { items: items.filter((i) => i.name !== "Needs Charging") })).body.includes("LIMITED"), false);
  const off = effect(nid(), "Bolt punch", [["system.derived.slugfest.damage", 3]], { disabled: true });
  assert.equal(snap(rebuild(a, { items: a.items.map((i) => (i === bolt ? { ...i, effects: [off], _source: { ...i._source, effects: [off] } } : i)) })).body.includes("LIMITED"), false);
  assert.equal(preparedField("system.derived.health.bonus"), "healthMax"); assert.equal(preparedField("system.attributes.agility.value"), "agility");
  assert.equal(preparedField("bonus.armorProtection"), "bonus.armorProtection");
  // the line has its own key, folds through a diff, and a boost of the limited power counts too
  assert.equal(lineKey(line), "LIMITED slugfestDamage");
  const up = formatUpdate(snap(a).lines, s);
  assert.match(up, /^\+ LIMITED slugfestDamage /m);
  assert.ok(sameLines(applyUpdate(snap(a).lines, up), s.lines));
  const boostRow = { id: "b1", type: "boost", name: "Mock Boost", powerId: "p1", effects: [{ disabled: false, transfer: true, changes: [{ key: "bonus.grapple", mode: "add", value: "2" }] }] };
  assert.deepEqual(limitedLines([{ id: "p1", type: "power", name: "P", effects: [] }, boostRow, { id: "l1", type: "limit", name: "L", powerId: "p1" }]),
    [`LIMITED bonus.grapple "Mock Boost" +2 limits="L" (the sheet counts it always; the limit's text may restrict it)`]);
});

await test("W4-B-6: '~' lines carry what changed inside them; removed one-key lines say what they held; fold unchanged", async () => {
  const { lineDelta, lineFields } = await import("../scripts/systems/invincible/snapshot.mjs");
  const a = typicalHero(), s0 = snap(a);
  const lean = a.items.find((i) => i.name === "Lean Times");
  const s1 = snap(rebuild(a, { items: a.items.filter((i) => i !== lean) }));
  const up = formatUpdate(s0.lines, s1);
  const rows = up.split("\n");
  const at = (re) => rows.findIndex((l) => re.test(l));
  const p = at(/^~ PREPARED /);
  assert.ok(p > 0, up); assert.match(rows[p + 1], /^ {2}\(changed: .*resources 2 -> removed/, rows[p + 1]);   // W5-B-4: a word, not "-"
  const b = at(/^~ BONUS /);
  assert.ok(b > 0, up); assert.match(rows[b + 1], /^ {2}\(changed: resources Lean Times -1 -> removed\)$/);
  assert.match(up, new RegExp(`^- I ${lean.id} "Lean Times"$`, "m"), "removed item named with '-'");
  assert.ok(sameLines(applyUpdate(s0.lines, up), s1.lines), "indented delta lines do not change the fold");
  // nextSheetBlock keeps folding to the fresh picture
  const n0 = nextSheetBlock(null, s0), n1 = nextSheetBlock(n0.held, s1);
  assert.equal(n1.kind, "update"); assert.ok(sameLines(n1.held.lines, s1.lines));
  // field rules: pairs, k=v, quoted name, bare flags, long values
  assert.equal(lineDelta("ATTR fighting 6 agility 7", "ATTR fighting 7 agility 7"), "changed: fighting 6 -> 7");
  assert.equal(lineDelta(`I x1 gear "Rope" ref=gears:a cost=1`, `I x1 gear "Rope Two" ref=gears:a edited cost=2`), `changed: name "Rope" -> "Rope Two", cost 1 -> 2, +edited`);
  assert.equal(lineDelta(`VALID baseline ok=false errors=attr.over(1) budget=3`, `VALID baseline ok=true budget=3`), "changed: ok false -> true, errors -attr.over(1)");
  assert.equal(lineDelta(`VALID baseline ok=false errors=a.b,c.d(Name),e.f info=x.y`, `VALID baseline ok=false errors=a.b,e.f,g.h info=x.y,z.w`), "changed: errors -c.d(Name) +g.h, info +z.w");
  assert.equal(lineDelta(`I x1 talent "T" custom desc="${"a".repeat(80)}"`, `I x1 talent "T" custom desc="${"b".repeat(80)}"`), "changed: desc changed");
  assert.equal(lineDelta("EMPTY drive flaw", "EMPTY flaw"), "changed: -drive");
  assert.deepEqual([...lineFields("PREPARED healthMax 9 slugfest 3 overrides=resources=4").kv], [["healthMax", "9"], ["slugfest", "3"], ["overrides", "resources=4"]]);
  // a one-key line that disappears says what it held
  const k0 = new Map([["BONUS", "BONUS resources: Mock -1"], ["ATTR", "ATTR fighting 1"]]);
  const gone = formatUpdate(k0, { lines: new Map([["ATTR", "ATTR fighting 1"]]), fingerprint: "f" });
  assert.match(gone, /^- BONUS \(was: resources: Mock -1\)$/m);
  assert.ok(sameLines(applyUpdate(k0, gone), new Map([["ATTR", "ATTR fighting 1"]])));
});

/* ---------------------------------------------------------------- wave 5, group B */
await test("W5-B-4: the undo FLAG never rides in a sheet_update (nor makes one); removed / new values read 'removed' / 'none'", async () => {
  const { lineDelta } = await import("../scripts/systems/invincible/snapshot.mjs");
  const undo = (n) => ({ ...typicalHero()._source.flags, "moinens-ai-gen": { undo: { runs: Array.from({ length: n }, (_, i) => ({ runId: `r${i + 1}`, at: i, ops: [] })) } } });
  const a = typicalHero();
  const s0 = snap(a);
  assert.ok(!s0.lines.has("FLAG undo"));
  const n0 = nextSheetBlock(null, s0);
  // the first Apply adds the flag only: unchanged for the model (held keeps what the model has)
  const s1 = snap(rebuild(a, { flags: undo(1) }));
  assert.match(s1.text, /^FLAG undo runs=1 last=r1$/m, "the full block still shows it");
  const n1 = nextSheetBlock(n0.held, s1);
  assert.equal(n1.kind, "unchanged"); assert.equal(n1.held, n0.held);
  // a real change + a new undo run: the update carries the change, never the FLAG line
  const s2 = snap(rebuild(a, { flags: undo(2), system: { attributes: { fighting: { value: 7 } } } }));
  const n2 = nextSheetBlock(n1.held, s2);
  assert.equal(n2.kind, "update"); assert.ok(!/FLAG/.test(n2.text), n2.text); assert.match(n2.text, /^~ ATTR /m);
  // the full block after a reset keeps the line; thresholds unchanged (8 diffs -> full)
  const full = nextSheetBlock({ ...n2.held, diffs: LIMITS.maxDiffs }, snap(rebuild(a, { flags: undo(3), system: { attributes: { fighting: { value: 8 } } } })));
  assert.equal(full.kind, "full"); assert.match(full.text, /supersedes=/); assert.match(full.text, /^FLAG undo runs=3 last=r3$/m);
  // the pu flag (rank) is the model's business: still sent
  const pu = snap(rebuild(a, { flags: { "invincible-plus-ultra": { chargen: { v: 1, rank: "street", archetype: "Speedster" } } } }));
  assert.match(nextSheetBlock(n0.held, pu).text, /FLAG pu rank=street/);
  // removed / added values
  assert.equal(lineDelta("PREPARED healthMax 9 resources 2", "PREPARED healthMax 9"), "changed: resources 2 -> removed");
  assert.equal(lineDelta("PREPARED healthMax 9", "PREPARED healthMax 9 resources 4"), "changed: resources none -> 4");
});

await test("W5-B-5: after a drawer rank / profile change the VALID line says it checks the existing build against the new setting", () => {
  const a = typicalHero();
  const n0 = nextSheetBlock(null, snap(a, { rank: "global" }));
  assert.ok(!/rank changed/.test(n0.text), "first block: nothing to compare");
  const teen = snap(a, { rank: "teen" });
  assert.match(teen.text, /^VALID .*errors=/m);
  const r = nextSheetBlock(n0.held, teen);
  const rows = r.text.split("\n");
  const v = rows.findIndex((l) => /^(~ )?VALID /.test(l));
  assert.ok(v >= 0, r.text);
  const note = rows.slice(v + 1).find((l) => /rank changed/.test(l));
  assert.equal(note, "  (rank changed global -> teen: VALID checks the existing build against the new setting)", r.text);
  assert.ok(sameLines(r.held.lines, teen.lines), "the note is not a sheet line (fold / held unchanged)");
  assert.ok(!parseSheet(r.kind === "full" ? r.text : teen.text).lines.has(""), "parseSheet skips indented notes");
  // the next message under the same rank: no note
  const again = nextSheetBlock(r.held, snap(rebuild(a, { system: { attributes: { fighting: { value: 5 } } } }), { rank: "teen" }));
  assert.ok(!/rank changed/.test(again.text), again.text);
  // profile change on a sheet with errors; a full block (supersedes) carries the note under VALID too
  const bad = rebuild(a, { system: { attributes: { fighting: { value: 9 } } } });
  const h0 = nextSheetBlock(null, snap(bad));
  const ip = nextSheetBlock({ ...h0.held, diffs: LIMITS.maxDiffs }, snap(bad, { profile: "in-play" }));
  assert.equal(ip.kind, "full");
  assert.match(ip.text, /^VALID baseline profile=in-play .*\n {2}\(profile changed creation -> in-play: VALID checks the existing build against the new setting\)$/m);
  // a rank change on a sheet with no errors or warnings: no note
  const okRank = nextSheetBlock(n0.held, snap(a, { rank: "cosmic" }));
  if (!/^(~ )?VALID .*(errors|warns)=/m.test(okRank.text)) assert.ok(!/rank changed/.test(okRank.text));
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
console.log("\nMeasured fixture sizes (local estimator, spec 9.2 [E]; confirm with count_tokens in T8):");
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k}: ${v.items} items, ${v.lines} lines, ${v.chars} chars, ~${v.tokensEst} tokens, cut level ${v.cutLevel}`);
