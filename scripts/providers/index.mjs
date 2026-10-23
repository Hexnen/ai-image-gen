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
import * as gemini from "./gemini.mjs";
import * as openrouter from "./openrouter.mjs";
import { MODELS, getModel, defaultModelId } from "./models.mjs";

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

export async function generate({ provider, ...rest }) {
  const impl = IMPL[provider];
  if (!impl) throw new Error(`Nieznany provider: ${provider}`);
  if (!rest.apiKey) throw new Error(`Brak klucza API dla ${PROVIDERS[provider].label}.`);
  return impl.generate(rest);
}
