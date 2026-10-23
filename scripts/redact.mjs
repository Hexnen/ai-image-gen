// Wspólne maskowanie sekretów w tekstach błędów (log, powiadomienia, rekordy batchy).
// Komunikaty HTTP dostawców potrafią cytować fragmenty nagłówków i kluczy.
import { PROVIDER_IDS } from "./constants.mjs";
import { getKey } from "./settings.mjs";

/** Wycina klucze/tokeny z tekstu. Zawsze zwraca string o długości <= maxLen. */
export function redact(text, maxLen = 2000) {
  let s = String(text ?? "");
  for (const p of PROVIDER_IDS) {
    let k = "";
    try { k = getKey(p); } catch { /* settings not ready */ }
    if (k && k.length >= 8) s = s.split(k).join("[redacted]");
  }
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(x-goog-api-key|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]") // długie ciągi wyglądające na token
    .slice(0, maxLen);
}

/** redact + escape HTML: do ui.notifications i innych miejsc, gdzie tekst trafia do DOM jako HTML. */
export function safeMessage(text, maxLen = 500) {
  return foundry.utils.escapeHTML(redact(text, maxLen));
}
