import { MODULE_ID } from "./constants.mjs";
import * as providers from "./providers/index.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  provider: "openai",
  model: "gpt-image-2.5-sunburst",
  width: 1024,
  height: 1024,
  promptTemplate: "{description}",
  refs: [],
  defaultMode: "fast",
  quality: "medium",
  imageSize: "1K",     // Gemini
  thinkingLevel: ""    // Gemini; "" = domyślny modelu
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

/**
 * Dopasuj konfigurację do możliwości jej modelu (czysta funkcja, bez zapisu): jakość OpenAI,
 * rozmiar i thinking Gemini, rozmiar 2.5 do reguł API. Stare zapisy bez nowych pól dostają domyślne.
 */
export function fitConfig(cfg) {
  const out = { ...cfg };
  if (out.provider === "openai") {
    out.quality = providers.fitOpenAIQuality(out.model, out.quality);
    if (providers.openaiCustomSize(out.model)) {
      const n = providers.normalizeOpenAISize(out.width, out.height);
      out.width = n.width;
      out.height = n.height;
    }
  } else if (out.provider === "gemini") {
    out.imageSize = providers.fitGeminiSize(out.model, out.imageSize);
    out.thinkingLevel = providers.fitGeminiThinking(out.model, out.thinkingLevel);
  }
  return out;
}

const all = () => game.settings.get(MODULE_ID, "imageTypes") ?? {};

// Type keys contain dots ("dnd5e.Actor.npc"); Foundry expands dotted keys inside an
// ObjectField into nested objects, so store them with a dot-free key.
const sk = (key) => String(key).replaceAll(".", "|");

/** Has the user saved anything for this type? */
export const isConfigured = (key) => sk(key) in all();

/** Config for a type key, merged over defaults (so unconfigured types still work). */
export function getConfig(key) {
  const saved = all()[sk(key)] ?? {};
  const cfg = { ...DEFAULT_CONFIG, ...saved, refs: [...(saved.refs ?? [])] };
  if (!QUALITIES.includes(cfg.quality)) cfg.quality = DEFAULT_CONFIG.quality; // old saves lack it
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

const clampSize = (v, fallback) => Math.max(64, Math.min(3840, Math.round(Number(v)) || fallback));

export async function setConfig(key, data) {
  assertGM();
  let clean = {
    provider: String(data.provider),
    model: String(data.model),
    width: clampSize(data.width, DEFAULT_CONFIG.width),
    height: clampSize(data.height, DEFAULT_CONFIG.height),
    promptTemplate: String(data.promptTemplate ?? DEFAULT_CONFIG.promptTemplate),
    refs: (data.refs ?? []).filter(Boolean).map(String),
    defaultMode: data.defaultMode === "batch" ? "batch" : "fast",
    quality: QUALITIES.includes(data.quality) ? data.quality : DEFAULT_CONFIG.quality,
    imageSize: String(data.imageSize ?? DEFAULT_CONFIG.imageSize),
    thinkingLevel: String(data.thinkingLevel ?? "")
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
