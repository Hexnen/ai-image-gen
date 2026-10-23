// Wspólny silnik ingestu wyników batcha (OpenAI i Gemini): wznawialny, z dzierżawą, bez podwójnego
// naliczania kosztu i bez gubienia opłaconych obrazów przy błędzie przejściowym.
import { b64ToBlob } from "../providers/util.mjs";
import { redact } from "../redact.mjs";
import { recordCost } from "../limits.mjs";
import { logBatchResult } from "../call-log.mjs";
import { statsPatch } from "../optimize.mjs";
import { claimLease, releaseLease, markIngested, patchBatch } from "./record.mjs";
import { applyBatchItem, finishPatch } from "./apply.mjs";

/** Ile razy (kolejnych sprawdzeń) próbujemy zapisać obraz, zanim uznamy pozycję za nieudaną. */
export const MAX_ATTEMPTS = 3;

/** Stan ingestu odtworzony z markera zapisanego w rekordzie (wznowienie po restarcie). */
export function stateOf(rec) {
  const ing = rec.ingest ?? {};
  return {
    done: new Set(ing.ids ?? []),
    failed: [...(ing.failed ?? [])],
    cost: Number(ing.cost) || 0,
    candidates: [...(ing.candidates ?? [])],
    attempts: { ...(ing.attempts ?? {}) },
    saved: { ...(ing.saved ?? {}) },
    incomplete: false,   // są pozycje z błędem przejściowym: zostaw rekord pending, ponów w następnym ticku
    lost: false,         // straciliśmy dzierżawę albo rekord przestał być aktywny
  };
}

export function resultOf(st) {
  const failedIds = new Set(st.failed.map((f) => f.id));
  return {
    applied: [...st.done].filter((id) => !failedIds.has(id)).length,
    failed: st.failed,
    cost: st.cost,
    candidates: st.candidates,
  };
}

const persist = (rec, st) =>
  markIngested(rec.id, st.done, st.cost, st.failed, st.candidates, { attempts: st.attempts, saved: st.saved });

/** Pozycja ma ostateczny wynik: marker najpierw, koszt dopiero potem (crash = niedoliczenie, nie podwójne). */
async function settle(rec, st, id, { ok, error, cost = 0, tokens, path, candidate, stats }) {
  st.done.add(id);
  if (!ok) st.failed.push({ id, error: redact(error ?? "error") });
  else if (candidate) st.candidates.push({ id, path, cost });
  st.cost += cost;
  delete st.attempts[id];
  delete st.saved[id];
  await logBatchResult(rec, id, { ok, error, cost, tokens, ...statsPatch(stats) });
  const marked = await persist(rec, st);
  await recordCost(cost);
  return marked;
}

async function handleRow(rec, st, item, row) {
  const id = row.id;
  if (row.error || !row.b64) {
    return settle(rec, st, id, { ok: false, error: row.error || "No image in the batch response", cost: row.cost ?? 0, tokens: row.tokens });
  }
  const r = await applyBatchItem(item, b64ToBlob(row.b64, row.mime || "image/png"), rec, st.saved[id]);
  if (r.ok) return settle(rec, st, id, { ok: true, path: r.path, candidate: r.candidate, cost: row.cost ?? 0, tokens: row.tokens, stats: r.stats });
  if (r.path) st.saved[id] = r.path;
  const n = (st.attempts[id] ?? 0) + 1;
  st.attempts[id] = n;
  if (r.permanent || n >= MAX_ATTEMPTS) {
    const why = r.permanent ? r.error : `${r.error} (gave up after ${n} attempts)`;
    return settle(rec, st, id, { ok: false, error: why, cost: row.cost ?? 0, tokens: row.tokens });
  }
  st.incomplete = true;   // obraz zostaje u dostawcy; ponowimy przy następnym sprawdzeniu
  return persist(rec, st);
}

/**
 * Przetwarza znormalizowane wiersze `{id, b64?, mime?, error?, cost?, tokens?}` (async iterable).
 * @returns {Promise<ReturnType<typeof stateOf>>}
 */
export async function ingestRows(rec, rows) {
  const st = stateOf(rec);
  const byId = new Map(rec.items.map((i) => [i.id, i]));
  for await (const row of rows) {
    const item = byId.get(row.id);
    if (!item || st.done.has(row.id)) continue;
    if (!(await handleRow(rec, st, item, row))) { st.lost = true; break; }
  }
  return st;
}

/** Pozycje bez żadnego wiersza w wynikach nie mogą zniknąć po cichu: to jawne błędy „no result". */
export async function failMissing(rec, st, why = "") {
  if (st.incomplete || st.lost) return;
  for (const item of rec.items) {
    if (st.done.has(item.id)) continue;
    const ok = await settle(rec, st, item.id, { ok: false, error: `No result in the batch output${why ? ` (${why})` : ""}` });
    if (!ok) { st.lost = true; return; }
  }
}

/**
 * Zamyka rekord. terminalStatus "done": normalne zakończenie (lub awaiting-pick). Inne ("error",
 * "cancelled"): zachowuje to, co już zaksięgowano (applied/failed/cost), a batch z kandydatami czeka na wybór.
 */
export function finishBatch(cur, st, { terminalStatus = "done", error } = {}) {
  const r = resultOf(st);
  let patch;
  if (terminalStatus === "done") patch = finishPatch(cur, r);
  else if (cur.pick && r.candidates.length) patch = { ...finishPatch(cur, r), error };
  else patch = {
    status: terminalStatus, error, completedAt: Date.now(),
    applied: r.applied, failed: r.failed, cost: r.cost, ingest: undefined, lease: undefined,
  };
  return patchBatch(cur.id, patch, { onlyActive: true, leaseOwner: game.user?.id });
}

/** Wyniki wygasły u dostawcy (404/410): zakończ, zachowując postęp z markera. */
export function expireBatch(cur, message) {
  return finishBatch(cur, stateOf(cur), { terminalStatus: "error", error: message });
}

/** Wykonaj `fn(świeży rekord)` tylko, gdy ten klient zdobył dzierżawę ingestu. */
export async function withLease(id, fn) {
  const cur = await claimLease(id);
  if (!cur) return false;
  try { await fn(cur); } finally { await releaseLease(id).catch(() => {}); }
  return true;
}
