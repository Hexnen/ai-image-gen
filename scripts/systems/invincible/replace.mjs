// mode "replace" -> in-place ops (spec 6 `replace`, 8.4 [CHANGED 2026-11-17b]; task T6). PURE: no Foundry globals.
//
// The writer never wipes: a replace proposal is diffed against the actor and turned into addItem / updateItem / removeItem /
// updateActor ops. Items that match an entry of the proposal (same type, same catalogue name; powers by base name, boosts and
// limits under their matched power) are KEPT with their ids; only the difference is written. Gear, vehicle weapons and critical
// injuries are never touched by a replace (plus-ultra's rule for superheroes, also used for NPCs here).
//
// Accepted shapes:
//   superhero: the plus-ultra chargen state (vendored state.mjs) with catalogue `ref`s in place of `packUuid` (spec 6):
//     { rank, attrs{6}, heroName, civilianName, role, appearance, occupation, resources, personality[], drive{name,text}, flaw{...},
//       npcRel, heroRel, team{name,base,where,upgrades[]}, sources:[{key,name,ref?}], powers:[{key,name?,ref?,level:0..3,sourceKey,
//       note?, boosts:[{name?,ref?}], limits:[{name?,ref?,grants?}]}], heroTalent, occTalent, extraTalents[], drawbacks:[{name?,ref?,note?}] }
//   flat (npc, and the validator's replace shape for any actor, proposal.mjs REPLACE): { name, attributes{6}, texts{}, resources?,
//        reputation?, sources?:[{ref|name, key?}], powers:[{ref|name, level, source?(key|name), note?, boosts?:[{ref}], limits?:[{ref}]}],
//          boosts:[{ref|name, power(ref|name|key)}], limits:[...same], talents:[{ref|name}], drawbacks:[{ref|name, note?}],
//          texts:{civilianName, role, appearance, occupation, personality, drive, flaw, relationships}, specialAbilities?: string }
//     specialAbilities is appended to the biography as escaped paragraphs (writer-notes W6).

import * as rules from "./vendor/chargen/rules.mjs";
import { ATTRS, LEVEL_WORDS, norm, normBase, powerLevelOf } from "./reader.mjs";
import { normRef, baseName, noteOf, levelWord, cleanText, writeNote } from "./writer.mjs";

const SIX = ["powerSource", "power", "boost", "limit", "talent", "drawback"];
const listOf = (coll) => (coll == null ? [] : Array.isArray(coll) ? coll : typeof coll.values === "function" ? [...coll.values()] : [...coll]);
const srcOf = (doc) => doc?._source ?? (typeof doc?.toObject === "function" ? doc.toObject() : doc) ?? {};
const msg = (code, message, extra = {}) => ({ code, message, ...extra });

/** catalogue entry of a proposal entry ({ ref } or { name }) */
function entryOf(cat, kind, x, { power = null } = {}) {
  if (!x) return null;
  if (typeof x === "string") x = { name: x };
  if (x.ref) { const e = cat.get(normRef(x.ref)); return e && e.kind === kind ? e : null; }
  if (x.name) return cat.findByName(kind, baseName(x.name), { power }) ?? cat.findByName(kind, x.name, { power });
  return null;
}

/** superhero state -> generic desired build */
function desiredFromState(s) {
  const talents = [s.heroTalent, s.occTalent, ...(s.extraTalents ?? [])].filter(Boolean);
  const fields = {};
  const text = (path, v) => { const t = cleanText(v, path === "name" || path === "system.civilianName" ? 60 : 1200); if (t) fields[path] = t; };
  text("name", s.heroName);
  text("system.civilianName", s.civilianName);
  text("system.role", s.role);
  text("system.appearance", s.appearance);
  for (const k of ATTRS) if (s.attrs?.[k] != null) fields[`system.attributes.${k}.value`] = Number(s.attrs[k]);
  text("system.occupation", s.occupation);
  text("system.personality", (s.personality ?? []).filter(Boolean).join(", "));
  const nt = (x) => (x ? (typeof x === "string" ? x : x.text ? `${x.name}. ${x.text}` : x.name) : "");
  text("system.drive", nt(s.drive));
  text("system.flaw", nt(s.flaw));
  const rel = [];
  if (s.npcRel?.type || s.npcRel?.name) rel.push(`NPC: ${[s.npcRel.name, s.npcRel.type ? `(${s.npcRel.type})` : ""].filter(Boolean).join(" ")}`);
  if (s.heroRel?.name) rel.push(`Hero: ${s.heroRel.name}`);
  text("system.relationships", rel.join("\n"));
  text("system.team", s.team?.name);
  const ups = (s.team?.upgrades ?? []).filter(Boolean);
  const head = [s.team?.base, s.team?.where].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");
  text("system.teamBase", [head, ups.length ? `upgrades: ${ups.join(", ")}` : ""].filter(Boolean).join("; "));
  if (rules.isRank(s.rank)) fields["system.reputation"] = rules.RANKS[s.rank].reputation;
  if (s.resources != null) fields["system.resources"] = Number(s.resources) || 0;
  return {
    sources: (s.sources ?? []).map((x, i) => ({ key: String(x.key ?? `s${i + 1}`), ref: x.ref, name: x.name })),
    powers: (s.powers ?? []).map((p, i) => ({ key: String(p.key ?? `p${i + 1}`), ref: p.ref, name: p.name, level: p.level ?? 0, sourceKey: p.sourceKey ?? null, note: p.note ?? "", boosts: p.boosts ?? [], limits: p.limits ?? [] })),
    talents, drawbacks: s.drawbacks ?? [], fields
  };
}

/** npc proposal -> generic desired build */
function desiredFromNpc(n) {
  const sources = (n.sources ?? []).map((x, i) => ({ key: String(x.key ?? `s${i + 1}`), ref: x.ref, name: x.name }));
  const srcKey = (v) => {
    if (v == null || v === "") return null;
    const hit = sources.find((s) => s.key === String(v) || (s.name && norm(s.name) === norm(v)) || (s.ref && normRef(s.ref) === normRef(v)));
    return hit?.key ?? null;
  };
  const powers = (n.powers ?? []).map((p, i) => ({ key: String(p.key ?? `p${i + 1}`), ref: p.ref, name: p.name, level: p.level ?? 0, sourceKey: srcKey(p.source ?? p.sourceKey), note: p.note ?? "", boosts: [...(p.boosts ?? [])], limits: [...(p.limits ?? [])] }));
  const unattached = [];
  const attach = (list, field) => {
    for (const b of list ?? []) {
      const v = b.power ?? b.powerKey ?? b.powerRef;
      const p = powers.find((x) => x.key === String(v) || (x.ref && v && normRef(x.ref) === normRef(v)) || (x.name && v && norm(baseName(x.name)) === norm(baseName(v))));
      if (p) p[field].push({ ref: b.ref, name: b.name }); else unattached.push({ ...b, field });
    }
  };
  attach(n.boosts, "boosts"); attach(n.limits, "limits");
  const fields = {};
  const text = (path, v) => { const t = cleanText(v, path === "name" ? 60 : 1200); if (t) fields[path] = t; };
  text("name", n.name);
  for (const k of ATTRS) { const v = n.attributes?.[k]; if (v != null) fields[`system.attributes.${k}.value`] = Number(typeof v === "object" ? v.value : v); }
  for (const [k, v] of Object.entries(n.texts ?? {})) if (["civilianName", "role", "appearance", "occupation", "personality", "drive", "flaw", "relationships"].includes(k)) text(`system.${k}`, Array.isArray(v) ? v.join(", ") : v);
  for (const k of ["resources", "reputation"]) if (Number.isInteger(n[k])) fields[`system.${k}`] = n[k];
  if (cleanText(n.specialAbilities, 4000)) fields.biographyAppend = `Special abilities: ${cleanText(n.specialAbilities, 4000)}`;
  return { sources, powers, talents: n.talents ?? [], drawbacks: n.drawbacks ?? [], fields, unattached };
}

/**
 * toOps(actor, proposal, cat, opts) -> { ops, errors, warnings }
 * Deterministic op ids: src-<key>, pow-<key>, pow-<key>-b<n> / -l<n>, tal-<n>, drw-<n>, upd-<itemId>, del-<itemId>, actor.
 */
export function toOps(actor, proposal, cat, opts = {}) {
  const errors = [], warnings = [];
  const ops = [];
  if (!proposal || typeof proposal !== "object") return { ops, errors: [msg("proposal.shape", "replace needs a `proposal` object")], warnings };
  const isNpcShape = proposal.attributes != null || actor?.type === "npc";
  const want = isNpcShape ? desiredFromNpc(proposal) : desiredFromState(proposal);
  for (const u of want.unattached ?? []) errors.push(msg("link.power.required", `${u.field === "boosts" ? "boost" : "limit"} "${u.name ?? u.ref}" names no power of this proposal`));

  const items = listOf(actor?.items).map(srcOf);
  const used = new Set();
  const free = (type) => items.filter((i) => i.type === type && !used.has(i._id));

  // sources
  const srcMap = new Map();   // key -> { itemId } | { opId }
  for (const s of want.sources) {
    const e = entryOf(cat, "powerSource", s);
    const name = e?.name ?? cleanText(s.name, 80);
    if (!name) { errors.push(msg("ref.unknown", `power source ${s.ref ?? s.key} is not in the catalogue`)); continue; }
    const hit = free("powerSource").find((i) => norm(i.name) === norm(name));
    if (hit) { used.add(hit._id); srcMap.set(s.key, { itemId: hit._id }); continue; }
    const opId = `src-${s.key}`;
    if (e) ops.push({ opId, kind: "addItem", ref: e.ref });
    else { ops.push({ opId, kind: "addItem", custom: { type: "powerSource", name } }); warnings.push(msg("source.custom", `power source "${name}" is not in the catalogue: a named custom source is created`, { opId })); }
    srcMap.set(s.key, { opId });
  }
  const srcLink = (key, prefix) => {
    const m = key != null ? srcMap.get(String(key)) : null;
    if (!m) return {};
    return m.itemId ? { [`${prefix}ItemId`]: m.itemId } : { [`${prefix}OpId`]: m.opId };
  };

  // powers + their boosts/limits
  for (const p of want.powers) {
    const e = entryOf(cat, "power", p);
    if (!e) { errors.push(msg("ref.unknown", `power ${p.ref ?? p.name ?? p.key} is not in the catalogue`)); continue; }
    const w = levelWord(p.level) ?? (p.ref ? cat.levelOf(normRef(p.ref)) : null) ?? "basic";
    const note = writeNote(p.note);
    const hit = free("power").find((i) => norm(baseName(i.name)) === norm(e.name));
    let powerLink;
    if (hit) {
      used.add(hit._id);
      const set = {};
      const now = powerLevelOf(hit.system) || "basic";
      if (now !== w) set.level = w;
      if (noteOf(hit.name) !== note) set.note = note;
      const sl = srcLink(p.sourceKey, "powerSource");
      if (sl.powerSourceItemId && sl.powerSourceItemId !== String(hit.system?.powerSource ?? "")) set.powerSourceItemId = sl.powerSourceItemId;
      if (sl.powerSourceOpId) set.powerSourceOpId = sl.powerSourceOpId;
      if (Object.keys(set).length) ops.push({ opId: `upd-${hit._id}`, kind: "updateItem", itemId: hit._id, set });
      powerLink = { powerItemId: hit._id };
    } else {
      const opId = `pow-${p.key}`;
      ops.push({ opId, kind: "addItem", ref: e.ref, level: w, ...srcLink(p.sourceKey, "source"), ...(note ? { note } : {}) });
      powerLink = { powerOpId: opId };
    }
    for (const [field, kind, tag] of [["boosts", "boost", "b"], ["limits", "limit", "l"]]) {
      (p[field] ?? []).forEach((b, n) => {
        const be = entryOf(cat, kind, b, { power: e.name });
        if (!be) { errors.push(msg("ref.unknown", `${kind} ${b.ref ?? b.name} of "${e.name}" is not in the catalogue`)); return; }
        const existing = powerLink.powerItemId ? free(kind).find((i) => String(i.system?.power ?? "") === powerLink.powerItemId && norm(i.name) === norm(be.name)) : null;
        if (existing) { used.add(existing._id); return; }
        ops.push({ opId: `pow-${p.key}-${tag}${n + 1}`, kind: "addItem", ref: be.ref, ...powerLink });
      });
    }
  }

  // talents and drawbacks (multisets by base name; drawback notes updated in place)
  want.talents.forEach((t, n) => {
    const e = entryOf(cat, "talent", t);
    if (!e) { errors.push(msg("ref.unknown", `talent ${t?.ref ?? t?.name ?? t} is not in the catalogue`)); return; }
    const hit = free("talent").find((i) => norm(baseName(i.name)) === norm(e.name));
    if (hit) { used.add(hit._id); return; }
    ops.push({ opId: `tal-${n + 1}`, kind: "addItem", ref: e.ref, ...(t?.note ? { note: writeNote(t.note) } : {}) });
  });
  want.drawbacks.forEach((d, n) => {
    const e = entryOf(cat, "drawback", d);
    if (!e) { errors.push(msg("ref.unknown", `drawback ${d?.ref ?? d?.name ?? d} is not in the catalogue`)); return; }
    const note = writeNote(d?.note ?? (d?.name ? noteOf(d.name) : ""));
    const hit = free("drawback").find((i) => norm(baseName(i.name)) === norm(e.name));
    if (hit) {
      used.add(hit._id);
      if (noteOf(hit.name) !== note) ops.push({ opId: `upd-${hit._id}`, kind: "updateItem", itemId: hit._id, set: { note } });
      return;
    }
    ops.push({ opId: `drw-${n + 1}`, kind: "addItem", ref: e.ref, ...(note ? { note } : {}) });
  });

  // everything of the six creation types that the proposal does not name goes
  for (const i of items) if (SIX.includes(i.type) && !used.has(i._id)) ops.push({ opId: `del-${i._id}`, kind: "removeItem", itemId: i._id });

  // actor fields: only what differs; empty texts are never written
  const set = {};
  const src = srcOf(actor);
  for (const [path, v] of Object.entries(want.fields)) {
    if (path === "biographyAppend") { set[path] = v; continue; }
    const cur = path.split(".").reduce((o, k) => o?.[k], src);
    if (JSON.stringify(cur ?? null) !== JSON.stringify(v)) set[path] = v;
  }
  if (Object.keys(set).length) ops.push({ opId: "actor", kind: "updateActor", set });
  if (!ops.length) warnings.push(msg("replace.same", "The proposal matches the sheet; nothing to write."));
  return { ops, errors, warnings };
}

export { LEVEL_WORDS };
