import { MODULE_ID, PROVIDER_IDS } from "./constants.mjs";

const { NumberField, StringField, ObjectField } = foundry.data.fields;

export function registerSettings() {
  // API keys: client scope on purpose. World-scope settings sync to every player.
  for (const p of PROVIDER_IDS) {
    game.settings.register(MODULE_ID, `apiKey.${p}`, {
      name: `AIIMG.Settings.ApiKey.${p}.Name`,
      hint: "AIIMG.Settings.ApiKey.Hint",
      scope: "client",
      config: true,
      restricted: true,
      type: new StringField({ initial: "", blank: true })
    });
  }

  const limit = (key, initial) =>
    game.settings.register(MODULE_ID, `limit.${key}`, {
      name: `AIIMG.Settings.Limit.${key}.Name`,
      hint: `AIIMG.Settings.Limit.${key}.Hint`,
      scope: "world",
      config: true,
      restricted: true,
      type: new NumberField({ initial, min: 0, nullable: false })
    });
  limit("daily", 5);          // USD per day, 0 = unlimited
  limit("monthly", 50);       // USD per month, 0 = unlimited
  limit("perRequest", 1);     // USD, max estimated cost of one request, 0 = unlimited
  limit("batchSize", 50);     // max images in one batch, 0 = unlimited

  // Hidden state.
  game.settings.register(MODULE_ID, "usage", {
    scope: "world", config: false, type: new ObjectField({ initial: {} })
  });
  game.settings.register(MODULE_ID, "imageTypes", {
    scope: "world", config: false, type: new ObjectField({ initial: {} })
  });
  game.settings.register(MODULE_ID, "batches", {
    scope: "world", config: false, type: new ObjectField({ initial: {} })
  });
}

export const getKey = (provider) => game.settings.get(MODULE_ID, `apiKey.${provider}`);
export const getLimit = (key) => game.settings.get(MODULE_ID, `limit.${key}`);
