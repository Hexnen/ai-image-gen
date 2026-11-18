// W6-N: the shared "which depth map belongs to this image" lookup, for the sheet portraits (parallax/portrait.mjs) and
// later for tokens on the canvas. One question, one answer: image path -> depth map info or null.
//
// Where a map lives: next to the image as `<name>_depth.png` (+ `_depth.json` sidecar, `_mask.png`), or under
// `ai-image-gen/_depth/` for images in core / system / module folders and URLs (depth/post.mjs depthPathsFor).
//
// How it is found, without HTTP 404 noise:
// 1. the world index (world setting `depthIndex`, readable by every client, written by a GM): every finished "Generate
//    depth" run records `image -> map` there (run.mjs), and a GM's lookup backfills maps it finds on disk (older runs);
// 2. users who may browse files (GM, by default TRUSTED+) also look at the directory listing (FilePicker.browse, over
//    the socket; one listing per directory, cached) when the index has no entry;
// 3. everyone else (players) sees only what the index knows: a map made by any GM shows up for them as soon as the
//    index changes (setting onChange), no page reload.
// Results are cached per image (positive until the index changes, negative for `negTtlMs` for browsing users and until
// the index changes for the others).
//
// The core (`createDepthIndex`) is pure and takes its storage / listing / permission functions as arguments, so the
// Node tests run it without Foundry. `depthIndex` is the instance bound to Foundry (lazy: no Foundry global is touched
// before the first call).
import { MODULE_ID } from "../constants.mjs";
import { depthPathsFor } from "./post.mjs";

export const INDEX_SETTING = "depthIndex";
export const INDEX_VERSION = 1;
export const INDEX_MAX = 2000;
export const FORMATS = Object.freeze(["png16", "png-rg16", "gray8"]);

/**
 * Canonical key of an image source: Data-relative path, no query / hash, no leading slash, forward slashes, decoded.
 * Same-origin absolute URLs (an `<img>.src`) become Data paths when `origin` is given; `routePrefix` (Foundry's
 * `ROUTE_PREFIX`) is cut off the front. Other URLs stay as they are (minus query / hash). "" for nothing usable.
 */
export function normalizeImagePath(src, { origin = "", routePrefix = "" } = {}) {
  let s = String(src ?? "").trim();
  if (!s || /^(data|blob):/i.test(s)) return "";
  if (origin && s.startsWith(`${origin}/`)) s = s.slice(origin.length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s.split(/[?#]/)[0];
  s = s.split(/[?#]/)[0].replace(/\\/g, "/");
  try { s = decodeURIComponent(s); } catch { /* keep the raw text: a stray % is a valid file name character */ }
  s = s.replace(/^\/+/, "");
  const pre = String(routePrefix ?? "").replace(/^\/+|\/+$/g, "");
  if (pre && s.startsWith(`${pre}/`)) s = s.slice(pre.length + 1);
  return s;
}

/** A real image file that may have a map (not core icons, not SVG, not empty). */
export function isDepthCandidate(key) {
  return !!key && !/^icons\//.test(key) && !/\.svg$/i.test(key) && !/(_depth|_mask)\.png$/i.test(key);
}

/** Clean one stored entry (from the setting: any shape) or null. */
export function cleanEntry(e) {
  if (!e || typeof e !== "object" || typeof e.d !== "string" || !e.d || e.d.length > 1024) return null;
  if (/^(data|blob|javascript):/i.test(e.d)) return null;
  return {
    d: e.d,
    f: FORMATS.includes(e.f) ? e.f : null,
    m: typeof e.m === "string" && e.m && e.m.length <= 1024 && !/^(data|blob|javascript):/i.test(e.m) ? e.m : null,
    s: e.s ? 1 : 0,
    t: Number.isFinite(e.t) ? e.t : 0
  };
}

/** The stored index (any shape) -> {v, maps} with only clean entries, newest INDEX_MAX kept. */
export function cleanIndex(raw, max = INDEX_MAX) {
  const maps = {};
  const src = raw && typeof raw === "object" && raw.maps && typeof raw.maps === "object" ? raw.maps : {};
  const list = [];
  for (const [k, v] of Object.entries(src)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const e = cleanEntry(v);
    if (e && k) list.push([k, e]);
  }
  list.sort((a, b) => b[1].t - a[1].t);
  for (const [k, e] of list.slice(0, max)) maps[k] = e;
  return { v: INDEX_VERSION, maps };
}

/** Public shape of a found map. */
function infoOf(image, e, source) {
  return Object.freeze({ image, depth: e.d, format: e.f, mask: e.m, sidecar: !!e.s, source });
}

/**
 * The index core.
 * @param {object} io
 * @param {() => object} io.read                 stored index (any shape; cleaned here)
 * @param {(index:object) => Promise<void>} [io.write]   store the whole index (only called when canWrite())
 * @param {(dir:string) => Promise<string[]>} [io.listDir] file paths in a Data directory (throws / [] when missing)
 * @param {() => boolean} [io.canBrowse]         may this user list directories?
 * @param {() => boolean} [io.canWrite]          may this user write the index? (GM)
 * @param {() => number} [io.now]
 * @param {(src:string) => string} [io.normalize]
 * @param {number} [io.negTtlMs]                 how long "no map" is believed for a browsing user
 * @param {number} [io.dirTtlMs]                 how long a directory listing is reused
 * @param {number} [io.writeDelayMs]             backfill writes are batched over this delay
 */
export function createDepthIndex(io) {
  const now = io.now ?? (() => Date.now());
  const normalize = io.normalize ?? ((s) => normalizeImagePath(s));
  const canBrowse = io.canBrowse ?? (() => false);
  const canWrite = io.canWrite ?? (() => false);
  const negTtl = io.negTtlMs ?? 30_000;
  const dirTtl = io.dirTtlMs ?? 30_000;
  const writeDelay = io.writeDelayMs ?? 1500;

  const cache = new Map();     // key -> {info|null, at, neg}
  const inflight = new Map();  // key -> Promise
  const dirs = new Map();      // dir -> {at, p: Promise<Set<string>>}
  const listeners = new Set();
  let pending = new Map();     // key -> entry|null (backfill / forget waiting to be written)
  let timer = null;
  let stats = { lookups: 0, hits: 0, index: 0, browse: 0, listings: 0, writes: 0 };

  const stored = () => { try { return cleanIndex(io.read?.()); } catch { return cleanIndex(null); } };
  const emit = (keys) => { for (const fn of [...listeners]) { try { fn(keys); } catch (e) { console.error(`${MODULE_ID} | depth index listener`, e); } } };

  function listing(dir) {
    const hit = dirs.get(dir);
    if (hit && now() - hit.at < dirTtl) return hit.p;
    stats.listings++;
    const p = Promise.resolve().then(() => io.listDir?.(dir) ?? []).then(
      (files) => new Set((files ?? []).map((f) => normalize(f))),
      () => new Set()
    );
    dirs.set(dir, { at: now(), p });
    return p;
  }

  async function flush() {
    timer = null;
    if (!pending.size || !canWrite() || !io.write) { pending = new Map(); return; }
    const batch = pending;
    pending = new Map();
    const idx = stored();
    let changed = false;
    for (const [k, e] of batch) {
      if (e) { const old = idx.maps[k]; if (!old || old.d !== e.d || old.f !== e.f || old.m !== e.m || old.s !== e.s) { idx.maps[k] = e; changed = true; } }
      else if (idx.maps[k]) { delete idx.maps[k]; changed = true; }
    }
    if (!changed) return;
    stats.writes++;
    await io.write(cleanIndex(idx));
  }

  function queue(key, entry, immediate = false) {
    pending.set(key, entry);
    if (immediate) { clearTimeout(timer); return flush(); }
    if (!timer) timer = setTimeout(() => { flush().catch((e) => console.warn(`${MODULE_ID} | depth index write`, e)); }, writeDelay);
    return Promise.resolve();
  }

  async function resolve(key) {
    const e = stored().maps[key];
    if (e) { stats.index++; return infoOf(key, e, "index"); }
    if (!canBrowse()) return null;
    const paths = depthPathsFor(key);
    const files = await listing(paths.dir);
    if (!files.has(normalize(paths.depth))) return null;
    stats.browse++;
    const found = { d: paths.depth, f: null, m: files.has(normalize(paths.mask)) ? paths.mask : null, s: files.has(normalize(paths.meta)) ? 1 : 0, t: now() };
    if (canWrite() && io.write) queue(key, found).catch(() => {});
    return infoOf(key, found, "browse");
  }

  const api = {
    /** Canonical key for an image source (see normalizeImagePath). */
    keyOf: (src) => normalize(src),

    /** Where the module writes / looks for the map of `src` ({dir, base, writable, depth, mask, meta}). */
    pathsFor: (src) => depthPathsFor(normalize(src)),

    /**
     * The depth map of an image, or null. Cached; parallel calls share one lookup; never throws.
     * @returns {Promise<{image, depth, format, mask, sidecar, source}|null>}
     */
    async lookup(src) {
      stats.lookups++;
      const key = normalize(src);
      if (!isDepthCandidate(key)) return null;
      const c = cache.get(key);
      if (c && (!c.neg || !canBrowse() || now() - c.at < negTtl)) { stats.hits++; return c.info; }
      if (inflight.has(key)) return inflight.get(key);
      const p = resolve(key).catch(() => null).then((info) => {
        inflight.delete(key);
        cache.set(key, { info, at: now(), neg: !info });
        return info;
      });
      inflight.set(key, p);
      return p;
    },

    /** Cached answer without any I/O: info, null (known: no map) or undefined (not looked up yet). */
    peek(src) {
      const key = normalize(src);
      if (!isDepthCandidate(key)) return null;
      const c = cache.get(key);
      if (!c) return undefined;
      if (c.neg && canBrowse() && now() - c.at >= negTtl) return undefined;
      return c.info;
    },

    /**
     * Record a finished map (GM). `info` = {depth, format?, mask?, sidecar?}. Written at once (not batched), listeners
     * fire on every client through the setting's onChange. @returns {Promise<boolean>} false when this user may not write
     */
    async remember(src, info = {}) {
      const key = normalize(src);
      const e = cleanEntry({ d: normalize(info.depth), f: info.format ?? null, m: info.mask ? normalize(info.mask) : null, s: info.sidecar ? 1 : 0, t: now() });
      if (!isDepthCandidate(key) || !e) return false;
      cache.set(key, { info: infoOf(key, e, "index"), at: now(), neg: false });
      dirs.delete(depthPathsFor(key).dir);
      if (!canWrite() || !io.write) { emit([key]); return false; }
      await queue(key, e, true);
      emit([key]);
      return true;
    },

    /** Drop an image's entry (GM) and its cache. @returns {Promise<boolean>} */
    async forget(src) {
      const key = normalize(src);
      cache.delete(key);
      dirs.delete(depthPathsFor(key).dir);
      if (!canWrite() || !io.write || !stored().maps[key]) { emit([key]); return false; }
      await queue(key, null, true);
      emit([key]);
      return true;
    },

    /**
     * A consumer could not load the map it was given (deleted file): believe "no map" here, and a GM removes the
     * index entry so the other clients stop trying.
     */
    reportMissing(src) {
      const key = normalize(src);
      cache.set(key, { info: null, at: now(), neg: true });
      dirs.delete(depthPathsFor(key).dir);
      if (canWrite() && io.write && stored().maps[key]) queue(key, null).catch(() => {});
      emit([key]);
    },

    /** Forget cached answers (all, or one image). Listeners fire. */
    invalidate(src) {
      if (src === undefined || src === null) { cache.clear(); dirs.clear(); emit(null); return; }
      const key = normalize(src);
      cache.delete(key);
      dirs.delete(depthPathsFor(key).dir);
      emit([key]);
    },

    /** The stored index changed (setting onChange on any client): drop the cache, tell the listeners. */
    indexChanged() { cache.clear(); dirs.clear(); emit(null); },

    /** `fn(keys|null)` after a change (null = anything may have changed). @returns {() => void} unsubscribe */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Every stored entry as public info objects. */
    entries() { return Object.entries(stored().maps).map(([k, e]) => infoOf(k, e, "index")); },

    /** Counters for checks. */
    stats() { return { ...stats, cached: cache.size, dirs: dirs.size, pending: pending.size }; },

    /** Write pending backfills now (tests / before unload). */
    flush: () => { clearTimeout(timer); return flush(); }
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// Foundry binding
// ---------------------------------------------------------------------------------------------------------------

const origin = () => globalThis.location?.origin ?? "";
const routePrefix = () => globalThis.foundry?.utils?.getRoute?.("/")?.replace(/^\/+|\/+$/g, "") ?? "";

async function listDataDir(dir) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  const res = await FP.browse("data", dir);
  return (res?.files ?? []).map(String);
}

/** The index bound to this Foundry client (world setting + FilePicker.browse). */
export const depthIndex = createDepthIndex({
  read: () => game.settings.get(MODULE_ID, INDEX_SETTING),
  write: (idx) => game.settings.set(MODULE_ID, INDEX_SETTING, idx),
  listDir: listDataDir,
  canBrowse: () => !!game.user && (game.user.isGM || !!game.user.can?.("FILES_BROWSE")),
  canWrite: () => !!game.user?.isGM,
  normalize: (s) => normalizeImagePath(s, { origin: origin(), routePrefix: routePrefix() })
});

/** Register the hidden world setting (init). */
export function registerDepthIndexSetting() {
  game.settings.register(MODULE_ID, INDEX_SETTING, {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: { v: INDEX_VERSION, maps: {} } }),
    onChange: () => depthIndex.indexChanged()
  });
}
