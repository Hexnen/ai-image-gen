// W7-A AI Tile: pure geometry (rectangle only), image-1 region/request planning, image-2 context (2x, clipped),
// input-cost estimate, raster mapping, alpha edge, Tile data, prompt (scripts/tile/tile-core.mjs).
// Run from the module folder: node dev/test-ai-tile-core.mjs
import assert from "node:assert/strict";
import {
  bboxOf, polygonArea, pointInPolygon, validShape, rectPoints, rectOf, intersect, nearestAspect, aspectsFor, expandToAspect,
  geminiSizeFor, planRegion, contextPlan, positionText, inputEstimate, resultCrop, tileRaster, alphaRect, pointsIn,
  tileData, renderTilePrompt, gridInEdit, packGeometry, unpackGeometry, DEFAULT_TILE_PROMPT, TILE_TYPE_KEY, SHAPES,
  CONTEXT_EDGE, GUIDE_MASK
} from "../scripts/tile/tile-core.mjs";
import { normalizeOpenAISize } from "../scripts/providers/models.mjs";
import { openaiInputTokens } from "../scripts/image-cost.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} != ${b} (eps ${eps})`);
const SCENE = { x: 0, y: 0, width: 6000, height: 4000 };
const OAI = { provider: "openai", model: "gpt-image-2.6-flare", width: 2048, height: 2048, refPurpose: "max", refMaxEdge: 512 };
const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

test("type key passes the image-type key rule; only the rectangle is offered", () => {
  assert.match(TILE_TYPE_KEY, /^[a-z0-9][a-z0-9_-]{0,63}\.[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual([...SHAPES], ["rect"]);
});

test("rectangle from any corner order (whole px), bbox, area, point-in", () => {
  assert.deepEqual(rectPoints({ x: 100.4, y: 80.6 }, { x: 0.2, y: 0 }), [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 81 }, { x: 0, y: 81 }]);
  assert.deepEqual(bboxOf(rectOf({ x: 10, y: 20, width: 101, height: 51 })), { x: 10, y: 20, width: 101, height: 51 });
  near(polygonArea(rectPoints({ x: 0, y: 0 }, { x: 100, y: 50 })), 5000);
  assert.equal(pointInPolygon({ x: 10, y: 10 }, rectPoints({ x: 0, y: 0 }, { x: 20, y: 20 })), true);
  assert.equal(pointInPolygon({ x: 30, y: 10 }, rectPoints({ x: 0, y: 0 }, { x: 20, y: 20 })), false);
});

test("validShape rejects too few points, NaN and tiny rectangles", () => {
  assert.equal(validShape([{ x: 0, y: 0 }, { x: 1, y: 1 }]).ok, false);
  assert.equal(validShape([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 4, y: 4 }]).ok, false);
  assert.equal(validShape(rectPoints({ x: 0, y: 0 }, { x: 5, y: 500 })).reason, "small");
  assert.equal(validShape(rectPoints({ x: 0, y: 0 }, { x: 50, y: 50 })).ok, true);
});

test("intersect", () => {
  assert.deepEqual(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 10 }), { x: 5, y: 0, width: 5, height: 5 });
  assert.equal(intersect({ x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 }), null);
});

test("nearest aspect and provider aspect lists", () => {
  assert.equal(nearestAspect(1.0), "1:1");
  assert.equal(nearestAspect(1.78), "16:9");
  assert.equal(nearestAspect(5), "21:9");
  assert.equal(aspectsFor("openai", "gpt-image-2.6-flare"), null);
  assert.ok(aspectsFor("gemini", "gemini-nano-banana-2.1").includes("4:1"));
  assert.ok(!aspectsFor("openrouter", "x").includes("4:1"));
});

test("expandToAspect only grows, keeps the centre, matches the ratio, never uncovers the selection", () => {
  const r = expandToAspect({ x: 1000, y: 1000, width: 400, height: 100 }, 16 / 9);
  assert.deepEqual([r.width, r.height], [400, 225]);
  near(r.x + r.width / 2, 1200, 1);
  near(r.y + r.height / 2, 1050, 1);
  const edge = expandToAspect({ x: 10, y: 10, width: 100, height: 300 }, 1, SCENE);
  assert.deepEqual(edge, { x: 0, y: 10, width: 300, height: 300 });
  const huge = expandToAspect({ x: 0, y: 0, width: 7000, height: 100 }, 1, SCENE);
  assert.ok(contains(huge, { x: 0, y: 0, width: 7000, height: 100 }));
});

test("gemini imageSize: smallest >= long edge, capped by the type's size", () => {
  assert.equal(geminiSizeFor("gemini-3.1-flash-image", 400, "4K"), "0.5K");
  assert.equal(geminiSizeFor("gemini-3.1-flash-image", 1500, "4K"), "2K");
  assert.equal(geminiSizeFor("gemini-3.1-flash-image", 1500, "1K"), "1K");
  assert.equal(geminiSizeFor("gemini-nano-banana-2.1", 300, "2K"), "1K", "2.1 has no 0.5K");
});

test("OpenAI image 1: request = selection px within API rules, edit = request (mask match), region ~= selection", () => {
  const p = planRegion({ points: rectPoints({ x: 2000, y: 1000 }, { x: 2600, y: 1300 }), bounds: SCENE, cfg: OAI });
  assert.deepEqual(p.bbox, { x: 2000, y: 1000, width: 600, height: 300 });
  assert.deepEqual({ width: p.request.width, height: p.request.height }, normalizeOpenAISize(600, 300));
  assert.deepEqual(p.edit, { width: p.request.width, height: p.request.height });
  near(p.region.width / p.region.height, p.ratio, 0.004, "region ratio");
  assert.ok(contains(p.region, p.bbox));
  assert.ok(p.region.width <= 602 && p.region.height <= 302, `only rounding growth: ${JSON.stringify(p.region)}`);
});

test("OpenAI image 1: huge selection capped by the type's long edge; thin one widened below 2.9:1", () => {
  const big = planRegion({ points: rectPoints({ x: 0, y: 0 }, { x: 5000, y: 3000 }), bounds: SCENE, cfg: OAI });
  assert.ok(Math.max(big.request.width, big.request.height) <= 2048);
  const thin = planRegion({ points: rectPoints({ x: 100, y: 1000 }, { x: 4100, y: 1100 }), bounds: SCENE, cfg: OAI });
  assert.ok(thin.ratio < 2.9 + 1e-9);
  assert.ok(thin.region.height >= 4000 / 2.9 - 2 && contains(thin.region, thin.bbox));
});

test("Gemini image 1: aspect from the model list, region grown to it, edit image <= 1536 and <= 2 x region", () => {
  const p = planRegion({ points: rectPoints({ x: 1000, y: 1000 }, { x: 1800, y: 1450 }), bounds: SCENE, cfg: { provider: "gemini", model: "gemini-3.1-flash-image", imageSize: "2K" } });
  assert.equal(p.request.aspect, "16:9");
  near(p.region.width / p.region.height, 16 / 9, 0.004);
  assert.ok(contains(p.region, p.bbox));
  assert.ok(Math.max(p.edit.width, p.edit.height) <= 1536);
  const small = planRegion({ points: rectPoints({ x: 1000, y: 1000 }, { x: 1100, y: 1100 }), bounds: SCENE, cfg: { provider: "openrouter", model: "google/gemini-3.1-flash-image" } });
  assert.ok(Math.max(small.edit.width, small.edit.height) <= Math.max(512, 2 * small.region.width));
});

test("image 2 context: 2x wide and 2x high around the same centre, selection exactly in the middle", () => {
  const bbox = { x: 2000, y: 1000, width: 600, height: 300 };
  const c = contextPlan(bbox, SCENE);
  assert.deepEqual(c.rect, { x: 1700, y: 850, width: 1200, height: 600 });
  assert.deepEqual(c.sel, { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 });
  assert.equal(c.clipped, false);
  assert.deepEqual(c.size, { width: CONTEXT_EDGE, height: 512 });
  assert.equal(positionText(c.sel), "from 25% to 75% of its width and from 25% to 75% of its height");
});

test("image 2 context at the scene edge is clipped (not shifted) and the selection position follows", () => {
  const bbox = { x: 50, y: 3800, width: 400, height: 200 };
  const c = contextPlan(bbox, SCENE);
  assert.deepEqual(c.rect, { x: 0, y: 3700, width: 650, height: 300 });
  assert.equal(c.clipped, true);
  near(c.sel.x0, 50 / 650); near(c.sel.x1, 450 / 650); near(c.sel.y0, 100 / 300); near(c.sel.y1, 1);
  // small context is never upscaled
  assert.deepEqual(contextPlan({ x: 1000, y: 1000, width: 100, height: 50 }, SCENE).size, { width: 200, height: 100 });
});

test("input estimate: two images; OpenAI tokens = image 1 as sent + image 2 after the reference ladder", () => {
  const e = inputEstimate(OAI, { width: 1024, height: 1024 }, { width: 1024, height: 512 });
  assert.equal(e.images, 2);
  assert.equal(e.edit, openaiInputTokens(1024, 1024).tokens);
  assert.deepEqual(e.contextSent, { width: 512, height: 256 });
  assert.equal(e.context, openaiInputTokens(512, 256).tokens);
  assert.equal(e.total, e.edit + e.context);
  const g = inputEstimate({ provider: "gemini", model: "gemini-3.1-flash-image" }, { width: 1024, height: 576 }, { width: 1024, height: 576 });
  assert.equal(g.images, 2);
  assert.equal(g.total, null);
});

test("resultCrop: same ratio = whole image; wider/taller result = centre crop", () => {
  assert.deepEqual(resultCrop(1536, 1024, 1.5), { sx: 0, sy: 0, sw: 1536, sh: 1024 });
  assert.deepEqual(resultCrop(1024, 1024, 1.5), { sx: 0, sy: 171, sw: 1024, sh: 683 });
  assert.deepEqual(resultCrop(2000, 1000, 1.5), { sx: 250, sy: 0, sw: 1500, sh: 1000 });
});

test("tileRaster maps the region to the result and the selection to the file (scene px exact)", () => {
  const bbox = { x: 2000, y: 1000, width: 600, height: 300 };
  const region = { x: 1850, y: 850, width: 900, height: 600 };
  const r = tileRaster({ bbox, region, resultW: 1536, resultH: 1024, ratio: 1.5 });
  near(r.scale, 1536 / 900);
  assert.deepEqual(r.out, { width: Math.round(600 * r.scale), height: Math.round(300 * r.scale) });
  near(r.draw.dx, -150 * r.scale);
  near(r.draw.dw, 1536);
  const scenePt = { x: 2300, y: 1150 };
  near((scenePt.x - bbox.x) * r.scale, r.draw.dx + ((scenePt.x - region.x) / region.width) * r.draw.dw, 1e-9);
  const capped = tileRaster({ bbox, region, resultW: 1536, resultH: 1024, ratio: 1.5, maxEdge: 512 });
  assert.equal(Math.max(capped.out.width, capped.out.height), 512);
});

test("alphaRect: soft edge inside the file, 0 = whole file, never more than half the short side", () => {
  assert.deepEqual(alphaRect({ width: 200, height: 100 }, 0), { x: 0, y: 0, width: 200, height: 100, blur: 0 });
  assert.deepEqual(alphaRect({ width: 200, height: 100 }, 16), { x: 8, y: 8, width: 184, height: 84, blur: 4 });
  const big = alphaRect({ width: 200, height: 100 }, 500);
  assert.ok(big.width > 0 && big.height >= 0 && big.blur === 12.5);
});

test("pointsIn maps scene points into a scaled rectangle", () => {
  assert.deepEqual(pointsIn([{ x: 110, y: 220 }], { x: 100, y: 200 }, 2), [{ x: 20, y: 40 }]);
  assert.deepEqual(pointsIn([{ x: 110, y: 220 }], { x: 100, y: 200 }, 2, 3), [{ x: 20, y: 60 }]);
});

test("tileData: selection placement, rotation 0, sort above tiles of the same elevation", () => {
  const d = tileData({ bbox: { x: 1, y: 2, width: 3, height: 4 }, src: "a.webp", existing: [{ elevation: 0, sort: 5 }, { elevation: 20, sort: 99 }, { sort: 7 }] });
  assert.deepEqual({ x: d.x, y: d.y, width: d.width, height: d.height, rotation: d.rotation, elevation: d.elevation, sort: d.sort }, { x: 1, y: 2, width: 3, height: 4, rotation: 0, elevation: 0, sort: 8 });
  assert.equal(d.texture.src, "a.webp");
  assert.equal(tileData({ bbox: { x: 0, y: 0, width: 1, height: 1 }, src: "b" }).sort, 0);
});

test("prompt: says which image is which, position of the selection, mask sentence only with a mask", () => {
  const base = { description: "a collapsed wall with rubble. ", grid: 141.7, distance: 5, units: "ft", pos: positionText({ x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }) };
  const p = renderTilePrompt(DEFAULT_TILE_PROMPT, { ...base, guide: GUIDE_MASK });
  assert.match(p, /Image 1 is the exact area to edit/);
  assert.match(p, /Image 2 is a wider view/);
  assert.match(p, /red rectangle in image 2 \(from 25% to 75% of its width/);
  assert.match(p, /transparent area of the mask/);
  assert.match(p, /a collapsed wall with rubble\./);
  assert.match(p, /142 px/);
  assert.match(p, /5 ft/);
  assert.ok(!p.includes("{"), p);
  const noMask = renderTilePrompt(DEFAULT_TILE_PROMPT, { ...base, guide: "" });
  assert.ok(!/mask/.test(noMask) && !/\s{2}/.test(noMask), noMask);
  assert.equal(renderTilePrompt("{description} on {scene}", { description: "x", scene: "Warehouse" }), "x on Warehouse");
  near(gridInEdit(100, { width: 1536 }, { width: 900 }), 170.6666, 0.001);
});

test("geometry pack/unpack round trip (batch record)", () => {
  const pts = rectPoints({ x: 2000, y: 1000 }, { x: 2600, y: 1300 });
  const bbox = bboxOf(pts);
  const g = packGeometry({ sceneId: "s1", bbox, region: { x: 0, y: 0, width: 1, height: 1 }, ratio: 1.5, points: pts, feather: 8 });
  const u = unpackGeometry(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(u.points, pts);
  assert.equal(u.feather, 8);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
