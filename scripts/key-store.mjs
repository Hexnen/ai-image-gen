// W6-H: GM-only, world-persistent store for the API keys (OpenAI, Gemini, OpenRouter, Anthropic), so a GM does not type
// them again in every browser.
//
// Why a FILE and not a document/setting: Foundry v14 sends every world document and every Setting to every client when it
// joins (dist/packages/world.mjs, World.#g: `db.X.dump()` for Users, Actors, Journal, Macros, RollTables, Folders,
// Settings..., no per-user filter; only User.password/passwordSalt are stripped in dist/database/documents/user.mjs), every
// change is broadcast to the other sockets (dist/database/backend/server-backend.mjs `e.broadcast.emit("modifyDocument")`),
// and a compendium `get` has no ownership check (server-backend.mjs _getDocuments; server-compendium.mjs only guards
// create/update/delete), so a player can fetch any pack document over the socket. No document is GM-only.
//
// What IS GM-only: a PRIVATE directory of the "data" file storage. The server hides a private directory from the listing
// of every user below ASSISTANT and refuses to browse it for them (dist/files/local.mjs getFiles: `p.private&&!r` throws,
// private sub-directories are skipped when `!r`; r = isAdmin = ASSISTANT+, dist/files/files.mjs). The store is one file in
// such a directory whose name carries 128 random bits: `worlds/<world>/moinens-ai-gen-keys-<32 hex>/keys.svg`. Nothing
// sends that name to a player; the GM finds it by browsing the world folder (privateDirs). Players can still GET any file
// under Data by its exact URL (express.static), so the random name is what keeps them out: it is a capability URL.
// Caveat: the server lets any user with FILES_BROWSE (TRUSTED by default) call configurePath, so such a user who LEARNS the
// directory name could make it public again; without the name they cannot. Anyone with file access to the server, the world
// folder or a world backup can read the keys (base64, not encryption).
//
// Why .svg: the server refuses to overwrite a non-media file (json/txt) on upload (local.mjs upload: "You may not upload
// non-media files which would overwrite an existing file"), and there is no delete call for clients, so a json store would
// leave one stale file per save. An SVG is a media type, overwritten in place: one file, the payload in an XML comment.
//
// The core (createKeyStore) takes an adapter, so node tests run it without Foundry. Nothing here logs or returns a key in a
// message; errors name paths and steps only.

export const STORE_PREFIX = "moinens-ai-gen-keys-";
export const STORE_FILE = "keys.svg";
export const STORE_VERSION = 1;
export const STORE_PROVIDERS = Object.freeze(["openai", "gemini", "openrouter", "anthropic"]);
const MARK = "moinens-ai-gen-keys:";

const b64encode = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (b64) => {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** Only the known providers, strings only. */
export function cleanKeys(keys) {
  const out = {};
  for (const p of STORE_PROVIDERS) {
    const v = keys?.[p];
    if (typeof v === "string" && v) out[p] = v;
  }
  return out;
}

/** The SVG text holding the keys (base64 JSON inside a comment; renders as an empty 1x1 image). */
export function encodeStore(keys) {
  const payload = b64encode(JSON.stringify({ v: STORE_VERSION, keys: cleanKeys(keys) }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--${MARK}${payload}--></svg>\n`;
}

/** Keys from the SVG text; throws on a file that is not ours or is damaged (message without content). */
export function decodeStore(text) {
  const m = /<!--moinens-ai-gen-keys:([A-Za-z0-9+/=]*)-->/.exec(String(text ?? ""));
  if (!m) throw new Error("key store file is not in the expected format");
  let data;
  try { data = JSON.parse(b64decode(m[1])); } catch { throw new Error("key store file is damaged"); }
  if (!data || typeof data !== "object") throw new Error("key store file is damaged");
  return cleanKeys(data.keys);
}

/** 128 random bits as 32 hex characters. */
export function randomName(rng = globalThis.crypto) {
  const a = new Uint8Array(16);
  rng.getRandomValues(a);
  return STORE_PREFIX + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const base = (p) => decodeURIComponent(String(p ?? "").replace(/\/+$/, "").split("/").pop() ?? "");
const strip = (p) => String(p ?? "").replace(/\/+$/, "");

/**
 * adapter = {
 *   parent: "worlds/<id>",                         folder that holds the private store directory
 *   browse(target) -> { dirs: [], privateDirs: [], files: [] }   (FilePicker.browse "data")
 *   createDirectory(target), configurePath(target, { private }), upload(dir, fileName, text) -> truthy on success,
 *   fetchText(path) -> string | null (null = no file)
 * }
 */
export function createKeyStore(adapter) {
  let dir = null;          // located store directory (client path), null = none yet

  /** Find the store directory. Re-privatises one that lost its flag. { dir, wasPublic } */
  async function locate() {
    const res = await adapter.browse(adapter.parent);
    const priv = new Set((res?.privateDirs ?? []).map(strip));
    const found = (res?.dirs ?? []).map(strip).filter((d) => base(d).startsWith(STORE_PREFIX)).sort();
    if (!found.length) { dir = null; return { dir: null, wasPublic: false }; }
    // prefer a private one; if two GMs created one at the same time, the first by name wins (deterministic)
    const pick = found.find((d) => priv.has(d)) ?? found[0];
    let wasPublic = false;
    if (!priv.has(pick)) {
      wasPublic = true;
      await adapter.configurePath(pick, { private: true });
      await assertPrivate(pick);
    }
    dir = pick;
    return { dir, wasPublic };
  }

  async function assertPrivate(target) {
    const res = await adapter.browse(adapter.parent);
    const priv = new Set((res?.privateDirs ?? []).map(strip));
    if (!priv.has(strip(target))) throw new Error("the key store directory could not be made private");
  }

  /** Keys in the store ({} when there is no store yet). */
  async function load() {
    const { wasPublic } = await locate();
    if (!dir) return { keys: {}, exists: false, wasPublic };
    const text = await adapter.fetchText(`${dir}/${STORE_FILE}`);
    if (text === null || text === undefined) return { keys: {}, exists: false, wasPublic };
    return { keys: decodeStore(text), exists: true, wasPublic };
  }

  /** Write the whole key map. Creates the private directory first; never writes into a directory that is not private. */
  async function save(keys) {
    if (!dir) await locate();
    if (!dir) {
      const target = `${strip(adapter.parent)}/${randomName(adapter.rng)}`;
      await adapter.createDirectory(target);
      await adapter.configurePath(target, { private: true });
      dir = target;
    }
    await assertPrivate(dir);
    const ok = await adapter.upload(dir, STORE_FILE, encodeStore(keys));
    if (!ok) throw new Error("the key store file could not be uploaded");
    // read back and compare (the caller never sees the values in an error)
    const text = await adapter.fetchText(`${dir}/${STORE_FILE}`);
    const back = text == null ? null : decodeStore(text);
    const want = cleanKeys(keys);
    if (!back || JSON.stringify(back) !== JSON.stringify(want)) throw new Error("the key store did not read back the saved keys");
    return back;
  }

  return { locate, load, save, get dir() { return dir; } };
}

/** The Foundry adapter (GM client). */
export function foundryAdapter() {
  const FP = foundry.applications.apps.FilePicker.implementation;
  return {
    parent: `worlds/${game.world.id}`,
    browse: (target) => FP.browse("data", target),
    createDirectory: (target) => FP.createDirectory("data", target),
    configurePath: (target, opts) => FP.configurePath("data", target, opts),
    upload: async (target, name, text) => {
      const file = new File([text], name, { type: "image/svg+xml" });
      const r = await FP.upload("data", target, file, {}, { notify: false });
      return !!r?.path;
    },
    fetchText: async (path) => {
      const url = `${foundry.utils.getRoute(path)}?v=${Date.now()}`;
      const r = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`key store read failed (HTTP ${r.status})`);
      return r.text();
    }
  };
}
