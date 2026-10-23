// Wspólne helpery batcha (przeglądarka).
export const UPLOAD_TIMEOUT_MS = 120_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function readError(res) {
  try { return (await res.text()).slice(0, 500); } catch { return ""; }
}

export function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* nieparsowalna linia */ }
  }
  return out;
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
