// W6-R: depth STORE / INDEX / GENERATION fixes. Pure Node, real modules, stubbed Foundry I/O: NO paid call, NO key,
// NO network. Covers: per-image file names (the owner's atom-eve collision), old-form files accepted only for the image
// their sidecar names (and index repair), never overwriting a listed file, revision `r` in the index and lookup info,
// `%` / `#` / `?` names + encodeDataPath, chained index writes with a write in flight, entry validation incl. prototype
// names, cache diff on index change, the paid picture saved before post-processing + "save again" without paying,
// upload retry / session stop, abort before the paid call and before post-processing, the window's result guard and
// error text. Run from the module folder: node dev/test-depth-store.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// Foundry stubs (only touched at call time / for the window class)
const F = class {};
globalThis.foundry ??= {};
foundry.data ??= { fields: { NumberField: F, StringField: F, ObjectField: F, BooleanField: F, DataField: F } };
foundry.utils ??= { escapeHTML: (s) => s, getRoute: (p) => `/${p}` };
foundry.applications ??= { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (B) => class extends B {}, DialogV2: { confirm: async () => true } } };
globalThis.game ??= { settings: { get: () => undefined }, user: { isGM: true }, i18n: { localize: (k) => k, format: (k) => k, has: () => false }, modules: new Map() };

const { depthPathsFor, parseRunFile, hashKey, DEPTH_FALLBACK_DIR } = await import("../scripts/depth/post.mjs");
const { createDepthIndex, cleanIndex, cleanEntry, isDataPath, normalizeImagePath, encodeDataPath, toStored } = await import("../scripts/depth/depth-index.mjs");
const { runDepth, freeRunPaths, uploadWithRetry, DEPTH_CANDIDATE_DIR } = await import("../scripts/depth/run.mjs");
const { normalizeDepth } = await import("../scripts/depth-settings.mjs");
const { depthErrorText, resultMatches } = await import("../scripts/depth/depth-app.mjs");

const ATOM = [
  "modules/invincible-core/assets/actors/atom-eve.webp",
  "modules/invincible-core/assets/tokens/atom-eve.webp",
  "systems/invincible/assets/portraits/atom-eve.webp",
  "systems/invincible/assets/tokens/atom-eve.webp"
];

/** A world: one stored index shared by clients, a fake Data folder (files + JSON contents), a clock. */
function world(files = [], json = {}) {
  const w = { store: { v: 1, list: [] }, files: new Set(files), json: { ...json }, t: 1000, listings: [], reads: [], writes: 0, clients: [] };
  w.client = ({ gm = true, browse = gm, write } = {}) => {
    const idx = createDepthIndex({
      read: () => structuredClone(w.store),
      write: write ?? (async (x) => { w.writes++; w.store = structuredClone(x); for (const c of w.clients) c.indexChanged(); }),
      listDir: async (dir) => { w.listings.push(dir); return [...w.files].filter((f) => f.slice(0, f.lastIndexOf("/")) === dir).map(encodeDataPath); },
      readJson: async (p) => { w.reads.push(p); if (!(p in w.json)) throw new Error("404"); return structuredClone(w.json[p]); },
      canBrowse: () => browse, canWrite: () => gm, now: () => w.t, writeDelayMs: 0
    });
    w.clients.push(idx);
    return idx;
  };
  w.maps = () => cleanIndex(w.store).maps;
  return w;
}

// ------------------------------------------------------------------ 1. names

await test("names: the four atom-eve images (and hero.webp / hero.png) never share a file; deterministic; old names kept as `legacy`", () => {
  const runs = ATOM.map((k) => depthPathsFor(k, { engine: "browser", run: "abc" }));
  assert.equal(new Set(runs.map((p) => p.depth)).size, 4, runs.map((p) => p.depth).join("\n"));
  for (const p of runs) {
    assert.ok(p.depth.startsWith(`${DEPTH_FALLBACK_DIR}/atom-eve-webp-`), p.depth);
    assert.match(p.depth, /\.browser-abc_depth\.png$/);
    assert.equal(p.meta, p.depth.replace(/_depth\.png$/, "_depth.json"), "sidecar next to its own map");
    assert.equal(p.legacy.depth, `${DEPTH_FALLBACK_DIR}/atom-eve_depth.png`, "the old shared name is only kept for reading");
  }
  assert.notEqual(depthPathsFor("worlds/a/hero.webp", { engine: "browser", run: "1" }).depth, depthPathsFor("worlds/a/hero.png", { engine: "browser", run: "1" }).depth);
  assert.notEqual(depthPathsFor("worlds/a/My Hero.webp").stem, depthPathsFor("worlds/a/My-Hero.webp").stem, "sanitised names do not merge");
  assert.equal(depthPathsFor(ATOM[0]).stem, depthPathsFor(ATOM[0]).stem);
  assert.equal(hashKey(ATOM[0]), hashKey(ATOM[0]));
  assert.equal(hashKey(ATOM[0]).length, 10);
  const b = depthPathsFor("worlds/a/hero.webp", { engine: "browser", run: "x1" }), g = depthPathsFor("worlds/a/hero.webp", { engine: "generative", run: "x1" });
  assert.notEqual(b.depth, g.depth, "engine in the name: compare mode shows two files");
  assert.equal(b.dir, "worlds/a", "writable folders keep the map next to the image");
  const pr = parseRunFile(depthPathsFor("worlds/a/hero.webp", { engine: "generative", run: (123456789).toString(36) }).depth, b.prefix);
  assert.deepEqual([pr.kind, pr.engine, pr.rev], ["depth", "generative", 123456789]);
  assert.equal(parseRunFile("worlds/a/hero_depth.png", b.prefix), null);
});

await test("% / # / ? names: decoded exactly once, never again; encodeDataPath per segment", () => {
  assert.equal(normalizeImagePath("worlds/x/a%2520b.webp"), "worlds/x/a%20b.webp", "a file literally named a%20b.webp");
  assert.equal(normalizeImagePath("worlds/x/100%.webp"), "worlds/x/100%.webp");
  const lit = depthPathsFor("worlds/x/a%20b.webp"), sp = depthPathsFor("worlds/x/a b.webp");
  assert.notEqual(lit.stem, sp.stem, "a%20b.webp and 'a b.webp' keep their own maps");
  assert.doesNotThrow(() => depthPathsFor("worlds/x/100%.webp", { engine: "browser", run: "1" }));
  assert.equal(encodeDataPath("worlds/x/a%20b #1?.webp"), "worlds/x/a%2520b%20%231%3F.webp");
  assert.equal(encodeDataPath("/worlds/x/a.webp"), "worlds/x/a.webp");
  assert.equal(encodeDataPath("https://cdn.example/a b.webp"), "https://cdn.example/a b.webp", "URLs untouched");
  assert.equal(normalizeImagePath(encodeDataPath("worlds/x/a%20b #1?.webp")), "worlds/x/a%20b #1?.webp", "round trip");
});

// ------------------------------------------------------------------ 2. index: entries, prototype names

await test("entries: d / m must be relative Data paths; prototype names are plain keys", async () => {
  for (const bad of ["../etc/a.png", "a/../b.png", "/abs/a.png", "//host/a.png", "http://x/a.png", "javascript:alert(1)", "data:x", "file:///c/a.png", "C:\\a.png", "a\\b.png", "a//b.png", "./a.png", "a\u0000.png", ""]) {
    assert.equal(isDataPath(bad), false, bad);
    assert.equal(cleanEntry({ d: bad }), null, bad);
  }
  assert.equal(isDataPath("worlds/x/a b_depth.png"), true);
  assert.equal(cleanEntry({ d: "worlds/x/a_depth.png", m: "../m.png" }).m, null);
  const c = cleanIndex({ list: [{ k: "toString", d: "t_depth.png", t: 1 }, { k: "hasOwnProperty", d: "h_depth.png", t: 2 }, { k: "__proto__", d: "p.png" }, { k: "constructor", d: "c.png" }] });
  assert.deepEqual(Object.keys(c.maps).sort(), ["hasOwnProperty", "toString"]);
  assert.equal(typeof cleanIndex(null).maps.toString, "function", "plain object, but never read without hasOwn");
  const w = world([]);
  const gm = w.client();
  assert.equal(await gm.lookup("toString"), null, "an inherited name is not an entry");
  assert.equal(await gm.lookup("worlds/x/constructor"), null);
  assert.equal(await gm.remember("toString", { depth: "worlds/x/t_depth.png", format: "png16" }), true);
  const other = w.client({ gm: false, browse: false });
  assert.equal((await other.lookup("toString")).depth, "worlds/x/t_depth.png");
  assert.equal(await gm.remember("worlds/x/a.webp", { depth: "https://evil.example/a.png" }), false);
  assert.equal(await gm.remember("worlds/x/a.webp", { depth: "../../a_depth.png" }), false);
  assert.deepEqual(toStored({ maps: { "x.webp": { d: "/x.png" } } }).list, []);
});

// ------------------------------------------------------------------ 3. index: old-form files and the sidecar source

await test("backfill: an old shared `_depth/atom-eve_depth.png` attaches ONLY to the image its sidecar names", async () => {
  const L = `${DEPTH_FALLBACK_DIR}/atom-eve`;
  const w = world([`${L}_depth.png`, `${L}_depth.json`], { [`${L}_depth.json`]: { source: encodeDataPath(ATOM[2]) } });
  const gm = w.client();
  const res = await Promise.all(ATOM.map((k) => gm.lookup(k)));
  assert.deepEqual(res.map((r) => r?.depth ?? null), [null, null, `${L}_depth.png`, null]);
  await gm.flush();
  assert.deepEqual(Object.keys(w.maps()), [ATOM[2]], "only the portrait gets the index entry");
  assert.equal(gm.stats().listings, 1, "one listing of the fallback folder for all four");
  assert.ok(gm.stats().rejected >= 3);
});

await test("backfill: old file whose sidecar names ANOTHER image is never used; no sidecar + sole image = still read (old runs)", async () => {
  const w = world([`${DEPTH_FALLBACK_DIR}/hero_depth.png`, `${DEPTH_FALLBACK_DIR}/hero_depth.json`, `${DEPTH_FALLBACK_DIR}/solo_depth.png`],
    { [`${DEPTH_FALLBACK_DIR}/hero_depth.json`]: { source: "modules/x/actors/hero.webp" } });
  const gm = w.client();
  assert.equal(await gm.lookup("modules/x/tokens/hero.webp"), null);
  assert.equal((await gm.lookup("systems/y/solo.webp")).depth, `${DEPTH_FALLBACK_DIR}/solo_depth.png`, "no sidecar, nobody else: kept working");
  // next to the image: hero.webp and hero.png side by side, old file without sidecar -> ambiguous, nobody gets it
  const w2 = world(["worlds/a/hero.webp", "worlds/a/hero.png", "worlds/a/hero_depth.png", "worlds/a/solo.webp", "worlds/a/solo_depth.png"]);
  const g2 = w2.client();
  assert.equal(await g2.lookup("worlds/a/hero.webp"), null);
  assert.equal(await g2.lookup("worlds/a/hero.png"), null);
  assert.equal((await g2.lookup("worlds/a/solo.webp")).depth, "worlds/a/solo_depth.png");
});

await test("repair: an old WRONG index entry (backfilled for the token before W6-R) is dropped on the GM's lookup; right ones stay", async () => {
  const L = `${DEPTH_FALLBACK_DIR}/atom-eve`;
  const w = world([`${L}_depth.png`, `${L}_depth.json`], { [`${L}_depth.json`]: { source: ATOM[2] } });
  w.store.list = [
    { k: ATOM[1], d: `${L}_depth.png`, f: null, m: null, s: 1, t: 50 },   // backfilled for the wrong image
    { k: ATOM[2], d: `${L}_depth.png`, f: null, m: null, s: 1, t: 40 },   // backfilled for the right one
    { k: "worlds/x/a.webp", d: "worlds/x/a_depth.png", f: "png16", m: null, s: 1, t: 30 } // a run's entry: untouched
  ];
  const player = w.client({ gm: false, browse: false });
  assert.equal((await player.lookup(ATOM[1])).depth, `${L}_depth.png`, "players read the index as it is (no check)");
  const gm = w.client();
  assert.equal(await gm.lookup(ATOM[1]), null, "GM: sidecar says another source -> entry dropped");
  assert.equal((await gm.lookup(ATOM[2])).depth, `${L}_depth.png`);
  assert.equal((await gm.lookup("worlds/x/a.webp")).depth, "worlds/x/a_depth.png");
  await gm.flush();
  assert.deepEqual(Object.keys(w.maps()).sort(), [ATOM[2], "worlds/x/a.webp"].sort());
  assert.equal(await player.lookup(ATOM[1]), null, "the repair reaches players through the index change");
  // a run's old-form entry that a NEWER run of another image overwrote: the newer run claims the file
  const w3 = world([`${L}_depth.png`, `${L}_depth.json`], { [`${L}_depth.json`]: { source: ATOM[0] } });
  w3.store.list = [
    { k: ATOM[0], d: `${L}_depth.png`, f: "png16", m: null, s: 1, t: 10 },
    { k: ATOM[3], d: `${L}_depth.png`, f: "png16", m: null, s: 1, t: 20 }
  ];
  const g3 = w3.client();
  assert.equal(await g3.lookup(ATOM[0]), null, "older run, the file was overwritten by a newer run (stale sidecar ignored)");
  assert.equal((await g3.lookup(ATOM[3])).depth, `${L}_depth.png`);
});

await test("repair check asks for an old sidecar only when the entry says it exists (no 404)", async () => {
  const L = `${DEPTH_FALLBACK_DIR}/solo`;
  const w = world([`${L}_depth.png`]);
  w.store.list = [{ k: "systems/y/solo.webp", d: `${L}_depth.png`, f: null, m: null, s: 0, t: 5 }];
  const gm = w.client();
  assert.equal((await gm.lookup("systems/y/solo.webp")).depth, `${L}_depth.png`);
  assert.deepEqual(w.reads, []);
  assert.deepEqual(w.listings, [], "an index hit needs no listing");
});

await test("new-form files: found by listing, newest run wins, mask + sidecar detected, rev in the info; another image's files ignored", async () => {
  const k = ATOM[1];
  const a = depthPathsFor(k, { engine: "browser", run: (5000).toString(36) });
  const b = depthPathsFor(k, { engine: "generative", run: (9000).toString(36) });
  const other = depthPathsFor(ATOM[0], { engine: "browser", run: (99999).toString(36) });
  const w = world([a.depth, a.meta, b.depth, b.meta, b.mask, other.depth, `${DEPTH_FALLBACK_DIR}/atom-eve_depth.png`]);
  const gm = w.client();
  const info = await gm.lookup(k);
  assert.deepEqual([info.depth, info.mask, info.sidecar, info.rev, info.source], [b.depth, b.mask, true, 9000, "browse"]);
  assert.equal(w.reads.length, 0, "new names need no sidecar read");
  await gm.flush();
  assert.equal(w.maps()[k].r, 9000);
});

// ------------------------------------------------------------------ 4. index: revisions, writes, cache

await test("rev: a re-run with the same path but a new revision is written and reaches every client", async () => {
  const w = world();
  const gm = w.client(), p = w.client({ gm: false, browse: false });
  await gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png16", rev: 111 });
  assert.equal((await p.lookup("worlds/x/a.webp")).rev, 111);
  const heard = [];
  p.onChange((ks) => heard.push(ks));
  await gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png16", rev: 222 });
  assert.equal(w.writes, 2, "same d/f/m/s but a new r is a change");
  assert.deepEqual(heard, [["worlds/x/a.webp"]]);
  assert.equal((await p.lookup("worlds/x/a.webp")).rev, 222);
  await gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png16", rev: 222 });
  assert.equal(w.writes, 2, "identical: no write");
});

await test("flush chaining: a write in flight is awaited, the next one re-reads and merges (nothing dropped)", async () => {
  const w = world(["worlds/x/b.webp", "worlds/x/b_depth.png"]);
  let release, inFlight = 0, maxInFlight = 0;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const gm = w.client({
    write: async (x) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const wasFirst = first;
      if (first) { first = false; await gate; }
      w.writes++; w.store = structuredClone(x); inFlight--;
      // another GM's write lands right after our first one (the server applies writes in order)
      if (wasFirst) w.store.list.push({ k: "worlds/y/z.webp", d: "worlds/y/z_depth.png", f: "png16", m: null, s: 1, t: 5, r: 5 });
      for (const c of w.clients) c.indexChanged();
    }
  });
  const r1 = gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png16" });
  await new Promise((r) => setTimeout(r, 5));
  await gm.lookup("worlds/x/b.webp");                         // backfill queued while the first write hangs
  const f = gm.flush();
  const r2 = gm.remember("worlds/x/c.webp", { depth: "worlds/x/c_depth.png", format: "png16" });
  release();
  await Promise.all([r1, f, r2]);
  assert.equal(maxInFlight, 1, "one write at a time");
  assert.deepEqual(Object.keys(w.maps()).sort(), ["worlds/x/a.webp", "worlds/x/b.webp", "worlds/x/c.webp", "worlds/y/z.webp"]);
});

await test("a backfill never replaces an entry written meanwhile; reportMissing only drops the entry it saw", async () => {
  const w = world(["worlds/x/a.webp", "worlds/x/a_depth.png"]);
  const gm = w.client({ write: async (x) => { w.writes++; w.store = structuredClone(x); } });
  await gm.lookup("worlds/x/a.webp");                         // backfill pending (old-form, no sidecar)
  w.store.list.push({ k: "worlds/x/a.webp", d: "worlds/x/a.webp-run_depth.png", f: "png16", m: null, s: 1, t: 2000, r: 2000 });
  await gm.flush();
  assert.equal(w.maps()["worlds/x/a.webp"].d, "worlds/x/a.webp-run_depth.png");
  gm.reportMissing("worlds/x/a.webp");                        // queued with ifD = the file it saw
  w.store.list = [{ k: "worlds/x/a.webp", d: "worlds/x/new_depth.png", f: "png16", m: null, s: 1, t: 3000, r: 3000 }];
  await gm.flush();
  assert.equal(w.maps()["worlds/x/a.webp"].d, "worlds/x/new_depth.png", "a newer map is not deleted by a stale report");
});

await test("index change: only changed images lose their cached answer; a no-op change clears nothing", async () => {
  const w = world();
  const gm = w.client(), p = w.client({ gm: false, browse: false });
  assert.equal(await p.lookup("worlds/x/a.webp"), null);
  assert.equal(await p.lookup("worlds/x/b.webp"), null);
  const heard = [];
  p.onChange((ks) => heard.push(ks));
  await gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png16" });
  assert.equal(p.peek("worlds/x/a.webp"), undefined, "changed image: dropped");
  assert.equal(p.peek("worlds/x/b.webp"), null, "unrelated negative answer kept");
  p.indexChanged();
  assert.deepEqual(heard, [["worlds/x/a.webp"]], "the no-op change emitted nothing");
});

// ------------------------------------------------------------------ 5. run.mjs (stubbed Foundry I/O)

const W = 6, H = 4;
const srcImg = () => { const rgba = new Uint8ClampedArray(W * H * 4).fill(128); return { rgba, w: W, h: H, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }) }; };
const gradient = (w = 12, h = 8) => { const rgba = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.round(255 * x / (w - 1)); rgba.set([v, v, v, 255], (y * w + x) * 4); } return { rgba, w, h }; };
const flatPic = (w = 12, h = 8) => ({ rgba: new Uint8ClampedArray(w * h * 4).fill(200), w, h });

function harness({ listed = [], failUpload = null, picture = gradient, execute = null, w = world() } = {}) {
  const log = [];
  const uploads = [];
  const io = {
    ensureDir: async () => {},
    list: async (dir) => new Set(listed.filter((f) => f.startsWith(`${dir}/`))),
    upload: async (dir, file) => {
      const path = `${dir}/${file.name}`;
      log.push(`upload ${path}`);
      const err = failUpload?.(path, uploads.filter((u) => u === path).length);
      uploads.push(path);
      if (err) throw err;
      return { path: encodeDataPath(path) };
    },
    sleep: async (ms) => { log.push(`sleep ${ms}`); }
  };
  let executed = 0;
  const h = {
    log, uploads, w, index: w.client(),
    get executed() { return executed; },
    deps: {
      io,
      loadImage: async (p) => { log.push(`load ${p}`); return srcImg(); },
      decode: async (blob) => { log.push(`decode ${blob.size}`); return picture(); },
      engine: { probeWebGPU: async () => ({ ok: false }), isCached: async () => true, estimateDepth: async () => { throw new Error("not used"); }, figureMask: async () => ({ A: null }) },
      genDeps: {
        estimate: () => ({ display: 0.012, source: "table", n: 0 }),
        execute: execute ?? (async () => { executed++; log.push("execute"); return { candidates: [{ blob: new Blob([new Uint8Array(10)], { type: "image/png" }), cost: 0.012 }], cost: 0.012 }; }),
        prices: undefined
      },
      now: () => 1_700_000_000_000
    }
  };
  h.deps.index = h.index;
  return h;
}
const genDepth = () => normalizeDepth({ engine: "generative" });
const ui = (extra = {}) => ({ confirmPaid: async () => true, ...extra });

await test("run: new per-run names, map remembered with rev + real format + sidecar; a listed name is never overwritten", async () => {
  const key = ATOM[1];
  const runId = (1_700_000_000_000).toString(36);
  const taken = depthPathsFor(key, { engine: "generative", run: runId });
  const h = harness({ listed: [taken.depth] });     // e.g. a hand-made file that happens to have this name
  const r = await runDepth({ path: encodeDataPath(key), depth: genDepth(), ui: ui(), deps: h.deps });
  assert.equal(r.key, key);
  assert.ok(!h.uploads.includes(taken.depth), "the existing file was not overwritten");
  assert.equal(r.depthPath, depthPathsFor(key, { engine: "generative", run: `${runId}-2` }).depth);
  assert.equal(r.metaPath, r.depthPath.replace(/_depth\.png$/, "_depth.json"));
  const info = await h.index.lookup(key);
  assert.deepEqual([info.depth, info.format, info.sidecar, info.rev], [r.depthPath, "png16", true, 1_700_000_000_000]);
  assert.equal(freeRunPaths(key, "generative", runId, new Set()).depth, taken.depth);
  // another image with the same base name gets its own file
  const h2 = harness({ w: h.w });
  const r2 = await runDepth({ path: ATOM[0], depth: genDepth(), ui: ui(), deps: { ...h2.deps, index: h.index } });
  assert.notEqual(r2.depthPath, r.depthPath);
  assert.equal((await h.index.lookup(key)).depth, r.depthPath, "the token keeps its own map");
});

await test("run: the paid picture is stored under _candidates BEFORE post-processing; a flat result keeps it; save again costs nothing", async () => {
  const h = harness({ picture: flatPic });
  const key = "worlds/x/hero.webp";
  let err;
  try { await runDepth({ path: key, depth: genDepth(), ui: ui(), deps: h.deps }); } catch (e) { err = e; }
  assert.equal(err?.code, "flat");
  assert.ok(err.recover?.blob, "the picture travels with the error");
  assert.ok(err.recover.candidatePath?.startsWith(`${DEPTH_CANDIDATE_DIR}/hero-webp-`), err.recover.candidatePath);
  const iExec = h.log.indexOf("execute"), iKeep = h.log.findIndex((l) => l.startsWith(`upload ${DEPTH_CANDIDATE_DIR}/`)), iDecode = h.log.findIndex((l) => l.startsWith("decode"));
  assert.ok(iExec >= 0 && iKeep > iExec && iDecode > iKeep, h.log.join(" | "));
  assert.equal(h.uploads.filter((u) => u.endsWith("_depth.png")).length, 0, "no map");
  assert.equal(h.executed, 1);
  // save again from the kept file (window closed: only the path is left) with a readable picture: no execute
  const h2 = harness({ w: h.w });
  const r = await runDepth({ path: key, depth: genDepth(), ui: ui({ confirmPaid: async () => { throw new Error("must not ask"); } }), recover: { candidatePath: err.recover.candidatePath, cost: err.recover.cost }, deps: h2.deps });
  assert.equal(h2.executed, 0, "no paid call");
  assert.equal(r.cost, 0);
  assert.ok(r.notes.includes("recovered"));
  assert.ok(h2.log.includes(`load ${err.recover.candidatePath}`));
  assert.ok(r.depthPath.endsWith("_depth.png"));
});

await test("run: upload session error = one try, error code uploadSession, recover kept; network errors are retried", async () => {
  const session = Object.assign(new Error("User [] does not have permission to upload files."), { reason: "session", retryable: false });
  const h = harness({ failUpload: (p) => (p.endsWith("_depth.png") ? session : null) });
  let err;
  try { await runDepth({ path: "worlds/x/hero.webp", depth: genDepth(), ui: ui(), deps: h.deps }); } catch (e) { err = e; }
  assert.equal(err?.code, "uploadSession");
  assert.equal(h.uploads.filter((u) => u.endsWith("_depth.png")).length, 1, "no blind retries");
  assert.ok(err.recover?.blob && err.recover.candidatePath);
  assert.equal(h.executed, 1);
  // session lost already for the candidate: kept in memory only, the run goes on
  const h3 = harness({ failUpload: (p) => (p.startsWith(DEPTH_CANDIDATE_DIR) ? session : null) });
  const r3 = await runDepth({ path: "worlds/x/hero.webp", depth: genDepth(), ui: ui(), deps: h3.deps });
  assert.ok(r3.notes.includes("candidateNotKept"));
  assert.equal(r3.candidatePath ?? null, null);
  // a network error passes after the retry delays
  const net = Object.assign(new Error("fetch failed"), { reason: "network" });
  const h2 = harness({ failUpload: (p, n) => (p.endsWith("_depth.png") && n < 2 ? net : null) });
  const r = await runDepth({ path: "worlds/x/hero.webp", depth: genDepth(), ui: ui(), deps: h2.deps });
  assert.ok(r.depthPath);
  assert.deepEqual(h2.log.filter((l) => l.startsWith("sleep")), ["sleep 1000", "sleep 3000"]);
  await assert.rejects(uploadWithRetry(h2.deps.io, "a/b.png", new Uint8Array(1), "image/png", { delays: [] }).then(() => { throw Object.assign(new Error("x"), { code: "upload" }); }), /x/);
});

await test("run: abort before the paid call = no call; abort during the call = picture kept, no post-processing, no map", async () => {
  const ac = new AbortController();
  const h = harness();
  let err;
  try { await runDepth({ path: "worlds/x/hero.webp", depth: genDepth(), signal: ac.signal, ui: ui({ confirmPaid: async () => { ac.abort(); return true; } }), deps: h.deps }); } catch (e) { err = e; }
  assert.ok(err?.cancelled);
  assert.equal(h.executed, 0, "closed while the confirmation was open: nothing sent");
  const ac2 = new AbortController();
  let calls = 0;
  const h2 = harness({ execute: async () => { calls++; ac2.abort(); return { candidates: [{ blob: new Blob([new Uint8Array(10)], { type: "image/png" }), cost: 0.02 }], cost: 0.02 }; } });
  let err2;
  try { await runDepth({ path: "worlds/x/hero.webp", depth: genDepth(), signal: ac2.signal, ui: ui(), deps: h2.deps }); } catch (e) { err2 = e; }
  assert.ok(err2?.cancelled);
  assert.equal(calls, 1);
  assert.ok(err2.recover?.candidatePath, "the paid picture is on disk");
  assert.ok(!h2.log.some((l) => l.startsWith("decode")), "no post-processing after close");
  assert.equal(h2.uploads.filter((u) => u.endsWith("_depth.png")).length, 0);
  // the request itself never carries the window's signal (an aborted fetch would lose a paid picture)
  let seen = "unset";
  const h3 = harness({ execute: async (args) => { seen = args.signal; return { candidates: [{ blob: new Blob([new Uint8Array(4)], { type: "image/png" }) }], cost: 0 }; } });
  await runDepth({ path: "worlds/x/hero.webp", depth: genDepth(), signal: new AbortController().signal, ui: ui(), deps: h3.deps });
  assert.equal(seen, undefined);
});

// ------------------------------------------------------------------ 6. window

await test("window: results only for the image + engine they were made for; busy guard; error text", () => {
  assert.equal(resultMatches({ key: "a.webp", engine: "browser" }, { key: "a.webp", engine: "browser" }), true);
  assert.equal(resultMatches({ key: "a.webp", engine: "browser" }, { key: "b.webp", engine: "browser" }), false);
  assert.equal(resultMatches({ key: "a.webp", engine: "browser" }, { key: "a.webp", engine: "generative" }), false);
  assert.equal(resultMatches(null, { key: "a.webp" }), false);
  const has = (k) => k === "AIIMG.DepthRun.Err.flat";
  const localize = (k) => `L:${k}`;
  assert.equal(depthErrorText({ code: "flat", message: "m" }, { has, localize }), "L:AIIMG.DepthRun.Err.flat");
  assert.equal(depthErrorText(Object.assign(new Error("Quota exceeded"), { code: 22 }), { has, localize }), "Quota exceeded", "numeric DOMException code");
  assert.equal(depthErrorText({ code: "nope", message: "raw" }, { has, localize }), "raw");
  assert.equal(depthErrorText("plain", { has, localize }), "plain");
  const app = readFileSync(new URL("../scripts/depth/depth-app.mjs", import.meta.url), "utf8");
  assert.match(app, /if \(app\.busy\) \{/, "open() keeps the image while busy");
  assert.match(app, /static #onPick\(\) \{\s*if \(this\.busy\) return;/);
  assert.match(app, /if \(this\.busy\) \{ ev\.target\.value = this\.path; return; \}/);
  assert.match(app, /if \(this\.busy\) \{ ev\.target\.value = this\.engine; return; \}/);
  assert.match(app, /resultMatches\(r, \{ key: this\.key, engine \}\)/);
  assert.match(app, /this\.#abort\?\.abort\(\)/, "closing the window aborts");
  assert.match(app, /signal: ac\.signal/);
  assert.ok(!/L\(`AIIMG\.DepthRun\.Err\.\$\{e\.code\}`\)/.test(app), "no raw key for unknown codes");
  const tpl = readFileSync(new URL("../templates/depth.hbs", import.meta.url), "utf8");
  for (const n of ["path", "engine"]) assert.match(tpl, new RegExp(`name="${n}"[^>]*\\{\\{#if busy\\}\\}disabled`), n);
  assert.match(tpl, /data-action="retrySave"/);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
