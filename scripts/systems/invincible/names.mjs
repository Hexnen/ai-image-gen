// Item names with a trailing note: "Targeted (Kingpin)", "Knowledgeable (Physics)", "Flight (wings)". PURE, no Foundry globals.
//
// One shared implementation for reader.mjs, proposal.mjs, writer.mjs, catalog.mjs and replace.mjs (analysis-1 P1-D). Before, each
// file had its own `/\s*\([^)]*\)\s*$/`: a note that itself held a parenthesis ("Kingpin (Wilson Fisk)") made the name
// "Targeted (Kingpin (Wilson Fisk))", which that pattern cannot split, so the item lost its catalogue match (`custom`).
//
// Matching = the BALANCED trailing parenthesis group. For ordinary names (no nested or unbalanced brackets) it gives exactly what
// plus-ultra's patterns give (catalog.normBase, import.mjs stateFromActor; read-only reference):
//   "Phobic (spiders)" -> "Phobic" + "spiders";  "Extra Limb(s)" -> base "Extra Limb" (normBase), but with { space: true }
//   (import.mjs power rule: the note is written with a space) it stays one name; "A (b) (c)" -> "A (b)" + "c"; "A (b))" -> no note.
// Notes written by the builder never hold parentheses (cleanNote replaces them) and are cut at a word boundary (NOTE_MAX).

export const NOTE_MAX = 60;

export const norm = (s) => String(s ?? "").replace(/­/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Index of the "(" that opens the balanced bracket group ending the (right-trimmed) name, or -1. `space: true` also needs
 * whitespace right before that "(" (plus-ultra import.mjs splits a power note only then).
 */
export function trailingGroupStart(name, { space = false } = {}) {
  const s = String(name ?? "").replace(/\s+$/, "");
  if (!s.endsWith(")")) return -1;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) {
        if (space && !(i > 0 && /\s/.test(s[i - 1]))) return -1;
        return i;
      }
    }
  }
  return -1;
}

/** "Name (note)" -> { base: "Name", note: "note" } (note "" when there is none; base keeps the name's own text) */
export function splitNote(name, opts = {}) {
  const s = String(name ?? "").replace(/\s+$/, "");
  const i = trailingGroupStart(s, opts);
  if (i < 0) return { base: String(name ?? "").trim(), note: "" };
  return { base: s.slice(0, i).trim(), note: s.slice(i + 1, -1).trim() };
}
export const baseName = (name) => splitNote(name).base;
export const noteOf = (name) => splitNote(name).note;
export const normBase = (name) => norm(baseName(name));

/** cut at a word boundary to at most `max` characters (no "..." added; the full text stays in the warning) */
export function cutAtWord(text, max = NOTE_MAX) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const sp = head.search(/\s\S*$/);
  const cut = sp >= Math.floor(max / 2) ? head.slice(0, sp) : s.slice(0, max);
  return cut.replace(/[\s,;:.\-–—/]+$/, "").trim();
}

/**
 * A note as the builder writes it: parentheses replaced ("Kingpin (Wilson Fisk)" -> "Kingpin, Wilson Fisk"), whitespace
 * collapsed, cut at a word boundary to `max`. -> { note, parens (brackets were replaced), cut (it was shortened), full }
 */
export function cleanNote(note, max = NOTE_MAX) {
  const raw = String(note ?? "").replace(/\s+/g, " ").trim();
  const parens = /[()]/.test(raw);
  const full = parens
    ? raw.replace(/\s*\(\s*/g, ", ").replace(/\s*\)\s*/g, " ").replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "")
    : raw;
  const out = cutAtWord(full, max);
  return { note: out, parens, cut: out.length < full.length, full };
}

/** base name + cleaned note in brackets ("" note -> the base name alone) */
export function withNote(name, note, max = NOTE_MAX) {
  const n = cleanNote(note, max).note;
  return n ? `${baseName(name)} (${n})` : baseName(name);
}
