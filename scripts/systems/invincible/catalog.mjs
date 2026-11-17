// Invincible catalogue index (spec 6, 9.1, 9.2; task T4).
//
// Builds ONE in-memory index of the selectable content from the installed `invincible-core` compendia (and the two creation
// pages of its core book for archetypes / occupations), and serves the read tools: search, entry details, the compact index
// text for the cached prompt prefix (system[2]).
//
// PURE core + adapter: every Foundry access goes through a `source` object (foundrySource(game) below, or a node fixture), so
// this file runs in node. Nothing from the packs or the book is ever stored in the repo: names, summaries and rules text are
// read at runtime and only go to the model.
//
// Source adapter (all async except folders/has):
//   has(pack)                          -> boolean           (pack = short pack name, e.g. "powers")
//   index(pack, fields)                -> [{ _id, name, type, folder, system, _stats }]   (pack index with extra fields)
//   folders(pack)                      -> [{ id, name, parent }]                          (parent = folder id or null)
//   document(pack, id)                 -> plain toObject() data (items: system, effects; actors: system, items) or null
//   documents(pack)                    -> [plain toObject() data] (optional, W3-13: item effects for the fx column)
//   page(journalId, pageId, pageName)  -> { name, journal, html } | null                  (core-book journal pages only)
//
// Refs: `<short>:<documentId>` (spec 6: "pack short name + document id"), e.g. `powers:Ab12...`; archetypes and occupations
// are sections of a book page: `archetype:<slug>`, `occupation:<slug>`. The harness maps refs to UUIDs with refToUuid().

import { setPowerMaxLevels } from "./vendor/chargen/rules.mjs";
import { norm, normBase } from "./names.mjs";

export const CORE = "invincible-core";
export const LEVEL_WORDS = ["basic", "major", "massive", "monstrous"];

/** kind -> where it lives. short = the ref prefix. */
export const KIND_INFO = Object.freeze({
  power: { pack: "powers", short: "powers" },
  boost: { pack: "boosts", short: "boosts" },
  limit: { pack: "limits", short: "limits" },
  powerSource: { pack: "power-sources", short: "sources" },
  talent: { pack: "talents", short: "talents" },
  drawback: { pack: "drawbacks", short: "drawbacks" },
  gear: { pack: "gears", short: "gears" },
  vehicleWeapon: { pack: "gears", short: "gears" },
  archetype: { pack: "core-book", short: "archetype" },
  occupation: { pack: "core-book", short: "occupation" },
  npcProfile: { pack: "npcs-creatures", short: "npcs" },
  sampleHero: { pack: "heroes-villans", short: "heroes" }
});
export const KINDS = Object.freeze(Object.keys(KIND_INFO));
const SHORT_TO_PACK = Object.freeze({ powers: "powers", boosts: "boosts", limits: "limits", sources: "power-sources", talents: "talents", drawbacks: "drawbacks", gears: "gears", npcs: "npcs-creatures", heroes: "heroes-villans" });
/** long pack name -> ref prefix: a ref written with the pack's own name ("power-sources:<id>") is the same ref (P1-E) */
const PACK_TO_SHORT = Object.freeze(Object.fromEntries(Object.entries(SHORT_TO_PACK).filter(([s, p]) => s !== p).map(([s, p]) => [p, s])));
/** "power-sources:<id>" -> "sources:<id>"; anything else unchanged (trimmed) */
export function shortRef(ref) {
  const r = String(ref ?? "").trim();
  const i = r.indexOf(":");
  if (i < 0) return r;
  const p = r.slice(0, i);
  return PACK_TO_SHORT[p] ? `${PACK_TO_SHORT[p]}:${r.slice(i + 1)}` : r;
}

/** The two book pages that hold archetypes / occupations (one h2 section per entry) [V: chargen-spec 1, live 2026-11-17]. */
export const BOOK = Object.freeze({
  journal: "Rbx4P6GQT5EoFNUG",
  archetypes: { pageId: "0FCrBQzpjPzPkxWi", pageName: "Archetypes" },
  occupations: { pageId: "0YDxkdD5Fw55l8ig", pageName: "Occupation" }
});

export const SUMMARY_WORDS = 12;
export const RULES_TEXT_CAP = 2500;      // get_entries rulesText per item (spec 6)
export const SECTION_TEXT_CAP = 4000;    // archetype / occupation sections (see catalog-notes C3)
export const MAX_REFS = 8;
export const MAX_RESULTS = 25;

/* ------------------------------------------------------------------ text helpers (pure) */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", minus: "−" };
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * HTML -> plain text, keeping structure the model can use: headings as "## ", list items as "- ", paragraphs as line breaks,
 * table cells joined with " | ". Enricher links (@UUID[...]{Label}, @Check[...]...) become their label. Never returns HTML.
 */
export function htmlToText(html) {
  let s = String(html ?? "");
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/@\w+\[([^\]]*)\]/g, "$1");
  // W3-13: inline roll markers ([[D3]], [[/r 1d6]], [[/r 1d6]]{label}) -> their label or formula
  s = s.replace(/\[\[(?:\/\w+\s+)?([^\]]*?)\]\](?:\{([^}]*)\})?/g, (m, f, l) => (l ?? f).trim());
  // W4-B-5: one table row = one line "a | b | c": tags inside a cell (<p>, <br>, lists, emphasis) become spaces, so a cell never
  // spreads over several lines (dry run 4: read_rules "vehicles" came out one cell per line, every "|" on its own line)
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (m, row) => {
    const cells = [...row.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => c[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
    return cells.length ? `\n${cells.join(" | ")}\n` : m;
  });
  s = s.replace(/<h[1-6]\b[^>]*>/gi, "\n## ").replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/(li|ul|ol)>/gi, "\n");
  s = s.replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ").replace(/<\/?tr\b[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|section|blockquote|table|tbody|thead|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s).replace(/­/g, "");
  // one line per paragraph / list item (no blank lines: tokens); a blank line only before a heading
  return s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter((l) => l && l !== "-" && l !== "##").join("\n").replace(/\n(?=## )/g, "\n\n").trim();
}

/** Plain text on one line (for summaries). */
export const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** First sentence, at most `words` words (cut marked with "…"). Text-only; quotes and pipes removed so index lines stay clean. */
export function summaryOf(text, words = SUMMARY_WORDS) {
  const t = oneLine(text).replace(/^#+\s*/, "").replace(/\|/g, "/");
  if (!t) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const first = (m ? m[1] : t);
  const w = first.split(" ");
  return w.length > words ? `${w.slice(0, words).join(" ").replace(/[,;:.]+$/, "")}…` : first;
}

/* ---- W4-B-1: talents and drawbacks carry their mechanical core in the index (dry run 4: a drawback summary cut before its rule
   made the model state "no mechanical effect"). The rule sentence is compressed (articles, boilerplate the `needs` column already
   says), never cut inside its last few words. */
export const RULE_WORDS = 18;       // words of the rule sentence ...
export const RULE_SLACK = 4;        // ... plus up to this many more rather than cutting just before the end
const MECH_WORDS = /\d|\b(?:damage|armou?r|rolls?|dice|health|resolve|stress|karma|resources|reputation|doubled?|halv\w*|re-?rolls?|increase\w*|decrease\w*|push\w*|cannot|quick action|full action|lose access|no powers)\b/i;
const MECH_ATTR = /\b(?:FIGHTING|AGILITY|STRENGTH|REASON|INTUITION|PRESENCE)\b/;
/** does this sentence state a game mechanic (a number, a game term, an attribute in capitals)? */
export const isMechanic = (s) => MECH_WORDS.test(s) || MECH_ATTR.test(s);
/** rules sentence -> shorter text with the same rule: drops articles, "(choose one ...)" / "defined when you select this X" (the
    index `needs` column says it), "You get +2" -> "+2", "N points of stress" -> "N stress", "You can" -> "Can" */
export function compressRule(s) {
  return String(s ?? "")
    .replace(/\s*\(choose one[^)]*\)/gi, "")
    .replace(/,?\s*defined\b[^.,;]{0,30}?\bwhen you select this \w+/gi, "")   // "defined [optional short qualifier] when you select this X"
    .replace(/\b(?:the|a|an)\s+/gi, "")
    .replace(/\bYou (?:get|gain) (?=[+–−-]\d)/g, "")
    .replace(/\b(\d+) points? of stress\b/g, "$1 stress")
    .replace(/\bYou can\b/g, "Can")
    .replace(/\s+([,.;:])/g, "$1").replace(/\s+/g, " ").trim();
}
const capWords = (s, n, slack) => {
  const w = s.split(" ");
  return w.length > n + slack ? `${w.slice(0, n).join(" ").replace(/[,;:.–-]+$/, "")}…` : s;
};
/**
 * Index summary of a talent / drawback: the first sentence when it states a mechanic, else the first of the next three sentences
 * that does (the name and the needs column say what the item is), else the first sentence; compressed, at most RULE_WORDS (+
 * RULE_SLACK) words. Quotes / pipes as in summaryOf.
 */
export function ruleSummary(text) {
  const t = oneLine(text).replace(/^#+\s*/, "").replace(/\|/g, "/");
  if (!t) return "";
  const sents = t.split(/(?<=[.!?])\s+(?=[A-Z"(+–−-])/).map(compressRule).filter(Boolean);
  const s0 = sents[0] ?? "";
  const pick = isMechanic(s0) ? s0 : sents.slice(1, 4).find(isMechanic) ?? s0;
  return capWords(pick, RULE_WORDS, RULE_SLACK);
}

/** Cut text at `cap` chars with an explicit marker (spec 6: "(truncated, N chars)"). */
export function cut(text, cap) {
  const s = String(text ?? "");
  if (s.length <= cap) return s;
  return `${s.slice(0, cap).replace(/\s+\S*$/, "")} (truncated, ${s.length} chars)`;
}

/** Name normalisation identical in spirit to plus-ultra's catalog.norm + accent folding for search. normBase drops a balanced
    trailing "(note)" (names.mjs, shared with the reader / validator / writer). */
export { norm, normBase };
export const fold = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export const slug = (s) => fold(String(s ?? "").replace(/^the\s+/i, "")).replace(/ /g, "-");

/** 53-bit FNV-1a style hash (pure, stable across runtimes) -> 12 hex chars. */
export function hash(str) {
  let h1 = 0x811c9dc5 ^ 0, h2 = 0x01000193 ^ 0;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  h1 = (h1 ^ (h2 >>> 15)) >>> 0; h2 = (h2 ^ (h1 >>> 13)) >>> 0;
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/* ------------------------------------------------------------------ rule helpers shared with the vendored rules (pure) */
/** Highest level the book defines in a power's own text (plus-ultra B2 logic): "Major:" / "Massive:" / "Monstrous:" labels. */
export function bookMaxLevel(html) {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ");
  const has = (w) => new RegExp(`(?:^|[>\\s.])${w}\\s*:`).test(text);
  return has("Monstrous") ? 3 : has("Massive") ? 2 : has("Major") ? 1 : 0;
}
/** What a drawback asks you to choose (plus-ultra B4 logic): "source" | "defined" | false. */
export function needsChoice(html) {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  if (/power sources?\s*\(choose one/i.test(text) || /choose one of your power/i.test(text)) return "source";
  if (/defined\b[^.,;]{0,30}?\bwhen you select/i.test(text)) return "defined";   // "defined [optional short qualifier] when you select"
  return false;
}

/**
 * Occupation section (plain text from htmlToText) -> { resources, talents } for the validator (P1-F): the "Resources: N" line and
 * the numbered list after the "Occupation Talent" line ("1. A, 2. B, 3. C"; also one item per line). Same reading as plus-ultra's
 * tables.mjs (paragraph starting "Resources" / "Occupation Talent"). Missing parts -> resources null / talents [].
 */
export function occupationFacts(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim());
  const resLine = lines.find((l) => /^resources\b/i.test(l));
  const res = resLine ? parseInt(resLine.replace(/^resources\b[^0-9-]*/i, ""), 10) : NaN;
  const talents = [];
  const at = lines.findIndex((l) => /^occupation talents?\b/i.test(l));
  if (at >= 0) {
    // the list follows on the same line after the colon ("...: 1. A, 2. B") or on the next line(s): one line "1. A, 2. B, 3. C",
    // or one numbered item per line
    const sameLine = lines[at].includes(":") ? lines[at].slice(lines[at].indexOf(":") + 1).trim() : "";
    let body = [];
    if (/^\d+\.\s*\S/.test(sameLine)) body = [sameLine];
    else {
      let i = at + 1;
      if (i < lines.length && /^\d+\.\s*\S/.test(lines[i])) {
        body.push(lines[i]);
        if (!/[,;]\s*\d+\.\s/.test(lines[i])) for (i++; i < lines.length && /^\d+\.\s*\S/.test(lines[i]); i++) body.push(lines[i]);
      } else for (; i < lines.length && /^-\s+\S/.test(lines[i]); i++) body.push(`1. ${lines[i].replace(/^-\s+/, "")}`);   // <ol>/<ul> items
    }
    for (const b of body) for (const part of b.split(/(?:^|[,;])\s*\d+\.\s*/)) { const t = part.replace(/[.,;]+$/, "").trim(); if (t) talents.push(t); }
  }
  return { resources: Number.isFinite(res) ? res : null, talents };
}

/**
 * Archetype section (the stored HTML of one h2 section, enricher links intact) -> { role, attrs, powers } in the shape of
 * plus-ultra's getArchetype (W2-4: the fallback when plus-ultra is not there). Same reading as plus-ultra catalog.mjs
 * parseArchetypes: paragraphs starting "Role", "Suggested Attributes" (ATTRIBUTE N pairs) and "Suggested Powers" (comma list
 * outside brackets; each item has a powers link, "Major"/"Massive" before or in its label, boost links inside, a bracketed note
 * that is not about a boost). Refs come from the catalogue (`cat`), level documents of split powers resolve to their power.
 * -> { role, attrs:{fighting..}, powers:[{ name, level, ref, boosts:[{ name, ref }], note? }] } (empty parts when absent)
 */
export function archetypeFacts(html, cat = null) {
  const paras = String(html ?? "").split(/<\/p>|<p\b[^>]*>|<br\s*\/?>/i)
    .map((p) => decodeEntities(p.replace(/<[^>]*>/g, " ")).replace(/­/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const find = (label) => paras.find((p) => p.toLowerCase().startsWith(label.toLowerCase()));
  const role = (find("Role") ?? "").replace(/^Role\s*:\s*/i, "").replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").trim();
  const attrs = {};
  for (const m of (find("Suggested Attributes") ?? "").matchAll(/(FIGHTING|AGILITY|STRENGTH|REASON|INTUITION|PRESENCE)\s*:?\s*(\d+)/gi)) attrs[m[1].toLowerCase()] = Number(m[2]);
  const text = (find("Suggested Powers") ?? "").replace(/^Suggested Powers\s*:\s*/i, "");
  const toks = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++; else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { toks.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) toks.push(cur);
  const idOf = (uuid) => String(uuid).split(".").pop();
  const powers = [];
  for (const tok of toks) {
    const link = /@UUID\[Compendium\.invincible-core\.powers\.(?:Item\.)?([^\]]+)\]\{([^}]+)\}/.exec(tok);
    if (!link) continue;
    const e = cat?.get?.(`powers:${idOf(link[1])}`) ?? cat?.findByName?.("power", link[2].replace(/^(major|massive)\s+/i, "").trim()) ?? null;
    const around = `${link[2]} ${tok.slice(0, link.index)}`;
    const level = cat?.levelOf?.(`powers:${idOf(link[1])}`) ?? (/\bmassive\b/i.test(around) ? "massive" : /\bmajor\b/i.test(around) ? "major" : "basic");
    const boosts = [...tok.matchAll(/@UUID\[Compendium\.invincible-core\.boosts\.(?:Item\.)?([^\]]+)\]\{([^}]+)\}/g)].map((b) => {
      const be = cat?.get?.(`boosts:${idOf(b[1])}`);
      return { name: be?.name ?? b[2].trim(), ref: be?.ref ?? null };
    });
    const note = /\}\s*\(([^)]*)\)/.exec(tok)?.[1]?.replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").trim();
    powers.push({ name: e?.name ?? link[2].replace(/^(major|massive)\s+/i, "").trim(), level, ref: e?.ref ?? null, boosts, ...(note && !/boost/i.test(note) ? { note } : {}) });
  }
  return { role, attrs, powers };
}

/** Book page -> [{ name, html }] one per <h2> section (content up to the next h2). Pure (regex on the stored HTML). */
export function h2Sections(html) {
  const s = String(html ?? "");
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(s))) marks.push({ name: oneLine(decodeEntities(m[1].replace(/<[^>]*>/g, ""))).replace(/­/g, ""), start: m.index, bodyStart: re.lastIndex });
  return marks.map((k, i) => ({ name: k.name, html: s.slice(k.bodyStart, i + 1 < marks.length ? marks[i + 1].start : s.length) })).filter((x) => x.name);
}

/* ------------------------------------------------------------------ automations / effects (never script bodies) */
const num = (v) => (v === null || v === undefined || v === "" ? undefined : Number(v));
/** One automation -> compact facts (spec 6.0/10.3: the JavaScript body is never sent, only a flag). */
export function automationFacts(a) {
  if (!a || typeof a !== "object") return null;
  const o = { type: a.type };
  if (a.name) o.name = String(a.name);
  if (a.showAsSelection) o.selectable = true;
  if (a.attribute) o.attribute = a.attribute;
  const bonus = num(a.rollBonus); if (bonus) o.bonus = bonus;
  const dmg = num(a.baseDamage); if (dmg) o.damage = dmg;
  const add = num(a.additionalDamage); if (add) o.addDamage = add;
  if (num(a.minRange) || num(a.maxRange)) o.range = `${num(a.minRange) ?? 0}-${num(a.maxRange) ?? 0}`;
  if (a.bypassArmor) o.bypassArmor = true;
  const stress = num(a.stressCost); if (stress) o.stress = stress;
  if (a.autoModify) o.autoModify = true;
  if (a.description) o.note = cut(oneLine(htmlToText(a.description)), 200);
  if (String(a.extraConfiguration ?? "").trim()) o.script = true;
  if (a.type === "runMacro") o.macro = true;
  if (a.conditionToApply) o.appliesCondition = true;
  return o;
}
export function automationsOf(system) {
  return Object.values(system?.automations ?? {}).map(automationFacts).filter(Boolean);
}
/** Effects -> [{ name, disabled?, transfer?: false, changes:[{key, type, value}] }] (v14 `type`, older `mode`; v14 keeps the
    changes in `system.changes`, older data in `changes`). `transfer: false` = the effect stays on the item (not on the actor). */
export function effectsOf(effects) {
  return (Array.isArray(effects) ? effects : []).map((e) => ({
    name: e?.name ?? "",
    ...(e?.disabled ? { disabled: true } : {}),
    ...(e?.transfer === false ? { transfer: false } : {}),
    changes: (Array.isArray(e?.system?.changes) ? e.system.changes : Array.isArray(e?.changes) ? e.changes : []).filter((c) => c?.key).map((c) => ({ key: c.key, type: c.type ?? c.mode, value: c.value }))
  }));
}

/* ---- W3-13: a short effect summary for the index (`fx` column) */
const FX_ATTRS = ["fighting", "agility", "strength", "reason", "intuition", "presence"];
const FX_MODE = { 0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };
/** effect change key -> short label: "system.attributes.reason.value" -> "reason", "system.derived.health.bonus" -> "health",
    "system.resources" -> "resources"; the system's own bonus keys stay recognisable ("bonus.reason", "maxPush.all") */
export function fxLabel(key) {
  const k = String(key ?? "").replace(/^system\./, "");
  const m = /^attributes\.(\w+)\.value$/.exec(k) ?? /^derived\.(\w+)\.bonus$/.exec(k);
  if (m) return m[1];
  return k.replace(/^derived\./, "") || String(key ?? "");
}
/** label -> { cat, attr } for grouping: "reason" -> { "", reason }, "bonus.reason" -> { "bonus.", reason }, else null */
const fxAttr = (label) => {
  if (FX_ATTRS.includes(label)) return { cat: "", attr: label };
  const m = /^(bonus\.|maxPush\.)(\w+)$/.exec(label);
  return m && FX_ATTRS.includes(m[2]) ? { cat: m[1], attr: m[2] } : null;
};
const FX_ALL = { "": "all attributes", "bonus.": "all attribute bonuses", "maxPush.": "maxPush all attributes" };
const fxValue = (type, v) => {
  const mode = typeof type === "number" ? FX_MODE[type] : String(type ?? "add");
  const s = String(v ?? "").trim(), n = Number(s);
  const num = s !== "" && Number.isFinite(n);
  if (mode === "add") return num ? (n >= 0 ? `+${n}` : `${n}`) : `+${s}`;
  if (mode === "override") return `=${s}`;
  if (mode === "multiply") return `*${s}`;
  if (mode === "upgrade") return `>=${s}`;
  if (mode === "downgrade") return `<=${s}`;
  return `~${s}`;
};
export const FX_MAX = 70;
/**
 * effects (effectsOf shape) -> "reason-3, 5 others -1" | "health+1 (disabled)" | "intuiton-1 (not transferred)" | "" (no changes).
 * Same value on 3+ attributes groups them ("N others V" next to other attribute changes, "all attributes V" for all six);
 * effects joined with "; "; cut at FX_MAX characters ("…"). Pure and byte-stable.
 */
export function fxSummary(effects) {
  const parts = [];
  for (const e of effects ?? []) {
    const ch = (e?.changes ?? []).map((c) => { const label = fxLabel(c.key); return { label, a: fxAttr(label), val: fxValue(c.type, c.value) }; });
    if (!ch.length) continue;
    const out = [];
    // attribute-named changes, per category (attribute value, attribute bonus, maxPush), in first-seen order
    for (const cat of [...new Set(ch.filter((c) => c.a).map((c) => c.a.cat))]) {
      const attr = ch.filter((c) => c.a?.cat === cat);
      const groups = new Map();
      for (const c of attr) groups.set(c.val, [...(groups.get(c.val) ?? []), c.a.attr]);
      const big = [...groups.entries()].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length)[0] ?? null;
      const rest = attr.filter((c) => !big || c.val !== big[0]).map((c) => `${c.label}${c.val}`);
      const allSix = new Set(attr.map((c) => c.a.attr)).size === FX_ATTRS.length;
      out.push(...rest);
      if (big) out.push(big[1].length === FX_ATTRS.length ? `${FX_ALL[cat]} ${big[0]}` : allSix && rest.length ? `${big[1].length} others ${big[0]}` : `${cat}${big[1].join("/")} ${big[0]}`);
    }
    for (const c of ch) if (!c.a) out.push(`${c.label}${c.val}`);
    const flags = [e.disabled ? "disabled" : "", e.transfer === false ? "not transferred" : ""].filter(Boolean).join(", ");
    parts.push(`${out.join(", ")}${flags ? ` (${flags})` : ""}`);
  }
  const s = parts.join("; ").replace(/\|/g, "/");
  return s.length > FX_MAX ? `${s.slice(0, FX_MAX - 1).replace(/[,;\s]+$/, "")}…` : s;
}
/** placeholder keys left for the user to fill ("bonus.[attribute]") */
export const placeholderKeys = (effects) => [...new Set((effects ?? []).flatMap((e) => (e?.changes ?? []).map((c) => String(c.key ?? "")).filter((k) => /\[[^\]]*\]/.test(k))))];

/* ------------------------------------------------------------------ index building */
const INDEX_FIELDS = {
  powers: ["system.level", "folder", "system.description", "_stats.modifiedTime"],
  boosts: ["folder", "system.description", "_stats.modifiedTime"],
  limits: ["folder", "system.description", "_stats.modifiedTime"],
  "power-sources": ["system.description", "_stats.modifiedTime"],
  talents: ["system.description", "_stats.modifiedTime"],
  drawbacks: ["system.description", "_stats.modifiedTime"],
  gears: ["folder", "system.description", "system.cost", "system.restricted", "system.singleUse", "system.automations", "_stats.modifiedTime"],
  "npcs-creatures": ["folder", "items", "_stats.modifiedTime"],
  "heroes-villans": ["folder", "items", "_stats.modifiedTime"]
};
export const REQUIRED_PACKS = Object.freeze(["powers", "power-sources", "boosts", "limits", "talents", "drawbacks"]);

function folderTools(folders) {
  const byId = new Map((folders ?? []).map((f) => [f.id, f]));
  const name = (id) => byId.get(id)?.name ?? null;
  const root = (id) => { let f = byId.get(id), n = 0; while (f?.parent && byId.has(f.parent) && n++ < 20) f = byId.get(f.parent); return f?.name ?? null; };
  return { name, root };
}

/** item summary for actor-kind entries: the power list is what tells two sample heroes apart. Names only: the compendium
    index's embedded items lose `system` until a document is loaded (live 2026-11-17), and the prefix must not change then. */
function actorSummary(items) {
  const powers = [...new Set((items ?? []).filter((i) => i?.type === "power").map((i) => i.name))];
  if (powers.length) return `powers: ${powers.slice(0, 5).join(", ")}${powers.length > 5 ? ", …" : ""}`;
  const any = (items ?? []).filter((i) => i?.name).map((i) => i.name);
  return any.length ? `items: ${any.slice(0, 4).join(", ")}${any.length > 4 ? ", …" : ""}` : "";
}

/**
 * Build the catalogue from a source. -> Catalog object (see makeCatalog). Never throws for a missing optional pack (gear,
 * actors, book pages): those kinds are just empty and listed in `missing`.
 */
export async function buildCatalog(source, { feedRules = true } = {}) {
  const entries = [];
  const missing = [];
  const counts = {};
  const sig = [];   // source fingerprint material (pack, count, max modifiedTime)
  const take = async (pack) => {
    if (!source.has(pack)) { missing.push(pack); return null; }
    const idx = await source.index(pack, INDEX_FIELDS[pack] ?? []);
    const arr = [...(idx ?? [])];
    sig.push(`${pack}:${arr.length}:${Math.max(0, ...arr.map((i) => Number(i?._stats?.modifiedTime) || 0))}`);
    return { idx: arr, f: folderTools(source.folders(pack)) };
  };

  // powers (grouped by name: split-level powers have one document per level)
  const pw = await take("powers");
  if (pw) {
    const byName = new Map();
    for (const i of pw.idx) {
      let e = byName.get(i.name);
      if (!e) {
        e = { kind: "power", name: i.name, id: i._id, pack: "powers", type: (pw.f.root(i.folder) ?? "Other").replace(/\s*Powers$/i, ""), maxLevel: 0, levelDocs: {}, html: i.system?.description ?? "" };
        byName.set(i.name, e);
      }
      const lv = i.system?.level ?? "";
      if (LEVEL_WORDS.includes(lv)) e.levelDocs[lv] = i._id;
      e.maxLevel = Math.max(e.maxLevel, bookMaxLevel(i.system?.description));
      if (lv === "basic") { e.id = i._id; e.html = i.system?.description ?? e.html; }
    }
    for (const e of byName.values()) {
      const have = Object.keys(e.levelDocs);
      e.split = have.length > 1;
      if (e.split) e.maxLevel = Math.max(...have.map((w) => LEVEL_WORDS.indexOf(w)));
      else e.levelDocs = {};
      entries.push(e);
    }
  }
  // boosts / limits: folder name == power name
  for (const [pack, kind] of [["boosts", "boost"], ["limits", "limit"]]) {
    const r = await take(pack);
    if (r) for (const i of r.idx) entries.push({ kind, name: i.name, id: i._id, pack, power: r.f.name(i.folder) ?? "", html: i.system?.description ?? "" });
  }
  for (const [pack, kind] of [["power-sources", "powerSource"], ["talents", "talent"], ["drawbacks", "drawback"]]) {
    const r = await take(pack);
    if (r) for (const i of r.idx) {
      const e = { kind, name: i.name, id: i._id, pack, html: i.system?.description ?? "" };
      if (kind === "drawback") { const n = needsChoice(e.html); if (n) e.needs = n; }
      entries.push(e);
    }
  }
  const gr = await take("gears");
  if (gr) for (const i of gr.idx) {
    const kind = i.type === "vehicleWeapon" ? "vehicleWeapon" : "gear";
    const auto = automationsOf(i.system).find((a) => a.damage || a.bonus || a.range) ?? null;
    entries.push({
      kind, name: i.name, id: i._id, pack: "gears", type: gr.f.name(i.folder) ?? "", html: i.system?.description ?? "",
      gear: { cost: num(i.system?.cost) ?? null, restricted: !!i.system?.restricted, singleUse: !!i.system?.singleUse, attack: auto ? { bonus: auto.bonus ?? 0, damage: auto.damage ?? 0, range: auto.range ?? null } : null }
    });
  }
  for (const [pack, kind] of [["npcs-creatures", "npcProfile"], ["heroes-villans", "sampleHero"]]) {
    const r = await take(pack);
    if (r) for (const i of r.idx) {
      // npcProfile: stock NPCs and creatures only (type npc); minions / vehicles / challenges are out of v1 (spec O2)
      if (kind === "npcProfile" && i.type !== "npc") continue;
      if (kind === "sampleHero" && i.type !== "superhero") continue;
      entries.push({ kind, name: i.name, id: i._id, pack, type: r.f.name(i.folder) ?? "", summaryText: actorSummary(i.items) });
    }
  }
  // archetypes / occupations: h2 sections of two book pages
  for (const [key, kind] of [["archetypes", "archetype"], ["occupations", "occupation"]]) {
    const p = source.has("core-book") ? await source.page(BOOK.journal, BOOK[key].pageId, BOOK[key].pageName) : null;
    if (!p?.html) { missing.push(`core-book:${BOOK[key].pageName}`); continue; }
    const secs = h2Sections(p.html);
    sig.push(`${key}:${secs.length}:${hash(p.html)}`);
    for (const s of secs) {
      const name = s.name.replace(/^The\s+/i, "");
      const text = htmlToText(s.html);
      const role = /\bRole:\s*([A-Za-z]+)/.exec(text)?.[1];
      const occ = kind === "occupation" ? occupationFacts(text) : null;
      entries.push({ kind, name, id: slug(name), pack: "core-book", html: s.html, ...(role ? { type: role } : {}), ...(occ ?? {}) });
    }
  }
  // W3-13: item documents for their effects (fx column of talents / drawbacks; placeholder keys for the validator, W3-9). The
  // optional adapter call documents(pack) loads a whole pack at once (the reader's lookup loads the same documents); without it
  // (or when it fails) entries have no effects data and the fx column shows "-".
  if (typeof source.documents === "function") {
    for (const pack of ["powers", "boosts", "limits", "power-sources", "talents", "drawbacks", "gears"]) {
      if (!source.has(pack)) continue;
      let byId = null;
      try { byId = new Map(((await source.documents(pack)) ?? []).map((d) => [d?._id, d])); } catch { byId = null; }
      if (!byId) continue;
      for (const e of entries) {
        if (e.pack !== pack) continue;
        const d = byId.get(e.id);
        if (!d) continue;
        e.effects = effectsOf(d.effects);
        const ph = placeholderKeys(e.effects);
        if (ph.length) e.placeholders = ph;
      }
    }
  }
  for (const e of entries) {
    e.ref = `${KIND_INFO[e.kind].short}:${e.id}`;
    if (e.summaryText == null) e.summaryText = e.kind === "talent" || e.kind === "drawback" ? ruleSummary(htmlToText(e.html)) : summaryOf(htmlToText(e.html));
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  const missingRequired = REQUIRED_PACKS.filter((p) => missing.includes(p));
  const cat = makeCatalog(entries, { missing, missingRequired, counts, sourceFingerprint: hash(sig.join("|")) });
  if (feedRules) setPowerMaxLevels(cat.byKind("power").map((e) => [e.name, e.maxLevel]));
  return cat;
}

/* ------------------------------------------------------------------ the catalogue object */
const KIND_ORDER = KINDS;
const byKindThenName = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.kind === "boost" || a.kind === "limit" ? norm(a.power).localeCompare(norm(b.power)) : 0) || a.name.localeCompare(b.name, "en") || a.ref.localeCompare(b.ref);

export function makeCatalog(entries, meta = {}) {
  const all = [...entries].sort(byKindThenName);
  const byRef = new Map(all.map((e) => [e.ref, e]));
  const kinds = new Map();
  for (const e of all) { if (!kinds.has(e.kind)) kinds.set(e.kind, []); kinds.get(e.kind).push(e); }
  // level documents of split powers resolve to their power (ref of a level doc is accepted everywhere)
  const levelRef = new Map();
  for (const p of kinds.get("power") ?? []) for (const [w, id] of Object.entries(p.levelDocs ?? {})) levelRef.set(`powers:${id}`, { power: p, level: w });

  const cat = {
    meta, entries: all,
    byKind: (k) => kinds.get(k) ?? [],
    /** entry for a ref (a split power's level ref resolves to the power) */
    get(ref) {
      const r = shortRef(ref);
      return byRef.get(r) ?? levelRef.get(r)?.power ?? null;
    },
    levelOf: (ref) => levelRef.get(shortRef(ref))?.level ?? null,
    /** find by name within a kind (exact, then without a trailing "(...)") */
    findByName(kind, name, { power = null } = {}) {
      let list = kinds.get(kind) ?? [];
      if (power && (kind === "boost" || kind === "limit")) { const sub = list.filter((e) => norm(e.power) === norm(power)); if (sub.length) list = sub; }
      const n = norm(name);
      return list.find((e) => norm(e.name) === n) ?? list.find((e) => normBase(e.name) === normBase(name)) ?? null;
    },
    boostsFor: (power) => (kinds.get("boost") ?? []).filter((e) => norm(e.power) === norm(power)),
    limitsFor: (power) => (kinds.get("limit") ?? []).filter((e) => norm(e.power) === norm(power))
  };
  return cat;
}

/** ref -> Foundry UUID (for the writer / validator). Book sections have no document uuid (null). */
export function refToUuid(cat, ref) {
  const e = cat.get(ref);
  if (!e || e.pack === "core-book") return null;
  const lv = cat.levelOf(ref);
  const id = lv ? e.levelDocs[lv] : e.id;
  return `Compendium.${CORE}.${e.pack}.${e.pack === "npcs-creatures" || e.pack === "heroes-villans" ? "Actor" : "Item"}.${id}`;
}

/* ------------------------------------------------------------------ compact index text (system[2], cached prefix) */
const levelWord = (i) => LEVEL_WORDS[i] ?? "basic";
const clean = (s) => oneLine(s).replace(/\|/g, "/");
/** One line per entry, grouped by kind, sorted. Byte-stable for the same catalogue (no timestamps, no world data). */
export function indexText(cat) {
  const out = [];
  out.push("<catalog>");
  out.push("Installed Invincible content (invincible-core). Use refs exactly as written; get_entries(refs) gives the full rules text. Columns per section header; '-' = none; fx = the item's effects on the sheet (attribute or field change); fx text = no sheet effect (rule in the summary/text); (disabled) = off until switched on in play.");
  const sec = (kind, header, line) => {
    const list = cat.byKind(kind);
    if (!list.length) return;
    out.push(`# ${kind} (${list.length}): ${header}`);
    let group = null;
    for (const e of list) {
      if ((kind === "boost" || kind === "limit") && e.power !== group) { group = e.power; out.push(`@${clean(group) || "-"}`); }
      out.push(line(e));
    }
  };
  sec("power", "ref|name|type|max level (split = one document per level)|summary",
    (e) => `${e.ref}|${clean(e.name)}|${clean(e.type)}|${levelWord(e.maxLevel)}${e.split ? " split" : ""}|${e.summaryText || "-"}`);
  sec("boost", "ref|name|summary, grouped under @power", (e) => `${e.ref}|${clean(e.name)}|${e.summaryText || "-"}`);
  sec("limit", "ref|name|summary, grouped under @power", (e) => `${e.ref}|${clean(e.name)}|${e.summaryText || "-"}`);
  sec("powerSource", "ref|name|summary", (e) => `${e.ref}|${clean(e.name)}|${e.summaryText || "-"}`);
  // W3-13: fx = the item's own effects in short (finding 4: a drawback's stat penalty was invisible in the index)
  // W4-B-2: "text" = effects data read and none changes the sheet (the rule lives in the text); "-" = no effects data (adapter
  // without documents)
  const fx = (e) => fxSummary(e.effects) || (Array.isArray(e.effects) ? "text" : "-");
  sec("talent", "ref|name|fx|summary", (e) => `${e.ref}|${clean(e.name)}|${fx(e)}|${e.summaryText || "-"}`);
  sec("drawback", "ref|name|needs a choice (source/defined/-)|fx|summary", (e) => `${e.ref}|${clean(e.name)}|${e.needs || "-"}|${fx(e)}|${e.summaryText || "-"}`);
  const gearLine = (e) => {
    const g = e.gear ?? {}, a = g.attack;
    const flags = [g.restricted ? "restricted" : "", g.singleUse ? "single-use" : ""].filter(Boolean).join(" ");
    const atk = a ? `atk ${a.bonus >= 0 ? "+" : ""}${a.bonus} dmg ${a.damage}${a.range ? ` rng ${a.range}` : ""}` : "-";
    return `${e.ref}|${clean(e.name)}|${clean(e.type) || "-"}|${g.cost ?? "-"}|${flags || "-"}|${atk}|${e.summaryText || "-"}`;
  };
  sec("gear", "ref|name|group|cost|flags|attack|summary", gearLine);
  sec("vehicleWeapon", "ref|name|group|cost|flags|attack|summary", gearLine);
  sec("archetype", "ref|name|role|summary (book section; get_entries for the full text)", (e) => `${e.ref}|${clean(e.name)}|${clean(e.type) || "-"}|${e.summaryText || "-"}`);
  // W2-4: Resources and the occupation talents on the line (the facts a build needs; saves a get_entries per build)
  sec("occupation", "ref|name|resources|occupation talents|summary (book section)",
    (e) => `${e.ref}|${clean(e.name)}|${Number.isInteger(e.resources) ? e.resources : "-"}|${(e.talents ?? []).map(clean).join(", ") || "-"}|${e.summaryText || "-"}`);
  sec("npcProfile", "ref|name|group|powers (stock NPC actors)", (e) => `${e.ref}|${clean(e.name)}|${clean(e.type) || "-"}|${clean(e.summaryText) || "-"}`);
  // W3-13 (D-8 provisional yes): sample heroes are not listed (not read in dry runs 2 and 3); search_catalog / get_entries keep them
  out.push("</catalog>");
  return out.join("\n");
}

/* ------------------------------------------------------------------ search */
/** Simple token scoring over name / power / type / summary (spec 6: lowercase, accent-insensitive). */
export function search(cat, { query = "", kinds = null, forPower = null, limit = 10 } = {}) {
  const lim = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(limit) ? limit : 10));
  const ks = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  let powerName = null, powerFound = null;
  if (forPower) {
    const p = cat.get(forPower) ?? cat.findByName("power", forPower);
    powerFound = p?.kind === "power";   // PA1: tools.mjs tells "no boosts or limits" from "unknown power"
    powerName = powerFound ? p.name : String(forPower);
  }
  const q = fold(query);
  const toks = q ? [...new Set(q.split(" ").filter((t) => t.length > 1 || /\d/.test(t)))] : [];
  const scored = [];
  for (const e of cat.entries) {
    if (ks && !ks.has(e.kind)) continue;
    if (powerName != null && (e.kind === "boost" || e.kind === "limit") && norm(e.power) !== norm(powerName) && normBase(e.power) !== normBase(powerName)) continue;
    if (powerName != null && !(e.kind === "boost" || e.kind === "limit") && !ks) continue;   // forPower alone = that power's boosts and limits
    let s = 0;
    if (q) {
      const name = fold(e.name), sum = fold(e.summaryText), extra = fold(`${e.power ?? ""} ${e.type ?? ""}`);
      if (name === q) s += 100;
      else if (name.startsWith(q)) s += 60;
      else if (name.includes(q)) s += 40;
      for (const t of toks) {
        if (new RegExp(`\\b${t}`).test(name)) s += 12;
        if (new RegExp(`\\b${t}`).test(extra)) s += 6;
        if (new RegExp(`\\b${t}`).test(sum)) s += 3;
      }
      if (!s) continue;
    }
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || byKindThenName(a.e, b.e));
  return { total: scored.length, results: scored.slice(0, lim).map(({ e }) => briefOf(e)), ...(forPower ? { powerFound } : {}) };
}

/** search result shape: { ref, kind, name, type?, levels?, power?, summary, needs?, gear? } */
export function briefOf(e) {
  const o = { ref: e.ref, kind: e.kind, name: e.name };
  if (e.type) o.type = e.type;
  if (e.kind === "power") o.levels = LEVEL_WORDS.slice(0, e.maxLevel + 1);
  if (e.power) o.power = e.power;
  o.summary = e.summaryText || "";
  if (e.needs) o.needs = e.needs;
  if (e.gear) o.gear = e.gear;
  return o;
}

/* ------------------------------------------------------------------ entry details (get_entries) */
// W2-4: no per-entry slot/cost note any more (it repeated the rules digest in every entry: ~17 % of get_entries text in dry run 2).
// What was entry-specific in it is a field: maxLevel / levels (power), power (boost/limit), needs (drawback), gear.

function actorDetails(data) {
  const sys = data?.system ?? {};
  const attrs = Object.fromEntries(Object.entries(sys.attributes ?? {}).map(([k, v]) => [k, v?.value ?? v]));
  const items = (data?.items ?? []).map((i) => {
    const o = { type: i.type, name: i.name };
    if (i.system?.level) o.level = i.system.level;
    return o;
  });
  const texts = {};
  for (const k of ["role", "occupation", "personality", "drive", "flaw", "appearance"]) if (String(sys[k] ?? "").trim()) texts[k] = cut(oneLine(sys[k]), 300);
  const bio = htmlToText(sys.biography ?? sys.description ?? "");
  return { type: data?.type, attributes: attrs, ...(sys.resources != null ? { resources: sys.resources } : {}), ...(sys.reputation != null ? { reputation: sys.reputation } : {}), texts, items, ...(bio ? { text: cut(bio, 1500) } : {}) };
}

export const LEVEL_TEXT_CAP = 500;   // W4-B-3: one level's own lines in get_entries perLevel
/** split power -> { basic: { fx? }, major: { fx?, text? }, ... }: `fx` = fxSummary of that level document's effects, `text` = the
    level document's lines that the Basic document does not have (cut at LEVEL_TEXT_CAP). A level whose document cannot be read
    is left out. */
export async function levelFacts(e, basicData, source) {
  const baseLines = new Set(htmlToText(basicData?.system?.description ?? e.html).split("\n"));
  const out = {};
  for (const w of LEVEL_WORDS) {
    const id = e.levelDocs?.[w];
    if (!id) continue;
    const d = id === e.id ? basicData : await source.document(e.pack, id);
    if (!d) continue;
    const o = {};
    const fx = fxSummary(effectsOf(d.effects));
    if (fx) o.fx = fx;
    if (id !== e.id) {
      const own = htmlToText(d.system?.description ?? "").split("\n").filter((l) => l && !baseLines.has(l));
      if (own.length) o.text = cut(own.join("\n"), LEVEL_TEXT_CAP);
    }
    out[w] = o;
  }
  return out;
}

/**
 * Full details for up to MAX_REFS refs. `extras.archetype(name)` (optional) adds plus-ultra's structured archetype data (else
 * archetypeFacts). Occupations carry resources + talents (names). No slot note (W2-4).
 * -> { entries:[...], unknown:[ref] }
 */
export async function getEntries(cat, source, refs, { extras = {} } = {}) {
  const list = [...new Set((Array.isArray(refs) ? refs : []).map((r) => String(r ?? "").trim()).filter(Boolean))].slice(0, MAX_REFS);
  const entries = [], unknown = [];
  for (const ref of list) {
    const e = cat.get(ref);
    if (!e) { unknown.push(ref); continue; }
    const o = { ref: e.ref, name: e.name, kind: e.kind };
    if (e.type) o.type = e.type;
    if (e.power) o.power = e.power;
    if (e.needs) o.needs = e.needs;
    if (e.pack === "core-book") {
      o.rulesText = cut(htmlToText(e.html), SECTION_TEXT_CAP);
      if (e.kind === "archetype" && typeof extras.archetype === "function") {
        try {
          const a = await extras.archetype(e.name);
          if (a) o.structured = { role: a.role, attrs: a.attrs, powers: (a.powers ?? []).map((p) => ({ name: p.name, level: LEVEL_WORDS[p.level] ?? p.level, ref: cat.findByName("power", p.name)?.ref ?? null, boosts: (p.boosts ?? []).map((b) => ({ name: b.name, ref: cat.findByName("boost", b.name, { power: p.name })?.ref ?? null })), ...(p.note ? { note: p.note } : {}) })) };
        } catch { /* optional extra */ }
      }
      // W2-4: without plus-ultra (or when it has no data) the same shape from our own reading of the section
      if (e.kind === "archetype" && !o.structured) {
        const a = archetypeFacts(e.html, cat);
        if (a.role || a.powers.length || Object.keys(a.attrs).length) o.structured = { role: a.role || e.type || "", attrs: a.attrs, powers: a.powers };
      }
      if (e.kind === "occupation") { o.resources = Number.isInteger(e.resources) ? e.resources : null; o.talents = e.talents ?? []; }
    } else if (e.kind === "npcProfile" || e.kind === "sampleHero") {
      const data = await source.document(e.pack, e.id);
      if (!data) { unknown.push(ref); continue; }
      Object.assign(o, actorDetails(data));
    } else {
      const data = await source.document(e.pack, e.id);
      if (!data) { unknown.push(ref); continue; }
      o.rulesText = cut(htmlToText(data.system?.description ?? e.html), RULES_TEXT_CAP);
      if (e.kind === "power") {
        // W2-4: the level -> ref map only for split powers (one document per level); others: the highest level
        if (e.split) {
          o.split = true; o.levels = Object.fromEntries(LEVEL_WORDS.filter((w) => e.levelDocs[w]).map((w) => [w, `powers:${e.levelDocs[w]}`]));
          // W4-B-3: what each level gives (dry run 4: only the Basic text was visible). Per level: its effects in short and the
          // lines of its own text that the Basic text (rulesText) does not have; nothing when a level adds nothing.
          o.perLevel = await levelFacts(e, data, source);
        }
        else o.maxLevel = levelWord(e.maxLevel);
        const lv = cat.levelOf(ref);
        if (lv) o.level = lv;
      }
      // W2-4: automations as names only (the copy carries them; numbers that matter are on gear.attack); a script only as a flag
      const autos = automationsOf(data.system);
      if (autos.length) o.automations = autos.map((a) => a.name || a.type);
      const fx = effectsOf(data.effects);
      if (fx.length) o.effects = fx;
      if (String(data.system?.extraConfiguration ?? "").trim() || autos.some((a) => a.script)) o.script = true;
      if (e.gear) {
        const atk = autos.find((a) => a.damage || a.bonus || a.range);
        o.gear = { cost: data.system?.cost ?? e.gear.cost, restricted: !!data.system?.restricted, singleUse: !!data.system?.singleUse, ...(atk ? { attack: { bonus: atk.bonus ?? 0, damage: atk.damage ?? 0, range: atk.range ?? null, ...(atk.bypassArmor ? { bypassArmor: true } : {}) } } : {}) };
      }
    }
    entries.push(o);
  }
  return { entries, unknown };
}

/* ------------------------------------------------------------------ Foundry adapter */
/** Source over the live compendia of invincible-core. Reads only (index, getDocument, journal pages). */
export function foundrySource(game = globalThis.game) {
  const packOf = (name) => game?.packs?.get?.(`${CORE}.${name}`) ?? null;
  return {
    has: (name) => !!packOf(name),
    async index(name, fields) {
      const p = packOf(name);
      if (!p) return [];
      return [...(await p.getIndex({ fields }))];
    },
    folders(name) {
      const p = packOf(name);
      return p ? [...p.folders].map((f) => ({ id: f.id, name: f.name, parent: f.folder?.id ?? null })) : [];
    },
    async document(name, id) {
      const p = packOf(name);
      if (!p) return null;
      const d = await p.getDocument(id);
      return d ? d.toObject() : null;
    },
    /** W3-13: every document of a pack (one request), plain toObject() data */
    async documents(name) {
      const p = packOf(name);
      if (!p) return [];
      return (await p.getDocuments()).map((d) => d.toObject());
    },
    async page(journalId, pageId, pageName) {
      const p = packOf("core-book");
      if (!p) return null;
      const j = await p.getDocument(journalId);
      if (!j || /quickstart/i.test(j.name)) return null;
      const pg = j.pages.get(pageId) ?? j.pages.find((x) => x.name === pageName);
      if (!pg || /quickstart/i.test(pg.name)) return null;
      return { name: pg.name, journal: j.name, html: pg.text?.content ?? "" };
    }
  };
}

/* ------------------------------------------------------------------ cache (memory, per page load; spec 11.2) */
let cached = null;   // { source, promise }
let hooked = false;
export function invalidate() { cached = null; }
/** The catalogue for this page (built once, rebuilt after invincible-core items change). */
export function getCatalog(source = null) {
  const src = source ?? foundrySource();
  if (cached && cached.source === (source ?? "foundry")) return cached.promise;
  const promise = buildCatalog(src).catch((e) => { cached = null; throw e; });
  cached = { source: source ?? "foundry", promise };
  if (!source && !hooked && globalThis.Hooks?.on) {
    hooked = true;
    const inCore = (doc) => String(doc?.pack ?? "").startsWith(`${CORE}.`);
    for (const h of ["createItem", "updateItem", "deleteItem", "createActor", "updateActor", "deleteActor", "updateJournalEntryPage"]) globalThis.Hooks.on(h, (doc) => { if (inCore(doc) || inCore(doc?.parent)) invalidate(); });
  }
  return promise;
}

/** Short pack name -> pack (for refs given as `sources:` etc.). */
export const packOfShort = (short) => SHORT_TO_PACK[short] ?? null;
