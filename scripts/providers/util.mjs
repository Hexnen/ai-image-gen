// Wspólne helpery providerów (przeglądarka, bez zależności).
// Port z Hexnen/roleplay src/lib/roleplay/imageGen/shared.ts.

export const GEN_TIMEOUT_MS = 120_000;
/** GPT Image 2 na quality=high potrafi mielić > 1 min. */
export const GPT_IMAGE_TIMEOUT_MS = 180_000;

/** Łączy sygnał użytkownika (anuluj) z timeoutem. */
export function withTimeout(ms, signal) {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, t]) : t;
}

/** Błąd HTTP z początkiem body. */
export async function httpError(label, res) {
  let detail = "";
  try { detail = await res.text(); } catch { /* brak treści */ }
  return new Error(`${label} HTTP ${res.status}: ${detail.slice(0, 500)}`);
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
