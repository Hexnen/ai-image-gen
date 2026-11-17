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
    apply: (doc, proposal, opts) => writer.apply(doc, proposal, opts),
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
