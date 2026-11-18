import { MODULE_ID } from "./constants.mjs";
import { fmtBytes } from "./optimize.mjs";
import { PROVIDERS } from "./providers/index.mjs";
import { readLog, clearLog, toCSV, toJSON } from "./call-log.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const MAX_ROWS = 500;
const KINDS = ["fast", "test", "batch-submit", "batch-result", "limit-blocked", "build", "build-prewarm"];   // build*: AI builder harness (harness.mjs)
const STATUSES = ["ok", "error", "blocked", "pending"];

const loc = (key) => (game.i18n.has(key) ? game.i18n.localize(key) : key.split(".").pop());
const money = (n, estimated = false) => (n == null ? "" : `${estimated ? "~" : ""}$${Number(n).toFixed(Number(n) >= 1 ? 2 : 4)}`);
const dur = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);

/** Log wywołań: tabela, filtry, sumy, eksport CSV/JSON. */
export class LogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-log`,
    classes: ["aiimg-log"],
    tag: "div",
    window: { title: "AIIMG.Log.Title", icon: "fa-solid fa-clipboard-list", resizable: true },
    position: { width: 1040, height: 620 },
    actions: {
      toggle: LogApp.#onToggle,
      copyPrompt: LogApp.#onCopy,
      exportCsv: LogApp.#onExportCsv,
      exportJson: LogApp.#onExportJson,
      clear: LogApp.#onClear,
      refresh: LogApp.#onRefresh,
      resetFilters: LogApp.#onResetFilters
    }
  };

  static PARTS = {
    filters: { template: `modules/${MODULE_ID}/templates/log-filters.hbs` },
    table: { template: `modules/${MODULE_ID}/templates/log.hbs`, scrollable: [".aiimg-log-scroll"] }
  };

  static #instance;

  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  #f = { provider: "", model: "", status: "", kind: "", from: "", to: "", q: "" };
  #all = [];
  #timer = null;
  /** Expanded row ids; kept here (not in the DOM) so a live update does not collapse what you are reading. */
  #open = new Set();

  #hook = () => {
    if (!this.rendered) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.render({ parts: ["table"] }), 150);
  };

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    Hooks.on("aiImageGen.logUpdate", this.#hook);
    // The window element is rebuilt on every open, so the listeners belong to the first render of each open.
    const onChange = (ev) => {
      const el = ev.target.closest("[data-f]");
      if (!el || !this.element.contains(el)) return;
      this.#f[el.dataset.f] = el.value;
      if (el.dataset.f === "q") {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.render({ parts: ["table"] }), 200);
      } else this.render({ parts: ["table"] });
    };
    this.element.addEventListener("input", (ev) => { if (ev.target.dataset?.f === "q") onChange(ev); });
    this.element.addEventListener("change", (ev) => { if (ev.target.dataset?.f !== "q") onChange(ev); });
    this.element.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest?.("tr.aiimg-log-row");
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      this.#toggleRow(row.dataset.id);
    });
  }

  _onClose(options) {
    super._onClose?.(options);
    Hooks.off("aiImageGen.logUpdate", this.#hook);
    clearTimeout(this.#timer);
  }

  #filtered() {
    const f = this.#f;
    const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : -Infinity;
    const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : Infinity;
    const q = f.q.trim().toLowerCase();
    return this.#all.filter((e) => {
      if (f.provider && e.provider !== f.provider) return false;
      if (f.model && e.model !== f.model) return false;
      if (f.status && e.status !== f.status) return false;
      if (f.kind && e.kind !== f.kind) return false;
      const t = Date.parse(e.ts);
      if (t < from || t > to) return false;
      if (q && !`${e.prompt ?? ""}\n${e.description ?? ""}\n${e.docName ?? ""}\n${e.error ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  async _preparePartContext(partId, context) {
    context = await super._preparePartContext?.(partId, context) ?? context;
    this.#all = await readLog(); // z pamięci (cache call-log), tanie
    const f = this.#f;
    if (partId === "filters") {
      const uniq = (k) => [...new Set(this.#all.map((e) => e[k]).filter(Boolean))].sort();
      const opts = (vals, cur, label = (v) => v) => [{ value: "", label: loc("AIIMG.Log.All"), selected: !cur },
        ...vals.map((v) => ({ value: v, label: label(v), selected: v === cur }))];
      context.f = f;
      context.providers = opts(uniq("provider"), f.provider, (v) => PROVIDERS[v]?.label ?? v);
      context.models = opts(uniq("model"), f.model);
      context.statuses = opts(STATUSES, f.status, (v) => loc(`AIIMG.Log.Status.${v}`));
      context.kinds = opts(KINDS, f.kind, (v) => loc(`AIIMG.Log.Kind.${v}`));
    } else if (partId === "table") {
      const rows = this.#filtered();
      const spentRows = rows.filter((e) => e.costKind === "actual" && e.status !== "blocked");
      const fast = rows.filter((e) => e.kind === "fast" && e.status === "ok" && e.durationMs != null);
      context.summary = {
        count: rows.length,
        spent: money(spentRows.reduce((s, e) => s + (e.cost ?? 0), 0)),
        queued: money(rows.filter((e) => e.kind === "batch-submit" && e.status === "pending").reduce((s, e) => s + (e.cost ?? 0), 0), true),
        avg: fast.length ? dur(fast.reduce((s, e) => s + e.durationMs, 0) / fast.length) : "—"
      };
      context.capped = rows.length > MAX_ROWS ? game.i18n.format("AIIMG.Log.Capped", { n: MAX_ROWS, total: rows.length }) : "";
      context.empty = rows.length === 0;
      context.rows = rows.slice(0, MAX_ROWS).map((e) => ({
        id: e.id,
        open: this.#open.has(e.id),
        time: new Date(e.ts).toLocaleString(),
        kind: e.kind, kindLabel: loc(`AIIMG.Log.Kind.${e.kind}`),
        status: e.status, statusLabel: loc(`AIIMG.Log.Status.${e.status}`),
        provider: PROVIDERS[e.provider]?.label ?? e.provider ?? "",
        model: e.model ?? "",
        duration: dur(e.durationMs),
        cost: money(e.cost, e.costKind === "estimated"),
        doc: e.docName ?? "",
        prompt: e.prompt ?? "",
        short: (e.prompt ?? e.error ?? "").replace(/\s+/g, " ").slice(0, 110),
        error: e.error ?? "",
        details: [
          ["AIIMG.Log.Route", e.route], ["AIIMG.Log.Size", e.size], ["AIIMG.Config.Quality", e.quality],
          ["AIIMG.Log.ImageSize", e.imageSize], ["AIIMG.Log.Thinking", e.thinkingLevel],
          ["AIIMG.Log.Refs", e.refsCount], ["AIIMG.Log.Tokens", e.tokens ? `${e.tokens.in} → ${e.tokens.out}` : ""],
          ["AIIMG.Log.RefTokens", e.tokens?.img != null || e.estTokens?.refs != null ? game.i18n.format("AIIMG.Log.RealVsEst", { real: e.tokens?.img ?? "?", est: e.estTokens?.refs ?? "?" }) : ""],
          ["AIIMG.Log.OutTokens", e.estTokens?.out != null ? game.i18n.format("AIIMG.Log.RealVsEst", { real: e.tokens?.out ?? "?", est: e.estTokens.out }) : ""],
          ["AIIMG.Log.Optimized", e.bytesBefore != null ? `${fmtBytes(e.bytesBefore)} → ${fmtBytes(e.bytesAfter)} (${e.optimizedVia ?? "?"})` : ""],
          ["AIIMG.Log.Transparent", e.transparent ? "✓" : ""],
          ["AIIMG.Log.Description", e.description && e.description !== e.prompt ? e.description : ""], ["AIIMG.Log.Type", e.typeKey], ["AIIMG.Log.Batch", e.batchId],
          ["AIIMG.Log.Uuid", e.docUuid], ["AIIMG.Log.Caller", e.caller], ["AIIMG.Log.User", e.user]
        ].filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => ({ label: loc(k), value: String(v) }))
      }));
    }
    return context;
  }

  static #onToggle(event, target) {
    if (event.target.closest("button")) return;
    this.#toggleRow(target.dataset.id);
  }

  #toggleRow(id) {
    const row = this.element.querySelector(`tr.aiimg-log-row[data-id="${CSS.escape(id)}"]`);
    const detail = this.element.querySelector(`tr.aiimg-log-detail[data-for="${CSS.escape(id)}"]`);
    if (!row || !detail) return;
    const open = !this.#open.has(id);
    if (open) this.#open.add(id); else this.#open.delete(id);
    detail.hidden = !open;
    row.classList.toggle("open", open);
    row.setAttribute("aria-expanded", String(open));
  }

  static async #onCopy(event, target) {
    event.stopPropagation();
    const row = this.#all.find((e) => e.id === target.dataset.id);
    const text = row?.prompt ?? "";
    if (!text) return;
    try { await game.clipboard.copyPlainText(text); }
    catch { await navigator.clipboard.writeText(text); }
    ui.notifications.info(game.i18n.localize("AIIMG.Log.Copied"));
  }

  static #stamp() { return new Date().toISOString().slice(0, 10); }

  static #onExportCsv() {
    foundry.utils.saveDataToFile(toCSV(this.#filtered()), "text/csv", `moinens-ai-gen-log-${LogApp.#stamp()}.csv`);
  }

  static #onExportJson() {
    foundry.utils.saveDataToFile(toJSON(this.#filtered()), "application/json", `moinens-ai-gen-log-${LogApp.#stamp()}.json`);
  }

  static async #onClear() {
    const ok = await DialogV2.confirm({
      window: { title: game.i18n.localize("AIIMG.Log.Clear") },
      content: `<p>${game.i18n.localize("AIIMG.Log.ClearConfirm")}</p>`,
      yes: { default: false }
    });
    if (!ok) return;
    await clearLog();
    this.#all = [];
    this.render({ parts: ["filters", "table"] });
  }

  static async #onRefresh() {
    this.#all = await readLog();
    this.render({ parts: ["filters", "table"] });
  }

  static #onResetFilters() {
    this.#f = { provider: "", model: "", status: "", kind: "", from: "", to: "", q: "" };
    this.render({ parts: ["filters", "table"] });
  }
}
