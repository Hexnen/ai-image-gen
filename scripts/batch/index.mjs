// Silnik batch (bez UI). Zdarzenie: Hooks.callAll("aiImageGen.batchUpdate", record).
import { getKey } from "../settings.mjs";
import { assertWithinLimits } from "../limits.mjs";
import { PROVIDERS } from "../providers/index.mjs";
import { estimateBatchCost } from "./cost.mjs";
import { newBatchId } from "./util.mjs";
import { putBatch } from "./record.mjs";
import { submitOpenAI } from "./openai.mjs";
import { submitGemini } from "./gemini.mjs";

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
export async function submitBatch({ provider, model, items }) {
  if (!PROVIDERS[provider]?.supportsBatch || !SUBMIT[provider]) {
    throw new Error(`Provider "${provider}" nie obsługuje batcha (OpenRouter: brak Batch API).`);
  }
  if (!items?.length) throw new Error("Batch: brak itemów.");
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error("Batch: id itemów muszą być unikalne.");
  const apiKey = getKey(provider);
  if (!apiKey) throw new Error(`Brak klucza API dla ${PROVIDERS[provider].label}.`);

  const estimatedCost = estimateBatchCost(provider, model, items);
  assertWithinLimits(estimatedCost, { count: items.length, batch: true });

  const { remoteId, endpoint } = await SUBMIT[provider]({ apiKey, model, items });

  const rec = {
    id: newBatchId(),
    provider, model, remoteId, endpoint,
    status: "pending",
    createdAt: Date.now(),
    estimatedCost,
    // Blobów nie trzymamy w ustawieniach — tylko to, czego potrzebuje ingest.
    items: items.map(({ id, target, meta }) => ({ id, target: { field: "img", ...target }, meta: meta ?? {} })),
  };
  return putBatch(rec);
}
