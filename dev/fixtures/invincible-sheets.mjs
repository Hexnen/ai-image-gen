// Fake Invincible actors and a fake catalogue for node tests (T12 snapshot; reusable by T5/T6 projection tests).
// ALL names and texts are INVENTED placeholders: no rulebook text, no real catalogue names or ids.
// Shapes follow the system's data models (systems/invincible/system/models/*) and Foundry document layout:
//   actor = { id, uuid, name, type, _source:{ _id, name, type, system, flags }, system (prepared), items:[item], effects:[effect], overrides }
//   item  = { id, name, type, _source:{ _id, name, type, system, effects }, effects:[effect source] }
import { entryFromIndex, createCatalogLookup } from "../../scripts/systems/invincible/reader.mjs";

/* ---------------------------------------------------------------- deterministic ids and filler text */
export function idGen(seed = 1) {
  let x = seed >>> 0 || 1;
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return () => { let s = ""; for (let i = 0; i < 16; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; s += A[x % A.length]; } return s; };
}
const WORDS = "the device hums softly while its owner adjusts a brass dial and the lens glows with a pale amber light that flickers when the wind turns cold over rooftops near the harbor market at dusk".split(" ");
/** invented filler prose of about n characters */
export function filler(n, seed = 3) {
  let s = "", i = seed;
  while (s.length < n) { s += (s ? " " : "") + WORDS[i % WORDS.length]; i = (i * 7 + 3) % 9973; }
  return s.charAt(0).toUpperCase() + s.slice(1, n).trimEnd() + ".";
}
const html = (t) => `<p>${t}</p>`;

/* ---------------------------------------------------------------- catalogue (fake compendium index rows) */
const cid = idGen(777);
const auto = (type, name, extra = {}) => ({ _id: cid(), type, name, showAsSelection: true, open: true, origin: "", extraConfiguration: "", ...extra });
const autos = (...a) => Object.fromEntries(a.map((x) => [x._id, x]));
/** rows per pack: { _id, name, type, folder, system } ; folders = { id: name } for boosts/limits */
export function makeCatalogRows() {
  const rows = {
    "power-sources": [
      { name: "Strange Meteor", system: { description: html(filler(300, 11)) } },
      { name: "Tinkerer Genius", system: { description: html(filler(280, 12)) } },
      { name: "Ancient Bloodline", system: { description: html(filler(260, 13)) } }
    ],
    "powers": [
      { name: "Glide Wings", system: { level: "", description: html(filler(900, 21)), automations: autos(auto("usePower", "Basic"), auto("usePower", "Major", { showAsSelection: false })) } },
      { name: "Spark Bolt", system: { level: "", description: html(filler(900, 22)), automations: autos(auto("rollAttack", "Basic Bolt", { rollBonus: 0, baseDamage: 2, minRange: 0, maxRange: 2 }), auto("rollAttack", "Major Bolt", { showAsSelection: false, baseDamage: 3, minRange: 0, maxRange: 3 })) } },
      { name: "Echo Sense", system: { level: "", description: html(filler(700, 23)), automations: autos(auto("usePower", "Basic")) } },
      { name: "Iron Hide", system: { level: "basic", description: html(filler(600, 24)), automations: autos(auto("usePower", "Basic")) } },
      { name: "Iron Hide", system: { level: "major", description: html(filler(600, 25)), automations: autos(auto("usePower", "Major")) } },
      { name: "Quick Step", system: { level: "", description: html(filler(500, 26)), automations: autos(auto("usePower", "Basic")) } },
      { name: "Mind Static", system: { level: "", description: html(filler(800, 27)), automations: autos(auto("rollAttack", "Basic Static", { baseDamage: 1 })) } }
    ],
    "boosts": [
      { name: "Wider Arc", folder: "Spark Bolt", system: { description: html(filler(200, 31)), extraConfiguration: "automation.baseDamage += 1;" } },
      { name: "Silent Flight", folder: "Glide Wings", system: { description: html(filler(200, 32)), extraConfiguration: "" } },
      { name: "Wider Arc", folder: "Mind Static", system: { description: html(filler(200, 33)), extraConfiguration: "" } }
    ],
    "limits": [
      { name: "Needs Charging", folder: "Spark Bolt", system: { description: html(filler(200, 41)), extraConfiguration: "" } },
      { name: "Loud", folder: "Glide Wings", system: { description: html(filler(200, 42)), extraConfiguration: "" } }
    ],
    "talents": [
      { name: "Quick Wits", system: { description: html(filler(250, 51)) } },
      { name: "Streetwise", system: { description: html(filler(250, 52)) } },
      { name: "Steady Hands", system: { description: html(filler(250, 53)) } },
      { name: "Tough Skin", system: { description: html(filler(250, 54)) } }
    ],
    "drawbacks": [
      { name: "Lean Times", system: { description: html(filler(250, 61)) } },
      { name: "Haunted", system: { description: html(filler(250, 62)) } }
    ],
    "gears": [
      { name: "Grapple Line", type: "gear", system: { description: html(filler(220, 71)), cost: 1, restricted: false, singleUse: false } },
      { name: "Stun Baton", type: "gear", system: { description: html(filler(220, 72)), cost: 2, restricted: true, singleUse: false, automations: autos(auto("rollAttack", "Strike", { rollBonus: 1, baseDamage: 2, minRange: 0, maxRange: 0 })) } }
    ]
  };
  for (const list of Object.values(rows)) for (const r of list) r._id = cid();
  return rows;
}
export const CATALOG_ROWS = makeCatalogRows();
export function makeLookup(rows = CATALOG_ROWS) {
  const entries = [];
  for (const [pack, list] of Object.entries(rows)) for (const r of list) entries.push(entryFromIndex(pack, r, { folderName: r.folder ?? null }));
  return createCatalogLookup(entries);
}
export const catRow = (pack, name, level = null) =>
  CATALOG_ROWS[pack].find((r) => r.name === name && level != null && r.system.level === level) ?? CATALOG_ROWS[pack].find((r) => r.name === name);

/* ---------------------------------------------------------------- actor builder */
const clone = (x) => JSON.parse(JSON.stringify(x));
/** an owned item copied from a catalogue row like plus-ultra does (toObject, new _id), with overrides */
export function fromCatalog(nextId, pack, name, { level = null, system = {}, rename = null, effects = [], type = null } = {}) {
  const row = catRow(pack, name, level);
  if (!row) throw new Error(`fixture: no catalogue row ${pack}/${name}`);
  const T = { "power-sources": "powerSource", powers: "power", boosts: "boost", limits: "limit", talents: "talent", drawbacks: "drawback", gears: "gear" };
  const sys = { ...clone(row.system), ...system };
  if (level && level !== "basic" && sys.automations) for (const a of Object.values(sys.automations)) a.showAsSelection = a.name.toLowerCase().includes(level);
  if (level && pack === "powers") sys.level = level;
  return item(nextId(), type ?? row.type ?? T[pack], rename ?? row.name, sys, effects);
}
export function item(id, type, name, system = {}, effects = []) {
  const _source = { _id: id, name, type, system: { description: "", automations: {}, ...system }, effects: clone(effects), flags: {} };
  return { id, name, type, _source, effects: clone(effects) };
}
export const effect = (id, name, changes, { disabled = false, transfer = true, statuses = [] } = {}) =>
  ({ _id: id, name, disabled, transfer, statuses, system: { changes: changes.map(([key, value, type = "add"]) => ({ key, value: String(value), type })) } });

/** derived values the way the system prepares them (base-actor.mjs prepareDerivedData), plus effect bonuses */
export function prepare(source, items, actorEffects = []) {
  const sys = clone(source.system);
  const all = [...items.flatMap((i) => i.effects.filter((e) => e.transfer !== false).map((e) => ({ ...e, parentName: i.name }))), ...actorEffects.map((e) => ({ ...e, parentName: e.name }))];
  const bonuses = {};
  const overrides = {};
  for (const e of all) {
    if (e.disabled) continue;
    for (const c of e.system.changes) {
      const k = c.key.replace("bonus.", "");
      (bonuses[k] ??= {})[e.parentName] = Number.isNaN(Number(c.value)) ? c.value : parseInt(c.value, 10);
      if (c.key.startsWith("system.") && c.type === "add") {
        const path = c.key.slice(7).split(".");
        let o = sys; for (const p of path.slice(0, -1)) o = o[p] ??= {};
        const last = path[path.length - 1];
        o[last] = (Number(o[last]) || 0) + Number(c.value);
        overrides[c.key] = o[last];
      }
    }
  }
  const a = (k) => sys.attributes[k].value;
  const comp = { slugfest: ["strength"], health: ["fighting", "agility", "strength"], resolve: ["reason", "intuition", "presence"] };
  for (const [k, list] of Object.entries(comp)) sys.derived[k].max = Math.ceil(list.reduce((s, x) => s + a(x), 0) / 2) + (sys.derived[k].bonus ?? 0);
  sys.derived.slugfest.damage = (sys.derived.slugfest.damage ?? 0) + Math.ceil(a("strength") / 2);
  sys.bonuses = bonuses;
  return { system: sys, overrides: expand(overrides) };
}
const expand = (flat) => { const o = {}; for (const [k, v] of Object.entries(flat)) { const p = k.split("."); let c = o; for (const x of p.slice(0, -1)) c = c[x] ??= {}; c[p[p.length - 1]] = v; } return o; };

export function actor({ id, name, type = "superhero", attrs, system = {}, flags = {}, items = [], effects = [] }) {
  const base = {
    attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v }])),
    derived: { slugfest: { value: 2, max: 2 }, health: { value: 0, max: 2 }, resolve: { value: 0, max: 2 } },
    biography: "", civilianName: "", role: "", appearance: "", reputation: 0, karma: 0, resources: 1,
    occupation: "", personality: "", drive: "", flaw: "", relationships: "", team: "", teamBase: ""
  };
  const sys = { ...base, ...system, derived: { ...base.derived, ...(system.derived ?? {}) } };
  const _source = { _id: id, name, type, system: sys, flags: clone(flags), items: items.map((i) => i._source), effects: clone(effects) };
  const prep = prepare(_source, items, effects);
  return { id, uuid: `Actor.${id}`, name, type, documentName: "Actor", _source, system: prep.system, overrides: prep.overrides, items, effects: clone(effects) };
}

/* ---------------------------------------------------------------- a typical, VALID global-rank superhero */
export function typicalHero(seed = 101) {
  const nid = idGen(seed);
  const src = fromCatalog(nid, "power-sources", "Strange Meteor");
  const wings = fromCatalog(nid, "powers", "Glide Wings", { system: { powerSource: src.id } });
  const bolt = fromCatalog(nid, "powers", "Spark Bolt", { level: "major", system: { powerSource: src.id } });
  const sense = fromCatalog(nid, "powers", "Echo Sense", { system: { powerSource: src.id } });
  const silent = fromCatalog(nid, "boosts", "Silent Flight", { system: { power: wings.id } });
  const charge = fromCatalog(nid, "limits", "Needs Charging", { system: { power: bolt.id } });
  const fxQuick = effect(nid(), "Quick Wits", [["system.initiativeSize", 1]]);
  const quick = fromCatalog(nid, "talents", "Quick Wits", { effects: [fxQuick] });
  const street = fromCatalog(nid, "talents", "Streetwise");
  const lean = fromCatalog(nid, "drawbacks", "Lean Times", { effects: [effect(nid(), "Lean Times", [["system.resources", -1]])] });
  const line = fromCatalog(nid, "gears", "Grapple Line");
  const baton = fromCatalog(nid, "gears", "Stun Baton");
  const cam = item(nid(), "gear", "Pocket Camera", { description: html(filler(260, 81)), cost: 1, restricted: false, singleUse: false });
  // hand-edited copy of a catalogue talent? no: keep the hero clean; the hand edit lives on the gear line
  line._source.system.description = html(filler(240, 82)); // hand-edited description of a catalogue item
  const items = [src, wings, bolt, sense, silent, charge, quick, street, lean, line, baton, cam];
  return actor({
    id: nid(), name: "Amber Kestrel", attrs: { fighting: 6, agility: 7, strength: 5, reason: 5, intuition: 5, presence: 5 },
    system: {
      civilianName: "Mira Vell", role: "Wildcard", occupation: "Courier", resources: 3, reputation: 2,
      personality: "Restless, Loyal", drive: "Keep the harbor safe", flaw: "Takes every bet",
      appearance: filler(180, 91), relationships: "NPC: Tomas Rel (mentor)\nHero: Grey Lantern", team: "Harbor Watch", teamBase: "Warehouse, Pier 9",
      derived: { health: { value: 9, max: 9 }, resolve: { value: 8, max: 8 }, slugfest: { value: 3, max: 3 } }
    },
    flags: { "invincible-plus-ultra": { chargen: { v: 1, runId: "run-x", rank: "global", archetype: "Speedster" } }, "some-other-module": { secret: "OTHER_MODULE_SECRET" } },
    items
  });
}

/* ---------------------------------------------------------------- a big NPC with many custom items */
export function bigNpc(seed = 202, { customGear = 14, descLen = 700 } = {}) {
  const nid = idGen(seed);
  const sources = [fromCatalog(nid, "power-sources", "Ancient Bloodline"), fromCatalog(nid, "power-sources", "Tinkerer Genius"), item(nid(), "powerSource", "Clockwork Heart", { description: html(filler(500, 101)) })];
  const items = [...sources];
  const pw = [];
  const add = (x) => { items.push(x); return x; };
  pw.push(add(fromCatalog(nid, "powers", "Spark Bolt", { level: "major", system: { powerSource: sources[0].id } })));
  pw.push(add(fromCatalog(nid, "powers", "Iron Hide", { level: "major", system: { powerSource: sources[0].id } })));
  pw.push(add(fromCatalog(nid, "powers", "Mind Static", { system: { powerSource: sources[1].id } })));
  pw.push(add(fromCatalog(nid, "powers", "Quick Step", { system: { powerSource: sources[1].id } })));
  pw.push(add(fromCatalog(nid, "powers", "Echo Sense", { system: { powerSource: sources[2].id } })));
  for (let k = 0; k < 5; k++) {
    pw.push(add(item(nid(), "power", `Clockwork Trick ${k + 1}`, {
      powerSource: sources[2].id, level: k % 2 ? "major" : "basic", description: html(filler(descLen, 110 + k)),
      automations: autos(auto("rollAttack", `Gear Shot ${k + 1}`, { baseDamage: k + 1, maxRange: 2, extraConfiguration: "console.log('SECRET_SCRIPT_BODY');" }))
    })));
  }
  add(fromCatalog(nid, "boosts", "Wider Arc", { system: { power: pw[0].id } }));
  add(fromCatalog(nid, "boosts", "Wider Arc", { system: { power: pw[2].id } }));
  add(fromCatalog(nid, "limits", "Needs Charging", { system: { power: pw[0].id } }));
  for (let k = 0; k < 4; k++) add(item(nid(), "boost", `Overwind ${k + 1}`, { power: pw[5 + k].id, description: html(filler(300, 130 + k)), extraConfiguration: "return 'SECRET_SCRIPT_BODY';" }));
  for (const t of ["Quick Wits", "Streetwise", "Steady Hands", "Tough Skin"]) add(fromCatalog(nid, "talents", t, { effects: t === "Tough Skin" ? [effect(nid(), t, [["system.derived.health.bonus", 2]])] : [] }));
  add(item(nid(), "talent", "Gearwright", { description: html(filler(400, 140)) }));
  add(fromCatalog(nid, "drawbacks", "Haunted", { rename: "Haunted (by the old foundry)" }));
  add(item(nid(), "drawback", "Rusting Joints", { description: html(filler(350, 141)) }, [effect(nid(), "Rusting Joints", [["system.attributes.agility.value", -1]], { disabled: true })]));
  for (let k = 0; k < customGear; k++) {
    add(item(nid(), "gear", `Contraption ${String.fromCharCode(65 + (k % 26))}${k >= 26 ? k : ""}`, {
      description: html(filler(descLen, 150 + k)), cost: (k % 4) + 1, restricted: k % 3 === 0, singleUse: k % 5 === 0,
      automations: k % 2 ? autos(auto("rollAttack", "Fire", { rollBonus: k % 3, baseDamage: 2 + (k % 3), minRange: 0, maxRange: 1 + (k % 4) })) : {}
    }));
  }
  add(item(nid(), "criticalInjury", "Cracked Mainspring", { lethal: false, healingTime: "two weeks", description: html(filler(150, 190)) }));
  return actor({
    id: nid(), name: "The Clockmaster", type: "npc", attrs: { fighting: 5, agility: 4, strength: 6, reason: 9, intuition: 7, presence: 6 },
    system: {
      occupation: "Inventor", personality: "Patient, Vain", drive: filler(120, 201), flaw: filler(100, 202), appearance: filler(500, 203),
      biography: html(filler(1400, 204)), relationships: filler(200, 205), resources: 4, reputation: 3,
      derived: { health: { value: 12, max: 12 }, resolve: { value: 11, max: 11 }, slugfest: { value: 3, max: 3 } }
    },
    flags: { "moinens-ai-gen": { undo: { runs: [{ runId: "r1", at: 1, ops: [] }, { runId: "r2", at: 2, ops: [] }] } } },
    items,
    effects: [effect(nid(), "Stunned", [], { statuses: ["stunned"] }), effect(nid(), "Overclocked", [["system.attributes.strength.value", 2]])]
  });
}

/** an actor that would never fit: many custom items with long descriptions (cap and cut order) */
export const hugeNpc = () => bigNpc(303, { customGear: 60, descLen: 1500 });
