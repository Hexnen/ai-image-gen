// Jednorazowe migracje danych modułu (uruchamia GM przy `ready`). Wersja schematu w ustawieniu `schema`.
//   1 -> 2: klucze typów z kropkami rozwinięte przez Foundry w zagnieżdżone obiekty -> płaskie klucze z `|`;
//           mapa `batches` -> osobne ustawienia `batch.<n>`.
import { MODULE_ID } from "./constants.mjs";
import { SCHEMA_VERSION } from "./settings.mjs";
import { getBatch, putBatch } from "./batch/record.mjs";

const isConfigLike = (v) => v && typeof v === "object" && !Array.isArray(v) && ("provider" in v || "model" in v);
const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Płaska postać mapy konfiguracji typów (czysta funkcja, do testów). */
export function flattenImageTypes(map) {
  const out = {};
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const p = [...path, k];
      if (isConfigLike(v)) out[p.join("|")] = v;
      else if (isPlain(v)) walk(v, p);
    }
  };
  walk(map, []);
  return out;
}

async function migrateImageTypeKeys() {
  const cur = game.settings.get(MODULE_ID, "imageTypes") ?? {};
  const flat = flattenImageTypes(cur);
  const same = Object.keys(flat).length === Object.keys(cur).length && Object.keys(flat).every((k) => k in cur);
  if (!same) await game.settings.set(MODULE_ID, "imageTypes", flat);
  return !same;
}

async function migrateLegacyBatches() {
  const legacy = game.settings.get(MODULE_ID, "batches") ?? {};
  const recs = Object.values(legacy).filter((r) => r?.id);
  for (const r of recs) if (!getBatch(r.id)) await putBatch(r);   // błąd (np. brak miejsca) przerywa migrację
  if (Object.keys(legacy).length) await game.settings.set(MODULE_ID, "batches", {});
  return recs.length;
}

export async function runMigrations() {
  if (!game.user?.isGM) return false;
  const cur = Number(game.settings.get(MODULE_ID, "schema")) || 0;
  if (cur >= SCHEMA_VERSION) return false;
  if (cur < 2) {
    await migrateImageTypeKeys();
    await migrateLegacyBatches();
  }
  await game.settings.set(MODULE_ID, "schema", SCHEMA_VERSION);
  return true;
}
