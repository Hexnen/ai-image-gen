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
  for (const h of ["createTile", "updateTile", "deleteTile"]) assert.match(src, new RegExp(`Hooks\\.on\\("${h}"`));
  // the document is never written (client-side mesh placement only)
  assert.doesNotMatch(src, /\.update\(|updateEmbeddedDocuments|setFlag/);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
