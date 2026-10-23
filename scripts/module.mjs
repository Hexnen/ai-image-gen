import { MODULE_ID } from "./constants.mjs";
import { registerSettings, getKey } from "./settings.mjs";
import * as limits from "./limits.mjs";
import * as providers from "./providers/index.mjs";
import * as imageTypes from "./image-types.mjs";
import * as configStore from "./config-store.mjs";
import { ImageConfigApp } from "./config-app.mjs";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    providers, limits, getKey, imageTypes, configStore,
    openConfig: () => ImageConfigApp.open()
  };
  console.log(`${MODULE_ID} | ready`);
});

// Left-hand toolbar button (GM only). v14: controls is a record keyed by control name.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const group = controls.tokens;
  if (!group) return;
  group.tools[`${MODULE_ID}-config`] = {
    name: `${MODULE_ID}-config`,
    title: "AIIMG.Controls.Open",
    icon: "fa-solid fa-wand-magic-sparkles",
    order: Object.keys(group.tools).length,
    button: true,
    visible: true,
    onChange: () => ImageConfigApp.open()
  };
});
