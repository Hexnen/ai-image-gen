// Logika generacji dla jednego dokumentu (Fast i Batch), bez UI.
import { getKey } from "./settings.mjs";
import { resolveTypeKey } from "./image-types.mjs";
import { getConfig, isConfigured, renderPrompt } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { assertWithinLimits, recordCost } from "./limits.mjs";
import { saveImageBlob, applyImage } from "./save-image.mjs";
import { submitBatch } from "./batch/index.mjs";
import { estimateBatchCost } from "./batch/cost.mjs";
import { logCall, updateCall, tokensFrom } from "./call-log.mjs";

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
    name: document.name ?? "image",
    typeKey: key,
    description: description.trim()
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

/** Wspólne pola wpisu logu dla jednego żądania. */
function logBase(document, description, key, cfg, prompt, kind) {
  return {
    kind, provider: cfg.provider, model: cfg.model, prompt, description: description.trim(),
    size: `${cfg.width}x${cfg.height}`,
    // tylko parametry, które dany provider faktycznie dostaje
    quality: cfg.provider === "openai" ? cfg.quality : undefined,
    imageSize: cfg.provider === "gemini" ? cfg.imageSize : undefined,
    thinkingLevel: cfg.provider === "gemini" ? cfg.thinkingLevel : undefined,
    refsCount: cfg.refs?.length ?? 0, docUuid: document.uuid, docName: document.name, typeKey: key
  };
}

/** Fast: generuj teraz, zapisz plik i podmień obraz dokumentu. @returns {Promise<string>} ścieżka */
export async function runFast(document, description, { signal } = {}) {
  const { key, cfg, prompt, meta } = describe(document, description);
  const base = logBase(document, description, key, cfg, prompt, "fast");
  const ts = new Date().toISOString();
  let t0 = performance.now();
  let entry = null;
  try {
    if (!prompt.trim()) throw new Error("Empty prompt.");
    const apiKey = getKey(cfg.provider);
    if (!apiKey) throw new Error(`No API key for ${providers.PROVIDERS[cfg.provider]?.label ?? cfg.provider}.`);
    const est = estimateFast(cfg, cfg.refs.length);
    try {
      assertWithinLimits(est);
    } catch (e) {
      await logCall({ ...base, ts, kind: "limit-blocked", status: "blocked", cost: est, costKind: "estimated", error: e.message, durationMs: 0 });
      e.aiimgLogged = true;
      throw e;
    }
    const refs = await loadRefs(cfg.refs);
    t0 = performance.now();
    const { blob, cost, raw, route } = await providers.generate({
      provider: cfg.provider, apiKey, model: cfg.model, prompt, refs,
      width: cfg.width, height: cfg.height, quality: cfg.quality,
      imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel, signal
    });
    entry = await logCall({
      ...base, ts, status: "ok", durationMs: performance.now() - t0, route,
      cost, costKind: "actual", tokens: tokensFrom(raw) ?? undefined
    });
    await recordCost(cost); // koszt jest realny nawet gdy zapis się nie uda
    const path = await saveImageBlob(blob, meta);
    await applyImage(document.uuid, path, FIELD);
    return path;
  } catch (e) {
    if (entry) await updateCall(entry.id, { status: "error", error: `After generation: ${e.message}` });
    else if (!e.aiimgLogged) await logCall({ ...base, ts, status: "error", durationMs: performance.now() - t0, cost: 0, costKind: "actual", error: e.message });
    throw e;
  }
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
