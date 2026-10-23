// "Generate image with AI" in the Actor / Item / Macro directory context menus (GM only).
import { canGenerate } from "./sheet-button.mjs";
import { GenerateDialog } from "./generate-dialog.mjs";

const DOCS = ["Actor", "Item", "Macro"];

export function registerContextMenus() {
  for (const name of DOCS) {
    Hooks.on(`get${name}ContextOptions`, (app, entries) => { // v14 passes the directory application first
      const getDocument = (li) => game.collections.get(name)?.get(li.closest("[data-entry-id]")?.dataset.entryId);
      entries.push({
        label: game.i18n.localize("AIIMG.Sheet.Generate"),
        icon: "fa-solid fa-wand-magic-sparkles",
        visible: (li) => { const doc = getDocument(li); return !!doc && canGenerate(doc); },
        onClick: (event, li) => { const doc = getDocument(li); if (doc) GenerateDialog.open(doc); }
      });
    });
  }
}
