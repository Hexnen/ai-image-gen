// The AI builder drawer (spec 4; task T7): a frameless ApplicationV2 docked outside the right edge of an actor sheet (left
// edge when there is no room), GM only, only while the system pack is ready and supports the actor. It drives
// api.build.openSession(actor) (harness.mjs) and the pack's validate / apply / undo / undoStatus (writer group).
// Loaded by a dynamic import from module.mjs (GM branch of `ready`); a failure here never touches image generation.
//
// Entry points: a header button on supported actor sheets (fa-robot, idempotent, re-checked on every render) and a 3-dot entry
// (getHeaderControlsActorSheetV2); api.build.openDrawer(actor) opens it from code. There is no side tab (W5-E): closed, the
// drawer is hidden (or closed) and the header button carries its state (pressed = open, dot = proposal waiting, pulse = working).
// View-model: drawer-model.mjs (pure, node-tested). Template: templates/builder-drawer.hbs (one file, one branch per part).
// Styles: styles/builder-drawer.css.

import { MODULE_ID } from "../constants.mjs";
import * as M from "./drawer-model.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const TEMPLATE = `modules/${MODULE_ID}/templates/builder-drawer.hbs`;
const ICON = "fa-solid fa-robot";
const PU = "invincible-plus-ultra";

const L = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const api = () => game.modules.get(MODULE_ID)?.api ?? null;
const build = () => api()?.build ?? null;
const getPack = () => build()?.registry?.getPack?.() ?? null;

/** drawers by sheet application id (one drawer per sheet window; the session is per actor) */
const drawers = new Map();

/** May the GM open the builder on this actor (pack ready, actor type supported, writable)? */
export function canUse(actor) {
  if (!game.user?.isGM || !actor || actor.documentName !== "Actor" || !actor.id) return false;
  const sup = build()?.registry?.supports?.(actor);
  return !!sup && sup.kind === "actor" && sup.canWrite !== false;
}

/** Rank the pack falls back to for this actor (plus-ultra's chargen flag, else the pack's default). */
function defaultRankOf(actor, ranks) {
  const flag = actor?.flags?.[PU]?.chargen?.rank;
  if (flag && ranks.some((r) => r.key === flag)) return flag;
  return ranks.find((r) => r.isDefault)?.key ?? "global";
}

const sheetOf = (app) => (app?.document?.documentName === "Actor" && app.element ? app : null);
const isSheetOf = (app, actor) => app?.document === actor && app.rendered && app.element?.isConnected;

export class BuilderDrawer extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["maig-drawer"],
    tag: "aside",
    window: { frame: false, positioned: false },
    actions: {
      collapse: BuilderDrawer.#onCollapse,
      send: BuilderDrawer.#onSend,
      stop: BuilderDrawer.#onStop,
      newConversation: BuilderDrawer.#onNewConversation,
      apply: BuilderDrawer.#onApply,
      discard: BuilderDrawer.#onDiscard,
      undo: BuilderDrawer.#onUndo,
      dismiss: BuilderDrawer.#onDismiss,
      openSettings: BuilderDrawer.#onOpenSettings
    }
  };

  static PARTS = {
    head: { template: TEMPLATE },
    log: { template: TEMPLATE, scrollable: [""] },
    card: { template: TEMPLATE, scrollable: [""] },
    composer: { template: TEMPLATE }
  };

  /** Open (or focus) the drawer of a sheet. */
  static async openFor(sheet, { open = true } = {}) {
    if (!sheet?.document || !canUse(sheet.document)) return null;
    let d = drawers.get(sheet.id);
    if (!d) { d = new BuilderDrawer(sheet); drawers.set(sheet.id, d); }
    if (open) d.isOpen = true;
    try {
      await d.ready();
      // the sheet closed (or another drawer took its place) while the session opened: never render an orphan (bughunt-2 #14)
      if (!sheet.rendered || drawers.get(sheet.id) !== d) { d.#discard(); return null; }
      await d.render({ force: true });
    } catch (e) {
      // a failed ready() / render must not leave a dead, "open" drawer in the map (bughunt-2 #6): forget it, say so once
      d.#discard();
      console.error(`${MODULE_ID} | AI builder drawer failed to open`, e);
      if (open) ui.notifications?.error?.(L("MAIG.Drawer.OpenFailed", { error: String(e?.message ?? e) }), { console: false });
      syncHeaderState(sheet);
      return null;
    }
    if (open) d.focusInput();
    return d;
  }

  /** drop a drawer that never became usable: out of the map, unsubscribed, closed */
  #discard() {
    if (drawers.get(this.sheet?.id) === this) drawers.delete(this.sheet.id);
    this.isOpen = false;
    this.#unsub?.();
    this.#unsub = null;
    this.close({ animate: false }).catch(() => {});
  }

  constructor(sheet) {
    super({ id: `${MODULE_ID}-builder-${foundry.utils.randomID(8)}` });
    this.sheet = sheet;
    this.actor = sheet.document;
    this.isOpen = false;
  }

  /** "apply" | "undo" | "discard" while the drawer writes (header button state) */
  get working() { return this.#working; }

  /** Closed but still worth keeping (hidden, subscribed): a proposal waits or a turn / write runs; the header button shows it. */
  get keepAlive() { return !!this.pendingCard || !!this.session?.busy || !!this.#working; }

  /**
   * Open / close from the header button or the title-bar X. Closed: hidden at once; kept (subscribed) while keepAlive,
   * else forgotten at once and closed without animation (a closing app answered the next click in the live check).
   */
  async setOpen(open) {
    this.isOpen = !!open;
    if (this.isOpen) {
      await this.render({ parts: ["head", "log", "card", "composer"] });
      this.focusInput();
    } else {
      this.element?.classList.remove("open");
      this.dock();
      if (!this.keepAlive) {
        if (drawers.get(this.sheet?.id) === this) drawers.delete(this.sheet.id);
        syncHeaderState(this.sheet);
        await this.close({ animate: false });
        return;
      }
    }
    syncHeaderState(this.sheet);
  }

  session = null;
  #unsub = null;
  #readyP = null;
  #observers = [];
  #hooks = [];
  #onWinResize = () => this.dock();
  #draft = "";
  #sent = null;            // text of a send in flight until the harness stored it ("user-message")
  #focusInput = false;
  #stick = true;
  #flash = null;           // { level, text, items: [string] } banner from a drawer action
  #live = null;            // running turn: { start, requests, tools, usd, text, toolName, toolChars }
  #preview = null;         // { key, v, plan, error, at } validation preview of the card proposal
  #previewP = null;
  #previewKey = "";
  #working = null;         // "apply" | "undo" | "discard" while the drawer writes
  #timer = null;
  #renderQ = new Set();
  #renderT = null;
  #sheetRenders = 0;
  #details = new Map();    // open state of <details data-key> across part renders (bughunt-2 #3)
  #announced = -1;         // conversation rows already announced to screen readers (-1 = first render, announce nothing)
  #liveEl = null;          // stable visually-hidden live region (the log part itself is replaced on every render)
  lastWriteStats = null;   // { kind, sheetRenders, forced, ms } of the last Apply / Undo (live check, W5-T7)

  /** Open the session once (IndexedDB restore) and subscribe to its events. */
  ready() {
    this.#readyP ??= (async () => {
      const b = build();
      if (!b?.openSession) throw new Error("builder harness not loaded");
      this.session = await b.openSession(this.actor);
      this.#unsub = this.session.on("*", (data, type) => this.#onEvent(type, data));
      if (this.session.busy) this.#live ??= { start: Date.now(), requests: 0, tools: 0, usd: 0, text: "" };
      this.session.prewarm?.().catch?.(() => {});
    })();
    this.#readyP.catch(() => { this.#readyP = null; });   // a failure is not cached: the next click tries again
    return this.#readyP;
  }

  get pendingCard() {
    const s = this.session;
    if (!s) return null;
    return M.cardProposal(s.pendingProposal, s.proposals, s.transcript());
  }

  /* ------------------------------------------------------------------------------------------------ context */

  async _prepareContext() {
    const b = build();
    const pack = getPack();
    const s = this.session;
    const ranks = b?.ranks?.() ?? [];
    const opts = s?.options ?? {};
    const defRank = defaultRankOf(this.actor, ranks);
    const eff = M.effectiveOptions(opts, defRank);
    const items = s ? s.transcript() : [];
    const states = s?.proposals ?? [];
    const rows = M.conversationRows(items, { states, L });
    const card = this.pendingCard;
    const usage = this.#usageVm();
    const sup = b?.registry?.supports?.(this.actor);
    const dry = b?.dry ?? null;
    let hasKey = true;
    if (!dry) { try { hasKey = !!String(api()?.getKey?.("anthropic") ?? "").trim(); } catch { hasKey = false; } }
    let undo = null;
    try { undo = M.undoView(pack?.undoStatus?.(this.actor), L); } catch { undo = null; }

    // card: validation preview (cached per proposal + options + sheet version)
    let cardVm = null;
    if (card) {
      const key = `${card.proposalId}|${eff.rank}|${eff.profile}`;
      if (this.#previewKey !== key || !this.#preview) this.#refreshPreview(card, eff, key);
      const pv = this.#preview?.key === key ? this.#preview : null;
      const v = pv?.v ?? null;
      const sum = M.summaryRows(v?.summary ?? card.summary ?? "", v?.opInfo ?? {});
      cardVm = {
        id: card.proposalId, restored: card.restored, checking: !pv,
        ok: v ? v.ok !== false : null,
        ops: sum.ops, extra: sum.extra, opCount: sum.ops.length,
        budget: M.budgetRows(v?.budget, L),
        errors: M.issueRows(v?.errors), warnings: M.issueRows(v?.warnings ?? card.warnings), info: M.issueRows(v?.info),
        confirm: (v?.applyConfirm ?? []).map(String),
        // W5-A-3: the talents the writer re-creates into the proposal's order (plan.reorders; only a replace)
        reorders: M.reorderRows(pv?.reorders, L),
        previewError: pv?.error ?? null,
        rankName: ranks.find((r) => r.key === eff.rank)?.name ?? eff.rank,
        profileName: L(`MAIG.Drawer.Profile.${eff.profile}`)
      };
    }
    const busy = !!s?.busy;
    return {
      appId: this.id,
      isOpen: this.isOpen, busy, working: this.#working, anyBusy: busy || !!this.#working,
      title: L("MAIG.Drawer.Title"),
      actorName: this.actor.name,
      packLabel: pack?.label ?? pack?.id ?? "",
      mode: sup?.mode ? L(`MAIG.Drawer.Mode.${sup.mode}`) : "",
      ranks: M.rankOptions(ranks, opts.rank ?? "", defRank, L),
      profiles: M.profileOptions(opts.profile ?? "", L),
      profileHint: L(`MAIG.Drawer.Profile.hint.${eff.profile}`),
      rankIsDefault: !opts.rank, profileIsDefault: !opts.profile,
      dry: !!dry, noKey: !dry && !hasKey,
      flash: this.#flash,
      rows, empty: !rows.length && !busy,
      live: this.#live ? {
        text: M.renderText(this.#live.text), elapsed: M.fmtElapsed(Date.now() - this.#live.start),
        request: this.#live.requests, tool: this.#live.toolName ? L("MAIG.Drawer.Live.tool", { name: this.#live.toolName, chars: M.fmtTokens(this.#live.toolChars ?? 0) }) : "",
        fixRound: !!this.#live.fixRound
      } : null,
      card: cardVm, hasCard: !!cardVm, undo, hasUndo: !!undo?.available,
      usage, draft: this.#draft,
      sendLabel: L("MAIG.Drawer.Send"), stopLabel: L("MAIG.Drawer.Stop")
    };
  }

  /** the usage line of the composer (also refreshed in place by #syncComposer during a turn) */
  #usageVm() {
    const s = this.session;
    if (!s) return null;
    let caps = {};
    try { caps = build()?.harness?.settings?.() ?? {}; } catch { caps = {}; }
    try { return M.usageView(s.usage(), caps, this.#live, L, { model: s.record?.model, effort: s.record?.effort }); }
    catch { return null; }
  }

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    context.part = { [partId]: true };
    return context;
  }

  /* ------------------------------------------------------------------------------------------------ preview */

  #refreshPreview(card, eff, key) {
    this.#previewKey = key;
    const pack = getPack();
    const run = (async () => {
      let v = null, error = null;
      try { v = typeof pack?.validate === "function" ? await pack.validate(this.actor, card.input, { rank: eff.rank, profile: eff.profile }) : null; }
      catch (e) { error = String(e?.message ?? e); }
      let expect = null, reorders = [];
      try {
        const p = typeof pack?.plan === "function" ? await pack.plan(this.actor, card.input, { rank: eff.rank, profile: eff.profile }) : null;
        expect = p?.expect ?? null;
        reorders = Array.isArray(p?.reorders) ? p.reorders : [];
      } catch { expect = null; reorders = []; }
      if (this.#previewKey !== key) return;
      this.#preview = { key, v, expect, reorders, error, at: Date.now() };
      this.#queue("card");
    })();
    this.#previewP = run;
    return run;
  }

  /** the preview must be redone (sheet changed, options changed, new proposal) */
  #invalidatePreview() { this.#previewKey = ""; this.#preview = null; }

  /* ------------------------------------------------------------------------------------------------ events */

  #onEvent(type, data) {
    switch (type) {
      case "turn-start":
        this.#live = { start: Date.now(), requests: 0, tools: 0, usd: 0, text: "" };
        this.#flash = null;
        this.#queue("log", "composer", "head");
        this.#tick(true);
        break;
      case "request-start":
        if (this.#live) { this.#live.requests = data?.request ?? this.#live.requests + 1; this.#live.text = ""; this.#live.toolName = ""; }
        this.#queue("log", "composer");
        break;
      case "stream":
        if (!this.#live) break;
        if (data?.type === "text") { this.#live.text += String(data.text ?? ""); this.#queue("log"); }
        else if (data?.type === "tool_input" || data?.type === "block_start" && data.blockType === "tool_use") {
          this.#live.toolName = data.name ?? this.#live.toolName; this.#live.toolChars = data.chars ?? 0; this.#queue("log");
        }
        break;
      case "request-end":
        if (this.#live) this.#live.usd += Number(data?.usd ?? 0);
        this.#queue("composer");
        break;
      case "assistant-message":
        if (this.#live) { this.#live.text = ""; this.#live.toolName = ""; }
        this.#queue("log");
        break;
      case "tool-start":
        if (this.#live) this.#live.tools++;
        this.#queue("log", "composer");
        break;
      case "fix-round": // W5-B-1: an accepted submit had warnings to fix; the harness sends one more request
        if (this.#live) this.#live.fixRound = true;
        this.#queue("log");
        break;
      case "user-message":
        this.#sent = null;   // the GM's text is in the conversation now: nothing to give back (bughunt-2 #2)
        this.#queue("log");
        break;
      case "tool-end": case "notice": case "submit-failed":
        this.#queue("log");
        break;
      case "proposal":
        this.#invalidatePreview();
        this.#queue("log", "card");
        break;
      case "turn-end":
        this.#live = null;
        this.#tick(false);
        this.#queue("log", "card", "composer", "head");
        break;
      case "conversation":
        this.#invalidatePreview();
        this.#flash = null;
        this.#details.clear();
        this.#announced = -1;
        this.#queue("log", "card", "composer", "head");
        break;
      case "state":
        this.#queue("composer");
        break;
      default: break;
    }
  }

  /** batch partial renders (stream events arrive many per second) */
  #queue(...parts) {
    for (const p of parts) this.#renderQ.add(p);
    if (this.#renderT) return;
    this.#renderT = setTimeout(() => {
      this.#renderT = null;
      let list = [...this.#renderQ];
      this.#renderQ.clear();
      if (!this.rendered) return;
      // the composer is never re-rendered for state changes (bughunt-2 #4): the textarea keeps value, caret, height and an
      // IME composition; only the send/stop swap, the disabled state and the usage line change, in place
      if (list.includes("composer") && this.#syncComposer()) list = list.filter((p) => p !== "composer");
      if (list.length) this.render({ parts: list }).catch((e) => console.warn(`${MODULE_ID} | drawer render`, e));
    }, 80);
  }

  /** elapsed clock while a turn runs: updates the text only, never re-renders */
  #tick(on) {
    clearInterval(this.#timer);
    this.#timer = null;
    if (!on) return;
    this.#timer = setInterval(() => {
      const el = this.element?.querySelector?.("[data-role=elapsed]");
      if (el && this.#live) el.textContent = M.fmtElapsed(Date.now() - this.#live.start);
    }, 1000);
  }

  /* ------------------------------------------------------------------------------------------------ render / dock */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    window.addEventListener("resize", this.#onWinResize);
    const el = this.sheet.element;
    if (el) {
      if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => this.dock()); ro.observe(el); this.#observers.push(ro); }
      // a move (setPosition writes left/top), bringToFront (z-index) and minimise (class) change attributes only
      const mo = new MutationObserver(() => this.dock());
      mo.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
      this.#observers.push(mo);
    }
    // the sheet's own renders (live check: does it follow writes by itself?) and changes of the actor (card, undo row)
    const on = (name, fn) => this.#hooks.push([name, Hooks.on(name, fn)]);
    on("renderApplicationV2", (app) => { if (app === this.sheet) { this.#sheetRenders++; this.dock(); } });
    const mine = (doc) => doc === this.actor || doc?.parent === this.actor;
    for (const h of ["updateActor", "createItem", "updateItem", "deleteItem"]) {
      on(h, (doc) => {
        if (!mine(doc) || this.#working) return;
        this.#invalidatePreview();
        this.#queue("card");
      });
    }
    this.element.addEventListener("pointerdown", () => { try { this.sheet.bringToFront(); } catch { /* frameless */ } }, { capture: true });
    // <details> open state survives part renders (toggle does not bubble: capture on the stable root)
    this.element.addEventListener("toggle", (ev) => {
      const d = ev.target;
      if (d?.tagName === "DETAILS" && d.dataset.key) this.#details.set(d.dataset.key, d.open);
    }, { capture: true });
    // Esc inside the drawer closes the drawer only (Foundry's Esc would close the sheet window with it); focus goes back
    // to the header button. An IME composition keeps its Esc.
    this.element.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || ev.isComposing || ev.defaultPrevented) return;
      ev.preventDefault();
      ev.stopPropagation();
      BuilderDrawer.#onCollapse.call(this);
    });
    // landmark name + a live region that part renders do not replace (bughunt-2 #9)
    this.element.setAttribute("aria-labelledby", `${this.id}-title`);
    const live = document.createElement("div");
    live.className = "visually-hidden";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.dataset.role = "announce";
    this.element.append(live);
    this.#liveEl = live;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const parts = options.parts ?? Object.keys(this.constructor.PARTS);
    const el = this.element;
    el.classList.toggle("open", !!this.isOpen);
    el.classList.toggle("is-busy", !!context.anyBusy);
    if (parts.includes("composer")) this.#wireComposer();
    if (parts.includes("head")) this.#wireHead();
    if (parts.includes("log")) { this.#wireLog(); this.#announce(context.rows ?? []); }
    for (const d of el.querySelectorAll("details[data-key]")) {
      const v = this.#details.get(d.dataset.key);
      if (v !== undefined && d.open !== v) d.open = v;
    }
    this.#syncComposer();
    this.dock();
    syncHeaderState(this.sheet);
  }

  /** a full render (open, first render) still re-creates the textarea: carry caret, scroll, height and focus over */
  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState?.(partId, newElement, priorElement, state);
    if (partId !== "composer") return;
    const ta = priorElement?.querySelector?.("textarea[name=message]");
    if (!ta) return;
    state.maigInput = {
      start: ta.selectionStart, end: ta.selectionEnd, dir: ta.selectionDirection,
      height: ta.style.height, scroll: ta.scrollTop, focused: document.activeElement === ta
    };
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState?.(partId, newElement, priorElement, state);
    const st = state?.maigInput;
    if (partId !== "composer" || !st) return;
    const ta = newElement?.querySelector?.("textarea[name=message]");
    if (!ta) return;
    ta.value = this.#draft;
    if (st.height) ta.style.height = st.height;
    if (st.focused && !ta.disabled) {
      ta.focus({ preventScroll: true });
      try { ta.setSelectionRange(st.start, st.end, st.dir); } catch { /* ignore */ }
    }
    ta.scrollTop = st.scroll;
  }

  /** send/stop swap, disabled state and usage line of the composer, in place. -> false when there is no composer yet */
  #syncComposer() {
    const root = this.element?.querySelector?.("[data-application-part=composer]");
    if (!root) return false;
    const busy = !!this.session?.busy, working = !!this.#working;
    const ta = root.querySelector("textarea[name=message]");
    if (ta) ta.disabled = working;
    const stop = root.querySelector("[data-action=stop]"), send = root.querySelector("[data-action=send]");
    if (stop) stop.hidden = !busy;
    if (send) { send.hidden = busy; send.disabled = working; }
    this.element.classList.toggle("is-busy", busy || working);
    const u = root.querySelector("[data-role=usage]");
    if (u) {
      const v = this.#usageVm();
      u.hidden = !v;
      if (v) {
        u.textContent = v.turn ? L("MAIG.Drawer.Usage.turn", v.turn) : v.line;
        u.classList.toggle("is-amber", !!v.amber);
        u.dataset.tooltip = v.tip ?? "";
      }
    }
    return true;
  }

  /** new conversation rows (not the GM's own, not tool chips) go to the stable live region as plain text */
  #announce(rows) {
    const n = rows.length;
    if (this.#announced < 0 || n < this.#announced) { this.#announced = n; return; }
    const fresh = rows.slice(this.#announced);
    this.#announced = n;
    const plain = (html) => { const t = document.createElement("template"); t.innerHTML = String(html ?? ""); return t.content.textContent.trim(); };
    const text = fresh.map((r) => {
      if (r.kind === "ai" || r.kind === "proposal" || r.kind === "progress") return plain(r.html);
      if (r.kind === "notice") return String(r.text ?? "");
      if (r.kind === "status") return L(`MAIG.Drawer.Event.${r.status}`);
      return "";
    }).filter(Boolean).join(" ");
    if (text && this.#liveEl) this.#liveEl.textContent = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  }

  #wireComposer() {
    const ta = this.element.querySelector("textarea[name=message]");
    if (!ta) return;
    if (ta.value !== this.#draft) ta.value = this.#draft;
    ta.addEventListener("input", () => { this.#draft = ta.value; });
    ta.addEventListener("focus", () => { this.#focusInput = true; });
    ta.addEventListener("blur", () => { this.#focusInput = false; });
    ta.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.#send();
    });
    if (this.#focusInput && document.activeElement !== ta && !ta.disabled) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  #wireHead() {
    for (const sel of this.element.querySelectorAll("select[data-option]")) {
      sel.addEventListener("change", async () => {
        if (!this.session) return;
        await this.session.setOptions({ [sel.dataset.option]: sel.value || null });
        this.#invalidatePreview();
        this.#queue("head", "card");
      });
    }
  }

  #wireLog() {
    const log = this.element.querySelector("[data-application-part=log]");
    if (!log) return;
    if (this.#stick) log.scrollTop = log.scrollHeight;
    log.addEventListener("scroll", () => { this.#stick = log.scrollHeight - log.scrollTop - log.clientHeight < 24; }, { passive: true });
  }

  focusInput() {
    this.#focusInput = true;
    requestAnimationFrame(() => this.element?.querySelector?.("textarea[name=message]")?.focus());
  }

  /** Glue to the sheet: flush to its right edge (left when no room), below its header, same z-index; hidden while closed or minimised. */
  dock() {
    const el = this.element;
    const sh = this.sheet?.element;
    if (!el) return;
    const gone = !sh || !sh.isConnected;
    const hidden = gone || !this.isOpen || sh.classList.contains("minimized") || sh.classList.contains("minimizing");
    el.hidden = hidden;
    if (hidden) return;
    const g = M.dockGeometry(sh.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    el.classList.toggle("flip", g.flip);
    el.style.left = `${g.left}px`;
    el.style.top = `${g.top}px`;
    el.style.width = `${g.width}px`;
    el.style.height = `${g.height}px`;
    el.style.zIndex = sh.style.zIndex || "";
    // theme follows the sheet (bughunt-2 #5, W5-F): a sheet with its own theme (DocumentSheetConfig -> `themed theme-*`)
    // gives it; an unthemed sheet (the Invincible sheets are always light paper) gives light, whatever the interface is
    const dark = sh.classList.contains("theme-dark");
    el.classList.toggle("theme-dark", dark);
    el.classList.toggle("theme-light", !dark);
  }

  _onClose(options) {
    super._onClose?.(options);
    window.removeEventListener("resize", this.#onWinResize);
    for (const o of this.#observers) o.disconnect();
    this.#observers = [];
    for (const [name, id] of this.#hooks) Hooks.off(name, id);
    this.#hooks = [];
    this.#unsub?.();
    this.#unsub = null;
    this.#tick(false);
    clearTimeout(this.#renderT);
    if (drawers.get(this.sheet?.id) === this) drawers.delete(this.sheet.id);
  }

  /* ------------------------------------------------------------------------------------------------ actions */

  /** title-bar X: close the panel; focus goes back to the header button it opens from */
  static async #onCollapse() {
    const sheet = this.sheet;
    await this.setOpen(false);
    sheet?.element?.querySelector?.("[data-maig-builder]")?.focus?.();
  }

  static #onSend() { return this.#send(); }

  async #send() {
    const s = this.session;
    const text = this.#draft.trim();
    if (!s || !text || s.busy || this.#working) return;
    this.#draft = "";
    this.#sent = text;
    this.#stick = true;
    const ta = this.element.querySelector("textarea[name=message]");
    if (ta) ta.value = "";
    this.#focusInput = true;
    try { await s.send(text); }
    catch (e) { this.#setFlash("error", L("MAIG.Drawer.Flash.sendFailed", { error: String(e?.message ?? e) })); }
    finally {
      // refused before the turn (no key, no pack, history full, ...) or failed before the message was stored: the
      // "user-message" event never came, so the text is not in the conversation. Give it back (bughunt-2 #2), in front
      // of anything the GM typed in the meantime.
      if (this.#sent === text) {
        this.#draft = this.#draft.trim() ? `${text}\n${this.#draft}` : text;
        const box = this.element?.querySelector?.("textarea[name=message]");
        if (box) box.value = this.#draft;
      }
      this.#sent = null;
    }
  }

  static #onStop() { this.session?.stop(); }

  static async #onNewConversation() {
    const s = this.session;
    if (!s || s.busy || this.#working) return;
    const r = await s.newConversation();
    if (!r?.ok) this.#setFlash("warn", L("MAIG.Drawer.Flash.busy"));
  }

  static #onDismiss() { this.#flash = null; this.render({ parts: ["head"] }); }

  static #onOpenSettings() {
    // W5-F: the keys are no longer fields of Configure Settings: the GM-only keys window (keys-app.mjs)
    try { if (api()?.openKeys?.()) return; } catch { /* fall back */ }
    try { game.settings.sheet.render({ force: true }); } catch { /* ignore */ }
  }

  #setFlash(level, text, items = []) {
    this.#flash = { level, text, items, icon: level === "error" ? "fa-circle-exclamation" : level === "warn" ? "fa-triangle-exclamation" : "fa-circle-check" };
    this.#queue("head");
  }

  /** Apply / Undo write the actor: re-render its open sheets when they did not re-render by themselves (live check). */
  async #afterWrite(kind, before, t0) {
    await new Promise((r) => setTimeout(r, 250));   // the sheet's own render is debounced
    const renders = this.#sheetRenders - before;
    let forced = 0;
    if (!renders) {
      for (const app of foundry.applications.instances.values()) {
        if (isSheetOf(app, this.actor)) { app.render(); forced++; }
      }
    }
    this.lastWriteStats = { kind, sheetRenders: renders, forced, ms: Date.now() - t0 };
    this.#invalidatePreview();
  }

  static async #onApply() {
    const s = this.session;
    const pack = getPack();
    const card = this.pendingCard;
    if (!s || !pack || !card || s.busy || this.#working) return;
    const ranks = build()?.ranks?.() ?? [];
    const eff = M.effectiveOptions(s.options, defaultRankOf(this.actor, ranks));
    const expect = this.#preview?.key === `${card.proposalId}|${eff.rank}|${eff.profile}` ? this.#preview.expect : null;
    this.#working = "apply";
    this.#queue("card", "composer");
    const t0 = Date.now(), before = this.#sheetRenders;
    let r = null;
    try {
      const opts = { rank: eff.rank, profile: eff.profile, ...(expect ? { expect } : {}) };
      r = await pack.apply(this.actor, card.input, opts);
      if (r?.needsConfirm && Array.isArray(r.confirm) && r.confirm.length) {
        const yes = await confirmDialog({
          title: L("MAIG.Drawer.Confirm.title"),
          lead: L("MAIG.Drawer.Confirm.lead", { name: this.actor.name }),
          items: M.confirmItems(r.confirm, L),
          yes: L("MAIG.Drawer.Confirm.yes"), no: L("MAIG.Drawer.Confirm.no")
        });
        if (!yes) { this.#setFlash("info", L("MAIG.Drawer.Flash.notApplied")); return; }
        r = await pack.apply(this.actor, card.input, { ...opts, confirmed: true });
      }
      if (r?.ok) {
        await s.markProposal(card.proposalId, "applied", { runId: r.runId });
        // W5-A: the build's Health / Resolve and the re-ordered talents first, then the warnings
        this.#setFlash("ok", r.message || L("MAIG.Drawer.Flash.applied"), M.applyResultLines(r, L, 6));
      } else {
        const why = r?.unsaved ? L("MAIG.Drawer.Flash.unsaved") : r?.stale ? L("MAIG.Drawer.Flash.stale") : r?.busy ? L("MAIG.Drawer.Flash.writerBusy") : "";
        this.#setFlash("error", [why, r?.message].filter(Boolean).join(" ") || L("MAIG.Drawer.Flash.applyFailed"), (r?.errors ?? []).map((e) => e.message).filter(Boolean).slice(0, 6));
      }
    } catch (e) {
      this.#setFlash("error", L("MAIG.Drawer.Flash.applyFailed"), [String(e?.message ?? e)]);
    } finally {
      if (r?.ok) await this.#afterWrite("apply", before, t0);
      this.#working = null;
      this.#invalidatePreview();
      this.#queue("log", "card", "composer", "head");
    }
  }

  static async #onDiscard() {
    const s = this.session;
    const card = this.pendingCard;
    if (!s || !card || this.#working) return;
    this.#working = "discard";
    try { await s.markProposal(card.proposalId, "discarded"); this.#setFlash("info", L("MAIG.Drawer.Flash.discarded")); }
    finally { this.#working = null; this.#invalidatePreview(); this.#queue("log", "card", "composer"); }
  }

  static async #onUndo() {
    const s = this.session;
    const pack = getPack();
    if (!s || !pack || s.busy || this.#working) return;
    const st = pack.undoStatus(this.actor);
    if (!st?.available) { this.#setFlash("info", L("MAIG.Drawer.Flash.nothingToUndo")); this.#queue("card"); return; }
    this.#working = "undo";
    this.#queue("card", "composer");
    const t0 = Date.now(), before = this.#sheetRenders;
    let r = null;
    try {
      r = await pack.undo(this.actor, st.runId);
      if (r?.needsConfirm) {
        const yes = await confirmDialog({
          title: L("MAIG.Drawer.Undo.confirmTitle"),
          lead: L("MAIG.Drawer.Undo.confirmLead", { name: this.actor.name }),
          items: (r.drift ?? []).map((d) => L(`MAIG.Drawer.Undo.drift.${M.driftKey(d)}`, { name: d.name })),
          yes: L("MAIG.Drawer.Undo.confirmYes"), no: L("MAIG.Drawer.Confirm.no")
        });
        if (!yes) return;
        r = await pack.undo(this.actor, st.runId, { confirmDrift: true });
      }
      if (r?.ok) {
        // the proposal that run applied is pending again (W7-1): the card comes back with Apply
        const applied = (s.proposals ?? []).filter((p) => p.status === "applied").at(-1);
        if (applied && String(s.record?.lastRunId ?? "") === String(st.runId)) await s.markProposal(applied.id, "pending");
        this.#setFlash("ok", r.message || L("MAIG.Drawer.Flash.undone"));
      } else this.#setFlash("error", r?.message || L("MAIG.Drawer.Flash.undoFailed"));
    } catch (e) {
      this.#setFlash("error", L("MAIG.Drawer.Flash.undoFailed"), [String(e?.message ?? e)]);
    } finally {
      if (r?.ok) await this.#afterWrite("undo", before, t0);
      this.#working = null;
      this.#invalidatePreview();
      this.#queue("log", "card", "composer", "head");
    }
  }
}

/** Foundry confirm dialog with a list (remove / swap / reorder items, drift). -> true | false */
async function confirmDialog({ title, lead, items = [], yes, no }) {
  const esc = foundry.utils.escapeHTML;
  const content = `<div class="maig-confirm"><p>${esc(lead)}</p>${items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}</div>`;
  try {
    const r = await DialogV2.confirm({
      window: { title, icon: ICON },
      classes: ["maig-confirm-dialog"],
      content,
      yes: { label: yes, icon: "fa-solid fa-check", default: true },
      no: { label: no, icon: "fa-solid fa-xmark" },
      rejectClose: false,
      modal: true
    });
    return r === true;
  } catch { return false; }
}

/* ---------------------------------------------------------------------------------------------- sheet integration */

function syncButton(app, element) {
  const sheet = sheetOf(app);
  if (!sheet) return;
  const header = (element ?? sheet.element)?.querySelector?.(".window-header");
  if (!header) return;
  const existing = header.querySelector("[data-maig-builder]");
  if (!canUse(sheet.document)) { existing?.remove(); return; }
  const d = drawers.get(sheet.id);
  if (!existing) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `header-control icon ${ICON} maig-header-btn`;
    btn.dataset.maigBuilder = "";
    btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleFor(sheet).catch((e) => console.error(`${MODULE_ID} | AI builder toggle failed`, e)); });
    const anchor = header.querySelector('[data-action="copyUuid"]') ?? header.querySelector('[data-action="close"]');
    if (anchor) anchor.before(btn); else header.append(btn);
  }
  // a session already in memory with a proposal waiting or a turn running: a hidden drawer follows it, the button shows it (spec 4.1)
  if (!d) {
    const s = build()?.getSession?.(sheet.document);
    if (s && (s.busy || M.cardProposal(s.pendingProposal, s.proposals, s.transcript()))) BuilderDrawer.openFor(sheet, { open: false }).catch(() => {});
  } else d.dock();
  syncHeaderState(sheet);
}

/**
 * The header button carries the drawer's state (W5-E, no side tab): aria-pressed = open, `has-pending` = a proposal waits
 * (yellow dot), `is-working` = a turn or a write runs (pulsing dot); the tooltip / label say the same.
 */
function syncHeaderState(sheet) {
  const btn = sheet?.element?.querySelector?.("[data-maig-builder]");
  if (!btn) return;
  const d = drawers.get(sheet.id);
  let s = d?.session ?? null;
  if (!s) { try { s = build()?.getSession?.(sheet.document) ?? null; } catch { s = null; } }
  let pending = false;
  try { pending = !!(s && M.cardProposal(s.pendingProposal, s.proposals, s.transcript())); } catch { pending = false; }
  const st = M.headerButtonState({ open: !!d?.isOpen, pending, busy: !!s?.busy || !!d?.working }, L);
  btn.setAttribute("aria-pressed", String(st.pressed));
  btn.classList.toggle("has-pending", st.pending);
  btn.classList.toggle("is-working", st.working);
  btn.dataset.tooltip = st.tooltip;
  btn.setAttribute("aria-label", st.tooltip);
}

/** Header button / 3-dot entry: open, or close when open. */
export async function toggleFor(sheet) {
  const d = drawers.get(sheet.id);
  if (d) await d.setOpen(!d.isOpen);
  else await BuilderDrawer.openFor(sheet, { open: true });
  syncHeaderState(sheet);
}

function syncAll() {
  try { for (const app of foundry.applications.instances.values()) syncButton(app, app.element); }
  catch (e) { console.warn(`${MODULE_ID} | builder header sync failed`, e); }
}

let started = false;
/** Called once from module.mjs (GM, ready). */
export function startDrawer(moduleApi) {
  if (started || !game.user?.isGM) return;
  started = true;
  // module.json lists the stylesheet; a server that read the manifest before it was added does not serve it: add it here once
  if (!document.querySelector('link[href*="styles/builder-drawer.css"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `modules/${MODULE_ID}/styles/builder-drawer.css`;
    document.head.append(link);
  }
  Hooks.on("renderApplicationV2", (app, element) => syncButton(app, element));
  // forget the drawer at once (its own close can still be animating): a sheet reopened right away docks a fresh one
  Hooks.on("closeApplicationV2", (app) => { const d = drawers.get(app?.id); if (d && app === d.sheet) { drawers.delete(app.id); d.close(); } });
  Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
    const actor = app?.document;
    if (!actor) return;
    // runs each time the menu opens: the label says what a click does (bughunt-2 #13)
    const label = drawers.get(app.id)?.isOpen ? "MAIG.Drawer.MenuClose" : "MAIG.Drawer.Open";
    controls.push({ action: "maigBuilder", icon: ICON, label, visible: () => canUse(actor), onClick: () => toggleFor(app).catch((e) => console.error(`${MODULE_ID} | AI builder toggle failed`, e)) });
  });
  Hooks.on("moinensAiGen.packReady", () => syncAll());
  Hooks.on("moinensAiGen.harnessReady", () => syncAll());
  if (moduleApi) {
    moduleApi.build = Object.assign(moduleApi.build ?? {}, {
      openDrawer: async (actor) => {
        const sheet = actor?.sheet;
        if (!sheet) return null;
        if (!sheet.rendered) await sheet.render({ force: true });
        return BuilderDrawer.openFor(sheet, { open: true });
      },
      drawers
    });
  }
  Promise.resolve(moduleApi?.build?.ready).finally(() => syncAll());
}
