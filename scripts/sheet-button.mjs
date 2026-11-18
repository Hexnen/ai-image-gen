// Ikonka „generuj AI" przy obrazku arkusza Actor/Item i w konfiguracji makra.
import { MODULE_ID } from "./constants.mjs";
import { resolveTypeKey } from "./image-types.mjs";
import { GenerateDialog } from "./generate-dialog.mjs";
import { assertCanApply } from "./generate-flow.mjs";
import { depthButtonFor, registerDepth } from "./depth/entry.mjs";

/** Selektory obrazka profilu — od najbardziej do najmniej pewnych. */
const DEFAULT_SELECTORS = [
  'img[data-edit="img"]',
  '[data-action="editImage"]',
  "img.profile-img",
  ".profile-img img",
  "img.document-image"
];

/**
 * Wyjątki per system: selektory próbowane PRZED domyślnymi.
 * Systemy z lokalnymi arkuszami (invincible, mythicbastionland, stonetop) używają
 * `img[data-edit="img"]`, więc działają z listą domyślną; wpisz tu własny selektor, gdy nie.
 */
export const SYSTEM_SELECTORS = {
  invincible: ["img.profile-img[data-edit='img']"]
};

const SUPPORTED = new Set(["Actor", "Item", "Macro"]);

function documentOf(app) {
  const d = app.document ?? app.object ?? app.actor ?? app.item ?? app.macro;
  return d && SUPPORTED.has(d.documentName) ? d : null;
}

function rootOf(html, app) {
  const el = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  return el instanceof HTMLElement ? el : el?.[0] ?? null;
}

function findAnchor(root) {
  const lists = [...(SYSTEM_SELECTORS[game.system.id] ?? []), ...DEFAULT_SELECTORS];
  for (const sel of lists) {
    const el = root.querySelector(sel);
    if (!el) continue;
    return el.tagName === "IMG" ? el : el.querySelector("img") ?? el;
  }
  return null;
}

export function canGenerate(doc) {
  if (!game.user.isGM || !resolveTypeKey(doc) || !doc.id) return false;
  // Unsaved, not editable or in a locked compendium (embedded included): the image could not be applied after paying.
  try { assertCanApply(doc); } catch { return false; }
  return true;
}

function inject(app, html) {
  const doc = documentOf(app);
  if (!doc || !canGenerate(doc)) return;
  const root = rootOf(html, app);
  if (!root) return;
  const anchor = findAnchor(root);
  const host = anchor?.parentElement;
  // One button per image holder; other modules may insert siblings next to the image, so look in the parent.
  if (!anchor || !host || host.querySelector(":scope > .aiimg-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "aiimg-btn";
  btn.dataset.tooltip = game.i18n.localize("AIIMG.Sheet.Generate");
  btn.setAttribute("aria-label", btn.dataset.tooltip);
  btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
  btn.addEventListener("click", (ev) => {
    // Rodzic obrazka bywa [data-action]; nie pozwól, by delegat aplikacji odpalił jego akcję.
    ev.preventDefault();
    ev.stopPropagation();
    GenerateDialog.open(doc);
  });
  anchor.after(btn);
  // W6-I: "Dodaj głębię" next to the wand when the type has depth switched on (Depth tab) and the image is a real file
  const depthBtn = depthButtonFor(doc);
  if (depthBtn) btn.after(depthBtn);

  // Bottom-right corner of the image, measured against the button's offset parent. The image can move
  // without changing its own size (flex header, window resize, tab switch), so everything around it is watched.
  const place = () => {
    if (!btn.isConnected) return;
    const op = btn.offsetParent;
    if (!op || !anchor.offsetWidth) return;
    const a = anchor.getBoundingClientRect();
    const o = op.getBoundingClientRect();
    btn.style.left = `${a.right - o.left + op.scrollLeft - op.clientLeft - btn.offsetWidth - 2}px`;
    btn.style.top = `${a.bottom - o.top + op.scrollTop - op.clientTop - btn.offsetHeight - 2}px`;
    if (depthBtn?.isConnected) {
      depthBtn.style.left = `${parseFloat(btn.style.left) - depthBtn.offsetWidth - 3}px`;
      depthBtn.style.top = btn.style.top;
    }
  };
  const settle = () => {
    const until = performance.now() + 700;
    const tick = () => { place(); if (btn.isConnected && performance.now() < until) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
  place();
  anchor.addEventListener("load", settle);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(settle);
    for (const el of new Set([anchor, host, btn.offsetParent, root].filter(Boolean))) ro.observe(el);
  }
  if (typeof IntersectionObserver === "function") new IntersectionObserver(settle).observe(anchor);
  root.addEventListener("transitionend", settle);
  root.addEventListener("animationend", settle);
}

export function registerSheetButtons() {
  // ApplicationV2 (arkusze v13/v14, MacroConfig) oraz stare arkusze v1 (np. stonetop).
  Hooks.on("renderApplicationV2", (app, element) => inject(app, element));
  Hooks.on("renderDocumentSheet", (app, html) => inject(app, html));
  registerDepth(); // W6-I: api.depth + nothing else at init (the depth code loads on first use)
  console.log(`${MODULE_ID} | sheet buttons registered`);
}
