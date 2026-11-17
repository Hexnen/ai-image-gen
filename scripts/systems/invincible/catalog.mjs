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
//   page(journalId, pageId, pageName)  -> { name, journal, html } | null                  (core-book journal pages only)
//
// Refs: `<short>:<documentId>` (spec 6: "pack short name + document id"), e.g. `powers:Ab12...`; archetypes and occupations
// are sections of a book page: `archetype:<slug>`, `occupation:<slug>`. The harness maps refs to UUIDs with refToUuid().

import { setPowerMaxLevels } from "./vendor/chargen/rules.mjs";

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

/** Cut text at `cap` chars with an explicit marker (spec 6: "(truncated, N chars)"). */
export function cut(text, cap) {
  const s = String(text ?? "");
  if (s.length <= cap) return s;
  return `${s.slice(0, cap).replace(/\s+\S*$/, "")} (truncated, ${s.length} chars)`;
}

/** Name normalisation identical in spirit to plus-ultra's catalog.norm + accent folding for search. */
export const norm = (s) => String(s ?? "").replace(/­/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export const normBase = (s) => norm(String(s ?? "").replace(/\s*\([^)]*\)\s*$/, ""));
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
/** Effects -> [{ name, disabled?, changes:[{key, type, value}] }] (v14 `type`, older `mode`). */
export function effectsOf(effects) {
  return (Array.isArray(effects) ? effects : []).map((e) => ({
    name: e?.name ?? "",
    ...(e?.disabled ? { disabled: true } : {}),
    changes: (e?.changes ?? []).map((c) => ({ key: c.key, type: c.type ?? c.mode, value: c.value }))
  }));
}

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
      entries.push({ kind, name, id: slug(name), pack: "core-book", html: s.html, ...(role ? { type: role } : {}) });
    }
  }
  for (const e of entries) {
    e.ref = `${KIND_INFO[e.kind].short}:${e.id}`;
    if (e.summaryText == null) e.summaryText = summaryOf(htmlToText(e.html));
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
      const r = String(ref ?? "").trim();
      return byRef.get(r) ?? levelRef.get(r)?.power ?? null;
    },
    levelOf: (ref) => levelRef.get(String(ref ?? "").trim())?.level ?? null,
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
  out.push("Installed Invincible content (invincible-core). Use refs exactly as written; get_entries(refs) gives the full rules text. Columns per section header; '-' = none.");
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
  sec("talent", "ref|name|summary", (e) => `${e.ref}|${clean(e.name)}|${e.summaryText || "-"}`);
  sec("drawback", "ref|name|needs a choice (source/defined/-)|summary", (e) => `${e.ref}|${clean(e.name)}|${e.needs || "-"}|${e.summaryText || "-"}`);
  const gearLine = (e) => {
    const g = e.gear ?? {}, a = g.attack;
    const flags = [g.restricted ? "restricted" : "", g.singleUse ? "single-use" : ""].filter(Boolean).join(" ");
    const atk = a ? `atk ${a.bonus >= 0 ? "+" : ""}${a.bonus} dmg ${a.damage}${a.range ? ` rng ${a.range}` : ""}` : "-";
    return `${e.ref}|${clean(e.name)}|${clean(e.type) || "-"}|${g.cost ?? "-"}|${flags || "-"}|${atk}|${e.summaryText || "-"}`;
  };
  sec("gear", "ref|name|group|cost|flags|attack|summary", gearLine);
  sec("vehicleWeapon", "ref|name|group|cost|flags|attack|summary", gearLine);
  sec("archetype", "ref|name|role|summary (book section; get_entries for the full text)", (e) => `${e.ref}|${clean(e.name)}|${clean(e.type) || "-"}|${e.summaryText || "-"}`);
  sec("occupation", "ref|name|summary (book section)", (e) => `${e.ref}|${clean(e.name)}|${e.summaryText || "-"}`);
  sec("npcProfile", "ref|name|group|powers (stock NPC actors)", (e) => `${e.ref}|${clean(e.name)}|${clean(e.type) || "-"}|${clean(e.summaryText) || "-"}`);
  sec("sampleHero", "ref|name|powers (finished sample heroes, a guide to conventions)", (e) => `${e.ref}|${clean(e.name)}|${clean(e.summaryText) || "-"}`);
  out.push("</catalog>");
  return out.join("\n");
}

/* ------------------------------------------------------------------ search */
/** Simple token scoring over name / power / type / summary (spec 6: lowercase, accent-insensitive). */
export function search(cat, { query = "", kinds = null, forPower = null, limit = 10 } = {}) {
  const lim = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(limit) ? limit : 10));
  const ks = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  let powerName = null;
  if (forPower) {
    const p = cat.get(forPower) ?? cat.findByName("power", forPower);
    powerName = p?.kind === "power" ? p.name : String(forPower);
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
  return { total: scored.length, results: scored.slice(0, lim).map(({ e }) => briefOf(e)) };
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
const SLOT_NOTE = {
  power: (e) => `Basic level = 1 power slot; each level above Basic is 1 more slot (this power goes up to ${levelWord(e.maxLevel)}). New heroes: up to Major, Massive only at Cosmic Champion, never Monstrous.`,
  boost: (e) => `1 power slot; belongs to the power "${e.power}".`,
  limit: (e) => `Belongs to the power "${e.power}"; it does not cost a slot itself but pays for one level or one boost of that power (which then costs no slot).`,
  powerSource: () => "The first power source is free; each extra one costs 1 attribute point. Every power names one of the hero's sources.",
  talent: () => "A hero starts with 2 free talents (hero talent + occupation talent); each extra talent costs 1 attribute point. Most talents only once.",
  drawback: (e) => `Each drawback gives +1 attribute point; at most 2.${e.needs === "source" ? " Name the affected power source in the note." : e.needs === "defined" ? " Define the specifics in the note." : ""}`,
  gear: (e) => `Costs ${e.gear?.cost ?? "?"} against the hero's Resources${e.gear?.restricted ? "; restricted" : ""}${e.gear?.singleUse ? "; single use" : ""}.`,
  vehicleWeapon: (e) => `Vehicle weapon; cost ${e.gear?.cost ?? "?"}${e.gear?.restricted ? "; restricted" : ""}.`,
  archetype: () => "Book suggestion, not a rule: attributes and powers here already fit a Global Guardian budget.",
  occupation: () => "Sets the hero's Resources and offers the occupation talents.",
  npcProfile: () => "Stock NPC: free-form creation, no point budget.",
  sampleHero: () => "Finished sample hero, a guide to conventions (read-only)."
};

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

/**
 * Full details for up to MAX_REFS refs. `extras.archetype(name)` (optional) adds plus-ultra's structured archetype data.
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
    } else if (e.kind === "npcProfile" || e.kind === "sampleHero") {
      const data = await source.document(e.pack, e.id);
      if (!data) { unknown.push(ref); continue; }
      Object.assign(o, actorDetails(data));
    } else {
      const data = await source.document(e.pack, e.id);
      if (!data) { unknown.push(ref); continue; }
      o.rulesText = cut(htmlToText(data.system?.description ?? e.html), RULES_TEXT_CAP);
      if (e.kind === "power") {
        o.levels = e.split
          ? Object.fromEntries(LEVEL_WORDS.filter((w) => e.levelDocs[w]).map((w) => [w, `powers:${e.levelDocs[w]}`]))
          : Object.fromEntries(LEVEL_WORDS.slice(0, e.maxLevel + 1).map((w) => [w, e.ref]));
        if (e.split) o.splitLevels = "one document per level: add the level's ref";
        const lv = cat.levelOf(ref);
        if (lv) o.level = lv;
      }
      const autos = automationsOf(data.system);
      if (autos.length) o.automations = autos;
      const fx = effectsOf(data.effects);
      if (fx.length) o.effects = fx;
      if (String(data.system?.extraConfiguration ?? "").trim()) o.script = true;
      if (e.gear) o.gear = { cost: data.system?.cost ?? e.gear.cost, restricted: !!data.system?.restricted, singleUse: !!data.system?.singleUse };
    }
    o.slotNote = SLOT_NOTE[e.kind]?.(e) ?? "";
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
