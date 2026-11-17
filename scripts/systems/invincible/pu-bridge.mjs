// Soft bridge to invincible-plus-ultra (spec 3.3, 3.4 option c, 8.1, O21; task T6). Invincible only, never required.
//
// What it offers when plus-ultra is active and passes the self-test, and what happens without it:
//   fullRebuild.{plan, apply, undo, undoStatus}  "Pełna przebudowa (plus-ultra)" / "Full rebuild (plus-ultra)": plus-ultra's
//        destructive chargen apply for a superhero (its own lock, 24 h undo, team-base cards). The ONLY place the builder calls it
//        (O5/O21); every other write is the in-place writer. Without plus-ultra: { ok:false, unavailable:true }.
//   openWizard(actor, state?) / canOpenWizard(actor)   "Open in wizard": plus-ultra's wizard for the actor (the state is passed
//        along; plus-ultra 0.20.2 ignores it until spec 8.3 item 2 / T9). Without plus-ultra: canOpenWizard = false (button hidden).
//   lists(kind) -> [{ name, data? }]   archetype / occupation lists of the plus-ultra provider (book-parsed at runtime). Without it:
//        [] (the model reads the book pages through read_rules instead, spec 3.4).
//   installWizardButton(openBuilder)   adds an "Open in builder" button to plus-ultra's wizard window header (DOM hook on
//        renderApplicationV2, idempotent); returns an uninstall function. No-op without plus-ultra or without Hooks.
//   selfTest()   the version guard of spec 3.3: API shape + a write-free plan call that must refuse a non-superhero with
//        WrongType. A failed self-test switches every extra off (status().usable = false), the pack keeps working.
// Never throws to the caller; every entry point degrades to a plain "unavailable" result.

import { createState } from "./vendor/chargen/state.mjs";
import { LEVEL_WORDS } from "./reader.mjs";
import { normRef } from "./writer.mjs";

export const PU_MODULE = "invincible-plus-ultra";
const WIZARD_PREFIX = "ipc-chargen-";

export function createBridge({ game = () => globalThis.game, getCatalog = null, refToUuid = null, hooks = () => globalThis.Hooks, log = console } = {}) {
  let tested = null;   // { ok, error? }

  const mod = () => { try { const m = game()?.modules?.get?.(PU_MODULE); return m?.active ? m : null; } catch { return null; } };
  const chargen = () => mod()?.api?.chargen ?? null;
  const shapeOk = (c) => !!c && typeof c.apply?.plan === "function" && typeof c.apply?.apply === "function" && typeof c.apply?.undo === "function" && typeof c.apply?.undoStatus === "function";

  function status() {
    const m = mod();
    const c = chargen();
    return {
      active: !!m, version: m?.version ?? null, api: shapeOk(c),
      selfTest: tested, usable: !!m && shapeOk(c) && tested?.ok !== false,
      wizard: typeof c?.open === "function", lists: typeof c?.provider === "function"
    };
  }

  async function selfTest() {
    const c = chargen();
    if (!mod()) return (tested = { ok: false, error: "plus-ultra is not active" });
    if (!shapeOk(c)) return (tested = { ok: false, error: "plus-ultra chargen API is incomplete" });
    try {
      const r = await c.apply.plan({ type: "npc", name: "moinens-ai-gen self-test", isOwner: true, items: [] }, createState({ seed: "000000" }));
      const ok = r && r.ok === false && (r.errors ?? []).some((e) => e.code === "WrongType");
      tested = ok ? { ok: true } : { ok: false, error: "plan() did not refuse a non-superhero with WrongType" };
    } catch (e) { tested = { ok: false, error: String(e?.message ?? e) }; }
    return tested;
  }
  const usable = () => status().usable;

  /* ---------- our replace state (catalogue refs) -> plus-ultra state (packUuid) */
  async function toPuState(state) {
    const cat = await getCatalog();
    const fill = (x, kind) => {
      if (!x) return x;
      const e = x.ref ? cat.get(normRef(x.ref)) : null;
      const out = { ...x, name: x.name ?? e?.name ?? "", packUuid: e ? refToUuid(cat, normRef(x.ref)) : (x.packUuid ?? null) };
      delete out.ref;
      if (kind === "power" && e?.split) {
        const w = LEVEL_WORDS[x.level ?? 0] ?? "basic";
        if (e.levelDocs?.[w]) out.packUuid = `Compendium.invincible-core.powers.Item.${e.levelDocs[w]}`;
      }
      return out;
    };
    const base = createState({ seed: state.seed ?? "000000", rank: state.rank, mode: "manual" });
    return {
      ...base, ...state,
      sources: (state.sources ?? []).map((s) => fill(s, "powerSource")),
      powers: (state.powers ?? []).map((p) => ({ ...fill(p, "power"), boosts: (p.boosts ?? []).map((b) => fill(b, "boost")), limits: (p.limits ?? []).map((l) => fill(l, "limit")) })),
      heroTalent: fill(state.heroTalent, "talent"), occTalent: fill(state.occTalent, "talent"),
      extraTalents: (state.extraTalents ?? []).map((t) => fill(t, "talent")), drawbacks: (state.drawbacks ?? []).map((d) => fill(d, "drawback"))
    };
  }
  const unavailable = (why) => ({ ok: false, unavailable: true, errors: [{ code: "pu.unavailable", message: `Full rebuild needs invincible-plus-ultra: ${why}.` }], message: `Full rebuild needs invincible-plus-ultra: ${why}.` });
  const whyNot = () => { const s = status(); return !s.active ? "not active" : !s.api ? "its API is incomplete" : `self-test failed (${s.selfTest?.error ?? "?"})`; };
  const stateOf = (proposal) => proposal?.proposal ?? proposal?.state ?? proposal;

  const fullRebuild = {
    available: (actor) => usable() && actor?.type === "superhero",
    async plan(actor, proposal) {
      if (!usable()) return unavailable(whyNot());
      if (actor?.type !== "superhero") return { ok: false, errors: [{ code: "doc.type", message: "Full rebuild is for superheroes only." }] };
      try { return await chargen().apply.plan(actor, await toPuState(stateOf(proposal))); }
      catch (e) { log?.warn?.("moinens-ai-gen | plus-ultra plan failed", e); return { ok: false, errors: [{ code: "pu.failed", message: String(e?.message ?? e) }] }; }
    },
    async apply(actor, proposal, { confirmed = false, expect = null } = {}) {
      if (!game()?.user?.isGM) return { ok: false, errors: [{ code: "user.notGM", message: "Only the GM writes with the builder." }] };
      if (!usable()) return unavailable(whyNot());
      try { return await chargen().apply.apply(actor, await toPuState(stateOf(proposal)), { confirmed, expect }); }
      catch (e) { log?.warn?.("moinens-ai-gen | plus-ultra apply failed", e); return { ok: false, errors: [{ code: "pu.failed", message: String(e?.message ?? e) }] }; }
    },
    async undo(actor, { confirmDrift = false } = {}) {
      if (!usable()) return unavailable(whyNot());
      try { return await chargen().apply.undo(actor, { confirmDrift }); }
      catch (e) { return { ok: false, errors: [{ code: "pu.failed", message: String(e?.message ?? e) }] }; }
    },
    undoStatus(actor) {
      if (!usable()) return { available: false, unavailable: true };
      try { return chargen().apply.undoStatus(actor); } catch { return { available: false }; }
    }
  };

  function canOpenWizard(actor) {
    if (!usable() || actor?.type !== "superhero") return false;
    const c = chargen();
    if (typeof c?.open !== "function") return false;
    try { return typeof c.canUse === "function" ? !!c.canUse(actor) : true; } catch { return false; }
  }
  async function openWizard(actor, state = null) {
    if (!canOpenWizard(actor)) return null;
    try { return await chargen().open(actor, state ? { state: await toPuState(state) } : {}); }
    catch (e) { log?.warn?.("moinens-ai-gen | opening the plus-ultra wizard failed", e); return null; }
  }

  async function lists(kind) {
    if (!usable()) return [];
    const key = kind === "archetype" || kind === "archetypes" ? "archetypes" : kind === "occupation" || kind === "occupations" ? "occupations" : null;
    if (!key) return [];
    try {
      const P = chargen().provider?.() ?? chargen().catalog?.provider?.();
      const l = await P?.list?.(key, {});
      return (l ?? []).filter((e) => e?.name).map((e) => ({ name: String(e.name), ...(e.data ? { data: e.data } : {}) }));
    } catch (e) { log?.warn?.("moinens-ai-gen | plus-ultra lists failed", e); return []; }
  }

  function installWizardButton(openBuilder, { label = "Open in builder", icon = "fa-solid fa-robot" } = {}) {
    const H = hooks();
    if (!H?.on || typeof openBuilder !== "function") return () => {};
    const id = H.on("renderApplicationV2", (app, element) => {
      try {
        if (!usable() || !String(app?.id ?? "").startsWith(WIZARD_PREFIX)) return;
        const actor = app.actor ?? app.document;
        if (!actor || !game()?.user?.isGM) return;
        const header = (element ?? app.element)?.querySelector?.(".window-header");
        if (!header || header.querySelector("[data-maig-open-builder]")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `header-control icon ${icon}`;
        btn.dataset.maigOpenBuilder = "";
        btn.dataset.tooltip = label;
        btn.setAttribute("aria-label", label);
        btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); try { openBuilder(actor); } catch (e) { log?.warn?.(e); } });
        const anchor = header.querySelector('[data-action="close"]');
        if (anchor) anchor.before(btn); else header.append(btn);
      } catch (e) { log?.warn?.("moinens-ai-gen | wizard button failed", e); }
    });
    return () => { try { H.off("renderApplicationV2", id); } catch { /* gone */ } };
  }

  return { status, selfTest, fullRebuild, canOpenWizard, openWizard, lists, installWizardButton, _toPuState: toPuState };
}
