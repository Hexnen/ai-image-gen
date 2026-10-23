import { MODULE_ID, PROVIDER_IDS } from "./constants.mjs";
import * as providers from "./providers/index.mjs";
import { DEFAULT_OUTPUT, MAX_EDGES, FORMATS } from "./optimize.mjs";
import { defaultEdgeForKey } from "./output-preview.mjs";
import { virtualDefaults } from "./image-types.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  provider: "openai",
  model: "gpt-image-2.5-sunburst",
  width: 1024,
  height: 1024,
  promptTemplate: "{description}",
  refs: [],
  defaultMode: "fast",
  defaultCount: 1,     // versions per run offered by the generate dialog (1-8)
  quality: "medium",
  imageSize: "1K",     // Gemini
  thinkingLevel: "",   // Gemini; "" = domyślny modelu
  // Output: co zapisujemy na dysk (nie zmienia żądania do API). outMaxEdge 0 = bez zmniejszania.
  outMaxEdge: DEFAULT_OUTPUT.maxEdge,
  outFormat: DEFAULT_OUTPUT.format,
  outQuality: DEFAULT_OUTPUT.quality
});

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
  // Zapis z nieznanym dostawcą (usunięty/przemianowany) psułby każde renderowanie okien: wróć do domyślnego.
  if (!PROVIDER_IDS.includes(cfg.provider)) { cfg.provider = DEFAULT_CONFIG.provider; cfg.model = DEFAULT_CONFIG.model; }
  if (!QUALITIES.includes(cfg.quality)) cfg.quality = DEFAULT_CONFIG.quality; // old saves lack it
  cfg.defaultCount = clampCount(cfg.defaultCount);
  // Heal a model that no longer belongs to the provider.
  const models = providers.listModels(cfg.provider);
  if (models.length && !models.some((m) => m.id === cfg.model)) cfg.model = models[0].id;
  Object.assign(cfg, fitConfig(cfg));
  // Batch is impossible for providers without it.
  if (cfg.defaultMode === "batch" && !providers.PROVIDERS[cfg.provider]?.supportsBatch) cfg.defaultMode = "fast";
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
    imageSize: String(data.imageSize ?? DEFAULT_CONFIG.imageSize),
    thinkingLevel: String(data.thinkingLevel ?? ""),
    ...normalizeOutput(data)
  };
  clean = fitConfig(clean);
  if (!providers.PROVIDERS[clean.provider]?.supportsBatch) clean.defaultMode = "fast";
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
