// Invincible read tools (spec 6 tool table; task T4): search_catalog, get_entries, read_rules, read_document.
// All read-only; none writes a document. check_proposal / submit_proposal belong to the validate group (T5) and are added to
// the pack's tool list by pack.mjs when that group exists (see readToolDefs + pack.tools()).
//
// Schemas are STATIC (cached prefix, spec 9.1): no world data, deterministic key order. Strict tool use (spec 5.1): every
// object has additionalProperties:false and a required list. The strict grammar does not support numeric / length / array
// size constraints (claude-api skill: "Numerical constraints, string constraints, complex array constraints" unsupported), so
// limits (<= 8 refs, <= 25 results, part >= 1) are stated in the descriptions and enforced here.
//
// Results are plain JSON-serialisable objects; the harness sends them as compact JSON text (toolResultText). A bad input is
// an ok:false result with a hint (the model can fix it); only an internal failure throws (harness -> is_error).

import { KINDS, MAX_REFS, MAX_RESULTS, search, getEntries, htmlToText, cut, oneLine, automationFacts, effectsOf, refToUuid } from "./catalog.mjs";
import { TOPIC_KEYS, readRules } from "./rules-digest.mjs";

export const READ_TOOL_NAMES = Object.freeze(["get_entries", "read_document", "read_rules", "search_catalog"]);
export const DOC_FIELDS = Object.freeze(["description", "automations", "effects", "system"]);
export const DEEP_TEXT_CAP = 8000;     // read_document: one item's full description
export const RESULT_CAP = 16000;       // read_document: whole result (chars of JSON)

/** Tool definitions (sorted by name; the transport sorts too). */
export function readToolDefs() {
  return [
    {
      name: "get_entries",
      description: "Full details of catalogue entries by ref (at most 8 refs per call): the rules text of the item as the book gives it, levels (split-level powers: one ref per level), automations (numbers only), effects, what a drawback needs, and a slot/cost note. Archetype and occupation refs return their book section; npc/sampleHero refs return the actor's attributes and items. Read an entry before you pick it unless you already read it in this conversation.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["refs"],
        properties: { refs: { type: "array", items: { type: "string" }, description: "Refs exactly as in the catalogue, e.g. \"powers:<id>\". At most 8." } }
      },
      strict: true
    },
    {
      name: "read_document",
      description: "Deep fields that the <sheet> block leaves out, or another world document. NOT for this sheet's normal state: that is already in your context. Use it (1) for full descriptions, automation details or effect changes of items on this sheet (target \"this\" + itemIds), or (2) to read another world actor or item the GM names (target = its exact name or uuid). Read-only.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", description: "\"this\" for the open sheet, or a world Actor/Item name or uuid." },
          itemIds: { type: "array", items: { type: "string" }, description: "Embedded item ids (as in the sheet block). Omit for the document itself." },
          fields: { type: "array", items: { type: "string", enum: [...DOC_FIELDS] }, description: "Which deep fields to return; default: description and automations." }
        }
      },
      strict: true
    },
    {
      name: "read_rules",
      description: "Read one whitelisted page of the core rulebook as plain text, in parts of up to 6,000 characters (part 1 first; the result says how many parts there are). Use it for rules the digest only summarises: archetypes and occupations in full, growth, gear, weapons, vehicles, NPCs, minions.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["topic"],
        properties: {
          topic: { type: "string", enum: [...TOPIC_KEYS] },
          part: { type: "integer", description: "1-based part number; default 1." }
        }
      },
      strict: true
    },
    {
      name: "search_catalog",
      description: "Search the installed catalogue by name and summary (case- and accent-insensitive). Returns refs to use in get_entries and proposals. forPower narrows boosts and limits to one power (power name or ref); with an empty query it lists all of that power's boosts and limits.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Words to look for; may be empty when kinds or forPower narrow the list." },
          kinds: { type: "array", items: { type: "string", enum: [...KINDS] }, description: "Only these kinds; default all." },
          forPower: { type: "string", description: "Power name or ref: only its boosts/limits." },
          limit: { type: "integer", description: "Max results, 1-25; default 10." }
        }
      },
      strict: true
    }
  ];
}

/** Compact JSON for the tool_result text. */
export const toolResultText = (obj) => JSON.stringify(obj);

const bad = (code, message, hint) => ({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
const strArr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string") : []);

/* ------------------------------------------------------------------ read_document */
function deepItem(item, fields) {
  const sys = item?.system ?? {};
  const o = { itemId: item?._id ?? item?.id, type: item?.type, name: item?.name };
  if (fields.includes("description")) o.description = cut(htmlToText(sys.description ?? ""), DEEP_TEXT_CAP);
  if (fields.includes("automations")) o.automations = Object.values(sys.automations ?? {}).map(automationFacts).filter(Boolean);
  if (fields.includes("effects")) o.effects = effectsOf(item?.effects);
  if (fields.includes("system")) {
    const rest = {};
    for (const [k, v] of Object.entries(sys)) {
      if (k === "description" || k === "automations") continue;
      if (k === "extraConfiguration") { if (String(v ?? "").trim()) rest.script = true; continue; }
      rest[k] = v;
    }
    o.system = rest;
  }
  return o;
}

/** Fallback compact header when the sheet group (T12 snapshot) is not available. */
function miniSheet(data) {
  const sys = data?.system ?? {};
  const lines = [`${data?.type ?? "?"} "${oneLine(data?.name)}"`];
  const attrs = Object.entries(sys.attributes ?? {}).map(([k, v]) => `${k} ${v?.value ?? v}`);
  if (attrs.length) lines.push(`ATTR ${attrs.join(" ")}`);
  for (const k of ["role", "occupation", "personality", "drive", "flaw", "appearance"]) if (String(sys[k] ?? "").trim()) lines.push(`TEXT ${k}="${cut(oneLine(sys[k]), 300)}"`);
  for (const i of data?.items ?? []) lines.push(`I ${i._id} ${i.type} "${oneLine(i.name)}"${i.system?.level ? ` lvl=${i.system.level}` : ""}`);
  return lines.join("\n");
}

const plain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

/** Resolve target to a document. "this" -> ctx.doc; uuid -> world Actor/Item; name -> unique world actor or item. */
async function resolveTarget(target, ctx) {
  const t = String(target ?? "").trim();
  if (!t) return { error: bad("doc.target", "target is empty.", "Use \"this\" or a world document name.") };
  if (t === "this") return ctx?.doc ? { doc: ctx.doc, self: true } : { error: bad("doc.none", "No document is open.") };
  const game = ctx?.game ?? globalThis.game;
  const user = game?.user;
  const visible = (d) => !!d && (typeof d.testUserPermission !== "function" || d.testUserPermission(user, "OBSERVER"));
  if (/^(Actor|Item)\.[A-Za-z0-9]{16}(\.Item\.[A-Za-z0-9]{16})?$/.test(t)) {
    let d = null;
    try { d = (ctx?.fromUuid ?? globalThis.fromUuid)?.(t); d = await d; } catch { d = null; }
    if (!d || d.pack || !visible(d)) return { error: bad("doc.notFound", `No visible world document ${t}.`) };
    return { doc: d, self: d === ctx?.doc };
  }
  if (/^Compendium\./.test(t)) return { error: bad("doc.compendium", "Compendium documents are read with get_entries (catalogue refs).") };
  const n = t.toLowerCase();
  const hits = [...(game?.actors ?? []), ...(game?.items ?? [])].filter((d) => String(d?.name ?? "").trim().toLowerCase() === n && visible(d));
  if (!hits.length) return { error: bad("doc.notFound", `No world actor or item named "${t}".`, "Use the exact name, or ask the GM.") };
  if (hits.length > 1) return { error: bad("doc.ambiguous", `${hits.length} world documents are named "${t}".`, `Use a uuid: ${hits.slice(0, 6).map((d) => d.uuid).join(", ")}`) };
  return { doc: hits[0], self: hits[0] === ctx?.doc };
}

export async function readDocument(input, ctx = {}, { snapshot = null } = {}) {
  const r = await resolveTarget(input?.target, ctx);
  if (r.error) return r.error;
  const fields = strArr(input?.fields).filter((f) => DOC_FIELDS.includes(f));
  const use = fields.length ? fields : ["description", "automations"];
  const ids = strArr(input?.itemIds);
  const doc = r.doc;
  const data = plain(doc);
  const docName = doc?.documentName ?? (data?.items ? "Actor" : "Item");
  const out = { ok: true, target: r.self ? "this" : (doc?.uuid ?? data?._id), documentName: docName, name: data?.name, type: data?.type };
  if (docName === "Item") {
    out.item = deepItem(data, use);
  } else {
    if (r.self && !ids.length) return bad("doc.self", "This sheet is already in your context.", "Name itemIds for deep fields, or ask for effects with fields:[\"effects\"] and itemIds.");
    if (!r.self) {
      let sheet = null;
      if (typeof snapshot === "function") { try { sheet = (await snapshot(doc, { liveForm: false }))?.text ?? null; } catch { sheet = null; } }
      out.sheet = sheet ?? miniSheet(data);
    }
    const items = data?.items ?? [];
    const pick = ids.map((id) => items.find((i) => i._id === id) ?? id);   // no ids on another actor: its sheet text only
    const missing = pick.filter((x) => typeof x === "string");
    out.items = pick.filter((x) => typeof x !== "string").map((i) => deepItem(i, use));
    if (missing.length) out.unknownItemIds = missing;
    if (use.includes("effects")) out.actorEffects = effectsOf(data?.effects);
  }
  let text = JSON.stringify(out);
  if (text.length > RESULT_CAP && out.items?.length) {
    // shrink descriptions evenly until the result fits (explicit marker kept by cut())
    const per = Math.max(400, Math.floor((RESULT_CAP - (text.length - out.items.reduce((a, i) => a + (i.description?.length ?? 0), 0))) / out.items.length));
    for (const i of out.items) if (i.description) i.description = cut(i.description, per);
    out.note = "descriptions shortened to fit; ask for fewer itemIds to read one in full";
  }
  return out;
}

/* ------------------------------------------------------------------ dispatcher */
/**
 * makeReadTools({ getCatalog, source, extras, snapshot }) -> { defs(), run(name, input, ctx) }
 *   getCatalog(): Promise<Catalog>, source: catalog source adapter, extras: { archetype(name) } (plus-ultra, optional),
 *   snapshot(doc, opts): the sheet group's serializer (optional, T12).
 */
export function makeReadTools({ getCatalog, source, extras = {}, snapshot = null } = {}) {
  const run = async (name, input = {}, ctx = {}) => {
    switch (name) {
      case "search_catalog": {
        const cat = await getCatalog();
        const kinds = strArr(input.kinds);
        const badKinds = kinds.filter((k) => !KINDS.includes(k));
        if (badKinds.length) return bad("search.kind", `Unknown kinds: ${badKinds.join(", ")}.`, `Kinds: ${KINDS.join(", ")}.`);
        const query = typeof input.query === "string" ? input.query : "";
        const forPower = typeof input.forPower === "string" && input.forPower.trim() ? input.forPower.trim() : null;
        if (!query.trim() && !kinds.length && !forPower) return bad("search.empty", "Empty search.", "Give words, kinds or forPower.");
        const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(MAX_RESULTS, input.limit)) : 10;
        const r = search(cat, { query, kinds: kinds.length ? kinds : null, forPower, limit });
        return { ok: true, total: r.total, shown: r.results.length, results: r.results };
      }
      case "get_entries": {
        const refs = strArr(input.refs);
        if (!refs.length) return bad("entries.none", "No refs.", "Pass refs from the catalogue or search_catalog.");
        const cat = await getCatalog();
        const r = await getEntries(cat, source, refs, { extras });
        const res = { ok: true, entries: r.entries };
        if (r.unknown.length) res.unknownRefs = r.unknown;
        if (refs.length > MAX_REFS) res.note = `only the first ${MAX_REFS} refs were read`;
        return res;
      }
      case "read_rules": {
        const part = Number.isInteger(input.part) ? input.part : 1;
        return readRules(source, { topic: input.topic, part });
      }
      case "read_document":
        return readDocument(input, ctx, { snapshot });
      default:
        return null;   // not a read tool
    }
  };
  return { defs: readToolDefs, run, refToUuid };
}
