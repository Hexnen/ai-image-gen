import { MODULE_ID } from "./constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TAB_W = 32;
const PANEL_W = 430;
const MIN_PANEL_W = 280;
const HEADER_H = 38;

/**
 * Test drawer: a frameless side panel docked to the right edge of the config window (outside it, because
 * the window clips its own overflow). The config window owns all the state; this app only renders it,
 * forwards its actions and keeps itself glued to the window (move / resize / z-order / minimize / close).
 */
export class TestDrawerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-test-drawer`,
    classes: ["aiimg-drawer"],
    tag: "aside",
    window: { frame: false, positioned: false },
    actions: {
      toggle: TestDrawerApp.#onToggle,
      runTest: TestDrawerApp.#onRunTest,
      saveTest: TestDrawerApp.#onSaveTest,
      zoomTest: TestDrawerApp.#onZoomTest,
      loadTry: TestDrawerApp.#onLoadTry,
      openSettings: TestDrawerApp.#onOpenSettings
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/test-drawer.hbs`, scrollable: [".aiimg-drawer-body"] }
  };

  /** @param {import("./config-app.mjs").ImageConfigApp} owner */
  constructor(owner) {
    super();
    this.owner = owner;
  }

  #observer = null;
  #onResize = () => this.dock();

  async _prepareContext() {
    return this.owner.drawerContext();
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    window.addEventListener("resize", this.#onResize);
    const cfg = this.owner.element;
    if (cfg && typeof ResizeObserver === "function") {
      this.#observer = new ResizeObserver(() => this.dock());
      this.#observer.observe(cfg);
    }
  }

  _onClose(options) {
    super._onClose?.(options);
    window.removeEventListener("resize", this.#onResize);
    this.#observer?.disconnect();
    this.#observer = null;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.owner.wireDrawer(this.element);
    this.dock();
  }

  /** Glue the drawer to the config window: right edge (or left when there is no room), same height and z-index. */
  dock() {
    const el = this.element;
    const cfg = this.owner.element;
    if (!el || !cfg) return;
    const hidden = cfg.classList.contains("minimized") || !cfg.isConnected;
    el.hidden = hidden;
    if (hidden) return;
    const open = !!this.owner.test.open;
    const r = cfg.getBoundingClientRect();
    const roomR = window.innerWidth - r.right;
    const roomL = r.left;
    // Prefer the right edge, then the left; with no room on either side shrink the panel (min MIN_PANEL_W) and,
    // as a last resort, let it overlap the window rather than leave the screen.
    let flip = false;
    let panelW = PANEL_W;
    if (open && roomR < TAB_W + PANEL_W) {
      if (roomL >= TAB_W + PANEL_W) flip = true;
      else {
        flip = roomL > roomR;
        panelW = Math.max(MIN_PANEL_W, Math.min(PANEL_W, Math.max(roomL, roomR) - TAB_W));
      }
    } else if (!open && roomR < TAB_W && roomL >= TAB_W) flip = true;
    const width = open ? TAB_W + panelW : TAB_W;
    let left = flip ? r.left - width : r.right;
    left = Math.max(0, Math.min(left, window.innerWidth - width));
    el.classList.toggle("open", open);
    el.classList.toggle("flip", flip);
    el.style.width = `${width}px`;
    el.style.top = `${r.top + HEADER_H}px`;
    el.style.height = `${Math.max(120, r.height - HEADER_H)}px`;
    el.style.left = `${left}px`;
    el.style.zIndex = cfg.style.zIndex || "";
  }

  static #onToggle() {
    this.owner.toggleDrawer();
  }

  static #onRunTest() {
    return this.owner.runTest();
  }

  static #onSaveTest(event, target) {
    return this.owner.saveTest(Number(target.dataset.index));
  }

  static #onZoomTest(event, target) {
    this.owner.zoomTest(Number(target.dataset.index));
  }

  static #onLoadTry(event, target) {
    this.owner.loadTry(target.dataset.id);
  }

  static #onOpenSettings() {
    game.settings.sheet.render({ force: true });
  }
}
