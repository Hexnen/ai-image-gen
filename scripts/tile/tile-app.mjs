// W7-A AI Tile: okno promptu (podgląd wycinka, opcje, koszt, Teraz / Batch) i okno przeglądu wariantów z podglądem
// na mapie (Akceptuj / Odrzuć / Powtórz). Tylko MG.
import { MODULE_ID, DATA_ROOT } from "../constants.mjs";
import { safeMessage } from "../redact.mjs";
import { patchBatch, getBatch } from "../batch/record.mjs";
import { drawShape } from "./tile-draw.mjs";
import {
  prepareJob, tileOptions, saveTileOptions, estimateJob, readinessFor, generateTileVariants, acceptVariant,
  submitTileBatch, createTile, geomFromMeta, buildJobPrompt
} from "./tile-flow.mjs";
import { TILE_TYPE_KEY, CONTEXT_FACTORS, normalizeTileOptions } from "./tile-core.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const L = (k) => game.i18n.localize(k);
const F = (k, d) => game.i18n.format(k, d ?? {});
const money = (v) => `$${Number(v || 0).toFixed(3)}`;

/** Start z przycisku: rysowanie prostokąta -> okno. */
export async function startAiTile({ points } = {}) {
  if (!game.user.isGM) return null;
  if (!canvas?.ready || !canvas.scene) { ui.notifications.warn(L("AIIMG.Tile.ErrScene")); return null; }
  const drawn = await drawShape({ points });
  if (!drawn) return null;
  return TileDialog.open({ scene: canvas.scene, points: drawn.points });
}

// =====================================================================================================================

export class TileDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-tile`,
    classes: ["aiimg-tile-dialog"],
    tag: "form",
    window: { title: "AIIMG.Tile.Title", icon: "fa-solid fa-vector-square", resizable: true },
    position: { width: 560, height: "auto" },
    form: { handler: TileDialog.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      redraw: TileDialog.#onRedraw,
      openConfig: TileDialog.#onOpenConfig,
      cancelRun: TileDialog.#onCancelRun
    }
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/tile-dialog.hbs` } };

  static open(o) {
    const old = foundry.applications.instances.get(`${MODULE_ID}-tile`);
    if (old) old.close({ force: true });
    const app = new this(o);
    app.render({ force: true });
    return app;
  }

  constructor({ scene, points, description = "", ...options } = {}) {
    super(options);
    this.scene = scene;
    this.points = points;
    this.description = description;
    this.opts = tileOptions();
    this.mode = "fast";
    this.job = null;
    this.urls = [];
    this.busy = false;
    this.error = "";
    this.prepared = this.#prepare();
  }

  async #prepare() {
    this.error = "";
    try {
      this.job = await prepareJob({ scene: this.scene, points: this.points, opts: this.opts, description: this.description, mode: this.mode });
    } catch (e) {
      console.error(`${MODULE_ID} | AI Tile prepare`, e);
      this.job = null;
      this.error = e?.message ?? String(e);
    }
    if (this.rendered) this.render();
    return this.job;
  }

  #url(blob) { if (!blob) return ""; const u = URL.createObjectURL(blob); this.urls.push(u); return u; }

  async _prepareContext() {
    const job = this.job;
    const ready = job ? readinessFor(job.cfg) : null;
    const count = this.opts.count;
    return {
      id: this.id,
      busy: this.busy, error: this.error, preparing: !job && !this.error,
      description: this.description, count, maxVersions: 8, mode: this.mode,
      feather: this.opts.feather,
      contextOptions: CONTEXT_FACTORS.map((f) => ({ value: f, label: `${String(f).replace(".", game.i18n.lang === "pl" ? "," : ".")}×`, selected: f === this.opts.context })),
      ready,
      hasKey: ready?.hasKey ?? true,
      canBatch: ready?.canBatch ?? false,
      noBatch: ready && !ready.canBatch ? L(ready.noBatchReason === "model" ? "AIIMG.Tile.NoBatchModel" : "AIIMG.Tile.NoBatchProvider") : "",
      send: job ? this.#url(job.sendBlob) : "",
      facts: job ? F("AIIMG.Tile.Facts", {
        bw: job.plan.bbox.width, bh: job.plan.bbox.height,
        req: job.plan.request.aspect ? `${job.plan.request.aspect}${job.plan.request.imageSize ? ` ${job.plan.request.imageSize}` : ""}` : `${job.plan.request.width}×${job.plan.request.height}`,
        cw: job.plan.region.width, ch: job.plan.region.height,
        method: L(`AIIMG.Tile.Method.${job.captureMethod}`)
      }) : "",
      clipped: !!job?.plan.clipped,
      inputs: job ? (job.input.tokens != null
        ? F("AIIMG.Tile.InputsTokens", { w: job.input.sent.width, h: job.input.sent.height, t: job.input.tokens })
        : F("AIIMG.Tile.Inputs", { w: job.input.sent.width, h: job.input.sent.height })) : "",
      estimate: job ? F("AIIMG.Tile.Estimate", { cost: money(estimateJob(job, count, this.mode)), n: count }) : "",
      prompt: job ? buildJobPrompt(job, this.description || "…") : ""
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    el.querySelector("textarea[name=description]")?.focus();
    // opcje zmieniające wycinek: przygotuj ponownie (z opóźnieniem); pozostałe tylko przeliczają podgląd
    let t = null;
    el.addEventListener("change", (ev) => {
      const n = ev.target?.name;
      if (!n) return;
      this.#readForm();
      if (["feather", "context", "mode"].includes(n)) {
        clearTimeout(t);
        t = setTimeout(() => { this.job = null; this.render(); this.prepared = this.#prepare(); saveTileOptions(this.opts); }, 150);
      } else if (n === "count") { saveTileOptions(this.opts); this.render(); }
    });
    el.querySelector("textarea[name=description]")?.addEventListener("input", (ev) => {
      this.description = ev.target.value;
      const p = el.querySelector("[data-role=prompt]");
      if (p && this.job) p.textContent = buildJobPrompt(this.job, this.description || "…");
    });
  }

  #readForm() {
    const fd = new foundry.applications.ux.FormDataExtended(this.element).object;
    this.description = String(fd.description ?? this.description);
    this.opts = normalizeTileOptions({
      ...this.opts,
      count: fd.count,
      feather: Number(fd.feather) || 0,
      context: fd.context === undefined ? this.opts.context : Number(fd.context)
    });
    this.mode = fd.mode === "batch" ? "batch" : "fast";
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.abort?.abort();
  }

  static async #onRedraw() {
    const points = this.points;
    this.close({ force: true });
    return startAiTile({ points });
  }

  static #onOpenConfig() {
    import("../config-app.mjs").then((m) => {
      const app = m.ImageConfigApp.open();
      // select the AI Tile type unless the GM has unsaved edits of another type open
      if (!app.draft && app.selectedKey !== TILE_TYPE_KEY) { app.selectedKey = TILE_TYPE_KEY; app.render(); }
    }).catch((e) => console.error(`${MODULE_ID} | config window`, e));
  }

  static #onCancelRun() { this.abort?.abort(); }

  static async #onSubmit() {
    if (this.busy) return;
    this.#readForm();
    if (!this.description.trim()) { ui.notifications.warn(L("AIIMG.Tile.ErrPrompt")); return; }
    await this.prepared;
    if (!this.job) return;
    this.job.description = this.description;
    this.job.prompt = buildJobPrompt(this.job, this.description);
    await saveTileOptions(this.opts);
    this.busy = true;
    this.error = "";
    this.abort = new AbortController();
    await this.render();
    try {
      if (this.mode === "batch") {
        const rec = await submitTileBatch(this.job, { count: this.opts.count });
        ui.notifications.info(F("AIIMG.Tile.BatchSent", { id: rec.id }));
        this.busy = false;
        return this.close({ force: true });
      }
      const res = await generateTileVariants(this.job, { count: this.opts.count, signal: this.abort.signal });
      if (res.failed.length) ui.notifications.warn(F("AIIMG.Tile.SomeFailed", { n: res.failed.length, error: safeMessage(res.failed[0].error) }));
      if (!res.candidates.length) throw new Error(res.failed[0]?.error ?? "No image.");
      TileReviewApp.open({ job: this.job, candidates: res.candidates, count: this.opts.count });
      this.busy = false;
      return this.close({ force: true });
    } catch (e) {
      console.error(`${MODULE_ID} | AI Tile`, e);
      this.error = e?.name === "AbortError" ? L("AIIMG.Tile.Cancelled") : safeMessage(e?.message ?? String(e));
      this.busy = false;
      return this.render();
    }
  }
}

// =====================================================================================================================

/** Podgląd na mapie: sprite w prostokącie kafelka (nad wszystkim, bez interakcji). */
class MapPreview {
  constructor(rect) {
    this.rect = rect;
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.frame = new PIXI.Graphics();
    (canvas.controls ?? canvas.interface).addChild(this.container);
    this.container.addChild(this.frame);
    this.sprite = null;
    this.hook = Hooks.on("canvasPan", () => this.#frame());
    this.#frame();
  }
  #frame() {
    const z = canvas.stage.scale.x || 1, r = this.rect;
    this.frame.clear();
    this.frame.lineStyle({ width: 1.5 / z, color: 0xff8a00, alpha: 0.9 });
    this.frame.drawRect(r.x, r.y, r.width, r.height);
  }
  show(source) {
    this.sprite?.destroy({ texture: true, baseTexture: true });
    this.sprite = null;
    if (!source) return;
    const tex = PIXI.Texture.from(source);
    const s = new PIXI.Sprite(tex);
    s.position.set(this.rect.x, this.rect.y);
    s.width = this.rect.width;
    s.height = this.rect.height;
    this.container.addChildAt(s, 0);
    this.sprite = s;
  }
  set visible(v) { if (this.sprite) this.sprite.visible = v; }
  destroy() {
    Hooks.off("canvasPan", this.hook);
    this.container.destroy({ children: true, texture: true, baseTexture: true });
  }
}

export class TileReviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aiimg-tile-review"],
    tag: "div",
    window: { title: "AIIMG.Tile.ReviewTitle", icon: "fa-solid fa-vector-square", resizable: true },
    position: { width: 520, height: "auto", top: 80 },
    actions: {
      select: TileReviewApp.#onSelect,
      accept: TileReviewApp.#onAccept,
      discard: TileReviewApp.#onDiscard,
      retry: TileReviewApp.#onRetry,
      toggle: TileReviewApp.#onToggle,
      pan: TileReviewApp.#onPan,
      reveal: TileReviewApp.#onReveal,
      done: TileReviewApp.#onDone
    }
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/tile-review.hbs` } };

  /**
   * @param {object} p
   * @param {object} [p.job]          Fast: zadanie z prepareJob
   * @param {object[]} p.candidates   Fast: {index, tile:HTMLCanvasElement, cost, logId}; Batch: {path, cost}
   * @param {object} [p.batch]        Batch: {rec, geom, scene}
   */
  static open(p) {
    const app = new this(p);
    app.render({ force: true });
    return app;
  }

  constructor({ job, candidates, count = 1, batch, ...options }) {
    super({ id: `${MODULE_ID}-tile-review-${batch?.rec?.id ?? job?.id ?? foundry.utils.randomID()}`, ...options });
    this.job = job ?? null;
    this.batch = batch ?? null;
    this.count = count;
    this.cands = [];
    this.next = 0;
    this.active = null;
    this.original = false;
    this.busy = false;
    this.error = "";
    this.decided = false;
    this.pasted = null;   // W8: {tileId, sceneId, revealed} po wklejeniu (kafelek ukryty przed graczami)
    this.rect = job?.tileRect ?? batch?.geom?.tileRect;
    this.sceneId = job?.sceneId ?? batch?.geom?.sceneId;
    this.preview = this.#onScene() ? new MapPreview(this.rect) : null;
    this.#add(candidates);
    if (this.cands.length) this.#select(this.cands[0]);
  }

  #onScene() { return canvas?.ready && canvas.scene?.id === this.sceneId; }

  #add(list) {
    for (const c of list) {
      const uid = `t${++this.next}`;
      const src = c.tile ? c.tile.toDataURL("image/png") : foundry.utils.getRoute(c.path);
      this.cands.push({ ...c, uid, n: this.next, src });
    }
  }

  #select(c) {
    this.active = c;
    if (!this.preview) return;
    this.preview.show(c.tile ?? c.src);
    this.preview.visible = !this.original;
  }

  async _prepareContext() {
    return {
      cands: this.cands.map((c) => ({ uid: c.uid, n: c.n, src: c.src, cost: c.cost > 0 ? money(c.cost) : "", active: c === this.active })),
      busy: this.busy, error: this.error, original: this.original,
      canRetry: !!this.job, onScene: !!this.preview,
      offScene: F("AIIMG.Tile.OffScene", { scene: foundry.utils.escapeHTML(game.scenes.get(this.sceneId)?.name ?? "?") }),
      hasActive: !!this.active,
      pasted: this.pasted ? { revealed: !!this.pasted.revealed, gone: !this.#pastedDoc() } : null
    };
  }

  _onClose(options) {
    super._onClose?.(options);
    this.preview?.destroy();
    this.preview = null;
  }

  async close(options = {}) {
    if (this.busy && !options.force) return this;
    if (!this.decided && this.cands.length && this.job && !options.force) {
      const ok = await DialogV2.confirm({
        window: { title: L("AIIMG.Tile.DiscardTitle") },
        content: `<p>${F("AIIMG.Tile.DiscardBody", { n: this.cands.length })}</p>`, rejectClose: false
      });
      if (!ok) return this;
    }
    return super.close(options);
  }

  static #onSelect(ev, target) {
    const c = this.cands.find((x) => x.uid === target.dataset.uid);
    if (!c) return;
    this.#select(c);
    this.render();
  }

  static #onToggle() {
    this.original = !this.original;
    if (this.preview) this.preview.visible = !this.original;
    this.render();
  }

  static #onPan() {
    const r = this.rect;
    if (this.#onScene()) canvas.animatePan({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  }

  static async #onAccept() {
    if (this.busy || !this.active || this.pasted) return;
    this.busy = true; this.error = "";
    await this.render();
    let tile = null;
    try {
      if (this.job) {
        ({ tile } = await acceptVariant(this.job, this.active));
        ui.notifications.info(F("AIIMG.Tile.PastedHidden", { id: tile?.id ?? "" }));
      } else {
        const { rec, geom } = this.batch;
        if (getBatch(rec.id)?.status !== "awaiting-pick") throw new Error(L("AIIMG.Pick.AlreadyDecided"));
        const scene = game.scenes.get(geom.sceneId);
        tile = await createTile(scene, geom.tileRect, this.active.path, { key: `${rec.id}-pick`, batchId: rec.id, prompt: String(rec.items?.[0]?.meta?.description ?? "").slice(0, 500), provider: rec.provider, model: rec.model });
        await patchBatch(rec.id, { candidates: undefined, status: "done", picked: this.active.path }, { onlyStatus: "awaiting-pick" });
        ui.notifications.info(F("AIIMG.Tile.PastedHidden", { id: tile?.id ?? "" }));
      }
      this.decided = true;
      this.busy = false;
      // W8: okno zostaje z informacją, że kafelek widzi tylko MG, i przyciskiem „Pokaż graczom”
      this.pasted = { tileId: tile?.id ?? null, sceneId: tile?.parent?.id ?? this.sceneId, revealed: false };
      this.preview?.destroy();
      this.preview = null;
      return this.render();
    } catch (e) {
      console.error(`${MODULE_ID} | AI Tile accept`, e);
      this.error = safeMessage(e?.message ?? String(e));
      this.busy = false;
      return this.render();
    }
  }

  #pastedDoc() {
    const p = this.pasted;
    return p?.tileId ? game.scenes.get(p.sceneId)?.tiles.get(p.tileId) ?? null : null;
  }

  /** W8: odkryj wklejony kafelek graczom (u wszystkich zagra fade-in, tile-fade.mjs). */
  static async #onReveal() {
    const doc = this.#pastedDoc();
    if (!doc || this.busy) return;
    this.busy = true;
    try {
      await doc.update({ hidden: false });
      this.pasted.revealed = true;
      ui.notifications.info(L("AIIMG.Tile.Revealed"));
    } catch (e) {
      this.error = safeMessage(e?.message ?? String(e));
    }
    this.busy = false;
    return this.render();
  }

  static #onDone() { return this.close({ force: true }); }

  static async #onDiscard() {
    if (this.busy) return;
    if (this.batch) {
      await patchBatch(this.batch.rec.id, { candidates: undefined, status: "done", picked: null, discarded: true }, { onlyStatus: "awaiting-pick" });
      ui.notifications.info(F("AIIMG.Pick.DiscardedDisk", { folder: `${DATA_ROOT}/_candidates/${this.batch.rec.id}` }));
    }
    this.decided = true;
    return this.close({ force: true });
  }

  static async #onRetry() {
    if (this.busy || !this.job) return;
    this.busy = true; this.error = "";
    await this.render();
    try {
      const res = await generateTileVariants(this.job, { count: this.count });
      if (res.failed.length) ui.notifications.warn(F("AIIMG.Tile.SomeFailed", { n: res.failed.length, error: safeMessage(res.failed[0].error) }));
      const before = this.cands.length;
      this.#add(res.candidates);
      if (this.cands.length > before) this.#select(this.cands[before]);
    } catch (e) {
      this.error = safeMessage(e?.message ?? String(e));
    }
    this.busy = false;
    return this.render();
  }
}

/** Batch z kilkoma wariantami kafelka czeka na wybór: okno przeglądu (podgląd, gdy scena jest na płótnie). */
export async function openTileBatchPick(rec) {
  const geom = geomFromMeta(rec.items[0].meta.tile);
  const scene = game.scenes.get(geom.sceneId);
  if (!scene) { ui.notifications.error(L("AIIMG.Tile.ErrSceneGone")); return null; }
  return TileReviewApp.open({ batch: { rec, geom }, candidates: rec.candidates.map((c) => ({ path: c.path, cost: c.cost })) });
}
