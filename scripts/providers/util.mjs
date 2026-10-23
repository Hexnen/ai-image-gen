// Wspólne helpery providerów (przeglądarka, bez zależności).
// Port z Hexnen/roleplay src/lib/roleplay/imageGen/shared.ts.
import { redact } from "../redact.mjs";

export const GEN_TIMEOUT_MS = 120_000;
/** GPT Image 2 na quality=high potrafi mielić > 1 min. */
export const GPT_IMAGE_TIMEOUT_MS = 180_000;

/** Timeout skalowany od obciążenia żądania (np. n obrazów, wysoka jakość, 4K), w [base, max]. */
export function scaledTimeout(base, { n = 1, factor = 1, max = 600_000 } = {}) {
  const k = factor * (1 + 0.5 * (Math.max(1, Number(n) || 1) - 1));
  return Math.min(max, Math.max(base, Math.round(base * k)));
}

/** Łączy sygnał użytkownika (anuluj) z timeoutem; działa też bez AbortSignal.any. */
export function withTimeout(ms, signal) {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, t]);
  const ctl = new AbortController();
  const fire = (s) => () => ctl.abort(s.reason);
  for (const s of [signal, t]) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener("abort", fire(s), { once: true });
  }
  return ctl.signal;
}

/** TimeoutError/AbortError z fetch -> czytelny komunikat (zachowuje name, żeby wywołujący rozróżnił). */
export function normalizeError(e) {
  if (e?.name === "TimeoutError") {
    const x = new Error("Request timed out (the provider may still have processed and billed it).");
    x.name = "TimeoutError";
    return x;
  }
  if (e?.name === "AbortError") {
    const x = new Error("Cancelled.");
    x.name = "AbortError";
    return x;
  }
  // fetch() odrzucone bez odpowiedzi (TypeError: Failed to fetch): offline/zablokowane ALBO dostawca odrzucił
  // żądanie bez nagłówków CORS — OpenAI tak odpowiada na dobrze sformatowany, ale nieistniejący klucz (sk-proj-...).
  if (e instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(String(e.message))) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const x = new Error(offline
      ? "No network connection."
      : "Could not read the provider's response (network error, or the provider rejected the request without CORS headers). Check the API key and your connection.");
    x.name = "NetworkError";
    return x;
  }
  return e;
}

/**
 * Treść błędu dostawcy do pokazania człowiekowi: z JSON-a bierze `error.message` (OpenAI, OpenRouter, Gemini —
 * także w tablicy, jak w Interactions API), dodając kod/status gdy jest; inaczej początek surowego body.
 */
export function errorText(detail, max = 500) {
  const raw = String(detail ?? "").trim();
  try {
    const j = JSON.parse(raw);
    const err = (Array.isArray(j) ? j[0] : j)?.error ?? (Array.isArray(j) ? j[0] : j)?.detail ?? j;
    const msg = typeof err === "string" ? err : err?.message;
    if (typeof msg === "string" && msg.trim()) {
      const tag = err?.status || err?.type || err?.code;
      return (tag && typeof tag === "string" ? `${msg.trim()} [${tag}]` : msg.trim()).slice(0, max);
    }
  } catch { /* nie JSON */ }
  return raw.slice(0, max);
}

/** Błąd HTTP z czytelnym komunikatem dostawcy (zamaskowane klucze). */
export async function httpError(label, res) {
  let detail = "";
  try { detail = await res.text(); } catch { /* brak treści */ }
  const e = new Error(redact(`${label} HTTP ${res.status}: ${errorText(detail)}`));
  e.status = res.status;
  return e;
}

export function b64ToBlob(b64, type = "image/png") {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function blobToB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** MIME po magic bytes (fallback: blob.type). */
export async function mimeOf(blob) {
  const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (a, b) => String.fromCharCode(...h.subarray(a, b));
  if (h[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return blob.type || "image/png";
}

/** Najbliższy z dozwolonych aspektów ("w:h") dla zadanych wymiarów/aspektu. */
export function nearestAspect({ aspectRatio, width, height }, allowed) {
  let r;
  if (aspectRatio && /^\d+:\d+$/.test(aspectRatio)) {
    const [w, h] = aspectRatio.split(":").map(Number);
    r = w / h;
  } else if (width && height) r = width / height;
  else return allowed.includes("1:1") ? "1:1" : allowed[0];
  let best = allowed[0], bd = Infinity;
  for (const a of allowed) {
    const [w, h] = a.split(":").map(Number);
    const d = Math.abs(Math.log(w / h / r));
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
