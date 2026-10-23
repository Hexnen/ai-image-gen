/** Config key for macros: macros are system-independent. */
export const MACRO_KEY = "core.Macro";

const DOCS = ["Actor", "Item"];

function typeLabel(doc, type) {
  const raw = CONFIG[doc]?.typeLabels?.[type];
  if (raw) return game.i18n.localize(raw);
  const guess = `TYPES.${doc}.${type}`;
  return game.i18n.has(guess) ? game.i18n.localize(guess) : type;
}

/** All image types available in the current world, as `<systemId>.<Doc>.<type>` keys. */
export function detectImageTypes() {
  const out = [];
  for (const doc of DOCS) {
    for (const type of game.documentTypes?.[doc] ?? []) {
      if (type === "base") continue;
      out.push({
        key: `${game.system.id}.${doc}.${type}`,
        documentName: doc,
        type,
        label: typeLabel(doc, type),
        group: doc
      });
    }
  }
  out.push({
    key: MACRO_KEY,
    documentName: "Macro",
    type: null,
    label: game.i18n.localize("DOCUMENT.Macro"),
    group: "Macro"
  });
  return out;
}

/** Config key for a document (Actor, Item, Macro). Returns null for unsupported documents. */
export function resolveTypeKey(document) {
  const doc = document?.documentName;
  if (doc === "Macro") return MACRO_KEY;
  if (!DOCS.includes(doc)) return null;
  return `${game.system.id}.${doc}.${document.type}`;
}
