// Logika generacji dla jednego dokumentu (Fast i Batch), bez UI.
import { getKey } from "./settings.mjs";
import { resolveTypeKey } from "./image-types.mjs";
import { getConfig, isConfigured, renderPrompt } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { assertWithinLimits, recordCost } from "./limits.mjs";
import { saveImageBlob, applyImage } from "./save-image.mjs";
import { submitBatch } from "./batch/index.mjs";
import { estimateBatchCost } from "./batch/cost.mjs";

const FIELD = "img";

/** Wczytaj obrazy referencyjne (ścieżki z konfiguracji) jako Blob-y. */
export async function loadRefs(paths = []) {
  const out = [];
  for (const p of paths) {
    const url = /^(https?:|data:|blob:)/.test(p) ? p : foundry.utils.getRoute(p);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Reference image ${p}: HTTP ${res.status}`);
    out.push(await res.blob());
  }
  return out;
}

/** Stan gotowości dla dialogu: klucz, konfiguracja, możliwość batcha. */
export function readiness(document) {
  const key = resolveTypeKey(document);
  const cfg = getConfig(key);
  const provider = providers.PROVIDERS[cfg.provider];
  return {
    key,
    cfg,
    configured: isConfigured(key),
    hasKey: !!getKey(cfg.provider),
    providerLabel: provider?.label ?? cfg.provider,
    modelLabel: providers.listModels(cfg.provider).find((m) => m.id === cfg.model)?.label ?? cfg.model,
    canBatch: !!provider?.supportsBatch
  };
}

function describe(document, description) {
  const key = resolveTypeKey(document);
  if (!key) throw new Error("Unsupported document.");
  const cfg = getConfig(key);
  const prompt = renderPrompt(cfg.promptTemplate, {
    description: description.trim(),
    name: document.name ?? "",
    type: document.type ?? document.documentName
  });
  const meta = {
    system: document.documentName === "Macro" ? "core" : game.system.id,
    docType: [document.documentName, document.type].filter(Boolean).join("-"),
    name: document.name ?? "image"
  };
  return { key, cfg, prompt, meta };
}

/** Szacunek kosztu pojedynczego żądania (sync ≈ 2× batch). 0 gdy nieznany. */
function estimateFast(cfg, refCount) {
  try {
    return estimateBatchCost(cfg.provider, cfg.model, [{
      refs: new Array(refCount), width: cfg.width, height: cfg.height, quality: cfg.quality, imageSize: cfg.imageSize
    }]) * 2;
  } catch {
    return 0;
  }
}

/** Fast: generuj teraz, zapisz plik i podmień obraz dokumentu. @returns {Promise<string>} ścieżka */
export async function runFast(document, description, { signal } = {}) {
  const { cfg, prompt, meta } = describe(document, description);
  if (!prompt.trim()) throw new Error("Empty prompt.");
  const apiKey = getKey(cfg.provider);
  if (!apiKey) throw new Error(`No API key for ${providers.PROVIDERS[cfg.provider]?.label ?? cfg.provider}.`);
  assertWithinLimits(estimateFast(cfg, cfg.refs.length));
  const refs = await loadRefs(cfg.refs);
  const { blob, cost } = await providers.generate({
    provider: cfg.provider, apiKey, model: cfg.model, prompt, refs,
    width: cfg.width, height: cfg.height, quality: cfg.quality,
    imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel, signal
  });
  await recordCost(cost); // koszt jest realny nawet gdy zapis się nie uda
  const path = await saveImageBlob(blob, meta);
  await applyImage(document.uuid, path, FIELD);
  return path;
}

/** Batch: zakolejkuj jeden element. @returns {Promise<object>} rekord batcha */
export async function runBatch(document, description) {
  const { cfg, prompt, meta } = describe(document, description);
  if (!prompt.trim()) throw new Error("Empty prompt.");
  const refs = await loadRefs(cfg.refs);
  return submitBatch({
    provider: cfg.provider,
    model: cfg.model,
    items: [{
      id: foundry.utils.randomID(),
      prompt, refs, width: cfg.width, height: cfg.height, quality: cfg.quality,
      imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel,
      target: { uuid: document.uuid, field: FIELD },
      meta
    }]
  });
}
