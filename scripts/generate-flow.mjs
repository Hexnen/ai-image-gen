// Logika generacji dla jednego dokumentu (Fast i Batch), bez UI.
import { getKey } from "./settings.mjs";
import { resolveTypeKey } from "./image-types.mjs";
import { getConfig, isConfigured, renderPrompt, fitConfig, DEFAULT_CONFIG } from "./config-store.mjs";
import * as providers from "./providers/index.mjs";
import { reserveBudget, recordCost } from "./limits.mjs";
import { saveImageBlobEx, applyImage } from "./save-image.mjs";
import { submitBatch } from "./batch/index.mjs";
import { estimateSyncCost, estimateBatchCost } from "./batch/cost.mjs";
import { lookupLearned, learnedLimit } from "./cost-learning.mjs";
import { logCall, updateCall, tokensFrom } from "./call-log.mjs";
import { outputOptsFromConfig, statsPatch } from "./optimize.mjs";
import { prepareRefs, purposeOverride, estimateSettings } from "./ref-convert.mjs";
import { outputFamily, outputTokens } from "./image-cost.mjs";

const FIELD = "img";

export const MAX_VERSIONS = 8;
export const MAX_EXTRA_REF_BYTES = 20 * 1024 * 1024;
const FAST_CONCURRENCY = 3;
/** Szacunek, gdy wyliczenie kosztu się nie uda: nie 0, bo 0 wyłącza wszystkie limity. */
const FALLBACK_ESTIMATE = 0.25;
/** Formaty referencji akceptowane przez wszystkich providerów. */
const REF_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Konwersja obrazu w innym formacie (gif/avif/bmp…) do PNG przez canvas. */
async function convertToPng(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close?.();
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

/** Format po magic bytes: "image/png|jpeg|webp", "other" (rozpoznany inny: gif/bmp/avif…) albo null (nieznany). */
async function sniffImage(blob) {
  const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (a, b) => String.fromCharCode(...h.subarray(a, b));
  if (h[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 3) === "GIF" || ascii(0, 2) === "BM" || ascii(4, 8) === "ftyp" || ascii(0, 4) === "RIFF") return "other";
  return null;
}

/**
 * Referencja musi być png/jpeg/webp WEDŁUG ZAWARTOŚCI (deklarowany typ bywa kłamliwy): inne rozpoznane
 * formaty konwertujemy do PNG przez canvas albo odrzucamy z czytelnym błędem.
 */
export async function normalizeRef(blob, label) {
  const sniffed = await sniffImage(blob);
  if (sniffed && sniffed !== "other") return blob.type === sniffed ? blob : new Blob([blob], { type: sniffed });
  if (!sniffed && REF_TYPES.includes(blob.type)) return blob; // nieznana zawartość, ale deklarowany typ jest dozwolony
  try {
    return await convertToPng(blob);
  } catch {
    throw new Error(`Reference image ${label}: unsupported format (${sniffed === "other" ? "not PNG/JPEG/WebP" : blob.type || "unknown"}). Use PNG, JPEG or WebP.`);
  }
}

/** Wczytaj obrazy referencyjne (ścieżki z konfiguracji) jako Blob-y (bez duplikatów ścieżek). */
export async function loadRefs(paths = [], signal) {
  const out = [];
  for (const p of [...new Set(paths)]) {
    const url = /^(https?:|data:|blob:)/.test(p) ? p : foundry.utils.getRoute(p);
    const res = await fetch(url, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`Reference image ${p}: HTTP ${res.status}`);
    out.push(await normalizeRef(await res.blob(), p));
  }
  return out;
}

/**
 * W6-D: zmniejsz referencje przed wysyłką (ref-convert.mjs) i policz szacunek tokenów do logu.
 * Kolejność jak w żądaniu: najpierw referencje typu (cfg.refs, nadpisania per ścieżka), potem dodatkowe (extraPurposes).
 * @returns {Promise<{refs:Blob[], estTokens:{refs?:number, out?:number}|undefined}>}
 */
export async function sendableRefs(cfg, typeRefs, extraRefs, extraPurposes = []) {
  const paths = [...new Set(cfg.refs ?? [])];
  const purposes = [...paths.map((p) => purposeOverride(cfg, p)), ...extraRefs.map((_, i) => extraPurposes[i] ?? "")];
  const r = await prepareRefs([...typeRefs, ...extraRefs], cfg, purposes);
  const fam = outputFamily(cfg.provider, cfg.model);
  const out = fam ? outputTokens(fam, cfg.quality, cfg.width, cfg.height, { tables: estimateSettings().tables }) : null;
  const est = {};
  if (r.tokens != null) est.refs = r.tokens;
  if (out != null) est.out = out;
  return { refs: r.blobs, estTokens: Object.keys(est).length ? est : undefined };
}

/**
 * Rzuca, gdy wynik nie mógłby zostać zastosowany do dokumentu — wołać PRZED płatnym wywołaniem:
 * brak UUID (niezapisany), brak uprawnienia do edycji, dokument w zablokowanym kompendium (także embedded).
 */
export function assertCanApply(doc) {
  if (!doc?.uuid) throw new Error("Save the document first: it has no UUID, so the image could not be applied.");
  if (doc.canUserModify && !doc.canUserModify(game.user, "update")) throw new Error("You do not have permission to modify this document.");
  if (doc.compendium?.locked ?? doc.parent?.compendium?.locked) throw new Error("This document is in a locked compendium.");
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

function describe(document, description, overrides = {}) {
  const key = resolveTypeKey(document);
  if (!key) throw new Error("Unsupported document.");
  // One-off overrides from the dialog (e.g. transparent background) go through fitConfig: unsupported values are dropped.
  const cfg = Object.keys(overrides ?? {}).length ? fitConfig({ ...getConfig(key), ...overrides }) : getConfig(key);
  const prompt = buildPrompt(document, description, cfg);
  const meta = {
    system: document.documentName === "Macro" ? "core" : game.system.id,
    docType: [document.documentName, document.type].filter(Boolean).join("-"),
    name: document.name ?? "image",
    typeKey: key,
    description: description.trim(),
    ...(cfg.transparent ? { transparent: true } : {})
  };
  return { key, cfg, prompt, meta };
}

/** Cautious table estimate of one image (sync = standard rates, batch = half). Never 0 on a failed calculation. */
function tableEstimate(cfg, refCount, mode) {
  const item = { refs: new Array(refCount), width: cfg.width, height: cfg.height, quality: cfg.quality, imageSize: cfg.imageSize };
  try {
    return mode === "batch" ? estimateBatchCost(cfg.provider, cfg.model, [item]) : estimateSyncCost(cfg.provider, cfg.model, [item]);
  } catch {
    return mode === "batch" ? FALLBACK_ESTIMATE / 2 : FALLBACK_ESTIMATE;
  }
}

/**
 * Cost of one image, two ways. `display`: what the UI shows (the learned median of REAL costs from the log when there
 * are enough runs, else the table). `limit`: what the budget limits and reservations use (learned median with a
 * margin, never below the dearest of the last 3 runs; else the cautious table).
 * @returns {{display:number, limit:number, source:"learned"|"table", n:number}}
 */
export function estimateInfo(cfg, refCount, mode = "sync") {
  const table = tableEstimate(cfg, refCount, mode);
  const l = lookupLearned({
    provider: cfg.provider, model: cfg.model, quality: cfg.quality, width: cfg.width, height: cfg.height,
    imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel, refsCount: refCount
  }, mode);
  if (!l) return { display: table, limit: table, source: "table", n: 0 };
  return { display: l.median, limit: learnedLimit(l), source: "learned", n: l.n };
}

/** Cost of one sync request for the LIMITS (see estimateInfo). */
export function estimateFast(cfg, refCount) {
  return estimateInfo(cfg, refCount, "sync").limit;
}

/** Cost for the UI: Fast ×count, or Batch ×count at batch rates. @returns {{cost:number, source:string, n:number}} */
export function estimateTotalInfo(document, { count = 1, extraRefs = 0, mode = "fast" } = {}) {
  const key = resolveTypeKey(document);
  if (!key) return { cost: 0, source: "table", n: 0 };
  const cfg = getConfig(key);
  const refs = (cfg.refs?.length ?? 0) + extraRefs;
  const i = estimateInfo(cfg, refs, mode === "batch" ? "batch" : "sync");
  return { cost: i.display * count, source: i.source, n: i.n };
}

/** Same, as a plain number (kept for callers that only need the amount). */
export function estimateTotal(document, opts = {}) {
  return estimateTotalInfo(document, opts).cost;
}

/** Walidacja liczby wersji i referencji (rzuca czytelny błąd). @returns {number} łączna liczba referencji */
export function validateRun(cfg, count, extraRefs) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_VERSIONS) {
    throw new Error(`Versions must be between 1 and ${MAX_VERSIONS}.`);
  }
  const total = (cfg.refs?.length ?? 0) + extraRefs.length;
  const max = maxRefsFor(cfg.provider, cfg.model);
  if (total > max) throw new Error(`Too many reference images: ${total} (max ${max} for this model).`);
  for (const b of extraRefs) {
    if (!/^image\//.test(b.type || "")) throw new Error("Extra references must be images.");
    if (!REF_TYPES.includes(b.type)) throw new Error(`Unsupported reference format (${b.type.replace("image/", "")}). Use PNG, JPEG or WebP.`);
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
    transparent: cfg.transparent || undefined,
    refsCount: refsTotal, docUuid: document.uuid, docName: document.name, typeKey: key
  };
}

/**
 * Wykonaj `count` zadań z ograniczoną współbieżnością; zadanie nigdy nie przerywa reszty.
 * Po anulowaniu (signal.aborted) kolejne zadania NIE startują i są oznaczone `skipped` (bez N błędów "Aborted").
 */
async function pool(count, limit, signal, task) {
  const out = new Array(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      if (signal?.aborted) {
        while (next < count) out[next++] = { ok: false, skipped: true, error: "Cancelled.", cost: 0, costKind: "actual" };
        return;
      }
      const i = next++;
      out[i] = await task(i).catch((e) => ({ ok: false, error: e?.message ?? String(e), cost: 0, costKind: "actual" }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return out;
}

/**
 * Opis nieudanego żądania. Koszt: rzeczywisty, jeśli provider go podał w błędzie (odpowiedź bez obrazu bywa
 * rozliczona); przy timeoucie/anulowaniu w locie serwer mógł dokończyć i naliczyć, więc księgujemy SZACUNEK.
 */
function failure(e, startMs, estShare) {
  let cost = Number(e?.cost) || 0;
  let costKind = "actual";
  if (!cost && (e?.name === "TimeoutError" || e?.name === "AbortError")) { cost = estShare; costKind = "estimated"; }
  return { ok: false, error: e?.message ?? String(e), cost, costKind, durationMs: performance.now() - startMs, cancelled: e?.name === "AbortError" };
}

/**
 * Fast: wygeneruj `count` wersji (bez zapisu na dysk). OpenAI: JEDNO żądanie z `n`; Gemini/OpenRouter:
 * `count` żądań, max 3 równolegle (błąd jednej wersji nie przerywa reszty). Log: osobny wpis na wersję;
 * przy OpenAI koszt żądania (usage całości) jest dzielony po równo na wersje. Koszt naliczany raz.
 * @returns {Promise<{candidates:{index:number, blob:Blob, cost:number, logId?:string}[],
 *   failed:{index:number, error:string}[], cost:number, meta:object, prompt:string, key:string}>}
 */
export async function generateCandidates(document, description, { count = 1, extraRefs = [], extraRefPurposes = [], signal, overrides } = {}) {
  assertCanApply(document); // zanim cokolwiek zapłacimy
  const { key, cfg, prompt, meta } = describe(document, description, overrides);
  return executeGeneration({ doc: document, description, key, cfg, prompt, meta, count, extraRefs, extraRefPurposes, signal, runKind: "fast" });
}

/** Wspólny rdzeń generacji (dokument albo próba z szuflady testu): limity, wywołanie providera, log, koszt. */
export async function executeGeneration({ doc: document, description, key, cfg, prompt, meta, count, extraRefs, extraRefPurposes = [], signal, runKind, caller }) {
  const ts = new Date().toISOString();
  let refsTotal = (cfg.refs?.length ?? 0) + extraRefs.length;
  const base = logBase(document, description, key, cfg, prompt, runKind, refsTotal);
  if (caller) base.caller = String(caller).slice(0, 64); // module that asked (API), shown in the log
  const preFail = async (e, kind = runKind, status = "error", cost = 0, costKind = "actual") => {
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
  const one = estimateFast(cfg, refsTotal);
  const est = one * count;
  // Rezerwacja: równoległe wywołania (inne okno, szuflada testu, regenerate) widzą ten szacunek, zanim koszt zostanie zaksięgowany.
  // OpenAI to JEDNO żądanie z `n` (limit na żądanie dotyczy całości); Gemini/OpenRouter to `count` osobnych żądań.
  let release;
  try {
    release = reserveBudget(est, { count, perRequest: cfg.provider === "openai" ? est : one });
  } catch (e) { throw await preFail(e, "limit-blocked", "blocked", est, "estimated"); }
  try {
    return await runGeneration({ document, description, key, cfg, prompt, meta, count, extraRefs, extraRefPurposes, signal, ts, base, est, apiKey });
  } finally {
    release();
  }
}

async function runGeneration({ document, description, key, cfg, prompt, meta, count, extraRefs, extraRefPurposes, signal, ts, base, est, apiKey }) {
  const cancelledEarly = () => Object.assign(new Error("Cancelled."), { name: "AbortError", aiimgLogged: true });
  if (signal?.aborted) throw cancelledEarly(); // nic jeszcze nie poszło do API: koszt 0, bez wpisu w logu
  const normalizedExtra = [];
  for (const [i, b] of extraRefs.entries()) normalizedExtra.push(await normalizeRef(b, `#${i + 1}`));
  let refs, estTokens;
  try {
    ({ refs, estTokens } = await sendableRefs(cfg, await loadRefs(cfg.refs, signal), normalizedExtra, extraRefPurposes));
  } catch (e) {
    if (e?.name === "AbortError") throw cancelledEarly();
    throw e;
  }
  // Anulowano podczas ładowania referencji: żądanie nie wyszło, więc nie księgujemy szacunku (jak przy timeoucie w locie).
  if (signal?.aborted) throw cancelledEarly();
  const common = {
    provider: cfg.provider, apiKey, model: cfg.model, prompt, refs,
    width: cfg.width, height: cfg.height, quality: cfg.quality, transparent: !!cfg.transparent,
    imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel, signal
  };
  const share = est / count;
  const results = [];
  const t0 = performance.now();
  if (cfg.provider === "openai") {
    try {
      const r = await providers.generate({ ...common, n: count });
      const blobs = r.blobs ?? [r.blob];
      blobs.forEach((blob) => results.push({
        ok: true, blob, cost: r.cost / blobs.length, costKind: r.costEstimated ? "estimated" : "actual",
        raw: r.raw, route: r.route, durationMs: performance.now() - t0
      }));
      for (let i = blobs.length; i < count; i++) results.push({ ok: false, error: "The API returned fewer images than requested.", cost: 0, costKind: "actual" });
    } catch (e) {
      // jedno żądanie na wszystkie wersje: ewentualny koszt (np. szacunek po timeoucie) księgujemy RAZ
      const f = failure(e, t0, est);
      for (let i = 0; i < count; i++) results.push(i === 0 ? f : { ...f, cost: 0 });
    }
  } else {
    const rs = await pool(count, FAST_CONCURRENCY, signal, async () => {
      const s = performance.now();
      try {
        const r = await providers.generate(common);
        return {
          ok: true, blob: r.blob, cost: r.cost, costKind: r.costEstimated ? "estimated" : "actual",
          raw: r.raw, route: r.route, durationMs: performance.now() - s
        };
      } catch (e) {
        return failure(e, s, share);
      }
    });
    results.push(...rs);
  }

  const candidates = [], failed = [];
  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    total += r.cost ?? 0;
    if (r.skipped) { failed.push({ index: i, error: r.error }); continue; } // anulowane przed startem: bez wpisu w logu
    const vbase = { ...base, ts, itemId: count > 1 ? `v${i + 1}/${count}` : undefined };
    if (r.ok) {
      const entry = await logCall({
        ...vbase, status: "ok", durationMs: r.durationMs, route: r.route, cost: r.cost, costKind: r.costKind,
        // tokeny OpenAI dotyczą całego żądania (n obrazów): tylko przy pojedynczej wersji
        tokens: cfg.provider === "openai" && count > 1 ? undefined : tokensFrom(r.raw) ?? undefined,
        // W6-D: szacunek (refs + wyjście jednego obrazu) obok prawdziwych tokenów; przy OpenAI n>1 refs są w całym żądaniu
        estTokens
      });
      candidates.push({ index: i, blob: r.blob, cost: r.cost, logId: entry?.id, ...(cfg.transparent ? { transparent: true } : {}) });
    } else {
      await logCall({ ...vbase, status: "error", durationMs: r.durationMs ?? performance.now() - t0, cost: r.cost ?? 0, costKind: r.costKind ?? "actual", error: r.error });
      failed.push({ index: i, error: r.error });
    }
  }
  // Koszt jest realny (albo szacowany po timeoucie) nawet gdy zapis się nie uda. Błąd księgowania (rozłączenie,
  // uprawnienia) nie może odebrać opłaconych obrazów: tylko ostrzeżenie.
  try { await recordCost(total); } catch (e) { console.warn("moinens-ai-gen | could not record cost", total, e); }
  if (!candidates.length) {
    const e = new Error(failed[0]?.error ?? "Generation failed.");
    e.aiimgLogged = true;
    if (results.every((r) => r.skipped || r.cancelled)) e.name = "AbortError";
    throw e;
  }
  return { candidates, failed, cost: total, meta, prompt, key };
}

// ---------- szuflada testu w oknie konfiguracji ----------

const testDoc = ({ name = "", type = "" } = {}) => ({ name, type, documentName: "", uuid: undefined });

/** Prompt próby: ten sam buildPrompt co przy prawdziwej generacji, z niezapisanego szkicu konfiguracji. */
export function buildTestPrompt(cfg, { description = "", name = "", type = "" } = {}) {
  return buildPrompt(testDoc({ name, type }), description, cfg);
}

/** Szkic konfiguracji → pełna konfiguracja dopasowana do możliwości modelu. */
export function fitTestConfig(draft) {
  return fitConfig({ ...DEFAULT_CONFIG, ...draft, refs: [...(draft?.refs ?? [])] });
}

/** Cost of a test run (Fast ×count) for the UI, with where the number comes from. */
export function estimateTestInfo(cfg, count = 1) {
  const i = estimateInfo(cfg, cfg.refs?.length ?? 0, "sync");
  return { cost: i.display * count, source: i.source, n: i.n };
}

/** Same, as a plain number. */
export function estimateTest(cfg, count = 1) {
  return estimateTestInfo(cfg, count).cost;
}

/**
 * Próbna generacja ze szkicu: nie dotyka żadnego dokumentu i nic nie zapisuje na dysk. Log: kind "test",
 * limity i koszt jak przy Fast. @returns jak generateCandidates (kandydaci w pamięci jako Blob).
 */
export async function generateTest(draft, key, { description = "", name = "", type = "", count = 1, signal } = {}) {
  const cfg = fitTestConfig(draft);
  const doc = testDoc({ name, type });
  const prompt = buildPrompt(doc, description, cfg);
  const meta = { system: key?.split(".")[0] ?? "core", docType: "test", name: name || "test", typeKey: key, description: description.trim() };
  return executeGeneration({ doc, description, key, cfg, prompt, meta, count, extraRefs: [], signal, runKind: "test" });
}

/** Zapisz kandydata (Blob) do folderu typu; opcjonalnie podepnij pod dokument. @returns {Promise<string>} ścieżka */
export async function commitCandidate(document, candidate, meta, { apply = true } = {}) {
  // Rozmiar/format zapisu z konfiguracji typu (sekcja Output); obraz do API jest już wysłany, to dotyczy tylko pliku.
  // Alpha travels with the image (candidate/meta), not with the saved config: a one-off override may differ from it.
  const optimize = { ...outputOptsFromConfig(meta?.typeKey ? getConfig(meta.typeKey) : {}), ...(candidate.transparent || meta?.transparent ? { alpha: true } : {}) };
  const { path, stats } = await saveImageBlobEx(candidate.blob, { ...meta, optimize, preOptimized: candidate.opt });
  candidate.saved = stats;
  if (candidate.logId) await updateCall(candidate.logId, statsPatch(stats));
  if (apply) await applyImage(document.uuid, path, FIELD);
  return path;
}

/** Fast dla jednej wersji: generuj, zapisz plik i podmień obraz dokumentu. @returns {Promise<string>} ścieżka */
export async function runFast(document, description, { signal, extraRefs = [], extraRefPurposes = [], onSaved, overrides } = {}) {
  const res = await generateCandidates(document, description, { count: 1, extraRefs, extraRefPurposes, signal, overrides });
  const cand = res.candidates[0];
  try {
    const path = await commitCandidate(document, cand, res.meta);
    onSaved?.(cand.saved);
    return path;
  } catch (e) {
    if (cand.logId) await updateCall(cand.logId, { status: "error", error: `After generation: ${e.message}` });
    // Obraz jest już opłacony: nie gubimy go, tylko oddajemy do okna wyboru (zapis można powtórzyć stamtąd).
    try {
      const { PickApp } = await import("./pick-app.mjs"); // dynamicznie: pick-app importuje ten plik
      PickApp.open({ document, candidates: [cand], meta: res.meta, source: "memory" });
      e.message += " The generated image was kept in the picker window: save it from there.";
    } catch { /* okno niedostępne: zostaje oryginalny błąd */ }
    throw e;
  }
}

/**
 * Batch: zakolejkuj `count` wersji jako N pozycji jednego zlecenia. Dla count > 1 rekord dostaje
 * `pick: true` — wyniki lądują w _candidates/<batchId>/ i czekają na wybór ("awaiting-pick").
 * @returns {Promise<object>} rekord batcha
 */
export async function runBatch(document, description, { count = 1, extraRefs = [], extraRefPurposes = [], overrides } = {}) {
  assertCanApply(document); // zanim cokolwiek zapłacimy
  const { cfg, prompt, meta } = describe(document, description, overrides);
  if (!prompt.trim()) throw new Error("Empty prompt.");
  validateRun(cfg, count, extraRefs);
  const extra = [];
  for (const [i, b] of extraRefs.entries()) extra.push(await normalizeRef(b, `#${i + 1}`));
  const { refs } = await sendableRefs(cfg, await loadRefs(cfg.refs), extra, extraRefPurposes);
  const items = Array.from({ length: count }, (_, i) => ({
    id: foundry.utils.randomID(),
    prompt, refs, width: cfg.width, height: cfg.height, quality: cfg.quality, transparent: !!cfg.transparent,
    imageSize: cfg.imageSize, thinkingLevel: cfg.thinkingLevel,
    target: { uuid: document.uuid, field: FIELD },
    meta: { ...meta, ...(count > 1 ? { variant: i + 1, variants: count } : {}) }
  }));
  return submitBatch({ provider: cfg.provider, model: cfg.model, items, pick: count > 1 });
}
