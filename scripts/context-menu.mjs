// "Generate image with AI" in the Actor / Item / Macro directory context menus (GM only).
import { canGenerate } from "./sheet-button.mjs";
import { GenerateDialog } from "./generate-dialog.mjs";

const DOCS = ["Actor", "Item", "Macro"];

export function registerContextMenus() {
  for (const name of DOCS) {
    Hooks.on(`get${name}ContextOptions`, (app, entries) => { // v14 passes the directory application first
      // The same hook fires in a Compendium window of this document type (Compendium extends DocumentDirectory): look the
      // entry up in the window's own collection, never in the world one (a world copy imported with keepId shares the id,
      // so the world lookup would offer, and apply the image to, the world document from inside the compendium).
      const coll = app?.collection ?? game.collections.get(name);
      const getDocument = (li) => coll?.get?.(li.closest("[data-entry-id]")?.dataset.entryId);
      entries.push({
        label: game.i18n.localize("AIIMG.Sheet.Generate"),
        icon: "fa-solid fa-wand-magic-sparkles",
        visible: (li) => { const doc = getDocument(li); return !!doc && canGenerate(doc); },
        onClick: (event, li) => { const doc = getDocument(li); if (doc) GenerateDialog.open(doc); }
      });
    });
  }
}
