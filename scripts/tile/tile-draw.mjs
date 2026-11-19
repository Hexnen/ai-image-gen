// W7-A AI Tile: rysowanie prostokąta na płótnie sceny (nakładka PIXI w układzie sceny + pasek HUD w DOM).
// Decyzja właściciela 2026-11-19: na razie tylko prostokąt. LPM przechwytywany w fazie capture na `window` (przed PIXI na
// <canvas id="board">), PPM i kółko zostają dla Foundry (przesuwanie, zoom). Wynik: Promise<{points, shape} | null>.
import { MODULE_ID } from "../constants.mjs";
import { rectPoints, bboxOf, validShape, pointInPolygon } from "./tile-core.mjs";

const L = (k) => game.i18n.localize(k);
const COLOR = 0xff8a00;
const HANDLE_PX = 7;      // promień uchwytu w px ekranu

let active = null;

export const isDrawing = () => !!active;

/** Zakończ trwające rysowanie (np. zmiana sceny). */
export function cancelDrawing() { active?.finish(null); }

/** Współrzędne sceny z punktu ekranu. */
export function sceneFromClient(x, y) {
  if (typeof canvas.canvasCoordinatesFromClient === "function") return canvas.canvasCoordinatesFromClient({ x, y });
  const r = canvas.app.view.getBoundingClientRect();
  return canvas.stage.worldTransform.applyInverse(new PIXI.Point(x - r.left, y - r.top));
}

const zoom = () => canvas.stage.scale.x || 1;

class DrawTool {
  constructor({ points = null } = {}) {
    this.shape = "rect";
    this.points = points?.length ? rectPoints(...corners(points)) : [];
    this.closed = this.points.length === 4;
    this.drag = null;   // {kind: "corner"|"move"|"box", ...}
    this.promise = new Promise((res) => { this.resolve = res; });
    this.view = canvas.app.view;
    this.gfx = new PIXI.Graphics();
    this.gfx.eventMode = "none";
    this.layer = canvas.controls ?? canvas.interface ?? canvas.stage;
    this.layer.addChild(this.gfx);
    this.on = { down: (e) => this.#down(e), move: (e) => this.#move(e), up: (e) => this.#up(e), key: (e) => this.#key(e) };
    window.addEventListener("pointerdown", this.on.down, { capture: true });
    window.addEventListener("pointermove", this.on.move, { capture: true });
    window.addEventListener("pointerup", this.on.up, { capture: true });
    window.addEventListener("keydown", this.on.key, { capture: true });
    this.panHook = Hooks.on("canvasPan", () => this.redraw());
    this.tearHook = Hooks.on("canvasTearDown", () => this.finish(null));
    this.view.style.cursor = "crosshair";
    this.#hud();
    this.redraw();
  }

  // ---------- HUD ----------
  #hud() {
    const el = document.createElement("div");
    el.id = `${MODULE_ID}-tile-hud`;
    el.className = "aiimg-tile-hud";
    el.innerHTML = `
      <span class="aiimg-tile-hud-title"><i class="fa-solid fa-vector-square"></i> ${L("AIIMG.Tile.Title")}</span>
      <span class="aiimg-tile-hud-hint" data-role="hint"></span>
      <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> ${L("AIIMG.Tile.Cancel")}</button>
      <button type="button" data-action="confirm" class="primary"><i class="fa-solid fa-check"></i> ${L("AIIMG.Tile.Next")}</button>`;
    el.addEventListener("click", (ev) => {
      const a = ev.target.closest("button[data-action]")?.dataset.action;
      if (a === "cancel") this.finish(null);
      else if (a === "confirm") this.confirm();
    });
    document.body.append(el);
    this.hud = el;
    this.#syncHud();
  }

  #syncHud() {
    if (!this.hud) return;
    this.hud.querySelector("[data-role=hint]").textContent = L(this.closed ? "AIIMG.Tile.HintEdit" : "AIIMG.Tile.Hint.rect");
    this.hud.querySelector("[data-action=confirm]").disabled = !(this.closed && validShape(this.points).ok);
  }

  /** Ustaw prostokąt programowo (testy, API): dwa narożniki w px sceny. */
  setRect(a, b) {
    this.points = rectPoints(a, b);
    this.closed = validShape(this.points).ok;
    this.#syncHud();
    this.redraw();
  }

  confirm() {
    if (!this.closed || !validShape(this.points).ok) { ui.notifications.warn(L("AIIMG.Tile.ErrShape")); return; }
    this.finish({ points: this.points.map((p) => ({ x: p.x, y: p.y })), shape: this.shape });
  }

  finish(result) {
    if (this.done) return;
    this.done = true;
    window.removeEventListener("pointerdown", this.on.down, { capture: true });
    window.removeEventListener("pointermove", this.on.move, { capture: true });
    window.removeEventListener("pointerup", this.on.up, { capture: true });
    window.removeEventListener("keydown", this.on.key, { capture: true });
    Hooks.off("canvasPan", this.panHook);
    Hooks.off("canvasTearDown", this.tearHook);
    this.view.style.cursor = "";
    this.hud?.remove();
    this.gfx.destroy();
    active = null;
    this.resolve(result);
  }

  // ---------- zdarzenia ----------
  #pt(e) { const p = sceneFromClient(e.clientX, e.clientY); return { x: p.x, y: p.y }; }

  #cornerAt(p) {
    if (!this.closed) return -1;
    const r = (HANDLE_PX + 3) / zoom();
    return this.points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= r);
  }

  #down(e) {
    if (e.button !== 0 || e.target !== this.view) return;   // PPM / środkowy: przesuwanie Foundry
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = this.#pt(e);
    if (this.closed) {
      const c = this.#cornerAt(p);
      if (c >= 0) { this.drag = { kind: "box", a: { ...this.points[(c + 2) % 4] }, b: p }; return; }   // przeciwległy narożnik stoi
      if (pointInPolygon(p, this.points)) { this.drag = { kind: "move", last: p }; return; }
    }
    this.points = []; this.closed = false;
    this.drag = { kind: "box", a: p, b: p };
    this.#syncHud();
    this.redraw();
  }

  #move(e) {
    const d = this.drag;
    if (!d) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = this.#pt(e);
    if (d.kind === "move") {
      const dx = Math.round(p.x - d.last.x), dy = Math.round(p.y - d.last.y);
      if (!dx && !dy) return;
      this.points = this.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      d.last = { x: d.last.x + dx, y: d.last.y + dy };
    } else {
      d.b = p;
      this.points = rectPoints(d.a, d.b);
    }
    this.redraw();
  }

  #up(e) {
    const d = this.drag;
    if (!d || e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.drag = null;
    this.closed = validShape(this.points).ok;
    if (!this.closed) this.points = [];
    this.#syncHud();
    this.redraw();
  }

  #key(e) {
    if (e.target?.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.finish(null); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); this.confirm(); }
  }

  // ---------- rysunek ----------
  redraw() {
    if (this.done) return;
    const g = this.gfx;
    const z = zoom();
    g.clear();
    if (this.points.length !== 4) return;
    const b = bboxOf(this.points);
    g.beginFill(COLOR, 0.18);
    g.lineStyle({ width: 2.5 / z, color: COLOR, alpha: 1, join: "miter" });
    g.drawRect(b.x, b.y, b.width, b.height);
    g.endFill();
    if (this.closed) {
      const r = HANDLE_PX / z;
      g.lineStyle({ width: 1.5 / z, color: 0x000000, alpha: 0.8 });
      for (const p of this.points) { g.beginFill(COLOR, 1); g.drawCircle(p.x, p.y, r); g.endFill(); }
    }
  }
}

/** Dwa przeciwległe narożniki z dowolnej listy punktów (bbox). */
function corners(points) {
  const b = bboxOf(points);
  return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }];
}

/**
 * Rysuj prostokąt na płótnie. @returns {Promise<{points:{x,y}[], shape:"rect"}|null>} null = anulowano
 * @param {{points?:{x,y}[]}} [o]  prostokąt startowy (powrót z okna do poprawki)
 */
export function drawShape(o = {}) {
  if (!canvas?.ready) { ui.notifications.warn(L("AIIMG.Tile.ErrScene")); return Promise.resolve(null); }
  active?.finish(null);
  active = new DrawTool(o);
  return active.promise;
}

/** Dla testów na żywo i API: aktywne narzędzie (stan i metody). */
export const _activeTool = () => active;
