// Warstwa providerów SYNC (tryb "fast"). Batch jest osobno (faza 5).
//
// generate({ provider, apiKey, model, prompt, refs?: Blob[], width?, height?,
//            aspectRatio?: "w:h", quality?: "low"|"medium"|"high" (tylko openai), signal? })
//   -> { blob: Blob, cost: number /* USD; 0 gdy nieznany */, raw }
//
// Uwagi: wywołania idą z przeglądarki (CORS niezweryfikowany). Wymiary są mapowane
// na najbliższe wspierane przez dostawcę (OpenAI: 3 rozmiary; Gemini/OpenRouter: aspekt).
import * as openai from "./openai.mjs";
import * as gemini from "./gemini.mjs";
import * as openrouter from "./openrouter.mjs";

export const PROVIDERS = {
  openai: { label: "OpenAI", supportsBatch: true },
  gemini: { label: "Google Gemini", supportsBatch: true },
  openrouter: { label: "OpenRouter", supportsBatch: false },
};

const IMPL = { openai, gemini, openrouter };

const MODELS = {
  openai: [
    { id: "gpt-image-2", label: "GPT Image 2" },
    { id: "gpt-image-1.5", label: "GPT Image 1.5" },
    { id: "gpt-image-1", label: "GPT Image 1" },
    { id: "gpt-image-1-mini", label: "GPT Image 1 mini" },
  ],
  gemini: [
    { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite" },
  ],
  openrouter: [
    { id: "google/gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite (OpenRouter)" },
    { id: "openai/gpt-5.4-image-2", label: "GPT Image 2 (OpenRouter, chat)" },
  ],
};

export function listModels(provider) {
  return (MODELS[provider] ?? []).map((m) => ({ ...m }));
}

export async function generate({ provider, ...rest }) {
  const impl = IMPL[provider];
  if (!impl) throw new Error(`Nieznany provider: ${provider}`);
  if (!rest.apiKey) throw new Error(`Brak klucza API dla ${PROVIDERS[provider].label}.`);
  return impl.generate(rest);
}
