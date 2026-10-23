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
import { openPickForBatch } from "./pick-app.mjs";
import { runMigrations } from "./migrate.mjs";

/** GM-owe powiadomienie: batch z wieloma wersjami czeka na wybór (klik w powiadomienie otwiera okno). */
function notifyPick(rec) {
  // Nazwę dokumentu może zmienić gracz-właściciel: do powiadomienia (HTML) tylko po escape.
  const name = foundry.utils.escapeHTML(String(rec.items?.[0]?.meta?.name ?? ""));
  const n = ui.notifications.info(game.i18n.format("AIIMG.Pick.Ready", { name }), { permanent: true, console: false });
  try { n?.element?.addEventListener?.("click", () => openPickForBatch(rec.id)); } catch { /* best effort */ }
}

Hooks.once("init", () => {
  registerSettings();
  registerSheetButtons();
});

Hooks.once("ready", async () => {
  const api = {
    providers, limits, getKey, imageTypes, configStore,
    openConfig: () => ImageConfigApp.open(),
    openBatches: () => BatchesApp.open(),
    openLog: () => LogApp.open(),
    generate: (document) => GenerateDialog.open(document),
    openPick: (batchId) => openPickForBatch(batchId)
  };
  // Log (prompty, koszty) i silnik batcha tylko dla GM-a: gracz nie ma ich ani przez API modułu.
  if (game.user.isGM) Object.assign(api, { batch, callLog });
  game.modules.get(MODULE_ID).api = api;
  if (game.user.isGM) {
    try { await runMigrations(); }
    catch (e) { console.error(`${MODULE_ID} | migration failed (will retry next start)`, e); }
    callLog.initLog();
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
  if (!game.user.isGM) return;
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
