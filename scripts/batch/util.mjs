// Wspólne helpery batcha (przeglądarka).
export const UPLOAD_TIMEOUT_MS = 120_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Maks. czas bez nowych danych przy strumieniowym pobieraniu wyników. */
export const STREAM_IDLE_MS = 60_000;

/** Błąd HTTP z kodem statusu (żeby wywołujący odróżnił 404/410 „wygasło" od błędu przejściowego). */
export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function readError(res) {
  try { return (await res.text()).slice(0, 500); } catch { return ""; }
}

export function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

function tryParse(line, stats) {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line); } catch { if (stats) stats.skipped = (stats.skipped ?? 0) + 1; return undefined; }
}

/** Parsuje cały tekst JSONL; nieparsowalne linie są liczone w `stats.skipped` (nie giną po cichu). */
export function parseJsonl(text, stats) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const row = tryParse(line, stats);
    if (row !== undefined) out.push(row);
  }
  return out;
}

/**
 * Strumieniowo czyta JSONL z odpowiedzi fetch (bez trzymania całego pliku w jednym stringu —
 * wyniki z obrazami base64 potrafią mieć setki MB). `ctrl` (AbortController użyty w fetch) służy do
 * przerwania, gdy przez `idleMs` nie przyjdą dane; czas przetwarzania wiersza po stronie wywołującego
 * się nie liczy (timer działa tylko podczas oczekiwania na kolejny kawałek).
 */
export async function* iterJsonl(res, { stats, ctrl, idleMs = STREAM_IDLE_MS } = {}) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    for (const row of parseJsonl(await res.text(), stats)) yield row;
    return;
  }
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const timer = ctrl ? setTimeout(() => ctrl.abort(new Error("download stalled")), idleMs) : null;
    let chunk;
    try { chunk = await reader.read(); } finally { if (timer) clearTimeout(timer); }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const row = tryParse(line, stats);
      if (row !== undefined) yield row;
    }
  }
  buf += dec.decode();
  const last = tryParse(buf, stats);
  if (last !== undefined) yield last;
}

/** fetch z kontrolerem przerwania: timeout tylko na nagłówki, potem idle-timeout w `iterJsonl`. */
export async function openStream(url, init = {}, headerTimeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("download timed out")), headerTimeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, ctrl };
  } finally {
    clearTimeout(t);
  }
}

export function newBatchId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Unikalne referencje (po tożsamości Blob) z listy itemów. */
export function uniqueRefs(items) {
  const set = new Set();
  for (const it of items) for (const b of it.refs ?? []) set.add(b);
  return [...set];
}
