// W6-L: the parallax portrait window ("okno portretu"): one portrait, one or more depth maps, switch between them (tabs)
// or compare 2-3 side by side (one WebGL canvas, every panel a viewport: same frame, same pointer, same sway). Sliders
// live in the page session (closing and reopening the window keeps them). A PIXI version for tokens / scenes is a later
// step; this window has its own WebGL2 canvas.
import { MODULE_ID } from "../constants.mjs";
import {
  conditionDepth, downscaleMap, normalizeView, viewDefaults, viewFromTypeParallax, VIEW_RANGES, VIEWS,
  offsetFor, overscanFor, stepsFor, clampLook, easeToward, idleBlend, swayAt, backingSize, containRect
} from "./parallax-core.mjs";
import { ParallaxRenderer } from "./parallax-gl.mjs";
import { loadPortrait, loadDepth } from "./parallax-load.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = (k) => game.i18n.localize(k);
const F = (k, d) => game.i18n.format(k, d);

/** Page-session state of the sliders (kept across close / reopen until the page reloads). */
const SESSION = { view: null, compare: false };
const SLIDERS = ["strength", "sway", "focus", "gamma", "contrast", "dilate", "normalBlur", "light", "rim", "dust"];
const SWITCHED = { light: "light", rim: "rim", dust: "dust" };
const RECONDITION = new Set(["dilate", "normalBlur"]);
const MAX_COMPARE = 3;

let seq = 0;
const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

/** Normalise the `open` arguments: image = path string or {path, crop}; depths = [{name, path, crop?, invert?, format?}]. */
function specOf({ image, depths = [], crop = null } = {}) {
  const img = typeof image === "string" ? { path: image, crop } : { path: image?.path ?? "", crop: image?.crop ?? crop };
  const list = (Array.isArray(depths) ? depths : [depths]).filter((d) => d && (typeof d === "string" || d.path)).map((d, i) => {
    const o = typeof d === "string" ? { path: d } : d;
    const file = String(o.path).split(/[?#]/)[0].split("/").pop();
    return { name: String(o.name ?? (file || `#${i + 1}`)), path: String(o.path), crop: o.crop ?? null, invert: !!o.invert, format: o.format ?? null };
  });
  return { image: img, depths: list };
}

export class ParallaxApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-parallax`,
    classes: ["aiimg-plx"],
    tag: "div",
    window: { title: "AIIMG.Parallax.Title", icon: "fa-solid fa-cube", resizable: true },
    position: { width: 760, height: 800 },
    actions: {
      tab: ParallaxApp.#onTab,
      compare: ParallaxApp.#onCompare,
      pick: ParallaxApp.#onPick,
      reset: ParallaxApp.#onReset
    }
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/parallax.hbs` } };

  static #instance;

  /** Open (or refocus and replace the content of) the window. @returns {ParallaxApp} */
  static open(args = {}) {
    const spec = specOf(args);
    const app = (this.#instance ??= new this());
    if (!SESSION.view) {
      SESSION.view = args.view ? normalizeView(args.view) : args.parallax ? viewFromTypeParallax(args.parallax) : viewDefaults();
      if (reducedMotion()) SESSION.view.sway = 0; // the user can still turn it up
    }
    app.#setContent(spec);
    app.render({ force: true });
    return app;
  }

  /** The open window, if any (macros / tests). */
  static get instance() { return this.#instance ?? null; }

  image = null;        // {path, crop, bitmap?, w, h, error?}
  maps = [];           // [{key, name, path, crop, invert, format, status, error, src, info}]
  active = 0;
  picked = [];
  #canvas = null;
  #gl = null;
  #glError = "";
  #raf = 0;
  #visible = true;
  #observers = [];
  #layout = { panels: [], ratio: 1 };
  #look = { x: 0, y: 0 };
  #pointer = { x: 0, y: 0 };
  #lastInput = -1e9;
  #hold = false;
  #frozen = null;
  #lastT = 0;
  #stats = { draw: [], gap: [], shown: 0 };
  #recondTimer = 0;
  #gen = 0;
  #onVis = () => this.#kick();

  get view() { return (SESSION.view ??= viewDefaults()); }
  #bg = [0.1, 0.09, 0.1];
  get compare() { return SESSION.compare; }

  #setContent(spec) {
    const gen = ++this.#gen;
    for (const m of this.maps) this.#gl?.dropDepth(m.key);
    this.image?.bitmap?.close?.();
    this.image = { path: spec.image.path, crop: spec.image.crop, status: "loading" };
    this.maps = spec.depths.map((d) => ({ ...d, key: `m${++seq}`, status: "loading", error: "", src: null, info: null }));
    this.active = 0;
    this.picked = this.maps.slice(0, MAX_COMPARE).map((m) => m.key);
    this.#load(gen);
  }

  async #load(gen) {
    try {
      const p = await loadPortrait(this.image.path, { crop: this.image.crop });
      if (gen !== this.#gen) { p.bitmap.close?.(); return; }
      Object.assign(this.image, p, { status: "ready" });
      this.#gl?.setImage(p.bitmap);
    } catch (e) {
      if (gen !== this.#gen) return;
      console.error(`${MODULE_ID} | parallax portrait`, e);
      Object.assign(this.image, { status: "error", error: String(e?.message ?? e) });
    }
    this.#refresh();
    for (const m of this.maps) {
      try {
        let src = await loadDepth(m);
        if (gen !== this.#gen) return;
        // depth finer than the portrait adds nothing on screen: box it down to about the portrait size
        if (this.image.w) {
          const f = Math.floor(Math.min(src.w / this.image.w, src.h / this.image.h));
          if (f >= 2) {
            const d = downscaleMap(src.D, src.w, src.h, f);
            src = { ...src, D: d.M, mask: src.mask ? downscaleMap(src.mask, src.w, src.h, f).M : null, w: d.w, h: d.h, bits: src.bits };
          }
        }
        m.src = src;
        m.aspectOff = this.image.w ? Math.abs(src.w / src.h - this.image.w / this.image.h) > 0.02 : false;
        await new Promise((r) => setTimeout(r, 0));
        this.#condition(m);
        m.status = "ready";
      } catch (e) {
        if (gen !== this.#gen) return;
        console.error(`${MODULE_ID} | parallax depth ${m.path}`, e);
        m.status = "error"; m.error = String(e?.message ?? e);
      }
      this.#refresh();
    }
  }

  #condition(m) {
    if (!m.src) return;
    const t0 = performance.now();
    const c = conditionDepth(m.src, { dilatePx: this.view.dilate, normalBlurPx: this.view.normalBlur });
    m.info = { ...c.info, w: c.w, h: c.h, ms: Math.round(performance.now() - t0) };
    this.#gl?.setDepth(m.key, c);
    m.uploaded = !!this.#gl;
    m.cond = this.#gl ? null : c; // kept until a context exists
  }

  #refresh() { if (this.rendered) this.render(); }

  // ------------------------------------------------------------------ context

  async _prepareContext() {
    const v = this.view;
    const fmt = (m) => {
      if (m.status === "loading") return L("AIIMG.Parallax.Loading");
      if (m.status === "error") return F("AIIMG.Parallax.LoadFailed", { error: m.error });
      const i = m.info ?? {};
      const parts = [`${m.src.w}×${m.src.h}`, L(`AIIMG.Parallax.Format.${i.format ?? "gray8"}`)];
      if (i.hasMask) parts.push(L("AIIMG.Parallax.HasMask"));
      if (m.aspectOff) parts.push(L("AIIMG.Parallax.Aspect"));
      return parts.join(" · ");
    };
    const maps = this.maps.map((m, i) => ({
      index: i, key: m.key, name: m.name, status: m.status, meta: fmt(m), error: m.status === "error",
      active: i === this.active, picked: this.picked.includes(m.key), tabindex: i === this.active ? 0 : -1
    }));
    const shown = this.#shownMaps();
    const sliders = SLIDERS.map((k) => {
      const [min, max, step] = VIEW_RANGES[k];
      return {
        key: k, label: L(`AIIMG.Parallax.Slider.${k}`), min, max, step, value: v[k], display: this.#display(k, v[k]),
        switch: SWITCHED[k] ? { key: SWITCHED[k], checked: !!v.on[SWITCHED[k]] } : null,
        group: ["light", "rim", "dust"].includes(k) ? "fx" : "depth"
      };
    });
    return {
      glError: this.#glError,
      imageError: this.image?.status === "error" ? F("AIIMG.Parallax.LoadFailed", { error: this.image.error }) : "",
      imageLoading: this.image?.status === "loading",
      noMaps: !this.maps.length,
      maps, compare: this.compare, multi: this.maps.length > 1,
      cells: shown.map((m) => ({ key: m.key, name: m.name, meta: fmt(m), loading: m.status === "loading", error: m.status === "error" })),
      cellCount: shown.length,
      depthSliders: sliders.filter((s) => s.group === "depth"),
      fxSliders: sliders.filter((s) => s.group === "fx"),
      toggles: ["vignette", "holeFill"].map((k) => ({ key: k, label: L(`AIIMG.Parallax.Toggle.${k}`), checked: !!v.on[k] })),
      views: VIEWS.map((id) => ({ id, label: L(`AIIMG.Parallax.View.${id}`), checked: v.view === id })),
      appId: this.id
    };
  }

  #display(k, val) {
    if (k === "dilate" || k === "normalBlur") return `${val} px`;
    if (k === "gamma" || k === "contrast") return Number(val).toFixed(2);
    return `${Math.round(val * 100)}%`;
  }

  #shownMaps() {
    if (!this.maps.length) return [];
    if (this.compare && this.maps.length > 1) {
      const sel = this.maps.filter((m) => this.picked.includes(m.key));
      return sel.length ? sel : [this.maps[this.active]];
    }
    return [this.maps[Math.min(this.active, this.maps.length - 1)]];
  }

  // ------------------------------------------------------------------ render / DOM

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "aiimg-plx-canvas";
    this.#canvas.setAttribute("aria-hidden", "true");
    this.#canvas.addEventListener("webglcontextlost", (ev) => { ev.preventDefault(); if (this.#gl) this.#gl.lost = true; });
    this.#canvas.addEventListener("webglcontextrestored", () => this.#initGL(true));
    this.#initGL(false);
    document.addEventListener("visibilitychange", this.#onVis);
  }

  #initGL(restore) {
    try {
      this.#gl = ParallaxRenderer.create(this.#canvas);
      if (!this.#gl) { this.#glError = L("AIIMG.Parallax.NoWebGL"); return; }
      this.#glError = "";
      if (this.image?.bitmap) this.#gl.setImage(this.image.bitmap);
      for (const m of this.maps) if (m.src) { if (restore || !m.uploaded) this.#condition(m); }
      if (restore) this.#refresh();
    } catch (e) {
      console.error(`${MODULE_ID} | parallax WebGL`, e);
      this.#gl = null;
      this.#glError = F("AIIMG.Parallax.GLFailed", { error: String(e?.message ?? e) });
    }
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    const stage = el.querySelector("[data-role=stage]");
    for (const o of this.#observers) o.disconnect();
    this.#observers = [];
    if (!stage) return;
    if (this.#gl && this.#canvas) stage.prepend(this.#canvas);
    // sizes
    const ro = new ResizeObserver(() => { this.#measure(); this.#kick(); });
    ro.observe(stage);
    this.#observers.push(ro);
    const io = new IntersectionObserver((ents) => { this.#visible = ents.some((e) => e.isIntersecting); this.#kick(); });
    io.observe(stage);
    this.#observers.push(io);
    // pointer: the same look for every panel (position inside the panel under the pointer)
    stage.addEventListener("pointermove", (ev) => this.#onPointer(ev));
    stage.addEventListener("pointerleave", () => { this.#lastInput = performance.now(); });
    stage.addEventListener("keydown", (ev) => this.#onKey(ev));
    // controls (no re-render: the canvas keeps running)
    for (const inp of el.querySelectorAll("input[data-slider]")) inp.addEventListener("input", (ev) => this.#onSlider(ev.currentTarget));
    for (const inp of el.querySelectorAll("input[data-switch]")) inp.addEventListener("change", (ev) => { this.view.on[ev.currentTarget.dataset.switch] = ev.currentTarget.checked; this.#kick(); });
    for (const inp of el.querySelectorAll("input[data-viewmode]")) inp.addEventListener("change", (ev) => { if (ev.currentTarget.checked) this.view.view = ev.currentTarget.value; this.#kick(); });
    el.querySelector("[role=tablist]")?.addEventListener("keydown", (ev) => this.#onTabKey(ev));
    this.#measure();
    this.#kick();
  }

  _onClose(options) {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    for (const o of this.#observers) o.disconnect();
    this.#observers = [];
    document.removeEventListener("visibilitychange", this.#onVis);
    clearTimeout(this.#recondTimer);
    this.#gen++;
    this.#gl?.destroy();
    this.#gl = null;
    this.#canvas = null;
    this.image?.bitmap?.close?.();
    this.image = null;
    this.maps = [];
    ParallaxApp.#instance = null;
    return super._onClose?.(options);
  }

  #measure() {
    const stage = this.element?.querySelector("[data-role=stage]");
    const cv = this.#canvas;
    if (!stage || !cv || !cv.isConnected) { this.#layout = { panels: [], ratio: 1 }; return; }
    const sr = stage.getBoundingClientRect();
    const b = backingSize(sr.width, sr.height, globalThis.devicePixelRatio ?? 1);
    if (cv.width !== b.w || cv.height !== b.h) { cv.width = b.w; cv.height = b.h; }
    const panels = [];
    for (const cell of stage.querySelectorAll("[data-cell]")) {
      const r = cell.getBoundingClientRect();
      panels.push({ key: cell.dataset.cell, x: (r.left - sr.left) * b.ratio, y: (r.top - sr.top) * b.ratio, w: r.width * b.ratio, h: r.height * b.ratio, el: cell });
    }
    this.#layout = { panels, ratio: b.ratio };
    const bg = getComputedStyle(stage).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [27, 23, 25];
    this.#bg = [bg[0] / 255, bg[1] / 255, bg[2] / 255];
  }

  // ------------------------------------------------------------------ input

  #onPointer(ev) {
    const cell = ev.target.closest?.("[data-cell]") ?? this.element.querySelector("[data-cell]");
    if (!cell || !this.image?.w) return;
    const r = cell.getBoundingClientRect();
    const c = containRect(r.width, r.height, this.image.w / this.image.h);
    const px = ((ev.clientX - r.left) / r.width - c.x) / c.w, py = ((ev.clientY - r.top) / r.height - c.y) / c.h;
    const l = clampLook((px - 0.5) * 2, (py - 0.5) * 2);
    this.#pointer = { x: Math.max(-1, Math.min(1, l.x)), y: Math.max(-1, Math.min(1, l.y)) };
    this.#lastInput = performance.now();
    this.#hold = false;
    this.#kick();
  }

  #onKey(ev) {
    const step = ev.shiftKey ? 0.05 : 0.2;
    const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (k) {
      const l = clampLook(this.#pointer.x + k[0], this.#pointer.y + k[1]);
      this.#pointer = l;
    } else if (ev.key === "Home") this.#pointer = { x: 0, y: 0 };
    else return;
    ev.preventDefault();
    ev.stopPropagation();
    this.#hold = true;
    this.#lastInput = performance.now();
    this.#kick();
  }

  #onTabKey(ev) {
    const tabs = [...this.element.querySelectorAll("[role=tab]")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[ev.key];
    if (j === undefined) return;
    ev.preventDefault();
    this.active = Number(tabs[j].dataset.index);
    this.render().then(() => this.element.querySelector(`[role=tab][data-index="${this.active}"]`)?.focus());
  }

  #onSlider(inp) {
    const k = inp.dataset.slider;
    this.view[k] = normalizeView({ [k]: inp.value }, this.view)[k];
    const out = this.element.querySelector(`output[data-for="${k}"]`);
    if (out) out.textContent = this.#display(k, this.view[k]);
    if (RECONDITION.has(k)) {
      clearTimeout(this.#recondTimer);
      this.#recondTimer = setTimeout(() => { for (const m of this.maps) if (m.status === "ready") this.#condition(m); this.#kick(); }, 180);
    }
    this.#kick();
  }

  static #onTab(ev, target) { this.active = Number(target.dataset.index); return this.render(); }
  static #onCompare() { SESSION.compare = !SESSION.compare; return this.render(); }
  static #onPick(ev, target) {
    const key = target.dataset.key;
    if (this.picked.includes(key)) { if (this.picked.length > 1) this.picked = this.picked.filter((k) => k !== key); }
    else { this.picked = [...this.picked, key].slice(-MAX_COMPARE); }
    this.picked = this.maps.filter((m) => this.picked.includes(m.key)).map((m) => m.key);
    return this.render();
  }
  static #onReset() {
    const keep = { dilate: this.view.dilate, normalBlur: this.view.normalBlur };
    SESSION.view = viewDefaults();
    if (reducedMotion()) SESSION.view.sway = 0;
    if (keep.dilate !== SESSION.view.dilate || keep.normalBlur !== SESSION.view.normalBlur) for (const m of this.maps) if (m.status === "ready") this.#condition(m);
    return this.render();
  }

  // ------------------------------------------------------------------ frame loop

  #running() {
    return !!this.#gl && !this.#gl.lost && this.rendered && !this.minimized && this.#visible && !document.hidden && !!this.#canvas?.isConnected;
  }

  #kick() {
    if (this.#raf || !this.#running()) return;
    this.#lastT = performance.now();
    this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(t) {
    this.#raf = 0;
    if (!this.#running()) return;
    const dt = Math.min(0.1, Math.max(0, (t - this.#lastT) / 1000));
    if (this.#lastT && dt > 0) this.#push(this.#stats.gap, dt * 1000);
    this.#lastT = t;
    const v = this.view;
    let target;
    if (this.#frozen) target = this.#frozen;
    else {
      const idle = this.#hold ? 0 : idleBlend(t, this.#lastInput);
      const sw = swayAt(t, v.sway);
      target = { x: this.#pointer.x * (1 - idle) + sw.x * idle, y: this.#pointer.y * (1 - idle) + sw.y * idle };
    }
    if (this.#frozen) this.#look = { ...target };
    else this.#look = { x: easeToward(this.#look.x, target.x, dt, 0.14), y: easeToward(this.#look.y, target.y, dt, 0.14) };
    const t0 = performance.now();
    this.#drawFrame(t);
    this.#push(this.#stats.draw, performance.now() - t0);
    this.#showStats(t);
    this.#raf = requestAnimationFrame((tt) => this.#frame(tt));
  }

  #drawFrame(t) {
    const img = this.image;
    if (!img?.w || !this.#gl) return;
    const v = this.view;
    const off = offsetFor(this.#look, v.strength, img.w, img.h);
    const crop = overscanFor(v.strength, v.focus, img.w, img.h);
    const aspect = img.w / img.h;
    const panels = this.#layout.panels.filter((p) => this.maps.some((m) => m.key === p.key && m.status === "ready"));
    this.#gl.draw(panels, {
      off, crop, look: this.#look, bg: this.#bg,
      focus: v.focus, gamma: v.gamma, contrast: v.contrast,
      light: v.on.light ? v.light : 0, rim: v.on.rim ? v.rim : 0, dust: v.on.dust ? v.dust : 0,
      vignette: v.on.vignette ? 1 : 0, holeFill: v.on.holeFill ? 1 : 0,
      time: t / 1000, relief: 10, view: Math.max(0, VIEWS.indexOf(v.view)),
      rectFor: (p) => containRect(p.w, p.h, aspect),
      stepsFor: (d) => stepsFor(offsetFor({ x: 1, y: 0 }, v.strength, img.w, img.h), d.w, d.h)
    });
  }

  #push(arr, v) { arr.push(v); if (arr.length > 120) arr.shift(); }

  #showStats(t) {
    if (t - this.#stats.shown < 500) return;
    this.#stats.shown = t;
    const out = this.element?.querySelector("[data-role=frame]");
    if (!out || !this.#stats.gap.length) return;
    const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    out.textContent = F("AIIMG.Parallax.Frame", { ms: avg(this.#stats.draw).toFixed(2), fps: Math.round(1000 / avg(this.#stats.gap)) });
  }

  // ------------------------------------------------------------------ test / macro helpers

  /** Fix the look at {x, y} (unit disc, y down) without easing; `null` gives control back to the pointer / sway. */
  setLook(look) {
    this.#frozen = look ? clampLook(Number(look.x) || 0, Number(look.y) || 0) : null;
    this.#kick();
    return this.#frozen;
  }

  /** Draw one frame now, outside the animation loop (captures in a throttled / background tab). */
  renderNow() {
    if (!this.#gl) return false;
    if (this.#frozen) this.#look = { ...this.#frozen };
    this.#measure();
    this.#drawFrame(performance.now());
    return true;
  }

  /** Change view settings from code (same schema as the sliders). */
  setView(partial = {}) {
    const before = { dilate: this.view.dilate, normalBlur: this.view.normalBlur };
    SESSION.view = normalizeView({ ...this.view, ...partial, on: { ...this.view.on, ...(partial.on ?? {}) } }, this.view);
    if (before.dilate !== SESSION.view.dilate || before.normalBlur !== SESSION.view.normalBlur) for (const m of this.maps) if (m.status === "ready") this.#condition(m);
    this.render();
    return structuredClone(SESSION.view);
  }

  setCompare(on, keys = null) {
    SESSION.compare = !!on;
    if (keys) this.picked = this.maps.filter((m, i) => keys.includes(m.key) || keys.includes(m.name) || keys.includes(i)).map((m) => m.key).slice(0, MAX_COMPARE);
    return this.render();
  }

  /** Synchronous GPU-bound timing: `frames` draws, each waited for (readPixels). @returns {{avgMs, p95Ms, panels, canvas}} */
  benchmark(frames = 120) {
    if (!this.#gl) return null;
    const times = [];
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      const s = performance.now();
      this.#drawFrame(t0 + i * 16.7);
      this.#gl.finish();
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    return {
      avgMs: Math.round((times.reduce((s, x) => s + x, 0) / times.length) * 100) / 100,
      p95Ms: Math.round(times[Math.floor(times.length * 0.95)] * 100) / 100,
      panels: this.#layout.panels.length, canvas: [this.#canvas.width, this.#canvas.height]
    };
  }

  /** State for checks: maps, statuses, conditioning info, rolling frame stats. */
  status() {
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    return {
      image: this.image ? { path: this.image.path, status: this.image.status, w: this.image.w, h: this.image.h, error: this.image.error } : null,
      maps: this.maps.map((m) => ({ key: m.key, name: m.name, status: m.status, error: m.error, info: m.info, aspectOff: m.aspectOff })),
      compare: this.compare, active: this.active, picked: [...this.picked], view: structuredClone(this.view),
      gl: !!this.#gl, glError: this.#glError, running: !!this.#raf,
      drawMs: avg(this.#stats.draw), frameGapMs: avg(this.#stats.gap), canvas: this.#canvas ? [this.#canvas.width, this.#canvas.height] : null
    };
  }
}
