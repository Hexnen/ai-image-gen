// Ikonka „generuj AI" przy obrazku arkusza Actor/Item i w konfiguracji makra.
import { MODULE_ID } from "./constants.mjs";
import { resolveTypeKey } from "./image-types.mjs";
import { GenerateDialog } from "./generate-dialog.mjs";

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

function canGenerate(doc) {
  if (!game.user.isGM || !resolveTypeKey(doc)) return false;
  if (doc.pack && doc.collection?.locked) return false;
  return true;
}

function inject(app, html) {
  const doc = documentOf(app);
  if (!doc || !canGenerate(doc)) return;
  const root = rootOf(html, app);
  if (!root) return;
  const anchor = findAnchor(root);
  if (!anchor || anchor.nextElementSibling?.classList.contains("aiimg-btn")) return;

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

  // Dolny prawy róg obrazka, liczony względem wspólnego offsetParent.
  const place = () => {
    btn.style.left = `${anchor.offsetLeft + anchor.offsetWidth - btn.offsetWidth - 2}px`;
    btn.style.top = `${anchor.offsetTop + anchor.offsetHeight - btn.offsetHeight - 2}px`;
  };
  place();
  anchor.addEventListener("load", place);
  if (typeof ResizeObserver === "function") new ResizeObserver(place).observe(anchor);
}

export function registerSheetButtons() {
  // ApplicationV2 (arkusze v13/v14, MacroConfig) oraz stare arkusze v1 (np. stonetop).
  Hooks.on("renderApplicationV2", (app, element) => inject(app, element));
  Hooks.on("renderDocumentSheet", (app, html) => inject(app, html));
  console.log(`${MODULE_ID} | sheet buttons registered`);
}
