// Invincible validation pipeline (spec 7, 7.4, 7.5, 10.3; task T5) + the model-facing proposal tool (submit_proposal; its
// `dryRun` flag is the old check_proposal, D-9) + the pack's `validate` capability group (registry contract, scripts/build/registry.mjs).
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
//     budget: { before, after, note, perOp:[{ opId, points, slots, label?, spentAfter? }] } | { kind:"npc"|"item", note } }
//   (W2-5: perOp points/slots = the change that op makes; spentAfter = the attribute sum after an op that changed it.)
// Issues may carry `gm` (GM-only text, e.g. the book's Hard Times number); toolResult drops it from the model's copy.
// GM-only extras of validate(): normalized, ops (the final op list, replace converted), opInfo, expect, selection, summary.
//
// Profiles (spec 7.5.3, O23): `creation` = the projection must pass rules.validate completely; `in-play` = "no new errors"
// against the baseline (same pipeline on the unchanged actor): budget codes become info (the budget delta), errors already in
// the baseline are tolerated (info), any NEW error blocks. Structural rules (7.5.2) are never relaxed for NEW issues.

import * as rules from "./vendor/chargen/rules.mjs";
import { chargenStateFromActor, readItem, getCatalogLookup, talentRoleShifts, talentRolesOf, talentRoles } from "./reader.mjs";
import { movePlan } from "./undo.mjs";
import { talentOrderOf } from "./writer.mjs";
import { getCatalog, slug, effectsOf, placeholderKeys } from "./catalog.mjs";
import {
  PROPOSAL_SCHEMA, PROPOSAL_GUIDE, LEVEL_WORDS, normalize, project, replaceToOps, selectOps, expectFor, checkStale, toPlainActor, asDoc,
  customItemData, levelExists, powerLevel, baseName, noteOf, norm, normBase, hash, stableJson, summarize, getPath, CUSTOM_TYPES, resolveRank, NEW_PREFIX,
  attributeFromNote, fillAttributeKey, onlyAttributePlaceholders
} from "./proposal.mjs";

export const PROFILES = Object.freeze(["creation", "in-play"]);
/** names runProposalTool accepts: check_proposal stays as an internal alias of submit_proposal + dryRun (D-9: not in the tool list) */
export const TOOL_NAMES = Object.freeze(["check_proposal", "submit_proposal"]);
/** the tools the model sees (W3-14 / D-9: one tool; -6.4k chars of cached prefix) */
export const MODEL_TOOL_NAMES = Object.freeze(["submit_proposal"]);
/** spec 7.5.2: always hard errors on the projection (new ones never relaxed by in-play) */
export const STRUCTURAL = Object.freeze(new Set([
  "rank.unknown", "state.shape", "powers.none", "slots.min", "sources.none", "power.duplicate", "power.level.invalid", "power.level.monstrous",
  "power.level.massive", "power.level.none", "power.source.missing", "limit.grant.missing", "limit.grant.invalid", "drawbacks.max",
  "talent.duplicate", "drawback.duplicate", "link.power.missing", "link.source.missing", "attr.range"
]));
/** vendored warnings the validator reports as info (W4-A-1: an empty team = a solo hero, D-16) */
export const QUIET_CODES = Object.freeze(new Set(["team.empty"]));
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
  "ref.level.conflict": (p) => ({ message: `Ref "${p.ref}" is the ${p.refLevel} level document, but level ${p.level} was asked.`, hint: `Use the power's main ref${p.mainRef ? ` "${p.mainRef}"` : ""} with level ${p.level}, or the ${p.level} level's own ref (get_entries -> levels) with level left out.` }),
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
  "power.level.massive": (p, c) => ({ message: `Power "${p.name}" is Massive; only Cosmic Champions start with Massive powers (rank: ${c.rank}).`, hint: "Lower it to Major; Massive needs the cosmic rank, which only the GM sets in the drawer (the in-play profile does not allow it either)." }),
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
  // W2-5 / D-3 provisional: the model sees only the stored and effective values (the -1 the system applies); the book's -2 is a
  // GM-only remark (`gm`), so the model is not tempted to write the lowered number
  "drawback.hardTimes": (p) => (Number.isInteger(p.stored)
    ? { message: `Hard Times: Resources stays stored at ${p.stored} (the occupation's value); each Hard Times lowers it by 1 through its effect, so the sheet shows ${p.effective}.`, hint: "Nothing to fix: write resources = the occupation's value, never the lowered number.", gm: `The book text says -2 per Hard Times (Resources would be ${p.book}); the builder follows the system's effect (-1), owner decision D-3.` }
    : { message: "Hard Times lowers Resources by 1 through its effect.", hint: "Nothing to fix.", gm: "The book text says -2 per Hard Times; the builder follows the system's effect (-1), owner decision D-3." }),
  "drawback.note.missing": (p) => ({ message: `Drawback "${p.name}" needs a choice (${p.kind === "source" ? "a power source" : "defined when taken"}) in its note.`, hint: "Add note: \"...\" (shown in brackets in the name)." }),
  "attr.invalid": (p) => ({ message: `Attribute ${A(p.attr)} is not a whole number.`, hint: "Attributes are integers." }),
  "attr.low": (p) => ({ message: `Attribute ${A(p.attr)} is below ${p.min}.`, hint: `Every attribute is at least ${p.min}.` }),
  // W3-11 (finding 7, D-14): the cap stays hard in-play; say so and who can change it
  "attr.cap": (p) => ({ message: `Attribute ${A(p.attr)} is above the rank cap ${p.cap}.`, hint: p.inPlay
    ? `The rank cap applies in-play too: keep every attribute within 1..${p.cap}. If the GM wants a higher value, ask them to change the rank in the drawer.`
    : `Keep every attribute within 1..${p.cap}.` }),
  "budget.range": (p) => ({ message: `The attribute budget (${p.budget}) cannot be spent within 1..${p.cap} per attribute.`, hint: "Change slots, talents, sources or drawbacks so the budget fits 6..6x cap." }),
  "attr.over": (p) => ({ message: `${p.over} attribute points too many (budget ${p.budget}).`, hint: `Lower attributes by ${p.over} in total, or free points (drop a boost/level, take a drawback).` }),
  "attr.unspent": (p) => ({ message: `${p.left} attribute points are unspent (budget ${p.budget}).`, hint: `Raise attributes by ${p.left} in total, each within 1..cap.` }),
  "occupation.missing": () => ({ message: "The occupation is missing.", hint: "Set texts.occupation (it decides Resources and the occupation talent)." }),
  // W4-A-5: say what to do when the GM asked to remove it (the rules need one in BOTH profiles: in-play blocks it too, a NEW error)
  "talent.occ.missing": (p) => ({ message: `The occupation talent (the second talent${p.occupation ? `, from the ${p.occupation} list` : ""}) is missing; the rules need one in every profile.`,
    hint: `Keep two talents: ${p.list ? `replace the occupation talent with another one from the ${p.occupation} list (${p.list})` : "add an occupation talent from the occupation's list as the second talent"} instead of removing it. If the GM wants it gone anyway, do not submit the removal: say in one sentence that the rules need an occupation talent and the GM can remove it by hand on the sheet.` }),
  "resources.invalid": (p) => ({ message: `Resources ${p.resources} is invalid for a hero with an occupation.`, hint: "Set resources to the occupation's value (at least 1)." }),
  // W3-7 (finding 8, D-15 provisional): an empty relationships text is "no NPC relationship written", not "a nameless NPC"
  "npc.name.blank": (p) => (p.line
    ? { message: "The NPC relationship line has no name.", hint: "Write the NPC's name in it: \"NPC: Name (type)\" in texts.relationships." }
    : { message: "No NPC relationship is written (texts.relationships has no \"NPC: Name (type)\" line).", hint: "At a build, invent one original NPC and write \"NPC: Name (type)\" in texts.relationships." }),
  // creation-profile checks of the life step (P1-F; warnings, owner decision D-4 provisional)
  "occupation.unknown": (p) => ({ message: p.name ? `Occupation "${p.occupation}" is written as a ref or slug; the sheet stores the occupation's name ("${p.name}").` : `Occupation "${p.occupation}" is not in the catalogue; its Resources and occupation talent cannot be checked.`, hint: p.name ? `Set texts.occupation to "${p.name}".` : "Use an occupation name from the catalogue index (English, exactly as listed), or keep an own occupation if the GM wants one." }),
  "resources.occupation": (p) => ({ message: `Resources ${p.resources} differ from the occupation's value (${p.occupation}: ${p.value}).`, hint: `Set resources to ${p.value}; talents and drawbacks change Resources through their effects, not the stored value.` }),
  "talent.occ.list": (p) => ({ message: `The occupation talent "${p.name}" (the second talent) is not on the ${p.occupation} list (${p.list}).`, hint: "Order talents hero talent, occupation talent, extras; pick the occupation talent from that list." }),
  "reputation.rank": (p) => ({ message: `Reputation ${p.reputation} differs from the ${p.rank} rank's starting value (${p.value}).`, hint: `Set reputation to ${p.value}.` }),
  "reputation.defaulted": (p) => ({ message: `No reputation given: the ${p.rank} rank's value ${p.value} is written.`, hint: "Give reputation explicitly to choose another value." }),
  "personality.count": (p) => ({ message: `Personality needs exactly 2 different words (has ${p.count}).`, hint: "texts.personality: \"Word1, Word2\"." }),
  "drive.empty": () => ({ message: "Drive is empty.", hint: "Set texts.drive." }),
  "flaw.empty": () => ({ message: "Flaw is empty.", hint: "Set texts.flaw." }),
  "heroName.empty": () => ({ message: "The hero name is empty.", hint: "Set the actor name." }),
  "civilianName.empty": () => ({ message: "The civilian name is empty.", hint: "Set texts.civilianName." }),
  "team.join.missing": () => ({ message: "The team base to join is missing.", hint: "Name the team in texts.team." }),
  // W4-A-1 (D-16): an empty team is a solo hero, not a defect: quiet info (validator; the vendored rules keep their warning)
  "team.empty": () => ({ message: "No team and no team base: a solo hero.", hint: "Nothing to fix (a solo hero keeps team and teamBase empty)." }),
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
  "rank.differs": (p) => ({ message: `The proposal's rank (${p.proposed}) differs from the drawer's rank (${p.rank}); validated as ${p.rank}, so budget numbers and fixes here are for ${p.rank}.`, hint: "Ask the GM to set the rank in the drawer; do not rebalance for the other rank." }),
  // W3-7 (finding 6): the hint read like an order to ask the GM
  "rank.defaulted": (p) => ({ message: `No rank chosen (drawer or plus-ultra flag): validated as ${p.rank} (the default).`, hint: "Nothing to do unless the GM's message names another rank; then ask them to set it in the drawer." }),
  "note.cut": (p) => ({ message: `A note is longer than ${p.max} characters (${p.length}); it is cut to "${p.kept}".`, hint: `Keep notes short (at most ${p.max} characters).` }),
  "remove.handEdited": (p) => ({ message: `Removes ${p.custom ? "custom" : "hand-edited"} item "${p.name}".`, hint: "The GM sees it in the preview; say why in choiceNotes." }),
  "field.sensitive": (p) => ({ message: `Writes ${p.field}, which is only changed when the GM asked for it.`, hint: "Leave it out unless the GM asked." }),
  "gear.cost": (p) => ({ message: `Gear "${p.name}" cost ${p.cost} at Resources ${p.resources}.`, hint: "Information only; the GM decides what the hero can afford." }),
  // W3-9 (finding 3; D-13 undecided, so no writer substitution): the model names the choice in the note, the GM edits the effect
  // W4-A-4 (D-13 provisional): the writer fills "[attribute]" from the note of an ADDED item; this warning stays when it cannot
  "effect.placeholder": (p) => ({ message: `${p.type ? `${p.type[0].toUpperCase()}${p.type.slice(1)} ` : ""}"${p.name}" has an effect with a choice left open (${(p.keys ?? []).join(", ")}).`,
    hint: p.attrOnly && p.isNew && p.canNote
      ? (p.noted ? "The note names no single attribute, so the effect stays open: write one attribute in the note (Fighting, Agility, Strength, Reason, Intuition or Presence; the GM's language is fine) and the builder sets the effect." : "Write the attribute in the item's note (Fighting, Agility, Strength, Reason, Intuition or Presence; the GM's language is fine); the builder then sets the effect.")
      : p.noted ? "Nothing to fix: the note names the choice; the GM sets the effect." : p.canNote ? "Write the choice (e.g. the attribute) in the item's note; the GM sets the effect." : "Name the choice in choiceNotes; the GM sets the effect.",
    gm: `The effect of "${p.name}" still has the placeholder key ${(p.keys ?? []).join(", ")}: edit the effect by hand after Apply (the builder does not fill it in).` }),
  "effect.filled": (p) => ({ message: `${p.type ? `${p.type[0].toUpperCase()}${p.type.slice(1)} ` : ""}"${p.name}": the builder writes the effect key ${(p.keys ?? []).join(", ")} as ${(p.filled ?? []).join(", ")} (from the note; value as in the entry).`, hint: "Nothing to fix." }),
  "profile.suggestInPlay": () => ({ message: "The current sheet already fails the creation rules.", hint: "The GM may switch the drawer to the in-play profile (no new errors)." }),
  "budget.delta": (p) => ({ message: `Under creation rules this change ${p.delta < 0 ? `costs ${-p.delta}` : `frees ${p.delta}`} attribute point(s) (budget ${p.before} -> ${p.after}, spent ${p.spentBefore} -> ${p.spentAfter}).`, hint: "In-play: informational only." }),
  "talent.role.shift": (p) => ({ message: `Talent "${p.name}" ${p.listed ? `is listed as the ${p.from} talent but will be` : `is the ${p.from} talent now and will be`} the ${p.to} talent after this change: the role follows the order of the talents on the sheet (1st hero, 2nd occupation, the rest extras) and a new talent is always added last.`, hint: "If that is not intended, also remove and re-add the talents that must come after the new one, in role order; otherwise ignore this." }),
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
  if (issue.entry) out.entry = issue.entry;   // W2-2: the proposal entry's name (replace)
  out.message = issue.message ?? t.message;
  out.hint = issue.hint ?? t.hint;
  if (issue.suggest) out.suggest = issue.suggest;
  if (t.gm) out.gm = t.gm;   // GM-only (dropped from the model's tool result)
  return out;
}

/* ================================================================== rules on a (projected) actor */
const issue = (code, severity, path, params = {}) => ({ code, severity, path, params });
const sig = (i) => `${i.code}|${norm(i.params?.name ?? i.params?.attr ?? i.path ?? "")}`;

/** -> { rank, from: "drawer"|"flag"|"default" } (from "default" = nobody chose a rank: warning rank.defaulted, P1-G) */
function rankFor(plain, opts) { return resolveRank(plain, opts.rank); }
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
  // W4-A-1: team.empty is info here (a solo hero, D-16), never a warning that asks for a fix
  const out = v.issues.filter((i) => i.code !== "drawback.note.missing").map((i) => issue(i.code, QUIET_CODES.has(i.code) ? "info" : i.severity === "warn" ? "warn" : i.severity, i.path, i.params));
  // W4-A-5: the occupation talent's list for the hint
  const occMiss = out.find((i) => i.code === "talent.occ.missing");
  if (occMiss) {
    const occ = (catalog?.byKind?.("occupation") ?? []).find((o) => norm(o.name) === norm(String(state.occupation ?? "").replace(/^the\s+/i, "")));
    if (occ) occMiss.params = { ...occMiss.params, occupation: occ.name, ...(occ.talents?.length ? { list: occ.talents.join(", ") } : {}) };
  }
  // D-3 (provisional): Hard Times stays the pack's -1; say which Resources value to store and what the sheet then shows
  const ht = out.find((i) => i.code === "drawback.hardTimes");
  if (ht) {
    const n = state.drawbacks.filter((d) => norm(d?.name) === "hard times").length;
    const stored = Number(state.resources) || 0;
    ht.params = { ...ht.params, n, stored, effective: stored - n, book: stored - 2 * n };
  }
  // W3-7: is there an "NPC:" line at all (nameless NPC) or no NPC relationship written
  const nb = out.find((i) => i.code === "npc.name.blank");
  if (nb) nb.params = { ...nb.params, line: /^\s*NPC:/im.test(String(getPath(plain, "system.relationships") ?? "")) };
  return { issues: [...out, ...catalogueIssues(plain, catalog)], state };
}
/**
 * Life-step checks the vendored rules do not make (P1-F), creation profile only (in play, Reputation grows and the GM edits
 * freely). Warnings (owner decision D-4, provisional): occupation from the catalogue (by name; a ref or slug is pointed at the
 * name), stored Resources = the occupation's value, the occupation talent (2nd talent) from the occupation's list (base names,
 * so "Knowledgeable (Physics)" matches "Knowledgeable"), stored Reputation = the rank's starting value. An occupation the
 * catalogue does not know (own occupation, book page missing) skips the Resources and talent checks.
 */
export function creationIssues(plain, state, rank, catalog) {
  const out = [];
  const occs = catalog?.byKind?.("occupation") ?? [];
  const occText = String(state?.occupation ?? "").trim();
  if (occText && occs.length) {
    let occ = occs.find((o) => norm(o.name) === norm(occText) || norm(o.name) === norm(occText.replace(/^the\s+/i, "")));
    if (!occ) {
      const alt = (catalog.get?.(occText)?.kind === "occupation" ? catalog.get(occText) : null) ?? occs.find((o) => o.id === slug(occText.replace(/^occupation:/i, "")));
      out.push(issue("occupation.unknown", "warn", "occupation", { occupation: occText, ...(alt ? { name: alt.name } : {}) }));
      occ = alt ?? null;
    }
    if (occ) {
      if (Number.isInteger(occ.resources) && Number(state.resources) !== occ.resources) {
        out.push(issue("resources.occupation", "warn", "resources", { resources: Number(state.resources) || 0, value: occ.resources, occupation: occ.name }));
      }
      const t = state.occTalent?.name;
      if (t && occ.talents?.length && !occ.talents.some((x) => normBase(x) === normBase(t))) {
        out.push(issue("talent.occ.list", "warn", "occTalent", { name: t, occupation: occ.name, list: occ.talents.join(", ") }));
      }
    }
  }
  const want = rules.RANKS[rank]?.reputation;
  const have = Number(getPath(plain, "system.reputation") ?? 0) || 0;
  if (Number.isInteger(want) && have !== want) out.push(issue("reputation.rank", "warn", "reputation", { reputation: have, value: want, rank }));
  return out;
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
    // W5-B-2: rank.defaulted is a quiet info (the default rank is used and nothing conflicts); a warning only when the result
    // is refused (an error may come from the default rank) or the proposal names another rank (rank.differs)
    const rd = [...raw.warnings, ...raw.info].filter((i) => i.code === "rank.defaulted");
    if (rd.length) {
      const loud = raw.errors.length > 0 || raw.warnings.some((i) => i.code === "rank.differs");
      raw = { ...raw, warnings: raw.warnings.filter((i) => i.code !== "rank.defaulted"), info: raw.info.filter((i) => i.code !== "rank.defaulted") };
      (loud ? raw.warnings : raw.info).unshift(rd[0]);
    }
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
  acc.warnings.push(...(n.warnings ?? []));   // note.cut (P1-D)
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
  const { rank, from: rankFrom } = rankFor(basePlain, opts);
  const isHero = dk.type === "superhero";
  const issuesOf = (plain) => {
    const r = isHero ? superheroIssues(plain, rank, catalog) : npcIssues(plain, rank, catalog);
    if (isHero && profile === "creation") r.issues.push(...creationIssues(plain, r.state, rank, catalog));
    return r;
  };
  // P1-G: nobody chose a rank (no drawer rank, no plus-ultra flag): say so instead of validating as Global silently
  // W5-B-2: info here; `finish` makes it a warning when the result is refused or names another rank
  if (isHero && rankFrom === "default") acc.info.push({ code: "rank.defaulted", path: "rank", params: { rank } });

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
  let conv = null;
  if (P.mode === "replace") {
    conv = replaceToOps(null, P.proposal, { catalog, plain: basePlain, rank, profile });
    acc.errors.push(...conv.errors);
    ops = conv.ops;
    // W2-2: every issue from here on is reported in the proposal's terms (proposal.powers[0].level, entry name), not in the
    // terms of the internal ops the replace was converted to (ops[2].level); opIds stay (summary / perOp / GM preview use them)
    const raw = finish;
    finish = (layer, r, ctx) => raw(layer, { errors: r.errors.map((i) => replacePath(i, conv, res.ops ?? ops)), warnings: r.warnings.map((i) => replacePath(i, conv, res.ops ?? ops)), info: r.info.map((i) => replacePath(i, conv, res.ops ?? ops)) }, ctx);
    for (const d of conv.defaulted ?? []) acc.info.push({ code: "reputation.defaulted", path: d.path, params: { value: d.value, rank: d.rank } });
    if (P.proposal.rank && P.proposal.rank !== rank) acc.warnings.push({ code: "rank.differs", path: "proposal.rank", params: { proposed: P.proposal.rank, rank } });
  }
  const rankDiffers = acc.warnings.some((w) => w.code === "rank.differs");
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
  // W5-A-V1: a replace writes the proposal's talent order (writer W5-A-3: the moved talents re-created last). The projection
  // takes the same order, so the rules read the written roles (hero / occupation talent, talent.occ.list, perOp is per op);
  // the kept talents that change role go to applyConfirm (W5-A-V2)
  const talentOrder = P.mode === "replace" && isHero ? talentOrderPlan(basePlain, proj.actor, conv) : { move: [], reorders: [] };
  if (talentOrder.move.length && Array.isArray(proj.actor?.items)) {
    const at = new Map(proj.actor.items.map((i) => [String(i._id), i]));
    const moved = talentOrder.move.map((id) => at.get(id)).filter(Boolean);
    proj.actor.items = [...proj.actor.items.filter((i) => !talentOrder.move.includes(String(i._id))), ...moved];
  }
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
  // creation + replace = a (re)build: every warning of the result counts, also those the blank sheet already had (P1-F: e.g.
  // npc.name.blank is on an empty actor from the start, so "new warnings only" hid its hint from the model)
  const showAllWarnings = profile === "creation" && P.mode === "replace";
  const baseWarnSigs = new Set(showAllWarnings ? [] : baseIssues.filter((i) => i.severity === "warn").map(sig));
  const blame = opBlame(ops, proj);
  for (const i of projIssues) {
    const e = { ...i, opId: i.opId ?? blame(i) };
    if (profile === "in-play" && i.code === "attr.cap") e.params = { ...e.params, inPlay: true };   // W3-11
    if (i.severity === "error") {
      if (profile === "in-play" && BUDGET_CODES.has(i.code)) continue;            // reported as budget.delta below
      if (profile === "in-play" && baseSigs.has(sig(i))) { acc.info.push({ code: "baseline.tolerated", path: i.path, params: { issue: describe(i, { rank }).message } }); continue; }
      acc.errors.push(e);
    } else if (i.severity === "warn") { if (!baseWarnSigs.has(sig(i))) acc.warnings.push(e); }
    else acc.info.push(e);
  }
  // W3-7 (finding 2): the Hard Times remark only when the change touches drawbacks or Resources, or in a replace (it came with
  // every submit on a sheet that has Hard Times)
  const touchesHT = Object.values(proj.opInfo).some((x) => x.type === "drawback" || (x.cascade ?? []).some((c) => c.type === "drawback") ||
    (x.kind === "actor" && (x.changed ?? []).some((c) => c.path === "system.resources")));
  if (P.mode !== "replace" && !touchesHT) acc.info = acc.info.filter((x) => x.code !== "drawback.hardTimes");
  // W4-A-1: the solo-hero remark only in a replace (a build) or when the change writes team / teamBase
  const touchesTeam = Object.values(proj.opInfo).some((x) => x.kind === "actor" && (x.changed ?? []).some((c) => c.path === "system.team" || c.path === "system.teamBase"));
  if (P.mode !== "replace" && !touchesTeam) acc.info = acc.info.filter((x) => x.code !== "team.empty");
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
    res.budget = { before, after: afterB, note: BUDGET_NOTE, perOp: perOpCost(basePlain, ops, catalog, rank, before) };
    if (profile === "in-play" && (afterB.points !== before.points || afterB.spent !== before.spent)) {
      acc.info.push({ code: "budget.delta", path: "attrs", params: { delta: (afterB.points - afterB.spent) - (before.points - before.spent), before: before.points, after: afterB.points, spentBefore: before.spent, spentAfter: afterB.spent } });
    }
    // self-repair hint (spec 7.3): a reconciled attribute vector for attr.over / attr.unspent. Not when the proposal names
    // another rank (rank.differs, P1-G): the vector would balance the drawer's rank, i.e. the wrong one
    for (const e of rankDiffers ? [] : acc.errors) {
      if (e.code !== "attr.over" && e.code !== "attr.unspent") continue;
      const r = rules.reconcileAttributes(after.state.attrs, afterB.points, afterB.cap);
      if (r.ok) e.suggest = { updateActor: { attributes: r.attrs } };
    }
  }
  // W2-3: a talent's role is its place in the collection (new items go last); say when the change gives a talent another role
  // (ops: compared with the sheet now). W5-A-V1: never in a replace (the writer writes the proposal's talent order, W5-A-3, so
  // the list order IS the result). Before the L2 stop, so the model sees it together with rule errors.
  if (isHero) for (const s of talentShifts(basePlain, proj.actor, P, catalog)) {
    acc.warnings.push({ code: "talent.role.shift", path: `items.${s.itemId}`, ...(s.itemId.startsWith(NEW_PREFIX) ? { opId: s.itemId.slice(NEW_PREFIX.length) } : {}), params: s });
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
  // W3-9: an item this change adds (in a creation replace: any item of the result) whose effect key still has a placeholder
  // ("bonus.[attribute]"). Added items: the catalogue entry's effects (the projection carries none); sheet items: their own.
  for (const it of proj.actor.items) {
    const isNew = String(it._id).startsWith(NEW_PREFIX);
    if (!isNew && !showAllWarnings) continue;
    const own = placeholderKeys(effectsOf(it.effects));
    const entry = isNew ? (catalog?.get?.(it._ref) ?? catalog?.findByName?.(it.type, baseName(it.name))) : null;
    const keys = own.length ? own : entry?.placeholders ?? [];
    if (!keys.length) continue;
    const at = { path: `items.${it._id}`, ...(isNew ? { opId: it._id.slice(NEW_PREFIX.length) } : {}) };
    const canNote = ["power", "talent", "drawback"].includes(it.type);
    const attrOnly = keys.every(onlyAttributePlaceholders);
    // W4-A-4 (D-13 provisional): an ADDED item whose open keys are all "[attribute]" and whose note names one attribute is filled
    // by the writer (writer.mjs fillAttributeEffects): info, not a warning
    const attr = isNew && canNote && attrOnly ? attributeFromNote(noteOf(it.name)) : null;
    if (attr) acc.info.push({ code: "effect.filled", ...at, params: { name: baseName(it.name), type: it.type, keys, filled: keys.map((k) => fillAttributeKey(k, attr)), attr } });
    else acc.warnings.push({ code: "effect.placeholder", ...at, params: { name: baseName(it.name), type: it.type, keys, noted: !!noteOf(it.name), canNote, attrOnly, isNew } });
  }
  // W3-12 (D-17 provisional): gear cost next to the hero's Resources, info only (no rule enforced), for gear this change adds or
  // re-prices
  if (isHero) {
    const resources = Number(getPath(proj.actor, "system.resources")) || 0;
    for (const [opId, info] of Object.entries(proj.opInfo)) {
      if (info.type !== "gear" && info.type !== "vehicleWeapon") continue;
      if (info.kind !== "add" && !(info.kind === "update" && (info.changed ?? []).some((c) => c.field === "cost"))) continue;
      const it = proj.actor.items.find((x) => x._id === info.itemId);
      const cost = Number(it?.system?.cost);
      if (it && Number.isInteger(cost)) acc.info.push({ code: "gear.cost", opId, path: `items.${info.itemId}`, params: { name: it.name, cost, resources } });
    }
  }

  // W3-10 (finding 5): removals and level swaps need the GM's confirmation at Apply (writer: plan.needConfirm); the model is told
  // in the submit result. Same set as the writer's plan.deletes (removeItem + cascade) and plan.swaps (split-level power change).
  // W5-A-V2: plus the kept talents a replace re-creates into another role (writer plan.reorders roleChange)
  res.applyConfirm = applyConfirmList(proj, talentOrder.reorders);

  res.expect = expectFor(doc ?? asDoc(basePlain), ops, proj);
  res.summary = [...summarize({ ops }, proj, res.budget), ...keptLine(conv, ops), ...(isHero && res.budget.after ? [`budget ${res.budget.after.points} spent ${res.budget.after.spent} slots ${res.budget.after.slots}/${res.budget.after.rankPowers}`] : [])].join("\n");
  return finish("L4", acc, { rank });
}
/**
 * W2-3 role shifts -> [{ itemId, name, from, to, listed }] (see reader.mjs talentRoles). ops only: W5-A-V1, a replace writes the
 * proposal's talent order (writer W5-A-3), so the projection's "kept in place, new last" order is not the result and no
 * shift happens -> [].
 */
export function talentShifts(basePlain, after, P) {
  if (P?.mode === "replace") return [];
  return talentRoleShifts(basePlain, after).map((x) => ({ ...x, listed: false }));
}
/**
 * W5-A-V2: the kept talents a replace re-creates into ANOTHER role, the way the writer plans it (writer.mjs W5-A-3: talents of
 * the projection = kept in place + new last; desired = the proposal's order, unnamed ones after; movePlan; roleChange = a kept
 * talent in the moved tail whose role on the sheet now differs from its role in the written order).
 * basePlain = sheet now, after = projection, conv = replaceToOps result -> [{ itemId, name, from, to }]
 */
export function talentReorders(basePlain, after, conv) {
  return talentOrderPlan(basePlain, after, conv).reorders;
}
/** talentReorders + `move` = the talent ids (projection ids, new ones "new:<opId>") the writer re-creates last, in that order */
export function talentOrderPlan(basePlain, after, conv) {
  const none = { move: [], reorders: [] };
  const order = talentOrderOf(conv);
  if (!order) return none;
  const fin = talentRolesOf(after);
  const before = fin.items.map((t) => String(t.id));
  const desired = [...new Set(order.map((t) => (t?.itemId != null ? String(t.itemId) : t?.opId != null ? NEW_PREFIX + t.opId : "")).filter((id) => before.includes(id)))];
  desired.push(...before.filter((id) => !desired.includes(id)));
  const { keep, move } = movePlan(before, desired);
  if (!move.length) return none;
  const was = talentRolesOf(basePlain).roles;
  const will = talentRoles([...keep, ...move].map((id) => ({ id })), !!String(getPath(after, "system.occupation") ?? "").trim());
  const nameOf = new Map(fin.items.map((t) => [String(t.id), String(t.name ?? "")]));
  const reorders = [];
  for (const id of move) {
    if (id.startsWith(NEW_PREFIX)) continue;
    const from = was.get(id) ?? null, to = will.get(id) ?? null;
    if (from && to && from !== to) reorders.push({ itemId: id, name: nameOf.get(id) ?? id, from, to });
  }
  return { move, reorders };
}
/** W2-5 (D-Q): a replace whose reputation / resources already match the sheet makes no op for them; say they are set */
function keptLine(conv, ops) {
  const k = Object.entries(conv?.kept ?? {});
  if (!k.length) return [];
  const act = ops.find((o) => o.op === "updateActor")?.opId;
  return [`${act ?? "actor"}: kept ${k.map(([f, v]) => `${f} ${v}`).join(", ")} (already on the sheet)`];
}
/**
 * W3-10: what the GM confirms at Apply -> ["remove talent \"X\"", "remove boost \"Y\" (with \"Z\")", "level swap power \"W\" major -> massive",
 * "reorder talent \"Q\" hero -> occupation" (W5-A-V2: `reorders` = talentReorders, a replace only)]
 */
export function applyConfirmList(proj, reorders = []) {
  const out = [];
  for (const info of Object.values(proj?.opInfo ?? {})) {
    if (info.kind === "remove") out.push(`remove ${info.type} "${info.name}"`);
    for (const c of info.cascade ?? []) out.push(`remove ${c.type} "${c.name}" (with "${info.name}")`);
    if (info.splitSwap && info.splitSwap.from !== info.splitSwap.to) out.push(`level swap ${info.type} "${baseName(info.name)}" ${info.splitSwap.from} -> ${info.splitSwap.to}`);
  }
  for (const r of reorders ?? []) out.push(`reorder talent "${baseName(r.name)}" ${r.from} -> ${r.to}`);
  return out;
}
export const APPLY_CONFIRM_NOTE = "The GM confirms these at Apply (removals, level swaps and kept talents moved to another role); nothing to do for you.";
const opIdOf = (proj, info) => Object.entries(proj.opInfo).find(([, v]) => v === info)?.[0];
const planIssue = (e) => (typeof e === "string" ? { code: "plan.error", message: e, hint: "Check the sheet and resubmit." } : { code: String(e?.code ?? "plan.error"), path: e?.path, opId: e?.opId, params: e?.params ?? {}, ...(MESSAGES[e?.code] ? {} : { message: String(e?.message ?? e?.code ?? "plan error"), hint: String(e?.hint ?? "Check the sheet and resubmit.") }) });
async function resolveLookup(l) {
  try { return l ? await (typeof l === "function" ? l() : l) : null; } catch { return null; }
}

/* ---- W2-2: replace issues in the proposal's own terms */
/** op field (after "ops[i].") -> the proposal field of the same entry */
const OP_FIELD = { ref: ".ref", level: ".level", note: ".note", sourceItemId: ".source", sourceOpId: ".source",
  "set.level": ".level", "set.note": ".note", "set.powerSourceItemId": ".source", "set.powerSourceOpId": ".source" };
/** chargen state path (vendored rules / creationIssues) -> proposal path */
const STATE_PATH = { attrs: "proposal.attributes", occupation: "proposal.texts.occupation", resources: "proposal.resources",
  reputation: "proposal.reputation", personality: "proposal.texts.personality", drive: "proposal.texts.drive", flaw: "proposal.texts.flaw",
  heroName: "proposal.name", civilianName: "proposal.texts.civilianName", "npcRel.name": "proposal.texts.relationships",
  team: "proposal.texts.team", "team.baseId": "proposal.texts.team", "team.upgrades": "proposal.texts.teamBase",
  heroTalent: "proposal.talents[0]", occTalent: "proposal.talents[1]", extraTalents: "proposal.talents", drawbacks: "proposal.drawbacks",
  powers: "proposal.powers", sources: "proposal.sources", rank: "proposal.rank" };
/** an actor-op field param ("system.attributes.agility.value", "system.relationships", "name") -> proposal path */
const actorField = (f) => {
  const m = /^system\.attributes\.(\w+)\.value$/.exec(f ?? "");
  if (m) return `proposal.attributes.${m[1]}`;
  if (f === "name") return "proposal.name";
  if (f === "system.reputation" || f === "system.resources") return `proposal.${f.slice(7)}`;
  if (/^system\.\w+$/.test(f ?? "")) return `proposal.texts.${f.slice(7)}`;
  return "proposal";
};
/**
 * replacePath(issue, conv, ops) -> the issue with `path` in proposal terms and `entry` = the entry's name (W2-2).
 * Order: an op path ("ops[2].level": the op's source entry + the field), an item path ("items.<id>": the entry a kept or added
 * item comes from; a leftover the replace removes keeps "items.<id>"), the op an issue was blamed on (rules issues of an item),
 * then the chargen state path table (attributes, texts, talents...). Paths already in proposal terms stay as they are.
 */
export function replacePath(i, conv, ops) {
  if (!conv || !i) return i;
  const p = String(i.path ?? "");
  const opAt = (k) => ops?.[k]?.opId;
  let m, s = null, path = null;
  if ((m = /^ops\[(\d+)\](?:\.(.+))?$/.exec(p))) {
    s = conv.src?.[i.opId ?? opAt(+m[1])] ?? conv.src?.[opAt(+m[1])] ?? null;
    if (s) path = s.path === "proposal" ? actorField(i.params?.field) : s.path + (OP_FIELD[m[2]] ?? "");
  } else if ((m = /^items\.(.+)$/.exec(p))) {
    const id = m[1];
    s = id.startsWith(NEW_PREFIX) ? conv.src?.[id.slice(NEW_PREFIX.length)] : conv.srcItems?.[id] ?? null;
    if (s) path = s.path;
  }
  if (!path && i.opId && conv.src?.[i.opId] && conv.src[i.opId].path !== "proposal" && !p.startsWith("proposal")) { s = conv.src[i.opId]; path = s.path; }
  if (!path && !p.startsWith("proposal") && !p.startsWith("items.")) {
    const head = p.replace(/\.(\d+)$/, "");
    const t = /^attrs\.(\w+)$/.exec(p) ? `proposal.attributes.${p.slice(6)}` : STATE_PATH[p] ?? STATE_PATH[head] ?? null;
    if (t) path = t;
  }
  if (!path) return s ? { ...i, entry: s.name } : i;
  return { ...i, path, ...(s?.name && s.path !== "proposal" ? { entry: s.name } : {}) };
}

/** rules issue -> the op that caused it (by item name, or the updateActor op for attribute / text codes) */
function opBlame(ops, proj) {
  const byName = new Map();
  for (const [opId, info] of Object.entries(proj.opInfo)) if (info.name) byName.set(normBase(info.name), opId);
  const actorOp = ops.find((o) => o.op === "updateActor")?.opId;
  return (i) => {
    const n = i.params?.name;
    if (n && byName.has(normBase(n))) return byName.get(normBase(n));
    if (/^(attr|personality|drive|flaw|heroName|civilianName|occupation|resources|reputation|npc\.name)/.test(i.code) && actorOp) return actorOp;
    return undefined;
  };
}

/** W2-5: what `before` means (the dry run read 40 points on an empty Global sheet as an error). W2-8: GM side only (pack.validate,
    drawer preview); the model reads the same legend in the rules digest, so toolResult drops it. */
export const BUDGET_NOTE = "points = attribute points available; every unused rank slot adds 2 (an empty sheet starts high, each slot then costs 2). perOp points/slots = that op's change; spentAfter = attribute sum after it.";
/**
 * per-op cost (spec 7.5.4, P1-C): cumulative projections, each op's delta of budget points, slots and spent points, plus a
 * readable `label`. Evaluation order: actor-field ops FIRST, then the rest in list order (the occupation decides which talent
 * is free; evaluated last it made the occupation talent look paid and the actor op look +1). The deltas still add up to
 * after - before; the result is in list order. Talent / source roles come from the FINAL sheet (talent order: hero,
 * occupation, extras; first source free).
 */
export function perOpCost(basePlain, ops, catalog, rank, before) {
  const order = [...ops.filter((o) => o.op === "updateActor"), ...ops.filter((o) => o.op !== "updateActor")];
  const byOp = new Map();
  let prev = before;
  for (let k = 0; k < order.length; k++) {
    const p = project(null, order.slice(0, k + 1), { catalog, plain: basePlain });
    const b = budgetOf(stateOf(p.actor, rank));
    byOp.set(order[k].opId, { opId: order[k].opId, points: b.points - prev.points, slots: b.slots - prev.slots, spentBefore: prev.spent, spentAfter: b.spent, slotsAfter: b.slots, rankPowers: b.rankPowers });
    prev = b;
  }
  const fin = project(null, ops, { catalog, plain: basePlain });
  const st = stateOf(fin.actor, rank);
  const ctx = {
    talents: fin.actor.items.filter((x) => x.type === "talent").map((x) => x._id),
    sources: fin.actor.items.filter((x) => x.type === "powerSource").map((x) => x._id),
    occupation: !!st.occupation,
    // W2-5: a limit's power and what it pays for. W3-6: always the reader's reading (level when the power is above Basic, else
    // boost: reader.mjs chargenStateFromActor, which the budget uses), never the model's `grants` (it does not change the cost)
    limitOf: (itemId) => {
      const all = [...fin.actor.items, ...basePlain.items];
      const l = all.find((x) => x._id === itemId);
      const pw = l ? all.find((x) => x._id === l.system?.power) : null;
      if (!pw) return null;
      // W5-B-3: the power's level and its boosts on the final sheet (a level-paying limit leaves the boosts on slots)
      const boosts = fin.actor.items.filter((x) => x.type === "boost" && x.system?.power === pw._id).map((x) => baseName(x.name));
      return { power: baseName(pw.name), grants: limitReading(pw), level: powerLevel(pw.system), boosts };
    }
  };
  return ops.map((op) => {
    const { slotsAfter, rankPowers, spentBefore, spentAfter, ...c } = byOp.get(op.opId);
    const label = costLabel({ ...c, slotsAfter, rankPowers, spentBefore, spentAfter }, fin.opInfo[op.opId], ctx);
    const out = label ? { ...c, label } : { ...c };
    if (spentAfter !== spentBefore) out.spentAfter = spentAfter;   // W2-5: absolute, only where the op changed it
    return out;
  });
}
/** W3-6: what a limit pays for as the reader (and so the budget) reads it: a level when its power is above Basic, else a boost */
export const limitReading = (power) => (power && LEVEL_WORDS.indexOf(powerLevel(power.system)) > 0 ? "level" : "boost");
const cap1 = (w) => (w ? `${w[0].toUpperCase()}${w.slice(1)}` : "");
/**
 * W5-B-3: what an added limit pays for, in the sheet's reading (limitReading). A power at Basic: "pays for a boost of "X"". Above
 * Basic: "pays for a level of "X"" (W3-6), and when the power also has boosts both facts, so the model can tell the GM which:
 * "pays for the level Major of "X"; the boost "Y" stays paid by a slot" (Massive and up: "a level (Massive)").
 */
export function limitPays(lim, slots = "") {
  const par = slots ? ` (no slot for it; ${slots})` : "";
  if (lim.grants !== "level" || !lim.boosts?.length) return `pays for a ${lim.grants} of "${lim.power}"${par}`;
  const lvl = lim.level === "major" ? `the level ${cap1(lim.level)}` : `a level (${cap1(lim.level)})`;
  const b = lim.boosts.map((n) => `"${n}"`).join(", ");
  return `pays for ${lvl} of "${lim.power}"${par}; the boost${lim.boosts.length > 1 ? `s ${b} stay paid by slots` : ` ${b} stays paid by a slot`}`;
}
const signed = (n, unit) => `${n > 0 ? "+" : ""}${n} ${unit}${Math.abs(n) === 1 ? "" : "s"}`;
/** -> "hero talent (free)", "occupation talent (free)", "extra talent -1 pt", "drawback +1 pt", "extra power source -1 pt",
    "+1 slot (slots 3/4) -2 pts", "pays for a boost of \"X\" (no slot for it; slots 2/4); the limit returns +2 pts", "attributes spent 12 -> 34",
    "+1 pt" ... ; "" when the op costs nothing and has no role */
export function costLabel(c, info, ctx) {
  if (!c) return "";
  const pts = c.points ? signed(c.points, "pt") : "";
  // W2-5: an attribute change says the sum it leaves (the old delta "spent 22" read like a total)
  const spent = Number.isInteger(c.spentAfter) && c.spentAfter !== c.spentBefore ? `attributes spent ${c.spentBefore} -> ${c.spentAfter}` : "";
  if (info?.kind === "actor" && spent) return [spent, c.slots ? `${signed(c.slots, "slot")} (slots ${c.slotsAfter}/${c.rankPowers})` : "", pts].filter(Boolean).join(", ");
  // W2-5: a limit pays for one level or boost of its power: say so instead of "-1 slot", which read like a slot refund
  const lim = info?.type === "limit" && c.slots && ctx.limitOf ? ctx.limitOf(info.itemId) : null;
  // W6-R3: "; the limit returns +2 pts" (a bare trailing "+2 pts" after the boost clause read as the boost's)
  if (lim && info.kind === "add" && c.slots < 0) return `${limitPays(lim, `slots ${c.slotsAfter}/${c.rankPowers}`)}${pts ? `; the limit returns ${pts}` : ""}`;
  if (lim && info.kind === "remove" && c.slots > 0) return `limit gone: the ${lim.grants} of "${lim.power}" it paid for needs a slot again (slots ${c.slotsAfter}/${c.rankPowers})${pts ? ` ${pts}` : ""}`;
  const role = (name) => (c.points ? `${name} ${pts}` : `${name} (free)`);
  if (info?.kind === "add" && info.type === "talent" && !c.slots) {
    const i = ctx.talents.indexOf(info.itemId);
    return role(i === 0 ? "hero talent" : i === 1 && ctx.occupation ? "occupation talent" : "extra talent");
  }
  if (info?.kind === "add" && info.type === "drawback" && !c.slots) return role("drawback");
  if (info?.kind === "add" && info.type === "powerSource" && !c.slots) return role(ctx.sources.indexOf(info.itemId) === 0 ? "first power source" : "extra power source");
  if (c.slots) {
    const over = c.slotsAfter > c.rankPowers ? ", over the rank" : "";
    return `${signed(c.slots, "slot")} (slots ${c.slotsAfter}/${c.rankPowers}${over})${pts ? ` ${pts}` : ""}`;
  }
  return pts;
}

/* ================================================================== model-facing tools */
const TOOL_DESC = {
  submit_proposal: "Submit the proposal for the GM. It is validated (refs, the rules on the sheet as it would be after the change, a dry run of the write); errors come back with hints, the budget before/after and each op's cost. ok:true ends your turn (with a warning to fix: after one fix step) and the GM sees a preview (applyConfirm: the removals, level swaps and kept talents moved to another role that the GM confirms at Apply). dryRun:true = check only: same checks, nothing reaches the GM, your turn goes on; only to compare variants or to price a change you may not propose (\"what would Flight at Major cost?\"), never before a submit.\n" + PROPOSAL_GUIDE
};
/**
 * B1 (bughunt-1, PROVISIONAL, owner decides after one real request): `strict` on the proposal tool. Internal constant, no
 * setting. OFF: PROPOSAL_SCHEMA has ~126 optional properties, and Anthropic's strict-grammar complexity limits (optional
 * parameters / unions per request) could not be confirmed from the local claude-api skill (it lists only unsupported
 * keywords); over a limit EVERY builder request would get a 400. The schema still goes to the model as is, and the
 * harness never trusts tool input: L0 `checkShape` (same schema, additionalProperties:false) + `normalize` check it locally.
 * The four small read tools (6 optional properties together) keep strict: true (tools.mjs).
 */
export const PROPOSAL_TOOL_STRICT = false;
export function proposalToolDefs() {
  return MODEL_TOOL_NAMES.map((name) => ({ name, description: TOOL_DESC[name], input_schema: PROPOSAL_SCHEMA, ...(PROPOSAL_TOOL_STRICT ? { strict: true } : {}) }));
}
/**
 * W5-B-1: warnings of an accepted submit that the model can fix in one more submit (the harness then keeps the turn open for one
 * fix round). Not counted: info (never), the quiet codes, warnings whose hint says there is nothing to do, and these codes: the
 * GM's business or already intended (drawer rank, slots over the rank by choice, hand-edited removals the GM sees, a cut note,
 * an NPC threat, a sensitive field the GM asked for).
 */
export const NO_FIX_WARNINGS = Object.freeze(new Set(["rank.defaulted", "rank.differs", "slots.over", "remove.handEdited", "note.cut", "npc.threat", "field.sensitive", "baseline.tolerated", "budget.delta", "gear.cost", "effect.filled"]));
const NO_FIX_HINT = /^(nothing to (fix|do)|information only|fine if|in-play: )/i;
export const isActionableWarning = (w) => !!w?.code && !QUIET_CODES.has(w.code) && !NO_FIX_WARNINGS.has(w.code) && !!String(w.hint ?? "").trim() && !NO_FIX_HINT.test(String(w.hint).trim());
/** model-facing submit result -> the actionable warnings (empty for a refused or dry-run result) */
export function actionableWarnings(name, res) {
  if (!res || res.ok !== true || res.dryRun === true) return [];
  return (Array.isArray(res.warnings) ? res.warnings : []).filter(isActionableWarning);
}
/** D-9: check_proposal (internal alias) or submit_proposal with dryRun:true */
export const isDryRun = (name, input) => name === "check_proposal" || input?.dryRun === true;
/** compact model-facing result (GM-only fields dropped) */
export function toolResult(name, r, doc, { dryRun = name === "check_proposal" } = {}) {
  const out = { ok: r.ok };
  if (dryRun) out.dryRun = true;   // the harness reads it: never the pending proposal, never ends the turn
  if (r.ok && !dryRun) {
    out.proposalId = `prop-${hash(`${doc?.uuid ?? ""}|${stableJson(r.normalized)}`)}`;
    out.summary = r.summary ?? "";
    // W3-10: model-facing (tool result, outside the cached prefix)
    if (r.applyConfirm?.length) { out.applyConfirm = r.applyConfirm; out.applyConfirmNote = APPLY_CONFIRM_NOTE; }
  }
  // GM-only remarks (`gm`, W2-5) never reach the model
  const model = (list) => list.map((i) => { if (!i?.gm) return i; const { gm, ...rest } = i; return rest; });
  if (r.errors.length) out.errors = model(r.errors);
  out.warnings = model(r.warnings);
  if (r.info.length) out.info = model(r.info);
  if (r.autoFixed.length) out.autoFixed = r.autoFixed;
  // W2-8: the budget legend lives in the rules digest (cached prefix); the per-result `note` stays GM-side only
  if (r.budget && typeof r.budget === "object" && "note" in r.budget) { const { note, ...b } = r.budget; out.budget = b; } else out.budget = r.budget;
  if (!r.ok) out.layer = r.layer;
  if (r.ok && dryRun) out.summary = r.summary ?? "";
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
    actionableWarnings: (name, res) => actionableWarnings(name, res),   // W5-B-1 (the harness's fix round)
    async runProposalTool(name, input, ctx = {}) {
      if (!TOOL_NAMES.includes(name)) return { ok: false, errors: [{ code: "tool.unknown", message: `Unknown tool "${name}".`, hint: "" }] };
      const o = ctx.options ?? {};
      const dryRun = isDryRun(name, input);
      const r = await run(ctx.doc, input, { profile: o.profile, rank: o.rank, requireRationale: !dryRun });
      return toolResult(name, r, ctx.doc, { dryRun });
    }
  };
}
