// Sheet-in-context rule (spec 5.4, 6.0; task T2). PURE, system-agnostic: works on the pack's snapshot `lines`
// (Map<key, line>, spec 3.2) and never knows what a line means.
//
// Per GM message the harness asks the pack for a fresh snapshot and decides which sheet block opens the user message:
//   1. first message of a conversation                          -> full <sheet> (the pack's text as is)
//   2. nothing changed against the picture the conversation holds -> <sheet_unchanged/>
//   3. small change (<= 25 % of the fresh snapshot's lines AND <= 1,500 tokens) -> <sheet_update> (removed / added / changed lines)
//   4. otherwise, or when 8 diffs were sent since the last full sheet -> fresh full <sheet supersedes="all earlier sheet blocks">
// "The picture the conversation holds" = the last full sheet with every later diff folded in; the session stores it as
// ordered [key, line] pairs, so the decision survives a page reload. Nothing earlier in the history is ever edited.

import { estimateTokens } from "../anthropic/pricing.mjs";

export const SHEET_RULES = Object.freeze({ maxDiffShare: 0.25, maxDiffTokens: 1500, maxDiffsBeforeFull: 8 });
export const SUPERSEDES = 'supersedes="all earlier sheet blocks"';
export const UNCHANGED_BLOCK = "<sheet_unchanged/>";

/**
 * Ordered [key, line] pairs of a snapshot. Uses `snap.lines` (Map or array of pairs) when the pack provides it;
 * otherwise falls back to the text's inner lines with the line itself as key (a changed line then shows as remove + add).
 */
export function pairsOf(snap) {
  const l = snap?.lines;
  if (l instanceof Map && l.size) return [...l.entries()].map(([k, v]) => [String(k), String(v)]);
  if (Array.isArray(l) && l.length) return l.map(([k, v]) => [String(k), String(v)]);
  const rows = String(snap?.text ?? "").split(/\r?\n/).filter((s) => s.trim() && !/^\s*<\/?sheet\b/i.test(s));
  return rows.map((s) => [s, s]);
}

/** Line diff of two pair lists. -> { removed:[key], added:[[key,line]], changed:[[key,line]], size } */
export function diffPairs(held, fresh) {
  const a = new Map(held), b = new Map(fresh);
  const removed = [], added = [], changed = [];
  for (const [k] of held) if (!b.has(k)) removed.push(k);
  for (const [k, v] of fresh) {
    if (!a.has(k)) added.push([k, v]);
    else if (a.get(k) !== v) changed.push([k, v]);
  }
  return { removed, added, changed, size: removed.length + added.length + changed.length };
}

/** Fold a diff into the held picture (order: kept lines in place, new lines appended). */
export function foldPairs(held, diff) {
  const gone = new Set(diff.removed);
  const ch = new Map(diff.changed);
  const out = held.filter(([k]) => !gone.has(k)).map(([k, v]) => [k, ch.has(k) ? ch.get(k) : v]);
  return out.concat(diff.added.map(([k, v]) => [k, v]));
}

const attr = (s) => String(s ?? "").replace(/["<>\n\r]/g, "");

/** The <sheet_update> block: "- key" removed, "+ line" added, "~ line" changed (the line's new text). */
export function renderUpdate(diff, { doc = "", fingerprint = "" } = {}) {
  const head = `<sheet_update${doc ? ` doc="${attr(doc)}"` : ""}${fingerprint ? ` fp=${attr(fingerprint)}` : ""} changes=${diff.size}>`;
  const rows = [
    ...diff.removed.map((k) => `- ${k}`),
    ...diff.added.map(([, v]) => `+ ${v}`),
    ...diff.changed.map(([, v]) => `~ ${v}`)
  ];
  return [head, ...rows, "</sheet_update>"].join("\n");
}

/** Mark a later full block as replacing all earlier ones (attribute added to the opening <sheet tag). */
export function markSupersedes(text) {
  const s = String(text ?? "");
  if (s.includes(SUPERSEDES)) return s;
  return /^\s*<sheet\b/i.test(s) ? s.replace(/<sheet\b/i, `<sheet ${SUPERSEDES}`) : `<sheet ${SUPERSEDES}>\n${s}\n</sheet>`;
}

/**
 * Decide the sheet block for the next GM message.
 * @param held   null (new conversation) | { pairs, diffsSinceFull, fulls }   (session.record.sheet)
 * @param snap   the pack's fresh snapshot { text, fingerprint, lines, tokensEst }
 * @returns { kind: "full"|"update"|"unchanged", text, held: nextHeld, diff? }
 */
export function decideSheetBlock(held, snap, { doc = "", rules = SHEET_RULES } = {}) {
  const fresh = pairsOf(snap);
  const full = (first) => ({
    kind: "full",
    text: first ? String(snap?.text ?? "") : markSupersedes(snap?.text),
    held: { pairs: fresh, diffsSinceFull: 0, fulls: (held?.fulls ?? 0) + 1, fingerprint: snap?.fingerprint ?? null }
  });
  if (!held || !Array.isArray(held.pairs)) return full(true);
  const diff = diffPairs(held.pairs, fresh);
  if (!diff.size) {
    return { kind: "unchanged", text: UNCHANGED_BLOCK, held: { ...held, fingerprint: snap?.fingerprint ?? held.fingerprint ?? null }, diff };
  }
  if ((held.diffsSinceFull ?? 0) >= rules.maxDiffsBeforeFull) return { ...full(false), diff };
  const text = renderUpdate(diff, { doc, fingerprint: snap?.fingerprint });
  const share = diff.size / Math.max(1, fresh.length);
  if (share > rules.maxDiffShare || estimateTokens(text) > rules.maxDiffTokens) return { ...full(false), diff };
  return {
    kind: "update", text, diff,
    held: { pairs: foldPairs(held.pairs, diff), diffsSinceFull: (held.diffsSinceFull ?? 0) + 1, fulls: held.fulls ?? 1, fingerprint: snap?.fingerprint ?? null }
  };
}

/** JSON-safe form of a held picture (a pack's own `held` may contain Maps; the session record must survive IndexedDB/JSON). */
export function encodeHeld(v) {
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [k, encodeHeld(x)]) };
  if (Array.isArray(v)) return v.map(encodeHeld);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeHeld(x)]));
  return v;
}
export function decodeHeld(v) {
  if (Array.isArray(v)) return v.map(decodeHeld);
  if (v && typeof v === "object") {
    if (Array.isArray(v.__map) && Object.keys(v).length === 1) return new Map(v.__map.map(([k, x]) => [k, decodeHeld(x)]));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeHeld(x)]));
  }
  return v;
}
