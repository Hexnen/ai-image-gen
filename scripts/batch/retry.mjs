// W6-K: ponowienie ZAPISU wyników batcha, które zostały wygenerowane (i opłacone), ale nie dały się zapisać/podpiąć.
// Tylko odczyt u dostawcy (status batcha + pobranie pliku wyników): nic nie jest generowane ani naliczane drugi raz.
// Koszt NIE jest księgowany ponownie (recordCost został policzony przy pierwszym ingeście).
import { getKey } from "../settings.mjs";
import { requireUsableKey } from "../key-check.mjs";
import { b64ToBlob } from "../providers/util.mjs";
import { redact } from "../redact.mjs";
import { logBatchResult, logCall } from "../call-log.mjs";
import { statsPatch } from "../optimize.mjs";
import { getBatch, patchBatch, TERMINAL, leaseOwnerId, tuning } from "./record.mjs";
import { applyBatchItem } from "./apply.mjs";
import { openaiRetryRows, deleteOpenAIFiles } from "./openai.mjs";
import { geminiRetryRows } from "./gemini.mjs";

const ROWS = { openai: openaiRetryRows, gemini: geminiRetryRows };
/** Czas blokady ponowienia w rekordzie (dwóch MG / dwie karty nie ponawiają naraz). */
export const RETRY_LOCK_MS = 3 * 60 * 1000;
const running = new Set();

/**
 * Wpis `failed`, którego obraz istnieje u dostawcy, a zawiódł tylko zapis. Nowe wpisy mają `retry: true`;
 * rekordy sprzed W6-K rozpoznajemy po treści błędu zapisu (np. "Upload failed ... (gave up after 3 attempts)").
 */
export const isRetryableFailure = (f) => !!f && f.retry !== false &&
  (f.retry === true || f.stage === "save" || /Upload failed|gave up after \d+ attempts/i.test(String(f.error ?? "")));

export const retryableItems = (rec) => (rec?.failed ?? []).filter(isRetryableFailure);

const isGone = (e) => e?.status === 404 || e?.status === 410;

/**
 * Ponów zapis opłaconych wyników batcha.
 * @param {string} batchId
 * @param {{apiKey?:string, apply?:boolean}} [opts] apply=false: tylko zapisz plik, nie podmieniaj obrazu dokumentu
 * @returns {Promise<{saved:string[], failed:{id:string,error:string}[], gone:string[], record:object|null}>}
 */
export async function retryBatchSave(batchId, { apiKey, apply = true } = {}) {
  if (!game.user?.isGM) throw new Error("Only a GM can retry saving batch results.");
  const rec = getBatch(batchId);
  if (!rec) throw new Error(`Batch ${batchId} not found.`);
  if (!TERMINAL.includes(rec.status) && rec.status !== "awaiting-pick") throw new Error(`Batch ${batchId} is still ${rec.status}; wait until it finishes.`);
  const todo = retryableItems(rec);
  if (!todo.length) return { saved: [], failed: [], gone: [], record: rec };
  if (!rec.remoteId) throw new Error(`Batch ${batchId} has no provider id; nothing to download.`);
  const rows = ROWS[rec.provider];
  if (!rows) throw new Error(`Provider "${rec.provider}" has no batch results to download.`);
  const key = apiKey ?? requireUsableKey(getKey(rec.provider));
  if (!key) throw new Error(`No ${rec.provider} API key on this client.`);
  if (running.has(batchId)) throw new Error(`Retry of batch ${batchId} is already running.`);
  running.add(batchId);   // synchronously, before any await: a second click/call on this client is refused
  try {
    return await retryLocked(batchId, rec, key, apply);
  } finally {
    running.delete(batchId);
  }
}

async function retryLocked(batchId, rec, key, apply) {
  const rows = ROWS[rec.provider];
  // Blokada w rekordzie: zapis tylko, gdy nikt inny jej nie trzyma (patchBatch jest seryjny na tym kliencie).
  const me = leaseOwnerId();
  if (rec.retrying && rec.retrying.owner !== me && rec.retrying.until > Date.now()) {
    throw new Error(`Another client is retrying batch ${batchId}; try again in a few minutes.`);
  }
  const locked = await patchBatch(batchId, { retrying: { owner: me, until: Date.now() + RETRY_LOCK_MS } }, {});
  if (!locked) throw new Error(`Batch ${batchId} not found.`);
  try {
    // Drugi klient mógł zapisać blokadę równolegle: poczekaj, aż jego zapis dotrze, i sprawdź, kto wygrał.
    if (tuning.verifyMs) await new Promise((r) => setTimeout(r, tuning.verifyMs));
    const cur = getBatch(batchId);
    if (cur?.retrying?.owner !== me) throw new Error(`Another client is retrying batch ${batchId}.`);
    const want = new Map(retryableItems(cur).map((f) => [f.id, f]));
    const byId = new Map(cur.items.map((i) => [i.id, i]));
    const saved = [], failed = [], gone = [], paths = {};
    const candidates = [...(cur.candidates ?? [])];
    let goneWhy = "";
    try {
      for await (const row of rows(key, cur)) {
        const f = want.get(row.id);
        const item = byId.get(row.id);
        if (!f || !item) continue;
        want.delete(row.id);
        if (row.error || !row.b64) { failed.push({ id: row.id, error: row.error || "No image in the batch output", final: true }); continue; }
        const blob = b64ToBlob(row.b64, row.mime || "image/png");
        // `path`: plik zapisany w poprzedniej próbie (zawiodło tylko podpięcie) -> nie wgrywamy drugi raz
        const r = apply || cur.pick
          ? await applyBatchItem(item, blob, cur, f.path)
          : await applyBatchItem(item, blob, { ...cur, pick: true, id: `${cur.id}-recovered` }, f.path);
        if (!r.ok) { failed.push({ id: row.id, error: r.error, reason: r.reason, path: r.path, final: !!r.permanent }); continue; }
        saved.push(row.id);
        paths[row.id] = r.path;
        if (r.candidate && apply) candidates.push({ id: row.id, path: r.path, cost: f.cost ?? row.cost ?? 0 });
        await logRecovered(cur, row, f, r);
      }
    } catch (e) {
      if (!isGone(e)) throw e;
      goneWhy = `Result no longer available at ${cur.provider} (${redact(String(e.message ?? e))}); it cannot be recovered.`;
    }
    for (const id of want.keys()) {
      gone.push(id);
      failed.push({ id, error: goneWhy || "Not found in the provider's batch output.", final: true });
    }

    // Stan rekordu: udane znikają z `failed`, reszta z prawdziwym błędem; `retry` zostaje tylko dla możliwych do ponowienia.
    const fresh = getBatch(batchId) ?? cur;
    const failById = new Map(failed.map((f) => [f.id, f]));
    const nextFailed = (fresh.failed ?? []).filter((f) => !saved.includes(f.id)).map((f) => {
      const nf = failById.get(f.id);
      if (!nf) return f;
      return { ...f, error: redact(nf.error), stage: "save", retry: !nf.final, ...(nf.path ? { path: nf.path } : {}),
        ...(nf.reason ? { reason: nf.reason } : {}), lastRetryAt: Date.now() };
    });
    const retryable = nextFailed.filter(isRetryableFailure).length;
    const patch = {
      failed: nextFailed,
      applied: (fresh.applied ?? 0) + (apply && !cur.pick ? saved.length : 0),
      retryable: retryable || undefined,
      retrying: undefined,
      lastRetry: { at: Date.now(), saved: saved.length, failed: failed.length },
    };
    if (cur.pick && candidates.length) { patch.candidates = candidates; patch.status = "awaiting-pick"; }
    if (!apply && saved.length) patch.recovered = [...(fresh.recovered ?? []), ...saved.map((id) => ({ id, path: paths[id] }))];
    const record = await patchBatch(batchId, patch);
    // Nic już nie czeka na ponowienie: plik wyników u OpenAI może zniknąć (prywatność, jak po zwykłym ingeście).
    if (!retryable && cur.provider === "openai" && cur.remote?.outputFileId) {
      await deleteOpenAIFiles(key, [cur.remote.outputFileId, cur.remote.errorFileId]);
    }
    return { saved, paths, failed: failed.map(({ id, error }) => ({ id, error })), gone, record };
  } finally {
    const c = getBatch(batchId);
    if (c?.retrying?.owner === me) await patchBatch(batchId, { retrying: undefined }).catch(() => {});
  }
}

/** Wpis w logu: pierwszy batch-result (z prawdziwym kosztem), jeśli go nie ma; inaczej "batch-retry" z kosztem 0. */
async function logRecovered(rec, row, f, r) {
  const first = await logBatchResult(rec, row.id, { ok: true, cost: f.cost ?? row.cost ?? 0, tokens: row.tokens, ...statsPatch(r.stats) });
  if (first) return;
  const item = rec.items?.find((i) => i.id === row.id);
  await logCall({
    kind: "batch-retry", status: "ok", provider: rec.provider, model: rec.model, route: rec.endpoint,
    cost: 0, costKind: "actual", batchId: rec.id, itemId: row.id,
    docUuid: item?.target?.uuid, docName: item?.meta?.name, typeKey: item?.meta?.typeKey,
  });
}
