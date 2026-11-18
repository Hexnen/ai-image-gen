// Silnik batch (bez UI). Zdarzenie: Hooks.callAll("aiImageGen.batchUpdate", record).
import { getKey } from "../settings.mjs";
import { requireUsableKey } from "../key-check.mjs";
import { reserveBudget } from "../limits.mjs";
import { PROVIDERS } from "../providers/index.mjs";
import { estimateBatchCost } from "./cost.mjs";
import { estimateBatchLimit } from "../cost-learning.mjs";
import { newBatchId } from "./util.mjs";
import { normalizeError } from "../providers/util.mjs";
import { putBatch, patchBatch, removeBatch } from "./record.mjs";
import { submitOpenAI, cancelOpenAI } from "./openai.mjs";
import { submitGemini, cancelGemini } from "./gemini.mjs";
import { logCall } from "../call-log.mjs";

export { listBatches, getBatch, removeBatch, isActive, pruneBatches } from "./record.mjs";
export { checkBatches, startPoller, stopPoller, cancelBatch, abandonBatch, CHECK_EVERY_MS } from "./poller.mjs";
export { estimateBatchCost } from "./cost.mjs";

const SUBMIT = { openai: submitOpenAI, gemini: submitGemini };
const CANCEL = { openai: cancelOpenAI, gemini: cancelGemini };

/**
 * @param {object} p
 * @param {"openai"|"gemini"} p.provider
 * @param {string} p.model
 * @param {{id:string, prompt:string, refs?:Blob[], width?:number, height?:number, quality?:string,
 *          target:{uuid:string, field?:string}, meta?:{system?:string, docType?:string, name?:string}}[]} p.items
 * @returns {Promise<object>} zapisany rekord batcha
 */
export async function submitBatch({ provider, model, items, pick = false }) {
  if (!PROVIDERS[provider]?.supportsBatch || !SUBMIT[provider]) {
    throw new Error(`Provider "${provider}" nie obsługuje batcha (OpenRouter: brak Batch API).`);
  }
  if (!items?.length) throw new Error("Batch: brak itemów.");
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error("Batch: id itemów muszą być unikalne.");
  // Id pozycji są kluczami w rekordzie (ustawienie świata rozwija kropki w kluczach) i custom_id u dostawcy.
  if (items.some((i) => !/^[A-Za-z0-9_-]{1,64}$/.test(String(i.id)))) throw new Error("Batch: id itemów mogą zawierać tylko litery, cyfry, _ i -.");
  const apiKey = requireUsableKey(getKey(provider)); // W6-B: non-ASCII key -> ApiKeyError before any upload
  if (!apiKey) throw new Error(`Brak klucza API dla ${PROVIDERS[provider].label}.`);

  const estimatedCost = estimateBatchLimit(provider, model, items); // learned (with margin) when the log has real runs, else the table
  const logItems = (extra, perItemCost) => Promise.all(items.map((i) => logCall({
    provider, model, prompt: i.prompt, description: i.meta?.description,
    size: i.width && i.height ? `${i.width}x${i.height}` : undefined,
    quality: provider === "openai" ? i.quality : undefined,
    imageSize: provider === "gemini" ? i.imageSize : undefined,
    thinkingLevel: provider === "gemini" ? i.thinkingLevel : undefined,
    refsCount: i.refs?.length ?? 0,
    docUuid: i.target?.uuid, docName: i.meta?.name, typeKey: i.meta?.typeKey, itemId: i.id,
    cost: perItemCost, costKind: "estimated", ...extra
  })));
  // Rezerwacja budżetu na czas wysyłki: równoległe wysyłki widzą się nawzajem. Zwalniana po zapisie rekordu
  // (od tej chwili koszt liczy pendingBatchCost()), także przy błędzie.
  let release;
  try {
    release = reserveBudget(estimatedCost, { count: items.length, batch: true });
  } catch (e) {
    await logItems({ kind: "limit-blocked", status: "blocked", error: e.message, durationMs: 0 }, estimatedCost / items.length);
    throw e;
  }
  try {
    return await send();
  } finally {
    release();
  }

  async function send() {
    // Rekord „submitting" powstaje PRZED wywołaniem dostawcy: jeśli zapis po udanej wysyłce się nie uda
    // (rozłączenie, uprawnienia), batch nie zostaje płatnym sierotą bez śladu.
    const id = newBatchId();
    const rec = {
      id,
      provider, model,
      status: "submitting",
      createdAt: Date.now(),
      estimatedCost,
      // Blobów nie trzymamy w ustawieniach — tylko to, czego potrzebuje ingest.
      items: items.map(({ id: itemId, target, meta }) => ({ id: itemId, target: { field: "img", ...target }, meta: meta ?? {} })),
      ...(pick ? { pick: true } : {}),
    };
    await putBatch(rec);
    release(); // od teraz koszt liczy pendingBatchCost() ("submitting"): bez podwójnego liczenia w limitach

    const t0 = performance.now();
    let submitted;
    try {
      submitted = await SUBMIT[provider]({ apiKey, model, items });
    } catch (e) {
      await removeBatch(id).catch(() => {});
      const err = normalizeError(e);
      await logItems({ kind: "batch-submit", status: "error", error: err.message, durationMs: performance.now() - t0 }, 0);
      throw err;
    }
    const { remoteId, endpoint, files } = submitted;

    let saved;
    try {
      saved = await patchBatch(id, { remoteId, endpoint, status: "pending", ...(files?.length ? { files } : {}) });
      if (!saved) throw new Error("the batch record disappeared");
    } catch (e) {
      // Dostawca przyjął zlecenie, a my nie umiemy go zapisać: nie zostawiaj płatnego batcha bez nadzoru.
      let cancelled = true;
      try { await CANCEL[provider](apiKey, { remoteId }); } catch { cancelled = false; }
      await logItems({ kind: "batch-submit", status: "error", route: endpoint, batchId: id, durationMs: performance.now() - t0,
        error: `Batch ${remoteId} was created at the provider but could not be saved (${e.message}); cancel ${cancelled ? "requested" : "FAILED"}.` }, 0);
      await removeBatch(id).catch(() => {});
      throw new Error(`Batch ${remoteId} was created but could not be saved (${e.message}). ${cancelled ? "Cancellation was requested." : "Cancel it manually at the provider."}`);
    }
    await logItems({ kind: "batch-submit", status: "pending", route: endpoint, batchId: id, durationMs: performance.now() - t0 },
      estimatedCost / items.length);
    return saved;
  }
}
