// Warstwa providerów SYNC (tryb "fast"). Batch jest osobno (faza 5).
//
// generate({ provider, apiKey, model, prompt, refs?: Blob[], width?, height?,
//            aspectRatio?: "w:h", quality? (openai: low..max wg modelu), imageSize? ("1K"|"2K"|"4K"|"0.5K", gemini),
//            thinkingLevel? ("minimal"|"medium"|"high", gemini), signal? })
//   -> { blob: Blob, cost: number /* USD; 0 gdy nieznany */, raw }
//
// Uwagi: wywołania idą z przeglądarki (CORS niezweryfikowany). Wymiary są mapowane
// na najbliższe wspierane przez dostawcę (OpenAI: 3 rozmiary; Gemini/OpenRouter: aspekt).
import * as openai from "./openai.mjs";
import { requireUsableKey } from "../key-check.mjs";
import * as gemini from "./gemini.mjs";
import * as openrouter from "./openrouter.mjs";
import { MODELS, getModel, defaultModelId, modelHasBatch } from "./models.mjs";
import { normalizeError } from "./util.mjs";

export * from "./models.mjs";

export const PROVIDERS = {
  openai: { label: "OpenAI", supportsBatch: true },
  gemini: { label: "Google Gemini", supportsBatch: true },
  openrouter: { label: "OpenRouter", supportsBatch: false },
};

const IMPL = { openai, gemini, openrouter };

/** [{ id, label, note?, ...możliwości }] — pełne wpisy katalogu (models.mjs). */
export function listModels(provider) {
  return (MODELS[provider] ?? []).map((m) => ({ ...m }));
}

/** Możliwości jednego modelu (albo null dla nieznanego/OpenRouter). */
export const modelCaps = (provider, id) => getModel(provider, id);
export { defaultModelId };

/** Batch possible for this provider AND model (gpt-image-2.6 has no Batch API although OpenAI has one). */
export const supportsBatchFor = (provider, model) => !!PROVIDERS[provider]?.supportsBatch && modelHasBatch(provider, model);

/** Why batch is off: "provider" (no batch API at all), "model" (this model has none), or "" (batch is possible). */
export const noBatchReason = (provider, model) =>
  !PROVIDERS[provider]?.supportsBatch ? "provider" : !modelHasBatch(provider, model) ? "model" : "";

export async function generate({ provider, ...rest }) {
  const impl = IMPL[provider];
  if (!impl) throw new Error(`Nieznany provider: ${provider}`);
  // W6-B: niewidoczne znaki zdjęte; widoczny znak spoza ASCII -> ApiKeyError (bez klucza w tekście), zanim fetch rzuci
  rest.apiKey = requireUsableKey(rest.apiKey);
  if (!rest.apiKey) throw new Error(`Brak klucza API dla ${PROVIDERS[provider].label}.`);
  try {
    return await impl.generate(rest);
  } catch (e) {
    throw normalizeError(e); // TimeoutError/AbortError -> czytelny komunikat, name zachowane
  }
}
