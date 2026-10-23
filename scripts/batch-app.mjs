import { MODULE_ID } from "./constants.mjs";
import { PROVIDERS } from "./providers/index.mjs";
import { openPickForBatch } from "./pick-app.mjs";
import { listBatches, removeBatch, isActive, checkBatches, cancelBatch } from "./batch/index.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Podgląd batchy: status, koszt, odśwież / anuluj / usuń z listy. */
export class BatchesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-batches`,
    classes: ["aiimg-batches"],
    tag: "div",
    window: { title: "AIIMG.Batches.Title", icon: "fa-solid fa-layer-group", resizable: true },
    position: { width: 640, height: 420 },
    actions: {
      refresh: BatchesApp.#onRefresh,
      cancel: BatchesApp.#onCancel,
      remove: BatchesApp.#onRemove,
      pick: BatchesApp.#onPick
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/batches.hbs` }
  };

  static #instance;

  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  #hook = (rec) => { if (this.rendered) this.render(); };

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    Hooks.on("aiImageGen.batchUpdate", this.#hook);
  }

  _onClose(options) {
    super._onClose?.(options);
    Hooks.off("aiImageGen.batchUpdate", this.#hook);
  }

  async _prepareContext() {
    const batches = listBatches().map((rec) => {
      const cost = rec.cost ?? rec.ingest?.cost;
      return {
        id: rec.id,
        provider: PROVIDERS[rec.provider]?.label ?? rec.provider,
        model: rec.model,
        status: rec.status,
        statusLabel: game.i18n.has(`AIIMG.Batches.Status.${rec.status}`)
          ? game.i18n.localize(`AIIMG.Batches.Status.${rec.status}`) : rec.status,
        created: rec.createdAt ? new Date(rec.createdAt).toLocaleString() : "",
        count: rec.items?.length ?? 0,
        names: (rec.items ?? []).map((i) => i.meta?.name).filter(Boolean).slice(0, 3).join(", "),
        cost: cost != null ? `$${Number(cost).toFixed(3)}` : `~$${Number(rec.estimatedCost ?? 0).toFixed(3)}`,
        costReal: cost != null,
        error: rec.error ?? (rec.failed?.length ? game.i18n.format("AIIMG.Batches.Failed", { n: rec.failed.length }) : ""),
        active: isActive(rec),
        cancelling: rec.status === "cancelling",
        awaitingPick: rec.status === "awaiting-pick" && !!rec.candidates?.length
      };
    });
    return { batches, empty: batches.length === 0 };
  }

  static async #onRefresh() {
    try { await checkBatches({ force: true }); }
    catch (e) { ui.notifications.error(e.message); }
    this.render();
  }

  static async #onCancel(event, target) {
    try { await cancelBatch(target.dataset.id); }
    catch (e) { ui.notifications.error(e.message); }
    this.render();
  }

  static async #onPick(event, target) {
    try { await openPickForBatch(target.dataset.id); }
    catch (e) { ui.notifications.error(e.message); }
  }

  static async #onRemove(event, target) {
    await removeBatch(target.dataset.id);
    this.render();
  }
}
