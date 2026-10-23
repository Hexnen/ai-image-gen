// Silnik batch (bez UI). Zdarzenie: Hooks.callAll("aiImageGen.batchUpdate", record).
import { getKey } from "../settings.mjs";
import { assertWithinLimits } from "../limits.mjs";
import { PROVIDERS } from "../providers/index.mjs";
import { estimateBatchCost } from "./cost.mjs";
import { newBatchId } from "./util.mjs";
import { putBatch } from "./record.mjs";
import { submitOpenAI } from "./openai.mjs";
import { submitGemini } from "./gemini.mjs";
import { logCall } from "../call-log.mjs";

export { listBatches, getBatch, removeBatch, isActive } from "./record.mjs";
export { checkBatches, startPoller, stopPoller, cancelBatch, CHECK_EVERY_MS } from "./poller.mjs";
export { estimateBatchCost } from "./cost.mjs";

const SUBMIT = { openai: submitOpenAI, gemini: submitGemini };

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
  const apiKey = getKey(provider);
  if (!apiKey) throw new Error(`Brak klucza API dla ${PROVIDERS[provider].label}.`);

  const estimatedCost = estimateBatchCost(provider, model, items);
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
  try {
    assertWithinLimits(estimatedCost, { count: items.length, batch: true });
  } catch (e) {
    await logItems({ kind: "limit-blocked", status: "blocked", error: e.message, durationMs: 0 }, estimatedCost / items.length);
    throw e;
  }

  const t0 = performance.now();
  let submitted;
  try {
    submitted = await SUBMIT[provider]({ apiKey, model, items });
  } catch (e) {
    await logItems({ kind: "batch-submit", status: "error", error: e.message, durationMs: performance.now() - t0 }, 0);
    throw e;
  }
  const { remoteId, endpoint } = submitted;

  const rec = {
    id: newBatchId(),
    provider, model, remoteId, endpoint,
    status: "pending",
    createdAt: Date.now(),
    estimatedCost,
    // Blobów nie trzymamy w ustawieniach — tylko to, czego potrzebuje ingest.
    items: items.map(({ id, target, meta }) => ({ id, target: { field: "img", ...target }, meta: meta ?? {} })),
    ...(pick ? { pick: true } : {}),
  };
  const saved = await putBatch(rec);
  await logItems({ kind: "batch-submit", status: "pending", route: endpoint, batchId: rec.id, durationMs: performance.now() - t0 },
    estimatedCost / items.length);
  return saved;
}
