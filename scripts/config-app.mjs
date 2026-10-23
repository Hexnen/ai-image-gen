import { MODULE_ID } from "./constants.mjs";
import { safeMessage } from "./redact.mjs";
import { detectImageTypes } from "./image-types.mjs";
import { getConfig, setConfig, resetConfig, isConfigured, sizePresetsFor, fitConfig } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { getUsage } from "./limits.mjs";
import { saveRefFile, saveTestExample } from "./save-image.mjs";
import { getKey } from "./settings.mjs";
import { buildTestPrompt, fitTestConfig, estimateTest, generateTest } from "./generate-flow.mjs";
import { TestDrawerApp } from "./test-drawer-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const MAX_TEST_VERSIONS = 4;
const MAX_RUNS = 10;
const filePicker = () => foundry.applications.apps.FilePicker.implementation;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

export class ImageConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-config`,
    classes: ["aiimg-config"],
    tag: "div",
    window: { title: "AIIMG.Config.Title", icon: "fa-solid fa-wand-magic-sparkles", resizable: true },
    position: { width: 860, height: 640 },
    actions: {
      selectType: ImageConfigApp.#onSelectType,
      filter: ImageConfigApp.#onFilter,
      addRef: ImageConfigApp.#onAddRef,
      uploadRefs: ImageConfigApp.#onUploadRefs,
      removeRef: ImageConfigApp.#onRemoveRef,
      save: ImageConfigApp.#onSave,
      reset: ImageConfigApp.#onReset
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/config.hbs`, scrollable: [".aiimg-form", ".aiimg-types ul"] }
  };

  static #instance;

  /** Open (or focus) the single config window. */
  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  selectedKey = null;
  groupFilter = "all";
  /** Unsaved edits for the selected type; discarded on type switch. */
  draft = null;

  /**
   * Test drawer state. Runs live in memory only (Blob + object URL), newest first, max MAX_RUNS; nothing
   * touches a document or the disk until the user saves an example.
   */
  test = { open: false, key: null, description: "", name: "", type: "", count: 1, running: false, confirming: false, runs: [], shown: null };

  /** The side panel docked to this window (GM only). */
  #drawer = null;

  /** Closing without Save discards the draft (the window is a singleton and would otherwise keep it). */
  _onClose(options) {
    this.draft = null;
    this.#clearRuns();
    this.test.key = null; // an in-flight test keeps `running` until it settles, so a reopened window cannot start a second one
    this.#drawer?.close();
    this.#drawer = null;
    return super._onClose?.(options);
  }

  _onPosition(position) {
    super._onPosition?.(position);
    this.#drawer?.dock();
  }

  bringToFront() {
    super.bringToFront();
    this.#drawer?.dock();
  }

  #clearRuns() {
    for (const r of this.test.runs) for (const it of r.items) URL.revokeObjectURL(it.url);
    this.test.runs = [];
    this.test.shown = null;
  }

  #storeKey() {
    return `${MODULE_ID}.test.${this.selectedKey}`;
  }

  /** Switch the drawer to the selected type: restore the remembered inputs, drop the previous type's runs. */
  #syncTestKey(selected) {
    if (this.test.key === this.selectedKey) return;
    this.#clearRuns();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(this.#storeKey()) ?? "{}") ?? {}; } catch { /* no storage */ }
    this.test.key = this.selectedKey;
    this.test.description = String(saved.description ?? "");
    this.test.name = String(saved.name ?? "");
    this.test.type = String(saved.type ?? selected?.label ?? "");
    this.test.count = Math.min(MAX_TEST_VERSIONS, Math.max(1, Number(saved.count) || 1));
  }

  #persistTest() {
    const { description, name, type, count } = this.test;
    try { localStorage.setItem(this.#storeKey(), JSON.stringify({ description, name, type, count })); } catch { /* no storage */ }
  }

  /** Copy the drawer inputs into the state (and storage). */
  #readTest() {
    const el = this.#drawer?.element;
    if (!el) return;
    const v = (n) => el.querySelector(`[name=${n}]`)?.value;
    const t = this.test;
    t.description = v("testDescription") ?? t.description;
    t.name = v("testName") ?? t.name;
    t.type = v("testType") ?? t.type;
    t.count = Math.min(MAX_TEST_VERSIONS, Math.max(1, Number(v("testCount")) || t.count));
    this.#persistTest();
  }

  /** The draft completed with model-fitted values, exactly as a run would use it. */
  #testConfig() {
    return fitTestConfig(this.draft ?? getConfig(this.selectedKey));
  }

  /** Refresh prompt / counters / estimate in place (no re-render, so focus and caret survive). */
  #updateTestPreview() {
    const el = this.#drawer?.element;
    if (!el || !this.draft) return;
    const cfg = this.#testConfig();
    const prompt = buildTestPrompt(cfg, this.test);
    const set = (role, text) => { const n = el.querySelector(`[data-role=${role}]`); if (n) n.textContent = text; };
    set("testPrompt", prompt);
    set("testChars", game.i18n.format("AIIMG.Test.Chars", { n: prompt.length }));
    set("testRefs", game.i18n.format("AIIMG.Test.Refs", { n: cfg.refs.length }));
    set("testEstimate", game.i18n.format("AIIMG.Test.Estimate", { cost: estimateTest(cfg, this.test.count).toFixed(3) }));
    el.querySelector("[data-role=testEmpty]")?.toggleAttribute("hidden", !!prompt.trim());
  }

  #testContext(cfg, selected) {
    this.#syncTestKey(selected);
    const t = this.test;
    const fitted = fitTestConfig(cfg);
    const prompt = buildTestPrompt(fitted, t);
    const run = t.runs.find((r) => r.id === t.shown) ?? t.runs[0];
    const fmt = (n) => Number(n || 0).toFixed(3);
    return {
      open: t.open,
      description: t.description,
      name: t.name,
      type: t.type,
      counts: Array.from({ length: MAX_TEST_VERSIONS }, (_, i) => ({ value: i + 1, selected: i + 1 === t.count })),
      prompt,
      chars: game.i18n.format("AIIMG.Test.Chars", { n: prompt.length }),
      refs: game.i18n.format("AIIMG.Test.Refs", { n: fitted.refs.length }),
      empty: !prompt.trim(),
      estimate: game.i18n.format("AIIMG.Test.Estimate", { cost: fmt(estimateTest(fitted, t.count)) }),
      hasKey: !!getKey(fitted.provider),
      running: t.running,
      busy: t.running || t.confirming,
      results: (run?.items ?? []).map((it, index) => ({ index, url: it.url, cost: game.i18n.format("AIIMG.Test.Cost", { cost: fmt(it.cost) }) })),
      history: t.runs.map((r) => ({
        id: r.id,
        thumb: r.items[0]?.url,
        text: r.description.length > 70 ? `${r.description.slice(0, 70)}…` : r.description || "—",
        cost: game.i18n.format("AIIMG.Test.Cost", { cost: fmt(r.cost) }),
        seconds: game.i18n.format("AIIMG.Test.Seconds", { s: (r.durationMs / 1000).toFixed(1) }),
        active: r.id === run?.id
      }))
    };
  }

  /** Context for the docked test drawer (rendered by TestDrawerApp). */
  drawerContext() {
    const selected = detectImageTypes().find((t) => t.key === this.selectedKey);
    const cfg = (this.draft ??= getConfig(this.selectedKey));
    return { open: this.test.open, test: this.#testContext(cfg, selected) };
  }

  async _prepareContext() {
    const types = detectImageTypes();
    if (!this.selectedKey || !types.some((t) => t.key === this.selectedKey)) {
      this.selectedKey = types[0]?.key ?? null;
      this.draft = null;
    }
    const visible = types.filter((t) => this.groupFilter === "all" || t.group === this.groupFilter);
    const selected = types.find((t) => t.key === this.selectedKey);
    const cfg = (this.draft ??= getConfig(this.selectedKey));

    const providerList = Object.entries(providers.PROVIDERS).map(([id, p]) => ({
      id, label: p.label, selected: id === cfg.provider
    }));
    const L = (k) => game.i18n.localize(k);
    const models = providers.listModels(cfg.provider).map((m) => ({
      id: m.id,
      label: m.note ? `${m.label} — ${L(`AIIMG.ModelNote.${m.note}`)}` : m.label,
      selected: m.id === cfg.model
    }));
    const caps = providers.modelCaps(cfg.provider, cfg.model);
    const presets = sizePresetsFor(cfg.provider, cfg.model);
    const sizeId = `${cfg.width}x${cfg.height}`;
    const customSize = !!cfg.custom || !presets.some((s) => s.id === sizeId);
    const exactSize = cfg.provider === "openai" && !!caps?.customSize; // 2.5: any WxH (x16)
    const sizes = presets.map((s) => ({
      ...s, label: `${s.width}×${s.height}`, selected: !customSize && s.id === sizeId
    }));
    const supportsBatch = !!providers.PROVIDERS[cfg.provider]?.supportsBatch;
    const usage = getUsage();

    return {
      filters: ["all", "Actor", "Item", "Macro"].map((g) => ({
        id: g,
        active: this.groupFilter === g,
        label: g === "all" ? game.i18n.localize("AIIMG.Config.All") : game.i18n.localize(`DOCUMENT.${g}`)
      })),
      types: visible.map((t) => ({ ...t, active: t.key === this.selectedKey, configured: isConfigured(t.key) })),
      selected,
      cfg,
      providerList,
      models,
      sizes,
      customSize,
      isFast: cfg.defaultMode === "fast",
      isBatch: cfg.defaultMode === "batch",
      supportsBatch,
      isOpenAI: cfg.provider === "openai",
      isGemini: cfg.provider === "gemini",
      allowCustomSize: cfg.provider !== "openai" || exactSize,
      sizeStep: exactSize ? 16 : 64,
      sizeMax: exactSize ? 3840 : 4096,
      exactSize,
      qualities: (caps?.qualities ?? providers.OPENAI_QUALITIES_OLD).map((q) => ({
        id: q, selected: q === cfg.quality, label: L(`AIIMG.Quality.${q}`)
      })),
      imageSizes: (caps?.sizes ?? []).map((v) => ({ id: v, label: v, selected: v === cfg.imageSize })),
      hasThinking: !!caps?.thinking?.length,
      thinkingLevels: (caps?.thinking ?? []).map((v) => ({
        id: v, selected: v === (cfg.thinkingLevel || caps.defaultThinking),
        label: L(`AIIMG.Thinking.${v}`) + (v === caps.defaultThinking ? ` (${L("AIIMG.Thinking.default")})` : "")
      })),
      batchWarn: cfg.defaultMode === "batch" && !supportsBatch,
      refs: cfg.refs.map((path, index) => ({ path, index })),
      usage: { day: usage.day.toFixed(2), month: usage.month.toFixed(2) },
      isGM: game.user.isGM
    };
  }

  /** Copy the form fields into the draft so re-renders keep unsaved edits. */
  #readForm() {
    const form = this.element?.querySelector("form.aiimg-form");
    if (!form || !this.draft) return;
    const fd = new foundry.applications.ux.FormDataExtended(form).object;
    const d = this.draft;
    d.provider = fd.provider ?? d.provider;
    d.model = fd.model ?? d.model;
    d.promptTemplate = fd.promptTemplate ?? d.promptTemplate;
    d.defaultMode = fd.defaultMode ?? d.defaultMode;
    d.quality = fd.quality ?? d.quality;
    d.imageSize = fd.imageSize ?? d.imageSize;
    d.thinkingLevel = fd.thinkingLevel ?? d.thinkingLevel;
    if (fd.size && fd.size !== "custom") {
      const [w, h] = fd.size.split("x").map(Number);
      d.width = w;
      d.height = h;
    } else if (fd.width || fd.height) {
      d.width = Number(fd.width) || d.width;
      d.height = Number(fd.height) || d.height;
    }
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    // Provider change: fall back to that provider's first model (and Fast if no batch).
    el.querySelector("select[name=provider]")?.addEventListener("change", () => {
      this.#readForm();
      const models = providers.listModels(this.draft.provider);
      this.draft.model = models[0]?.id ?? "";
      if (!providers.PROVIDERS[this.draft.provider]?.supportsBatch) this.draft.defaultMode = "fast";
      Object.assign(this.draft, fitConfig(this.draft));
      this.draft.custom = false;
      this.render();
    });
    // Model change: re-clamp quality / size / thinking to what the new model supports.
    el.querySelector("select[name=model]")?.addEventListener("change", () => {
      this.#readForm();
      Object.assign(this.draft, fitConfig(this.draft));
      this.draft.custom = false;
      this.render();
    });
    // Switching to "custom" must keep the current numbers; switching away applies the preset.
    el.querySelector("select[name=size]")?.addEventListener("change", (ev) => {
      const v = ev.target.value;
      if (v === "custom") {
        this.draft.custom = true; // keep the current numbers, just reveal the inputs
      } else {
        this.draft.custom = false;
        const [w, h] = v.split("x").map(Number);
        this.draft.width = w;
        this.draft.height = h;
      }
      this.#readFormExceptSize();
      this.render();
    });
    // Quality / image size / thinking / custom width+height only change the draft and the live estimate
    // (no re-render, so focus and caret survive). Provider, model, size preset and mode re-render above.
    for (const n of ["quality", "imageSize", "thinkingLevel", "width", "height"]) {
      const f = el.querySelector(`[name=${n}]`);
      f?.addEventListener(f.tagName === "SELECT" ? "change" : "input", () => this.#onDraftInput());
    }
    this.#wireRefZone(el.querySelector(".aiimg-refs"));
    el.querySelector("textarea[name=promptTemplate]")?.addEventListener("input", () => this.#onDraftInput());
    if (game.user.isGM) {
      this.#drawer ??= new TestDrawerApp(this);
      this.#drawer.render({ force: true });
    }
    el.querySelector("input[name=refUpload]")?.addEventListener("change", (ev) => {
      this.#uploadFiles([...ev.target.files]);
      ev.target.value = "";
    });
    el.querySelectorAll("input[name=defaultMode]").forEach((r) =>
      r.addEventListener("change", () => {
        this.#readFormExceptSize();
        this.render();
      }));
  }

  /** Typing in the template or the sample inputs updates the drawer preview without a re-render. */
  #onDraftInput() {
    this.#readForm();
    this.#readTest();
    this.#updateTestPreview();
  }

  /** Called by the drawer after each of its renders: hook its inputs up to the live preview. */
  wireDrawer(el) {
    const live = () => this.#onDraftInput();
    for (const n of ["testDescription", "testName", "testType"]) el.querySelector(`[name=${n}]`)?.addEventListener("input", live);
    el.querySelector("select[name=testCount]")?.addEventListener("change", live);
  }

  toggleDrawer() {
    this.test.open = !this.test.open;
    this.#drawer?.render();
  }

  /** Drag&drop and Ctrl+V (while the zone has focus) upload images as permanent references. */
  #wireRefZone(zone) {
    if (!zone || !game.user.isGM) return;
    const imgs = (list) => [...(list ?? [])].filter((f) => f.type?.startsWith("image/"));
    zone.addEventListener("dragover", (ev) => {
      if ([...(ev.dataTransfer?.types ?? [])].includes("Files")) { ev.preventDefault(); zone.classList.add("aiimg-dragging"); }
    });
    zone.addEventListener("dragleave", (ev) => {
      if (!zone.contains(ev.relatedTarget)) zone.classList.remove("aiimg-dragging");
    });
    zone.addEventListener("drop", (ev) => {
      zone.classList.remove("aiimg-dragging");
      const files = imgs(ev.dataTransfer?.files);
      if (!files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.#uploadFiles(files);
    });
    zone.addEventListener("paste", (ev) => {
      const files = imgs(ev.clipboardData?.files);
      if (!files.length) return;
      ev.preventDefault();
      this.#uploadFiles(files);
    });
  }

  /** Upload to _refs/<system>/<type>/ and append the stored paths to the draft (not saved until Save). */
  async #uploadFiles(files) {
    if (!files.length || !this.selectedKey || this.uploading) return;
    this.#readForm();
    this.uploading = true;
    const errors = [];
    try {
      for (const f of files) {
        try {
          const path = await saveRefFile(f, this.selectedKey);
          if (!this.draft.refs.includes(path)) this.draft.refs.push(path);
        } catch (e) { errors.push(e.message); }
      }
    } finally {
      this.uploading = false;
    }
    if (errors.length) ui.notifications.warn(game.i18n.format("AIIMG.Config.UploadFailed", { error: safeMessage(errors.join("; ")) }));
    this.render();
  }

  /** Like #readForm but leaves width/height as the size handler set them. */
  #readFormExceptSize() {
    const { width, height } = this.draft;
    this.#readForm();
    this.draft.width = width;
    this.draft.height = height;
  }

  static #onSelectType(event, target) {
    this.#readForm();
    this.#readTest();
    this.selectedKey = target.dataset.key;
    this.draft = null;
    this.render();
  }

  static #onFilter(event, target) {
    this.groupFilter = target.dataset.group;
    this.render();
  }

  static #onAddRef() {
    this.#readForm();
    new (filePicker())({
      type: "image",
      callback: (path) => {
        if (!this.draft.refs.includes(path)) this.draft.refs.push(path);
        this.render();
      }
    }).render({ force: true });
  }

  static #onUploadRefs() {
    this.element.querySelector("input[name=refUpload]")?.click();
  }

  static #onRemoveRef(event, target) {
    this.#readForm();
    this.draft.refs.splice(Number(target.dataset.index), 1);
    this.render();
  }

  #currentRun() {
    return this.test.runs.find((r) => r.id === this.test.shown) ?? this.test.runs[0];
  }

  /** Real (billed) call with the unsaved draft: confirm the estimate first; the core logs it as kind "test". */
  async runTest() {
    const t = this.test;
    if (t.running || t.confirming) return;
    this.#readForm();
    this.#readTest();
    const key = this.selectedKey;
    const draft = foundry.utils.deepClone(this.draft ?? getConfig(key));
    const cfg = fitTestConfig(draft);
    if (!getKey(cfg.provider)) return ui.notifications.warn(game.i18n.localize("AIIMG.Test.NoKey"));
    if (!buildTestPrompt(cfg, t).trim()) return ui.notifications.warn(game.i18n.localize("AIIMG.Test.Empty"));
    const count = t.count;
    // Lock BEFORE the dialog opens, so a second click cannot stack another confirmation (and another paid call).
    t.confirming = true;
    this.#drawer?.render();
    let ok = false;
    try {
      ok = await DialogV2.confirm({
        window: { title: game.i18n.localize("AIIMG.Test.ConfirmTitle") },
        content: `<p>${game.i18n.format("AIIMG.Test.ConfirmBody", {
          provider: esc(providers.PROVIDERS[cfg.provider]?.label ?? cfg.provider),
          model: esc(cfg.model), cost: estimateTest(cfg, count).toFixed(3), count
        })}</p>`,
        yes: { default: false }
      });
    } finally {
      t.confirming = false;
    }
    if (!ok) { this.#drawer?.render(); return; }
    const input = { description: t.description, name: t.name, type: t.type };
    t.running = true;
    this.#drawer?.render();
    const t0 = performance.now();
    try {
      const res = await generateTest(draft, key, { ...input, count });
      const items = res.candidates.map((c) => ({ blob: c.blob, cost: c.cost, url: URL.createObjectURL(c.blob) }));
      if (!this.rendered || this.selectedKey !== key) {
        // Window closed or type switched while the call was in flight: the results are gone, but they were paid for.
        for (const it of items) URL.revokeObjectURL(it.url);
        if (items.length) ui.notifications.warn(game.i18n.format("AIIMG.Test.Discarded", { n: items.length }));
      } else {
        const run = { id: foundry.utils.randomID(), ...input, prompt: res.prompt, cost: res.cost, durationMs: performance.now() - t0, items };
        t.runs.unshift(run);
        for (const old of t.runs.splice(MAX_RUNS)) for (const it of old.items) URL.revokeObjectURL(it.url);
        t.shown = run.id;
        if (res.failed.length) ui.notifications.warn(game.i18n.format("AIIMG.Test.PartFailed", { n: res.failed.length, count }));
      }
    } catch (e) {
      ui.notifications.error(game.i18n.format("AIIMG.Test.Failed", { error: safeMessage(e.message) }));
    } finally {
      t.running = false;
      this.#drawer?.render();
    }
  }

  async saveTest(index) {
    const item = this.#currentRun()?.items[index];
    if (!item) return;
    try {
      const path = await saveTestExample(item.blob, this.selectedKey, this.test.name || "test");
      ui.notifications.info(game.i18n.format("AIIMG.Test.Saved", { path: esc(path) }));
    } catch (e) {
      ui.notifications.error(game.i18n.format("AIIMG.Test.SaveFailed", { error: safeMessage(e.message) }));
    }
  }

  zoomTest(index) {
    const item = this.#currentRun()?.items[index];
    if (!item) return;
    new foundry.applications.apps.ImagePopout({
      src: item.url, window: { title: `${game.i18n.localize("AIIMG.Test.Title")} #${index + 1}` }
    }).render({ force: true });
  }

  /** Load a past try's inputs back into the drawer and show its results. */
  loadTry(id) {
    const run = this.test.runs.find((r) => r.id === id);
    if (!run) return;
    this.#readForm();
    Object.assign(this.test, { description: run.description, name: run.name, type: run.type, shown: run.id, open: true });
    this.#persistTest();
    this.#drawer?.render();
  }

  static async #onSave() {
    this.#readForm();
    try {
      await setConfig(this.selectedKey, this.draft);
      ui.notifications.info(game.i18n.localize("AIIMG.Config.Saved"));
    } catch (e) {
      ui.notifications.error(safeMessage(e.message));
    }
    this.draft = null;
    this.render();
  }

  static async #onReset() {
    try {
      await resetConfig(this.selectedKey);
    } catch (e) {
      ui.notifications.error(safeMessage(e.message));
    }
    this.draft = null;
    this.render();
  }
}
