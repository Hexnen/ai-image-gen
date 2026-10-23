// Rekordy batchy w world setting `batches` (klucz = id lokalny). Zapisy serializowane.
import { MODULE_ID } from "../constants.mjs";

export const ACTIVE = ["pending", "cancelling"];
export const isActive = (r) => ACTIVE.includes(r?.status);

let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

const readAll = () => structuredClone(game.settings.get(MODULE_ID, "batches") ?? {});
const writeAll = (all) => game.settings.set(MODULE_ID, "batches", all);
const notify = (rec) => Hooks.callAll("aiImageGen.batchUpdate", rec);

export const getBatch = (id) => readAll()[id] ?? null;
export const listBatches = () =>
  Object.values(readAll()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

export function putBatch(rec) {
  return serial(async () => {
    const all = readAll();
    all[rec.id] = rec;
    await writeAll(all);
    notify(rec);
    return rec;
  });
}

export function removeBatch(id) {
  return serial(async () => {
    const all = readAll();
    if (!(id in all)) return false;
    delete all[id];
    await writeAll(all);
    return true;
  });
}

/** Scala `patch` w rekord (undefined = usuń pole). onlyActive: nie nadpisuj rekordu, który już nie jest aktywny. */
export function patchBatch(id, patch, { onlyActive = false } = {}) {
  return serial(async () => {
    const all = readAll();
    const cur = all[id];
    if (!cur) return null;
    if (onlyActive && !isActive(cur)) return cur;
    const before = cur.status;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cur[k];
      else cur[k] = v;
    }
    await writeAll(all);
    if (cur.status !== before) notify(cur);
    return cur;
  });
}

/** Marker postępu ingestu (wznowienie po restarcie nie dubluje plików ani kosztu). */
export async function markIngested(id, doneIds, cost, failed = [], candidates = []) {
  const saved = await patchBatch(id, { ingest: { ids: [...doneIds], cost, failed, candidates } }, { onlyActive: true });
  return !!saved && isActive(saved);
}
