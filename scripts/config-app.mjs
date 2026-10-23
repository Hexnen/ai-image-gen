import { MODULE_ID } from "./constants.mjs";
import { detectImageTypes } from "./image-types.mjs";
import { getConfig, setConfig, resetConfig, isConfigured, SIZE_PRESETS, QUALITIES } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { getUsage } from "./limits.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const filePicker = () => foundry.applications.apps.FilePicker.implementation;

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
      removeRef: ImageConfigApp.#onRemoveRef,
      save: ImageConfigApp.#onSave,
      reset: ImageConfigApp.#onReset
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/config.hbs` }
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
    const models = providers.listModels(cfg.provider).map((m) => ({ ...m, selected: m.id === cfg.model }));
    const sizeId = `${cfg.width}x${cfg.height}`;
    const customSize = !!cfg.custom || !SIZE_PRESETS.some((s) => s.id === sizeId);
    const sizes = SIZE_PRESETS.map((s) => ({
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
      qualities: QUALITIES.map((q) => ({
        id: q, selected: q === cfg.quality, label: game.i18n.localize(`AIIMG.Quality.${q}`)
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
    el.querySelectorAll("input[name=defaultMode]").forEach((r) =>
      r.addEventListener("change", () => {
        this.#readFormExceptSize();
        this.render();
      }));
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

  static #onRemoveRef(event, target) {
    this.#readForm();
    this.draft.refs.splice(Number(target.dataset.index), 1);
    this.render();
  }

  static async #onSave() {
    this.#readForm();
    try {
      await setConfig(this.selectedKey, this.draft);
      ui.notifications.info(game.i18n.localize("AIIMG.Config.Saved"));
    } catch (e) {
      ui.notifications.error(e.message);
    }
    this.draft = null;
    this.render();
  }

  static async #onReset() {
    try {
      await resetConfig(this.selectedKey);
    } catch (e) {
      ui.notifications.error(e.message);
    }
    this.draft = null;
    this.render();
  }
}
