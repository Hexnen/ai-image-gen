import { MODULE_ID, OLD_MODULE_ID } from "./constants.mjs";
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
import { initCostLearning } from "./cost-learning.mjs";
import { GenerateDialog } from "./generate-dialog.mjs";
import { registerSheetButtons } from "./sheet-button.mjs";
import { registerContextMenus } from "./context-menu.mjs";
import { openPickForBatch } from "./pick-app.mjs";
import { runMigrations } from "./migrate.mjs";
import { migrateFromAiImageGen } from "./migrate-id.mjs";
import { syncOptimizerProfile } from "./optimize.mjs";
import { generateImage, estimateGeneration } from "./api.mjs";

/**
 * The old module (id "ai-image-gen") is enabled at the same time: this one stays dormant (no API, no poller, no buttons,
 * no settings copy) so the same batch is never ingested twice and the copy is not taken from values that still change.
 * Evaluated lazily: game.modules is ready from `init` on.
 */
/**
 * This code runs, but not as "moinens-ai-gen": the server still has the package registered under the OLD id (it was
 * started before the rename and the folder was renamed or the manifest changed under it). Then the "old module" that is
 * active IS this module, so the both-active warning would tell the GM to disable the only copy. Stay idle with an
 * accurate message instead (template paths use modules/moinens-ai-gen, which the server does not serve yet).
 */
export const runningUnderOldId = () => !game.modules.get(MODULE_ID)?.active;
const oldModuleActive = () => !runningUnderOldId() && !!game.modules.get(OLD_MODULE_ID)?.active;
const dormant = () => runningUnderOldId() || oldModuleActive();

/** GM-owe powiadomienie: batch z wieloma wersjami czeka na wybór (klik w powiadomienie otwiera okno). */
function notifyPick(rec) {
  // Nazwę dokumentu może zmienić gracz-właściciel: do powiadomienia (HTML) tylko po escape.
  const name = foundry.utils.escapeHTML(String(rec.items?.[0]?.meta?.name ?? ""));
  const n = ui.notifications.info(game.i18n.format("AIIMG.Pick.Ready", { name }), { permanent: true, console: false });
  try { n?.element?.addEventListener?.("click", () => openPickForBatch(rec.id)); } catch { /* best effort */ }
}

Hooks.once("init", () => {
  if (runningUnderOldId()) return;   // nothing under the new namespace until the server knows the new id
  registerSettings();   // always: the settings must exist for the later copy and for the config window
  if (oldModuleActive()) return;
  registerSheetButtons();
  registerContextMenus();
});

Hooks.once("ready", async () => {
  if (runningUnderOldId()) {
    if (game.user.isGM) ui.notifications.warn(game.i18n.localize("AIIMG.Rename.StaleServer"), { permanent: true });
    console.warn(`${MODULE_ID} | loaded under the old id "${OLD_MODULE_ID}" (the server has not picked up the rename yet): idle until Foundry is restarted`);
    return;
  }
  if (oldModuleActive()) {
    if (game.user.isGM) ui.notifications.warn(game.i18n.localize("AIIMG.Rename.BothActive"), { permanent: true });
    console.warn(`${MODULE_ID} | "${OLD_MODULE_ID}" is still active: this module stays idle until it is disabled`);
    return;
  }
  // Every client: only what is needed to register image types (harmless; the registry lives in memory).
  const api = {
    apiVersion: 1,
    registerImageType: imageTypes.registerImageType,
    unregisterImageType: imageTypes.unregisterImageType
  };
  // Everything else (settings access, estimates, generation, log, batch engine) is GM-only: a player gets none of it.
  if (game.user.isGM) {
    Object.assign(api, {
      providers, limits, getKey, imageTypes, configStore,
      openConfig: () => ImageConfigApp.open(),
      openBatches: () => BatchesApp.open(),
      openLog: () => LogApp.open(),
      generate: (document) => GenerateDialog.open(document),
      openPick: (batchId) => openPickForBatch(batchId),
      listImageTypes: () => imageTypes.detectImageTypes(),
      estimateGeneration,
      generateImage,
      batch, callLog
    });
  }
  // Settings copied from the old id first (keys, limits, types, batch slots), then the schema migrations on the new namespace.
  if (game.user.isGM) await migrateFromAiImageGen();
  game.modules.get(MODULE_ID).api = api;
  // AI builder pack registry (spec 3.3): GM only, loaded dynamically; it imports a system pack only for the matching system, and a failure never touches image generation.
  if (game.user.isGM) import("./build/registry.mjs").then((m) => m.startBuildRegistry(api)).catch((e) => console.error(`${MODULE_ID} | AI builder registry failed to load`, e));
  if (game.user.isGM) import("./build/builder-api.mjs").then((m) => m.attachBuilder(api)).catch((e) => console.error(`${MODULE_ID} | AI builder harness failed to load`, e));
  // AI builder drawer (T7): header button on supported actor sheets + the docked drawer; GM only, idle until the pack is ready
  if (game.user.isGM) import("./build/drawer-app.mjs").then((m) => m.startDrawer(api)).catch((e) => console.error(`${MODULE_ID} | AI builder drawer failed to load`, e));
  Hooks.callAll("aiImageGen.ready", api); // hook name kept from the old id: modules that started earlier can now register their types
  // local-media-optimizer (jeśli jest): profil folderu danych ai-image-gen/ (DATA_ROOT) z naszymi domyślnymi limitami.
  syncOptimizerProfile();
  if (game.user.isGM) {
    try { await runMigrations(); }
    catch (e) { console.error(`${MODULE_ID} | migration failed (will retry next start)`, e); }
    callLog.initLog();
    initCostLearning(); // estimates learn from real costs in the log
    batch.startPoller();
    const seen = new Set();
    const announce = (rec) => {
      if (rec?.status !== "awaiting-pick" || !rec.candidates?.length || seen.has(rec.id)) return;
      seen.add(rec.id);
      notifyPick(rec);
    };
    batch.listBatches().forEach(announce); // po restarcie: przypomnij o czekających wyborach
    Hooks.on("aiImageGen.batchUpdate", announce);
  }
  console.log(`${MODULE_ID} | ready`);
});

// Left-hand toolbar buttons (GM only). v14: controls is a record keyed by control name.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM || dormant()) return;
  // Own control category (no canvas layer): the three buttons live here, not under Token Controls.
  const group = controls[MODULE_ID] = {
    name: MODULE_ID,
    order: Object.keys(controls).length,
    title: "AIIMG.Controls.Category",
    icon: "fa-solid fa-wand-magic-sparkles",
    visible: true,
    tools: {}
  };
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
