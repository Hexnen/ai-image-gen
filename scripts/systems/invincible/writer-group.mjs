// Writer capability group of the Invincible pack (registry contract "writer": plan / apply / undo / undoStatus; task T6), plus
// the optional selfTest hook and the plus-ultra bridge. Kept out of pack.mjs so parallel tasks only touch their own group there.
// Foundry globals are read lazily (inside the functions), never at import time.

import { createWriter, selectOps } from "./writer.mjs";
import { toOps } from "./replace.mjs";
import { createBridge } from "./pu-bridge.mjs";
import { readLiveForm } from "./reader.mjs";
import { getCatalog, refToUuid } from "./catalog.mjs";

/**
 * writerGroup(getPack, deps) -> { plan, apply, undo, undoStatus, selfTest, plusUltra, selectOps }
 *   getPack(): the pack object (its `validate`, when the validate group exists, is re-run by apply on the current actor)
 *   deps: overrides for tests ({ game, getCatalog, fetchData, ... } as in createWriter / createBridge)
 */
/** the chargen state shape (spec 6 replace for superheroes; plus-ultra state with refs) vs the validator's flat replace shape */
export const isStateShape = (p) => !!p && (p.attrs != null || p.heroName != null || p.heroTalent != null || (p.powers ?? []).some((x) => x && x.sourceKey != null));

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o[k]]));
const shortMsg = (m) => (m && typeof m === "object" ? pick(m, ["code", "message", "hint", "opId", "itemId", "path"]) : { message: String(m ?? "") });
const shortBudget = (b) => {
  if (!b || typeof b !== "object") return null;
  if (b.kind) return pick(b, ["kind", "note"]);
  const side = (x) => (x && typeof x === "object" ? pick(x, ["points", "spent", "slots", "rankPowers", "cap", "note"]) : null);
  return { before: side(b.before), after: side(b.after) };
};

/**
 * The pack's apply result (W2-7): what the drawer and a stand-in need, without the plan / projected actor.
 * -> { ok, runId, message, ops: [{ opId, action, type, name, itemId, outcome, because?, cascade? }],
 *      budget: { before: { points, spent, slots, rankPowers, cap }, after: {...} } | { kind, note } | null,
 *      warnings: [{ code, message, ... }], errors: [...], created, updated, deleted, idMap,
 *      needsConfirm?, confirm?: [{ opId, action, name }] (what confirmed:true would allow), stale?, unsaved?, busy?, rolledBack? }
 *   outcome: "written" | "unchanged" (noop) | "dropped" (deselected / partial selection, `because`) | "not written" (ok false)
 */
export function conciseApplyResult(r) {
  if (!r || typeof r !== "object") return r;
  const p = r.plan ?? null;
  const idMap = r.idMap ?? {};
  const ops = (p?.ops ?? []).map((o) => ({
    opId: o.opId, action: o.action, type: o.type, name: o.name,
    itemId: o.itemId ?? (typeof idMap[o.opId] === "string" ? idMap[o.opId] : null),
    outcome: !r.ok ? "not written" : o.action === "noop" ? "unchanged" : "written",
    ...(o.cascade?.length ? { cascade: o.cascade.map((c) => c.name) } : {})
  }));
  for (const d of p?.dropped ?? []) ops.push({ opId: d.opId, outcome: "dropped", because: d.because });
  const out = {
    ok: r.ok === true, runId: r.runId ?? null, message: r.message ?? "", ops, budget: shortBudget(r.budget),
    // a refused validation keeps its own warnings (e.g. rank.defaulted) only in r.validation: merged here
    warnings: [...new Map([...(r.warnings ?? []), ...(r.validation?.warnings ?? [])].map(shortMsg).map((w) => [`${w.code}|${w.message}|${w.opId ?? ""}`, w])).values()],
    errors: (r.errors ?? []).map(shortMsg),
    created: r.created ?? [], updated: r.updated ?? [], deleted: r.deleted ?? [], idMap
  };
  if (r.needsConfirm) {
    out.needsConfirm = true;
    out.confirm = [...(p?.deletes ?? []).map((d) => ({ opId: d.opId, action: "remove", name: d.name })), ...(p?.swaps ?? []).map((s) => ({ opId: s.opId, action: "swap", name: s.name }))];
  }
  for (const k of ["stale", "unsaved", "busy", "rolledBack"]) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

export function writerGroup(getPack, deps = {}) {
  const game = () => deps.game ?? globalThis.game;
  const catalog = deps.getCatalog ?? (() => getCatalog());
  // replace -> ops: the SAME converter the validator used (proposal.mjs replaceToOps, T5) for its shape, so the ops the GM
  // previewed and the ops written agree; replace.mjs for the chargen-state shape and when the validator's module is missing.
  let puConv = null;
  const loadConv = () => (puConv ??= import("./proposal.mjs").then((m) => (typeof m.replaceToOps === "function" ? m.replaceToOps : null)).catch(() => null));
  const pickToOps = async (doc, proposal, cat, opts) => {
    const conv = isStateShape(proposal) ? null : await loadConv();
    if (typeof conv === "function") {
      try { const r = conv(doc, proposal, { catalog: cat, rank: opts?.rank, profile: opts?.profile }); return { ops: r.ops ?? [], errors: (r.errors ?? []).map((e) => ({ ...e, message: e.message ?? `${e.code} ${e.path ?? ""}`.trim() })), warnings: r.warnings ?? [] }; }
      catch (e) { return { ops: [], errors: [{ code: "replace.failed", message: String(e?.message ?? e) }], warnings: [] }; }
    }
    return toOps(doc, proposal, cat, opts);
  };
  const writer = createWriter({
    getCatalog: catalog,
    async fetchData(uuid) {
      const doc = await globalThis.fromUuid?.(uuid);
      return doc ? doc.toObject() : null;
    },
    toOps: pickToOps,
    isGM: () => !!game()?.user?.isGM,
    userId: () => game()?.user?.id ?? "?",
    userName: (id) => game()?.users?.get?.(id)?.name ?? "?",
    liveForm: (doc) => readLiveForm(doc),
    validate: (doc, proposal, opts) => {
      const p = getPack();
      return typeof p?.validate === "function" ? p.validate(doc, proposal, opts) : null;
    },
    randomID: () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18),
    createWorldItem: (data) => globalThis.CONFIG.Item.documentClass.create(data),
    fromUuid: (uuid) => globalThis.fromUuid?.(uuid),
    ...deps
  });
  const bridge = createBridge({ game, getCatalog: catalog, refToUuid, ...(deps.bridge ?? {}) });

  return {
    plan: (doc, proposal, opts) => writer.plan(doc, proposal, opts),
    // concise result by default (W2-7, D-I: the full one carries plan.projected, ~25 KB); { verbose: true } = the writer's full result
    apply: async (doc, proposal, opts = {}) => {
      const { verbose = false, ...rest } = opts ?? {};
      const r = await writer.apply(doc, proposal, rest);
      return verbose ? r : conciseApplyResult(r);
    },
    undo: (doc, runId, opts) => writer.undo(doc, runId, opts),
    undoStatus: (doc) => writer.undoStatus(doc),
    /** spec 3.3 version guard: only plus-ultra's extras depend on it; without plus-ultra there is nothing to test */
    async selfTest() {
      if (!bridge.status().active) return { ok: true, skipped: true, plusUltra: bridge.status() };
      const r = await bridge.selfTest();
      return r.ok ? { ok: true, plusUltra: bridge.status() } : { ok: false, error: `plus-ultra extras off: ${r.error}`, plusUltra: bridge.status() };
    },
    plusUltra: bridge,
    selectOps
  };
}
