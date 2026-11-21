// W6-N: the shared "which depth map belongs to this image" lookup, for the sheet portraits (parallax/portrait.mjs) and
// the tokens on the canvas. One question, one answer: image path -> depth map info or null.
//
// Where a map lives (depth/post.mjs depthPathsFor): next to the image, or under `ai-image-gen/_depth/` for images in
// core / system / module folders and URLs. W6-R: every run writes its own files
// `<base>-<ext>-<hash of the full key>.<engine>-<run>_depth.png` (+ `_depth.json` sidecar, `_mask.png`): two images
// never share a file, a run never overwrites another map, the sidecar always belongs to its map. Old (pre-W6-R) files
// `<base>_depth.png` are still read, but only for the image their sidecar names (or, without a sidecar, when no other
// image claims them).
//
// How it is found, without HTTP 404 noise:
// 1. the world index (world setting `depthIndex`, readable by every client, written by a GM): every finished "Generate
//    depth" run records `image -> map` there (run.mjs), and a GM's lookup backfills maps it finds on disk (older runs);
// 2. users who may browse files (GM, by default TRUSTED+) also look at the directory listing (FilePicker.browse, over
//    the socket; one listing per directory, cached) when the index has no entry;
// 3. everyone else (players) sees only what the index knows: a map made by any GM shows up for them as soon as the
//    index changes (setting onChange), no page reload.
// Results are cached per image (positive until the image's entry changes, negative for `negTtlMs` for browsing users and
// until the image's entry changes for the others).
//
// The core (`createDepthIndex`) is pure and takes its storage / listing / permission functions as arguments, so the
// Node tests run it without Foundry. `depthIndex` is the instance bound to Foundry (lazy: no Foundry global is touched
// before the first call).
import { MODULE_ID } from "../constants.mjs";
import { depthPathsFor, parseRunFile } from "./post.mjs";

export const INDEX_SETTING = "depthIndex";
export const INDEX_VERSION = 1;
export const INDEX_MAX = 2000;
export const FORMATS = Object.freeze(["png16", "png-rg16", "gray8"]);
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/**
 * Canonical key of an image source: Data-relative path, no query / hash, no leading slash, forward slashes, decoded
 * EXACTLY ONCE (W6-R: every later step takes the key as it is; a stray `%` stays). Same-origin absolute URLs (an
 * `<img>.src`) become Data paths when `origin` is given; `routePrefix` (Foundry's `ROUTE_PREFIX`) is cut off the
 * front. Other URLs stay as they are (minus query / hash). "" for nothing usable.
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

/**
 * W6-R: a Data path (a key: decoded) as a URL path for fetch: every segment percent-encoded, so `#`, `?`, `%` and spaces
 * in file names survive. URLs (with a scheme) are returned unchanged. Fetch `getRoute(encodeDataPath(info.depth))`.
 */
export function encodeDataPath(path) {
  const s = String(path ?? "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return s.replace(/^\/+/, "").split("/").map((p) => encodeURIComponent(p)).join("/");
}

/** A real image file that may have a map (not core icons, not SVG, not empty). */
export function isDepthCandidate(key) {
  return !!key && !/^icons\//.test(key) && !/\.svg$/i.test(key) && !/(_depth|_mask)\.png$/i.test(key);
}

/**
 * W6-R: a stored map / mask target must be a plain relative Data path: no scheme (http:, data:, javascript:, file:),
 * no leading slash, no backslash, no `..` / `.` / empty segment, no control characters, ≤ 1024 characters.
 */
export function isDataPath(p) {
  if (typeof p !== "string" || !p || p.length > 1024) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg && seg !== "." && seg !== "..");
}

/** Clean one stored entry (from the setting: any shape) or null. `r` = revision (run time in ms; 0 = older entry). */
export function cleanEntry(e) {
  if (!e || typeof e !== "object" || !isDataPath(e.d)) return null;
  return {
    d: e.d,
    f: FORMATS.includes(e.f) ? e.f : null,
    m: isDataPath(e.m) ? e.m : null,
    s: e.s ? 1 : 0,
    t: Number.isFinite(e.t) ? e.t : 0,
    r: Number.isFinite(e.r) && e.r > 0 ? Math.floor(e.r) : 0
  };
}

/**
 * The stored index (any shape) -> {v, maps} with only clean entries, newest INDEX_MAX kept. Stored form is
 * `{v, list: [{k, d, f, m, s, t, r}]}` (toStored): image paths contain dots, and Foundry expands dotted keys of an object
 * setting ("a/hero.webp" -> {"a/hero": {webp: ...}}), seen live on lane 8. `maps` (object form) is read too (tests).
 * W6-R: keys are set as own properties and always read with Object.hasOwn, so "toString" etc. are plain keys.
 */
export function cleanIndex(raw, max = INDEX_MAX) {
  const maps = {};
  const list = [];
  const add = (k, v) => {
    if (typeof k !== "string" || !k || k.length > 1024 || RESERVED_KEYS.has(k)) return;
    const e = cleanEntry(v);
    if (e) list.push([k, e]);
  };
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.list)) for (const it of raw.list) if (it && typeof it === "object") add(it.k, it);
    if (raw.maps && typeof raw.maps === "object") for (const k of Object.keys(raw.maps)) add(k, raw.maps[k]);
  }
  list.sort((a, b) => b[1].t - a[1].t);
  for (const [k, e] of list.slice(0, max)) if (!Object.hasOwn(maps, k)) setOwn(maps, k, e);
  return { v: INDEX_VERSION, maps };
}

/** {v, maps} -> the stored form {v, list} (no image path ever becomes an object key of the setting). */
export function toStored(idx) {
  const c = cleanIndex(idx);
  return { v: INDEX_VERSION, list: Object.keys(c.maps).map((k) => ({ k, ...c.maps[k] })) };
}

/** Public shape of a found map. W6-R: `rev` = revision of the map (new on every run; 0 = older entry). */
function infoOf(image, e, source) {
  return Object.freeze({ image, depth: e.d, format: e.f, mask: e.m, sidecar: !!e.s, source, rev: e.r || 0 });
}

const sigOf = (e) => (e ? `${e.d}|${e.f}|${e.m}|${e.s}|${e.r}` : "");

/**
 * The index core.
 * @param {object} io
 * @param {() => object} io.read                 stored index (any shape; cleaned here)
 * @param {(index:object) => Promise<void>} [io.write]   store the whole index (only called when canWrite())
 * @param {(dir:string) => Promise<string[]>} [io.listDir] file paths in a Data directory (throws / [] when missing)
 * @param {(path:string) => Promise<object|null>} [io.readJson] a Data JSON file (old sidecars); null / throw = unreadable
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
  const verified = new Map();  // key -> d: old-form entries already checked this session
  let pending = new Map();     // key -> {e, soft?, ifD?} (e null = delete) waiting to be written
  let timer = null;
  let chain = Promise.resolve();   // W6-R: one index write in flight at a time
  let seen = null;             // key -> signature of the stored index last seen (diffed on change)
  const stats = { lookups: 0, hits: 0, index: 0, browse: 0, listings: 0, writes: 0, rejected: 0, repaired: 0 };

  // Perf: cleanIndex (clean + sort up to INDEX_MAX entries) ran on EVERY lookup miss: a scene of N tokens with N distinct
  // images did N full cleans synchronously in one refresh. The stored value keeps its identity until the setting changes
  // (Foundry re-casts it on update), so the clean result is reused per raw object; callers get their own `maps` copy
  // (doFlush / resolve add and delete keys on it).
  let memoRaw, memoIdx = null;
  const stored = () => {
    let raw;
    try { raw = io.read?.(); } catch { return cleanIndex(null); }
    if (!memoIdx || raw !== memoRaw || !raw || typeof raw !== "object") {
      try { memoIdx = cleanIndex(raw); } catch { memoIdx = null; return cleanIndex(null); }
      memoRaw = raw;
    }
    const maps = {};
    for (const k of Object.keys(memoIdx.maps)) setOwn(maps, k, memoIdx.maps[k]);
    return { v: memoIdx.v, maps };
  };
  const snapshot = (idx) => { const m = new Map(); for (const k of Object.keys(idx.maps)) m.set(k, sigOf(idx.maps[k])); return m; };
  const read = () => { const idx = stored(); if (!seen) seen = snapshot(idx); return idx; };
  const emit = (keys) => { for (const fn of [...listeners]) { try { fn(keys); } catch (e) { console.error(`${MODULE_ID} | depth index listener`, e); } } };
  const dropKey = (key) => { cache.delete(key); verified.delete(key); try { dirs.delete(depthPathsFor(key).dir); } catch { /* bad key */ } };

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

  async function doFlush() {
    if (!pending.size) return;
    if (!canWrite() || !io.write) { pending = new Map(); return; }
    const batch = pending;
    pending = new Map();
    // read AFTER the previous write finished (chain): a concurrent remember / another GM's entry is merged, not dropped
    const idx = stored();
    let changed = false;
    for (const [k, op] of batch) {
      const old = own(idx.maps, k);
      if (op.e) {
        if (op.soft && old) continue;              // a backfill never replaces an entry written meanwhile
        if (sigOf(old) !== sigOf(op.e)) { setOwn(idx.maps, k, op.e); changed = true; }
      } else if (old && (op.ifD === undefined || old.d === op.ifD)) { delete idx.maps[k]; changed = true; }
    }
    if (!changed) return;                          // no-op: no write, so no client drops anything
    stats.writes++;
    await io.write(toStored(idx));
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    const p = chain.then(doFlush);
    chain = p.catch(() => {});
    return p;
  }

  function queue(key, op, immediate = false) {
    pending.set(key, op);
    if (immediate) return flush();
    if (!timer) timer = setTimeout(() => { flush().catch((e) => console.warn(`${MODULE_ID} | depth index write`, e)); }, writeDelay);
    return Promise.resolve();
  }

  /** Normalised `source` of an old-form sidecar, or null (none listed / unreadable / not ours). */
  async function sidecarSource(metaPath, files, self) {
    if (files ? !files.has(metaPath) : !self?.s) return null;    // only ask for a sidecar known to exist (no 404)
    try {
      const meta = await io.readJson?.(metaPath);
      return meta && typeof meta === "object" && typeof meta.source === "string" ? normalize(meta.source) : null;
    } catch { return null; }
  }

  /**
   * W6-R: may `key` use the OLD-form file `d` (`<base>_depth.png`: shared by every image with that base name in the
   * fallback folder, and by `hero.webp` / `hero.png` side by side)? (1) a newer entry written by a run (format known)
   * for ANOTHER image claims the file -> no; (2) this image's own run entry, nobody newer -> yes; (3) the sidecar names
   * the source -> it must be this image; (4) no sidecar -> only when no other entry points at the file and no sibling
   * image in the listed folder has the same old name.
   */
  async function legacyOk(key, d, { idx, files = null, self = null } = {}) {
    const paths = depthPathsFor(key);
    for (const k of Object.keys(idx.maps)) {
      const e = idx.maps[k];
      if (k !== key && e.d === d && e.f && (!self?.f || e.t > self.t)) return false;
    }
    if (self?.f) return true;
    const src = await sidecarSource(paths.legacy.meta, files, self);
    if (src) return src === key;
    for (const k of Object.keys(idx.maps)) if (k !== key && idx.maps[k].d === d) return false;
    if (files && paths.writable) {
      for (const f of files) if (f !== key && isDepthCandidate(f) && /\.[a-z0-9]+$/i.test(f) && depthPathsFor(f).legacy.depth === d) return false;
    }
    return true;
  }

  /** Newest W6-R run file of the image in a listing, as an entry, or null. */
  function newestRun(paths, files) {
    let best = null;
    for (const f of files) {
      const p = parseRunFile(f, paths.prefix);
      if (!p || p.kind !== "depth") continue;
      if (!best || p.rev > best.rev || (p.rev === best.rev && p.n > best.n)) best = { ...p, path: f };
    }
    if (!best) return null;
    const name = best.path.slice(0, -"_depth.png".length);
    return { d: best.path, f: null, m: files.has(`${name}_mask.png`) ? `${name}_mask.png` : null, s: files.has(`${name}_depth.json`) ? 1 : 0, t: now(), r: best.rev };
  }

  async function resolve(key) {
    const idx = read();
    const e = own(idx.maps, key);
    if (e) {
      // W6-R repair: an old-form entry (maybe backfilled for the wrong image before W6-R) is checked once per session
      const paths = depthPathsFor(key);
      if (!e.r && e.d === paths.legacy.depth && canBrowse() && verified.get(key) !== e.d) {
        if (await legacyOk(key, e.d, { idx, self: e })) verified.set(key, e.d);
        else {
          stats.repaired++;
          if (canWrite() && io.write) queue(key, { e: null, ifD: e.d }).catch(() => {});
          delete idx.maps[key];
          return resolveDisk(key, idx);
        }
      }
      stats.index++;
      return infoOf(key, e, "index");
    }
    return resolveDisk(key, idx);
  }

  async function resolveDisk(key, idx) {
    if (!canBrowse()) return null;
    const paths = depthPathsFor(key);
    const files = await listing(paths.dir);
    let found = newestRun(paths, files);
    if (!found && files.has(paths.legacy.depth)) {
      if (await legacyOk(key, paths.legacy.depth, { idx, files })) {
        found = { d: paths.legacy.depth, f: null, m: files.has(paths.legacy.mask) ? paths.legacy.mask : null, s: files.has(paths.legacy.meta) ? 1 : 0, t: now(), r: 0 };
        verified.set(key, found.d);
      } else stats.rejected++;
    }
    if (!found) return null;
    stats.browse++;
    if (canWrite() && io.write) queue(key, { e: found, soft: true }).catch(() => {});
    return infoOf(key, found, "browse");
  }

  const api = {
    /** Canonical key for an image source (see normalizeImagePath). */
    keyOf: (src) => normalize(src),

    /**
     * File names of `src` (depthPathsFor of its key): {dir, base, ext, hash, stem, writable, prefix, legacy, depth, mask,
     * meta}; with `{engine, run}` depth / mask / meta are that run's names, without them the old names.
     */
    pathsFor: (src, o) => depthPathsFor(normalize(src), o),

    /**
     * The depth map of an image, or null. Cached; parallel calls share one lookup; never throws.
     * @returns {Promise<{image, depth, format, mask, sidecar, source, rev}|null>}
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
     * Record a finished map (GM). `info` = {depth, format?, mask?, sidecar?, rev?} (rev = run time; default: now).
     * Written at once (after any write in flight), listeners fire on every client through the setting's onChange.
     * @returns {Promise<boolean>} false when this user may not write
     */
    async remember(src, info = {}) {
      const key = normalize(src);
      const rev = Number.isFinite(info.rev) && info.rev > 0 ? info.rev : now();
      const e = cleanEntry({ d: normalize(info.depth), f: info.format ?? null, m: info.mask ? normalize(info.mask) : null, s: info.sidecar ? 1 : 0, t: now(), r: rev });
      if (!isDepthCandidate(key) || !e) return false;
      dropKey(key);
      cache.set(key, { info: infoOf(key, e, "index"), at: now(), neg: false });
      verified.set(key, e.d);
      if (!canWrite() || !io.write) { emit([key]); return false; }
      await queue(key, { e }, true);
      emit([key]);
      return true;
    },

    /** Drop an image's entry (GM) and its cache. @returns {Promise<boolean>} */
    async forget(src) {
      const key = normalize(src);
      dropKey(key);
      if (!canWrite() || !io.write || !own(stored().maps, key)) { emit([key]); return false; }
      await queue(key, { e: null }, true);
      emit([key]);
      return true;
    },

    /**
     * A consumer could not load the map it was given (deleted file): believe "no map" here, and a GM removes the
     * index entry (only while it still points at that file) so the other clients stop trying.
     */
    reportMissing(src) {
      const key = normalize(src);
      const old = own(stored().maps, key);
      dropKey(key);
      cache.set(key, { info: null, at: now(), neg: true });
      if (canWrite() && io.write && old) queue(key, { e: null, ifD: old.d }).catch(() => {});
      emit([key]);
    },

    /** Forget cached answers (all, or one image). Listeners fire. */
    invalidate(src) {
      if (src === undefined || src === null) { cache.clear(); dirs.clear(); verified.clear(); emit(null); return; }
      dropKey(normalize(src));
      emit([normalize(src)]);
    },

    /**
     * The stored index changed (setting onChange on any client). W6-R: only images whose entry really changed lose
     * their cached answer (other "no map" answers survive), listeners get those keys; nothing changed -> nothing happens.
     */
    indexChanged() {
      const next = snapshot(stored());
      if (!seen) { seen = next; cache.clear(); dirs.clear(); verified.clear(); emit(null); return; }
      const changed = [];
      for (const [k, s] of next) if (seen.get(k) !== s) changed.push(k);
      for (const k of seen.keys()) if (!next.has(k)) changed.push(k);
      seen = next;
      if (!changed.length) return;
      for (const k of changed) dropKey(k);
      emit(changed);
    },

    /** `fn(keys|null)` after a change (null = anything may have changed). @returns {() => void} unsubscribe */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Every stored entry as public info objects. */
    entries() { const m = stored().maps; return Object.keys(m).map((k) => infoOf(k, m[k], "index")); },

    /** Counters for checks. */
    stats() { return { ...stats, cached: cache.size, dirs: dirs.size, pending: pending.size }; },

    /** Write pending backfills now (tests / before unload); waits for a write in flight first. */
    flush: () => flush()
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

/** An old-form sidecar (only asked for when the directory listing shows it: no 404). */
async function readDataJson(path) {
  const res = await fetch(foundry.utils.getRoute(encodeDataPath(path)), { cache: "no-cache" });
  if (!res.ok) return null;
  return res.json();
}

/** The index bound to this Foundry client (world setting + FilePicker.browse). */
export const depthIndex = createDepthIndex({
  read: () => game.settings.get(MODULE_ID, INDEX_SETTING),
  write: (idx) => game.settings.set(MODULE_ID, INDEX_SETTING, idx),
  listDir: listDataDir,
  readJson: readDataJson,
  canBrowse: () => !!game.user && (game.user.isGM || !!game.user.can?.("FILES_BROWSE")),
  canWrite: () => !!game.user?.isGM,
  normalize: (s) => normalizeImagePath(s, { origin: origin(), routePrefix: routePrefix() })
});

/** Register the hidden world setting (init). */
export function registerDepthIndexSetting() {
  game.settings.register(MODULE_ID, INDEX_SETTING, {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: { v: INDEX_VERSION, list: [] } }),
    onChange: () => depthIndex.indexChanged()
  });
}
