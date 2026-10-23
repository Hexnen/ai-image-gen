// Pełny log wywołań (Fast, wysyłka batcha, wyniki batcha, zablokowane przez limity).
// Pliki miesięczne Data/ai-image-gen/_log/YYYY-MM.json; cache w pamięci; zapisy serializowane.
// Log NIE zawiera kluczy API ani nagłówków (błędy są oczyszczane w `redact`).
import { MODULE_ID, PROVIDER_IDS } from "./constants.mjs";
import { getKey } from "./settings.mjs";
import { ensureDir } from "./save-image.mjs";

const FP = () => foundry.applications.apps.FilePicker.implementation;
const DIR = `${MODULE_ID}/_log`;

export const LOG_FIELDS = [
  "id", "ts", "durationMs", "kind", "status", "provider", "model", "route", "prompt", "description",
  "size", "quality", "imageSize", "thinkingLevel", "refsCount", "cost", "costKind", "tokens",
  "docUuid", "docName", "typeKey", "batchId", "itemId", "error", "user"
];

const months = new Map();   // "YYYY-MM" -> entry[]
const dirty = new Set();
let loading = null;
let chain = Promise.resolve();

const monthOf = (ts) => String(ts).slice(0, 7);

// ---------- sanitising ----------

/** Wycina klucze/tokeny z tekstu (błędy HTTP potrafią je cytować). */
export function redact(text) {
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
    .slice(0, 2000);
}

/** Tokeny z obiektu usage/usageMetadata (albo z całej odpowiedzi). */
export function tokensFrom(obj) {
  const u = obj?.usage ?? obj?.usageMetadata ?? obj?.usage_metadata ?? obj;
  if (!u || typeof u !== "object") return null;
  const inT = u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? u.prompt_token_count;
  const outT = u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? u.candidates_token_count;
  if (!Number.isFinite(Number(inT)) && !Number.isFinite(Number(outT))) return null;
  return { in: Number(inT) || 0, out: Number(outT) || 0 };
}

function clean(entry) {
  const e = {};
  for (const f of LOG_FIELDS) if (entry[f] !== undefined && entry[f] !== null && entry[f] !== "") e[f] = entry[f];
  e.id ??= foundry.utils.randomID();
  e.ts ??= new Date().toISOString();
  e.user ??= game.user?.name ?? "";
  if (e.error !== undefined) e.error = redact(e.error);
  if (typeof e.cost === "number") e.cost = Math.round(e.cost * 1e6) / 1e6;
  if (typeof e.durationMs === "number") e.durationMs = Math.round(e.durationMs);
  return e;
}

// ---------- storage ----------

function mergeInto(key, arr) {
  const cur = months.get(key) ?? [];
  const seen = new Set(cur.map((x) => x.id));
  months.set(key, [...arr.filter((x) => x && !seen.has(x.id)), ...cur]);
}

async function doLoad() {
  let files = [];
  try { files = (await FP().browse("data", DIR)).files ?? []; } catch { /* no log dir yet */ }
  for (const f of files) {
    const m = /(\d{4}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    try {
      const res = await fetch(`${foundry.utils.getRoute(f)}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) continue;
      const arr = await res.json();
      if (Array.isArray(arr)) mergeInto(m[1], arr);
    } catch (e) {
      console.warn(`${MODULE_ID} | log: cannot read ${f}`, e);
    }
  }
}

/** Wczytaj istniejące pliki logu (idempotentne). */
export function initLog() {
  return (loading ??= doLoad());
}

async function writeMonth(key) {
  await ensureDir(DIR);
  const file = new File([JSON.stringify(months.get(key) ?? [])], `${key}.json`, { type: "application/json" });
  await FP().upload("data", DIR, file, {}, { notify: false });
}

/** Zapisz brudne miesiące; kolejka seryjna (bez wyścigów). Błąd zapisu nigdy nie psuje generacji. */
export function flushLog() {
  chain = chain.then(async () => {
    while (dirty.size) {
      const key = dirty.values().next().value;
      dirty.delete(key);
      try { await writeMonth(key); }
      catch (e) { dirty.add(key); console.warn(`${MODULE_ID} | log: write failed`, e); break; }
    }
  });
  return chain;
}

// ---------- API ----------

/** Dopisz wpis. Tylko GM zapisuje. @returns {Promise<object|null>} zapisany wpis */
export async function logCall(entry) {
  try {
    if (!game.user?.isGM) return null;
    await initLog();
    const e = clean(entry);
    const key = monthOf(e.ts);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(e);
    dirty.add(key);
    Hooks.callAll("aiImageGen.logUpdate", e);
    await flushLog();
    return e;
  } catch (err) {
    console.warn(`${MODULE_ID} | log: logCall failed`, err);
    return null;
  }
}

/** Zmień pola istniejącego wpisu (np. zapis pliku się nie udał po udanym wywołaniu API). */
export async function updateCall(id, patch) {
  try {
    await initLog();
    for (const [key, arr] of months) {
      const e = arr.find((x) => x.id === id);
      if (!e) continue;
      Object.assign(e, clean({ ...e, ...patch }));
      dirty.add(key);
      Hooks.callAll("aiImageGen.logUpdate", e);
      await flushLog();
      return e;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | log: updateCall failed`, err);
  }
  return null;
}

/** Wszystkie wpisy (najnowsze pierwsze), opcjonalnie z zakresu dat (ISO lub Date). */
export async function readLog({ from, to } = {}) {
  await initLog();
  const lo = from ? new Date(from).getTime() : -Infinity;
  const hi = to ? new Date(to).getTime() : Infinity;
  return [...months.values()].flat()
    .filter((e) => { const t = Date.parse(e.ts); return t >= lo && t <= hi; })
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export async function clearLog() {
  await initLog();
  for (const key of months.keys()) { months.set(key, []); dirty.add(key); }
  Hooks.callAll("aiImageGen.logUpdate", null);
  await flushLog();
}

/** Wpis wysyłki batcha dla itemu (żeby wynik odziedziczył prompt, rozmiar itd.). */
export function findSubmitEntry(batchId, itemId) {
  for (const arr of months.values()) {
    const e = arr.find((x) => x.kind === "batch-submit" && x.batchId === batchId && x.itemId === itemId);
    if (e) return e;
  }
  return null;
}

/** Wpis „batch-result" dla jednego itemu (sukces albo błąd). */
export function logBatchResult(rec, itemId, { ok, error, cost = 0, tokens = null } = {}) {
  // wznowiony ingest / ponowne czytanie pliku błędów nie dubluje wpisów
  for (const arr of months.values()) {
    if (arr.some((x) => x.kind === "batch-result" && x.batchId === rec.id && x.itemId === itemId)) return Promise.resolve(null);
  }
  const item = rec.items?.find((i) => i.id === itemId);
  const sub = findSubmitEntry(rec.id, itemId);
  return logCall({
    kind: "batch-result",
    status: ok ? "ok" : "error",
    provider: rec.provider,
    model: rec.model,
    route: rec.endpoint,
    prompt: sub?.prompt,
    description: sub?.description ?? item?.meta?.description,
    size: sub?.size, quality: sub?.quality, imageSize: sub?.imageSize, thinkingLevel: sub?.thinkingLevel,
    refsCount: sub?.refsCount,
    cost, costKind: "actual",
    tokens: tokens ?? undefined,
    // czas oczekiwania na wynik (od wysyłki), nie czas jednego żądania
    durationMs: rec.createdAt ? Date.now() - rec.createdAt : undefined,
    docUuid: item?.target?.uuid,
    docName: item?.meta?.name ?? sub?.docName,
    typeKey: item?.meta?.typeKey ?? sub?.typeKey,
    batchId: rec.id, itemId,
    error
  });
}

// ---------- export ----------

export const CSV_COLUMNS = ["ts", "kind", "status", "provider", "model", "route", "durationMs", "cost", "costKind",
  "tokensIn", "tokensOut", "size", "quality", "imageSize", "thinkingLevel", "refsCount", "docName", "docUuid",
  "typeKey", "batchId", "user", "description", "prompt", "error"];

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-(?!\d)/.test(s)) s = `'${s}`; // formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(entries) {
  const rows = entries.map((e) => CSV_COLUMNS.map((c) =>
    csvCell(c === "tokensIn" ? e.tokens?.in : c === "tokensOut" ? e.tokens?.out : e[c])));
  return [CSV_COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
}

export const toJSON = (entries) => JSON.stringify(entries, null, 2);
