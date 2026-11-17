// Invincible sheet reader (spec 6.0, 3.5 `reader.mjs`, task T12).
//
// actor (or item) document -> plain "sheet model" the serializer (snapshot.mjs) turns into the compact <sheet> block, and the
// chargen state the vendored rules validate (the VALID line; also the projection read-back of spec 7.5 for T5/T6).
//
// Purity: everything except the three Foundry adapters at the bottom (loadCatalogLookup, readLiveForm, findOpenSheets) works on
// plain objects shaped like Foundry documents ({ id, uuid, name, type, _source, system, items, effects }), so node tests feed
// fixtures. No Foundry globals at import time.
//
// What the model gets and what it never gets (spec 6.0, 10.3):
// - stored values (`_source`) and prepared values (`system` after effects) separately;
// - every owned item with its 16-char id, level, links (power source, boost/limit -> power), gear numbers, the catalogue `ref`
//   it matches by name (or `custom`), `edited` when its description differs from the pack document;
// - descriptions ONLY for custom or hand-edited items (plain text, cut);
// - automations only as a short summary when they differ from the pack copy (or for custom items); a JavaScript body
//   (`extraConfiguration` on automations, boosts and limits) is NEVER read into the model, only a `script` flag;
// - no flags of other modules except plus-ultra's chargen rank/archetype; our own undo journal only as a count.
//
// Heuristics of plus-ultra's import.mjs (stateFromActor) are kept identical: talents in sheet order (1st = hero talent,
// 2nd = occupation talent when an occupation text exists), a limit grants "level" when its power is above basic else "boost",
// "Name (note)" splits back into name + note for powers and drawbacks, attributes from _source.

import * as rules from "./vendor/chargen/rules.mjs";
import { createState } from "./vendor/chargen/state.mjs";
import { norm, normBase, splitNote } from "./names.mjs";

export const MODULE_ID = "moinens-ai-gen";
export const PU_ID = "invincible-plus-ultra";
export const CORE_ID = "invincible-core";
export const LEVEL_WORDS = ["basic", "major", "massive", "monstrous"];
export const ATTRS = rules.ATTRS;
/** actor text fields in sheet order; biography is HTML (plain-texted) */
export const TEXT_FIELDS = ["civilianName", "role", "occupation", "personality", "drive", "flaw", "appearance", "relationships", "team", "teamBase", "biography"];
/** order of item kinds in the block (after the source -> power -> boost/limit tree) */
export const ITEM_ORDER = ["powerSource", "power", "boost", "limit", "talent", "drawback", "gear", "vehicleWeapon", "criticalInjury", "spell"];
/** core packs -> item type they hold (gears holds gear; the index `type` decides per entry) */
export const PACK_TYPES = Object.freeze({ "powers": "power", "power-sources": "powerSource", "boosts": "boost", "limits": "limit", "talents": "talent", "drawbacks": "drawback", "gears": null });
/** core pack -> the catalogue's ref prefix (catalog.mjs KIND_INFO.short): refs on the sheet are the refs the tools take (P1-E) */
export const PACK_SHORT = Object.freeze({ "powers": "powers", "power-sources": "sources", "boosts": "boosts", "limits": "limits", "talents": "talents", "drawbacks": "drawbacks", "gears": "gears" });

/* ------------------------------------------------------------------ small pure helpers */
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
// name matching (balanced trailing "(note)") is shared with proposal / writer / catalog: names.mjs
export { norm, normBase };
export function getPath(o, path) {
  let cur = o;
  for (const k of String(path).split(".")) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}
/** FNV-1a 32 bit -> 7 base36 chars (stable fingerprints, not security) */
export function hash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, "0");
}
const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", mdash: "-", ndash: "-", hellip: "..." };
/** HTML -> one-line plain text. @UUID[..]{label} -> label, [[/r 1d6]] -> 1d6, tags dropped, entities decoded, whitespace collapsed. */
export function plainText(html) {
  let s = String(html ?? "");
  if (!s) return "";
  s = s.replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/@\w+\[([^\]]*)\]/g, "$1")
    .replace(/\[\[\/?\w*\s*([^\]]*)\]\]/g, "$1")
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div|\/tr)\b[^>]*>/gi, " ")
    .replace(/<\s*li\b[^>]*>/gi, " - ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (own(ENT, e.toLowerCase())) return ENT[e.toLowerCase()];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#\d/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return m;
    });
  return s.replace(/\s+/g, " ").trim();
}
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const srcOf = (doc) => doc?._source ?? (typeof doc?.toObject === "function" ? doc.toObject() : doc) ?? {};
const listOf = (coll) => (coll == null ? [] : Array.isArray(coll) ? coll : typeof coll.values === "function" ? [...coll.values()] : [...coll]);

/* ------------------------------------------------------------------ automations / effects */
const AUTO_SKIP = new Set(["_id", "showAsSelection", "open", "origin", "extraConfiguration", "conditionToApply", "postExecution", "macro", "macroUuid"]);
const hasScript = (s) => typeof s === "string" && s.trim() !== "";
/** automations of an item source as a list (TypedObjectField = object keyed by id) */
export const automationsOf = (sys) => Object.values(sys?.automations ?? {}).filter((a) => a && typeof a === "object");
/** JSON with sorted keys; Sets as sorted arrays (a SetField can be a Set right after creation and an array after a reload) */
export function stableJson(v) {
  return JSON.stringify(v, (k, x) => {
    if (x instanceof Set) return [...x].sort();
    if (x && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]]));
    return x;
  });
}
/** stable signature of an item's automations + item-level script, ignoring level flips (showAsSelection) and ids. Script BODIES are
    hashed, never kept. */
export function automationSig(sys) {
  const parts = automationsOf(sys).map((a) => {
    const keep = Object.keys(a).filter((k) => !AUTO_SKIP.has(k)).sort().map((k) => `${k}=${stableJson(a[k])}`);
    if (hasScript(a.extraConfiguration)) keep.push(`js=${hash(a.extraConfiguration)}`);
    for (const k of ["conditionToApply", "postExecution", "macro", "macroUuid"]) if (a[k]) keep.push(`${k}=${hash(a[k])}`);
    return keep.join("|");
  }).sort();
  if (hasScript(sys?.extraConfiguration)) parts.push(`itemjs=${hash(sys.extraConfiguration)}`);
  return hash(parts.join("\n"));
}
const ATTACK_TYPES = new Set(["rollAttack", "rollAttackWithActor"]);
/** short automation summary: type, name, '*' when shown as selection, attack numbers; never a script body or a linked uuid */
export function automationSummary(sys) {
  const autos = automationsOf(sys).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.type).localeCompare(String(b.type)));
  return autos.map((a) => {
    const nums = [];
    if (ATTACK_TYPES.has(a.type)) {
      if (num(a.rollBonus)) nums.push(`bonus${num(a.rollBonus) > 0 ? "+" : ""}${num(a.rollBonus)}`);
      if (num(a.baseDamage) != null) nums.push(`dmg${num(a.baseDamage)}`);
      if (num(a.minRange) || num(a.maxRange)) nums.push(`rng${num(a.minRange) ?? 0}-${num(a.maxRange) ?? 0}`);
      if (a.bypassArmor) nums.push("bypass");
    }
    if (num(a.stressCost)) nums.push(`stress${num(a.stressCost)}`);
    return { type: String(a.type ?? "?"), name: String(a.name ?? ""), sel: !!a.showAsSelection, nums, script: hasScript(a.extraConfiguration) };
  });
}
/** first attack automation of a gear/vehicle weapon -> { bonus, damage, minRange, maxRange, bypassArmor } | null */
export function gearAttack(sys) {
  const a = automationsOf(sys).find((x) => ATTACK_TYPES.has(x.type));
  if (!a) return null;
  return { bonus: num(a.rollBonus) ?? 0, damage: num(a.baseDamage) ?? 0, minRange: num(a.minRange) ?? 0, maxRange: num(a.maxRange) ?? 0, bypassArmor: !!a.bypassArmor };
}
const MODE_WORDS = { 0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };
/** effect doc/source -> { id, name, disabled, transfer, statuses, changes:[{key, mode, value}] } (v14 keeps changes in system.changes with `type`) */
export function readEffect(e) {
  const s = srcOf(e);
  const raw = Array.isArray(s?.system?.changes) ? s.system.changes : Array.isArray(s?.changes) ? s.changes : [];
  const changes = raw.filter((c) => c && c.key).map((c) => ({
    key: String(c.key), mode: typeof c.type === "string" && c.type ? c.type : MODE_WORDS[c.mode] ?? "add", value: c.value ?? ""
  }));
  return {
    id: String(s._id ?? e?.id ?? ""), name: String(s.name ?? e?.name ?? ""), disabled: !!s.disabled,
    transfer: s.transfer !== false, statuses: [...(s.statuses ?? [])].map(String).sort(), changes
  };
}

/* ------------------------------------------------------------------ catalogue lookup (pure) */
/**
 * createCatalogLookup(entries) -> { size, match(item, { powerName }) -> entry|null, fingerprint }
 * entry = { ref: "<pack>:<docId>", pack, id, type, name, level ("" or a level word), power (boost/limit folder name or null),
 *           descHash, autoSig }
 * Name matching like plus-ultra catalog.findByName: exact (normalised), then without a trailing "(note)". Boosts/limits prefer
 * the entry filed under the linked power; split-level powers (one document per level) prefer the item's level.
 * T4 may replace the source of entries (useCatalogLookup); the shape stays.
 */
export function createCatalogLookup(entries = []) {
  const byType = new Map();
  for (const e of entries) {
    if (!e?.type || !e.name) continue;
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e);
  }
  for (const l of byType.values()) l.sort((a, b) => a.name.localeCompare(b.name) || String(a.ref).localeCompare(String(b.ref)));
  function match(item, { powerName = null } = {}) {
    const list = byType.get(item?.type) ?? [];
    if (!list.length) return null;
    const n = norm(item.name), nb = normBase(item.name);
    let hits = list.filter((e) => norm(e.name) === n);
    if (!hits.length) hits = list.filter((e) => normBase(e.name) === nb || norm(e.name) === nb);
    if (!hits.length) return null;
    if (hits.length > 1 && powerName && (item.type === "boost" || item.type === "limit")) {
      const sub = hits.filter((e) => normBase(e.power) === normBase(powerName));
      if (sub.length) hits = sub;
    }
    if (hits.length > 1 && item.level) {
      const sub = hits.filter((e) => e.level === item.level);
      if (sub.length) hits = sub;
    }
    return hits[0];
  }
  const fingerprint = hash(entries.map((e) => `${e.ref}:${e.descHash}:${e.autoSig}`).sort().join("|"));
  return { size: entries.length, match, fingerprint };
}
/** catalogue entry from a compendium index row (pure; used by the Foundry loader and by tests) */
export function entryFromIndex(packName, row, { folderName = null } = {}) {
  const sys = row.system ?? {};
  const type = PACK_TYPES[packName] ?? row.type ?? null;
  return {
    ref: `${PACK_SHORT[packName] ?? packName}:${row._id}`, pack: packName, id: row._id, type, name: String(row.name ?? ""),
    level: LEVEL_WORDS.includes(sys.level) ? sys.level : "",
    power: type === "boost" || type === "limit" ? folderName : null,
    descHash: hash(plainText(sys.description)), autoSig: automationSig(sys)
  };
}
const EMPTY_LOOKUP = createCatalogLookup([]);

/* ------------------------------------------------------------------ power level */
/** level word of a power source: system.level, else the highest showAsSelection automation named after a level (the system's own
    fallback in item-power.mjs setPowerLevel), else "" */
export function powerLevelOf(sys) {
  if (LEVEL_WORDS.includes(sys?.level)) return sys.level;
  let lv = -1;
  for (const a of automationsOf(sys)) {
    if (!a.showAsSelection) continue;
    const n = String(a.name ?? "").toLowerCase();
    LEVEL_WORDS.forEach((w, i) => { if (n.includes(w)) lv = Math.max(lv, i); });
  }
  return lv >= 0 ? LEVEL_WORDS[lv] : "";
}

/* ------------------------------------------------------------------ items */
/**
 * One owned item -> model row. `ctx` = { lookup, byId (id -> raw item source), descCap }.
 */
export function readItem(item, ctx = {}) {
  const s = srcOf(item);
  const sys = s.system ?? {};
  const id = String(s._id ?? item?.id ?? "");
  const type = String(s.type ?? item?.type ?? "");
  const name = String(s.name ?? item?.name ?? "");
  const row = { id, type, name };
  if (type === "power") {
    row.level = powerLevelOf(sys);
    row.sourceId = sys.powerSource ? String(sys.powerSource) : null;
  }
  if (type === "boost" || type === "limit") row.powerId = sys.power ? String(sys.power) : null;
  if (type === "gear" || type === "vehicleWeapon") {
    row.gear = { cost: num(sys.cost) ?? 0, restricted: !!sys.restricted, ...(type === "gear" ? { singleUse: !!sys.singleUse } : {}), attack: gearAttack(sys) };
  }
  if (type === "criticalInjury") row.injury = { lethal: !!sys.lethal, healingTime: String(sys.healingTime ?? "") };
  // catalogue match
  const powerName = row.powerId ? srcOf(ctx.byId?.get(row.powerId))?.name ?? null : null;
  const hit = (ctx.lookup ?? EMPTY_LOOKUP).match({ type, name, level: row.level ?? "" }, { powerName });
  const text = plainText(sys.description);
  const sig = automationSig(sys);
  const scripted = hasScript(sys.extraConfiguration) || automationsOf(sys).some((a) => hasScript(a.extraConfiguration));
  if (hit) {
    row.ref = hit.ref;
    row.edited = hit.descHash !== hash(text);
    row.autoDiff = hit.autoSig !== sig;
  } else {
    row.ref = null; row.edited = false; row.autoDiff = automationsOf(sys).length > 0 || scripted;
  }
  row.script = scripted && (!hit || row.autoDiff);
  if (row.autoDiff) row.auto = automationSummary(sys);
  if (!hit || row.edited) { row.desc = text; row.descLen = text.length; }
  row.effects = listOf(item?.effects ?? s.effects).map(readEffect)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return row;
}

/* ------------------------------------------------------------------ talent roles (W2-3) */
/**
 * Role of each talent of a superhero, the way plus-ultra import.mjs (and chargenStateFromActor below) reads it: by the order of the
 * actor's item collection (= the stored `items` array; Foundry keeps that order across reloads, v14 EmbeddedCollectionField
 * stores the id list in order). 1st talent = "hero", 2nd = "occupation" when the actor has an occupation text, the rest "extra".
 * The item `sort` field (drag order on the sheet) plays no part. New items are always appended, so replacing the hero or the
 * occupation talent shifts the roles of the talents after it (talentRoleShifts).
 * talents: [{ id }] in collection order -> Map(id -> "hero"|"occupation"|"extra")
 */
export const TALENT_ROLES = Object.freeze(["hero", "occupation", "extra"]);
export function talentRoles(talents, hasOccupation) {
  const out = new Map();
  (talents ?? []).forEach((t, n) => out.set(String(t.id ?? t._id), n === 0 ? "hero" : n === 1 && hasOccupation ? "occupation" : "extra"));
  return out;
}
/** roles of an actor-like object's talents (plain `{ items:[{_id,type}], system:{occupation} }` or a document) */
export function talentRolesOf(actor) {
  const src = srcOf(actor);
  const items = listOf(actor?.items ?? src.items).map(srcOf).filter((i) => i?.type === "talent").map((i) => ({ id: i._id ?? i.id, name: i.name }));
  return { roles: talentRoles(items, !!String(src.system?.occupation ?? "").trim()), items };
}
/**
 * Talents that exist before AND after a change and whose role differs (e.g. the hero talent removed and a new one added: the new one
 * lands last, the old occupation talent becomes the hero talent). Pure.
 * -> [{ itemId, name, from, to }]
 */
export function talentRoleShifts(before, after) {
  const b = talentRolesOf(before), a = talentRolesOf(after);
  const out = [];
  for (const t of a.items) {
    const id = String(t.id), from = b.roles.get(id), to = a.roles.get(id);
    if (from && to && from !== to) out.push({ itemId: id, name: String(t.name ?? ""), from, to });
  }
  return out;
}

/* ------------------------------------------------------------------ chargen state (stateFromActor, rewritten pure) */
/**
 * actor-like object -> plus-ultra chargen state (vendored state.mjs shape). Same heuristics as plus-ultra import.mjs (header).
 * `rank`: used when the actor has no plus-ultra chargen rank flag.
 */
export function chargenStateFromActor(actor, { rank } = {}) {
  const src = srcOf(actor), sys = src.system ?? {};
  const flagRank = getPath(src, `flags.${PU_ID}.chargen.rank`);
  const useRank = rules.isRank(rank) ? rank : rules.isRank(flagRank) ? flagRank : rules.DEFAULT_RANK;
  const s = createState({ seed: "000000", rank: useRank, mode: "manual" });
  for (const k of ATTRS) { const v = Number(getPath(sys, `attributes.${k}.value`)); if (Number.isFinite(v)) s.attrs[k] = v; }
  const txt = (k) => String(sys[k] ?? "").trim();
  s.heroName = String(src.name ?? actor?.name ?? "");
  s.civilianName = txt("civilianName");
  s.role = txt("role") || null;
  s.appearance = txt("appearance");
  s.occupation = txt("occupation") || null;
  s.resources = Number(sys.resources) || 0;
  s.personality = txt("personality").split(/[,;\n]+/).map((w) => w.trim()).filter(Boolean);
  s.drive = txt("drive") ? { name: txt("drive"), text: "" } : null;
  s.flaw = txt("flaw") ? { name: txt("flaw"), text: "" } : null;
  for (const line of txt("relationships").split(/\n+/)) {
    const m = line.match(/^(NPC|Hero):\s*(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "hero") s.heroRel = { name: m[2].trim(), actorUuid: null };
    else { const n = splitNote(m[2]); s.npcRel = { name: n.base, type: n.note }; }
  }
  s.team = { name: txt("team"), base: "", where: "", upgrades: [], mode: "text", baseId: null };
  const [base, ups] = txt("teamBase").split(/(?:^|;)\s*upgrades:\s*/i);
  const head = (base ?? "").trim(), comma = head.indexOf(",");
  s.team.base = (comma < 0 ? head : head.slice(0, comma)).trim();
  s.team.where = comma < 0 ? "" : head.slice(comma + 1).trim();
  s.team.upgrades = (ups ?? "").split(",").map((x) => x.trim()).filter(Boolean);

  const items = listOf(actor?.items).map(srcOf);
  const ofType = (type) => items.filter((i) => i.type === type);
  const sourceKey = new Map();
  ofType("powerSource").forEach((it, n) => { const key = `s${n + 1}`; sourceKey.set(it._id, key); s.sources.push({ key, name: it.name, packUuid: null }); });
  const powerKey = new Map();
  ofType("power").forEach((it, n) => {
    const key = `p${n + 1}`;
    powerKey.set(it._id, key);
    // import.mjs: a power note is split only when written with a space ("Extra Limb(s)" stays one name); balanced brackets (names.mjs)
    const sp = splitNote(it.name, { space: true });
    const split = sp.base !== String(it.name ?? "").trim();
    const level = Math.max(0, LEVEL_WORDS.indexOf(powerLevelOf(it.system)));
    s.powers.push({ key, name: split ? sp.base : it.name, packUuid: null, level, sourceKey: sourceKey.get(it.system?.powerSource) ?? s.sources[0]?.key ?? null, boosts: [], limits: [], ...(split && sp.note ? { note: sp.note } : {}) });
  });
  const powerOf = (it) => s.powers.find((p) => p.key === powerKey.get(it.system?.power));
  for (const it of ofType("boost")) powerOf(it)?.boosts.push({ name: it.name, packUuid: null });
  for (const it of ofType("limit")) { const p = powerOf(it); if (p) p.limits.push({ name: it.name, packUuid: null, grants: p.level > 0 ? "level" : "boost" }); }
  const talents = ofType("talent").map((it) => ({ name: it.name, packUuid: null }));
  s.heroTalent = talents[0] ?? null;
  if (s.occupation) { s.occTalent = talents[1] ?? null; s.extraTalents = talents.slice(2); } else s.extraTalents = talents.slice(1);
  s.drawbacks = ofType("drawback").map((it) => {
    const d = splitNote(it.name);
    return d.base !== String(it.name ?? "").trim() ? { name: d.base, packUuid: null, note: d.note } : { name: it.name, packUuid: null, note: "" };
  });
  return s;
}

/* ------------------------------------------------------------------ validation baseline (VALID line) */
const PARAM_ORDER = ["name", "attr", "left", "over", "count", "slots", "rank", "field"];
const issueTag = (i) => {
  const p = i.params ?? {};
  const k = PARAM_ORDER.find((x) => p[x] !== undefined && p[x] !== "");
  return k ? `${i.code}(${p[k]})` : i.code;
};
const uniq = (a) => [...new Set(a)];
/** superhero: vendored rules.validate + budget numbers. -> { kind: "creation", ok, errors, warnings, info, budget } */
export function superheroBaseline(state) {
  const v = rules.validate(state);
  const r = rules.rankOf(state);
  return {
    kind: "creation", rank: state.rank, ok: v.ok,
    errors: uniq(v.errors.map(issueTag)), warnings: uniq(v.warnings.map(issueTag)),
    info: uniq(v.issues.filter((i) => i.severity === "info").map(issueTag)),
    budget: {
      points: rules.budget(state), spent: rules.attrSum(state.attrs), slots: rules.slots(state), rankPowers: r?.powers ?? 0,
      cap: r?.cap ?? 0, drawbacks: rules.drawbackCount(state), maxDrawbacks: rules.MAX_DRAWBACKS,
      extraSources: rules.extraSources(state), extraTalents: rules.extraTalentCount(state)
    }
  };
}
/** npc: structure only (spec 7.4; T5 owns the full NPC validator and may replace this). */
export function npcBaseline(actor, items) {
  const src = srcOf(actor), errors = [], warnings = [];
  for (const k of ATTRS) {
    const v = getPath(src, `system.attributes.${k}.value`);
    if (!Number.isInteger(v) || v < 0 || v > 12) errors.push(`attr.range(${k})`);
  }
  const ids = new Set(items.map((i) => i.id));
  const hasSources = items.some((i) => i.type === "powerSource");
  for (const i of items) {
    if (i.type === "power" && hasSources && i.sourceId && !ids.has(i.sourceId)) errors.push(`power.source.missing(${i.name})`);
    if ((i.type === "boost" || i.type === "limit") && (!i.powerId || !ids.has(i.powerId))) errors.push(`${i.type}.power.missing(${i.name})`);
  }
  const talents = items.filter((i) => i.type === "talent").map((i) => i.name);
  const count = new Map();
  for (const t of talents) { const k = rules.talentKey(t); const c = (count.get(k) ?? 0) + 1; count.set(k, c); if (c === rules.talentLimit(t) + 1) errors.push(`talent.duplicate(${t})`); }
  return { kind: "npc", ok: !errors.length, errors: uniq(errors), warnings, info: [], budget: null };
}

/* ------------------------------------------------------------------ live form (unsaved values) */
const sameValue = (stored, live) => {
  if (stored === live) return true;
  const sv = stored ?? "", lv = live ?? "";
  if (typeof sv === "number" || typeof lv === "number") {
    if (String(sv).trim() === "" || String(lv).trim() === "") return String(sv).trim() === String(lv).trim();
    return Number(sv) === Number(lv);
  }
  if (typeof sv === "boolean" || typeof lv === "boolean") return !!sv === (lv === true || lv === "true" || lv === "on");
  if (Array.isArray(sv) || Array.isArray(lv)) return JSON.stringify(sv) === JSON.stringify(lv);
  if (typeof sv === "object" || typeof lv === "object") return JSON.stringify(sv) === JSON.stringify(lv);
  return String(sv).trim() === String(lv).trim();
};
/**
 * Compare live form values with the stored source. `live` = { "<path>": value } for the actor, and optionally
 * `items: { <itemId>: { "<path>": value } }`. Paths that are not in _source (UI-only inputs) are ignored.
 * -> [{ path, stored, live }] sorted by path; item paths are "items.<id>.<path>".
 */
export function unsavedFrom(actor, live) {
  if (!live || typeof live !== "object") return [];
  const out = [];
  // a schema field that was never written is absent from _source (StringField without initial): compare it as ""
  const isField = (doc, path) => {
    try {
      if (path.startsWith("system.")) return !!doc?.system?.schema?.getField?.(path.slice(7));
      return !!doc?.schema?.getField?.(path);
    } catch { return false; }
  };
  const cmp = (src, values, prefix, doc) => {
    for (const [path, value] of Object.entries(values ?? {})) {
      if (path === "items" && prefix === "") continue;
      let stored = getPath(src, path);
      if (stored === undefined) { if (!isField(doc, path)) continue; stored = ""; }
      if (!sameValue(stored, value)) out.push({ path: prefix + path, stored, live: value });
    }
  };
  cmp(srcOf(actor), live, "", actor);
  const byId = new Map(listOf(actor?.items).map((i) => [String(srcOf(i)._id ?? i.id), i]));
  for (const [id, values] of Object.entries(live.items ?? {})) {
    const it = byId.get(id);
    if (it) cmp(srcOf(it), values, `items.${id}.`, it);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ the sheet model */
/**
 * readActor(actor, opts) -> sheet model (plain data, deterministic for the same input).
 * opts: { lookup (createCatalogLookup), live ({path:value, items:{id:{path:value}}} from readLiveForm), rank, profile }
 */
export function readActor(actor, { lookup = EMPTY_LOOKUP, live = null, rank = null, profile = "creation" } = {}) {
  const src = srcOf(actor), sys = src.system ?? {}, prep = actor?.system ?? sys;
  const rawItems = listOf(actor?.items);
  const byId = new Map(rawItems.map((i) => [String(srcOf(i)._id ?? i.id), i]));
  const items = rawItems.map((i) => readItem(i, { lookup, byId }));
  const flagRank = getPath(src, `flags.${PU_ID}.chargen.rank`);
  const useRank = rules.isRank(rank) ? rank : rules.isRank(flagRank) ? flagRank : rules.DEFAULT_RANK;
  const model = {
    kind: "actor",
    doc: { uuid: String(actor?.uuid ?? `Actor.${src._id ?? actor?.id ?? "?"}`), id: String(src._id ?? actor?.id ?? ""), type: String(src.type ?? actor?.type ?? ""), name: String(src.name ?? actor?.name ?? "") },
    rank: useRank, rankFrom: rules.isRank(rank) ? "drawer" : rules.isRank(flagRank) ? "flag" : "default", profile,
    attrs: Object.fromEntries(ATTRS.map((k) => [k, num(getPath(sys, `attributes.${k}.value`))])),
    stored: {
      health: num(getPath(sys, "derived.health.value")), resolve: num(getPath(sys, "derived.resolve.value")),
      reputation: num(sys.reputation), resources: num(sys.resources), karma: num(sys.karma)
    },
    prepared: readPrepared(actor, src, prep),
    bonuses: readBonuses(prep?.bonuses),
    texts: Object.fromEntries(TEXT_FIELDS.map((k) => [k, k === "biography" ? plainText(sys[k]) : String(sys[k] ?? "").replace(/[ \t\r]+/g, " ").replace(/ *\n\s*/g, "\n").trim()])),
    items,
    effects: listOf(actor?.effects).map(readEffect).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    flags: readFlags(src),
    unsaved: unsavedFrom(actor, live),
    validation: null
  };
  const type = model.doc.type;
  // W2-3: the talent role is the collection order (talentRoles); the sheet line shows it, so the block's (tree) order may differ
  if (type === "superhero") {
    const roles = talentRoles(items.filter((i) => i.type === "talent"), !!model.texts.occupation);
    for (const i of items) if (roles.has(i.id)) i.role = roles.get(i.id);
  }
  if (type === "superhero") model.validation = superheroBaseline(chargenStateFromActor(actor, { rank: useRank }));
  else if (type === "npc") model.validation = npcBaseline(actor, items);
  return model;
}
function readPrepared(actor, src, prep) {
  const out = {};
  const put = (k, v) => { const n = num(v); if (n !== null) out[k] = n; };
  put("healthMax", getPath(prep, "derived.health.max"));
  put("resolveMax", getPath(prep, "derived.resolve.max"));
  put("slugfest", getPath(prep, "derived.slugfest.max"));
  put("slugfestDamage", getPath(prep, "derived.slugfest.damage"));
  // effect-modified copies of stored numbers: only when they differ from what is stored
  for (const k of ["reputation", "resources", "karma"]) if (num(prep?.[k]) !== null && num(prep?.[k]) !== num(src.system?.[k])) put(k, prep[k]);
  for (const k of ATTRS) {
    const v = num(getPath(prep, `attributes.${k}.value`));
    if (v !== null && v !== num(getPath(src.system, `attributes.${k}.value`))) out[k] = v;
  }
  if (num(prep?.initiativeSize) !== null) put("initiativeSize", prep.initiativeSize);
  if (prep?.maxPush && typeof prep.maxPush === "object") for (const [k, v] of Object.entries(prep.maxPush).sort()) put(`maxPush.${k}`, v);
  else put("maxPush", prep?.maxPush);
  // paths overridden by active effects (actor.overrides): the sheet disables these inputs
  // (paths already shown above as their own numbers, or in the BONUS line - top-level `bonus.*` keys of the system's effects - are left out)
  const ov = flatten(actor?.overrides ?? {});
  const shown = /^(bonus\.|system\.(bonus|resources$|reputation$|karma$|initiativeSize$|maxPush|attributes\.\w+\.value$|derived\.))/;
  const paths = Object.keys(ov).filter((p) => !shown.test(p)).sort();
  if (paths.length) out.overrides = paths.map((p) => `${p.replace(/^system\./, "")}=${ov[p]}`);
  return out;
}
function flatten(o, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, p, out); else out[p] = v;
  }
  return out;
}
/** system.bonuses (prepared by the system from applied effects: { key: { sourceName: value } }) -> sorted list */
function readBonuses(b) {
  if (!b || typeof b !== "object") return [];
  const out = [];
  for (const key of Object.keys(b).sort()) {
    const per = b[key];
    if (!per || typeof per !== "object") continue;
    for (const from of Object.keys(per).sort()) out.push({ key: key.replace(/^system\./, ""), from, value: per[from] });
  }
  return out;
}
function readFlags(src) {
  const out = {};
  const pu = getPath(src, `flags.${PU_ID}.chargen`);
  if (pu && typeof pu === "object") {
    out.pu = {};
    if (pu.rank) out.pu.rank = String(pu.rank);
    if (pu.archetype) out.pu.archetype = String(pu.archetype);
  }
  const undo = getPath(src, `flags.${MODULE_ID}.undo`);
  const runs = Array.isArray(undo?.runs) ? undo.runs : [];
  if (runs.length) out.undo = { runs: runs.length, last: String(runs[runs.length - 1]?.runId ?? "") };
  return out;
}

/** a standalone item document (gear / vehicleWeapon drawer) -> sheet model */
export function readItemDocument(item, { lookup = EMPTY_LOOKUP, live = null } = {}) {
  const src = srcOf(item);
  const row = readItem(item, { lookup, byId: new Map() });
  row.desc = plainText(src.system?.description); row.descLen = row.desc.length;   // the subject itself: always its text
  return {
    kind: "item",
    doc: { uuid: String(item?.uuid ?? `Item.${src._id ?? "?"}`), id: row.id, type: row.type, name: row.name },
    items: [row], effects: [], flags: {}, unsaved: unsavedFrom({ _source: src, items: [] }, live), validation: null
  };
}

/* ================================================================== Foundry adapters (runtime only) */
let lookupProvider = null, lookupP = null;
/** T4 (or a test) can supply the catalogue lookup: fn(game) -> Promise<lookup>. Resets the cache. */
export function useCatalogLookup(fn) { lookupProvider = typeof fn === "function" ? fn : null; lookupP = null; }
export function invalidateCatalogLookup() { lookupP = null; }
/** memoised per page load; failures yield an empty lookup (every item then reads as `custom`), never a throw */
export function getCatalogLookup(game = globalThis.game) {
  lookupP ??= (async () => {
    try { return await (lookupProvider ?? loadCatalogLookup)(game); }
    catch (e) { try { console.warn("moinens-ai-gen | catalogue lookup failed", e); } catch { /* ignore */ } lookupP = null; return EMPTY_LOOKUP; }
  })();
  return lookupP;
}
/**
 * Reads the core packs' DOCUMENTS (about 360, ~0.2-0.5 s once per page; memoised by getCatalogLookup). Documents, not the raw index:
 * the raw index rows are not cleaned by the system's automation schemas (keys like canChangeAttribute / stressCost present on one
 * side only), so an index-based signature flags untouched copies as "different" (live finding 2026-11-17, lane 20). The cleaned
 * document _source matches what an owned copy holds.
 */
export async function loadCatalogLookup(game = globalThis.game) {
  const entries = [];
  for (const packName of Object.keys(PACK_TYPES)) {
    const pack = game?.packs?.get?.(`${CORE_ID}.${packName}`);
    if (!pack) continue;
    const docs = await pack.getDocuments();
    for (const doc of docs) {
      const row = doc._source ?? doc.toObject();
      const folderName = doc.folder?.name ?? (row.folder ? pack.folders?.get?.(row.folder)?.name ?? null : null);
      const e = entryFromIndex(packName, row, { folderName });
      if (e.type) entries.push(e);
    }
  }
  return createCatalogLookup(entries);
}

/** open, rendered sheets showing `doc` (ApplicationV2 instances with a form) */
export function findOpenSheets(doc) {
  const out = [];
  const inst = globalThis.foundry?.applications?.instances;
  const apps = inst?.values ? [...inst.values()] : [];
  for (const app of apps) {
    try { if (app?.document === doc && app.rendered && app.form instanceof HTMLFormElement) out.push(app); } catch { /* ignore */ }
  }
  return out;
}
function formObject(app) {
  const FDE = globalThis.foundry?.applications?.ux?.FormDataExtended;
  if (!FDE || !app?.form) return null;
  try { return { ...new FDE(app.form).object }; } catch { return null; }
}
/**
 * Live values of the actor's open sheet and of open sheets of its owned items (v14: foundry.applications.ux.FormDataExtended,
 * the same class ApplicationV2 uses on submit). -> { "<path>": value, items: { <id>: {...} } } or null when no sheet is open.
 * Read-only: builds FormData from the DOM, never submits.
 */
export function readLiveForm(actor) {
  let any = false;
  const out = {};
  for (const app of findOpenSheets(actor)) { const o = formObject(app); if (o) { Object.assign(out, o); any = true; } }
  if (actor?.items) {
    for (const it of actor.items) {
      for (const app of findOpenSheets(it)) {
        const o = formObject(app);
        if (o) { out.items ??= {}; out.items[it.id] = Object.assign(out.items[it.id] ?? {}, o); any = true; }
      }
    }
  }
  return any ? out : null;
}
