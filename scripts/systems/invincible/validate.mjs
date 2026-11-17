// Invincible validation pipeline (spec 7, 7.4, 7.5, 10.3; task T5) + the model-facing proposal tools (check_proposal,
// submit_proposal) + the pack's `validate` capability group (registry contract, scripts/build/registry.mjs).
//
// Layers (each stops the pipeline when it has errors, and reports ALL errors of that layer):
//   L0 shape        local schema check of the tool input (proposal.mjs checkShape/normalize) + autoFixed (spec 7.3)
//   L1 references   refs exist and have the right kind, levels exist, boosts/limits belong to their power (folder rule),
//                   item ids exist, links resolve after the change, whitelisted fields only (proposal.mjs project)
//   L2 system rules superhero: vendored rules.validate on the PROJECTED actor (spec 7.5.1) under the profile (creation /
//                   in-play); npc: structure only (7.4); items: gear whitelist + numeric ranges + DataModel check (10.3)
//   L3 dry run      stale check against the preview's fingerprints (7.5.5) + the writer's plan(doc, proposal) (T6) when present
//   L4 GM policy    warnings only: rank differs, hand-made items removed, sensitive fields, limit grant heuristic, profile hint
//
// Result (also the tool result the model sees, minus the GM-only fields):
//   { ok, layer, errors:[{ code, path?, opId?, message, hint, suggest? }], warnings:[...], info:[...], autoFixed:[...],
//     budget: { before, after, perOp:[{ opId, points, slots, spent }] } | { kind:"npc"|"item", note } }
// GM-only extras of validate(): normalized, ops (the final op list, replace converted), opInfo, expect, selection, summary.
//
// Profiles (spec 7.5.3, O23): `creation` = the projection must pass rules.validate completely; `in-play` = "no new errors"
// against the baseline (same pipeline on the unchanged actor): budget codes become info (the budget delta), errors already in
// the baseline are tolerated (info), any NEW error blocks. Structural rules (7.5.2) are never relaxed for NEW issues.

import * as rules from "./vendor/chargen/rules.mjs";
import { chargenStateFromActor, readItem, getCatalogLookup } from "./reader.mjs";
import { getCatalog } from "./catalog.mjs";
import {
  PROPOSAL_SCHEMA, PROPOSAL_GUIDE, LEVEL_WORDS, normalize, project, replaceToOps, selectOps, expectFor, checkStale, toPlainActor, asDoc,
  customItemData, levelExists, powerLevel, baseName, noteOf, norm, normBase, hash, stableJson, summarize, getPath, CUSTOM_TYPES
} from "./proposal.mjs";

export const PROFILES = Object.freeze(["creation", "in-play"]);
export const TOOL_NAMES = Object.freeze(["check_proposal", "submit_proposal"]);
/** spec 7.5.2: always hard errors on the projection (new ones never relaxed by in-play) */
export const STRUCTURAL = Object.freeze(new Set([
  "rank.unknown", "state.shape", "powers.none", "slots.min", "sources.none", "power.duplicate", "power.level.invalid", "power.level.monstrous",
  "power.level.massive", "power.level.none", "power.source.missing", "limit.grant.missing", "limit.grant.invalid", "drawbacks.max",
  "talent.duplicate", "drawback.duplicate", "link.power.missing", "link.source.missing", "attr.range"
]));
/** budget arithmetic: info (with the delta) under in-play */
export const BUDGET_CODES = Object.freeze(new Set(["attr.over", "attr.unspent", "budget.range"]));
export const NPC_ATTR = Object.freeze({ min: 0, max: 12 });   // system model range (spec 7.4)
export const GEAR_BONUS = Object.freeze({ min: -10, max: 10 });

/* ================================================================== messages + hints (English; spec 7.2) */
const A = (k) => String(k ?? "").replace(/^attrs\./, "");
const lv = (i) => LEVEL_WORDS[i] ?? String(i);
/** code -> (params, ctx) => { message, hint } ; ctx = { budget (after), rank } */
export const MESSAGES = Object.freeze({
  // L0
  "input.shape": (p) => ({ message: `Input field ${p.path || "(input)"}: expected ${p.expected}.`, hint: "Follow the tool schema exactly; send only the listed fields." }),
  "ops.empty": () => ({ message: "mode \"ops\" needs at least one op.", hint: "Add ops, or use mode \"replace\" with a proposal for a full rebuild." }),
  "ops.tooMany": (p) => ({ message: `Too many ops (max ${p.max}).`, hint: "Use mode \"replace\" for a rebuild, or split the change." }),
  "opId.missing": () => ({ message: "An op has no opId.", hint: "Give every op a short unique opId such as \"a1\"." }),
  "opId.duplicate": (p) => ({ message: `opId "${p.opId}" is used twice.`, hint: "Every op needs its own opId." }),
  "mode.unsupported": (p) => ({ message: `mode "${p.mode}" is not available for ${p.what}.`, hint: p.hint ?? "Use the mode the tool description names for this document." }),
  "target.unsupported": (p) => ({ message: `This document (${p.what}) cannot be built by the AI builder.`, hint: "Supported: superhero and npc actors, gear and vehicleWeapon items." }),
  // L1
  "ref.unknown": (p) => ({ message: `Unknown catalogue ref "${p.ref}".`, hint: "Copy refs exactly from the catalogue or a search_catalog result." }),
  "ref.kind": (p) => ({ message: `Ref "${p.ref}" is a ${p.kind}, which cannot be added as an item here.`, hint: "Only power, boost, limit, powerSource, talent, drawback, gear and vehicleWeapon refs can be added." }),
  "ref.level.none": (p) => ({ message: `${p.name} has no ${p.level} level (highest: ${p.max}).`, hint: `Pick a level up to ${p.max}; get_entries shows the levels.` }),
  "ref.level.conflict": (p) => ({ message: `Ref "${p.ref}" is the ${p.refLevel} level document, but level ${p.level} was asked.`, hint: "For split-level powers use the ref of the level you want (get_entries -> levels), or leave level out." }),
  "ref.power.mismatch": (p) => ({ message: `${p.type} "${p.name}" belongs to the power "${p.power}", not to "${p.target}".`, hint: `Attach it to a ${p.power} power, or search_catalog with forPower for this power's ${p.type}s.` }),
  "link.source.missing": (p) => ({ message: `Power "${p.name}" has no power source on the sheet after the change.`, hint: "Give the power a source: sourceItemId (existing) or sourceOpId (a powerSource you add in the same list)." }),
  "link.power.missing": (p) => ({ message: `${p.type ?? "Boost/limit"} "${p.name}" points at no power present after the change.`, hint: "Name its power with powerItemId or powerOpId, or remove it." }),
  "link.opId.unknown": (p) => ({ message: `opId "${p.ref}" is not an addItem op in this list.`, hint: "Reference only addItem ops of the same submission." }),
  "link.opId.kind": (p) => ({ message: `"${p.ref}" is a ${p.have}, a ${p.want} is needed here.`, hint: `Point at a ${p.want}.` }),
  "item.missing": (p) => ({ message: `Item id "${p.itemId}" is not on this sheet.`, hint: "Use item ids exactly as in the <sheet> block (I <itemId> ...)." }),
  "item.removed": (p) => ({ message: `Item "${p.itemId}" is already removed by op ${p.by}.`, hint: "Do not update or remove an item twice." }),
  "field.forbidden": (p) => ({ message: `Field "${p.field}" cannot be changed on a ${p.type}.`, hint: p.type === "actor" ? "updateActor may set: name, attributes, texts, reputation, resources (karma/health/resolve only when the GM asked)." : "updateItem fields: power level/powerSource/note; boost/limit power; talent/drawback note; gear name/descriptionAppend/gear." }),
  "field.value": (p) => ({ message: `Bad value for ${p.field}: expected ${p.expected}.`, hint: "Fix the value type or range." }),
  "remove.dependants": (p) => ({ message: `Removing "${p.name}" leaves ${p.dtype} "${p.dependant}" without its ${p.dtype === "power" ? "power source" : "power"}.`, hint: "Set cascade: true to remove the dependants too, or re-point them (updateItem) in the same list." }),
  // L2 rules (vendored rules.mjs codes)
  "rank.unknown": (p) => ({ message: `Unknown rank "${p.rank}".`, hint: "Ranks: teen, street, global, cosmic." }),
  "state.shape": (p) => ({ message: `The build has a malformed ${p.field} list.`, hint: "Send lists as arrays." }),
  "role.unknown": (p) => ({ message: `Role "${p.role}" is not one of the book's roles.`, hint: `Roles: ${rules.ROLES.join(", ")}.` }),
  "powers.none": () => ({ message: "A hero needs at least one power.", hint: "Add a power (with its power source)." }),
  "slots.min": (p) => ({ message: `Power slots used: ${p.slots}; at least 1 is needed.`, hint: "Add a power or a level." }),
  "sources.none": () => ({ message: "The hero has powers but no power source.", hint: "Add a powerSource and point the powers at it." }),
  "power.duplicate": (p) => ({ message: `Power "${p.name}" is taken twice.`, hint: "Raise its level instead, or pick another power." }),
  "source.duplicate": (p) => ({ message: `Power source "${p.name}" is taken twice.`, hint: "One copy is enough; point both powers at it." }),
  "power.level.invalid": (p) => ({ message: `Power "${p.name}" has an invalid level (${p.level}).`, hint: "Levels: basic, major, massive, monstrous." }),
  "power.level.monstrous": (p) => ({ message: `Power "${p.name}" is Monstrous; no hero starts with a Monstrous power.`, hint: "Use Major (Massive only at Cosmic Champion)." }),
  "power.level.massive": (p, c) => ({ message: `Power "${p.name}" is Massive; only Cosmic Champions start with Massive powers (rank: ${c.rank}).`, hint: "Lower it to Major, or ask the GM about the rank / the in-play profile." }),
  "power.level.none": (p) => ({ message: `Power "${p.name}" has no level above ${lv(p.max)}.`, hint: `Use at most ${lv(p.max)}.` }),
  "power.source.missing": (p) => ({ message: `Power "${p.name}" names no power source of this hero.`, hint: "Point it at one of the hero's power sources." }),
  "limit.grant.missing": (p) => ({ message: `A limit on "${p.name}" does not say what it pays for.`, hint: "A limit pays for one level or one boost of its power." }),
  "limit.grant.invalid": (p) => ({ message: `"${p.name}" has more limits than levels/boosts they could pay for.`, hint: "Each limit pays for one level above Basic or one boost of that power; remove a limit or add what it pays for." }),
  "source.unused": (p) => ({ message: `Power source "${p.name}" is used by no power.`, hint: "Point a power at it or remove it (an extra source costs 1 point)." }),
  "slots.over": (p) => ({ message: `${p.slots} power slots used, rank gives ${p.max}: costs ${p.cost} attribute points.`, hint: "Fine if intended (2 attribute points per extra slot)." }),
  "drawbacks.max": (p) => ({ message: `${p.count} drawbacks; at most ${p.max}.`, hint: "Remove a drawback." }),
  "talent.hero.missing": () => ({ message: "The hero talent is missing.", hint: "Add a talent (the first talent on the sheet is the hero talent)." }),
  "talent.duplicate": (p) => ({ message: `Talent "${p.name}" is taken more often than allowed.`, hint: "Most talents only once (Windfall any number, Durable/Determined up to 5)." }),
  "drawback.duplicate": (p) => ({ message: `Drawback "${p.name}" is taken twice.`, hint: "Each drawback once (Hard Times may repeat)." }),
  "drawback.hardTimes": () => ({ message: "Hard Times lowers Resources (the pack effect applies -1).", hint: "Nothing to fix." }),
  "drawback.note.missing": (p) => ({ message: `Drawback "${p.name}" needs a choice (${p.kind === "source" ? "a power source" : "defined when taken"}) in its note.`, hint: "Add note: \"...\" (shown in brackets in the name)." }),
  "attr.invalid": (p) => ({ message: `Attribute ${A(p.attr)} is not a whole number.`, hint: "Attributes are integers." }),
  "attr.low": (p) => ({ message: `Attribute ${A(p.attr)} is below ${p.min}.`, hint: `Every attribute is at least ${p.min}.` }),
  "attr.cap": (p) => ({ message: `Attribute ${A(p.attr)} is above the rank cap ${p.cap}.`, hint: `Keep every attribute within 1..${p.cap}.` }),
  "budget.range": (p) => ({ message: `The attribute budget (${p.budget}) cannot be spent within 1..${p.cap} per attribute.`, hint: "Change slots, talents, sources or drawbacks so the budget fits 6..6x cap." }),
  "attr.over": (p) => ({ message: `${p.over} attribute points too many (budget ${p.budget}).`, hint: `Lower attributes by ${p.over} in total, or free points (drop a boost/level, take a drawback).` }),
  "attr.unspent": (p) => ({ message: `${p.left} attribute points are unspent (budget ${p.budget}).`, hint: `Raise attributes by ${p.left} in total, each within 1..cap.` }),
  "occupation.missing": () => ({ message: "The occupation is missing.", hint: "Set texts.occupation (it decides Resources and the occupation talent)." }),
  "talent.occ.missing": () => ({ message: "The occupation talent is missing.", hint: "Add a second talent (the occupation talent)." }),
  "resources.invalid": (p) => ({ message: `Resources ${p.resources} is invalid for a hero with an occupation.`, hint: "Set resources to the occupation's value (at least 1)." }),
  "npc.name.blank": () => ({ message: "The NPC relationship has no name.", hint: "Add \"NPC: Name (type)\" to texts.relationships." }),
  "personality.count": (p) => ({ message: `Personality needs exactly 2 different words (has ${p.count}).`, hint: "texts.personality: \"Word1, Word2\"." }),
  "drive.empty": () => ({ message: "Drive is empty.", hint: "Set texts.drive." }),
  "flaw.empty": () => ({ message: "Flaw is empty.", hint: "Set texts.flaw." }),
  "heroName.empty": () => ({ message: "The hero name is empty.", hint: "Set the actor name." }),
  "civilianName.empty": () => ({ message: "The civilian name is empty.", hint: "Set texts.civilianName." }),
  "team.join.missing": () => ({ message: "The team base to join is missing.", hint: "Name the team in texts.team." }),
  "team.empty": () => ({ message: "No team or team base given.", hint: "Set texts.team / texts.teamBase." }),
  "upgrades.over": (p) => ({ message: `${p.count} team-base upgrades; the rank allows ${p.max}.`, hint: "Remove upgrades from texts.teamBase." }),
  // npc / items
  "attr.range": (p) => ({ message: `Attribute ${A(p.attr)} must be a whole number in ${NPC_ATTR.min}..${NPC_ATTR.max}.`, hint: "NPC attributes have no budget but must stay in range." }),
  "npc.threat": (p) => ({ message: `${p.what} is above what a ${p.rank} hero may start with.`, hint: "Fine for a threat; check it fits the heroes." }),
  "gear.range": (p) => ({ message: `${p.field} must be ${p.expected}.`, hint: "Costs, damage and ranges are whole numbers >= 0." }),
  "gear.minmax": (p) => ({ message: `minRange ${p.min} is above maxRange ${p.max}.`, hint: "Make minRange <= maxRange." }),
  "item.data.invalid": (p) => ({ message: `The item data does not pass the system's data model: ${p.error}`, hint: "Use only the whitelisted fields with plain values." }),
  // L3
  "stale.item": (p) => ({ message: `Item ${p.name ? `"${p.name}" ` : ""}(${p.itemId}) ${p.reason === "missing" ? "no longer exists" : "changed"} since the preview.`, hint: "The sheet changed: re-read it and submit again." }),
  "stale.actor": (p) => ({ message: `Actor field ${p.path} changed since the preview.`, hint: "The sheet changed: re-read it and submit again." }),
  "plan.failed": (p) => ({ message: `The write plan failed: ${p.error}`, hint: "Usually a sheet change; check the <sheet> block and resubmit." }),
  // L4 / info
  "rank.differs": (p) => ({ message: `The proposal's rank (${p.proposed}) differs from the drawer's rank (${p.rank}); validated as ${p.rank}.`, hint: "Ask the GM before changing rank." }),
  "remove.handEdited": (p) => ({ message: `Removes ${p.custom ? "custom" : "hand-edited"} item "${p.name}".`, hint: "The GM sees it in the preview; say why in choiceNotes." }),
  "field.sensitive": (p) => ({ message: `Writes ${p.field}, which is only changed when the GM asked for it.`, hint: "Leave it out unless the GM asked." }),
  "grants.heuristic": (p) => ({ message: `Limit "${p.name}" will be read as paying for a ${p.read} (power level decides), not a ${p.asked}.`, hint: "A limit pays for a level when its power is above Basic, else for a boost." }),
  "profile.suggestInPlay": () => ({ message: "The current sheet already fails the creation rules.", hint: "The GM may switch the drawer to the in-play profile (no new errors)." }),
  "budget.delta": (p) => ({ message: `Under creation rules this change ${p.delta < 0 ? `costs ${-p.delta}` : `frees ${p.delta}`} attribute point(s) (budget ${p.before} -> ${p.after}, spent ${p.spentBefore} -> ${p.spentAfter}).`, hint: "In-play: informational only." }),
  "baseline.tolerated": (p) => ({ message: `Already on the sheet before this change: ${p.issue}.`, hint: "In-play: tolerated; not caused by this proposal." }),
  "catalog.unavailable": (p) => ({ message: `The catalogue could not be read: ${p.error}`, hint: "Tell the GM; the builder needs the invincible-core packs." })
});

/** issue -> model-facing entry { code, path?, opId?, message, hint, suggest? } */
export function describe(issue, ctx = {}) {
  const fn = MESSAGES[issue.code];
  const p = { ...(issue.params ?? {}), path: issue.path };
  const t = fn ? fn(p, ctx) : { message: issue.message ?? issue.code, hint: issue.hint ?? "" };
  const out = { code: issue.code };
  if (issue.path) out.path = issue.path;
  if (issue.opId) out.opId = issue.opId;
  out.message = issue.message ?? t.message;
  out.hint = issue.hint ?? t.hint;
  if (issue.suggest) out.suggest = issue.suggest;
  return out;
}

/* ================================================================== rules on a (projected) actor */
const issue = (code, severity, path, params = {}) => ({ code, severity, path, params });
const sig = (i) => `${i.code}|${norm(i.params?.name ?? i.params?.attr ?? i.path ?? "")}`;

function rankFor(plain, opts) {
  if (rules.isRank(opts.rank)) return opts.rank;
  const f = getPath(plain, "flags.invincible-plus-ultra.chargen.rank");
  return rules.isRank(f) ? f : rules.DEFAULT_RANK;
}
export function stateOf(plain, rank) { return chargenStateFromActor(asDoc(plain), { rank }); }
export function budgetOf(state) {
  const r = rules.rankOf(state);
  return {
    points: rules.budget(state), spent: rules.attrSum(state.attrs), slots: rules.slots(state), rankPowers: r?.powers ?? 0, cap: r?.cap ?? 0,
    drawbacks: rules.drawbackCount(state), extraSources: rules.extraSources(state), extraTalents: rules.extraTalentCount(state)
  };
}
/** catalogue-backed checks shared by both actor kinds: drawback notes (rules.mjs gets no `needs` from the sheet) */
function catalogueIssues(plain, catalog) {
  const out = [];
  for (const it of plain.items) {
    if (it.type !== "drawback") continue;
    const e = catalog?.findByName?.("drawback", baseName(it.name));
    if (e?.needs && !noteOf(it.name)) out.push(issue("drawback.note.missing", "warn", `items.${it._id}`, { name: baseName(it.name), kind: e.needs }));
  }
  return out;
}
/** superhero: vendored rules.validate on the sheet read back as a chargen state (+ limit grant heuristic warnings) */
export function superheroIssues(plain, rank, catalog) {
  const state = stateOf(plain, rank);
  const v = rules.validate(state);
  const out = v.issues.filter((i) => i.code !== "drawback.note.missing").map((i) => issue(i.code, i.severity === "warn" ? "warn" : i.severity, i.path, i.params));
  return { issues: [...out, ...catalogueIssues(plain, catalog)], state };
}
/** npc (spec 7.4): structure only, no budget */
export function npcIssues(plain, rank, catalog) {
  const out = [];
  const r = rules.RANKS[rank] ?? rules.RANKS[rules.DEFAULT_RANK];
  for (const k of rules.ATTRS) {
    const v = getPath(plain, `system.attributes.${k}.value`);
    if (!Number.isInteger(v) || v < NPC_ATTR.min || v > NPC_ATTR.max) out.push(issue("attr.range", "error", `attrs.${k}`, { attr: k }));
    else if (v > r.cap) out.push(issue("npc.threat", "info", `attrs.${k}`, { what: `${k} ${v}`, rank, attr: k }));
  }
  const talents = [], drawbacks = [];
  for (const it of plain.items) {
    if (it.type === "power") {
      const level = powerLevel(it.system);
      const e = catalog?.findByName?.("power", baseName(it.name));
      if (e && !levelExists(e, level)) out.push(issue("power.level.none", "error", `items.${it._id}`, { name: baseName(it.name), max: Math.max(0, ...LEVEL_WORDS.map((w, k) => (levelExists(e, w) ? k : 0))) }));
      else if (LEVEL_WORDS.indexOf(level) > rules.levelCap(rank)) out.push(issue("npc.threat", "info", `items.${it._id}`, { what: `${baseName(it.name)} at ${level}`, rank, name: baseName(it.name) }));
    }
    if (it.type === "talent") talents.push(it.name);
    if (it.type === "drawback") drawbacks.push(baseName(it.name));
  }
  const over = (list, keyFn, limitFn) => {
    const count = new Map(), hit = new Set();
    for (const n of list) { const k = keyFn(n); const c = (count.get(k) ?? 0) + 1; count.set(k, c); if (c > limitFn(n)) hit.add(n); }
    return [...hit];
  };
  for (const t of over(talents, rules.talentKey, rules.talentLimit)) out.push(issue("talent.duplicate", "error", "talents", { name: t }));
  for (const d of over(drawbacks, norm, rules.drawbackLimit)) out.push(issue("drawback.duplicate", "error", "drawbacks", { name: d }));
  return { issues: [...out, ...catalogueIssues(plain, catalog)], state: null };
}

/* ================================================================== item checks (spec 10.3) */
function gearIssues(g, path, opId) {
  const out = [];
  const nonNeg = (k, v) => { if (v !== undefined && (!Number.isInteger(v) || v < 0)) out.push({ code: "gear.range", path: `${path}.${k}`, opId, params: { field: k, expected: "a whole number >= 0" } }); };
  nonNeg("cost", g?.cost);
  const a = g?.attack;
  if (a) {
    nonNeg("damage", a.damage); nonNeg("minRange", a.minRange); nonNeg("maxRange", a.maxRange);
    if (a.bonus !== undefined && (!Number.isInteger(a.bonus) || a.bonus < GEAR_BONUS.min || a.bonus > GEAR_BONUS.max)) out.push({ code: "gear.range", path: `${path}.attack.bonus`, opId, params: { field: "bonus", expected: `a whole number in ${GEAR_BONUS.min}..${GEAR_BONUS.max}` } });
    if (Number.isInteger(a.minRange) && Number.isInteger(a.maxRange) && a.minRange > a.maxRange) out.push({ code: "gear.minmax", path: `${path}.attack`, opId, params: { min: a.minRange, max: a.maxRange } });
  }
  return out;
}
/**
 * Foundry DataModel check of final item data (runtime only; spec 7.1 L2). Constructs a throwaway, unsaved Item and lets the
 * system's schema validate it. [A] v14: the Document constructor validates (strict) and throws on invalid data.
 * -> error text | null. Returns null outside Foundry.
 */
export function foundryItemCheck(data) {
  const cls = globalThis.CONFIG?.Item?.documentClass;
  if (typeof cls !== "function") return null;
  try {
    const doc = new cls(JSON.parse(JSON.stringify(data)), { strict: true });
    if (typeof doc.validate === "function") doc.validate({ strict: true });
    return null;
  } catch (e) { return String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300); }
}

/* ================================================================== the pipeline */
const docKind = (doc, target) => {
  if (target === "newItem") return { kind: "item", type: null };
  const name = doc?.documentName ?? doc?.constructor?.documentName ?? (doc?.type && doc?.items ? "Actor" : null);
  if (name === "Actor" && (doc.type === "superhero" || doc.type === "npc")) return { kind: "actor", type: doc.type };
  if (name === "Item" && CUSTOM_TYPES.includes(doc.type)) return { kind: "item", type: doc.type };
  return { kind: null, type: doc?.type ?? null, name };
};
const planGuard = new Map();   // doc uuid -> depth (a writer plan that calls validate again never recurses into plan)

/**
 * validateProposal(doc, input, opts) -> result (see header).
 * opts: { catalog (object | () => Promise), lookup (reader lookup | Promise), profile, rank, deselect:[opId] | only:[opId], expect,
 *         plan: (doc, proposal, { dryRun }) => Plan  |  a Plan object already computed (joined, never called back)  | null,
 *         skipPlan, allowVitals (GM asked for karma/health/resolve: no field.sensitive warning), requireRationale,
 *         itemCheck (data) => string|null }
 */
export async function validateProposal(doc, input, opts = {}) {
  const profile = PROFILES.includes(opts.profile) ? opts.profile : "creation";
  const res = { ok: false, layer: "L0", profile, errors: [], warnings: [], info: [], autoFixed: [], budget: null };
  const finish = (layer, raw, ctx = {}) => {
    res.layer = layer;
    res.errors = raw.errors.map((i) => describe(i, ctx));
    res.warnings = raw.warnings.map((i) => describe(i, ctx));
    res.info = raw.info.map((i) => describe(i, ctx));
    res.ok = res.errors.length === 0;
    return res;
  };
  const acc = { errors: [], warnings: [], info: [] };

  // ---- L0
  const n = normalize(input, { requireRationale: !!opts.requireRationale });
  res.autoFixed = n.autoFixed;
  acc.errors.push(...n.errors);
  const P = n.proposal;
  const dk = docKind(doc, P?.target);
  if (P && !dk.kind) acc.errors.push({ code: "target.unsupported", path: "target", params: { what: `${dk.name ?? "document"} ${dk.type ?? ""}`.trim() } });
  if (P && dk.kind === "item" && P.mode !== "replace") acc.errors.push({ code: "mode.unsupported", path: "mode", params: { mode: P.mode, what: "an item", hint: "Use mode \"replace\" with proposal.item." } });
  if (P && dk.kind === "item" && P.mode === "replace" && !P.proposal?.item) acc.errors.push({ code: "input.shape", path: "proposal.item", params: { expected: "required for an item" } });
  if (P && dk.kind === "actor" && P.mode === "replace" && P.proposal?.item) acc.errors.push({ code: "mode.unsupported", path: "proposal.item", params: { mode: "replace (item)", what: "an actor", hint: "Add gear to an actor with an addItem op (ref or custom)." } });
  res.normalized = P;
  if (acc.errors.length) return finish("L0", acc);

  // ---- catalogue
  let catalog;
  try { catalog = typeof opts.catalog === "function" ? await opts.catalog() : opts.catalog ?? await getCatalog(); }
  catch (e) { acc.errors.push({ code: "catalog.unavailable", params: { error: String(e?.message ?? e).slice(0, 200) } }); return finish("L1", acc); }

  if (dk.kind === "item") return validateItem(doc, P, dk, catalog, opts, res, acc, finish);
  return validateActor(doc, P, dk, catalog, profile, opts, res, acc, finish);
}

async function validateItem(doc, P, dk, catalog, opts, res, acc, finish) {
  const item = P.proposal.item;
  res.budget = { kind: "item", note: "items have no point budget" };
  if (dk.type && item.type !== dk.type) acc.errors.push({ code: "field.value", path: "proposal.item.type", params: { field: "type", expected: `"${dk.type}" (the document's type)` } });
  const extra = Object.keys(P.proposal).filter((k) => k !== "item");
  for (const k of extra) acc.errors.push({ code: "input.shape", path: `proposal.${k}`, params: { expected: "not used for an item" } });
  if (item.baseRef) {
    const e = catalog.get(item.baseRef);
    if (!e) acc.errors.push({ code: "ref.unknown", path: "proposal.item.baseRef", params: { ref: item.baseRef } });
    else if (!CUSTOM_TYPES.includes(e.kind)) acc.errors.push({ code: "ref.kind", path: "proposal.item.baseRef", params: { ref: item.baseRef, kind: e.kind } });
  }
  if (!item.name) acc.errors.push({ code: "field.value", path: "proposal.item.name", params: { field: "name", expected: "a non-empty name" } });
  if (acc.errors.length) return finish("L1", acc);
  acc.errors.push(...gearIssues(item, "proposal.item"));
  const { data, stripped } = customItemData(item);
  if (!acc.errors.length) {
    const err = (opts.itemCheck ?? foundryItemCheck)(data);
    if (err) acc.errors.push({ code: "item.data.invalid", path: "proposal.item", params: { error: err } });
  }
  res.itemData = data; res.stripped = stripped;
  if (acc.errors.length) return finish("L2", acc);
  res.summary = `${P.target === "newItem" ? "new" : "update"} ${data.type} "${data.name}" cost ${data.system.cost}${Object.keys(data.system.automations).length ? " with attack" : ""}`;
  res.ops = [];
  return finish("L4", acc);
}

async function validateActor(doc, P, dk, catalog, profile, opts, res, acc, finish) {
  const basePlain = toPlainActor(doc);
  const rank = rankFor(basePlain, opts);
  const isHero = dk.type === "superhero";
  const issuesOf = (plain) => (isHero ? superheroIssues(plain, rank, catalog) : npcIssues(plain, rank, catalog));

  // baseline (spec 7.5.3: the same pipeline on the unchanged actor)
  const base = project(null, [], { catalog, plain: basePlain });
  const baseRules = issuesOf(base.actor);
  const baseIssues = [...base.errors.map((e) => ({ ...e, severity: "error" })), ...baseRules.issues];
  const baseErrors = baseIssues.filter((i) => i.severity === "error");
  const before = isHero ? budgetOf(baseRules.state) : null;
  res.budget = isHero ? { before } : { kind: "npc", note: "NPCs have no point budget (free-form creation)" };
  // O23: the drawer suggests in-play when the CURRENT hero already fails the creation rules (an edit, not a rebuild)
  if (profile === "creation" && isHero && P.mode === "ops" && baseErrors.length) acc.info.push({ code: "profile.suggestInPlay", params: {} });

  // ops (replace -> ops)
  let ops = P.ops ?? [];
  if (P.mode === "replace") {
    const conv = replaceToOps(null, P.proposal, { catalog, plain: basePlain });
    acc.errors.push(...conv.errors);
    ops = conv.ops;
    if (P.proposal.rank && P.proposal.rank !== rank) acc.warnings.push({ code: "rank.differs", path: "proposal.rank", params: { proposed: P.proposal.rank, rank } });
  }
  // GM deselection (spec 7.5.6): deselect = unticked opIds, or only = the ticked ones (the writer's T6 option name)
  const deselect = Array.isArray(opts.only) ? ops.map((o) => o.opId).filter((id) => !opts.only.includes(id)) : opts.deselect;
  if (deselect?.length) {
    const sel = selectOps(ops, deselect);
    res.selection = { deselected: sel.deselected, withThem: sel.withThem };
    ops = sel.ops;
  }
  res.ops = ops;
  if (acc.errors.length) return finish("L1", acc, { rank });

  // ---- L1 (projection)
  const proj = project(null, ops, { catalog, plain: basePlain });
  res.opInfo = proj.opInfo;
  const newLinkErrors = proj.errors.filter((e) => !e.params?.preexisting);
  acc.errors.push(...newLinkErrors);
  // custom / gear numbers (L1-level shape of the whitelisted gear fields)
  ops.forEach((op, i) => {
    if (op.op === "addItem" && op.custom) acc.errors.push(...gearIssues(op.custom, `ops[${i}].custom`, op.opId));
    if (op.op === "updateItem" && op.set?.gear) acc.errors.push(...gearIssues(op.set.gear, `ops[${i}].set.gear`, op.opId));
  });
  if (acc.errors.length) return finish("L1", acc, { rank });

  // ---- L2 (rules on the projection, under the profile)
  const after = issuesOf(proj.actor);
  const projIssues = [...proj.errors.filter((e) => e.params?.preexisting).map((e) => ({ ...e, severity: "error" })), ...after.issues];
  const baseSigs = new Set(baseErrors.map(sig));
  const baseWarnSigs = new Set(baseIssues.filter((i) => i.severity === "warn").map(sig));
  const blame = opBlame(ops, proj);
  for (const i of projIssues) {
    const e = { ...i, opId: i.opId ?? blame(i) };
    if (i.severity === "error") {
      if (profile === "in-play" && BUDGET_CODES.has(i.code)) continue;            // reported as budget.delta below
      if (profile === "in-play" && baseSigs.has(sig(i))) { acc.info.push({ code: "baseline.tolerated", path: i.path, params: { issue: describe(i, { rank }).message } }); continue; }
      acc.errors.push(e);
    } else if (i.severity === "warn") { if (!baseWarnSigs.has(sig(i))) acc.warnings.push(e); }
    else acc.info.push(e);
  }
  // item data of AI-defined items (DataModel; runtime only)
  const itemCheck = opts.itemCheck ?? foundryItemCheck;
  ops.forEach((op, i) => {
    if (op.op !== "addItem" || !op.custom) return;
    const err = itemCheck(customItemData(op.custom, { seed: op.opId }).data);
    if (err) acc.errors.push({ code: "item.data.invalid", path: `ops[${i}].custom`, opId: op.opId, params: { error: err } });
  });
  // budget after + per-op cost (spec 7.5.4)
  if (isHero) {
    const afterB = budgetOf(after.state);
    res.budget = { before, after: afterB, perOp: perOpCost(basePlain, ops, catalog, rank, before) };
    if (profile === "in-play" && (afterB.points !== before.points || afterB.spent !== before.spent)) {
      acc.info.push({ code: "budget.delta", path: "attrs", params: { delta: (afterB.points - afterB.spent) - (before.points - before.spent), before: before.points, after: afterB.points, spentBefore: before.spent, spentAfter: afterB.spent } });
    }
    // self-repair hint (spec 7.3): a reconciled attribute vector for attr.over / attr.unspent
    for (const e of acc.errors) {
      if (e.code !== "attr.over" && e.code !== "attr.unspent") continue;
      const r = rules.reconcileAttributes(after.state.attrs, afterB.points, afterB.cap);
      if (r.ok) e.suggest = { updateActor: { attributes: r.attrs } };
    }
  }
  if (acc.errors.length) return finish("L2", acc, { rank });

  // ---- L3 stale check + writer dry run
  if (opts.expect) {
    for (const s of checkStale(doc, ops, opts.expect)) {
      acc.errors.push(s.itemId
        ? { code: "stale.item", path: s.itemId, opId: s.opId ?? undefined, params: { itemId: s.itemId, name: s.name, reason: s.reason } }
        : { code: "stale.actor", path: s.path, opId: s.opId ?? undefined, params: { path: s.path } });
    }
    if (acc.errors.length) return finish("L3", acc, { rank });
  }
  const uuid = String(doc?.uuid ?? basePlain._id ?? "?");
  // a Plan the writer already computed (T6 apply passes { plan: <Plan> }): join it, never call back
  if (opts.plan && typeof opts.plan === "object") {
    for (const e of opts.plan.errors ?? []) acc.errors.push(planIssue(e));
    for (const w of opts.plan.warnings ?? []) acc.warnings.push(planIssue(w));
    if (acc.errors.length) return finish("L3", acc, { rank });
  } else if (typeof opts.plan === "function" && !opts.skipPlan && !planGuard.get(uuid)) {
    planGuard.set(uuid, (planGuard.get(uuid) ?? 0) + 1);
    try {
      const plan = await opts.plan(doc, { target: P.target, mode: "ops", ops, rationale: P.rationale ?? "", choiceNotes: P.choiceNotes ?? [], ...(P.mode === "replace" ? { from: "replace" } : {}) }, { dryRun: true, fromValidate: true });
      for (const e of plan?.errors ?? []) acc.errors.push(planIssue(e));
      for (const w of plan?.warnings ?? []) acc.warnings.push(planIssue(w));
      res.plan = plan ?? null;
    } catch (e) {
      acc.errors.push({ code: "plan.failed", params: { error: String(e?.message ?? e).slice(0, 200) } });
    } finally {
      const d = (planGuard.get(uuid) ?? 1) - 1;
      if (d > 0) planGuard.set(uuid, d); else planGuard.delete(uuid);
    }
    if (acc.errors.length) return finish("L3", acc, { rank });
  }

  // ---- L4 GM policy (warnings only)
  const lookup = await resolveLookup(opts.lookup);
  const byId = new Map(basePlain.items.map((x) => [x._id, x]));
  for (const info of Object.values(proj.opInfo)) {
    const gone = info.kind === "remove" ? [{ itemId: info.itemId }, ...info.cascade] : info.cascade ?? [];
    for (const g of gone) {
      const src = byId.get(g.itemId);
      if (!src) continue;
      const row = readItem(src, { lookup, byId });
      if (!row.ref || row.edited) acc.warnings.push({ code: "remove.handEdited", path: `items.${g.itemId}`, opId: opIdOf(proj, info), params: { name: src.name, custom: !row.ref } });
    }
    if (!opts.allowVitals) for (const c of info.changed ?? []) if (/karma|derived\.\w+\.value/.test(c.path ?? "")) acc.warnings.push({ code: "field.sensitive", path: c.path, opId: opIdOf(proj, info), params: { field: c.path.replace(/^system\./, "") } });
  }
  for (const it of proj.actor.items) {
    if (it.type !== "limit" || !it.system?._grants) continue;
    const pw = proj.actor.items.find((x) => x._id === it.system.power);
    const read = pw && LEVEL_WORDS.indexOf(powerLevel(pw.system)) > 0 ? "level" : "boost";
    if (read !== it.system._grants) acc.warnings.push({ code: "grants.heuristic", opId: String(it._id).replace(/^new:/, ""), params: { name: it.name, read, asked: it.system._grants } });
  }

  res.expect = expectFor(doc ?? asDoc(basePlain), ops, proj);
  res.summary = [...summarize({ ops }, proj, res.budget), ...(isHero && res.budget.after ? [`budget ${res.budget.after.points} spent ${res.budget.after.spent} slots ${res.budget.after.slots}/${res.budget.after.rankPowers}`] : [])].join("\n");
  return finish("L4", acc, { rank });
}
const opIdOf = (proj, info) => Object.entries(proj.opInfo).find(([, v]) => v === info)?.[0];
const planIssue = (e) => (typeof e === "string" ? { code: "plan.error", message: e, hint: "Check the sheet and resubmit." } : { code: String(e?.code ?? "plan.error"), path: e?.path, opId: e?.opId, params: e?.params ?? {}, ...(MESSAGES[e?.code] ? {} : { message: String(e?.message ?? e?.code ?? "plan error"), hint: String(e?.hint ?? "Check the sheet and resubmit.") }) });
async function resolveLookup(l) {
  try { return l ? await (typeof l === "function" ? l() : l) : null; } catch { return null; }
}

/** rules issue -> the op that caused it (by item name, or the updateActor op for attribute / text codes) */
function opBlame(ops, proj) {
  const byName = new Map();
  for (const [opId, info] of Object.entries(proj.opInfo)) if (info.name) byName.set(normBase(info.name), opId);
  const actorOp = ops.find((o) => o.op === "updateActor")?.opId;
  return (i) => {
    const n = i.params?.name;
    if (n && byName.has(normBase(n))) return byName.get(normBase(n));
    if (/^(attr|personality|drive|flaw|heroName|civilianName|occupation|resources)/.test(i.code) && actorOp) return actorOp;
    return undefined;
  };
}

/** per-op cost: cumulative projections, each op's delta of budget points, slots and spent points */
export function perOpCost(basePlain, ops, catalog, rank, before) {
  const out = [];
  let prev = before;
  for (let k = 0; k < ops.length; k++) {
    const p = project(null, ops.slice(0, k + 1), { catalog, plain: basePlain });
    const b = budgetOf(stateOf(p.actor, rank));
    out.push({ opId: ops[k].opId, points: b.points - prev.points, slots: b.slots - prev.slots, spent: b.spent - prev.spent });
    prev = b;
  }
  return out;
}

/* ================================================================== model-facing tools */
const TOOL_DESC = {
  check_proposal: "Dry-run a proposal (same input and rules as submit_proposal) without making it the pending proposal: returns errors with hints, warnings, the budget before/after and each op's cost. Not needed before a submit (submit_proposal returns the same errors). Use it only to compare variants or to price a change you may not propose (\"what would Flight at Major cost?\").",
  submit_proposal: "Submit the proposal for the GM; send it directly, without a check_proposal first. It is validated (references, the system's rules on the sheet as it would be after the change, a dry run of the write); errors come back with hints and the budget so you can fix and resubmit. On ok:true the GM sees a preview and decides; end your turn then. mode \"ops\" for an existing sheet (each op has its own opId; everything not named stays), mode \"replace\" only for a blank actor or an explicit rebuild. Nothing is written until the GM clicks Apply.\n" + PROPOSAL_GUIDE
};
export function proposalToolDefs() {
  return TOOL_NAMES.map((name) => ({ name, description: TOOL_DESC[name], input_schema: PROPOSAL_SCHEMA, strict: true }));
}
/** compact model-facing result (GM-only fields dropped) */
export function toolResult(name, r, doc) {
  const out = { ok: r.ok };
  if (r.ok && name === "submit_proposal") {
    out.proposalId = `prop-${hash(`${doc?.uuid ?? ""}|${stableJson(r.normalized)}`)}`;
    out.summary = r.summary ?? "";
  }
  if (r.errors.length) out.errors = r.errors;
  out.warnings = r.warnings;
  if (r.info.length) out.info = r.info;
  if (r.autoFixed.length) out.autoFixed = r.autoFixed;
  out.budget = r.budget;
  if (!r.ok) out.layer = r.layer;
  if (r.ok && name === "check_proposal") out.summary = r.summary ?? "";
  return out;
}

/* ================================================================== the pack's validate group */
/**
 * validateGroup(getPack, deps) -> { validate, proposalTools, runProposalTool }
 *   deps: { catalog?, source?, lookup?, game?, itemCheck? } (tests inject; runtime uses the T4 catalogue and the T12 lookup)
 *   validate(doc, proposal, { profile, rank, deselect, expect, skipPlan }) -> full result (GM side: drawer preview, T6 apply)
 *   runProposalTool(name, input, ctx) -> model-facing result; ctx = { doc, options: { rank, profile } }
 */
export function validateGroup(getPack, deps = {}) {
  const catalog = () => (deps.catalog ? deps.catalog : getCatalog(deps.source ?? null));
  const lookup = () => deps.lookup ?? getCatalogLookup(deps.game ?? globalThis.game);
  const plan = () => { const p = getPack?.(); return typeof p?.plan === "function" ? (doc, prop, o) => p.plan(doc, prop, o) : null; };
  const run = (doc, input, o = {}) => validateProposal(doc, input, { catalog, lookup, plan: o.plan === undefined ? plan() : o.plan, itemCheck: deps.itemCheck, ...o });
  return {
    validate: (doc, proposal, o = {}) => run(doc, proposal, o),
    proposalTools: () => proposalToolDefs(),
    async runProposalTool(name, input, ctx = {}) {
      if (!TOOL_NAMES.includes(name)) return { ok: false, errors: [{ code: "tool.unknown", message: `Unknown tool "${name}".`, hint: "" }] };
      const o = ctx.options ?? {};
      const r = await run(ctx.doc, input, { profile: o.profile, rank: o.rank, requireRationale: name === "submit_proposal" });
      return toolResult(name, r, ctx.doc);
    }
  };
}
