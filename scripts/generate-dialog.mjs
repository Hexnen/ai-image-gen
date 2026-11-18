import { MODULE_ID } from "./constants.mjs";
import { optimizeEnabled, outputOptsFromConfig, fmtBytes } from "./optimize.mjs";
import { safeMessage } from "./redact.mjs";
import {
  readiness, runFast, runBatch, generateCandidates, estimateTotalInfo, buildPrompt, MAX_VERSIONS, MAX_EXTRA_REF_BYTES
} from "./generate-flow.mjs";
import { sourceTag } from "./cost-learning.mjs";
import { ImageConfigApp } from "./config-app.mjs";
import { PickApp } from "./pick-app.mjs";
import { saveRefFile } from "./save-image.mjs";
import { resolveTypeKey, detectImageTypes } from "./image-types.mjs";
import { getConfig, setConfig, isConfigured, clampCount, fitConfig } from "./config-store.mjs";
import { supportsTransparent } from "./providers/index.mjs";
import { createEnhanceStore, mountEnhance, resetEnhance, cancelEnhance } from "./enhance/ui.mjs";
import { refOptsFor, purposeOverride, measureRef, refLine, costBreakdown, estimateSettings, fmtUsd } from "./ref-convert.mjs";
import { PURPOSE_IDS, REF_PURPOSES, usd } from "./image-cost.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PREFS_KEY = `${MODULE_ID}.dialogPrefs`;
const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; }
};
const savePrefs = (p) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* storage unavailable */ }
};

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const money = (v) => (v > 0 ? `~$${v.toFixed(v < 0.1 ? 3 : 2)}` : "?");

/** Jak zapiszemy wynik (Output z konfiguracji typu): format, limit boku, jakość. */
function outputSummary(cfg) {
  if (!optimizeEnabled()) return game.i18n.localize("AIIMG.Gen.OutputOff");
  const o = outputOptsFromConfig(cfg);
  const edge = o.maxEdge ? `≤ ${o.maxEdge} px` : game.i18n.localize("AIIMG.Config.OutNoResize");
  return `${o.format.toUpperCase()} · ${edge} · ${Math.round(o.quality * 100)}%`;
}

/** Modal: opis, dodatkowe referencje, liczba wersji + Fast / Batch dla jednego dokumentu. */
export class GenerateDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aiimg-generate"],
    tag: "div",
    window: { title: "AIIMG.Gen.Title", icon: "fa-solid fa-wand-magic-sparkles", resizable: false },
    position: { width: 460, height: "auto" },
    actions: {
      runFast: GenerateDialog.#onFast,
      runBatch: GenerateDialog.#onBatch,
      openConfig: GenerateDialog.#onOpenConfig,
      addRefs: GenerateDialog.#onAddRefs,
      removeRef: GenerateDialog.#onRemoveRef
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/generate.hbs` }
  };

  /** Open (or focus) the dialog for a document. */
  static open(document) {
    // An unsaved document has no uuid: the image would be paid for and then have nowhere to go.
    if (!document?.uuid || !document.id) {
      ui.notifications.warn(game.i18n.localize("AIIMG.Gen.Unsaved"));
      return null;
    }
    const key = document.uuid;
    const id = `${MODULE_ID}-generate-${key.replace(/[^A-Za-z0-9]/g, "-")}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) { existing.bringToFront?.(); return existing; }
    const app = new this({ id, document });
    app.render({ force: true });
    return app;
  }

  /** @type {{uid:string, blob:Blob, name:string, url:string, purpose:string}[]} dodatkowe referencje tylko na to wywołanie (purpose "" = domyślne typu) */
  extraRefs = [];

  /** Różdżka przy opisie (Claude): stan cofnięcia i trwającego żądania, przeżywa re-render. */
  #enhance = createEnhanceStore();

  constructor({ document, ...options }) {
    super(options);
    this.document = document;
    this.description = "";
    this.busy = null; // "fast" | "batch" | null
    this.error = "";
    const prefs = loadPrefs();
    // A type with saved settings starts from its own versions-per-run; otherwise the last count used.
    const key = resolveTypeKey(document);
    this.count = key && isConfigured(key)
      ? clampCount(getConfig(key).defaultCount)
      : Math.min(MAX_VERSIONS, Math.max(1, Math.floor(Number(prefs.count)) || 1));
    this.preview = !!prefs.preview;
    this.promptOpen = !!prefs.promptOpen;
    this.saveRef = false;
    // One-off override of the type's transparent background; starts from the type's own setting.
    this.transparent = !!(key && getConfig(key).transparent);
  }

  /** Overrides sent with this run (only for models that support them). */
  #overrides(cfg) {
    return supportsTransparent(cfg.provider, cfg.model) ? { transparent: this.transparent } : undefined;
  }

  get title() {
    return game.i18n.format("AIIMG.Gen.TitleFor", { name: this.document.name });
  }

  /** W6-D: sizes of the type's and the extra references as they will be sent, and the token/cost estimate. */
  async #refsInfo(cfg) {
    const ro = refOptsFor(cfg);
    const { inPrice } = estimateSettings();
    const L = (k) => game.i18n.localize(k);
    const typeM = await Promise.all((cfg.refs ?? []).map((p) => measureRef(p, { ...ro, purpose: purposeOverride(cfg, p) || ro.purpose })));
    const extra = await Promise.all(this.extraRefs.map(async (x) => {
      const m = await measureRef({ key: x.uid, blob: x.blob }, { ...ro, purpose: x.purpose || ro.purpose });
      const line = refLine(m, inPrice);
      return {
        uid: x.uid, url: x.url, name: x.name, text: line.text, warn: line.warn, tokens: m?.error ? null : m?.tokens ?? null,
        options: [{ id: "", label: game.i18n.format("AIIMG.RefPurpose.TypeDefault", { p: L(`AIIMG.RefPurpose.${ro.purpose}`) }), selected: !x.purpose },
          ...PURPOSE_IDS.map((id) => ({ id, label: `${L(`AIIMG.RefPurpose.${id}`)} · ${REF_PURPOSES[id]} px`, selected: id === x.purpose }))]
      };
    }));
    const typeTok = typeM.map((m) => (m?.error ? null : m?.tokens ?? null));
    const tiles = ro.rules === "openai";
    const sum = typeTok.reduce((a, t) => a + (t ?? 0), 0);
    let typeLine = "";
    if (typeM.length) {
      const sent = typeM.filter((m) => m && !m.error);
      const bytes = (k) => sent.reduce((a, m) => a + m[k].bytes, 0);
      typeLine = game.i18n.format("AIIMG.RefSize.TypeRefs", { n: typeM.length, before: fmtBytes(bytes("src")), after: fmtBytes(bytes("sent")) })
        + (tiles ? ` · ${game.i18n.format("AIIMG.RefSize.Tokens", { tok: sum, usd: fmtUsd(usd(sum, inPrice)) })}` : "");
    }
    return { extra, typeLine, tiles, refTokens: tiles ? [...typeTok, ...extra.map((e) => e.tokens)] : [] };
  }

  async _prepareContext() {
    const r = readiness(this.document);
    const refsTotal = (r.cfg.refs?.length ?? 0) + this.extraRefs.length;
    const fastI = estimateTotalInfo(this.document, { count: this.count, extraRefs: this.extraRefs.length, mode: "fast" });
    const batchI = estimateTotalInfo(this.document, { count: this.count, extraRefs: this.extraRefs.length, mode: "batch" });
    const fast = fastI.cost, batch = batchI.cost;
    const canTransparent = supportsTransparent(r.cfg.provider, r.cfg.model);
    const effCfg = canTransparent ? fitConfig({ ...r.cfg, transparent: this.transparent }) : r.cfg;
    // One source note when both numbers come from the same place; otherwise each number says its own.
    const showBatch = r.canBatch;
    const sameSource = !showBatch || (fastI.source === batchI.source && fastI.n === batchI.n);
    const prompt = buildPrompt(this.document, this.description, r.cfg);
    const ri = await this.#refsInfo(r.cfg);
    let breakdown = null;
    try { breakdown = costBreakdown(r.cfg, { refTokens: ri.refTokens, count: this.count, mode: "fast" }); } catch { /* no table */ }
    return {
      refTypeLine: ri.typeLine,
      refTiles: ri.tiles,
      breakdown,
      description: this.description,
      descId: `${this.id}-description`,
      prompt,
      promptChars: prompt.length,
      promptEmpty: !prompt.trim(),
      promptOpen: this.promptOpen,
      promptFromConfig: r.configured,
      refsExtraSeparate: refsTotal,
      cfg: r.cfg,
      providerLabel: r.providerLabel,
      modelLabel: r.modelLabel,
      configured: r.configured,
      hasKey: r.hasKey,
      canBatch: r.canBatch,
      noBatchTip: r.noBatchReason === "model" ? "AIIMG.Gen.NoBatchModelTip" : "AIIMG.Gen.NoBatchTip",
      busy: !!this.busy,
      busyFast: this.busy === "fast",
      busyBatch: this.busy === "batch",
      batchDisabled: !r.canBatch || !!this.busy,
      fastDefault: r.cfg.defaultMode === "fast",
      batchDefault: r.cfg.defaultMode === "batch" && r.canBatch,
      error: this.error,
      extraRefs: ri.extra,
      refsTotal,
      maxRefs: r.maxRefs,
      refsOver: refsTotal > r.maxRefs,
      count: this.count,
      maxVersions: MAX_VERSIONS,
      preview: this.preview,
      showPreview: this.count === 1,
      estFast: money(fast),
      estBatch: r.canBatch ? money(batch) : "",
      estTag: sameSource ? sourceTag(fastI.source, fastI.n) : "",
      estFastTag: sameSource ? "" : sourceTag(fastI.source, fastI.n),
      estBatchTag: sameSource ? "" : sourceTag(batchI.source, batchI.n),
      outputSummary: outputSummary(effCfg),
      canTransparent,
      transparent: canTransparent && this.transparent,
      maxMb: MAX_EXTRA_REF_BYTES / 1048576,
      canSaveRef: game.user.isGM && !!resolveTypeKey(this.document) && this.extraRefs.length > 0,
      saveRef: this.saveRef
    };
  }

  #paste = (ev) => {
    // Only the window the user is working in takes a pasted image (two open dialogs would both get it).
    const active = document.activeElement;
    const inside = !!this.element?.contains(active);
    const focusFree = !active || active === document.body;
    if (!inside && !(focusFree && ui.activeWindow === this)) return;
    const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    ev.preventDefault();
    this.#addFiles(files);
  };

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    document.addEventListener("paste", this.#paste);
    const el = this.element;
    el.addEventListener("dragover", (ev) => {
      if ([...(ev.dataTransfer?.types ?? [])].includes("Files")) { ev.preventDefault(); el.classList.add("aiimg-dragging"); }
    });
    el.addEventListener("dragleave", (ev) => {
      if (ev.target === el || !el.contains(ev.relatedTarget)) el.classList.remove("aiimg-dragging");
    });
    el.addEventListener("drop", (ev) => {
      el.classList.remove("aiimg-dragging");
      const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.#addFiles(files);
    });
  }

  _onClose(options) {
    super._onClose?.(options);
    document.removeEventListener("paste", this.#paste);
    for (const r of this.extraRefs) URL.revokeObjectURL(r.url);
    resetEnhance(this.#enhance);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    el.querySelector("textarea[name=description]")
      ?.addEventListener("input", (ev) => { this.description = ev.target.value; this.#refreshPrompt(); });
    mountEnhance(this.#enhance, {
      textarea: el.querySelector("textarea[name=description]"),
      slot: el.querySelector("[data-role=enhance]"),
      statusEl: el.querySelector("[data-role=enhanceStatus]"),
      disabled: !!this.busy,
      // Ta sama etykieta typu co w szufladzie testu („Superhero”), nie wewnętrzny klucz („invincible.Actor.superhero”).
      getContext: () => {
        const key = resolveTypeKey(this.document);
        const label = key ? detectImageTypes().find((t) => t.key === key)?.label : null;
        return { name: this.document.name, type: label || this.document.documentName };
      }
    });
    el.querySelector("details.aiimg-prompt")?.addEventListener("toggle", (ev) => {
      this.promptOpen = ev.target.open;
      savePrefs({ promptOpen: this.promptOpen });
    });
    el.querySelector("[data-action=copyPrompt]")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        await navigator.clipboard.writeText(this.#currentPrompt());
        ui.notifications.info(game.i18n.localize("AIIMG.Gen.PromptCopied"));
      } catch { ui.notifications.warn(game.i18n.localize("AIIMG.Gen.PromptCopyFailed")); }
    });
    el.querySelector("input[name=count]")?.addEventListener("change", (ev) => {
      this.count = Math.min(MAX_VERSIONS, Math.max(1, Math.floor(Number(ev.target.value)) || 1));
      savePrefs({ count: this.count, preview: this.preview });
      this.render();
    });
    el.querySelector("input[name=preview]")?.addEventListener("change", (ev) => {
      this.preview = ev.target.checked;
      savePrefs({ count: this.count, preview: this.preview });
    });
    el.querySelector("input[name=transparent]")?.addEventListener("change", (ev) => { this.transparent = ev.target.checked; this.render(); });
    el.querySelector("input[name=saveRef]")?.addEventListener("change", (ev) => { this.saveRef = ev.target.checked; });
    el.querySelectorAll("select[data-ref-purpose]").forEach((sel) => sel.addEventListener("change", () => {
      const x = this.extraRefs.find((r) => r.uid === sel.dataset.uid);
      if (!x) return;
      x.purpose = sel.value;
      const uid = x.uid;
      this.render().then(() => this.element?.querySelector(`select[data-ref-purpose][data-uid="${uid}"]`)?.focus());
    }));
    el.querySelector("input[name=refFiles]")?.addEventListener("change", (ev) => {
      this.#addFiles([...ev.target.files]);
      ev.target.value = "";
    });
  }

  #currentPrompt() {
    return buildPrompt(this.document, this.description, readiness(this.document).cfg);
  }

  /** Update the Final prompt block in place (no re-render: keeps focus, caret and uploaded refs). */
  #refreshPrompt() {
    const el = this.element;
    const pre = el?.querySelector(".aiimg-prompt-text");
    if (!pre) return;
    const prompt = this.#currentPrompt();
    pre.textContent = prompt;
    const chars = el.querySelector(".aiimg-prompt-chars");
    if (chars) chars.textContent = game.i18n.format("AIIMG.Gen.PromptChars", { n: prompt.length });
    el.querySelector(".aiimg-prompt-empty")?.toggleAttribute("hidden", !!prompt.trim());
  }

  #addFiles(files) {
    const maxBytes = MAX_EXTRA_REF_BYTES;
    const rejected = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) { rejected.push(f.name); continue; }
      if (f.size > maxBytes) { rejected.push(`${f.name} (>${maxBytes / 1048576} MB)`); continue; }
      this.extraRefs.push({ uid: foundry.utils.randomID(), blob: f, name: f.name || "pasted", url: URL.createObjectURL(f), purpose: "" });
    }
    if (rejected.length) ui.notifications.warn(game.i18n.format("AIIMG.Gen.RefsRejected", { files: rejected.join(", ") }));
    return this.render();
  }

  async #run(mode) {
    if (this.busy) return;
    cancelEnhance(this.#enhance); // generujemy z tym, co jest w polu; trwające ulepszanie przerywamy (cofnięcie zostaje)
    this.error = "";
    if (!this.description.trim()) {
      this.error = game.i18n.localize("AIIMG.Gen.NeedDescription");
      return this.render();
    }
    const refs = this.extraRefs.map((r) => r.blob);
    const extraRefPurposes = this.extraRefs.map((r) => r.purpose || "");
    const refsFiles = this.saveRef ? [...refs] : [];
    const count = this.count;
    const overrides = this.#overrides(readiness(this.document).cfg);
    this.busy = mode;
    await this.render();
    try {
      if (mode === "fast") {
        if (count === 1 && !this.preview) {
          let saved = null;
          await runFast(this.document, this.description, { extraRefs: refs, extraRefPurposes, overrides, onSaved: (st) => { saved = st; } });
          ui.notifications.info(saved?.changed
            ? game.i18n.format("AIIMG.Gen.DoneSized", { name: esc(this.document.name), before: fmtBytes(saved.bytesBefore), after: fmtBytes(saved.bytesAfter) })
            : game.i18n.format("AIIMG.Gen.Done", { name: esc(this.document.name) }));
        } else {
          const description = this.description;
          const res = await generateCandidates(this.document, description, { count, extraRefs: refs, extraRefPurposes, overrides });
          if (res.failed.length) {
            ui.notifications.warn(game.i18n.format("AIIMG.Gen.SomeFailed", { failed: res.failed.length, total: count, error: safeMessage(res.failed[0].error) }));
          }
          PickApp.open({
            document: this.document, candidates: res.candidates, meta: res.meta, source: "memory",
            regenerate: () => generateCandidates(this.document, description, { count, extraRefs: refs, extraRefPurposes, overrides })
          });
        }
      } else {
        await runBatch(this.document, this.description, { count, extraRefs: refs, extraRefPurposes, overrides });
        ui.notifications.info(game.i18n.format(count > 1 ? "AIIMG.Gen.QueuedMany" : "AIIMG.Gen.Queued", { name: esc(this.document.name), n: count }));
      }
      savePrefs({ count: this.count, preview: this.preview });
      await this.#persistRefs(refsFiles);
      return this.close();
    } catch (e) {
      console.error(`${MODULE_ID} |`, e);
      // Shown inline in the dialog (it stays open), so no toast with the same text.
      this.error = safeMessage(e?.message ?? String(e));
      this.busy = null;
      return this.render();
    }
  }

  /** After a successful run: upload the extra references to _refs/ and append them to the type config. */
  async #persistRefs(files) {
    if (!files.length || !game.user.isGM) return;
    const key = resolveTypeKey(this.document);
    if (!key) return;
    try {
      const paths = [];
      for (const f of files) paths.push(await saveRefFile(f, key));
      const cfg = getConfig(key);
      await setConfig(key, { ...cfg, refs: [...new Set([...cfg.refs, ...paths])] });
      ui.notifications.info(game.i18n.format("AIIMG.Gen.RefsSaved", { n: paths.length }));
    } catch (e) {
      console.error(`${MODULE_ID} |`, e);
      ui.notifications.warn(game.i18n.format("AIIMG.Gen.RefsSaveFailed", { error: safeMessage(e.message) }));
    }
  }

  static #onFast() { return this.#run("fast"); }
  static #onBatch() { return this.#run("batch"); }
  static #onOpenConfig() { ImageConfigApp.open(); }
  static #onAddRefs() { this.element.querySelector("input[name=refFiles]")?.click(); }
  static #onRemoveRef(event, target) {
    const i = this.extraRefs.findIndex((r) => r.uid === target.dataset.uid);
    if (i < 0) return;
    URL.revokeObjectURL(this.extraRefs[i].url);
    this.extraRefs.splice(i, 1);
    return this.render();
  }
}
