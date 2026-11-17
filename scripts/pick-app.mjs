import { MODULE_ID, DATA_ROOT } from "./constants.mjs";
import { commitCandidate } from "./generate-flow.mjs";
import { applyImage } from "./save-image.mjs";
import { getBatch, patchBatch } from "./batch/record.mjs";
import { safeMessage } from "./redact.mjs";
import { getConfig } from "./config-store.mjs";
import { optimizeForSave, optimizeEnabled, outputOptsFromConfig, fmtBytes } from "./optimize.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const t = (k, d) => game.i18n.format(k, d ?? {});
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * Wybór jednej z kilku wersji obrazu.
 *  - source "memory" (Fast): kandydaci to Blob-i w pamięci; na dysk trafia tylko wybrany
 *    (i, na życzenie, pozostałe). Brak plików-sierot.
 *  - source "disk" (Batch): kandydaci są już w Data/ai-image-gen/_candidates/<batchId>/.
 *    Foundry nie pozwala modułowi kasować plików, więc niewybrane zostają w tym folderze.
 */
export class PickApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aiimg-pick"],
    tag: "div",
    window: { title: "AIIMG.Pick.Title", icon: "fa-solid fa-images", resizable: true },
    position: { width: 760, height: "auto" },
    actions: {
      use: PickApp.#onUse,
      zoom: PickApp.#onZoom,
      discardAll: PickApp.#onDiscard,
      regenerate: PickApp.#onRegenerate
    }
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/pick.hbs` } };

  /**
   * @param {object} p
   * @param {foundry.abstract.Document} p.document
   * @param {{id?:string, blob?:Blob, path?:string, cost?:number}[]} p.candidates
   * @param {object} [p.meta]            meta zapisu (system/docType/name) dla source "memory"
   * @param {"memory"|"disk"} [p.source]
   * @param {string} [p.batchId]         rekord batcha (source "disk")
   * @param {() => Promise<{candidates:object[]}>} [p.regenerate]  dogenerowanie kolejnych wersji (Fast)
   */
  static open({ document, candidates, meta, source = "memory", batchId, regenerate, commit, onPicked, onCancel, outOpts, title }) {
    const id = `${MODULE_ID}-pick-${batchId ?? foundry.utils.randomID()}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) { existing.bringToFront?.(); return existing; }
    const app = new this({ id, document, candidates, meta, source, batchId, regenerate, commit, onPicked, onCancel, outOpts, title });
    app.render({ force: true });
    return app;
  }

  #decided = false;
  /** Handoff mode: the caller was already told the outcome (picked or cancelled): never answer twice. */
  #resolved = false;
  #busy = false;
  #keep = false;
  #nextIndex = 0;
  #error = "";
  #closed = false;

  constructor({ document, candidates, meta, source, batchId, regenerate, commit, onPicked, onCancel, outOpts, title, ...options }) {
    super(options);
    this.outOpts = outOpts ?? null; // saved-file settings of the caller (handoff mode); measured and used at commit
    this.customTitle = title ?? "";
    // "Handoff" mode (module API): no document; the caller saves the chosen blob (commit) and learns the result.
    this.commitFn = commit ?? null;
    this.onPicked = onPicked ?? null;
    this.onCancel = onCancel ?? null;
    this.document = document;
    this.meta = meta;
    this.source = source;
    this.batchId = batchId;
    this.regenerate = regenerate;
    this.cands = [];
    this.#add(candidates);
  }

  #add(list) {
    if (this.#closed) return; // closed while a regeneration was running: no object URLs nobody can release
    for (const c of list) {
      const index = ++this.#nextIndex;
      const src = c.blob ? URL.createObjectURL(c.blob) : foundry.utils.getRoute(c.path);
      this.cands.push({ ...c, index, uid: `c${index}`, src });
    }
  }

  get title() {
    return this.customTitle || t("AIIMG.Pick.TitleFor", { name: this.document?.name ?? this.meta?.name ?? "" });
  }

  async _prepareContext() {
    return {
      cands: this.cands.map((c) => ({
        uid: c.uid, index: c.index, src: c.src,
        cost: c.cost != null && c.cost > 0 ? `$${Number(c.cost).toFixed(3)}` : "",
        size: PickApp.#sizeText(c)
      })),
      memory: this.source === "memory",
      handoff: !!this.commitFn, // another module asked for the image: no document is involved
      canRegenerate: this.source === "memory" && !!this.regenerate,
      keep: this.#keep,
      busy: this.#busy,
      error: this.#error,
      folder: this.batchId ? `${DATA_ROOT}/_candidates/${this.batchId}` : ""
    };
  }

  /** Rozmiar pliku: oryginał, a po zmierzeniu optymalizacji „przed → po” (tak zapisze się wybrany obraz). */
  static #sizeText(c) {
    if (!c.blob) return "";
    if (c.opt?.changed) return `${fmtBytes(c.opt.bytesBefore)} → ${fmtBytes(c.opt.bytesAfter)}`;
    return fmtBytes(c.blob.size);
  }

  /** Zmierz optymalizację kandydatów w tle (wynik jest użyty przy zapisie, bez ponownego kodowania). */
  async #measure() {
    if (this.source !== "memory" || !optimizeEnabled()) return;
    const opts = this.outOpts ?? outputOptsFromConfig(this.meta?.typeKey ? getConfig(this.meta.typeKey) : {});
    for (const c of this.cands) {
      if (this.#closed) return;
      if (c.opt || c.measuring || !c.blob) continue;
      c.measuring = true;
      try { c.opt = await optimizeForSave(c.blob, opts); } finally { c.measuring = false; }
      const el = this.element?.querySelector(`[data-role=size][data-uid="${c.uid}"]`);
      if (el) el.textContent = PickApp.#sizeText(c);
    }
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#measure();
    this.element.querySelector("input[name=keep]")
      ?.addEventListener("change", (ev) => { this.#keep = ev.target.checked; });
  }

  _onClose(options) {
    super._onClose?.(options);
    this.#closed = true;
    for (const c of this.cands) if (c.blob) URL.revokeObjectURL(c.src);
  }

  /** Zamknięcie bez wyboru: dla kandydatów w pamięci pytamy o zapis/odrzucenie. */
  async close(options = {}) {
    if (this.#busy && !options.force) {
      ui.notifications.warn(t("AIIMG.Pick.BusyClose"));
      return this;
    }
    if (this.source === "memory" && !this.#decided && this.cands.length && !options.force) {
      // Handoff (another module asked for ONE image): saving "all" makes no sense, only discard or keep choosing.
      const handoff = !!this.commitFn;
      const buttons = [
        ...(handoff ? [] : [{ action: "save", label: t("AIIMG.Pick.SaveAll"), icon: "fa-solid fa-floppy-disk" }]),
        { action: "discard", label: t("AIIMG.Pick.DiscardAll"), icon: "fa-solid fa-trash", default: true },
        { action: "cancel", label: t("AIIMG.Pick.Cancel"), icon: "fa-solid fa-xmark" }
      ];
      const choice = await DialogV2.wait({
        window: { title: t("AIIMG.Pick.CloseTitle"), icon: "fa-solid fa-floppy-disk" },
        content: `<p>${t(handoff ? "AIIMG.Pick.CloseBodyHandoff" : "AIIMG.Pick.CloseBody", { n: this.cands.length })}</p>`,
        buttons,
        rejectClose: false
      });
      if (!choice || choice === "cancel") return this;
      if (choice === "save") {
        try { await this.#saveCandidates(this.cands, { apply: false }); }
        catch (e) { ui.notifications.error(safeMessage(e.message), { console: false }); return this; }
      }
      this.#decided = true;
    }
    // Only now (after the user confirmed discarding) the caller that asked for the image hears "cancelled".
    if (this.commitFn && !this.#resolved) { this.#resolved = true; this.onCancel?.(); }
    return super.close(options);
  }

  /** Disk batch: another window (or GM) may have decided already; do not apply twice. */
  async #stillAwaiting() {
    if (!this.batchId || getBatch(this.batchId)?.status === "awaiting-pick") return true;
    ui.notifications.warn(t("AIIMG.Pick.AlreadyDecided"));
    this.#decided = true;
    await this.close({ force: true });
    return false;
  }

  async #saveCandidates(list, { apply }) {
    const paths = [];
    for (const c of list) paths.push(this.commitFn ? await this.commitFn(c) : await commitCandidate(this.document, c, this.meta, { apply }));
    return paths;
  }

  async #finishBatch(patch) {
    if (this.batchId) await patchBatch(this.batchId, { candidates: undefined, ...patch }, { onlyStatus: "awaiting-pick" });
  }

  static async #onUse(event, target) {
    if (this.#busy) return;
    const chosen = this.cands.find((c) => c.uid === target.dataset.uid);
    if (!chosen) return;
    this.#busy = true;
    this.#error = "";
    await this.render();
    try {
      if (this.commitFn) {
        const path = await this.commitFn(chosen);
        const others = this.#keep ? await this.#saveCandidates(this.cands.filter((c) => c !== chosen), { apply: false }) : [];
        this.#decided = true;
        this.#resolved = true;
        this.onPicked?.({ path, others, candidate: chosen });
        return this.close({ force: true });
      }
      if (this.source === "memory") {
        await commitCandidate(this.document, chosen, this.meta, { apply: true });
        if (this.#keep) await this.#saveCandidates(this.cands.filter((c) => c !== chosen), { apply: false });
      } else {
        if (!(await this.#stillAwaiting())) return;
        await applyImage(this.document.uuid, chosen.path, "img");
        await this.#finishBatch({ status: "done", picked: chosen.path });
      }
      this.#decided = true;
      ui.notifications.info(t("AIIMG.Gen.Done", { name: esc(this.document.name) }));
      return this.close({ force: true });
    } catch (e) {
      console.error(`${MODULE_ID} |`, e);
      this.#error = e?.message ?? String(e);
      this.#busy = false;
      return this.render();
    }
  }

  static #onZoom(event, target) {
    const c = this.cands.find((x) => x.uid === target.dataset.uid);
    if (!c) return;
    const Popout = foundry.applications.apps.ImagePopout;
    new Popout({ src: c.src, window: { title: `${this.document?.name ?? ""} #${c.index}` } }).render({ force: true });
  }

  static async #onDiscard() {
    if (this.#busy) return;
    if (this.source === "disk") {
      if (!(await this.#stillAwaiting())) return;
      await this.#finishBatch({ status: "done", picked: null, discarded: true });
      ui.notifications.info(t("AIIMG.Pick.DiscardedDisk", { folder: `${DATA_ROOT}/_candidates/${this.batchId}` }));
    }
    this.#decided = true;
    return this.close({ force: true }); // close() tells the handoff caller "cancelled" (once)
  }

  static async #onRegenerate() {
    if (this.#busy || !this.regenerate) return;
    this.#busy = true;
    this.#error = "";
    await this.render();
    try {
      const res = await this.regenerate();
      this.#add(res.candidates);
    } catch (e) {
      this.#error = e?.message ?? String(e);
    }
    this.#busy = false;
    return this.render();
  }
}

/** Otwórz okno wyboru dla rekordu batcha w stanie "awaiting-pick". */
export async function openPickForBatch(batchId) {
  const rec = getBatch(batchId);
  if (!rec?.candidates?.length) {
    ui.notifications.warn(t("AIIMG.Pick.NothingToPick"));
    return null;
  }
  const first = rec.items?.[0];
  const doc = await fromUuid(first?.target?.uuid);
  if (!doc) {
    ui.notifications.error(t("AIIMG.Pick.DocMissing"));
    return null;
  }
  return PickApp.open({
    document: doc, source: "disk", batchId,
    candidates: rec.candidates.map((c) => ({ path: c.path, cost: c.cost }))
  });
}
