// Conversation store of the AI builder (spec 11.2; task T2). PURE apart from the IndexedDB handle it is given.
//
// - IndexedDB database "moinens-ai-gen" in the GM's browser only (never actor flags, never files under Data/: spec 10.4).
//   Store "sessions": the ACTIVE conversation per document, key `${worldId}:${docUuid}`.
//   Store "archive":  earlier conversations of a document ("New conversation"), key `${docKey}|${createdAt}|${conversationId}`,
//                     newest `archiveKeep` per document.
// - Append-only: a save of the same conversation must keep every stored message byte-identical and in place (only new
//   messages at the end). Anything else is refused with HistoryEditError (spec 5.2: history is never edited).
//   A different conversation replaces the active one only through `{ newConversation: true }`, which archives the old one.
// - IndexedDB missing, blocked or failing: the store keeps working in memory for the page lifetime (`mode` says which),
//   reports it once through `onWarn`, and never throws for a storage failure.

export const DB_NAME = "moinens-ai-gen";
export const DB_VERSION = 1;
export const STORE = "sessions";
export const ARCHIVE = "archive";

export class HistoryEditError extends Error {
  constructor(detail) { super(`history is append-only: ${detail}`); this.name = "HistoryEditError"; this.code = "history-edit"; }
}

const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error("idb request failed")); });

export function docKey(worldId, docUuid) { return `${worldId ?? "?"}:${docUuid ?? "?"}`; }

/** Check that `next.messages` extends `prev.messages` without touching it. Throws HistoryEditError. */
export function assertAppendOnly(prev, next) {
  if (!prev || prev.conversationId !== next.conversationId) return;
  const a = prev.messages ?? [], b = next.messages ?? [];
  if (b.length < a.length) throw new HistoryEditError(`${a.length - b.length} message(s) removed`);
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) throw new HistoryEditError(`message ${i} changed`);
  }
}

/**
 * createSessionStore({ indexedDB, archiveKeep, onWarn }) -> store
 *   load(key)                       -> record | null
 *   save(record, { newConversation }) -> { ok, mode }   (throws HistoryEditError only)
 *   listArchive(key)                -> [record] newest first
 *   remove(key)                     -> void (active conversation only; archive kept)
 *   mode                            "idb" | "memory" (after the first operation)
 */
export function createSessionStore({ indexedDB = globalThis.indexedDB, archiveKeep = 5, onWarn = null } = {}) {
  const mem = new Map();       // key -> last saved record (plain), mirror of the active store
  const memArchive = new Map(); // archive key -> record (memory mode only)
  let dbP = null;
  let mode = indexedDB ? "idb" : "memory";
  let warned = false;
  const warn = (e) => {
    mode = "memory";
    if (warned) return;
    warned = true;
    try { onWarn?.(e); } catch { /* ignore */ }
  };

  function open() {
    if (!indexedDB) return Promise.resolve(null);
    dbP ??= new Promise((resolve) => {
      let r;
      try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { warn(e); return resolve(null); }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(ARCHIVE)) db.createObjectStore(ARCHIVE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => { warn(r.error); resolve(null); };
      r.onblocked = () => { warn(new Error("indexedDB blocked")); resolve(null); };
    });
    return dbP;
  }

  async function withStore(name, rw, fn) {
    const db = await open();
    if (!db) return { skipped: true };
    try {
      const tx = db.transaction([name], rw ? "readwrite" : "readonly");
      const done = new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error ?? new Error("idb tx failed")); tx.onabort = () => rej(tx.error ?? new Error("idb tx aborted")); });
      const value = await fn(tx.objectStore(name));
      if (rw) await done;
      return { value };
    } catch (e) { warn(e); return { skipped: true }; }
  }

  async function load(key) {
    if (mem.has(key)) return plain(mem.get(key));
    const r = await withStore(STORE, false, (s) => req2p(s.get(key)));
    const rec = r.value ?? null;
    if (rec) mem.set(key, plain(rec));
    return rec ? plain(rec) : null;
  }

  async function archive(rec) {
    if (!rec?.messages?.length) return;
    const akey = `${rec.key}|${rec.createdAt}|${rec.conversationId}`;
    memArchive.set(akey, plain(rec));
    await withStore(ARCHIVE, true, (s) => req2p(s.put(plain(rec), akey)));
    // keep the newest `archiveKeep` per document
    const keys = await archiveKeys(rec.key);
    for (const k of keys.slice(archiveKeep)) {
      memArchive.delete(k);
      await withStore(ARCHIVE, true, (s) => req2p(s.delete(k)));
    }
  }

  async function archiveKeys(key) {
    const r = await withStore(ARCHIVE, false, (s) => req2p(s.getAllKeys()));
    const all = new Set([...(r.value ?? []).map(String), ...memArchive.keys()]);
    const createdOf = (k) => Number(String(k).slice(key.length + 1).split("|")[0]) || 0;
    return [...all].filter((k) => k.startsWith(`${key}|`)).sort((a, b) => createdOf(b) - createdOf(a));
  }

  async function listArchive(key) {
    const out = [];
    for (const k of await archiveKeys(key)) {
      if (memArchive.has(k)) { out.push(plain(memArchive.get(k))); continue; }
      const r = await withStore(ARCHIVE, false, (s) => req2p(s.get(k)));
      if (r.value) out.push(plain(r.value));
    }
    return out;
  }

  async function save(record, { newConversation = false } = {}) {
    const rec = plain(record);
    if (!rec?.key) throw new Error("session record without key");
    const prev = mem.has(rec.key) ? mem.get(rec.key) : await load(rec.key);
    if (prev && prev.conversationId !== rec.conversationId) {
      if (!newConversation) throw new HistoryEditError("another conversation is active for this document (use newConversation)");
      await archive(prev);
    }
    assertAppendOnly(prev, rec);
    mem.set(rec.key, rec);
    await withStore(STORE, true, (s) => req2p(s.put(rec, rec.key)));
    return { ok: true, mode };
  }

  async function remove(key) {
    mem.delete(key);
    await withStore(STORE, true, (s) => req2p(s.delete(key)));
  }

  return { load, save, listArchive, remove, get mode() { return mode; } };
}
