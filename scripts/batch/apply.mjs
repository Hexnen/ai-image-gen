// Zastosowanie jednego wyniku batcha: zapis pliku + podpięcie pod dokument + koszt.
import { saveImageBlob, applyImage } from "../save-image.mjs";
import { recordCost } from "../limits.mjs";

/** Katalog kandydatów batcha z wieloma wersjami (Foundry nie pozwala modułowi kasować plików). */
export const candidateDir = (batchId) => `ai-image-gen/_candidates/${batchId}`;

/**
 * @param {object} [rec] rekord batcha; gdy `rec.pick`, wynik trafia do katalogu kandydatów
 *   (bez podpinania pod dokument — wybór robi użytkownik w oknie wyboru).
 * @returns {Promise<{ok:boolean, error?:string, path?:string, candidate?:boolean}>}
 */
export async function applyBatchItem(item, blob, cost, rec) {
  await recordCost(cost); // koszt jest realny nawet gdy zapis się nie uda
  let path;
  if (rec?.pick) {
    try {
      path = await saveImageBlob(blob, { name: item.meta?.name ?? item.id, dir: candidateDir(rec.id) });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    return { ok: true, path, candidate: true };
  }
  try {
    path = await saveImageBlob(blob, {
      system: item.meta?.system,
      docType: item.meta?.docType,
      name: item.meta?.name ?? item.id,
    });
    await applyImage(item.target.uuid, path, item.target.field ?? "img");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), path };
  }
  return { ok: true, path };
}

/**
 * Końcowy patch rekordu po udanym ingeście. Batch z wieloma wersjami (`rec.pick`) czeka na wybór
 * ("awaiting-pick", kandydaci w `candidates`); zwykły batch od razu "done".
 */
export function finishPatch(rec, r) {
  const base = { completedAt: Date.now(), applied: r.applied, failed: r.failed, cost: r.cost, ingest: undefined };
  if (rec.pick && r.candidates?.length) return { ...base, status: "awaiting-pick", candidates: r.candidates };
  return { ...base, status: "done" };
}
