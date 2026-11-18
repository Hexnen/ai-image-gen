// Rekordy batchy. Każdy rekord w OSOBNYM ustawieniu świata `batch.<n>` (SLOTS miejsc), bo ustawienie
// jest zapisywane w całości: jedna mapa `batches` pozwalała, by zapis jednego klienta kasował rekord
// dodany w tym samym czasie przez drugiego GM-a. Zdarzenie dla UI: ustawienia mają onChange, który
// woła Hooks.callAll("aiImageGen.batchUpdate", rec) na KAŻDYM kliencie (settings.mjs).
import { MODULE_ID } from "../constants.mjs";
import { redact } from "../redact.mjs";

export const SLOTS = 32;
export const slotKey = (i) => `batch.${i}`;

export const ACTIVE = ["pending", "cancelling"];
export const TERMINAL = ["done", "error", "cancelled"];
export const isActive = (r) => ACTIVE.includes(r?.status);

/** Czas ważności dzierżawy (lease) ingestu; odnawiana przy każdym markerze postępu. */
export const LEASE_MS = 3 * 60 * 1000;
/** Strojenie (testy ustawiają verifyMs = 0). */
export const tuning = { verifyMs: 1200 };

let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

// W6-K: dzierżawa należy do KLIENTA (karty przeglądarki), nie do użytkownika: ten sam MG w dwóch kartach
// (albo agent zalogowany jako ten sam użytkownik) nie może ingestować tego samego batcha równolegle.
const CLIENT = Math.random().toString(36).slice(2, 10);
export const leaseOwnerId = () => (game.user?.id ? `${game.user.id}:${CLIENT}` : null);
const me = leaseOwnerId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readSlot(i) {
  const v = game.settings.get(MODULE_ID, slotKey(i));
  return v && typeof v === "object" && v.id ? structuredClone(v) : null;
}
const writeSlot = (i, rec) => game.settings.set(MODULE_ID, slotKey(i), rec ?? {});

function findSlot(id) {
  for (let i = 0; i < SLOTS; i++) if (readSlot(i)?.id === id) return i;
  return -1;
}

/** Teksty błędów w rekordach są widoczne dla wszystkich klientów (ustawienie świata) — maskuj sekrety. */
export function sanitize(rec) {
  if (!rec || typeof rec !== "object") return rec;
  if (typeof rec.error === "string") rec.error = redact(rec.error);
  const fix = (arr) => Array.isArray(arr) ? arr.map((f) => (f && typeof f.error === "string" ? { ...f, error: redact(f.error) } : f)) : arr;
  if (rec.failed) rec.failed = fix(rec.failed);
  if (rec.ingest?.failed) rec.ingest.failed = fix(rec.ingest.failed);
  return rec;
}

const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

export const getBatch = (id) => {
  const i = findSlot(id);
  return i < 0 ? null : readSlot(i);
};

export function listBatches() {
  const out = [];
  for (let i = 0; i < SLOTS; i++) { const r = readSlot(i); if (r) out.push(r); }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Najstarszy rekord, który wolno wyrzucić, gdy brakuje miejsca (nigdy aktywny ani czekający na wybór). */
function evictable() {
  let best = null;
  for (let i = 0; i < SLOTS; i++) {
    const r = readSlot(i);
    if (r && TERMINAL.includes(r.status)) {
      const t = r.completedAt ?? r.createdAt ?? 0;
      if (!best || t < best.t) best = { i, t };
    }
  }
  return best?.i ?? -1;
}

function freeSlotFor(id) {
  const start = hash(id) % SLOTS;
  for (let k = 0; k < SLOTS; k++) {
    const i = (start + k) % SLOTS;
    if (!readSlot(i)) return i;
  }
  return evictable();
}

export function putBatch(rec) {
  return serial(async () => {
    sanitize(rec);
    let i = findSlot(rec.id);
    if (i < 0) i = freeSlotFor(rec.id);
    if (i < 0) throw new Error(`Too many tracked batches (${SLOTS}); remove finished ones from the list.`);
    await writeSlot(i, rec);
    return rec;
  });
}

export function removeBatch(id) {
  return serial(async () => {
    const i = findSlot(id);
    if (i < 0) return false;
    await writeSlot(i, null);
    return true;
  });
}

/**
 * Scala `patch` w rekord (undefined = usuń pole).
 * onlyActive: nie nadpisuj rekordu, który już nie jest aktywny.
 * onlyStatus: zapisz tylko, jeśli rekord ma dokładnie ten status (np. dwa okna wyboru tego samego batcha).
 * leaseOwner: zapisz tylko, jeśli ten klient nadal trzyma dzierżawę (inaczej zwraca null).
 */
export function patchBatch(id, patch, { onlyActive = false, onlyStatus = null, leaseOwner = null } = {}) {
  return serial(async () => {
    const i = findSlot(id);
    if (i < 0) return null;
    const cur = readSlot(i);
    if (onlyActive && !isActive(cur)) return cur;
    if (onlyStatus && cur.status !== onlyStatus) return cur;
    if (leaseOwner && cur.lease && cur.lease.owner !== leaseOwner && cur.lease.until > Date.now()) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cur[k];
      else cur[k] = v;
    }
    sanitize(cur);
    await writeSlot(i, cur);
    return cur;
  });
}

/**
 * Dzierżawa ingestu: tylko jeden klient naraz przetwarza wyniki danego batcha (dwóch GM-ów, ręczne
 * „Sprawdź teraz"). Zwraca świeży rekord, gdy dzierżawa jest nasza, inaczej null.
 */
export async function claimLease(id) {
  const claimed = await serial(async () => {
    const i = findSlot(id);
    if (i < 0) return null;
    const cur = readSlot(i);
    if (!isActive(cur)) return null;
    const now = Date.now();
    if (cur.lease && cur.lease.owner !== me() && cur.lease.until > now) return null;
    cur.lease = { owner: me(), until: now + LEASE_MS };
    await writeSlot(i, cur);
    return cur;
  });
  if (!claimed) return null;
  // Drugi klient mógł zapisać równolegle: poczekaj, aż jego zapis dotrze, i sprawdź, kto wygrał.
  if (tuning.verifyMs) await sleep(tuning.verifyMs);
  const now = getBatch(id);
  return now && isActive(now) && now.lease?.owner === me() ? now : null;
}

export async function releaseLease(id) {
  const cur = getBatch(id);
  if (cur?.lease?.owner === me()) await patchBatch(id, { lease: undefined });
}

/** Marker postępu ingestu (wznowienie po restarcie nie dubluje plików ani kosztu); odnawia dzierżawę. */
export async function markIngested(id, doneIds, cost, failed = [], candidates = [], extra = {}) {
  const saved = await patchBatch(id, {
    ingest: { ids: [...doneIds], cost, failed, candidates, ...extra },
    lease: { owner: me(), until: Date.now() + LEASE_MS },
  }, { onlyActive: true, leaseOwner: me() });
  return !!saved && isActive(saved) && saved.lease?.owner === me();
}

/**
 * Sprzątanie: stare zakończone rekordy znikają z listy, przerwane wysyłki (status "submitting" bez
 * odpowiedzi dostawcy) dostają błąd. Czekających na wybór nie usuwamy (kandydaci leżą na dysku).
 */
export async function pruneBatches({ maxAgeDays = 30, pickMaxAgeDays = 180 } = {}) {
  const now = Date.now();
  const DAY = 86_400_000;
  let removed = 0;
  for (const r of listBatches()) {
    const t = r.completedAt ?? r.createdAt ?? 0;
    if (r.status === "submitting" && now - (r.createdAt ?? 0) > 3_600_000) {
      await patchBatch(r.id, { status: "error", error: "Submission interrupted before the provider confirmed it.", completedAt: now });
    } else if (TERMINAL.includes(r.status) && now - t > maxAgeDays * DAY) {
      if (await removeBatch(r.id)) removed++;
    } else if (r.status === "awaiting-pick" && now - t > pickMaxAgeDays * DAY) {
      if (await removeBatch(r.id)) removed++;
    }
  }
  return removed;
}
