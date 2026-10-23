import { MODULE_ID } from "./constants.mjs";
import { readiness, runFast, runBatch } from "./generate-flow.mjs";
import { ImageConfigApp } from "./config-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Modal: opis + Fast / Batch dla jednego dokumentu. */
export class GenerateDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aiimg-generate"],
    tag: "div",
    window: { title: "AIIMG.Gen.Title", icon: "fa-solid fa-wand-magic-sparkles", resizable: false },
    position: { width: 460, height: "auto" },
    actions: {
      runFast: GenerateDialog.#onFast,
      runBatch: GenerateDialog.#onBatch,
      openConfig: GenerateDialog.#onOpenConfig
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/generate.hbs` }
  };

  /** Open (or focus) the dialog for a document. */
  static open(document) {
    const key = document.uuid ?? `unsaved-${document.documentName}-${document.id ?? document.name}`;
    const id = `${MODULE_ID}-generate-${key.replace(/[^A-Za-z0-9]/g, "-")}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) { existing.bringToFront?.(); return existing; }
    const app = new this({ id, document });
    app.render({ force: true });
    return app;
  }

  constructor({ document, ...options }) {
    super(options);
    this.document = document;
    this.description = "";
    this.busy = null; // "fast" | "batch" | null
    this.error = "";
  }

  get title() {
    return game.i18n.format("AIIMG.Gen.TitleFor", { name: this.document.name });
  }

  async _prepareContext() {
    const r = readiness(this.document);
    return {
      description: this.description,
      cfg: r.cfg,
      providerLabel: r.providerLabel,
      modelLabel: r.modelLabel,
      configured: r.configured,
      hasKey: r.hasKey,
      canBatch: r.canBatch,
      busy: !!this.busy,
      busyFast: this.busy === "fast",
      busyBatch: this.busy === "batch",
      batchDisabled: !r.canBatch || !!this.busy,
      fastDefault: r.cfg.defaultMode === "fast",
      batchDefault: r.cfg.defaultMode === "batch" && r.canBatch,
      error: this.error
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector("textarea[name=description]")
      ?.addEventListener("input", (ev) => { this.description = ev.target.value; });
  }

  async #run(mode) {
    if (this.busy) return;
    this.error = "";
    if (!this.description.trim()) {
      this.error = game.i18n.localize("AIIMG.Gen.NeedDescription");
      return this.render();
    }
    this.busy = mode;
    await this.render();
    try {
      if (mode === "fast") {
        await runFast(this.document, this.description);
        ui.notifications.info(game.i18n.format("AIIMG.Gen.Done", { name: this.document.name }));
      } else {
        await runBatch(this.document, this.description);
        ui.notifications.info(game.i18n.format("AIIMG.Gen.Queued", { name: this.document.name }));
      }
      return this.close();
    } catch (e) {
      console.error(`${MODULE_ID} |`, e);
      this.error = e?.message ?? String(e);
      ui.notifications.error(this.error, { console: false });
      this.busy = null;
      return this.render();
    }
  }

  static #onFast() { return this.#run("fast"); }
  static #onBatch() { return this.#run("batch"); }
  static #onOpenConfig() { ImageConfigApp.open(); }
}
