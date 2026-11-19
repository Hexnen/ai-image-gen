// W6-N: depth parallax on actor sheet portraits, the pure parts: the shared image -> depth map index
// (scripts/depth/depth-index.mjs: keys, cleaning, lookup order, caching, player vs GM, backfill, remember / forget,
// listeners) and the portrait helpers (scripts/parallax/portrait-core.mjs: object-fit, clipping, look, view settings,
// texture size, frame guard). Plus static checks of the wiring. Pure Node.
// Run from the module folder: node dev/test-portrait-parallax.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  normalizeImagePath, isDepthCandidate, cleanEntry, cleanIndex, toStored, createDepthIndex, INDEX_MAX
} from "../scripts/depth/depth-index.mjs";
import {
  parsePosition, objectFitRect, intersectRect, placementFor, panelPixels, lookFromPointer, settled, portraitView,
  effectAmount, portraitTextureSide, createFrameGuard, sameImage, cssBoxFor, rectsMatch, OVERLAY_STYLE, cropForLook,
  overlayOpacity, FADE_AT, PORTRAIT_TEXTURE_CAP
} from "../scripts/parallax/portrait-core.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const rectNear = (r, e, eps = 1e-6) => { for (const k of ["x", "y", "w", "h"]) near(r[k], e[k], eps, k); };

/** Foundry expands dotted object keys of a setting value (expandObject): "a/b.webp" -> {"a/b": {webp}}. */
function expandLikeFoundry(o) {
  if (!o || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(expandLikeFoundry);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const parts = k.split(".");
    let t = out;
    for (const p of parts.slice(0, -1)) t = (t[p] ??= {});
    t[parts.at(-1)] = expandLikeFoundry(v);
  }
  return out;
}

/** A world: one stored index shared by several clients, a fake file system, a clock. */
function world(files = []) {
  const w = { store: { v: 1, list: [] }, files: new Set(files), t: 1000, listings: [], writes: 0 };
  w.client = ({ gm = false, browse = gm, negTtlMs = 30_000 } = {}) => {
    const idx = createDepthIndex({
      read: () => structuredClone(w.store),
      write: async (x) => { w.writes++; w.store = expandLikeFoundry(structuredClone(x)); for (const c of w.clients) c.indexChanged(); },
      listDir: async (dir) => {
        w.listings.push(dir);
        const out = [...w.files].filter((f) => f.slice(0, f.lastIndexOf("/")) === dir);
        if (!out.length && ![...w.files].some((f) => f.startsWith(`${dir}/`))) throw new Error("does not exist");
        return out;
      },
      canBrowse: () => browse,
      canWrite: () => gm,
      now: () => w.t,
      negTtlMs, writeDelayMs: 0
    });
    w.clients.push(idx);
    return idx;
  };
  w.clients = [];
  w.maps = () => cleanIndex(w.store).maps;
  return w;
}

// ------------------------------------------------------------------ index: keys and cleaning

await test("normalizeImagePath: one key per image however it is written", () => {
  assert.equal(normalizeImagePath("worlds/x/a.webp"), "worlds/x/a.webp");
  assert.equal(normalizeImagePath("/worlds/x/a.webp?v=3#t"), "worlds/x/a.webp");
  assert.equal(normalizeImagePath("worlds\\x\\a.webp"), "worlds/x/a.webp");
  assert.equal(normalizeImagePath("worlds/x/My%20Hero.webp"), "worlds/x/My Hero.webp");
  assert.equal(normalizeImagePath("worlds/x/100%.webp"), "worlds/x/100%.webp", "a stray % does not throw");
  const o = { origin: "http://127.0.0.1:30008" };
  assert.equal(normalizeImagePath("http://127.0.0.1:30008/worlds/x/a.webp?1", o), "worlds/x/a.webp");
  assert.equal(normalizeImagePath("http://127.0.0.1:30008/game/worlds/x/a.webp", { ...o, routePrefix: "/game/" }), "worlds/x/a.webp");
  assert.equal(normalizeImagePath("https://cdn.example/a.webp?x=1", o), "https://cdn.example/a.webp", "other hosts stay URLs");
  assert.equal(normalizeImagePath("data:image/png;base64,AAAA"), "");
  assert.equal(normalizeImagePath("blob:xyz"), "");
  assert.equal(normalizeImagePath(""), "");
  assert.equal(normalizeImagePath(null), "");
});

await test("isDepthCandidate: real pictures only", () => {
  assert.ok(isDepthCandidate("worlds/x/a.webp"));
  assert.ok(!isDepthCandidate(""));
  assert.ok(!isDepthCandidate("icons/svg/mystery-man.svg"));
  assert.ok(!isDepthCandidate("worlds/x/logo.svg"));
  assert.ok(!isDepthCandidate("worlds/x/a_depth.png"), "a depth map has no depth map");
  assert.ok(!isDepthCandidate("worlds/x/a_mask.png"));
});

await test("cleanIndex: junk, prototype keys and unknown formats dropped; newest INDEX_MAX kept", () => {
  assert.deepEqual(cleanIndex(null), { v: 1, maps: {} });
  assert.deepEqual(cleanIndex("x"), { v: 1, maps: {} });
  const raw = JSON.parse('{"maps":{"__proto__":{"d":"evil.png"},"a.webp":{"d":"a_depth.png","f":"weird","s":1,"t":5},"b.webp":{"d":""},"c.webp":{"d":"javascript:alert(1)"},"d.webp":{"d":"d_depth.png","f":"png-rg16","m":"data:x","t":2}}}');
  const c = cleanIndex(raw);
  assert.deepEqual(Object.keys(c.maps).sort(), ["a.webp", "d.webp"]);
  assert.equal(c.maps["a.webp"].f, null);
  assert.equal(c.maps["a.webp"].s, 1);
  assert.equal(c.maps["d.webp"].f, "png-rg16");
  assert.equal(c.maps["d.webp"].m, null);
  assert.equal(Object.getPrototypeOf(c.maps), Object.prototype);
  assert.equal(cleanEntry({ d: "x".repeat(2000) }), null);
  const many = { maps: {} };
  for (let i = 0; i < INDEX_MAX + 50; i++) many.maps[`i${i}.webp`] = { d: `i${i}_depth.png`, t: i };
  const k = cleanIndex(many);
  assert.equal(Object.keys(k.maps).length, INDEX_MAX);
  assert.ok(!("i0.webp" in k.maps) && `i${INDEX_MAX + 49}.webp` in k.maps, "the oldest go first");
});

await test("stored form: image paths are values, never setting keys (Foundry expands dotted keys)", () => {
  const idx = { v: 1, maps: { "worlds/x/hero.webp": { d: "worlds/x/hero_depth.png", f: "png16", s: 1, t: 3 } } };
  const naive = expandLikeFoundry(structuredClone(idx));
  assert.deepEqual(cleanIndex(naive).maps, {}, "the object form is destroyed by the expansion (the bug seen live)");
  const st = expandLikeFoundry(toStored(idx));
  assert.deepEqual(Object.keys(cleanIndex(st).maps), ["worlds/x/hero.webp"]);
  assert.equal(cleanIndex(st).maps["worlds/x/hero.webp"].d, "worlds/x/hero_depth.png");
  assert.deepEqual(cleanIndex({ list: [null, 5, { k: "__proto__", d: "x.png" }, { k: "", d: "y.png" }] }).maps, {});
});

// ------------------------------------------------------------------ index: lookups

await test("player without file browsing: only the index, never a directory listing", async () => {
  const w = world(["worlds/x/a.webp", "worlds/x/a_depth.png"]);
  const p = w.client({ gm: false, browse: false });
  assert.equal(await p.lookup("worlds/x/a.webp"), null, "file exists but the index does not know it");
  assert.equal(w.listings.length, 0, "no listing, no request");
  assert.equal(p.peek("worlds/x/a.webp"), null, "negative cached");
  w.t += 10 * 60_000;
  assert.equal(p.peek("worlds/x/a.webp"), null, "for a player the negative stays until the index changes");
  // a GM records the map -> every client's cache is dropped (setting onChange) and the player finds it
  const gm = w.client({ gm: true });
  let heard = 0;
  p.onChange(() => heard++);
  assert.equal(await gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png16", sidecar: true }), true);
  assert.ok(heard >= 1, "the player's listeners heard the change");
  assert.equal(p.peek("worlds/x/a.webp"), undefined, "cache dropped");
  const info = await p.lookup("/worlds/x/a.webp?v=2");
  assert.deepEqual({ ...info }, { image: "worlds/x/a.webp", depth: "worlds/x/a_depth.png", format: "png16", mask: null, sidecar: true, source: "index", rev: w.t });
  assert.equal(w.listings.length, 0);
});

await test("GM: directory listing when the index has no entry, backfilled into the index; one listing per directory", async () => {
  const w = world(["worlds/x/a.webp", "worlds/x/a_depth.png", "worlds/x/a_depth.json", "worlds/x/a_mask.png", "worlds/x/b.webp", "worlds/x/b_depth.png", "worlds/x/c.webp"]);
  const gm = w.client({ gm: true });
  const [a, b, c, a2] = await Promise.all(["worlds/x/a.webp", "worlds/x/b.webp", "worlds/x/c.webp", "worlds/x/a.webp"].map((s) => gm.lookup(s)));
  assert.equal(w.listings.length, 1, "one listing for three images in one directory, parallel calls shared");
  assert.equal(a.source, "browse");
  assert.equal(a.sidecar, true);
  assert.equal(a.mask, "worlds/x/a_mask.png");
  assert.equal(b.sidecar, false, "no _depth.json: the loader must not ask for it (no 404)");
  assert.equal(c, null);
  assert.strictEqual(a2, a, "the same lookup");
  await gm.flush();
  assert.equal(w.writes, 1, "the backfill is one batched write");
  assert.deepEqual(Object.keys(w.maps()).sort(), ["worlds/x/a.webp", "worlds/x/b.webp"]);
  const st = gm.stats();
  assert.ok(st.browse >= 2 && st.listings === 1);
  // a second GM / reload: straight from the index, no listing
  const gm2 = w.client({ gm: true });
  w.listings.length = 0;
  assert.equal((await gm2.lookup("worlds/x/b.webp")).source, "index");
  assert.equal(w.listings.length, 0);
});

await test("browsing user (not GM): finds by listing but never writes the index", async () => {
  const w = world(["worlds/x/a.webp", "worlds/x/a_depth.png"]);
  const t = w.client({ gm: false, browse: true });
  assert.equal((await t.lookup("worlds/x/a.webp")).depth, "worlds/x/a_depth.png");
  await t.flush();
  assert.equal(w.writes, 0);
  assert.equal(await t.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png" }), false);
  assert.equal(w.writes, 0);
});

await test("negative answers expire for browsing users (a map made elsewhere shows up); positives stay", async () => {
  const w = world(["worlds/x/a.webp"]);
  const gm = w.client({ gm: true, negTtlMs: 30_000 });
  assert.equal(await gm.lookup("worlds/x/a.webp"), null);
  w.files.add("worlds/x/a_depth.png");
  w.t += 10_000;
  assert.equal(await gm.lookup("worlds/x/a.webp"), null, "still believed");
  w.t += 31_000;
  assert.equal(gm.peek("worlds/x/a.webp"), undefined, "expired");
  assert.equal((await gm.lookup("worlds/x/a.webp")).depth, "worlds/x/a_depth.png");
  const n = w.listings.length;
  w.t += 10 * 60_000;
  assert.ok(await gm.lookup("worlds/x/a.webp"));
  assert.equal(w.listings.length, n, "positive answers need no listing");
});

await test("images outside writable folders and URLs: the map is looked for under ai-image-gen/_depth", async () => {
  const w = world(["ai-image-gen/_depth/hero_depth.png"]);
  const gm = w.client({ gm: true });
  assert.equal(gm.pathsFor("systems/invincible/assets/hero.webp").depth, "ai-image-gen/_depth/hero_depth.png");
  assert.equal((await gm.lookup("systems/invincible/assets/hero.webp")).depth, "ai-image-gen/_depth/hero_depth.png");
  assert.deepEqual(w.listings, ["ai-image-gen/_depth"]);
  assert.equal(gm.pathsFor("worlds/x/My Hero.webp").depth, "worlds/x/My-Hero_depth.png", "same name rule as the writer");
});

await test("remember: immediate write, normalised, listeners; refuses icons / svg; forget and reportMissing", async () => {
  const w = world();
  const gm = w.client({ gm: true });
  const heard = [];
  gm.onChange((k) => heard.push(k));
  assert.equal(await gm.remember("icons/svg/mystery-man.svg", { depth: "x_depth.png" }), false);
  assert.equal(await gm.remember("worlds/x/a.webp", {}), false, "no depth path");
  assert.equal(w.writes, 0);
  assert.equal(await gm.remember("/worlds/x/a.webp?v=1", { depth: "/worlds/x/a_depth.png", format: "png-rg16", mask: "worlds/x/a_mask.png" }), true);
  assert.equal(w.writes, 1, "written at once");
  assert.deepEqual(w.maps()["worlds/x/a.webp"], { d: "worlds/x/a_depth.png", f: "png-rg16", m: "worlds/x/a_mask.png", s: 0, t: w.t, r: w.t });
  assert.ok(heard.length >= 1);
  assert.equal((await gm.lookup("worlds/x/a.webp")).format, "png-rg16");
  // the same again: no second write
  await gm.remember("worlds/x/a.webp", { depth: "worlds/x/a_depth.png", format: "png-rg16", mask: "worlds/x/a_mask.png" });
  assert.equal(w.writes, 1);
  // a consumer could not load it: the GM drops the entry (batched), everyone believes "no map"
  gm.reportMissing("worlds/x/a.webp");
  assert.equal(gm.peek("worlds/x/a.webp"), null);
  await gm.flush();
  assert.equal(w.maps()["worlds/x/a.webp"], undefined);
  await gm.remember("worlds/x/b.webp", { depth: "worlds/x/b_depth.png" });
  assert.equal(await gm.forget("worlds/x/b.webp"), true);
  assert.equal(w.maps()["worlds/x/b.webp"], undefined);
  const unsub = gm.onChange(() => { throw new Error("listener errors are contained"); });
  gm.invalidate();
  unsub();
});

await test("backfill writes merge with what is stored at write time (another GM wrote meanwhile)", async () => {
  const w = world(["worlds/x/a.webp", "worlds/x/a_depth.png"]);
  const gm = w.client({ gm: true });
  await gm.lookup("worlds/x/a.webp");
  w.store.list.push({ k: "worlds/y/z.webp", d: "worlds/y/z_depth.png", f: "png16", m: null, s: 1, t: 5 });
  await gm.flush();
  assert.deepEqual(Object.keys(w.maps()).sort(), ["worlds/x/a.webp", "worlds/y/z.webp"]);
});

await test("lookup never throws: unreadable index, failing listing, bad input", async () => {
  const idx = createDepthIndex({ read: () => { throw new Error("no setting"); }, listDir: async () => { throw new Error("socket down"); }, canBrowse: () => true, canWrite: () => true, write: async () => { throw new Error("denied"); }, writeDelayMs: 0 });
  assert.equal(await idx.lookup("worlds/x/a.webp"), null);
  assert.equal(await idx.lookup(undefined), null);
  assert.equal(await idx.lookup({}), null);
  assert.equal(idx.peek(""), null);
  assert.deepEqual(idx.entries(), []);
});

// ------------------------------------------------------------------ portrait helpers

await test("parsePosition: keywords, percentages, pixels, swapped order", () => {
  assert.deepEqual(parsePosition("50% 50%"), [{ f: 0.5 }, { f: 0.5 }]);
  assert.deepEqual(parsePosition("0px 10px"), [{ px: 0 }, { px: 10 }]);
  assert.deepEqual(parsePosition("left top"), [{ f: 0 }, { f: 0 }]);
  assert.deepEqual(parsePosition("top left"), [{ f: 0 }, { f: 0 }]);
  assert.deepEqual(parsePosition("right"), [{ f: 1 }, { f: 0.5 }]);
  assert.deepEqual(parsePosition("bottom"), [{ f: 0.5 }, { f: 1 }]);
  assert.deepEqual(parsePosition(""), [{ f: 0.5 }, { f: 0.5 }]);
  assert.deepEqual(parsePosition("calc(1px)"), [{ f: 0.5 }, { f: 0.5 }]);
});

await test("objectFitRect: fill / contain / cover / none / scale-down with positions", () => {
  const box = { x: 10, y: 20, w: 200, h: 100 };
  rectNear(objectFitRect(box, 400, 400, "fill"), box);
  rectNear(objectFitRect(box, 400, 400, "contain"), { x: 60, y: 20, w: 100, h: 100 });
  rectNear(objectFitRect(box, 400, 400, "cover"), { x: 10, y: -30, w: 200, h: 200 });
  rectNear(objectFitRect(box, 400, 400, "cover", "50% 0%"), { x: 10, y: 20, w: 200, h: 200 });
  rectNear(objectFitRect(box, 50, 40, "none"), { x: 85, y: 50, w: 50, h: 40 });
  rectNear(objectFitRect(box, 50, 40, "scale-down"), { x: 85, y: 50, w: 50, h: 40 });
  rectNear(objectFitRect(box, 400, 400, "scale-down"), { x: 60, y: 20, w: 100, h: 100 });
  rectNear(objectFitRect(box, 400, 400, "contain", "0px 0px"), { x: 10, y: 20, w: 100, h: 100 });
  rectNear(objectFitRect(box, 0, 0, "contain"), box, 0);
});

await test("placementFor: the canvas covers only the visible picture; panel = picture relative to it", () => {
  // cover in a square box, clipped by a frame (overflow: hidden) smaller than the image box
  const content = { x: 0, y: 0, w: 214, h: 214 };
  const p = placementFor({ content, natW: 1000, natH: 1500, fit: "cover", position: "50% 50%", clips: [{ x: 7, y: 7, w: 200, h: 200 }] });
  rectNear(p.drawn, { x: 0, y: -53.5, w: 214, h: 321 });
  rectNear(p.visible, { x: 7, y: 7, w: 200, h: 200 });
  rectNear(p.panel, { x: -7 / 200, y: -60.5 / 200, w: 214 / 200, h: 321 / 200 });
  // contain: letterbox outside the picture is not part of the canvas
  const q = placementFor({ content: { x: 0, y: 0, w: 200, h: 100 }, natW: 100, natH: 100, fit: "contain" });
  rectNear(q.visible, { x: 50, y: 0, w: 100, h: 100 });
  rectNear(q.panel, { x: 0, y: 0, w: 1, h: 1 });
  // scrolled out of view / hidden tab
  assert.equal(placementFor({ content, natW: 10, natH: 10, clips: [{ x: 500, y: 0, w: 10, h: 10 }] }), null);
  assert.equal(placementFor({ content: { x: 0, y: 0, w: 0, h: 0 }, natW: 10, natH: 10 }), null);
  assert.equal(intersectRect({ x: 0, y: 0, w: 1, h: 1 }, null), null);
});

await test("panelPixels: the copied area stays inside the canvas", () => {
  assert.deepEqual(panelPixels({ x: 0, y: 0, w: 1, h: 1 }, 100, 50), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(panelPixels({ x: -0.1, y: 0.25, w: 1.2, h: 0.5 }, 100, 100), { x: 0, y: 25, w: 100, h: 50 });
  assert.deepEqual(panelPixels({ x: 2, y: 0, w: 1, h: 1 }, 100, 100).w, 0);
});

await test("lookFromPointer: centre 0, edge 1, beyond the picture full tilt in the pointer's direction", () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(lookFromPointer(200, 150, r), { x: 0, y: 0 });
  const e = lookFromPointer(300, 150, r);
  near(e.x, 1); near(e.y, 0);
  const far = lookFromPointer(2000, 2000, r);
  near(Math.hypot(far.x, far.y), 1, 1e-9);
  assert.ok(far.x > 0 && far.y > 0);
  assert.deepEqual(lookFromPointer(1, 1, null), { x: 0, y: 0 });
  assert.ok(settled({ x: 0.0001, y: 0 }, { x: 0, y: 0 }));
  assert.ok(!settled({ x: 0.1, y: 0 }, { x: 0, y: 0 }));
});

await test("portraitView: seeded from the type, no sway / dust / vignette; light and rim fade in with the look", () => {
  const v = portraitView({ strength: 0.8, sway: 0.9, light: true, rim: false, dust: true });
  assert.equal(v.strength, 0.8);
  assert.equal(v.sway, 0);
  assert.equal(v.on.dust, false);
  assert.equal(v.on.vignette, false);
  assert.equal(v.on.light, true);
  assert.equal(v.on.rim, false);
  assert.equal(v.view, "image");
  const d = portraitView(null);
  assert.equal(d.strength, 0.5);
  assert.equal(effectAmount(0.6, { x: 0, y: 0 }), 0, "at rest the picture is not relit");
  near(effectAmount(0.6, { x: 0.5, y: 0 }), 0.3);
  near(effectAmount(0.6, { x: 3, y: 4 }), 0.6);
});

await test("W6-Q portraitTextureSide: natural size, capped by MAX_TEXTURE_SIZE and 4096 only", () => {
  assert.equal(PORTRAIT_TEXTURE_CAP, 4096);
  assert.equal(portraitTextureSide(941, 1672), 1672, "the owner's 941x1672 picture is NOT downscaled (was 768)");
  assert.equal(portraitTextureSide(941, 1672, 16384), 1672);
  assert.equal(portraitTextureSide(6000, 3000), 4096);
  assert.equal(portraitTextureSide(6000, 3000, 2048), 2048, "GPU limit wins");
  assert.equal(portraitTextureSide(200, 120), 200, "small pictures are never upscaled");
  assert.equal(portraitTextureSide(0, 0, 8192), 4096, "unknown natural size = cap (loader downscales only above it)");
  assert.equal(portraitTextureSide(0, 0, 0), 4096);
});

await test("W6-Q cssBoxFor: absolute box over a screen rect, any containing block / scale / scroll / border", () => {
  const v = { x: 437, y: 165, w: 373, h: 507 };
  // plain parent at (100, 50), border 3, no scale
  const plain = { rect: { left: 100, top: 50, width: 600, height: 800 }, offsetWidth: 600, offsetHeight: 800, clientLeft: 3, clientTop: 3, scrollLeft: 0, scrollTop: 0 };
  let c = cssBoxFor(v, plain);
  near(c.left, 334); near(c.top, 112); near(c.width, 373); near(c.height, 507);
  // the canvas' own screen rect = parent rect + border + left/top (what the browser does) -> equals v
  const screen = (c, P, sx = 1, sy = 1) => ({ x: P.rect.left + (P.clientLeft + c.left - P.scrollLeft) * sx, y: P.rect.top + (P.clientTop + c.top - P.scrollTop) * sy, w: c.width * sx, h: c.height * sy });
  assert.ok(rectsMatch(screen(c, plain), v, 1e-9));
  // scrolled parent (the content scrolled up by 490 px)
  const scrolled = { ...plain, scrollTop: 490 };
  c = cssBoxFor(v, scrolled);
  assert.ok(rectsMatch(screen(c, scrolled), v, 1e-9));
  near(c.top, 602);
  // scaled ancestor (window scaled 0.8: rect is 0.8 x offset size)
  const scaled = { rect: { left: 10, top: 20, width: 480, height: 640 }, offsetWidth: 600, offsetHeight: 800, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0 };
  c = cssBoxFor(v, scaled);
  near(c.width, 373 / 0.8); near(c.height, 507 / 0.8);
  assert.ok(rectsMatch(screen(c, scaled, 0.8, 0.8), v, 1e-9));
  // hidden parent / missing -> null (no placement while the tab is display:none)
  assert.equal(cssBoxFor(v, { ...plain, offsetWidth: 0, rect: { left: 0, top: 0, width: 0, height: 0 } }), null);
  assert.equal(cssBoxFor(v, null), null);
  assert.equal(cssBoxFor(null, plain), null);
});

await test("W6-Q rectsMatch: 1 px tolerance on every edge, DOMRect-like or {x,y,w,h}", () => {
  assert.ok(rectsMatch({ left: 437.4, top: 165, width: 373, height: 507.6 }, { x: 437, y: 165, w: 373, h: 507 }));
  assert.ok(!rectsMatch({ left: 449, top: 656, width: 282, height: 474 }, { x: 437, y: 165, w: 373, h: 507 }), "the owner's broken rects");
  assert.ok(!rectsMatch({ x: 437, y: 165, w: 375, h: 507 }, { x: 437, y: 165, w: 373, h: 507 }));
  assert.ok(!rectsMatch(null, { x: 0, y: 0, w: 1, h: 1 }));
});

await test("W6-Q overlay style is complete and set inline (never relies on the stylesheet)", () => {
  assert.equal(OVERLAY_STYLE.position, "absolute");
  assert.equal(OVERLAY_STYLE["pointer-events"], "none");
  for (const k of ["display", "margin", "transform", "opacity", "filter", "mix-blend-mode", "max-width", "z-index"]) assert.ok(k in OVERLAY_STYLE, k);
  assert.ok(Object.isFrozen(OVERLAY_STYLE));
  const src = readFileSync(new URL("../scripts/parallax/portrait.mjs", import.meta.url), "utf8");
  assert.match(src, /OVERLAY_STYLE\)\) this\.canvas\.style\.setProperty\(k, val, "important"\)/);
  assert.match(src, /cssBoxFor\(p\.visible/);
});

await test("W6-Q cropForLook: no overscan at rest (1:1 with the <img>), full margin at full tilt, always covers the shift", () => {
  const full = { x: 0.04, y: 0.02 };
  assert.deepEqual(cropForLook(full, { x: 0, y: 0 }), { x: 0, y: 0 });
  rectNear({ ...cropForLook(full, { x: 1, y: 0 }), w: 0, h: 0 }, { x: 0.04, y: 0.02, w: 0, h: 0 });
  rectNear({ ...cropForLook(full, { x: 0.3, y: 0.4 }), w: 0, h: 0 }, { x: 0.02, y: 0.01, w: 0, h: 0 });
  rectNear({ ...cropForLook(full, { x: 3, y: 4 }), w: 0, h: 0 }, { x: 0.04, y: 0.02, w: 0, h: 0 }, 1e-9);
  // the shift is linear in the look: margin(look) / shift(look) is constant, so samples stay inside at every tilt
  for (const m of [0.05, 0.2, 0.5, 0.9]) near(cropForLook(full, { x: m, y: 0 }).x / m, 0.04, 1e-12);
});

await test("W6-Q overlayOpacity: 0 at rest (plain <img>), fades in over the first FADE_AT of tilt, 1 with breathing / dust", () => {
  assert.equal(overlayOpacity({ x: 0, y: 0 }), 0);
  assert.equal(overlayOpacity({ x: 0.00005, y: 0 }), 0);
  near(overlayOpacity({ x: FADE_AT / 2, y: 0 }), 0.5);
  assert.equal(overlayOpacity({ x: 0.5, y: 0.5 }), 1);
  assert.equal(overlayOpacity({ x: 0, y: 0 }, true), 1);
  // monotone in the tilt
  let last = -1;
  for (let i = 0; i <= 20; i++) { const o = overlayOpacity({ x: i / 200, y: 0 }); assert.ok(o >= last); last = o; }
});

await test("frame guard: warm-up, ok at 60 fps, bad on a sustained low rate or heavy draws, stalls ignored", () => {
  const g = createFrameGuard({ warmup: 5, window: 20, maxGapMs: 55, maxDrawMs: 8 });
  for (let i = 0; i < 5; i++) assert.equal(g.push(16.7, 0.5), "warmup");
  for (let i = 0; i < 19; i++) assert.equal(g.push(16.7, 0.5), "warmup");
  assert.equal(g.push(16.7, 0.5), "ok");
  for (let i = 0; i < 20; i++) g.push(1000, 0.5); // tab switches / stalls: skipped
  assert.equal(g.state().last, "ok");
  for (let i = 0; i < 9; i++) g.push(70, 0.5);
  assert.equal(g.state().last, "ok", "a short dip is not enough (median)");
  let r;
  for (let i = 0; i < 12; i++) r = g.push(70, 0.5);
  assert.equal(r, "bad");
  g.reset();
  assert.equal(g.state().samples, 0);
  for (let i = 0; i < 25; i++) r = g.push(16.7, 12);
  assert.equal(r, "bad", "our own draws too heavy");
  assert.equal(createFrameGuard().push(0, 1), "warmup");
});

await test("sameImage: <img> src vs actor.img through the normaliser", () => {
  const n = (s) => normalizeImagePath(s, { origin: "http://127.0.0.1:30008" });
  assert.ok(sameImage("http://127.0.0.1:30008/worlds/x/My%20Hero.webp", "worlds/x/My Hero.webp", n));
  assert.ok(sameImage("worlds/x/a.webp?v=1", "/worlds/x/a.webp", n));
  assert.ok(!sameImage("worlds/x/a.webp", "worlds/x/b.webp", n));
  assert.ok(!sameImage("", "", n));
});

// ------------------------------------------------------------------ wiring (static)

const MOD = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, MOD), "utf8");

await test("wiring: settings, hooks, run.mjs records the map, renderer shares one context, window unchanged", () => {
  const settings = read("scripts/settings.mjs");
  assert.match(settings, /registerPortraitSetting\(\);/);
  assert.match(settings, /registerDepthIndexSetting\(\);/);
  assert.match(read("scripts/sheet-button.mjs"), /registerPortraitParallax\(\);/);
  const run = read("scripts/depth/run.mjs");
  const iDepth = run.indexOf("res.depthPath = await uploadWithRetry(io, paths.depth");
  const iRemember = run.indexOf("index.remember(key");
  assert.ok(iDepth > 0 && iRemember > iDepth, "remembered after the map is saved");
  assert.match(run, /try \{\s*res\.metaPath = await uploadWithRetry\(io, paths\.meta/, "a failed sidecar does not fail the run");
  assert.match(run, /notify: false, skipOptimize: true/, "Media Optimizer must not turn the 16-bit PNG into an 8-bit _depth.webp (seen live)");
  const portrait = read("scripts/parallax/portrait.mjs");
  assert.match(portrait, /closeApplicationV2/);
  assert.match(portrait, /getHeaderControlsApplicationV2/);
  assert.match(portrait, /prefers-reduced-motion: reduce/);
  assert.match(portrait, /ParallaxRenderer\.create\(canvas, \{ alpha: true/);
  assert.equal((portrait.match(/ParallaxRenderer\.create\(/g) ?? []).length, 2, "create + restore, nothing per view");
  assert.ok(!/game\.user\.isGM[^\n]*attach\(/.test(portrait), "players get the effect too");
  const gl = read("scripts/parallax/parallax-gl.mjs");
  assert.match(gl, /outColor = vec4\(c, mix\(1\.0, src\.a, uAlphaOut\)\)/);
  assert.match(gl, /gl\.uniform1f\(U\.uAlphaOut, u\.alphaOut \? 1 : 0\)/, "the window passes no alphaOut: opaque as before");
  assert.ok(!/alphaOut/.test(read("scripts/parallax/parallax-app.mjs")));
  assert.match(read("scripts/parallax/parallax-load.mjs"), /sidecar !== false \? await sidecarOf\(path, rev\)/);
  for (const l of ["en", "pl"]) {
    const j = JSON.parse(read(`lang/${l}.json`));
    for (const k of ["AIIMG.PortraitParallax.Setting.Name", "AIIMG.PortraitParallax.Setting.Hint", "AIIMG.PortraitParallax.Generate", "AIIMG.PortraitParallax.Slow", "AIIMG.DepthRun.Note.metaKept"]) assert.ok(j[k], `${l}: ${k}`);
  }
  for (const f of ["scripts/parallax/portrait.mjs", "scripts/parallax/portrait-core.mjs", "scripts/depth/depth-index.mjs"]) {
    let src = read(f);
    // W6-R: the only request of depth-index: an old-form `_depth.json` sidecar (GM / browsing users, only when listed)
    if (f.endsWith("depth-index.mjs")) {
      assert.equal(src.match(/\bfetch\(/g)?.length ?? 0, 1, "depth-index: one fetch");
      src = src.replace(/async function readDataJson[\s\S]*?\r?\n\}\r?\n/, "");
    }
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/, `${f}: no own network calls`);
    assert.doesNotMatch(src, /https?:\/\//, `${f}: no hosts`);
  }
  assert.ok(readdirSync(new URL("scripts/parallax/", MOD)).includes("portrait.mjs"));
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
