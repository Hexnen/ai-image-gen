/* One-time copy of this module's settings from its OLD id ("ai-image-gen", the module was called AI Image Gen) to the
   current id ("moinens-ai-gen"). Pattern taken from invincible-plus-ultra/scripts/migrate-id.mjs. Old values are only READ
   (never deleted or changed), so re-enabling the old module brings back the old SETTINGS. It does not know what this module
   did in the meantime: batches that were still running at the copy would be collected a second time by the old module
   (README "Rename from ai-image-gen" says what to do before going back).
   Storage formats:
   - client scope: window.localStorage "<namespace>.<key>", value = JSON.stringify(value). The API keys never leave the
     GM's browser: localStorage -> localStorage on the same client. Every GM browser migrates itself once (client flag).
   - world scope : Setting documents in game.settings.storage.get("world"), key "<namespace>.<key>", value already parsed
     (Setting.value is a JSONField). GM only, once per world (world flag).
   - raw localStorage keys that are not settings ("<namespace>.dialogPrefs", "<namespace>.test.<typeKey>"): copied as
     strings when the new key is absent.
   A setting is copied only when the new key was NEVER stored in the new namespace (no Setting document / no localStorage
   entry) and the old value differs from the default. A value that is back at its default is therefore not the same as
   "not copied yet": a batch slot freed after collecting (written as {}) is never refilled with the old record, so a
   re-run (partial copy retried next start, or the manual re-copy) cannot resurrect a batch and collect it twice. A batch
   record whose id already sits in another slot of the new namespace is skipped as well.
   A flag stays unset while some key is not registered yet (the run is then repeated next start).
   The caller (module.mjs) runs this BEFORE runMigrations(), so an old world on schema 1 is upgraded in the new namespace,
   and does not run it at all while the old module is still active (its values would keep changing after the copy). */
import { MODULE_ID, OLD_MODULE_ID, PROVIDER_IDS, MIGRATED_CLIENT, MIGRATED_WORLD } from "./constants.mjs";
import { SLOTS, slotKey } from "./batch/record.mjs";

const LOG = `${MODULE_ID} |`;
export const CLIENT_KEYS = [...PROVIDER_IDS.map((p) => `apiKey.${p}`), "apiKey.anthropic"];
export const WORLD_KEYS = [
  "enhance.model", "enhance.effort",
  "limit.daily", "limit.monthly", "limit.perRequest", "limit.batchSize",
  "optimizeImages", "usage", "imageTypes", "schema", "batches",
  ...Array.from({ length: SLOTS }, (_, i) => slotKey(i))
];
/** Raw (non-setting) localStorage keys under the namespace: exact names or prefixes ending with ".". */
export const RAW_KEYS = ["dialogPrefs", "test."];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Structural equality good enough for setting values (primitives, plain objects, arrays). */
export function sameValue(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** Default of a registered setting: the DataField's initial value, else cfg.default. */
export function defaultOf(cfg) {
  const f = cfg?.type;
  if (f && typeof f.getInitialValue === "function") {
    try { return f.getInitialValue({}); } catch { /* fall through */ }
  }
  if (f && "initial" in Object(f)) return typeof f.initial === "function" ? f.initial({}) : f.initial;
  return cfg?.default;
}

const fields = () => globalThis.foundry?.data?.fields ?? {};
const is = (f, name) => typeof fields()[name] === "function" && f instanceof fields()[name];

/** Coerce an old value into what the registered setting accepts; undefined = reject (keep the new default). */
export function coerce(cfg, v) {
  if (v === null || v === undefined) return undefined;
  const f = cfg?.type;
  if (is(f, "BooleanField")) return typeof v === "boolean" ? v : undefined;
  if (is(f, "NumberField")) {
    const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
    if (!Number.isFinite(n)) return undefined;
    if ((f.min ?? null) !== null && n < f.min) return undefined;
    if ((f.max ?? null) !== null && n > f.max) return undefined;
    return n;
  }
  if (is(f, "StringField")) {
    if (typeof v !== "string") return undefined;
    const ch = typeof f.choices === "function" ? f.choices() : f.choices;
    if (ch && !(Array.isArray(ch) ? ch.includes(v) : Object.hasOwn(ch, v))) return undefined;
    return v;
  }
  if (is(f, "ObjectField")) return isPlainObject(v) ? v : undefined;
  return undefined;   // unknown type: never copy blind
}

/** Parse a localStorage value written by ClientSettings (JSON); tolerate a bare non-JSON string. */
export function parseStored(raw) {
  if (raw === null || raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

const storage = () => globalThis.window?.localStorage ?? globalThis.localStorage;
const readClient = (key) => parseStored(storage()?.getItem(`${OLD_MODULE_ID}.${key}`));
const worldDoc = (ns, key) => game.settings.storage?.get("world")?.getSetting?.(`${ns}.${key}`, null);
const readWorld = (key) => worldDoc(OLD_MODULE_ID, key)?.value;
/** Has this key ever been written in the NEW namespace? (client: localStorage entry; world: Setting document) */
export function storedInNew(key, scope) {
  if (scope === "world") return !!worldDoc(MODULE_ID, key);
  return (storage()?.getItem(`${MODULE_ID}.${key}`) ?? null) !== null;
}
const isSlot = (key) => /^batch\.\d+$/.test(key);
/** Ids of batch records already held in the new namespace (any slot). */
function newBatchIds() {
  const ids = new Set();
  for (let i = 0; i < SLOTS; i++) {
    try { const r = game.settings.get(MODULE_ID, slotKey(i)); if (r?.id) ids.add(r.id); } catch { /* not registered */ }
  }
  return ids;
}

/** Copy the raw (non-setting) localStorage entries; returns the copied keys (without namespace). */
export function copyRawLocalStorage(ls = storage()) {
  const copied = [];
  if (!ls) return copied;
  const oldNs = `${OLD_MODULE_ID}.`;
  const keys = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k?.startsWith(oldNs)) keys.push(k.slice(oldNs.length));
  }
  for (const k of keys) {
    if (!RAW_KEYS.some((r) => (r.endsWith(".") ? k.startsWith(r) : k === r))) continue;
    const target = `${MODULE_ID}.${k}`;
    if (ls.getItem(target) !== null) continue;
    const v = ls.getItem(`${oldNs}${k}`);
    if (v === null) continue;
    try { ls.setItem(target, v); copied.push(k); } catch (e) { console.warn(`${LOG} migrate ${k} failed`, e); }
  }
  return copied;
}

let running = null;
/** Idempotent within a session; never throws. Resolves to { client: [...], world: [...], raw: [...] } (copied keys). */
export function migrateFromAiImageGen() {
  return running ??= run().catch((e) => { console.warn(`${LOG} settings migration from "${OLD_MODULE_ID}" failed`, e); return { client: [], world: [], raw: [] }; });
}
/** Tests only: forget the in-session memo. */
export function _resetForTests() { running = null; }

async function run() {
  const out = { client: [], world: [], raw: [] };
  if (!game.user?.isGM) return out;   // only GMs use this module; players have nothing to copy
  let complete = true;
  const pending = [];
  let batchIds = null;
  const copy = (key, read, bucket) => {
    try {
      const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (!cfg) { complete = false; return; }
      const old = coerce(cfg, read(key));
      const def = defaultOf(cfg);
      if (old === undefined || sameValue(old, def)) return;
      if (storedInNew(key, cfg.scope === "world" ? "world" : "client")) return;   // written here before: never overwrite
      if (!sameValue(game.settings.get(MODULE_ID, key), def)) return;
      if (isSlot(key)) {
        batchIds ??= newBatchIds();
        if (!old.id || batchIds.has(old.id)) return;   // the same batch is already tracked here
        batchIds.add(old.id);
      }
      pending.push(game.settings.set(MODULE_ID, key, old).then(() => bucket.push(key))
        .catch((e) => { complete = false; console.warn(`${LOG} migrate ${key} failed`, e); }));
    } catch (e) { complete = false; console.warn(`${LOG} migrate ${key} failed`, e); }
  };
  const done = (flag) => { try { return game.settings.get(MODULE_ID, flag) === true; } catch { return true; } };

  try {
    if (game.settings.settings.has(`${MODULE_ID}.${MIGRATED_CLIENT}`) && !done(MIGRATED_CLIENT)) {
      complete = true;
      for (const k of CLIENT_KEYS) copy(k, readClient, out.client);
      await Promise.all(pending.splice(0));
      out.raw = copyRawLocalStorage();
      if (complete) await game.settings.set(MODULE_ID, MIGRATED_CLIENT, true);
    }
  } catch (e) { console.warn(`${LOG} client settings migration failed`, e); }

  try {
    if (game.settings.settings.has(`${MODULE_ID}.${MIGRATED_WORLD}`) && !done(MIGRATED_WORLD)) {
      complete = true;
      for (const k of WORLD_KEYS) copy(k, readWorld, out.world);
      await Promise.all(pending.splice(0));
      if (complete) await game.settings.set(MODULE_ID, MIGRATED_WORLD, true);
    }
  } catch (e) { console.warn(`${LOG} world settings migration failed`, e); }

  const n = out.client.length + out.world.length + out.raw.length;
  // Key NAMES only in the console, never values (API keys).
  if (n) console.info(`${LOG} copied settings from "${OLD_MODULE_ID}": ${[...out.client, ...out.world, ...out.raw].join(", ")}`);
  return out;
}
