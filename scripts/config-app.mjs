import { MODULE_ID } from "./constants.mjs";
import { detectImageTypes } from "./image-types.mjs";
import { getConfig, setConfig, resetConfig, isConfigured, sizePresetsFor, fitConfig } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { getUsage } from "./limits.mjs";
import { saveRefFile } from "./save-image.mjs";

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
      uploadRefs: ImageConfigApp.#onUploadRefs,
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
    this.#wireRefZone(el.querySelector(".aiimg-refs"));
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
    if (errors.length) ui.notifications.warn(game.i18n.format("AIIMG.Config.UploadFailed", { error: errors.join("; ") }));
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
