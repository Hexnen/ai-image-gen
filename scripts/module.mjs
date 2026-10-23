import { MODULE_ID } from "./constants.mjs";
import { registerSettings, getKey } from "./settings.mjs";
import * as limits from "./limits.mjs";
import * as providers from "./providers/index.mjs";
import * as imageTypes from "./image-types.mjs";
import * as configStore from "./config-store.mjs";
import * as batch from "./batch/index.mjs";
import { ImageConfigApp } from "./config-app.mjs";
import { BatchesApp } from "./batch-app.mjs";
import { LogApp } from "./log-app.mjs";
import * as callLog from "./call-log.mjs";
import { GenerateDialog } from "./generate-dialog.mjs";
import { registerSheetButtons } from "./sheet-button.mjs";

Hooks.once("init", () => {
  registerSettings();
  registerSheetButtons();
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    providers, limits, getKey, imageTypes, configStore, batch, callLog,
    openConfig: () => ImageConfigApp.open(),
    openBatches: () => BatchesApp.open(),
    openLog: () => LogApp.open(),
    generate: (document) => GenerateDialog.open(document)
  };
  if (game.user.isGM) {
    callLog.initLog();
    batch.startPoller();
  }
  console.log(`${MODULE_ID} | ready`);
});

// Left-hand toolbar buttons (GM only). v14: controls is a record keyed by control name.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const group = controls.tokens;
  if (!group) return;
  const add = (id, title, icon, open) => {
    group.tools[`${MODULE_ID}-${id}`] = {
      name: `${MODULE_ID}-${id}`,
      title,
      icon,
      order: Object.keys(group.tools).length,
      button: true,
      visible: true,
      onChange: open
    };
  };
  add("config", "AIIMG.Controls.Open", "fa-solid fa-wand-magic-sparkles", () => ImageConfigApp.open());
  add("batches", "AIIMG.Controls.Batches", "fa-solid fa-layer-group", () => BatchesApp.open());
  add("log", "AIIMG.Controls.Log", "fa-solid fa-clipboard-list", () => LogApp.open());
});
