// W6-C: the character biography the builder writes (owner 2026-11-18: "niech też pisze 2 akapitowe bio"). PURE: no Foundry globals.
//
// Stored where the system keeps it: the actor's `system.biography` (an HTML field; superhero and npc models). The model writes
// plain text in `texts.biography` (updateActor set / replace proposal); the writer turns it into escaped <p> paragraphs (one per
// non-empty line, writer.mjs toParagraphs), so "paragraph" here means the same: a non-empty line of the plain text.
// Checks (validate.mjs): bio.missing (a replace / a build without one), bio.paragraphs (written with != BIO_PARAGRAPHS),
// bio.copied (a run of COPY_WORDS words found in a catalogue entry's own text: no rulebook prose in a bio).

import { plainText } from "./reader.mjs";
import { htmlToText } from "./catalog.mjs";

export const BIO_PARAGRAPHS = 2;
/** a run of this many consecutive words shared with a catalogue text counts as copied */
export const COPY_WORDS = 10;
const ZW = /[​-‍﻿]/g;   // the writer's defuse() inserts U+200B into enricher-like text

/** plain bio text -> its paragraphs (non-empty lines, trimmed) */
export const bioParagraphs = (text) => String(text ?? "").replace(/\r/g, "").split(/\n+/).map((p) => p.trim()).filter(Boolean);
/** stored HTML -> one comparable line (for an emptiness check plain text works too) */
export const bioFlat = (html) => plainText(String(html ?? "").replace(ZW, ""));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** plain bio text -> the HTML shape the writer stores (escaped <p> per paragraph, without the writer's defuse) */
export const bioHtml = (text) => bioParagraphs(text).map((p) => `<p>${esc(p)}</p>`).join("");
/** the stored biography (HTML) and a plain text the model wrote say the same */
export const sameBio = (stored, text) => bioFlat(stored) === bioFlat(bioHtml(text));

const words = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const shingles = new WeakMap();   // catalog -> Set of COPY_WORDS-word runs of its entries' own texts
function catalogRuns(catalog) {
  if (!catalog || typeof catalog !== "object") return new Set();
  let set = shingles.get(catalog);
  if (set) return set;
  set = new Set();
  for (const e of Array.isArray(catalog.entries) ? catalog.entries : []) {
    const w = words(htmlToText(e?.html ?? ""));
    for (let i = 0; i + COPY_WORDS <= w.length; i++) set.add(w.slice(i, i + COPY_WORDS).join(" "));
  }
  shingles.set(catalog, set);
  return set;
}
/** -> the first copied run of COPY_WORDS words ("" = none) */
export function copiedRun(text, catalog) {
  const w = words(text);
  if (w.length < COPY_WORDS) return "";
  const set = catalogRuns(catalog);
  if (!set.size) return "";
  for (let i = 0; i + COPY_WORDS <= w.length; i++) { const run = w.slice(i, i + COPY_WORDS).join(" "); if (set.has(run)) return run; }
  return "";
}
