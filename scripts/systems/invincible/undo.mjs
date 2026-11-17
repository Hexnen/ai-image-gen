// Undo journal of the Invincible in-place writer (spec 11.2, 7.5 point 5; task T6). PURE: no Foundry globals.
//
// Journal = flags.moinens-ai-gen.undo = { v: 1, runs: [Run] }   (newest last; at most UNDO_RUNS runs, none older than UNDO_TTL)
//   Run   = { runId, at, by, label, ops: [Entry] }
//   Entry = { opId, kind, itemId, type, name, before, after, paths?, cascadeOf?, dependsOn?, undone? }
//     kind "add"    : before = null, after = fingerprint of the created item          undo = delete the item
//     kind "update" : before = full _source before, paths = changed paths, after = fp   undo = write the before values of `paths` back
//     kind "swap"   : before = full _source of the replaced level document, after = fp  undo = delete + re-create `before` with keepId
//     kind "remove" : before = full _source, after = null                               undo = re-create `before` with keepId (same id)
//     kind "actor"  : itemId = null, paths, before = { path: value | null }, after = { path: value }   undo = write the before values
//                     (also the item drawer's own fields: then the paths are the item's)
//     kind "world"  : uuid = a world item the run created (target "newItem"), after = fp        undo = delete that item
//     kind "order"  : opId "_order", itemId = null, ids = the talents the run re-created (keepId) to put them in the replace
//                     proposal's order (W5-A-3); no source is stored. undo = the run's whole `order` is restored (below).
//   Run.order (W5-A-2) = ids of the actor's items in collection order BEFORE the run. Undo and rollback put the items back in
//   that order (talent roles hang on it: first = hero, second = occupation; W2-3) by re-creating, with keepId and their current
//   source, the items from the first out-of-order position on (restoreTarget / movePlan). Runs written before W5-A have no
//   `order`: their undo works as before (re-created items land at the end).
//   `cascadeOf` = opId of the removeItem op that caused this removal; `dependsOn` = opId of the add op this add was linked to
//   (a boost added under a power added in the same run). Both make per-item undo take the group together.
// Game data only (spec 10.4): never conversation text.

import { stableJson, hash, getPath } from "./reader.mjs";

export const UNDO_TTL = 24 * 3600 * 1000;
export const UNDO_RUNS = 10;
/** journal size cap in JSON chars (actor data syncs to every client that sees the actor); oldest runs go first */
export const JOURNAL_LIMIT = 400_000;

export const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** stable fingerprint of a document source: ignores _stats at ANY depth (the item's and its embedded effects' createdTime /
    modifiedTime change when an undo re-creates the item with keepId) and the item's sort (drag order on the sheet) */
export function fingerprint(src) {
  if (!src || typeof src !== "object") return null;
  const { _stats, sort, ...rest } = src;
  return hash(stableJson(dropStats(rest)));
}
const dropStats = (v) => {
  if (Array.isArray(v)) return v.map(dropStats);
  if (!v || typeof v !== "object") return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) if (k !== "_stats") o[k] = dropStats(x);
  return o;
};

/** the journal of a document source (always a fresh object, never the stored one) */
export function readJournal(src) {
  const j = getPath(src, "flags.moinens-ai-gen.undo");
  const runs = Array.isArray(j?.runs) ? j.runs.filter((r) => r && r.runId && Array.isArray(r.ops)) : [];
  const out = clone(runs);
  for (const r of out) for (const e of r.ops) if (e.kind === "actor" && Array.isArray(e.paths)) { e.before = byPaths(e.before, e.paths); e.after = byPaths(e.after, e.paths); }
  return { v: 1, runs: out };
}
/** Foundry expands dotted keys inside a stored flag ({"system.x.value": 1} is saved as {system:{x:{value:1}}}): actor entries
    are read back as flat { path: value } maps from their `paths`, whichever shape was stored */
function byPaths(obj, paths) {
  if (obj == null) return obj;
  const out = {};
  for (const p of paths) out[p] = Object.prototype.hasOwnProperty.call(obj, p) ? obj[p] : (getPath(obj, p) ?? null);
  return out;
}

/** drop expired and fully undone runs, keep the newest UNDO_RUNS, then cut oldest until the JSON fits JOURNAL_LIMIT.
    The newest run always stays (even alone over the limit: without it the GM could not undo what just happened). */
export function pruneJournal(journal, now = Date.now()) {
  let runs = (journal?.runs ?? []).filter((r) => now - (Number(r.at) || 0) <= UNDO_TTL && r.ops.some((e) => !e.undone));
  runs = runs.slice(-UNDO_RUNS);
  const dropped = [];
  while (runs.length > 1 && JSON.stringify(runs).length > JOURNAL_LIMIT) dropped.push(runs.shift().runId);
  return { journal: { v: 1, runs }, dropped };
}

/** the run to act on: by id, else the newest one with something left to undo */
export function findRun(journal, runId = null) {
  const runs = journal?.runs ?? [];
  if (runId) return runs.find((r) => r.runId === runId) ?? null;
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].ops.some((e) => !e.undone)) return runs[i];
  return null;
}

/**
 * Entries to undo for a per-item request (opIds), closed over the group rules:
 *  - an add takes every add that depends on it (boost under an added power, power under an added source), transitively;
 *  - a remove takes its cascade (entries with cascadeOf = that opId);
 *  - a restored remove takes the removed link target of the same run (a boost whose power was removed by another op), so the
 *    restored item never points at a missing id.
 * No opIds = the whole run. Already undone entries are never returned.
 */
export function selectEntries(run, opIds = null) {
  const live = run.ops.filter((e) => !e.undone);
  if (!opIds || !opIds.length) return live;
  const pick = new Set();
  const want = new Set(opIds);
  const add = (e) => { if (!pick.has(e)) { pick.add(e); return true; } return false; };
  for (const e of live) if (want.has(e.opId)) add(e);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of live) {
      if (pick.has(e)) continue;
      const take = [...pick].some((p) =>
        (p.kind === "add" && e.kind === "add" && e.dependsOn === p.opId) ||
        (p.kind === "remove" && e.kind === "remove" && e.cascadeOf === p.opId && !p.cascadeOf) ||
        (p.kind === "remove" && e.kind === "remove" && linkTarget(p.before) === e.itemId));
      if (take) grew = add(e) || grew;
    }
  }
  return live.filter((e) => pick.has(e));
}
/** id an item source links to (power -> source, boost/limit -> power) */
export function linkTarget(src) {
  if (!src) return null;
  if (src.type === "power") return src.system?.powerSource || null;
  if (src.type === "boost" || src.type === "limit") return src.system?.power || null;
  return null;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Drift of entries against the current document: what changed after the run wrote it.
 * items = Map(id -> current source) of the actor's items; actorSrc = actor _source.
 * -> [{ opId, itemId, name, why: "edited"|"missing"|"exists"|"field", path? }]
 */
export function driftOf(entries, items, actorSrc) {
  const out = [];
  for (const e of entries) {
    if (e.kind === "actor") {
      for (const [path, v] of Object.entries(e.after ?? {})) {
        if (!sameJson(getPath(actorSrc, path), v)) out.push({ opId: e.opId, itemId: null, name: path, why: "field", path });
      }
      continue;
    }
    if (e.kind === "world") continue;   // a world item created by the run: checked by the writer (async lookup)
    if (e.kind === "order") continue;   // only positions: the re-created talents keep id and source (their own entries carry drift)
    const cur = items.get(e.itemId);
    if (e.kind === "remove") {
      if (cur) out.push({ opId: e.opId, itemId: e.itemId, name: e.name, why: "exists" });
      continue;
    }
    if (!cur) out.push({ opId: e.opId, itemId: e.itemId, name: e.name, why: "missing" });
    else if (e.after && fingerprint(cur) !== e.after) out.push({ opId: e.opId, itemId: e.itemId, name: cur.name ?? e.name, why: "edited" });
  }
  return out;
}

/** order of the reverse writes for a set of entries (reverse of the apply phases) */
const RESTORE_TYPE_ORDER = ["powerSource", "power", "boost", "limit", "talent", "drawback", "gear", "vehicleWeapon", "criticalInjury"];
export function undoOrder(entries) {
  const typeRank = (e) => { const i = RESTORE_TYPE_ORDER.indexOf(e.type); return i < 0 ? 99 : i; };
  return {
    actor: entries.filter((e) => e.kind === "actor").reverse(),
    restore: entries.filter((e) => e.kind === "remove").sort((a, b) => typeRank(a) - typeRank(b)),
    reverse: entries.filter((e) => e.kind === "update").reverse(),
    swap: entries.filter((e) => e.kind === "swap").reverse(),
    remove: entries.filter((e) => e.kind === "add").sort((a, b) => typeRank(b) - typeRank(a))
  };
}

/* ------------------------------------------------------------------ collection order (W5-A-2, W5-A-3) */
/**
 * The order the items should have after an undo / rollback.
 *   current: ids now on the actor (collection order); runOrder: ids before the run; pending: ids about to be re-created (not on
 *   the actor yet: restored removals, swapped level documents); full: true = the whole run is undone (every item of the run's
 *   `order` goes back to its old place), false = per-item undo (only the `pending` items go back to their old place, next to
 *   their old predecessor; everything else keeps its current position).
 * Items not in runOrder (added after the run, or by the run and not undone) follow the pre-run items in their current order.
 * -> target ids (every current and pending id once)
 */
export function restoreTarget(current, runOrder, pending = [], full = true) {
  const rank = new Map((runOrder ?? []).map((id, i) => [String(id), i]));
  const cur = (current ?? []).map(String), pend = (pending ?? []).map(String).filter((id) => !cur.includes(id));
  const extraPend = pend.filter((id) => !rank.has(id));
  if (full) {
    const present = new Set([...cur, ...pend]);
    return [...runOrder.map(String).filter((id) => present.has(id)), ...cur.filter((id) => !rank.has(id)), ...extraPend];
  }
  const place = new Set(pend.filter((id) => rank.has(id)));
  const out = cur.filter((id) => !place.has(id));
  for (const p of [...place].sort((a, b) => rank.get(a) - rank.get(b))) {
    let at = -1;
    for (let i = rank.get(p) - 1; i >= 0 && at < 0; i--) at = out.indexOf(String(runOrder[i]));
    out.splice(at + 1, 0, p);
  }
  return [...out, ...extraPend];
}
/**
 * Minimal re-creation that turns `current` into `target` when re-created items always land at the end (Foundry: a created
 * embedded document is appended to the collection; v14 keeps that order on the parent and after a reload, W2-3).
 * keep = the longest prefix of target that already stands in that order in current (other items may sit between them: they
 * move); move = the rest of target, to be (re-)created in this order. Deterministic. `current` may lack ids of target
 * (pending re-creations): they are always moved.
 * -> { keep: [ids], move: [ids] }
 */
export function movePlan(current, target) {
  const t = (target ?? []).map(String);
  let j = 0;
  for (const id of (current ?? []).map(String)) if (j < t.length && id === t[j]) j++;
  return { keep: t.slice(0, j), move: t.slice(j) };
}

/** a short, UI-safe view of the journal for undoStatus (no sources) */
export function describeRun(run, now = Date.now(), drift = []) {
  const byOp = new Map();
  for (const d of drift) { if (!byOp.has(d.opId)) byOp.set(d.opId, []); byOp.get(d.opId).push(d); }
  const ops = [];
  const seen = new Set();
  for (const e of run.ops) {
    if (e.undone) continue;
    const key = `${e.opId}:${e.itemId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push({ opId: e.opId, kind: e.kind, itemId: e.itemId ?? null, type: e.type ?? null, name: e.name ?? "", ...(e.cascadeOf ? { cascadeOf: e.cascadeOf } : {}), ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}), drift: (byOp.get(e.opId) ?? []).filter((d) => d.itemId === (e.itemId ?? null)).map((d) => d.why) });
  }
  return { runId: run.runId, at: run.at, age: now - (Number(run.at) || 0), label: run.label ?? "", ops };
}
