// Invincible in-place writer: plan / apply / undo / undoStatus (spec 3.2 writer group, 6 `ops`, 7.5 point 5, 8.4, 10.1, 10.3,
// 11.2; task T6). Every write of the builder goes through here (O5/O21): items are created, updated and deleted IN PLACE, so
// untouched and edited items keep their ids. plus-ultra's destructive replace is only reachable through pu-bridge.mjs
// ("Full rebuild (plus-ultra)").
//
// Foundry access only through `deps` (createWriter), so node tests drive it with fake documents (dev/test-build-ops.mjs).
//
// PLAN (dry run, writes nothing; used by validation T5 as the L3 step and by the drawer's preview):
//   plan(doc, proposal, { allowVitals, only }) -> Plan = {
//     ok, mode: "ops"|"replace"|"item", derived: boolean (ops derived from a replace), runId: null,
//     doc: { uuid, id, type, name },
//     errors:[Msg], warnings:[Msg], info:[Msg],            Msg = { code, message, opId?, itemId?, path?, names? }
//     ops: [OpPlan],                                         one per proposal op, in proposal order
//       OpPlan = { opId, kind, action: "add"|"update"|"swap"|"remove"|"actor"|"noop", itemId (null for add/actor), type, name,
//                  ref, level?, changes:[{ path, from, to }], cascade:[{ itemId, type, name }], links:{ source?, power? },
//                  requires:[opId] (ops this one depends on, for partial selection), destructive }
//     fields:[{ path, from, to }], creates:[{ opId, type, name, level?, source?, power?, note? }], updates:[{ opId, itemId, type, name, changes }],
//     deletes:[{ opId, id, type, name, cascadeOf? }], swaps:[{ opId, id, name, from, to }], keeps:[{ id, type, name }],
//     overwrites:[{ path, from, to }] (actor texts that replace non-empty text),
//     counts:{ create, update, swap, delete, fields, keeps }, destructive (deletes or swaps > 0),
//     build (W3-3: creation profile, no creation item survives, some are added -> current Health/Resolve = max after the write;
//       W5-A-1: every replace in the creation profile is a build too),
//     reorders:[{ id|null, opId|null, name, from, to, roleChange }] (W5-A-3: replace only; talents re-created with keepId after the
//       other phases so the collection order = the proposal's talent order; roleChange = a KEPT talent changes role: destructive),
//     unsaved:[{ path, stored, live }] (open sheet input not saved yet: apply refuses while non-empty),
//     dropped:[{ opId, because }] (partial selection), expect: Expect, projected: ActorLike }
//   Expect = { items: { <itemId>: { fp, name } }, actor: { <path>: value }, deletes:[itemId] }: pass back to apply() unchanged.
//   projected = the actor after the ops, as a plain actor-like object ({ id, uuid, name, type, _source, system, items:[{ id, name,
//     type, _source, effects }], effects }) for reader.mjs / the validators (spec 7.5 point 1). New items get placeholder ids "+<opId>".
// APPLY: apply(doc, proposal, { rank, profile, confirmed, expect, only, allowVitals, onStage }) -> Result = { ok, runId, plan, errors,
//   (`rank` = the drawer's rank, REQUIRED for superheroes: teen|street|global|cosmic. Without it the hero is validated by
//   plus-ultra's chargen rank flag, else as Global, and the result carries the warning `rank.defaulted` (P1-G). `profile` =
//   "creation" (default) | "in-play"; `confirmed` (not `confirm`) = true for removals / level swaps.)
//   warnings (plan + the validator's, once each), created:[id], updated:[id], deleted:[id], idMap:{ opId: itemId } (ids assigned
//   before writing, created with keepId: W3-1), message, vitals?: { health?: {from,to}, resolve?: {from,to} } (build, W3-3),
//   reordered?: [{ itemId, name, from?, to? }] (W5-A-3: talents re-created into the replace proposal's order),
//   busy?, stale?, needsConfirm?, unsaved?,
//   rolledBack?, budget? (the validator's, when validation ran) }. This is the writer's FULL result; the pack's apply
//   (writer-group.mjs) returns a concise one unless { verbose: true }. GM only; refuses while the open sheet holds unsaved input; re-plans and re-validates on the CURRENT document;
//   refuses the WHOLE write when an item it touches changed since the preview (expect); destructive plans need confirmed:true;
//   a failure in any phase rolls back what this run wrote.
// UNDO: undo(doc, runId?, { opIds?, confirmDrift }) whole run or per item (groups: undo.mjs selectEntries); undoStatus(doc) sync.
//   W5-A-2: the run journals the item order before it (Run.order); a whole-run undo (and a rollback) puts every item back in
//   that order, a per-item undo puts the restored items back at their old place (undo.mjs restoreTarget / movePlan).

import { ATTRS, LEVEL_WORDS, getPath, norm, normBase, plainText, powerLevelOf, unsavedFrom, automationsOf, talentRoles } from "./reader.mjs";
import { clone, fingerprint, readJournal, pruneJournal, findRun, selectEntries, driftOf, laterTouches, undoOrder, describeRun, restoreTarget, movePlan, UNDO_TTL } from "./undo.mjs";
import { baseName, noteOf, withNote, cleanNote } from "./names.mjs";
import { attributeFromNote, fillAttributeKey, onlyAttributePlaceholders } from "./proposal.mjs";

export const MODULE_ID = "moinens-ai-gen";
export const JOURNAL_PATH = `flags.${MODULE_ID}.undo`;
export const LOCK_PATH = `flags.${MODULE_ID}.lock`;
export const PU_LOCK_PATH = "flags.invincible-plus-ultra.chargenLock";
export const LOCK_TTL = 90 * 1000;
export const ACTOR_TYPES = Object.freeze(["superhero", "npc"]);
export const ITEM_DOC_TYPES = Object.freeze(["gear", "vehicleWeapon"]);
export const OP_KINDS = Object.freeze(["addItem", "updateItem", "removeItem", "updateActor"]);
/** write order of creates (spec 8.4: sources -> powers -> boosts/limits -> talents/drawbacks -> rest) */
export const CREATE_PHASES = Object.freeze([["powerSource"], ["power"], ["boost", "limit"], ["talent", "drawback"], ["gear", "vehicleWeapon"]]);
export const ADDABLE = Object.freeze(CREATE_PHASES.flat());
/** item types a build creates (an actor without any of them is "empty" for W3-3) */
export const CREATION_TYPES = Object.freeze(["powerSource", "power", "boost", "limit", "talent", "drawback"]);
/** a Foundry document id (16 alphanumerics) */
const ID_RE = /^[A-Za-z0-9]{16}$/;
/** `custom` adds (no catalogue ref): gear and vehicle weapons (spec 10.3) + a named power source (writer-notes W3) */
export const CUSTOM_TYPES = Object.freeze(["gear", "vehicleWeapon", "powerSource"]);
export const TEXT_FIELDS = Object.freeze(["civilianName", "role", "appearance", "occupation", "personality", "drive", "flaw", "relationships", "team", "teamBase"]);
export const SOURCE_IMG = "systems/invincible/assets/icons/powersource.svg";
const SHORT_OF = { "power-sources": "sources", powers: "powers", boosts: "boosts", limits: "limits", talents: "talents", drawbacks: "drawbacks", gears: "gears" };
const CORE = "invincible-core";

/* ------------------------------------------------------------------ actor field whitelist (spec 6 updateActor, O25) */
export const ACTOR_PATHS = new Map([
  ["name", { kind: "text", cap: 60 }],
  ...ATTRS.map((k) => [`system.attributes.${k}.value`, { kind: "int", min: 0, max: 12 }]),
  ...TEXT_FIELDS.map((k) => [`system.${k}`, { kind: "text", cap: 1200 }]),
  ["system.reputation", { kind: "int", min: 0, max: 99 }],
  ["system.resources", { kind: "int", min: 0, max: 99 }],
  ["biographyAppend", { kind: "append", cap: 4000, target: "system.biography" }]
]);
/** karma and current Health/Resolve: only when the drawer passes allowVitals (the GM asked for it explicitly, O25) */
export const VITAL_PATHS = new Map([
  ["system.karma", { kind: "int", min: 0, max: 99 }],
  ["system.derived.health.value", { kind: "int", min: 0, max: 999 }],
  ["system.derived.resolve.value", { kind: "int", min: 0, max: 999 }]
]);

/* ------------------------------------------------------------------ small helpers */
const listOf = (coll) => (coll == null ? [] : Array.isArray(coll) ? coll : typeof coll.values === "function" ? [...coll.values()] : [...coll]);
const srcOf = (doc) => doc?._source ?? (typeof doc?.toObject === "function" ? doc.toObject() : doc) ?? {};
const docName = (doc) => doc?.documentName ?? doc?.constructor?.documentName ?? null;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
/** plain text: control chars and bidi overrides stripped, trimmed, capped */
export const cleanText = (v, cap = 1200) => String(v ?? "").replace(CTRL, "").replace(/\r\n?/g, "\n").trim().slice(0, cap);
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** defuse Foundry enrichers (@UUID[..], [[/r ..]]) in model text so a sheet never turns it into links or rolls */
const defuse = (s) => String(s).replace(/@(\w+)\[/g, "@​$1[").replace(/\[\[/g, "[​[");
/** plain text -> safe HTML paragraphs */
export const toParagraphs = (s) => cleanText(s, 4000).split(/\n+/).map((x) => x.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(defuse(p))}</p>`).join("");
// "Name (note)": balanced trailing bracket group; notes without brackets, cut at a word boundary (names.mjs, shared, P1-D)
export { baseName, noteOf };
/** a note as written: control chars stripped, brackets replaced, cut at a word boundary to NOTE_MAX (same as the validator) */
export const writeNote = (note) => cleanNote(cleanText(note ?? "", 4000)).note;
export const levelWord = (l) => {
  if (l === null || l === undefined || l === "") return null;
  if (typeof l === "number") return LEVEL_WORDS[l] ?? null;
  const w = String(l).toLowerCase().trim();
  if (/^\d$/.test(w)) return LEVEL_WORDS[Number(w)] ?? null;
  return LEVEL_WORDS.includes(w) ? w : null;
};
/** refs as written by the catalogue (`sources:<id>`); the reader's long pack names (`power-sources:<id>`) are accepted too */
export function normRef(ref) {
  const r = String(ref ?? "").trim();
  const i = r.indexOf(":");
  if (i < 0) return r;
  const p = r.slice(0, i);
  return SHORT_OF[p] ? `${SHORT_OF[p]}:${r.slice(i + 1)}` : r;
}
export function setPath(o, path, v) {
  const parts = String(path).split(".");
  let cur = o;
  for (const k of parts.slice(0, -1)) cur = (cur[k] && typeof cur[k] === "object") ? cur[k] : (cur[k] = {});
  cur[parts[parts.length - 1]] = v;
}
function delPath(o, path) {
  const parts = String(path).split(".");
  let cur = o;
  for (const k of parts.slice(0, -1)) { cur = cur?.[k]; if (!cur) return; }
  delete cur[parts[parts.length - 1]];
}
/** Foundry 14 ForcedDeletion where it exists, the legacy "-=key" otherwise (same as plus-ultra P11-6) */
export function dropKey(path) {
  const i = path.lastIndexOf(".");
  const parent = path.slice(0, i), key = path.slice(i + 1);
  const FD = globalThis.foundry?.data?.operators?.ForcedDeletion;
  return FD?.create ? [path, FD.create()] : [`${parent}.-=${key}`, null];
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** W5-B 6d: an updateItem op is named as the item will be called (a note or gear rename in `changes`), like the actor op (W3-2) */
const newNameOf = (changes, name) => changes.find((c) => c.path === "name")?.to ?? name;
const msg = (code, message, extra = {}) => ({ code, message, ...extra });

/** non-split powers keep all level automations in one document: show those of the chosen level (plus-ultra apply.mjs rule).
    Returns [{ id, from, to }] for the automations whose flag changes; mutates `sys` when `write`. */
export function levelFlips(sys, word, write = false) {
  const out = [];
  for (const [id, a] of Object.entries(sys?.automations ?? {})) {
    if (!a || typeof a !== "object") continue;
    const m = /\b(basic|major|massive|monstrous)\b/i.exec(a.name ?? "");
    if (!m) continue;
    const w = m[1].toLowerCase();
    const to = w === word || (w === "basic" && a.type === "rollAttack");
    if (!!a.showAsSelection !== to) { out.push({ id: a._id ?? id, key: id, from: !!a.showAsSelection, to }); if (write) a.showAsSelection = to; }
  }
  return out;
}
/** pack document data -> embedded item data (plus-ultra baseItemData without its run flag) */
export function itemDataFromPack(data) {
  const d = clone(data);
  delete d._id; delete d.folder; delete d.ownership; delete d._stats; delete d.sort;
  if (d.flags && "exportSource" in d.flags) delete d.flags.exportSource;
  if (d.flags && "core" in d.flags) { delete d.flags.core.sourceId; if (!Object.keys(d.flags.core).length) delete d.flags.core; }
  d.system ??= {};
  return d;
}
const int = (v) => (Number.isInteger(Number(v)) && v !== "" && v !== null && typeof v !== "boolean" ? Number(v) : NaN);
/** whitelisted attack -> ONE rollAttack automation (spec 10.3): numbers and booleans only, never scripts or uuids */
export function attackAutomation(attack, id) {
  const a = { _id: id, type: "rollAttack", name: cleanText(attack.name ?? "Attack", 60) || "Attack", showAsSelection: true, open: true, origin: "",
    rollBonus: int(attack.bonus ?? 0) || 0, baseDamage: Math.max(0, int(attack.damage ?? 1) || 0), minRange: Math.max(0, int(attack.minRange ?? 0) || 0),
    maxRange: Math.max(0, int(attack.maxRange ?? 0) || 0), bypassArmor: attack.bypassArmor === true, actualDamage: true };
  if (Array.isArray(attack.attribute) || typeof attack.attribute === "string") {
    const at = [].concat(attack.attribute).map((x) => String(x).toLowerCase()).filter((x) => ATTRS.includes(x));
    if (at.length) a.attribute = at;
  }
  return a;
}
function checkAttack(attack, E, extra) {
  if (attack == null) return;
  if (typeof attack !== "object") { E("gear.attack", "attack must be an object", extra); return; }
  for (const k of ["bonus", "damage", "minRange", "maxRange"]) {
    if (attack[k] === undefined) continue;
    if (Number.isNaN(int(attack[k]))) E("gear.attack.number", `attack.${k} must be an integer`, { ...extra, path: `attack.${k}` });
    else if (k !== "bonus" && int(attack[k]) < 0) E("gear.attack.range", `attack.${k} must be >= 0`, { ...extra, path: `attack.${k}` });
  }
  if (int(attack.minRange ?? 0) > int(attack.maxRange ?? 0)) E("gear.attack.range", "attack.minRange must be <= attack.maxRange", extra);
}
/** custom gear / vehicle weapon / power source -> item data (whitelist, spec 10.3). No img (Foundry default), no flags, no effects. */
export function customItemData(c, randomID) {
  const type = c.type;
  const d = { name: cleanText(c.name, 80) || "Item", type, system: { description: c.description ? toParagraphs(c.description) : "" } };
  if (type === "powerSource") { d.img = SOURCE_IMG; return d; }
  d.system.cost = Math.max(0, int(c.cost ?? 0) || 0);
  d.system.restricted = c.restricted === true;
  if (type === "gear") d.system.singleUse = c.singleUse === true;
  d.system.automations = {};
  if (c.attack) { const id = randomID(); d.system.automations[id] = attackAutomation(c.attack, id); }
  return d;
}

/**
 * W4-A-4 (D-13 provisional): fill the "[attribute]" placeholder of a catalogue item's effect keys ("bonus.[attribute]") with the
 * attribute its note names (English or Polish, any case; proposal.mjs attributeFromNote). Only keys whose open parts are all
 * "[attribute]"; values untouched. Mutates `data` (the item data about to be created / swapped in).
 * -> { filled: [{ from, to }], open: [key] } (open = placeholder keys left as they are: no note, no single attribute, other placeholder)
 */
export function fillAttributeEffects(data, note) {
  const out = { filled: [], open: [] };
  const attr = note ? attributeFromNote(note) : null;
  for (const e of Array.isArray(data?.effects) ? data.effects : []) {
    for (const list of [e?.system?.changes, e?.changes]) {
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        const key = String(c?.key ?? "");
        if (!/\[[^\]]*\]/.test(key)) continue;
        if (attr && onlyAttributePlaceholders(key)) { c.key = fillAttributeKey(key, attr); out.filled.push({ from: key, to: c.key }); }
        else out.open.push(key);
      }
    }
  }
  return out;
}
/** plan side of fillAttributeEffects: info when filled (a placeholder left open is the validator's warning effect.placeholder,
    which apply carries on success; not repeated here, the validator joins plan warnings into the model's result) */
function fillPlan(p, opId, data, note) {
  const f = fillAttributeEffects(data, note);
  if (f.filled.length) p.info.push(msg("effect.filled", `"${data.name}": effect key ${f.filled.map((x) => `${x.from} -> ${x.to}`).join(", ")} (from the note).`, { opId, filled: f.filled }));
  return f;
}

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
/** the validator's structured set ({ attributes:{}, texts:{}, reputation, resources, karma, health, resolve, name }, proposal.mjs) and
    the spec's dotted form ({ "system.<path>": v }) -> one flat { key: value } */
export function flattenActorSet(set) {
  const out = {};
  for (const [k, v] of Object.entries(set ?? {})) {
    if (k === "attributes" && isObj(v)) for (const [a, n] of Object.entries(v)) out[`system.attributes.${a}.value`] = n;
    else if (k === "texts" && isObj(v)) for (const [t, x] of Object.entries(v)) out[`system.${t}`] = x;
    else if (k === "health") out["system.derived.health.value"] = v;
    else if (k === "resolve") out["system.derived.resolve.value"] = v;
    else out[k] = v;
  }
  return out;
}
/** -> [{ path, value }] normalised updateActor keys; unknown keys reported; karma / current Health / Resolve flagged (O25) */
function actorSetEntries(set, { allowVitals }, E, opId, W = () => {}) {
  const out = [];
  if (!isObj(set)) { E("op.shape", "updateActor needs a `set` object", { opId }); return out; }
  for (const [raw, value] of Object.entries(flattenActorSet(set))) {
    let path = String(raw).trim();
    if (path !== "name" && path !== "biographyAppend" && !path.startsWith("system.")) path = `system.${path}`;
    if (/^system\.attributes\.\w+$/.test(path)) path += ".value";
    const spec = ACTOR_PATHS.get(path) ?? VITAL_PATHS.get(path) ?? null;
    if (!spec) { E("actor.field", `"${raw}" is not a field the builder may write`, { opId, path: raw }); continue; }
    if (VITAL_PATHS.has(path) && !allowVitals) W("field.sensitive", `${path} (karma / current Health / Resolve): written only because the GM asked for it; check the preview`, { opId, path });
    if (spec.kind === "int") {
      const n = int(value);
      if (Number.isNaN(n) || n < spec.min || n > spec.max) { E("actor.value", `${path} must be an integer ${spec.min}..${spec.max}`, { opId, path }); continue; }
      out.push({ path, value: n, spec });
    } else {
      if (typeof value !== "string") { E("actor.value", `${path} must be text`, { opId, path }); continue; }
      const v = cleanText(value, spec.cap);
      if (spec.kind === "text" && !v && path === "name") { E("actor.value", "name must not be empty", { opId, path }); continue; }
      out.push({ path, value: v, spec });
    }
  }
  return out;
}

/**
 * W5-A-3: the talent order a replace asks for, from its conversion: `conv.talentOrder` ([{ itemId } | { opId }], replace.mjs) or,
 * for the validator's converter (proposal.mjs replaceToOps), its `srcItems` (kept items) and `src` (ops) entries whose path is
 * "proposal.talents[i]". A kept item wins over an op of the same entry (a note update). -> [{ itemId } | { opId }] | null
 */
export function talentOrderOf(conv) {
  if (Array.isArray(conv?.talentOrder)) return conv.talentOrder;
  const at = [];
  const put = (path, tok) => { const m = /^proposal\.talents\[(\d+)\]$/.exec(String(path ?? "")); if (m && !at[Number(m[1])]) at[Number(m[1])] = tok; };
  for (const [itemId, s] of Object.entries(conv?.srcItems ?? {})) put(s?.path, { itemId });
  for (const [opId, s] of Object.entries(conv?.src ?? {})) put(s?.path, { opId });
  const out = at.filter(Boolean);
  return out.length ? out : null;
}

/* ------------------------------------------------------------------ partial selection (spec 7.5 point 6) */
/** ops each op depends on (links to other add ops in the same list) */
export const kindOf = (op) => op?.kind ?? op?.op;
/** ops as the writer reads them: `kind` filled from the validator's `op` key */
export const normalizeOps = (ops) => (ops ?? []).map((op) => (op && typeof op === "object" && op.kind == null && op.op != null ? { ...op, kind: op.op } : op));
export function opRequires(op) {
  const r = [];
  op = op && op.kind == null && op.op != null ? { ...op, kind: op.op } : op;
  if (op?.kind === "addItem") { if (op.sourceOpId) r.push(op.sourceOpId); if (op.powerOpId) r.push(op.powerOpId); }
  if (op?.kind === "updateItem" && op.set?.powerSourceOpId) r.push(op.set.powerSourceOpId);
  if (op?.kind === "updateItem" && op.set?.powerOpId) r.push(op.set.powerOpId);
  return r.map(String);
}
/** keep only `keep` opIds; dependants of a dropped op are dropped with it (transitively). -> { ops, dropped:[{opId, because}] } */
export function selectOps(ops, keep) {
  const want = new Set((keep ?? []).map(String));
  const dropped = [];
  const gone = new Set();
  for (const op of ops ?? []) if (!want.has(String(op?.opId))) { gone.add(String(op?.opId)); dropped.push({ opId: String(op?.opId), because: "unticked" }); }
  let grew = true;
  while (grew) {
    grew = false;
    for (const op of ops ?? []) {
      const id = String(op?.opId);
      if (gone.has(id)) continue;
      const dep = opRequires(op).find((r) => gone.has(r));
      if (dep) { gone.add(id); dropped.push({ opId: id, because: dep }); grew = true; }
    }
  }
  return { ops: (ops ?? []).filter((op) => !gone.has(String(op?.opId))), dropped };
}

/* ================================================================== the writer */
/**
 * createWriter(deps) -> { plan, apply, undo, undoStatus }
 * deps: {
 *   getCatalog(): Promise<cat>                      catalogue (catalog.mjs makeCatalog shape: get, levelOf, findByName)
 *   fetchData(uuid): Promise<object|null>           compendium document data (toObject) for a catalogue uuid
 *   toOps(actor, replaceProposal, cat, opts): { ops, errors, warnings }   replace -> ops (replace.mjs)
 *   isGM(): boolean, userId(): string, userName(id): string
 *   liveForm(doc): object|null                      reader.readLiveForm (unsaved sheet input)
 *   validate(doc, proposal, opts): Promise<{ ok, errors }>|null   the pack's validator (T5), re-run on apply
 *   randomID(): string, now(): number, sleep(ms): Promise
 *   createWorldItem(data): Promise<doc>, fromUuid(uuid): Promise<doc|null>   (target "newItem")
 *   log: console-like
 * }
 */
export function createWriter(deps = {}) {
  const D = {
    randomID: () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10),
    now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isGM: () => !!globalThis.game?.user?.isGM, userId: () => globalThis.game?.user?.id ?? "?",
    userName: (id) => globalThis.game?.users?.get?.(id)?.name ?? "?",
    liveForm: () => null, validate: null, log: console, lockSettle: 300,
    ...deps
  };
  const inflight = new Set();

  /* -------------------------------------------------------------- reference resolution */
  async function resolveRef(cat, ref, level) {
    const r = normRef(ref);
    const entry = cat.get(r);
    if (!entry) return { error: "ref.unknown" };
    if (!ADDABLE.includes(entry.kind)) return { error: "ref.kind", entry };
    let docId = entry.id, word = null;
    if (entry.kind === "power") {
      const asked = levelWord(level);
      if (level != null && level !== "" && !asked) return { error: "level.word", entry };
      word = asked ?? cat.levelOf(r) ?? null;
      if (entry.split) {
        const w = word ?? "basic";
        if (!entry.levelDocs?.[w]) return { error: "level.missing", entry, level: w };
        docId = entry.levelDocs[w];
        word = w;
      }
    }
    const uuid = `Compendium.${CORE}.${entry.pack}.Item.${docId}`;
    const data = await D.fetchData(uuid);
    if (!data) return { error: "ref.unavailable", entry };
    return { entry, uuid, data, level: word, split: !!entry.split };
  }

  /* -------------------------------------------------------------- planning */
  async function planInternal(doc, proposal, opts = {}) {
    const dn = docName(doc);
    if (dn === "Item" || proposal?.target === "newItem") return planItemDoc(doc, proposal, opts);
    const base = emptyPlan(doc);
    if (dn !== "Actor" || !ACTOR_TYPES.includes(doc?.type)) { base.errors.push(msg("doc.type", `The builder writes ${ACTOR_TYPES.join(" and ")} actors and ${ITEM_DOC_TYPES.join(" / ")} items; this is "${doc?.type ?? "?"}".`)); return finish(base); }
    if (!proposal || typeof proposal !== "object") { base.errors.push(msg("proposal.shape", "No proposal.")); return finish(base); }
    const cat = await D.getCatalog();
    let ops, derived = false, talentOrder = null;
    const mode = proposal.mode ?? (proposal.ops ? "ops" : "replace");
    if (mode === "ops") {
      if (!Array.isArray(proposal.ops) || !proposal.ops.length) { base.errors.push(msg("proposal.shape", "mode \"ops\" needs a non-empty `ops` list.")); return finish(base); }
      ops = normalizeOps(clone(proposal.ops));
    } else if (mode === "replace") {
      if (typeof D.toOps !== "function") { base.errors.push(msg("proposal.mode", "replace is not available.")); return finish(base); }
      const conv = await D.toOps(doc, proposal.proposal ?? proposal.state ?? null, cat, opts);
      base.warnings.push(...(conv.warnings ?? []));
      if (conv.errors?.length) { base.errors.push(...conv.errors); base.mode = "replace"; return finish(base); }
      ops = normalizeOps(conv.ops); derived = true; talentOrder = talentOrderOf(conv);
    } else { base.errors.push(msg("proposal.mode", `Unknown mode "${mode}".`)); return finish(base); }
    let dropped = [];
    if (Array.isArray(opts.only)) ({ ops, dropped } = selectOps(ops, opts.only));
    else if (Array.isArray(opts.deselect) && opts.deselect.length) { const no = new Set(opts.deselect.map(String)); ({ ops, dropped } = selectOps(ops, ops.map((o) => String(o?.opId)).filter((id) => !no.has(id)))); }
    // resolve every catalogue document BEFORE planning (adds; level swaps of split powers)
    const res = new Map();
    const items = new Map(listOf(doc.items).map((i) => [String(srcOf(i)._id ?? i.id), srcOf(i)]));
    for (const op of ops) {
      if (op?.kind === "addItem" && op.ref != null && op.custom == null) res.set(String(op.opId), await resolveRef(cat, op.ref, op.level));
      if (op?.kind === "updateItem" && op.set?.level != null) {
        const it = items.get(String(op.itemId));
        if (it?.type === "power") {
          const entry = cat.findByName("power", baseName(it.name)) ?? cat.findByName("power", it.name);
          if (entry?.split) res.set(String(op.opId), await resolveRef(cat, entry.ref, op.set.level));
          else if (entry) res.set(String(op.opId), { entry, split: false });
        }
      }
    }
    const out = buildPlan(doc, ops, res, { ...opts, mode, talentOrder, randomID: D.randomID, liveForm: D.liveForm });
    out.plan.mode = mode; out.plan.derived = derived; out.plan.dropped = dropped;
    return out;
  }

  function emptyPlan(doc) {
    const s = srcOf(doc);
    return { ok: false, mode: "ops", derived: false, runId: null, doc: { uuid: String(doc?.uuid ?? ""), id: String(s._id ?? doc?.id ?? ""), type: String(doc?.type ?? s.type ?? ""), name: String(doc?.name ?? s.name ?? "") },
      errors: [], warnings: [], info: [], ops: [], fields: [], creates: [], updates: [], deletes: [], swaps: [], keeps: [], overwrites: [], reorders: [],
      counts: { create: 0, update: 0, swap: 0, delete: 0, fields: 0, keeps: 0, reorder: 0 }, destructive: false, build: false, unsaved: [], dropped: [],
      expect: { items: {}, actor: {}, deletes: [] }, projected: null };
  }
  function finish(p, exec = null) {
    p.counts = { create: p.creates.length, update: p.updates.length, swap: p.swaps.length, delete: p.deletes.length, fields: p.fields.length, keeps: p.keeps.length, reorder: (p.reorders ?? []).length };
    // W5-A-3: a kept talent re-created into another role (hero <-> occupation <-> extra) is confirmed like a removal
    p.destructive = p.deletes.length > 0 || p.swaps.length > 0 || (p.reorders ?? []).some((r) => r.roleChange);
    p.ok = !p.errors.length;
    return { plan: p, exec };
  }

  /**
   * The pure part: ops + resolved catalogue data -> plan + the internal execution list. No document is written; the actor is
   * only read (sources cloned).
   */
  function buildPlan(actor, ops, res, opts) {
    const p = emptyPlan(actor);
    const E = (code, message, extra = {}) => p.errors.push(msg(code, message, extra));
    const W = (code, message, extra = {}) => p.warnings.push(msg(code, message, extra));
    const actorSrc = clone(srcOf(actor));
    const cur = new Map(listOf(actor.items).map((i) => { const s = clone(srcOf(i)); return [String(s._id ?? i.id), s]; }));
    const proj = new Map([...cur].map(([id, s]) => [id, clone(s)]));
    const exec = { adds: [], swaps: [], updates: [], removes: [], actor: [] };
    p.unsaved = unsavedFrom(actor, safeLive(actor));
    if (p.unsaved.length) W("sheet.unsaved", `The open sheet has ${p.unsaved.length} unsaved value(s): save or discard them before Apply.`, { names: p.unsaved.map((u) => u.path) });

    // shape + ids
    const byId = new Map();
    const opPlans = [];
    ops.forEach((op, i) => {
      if (!op || typeof op !== "object" || Array.isArray(op)) { E("op.shape", `op #${i + 1} is not an object`); return; }
      const opId = String(op.opId ?? "").trim();
      if (!opId) { E("op.id", `op #${i + 1} has no opId`); return; }
      if (byId.has(opId)) { E("op.id.duplicate", `opId "${opId}" is used twice`, { opId }); return; }
      if (!OP_KINDS.includes(op.kind)) { E("op.kind", `unknown op kind "${op.kind}"`, { opId }); return; }
      byId.set(opId, op);
      opPlans.push({ opId, kind: op.kind, action: null, itemId: null, type: null, name: "", ref: op.ref ? normRef(op.ref) : null, changes: [], cascade: [], links: {}, requires: opRequires(op), destructive: false });
    });
    const planOf = new Map(opPlans.map((x) => [x.opId, x]));
    const pid = (opId) => `+${opId}`;
    const addType = new Map();   // opId -> item type of an add
    for (const [opId, op] of byId) {
      if (op.kind !== "addItem") continue;
      if (op.custom != null) {
        if (op.ref != null) E("op.add.both", "addItem takes either `ref` or `custom`, not both", { opId });
        const t = op.custom?.type;
        if (!CUSTOM_TYPES.includes(t)) E("op.add.custom", `custom items are only ${CUSTOM_TYPES.join(", ")} (spec 10.3); powers, boosts, limits, talents and drawbacks come from the catalogue`, { opId });
        else addType.set(opId, t);
      } else {
        const r = res.get(opId);
        if (!r || r.error) {
          const why = { "ref.unknown": `ref "${op.ref}" is not in the catalogue`, "ref.kind": `ref "${op.ref}" is a ${r?.entry?.kind}, not an item that can be added`, "level.word": `level "${op.level}" is not basic/major/massive/monstrous`, "level.missing": `"${r?.entry?.name}" has no ${r?.level} level document`, "ref.unavailable": `the catalogue document for "${op.ref}" could not be read` }[r?.error ?? "ref.unknown"];
          E(r?.error ?? "ref.unknown", why ?? `ref "${op.ref}" cannot be used`, { opId });
        } else addType.set(opId, r.entry.kind);
      }
    }
    // explicit removals (needed before link checks)
    const removed = new Map();   // itemId -> opId (explicit or cascade)
    for (const [opId, op] of byId) {
      if (op.kind !== "removeItem") continue;
      const id = String(op.itemId ?? "");
      if (!cur.has(id)) { E("item.missing", `item ${id || "?"} is not on this sheet (removed or changed since the preview?)`, { opId, itemId: id }); continue; }
      if (removed.has(id)) { E("op.conflict", `item "${cur.get(id).name}" is removed twice`, { opId, itemId: id }); continue; }
      removed.set(id, opId);
    }
    // link resolution: existing item (present, right type, not removed) or an add op of the right type
    const link = (opId, itemId, viaOp, types, what) => {
      if (itemId != null && itemId !== "") {
        const id = String(itemId);
        const it = proj.get(id);
        if (!it) { E("link.missing", `${what} ${id} is not on this sheet`, { opId, itemId: id }); return null; }
        if (!types.includes(it.type)) { E("link.type", `${what} ${id} ("${it.name}") is a ${it.type}`, { opId, itemId: id }); return null; }
        if (removed.has(id)) { E("link.removed", `${what} "${it.name}" is removed by op ${removed.get(id)}`, { opId, itemId: id }); return null; }
        return id;
      }
      if (viaOp != null && viaOp !== "") {
        const o = String(viaOp);
        if (!byId.has(o) || byId.get(o).kind !== "addItem") { E("link.op", `${what} op "${o}" is not an addItem in this proposal`, { opId }); return null; }
        if (addType.has(o) && !types.includes(addType.get(o))) { E("link.type", `${what} op "${o}" adds a ${addType.get(o)}`, { opId }); return null; }
        return pid(o);
      }
      return null;
    };

    // 1. adds
    for (const [opId, op] of byId) {
      if (op.kind !== "addItem" || !addType.has(opId)) continue;
      const type = addType.get(opId);
      const r = res.get(opId);
      const pl = planOf.get(opId);
      let data;
      if (op.custom != null) {
        const c = op.custom;
        if (!cleanText(c.name, 80)) E("op.add.custom", "a custom item needs a name", { opId });
        if (type !== "powerSource") {
          if (c.cost !== undefined && (Number.isNaN(int(c.cost)) || int(c.cost) < 0)) E("gear.cost", "cost must be an integer >= 0", { opId });
          checkAttack(c.attack, E, { opId });
        }
        for (const k of Object.keys(c)) if (!["type", "name", "description", "cost", "restricted", "singleUse", "attack"].includes(k)) E("op.add.custom.field", `custom.${k} is not allowed (whitelist: name, description, cost, restricted, singleUse, attack)`, { opId });
        data = customItemData({ ...c, type }, opts.randomID);
      } else {
        data = itemDataFromPack(r.data);
        if (type === "power" && !r.split && r.level) { data.system.level = r.level; levelFlips(data.system, r.level, true); }
        if (type === "power" && r.split && r.level) data.system.level = data.system.level || r.level;
      }
      const note = writeNote(op.note);
      if (note) { if (["power", "talent", "drawback"].includes(type)) data.name = withNote(data.name, note); else W("op.note.ignored", `a note is only written on powers, talents and drawbacks (op ${opId})`, { opId }); }
      // W4-A-4 (D-13 provisional): "[attribute]" in this item's effect keys <- the attribute its note names
      if (op.custom == null && ["power", "talent", "drawback"].includes(type)) fillPlan(p, opId, data, note);
      const links = {};
      let dependsOn = null;
      if (type === "power") {
        const s = link(opId, op.sourceItemId, op.sourceOpId, ["powerSource"], "power source");
        if (s) { data.system.powerSource = s; links.source = s; if (op.sourceOpId) dependsOn = String(op.sourceOpId); }
        else if (op.sourceItemId == null && op.sourceOpId == null) { data.system.powerSource = ""; W("power.noSource", `power "${data.name}" names no power source`, { opId }); }
      } else if (type === "boost" || type === "limit") {
        const pw = link(opId, op.powerItemId, op.powerOpId, ["power"], "power");
        if (pw) { data.system.power = pw; links.power = pw; if (op.powerOpId) dependsOn = String(op.powerOpId); }
        else if (op.powerItemId == null && op.powerOpId == null) E("link.power.required", `a ${type} must name its power (powerItemId or powerOpId)`, { opId });
      } else if (op.sourceItemId != null || op.sourceOpId != null || op.powerItemId != null || op.powerOpId != null) W("op.link.ignored", `links are ignored on a ${type} (op ${opId})`, { opId });
      const id = pid(opId);
      proj.set(id, { ...clone(data), _id: id, effects: clone(data.effects ?? []) });
      Object.assign(pl, { action: "add", type, name: data.name, level: type === "power" ? (r?.level ?? levelWord(op.level) ?? "basic") : undefined, links });
      p.creates.push({ opId, type, name: data.name, ...(type === "power" ? { level: pl.level } : {}), ...(note ? { note } : {}), ...(op.custom ? { custom: true } : { ref: normRef(op.ref) }) });
      exec.adds.push({ opId, type, data, dependsOn });
    }
    // names of link targets for the display list
    const nameOf = (id) => proj.get(id)?.name ?? cur.get(id)?.name ?? id;
    for (const c of p.creates) {
      const a = exec.adds.find((x) => x.opId === c.opId);
      if (a?.data.system?.powerSource) c.source = nameOf(a.data.system.powerSource);
      if (a?.data.system?.power) c.power = nameOf(a.data.system.power);
    }

    // 2. updates (and level swaps of split powers)
    const touched = new Set();
    for (const [opId, op] of byId) {
      if (op.kind !== "updateItem") continue;
      const pl = planOf.get(opId);
      const id = String(op.itemId ?? "");
      const it = cur.get(id);
      if (!it) { E("item.missing", `item ${id || "?"} is not on this sheet (removed or changed since the preview?)`, { opId, itemId: id }); continue; }
      if (removed.has(id)) { E("op.conflict", `"${it.name}" is both updated and removed`, { opId, itemId: id }); continue; }
      if (touched.has(id)) { E("op.conflict", `"${it.name}" is updated by two ops; merge them`, { opId, itemId: id }); continue; }
      touched.add(id);
      const set = op.set;
      if (!set || typeof set !== "object" || Array.isArray(set) || !Object.keys(set).length) { E("op.shape", "updateItem needs a non-empty `set`", { opId }); continue; }
      const allowed = ["level", "powerSourceItemId", "powerSourceOpId", "powerItemId", "powerOpId", "note", "name", "descriptionAppend", "gear"];
      const bad = Object.keys(set).filter((k) => !allowed.includes(k));
      if (bad.length) { E("set.field", `updateItem cannot set ${bad.join(", ")} (whitelist: ${allowed.join(", ")})`, { opId }); continue; }
      const type = it.type;
      const isGear = type === "gear" || type === "vehicleWeapon";
      Object.assign(pl, { itemId: id, type, name: it.name });
      const next = clone(it);
      const changes = [];
      const ch = (path, from, to) => { if (!same(from, to)) { changes.push({ path, from, to }); setPath(next, path, to); } };
      let swapData = null;
      // level
      if (set.level != null) {
        const w = levelWord(set.level);
        if (type !== "power") E("set.level.type", `only powers have a level ("${it.name}" is a ${type})`, { opId });
        else if (!w) E("level.word", `level "${set.level}" is not basic/major/massive/monstrous`, { opId });
        else {
          const r = res.get(opId);
          const now = powerLevelOf(it.system) || "basic";
          if (r?.error) E(r.error, r.error === "level.missing" ? `"${baseName(it.name)}" has no ${w} level document` : `the level document of "${baseName(it.name)}" could not be read`, { opId, itemId: id });
          else if (w !== now || (r?.split && it.system?.level !== w)) {
            if (r?.split) {
              // split-level power: swap the level document, SAME id (keepId), same source, same name note (spec 6 updateItem)
              swapData = itemDataFromPack(r.data);
              swapData.system.level = swapData.system.level || w;
              swapData.system.powerSource = it.system?.powerSource ?? "";
              swapData.name = withNote(swapData.name, noteOf(it.name));
              changes.push({ path: "level", from: now, to: w, swap: true });
            } else {
              ch("system.level", it.system?.level ?? "", w);
              for (const f of levelFlips(it.system, w)) ch(`system.automations.${f.key}.showAsSelection`, f.from, f.to);
            }
          } else W("op.noop", `"${it.name}" is already ${w}`, { opId });
        }
      }
      if (set.powerSourceItemId != null || set.powerSourceOpId != null) {
        if (type !== "power") E("set.source.type", `only powers have a power source ("${it.name}" is a ${type})`, { opId });
        else {
          const s = link(opId, set.powerSourceItemId, set.powerSourceOpId, ["powerSource"], "power source");
          if (s) { if (swapData) swapData.system.powerSource = s; ch("system.powerSource", it.system?.powerSource ?? "", s); pl.links.source = s; }
        }
      }
      if (set.powerItemId != null || set.powerOpId != null) {
        if (type !== "boost" && type !== "limit") E("set.power.type", `only boosts and limits belong to a power ("${it.name}" is a ${type})`, { opId });
        else {
          const pw = link(opId, set.powerItemId, set.powerOpId, ["power"], "power");
          if (pw) { ch("system.power", it.system?.power ?? "", pw); pl.links.power = pw; }
        }
      }
      if (set.note != null) {
        if (!["power", "talent", "drawback"].includes(type)) E("set.note.type", `notes are written on powers, talents and drawbacks only ("${it.name}" is a ${type})`, { opId });
        else { const n = writeNote(set.note); const to = withNote(it.name, n); if (swapData) swapData.name = to; ch("name", it.name, to); }
      }
      if (set.name != null) {
        if (!isGear) E("set.name.type", `only gear and vehicle weapons can be renamed; use a note on "${it.name}"`, { opId });
        else { const n = cleanText(set.name, 80); if (!n) E("set.name", "name must not be empty", { opId }); else ch("name", it.name, n); }
      }
      if (set.descriptionAppend != null) {
        if (!isGear) E("set.description.type", `descriptions are only extended on gear and vehicle weapons ("${it.name}" is a ${type})`, { opId });
        else { const add = toParagraphs(set.descriptionAppend); if (add) ch("system.description", it.system?.description ?? "", `${it.system?.description ?? ""}${add}`); }
      }
      if (set.gear != null) {
        const g = set.gear;
        if (!isGear) E("set.gear.type", `"${it.name}" is not gear`, { opId });
        else if (typeof g !== "object" || Array.isArray(g)) E("set.gear", "gear must be an object", { opId });
        else {
          const badG = Object.keys(g).filter((k) => !["cost", "restricted", "singleUse", "attack"].includes(k));
          if (badG.length) E("set.gear.field", `gear cannot set ${badG.join(", ")}`, { opId });
          if (g.cost !== undefined) { const c = int(g.cost); if (Number.isNaN(c) || c < 0) E("gear.cost", "cost must be an integer >= 0", { opId }); else ch("system.cost", it.system?.cost, c); }
          if (g.restricted !== undefined) ch("system.restricted", !!it.system?.restricted, g.restricted === true);
          if (g.singleUse !== undefined) { if (type !== "gear") E("set.gear.field", "vehicle weapons have no singleUse", { opId }); else ch("system.singleUse", !!it.system?.singleUse, g.singleUse === true); }
          if (g.attack !== undefined) {
            checkAttack(g.attack, E, { opId });
            const autos = Object.entries(it.system?.automations ?? {}).filter(([, a]) => a?.type === "rollAttack" || a?.type === "rollAttackWithActor");
            if (autos.length) {
              const [key, a] = autos[0];
              const want = attackAutomation({ ...g.attack, name: a.name }, a._id ?? key);
              for (const k of ["rollBonus", "baseDamage", "minRange", "maxRange", "bypassArmor"]) if (g.attack[{ rollBonus: "bonus", baseDamage: "damage" }[k] ?? k] !== undefined) ch(`system.automations.${key}.${k}`, a[k], want[k]);
            } else {
              const nid = opts.randomID();
              ch(`system.automations.${nid}`, undefined, attackAutomation(g.attack, nid));
            }
          }
        }
      }
      if (swapData) {
        fillPlan(p, opId, swapData, noteOf(swapData.name));   // W4-A-4: the new level document's placeholders, from the kept note
        const after = { ...clone(swapData), _id: id };
        proj.set(id, after);
        p.swaps.push({ opId, id, name: it.name, from: changes.find((c) => c.swap)?.from, to: changes.find((c) => c.swap)?.to });
        exec.swaps.push({ opId, itemId: id, data: swapData, name: it.name });
        Object.assign(pl, { action: "swap", changes, destructive: true, name: newNameOf(changes, it.name) });
        p.updates.push({ opId, itemId: id, type, name: newNameOf(changes, it.name), changes });
      } else if (changes.length) {
        proj.set(id, next);
        const upd = {};
        for (const c of changes) {
          if (c.to === undefined) { const [k, v] = dropKey(c.path); upd[k] = v; } else upd[c.path] = c.to;
        }
        exec.updates.push({ opId, itemId: id, update: upd, paths: changes.map((c) => c.path), name: it.name });
        Object.assign(pl, { action: "update", changes, name: newNameOf(changes, it.name) });
        p.updates.push({ opId, itemId: id, type, name: newNameOf(changes, it.name), changes });
      } else if (!p.errors.some((e) => e.opId === opId)) { pl.action = "noop"; if (!p.warnings.some((w) => w.opId === opId)) W("op.noop", `op ${opId} changes nothing on "${it.name}"`, { opId }); }
    }

    // 3. removals + cascade (dependants after all re-points are known)
    const dependantsOf = (id) => [...proj.values()].filter((x) => !removed.has(String(x._id)) && (
      (x.type === "power" && String(x.system?.powerSource ?? "") === id) ||
      ((x.type === "boost" || x.type === "limit") && String(x.system?.power ?? "") === id)));
    for (const [opId, op] of byId) {
      if (op.kind !== "removeItem") continue;
      const id = String(op.itemId ?? "");
      if (!cur.has(id) || removed.get(id) !== opId) continue;
      const it = cur.get(id);
      const pl = planOf.get(opId);
      Object.assign(pl, { action: "remove", itemId: id, type: it.type, name: it.name, destructive: true });
      p.deletes.push({ opId, id, type: it.type, name: it.name });
      exec.removes.push({ opId, itemId: id, name: it.name, type: it.type });
    }
    for (const [opId, op] of byId) {
      if (op.kind !== "removeItem") continue;
      const id = String(op.itemId ?? "");
      if (removed.get(id) !== opId) continue;
      const pl = planOf.get(opId);
      const deps = dependantsOf(id);
      if (!deps.length) continue;
      if (op.cascade !== true) {
        E("remove.dependants", `removing "${cur.get(id).name}" leaves ${deps.map((d) => `"${d.name}"`).join(", ")} without ${cur.get(id).type === "powerSource" ? "a source" : "a power"}: set cascade: true, remove them, or re-point them in the same list`, { opId, itemId: id, names: deps.map((d) => d.name) });
        continue;
      }
      const queue = [...deps];
      while (queue.length) {
        const d = queue.shift();
        const did = String(d._id);
        if (removed.has(did)) continue;
        if (did.startsWith("+")) { E("remove.dependants", `"${d.name}" is added in this proposal under the item op ${opId} removes`, { opId }); continue; }
        removed.set(did, opId);
        pl.cascade.push({ itemId: did, type: d.type, name: d.name });
        p.deletes.push({ opId, id: did, type: d.type, name: d.name, cascadeOf: opId });
        exec.removes.push({ opId, itemId: did, name: d.name, type: d.type, cascadeOf: opId });
        queue.push(...dependantsOf(did));
      }
    }
    // an add or re-point that targets something a cascade removed
    for (const a of exec.adds) {
      for (const f of ["powerSource", "power"]) {
        const t = a.data.system?.[f];
        if (t && removed.has(String(t)) && !String(t).startsWith("+")) E("link.removed", `"${a.data.name}" links to "${nameOf(t)}", which this proposal removes`, { opId: a.opId });
      }
    }
    for (const id of removed.keys()) proj.delete(id);

    // 4. actor fields
    const actorPaths = new Set();
    for (const [opId, op] of byId) {
      if (op.kind !== "updateActor") continue;
      const pl = planOf.get(opId);
      const entries = actorSetEntries(op.set, opts, E, opId, W);
      const changes = [];
      for (const { path, value, spec } of entries) {
        if (actorPaths.has(path)) { E("op.conflict", `${path} is set by two ops`, { opId, path }); continue; }
        actorPaths.add(path);
        if (spec.kind === "append") {
          const cur0 = String(getPath(actorSrc, spec.target) ?? "");
          const add = toParagraphs(value);
          if (add) { changes.push({ path: spec.target, from: cur0, to: cur0 + add }); setPath(actorSrc, spec.target, cur0 + add); }
          continue;
        }
        const from = getPath(actorSrc, path);
        if (spec.kind === "text" && value === "" && String(from ?? "").trim()) W("actor.blank", `${path} is not blanked (empty values are never written)`, { opId, path });
        if (spec.kind === "text" && value === "") continue;
        if (!same(from ?? (spec.kind === "text" ? "" : null), value)) { changes.push({ path, from: from ?? null, to: value }); setPath(actorSrc, path, value); }
      }
      // W3-2: the op names the actor as it will be called (set.name present: the new name, even when unchanged)
      const newName = entries.find((e) => e.path === "name")?.value;
      Object.assign(pl, { action: changes.length ? "actor" : "noop", type: "actor", name: newName || actor.name, changes });
      if (!changes.length && !p.errors.some((e) => e.opId === opId)) W("op.noop", `op ${opId} changes no actor field`, { opId });
      for (const c of changes) {
        p.fields.push({ opId, ...c });
        if (c.path !== "name" && typeof c.from === "string" && c.from.trim() && !/^system\.biography$/.test(c.path)) p.overwrites.push({ opId, ...c });
      }
      if (changes.length) exec.actor.push({ opId, set: Object.fromEntries(changes.map((c) => [c.path, c.to])), paths: changes.map((c) => c.path) });
    }

    // keeps, expect, projection
    const touchedIds = new Set([...exec.updates.map((u) => u.itemId), ...exec.swaps.map((s) => s.itemId), ...removed.keys()]);
    for (const [id, s] of cur) if (!touchedIds.has(id)) p.keeps.push({ id, type: s.type, name: s.name });
    for (const id of touchedIds) { const s = cur.get(id); if (s) p.expect.items[id] = { fp: fingerprint(s), name: s.name }; }
    for (const a of exec.actor) for (const path of a.paths) p.expect.actor[path] = getPath(srcOf(actor), path) ?? null;
    p.expect.deletes = [...removed.keys()].sort();
    p.ops = opPlans;
    // W5-A-3: a replace delivers the proposal's talent order (talent roles: first = hero, second = occupation; W2-3). Kept talents
    // keep their place and new ones land at the end, so after the other phases the talents from the first out-of-order position
    // on are re-created (keepId, same source) in the proposal's order. Deterministic (movePlan). ops mode: never (the model
    // orders talents itself by remove + add). Talents the proposal does not name (a deselected removal) follow in their order.
    exec.order = null; exec.orderKnown = false;
    if (opts.mode === "replace" && Array.isArray(opts.talentOrder) && opts.talentOrder.length) {
      const before = [...cur].filter(([id, s]) => s.type === "talent" && !removed.has(id)).map(([id]) => id)
        .concat(exec.adds.filter((a) => a.type === "talent").map((a) => pid(a.opId)));
      const desired = [...new Set(opts.talentOrder.map((t) => (t?.itemId != null ? String(t.itemId) : t?.opId != null ? pid(String(t.opId)) : "")).filter((id) => before.includes(id)))];
      desired.push(...before.filter((id) => !desired.includes(id)));
      exec.orderKnown = true;
      const { keep, move } = movePlan(before, desired);
      if (move.length) {
        exec.order = { desired };
        const curTal = [...cur].filter(([, s]) => s.type === "talent").map(([id]) => ({ id }));
        const was = talentRoles(curTal, !!String(srcOf(actor).system?.occupation ?? "").trim());
        const will = talentRoles([...keep, ...move].map((id) => ({ id })), !!String(actorSrc.system?.occupation ?? "").trim());
        for (const id of move) {
          const isNew = id.startsWith("+");
          const from = isNew ? null : (was.get(id) ?? null), to = will.get(id) ?? null;
          p.reorders.push({ id: isNew ? null : id, opId: isNew ? id.slice(1) : null, name: nameOf(id), from, to, roleChange: !isNew && !!from && from !== to });
        }
        const kept = p.reorders.filter((r) => r.id);
        if (kept.length) p.info.push(msg("talent.order", `Talents in the proposal's order: ${kept.map((r) => `"${r.name}"${r.roleChange ? ` ${r.from} -> ${r.to}` : ""}`).join(", ")} re-created after the others with the same id${kept.length > 1 ? "s" : ""}.`, { names: kept.map((r) => r.name) }));
      }
    }
    const projItems = [...proj.values()].map((s) => ({ id: String(s._id), name: s.name, type: s.type, _source: s, effects: clone(s.effects ?? []) }));
    if (exec.order) {   // the projection shows the written order: the re-created talents last, in the proposal's order
      const moved = p.reorders.map((r) => r.id ?? pid(r.opId));
      const at = new Map(projItems.map((i) => [i.id, i]));
      projItems.splice(0, projItems.length, ...projItems.filter((i) => !moved.includes(i.id)), ...moved.map((id) => at.get(id)).filter(Boolean));
    }
    actorSrc.items = projItems.map((i) => i._source);
    p.projected = { id: String(actorSrc._id ?? actor.id ?? ""), uuid: String(actor.uuid ?? ""), documentName: "Actor", name: actorSrc.name ?? actor.name, type: actorSrc.type ?? actor.type, _source: actorSrc, system: clone(actorSrc.system), items: projItems, effects: clone(srcOf(actor).effects ?? listOf(actor.effects).map(srcOf)), overrides: {} };
    // W3-3 (D-1): a build = creation profile, no creation item of the actor survives the run (empty or emptied) and the run adds
    // some: current Health / Resolve go to max after the write. W5-A-1 (provisional): a REPLACE in the creation profile is a build
    // too (the model re-states the whole hero: "change him into X" must not start wounded), removals or not. ops-mode edits and
    // in-play keep them (O25; only the clamp below max).
    const survivors = [...cur].filter(([id, s]) => CREATION_TYPES.includes(s.type) && !removed.has(id));
    p.build = opts.profile !== "in-play" && (opts.mode === "replace" || (!survivors.length && exec.adds.some((a) => CREATION_TYPES.includes(a.type))));
    if (p.build) p.info.push(msg("vitals.build", opts.mode === "replace" ? "Replace in the creation profile is a build: current Health and Resolve are set to their max after the write." : "New build: current Health and Resolve are set to their max after the write."));
    p.info.push(msg("plan.summary", `${p.creates.length} to add, ${p.updates.length} to change, ${p.deletes.length} to remove, ${p.fields.length} actor field(s); ${p.keeps.length} item(s) unchanged, ids kept.`));
    return finish(p, exec);
  }

  function safeLive(doc) { try { return D.liveForm(doc); } catch { return null; } }

  /* -------------------------------------------------------------- item document (gear / vehicle weapon drawer) */
  async function planItemDoc(item, proposal, opts) {
    const p = emptyPlan(item);
    p.mode = "item";
    const E = (code, message, extra = {}) => p.errors.push(msg(code, message, extra));
    const exec = { item: null, world: null };
    const target = proposal?.target === "newItem" ? "newItem" : "this";
    if (target === "this" && !ITEM_DOC_TYPES.includes(item?.type)) { E("doc.type", `item drawers write ${ITEM_DOC_TYPES.join(" / ")}, not "${item?.type}"`); return finish(p); }
    const src = srcOf(item);
    let g = proposal?.proposal?.item ?? proposal?.proposal ?? proposal?.item ?? null;
    if (proposal?.mode === "ops") {
      const op = (proposal.ops ?? [])[0];
      if ((proposal.ops ?? []).length !== 1 || (op?.kind ?? op?.op) !== "updateItem" || String(op.itemId) !== String(src._id ?? item.id)) { E("proposal.shape", "an item drawer takes ONE updateItem op on this item, or a gear proposal"); return finish(p); }
      g = { ...(op.set?.gear ?? {}), ...(op.set?.name != null ? { name: op.set.name } : {}), ...(op.set?.descriptionAppend != null ? { descriptionAppend: op.set.descriptionAppend } : {}) };
    }
    if (!g || typeof g !== "object") { E("proposal.shape", "no gear proposal"); return finish(p); }
    const badK = Object.keys(g).filter((k) => !["type", "baseRef", "name", "description", "descriptionAppend", "cost", "restricted", "singleUse", "attack"].includes(k));
    if (badK.length) E("gear.field", `gear proposals cannot set ${badK.join(", ")}`);
    if (g.type != null && !ITEM_DOC_TYPES.includes(g.type)) E("gear.type", `type must be ${ITEM_DOC_TYPES.join(" or ")}`);
    if (target === "this" && g.type != null && g.type !== item.type) E("gear.type", `this item is a ${item.type}`);
    const opId = "item";
    let base = target === "newItem" ? { name: "", type: g.type ?? "gear", system: { description: "", cost: 0, restricted: false, ...(g.type === "vehicleWeapon" ? {} : { singleUse: false }), automations: {} } } : clone(src);
    if (g.baseRef) {
      const cat = await D.getCatalog();
      const r = await resolveRef(cat, g.baseRef, null);
      if (r.error || !ITEM_DOC_TYPES.includes(r.entry?.kind)) E("ref.unknown", `baseRef "${g.baseRef}" is not a gear / vehicle weapon in the catalogue`);
      else { const d = itemDataFromPack(r.data); base = { ...base, name: d.name, type: d.type ?? base.type, system: { ...base.system, ...d.system } }; }
    }
    if (g.cost !== undefined && (Number.isNaN(int(g.cost)) || int(g.cost) < 0)) E("gear.cost", "cost must be an integer >= 0");
    checkAttack(g.attack, E, {});
    if (g.singleUse !== undefined && (target === "this" ? item.type : base.type) === "vehicleWeapon") E("gear.field", "vehicle weapons have no singleUse");
    if (p.errors.length) return finish(p);
    const next = clone(base);
    if (g.name != null) { const n = cleanText(g.name, 80); if (n) next.name = n; }
    if (g.description != null) next.system.description = toParagraphs(g.description);
    if (g.descriptionAppend != null) next.system.description = `${next.system.description ?? ""}${toParagraphs(g.descriptionAppend)}`;
    if (g.cost !== undefined) next.system.cost = int(g.cost);
    if (g.restricted !== undefined) next.system.restricted = g.restricted === true;
    if (g.singleUse !== undefined) next.system.singleUse = g.singleUse === true;
    if (g.attack) {
      const autos = Object.entries(next.system.automations ?? {}).filter(([, a]) => a?.type === "rollAttack" || a?.type === "rollAttackWithActor");
      if (autos.length) { const [k, a] = autos[0]; next.system.automations[k] = { ...a, ...pickAttack(attackAutomation({ ...g.attack, name: a.name }, a._id ?? k), g.attack) }; }
      else { const nid = D.randomID(); next.system.automations = { ...(next.system.automations ?? {}), [nid]: attackAutomation(g.attack, nid) }; }
    }
    if (target === "newItem") {
      const data = { name: next.name || "Item", type: next.type ?? "gear", system: { description: next.system.description ?? "", cost: next.system.cost ?? 0, restricted: !!next.system.restricted, ...(next.type === "vehicleWeapon" ? {} : { singleUse: !!next.system.singleUse }), automations: next.system.automations ?? {} } };
      if (!g.baseRef) data.system.automations = Object.fromEntries(Object.entries(data.system.automations).filter(([, a]) => a.type === "rollAttack"));
      p.creates.push({ opId, type: data.type, name: data.name, world: true });
      exec.world = { opId, data };
      p.ops = [{ opId, kind: "addItem", action: "add", itemId: null, type: data.type, name: data.name, ref: g.baseRef ?? null, changes: [], cascade: [], links: {}, requires: [], destructive: false }];
      return finish(p, exec);
    }
    // in place: flat paths of what changes (whitelisted fields only)
    const changes = [];
    const walk = (path) => { const a = getPath(src, path), b = getPath(next, path); if (!same(a, b)) changes.push({ path, from: a ?? null, to: b ?? null }); };
    for (const path of ["name", "system.description", "system.cost", "system.restricted", "system.singleUse"]) walk(path);
    const keys = new Set([...Object.keys(src.system?.automations ?? {}), ...Object.keys(next.system?.automations ?? {})]);
    for (const k of keys) walk(`system.automations.${k}`);
    const upd = {};
    for (const c of changes) { if (c.to === null && getPath(next, c.path) === undefined) { const [k, v] = dropKey(c.path); upd[k] = v; } else upd[c.path] = c.to; }
    p.fields.push(...changes);
    p.overwrites.push(...changes.filter((c) => c.path === "system.description" && plainText(c.from)));
    p.ops = [{ opId, kind: "updateItem", action: changes.length ? "update" : "noop", itemId: String(src._id ?? item.id), type: item.type, name: item.name, ref: g.baseRef ?? null, changes, cascade: [], links: {}, requires: [], destructive: false }];
    if (!changes.length) p.warnings.push(msg("op.noop", "the proposal changes nothing on this item"));
    p.expect.items[String(src._id ?? item.id)] = { fp: fingerprint(src), name: src.name };
    p.unsaved = unsavedFrom({ _source: src, items: [] }, safeLive(item));
    p.projected = { ...clone(src), ...clone(next) };
    exec.item = { opId, update: upd, paths: changes.map((c) => c.path), before: Object.fromEntries(changes.map((c) => [c.path, c.from])) };
    return finish(p, exec);
  }
  const pickAttack = (want, given) => Object.fromEntries(Object.entries({ rollBonus: "bonus", baseDamage: "damage", minRange: "minRange", maxRange: "maxRange", bypassArmor: "bypassArmor" }).filter(([, g]) => given[g] !== undefined).map(([k]) => [k, want[k]]));

  /* -------------------------------------------------------------- lock (one write per actor, across clients; plus-ultra A1 pattern) */
  async function withLock(doc, fn) {
    const key = doc.uuid ?? doc.id;
    if (inflight.has(key)) return busy(doc, D.userName(D.userId()));
    const now = D.now();
    const src = srcOf(doc);
    for (const path of [LOCK_PATH, PU_LOCK_PATH]) {
      const cur = getPath(src, path);
      if (cur?.runId && now - (Number(cur.at) || 0) < LOCK_TTL) return busy(doc, D.userName(cur.userId));
    }
    inflight.add(key);
    const lockId = D.randomID();
    try {
      if (docName(doc) === "Actor") {
        await doc.update({ [LOCK_PATH]: { runId: lockId, userId: D.userId(), at: now } });
        if (D.lockSettle) await D.sleep(D.lockSettle);
        const got = getPath(srcOf(doc), LOCK_PATH);
        if (got?.runId !== lockId) return busy(doc, D.userName(got?.userId));
      }
      return await fn();
    } finally {
      inflight.delete(key);
      if (docName(doc) === "Actor") {
        try { if (getPath(srcOf(doc), LOCK_PATH)?.runId === lockId) { const [k, v] = dropKey(LOCK_PATH); await doc.update({ [k]: v }); } }
        catch (e) { D.log?.warn?.("moinens-ai-gen | writer: could not release the lock", e); }
      }
    }
  }
  const busy = (doc, by) => fail("write.busy", `"${doc.name}" is being written by ${by}; try again in a moment.`, { busy: true });
  function fail(code, message, extra = {}) {
    return { ok: false, runId: null, plan: null, errors: [msg(code, message, extra.errorExtra ?? {})], warnings: [], created: [], updated: [], deleted: [], idMap: {}, message, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "errorExtra")) };
  }
  function guard(doc) {
    if (!D.isGM()) return fail("user.notGM", "Only the GM writes with the builder.");
    if (!doc) return fail("doc.missing", "No document.");
    if (doc.pack || doc.compendium?.locked || doc.isOwner === false) return fail("doc.readOnly", `"${doc.name}" cannot be written (compendium, locked or not owned).`);
    const unsaved = unsavedFrom(docName(doc) === "Item" ? { _source: srcOf(doc), items: [] } : doc, safeLive(doc));
    if (unsaved.length) return fail("sheet.unsaved", `The open sheet of "${doc.name}" has unsaved input (${unsaved.map((u) => u.path).join(", ")}): save or discard it first.`, { unsaved });
    return null;
  }

  /* -------------------------------------------------------------- stale check (spec 7.5 point 5, B6) */
  function staleCheck(p, expect, doc) {
    const out = [];
    const exp = expect?.items ?? {};
    const items = new Map(listOf(doc.items).map((i) => [String(srcOf(i)._id ?? i.id), srcOf(i)]));
    for (const [id, e] of Object.entries(exp)) {
      const s = docName(doc) === "Item" ? (String(srcOf(doc)._id ?? doc.id) === id ? srcOf(doc) : null) : items.get(id);
      if (!s) out.push({ itemId: id, name: e?.name ?? id, why: "missing" });
      else if (fingerprint(s) !== e?.fp) out.push({ itemId: id, name: s.name, why: "changed" });
    }
    for (const id of Object.keys(p.expect.items)) if (!(id in exp)) out.push({ itemId: id, name: p.expect.items[id].name, why: "not in preview" });
    const seenDel = new Set(expect?.deletes ?? []);
    for (const id of p.expect.deletes) if (!seenDel.has(id) && !out.some((o) => o.itemId === id)) out.push({ itemId: id, name: items.get(id)?.name ?? id, why: "not in preview" });
    for (const [path, v] of Object.entries(expect?.actor ?? {})) if (!same(getPath(srcOf(doc), path) ?? null, v)) out.push({ itemId: null, name: path, why: "changed" });
    return out;
  }

  /* -------------------------------------------------------------- apply */
  async function apply(doc, proposal, opts = {}) {
    const g = guard(doc);
    if (g) return g;
    return withLock(doc, () => applyLocked(doc, proposal, opts));
  }
  async function applyLocked(doc, proposal, opts = {}) {
    const { confirmed = false, expect = null, profile, only, allowVitals = false, onStage = null, label = "" } = opts;
    const stage = (s) => { try { onStage?.(s); } catch { /* progress callbacks never break a write */ } };
    // rank + profile reach the replace -> ops conversion too (a creation build without reputation gets the rank's value, P1-F)
    const { plan: p, exec } = await planInternal(doc, proposal, { only, deselect: opts.deselect, allowVitals, rank: opts.rank, profile });
    const base = { ok: false, runId: null, plan: p, errors: p.errors, warnings: p.warnings, created: [], updated: [], deleted: [], idMap: {} };
    if (!p.ok) return { ...base, message: p.errors[0]?.message ?? "invalid" };
    if (typeof D.validate === "function") {
      let v = null;
      const deselect = Array.isArray(only) ? p.ops.map((o) => o.opId).filter((id) => !only.includes(id)).concat(p.dropped.map((d) => d.opId)) : (opts.deselect ?? undefined);
      try { v = await D.validate(doc, proposal, { profile, rank: opts.rank, deselect, skipPlan: true, only, allowVitals }); }
      catch (e) { v = { ok: false, errors: [msg("validate.failed", String(e?.message ?? e))] }; }
      // the validator's budget (before / after the ops) rides on every later result (W2-7: the concise apply result shows it)
      if (v?.budget) base.budget = v.budget;
      if (v && v.ok === false) return { ...base, validation: v, errors: v.errors ?? [], message: v.errors?.[0]?.message ?? "validation failed" };
      // W3-2 (was P1-G, rank.defaulted only): the validator's warnings ride on the result, each once (same code + op + message)
      const seen = new Set(p.warnings.map((w) => `${w.code}|${w.opId ?? ""}|${w.message}`));
      for (const w of v?.warnings ?? []) {
        if (!w?.code) continue;
        // W5-A-3: the writer writes a replace's talents in the proposal's order, so the validator's role shift (projected with
        // kept talents in place) does not happen
        if (w.code === "talent.role.shift" && exec?.orderKnown) continue;
        const m = { ...w, message: w.message ?? (w.code === "rank.defaulted" ? "No rank given: validated as the default rank." : w.code) };
        const k = `${m.code}|${m.opId ?? ""}|${m.message}`;
        if (!seen.has(k)) { seen.add(k); p.warnings.push(m); }
      }
    }
    if (expect) {
      const stale = staleCheck(p, expect, doc);
      if (stale.length) {
        const names = stale.map((s) => `"${s.name}" (${s.why})`).join(", ");
        const e = msg("plan.stale", `Changed since the preview: ${names}. Nothing was written; preview again.`, { names: stale.map((s) => s.name) });
        return { ...base, stale, errors: [e], message: e.message };
      }
    }
    if (p.destructive && confirmed !== true) {
      const e = msg("plan.needConfirm", `This removes or replaces ${p.deletes.length + p.swaps.length} item(s); confirm to apply.`);
      return { ...base, needsConfirm: true, errors: [e], message: e.message };
    }
    const runId = D.randomID();
    p.runId = runId;
    const run = { runId, at: D.now(), by: D.userId(), label: cleanText(label, 120), ops: [] };
    if (docName(doc) === "Item") return execItemDoc(doc, p, exec, run, base);
    // W5-A-2: the collection order before the run; undo and rollback put the items back in it (talent roles hang on it)
    run.order = listOf(doc.items).map((i) => String(srcOf(i)._id ?? i.id));
    let reordered = [];
    const idMap = {};
    const created = [], updated = [], deleted = [];
    let phase = "start";
    // W3-1 (F0): every add gets its id BEFORE writing and is created with keepId. The v14 server returns (and, without keepId,
    // inserts) created documents in completion order, so mapping the returned array by index could swap ids; with keepId the
    // server keeps the given order, which is also the talents' collection order (their roles, W2-3).
    const newIds = {};
    {
      const taken = new Set(listOf(doc.items).map((i) => String(srcOf(i)._id ?? i.id)));
      for (const a of exec.adds) {
        let id = null;
        for (let k = 0; k < 20 && !id; k++) { const c = String(D.randomID() ?? ""); if (ID_RE.test(c) && !taken.has(c)) id = c; }
        if (!id) { do id = Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join(""); while (taken.has(id)); }
        taken.add(id); newIds[a.opId] = id;
      }
    }
    try {
      // 1. creates, phase by phase, links to earlier adds resolved through the pre-assigned ids (only once written)
      for (const types of CREATE_PHASES) {
        const batch = exec.adds.filter((a) => types.includes(a.type));
        if (!batch.length) continue;
        phase = `create ${types.join("/")}`; stage(phase);
        const data = batch.map((a) => {
          const d = { ...clone(a.data), _id: newIds[a.opId] };
          for (const f of ["powerSource", "power"]) { const t = d.system?.[f]; if (typeof t === "string" && t.startsWith("+")) { const real = idMap[t.slice(1)]; if (!real) throw new Error(`link to ${t} unresolved`); d.system[f] = real; } }
          return d;
        });
        const docs = listOf(await doc.createEmbeddedDocuments("Item", data, { keepId: true }));
        const back = new Set(docs.map((d) => String(d?.id ?? d?._id ?? "")));
        // record what exists before checking, so a rollback deletes every item this batch did write
        for (const a of batch) {
          const id = newIds[a.opId];
          const it = doc.items?.get?.(id);
          if (!it && !back.has(id)) continue;
          idMap[a.opId] = id; created.push(id);
          run.ops.push({ opId: a.opId, kind: "add", itemId: id, type: a.type, name: it?.name ?? a.data.name, before: null, after: null, ...(a.dependsOn ? { dependsOn: a.dependsOn } : {}) });
        }
        const ours = new Set(batch.map((a) => newIds[a.opId]));
        for (const d of docs) { const id = String(d?.id ?? d?._id ?? ""); if (id && !ours.has(id)) run.ops.push({ opId: "_foreign", kind: "add", itemId: id, type: d.type ?? "", name: d.name ?? id, before: null, after: null }); }
        const missing = batch.filter((a) => !idMap[a.opId]);
        if (missing.length || docs.length !== batch.length) throw new Error(`created items do not match the requested ids (${missing.map((a) => a.opId).join(", ") || `${docs.length} of ${batch.length}`})`);
      }
      // 2. level swaps of split powers: same id, keepId
      for (const s of exec.swaps) {
        phase = "swap"; stage(phase);
        const it = doc.items.get(s.itemId);
        const before = clone(srcOf(it));
        const entry = { opId: s.opId, kind: "swap", itemId: s.itemId, type: before.type, name: before.name, before, after: null };
        run.ops.push(entry);
        await doc.deleteEmbeddedDocuments("Item", [s.itemId]);
        const data = { ...clone(s.data), _id: s.itemId };
        const t = data.system?.powerSource;
        if (typeof t === "string" && t.startsWith("+")) data.system.powerSource = idMap[t.slice(1)] ?? "";
        await doc.createEmbeddedDocuments("Item", [data], { keepId: true });
        updated.push(s.itemId);
      }
      // 3. item updates (one call)
      if (exec.updates.length) {
        phase = "update"; stage(phase);
        const rows = [];
        for (const u of exec.updates) {
          const before = clone(srcOf(doc.items.get(u.itemId)));
          const row = { _id: u.itemId };
          for (const [k, v] of Object.entries(u.update)) row[k] = (typeof v === "string" && v.startsWith("+") && (k === "system.powerSource" || k === "system.power")) ? (idMap[v.slice(1)] ?? "") : v;
          rows.push(row);
          run.ops.push({ opId: u.opId, kind: "update", itemId: u.itemId, type: before.type, name: before.name, before, paths: u.paths, after: null });
        }
        await doc.updateEmbeddedDocuments("Item", rows);
        updated.push(...exec.updates.map((u) => u.itemId));
      }
      // 4. removals incl. cascade (one call)
      if (exec.removes.length) {
        phase = "remove"; stage(phase);
        const ids = [];
        for (const r of exec.removes) {
          const it = doc.items.get(r.itemId);
          if (!it) continue;
          run.ops.push({ opId: r.opId, kind: "remove", itemId: r.itemId, type: r.type, name: r.name, before: clone(srcOf(it)), after: null, ...(r.cascadeOf ? { cascadeOf: r.cascadeOf } : {}) });
          ids.push(r.itemId);
        }
        if (ids.length) { await doc.deleteEmbeddedDocuments("Item", ids); deleted.push(...ids); }
      }
      // 4b. W5-A-3: talents into the replace proposal's order (re-created with keepId and their current source, minimal set)
      if (exec.order) {
        phase = "order"; stage(phase);
        const real = (id) => (id.startsWith("+") ? idMap[id.slice(1)] ?? null : id);
        const talents = listOf(doc.items).map(srcOf).filter((s) => s.type === "talent").map((s) => String(s._id));
        const desired = [...new Set(exec.order.desired.map(real).filter((id) => id && talents.includes(id)))];
        desired.push(...talents.filter((id) => !desired.includes(id)));
        const { move } = movePlan(talents, desired);
        if (move.length) {
          const data = move.map((id) => clone(srcOf(doc.items.get(id))));
          run.ops.push({ opId: "_order", kind: "order", itemId: null, type: "talent", name: "talent order", ids: move, before: data, after: null });
          await doc.deleteEmbeddedDocuments("Item", move);
          await createKeep(doc, data);
          reordered = move.map((id) => { const r = p.reorders.find((x) => (x.id ?? idMap[x.opId]) === id); return { itemId: id, name: doc.items.get(id)?.name ?? r?.name ?? id, ...(r?.from ? { from: r.from } : {}), ...(r?.to ? { to: r.to } : {}) }; });
        }
      }
      // 5. actor fields (one call)
      if (exec.actor.length) {
        phase = "actor"; stage(phase);
        const upd = {};
        for (const a of exec.actor) {
          const before = {};
          for (const path of a.paths) before[path] = clone(getPath(srcOf(doc), path)) ?? null;
          run.ops.push({ opId: a.opId, kind: "actor", itemId: null, type: "actor", name: doc.name, paths: a.paths, before, after: clone(a.set) });
          Object.assign(upd, a.set);
        }
        await doc.update(upd);
      }
      // 6. current Health / Resolve: re-clamped only when the new max is lower (spec 8.4); at a build (W3-3, D-1) set to max.
      //    A value an op of this run wrote explicitly (allowVitals) is left alone.
      phase = "clamp"; stage(phase);
      const clamp = {};
      const vitals = {};
      const written = new Set(exec.actor.flatMap((a) => a.paths));
      for (const k of ["health", "resolve"]) {
        const path = `system.derived.${k}.value`;
        const d = doc.system?.derived?.[k];
        const v = Number(getPath(srcOf(doc), path)), mx = Number(d?.max);
        if (!Number.isFinite(mx)) continue;
        if (p.build && !written.has(path)) { if (v !== mx) { clamp[path] = mx; vitals[k] = { from: Number.isFinite(v) ? v : null, to: mx }; } }
        else if (Number.isFinite(v) && v > mx) clamp[path] = mx;
      }
      if (Object.keys(clamp).length) {
        const before = Object.fromEntries(Object.keys(clamp).map((path) => [path, getPath(srcOf(doc), path) ?? null]));
        run.ops.push({ opId: p.build ? "_vitals" : "_clamp", kind: "actor", itemId: null, type: "actor", name: doc.name, paths: Object.keys(clamp), before, after: clamp });
        await doc.update(clamp);
      }
      // after-fingerprints (drift detection for undo), then the journal
      phase = "journal"; stage(phase);
      for (const e of run.ops) {
        if (e.kind === "actor") e.after = Object.fromEntries(e.paths.map((path) => [path, clone(getPath(srcOf(doc), path)) ?? null]));
        else if (e.kind !== "remove" && e.kind !== "order") { const it = doc.items.get(e.itemId); e.after = it ? fingerprint(srcOf(it)) : null; if (it) e.name = it.name; }
      }
      // the order entry keeps its sources only in memory (rollback); the journal needs the ids
      const stored = { ...run, ops: run.ops.map((e) => { if (e.kind !== "order") return e; const { before, ...rest } = e; return { ...rest, before: null }; }) };
      const { journal, dropped } = pruneJournal({ runs: [...readJournal(srcOf(doc)).runs, stored] }, D.now());
      await doc.update({ [JOURNAL_PATH]: journal });
      const warnings = [...p.warnings];
      if (!journal.runs.some((r) => r.runId === runId)) warnings.push(msg("undo.notStored", "The undo record could not be stored."));
      if (dropped.length) warnings.push(msg("undo.trimmed", `Older undo records were dropped to keep the actor small (${dropped.length}).`));
      const vText = Object.entries(vitals).map(([k, x]) => `${k === "health" ? "Health" : "Resolve"} ${x.from ?? "?"} -> ${x.to}`).join(", ");
      const keptMoved = reordered.filter((r) => !created.includes(r.itemId));
      const oText = keptMoved.length ? ` Talents in the proposal's order (${keptMoved.map((r) => `"${r.name}"${r.from && r.to && r.from !== r.to ? ` ${r.from} -> ${r.to}` : ""}`).join(", ")}; same ids).` : "";
      const message = `Applied to "${doc.name}": ${created.length} added, ${updated.length} changed, ${deleted.length} removed, ${p.fields.length} field(s).${vText ? ` New build: current ${vText} (max).` : ""}${oText}`;
      return { ...base, ok: true, runId, errors: [], warnings, created, updated: [...new Set(updated)], deleted, idMap, message, ...(vText ? { vitals } : {}), ...(reordered.length ? { reordered } : {}) };
    } catch (err) {
      D.log?.error?.(`moinens-ai-gen | writer apply failed at ${phase}`, err);
      const reason = String(err?.message ?? err).replace(/[\s.]+$/, "");
      try {
        await revert(doc, run.ops, { rollback: true, order: run.order, full: true });
        const e = msg("write.failed", `Writing failed at "${phase}" (${reason}); everything this run wrote was rolled back.`);
        return { ...base, errors: [e], rolledBack: true, message: e.message };
      } catch (rb) {
        D.log?.error?.("moinens-ai-gen | writer rollback failed", rb);
        try { const { journal } = pruneJournal({ runs: [...readJournal(srcOf(doc)).runs, { ...run, label: `${run.label} (partial)`.trim() }] }, D.now()); await doc.update({ [JOURNAL_PATH]: journal }); } catch { /* best effort: keep the partial run undoable */ }
        const e = msg("write.rollbackFailed", `Writing failed at "${phase}" (${reason}) and the rollback failed too (${String(rb?.message ?? rb)}); the partial run is in the undo list.`);
        return { ...base, errors: [e], rolledBack: false, runId, message: e.message };
      }
    }
  }

  async function execItemDoc(item, p, exec, run, base) {
    try {
      if (exec.world) {
        if (typeof D.createWorldItem !== "function") throw new Error("creating world items is not available");
        const created = await D.createWorldItem(exec.world.data);
        run.ops.push({ opId: exec.world.opId, kind: "world", itemId: created.id, uuid: created.uuid, type: created.type, name: created.name, before: null, after: fingerprint(srcOf(created)) });
      } else if (exec.item?.paths.length) {
        run.ops.push({ opId: exec.item.opId, kind: "actor", itemId: null, type: item.type, name: item.name, paths: exec.item.paths, before: clone(exec.item.before), after: null });
        await item.update(exec.item.update);
        const e = run.ops[run.ops.length - 1];
        e.after = Object.fromEntries(e.paths.map((path) => [path, clone(getPath(srcOf(item), path)) ?? null]));
      } else return { ...base, ok: true, runId: null, errors: [], message: "Nothing to change." };
      const { journal } = pruneJournal({ runs: [...readJournal(srcOf(item)).runs, run] }, D.now());
      await item.update({ [JOURNAL_PATH]: journal });
      const w = run.ops[0];
      return { ...base, ok: true, runId: run.runId, errors: [], created: w.kind === "world" ? [w.itemId] : [], updated: w.kind === "actor" ? [String(srcOf(item)._id ?? item.id)] : [], idMap: w.kind === "world" ? { [w.opId]: w.uuid } : {}, message: w.kind === "world" ? `Created "${w.name}".` : `Updated "${item.name}".` };
    } catch (err) {
      try { await revert(item, run.ops, { rollback: true }); } catch (rb) { D.log?.error?.("moinens-ai-gen | writer rollback failed", rb); }
      const e = msg("write.failed", `Writing failed (${String(err?.message ?? err)}); rolled back.`);
      return { ...base, errors: [e], rolledBack: true, message: e.message };
    }
  }

  /* -------------------------------------------------------------- reverse writes (undo and rollback) */
  /** create items with their own ids (keepId); one retry for the ones still missing; throws naming what could not be created */
  async function createKeep(doc, data) {
    if (!data.length) return;
    const missing = () => data.filter((d) => !doc.items?.get?.(String(d._id)));
    try { await doc.createEmbeddedDocuments("Item", data, { keepId: true }); }
    catch (err) {
      const miss = missing();
      if (!miss.length) return;
      D.log?.warn?.("moinens-ai-gen | writer: re-creating items failed, one retry", err);
      await doc.createEmbeddedDocuments("Item", clone(miss), { keepId: true });
    }
    const still = missing();
    if (still.length) throw new Error(`could not re-create ${still.map((d) => `"${d.name}"`).join(", ")} with ${still.length > 1 ? "their" : "its"} id`);
  }
  /**
   * W5-A-2: re-create `pending` items (restored removals, old level documents; Map id -> source) and put the actor's items into
   * the run's pre-run `order` (restoreTarget: whole run = every item back in place; per item = only the pending ones), with ONE
   * delete and ONE create (movePlan: from the first out-of-order position on, keepId, current source). Without an `order`
   * (journal written before W5-A) the pending items are created at the end as before.
   */
  async function placeItems(doc, pending, order, full) {
    const has = (id) => !!doc.items?.get?.(id);
    if (!Array.isArray(order) || !order.length) { await createKeep(doc, [...pending.values()]); return; }
    const current = listOf(doc.items).map((i) => String(srcOf(i)._id ?? i.id));
    const { move } = movePlan(current, restoreTarget(current, order, [...pending.keys()], full));
    if (!move.length) return;
    const data = move.map((id) => pending.get(id) ?? clone(srcOf(doc.items.get(id))));
    const del = move.filter(has);
    if (del.length) await doc.deleteEmbeddedDocuments("Item", del);
    await createKeep(doc, data);
  }

  async function revert(doc, entries, { rollback = false, order = null, full = true } = {}) {
    const isItem = docName(doc) === "Item";
    const o = undoOrder(entries);
    const skipped = [];
    const has = (id) => !!doc.items?.get?.(id);
    // actor fields (or the item document's own fields)
    for (const e of o.actor) {
      const upd = {};
      for (const path of e.paths) {
        const b = e.before?.[path];
        if (b === null || b === undefined) {
          const now = getPath(srcOf(doc), path);
          if (typeof now === "string") upd[path] = "";
          else if (now !== undefined && /^system\.automations\.[^.]+$/.test(path)) { const [k, v] = dropKey(path); upd[k] = v; }
        } else upd[path] = clone(b);
      }
      if (Object.keys(upd).length) await doc.update(upd);
    }
    if (!isItem) {
      // removed items come back with their OLD ids (links from boosts/limits/powers stay intact); created at the end (placeItems)
      const pending = new Map();
      for (const e of o.restore) { if (has(e.itemId)) skipped.push(e); else pending.set(String(e.itemId), clone(e.before)); }
      // field updates written back path by path
      const rows = [];
      for (const e of o.reverse) {
        if (!has(e.itemId)) { skipped.push(e); continue; }
        const row = { _id: e.itemId };
        for (const path of e.paths ?? []) {
          const b = getPath(e.before, path);
          if (b === undefined) { const [k, v] = dropKey(path); row[k] = v; } else row[path] = clone(b);
        }
        rows.push(row);
      }
      if (rows.length) await doc.updateEmbeddedDocuments("Item", rows);
      // level swaps: the old level document back under the same id (created with the restored items)
      for (const e of o.swap) {
        if (has(e.itemId)) await doc.deleteEmbeddedDocuments("Item", [e.itemId]);
        pending.set(String(e.itemId), clone(e.before));
      }
      // rollback of a failed run: talents the order phase deleted and had not re-created yet (only items from before the run)
      if (rollback) for (const e of entries.filter((x) => x.kind === "order")) {
        for (const s of e.before ?? []) { const id = String(s?._id ?? ""); if (id && !has(id) && (order ?? []).includes(id)) pending.set(id, clone(s)); }
      }
      // adds deleted
      const del = o.remove.filter((e) => { if (!has(e.itemId)) { skipped.push(e); return false; } return true; }).map((e) => e.itemId);
      if (del.length) await doc.deleteEmbeddedDocuments("Item", del);
      // restored items created, everything back in the pre-run order (W5-A-2)
      await placeItems(doc, pending, order, full);
    }
    for (const e of entries.filter((x) => x.kind === "world")) {
      const d = typeof D.fromUuid === "function" ? await D.fromUuid(e.uuid) : null;
      if (d) await d.delete(); else skipped.push(e);
    }
    if (rollback) return { skipped };
    return { skipped };
  }

  /* -------------------------------------------------------------- undo / status */
  function journalState(doc) {
    const src = srcOf(doc);
    const journal = readJournal(src);
    const items = new Map(listOf(doc.items).map((i) => [String(srcOf(i)._id ?? i.id), srcOf(i)]));
    return { src, journal, items };
  }
  function undoStatus(doc) {
    if (!doc) return { available: false };
    const { src, journal, items } = journalState(doc);
    const now = D.now();
    const live = journal.runs.filter((r) => now - (Number(r.at) || 0) <= UNDO_TTL && r.ops.some((e) => !e.undone));
    const run = findRun({ runs: live });
    if (!run) {
      const expired = journal.runs.some((r) => r.ops.some((e) => !e.undone));
      return { available: false, ...(expired ? { expired: true } : {}), runs: [] };
    }
    const runs = live.map((r) => {
      const entries = r.ops.filter((e) => !e.undone);
      return describeRun(r, now, driftOf(entries, items, src));
    }).reverse();
    const drift = driftOf(run.ops.filter((e) => !e.undone), items, src, laterTouches(journal, run));
    return { available: true, runId: run.runId, at: run.at, age: now - (Number(run.at) || 0), drift, clean: !drift.length, changes: drift.length, runs };
  }
  async function undo(doc, runId = null, opts = {}) {
    const g = guard(doc);
    if (g) return g;
    return withLock(doc, () => undoLocked(doc, runId, opts));
  }
  async function undoLocked(doc, runId, { opIds = null, confirmDrift = false } = {}) {
    const { src, journal, items } = journalState(doc);
    const run = findRun(journal, runId);
    const none = (code, text) => ({ ok: false, errors: [msg(code, text)], message: text, runId: runId ?? null });
    if (!run) return none("undo.none", `Nothing to undo on "${doc.name}".`);
    if (D.now() - (Number(run.at) || 0) > UNDO_TTL) return none("undo.expired", `The undo record of "${doc.name}" is older than 24 hours.`);
    const entries = selectEntries(run, opIds);
    if (!entries.length) return none("undo.none", "Those changes are already undone.");
    const drift = driftOf(entries, items, src, laterTouches(journal, run));   // W6-R4: laterRun = changed by a later builder run
    for (const e of entries.filter((x) => x.kind === "world")) {
      const d = typeof D.fromUuid === "function" ? await D.fromUuid(e.uuid) : null;
      if (!d) drift.push({ opId: e.opId, itemId: e.itemId, name: e.name, why: "missing" });
      else if (e.after && fingerprint(srcOf(d)) !== e.after) drift.push({ opId: e.opId, itemId: e.itemId, name: d.name, why: "edited" });
    }
    if (drift.length && confirmDrift !== true) {
      const text = `"${doc.name}" changed after the builder wrote it (${drift.map((d) => `${d.name}: ${d.laterRun ? `${d.why} by a later builder run` : d.why}`).join(", ")}). Confirm to undo anyway.`;
      return { ok: false, needsConfirm: true, drift, errors: [msg("undo.drift", text)], message: text, runId: run.runId };
    }
    try {
      // whole run (or everything left of it) = every item back to its pre-run place; per item = only the restored ones
      const full = !opIds?.length || entries.length === run.ops.filter((e) => !e.undone).length;
      const { skipped } = await revert(doc, entries, { order: Array.isArray(run.order) ? run.order : null, full });
      const fresh = readJournal(srcOf(doc));
      const r = fresh.runs.find((x) => x.runId === run.runId);
      if (r) { const done = new Set(entries.map((e) => `${e.opId}:${e.itemId}:${e.kind}`)); for (const e of r.ops) if (done.has(`${e.opId}:${e.itemId}:${e.kind}`)) e.undone = true; }
      const { journal: pruned } = pruneJournal(fresh, D.now());
      await doc.update({ [JOURNAL_PATH]: pruned });
      const text = `Undone on "${doc.name}": ${entries.length - skipped.length} change(s)${skipped.length ? `, ${skipped.length} skipped (already gone or the id is taken)` : ""}.`;
      return { ok: true, runId: run.runId, errors: [], warnings: skipped.map((e) => msg("undo.skipped", `"${e.name}" was skipped`, { opId: e.opId, itemId: e.itemId })), undone: entries.map((e) => ({ opId: e.opId, itemId: e.itemId, kind: e.kind })), message: text };
    } catch (err) {
      D.log?.error?.("moinens-ai-gen | writer undo failed", err);
      const text = `Undo failed: ${String(err?.message ?? err)}`;
      return { ok: false, errors: [msg("undo.failed", text)], message: text, runId: run.runId };
    }
  }

  return {
    async plan(doc, proposal, opts = {}) { return (await planInternal(doc, proposal, opts)).plan; },
    apply, undo, undoStatus,
    /** internal (tests): resolve + build without guards */
    _planInternal: planInternal
  };
}
