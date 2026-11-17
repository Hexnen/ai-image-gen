// Invincible rules digest (system[1] of the cached prefix) + the read_rules page whitelist (spec 6, 9.1; task T4 draft).
//
// The digest is OUR paraphrase: numbers and rule structure only, built from the vendored chargen rules (rules.mjs constants,
// which are public game numbers already in plus-ultra) and the creation logic. It contains NO rulebook prose. Book text reaches
// the model only at runtime, through read_rules / get_entries, and is never stored in the repo.
// T8 owns the final wording; this draft fixes the structure and the numbers.
//
// read_rules: whitelisted core-book pages of `invincible-core` only. The Quickstart journal (system adventure) is never a source:
// it is not in the whitelist, and the source adapter refuses any journal or page whose name says Quickstart.

import { RANKS, RANK_ORDER, ATTRS, ROLES, MAX_DRAWBACKS, FREE_TALENTS, ATTR_MIN, SLOT_VALUE, TALENT_LIMITS, DRAWBACK_LIMITS } from "./vendor/chargen/rules.mjs";
import { htmlToText } from "./catalog.mjs";

export const DIGEST_VERSION = 2;
export const RULES_PART_CHARS = 6000;   // spec 6: cap 6,000 chars per read_rules call (longer pages come in parts)

const RANK_NAMES = { teen: "Teen Upstart", street: "Street Protector", global: "Global Guardian", cosmic: "Cosmic Champion" };
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const limitText = (o) => Object.entries(o).map(([k, v]) => `${k.split(" ").map(cap1).join(" ")} (${v === Infinity ? "any number of times" : `up to ${v} times`})`).join(", ");

/** The digest text. Deterministic (no dates, no world data). */
export function rulesDigest() {
  const rankRows = RANK_ORDER.map((k) => { const r = RANKS[k]; return `${k}|${RANK_NAMES[k]}|${r.points}|${r.cap}|${r.powers}|${r.reputation}|${r.upgrades}`; });
  return [
    "<rules system=\"invincible\">",
    "Invincible RPG (Free League), character creation and item rules as the builder enforces them. Paraphrase with numbers only; the book's own text comes from read_rules / get_entries.",
    "",
    "## Document types",
    "Actors: superhero (player hero, full creation rules), npc (free-form), minions, challenge, vehicle (the last three are out of scope). Items: powerSource, power, boost, limit, talent, drawback, gear, vehicleWeapon, criticalInjury (never created by the builder).",
    `Attributes (exactly these six): ${ATTRS.join(", ")}. Roles (no mechanical effect): ${ROLES.join(", ")}. The system has no skills; stunts are roll outcomes described in power texts, not picks.`,
    "",
    "## Hero rank table",
    "key|name|attribute points|attribute cap|power slots|reputation|base upgrades",
    ...rankRows,
    "Default rank: Global Guardian. The GM sets the rank in the drawer; never change it yourself. The sheet header shows rank=<key>(drawer|flag|default); (default) means nobody chose it. If the GM's message names another rank, call no tools and ask the GM to set it in the drawer.",
    "",
    "## Reading VALID and budget",
    "The sheet's VALID line and the budget in tool results: budget (points) = attribute points available now (the formula below, unused slots already counted); spent = sum of the six attributes, must equal budget; slots = used/rank; cap = attribute cap; drawbacks = taken/max; xsrc, xtal (extraSources, extraTalents) = paid extra power sources and talents; errors/warns = codes, numbers in brackets. Judge a draft by budget.after; per-op values are running changes in list order.",
    "",
    "## Superhero budget (all of it must balance)",
    `Attribute points available = rank points + ${SLOT_VALUE} x (rank power slots - slots used) - extra power sources - extra talents + drawbacks.`,
    `Every attribute is an integer from ${ATTR_MIN} to the rank cap, and ALL available points must be spent (no leftover, no overspend).`,
    "Slots used per power = levels above Basic + 1 + its boosts - the levels/boosts paid by its limits. Using fewer slots than the rank gives frees 2 attribute points per slot; using more costs 2 per slot.",
    "Power levels: basic, major, massive, monstrous. A level needs the previous one. New heroes start at most at Major; Massive only at Cosmic Champion; Monstrous never. A power never goes above the highest level its catalogue entry lists.",
    "Split-level powers (catalogue marks them 'split') have one document per level: give the basic ref with a level, or that level's own ref (level omitted or the same).",
    "Boosts and limits belong to one named power (catalogue groups them under @power). A boost costs 1 slot. A limit is always paired with one level or one boost of its power, which then costs no slot; a limit without such a pairing is invalid.",
    "Power sources: at least one when the hero has powers; every power names one of the hero's sources; the first source is free, each extra costs 1 attribute point.",
    `Talents: ${FREE_TALENTS} free (one hero talent + one occupation talent); each extra talent costs 1 attribute point. Order sets the role: the first talent (on the sheet and in a proposal's list) is the hero talent, the second the occupation talent, the rest are extras. Hero talent: from the archetype's list when you build from an archetype, otherwise any talent. Occupation talent: from the occupation's list; where it lists Knowledgeable, any Knowledgeable (subject) entry of the catalogue counts. A talent is taken once unless it says otherwise: ${limitText(TALENT_LIMITS)}. Knowledgeable counts once whatever its subject.`,
    `Drawbacks: optional, at most ${MAX_DRAWBACKS}, each gives +1 attribute point; only once each except ${limitText(DRAWBACK_LIMITS)}. A drawback that asks for a choice (catalogue column 'needs': source = one of the hero's power sources, defined = something you define) needs a note.`,
    "Derived values (never written, the sheet computes them): Health = half of (fighting + agility + strength) rounded up; Resolve = half of (reason + intuition + presence) rounded up; Slugfest = half of strength rounded up; item effects add to them.",
    "Stored values to write at creation: reputation = the rank's reputation value (table above; item effects add on top); resources = the occupation's Resources value. Hard Times: still write the occupation's value; each Hard Times lowers the effective Resources by 1 through its item effect (the book prints 2; the builder follows the system's effect).",
    "Occupation: required; texts.occupation = its English catalogue name; it sets Resources (the occupation's value) and offers its talents. Personality = exactly 2 words. Drive, flaw and hero name are required; civilian name, appearance, relationships and team texts are expected.",
    "Archetypes are optional book suggestions (16), not rules; their suggested attributes and powers fit a Global Guardian budget.",
    "",
    "## NPCs",
    "Free-form: start from a stock NPC profile or an archetype; attributes 0..12 as the concept needs; powers only if they will be used; talents optional; drawbacks encouraged when they give the heroes a weakness to find; special abilities as text. Structure still holds: refs resolve, levels exist for the power, boosts/limits sit on a present power, no duplicate once-only talents.",
    "",
    "## Gear and vehicle weapons",
    "Gear: cost (integer >= 0, paid from Resources), restricted, single use, at most one attack (bonus, damage, min/max range, bypass armor). Vehicle weapons: cost and restricted. Start from a catalogue item when one fits; a custom item gets only a name, a plain description and those numbers.",
    "",
    "## Names",
    "Catalogue and item names stay in English exactly as in the catalogue; free texts follow the GM's language.",
    "</rules>"
  ].join("\n");
}

/**
 * read_rules topics -> core-book page (journal id, page id, page name). Page ids [V: live core-book 2026-11-17, chargen-spec 1].
 * Static: part of the tool schema (enum), so it is part of the cached prefix.
 */
export const RULE_TOPICS = Object.freeze({
  creation_overview: { journal: "Rbx4P6GQT5EoFNUG", page: "qmOhEV4M6DCQuMyC", name: "2: Your Superhero" },
  hero_rank: { journal: "Rbx4P6GQT5EoFNUG", page: "KcdpSxwN4xd9xKWI", name: "Hero Rank" },
  archetype_step: { journal: "Rbx4P6GQT5EoFNUG", page: "frBt1sEIFzmSNYLk", name: "Archetype" },
  attributes: { journal: "Rbx4P6GQT5EoFNUG", page: "5Rh9ZCOMsoTBYxc2", name: "Attributes" },
  health_resolve: { journal: "Rbx4P6GQT5EoFNUG", page: "3YiVccc3OQXr8lNE", name: "Health & Resolve" },
  powers_step: { journal: "Rbx4P6GQT5EoFNUG", page: "zg6TzE7j55vruJcT", name: "Powers" },
  talents_drawbacks_step: { journal: "Rbx4P6GQT5EoFNUG", page: "QUASJRybP42Vt8uZ", name: "Talents & Drawbacks" },
  occupation: { journal: "Rbx4P6GQT5EoFNUG", page: "0YDxkdD5Fw55l8ig", name: "Occupation" },
  personal_stuff: { journal: "Rbx4P6GQT5EoFNUG", page: "3oQYByEjZWpJs4P0", name: "Personal Stuff" },
  gear_resources: { journal: "Rbx4P6GQT5EoFNUG", page: "61Z6MioLBEn68ssA", name: "Gear & Resources" },
  team: { journal: "Rbx4P6GQT5EoFNUG", page: "SPsGAK5G5YYdG0Xy", name: "Team" },
  growth: { journal: "Rbx4P6GQT5EoFNUG", page: "R9r1Q30fr2xjoeK0", name: "Your Hero’s Growth" },
  reputation: { journal: "Rbx4P6GQT5EoFNUG", page: "pJLE33xQAFpzT8XV", name: "Reputation" },
  archetypes: { journal: "Rbx4P6GQT5EoFNUG", page: "0FCrBQzpjPzPkxWi", name: "Archetypes" },
  powers_intro: { journal: "nxvb0S0nTpAkqrBP", page: "Vn2Dhs2IohFtmEJi", name: "Powers" },
  weapons: { journal: "uGzAZuMcLWF9J1v0", page: "jpsgqPdomMQyTRQR", name: "Weapons" },
  other_gear: { journal: "uGzAZuMcLWF9J1v0", page: "fbSCVaPGT41yDxWi", name: "Other Gear" },
  vehicles: { journal: "uGzAZuMcLWF9J1v0", page: "M5uV9DJumd24JIud", name: "Vehicles" },
  minions: { journal: "uGzAZuMcLWF9J1v0", page: "m5bfJ92ziv2yfA2R", name: "Minions" },
  npc_creation: { journal: "zC8jNET9TAJE0aRs", page: "OljU5ooGeWf9Of14", name: "Non-Player Characters" },
  npc_profiles: { journal: "zC8jNET9TAJE0aRs", page: "xMrkexdC80JdPoh7", name: "NPC Profiles" },
  creatures: { journal: "zC8jNET9TAJE0aRs", page: "lfHWTDrW5MFA9p4S", name: "Creatures" }
});
export const TOPIC_KEYS = Object.freeze(Object.keys(RULE_TOPICS));

/** Split plain text into parts of at most `max` chars at paragraph (then line, then word) boundaries. */
export function splitParts(text, max = RULES_PART_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let at = rest.lastIndexOf("\n\n", max);
    if (at < max * 0.5) at = rest.lastIndexOf("\n", max);
    if (at < max * 0.5) at = rest.lastIndexOf(" ", max);
    if (at <= 0) at = max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * read_rules. -> { topic, title, part, parts, text } or { ok:false, error }
 * Text is the page converted to plain text; one part per call (1-based `part`, default 1).
 */
export async function readRules(source, { topic, part = 1 } = {}) {
  const t = Object.prototype.hasOwnProperty.call(RULE_TOPICS, topic) ? RULE_TOPICS[topic] : null;
  if (!t) return { ok: false, error: { code: "rules.topic", message: `Unknown topic "${topic}".`, hint: `Use one of: ${TOPIC_KEYS.join(", ")}.` } };
  const p = await source.page(t.journal, t.page, t.name);
  if (!p?.html) return { ok: false, error: { code: "rules.missing", message: `The book page "${t.name}" is not available in this world.` } };
  if (/quickstart/i.test(`${p.journal ?? ""} ${p.name ?? ""}`)) return { ok: false, error: { code: "rules.refused", message: "Quickstart text is never a rules source." } };
  const parts = splitParts(htmlToText(p.html));
  const n = Number.isInteger(part) && part >= 1 ? Math.min(part, parts.length) : 1;
  return { ok: true, topic, title: p.name, part: n, parts: parts.length, text: parts[n - 1], ...(n < parts.length ? { more: `call again with part ${n + 1}` } : {}) };
}
