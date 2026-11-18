import { MODULE_ID, PROVIDER_IDS, MIGRATED_CLIENT, MIGRATED_WORLD } from "./constants.mjs";
import { SLOTS, slotKey } from "./batch/record.mjs";
import { syncOptimizerProfile } from "./optimize.mjs";
import { DEFAULT_MODEL as ENHANCE_DEFAULT_MODEL, DEFAULT_EFFORT as ENHANCE_DEFAULT_EFFORT, EFFORTS } from "./enhance/anthropic.mjs";
import { registerBuildSettings } from "./build/build-settings.mjs";
import { normalizeApiKey } from "./key-check.mjs";

const { NumberField, StringField, ObjectField, BooleanField } = foundry.data.fields;

/** Bieżący schemat danych modułu (migracje w migrate.mjs). */
export const SCHEMA_VERSION = 2;

export function registerSettings() {
  // API keys: client scope on purpose. World-scope settings sync to every player.
  // config: false (W5-F): v14's Configure Settings shows CLIENT settings to players too (`restricted` only matters for
  // world settings), so the keys are edited in the GM-only window of keys-app.mjs (restricted settings menu, password inputs).
  for (const p of PROVIDER_IDS) {
    game.settings.register(MODULE_ID, `apiKey.${p}`, {
      name: `AIIMG.Settings.ApiKey.${p}.Name`,
      hint: "AIIMG.Settings.ApiKey.Hint",
      scope: "client",
      config: false,
      restricted: true,
      type: new StringField({ initial: "", blank: true })
    });
  }

  // Ulepszanie opisów (Claude): osobny klucz Anthropic, też klient (nie synchronizuje się do graczy).
  game.settings.register(MODULE_ID, "apiKey.anthropic", {
    name: "AIIMG.Settings.ApiKey.anthropic.Name",
    hint: "AIIMG.Settings.ApiKey.anthropic.Hint",
    scope: "client",
    config: false,
    restricted: true,
    type: new StringField({ initial: "", blank: true })
  });
  game.settings.register(MODULE_ID, "enhance.model", {
    name: "AIIMG.Settings.EnhanceModel.Name",
    hint: "AIIMG.Settings.EnhanceModel.Hint",
    scope: "world",
    config: true,
    restricted: true,
    type: new StringField({ initial: ENHANCE_DEFAULT_MODEL, blank: true })
  });
  game.settings.register(MODULE_ID, "enhance.effort", {
    name: "AIIMG.Settings.EnhanceEffort.Name",
    hint: "AIIMG.Settings.EnhanceEffort.Hint",
    scope: "world",
    config: true,
    restricted: true,
    type: new StringField({
      initial: ENHANCE_DEFAULT_EFFORT,
      blank: true,
      choices: Object.fromEntries(EFFORTS.map((e) => [e, `AIIMG.Settings.EnhanceEffort.${e || "default"}`]))
    })
  });

  const limit = (key, initial) =>
    game.settings.register(MODULE_ID, `limit.${key}`, {
      name: `AIIMG.Settings.Limit.${key}.Name`,
      hint: `AIIMG.Settings.Limit.${key}.HintV2`, // 0 = brak limitu (ostrzeżenie w tekście)
      scope: "world",
      config: true,
      restricted: true,
      type: new NumberField({ initial, min: 0, nullable: false })
    });
  limit("daily", 5);          // USD per day, 0 = unlimited
  limit("monthly", 50);       // USD per month, 0 = unlimited
  limit("perRequest", 1);     // USD, max estimated cost of one request, 0 = unlimited
  limit("batchSize", 50);     // max images in one batch, 0 = unlimited
  registerBuildSettings();    // AI builder harness: model, effort, cache TTL, per-message caps, pre-warm (build/build-settings.mjs)

  // Zmniejszanie/WebP wyników przed zapisem (szczegóły per typ: sekcja „Output” w konfiguracji typu).
  game.settings.register(MODULE_ID, "optimizeImages", {
    name: "AIIMG.Settings.OptimizeImages.Name",
    hint: "AIIMG.Settings.OptimizeImages.Hint",
    scope: "world",
    config: true,
    restricted: true,
    type: new BooleanField({ initial: true }),
    onChange: () => syncOptimizerProfile()
  });

  // Hidden state.
  game.settings.register(MODULE_ID, "usage", {
    scope: "world", config: false, type: new ObjectField({ initial: {} })
  });
  game.settings.register(MODULE_ID, "imageTypes", {
    scope: "world", config: false, type: new ObjectField({ initial: {} })
  });
  // Dawna mapa wszystkich batchy: tylko do jednorazowej migracji do slotów `batch.<n>` (migrate.mjs).
  game.settings.register(MODULE_ID, "batches", {
    scope: "world", config: false, type: new ObjectField({ initial: {} })
  });
  game.settings.register(MODULE_ID, "schema", {
    scope: "world", config: false, type: new NumberField({ initial: 0, nullable: false })
  });
  // Jednorazowa kopia ustawień ze starego id "ai-image-gen" (migrate-id.mjs): flaga per przeglądarka GM-a i per świat.
  game.settings.register(MODULE_ID, MIGRATED_CLIENT, {
    scope: "client", config: false, type: new BooleanField({ initial: false })
  });
  game.settings.register(MODULE_ID, MIGRATED_WORLD, {
    scope: "world", config: false, type: new BooleanField({ initial: false })
  });
  // Jeden rekord batcha na ustawienie: zapis jednego nie nadpisuje innych. onChange odpala się na
  // każdym kliencie, więc UI (okno batchy, przypomnienie o wyborze) odświeża się też u drugiego GM-a.
  for (let i = 0; i < SLOTS; i++) {
    game.settings.register(MODULE_ID, slotKey(i), {
      scope: "world", config: false, type: new ObjectField({ initial: {} }),
      onChange: (v) => Hooks.callAll("aiImageGen.batchUpdate", v?.id ? v : { id: null, removed: true })
    });
  }
}

// W6-B: invisible characters of a pasted key (NBSP, zero-width, BOM, newline...) are stripped on every read, so a key
// saved before the keys window normalised it still works. A visible non-ASCII character stays: the request paths refuse
// it with a clear message (key-check.mjs) instead of letting fetch() throw.
export const getKey = (provider) => normalizeApiKey(game.settings.get(MODULE_ID, `apiKey.${provider}`));
export const getLimit = (key) => game.settings.get(MODULE_ID, `limit.${key}`);
