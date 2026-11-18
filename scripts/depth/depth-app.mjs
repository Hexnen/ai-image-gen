// W6-I: the "Dodaj głębię" window (GM only): pick an image, run, preview the depth map (before/after, mask, side by side
// with the other engine's result), timings, model, saved file, errors. No parallax shader here (a later step).
import { MODULE_ID } from "../constants.mjs";
import { getConfig } from "../config-store.mjs";
import { normalizeDepth, fmtMB } from "../depth-settings.mjs";
import { runDepth, previewUrl } from "./run.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const L = (k) => game.i18n.localize(k);
const F = (k, d) => game.i18n.format(k, d);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const ms = (v) => (v == null ? "" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const usd = (v) => (v == null ? "?" : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`);

export class DepthApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-depth`,
    classes: ["aiimg-depthrun"],
    tag: "div",
    window: { title: "AIIMG.DepthRun.Title", icon: "fa-solid fa-layer-group", resizable: true },
    position: { width: 720, height: 760 },
    actions: {
      pick: DepthApp.#onPick,
      run: DepthApp.#onRun,
      view: DepthApp.#onView,
      parallax: DepthApp.#onParallax
    }
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/depth.hbs`, scrollable: [".aiimg-depthrun-body"] } };

  static #instance;

  /** Open (or refocus) the window. @param {{path?:string, typeKey?:string, depth?:object}} o  depth = unsaved settings (Depth tab draft) */
  static open({ path = "", typeKey = "", depth = null } = {}) {
    if (!game.user.isGM) return null;
    const app = (this.#instance ??= new this());
    if (path && path !== app.path) { app.#clear(); app.path = path; }
    if (typeKey) app.typeKey = typeKey;
    app.depthOverride = depth;
    app.engine = (depth ?? app.settings()).engine === "generative" ? "generative" : "browser";
    app.render({ force: true });
    return app;
  }

  path = "";
  typeKey = "";
  depthOverride = null;
  engine = "browser";
  busy = false;
  error = "";
  statusText = "";
  view = "after";
  /** results per engine for the current source: {browser?, generative?} */
  results = {};
  #urls = [];

  settings() {
    const base = this.depthOverride ?? (this.typeKey ? getConfig(this.typeKey).depth : null);
    return normalizeDepth(base ?? {}, { webgpu: !!navigator.gpu });
  }

  #clear() {
    for (const u of this.#urls) URL.revokeObjectURL(u);
    this.#urls = [];
    this.results = {};
    this.error = "";
    this.view = "after";
  }

  _onClose(options) {
    this.#clear();
    import("./engine.mjs").then((E) => E.releaseAll()).catch(() => {});
    return super._onClose?.(options);
  }

  async _prepareContext() {
    const d = this.settings();
    const r = this.results[this.engine];
    const other = this.results[this.engine === "browser" ? "generative" : "browser"];
    const src = this.path ? foundry.utils.getRoute(this.path) : "";
    const views = r ? [
      { id: "before", label: L("AIIMG.DepthRun.Before"), active: this.view === "before" },
      { id: "after", label: L("AIIMG.DepthRun.After"), active: this.view === "after" },
      ...(r.maskUrl ? [{ id: "mask", label: L("AIIMG.DepthRun.Mask"), active: this.view === "mask" }] : []),
      ...(other ? [{ id: "compare", label: L("AIIMG.DepthRun.Compare"), active: this.view === "compare" }] : [])
    ] : [];
    const t = r?.timings ?? {};
    const timings = r ? [
      ["Read", t.readMs], ["Load", t.loadMs], ["Infer", t.inferMs], ["Generate", t.generateMs], ["MaskLoad", t.maskLoadMs], ["MaskInfer", t.maskInferMs],
      ["Post", t.postMs], ["Encode", t.encodeMs], ["Upload", t.uploadMs]
    ].filter(([, v]) => v != null).map(([k, v]) => ({ label: L(`AIIMG.DepthRun.T.${k}`), value: ms(v) })) : [];
    return {
      path: this.path, src, busy: this.busy, error: this.error, statusText: this.statusText,
      engines: [
        { id: "browser", label: L("AIIMG.Depth.Engine.browser"), selected: this.engine === "browser" },
        { id: "generative", label: L("AIIMG.Depth.Engine.generative"), selected: this.engine === "generative" }
      ],
      generative: this.engine === "generative",
      setLine: this.engine === "generative"
        ? F("AIIMG.DepthRun.SetGen", { provider: d.gen.provider, model: d.gen.model, quality: d.gen.quality })
          + (d.gen.styleRef ? ` · ${F("AIIMG.DepthRun.SetGenStyle", { file: d.gen.styleRef.split("/").pop() })}` : "")
        : F("AIIMG.DepthRun.SetBrowser", { model: d.model, precision: d.precision, res: d.resolution, mask: d.mask.enabled ? d.mask.model : L("AIIMG.DepthRun.NoMask") }),
      typeKey: this.typeKey,
      result: r ? {
        url: r.url, maskUrl: r.maskUrl, model: r.model, device: r.device, dtype: r.dtype, depthPath: r.depthPath, maskPath: r.maskPath, metaPath: r.metaPath,
        size: `${r.w}×${r.h}`, bytes: fmtMB(Math.round(r.bytes / 1e4) / 100), cost: r.cost != null ? usd(r.cost) : "",
        maskLine: r.mask ? (r.mask.ok ? F("AIIMG.DepthRun.MaskOk", { model: r.mask.model, device: r.mask.device, dtype: r.mask.dtype }) : F("AIIMG.DepthRun.MaskFailed", { error: r.mask.error ?? "" })) : "",
        gpuLine: r.gpu?.ok ? F("AIIMG.DepthRun.GpuYes", { desc: [r.gpu.vendor, r.gpu.architecture, r.gpu.description].filter(Boolean).join(" ") || "?", f16: r.gpu.f16 ? "shader-f16" : "no shader-f16" }) : F("AIIMG.DepthRun.GpuNo", { reason: r.gpu?.reason ?? "" }),
        notes: [...(r.notes ?? []).map((n) => L(`AIIMG.DepthRun.Note.${n}`)), ...(r.fallbackErrors ?? []).map((e) => F("AIIMG.DepthRun.FallbackErr", { error: e }))]
      } : null,
      compare: this.view === "compare" && r && other ? { a: { url: this.results.browser.url, label: `${L("AIIMG.Depth.Engine.browser")} · ${this.results.browser.model}` }, b: { url: this.results.generative.url, label: `${L("AIIMG.Depth.Engine.generative")} · ${this.results.generative.model}` } } : null,
      views, view: this.view, timings,
      showBefore: this.view === "before", showAfter: this.view === "after", showMask: this.view === "mask"
    };
  }

  _onRender() {
    const el = this.element;
    el.querySelector("input[name=path]")?.addEventListener("change", (ev) => { const v = ev.target.value.trim(); if (v !== this.path) { this.#clear(); this.path = v; this.render(); } });
    el.querySelector("select[name=engine]")?.addEventListener("change", (ev) => { this.engine = ev.target.value; this.view = "after"; this.render(); });
  }

  #setStatus(text) {
    this.statusText = text;
    const s = this.element?.querySelector("[data-role=status]");
    if (s) s.textContent = text;
  }

  #progress(p) {
    const bar = this.element?.querySelector("[data-role=progress]");
    if (!bar || !p?.total) return;
    bar.hidden = false;
    bar.max = p.total; bar.value = p.loaded;
    this.#setStatus(F("AIIMG.DepthRun.Downloading", { file: String(p.file ?? "").split("/").pop(), done: fmtMB(Math.round(p.loaded / 1e4) / 100), total: fmtMB(Math.round(p.total / 1e4) / 100) }));
  }

  static #onPick() {
    const fp = new (foundry.applications.apps.FilePicker.implementation)({
      type: "image", current: this.path,
      callback: (p) => { this.#clear(); this.path = p; this.render(); }
    });
    return fp.browse();
  }

  static #onView(ev, target) { this.view = target.dataset.view; return this.render(); }

  /** W6-L: open the parallax window on the source with every saved result of this window (browser and/or generative). */
  static #onParallax() {
    const depths = ["browser", "generative"].map((k) => this.results[k]).filter((r) => r?.depthPath)
      .map((r) => ({ name: `${L(`AIIMG.Depth.Engine.${r.engine}`)} · ${r.model ?? ""}`.trim(), path: r.depthPath, format: r.format ?? null }));
    if (!this.path || !depths.length) return;
    const cur = this.results[this.engine];
    if (cur?.depthPath) depths.sort((a, b) => (a.path === cur.depthPath ? -1 : b.path === cur.depthPath ? 1 : 0));
    const p = this.depthOverride?.parallax ?? (this.typeKey ? this.settings().parallax : null);
    import("../parallax/entry.mjs").then((m) => m.openParallax({ image: this.path, depths, parallax: p }));
  }

  static async #onRun() {
    if (this.busy || !this.path) return;
    this.busy = true;
    this.error = "";
    await this.render();
    const depth = { ...this.settings(), engine: this.engine };
    try {
      const r = await runDepth({
        path: this.path, depth, typeKey: this.typeKey,
        ui: {
          status: (code, d) => this.#setStatus(F(`AIIMG.DepthRun.S.${code}`, { model: d?.label ?? "", device: d?.device ?? "", dtype: d?.dtype ?? "" })),
          progress: (p) => this.#progress(p),
          confirmDownload: (items) => confirmDownload(items),
          confirmPaid: (est) => confirmPaid(est)
        }
      });
      r.url = await previewUrl(r.depth, r.w, r.h);
      this.#urls.push(r.url);
      if (r.maskA) { r.maskUrl = await previewUrl(r.maskA, r.w, r.h); this.#urls.push(r.maskUrl); }
      delete r.raw; delete r.depth; delete r.maskA;
      const old = this.results[this.engine];
      if (old?.url) URL.revokeObjectURL(old.url);
      this.results[this.engine] = r;
      r.format = depth.output.format === "png-rg16" ? "png-rg16" : "png16";
      import("../parallax/entry.mjs").then((m) => m.forgetDepthChecks()).catch(() => {});
      this.view = "after";
      console.log(`${MODULE_ID} | depth`, { model: r.model, device: r.device, dtype: r.dtype, timings: r.timings, depth: r.depthPath });
      ui.notifications.info(F("AIIMG.DepthRun.Saved", { path: esc(r.depthPath) }));
    } catch (e) {
      if (!e?.cancelled) {
        console.error(`${MODULE_ID} | depth failed`, e);
        this.error = e?.code ? L(`AIIMG.DepthRun.Err.${e.code}`) : String(e?.message ?? e);
      }
    } finally {
      this.busy = false;
      this.statusText = "";
      this.render();
    }
  }
}

/** First download of model files: show what and how big, ask once per run. */
async function confirmDownload(items) {
  const total = items.reduce((s, i) => s + (i.sizeMB ?? 0), 0);
  const rows = items.map((i) => `<li><strong>${esc(i.label)}</strong> <code>${esc(i.repo)}</code> · ${esc(i.dtype)} · ${esc(fmtMB(i.sizeMB))}</li>`).join("");
  return DialogV2.confirm({
    window: { title: L("AIIMG.DepthRun.DlTitle") },
    content: `<p>${esc(L("AIIMG.DepthRun.DlText"))}</p><ul>${rows}</ul><p>${esc(F("AIIMG.DepthRun.DlTotal", { total: fmtMB(Math.round(total * 10) / 10) }))}</p><p class="hint">${esc(L("AIIMG.DepthRun.DlLicence"))}</p>`,
    rejectClose: false, modal: true
  });
}

/** Paid generative call: always shown with the estimate, never automatic. */
async function confirmPaid(est) {
  const lines = [
    F("AIIMG.DepthRun.PaidModel", { model: est.modelLabel, provider: est.provider, quality: est.provider === "gemini" ? est.imageSize : est.quality }),
    F("AIIMG.DepthRun.PaidSize", { w: est.size.width, h: est.size.height, rw: est.ref.width, rh: est.ref.height }),
    est.styleRef ? F("AIIMG.DepthRun.PaidStyle", { w: est.styleRef.width, h: est.styleRef.height, file: String(est.stylePath ?? "").split("/").pop() }) : "",
    est.outTokens != null ? F("AIIMG.DepthRun.PaidTokens", { out: est.outTokens, ref: est.refTokens ?? "?", usd: usd(est.tokensUSD) }) : "",
    F("AIIMG.DepthRun.PaidCost", { usd: usd(est.usd), source: L(est.source === "learned" ? "AIIMG.DepthRun.SrcLearned" : "AIIMG.DepthRun.SrcTable") })
  ].filter(Boolean);
  return DialogV2.confirm({
    window: { title: L("AIIMG.DepthRun.PaidTitle") },
    content: `<p class="aiimg-warn">${esc(L("AIIMG.DepthRun.PaidExperimental"))}</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p>${esc(L("AIIMG.DepthRun.PaidAsk"))}</p>`,
    rejectClose: false, modal: true
  });
}
