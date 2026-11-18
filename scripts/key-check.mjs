// API key hygiene (W6-B). PURE: no Foundry globals, safe to import from node tests and from the transports.
//
// Why: fetch() refuses a header value with a character outside ISO-8859-1 ("String contains non ISO-8859-1 code point")
// and a key pasted from a chat or a document often carries an invisible or typographic character (zero-width space, BOM,
// NBSP, trailing newline, "…" from an app that shortens long words, "—"/smart quotes from autocorrect). Invisible ones are
// stripped (a real key never contains whitespace); a visible non-ASCII character cannot be guessed back, so the key is
// refused before any request with a message that asks for a fresh paste. Nothing here ever echoes the key value.

export const KEY_NON_ASCII_PL = "Klucz API zawiera znak spoza ASCII (np. wielokropek lub twarda spacja) — wklej go ponownie";
export const KEY_NON_ASCII_EN = "The API key contains a non-ASCII character (e.g. an ellipsis or a non-breaking space) — paste it again";

/** Polish or English text of the refusal, by Foundry language when available (default Polish: the owner's table). */
export function keyNonAsciiMessage(lang = globalThis.game?.i18n?.lang) {
  return String(lang ?? "pl").toLowerCase().startsWith("en") ? KEY_NON_ASCII_EN : KEY_NON_ASCII_PL;
}

// Whitespace of every kind (JS \s covers NBSP U+00A0, U+2028/2029, U+3000, BOM U+FEFF...), C0/C1 controls, soft hyphen,
// zero-width and bidi formatting characters, word joiner / invisible operators.
const INVISIBLE = /[\s\u0000-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;
const PRINTABLE_ASCII = /^[\x21-\x7E]*$/;   // a key: visible ASCII only, no spaces
const HEADER_SAFE = /^[\x20-\x7E]*$/;       // any other header value we build: printable ASCII (stricter than Latin-1)

/** Strip invisible / whitespace / control characters. Never throws; non-strings become strings. */
export function normalizeApiKey(value) {
  return String(value ?? "").replace(INVISIBLE, "");
}

/** { key, ok }: key = normalised value; ok = false when a visible non-ASCII character is left (do not send it). */
export function checkApiKey(value) {
  const key = normalizeApiKey(value);
  return { key, ok: PRINTABLE_ASCII.test(key) };
}

/** true when a header value can go to fetch() unchanged (printable ASCII). */
export const isHeaderSafe = (value) => HEADER_SAFE.test(String(value ?? ""));

/** Thrown before any fetch when the key is unusable. `kind` = "bad-key"; the message never contains the key. */
export class ApiKeyError extends Error {
  constructor(lang) {
    super(keyNonAsciiMessage(lang));
    this.name = "ApiKeyError";
    this.kind = "bad-key";
    this.detail = this.message;
    this.retryable = false;
  }
}

/** Normalised key, or throws ApiKeyError. Empty input returns "" (callers report "no key" themselves). */
export function requireUsableKey(value, lang) {
  const { key, ok } = checkApiKey(value);
  if (!ok) throw new ApiKeyError(lang);
  return key;
}

/**
 * Throws when any header value is not printable ASCII (defence in depth: fetch would throw a TypeError naming no header,
 * which used to surface as a retried "network" error). The x-api-key / Authorization / x-goog-api-key values get the
 * key message; any other header a plain one naming the header (values are never printed).
 */
export function assertHeadersSafe(headers, lang) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isHeaderSafe(value)) continue;
    if (/^(x-api-key|authorization|x-goog-api-key)$/i.test(name)) throw new ApiKeyError(lang);
    const e = new Error(`header ${name} contains a non-ASCII character`);
    e.kind = "request";
    throw e;
  }
  return headers;
}
