/** Config key for macros: macros are system-independent. */
export const MACRO_KEY = "core.Macro";

const DOCS = ["Actor", "Item"];

/**
 * Types added by other modules (in memory only: the owner registers them at every start).
 * key: "<owner-id>.<name>" (must not look like a document key), group: its own filter in the config window.
 */
const VIRTUAL = new Map();
const RESERVED_GROUPS = ["all", "actor", "item", "macro"];
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {object} t
 * @param {string} t.key            e.g. "sketch-reveal.painted"
 * @param {string} t.label          display name (plain text or a localization key)
 * @param {string} t.group          config-window group name (plain text or a localization key)
 * @param {string} [t.owner]        module id of the registrant (shown in the log)
 * @param {boolean} [t.requiresRef] generation needs at least one reference image (editing prompts)
 * @param {object} [t.defaults]     starting configuration (promptTemplate, width, height, refs, quality, provider, model,
 *                                  output:{maxEdge,format,quality}) used until the GM saves one
 */
export function registerImageType({ key, label, group, owner = "", requiresRef = false, defaults = {} } = {}) {
  if (!KEY_RE.test(String(key ?? ""))) throw new Error(`Invalid image type key: ${key}`);
  if (!label || !group) throw new Error("An image type needs a label and a group.");
  // "all" and the document groups are the built-in filter chips: a same-named group would duplicate a chip (and break "all").
  if (RESERVED_GROUPS.includes(loc(String(group)).trim().toLowerCase()) || RESERVED_GROUPS.includes(String(group).trim().toLowerCase())) {
    throw new Error(`"${group}" is a reserved group name (all, Actor, Item, Macro).`);
  }
  const system = key.split(".")[0];
  if (system === game.system?.id || system === "core") throw new Error(`Image type key "${key}" would collide with a document type.`);
  VIRTUAL.set(key, { key, label: String(label), group: String(group), owner: String(owner), requiresRef: !!requiresRef, defaults: foundry.utils.deepClone(defaults) });
  return key;
}

export function unregisterImageType(key) {
  return VIRTUAL.delete(key);
}

export const isVirtualType = (key) => VIRTUAL.has(key);
export const getVirtualType = (key) => VIRTUAL.get(key) ?? null;
const loc = (s) => (game.i18n?.has?.(s) ? game.i18n.localize(s) : s);

/** Groups of registered types, in registration order (labels localized). */
export function virtualGroups() {
  return [...new Set([...VIRTUAL.values()].map((t) => loc(t.group)))];
}

/** Starting configuration of a registered type, flattened to config-store field names (or null). */
export function virtualDefaults(key) {
  const d = VIRTUAL.get(key)?.defaults;
  if (!d) return null;
  const { output, ...rest } = d;
  const out = { ...rest };
  if (output) {
    if (output.maxEdge !== undefined) out.outMaxEdge = output.maxEdge;
    if (output.format !== undefined) out.outFormat = output.format;
    if (output.quality !== undefined) out.outQuality = output.quality;
  }
  return out;
}

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
  for (const t of VIRTUAL.values()) {
    out.push({ key: t.key, documentName: null, type: null, label: loc(t.label), group: loc(t.group), virtual: true, owner: t.owner });
  }
  return out;
}

/** Config key for a document (Actor, Item, Macro). Returns null for unsupported documents. */
export function resolveTypeKey(document) {
  const doc = document?.documentName;
  if (doc === "Macro") return MACRO_KEY;
  if (!DOCS.includes(doc)) return null;
  return `${game.system.id}.${doc}.${document.type}`;
}
