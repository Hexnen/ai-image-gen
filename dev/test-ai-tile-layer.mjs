// W10 AI Tile under the scene's map overlays: which sortLayer the AI tile's mesh gets (scripts/tile/tile-layer.mjs).
// Run from the module folder: node dev/test-ai-tile-layer.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aiTileSortLayer, rectsOverlap, isAiTileDoc, AI_TILE_SORT_LAYER, TILES_SORT_LAYER
} from "../scripts/tile/tile-layer.mjs";
import { MODULE_ID } from "../scripts/constants.mjs";
import { TILE_FLAG } from "../scripts/tile/tile-fade.mjs";
import { CAPTURE_MAP_LAYERS } from "../scripts/tile/tile-core.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

const R = (x, y, width, height) => ({ x, y, width, height });
const me = (o = {}) => ({ ai: true, rect: R(100, 100, 200, 100), elevation: 0, sort: 3, ...o });

test("placement: above the captured map layers and destruction (247), below every overlay / fire / drawing / token / weather", () => {
  assert.equal(TILES_SORT_LAYER, 500);
  assert.equal(AI_TILE_SORT_LAYER, 247.5);
  // the map the model saw (background 0, moinen-maps water 240, roads 245) stays under the tile
  for (const l of [0, ...CAPTURE_MAP_LAYERS]) assert.ok(l < AI_TILE_SORT_LAYER, `map layer ${l}`);
  // destruction objects + their plain-map patches (247) under the tile: a patch above would show the old map over the edit
  assert.ok(247 < AI_TILE_SORT_LAYER);
  // moinen-maps overlays that tint / darken the map, then fire, smoke, drawings, tokens, weather: all above
  for (const l of [248, 249, 250, 251, 252, 253, 255, 256, 258, 600, 700, 705, 750, 800, 801, 990, 995, 1000]) {
    assert.ok(l > AI_TILE_SORT_LAYER, `overlay ${l}`);
  }
});

test("only AI tiles are moved (null = leave Foundry's 500)", () => {
  assert.equal(aiTileSortLayer(me({ ai: false })), null);
  assert.equal(aiTileSortLayer(null), null);
  assert.equal(aiTileSortLayer(me()), AI_TILE_SORT_LAYER);
  assert.equal(isAiTileDoc({ flags: { [MODULE_ID]: { [TILE_FLAG]: { key: "k" } } } }), true);
  assert.equal(isAiTileDoc({ flags: {} }), false);
  assert.equal(isAiTileDoc(null), false);
});

test("an ordinary tile under the AI tile (same elevation, overlapping, sort <=) keeps the AI tile at 500 (stays above it)", () => {
  const plainUnder = { ai: false, rect: R(250, 150, 100, 100), elevation: 0, sort: 1 };
  assert.equal(aiTileSortLayer(me(), [plainUnder]), TILES_SORT_LAYER);
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, sort: 3 }]), TILES_SORT_LAYER, "equal sort counts as under");
  // the same tile above it (higher sort) is above at 500 anyway: the AI tile may go down
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, sort: 4 }]), AI_TILE_SORT_LAYER);
  // another elevation: the elevation decides the order, not the sortLayer
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, elevation: -1 }]), AI_TILE_SORT_LAYER);
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, elevation: 5 }]), AI_TILE_SORT_LAYER);
  // not overlapping (also: only touching an edge)
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, rect: R(400, 100, 50, 50) }]), AI_TILE_SORT_LAYER);
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, rect: R(300, 100, 50, 50) }]), AI_TILE_SORT_LAYER);
  // other AI tiles under it are moved too, so they keep their order among themselves
  assert.equal(aiTileSortLayer(me(), [{ ...plainUnder, ai: true }]), AI_TILE_SORT_LAYER);
  // a sort or elevation given as a string (document data) still compares as a number
  assert.equal(aiTileSortLayer(me({ sort: "3", elevation: "0" }), [{ ...plainUnder, sort: "2" }]), TILES_SORT_LAYER);
});

test("rectsOverlap", () => {
  assert.equal(rectsOverlap(R(0, 0, 10, 10), R(5, 5, 10, 10)), true);
  assert.equal(rectsOverlap(R(0, 0, 10, 10), R(10, 0, 10, 10)), false);
  assert.equal(rectsOverlap(R(0, 0, 10, 10), R(2, 2, 3, 3)), true);
  assert.equal(rectsOverlap(R(0, 0, 10, 10), null), false);
});

test("wiring: module.mjs installs the hooks at init; the runtime re-applies after Foundry's refreshState", () => {
  const mod = fs.readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");
  assert.match(mod, /import \{ installTileLayer \} from "\.\/tile\/tile-layer\.mjs"/);
  assert.match(mod, /installTileLayer\(\);/);
  const src = fs.readFileSync(new URL("../scripts/tile/tile-layer.mjs", import.meta.url), "utf8");
  assert.match(src, /Hooks\.on\("refreshTile"[\s\S]*?refreshState/);
  assert.match(src, /Hooks\.on\("drawTile"/);
  assert.match(src, /Hooks\.on\("canvasReady"/);
  for (const h of ["createTile", "updateTile", "deleteTile"]) assert.match(src, new RegExp(`Hooks\\.on\\("${h}"`));
  // the document is never written (client-side mesh placement only)
  assert.doesNotMatch(src, /\.update\(|updateEmbeddedDocuments|setFlag/);
});

// ---- runtime with a fake Foundry v14: Tile#_draw makes a mesh at sortLayer 0; the render flags (refresh -> refreshState
// -> 500, then the refreshTile hook) are applied only when the canvas ticker runs (a background / hidden tab does not run it).
{
  const { installTileLayer, applyTileLayer } = await import("../scripts/tile/tile-layer.mjs");
  const hooks = {};
  globalThis.Hooks = { on: (n, f) => (hooks[n] ??= []).push(f), callAll: (n, ...a) => (hooks[n] ?? []).forEach((f) => f(...a)) };
  const placeables = [];
  globalThis.canvas = { scene: { id: "S" }, tiles: { placeables } };
  const pending = new Set();
  class FakeTile {
    constructor(doc) { this.document = doc; this.renderFlags = { set: (f) => { Object.assign(this._flags, f); pending.add(this); } }; this._flags = {}; }
    get bounds() { const d = this.document; return { x: d.x, y: d.y, width: d.width, height: d.height }; }
    draw() {   // Tile#_draw + PlaceableObject#draw: new mesh at 0, "refresh" flags queued, drawTile hook
      this.mesh = { sortLayer: 0, destroyed: false };
      this.renderFlags.set({ refreshState: true });
      Hooks.callAll("drawTile", this);
    }
    tick() {   // PlaceableObject#applyRenderFlags
      const flags = this._flags; this._flags = {};
      if (flags.refreshState) this.mesh.sortLayer = TILES_SORT_LAYER;   // Tile#_refreshState
      Hooks.callAll("refreshTile", this, flags);
    }
  }
  const ticker = () => { for (const t of [...pending]) { pending.delete(t); t.tick(); } };
  const doc = (id, o = {}) => ({ id, parent: { id: "S" }, x: 100, y: 100, width: 200, height: 100, elevation: 0, sort: 3,
    flags: o.ai === false ? {} : { [MODULE_ID]: { [TILE_FLAG]: { key: id } } }, ...o });
  installTileLayer();
  installTileLayer();   // idempotent
  const ai = new FakeTile(doc("ai")); placeables.push(ai);
  const plain = new FakeTile(doc("plain", { ai: false, x: 900 })); placeables.push(plain);

  test("runtime: the AI tile mesh is on 247.5 right after draw, before any ticker frame (background tab / manual render)", () => {
    assert.equal(hooks.drawTile?.length, 1, "one drawTile hook");
    ai.draw(); plain.draw();
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
    assert.equal(plain.mesh.sortLayer, 0, "ordinary tile untouched (Foundry sets 500 on its refresh)");
  });

  test("runtime: after Foundry's refreshState wrote 500 the hook puts it back in the same pass", () => {
    ticker();
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
    assert.equal(plain.mesh.sortLayer, TILES_SORT_LAYER);
    ai.renderFlags.set({ refreshState: true }); ticker();   // hover / hidden toggle / fade end
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
    ai.renderFlags.set({ refreshMesh: true }); ticker();    // other flags never touch the layer
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
  });

  test("runtime: scene redraw / texture change (new mesh at 0) and canvasReady", () => {
    ai.draw();
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
    ai.mesh.sortLayer = 0; Hooks.callAll("canvasReady", canvas);
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
    ticker();
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
  });

  test("runtime: an ordinary tile moved under it -> 500 at once (updateTile), back -> 247.5; destroyed mesh ignored", () => {
    plain.document.x = 150; plain.document.sort = 1;
    Hooks.callAll("updateTile", plain.document, { x: 150 });
    assert.equal(ai.mesh.sortLayer, TILES_SORT_LAYER, "applied immediately, without a ticker frame");
    ticker(); assert.equal(ai.mesh.sortLayer, TILES_SORT_LAYER);
    plain.document.x = 900;
    Hooks.callAll("updateTile", plain.document, { x: 900 });
    assert.equal(ai.mesh.sortLayer, AI_TILE_SORT_LAYER);
    ticker();
    ai.mesh.destroyed = true;
    assert.equal(applyTileLayer(ai), null);
    Hooks.callAll("updateTile", { parent: { id: "other" } }, {});   // another scene: nothing
  });
  delete globalThis.Hooks; delete globalThis.canvas;
}

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
