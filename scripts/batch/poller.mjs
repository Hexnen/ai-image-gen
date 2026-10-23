// Odpytywanie batchy: tylko aktywny GM, co 5 min i na starcie, tylko rekordy aktywne.
import { getKey } from "../settings.mjs";
import { listBatches, getBatch, patchBatch, isActive } from "./record.mjs";
import { checkOpenAI, cancelOpenAI } from "./openai.mjs";
import { checkGemini, cancelGemini } from "./gemini.mjs";

export const CHECK_EVERY_MS = 5 * 60 * 1000;
let timer = null;
let running = false;

const IMPL = {
  openai: { check: checkOpenAI, cancel: cancelOpenAI },
  gemini: { check: checkGemini, cancel: cancelGemini },
};

/** Tylko jeden klient (aktywny GM) ingestuje, żeby nie dublować plików. */
const isActingGM = () => game.user?.isGM && (!game.users.activeGM || game.users.activeGM.id === game.user.id);

export async function checkBatches({ force = false } = {}) {
  if (running || (!force && !isActingGM())) return;
  running = true;
  try {
    for (const rec of listBatches().filter(isActive)) {
      const impl = IMPL[rec.provider];
      const apiKey = getKey(rec.provider);
      if (!impl || !apiKey) continue;
      try {
        await impl.check(apiKey, rec);
      } catch (e) {
        console.warn(`ai-image-gen | batch ${rec.id} check failed (will retry)`, e);
      }
    }
  } finally {
    running = false;
  }
}

export function startPoller() {
  if (timer || !game.user?.isGM) return;
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
  const apiKey = getKey(rec.provider);
  if (!impl || !apiKey) throw new Error(`Brak klucza API dla ${rec.provider}`);
  await impl.cancel(apiKey, rec);
  const saved = await patchBatch(id, { status: "cancelling" }, { onlyActive: true });
  checkBatches({ force: true });
  return saved;
}
