// Zastosowanie jednego wyniku batcha: zapis pliku + podpięcie pod dokument + koszt.
import { saveImageBlob, applyImage } from "../save-image.mjs";
import { recordCost } from "../limits.mjs";

/** @returns {Promise<{ok:boolean, error?:string, path?:string}>} */
export async function applyBatchItem(item, blob, cost) {
  await recordCost(cost); // koszt jest realny nawet gdy zapis się nie uda
  let path;
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
