// Invincible proposals (spec 6 `submit_proposal` (+ `dryRun`, D-9; `check_proposal` internal only), 7.5, 10.3; task T5). PURE: no Foundry globals.
//
// What lives here:
// - PROPOSAL_SCHEMA: the strict tool input schema of submit_proposal (static: cached prefix); `dryRun` = the old check_proposal.
// - checkShape(input, schema): the LOCAL L0 check against the same schema (the harness never trusts a tool input).
// - normalize(input): L0 semantic shape (ops ids, one of ref/custom, required fields per op) + the deterministic autoFixed set
//   of spec 7.3 (trimmed strings, collapsed duplicate personality words).
// - customItemData / gearPatch / appendParagraph: the item WHITELIST of spec 10.3 (name, plain-text description, numbers,
//   booleans, at most one rollAttack automation). Never extraConfiguration, runMacro, conditionToApply/postExecution UUIDs,
//   effects, img, flags.
// - project(actor, ops, { catalog }): ops applied to an in-memory copy of the actor (spec 7.5.1), never to the document.
// - replaceToOps(actor, proposal, { catalog }): a `replace` proposal diffed against the actor into ops (spec 6 / 8.4: items
//   with the same name are KEPT with their ids). T6 may use it as its replace -> ops conversion.
// - dependants / selectOps: GM deselection with dependants unticked together (spec 7.5.6).
// - expectFor / checkStale: per-item fingerprints for the stale check at apply time (spec 7.5.5).
//
// Items on the projected copy are plain `_source`-shaped objects ({ _id, name, type, system, effects, flags }); items added by
// an op get the id `new:<opId>` (the writer creates real ids). Ops reference each other only through opIds.

import { ATTRS, RANKS, isRank, DEFAULT_RANK } from "./vendor/chargen/rules.mjs";
import { NOTE_MAX, norm, normBase, baseName, noteOf, withNote, cleanNote } from "./names.mjs";

export const LEVEL_WORDS = Object.freeze(["basic", "major", "massive", "monstrous"]);
export const OP_KINDS = Object.freeze(["addItem", "updateItem", "removeItem", "updateActor"]);
/** item types an op may add from the catalogue (catalogue kind == item type) */
export const ITEM_KINDS = Object.freeze(["powerSource", "power", "boost", "limit", "talent", "drawback", "gear", "vehicleWeapon"]);
/** item types a `replace` proposal owns on an actor (injuries are never touched; gear only when the proposal has `gear`, W4-A-3) */
export const CREATION_TYPES = Object.freeze(["powerSource", "power", "boost", "limit", "talent", "drawback"]);
export const CUSTOM_TYPES = Object.freeze(["gear", "vehicleWeapon"]);
export const TEXT_KEYS = Object.freeze(["civilianName", "role", "occupation", "personality", "drive", "flaw", "appearance", "relationships", "team", "teamBase"]);
/** actor paths an op may write (spec 6 updateActor whitelist) */
export const ACTOR_PATHS = Object.freeze([
  "name", ...ATTRS.map((a) => `system.attributes.${a}.value`), ...TEXT_KEYS.map((k) => `system.${k}`), "system.reputation", "system.resources"
]);
/** written only when the GM asked for exactly that field (spec O25): allowed, always flagged as a warning */
export const SENSITIVE_PATHS = Object.freeze(["system.karma", "system.derived.health.value", "system.derived.resolve.value"]);
/** never written (derived / foreign) */
export const FORBIDDEN_ACTOR_PATH = /^(flags|img|prototypeToken|ownership|_id|_stats|items|effects|folder|sort)\b|^system\.(derived\.\w+\.(max|bonus)|bonuses|maxPush|initiativeSize)/;
export const NEW_PREFIX = "new:";
export const TEXT_MAX = 2000;
export const NAME_MAX = 120;
export { NOTE_MAX };   // names.mjs (one value for validator and writer)
export const OPS_MAX = 60;

/* ================================================================== schema (static, cached prefix) */
const S = (description) => ({ type: "string", ...(description ? { description } : {}) });
const I = (description) => ({ type: "integer", ...(description ? { description } : {}) });
const B = (description) => ({ type: "boolean", ...(description ? { description } : {}) });
const obj = (properties, required = [], description) => ({ type: "object", additionalProperties: false, required, properties, ...(description ? { description } : {}) });
const LEVEL = { type: "string", enum: [...LEVEL_WORDS] };
// Field docs live ONCE in PROPOSAL_GUIDE (the submit_proposal description), not per field (shorter cached prefix).
// W4-A-2: `grants` is gone from the schema (the sheet decides what a limit pays for: a level when its power is above Basic, else
// a boost; the summary says which). Old inputs that still carry it pass L0: normalize strips it silently (stripLegacy).
const ATTACK = obj({ damage: I(), bonus: I(), minRange: I(), maxRange: I(), bypassArmor: B(), attribute: { type: "string", enum: [...ATTRS] } }, ["damage"]);
const GEAR_NUMBERS = obj({ cost: I(), restricted: B(), singleUse: B(), attack: ATTACK });
const CUSTOM = obj({ type: { type: "string", enum: [...CUSTOM_TYPES] }, name: S(), description: S(), cost: I(), restricted: B(), singleUse: B(), attack: ATTACK }, ["type", "name"]);
const ATTRS_OBJ = obj(Object.fromEntries(ATTRS.map((a) => [a, I()])), []);
const TEXTS_OBJ = obj(Object.fromEntries(TEXT_KEYS.map((k) => [k, S()])), []);
const SET = obj({
  level: LEVEL, powerSourceItemId: S(), powerSourceOpId: S(), powerItemId: S(), powerOpId: S(), note: S(), name: S(), descriptionAppend: S(),
  gear: GEAR_NUMBERS, attributes: ATTRS_OBJ, texts: TEXTS_OBJ, reputation: I(), resources: I(), karma: I(), health: I(), resolve: I()
}, []);
const OP = obj({
  op: { type: "string", enum: [...OP_KINDS] }, opId: S(), ref: S(), custom: CUSTOM, level: LEVEL,
  sourceItemId: S(), sourceOpId: S(), powerItemId: S(), powerOpId: S(), note: S(),
  itemId: S(), cascade: B(), set: SET
}, ["op", "opId"]);
const REF_NOTE = obj({ ref: S(), note: S() }, ["ref"]);
/** W4-A-3: replace gear entry = a catalogue gear/vehicleWeapon ref OR a custom item (same fields as addItem custom) */
const GEAR_ENTRY = obj({ ref: S(), custom: CUSTOM }, []);
const REPLACE = obj({
  rank: { type: "string", enum: ["teen", "street", "global", "cosmic"] },
  name: S(), attributes: ATTRS_OBJ, texts: TEXTS_OBJ, resources: I(), reputation: I(),
  sources: { type: "array", items: obj({ key: S(), ref: S() }, ["key", "ref"]) },
  powers: { type: "array", items: obj({
    ref: S(), level: LEVEL, source: S(), note: S(),
    boosts: { type: "array", items: obj({ ref: S() }, ["ref"]) },
    limits: { type: "array", items: obj({ ref: S() }, ["ref"]) }
  }, ["ref"]) },
  talents: { type: "array", items: REF_NOTE }, drawbacks: { type: "array", items: REF_NOTE }, gear: { type: "array", items: GEAR_ENTRY }, item: CUSTOM
}, []);

export const PROPOSAL_SCHEMA = Object.freeze(obj({
  target: { type: "string", enum: ["this", "newItem"] }, mode: { type: "string", enum: ["ops", "replace"] },
  ops: { type: "array", items: OP }, proposal: REPLACE, rationale: S(),
  choiceNotes: { type: "array", items: obj({ opId: S(), path: S(), why: S() }, ["why"]) }, dryRun: B()
}, ["target", "mode"]));

/** How to fill the schema (the end of the submit_proposal description). Static text: cached prefix. */
export const PROPOSAL_GUIDE = [
  "target: \"this\" (the open document) or \"newItem\" (a new world gear/vehicleWeapon item, mode replace + proposal.item).",
  "mode \"ops\" (default for an existing sheet): ops = small in-place operations, each with your own unique opId (e.g. \"a1\"); everything not named stays as it is, ids kept.",
  `- addItem: ref (catalogue) OR custom (only gear/vehicleWeapon: type, name, plain-text description, cost >= 0, restricted, singleUse (gear), attack {damage, bonus, minRange, maxRange, bypassArmor, attribute} = one attack). power: level (basic/major/massive/monstrous; split-level powers: the power's index ref + level, or the level's own ref) and its source: sourceItemId (sheet id) or sourceOpId (a powerSource added in the same list). boost/limit: powerItemId or powerOpId, no note (its choice, e.g. a sense, goes in choiceNotes). power/talent/drawback: note = the choice shown in brackets, only for a real choice (no decorative notes; when the GM named none, invent one that fits); an effect with bonus.[attribute] (e.g. Signature Item): put one attribute in the note (it may name the item too: \"Shield, Fighting\"), the builder sets the effect from it; at most ${NOTE_MAX} characters, no parentheses inside (\"Kingpin\", not \"Kingpin (Wilson Fisk)\").`,
  "- updateItem {itemId, set}: power: level, powerSourceItemId|powerSourceOpId, note; boost/limit: powerItemId|powerOpId; talent/drawback: note (\"\" removes); gear/vehicleWeapon: name, descriptionAppend (plain text paragraph), gear {cost, restricted, singleUse, attack}.",
  "- removeItem {itemId, cascade}: a power with boosts/limits or a source used by powers needs cascade:true or re-pointing ops in the same list.",
  "- updateActor {set}: name (the hero name), attributes {fighting..presence}, texts {civilianName, role (an English role key), occupation (the occupation's English catalogue name), personality (exactly two words, comma separated), drive, flaw, appearance, relationships (one line each: \"NPC: Name (who they are)\", \"Hero: Name\"), team, teamBase}, reputation (the rank's reputation value), resources (the occupation's Resources value). karma/health/resolve (current values) only when the GM asked for them (a replace in the creation profile or a build on an empty sheet sets Health/Resolve to max itself).",
  "mode \"replace\" (blank actor or an explicit rebuild): proposal = rank (must be the drawer's rank), name, attributes, texts, resources, reputation (give both, values as in updateActor), sources [{key, ref}], powers [{ref, level, source (a sources key), note, boosts [{ref}], limits [{ref}]}], talents [{ref, note}] (hero talent first, then the occupation talent, then extras; written in this order, kept talents are moved), drawbacks [{ref, note}], gear [{ref} | {custom}] (optional: given = the hero's whole gear list, the rest is removed; left out = gear untouched); items with the same name are kept. Its errors name proposal.* paths and the entry; their opId is the summary's. For a gear/vehicleWeapon document: proposal.item (same fields as custom).",
  "rationale: one short paragraph for the GM (required unless dryRun): what you chose, why, the main alternative. choiceNotes: [{opId or path, why}] for every pick that is not obvious (how a new slot is paid for, each drawback)."
].join("\n");

/* ================================================================== small helpers */
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
export const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x, (k, v) => (v instanceof Set ? [...v] : v))));
// name + note helpers: balanced trailing "(note)", notes without brackets, cut at a word boundary (names.mjs, P1-D)
export { norm, normBase, baseName, noteOf, withNote };
/** the rank validation uses: the drawer's rank > plus-ultra's flag > Global. -> { rank, from: "drawer"|"flag"|"default" } */
export function resolveRank(plain, rank) {
  if (isRank(rank)) return { rank, from: "drawer" };
  const f = getPath(plain, "flags.invincible-plus-ultra.chargen.rank");
  return isRank(f) ? { rank: f, from: "flag" } : { rank: DEFAULT_RANK, from: "default" };
}
const listOf = (coll) => (coll == null ? [] : Array.isArray(coll) ? coll : typeof coll.values === "function" ? [...coll.values()] : [...coll]);
const srcOf = (doc) => doc?._source ?? (typeof doc?.toObject === "function" ? doc.toObject() : doc) ?? {};
/** FNV-1a 32 bit -> base36 (fingerprints, not security) */
export function hash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, "0");
}
export function stableJson(v) {
  return JSON.stringify(v, (k, x) => {
    if (x instanceof Set) return [...x].sort();
    if (x && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]]));
    return x;
  });
}
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
/** plain text -> safe HTML paragraphs (one <p> per blank-line block) */
export function textToHtml(text) {
  const parts = String(text ?? "").replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}
export const appendParagraph = (html, text) => `${String(html ?? "")}${textToHtml(text)}`;
const levelIndex = (w) => LEVEL_WORDS.indexOf(w);

/* ================================================================== L0: local schema check */
/**
 * checkShape(value, schema, path) -> [{ path, expected }] (empty = ok). Supports the subset PROPOSAL_SCHEMA uses: type
 * (string/integer/boolean/object/array), enum, required, properties, additionalProperties:false, items.
 */
export function checkShape(value, schema, path = "") {
  const out = [];
  const at = (p) => (path ? `${path}${p.startsWith("[") ? "" : "."}${p}` : p.replace(/^\./, ""));
  const t = schema.type;
  if (t === "object") {
    if (!isObj(value)) return [{ path: path || "(input)", expected: "object" }];
    for (const k of schema.required ?? []) if (value[k] === undefined || value[k] === null) out.push({ path: at(k), expected: "required" });
    for (const k of Object.keys(value)) {
      if (!own(schema.properties ?? {}, k)) { if (schema.additionalProperties === false) out.push({ path: at(k), expected: "no such field" }); continue; }
      if (value[k] === undefined || value[k] === null) continue;
      out.push(...checkShape(value[k], schema.properties[k], at(k)));
    }
    return out;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return [{ path, expected: "array" }];
    value.forEach((v, i) => out.push(...checkShape(v, schema.items, `${path}[${i}]`)));
    return out;
  }
  if (t === "string" && typeof value !== "string") return [{ path, expected: "string" }];
  if (t === "integer" && !Number.isInteger(value)) return [{ path, expected: "integer" }];
  if (t === "boolean" && typeof value !== "boolean") return [{ path, expected: "boolean" }];
  if (schema.enum && !schema.enum.includes(value)) return [{ path, expected: `one of ${schema.enum.join("|")}` }];
  return out;
}

/* ================================================================== normalisation (L0 semantics + autoFixed) */
/**
 * normalize(input, { requireRationale }) -> { proposal, errors:[{code, path, opId?, params}], autoFixed:[string] }
 * proposal = { target, mode, ops?, proposal?, rationale, choiceNotes } with strings trimmed. Never throws.
 */
export function normalize(input, { requireRationale = false } = {}) {
  const errors = [], autoFixed = [];
  input = stripLegacy(input);
  const shape = checkShape(input, PROPOSAL_SCHEMA);
  for (const s of shape) errors.push({ code: "input.shape", path: s.path, params: { expected: s.expected } });
  if (shape.some((s) => s.path === "(input)")) return { proposal: null, errors, autoFixed };
  const p = trimDeep(clone(input), "", autoFixed);
  delete p.dryRun;   // D-9: a tool flag, not part of the proposal (same proposalId with or without it)
  p.target ??= "this";
  p.choiceNotes ??= [];
  if (requireRationale && !String(p.rationale ?? "").trim()) errors.push({ code: "input.shape", path: "rationale", params: { expected: "required on submit" } });
  // W4-A-3: a replace gear entry is a catalogue ref OR a custom item
  if (isObj(p.proposal) && Array.isArray(p.proposal.gear)) p.proposal.gear.forEach((g, i) => {
    if (isObj(g) && !!g.ref === !!g.custom) errors.push({ code: "input.shape", path: `proposal.gear[${i}].ref`, params: { expected: "exactly one of ref or custom" } });
  });
  if (p.mode === "ops") {
    if (!Array.isArray(p.ops) || !p.ops.length) errors.push({ code: "ops.empty", path: "ops", params: {} });
    else if (p.ops.length > OPS_MAX) errors.push({ code: "ops.tooMany", path: "ops", params: { max: OPS_MAX } });
    if (p.proposal) errors.push({ code: "input.shape", path: "proposal", params: { expected: "only with mode replace" } });
    const seen = new Set();
    (Array.isArray(p.ops) ? p.ops : []).forEach((op, i) => {
      if (!isObj(op)) return;
      const path = `ops[${i}]`, opId = op.opId;
      if (!opId) errors.push({ code: "opId.missing", path, params: {} });
      else if (seen.has(opId)) errors.push({ code: "opId.duplicate", path, opId, params: { opId } });
      else if (opId.startsWith(NEW_PREFIX) || opId.length > 40) errors.push({ code: "input.shape", path: `${path}.opId`, opId, params: { expected: "a short id without \"new:\"" } });
      seen.add(opId);
      const need = (k, why) => { if (op[k] === undefined || op[k] === "") errors.push({ code: "input.shape", path: `${path}.${k}`, opId, params: { expected: why } }); };
      const forbid = (keys) => { for (const k of keys) if (op[k] !== undefined) errors.push({ code: "input.shape", path: `${path}.${k}`, opId, params: { expected: `not used by ${op.op}` } }); };
      if (op.op === "addItem") {
        if (!!op.ref === !!op.custom) errors.push({ code: "input.shape", path: `${path}.ref`, opId, params: { expected: "exactly one of ref or custom" } });
        forbid(["itemId", "set", "cascade"]);
      } else if (op.op === "updateItem") { need("itemId", "required"); needSet(op, path, errors); forbid(["ref", "custom", "level", "sourceItemId", "sourceOpId", "powerItemId", "powerOpId", "note", "cascade"]); }
      else if (op.op === "removeItem") { need("itemId", "required"); forbid(["ref", "custom", "level", "sourceItemId", "sourceOpId", "powerItemId", "powerOpId", "note", "set"]); }
      else if (op.op === "updateActor") { needSet(op, path, errors); forbid(["ref", "custom", "level", "sourceItemId", "sourceOpId", "powerItemId", "powerOpId", "note", "itemId", "cascade"]); }
    });
  } else if (p.mode === "replace") {
    if (!isObj(p.proposal)) errors.push({ code: "input.shape", path: "proposal", params: { expected: "required with mode replace" } });
    if (p.ops?.length) errors.push({ code: "input.shape", path: "ops", params: { expected: "only with mode ops" } });
  }
  // autoFix (spec 7.3): duplicate personality words collapse
  const fixPers = (texts, where) => {
    if (!isObj(texts) || typeof texts.personality !== "string") return;
    const words = texts.personality.split(/[,;]+/).map((w) => w.trim()).filter(Boolean);
    const out = [];
    for (const w of words) if (!out.some((x) => norm(x) === norm(w))) out.push(w);
    const joined = out.join(", ");
    if (joined !== texts.personality) { autoFixed.push(`${where}: personality "${texts.personality}" -> "${joined}"`); texts.personality = joined; }
  };
  (p.ops ?? []).forEach((op, i) => fixPers(op?.set?.texts, `ops[${i}].set.texts`));
  fixPers(p.proposal?.texts, "proposal.texts");
  // notes (P1-D): brackets inside a note are replaced (autoFixed, deterministic: the item name is "Name (note)"); a note longer
  // than NOTE_MAX is cut at a word boundary and reported as the warning note.cut (the writer cuts the same way)
  const warnings = [];
  const fixNote = (holder, key, path, opId) => {
    if (!isObj(holder) || typeof holder[key] !== "string" || !holder[key]) return;
    const c = cleanNote(holder[key]);
    if (c.parens) autoFixed.push(`${path}: brackets in the note replaced: "${holder[key]}" -> "${c.full}"`);
    if (c.cut) warnings.push({ code: "note.cut", path, ...(opId ? { opId } : {}), params: { max: NOTE_MAX, length: c.full.length, kept: c.note } });
    holder[key] = c.note;
  };
  (p.ops ?? []).forEach((op, i) => { if (!isObj(op)) return; fixNote(op, "note", `ops[${i}].note`, op.opId); fixNote(op.set, "note", `ops[${i}].set.note`, op.opId); });
  if (isObj(p.proposal)) {
    for (const k of ["powers", "talents", "drawbacks"]) (Array.isArray(p.proposal[k]) ? p.proposal[k] : []).forEach((x, i) => fixNote(x, "note", `proposal.${k}[${i}].note`));
  }
  return { proposal: p, errors, autoFixed, warnings };
}
/** W4-A-2: fields the schema no longer has but old inputs (replays, stored proposals) still carry: dropped silently (a COPY) */
export function stripLegacy(input) {
  if (!isObj(input)) return input;
  const hasOld = (Array.isArray(input.ops) && input.ops.some((o) => isObj(o) && own(o, "grants"))) ||
    (isObj(input.proposal) && Array.isArray(input.proposal.powers) && input.proposal.powers.some((p) => isObj(p) && Array.isArray(p.limits) && p.limits.some((l) => isObj(l) && own(l, "grants"))));
  if (!hasOld) return input;
  const c = clone(input);
  for (const o of Array.isArray(c.ops) ? c.ops : []) if (isObj(o)) delete o.grants;
  for (const p of Array.isArray(c.proposal?.powers) ? c.proposal.powers : []) for (const l of isObj(p) && Array.isArray(p.limits) ? p.limits : []) if (isObj(l)) delete l.grants;
  return c;
}
function needSet(op, path, errors) {
  if (!isObj(op.set) || !Object.keys(op.set).length) errors.push({ code: "input.shape", path: `${path}.set`, opId: op.opId, params: { expected: "a non-empty set" } });
}
function trimDeep(x, path, fixed) {
  if (typeof x === "string") { const t = x.trim(); if (t !== x && x.trim()) fixed.push(`${path || "(input)"}: whitespace trimmed`); return t; }
  if (Array.isArray(x)) return x.map((v, i) => trimDeep(v, `${path}[${i}]`, fixed));
  if (isObj(x)) { for (const k of Object.keys(x)) x[k] = trimDeep(x[k], path ? `${path}.${k}` : k, fixed); return x; }
  return x;
}

/* ================================================================== item whitelist (spec 10.3) */
/** forbidden anywhere in AI-defined item data */
export const FORBIDDEN_ITEM_KEYS = Object.freeze(["extraConfiguration", "runMacro", "conditionToApply", "postExecution", "macro", "macroUuid", "effects", "img", "flags", "_id", "_stats", "ownership", "folder", "sort", "origin"]);
const automationId = (seed) => hash(`atk:${seed}`).padEnd(16, "0").slice(0, 16).replace(/[^A-Za-z0-9]/g, "0");
/** attack numbers -> ONE rollAttack automation (numbers + booleans only) */
export function attackAutomation(attack, seed = "a") {
  const a = attack ?? {};
  const maxRange = Number.isInteger(a.maxRange) ? a.maxRange : 0;
  const attr = ATTRS.includes(a.attribute) ? a.attribute : maxRange > 0 ? "agility" : "fighting";
  const id = automationId(seed);
  return {
    [id]: {
      _id: id, type: "rollAttack", name: "Attack", showAsSelection: false, open: true,
      attribute: [attr], requireAttribute: true, rollBonus: Number.isInteger(a.bonus) ? a.bonus : 0, stressCost: 0,
      baseDamage: Number.isInteger(a.damage) ? a.damage : 0, minRange: Number.isInteger(a.minRange) ? a.minRange : 0, maxRange,
      actualDamage: true, bypassArmor: !!a.bypassArmor
    }
  };
}
/**
 * AI-defined gear / vehicle weapon -> item data built from the whitelist ONLY. Anything else in the input is dropped and named in
 * `stripped`. -> { data: { name, type, system }, stripped:[path] }
 */
export function customItemData(input, { seed = "custom" } = {}) {
  const raw = isObj(input) ? input : {};
  const allowed = new Set(["type", "name", "description", "cost", "restricted", "singleUse", "attack"]);
  const stripped = Object.keys(raw).filter((k) => !allowed.has(k));
  const type = CUSTOM_TYPES.includes(raw.type) ? raw.type : "gear";
  const system = { description: textToHtml(raw.description), cost: Number.isInteger(raw.cost) ? raw.cost : 0, restricted: !!raw.restricted, automations: {} };
  if (type === "gear") system.singleUse = !!raw.singleUse;
  else if (raw.singleUse !== undefined) stripped.push("singleUse");
  if (isObj(raw.attack)) {
    const okA = new Set(["damage", "bonus", "minRange", "maxRange", "bypassArmor", "attribute"]);
    for (const k of Object.keys(raw.attack)) if (!okA.has(k)) stripped.push(`attack.${k}`);
    system.automations = attackAutomation(raw.attack, seed);
  }
  return { data: { name: String(raw.name ?? "").slice(0, NAME_MAX), type, system }, stripped: stripped.sort() };
}
/** updateItem set.gear on an existing gear item -> system patch (numbers/booleans; attack replaces the FIRST rollAttack's numbers only) */
export function gearPatch(gear, itemSource, { seed = "upd" } = {}) {
  const patch = {};
  if (!isObj(gear)) return patch;
  if (Number.isInteger(gear.cost)) patch.cost = gear.cost;
  if (typeof gear.restricted === "boolean") patch.restricted = gear.restricted;
  if (typeof gear.singleUse === "boolean" && itemSource?.type === "gear") patch.singleUse = gear.singleUse;
  if (isObj(gear.attack)) {
    const autos = itemSource?.system?.automations ?? {};
    const atkId = Object.keys(autos).find((k) => autos[k]?.type === "rollAttack");
    if (atkId) {
      const a = gear.attack, cur = autos[atkId];
      patch[`automations.${atkId}`] = {
        ...pickNumbers(cur),
        ...(Number.isInteger(a.damage) ? { baseDamage: a.damage } : {}), ...(Number.isInteger(a.bonus) ? { rollBonus: a.bonus } : {}),
        ...(Number.isInteger(a.minRange) ? { minRange: a.minRange } : {}), ...(Number.isInteger(a.maxRange) ? { maxRange: a.maxRange } : {}),
        ...(typeof a.bypassArmor === "boolean" ? { bypassArmor: a.bypassArmor } : {}), ...(ATTRS.includes(a.attribute) ? { attribute: [a.attribute] } : {})
      };
    } else Object.assign(patch, { automationsAdd: attackAutomation(gear.attack, seed) });
  }
  return patch;
}
const pickNumbers = (a) => Object.fromEntries(["baseDamage", "rollBonus", "minRange", "maxRange", "bypassArmor"].filter((k) => a?.[k] !== undefined).map((k) => [k, a[k]]));

/* ================================================================== actor copy + set -> paths */
/** document (Foundry or fixture) -> plain actor source with items (a COPY; the document is never touched) */
export function toPlainActor(doc) {
  const src = clone(typeof doc?.toObject === "function" ? doc.toObject() : srcOf(doc));
  if (!Array.isArray(src.items) || (!src.items.length && listOf(doc?.items).length)) src.items = listOf(doc?.items).map((i) => clone(srcOf(i)));
  src.items = src.items.map((i) => ({ ...i, system: i.system ?? {} }));
  src.system ??= {};
  return src;
}
/** wrap a plain actor so reader.mjs functions read it like a document */
export const asDoc = (plain) => ({ _source: plain, id: plain._id, name: plain.name, type: plain.type, items: plain.items, effects: plain.effects ?? [] });

/** updateActor `set` (structured, or dotted paths) -> { "<path>": value } */
export function actorSetPaths(set) {
  const out = {};
  if (!isObj(set)) return out;
  for (const [k, v] of Object.entries(set)) {
    if (k === "attributes" && isObj(v)) for (const [a, x] of Object.entries(v)) out[`system.attributes.${a}.value`] = x;
    else if (k === "texts" && isObj(v)) for (const [t, x] of Object.entries(v)) out[`system.${t}`] = x;
    else if (k === "name") out.name = v;
    else if (k === "reputation" || k === "resources" || k === "karma") out[`system.${k}`] = v;
    else if (k === "health" || k === "resolve") out[`system.derived.${k}.value`] = v;
    else out[k] = v;   // dotted path given directly ("system.drive"): checked against the whitelist
  }
  return out;
}
export function setPath(o, path, value) {
  const parts = path.split(".");
  let c = o;
  for (const p of parts.slice(0, -1)) { if (!isObj(c[p])) c[p] = {}; c = c[p]; }
  c[parts[parts.length - 1]] = value;
}
export function getPath(o, path) {
  let c = o;
  for (const k of String(path).split(".")) { if (c == null || typeof c !== "object") return undefined; c = c[k]; }
  return c;
}
/** structured `set` keys that belong to items vs actor */
const ITEM_SET_KEYS = new Set(["level", "powerSourceItemId", "powerSourceOpId", "powerItemId", "powerOpId", "note", "name", "descriptionAppend", "gear"]);
const SET_FIELDS_BY_TYPE = {
  power: ["level", "powerSourceItemId", "powerSourceOpId", "note"],
  boost: ["powerItemId", "powerOpId"], limit: ["powerItemId", "powerOpId"],
  talent: ["note"], drawback: ["note"],
  gear: ["name", "descriptionAppend", "gear"], vehicleWeapon: ["name", "descriptionAppend", "gear"]
};

/* ================================================================== projection (spec 7.5.1) */
/**
 * project(actorDoc | plainActor, ops, { catalog, plain }) -> {
 *   actor: plain projected copy, opInfo: { <opId>: { kind, itemId, type, name, cascade:[{itemId,type,name}], splitSwap? } },
 *   errors: [{ code, path, opId, params }]   (L1: references, links, fields; structural link errors on the result)
 * }
 * Ops are applied in list order on a COPY. Cross-op references (sourceOpId/powerOpId) may point forward or back.
 */
export function project(doc, ops, { catalog = null, plain = null } = {}) {
  const actor = plain ? clone(plain) : toPlainActor(doc);
  const before = new Map(actor.items.map((i) => [i._id, i]));
  const errors = [], opInfo = {};
  const err = (code, op, i, params = {}, field = "") => errors.push({ code, path: `ops[${i}]${field ? `.${field}` : ""}`, opId: op?.opId, params });
  const byOp = new Map((ops ?? []).filter((o) => o?.opId).map((o) => [o.opId, o]));
  const items = () => actor.items;
  const find = (id) => items().find((x) => x._id === id) ?? null;
  const removedBy = new Map();   // itemId -> opId
  const cascadeRemoves = [];     // [{ opId, itemId }]


  // resolve a reference to an item that exists after projection: existing item id, or an addItem opId
  const refItem = (op, i, itemId, opId, wantType, field) => {
    if (itemId && opId) { err("input.shape", op, i, { expected: `either ${field}ItemId or ${field}OpId` }, field); return undefined; }
    if (opId) {
      const target = byOp.get(opId);
      if (!target || target.op !== "addItem") { err("link.opId.unknown", op, i, { ref: opId }, `${field}OpId`); return undefined; }
      const t = addedType(target, catalog);
      if (t && t !== wantType) { err("link.opId.kind", op, i, { ref: opId, want: wantType, have: t }, `${field}OpId`); return undefined; }
      return NEW_PREFIX + opId;
    }
    if (itemId) {
      const it = before.get(itemId);
      if (!it) { err("item.missing", op, i, { itemId }, `${field}ItemId`); return undefined; }
      if (it.type !== wantType) { err("link.opId.kind", op, i, { ref: itemId, want: wantType, have: it.type }, `${field}ItemId`); return undefined; }
      return itemId;
    }
    return null;
  };

  (ops ?? []).forEach((op, i) => {
    if (!isObj(op)) return;
    if (op.op === "addItem") {
      const made = buildAdded(op, i, { catalog, err, refItem, actor, byOp });
      if (!made) return;
      actor.items.push(made.item);
      opInfo[op.opId] = { kind: "add", itemId: made.item._id, type: made.item.type, name: made.item.name, ref: made.ref ?? null, ...(made.custom ? { custom: true } : {}), cascade: [] };
      return;
    }
    if (op.op === "updateActor") {
      const paths = actorSetPaths(op.set);
      const changed = [];
      for (const [path, value] of Object.entries(paths)) {
        const okPath = ACTOR_PATHS.includes(path) || SENSITIVE_PATHS.includes(path);
        if (!okPath || FORBIDDEN_ACTOR_PATH.test(path)) { err("field.forbidden", op, i, { field: path, type: "actor" }, "set"); continue; }
        const isNum = /attributes\.|reputation|resources|karma|derived\./.test(path);
        if (isNum && !Number.isInteger(value)) { err("field.value", op, i, { field: path, expected: "integer" }, "set"); continue; }
        if (isNum && !/attributes\./.test(path) && value < 0) { err("field.value", op, i, { field: path, expected: ">= 0" }, "set"); continue; }
        if (!isNum && typeof value !== "string") { err("field.value", op, i, { field: path, expected: "string" }, "set"); continue; }
        if (!isNum && value.length > TEXT_MAX) { err("field.value", op, i, { field: path, expected: `at most ${TEXT_MAX} characters` }, "set"); continue; }
        if (path === "name" && !value) { err("field.value", op, i, { field: path, expected: "a non-empty name" }, "set"); continue; }
        const old = path === "name" ? actor.name : getPath(actor, path);
        if (path === "name") actor.name = value; else setPath(actor, path, value);
        changed.push({ path, from: old ?? null, to: value });
      }
      opInfo[op.opId] = { kind: "actor", changed, cascade: [] };
      return;
    }
    // updateItem / removeItem
    const it = find(op.itemId);
    if (!it) {
      if (removedBy.has(op.itemId)) err("item.removed", op, i, { itemId: op.itemId, by: removedBy.get(op.itemId) }, "itemId");
      else err("item.missing", op, i, { itemId: op.itemId }, "itemId");
      return;
    }
    if (op.op === "removeItem") {
      actor.items = actor.items.filter((x) => x._id !== it._id);
      removedBy.set(it._id, op.opId);
      opInfo[op.opId] = { kind: "remove", itemId: it._id, type: it.type, name: it.name, cascade: [] };
      if (op.cascade) cascadeRemoves.push({ opId: op.opId, itemId: it._id, i });
      return;
    }
    // updateItem
    const allowed = SET_FIELDS_BY_TYPE[it.type] ?? [];
    const info = { kind: "update", itemId: it._id, type: it.type, name: it.name, changed: [], cascade: [] };
    for (const k of Object.keys(op.set ?? {})) {
      if (!ITEM_SET_KEYS.has(k) || !allowed.includes(k)) { err("field.forbidden", op, i, { field: k, type: it.type }, `set.${k}`); continue; }
    }
    const set = op.set ?? {};
    if (allowed.includes("level") && set.level) {
      const entry = catalog?.findByName?.("power", baseName(it.name)) ?? null;
      const from = powerLevel(it.system);
      if (entry && !levelExists(entry, set.level)) err("ref.level.none", op, i, { name: baseName(it.name), level: set.level, max: LEVEL_WORDS[maxLevelOf(entry)] }, "set.level");
      else {
        it.system.level = set.level;
        info.changed.push({ field: "level", from, to: set.level });
        if (entry?.split && from !== set.level) info.splitSwap = { from, to: set.level, fromRef: entry.levelDocs?.[from] ? `powers:${entry.levelDocs[from]}` : null, toRef: `powers:${entry.levelDocs[set.level]}` };
      }
    }
    if (allowed.includes("powerSourceItemId") && (set.powerSourceItemId || set.powerSourceOpId)) {
      const id = refItem(op, i, set.powerSourceItemId, set.powerSourceOpId, "powerSource", "set.powerSource");
      if (id) { info.changed.push({ field: "powerSource", from: it.system.powerSource ?? null, to: id }); it.system.powerSource = id; }
    }
    if (allowed.includes("powerItemId") && (set.powerItemId || set.powerOpId)) {
      let id = refItem(op, i, set.powerItemId, set.powerOpId, "power", "set.power");
      // folder rule (spec 7.1 L1): a catalogue boost/limit may only move to a power it is filed under
      const named = (catalog?.byKind?.(it.type) ?? []).filter((e) => normBase(e.name) === normBase(it.name));
      const target = id ? (actor.items.find((x) => x._id === id) ?? null) : null;
      const tName = target ? baseName(target.name) : id ? (catalog?.get?.(byOp.get(set.powerOpId)?.ref)?.name ?? null) : null;
      if (id && named.length && tName && !named.some((e) => normBase(e.power) === normBase(tName))) {
        err("ref.power.mismatch", op, i, { name: it.name, type: it.type, power: named.map((e) => e.power).join(" / "), target: tName }, "set.powerItemId");
        id = null;
      }
      if (id) { info.changed.push({ field: "power", from: it.system.power ?? null, to: id }); it.system.power = id; info.repoint = true; }
    }
    if (allowed.includes("note") && set.note !== undefined) {
      const next = withNote(it.name, set.note);
      info.changed.push({ field: "name", from: it.name, to: next, note: noteOf(next) });   // W3-8: `note` = the note it now has ("" = none)
      it.name = next;
    }
    if (allowed.includes("name") && set.name !== undefined) {
      if (!set.name || set.name.length > NAME_MAX) err("field.value", op, i, { field: "name", expected: `1..${NAME_MAX} characters` }, "set.name");
      else { info.changed.push({ field: "name", from: it.name, to: set.name }); it.name = set.name; }
    }
    if (allowed.includes("descriptionAppend") && set.descriptionAppend) {
      if (set.descriptionAppend.length > TEXT_MAX) err("field.value", op, i, { field: "descriptionAppend", expected: `at most ${TEXT_MAX} characters` }, "set.descriptionAppend");
      else { it.system.description = appendParagraph(it.system.description, set.descriptionAppend); info.changed.push({ field: "description", from: "(kept)", to: "+1 paragraph" }); }
    }
    if (allowed.includes("gear") && set.gear) {
      const patch = gearPatch(set.gear, it);
      for (const [k, v] of Object.entries(patch)) {
        if (k === "automationsAdd") { it.system.automations = { ...(it.system.automations ?? {}), ...v }; info.changed.push({ field: "attack", from: null, to: "added" }); continue; }
        if (k.startsWith("automations.")) { const id = k.slice(12); it.system.automations[id] = { ...it.system.automations[id], ...v }; info.changed.push({ field: "attack", from: "(numbers)", to: "(numbers)" }); continue; }
        info.changed.push({ field: k, from: it.system[k] ?? null, to: v });
        it.system[k] = v;
      }
    }
    opInfo[op.opId] = info;
  });

  // cascade: dependants still pointing at a removed item (not re-pointed by any op) go with it (recursively)
  for (const c of cascadeRemoves) {
    const queue = [c.itemId];
    while (queue.length) {
      const gone = queue.shift();
      const deps = actor.items.filter((x) => ((x.type === "boost" || x.type === "limit") && x.system?.power === gone) || (x.type === "power" && x.system?.powerSource === gone));
      for (const d of deps) {
        actor.items = actor.items.filter((x) => x._id !== d._id);
        removedBy.set(d._id, c.opId);
        opInfo[c.opId].cascade.push({ itemId: d._id, type: d.type, name: d.name });
        queue.push(d._id);
      }
    }
  }
  // structural links on the result (spec 7.5.2): every boost/limit -> a present power, every power -> a present source
  const present = new Set(actor.items.map((x) => x._id));
  const opIndex = (id) => (ops ?? []).findIndex((o) => o?.opId === id);
  const dangling = (x, gone, code, dtype) => {
    const by = gone ? removedBy.get(gone) : null;
    if (by) { errors.push({ code: "remove.dependants", path: `ops[${opIndex(by)}]`, opId: by, params: { name: nameOf(before.get(gone)), dependant: x.name, dtype } }); return; }
    const own = String(x._id).startsWith(NEW_PREFIX) ? String(x._id).slice(NEW_PREFIX.length) : null;
    if (own) errors.push({ code, path: `ops[${opIndex(own)}]`, opId: own, params: { name: x.name, type: x.type } });
    else errors.push({ code, path: `items.${x._id}`, params: { name: x.name, type: x.type, preexisting: true } });
  };
  for (const x of actor.items) {
    if ((x.type === "boost" || x.type === "limit") && (!x.system?.power || !present.has(x.system.power))) dangling(x, x.system?.power, "link.power.missing", x.type);
    if (x.type === "power" && x.system?.powerSource && !present.has(x.system.powerSource)) dangling(x, x.system.powerSource, "link.source.missing", "power");
  }
  return { actor, opInfo, errors, removedBy };
}
const nameOf = (it) => it?.name ?? "?";
/** the item type an addItem op would create (null when its ref is unknown) */
export function addedType(op, catalog) {
  if (op.custom) return CUSTOM_TYPES.includes(op.custom.type) ? op.custom.type : null;
  const e = catalog?.get?.(op.ref);
  return e && ITEM_KINDS.includes(e.kind) ? e.kind : null;
}
export function powerLevel(sys) {
  if (LEVEL_WORDS.includes(sys?.level)) return sys.level;
  let lv = -1;
  for (const a of Object.values(sys?.automations ?? {})) {
    if (!a?.showAsSelection) continue;
    const n = String(a.name ?? "").toLowerCase();
    LEVEL_WORDS.forEach((w, k) => { if (n.includes(w)) lv = Math.max(lv, k); });
  }
  return lv >= 0 ? LEVEL_WORDS[lv] : "basic";
}
export const maxLevelOf = (entry) => (entry?.split ? Math.max(...Object.keys(entry.levelDocs ?? {}).map(levelIndex)) : Number.isInteger(entry?.maxLevel) ? entry.maxLevel : 3);
export function levelExists(entry, level) {
  const k = levelIndex(level);
  if (k < 0) return false;
  if (entry?.split) return !!entry.levelDocs?.[level];
  return k <= maxLevelOf(entry);
}

/* ---- W4-A-4 (D-13 provisional): an effect key's `[attribute]` placeholder filled from the item's note */
/** attribute key -> what a note may say (lower case, diacritics stripped): the English name, the Polish label and its forms */
const ATTR_WORDS = Object.freeze({
  fighting: /^(fighting|walk[aeiy]|walce|walka)$/, agility: /^(agility|zwinnosc\w*|zrecznosc\w*)$/, strength: /^(strength|sil[aeiy]|sile)$/,
  reason: /^(reason|rozum\w*)$/, intuition: /^(intuition|intuicj\w*)$/, presence: /^(presence|prezencj\w*)$/
});
export const ATTR_PLACEHOLDER = /\[attribute\]/gi;
/** note -> the ONE attribute key it names (English or Polish, any case), else null (none or more than one) */
export function attributeFromNote(note) {
  const words = String(note ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const hit = new Set();
  for (const w of words) for (const [k, re] of Object.entries(ATTR_WORDS)) if (re.test(w)) hit.add(k);
  return hit.size === 1 ? [...hit][0] : null;
}
/** a key with the attribute placeholder filled ("bonus.[attribute]" + reason -> "bonus.reason") */
export const fillAttributeKey = (key, attr) => String(key ?? "").replace(ATTR_PLACEHOLDER, attr);
/** does this key have ONLY attribute placeholders (no other "[...]")? */
export const onlyAttributePlaceholders = (key) => /\[[^\]]*\]/.test(String(key ?? "")) && !/\[[^\]]*\]/.test(String(key ?? "").replace(ATTR_PLACEHOLDER, ""));

/**
 * The level a power ref pins (W2-1): null for the power's main ref (the entry's own ref, i.e. the basic document of a split
 * power, which takes any `level`) and for non-split powers; the level word for another level document of a split power.
 */
export function splitRefLevel(catalog, ref, entry = catalog?.get?.(ref)) {
  const lv = catalog?.levelOf?.(ref) ?? null;
  if (!lv || !entry) return null;
  return lv === (catalog.levelOf?.(entry.ref) ?? null) ? null : lv;
}

function buildAdded(op, i, { catalog, err, refItem, actor, byOp }) {
  const id = NEW_PREFIX + op.opId;
  if (op.custom) {
    const { data } = customItemData(op.custom, { seed: op.opId });
    if (!data.name) { err("field.value", op, i, { field: "custom.name", expected: "a non-empty name" }, "custom.name"); return null; }
    return { item: { _id: id, name: data.name, type: data.type, system: data.system, effects: [], flags: {} }, custom: true };
  }
  const entry = catalog?.get?.(op.ref) ?? null;
  if (!entry) { err("ref.unknown", op, i, { ref: op.ref }, "ref"); return null; }
  if (!ITEM_KINDS.includes(entry.kind)) { err("ref.kind", op, i, { ref: op.ref, kind: entry.kind }, "ref"); return null; }
  const type = entry.kind;
  const system = { description: "", automations: {} };
  let name = entry.name;
  // field use per type
  const bad = (k) => op[k] !== undefined && err("input.shape", op, i, { expected: `not used for a ${type}` }, k);
  if (type !== "power") ["level", "sourceItemId", "sourceOpId"].forEach(bad);
  if (type !== "boost" && type !== "limit") ["powerItemId", "powerOpId"].forEach(bad);
  if (!["power", "talent", "drawback"].includes(type)) bad("note");
  if (type === "power") {
    // split-level powers (W2-1, D-A): the power's main ref (its basic document, the ref in the index) + `level` picks that
    // level, as the writer does; only another level's own ref with a different `level` is a conflict
    const lvRef = splitRefLevel(catalog, op.ref, entry);
    const level = op.level ?? catalog.levelOf?.(op.ref) ?? "basic";
    if (lvRef && op.level && op.level !== lvRef) { err("ref.level.conflict", op, i, { ref: op.ref, level: op.level, refLevel: lvRef, mainRef: entry.ref }, "level"); return null; }
    if (!levelExists(entry, level)) { err("ref.level.none", op, i, { name: entry.name, level, max: LEVEL_WORDS[maxLevelOf(entry)] }, "level"); return null; }
    system.level = level;
    const src = refItem(op, i, op.sourceItemId, op.sourceOpId, "powerSource", "source");
    if (src === undefined) return null;
    if (src === null) {
      if (actor.type === "superhero" || actor.items.some((x) => x.type === "powerSource")) { err("link.source.missing", op, i, { name: entry.name }, "sourceItemId"); return null; }
    } else system.powerSource = src;
    if (op.note) name = withNote(name, op.note);
  } else if (type === "boost" || type === "limit") {
    const pid = refItem(op, i, op.powerItemId, op.powerOpId, "power", "power");
    if (pid === undefined) return null;
    if (pid === null) { err("link.power.missing", op, i, { name: entry.name, type }, "powerItemId"); return null; }
    const target = actor.items.find((x) => x._id === pid) ?? null;
    const targetName = target ? baseName(target.name) : (catalog?.get?.(byOp.get(op.powerOpId)?.ref)?.name ?? null);
    if (entry.power && targetName && normBase(entry.power) !== normBase(targetName)) { err("ref.power.mismatch", op, i, { name: entry.name, type, power: entry.power, target: targetName }, "ref"); return null; }
    system.power = pid;
  } else if (type === "drawback" || type === "talent") {
    if (op.note) name = withNote(name, op.note);
  } else if (type === "gear" || type === "vehicleWeapon") {
    Object.assign(system, { cost: entry.gear?.cost ?? 0, restricted: !!entry.gear?.restricted, ...(type === "gear" ? { singleUse: !!entry.gear?.singleUse } : {}) });
  }
  return { item: { _id: id, name, type, system, effects: [], flags: {}, _ref: entry.ref }, ref: op.ref };
}

/* ================================================================== replace -> ops (spec 6 / 8.4) */
/**
 * replaceToOps(doc, proposal, { catalog }) -> { ops, errors }
 * Superhero / npc `replace` proposal diffed against the actor: creation items (CREATION_TYPES) with the same type + base name
 * (and, for boosts/limits, the same power) are KEPT with their ids (updated when level/source/note differ); missing ones are
 * added; leftover creation items are removed (dependants before their parents). Injuries are never touched; gear only when the
 * proposal has a `gear` list (W4-A-3: then replaced like the other lists, same type + name kept).
 * Actor fields go into one updateActor op with the values that differ. Ref errors come back as errors (path proposal.*).
 * W2-2: `src` = { <opId>: { path, name } } and `srcItems` = { <kept itemId>: { path, name } } name the proposal entry each op
 * (or kept sheet item) comes from ("proposal.powers[0]", "proposal.powers[0].boosts[1]", "proposal" for the actor op), so
 * the validator can report errors in the model's own terms; removals of leftovers point at "items.<id>" (not in the proposal).
 * `kept` = actor fields the proposal gives with the value already on the sheet (reputation / resources; no op, summary only).
 */
export function replaceToOps(doc, proposal, { catalog, plain = null, rank = null, profile = "creation" }) {
  const actor = plain ? clone(plain) : toPlainActor(doc);
  const P = proposal ?? {};
  const ops = [], errors = [], defaulted = [];
  const src = {}, srcItems = {};
  const from = (opId, path, name) => { src[opId] = { path, name }; return opId; };
  const pool = actor.items.filter((x) => CREATION_TYPES.includes(x.type));
  const used = new Set();
  const take = (type, name, pred = () => true) => {
    const hit = pool.find((x) => !used.has(x._id) && x.type === type && normBase(x.name) === normBase(name) && pred(x));
    if (hit) used.add(hit._id);
    return hit ?? null;
  };
  let n = 0;
  const nextId = (p) => `${p}${++n}`;
  // actor fields FIRST (P1-C): the occupation exists before the talents are added, so the per-op cost of the second talent is
  // the free occupation talent, not an extra one; the writer writes in phases anyway (items, then the actor update)
  const set = {};
  if (P.name && P.name !== actor.name) set.name = P.name;
  if (isObj(P.attributes)) { const a = {}; for (const k of ATTRS) if (Number.isInteger(P.attributes[k]) && P.attributes[k] !== getPath(actor, `system.attributes.${k}.value`)) a[k] = P.attributes[k]; if (Object.keys(a).length) set.attributes = a; }
  if (isObj(P.texts)) { const t = {}; for (const k of TEXT_KEYS) if (typeof P.texts[k] === "string" && P.texts[k] !== String(actor.system?.[k] ?? "")) t[k] = P.texts[k]; if (Object.keys(t).length) set.texts = t; }
  // P1-F: a superhero built under the creation profile starts with the rank's reputation; a replace that leaves it out gets it
  const rep = { ...P };
  if (!Number.isInteger(P.reputation) && actor.type === "superhero" && profile !== "in-play") {
    const r = resolveRank(actor, rank);
    rep.reputation = RANKS[r.rank].reputation;
    if (rep.reputation !== actor.system?.reputation) defaulted.push({ path: "proposal.reputation", value: rep.reputation, rank: r.rank });
  }
  // notes as the writer writes them (no brackets, cut at a word boundary): the writer converts the RAW proposal again at apply,
  // so both conversions must compare the same note text (same ops, same opIds)
  const noteOfP = (x) => cleanNote(x?.note ?? "").note;
  const kept = {};
  for (const k of ["resources", "reputation"]) if (Number.isInteger(rep[k])) { if (rep[k] !== actor.system?.[k]) set[k] = rep[k]; else kept[k] = rep[k]; }
  if (Object.keys(set).length) ops.push({ op: "updateActor", opId: from(nextId("act"), "proposal", P.name || actor.name || "actor"), set });
  const entryOf = (ref, path, kinds) => {
    const e = catalog?.get?.(ref) ?? null;
    if (!e) { errors.push({ code: "ref.unknown", path, params: { ref } }); return null; }
    if (!kinds.includes(e.kind)) { errors.push({ code: "ref.kind", path, params: { ref, kind: e.kind } }); return null; }
    return e;
  };
  // sources
  const srcLink = new Map();   // proposal key -> { itemId } | { opId }
  (P.sources ?? []).forEach((s, i) => {
    const e = entryOf(s.ref, `proposal.sources[${i}].ref`, ["powerSource"]);
    if (!e) return;
    const hit = take("powerSource", e.name);
    if (hit) { srcLink.set(s.key, { itemId: hit._id }); srcItems[hit._id] = { path: `proposal.sources[${i}]`, name: e.name }; }
    else { const opId = from(nextId("src"), `proposal.sources[${i}]`, e.name); ops.push({ op: "addItem", opId, ref: s.ref }); srcLink.set(s.key, { opId }); }
  });
  // powers + their boosts / limits
  (P.powers ?? []).forEach((p, i) => {
    const e = entryOf(p.ref, `proposal.powers[${i}].ref`, ["power"]);
    if (!e) return;
    const level = p.level ?? catalog.levelOf?.(p.ref) ?? "basic";
    const link = p.source ? srcLink.get(p.source) : null;
    if (p.source && !link) errors.push({ code: "link.source.missing", path: `proposal.powers[${i}].source`, params: { name: e.name } });
    const hit = take("power", e.name);
    let powerLink;
    if (hit) {
      powerLink = { itemId: hit._id };
      srcItems[hit._id] = { path: `proposal.powers[${i}]`, name: e.name };
      const set = {};
      if (powerLevel(hit.system) !== level) set.level = level;
      if (link?.itemId && hit.system?.powerSource !== link.itemId) set.powerSourceItemId = link.itemId;
      if (link?.opId) set.powerSourceOpId = link.opId;
      if (noteOfP(p) !== noteOf(hit.name)) set.note = noteOfP(p);
      if (Object.keys(set).length) ops.push({ op: "updateItem", opId: from(nextId("pw"), `proposal.powers[${i}]`, e.name), itemId: hit._id, set });
    } else {
      const opId = from(nextId("pw"), `proposal.powers[${i}]`, e.name);
      ops.push({ op: "addItem", opId, ref: p.ref, level, ...(link?.itemId ? { sourceItemId: link.itemId } : {}), ...(link?.opId ? { sourceOpId: link.opId } : {}), ...(noteOfP(p) ? { note: noteOfP(p) } : {}) });
      powerLink = { opId };
    }
    for (const [list, type] of [[p.boosts ?? [], "boost"], [p.limits ?? [], "limit"]]) {
      list.forEach((b, j) => {
        const be = entryOf(b.ref, `proposal.powers[${i}].${type}s[${j}].ref`, [type]);
        if (!be) return;
        const bpath = `proposal.powers[${i}].${type}s[${j}]`;
        const bhit = powerLink.itemId ? take(type, be.name, (x) => x.system?.power === powerLink.itemId) : null;
        if (bhit) { srcItems[bhit._id] = { path: bpath, name: be.name }; return; }
        ops.push({ op: "addItem", opId: from(nextId(type === "boost" ? "bo" : "li"), bpath, be.name), ref: b.ref, ...(powerLink.itemId ? { powerItemId: powerLink.itemId } : { powerOpId: powerLink.opId }) });
      });
    }
  });
  for (const [list, type] of [[P.talents ?? [], "talent"], [P.drawbacks ?? [], "drawback"]]) {
    list.forEach((t, i) => {
      const e = entryOf(t.ref, `proposal.${type}s[${i}].ref`, [type]);
      if (!e) return;
      const note = noteOfP(t);
      const tpath = `proposal.${type}s[${i}]`;
      const hit = take(type, e.name, (x) => norm(noteOf(x.name)) === norm(note)) ?? take(type, e.name);
      if (hit) { srcItems[hit._id] = { path: tpath, name: e.name }; if (note !== noteOf(hit.name)) ops.push({ op: "updateItem", opId: from(nextId(type === "talent" ? "ta" : "dr"), tpath, e.name), itemId: hit._id, set: { note } }); }
      else ops.push({ op: "addItem", opId: from(nextId(type === "talent" ? "ta" : "dr"), tpath, e.name), ref: t.ref, ...(note ? { note } : {}) });
    });
  }
  // W4-A-3 (provisional W4-A-c): `gear` given = the gear list is replaced like the other lists (same type + name kept with its id,
  // a custom entry's cost / restricted / singleUse written when they differ, missing ones added, leftover gear and vehicle weapons
  // removed); `gear` left out = gear untouched, as before
  const gearPool = Array.isArray(P.gear) ? actor.items.filter((x) => CUSTOM_TYPES.includes(x.type)) : [];
  (Array.isArray(P.gear) ? P.gear : []).forEach((g, i) => {
    const gpath = `proposal.gear[${i}]`;
    if (!isObj(g)) return;
    let type, name;
    if (g.ref) {
      const e = entryOf(g.ref, `${gpath}.ref`, CUSTOM_TYPES);
      if (!e) return;
      type = e.kind; name = e.name;
    } else if (isObj(g.custom)) {
      type = CUSTOM_TYPES.includes(g.custom.type) ? g.custom.type : "gear"; name = String(g.custom.name ?? "").slice(0, NAME_MAX);
    } else return;
    const hit = gearPool.find((x) => !used.has(x._id) && x.type === type && norm(x.name) === norm(name)) ?? null;
    if (hit) {
      used.add(hit._id);
      srcItems[hit._id] = { path: gpath, name };
      if (g.custom) {
        const gear = {};
        if (Number.isInteger(g.custom.cost) && g.custom.cost !== hit.system?.cost) gear.cost = g.custom.cost;
        if (typeof g.custom.restricted === "boolean" && g.custom.restricted !== !!hit.system?.restricted) gear.restricted = g.custom.restricted;
        if (type === "gear" && typeof g.custom.singleUse === "boolean" && g.custom.singleUse !== !!hit.system?.singleUse) gear.singleUse = g.custom.singleUse;
        if (Object.keys(gear).length) ops.push({ op: "updateItem", opId: from(nextId("ge"), gpath, name), itemId: hit._id, set: { gear } });
      }
      return;
    }
    ops.push({ op: "addItem", opId: from(nextId("ge"), gpath, name), ...(g.ref ? { ref: g.ref } : { custom: clone(g.custom) }) });
  });
  // leftovers: dependants first (boost/limit, talent/drawback, power, source), then gear (only when `gear` is given)
  const order = ["boost", "limit", "talent", "drawback", "power", "powerSource", "gear", "vehicleWeapon"];
  const left = [...pool, ...gearPool].filter((x) => !used.has(x._id)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || String(a._id).localeCompare(String(b._id)));
  for (const x of left) ops.push({ op: "removeItem", opId: from(nextId("rm"), `items.${x._id}`, x.name), itemId: x._id });
  return { ops, errors, defaulted, src, srcItems, kept };
}

/* ================================================================== partial selection (spec 7.5.6) */
/** opIds an op references (it cannot stand without them) */
export function opRefs(op) {
  return [op?.sourceOpId, op?.powerOpId, op?.set?.powerSourceOpId, op?.set?.powerOpId].filter(Boolean);
}
/** transitive dependants of `opIds` -> Set (not including the roots) */
export function dependants(ops, opIds) {
  const roots = new Set(opIds), out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const op of ops ?? []) {
      if (!op?.opId || roots.has(op.opId) || out.has(op.opId)) continue;
      if (opRefs(op).some((r) => roots.has(r) || out.has(r))) { out.add(op.opId); grew = true; }
    }
  }
  return out;
}
/** -> { ops (kept, in order), deselected:[opId] (asked), withThem:[{ opId, because }] (dependants unticked together) } */
export function selectOps(ops, deselect = []) {
  const asked = new Set((deselect ?? []).filter((id) => (ops ?? []).some((o) => o?.opId === id)));
  const dep = dependants(ops, [...asked]);
  const withThem = [...dep].map((opId) => ({ opId, because: opRefs((ops ?? []).find((o) => o.opId === opId)).filter((r) => asked.has(r) || dep.has(r)) }));
  const drop = new Set([...asked, ...dep]);
  return { ops: (ops ?? []).filter((o) => !drop.has(o?.opId)), deselected: [...asked], withThem };
}

/* ================================================================== stale check (spec 7.5.5) */
/** fingerprint of one item source: hash of its _source without _stats (any stored change moves it) */
export function itemFingerprint(itemSrc) {
  if (!itemSrc) return null;
  const { _stats, ...rest } = itemSrc;
  return hash(stableJson(rest));
}
/**
 * expectFor(doc, ops, projection) -> { items: { <itemId>: fp }, actor: { <path>: json } }: what the preview saw for every item an
 * op updates or removes (cascade included) and every actor path an op writes.
 */
export function expectFor(doc, ops, projection = null) {
  const actor = toPlainActor(doc);
  const items = {}, fields = {};
  const byId = new Map(actor.items.map((i) => [i._id, i]));
  const add = (id) => { if (byId.has(id)) items[id] = itemFingerprint(byId.get(id)); };
  for (const op of ops ?? []) {
    if (op?.op === "updateItem" || op?.op === "removeItem") add(op.itemId);
    if (op?.op === "updateActor") for (const p of Object.keys(actorSetPaths(op.set))) fields[p] = JSON.stringify((p === "name" ? actor.name : getPath(actor, p)) ?? null);
    for (const k of [op?.sourceItemId, op?.powerItemId, op?.set?.powerSourceItemId, op?.set?.powerItemId]) if (k) add(k);
  }
  for (const info of Object.values(projection?.opInfo ?? {})) for (const c of info.cascade ?? []) add(c.itemId);
  return { items, actor: fields };
}
/** -> [{ opId|null, itemId?, path?, reason: "missing"|"changed" }] (empty = fresh) */
export function checkStale(doc, ops, expect) {
  if (!expect) return [];
  const actor = toPlainActor(doc);
  const byId = new Map(actor.items.map((i) => [i._id, i]));
  const out = [];
  const opFor = (id) => (ops ?? []).find((o) => o?.itemId === id || [o?.sourceItemId, o?.powerItemId, o?.set?.powerSourceItemId, o?.set?.powerItemId].includes(id))?.opId ?? null;
  for (const [id, fp] of Object.entries(expect.items ?? {})) {
    const it = byId.get(id);
    if (!it) out.push({ opId: opFor(id), itemId: id, reason: "missing" });
    else if (itemFingerprint(it) !== fp) out.push({ opId: opFor(id), itemId: id, name: it.name, reason: "changed" });
  }
  for (const [path, json] of Object.entries(expect.actor ?? {})) {
    const now = JSON.stringify((path === "name" ? actor.name : getPath(actor, path)) ?? null);
    if (now !== json) out.push({ opId: (ops ?? []).find((o) => o?.op === "updateActor" && own(actorSetPaths(o.set), path))?.opId ?? null, path, reason: "changed" });
  }
  return out;
}

/* ================================================================== summary (GM card + model) */
const OP_WORD = { add: "add", update: "change", remove: "remove", actor: "actor" };
/** short one-line-per-op summary text */
export function summarize(normalized, projection, budget) {
  const lines = [];
  for (const op of normalized?.ops ?? []) {
    const info = projection?.opInfo?.[op.opId];
    if (!info) continue;
    const c = budget?.perOp?.find((x) => x.opId === op.opId);
    if (info.kind === "actor") {
      // W2-5 (D-Q): reputation / resources with their value (the model checks them against the rank / occupation)
      let s = `${op.opId}: actor ${info.changed.map((ch) => { const f = ch.path.replace(/^system\.|\.value$/g, "").replace(/^attributes\./, ""); return f === "reputation" || f === "resources" ? `${f} ${ch.to}` : f; }).join(", ")}`;
      if (c?.label && (c.points || c.slots)) s += ` cost: ${c.label}`;
      lines.push(s);
    } else {
      // W3-8 (finding 15): a note change reads `change drawback "Frightful" [note "..."]` (the base name and the new note), not
      // `[name]`, which looked like a rename
      const noteCh = info.kind === "update" ? info.changed?.find((ch) => ch.note !== undefined) : null;
      let s = `${op.opId}: ${OP_WORD[info.kind]} ${info.type} "${noteCh ? baseName(info.name) : info.name}"`;
      if (info.kind === "add" && info.type === "power") s += ` (${projection.actor.items.find((x) => x._id === info.itemId)?.system?.level ?? "basic"})`;
      if (info.kind === "update" && info.changed?.length) s += ` [${info.changed.map((ch) => (ch.note !== undefined ? (ch.note ? `note "${ch.note}"` : "note removed") : ch.field)).join(", ")}]`;
      if (info.cascade?.length) s += ` + ${info.cascade.length} dependant(s)`;
      // P1-C: a readable cost per op ("free occupation talent", "extra talent -1 pt", "+1 slot (3/4) -2 pts")
      if (c?.label) s += ` cost: ${c.label}`;
      else if (c && (c.points || c.slots)) s += ` cost: ${c.slots ? `${c.slots > 0 ? "+" : ""}${c.slots} slot ` : ""}${c.points ? `${c.points > 0 ? "+" : ""}${c.points} pts` : ""}`.trimEnd();
      lines.push(s);
    }
  }
  return lines;
}
