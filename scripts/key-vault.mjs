// W6-H: in-memory key cache over the GM-only world store (key-store.mjs) and the old client-scope copies.
//
// Rules (owner, 2026-11-18: «czy 1 usunie klucze moje wpisane? mam je tylko tam»):
// - the client-scope keys (`<module>.apiKey.<p>` in this browser's localStorage) are NEVER cleared or overwritten here;
// - migration = copy client keys missing in the store, read the store back and compare, only then set the per-browser flag;
//   any failure: keep using the client copy, show a notice, try again next load;
// - store and client differ for a provider: this browser keeps its client copy (the store is not overwritten silently) and
//   the keys window reports the conflict (names only). Saving the keys window from this browser stores the shown values
//   in the world and from then on this browser follows the store for those providers (`keyStore.followStore`).
// - non-GM: no key, ever (the store is never even loaded for them).
// Sync reads (getKey) stay sync: the store is loaded into memory at ready and refreshed on save / keys window / socket ping.
// Nothing here logs a key value.
import { STORE_PROVIDERS, createKeyStore, foundryAdapter } from "./key-store.mjs";
import { checkApiKey } from "./key-check.mjs";

export const MIGRATED_FLAG = "keyStore.migrated";     // client scope: this browser's copies are in the world store
export const FOLLOW_STORE = "keyStore.followStore";   // client scope: { <provider>: true } this browser saved -> store wins
export const SOCKET_TYPE = "moinens-ai-gen.keys-changed";

const state = {
  loaded: false,        // store read OK at least once
  error: null,          // last store error (message, never a key)
  keys: {},             // store keys
  migration: "pending", // pending | done | failed | skipped
  store: null,
  deps: null,
  gen: 0                // bumped on every local save (an older in-flight reload must not overwrite it)
};

const MODULE = "moinens-ai-gen";
const defaultDeps = () => ({
  isGM: () => !!globalThis.game?.user?.isGM,
  getClient: (p) => { try { return String(game.settings.get(MODULE, `apiKey.${p}`) ?? ""); } catch { return ""; } },
  getSetting: (k, fallback) => { try { return game.settings.get(MODULE, k); } catch { return fallback; } },
  setSetting: (k, v) => game.settings.set(MODULE, k, v),
  notify: (level, i18nKey) => { try { ui.notifications?.[level]?.(game.i18n.localize(i18nKey), { permanent: level === "error" }); } catch { /* no ui */ } },
  // W6-S: sent only to the other active GM users (server option `recipients`); the message carries no values.
  emit: () => {
    try {
      const me = game.user?.id;
      const gms = (game.users?.filter?.((u) => u.isGM && u.active && u.id !== me) ?? []).map((u) => u.id);
      if (gms.length) game.socket?.emit?.(`module.${MODULE}`, { type: SOCKET_TYPE }, { recipients: gms });
    } catch { /* no socket */ }
  },
  store: () => createKeyStore(foundryAdapter()),
  isUserGM: (id) => { try { return !!(id && globalThis.game?.users?.get(id)?.isGM); } catch { return false; } },
  onSocket: (handler) => game.socket?.on?.(`module.${MODULE}`, handler),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms)
});

/** Tests: inject fakes. Resets the state. */
export function configureVault(deps = {}) {
  state.deps = { ...defaultDeps(), ...deps };
  state.store = null; state.loaded = false; state.error = null; state.keys = {}; state.migration = "pending";
  ping.running = false; ping.pending = false; ping.timer = null; ping.last = -Infinity;
}
const D = () => state.deps ?? (state.deps = defaultDeps());
const store = () => state.store ?? (state.store = D().store());
const follow = () => { const v = D().getSetting(FOLLOW_STORE, {}); return v && typeof v === "object" ? v : {}; };

/** The key this browser uses for a provider ("" for a non-GM). Raw value; settings.getKey normalises it. */
export function vaultKey(provider) {
  if (!D().isGM()) return "";
  const client = D().getClient(provider);
  const stored = state.keys[provider] ?? "";
  if (follow()[provider]) return state.loaded ? stored : (stored || client);
  if (client && stored && client !== stored) return client;   // conflict: this browser keeps its own copy
  return stored || client;
}

/** Providers whose client copy differs from the store (and this browser has not chosen the store). Names only. */
export function vaultConflicts() {
  if (!D().isGM() || !state.loaded) return [];
  const f = follow();
  return STORE_PROVIDERS.filter((p) => {
    const c = D().getClient(p), s = state.keys[p] ?? "";
    return !f[p] && c && s && c !== s;
  });
}

export const vaultStatus = () => ({ loaded: state.loaded, error: state.error, migration: state.migration, conflicts: vaultConflicts() });

/** Reload the store into memory (GM). Never throws; keeps the old cache on failure. */
export async function reloadVault() {
  if (!D().isGM()) return false;
  const gen = state.gen;
  try {
    const r = await store().load();
    if (gen !== state.gen) return true;   // W6-S: a local save landed meanwhile; its keys are newer than this read
    state.keys = r.keys; state.loaded = true; state.error = null;
    if (r.wasPublic) D().notify("warn", "AIIMG.KeyStore.WasPublic");
    return true;
  } catch (e) {
    state.error = String(e?.message ?? e);
    return false;
  }
}

/**
 * GM, at ready (after the old-id copy): load the store, then copy this browser's client keys that the store lacks.
 * The client copies are never touched. Flag set only after a read-back comparison.
 */
export async function initVault() {
  if (!D().isGM()) { state.migration = "skipped"; return vaultStatus(); }
  if (!(await reloadVault())) {
    state.migration = "failed";
    D().notify("warn", "AIIMG.KeyStore.LoadFailed");
    return vaultStatus();
  }
  if (D().getSetting(MIGRATED_FLAG, false)) { state.migration = "done"; return vaultStatus(); }
  const copy = {};
  for (const p of STORE_PROVIDERS) {
    const c = D().getClient(p);
    if (!c || state.keys[p]) continue;            // nothing to copy, or the store already has one (equal or conflict)
    const { key, ok } = checkApiKey(c);
    if (ok && key) copy[p] = key;                 // a key with a visible non-ASCII char stays client-only (flagged in the window)
  }
  try {
    if (Object.keys(copy).length) {
      const back = await store().save({ ...state.keys, ...copy });
      for (const [p, v] of Object.entries(copy)) if (back[p] !== v) throw new Error("read-back mismatch");
      state.keys = back; state.gen++;
      state.loaded = true;
    }
    await D().setSetting(MIGRATED_FLAG, true);
    state.migration = "done";
    if (Object.keys(copy).length) { D().notify("info", "AIIMG.KeyStore.Migrated"); D().emit(); }
  } catch (e) {
    state.error = String(e?.message ?? e);
    state.migration = "failed";
    D().notify("warn", "AIIMG.KeyStore.MigrateFailed");
  }
  return vaultStatus();
}

/**
 * Keys window save (GM): write the given values (all four providers; "" = no key) to the world store, then make this
 * browser follow the store for them. The client copies are left as they are. Throws (message without values) on failure.
 */
export async function saveVault(values) {
  if (!D().isGM()) throw new Error("GM only");
  const next = { ...state.keys };
  for (const p of STORE_PROVIDERS) if (p in values) next[p] = String(values[p] ?? "");
  const same = STORE_PROVIDERS.every((p) => (next[p] ?? "") === (state.keys[p] ?? ""));
  if (!same || !state.loaded) {
    const back = await store().save(next);
    state.keys = back; state.loaded = true; state.error = null; state.gen++;
    D().emit();
  }
  const f = { ...follow() };
  for (const p of STORE_PROVIDERS) if (p in values) f[p] = true;
  await D().setSetting(FOLLOW_STORE, f);
  return true;
}

// W6-S: the ping is coalesced. A burst of pings gives at most one reload in flight plus one trailing reload, and two
// ping reloads start at least PING_GAP_MS apart. Local calls (initVault, saveVault, the keys window) are not throttled.
export const PING_GAP_MS = 3000;
const ping = { running: false, pending: false, timer: null, last: -Infinity };

function runPingReload() {
  ping.timer = null; ping.pending = false; ping.running = true; ping.last = D().now();
  return reloadVault().finally(() => {
    ping.running = false;
    if (ping.pending) schedulePingReload();
  });
}

function schedulePingReload() {
  if (ping.running || ping.timer) { ping.pending = true; return; }
  const wait = ping.last + PING_GAP_MS - D().now();
  if (wait <= 0) { runPingReload(); return; }
  ping.pending = true;
  ping.timer = D().setTimer(runPingReload, wait);
}

/**
 * Socket handler. Foundry's server relays a module message as (data, senderUserId) with the sender id set by the server
 * (dist/server/sockets.mjs handleCustomSocket), so it cannot be forged. Only a ping from a GM user, received by a GM
 * client, is acted on. Returns true when the ping was accepted (tests).
 */
export function onVaultPing(msg, senderId) {
  if (msg?.type !== SOCKET_TYPE || !D().isGM() || !D().isUserGM(senderId)) return false;
  schedulePingReload();
  return true;
}

/** Other GM clients reload when one GM saved (the message carries no values). */
export function listenVault() {
  try { D().onSocket(onVaultPing); } catch { /* no socket */ }
}
