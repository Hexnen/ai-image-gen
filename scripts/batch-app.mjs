import { MODULE_ID } from "./constants.mjs";
import { PROVIDERS } from "./providers/index.mjs";
import { openPickForBatch } from "./pick-app.mjs";
import { listBatches, removeBatch, isActive, checkBatches, cancelBatch, abandonBatch, retryBatchSave, retryableItems } from "./batch/index.mjs";
import { safeMessage } from "./redact.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
// W6-K: text with an English fallback (the lang keys may not be loaded yet on a server started before they existed)
const tx = (key, fallback, data = {}) => {
  if (game.i18n.has(key)) return game.i18n.format(key, data);
  return fallback.replace(/\{(\w+)\}/g, (_, k) => String(data[k] ?? ""));
};

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
      abandon: BatchesApp.#onAbandon,
      pick: BatchesApp.#onPick,
      retrySave: BatchesApp.#onRetrySave
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/batches.hbs` }
  };

  static #instance;

  static open() {
    if (!game.user.isGM) { ui.notifications.warn(game.i18n.localize("AIIMG.Batches.GMOnly")); return null; }
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
        // W6-K: paid results whose save failed: truthful state + the real reason + a Retry save button
        retryable: retryableItems(rec).length,
        retryNote: retryableItems(rec).length
          ? tx("AIIMG.Batches.RetryAvailable", "{n} paid image(s) not saved: retry available", { n: retryableItems(rec).length }) : "",
        failDetail: (rec.failed ?? []).map((f) => String(f.error ?? "")).filter(Boolean).slice(0, 3).join(" | "),
        retryLabel: tx("AIIMG.Batches.RetrySave", "Retry save (downloads the already generated image again; no new generation, no new cost)"),
        retrying: !!(rec.retrying && rec.retrying.until > Date.now()),
        active: isActive(rec),
        abandonable: isActive(rec) || rec.status === "submitting",
        cancelling: rec.status === "cancelling",
        awaitingPick: rec.status === "awaiting-pick" && !!rec.candidates?.length
      };
    });
    return { batches, empty: batches.length === 0 };
  }

  static async #onRefresh() {
    try { await checkBatches({ force: true }); }
    catch (e) { ui.notifications.error(safeMessage(e.message)); }
    this.render();
  }

  static async #onRetrySave(event, target) {
    try {
      const r = await retryBatchSave(target.dataset.id);
      if (r.saved.length) ui.notifications.info(tx("AIIMG.Batches.RetrySaved", "Saved {n} recovered image(s).", { n: r.saved.length }));
      if (r.failed.length) ui.notifications.warn(tx("AIIMG.Batches.RetryFailed", "{n} image(s) still not saved: {error}", { n: r.failed.length, error: safeMessage(r.failed[0].error) }));
    } catch (e) { ui.notifications.error(safeMessage(e.message)); }
    this.render();
  }

  static async #onCancel(event, target) {
    try { await cancelBatch(target.dataset.id); }
    catch (e) { ui.notifications.error(safeMessage(e.message)); }
    this.render();
  }

  static async #onPick(event, target) {
    try { await openPickForBatch(target.dataset.id); }
    catch (e) { ui.notifications.error(safeMessage(e.message)); }
  }

  static async #onAbandon(event, target) {
    try {
      const ok = await DialogV2.confirm({
        window: { title: game.i18n.localize("AIIMG.Batches.AbandonTitle"), icon: "fa-solid fa-ban" },
        content: `<p>${game.i18n.localize("AIIMG.Batches.AbandonBody")}</p>`,
        rejectClose: false
      });
      if (ok) await abandonBatch(target.dataset.id);
    } catch (e) { ui.notifications.error(safeMessage(e.message)); }
    this.render();
  }

  static async #onRemove(event, target) {
    try { await removeBatch(target.dataset.id); }
    catch (e) { ui.notifications.error(safeMessage(e.message)); }
    this.render();
  }
}
