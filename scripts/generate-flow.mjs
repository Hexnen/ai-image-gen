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

export const MAX_VERSIONS = 8;
export const MAX_EXTRA_REF_BYTES = 20 * 1024 * 1024;
const FAST_CONCURRENCY = 3;

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

/** Maks. liczba obrazów referencyjnych dla modelu (OpenAI edits 16, Gemini wg katalogu, reszta 14). */
export function maxRefsFor(provider, model) {
  if (provider === "openai") return 16;
  if (provider === "gemini") return providers.modelCaps("gemini", model)?.maxRefs ?? 14;
  return 14;
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
    canBatch: !!provider?.supportsBatch,
    maxRefs: maxRefsFor(cfg.provider, cfg.model)
  };
}

/** The exact prompt text sent to the provider. The dialog preview uses this same function. */
export function buildPrompt(document, description, cfg = getConfig(resolveTypeKey(document))) {
  return renderPrompt(cfg.promptTemplate, {
    description: (description ?? "").trim(),
    name: document.name ?? "",
    type: document.type ?? document.documentName
  });
}

function describe(document, description) {
  const key = resolveTypeKey(document);
  if (!key) throw new Error("Unsupported document.");
  const cfg = getConfig(key);
  const prompt = buildPrompt(document, description, cfg);
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

/** Szacowany koszt całości (Fast ×count; Batch ×count po stawkach batch) — do UI. */
export function estimateTotal(document, { count = 1, extraRefs = 0, mode = "fast" } = {}) {
  const key = resolveTypeKey(document);
  if (!key) return 0;
  const cfg = getConfig(key);
  const refs = (cfg.refs?.length ?? 0) + extraRefs;
  const one = estimateFast(cfg, refs) / (mode === "batch" ? 2 : 1);
  return one * count;
}

/** Walidacja liczby wersji i referencji (rzuca czytelny błąd). @returns {number} łączna liczba referencji */
function validateRun(cfg, count, extraRefs) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_VERSIONS) {
    throw new Error(`Versions must be between 1 and ${MAX_VERSIONS}.`);
  }
  const total = (cfg.refs?.length ?? 0) + extraRefs.length;
  const max = maxRefsFor(cfg.provider, cfg.model);
  if (total > max) throw new Error(`Too many reference images: ${total} (max ${max} for this model).`);
  for (const b of extraRefs) {
    if (!/^image\//.test(b.type || "")) throw new Error("Extra references must be images.");
    if (b.size > MAX_EXTRA_REF_BYTES) throw new Error(`A reference image is larger than ${MAX_EXTRA_REF_BYTES / 1048576} MB.`);
  }
  return total;
}

/** Wspólne pola wpisu logu dla jednego żądania. */
function logBase(document, description, key, cfg, prompt, kind, refsTotal) {
  return {
    kind, provider: cfg.provider, model: cfg.model, prompt, description: description.trim(),
    size: `${cfg.width}x${cfg.height}`,
    // tylko parametry, które dany provider faktycznie dostaje
    quality: cfg.provider === "openai" ? cfg.quality : undefined,
    imageSize: cfg.provider === "gemini" ? cfg.imageSize : undefined,
    thinkingLevel: cfg.provider === "gemini" ? cfg.thinkingLevel : undefined,
    refsCount: refsTotal, docUuid: document.uuid, docName: document.name, typeKey: key
  };
}

/** Wykonaj `count` zadań z ograniczoną współbieżnością; zadanie nigdy nie przerywa reszty. */
async function pool(count, limit, task) {
  const out = new Array(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      out[i] = await task(i).then((v) => ({ ok: true, ...v }), (e) => ({ ok: false, error: e?.message ?? String(e) }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return out;
}

/**
 * Fast: wygeneruj `count` wersji (bez zapisu na dysk). OpenAI: JEDNO żądanie z `n`; Gemini/OpenRouter:
 * `count` żądań, max 3 równolegle (błąd jednej wersji nie przerywa reszty). Log: osobny wpis na wersję;
 * przy OpenAI koszt żądania (usage całości) jest dzielony po równo na wersje. Koszt naliczany raz.
 * @returns {Promise<{candidates:{index:number, blob:Blob, cost:number, logId?:string}[],
 *   failed:{index:number, error:string}[], cost:number, meta:object, prompt:string, key:string}>}
 */
export async function generateCandidates(document, description, { count = 1, extraRefs = [], signal } = {}) {
  const { key, cfg, prompt, meta } = describe(document, description);
  const ts = new Date().toISOString();
  let refsTotal = (cfg.refs?.length ?? 0) + extraRefs.length;
  const base = logBase(document, description, key, cfg, prompt, "fast", refsTotal);
  const preFail = async (e, kind = "fast", status = "error", cost = 0, costKind = "actual") => {
    await logCall({ ...base, ts, kind, status, cost, costKind, error: e.message, durationMs: 0 });
    e.aiimgLogged = true;
    return e;
  };
  if (!prompt.trim()) throw await preFail(new Error("Empty prompt."));
  const apiKey = getKey(cfg.provider);
  if (!apiKey) throw await preFail(new Error(`No API key for ${providers.PROVIDERS[cfg.provider]?.label ?? cfg.provider}.`));
  try {
    refsTotal = validateRun(cfg, count, extraRefs);
  } catch (e) { throw await preFail(e); }
  const est = estimateFast(cfg, refsTotal) * count;
  try {
    assertWithinLimits(est, { count });
  } catch (e) { throw await preFail(e, "limit-blocked", "blocked", est, "estimated"); }

  const refs = [...(await loadRefs(cfg.refs)), ...extraRefs];
  const common = {
    provider: cfg.provider, apiKey, model: cfg.model, prompt, refs,
    width: cfg.width, height: cfg.height, quality: cfg.quality,
    imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel, signal
  };
  const results = [];
  const t0 = performance.now();
  if (cfg.provider === "openai") {
    try {
      const r = await providers.generate({ ...common, n: count });
      const blobs = r.blobs ?? [r.blob];
      blobs.forEach((blob) => results.push({
        ok: true, blob, cost: r.cost / blobs.length, raw: r.raw, route: r.route, durationMs: performance.now() - t0
      }));
      for (let i = blobs.length; i < count; i++) results.push({ ok: false, error: "The API returned fewer images than requested." });
    } catch (e) {
      for (let i = 0; i < count; i++) results.push({ ok: false, error: e?.message ?? String(e), durationMs: performance.now() - t0 });
    }
  } else {
    const rs = await pool(count, FAST_CONCURRENCY, async () => {
      const s = performance.now();
      const r = await providers.generate(common);
      return { blob: r.blob, cost: r.cost, raw: r.raw, route: r.route, durationMs: performance.now() - s };
    });
    results.push(...rs);
  }

  const candidates = [], failed = [];
  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const vbase = { ...base, ts, itemId: count > 1 ? `v${i + 1}/${count}` : undefined };
    if (r.ok) {
      const entry = await logCall({
        ...vbase, status: "ok", durationMs: r.durationMs, route: r.route, cost: r.cost, costKind: "actual",
        // tokeny OpenAI dotyczą całego żądania (n obrazów): tylko przy pojedynczej wersji
        tokens: cfg.provider === "openai" && count > 1 ? undefined : tokensFrom(r.raw) ?? undefined
      });
      total += r.cost;
      candidates.push({ index: i, blob: r.blob, cost: r.cost, logId: entry?.id });
    } else {
      await logCall({ ...vbase, status: "error", durationMs: r.durationMs ?? performance.now() - t0, cost: 0, costKind: "actual", error: r.error });
      failed.push({ index: i, error: r.error });
    }
  }
  await recordCost(total); // koszt jest realny nawet gdy zapis się nie uda
  if (!candidates.length) {
    const e = new Error(failed[0]?.error ?? "Generation failed.");
    e.aiimgLogged = true;
    throw e;
  }
  return { candidates, failed, cost: total, meta, prompt, key };
}

/** Zapisz kandydata (Blob) do folderu typu; opcjonalnie podepnij pod dokument. @returns {Promise<string>} ścieżka */
export async function commitCandidate(document, candidate, meta, { apply = true } = {}) {
  const path = await saveImageBlob(candidate.blob, meta);
  if (apply) await applyImage(document.uuid, path, FIELD);
  return path;
}

/** Fast dla jednej wersji: generuj, zapisz plik i podmień obraz dokumentu. @returns {Promise<string>} ścieżka */
export async function runFast(document, description, { signal, extraRefs = [] } = {}) {
  const res = await generateCandidates(document, description, { count: 1, extraRefs, signal });
  const cand = res.candidates[0];
  try {
    return await commitCandidate(document, cand, res.meta);
  } catch (e) {
    if (cand.logId) await updateCall(cand.logId, { status: "error", error: `After generation: ${e.message}` });
    throw e;
  }
}

/**
 * Batch: zakolejkuj `count` wersji jako N pozycji jednego zlecenia. Dla count > 1 rekord dostaje
 * `pick: true` — wyniki lądują w _candidates/<batchId>/ i czekają na wybór ("awaiting-pick").
 * @returns {Promise<object>} rekord batcha
 */
export async function runBatch(document, description, { count = 1, extraRefs = [] } = {}) {
  const { cfg, prompt, meta } = describe(document, description);
  if (!prompt.trim()) throw new Error("Empty prompt.");
  validateRun(cfg, count, extraRefs);
  const refs = [...(await loadRefs(cfg.refs)), ...extraRefs];
  const items = Array.from({ length: count }, (_, i) => ({
    id: foundry.utils.randomID(),
    prompt, refs, width: cfg.width, height: cfg.height, quality: cfg.quality,
    imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel,
    target: { uuid: document.uuid, field: FIELD },
    meta: { ...meta, ...(count > 1 ? { variant: i + 1, variants: count } : {}) }
  }));
  return submitBatch({ provider: cfg.provider, model: cfg.model, items, pick: count > 1 });
}
