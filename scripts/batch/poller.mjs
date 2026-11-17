// Odpytywanie batchy: każdy GM mający klucz API sprawdza status (to tylko GET); ingest wyników
// wymaga dzierżawy w rekordzie (record.mjs), więc dwóch GM-ów nie dubluje plików ani kosztu.
// Dawniej ingestował tylko „aktywny GM" — jeśli on nie miał klucza, nikt nie przetwarzał wyników.
import { getKey } from "../settings.mjs";
import { listBatches, getBatch, patchBatch, isActive, pruneBatches } from "./record.mjs";
import { checkOpenAI, cancelOpenAI } from "./openai.mjs";
import { checkGemini, cancelGemini } from "./gemini.mjs";

export const CHECK_EVERY_MS = 5 * 60 * 1000;
/** Rekord aktywny dłużej niż to jest porzucany (OpenAI wygasza batch po 24 h, pliki Gemini po 48 h). */
export const MAX_AGE_MS = 72 * 60 * 60 * 1000;
let timer = null;
let running = false;
const warnedNoKey = new Set();

const IMPL = {
  openai: { check: checkOpenAI, cancel: cancelOpenAI },
  gemini: { check: checkGemini, cancel: cancelGemini },
};

const keyOf = (provider) => { try { return getKey(provider); } catch { return ""; } };

function warnNoKey(rec) {
  if (warnedNoKey.has(rec.provider)) return;
  warnedNoKey.add(rec.provider);
  console.warn(`moinens-ai-gen | batch ${rec.id}: no ${rec.provider} API key on this client, results are not collected here`);
  try {
    ui.notifications?.warn(game.i18n.format("AIIMG.BatchNoKey", { provider: foundry.utils.escapeHTML(String(rec.provider)) }));
  } catch { /* UI jeszcze niegotowe */ }
}

/** `force` (przycisk „Sprawdź teraz") pomija tylko czekanie na timer; ingest i tak wymaga dzierżawy. */
export async function checkBatches({ force = false } = {}) {
  if (!game.user?.isGM || running) return;
  running = true;
  try {
    for (const listed of listBatches().filter(isActive)) {
      const rec = getBatch(listed.id);          // świeży rekord (inny GM mógł go zmienić w międzyczasie)
      if (!rec || !isActive(rec)) continue;
      const impl = IMPL[rec.provider];
      if (!impl) continue;
      const apiKey = keyOf(rec.provider);
      if (!apiKey) { warnNoKey(rec); continue; }
      try {
        await impl.check(apiKey, rec);
      } catch (e) {
        console.warn(`moinens-ai-gen | batch ${rec.id} check failed (will retry)`, e);
      }
      await enforceMaxAge(rec.id);
    }
  } finally {
    running = false;
  }
}

async function enforceMaxAge(id) {
  const cur = getBatch(id);
  if (!isActive(cur) || Date.now() - (cur.createdAt ?? Date.now()) <= MAX_AGE_MS) return;
  await patchBatch(id, {
    status: "error", error: `No result after ${MAX_AGE_MS / 3_600_000} h; abandoned locally.`,
    completedAt: Date.now(), lease: undefined,
  }, { onlyActive: true });
}

export function startPoller() {
  if (timer || !game.user?.isGM) return;
  pruneBatches().catch((e) => console.warn("moinens-ai-gen | prune failed", e));
  checkBatches();
  timer = setInterval(() => checkBatches(), CHECK_EVERY_MS);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Anuluj u dostawcy. Rekord przechodzi w "cancelling"; końcowy stan ustawia kolejny check. */
export async function cancelBatch(id) {
  const rec = getBatch(id);
  if (!rec || !isActive(rec)) return rec;
  const impl = IMPL[rec.provider];
  const apiKey = keyOf(rec.provider);
  if (!impl || !apiKey) throw new Error(`Brak klucza API dla ${rec.provider}`);
  await impl.cancel(apiKey, rec);
  const saved = await patchBatch(id, { status: "cancelling" }, { onlyActive: true });
  checkBatches({ force: true });
  return saved;
}

/**
 * Porzuć rekord, który utknął (np. wyniki wygasły, klucz zmieniony): próbuje anulować u dostawcy
 * (best effort) i zamyka rekord lokalnie. Nie usuwa go z listy.
 */
export async function abandonBatch(id, reason = "Abandoned locally.") {
  const rec = getBatch(id);
  if (!rec || !(isActive(rec) || rec.status === "submitting")) return rec;
  const impl = IMPL[rec.provider];
  const apiKey = keyOf(rec.provider);
  if (impl && apiKey && rec.remoteId) { try { await impl.cancel(apiKey, rec); } catch { /* best effort */ } }
  return patchBatch(id, { status: "cancelled", error: reason, completedAt: Date.now(), ingest: undefined, lease: undefined });
}
