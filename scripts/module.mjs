import { MODULE_ID } from "./constants.mjs";
import { registerSettings, getKey } from "./settings.mjs";
import * as limits from "./limits.mjs";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", async () => {
  // Providers are loaded lazily so the module still boots if they are mid-edit.
  let providers = null;
  try { providers = await import("./providers/index.mjs"); }
  catch (e) { console.warn(`${MODULE_ID} | providers not available yet`, e); }
  game.modules.get(MODULE_ID).api = { providers, limits, getKey };
  console.log(`${MODULE_ID} | ready`);
});
