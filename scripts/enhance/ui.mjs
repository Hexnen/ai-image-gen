// Przycisk różdżki przy polu opisu: wysyła opis do Claude i wstawia ulepszoną wersję (z cofnięciem).
// Stan (`store`) należy do okna i przeżywa jego ponowne renderowanie; DOM jest podpinany po każdym renderze.
import { MODULE_ID } from "../constants.mjs";
import { redact } from "../redact.mjs";
import { enhanceDescription, DEFAULT_MODEL, EFFORTS, MAX_INPUT_CHARS } from "./anthropic.mjs";
import { getKey } from "../settings.mjs";

const L = (k, data) => (data ? game.i18n.format(`AIIMG.Enhance.${k}`, data) : game.i18n.localize(`AIIMG.Enhance.${k}`));

export const enhanceKey = () => getKey("anthropic");   // W6-H: world store / client copy, "" for a non-GM

function enhanceSettings() {
  const model = String(game.settings.get(MODULE_ID, "enhance.model") ?? "").trim() || DEFAULT_MODEL;
  const effort = String(game.settings.get(MODULE_ID, "enhance.effort") ?? "");
  return { model, effort: EFFORTS.includes(effort) ? effort : "" };
}

/** Nowy stan dla jednego pola opisu. */
export function createEnhanceStore() {
  // original = tekst sprzed pierwszego ulepszenia; enhanced = tekst wstawiony przez różdżkę (cofnięcie działa, póki pole go trzyma).
  return { scope: null, original: null, enhanced: null, controller: null, status: null, inserting: false, textarea: null, slot: null, statusEl: null, disabled: false };
}

/** Błąd → tekst dla człowieka (PL/EN z lang/), z zamaskowanymi kluczami. */
export function enhanceErrorText(e) {
  const kind = e?.kind ?? "unknown";
  const detail = e?.detail ? redact(e.detail, 300) : "";
  switch (kind) {
    case "rate-limit":
      return e.retryAfter ? L("Err.rate-limit-wait", { s: Math.ceil(e.retryAfter) }) : L("Err.rate-limit");
    case "too-long":
      return L("Err.too-long", { max: e.max ?? MAX_INPUT_CHARS });
    case "model":
      return L("Err.model", { model: enhanceSettings().model });
    case "request": case "server":
      return detail ? `${L(`Err.${kind}`)} (${detail})` : L(`Err.${kind}`);
    case "no-key": case "bad-key": case "empty-input": case "network": case "auth": case "permission": case "overloaded": case "timeout":
    case "cancelled": case "refusal": case "truncated": case "empty-response": case "bad-response":
      return L(`Err.${kind}`);
    default:
      return L("Err.unknown", { error: redact(e?.message ?? String(e), 300) });
  }
}

/**
 * Czy wolno przenieść fokus do pola opisu? Tylko gdy użytkownik nie pracuje gdzie indziej: fokus jest na polu, na
 * przyciskach różdżki albo nigdzie (body). Pisanie w innym polu albo w czacie nie może zostać przerwane.
 */
export function mayTakeFocus(active, textarea, slot, body = globalThis.document?.body) {
  if (!active || active === body || active === textarea) return true;
  return !!slot?.contains?.(active);
}

/** Cofnięcie ma sens tylko, gdy pole nadal trzyma tekst wstawiony przez różdżkę (ręczne zmiany go unieważniają). */
export const canUndo = (store, value = store.textarea?.value) => store.original !== null && store.enhanced !== null && value === store.enhanced;

/**
 * Wstaw tekst. Gdy wolno wziąć fokus: przez execCommand, żeby działało też natywne Ctrl+Z (z zapasowym value).
 * Gdy użytkownik pisze gdzie indziej: samo value (bez kradzieży fokusu; natywne Ctrl+Z tu nie obejmie wstawki).
 */
function replaceText(textarea, text, { focus = true } = {}) {
  if (!focus) {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  textarea.focus();
  textarea.select();
  let ok = false;
  try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
  if (!ok || textarea.value !== text) {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.setSelectionRange(text.length, text.length);
}

/** Okno kluczy API (W5-F: klucze nie są już w Configure Settings); zapas: ustawienia Foundry na kategorii tego modułu. */
async function openModuleSettings() {
  try { if (game.modules.get(MODULE_ID)?.api?.openKeys?.()) return; } catch { /* fall back to the settings window */ }
  const sheet = game.settings.sheet;
  try {
    await sheet.render({ force: true });
    sheet.changeTab?.(MODULE_ID, "categories");
  } catch (e) { console.warn(`${MODULE_ID} | could not open the settings on this module's tab`, e); }
}

function button({ action, icon, label, primary = false, disabled = false }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `aiimg-enhance-btn${primary ? " is-wand" : ""}`;
  b.dataset.enhance = action;
  b.setAttribute("aria-label", label);
  b.dataset.tooltipText = label;
  b.dataset.tooltipDirection = "UP";
  b.disabled = disabled;
  const i = document.createElement("i");
  i.className = icon;
  i.setAttribute("aria-hidden", "true");
  b.append(i);
  return b;
}

/** Odrysuj przyciski i linię statusu z bieżącego stanu (bez re-renderu okna). */
function paint(store) {
  const { slot, statusEl, textarea } = store;
  if (slot?.isConnected) {
    const busy = !!store.controller;
    const parts = [];
    if (canUndo(store) && !busy) {
      parts.push(button({ action: "undo", icon: "fa-solid fa-rotate-left", label: L("Undo"), disabled: store.disabled }));
    }
    parts.push(busy
      ? button({ action: "cancel", icon: "fa-solid fa-spinner fa-spin", label: L("Cancel"), primary: true })
      : button({ action: "run", icon: "fa-solid fa-wand-magic-sparkles", label: L("Run"), primary: true, disabled: store.disabled }));
    slot.replaceChildren(...parts);
    slot.classList.toggle("is-busy", busy);
  }
  if (textarea?.isConnected) {
    textarea.toggleAttribute("readonly", !!store.controller);
    textarea.setAttribute("aria-busy", store.controller ? "true" : "false");
  }
  if (statusEl?.isConnected) {
    const s = store.status;
    statusEl.hidden = !s;
    statusEl.dataset.state = s?.type ?? "";
    statusEl.replaceChildren();
    if (s) {
      const i = document.createElement("i");
      i.className = s.type === "error" ? "fa-solid fa-circle-xmark" : s.type === "busy" ? "fa-solid fa-spinner fa-spin" : "fa-solid fa-wand-magic-sparkles";
      i.setAttribute("aria-hidden", "true");
      const span = document.createElement("span");
      span.textContent = s.text;
      statusEl.append(i, span);
      if (s.type === "error" && s.openSettings) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "link";
        link.textContent = L("OpenSettings");
        link.addEventListener("click", () => openModuleSettings());
        statusEl.append(" ", link);
      }
    }
  }
}

async function run(store, getContext) {
  if (store.controller || store.disabled) return;
  const textarea = store.textarea;
  if (!textarea?.isConnected) return;
  const before = textarea.value;
  if (!before.trim()) {
    store.status = { type: "error", text: L("Err.empty-input") };
    paint(store);
    textarea.focus();
    return;
  }
  const apiKey = enhanceKey();
  if (!apiKey) {
    store.status = { type: "error", text: L("Err.no-key"), openSettings: true };
    paint(store);
    return;
  }
  const { model, effort } = enhanceSettings();
  const controller = new AbortController();
  store.controller = controller;
  store.status = { type: "busy", text: L("Busy", { model }) };
  paint(store);
  try {
    const res = await enhanceDescription({ apiKey, model, effort, text: before, context: getContext?.() ?? {}, signal: controller.signal });
    if (store.controller !== controller) return; // anulowane/zresetowane w międzyczasie
    store.controller = null;
    const ta = store.textarea; // okno mogło się przerenderować: pisz do aktualnego pola
    if (!ta?.isConnected) return;
    if (ta.value !== before) {
      // Użytkownik zmienił tekst w trakcie (np. przez cofnięcie): nie nadpisuj jego pracy.
      store.status = { type: "error", text: L("Err.changed") };
      return;
    }
    // Kolejne ulepszenie tego samego wyniku: cofnięcie wraca do tekstu sprzed pierwszego.
    if (!canUndo(store, before)) store.original = before;
    store.enhanced = res.text;
    store.status = { type: "done", text: L("Done") };
    paint(store); // zdejmuje readonly z pola, inaczej execCommand nic nie wstawi
    const focus = mayTakeFocus(document.activeElement, ta, store.slot);
    store.inserting = true;
    try { replaceText(ta, res.text, { focus }); } finally { store.inserting = false; }
    store.enhanced = ta.value; // to, co pole faktycznie trzyma (np. po normalizacji końców linii)
    paint(store);
  } catch (e) {
    if (store.controller !== controller) return;
    store.controller = null;
    if (e?.kind !== "cancelled") console.warn(`${MODULE_ID} | enhance failed:`, redact(e?.message ?? String(e)));
    store.status = e?.kind === "cancelled"
      ? null
      : { type: "error", text: enhanceErrorText(e), openSettings: e?.kind === "no-key" || e?.kind === "bad-key" || e?.kind === "auth" || e?.kind === "model" };
  } finally {
    if (!store.controller) paint(store);
  }
}

/**
 * Przerwij od razu (UI nie czeka, aż fetch odrzuci obietnicę; spóźniony wynik zostanie zignorowany).
 * focus: wróć do pola (klik „Anuluj” przy polu); wywołania z zewnątrz (generowanie, test) fokusu nie ruszają.
 */
export function cancelEnhance(store, { focus = false } = {}) {
  if (!store.controller) return;
  store.controller.abort();
  store.controller = null;
  store.status = null;
  paint(store);
  if (focus) store.textarea?.focus();
}

function undo(store) {
  const ta = store.textarea;
  if (!ta?.isConnected || store.controller) return;
  if (!canUndo(store)) { store.original = store.enhanced = null; paint(store); return; } // ręczne zmiany: nie nadpisuj
  const text = store.original;
  store.original = store.enhanced = null;
  store.status = null;
  paint(store);
  store.inserting = true;
  try { replaceText(ta, text); } finally { store.inserting = false; }
}

/** Przerwij trwające żądanie i wyczyść stan (np. przy zmianie typu w szufladzie testu albo zamknięciu okna). */
export function resetEnhance(store) {
  store.controller?.abort();
  store.controller = null;
  store.original = null;
  store.enhanced = null;
  store.status = null;
}

/**
 * Podepnij różdżkę do pola po renderze okna.
 * @param {object} store       stan z createEnhanceStore()
 * @param {object} opts
 * @param {HTMLTextAreaElement} opts.textarea
 * @param {HTMLElement} opts.slot          kontener na przyciski ([data-role=enhance])
 * @param {HTMLElement} [opts.statusEl]    linia statusu pod polem
 * @param {string} [opts.scope]            zmiana zakresu (np. inny typ) czyści cofnięcie
 * @param {boolean} [opts.disabled]
 * @param {() => {name?:string, type?:string}} [opts.getContext]
 */
export function mountEnhance(store, { textarea, slot, statusEl, scope = null, disabled = false, getContext } = {}) {
  if (!textarea || !slot) return;
  if (store.scope !== scope) { resetEnhance(store); store.scope = scope; }
  Object.assign(store, { textarea, slot, statusEl: statusEl ?? null, disabled: !!disabled });
  slot.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-enhance]");
    if (!b || b.disabled) return;
    ev.preventDefault();
    if (b.dataset.enhance === "run") run(store, getContext);
    else if (b.dataset.enhance === "cancel") cancelEnhance(store, { focus: true });
    else if (b.dataset.enhance === "undo") undo(store);
  });
  // Ctrl/Cmd+Enter w polu opisu = ulepsz.
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      run(store, getContext);
    }
  });
  // Ręczna edycja: znika stary komunikat o sukcesie (błąd zostaje, aż ktoś spróbuje ponownie) i cofnięcie,
  // bo wstawiłoby oryginał w miejsce ręcznych poprawek (natywne Ctrl+Z dalej działa).
  textarea.addEventListener("input", () => {
    if (store.inserting) return;
    let dirty = false;
    if (store.status?.type === "done") { store.status = null; dirty = true; }
    if (store.original !== null && !canUndo(store, textarea.value)) { store.original = store.enhanced = null; dirty = true; }
    if (dirty) paint(store);
  });
  paint(store);
}
