// Zastosowanie jednego wyniku batcha: zapis pliku + podpięcie pod dokument.
// Koszt NIE jest tu księgowany: robi to ingest.mjs dopiero po zapisaniu markera postępu
// (inaczej crash między kosztem a markerem liczył koszt drugi raz po wznowieniu).
import { saveImageBlob, applyImage } from "../save-image.mjs";

/** Katalog kandydatów batcha z wieloma wersjami (Foundry nie pozwala modułowi kasować plików). */
export const candidateDir = (batchId) => `ai-image-gen/_candidates/${batchId}`;

/** Trwały błąd: dokument docelowy już nie istnieje, ponowienie nic nie da. */
export const isPermanentApplyError = (e) => /Document not found/i.test(String(e?.message ?? e));

/**
 * @param {object} item pozycja rekordu batcha
 * @param {Blob} blob obraz
 * @param {object} [rec] rekord batcha; gdy `rec.pick`, wynik trafia do katalogu kandydatów
 *   (bez podpinania pod dokument — wybór robi użytkownik w oknie wyboru)
 * @param {string} [savedPath] ścieżka zapisana we wcześniejszej próbie (nie wgrywamy drugi raz)
 * @returns {Promise<{ok:boolean, error?:string, path?:string, candidate?:boolean, permanent?:boolean}>}
 */
export async function applyBatchItem(item, blob, rec, savedPath) {
  let path = savedPath;
  try {
    if (!path) {
      path = rec?.pick
        ? await saveImageBlob(blob, { name: item.meta?.name ?? item.id, dir: candidateDir(rec.id) })
        : await saveImageBlob(blob, {
            system: item.meta?.system,
            docType: item.meta?.docType,
            name: item.meta?.name ?? item.id,
          });
    }
    if (rec?.pick) return { ok: true, path, candidate: true };
    await applyImage(item.target.uuid, path, item.target.field ?? "img");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), path, permanent: isPermanentApplyError(e) };
  }
  return { ok: true, path };
}

/**
 * Końcowy patch rekordu po udanym ingeście. Batch z wieloma wersjami (`rec.pick`) czeka na wybór
 * ("awaiting-pick", kandydaci w `candidates`); zwykły batch od razu "done".
 */
export function finishPatch(rec, r) {
  const base = { completedAt: Date.now(), applied: r.applied, failed: r.failed, cost: r.cost, ingest: undefined, lease: undefined };
  if (rec.pick && r.candidates?.length) return { ...base, status: "awaiting-pick", candidates: r.candidates };
  return { ...base, status: "done" };
}
