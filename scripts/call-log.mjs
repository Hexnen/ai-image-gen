// Pełny log wywołań (Fast, wysyłka batcha, wyniki batcha, zablokowane przez limity).
// Pliki miesięczne Data/ai-image-gen/_log/YYYY-MM.json; cache w pamięci; zapisy serializowane.
// Log NIE zawiera kluczy API ani nagłówków (błędy są oczyszczane w `redact`).
// Zapis jest bezpieczny dla danych: przed nadpisaniem pliku miesiąca czytamy jego aktualną zawartość
// i scalamy po id (drugi GM mógł dopisać wpisy), a błąd odczytu NIGDY nie kończy się nadpisaniem pustym.
import { MODULE_ID } from "./constants.mjs";
import { redact } from "./redact.mjs";
import { ensureDir } from "./save-image.mjs";

export { redact };

const FP = () => foundry.applications.apps.FilePicker.implementation;
const DIR = `${MODULE_ID}/_log`;

export const LOG_FIELDS = [
  "id", "ts", "durationMs", "kind", "status", "provider", "model", "route", "prompt", "description",
  "size", "quality", "imageSize", "thinkingLevel", "refsCount", "cost", "costKind", "tokens",
  "docUuid", "docName", "typeKey", "batchId", "itemId", "error", "user",
  "bytesBefore", "bytesAfter", "optimizedVia"
];

const months = new Map();   // "YYYY-MM" -> entry[]
const dirty = new Set();
const replace = new Set();  // miesiące do nadpisania bez scalania (clearLog)
let loading = null;
let needsReload = false;    // listowanie/odczyt plików się nie udało: spróbuj ponownie przy najbliższym odczycie
let lastLoadTry = 0;
let lastBak = 0;
/** Strojenie (testy ustawiają bakEveryMs = 0): kopia .bak poprzedniej zawartości najwyżej raz na tyle ms. */
export const logTuning = { bakEveryMs: 60_000 };
let retryTimer = null;
let chain = Promise.resolve();

const isGM = () => !!game.user?.isGM;

const monthOf = (ts) => String(ts).slice(0, 7);

// ---------- sanitising ----------

/** Tokeny z obiektu usage/usageMetadata (albo z całej odpowiedzi). */
export function tokensFrom(obj) {
  const u = obj?.usage ?? obj?.usageMetadata ?? obj?.usage_metadata ?? obj;
  if (!u || typeof u !== "object") return null;
  const inT = u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? u.prompt_token_count;
  const outT = u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? u.candidates_token_count;
  if (!Number.isFinite(Number(inT)) && !Number.isFinite(Number(outT))) return null;
  return { in: Number(inT) || 0, out: Number(outT) || 0 };
}

/** Limity długości pól tekstowych (plik miesiąca jest przepisywany w całości przy każdym wpisie). */
const FIELD_MAX = { prompt: 8000, description: 2000, docName: 200, docUuid: 200, typeKey: 200, route: 200, model: 120 };

function clean(entry) {
  const e = {};
  for (const f of LOG_FIELDS) if (entry[f] !== undefined && entry[f] !== null && entry[f] !== "") e[f] = entry[f];
  e.id ??= foundry.utils.randomID();
  e.ts ??= new Date().toISOString();
  e.user ??= game.user?.name ?? "";
  for (const [f, max] of Object.entries(FIELD_MAX)) if (typeof e[f] === "string" && e[f].length > max) e[f] = `${e[f].slice(0, max)}…`;
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

const fileUrl = (key) => `${foundry.utils.getRoute(`${DIR}/${key}.json`)}?t=${Date.now()}`;

/** Odczyt pliku miesiąca: "ok" | "missing" (404: wolno utworzyć) | "corrupt" (zła zawartość) | "error" (nie wiemy). */
async function readMonthFile(key) {
  let res;
  try { res = await fetch(fileUrl(key), { cache: "no-store" }); }
  catch (e) { return { state: "error", error: e }; }
  if (res.status === 404) return { state: "missing" };
  if (!res.ok) return { state: "error", error: new Error(`HTTP ${res.status}`) };
  let text;
  try { text = await res.text(); } catch (e) { return { state: "error", error: e }; }
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? { state: "ok", arr } : { state: "corrupt", text };
  } catch {
    return { state: "corrupt", text };
  }
}

async function doLoad() {
  lastLoadTry = Date.now();
  needsReload = false;
  const keys = new Set([monthOf(new Date().toISOString())]);
  try {
    for (const f of (await FP().browse("data", DIR)).files ?? []) {
      const m = /(\d{4}-\d{2})\.json$/.exec(f);
      if (m) keys.add(m[1]);
    }
  } catch { needsReload = true; /* brak katalogu albo błąd listowania: niepewne, spróbujemy ponownie */ }
  for (const key of keys) {
    const r = await readMonthFile(key);
    if (r.state === "ok") mergeInto(key, r.arr);
    else if (r.state !== "missing") {
      needsReload = true;
      console.warn(`${MODULE_ID} | log: cannot read ${key}.json (${r.state}); it will not be overwritten blindly`, r.error ?? "");
    }
  }
}

/** Wczytaj istniejące pliki logu (idempotentne; tylko GM). */
export function initLog() {
  if (!isGM()) return Promise.resolve();
  return (loading ??= doLoad());
}

async function ensureLoaded() {
  await initLog();
  if (needsReload && isGM() && Date.now() - lastLoadTry > 30_000) {
    loading = doLoad();
    await loading;
  }
}

async function uploadText(name, text) {
  await ensureDir(DIR);
  await FP().upload("data", DIR, new File([text], name, { type: "application/json" }), {}, { notify: false });
}

async function writeMonth(key) {
  // Świeża zawartość pliku: wpisy dopisane przez innego GM-a nie mogą zniknąć, a niepewny odczyt blokuje zapis.
  const cur = await readMonthFile(key);
  if (cur.state === "error") throw new Error(`log: cannot read ${key}.json, refusing to overwrite it (${cur.error?.message ?? "?"})`);
  if (cur.state === "corrupt") await uploadText(`${key}.corrupt-${Date.now()}.json`, cur.text);
  if (cur.state === "ok") {
    if (!replace.has(key)) mergeInto(key, cur.arr);
    if (Date.now() - lastBak >= logTuning.bakEveryMs) { await uploadText(`${key}.bak.json`, JSON.stringify(cur.arr)); lastBak = Date.now(); }
  }
  replace.delete(key);
  await uploadText(`${key}.json`, JSON.stringify(months.get(key) ?? []));
}

/** Zapisz brudne miesiące; kolejka seryjna (bez wyścigów). Błąd zapisu nigdy nie psuje generacji (ponowienie za 30 s). */
export function flushLog() {
  if (!isGM()) return Promise.resolve();
  chain = chain.then(async () => {
    while (dirty.size) {
      const key = dirty.values().next().value;
      dirty.delete(key);
      try { await writeMonth(key); }
      catch (e) {
        dirty.add(key);
        console.warn(`${MODULE_ID} | log: write failed (will retry)`, e);
        retryTimer ??= setTimeout(() => { retryTimer = null; flushLog(); }, 30_000);
        retryTimer?.unref?.(); // tylko Node (testy): nie trzymaj procesu
        break;
      }
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
  if (!isGM()) return null;
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
  if (!isGM()) return [];
  await ensureLoaded();
  const lo = from ? new Date(from).getTime() : -Infinity;
  const hi = to ? new Date(to).getTime() : Infinity;
  return [...months.values()].flat()
    .filter((e) => { const t = Date.parse(e.ts); return t >= lo && t <= hi; })
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export async function clearLog() {
  if (!isGM()) throw new Error("Only a GM can clear the call log.");
  await initLog();
  for (const key of months.keys()) { months.set(key, []); dirty.add(key); replace.add(key); }
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
export function logBatchResult(rec, itemId, { ok, error, cost = 0, tokens = null, bytesBefore, bytesAfter, optimizedVia } = {}) {
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
    bytesBefore, bytesAfter, optimizedVia,
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
  "typeKey", "batchId", "bytesBefore", "bytesAfter", "optimizedVia", "user", "description", "prompt", "error"];

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
