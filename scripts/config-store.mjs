import { MODULE_ID, PROVIDER_IDS } from "./constants.mjs";
import * as providers from "./providers/index.mjs";
import { DEFAULT_OUTPUT, MAX_EDGES, FORMATS } from "./optimize.mjs";
import { defaultEdgeForKey } from "./output-preview.mjs";
import { virtualDefaults } from "./image-types.mjs";
import { DEFAULTS as EST, fitPurpose, clampMaxEdge, PURPOSE_IDS } from "./image-cost.mjs";
import { normalizeDepth } from "./depth-settings.mjs";

// The default model is the provider's first catalogue entry (W6-F: gpt-image-2.6-flare). It only fills types with no
// saved model: setConfig always stores the chosen model, so existing saves keep theirs (no migration needed).
export const DEFAULT_CONFIG = Object.freeze({
  provider: "openai",
  model: providers.defaultModelId("openai"),
  width: 1024,
  height: 1024,
  promptTemplate: "{description}",
  refs: [],
  defaultMode: "fast",
  defaultCount: 1,     // versions per run offered by the generate dialog (1-8)
  quality: "medium",
  transparent: false,  // transparent background (only models with supportsTransparent)
  imageSize: "1K",     // Gemini
  thinkingLevel: "",   // Gemini; "" = domyślny modelu
  // Output: co zapisujemy na dysk (nie zmienia żądania do API). outMaxEdge 0 = bez zmniejszania.
  outMaxEdge: DEFAULT_OUTPUT.maxEdge,
  outFormat: DEFAULT_OUTPUT.format,
  outQuality: DEFAULT_OUTPUT.quality,
  // W6-D: referencje są zmniejszane przed wysyłką (image-cost.mjs): przeznaczenie → próg, limit dłuższego boku,
  // nadpisania per obraz [{path, purpose}] (tablica, bo ścieżki mają kropki, a ObjectField rozwija klucze z kropkami).
  refPurpose: EST.purpose,
  refMaxEdge: EST.maxEdge,
  refPurposes: []
});

/** Nadpisania przeznaczenia per referencja: tylko dla ścieżek z listy refs i znanych przeznaczeń. */
export function cleanRefPurposes(list, refs = []) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const path = String(e?.path ?? "");
    if (!refs.includes(path) || !PURPOSE_IDS.includes(e?.purpose) || out.some((x) => x.path === path)) continue;
    out.push({ path, purpose: e.purpose });
  }
  return out;
}

/** Pola referencji w dozwolonym zakresie (stare zapisy bez nich dostają domyślne). */
export function normalizeRefOpts(cfg = {}, refs = cfg.refs ?? []) {
  return {
    refPurpose: fitPurpose(cfg.refPurpose),
    refMaxEdge: clampMaxEdge(cfg.refMaxEdge ?? EST.maxEdge),
    refPurposes: cleanRefPurposes(cfg.refPurposes, refs)
  };
}

/** Wszystkie wartości jakości (UI pokazuje podzbiór wg modelu: providers.modelCaps). */
export const QUALITIES = providers.OPENAI_QUALITIES_25;

const toPreset = (id) => { const [width, height] = id.split("x").map(Number); return { id, width, height }; };
export const SIZE_PRESETS = providers.MODELS.openai[0].presets.map(toPreset);

/** Presety rozdzielczości dla modelu (starsze modele OpenAI: tylko 3 rozmiary API). */
export function sizePresetsFor(provider, model) {
  const caps = providers.modelCaps(provider, model);
  return (caps?.presets ?? ["1024x1024", "1536x1024", "1024x1536", "1536x864"]).map(toPreset);
}

/** Wartość spoza listy (np. 1280 z typu zarejestrowanego przez inny moduł) → najbliższa z MAX_EDGES (remis: większa). 0/niepoprawna → domyślna. */
function nearestEdge(edge) {
  if (!Number.isFinite(edge)) return DEFAULT_OUTPUT.maxEdge;
  if (edge <= 0) return 0;
  const e = Math.round(edge);
  if (MAX_EDGES.includes(e)) return e;
  let best = null;
  for (const c of MAX_EDGES) {
    if (c <= 0) continue;
    if (best === null || Math.abs(c - e) < Math.abs(best - e) || (Math.abs(c - e) === Math.abs(best - e) && c > best)) best = c;
  }
  return best ?? DEFAULT_OUTPUT.maxEdge;
}

/** Pola „Output” z wartościami w dozwolonym zakresie (stare zapisy bez nich dostają domyślne). */
export function normalizeOutput(cfg = {}) {
  const edge = Number(cfg.outMaxEdge);
  const q = Number(cfg.outQuality);
  return {
    outMaxEdge: nearestEdge(edge),
    outFormat: FORMATS.includes(cfg.outFormat) ? cfg.outFormat : DEFAULT_OUTPUT.format,
    outQuality: Number.isFinite(q) ? Math.min(1, Math.max(0.5, Math.round(q * 100) / 100)) : DEFAULT_OUTPUT.quality
  };
}

/**
 * Dopasuj konfigurację do możliwości jej modelu (czysta funkcja, bez zapisu): jakość OpenAI,
 * rozmiar i thinking Gemini, rozmiar 2.5 do reguł API. Stare zapisy bez nowych pól dostają domyślne.
 */
export function fitConfig(cfg) {
  const out = { ...cfg, ...normalizeOutput(cfg) };
  // Transparent background: only for models that take it; it needs an alpha-capable file (JPEG has none).
  out.transparent = !!cfg.transparent && providers.supportsTransparent(out.provider, out.model);
  if (out.transparent && out.outFormat === "jpeg") out.outFormat = "webp";
  if (out.provider === "openai") {
    out.quality = providers.fitOpenAIQuality(out.model, out.quality);
  } else if (out.provider === "gemini") {
    out.imageSize = providers.fitGeminiSize(out.model, out.imageSize);
    out.thinkingLevel = providers.fitGeminiThinking(out.model, out.thinkingLevel);
  }
  const fit = providers.fitSizeFor(out.provider, out.model, out.width, out.height);
  out.width = fit.width;
  out.height = fit.height;
  return out;
}

const all = () => game.settings.get(MODULE_ID, "imageTypes") ?? {};

/** W6-G: only decides the default depth model (V2 Large with WebGPU, V2 Small without) for types with no saved depth. */
export const depthEnv = () => ({ webgpu: !!globalThis.navigator?.gpu });

/**
 * Where a retired model goes: a GPT Image save moves to the provider's default GPT Image Flare (W6-F: 2.6 Flare; same
 * provider, so OpenRouter saves stay on OpenRouter), anything else to the provider's first model.
 */
export function replacementModel(provider, oldId, models = providers.listModels(provider)) {
  if (/gpt-?(\d+(\.\d+)?-)?image/i.test(String(oldId))) {
    const flare = models.find((m) => /gpt-image-[\d.]+-flare$/.test(m.id));
    if (flare) return flare.id;
  }
  return models[0]?.id ?? "";
}

/**
 * Referencje to ścieżki plików w Data (względne). Odrzucamy adresy http(s)/data/blob/file, litery dysków,
 * `//` i `..`: `loadRefs` pobiera je z przeglądarki GM-a i wysyła bajty do dostawcy, więc konfiguracja
 * (czytelna dla wszystkich klientów świata) nie może wskazywać dowolnego adresu. Bez duplikatów.
 */
export function cleanRefs(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const v = String(r ?? "").trim();
    if (!v || v.length > 512) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || /^[\\/]{2}/.test(v) || v.split(/[\\/]/).includes("..")) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// Type keys contain dots ("dnd5e.Actor.npc"); Foundry expands dotted keys inside an
// ObjectField into nested objects, so store them with a dot-free key.
const sk = (key) => String(key).replaceAll(".", "|");

/**
 * W7-B: change a saved type configuration in place (GM only). `fn(saved)` returns the fields to replace, or null to
 * leave it. Types with nothing saved are skipped (they already take their registered defaults). @returns {Promise<boolean>}
 */
export async function patchSavedConfig(key, fn) {
  if (!game.user?.isGM) return false;
  const store = all();
  const saved = store[sk(key)];
  if (!saved || typeof saved !== "object") return false;
  const patch = fn(saved);
  if (!patch) return false;
  await game.settings.set(MODULE_ID, "imageTypes", { ...store, [sk(key)]: { ...saved, ...patch } });
  return true;
}

/** Has the user saved anything for this type? */
export const isConfigured = (key) => sk(key) in all();

/** Config for a type key, merged over defaults (so unconfigured types still work). */
export function getConfig(key) {
  const store = all();
  const saved = store[sk(key)] ?? {};
  // A type with no saved configuration gets the saved-file limit that fits its kind (Actor 1024, Item 256, Macro 128);
  // an existing save keeps whatever it has (old saves without the field stay at the general default).
  // Types registered by other modules bring their own starting configuration (prompt, size, output…).
  const vd = virtualDefaults(key);
  const dflt = vd ? { ...DEFAULT_CONFIG, ...vd, refs: cleanRefs(vd.refs) } : DEFAULT_CONFIG;
  const base = sk(key) in store ? dflt : { ...dflt, outMaxEdge: vd?.outMaxEdge ?? defaultEdgeForKey(key) };
  const cfg = { ...base, ...saved, refs: cleanRefs(saved.refs ?? (vd ? dflt.refs : undefined)) };
  Object.assign(cfg, normalizeRefOpts(cfg));
  // W6-G: depth settings (tab "Głębia") live under cfg.depth; old saves without them get the defaults.
  cfg.depth = normalizeDepth(saved.depth ?? vd?.depth, depthEnv());
  // Zapis z nieznanym dostawcą (usunięty/przemianowany) psułby każde renderowanie okien: wróć do domyślnego.
  if (!PROVIDER_IDS.includes(cfg.provider)) { cfg.provider = DEFAULT_CONFIG.provider; cfg.model = DEFAULT_CONFIG.model; }
  if (!QUALITIES.includes(cfg.quality)) cfg.quality = DEFAULT_CONFIG.quality; // old saves lack it
  cfg.defaultCount = clampCount(cfg.defaultCount);
  // A model that left the catalogue (old GPT Image 1/1.5/2 saves) is replaced, not deleted from the save: the
  // rest of the settings stay, size and quality are fitted to the new model, and `retiredModel` lets the
  // editor say so until the type is saved again (setConfig never stores it).
  const models = providers.listModels(cfg.provider);
  if (models.length && !models.some((m) => m.id === cfg.model)) {
    cfg.retiredModel = cfg.model;
    cfg.model = replacementModel(cfg.provider, cfg.model, models);
  }
  Object.assign(cfg, fitConfig(cfg));
  // Batch is impossible for providers or models without it (gpt-image-2.6 has no Batch API).
  if (cfg.defaultMode === "batch" && !providers.supportsBatchFor(cfg.provider, cfg.model)) cfg.defaultMode = "fast";
  return cfg;
}

function assertGM() {
  if (!game.user.isGM) throw new Error("Only a GM can change image settings.");
}

export const clampCount = (v) => Math.min(8, Math.max(1, Math.floor(Number(v)) || 1));
const clampSize = (v, fallback) => Math.max(64, Math.min(3840, Math.round(Number(v)) || fallback));

export async function setConfig(key, data) {
  assertGM();
  if (!PROVIDER_IDS.includes(data.provider)) throw new Error(`Unknown provider: ${data.provider}`);
  const known = providers.listModels(data.provider);
  const model = known.length && !known.some((m) => m.id === data.model) ? known[0].id : String(data.model);
  let clean = {
    provider: String(data.provider),
    model,
    width: clampSize(data.width, DEFAULT_CONFIG.width),
    height: clampSize(data.height, DEFAULT_CONFIG.height),
    promptTemplate: String(data.promptTemplate ?? DEFAULT_CONFIG.promptTemplate),
    refs: cleanRefs(data.refs),
    defaultMode: data.defaultMode === "batch" ? "batch" : "fast",
    defaultCount: clampCount(data.defaultCount),
    quality: QUALITIES.includes(data.quality) ? data.quality : DEFAULT_CONFIG.quality,
    transparent: !!data.transparent,
    imageSize: String(data.imageSize ?? DEFAULT_CONFIG.imageSize),
    thinkingLevel: String(data.thinkingLevel ?? ""),
    ...normalizeOutput(data),
    ...normalizeRefOpts(data, cleanRefs(data.refs)),
    // W6-G: a caller that sends no depth (older code paths) keeps the saved one
    depth: normalizeDepth(data.depth ?? all()[sk(key)]?.depth, depthEnv())
  };
  clean = fitConfig(clean);
  if (!providers.supportsBatchFor(clean.provider, clean.model)) clean.defaultMode = "fast";
  await game.settings.set(MODULE_ID, "imageTypes", { ...all(), [sk(key)]: clean });
  return clean;
}

export async function resetConfig(key) {
  assertGM();
  const next = { ...all() };
  delete next[sk(key)];
  await game.settings.set(MODULE_ID, "imageTypes", next);
}

/** Fill the placeholders of a prompt template. */
export function renderPrompt(template, { description = "", name = "", type = "" } = {}) {
  const vars = { description, name, type };
  return String(template).replace(/\{(description|name|type)\}/g, (_, k) => vars[k]);
}
