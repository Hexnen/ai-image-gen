// W7-A/W7-B AI Tile: pure geometry (rectangle only), ONE sent picture = the surroundings (1.5/2/3x, clipped) with a red
// outline just outside the selection, request planning, input-cost estimate (one image), cutting the selection out of the
// whole result, alpha edge, Tile data, prompt + migration of the old default, window options (scripts/tile/tile-core.mjs).
// Run from the module folder: node dev/test-ai-tile-core.mjs
import assert from "node:assert/strict";
import {
  bboxOf, polygonArea, pointInPolygon, validShape, rectPoints, rectOf, intersect, nearestAspect, aspectsFor, expandToAspect,
  geminiSizeFor, planRegion, contextRect, selIn, outlineBands, positionText, inputEstimate, resultCrop, tileRaster, alphaRect,
  pointsIn, tileData, renderTilePrompt, gridInEdit, packGeometry, unpackGeometry, DEFAULT_TILE_PROMPT, TILE_TYPE_KEY, SHAPES,
  CONTEXT_FACTOR, CONTEXT_FACTORS, INPUT_IMAGES, OUTLINE_COLOR, OUTLINE_FRAC, OUTLINE_MIN, DEFAULT_TILE_OPTS,
  normalizeTileOptions, LEGACY_TILE_PROMPTS, isLegacyTilePrompt, tilePromptTemplate, captureInclude, CAPTURE_MAP_LAYERS
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

test("context rect: factor x wide and high around the same centre, selection in the middle; 1.5x and 3x", () => {
  const bbox = { x: 2000, y: 1000, width: 600, height: 300 };
  const c = contextRect(bbox, SCENE);
  assert.deepEqual(c.rect, { x: 1700, y: 850, width: 1200, height: 600 });
  assert.equal(c.clipped, false);
  assert.deepEqual(selIn(bbox, c.rect), { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 });
  assert.equal(positionText(selIn(bbox, c.rect)), "from 25% to 75% of its width and from 25% to 75% of its height");
  assert.deepEqual(contextRect(bbox, SCENE, 3).rect, { x: 1400, y: 700, width: 1800, height: 900 });
  assert.deepEqual(contextRect(bbox, SCENE, 1.5).rect, { x: 1850, y: 925, width: 900, height: 450 });
  assert.deepEqual([...CONTEXT_FACTORS], [1.5, 2, 3]);
  assert.equal(CONTEXT_FACTOR, 2);
});

test("context rect at the canvas edge is clipped (not shifted); the selection is off-centre and its position follows", () => {
  const bbox = { x: 50, y: 3800, width: 400, height: 200 };
  const c = contextRect(bbox, SCENE);
  assert.deepEqual(c.rect, { x: 0, y: 3700, width: 650, height: 300 });
  assert.equal(c.clipped, true);
  const s = selIn(bbox, c.rect);
  near(s.x0, 50 / 650); near(s.x1, 450 / 650); near(s.y0, 100 / 300); near(s.y1, 1);
  // a selection sticking out of the bounds is still fully inside the context
  const out = contextRect({ x: -20, y: 10, width: 100, height: 100 }, SCENE);
  assert.ok(contains(out.rect, { x: -20, y: 10, width: 100, height: 100 }));
});

test("OpenAI plan: ONE image = the 2x surroundings at scene px (capped by the type), region fits the request ratio", () => {
  // the owner's live test: selection 1050x700 in the middle, context 2100x1400
  const pts = rectPoints({ x: 1400, y: 1750 }, { x: 2450, y: 2450 });
  const p = planRegion({ points: pts, bounds: SCENE, cfg: OAI });
  assert.deepEqual(p.bbox, { x: 1400, y: 1750, width: 1050, height: 700 });
  assert.deepEqual(p.context, { x: 875, y: 1400, width: 2100, height: 1400 });
  assert.equal(p.factor, 2);
  assert.equal(p.clipped, false);
  const k = 2048 / 2100;
  assert.deepEqual({ width: p.request.width, height: p.request.height }, normalizeOpenAISize(2100 * k, 1400 * k));
  assert.deepEqual(p.edit, { width: p.request.width, height: p.request.height }, "sent image = request size");
  near(p.region.width / p.region.height, p.ratio, 0.004, "region ratio");
  assert.ok(contains(p.region, p.context) && contains(p.region, p.bbox));
  assert.ok(p.region.width <= 2100 + 16 && p.region.height <= 1400 + 16, `only rounding growth: ${JSON.stringify(p.region)}`);
  near(p.sel.x0, 0.25, 0.005); near(p.sel.x1, 0.75, 0.005); near(p.sel.y0, 0.25, 0.005); near(p.sel.y1, 0.75, 0.005);
  // a type limit of 3840 keeps native scene px (no upscaling): the selection gets its full resolution
  const big = planRegion({ points: pts, bounds: SCENE, cfg: { ...OAI, width: 3840, height: 3840 } });
  assert.deepEqual({ width: big.request.width, height: big.request.height }, normalizeOpenAISize(2100, 1400));
  assert.ok((big.sel.x1 - big.sel.x0) * big.edit.width >= 1050 - 16, "selection at about native resolution");
  // 3x surroundings
  const p3 = planRegion({ points: pts, bounds: SCENE, cfg: OAI, factor: 3 });
  assert.deepEqual(p3.context, { x: 350, y: 1050, width: 3150, height: 2100 });
  assert.ok(Math.max(p3.request.width, p3.request.height) <= 2048);
});

test("OpenAI plan: small selection is never below the API minimum; thin one widened below 2.9:1; edge selection off-centre", () => {
  const small = planRegion({ points: rectPoints({ x: 1000, y: 1000 }, { x: 1100, y: 1050 }), bounds: SCENE, cfg: OAI });
  assert.ok(small.request.width * small.request.height >= 655_360);
  assert.ok(contains(small.region, small.bbox));
  const thin = planRegion({ points: rectPoints({ x: 100, y: 1000 }, { x: 2100, y: 1100 }), bounds: SCENE, cfg: OAI });
  assert.ok(thin.ratio < 2.9 + 1e-9);
  assert.ok(contains(thin.region, thin.bbox) && contains(SCENE, thin.region));
  const edge = planRegion({ points: rectPoints({ x: 50, y: 3800 }, { x: 450, y: 4000 }), bounds: SCENE, cfg: OAI });
  assert.equal(edge.clipped, true);
  assert.ok(contains(SCENE, edge.region) && contains(edge.region, edge.bbox));
  near(edge.sel.y1, 1, 1e-9, "selection on the bottom edge of the picture");
  assert.ok(edge.sel.x0 < 0.2, "selection near the left edge, not in the middle");
});

test("Gemini / OpenRouter plan: aspect from the model list, region grown to it, sent image <= 1536 and <= region px (min 512)", () => {
  const p = planRegion({ points: rectPoints({ x: 1000, y: 1000 }, { x: 1800, y: 1450 }), bounds: SCENE, cfg: { provider: "gemini", model: "gemini-3.1-flash-image", imageSize: "2K" } });
  assert.equal(p.request.aspect, "16:9");
  assert.equal(p.request.imageSize, "2K");
  near(p.region.width / p.region.height, 16 / 9, 0.004);
  assert.ok(contains(p.region, p.context));
  assert.ok(Math.max(p.edit.width, p.edit.height) <= 1536);
  const small = planRegion({ points: rectPoints({ x: 1000, y: 1000 }, { x: 1100, y: 1100 }), bounds: SCENE, cfg: { provider: "openrouter", model: "google/gemini-3.1-flash-image" } });
  assert.ok(Math.max(small.edit.width, small.edit.height) <= Math.max(512, small.region.width, small.region.height));
});

test("outline: bands sit just OUTSIDE the selection (no red pixel inside), thickness ~0.4% of the long side, min 4 px", () => {
  const w = 1536, h = 1024;
  const sel = { x0: 0.2504, y0: 0.2497, x1: 0.7499, y1: 0.7502 };
  const o = outlineBands(sel, w, h);
  assert.equal(o.lw, Math.max(OUTLINE_MIN, Math.round(OUTLINE_FRAC * 1536)));
  assert.equal(o.lw, 6);
  assert.equal(OUTLINE_COLOR, "#ff0000");
  // inner bounds round OUTWARDS: every pixel touching the selection is outside all bands
  assert.ok(o.inner.x0 <= sel.x0 * w && o.inner.x1 >= sel.x1 * w && o.inner.y0 <= sel.y0 * h && o.inner.y1 >= sel.y1 * h);
  const inside = (px, py) => o.bands.some((b) => px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height);
  for (let x = o.inner.x0; x < o.inner.x1; x += 7) for (let y = o.inner.y0; y < o.inner.y1; y += 7) assert.ok(!inside(x, y), `red at ${x},${y}`);
  for (const [x, y] of [[o.inner.x0, o.inner.y0], [o.inner.x1 - 1, o.inner.y1 - 1], [o.inner.x0, o.inner.y1 - 1], [o.inner.x1 - 1, o.inner.y0]]) assert.ok(!inside(x, y));
  // the frame closes around the selection: pixels just outside each side are red
  assert.ok(inside(o.inner.x0 - 1, h / 2) && inside(o.inner.x1, h / 2) && inside(w / 2, o.inner.y0 - 1) && inside(w / 2, o.inner.y1));
  assert.ok(inside(o.inner.x0 - o.lw, o.inner.y0 - o.lw) && !inside(o.inner.x0 - o.lw - 1, h / 2));
  // small image: minimum thickness; selection on the picture edge: that band is cut away
  assert.equal(outlineBands({ x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }, 400, 300).lw, 4);
  const e = outlineBands({ x0: 0, y0: 0.5, x1: 0.5, y1: 1 }, 1000, 1000);
  assert.ok(e.bands.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.width <= 1000 && b.y + b.height <= 1000));
  assert.equal(e.bands.length, 2, "left and bottom bands fall outside the picture");
});

test("input estimate: ONE image; OpenAI tokens = the sent image as is (no shrinking); others: no token count", () => {
  assert.equal(INPUT_IMAGES, 1);
  const e = inputEstimate(OAI, { width: 1536, height: 1024 });
  assert.equal(e.images, 1);
  assert.equal(e.tokens, openaiInputTokens(1536, 1024).tokens);
  assert.deepEqual(e.sent, { width: 1536, height: 1024 });
  const o = inputEstimate({ provider: "openrouter", model: "openai/gpt-image-2.6" }, { width: 1024, height: 1024 });
  assert.equal(o.tokens, openaiInputTokens(1024, 1024).tokens, "OpenAI models via OpenRouter use the OpenAI rules");
  const g = inputEstimate({ provider: "gemini", model: "gemini-3.1-flash-image" }, { width: 1024, height: 576 });
  assert.deepEqual([g.images, g.tokens], [1, null]);
});

test("resultCrop: same ratio = whole image; wider/taller result = centre crop", () => {
  assert.deepEqual(resultCrop(1536, 1024, 1.5), { sx: 0, sy: 0, sw: 1536, sh: 1024 });
  assert.deepEqual(resultCrop(1024, 1024, 1.5), { sx: 0, sy: 171, sw: 1024, sh: 683 });
  assert.deepEqual(resultCrop(2000, 1000, 1.5), { sx: 250, sy: 0, sw: 1500, sh: 1000 });
});

test("tileRaster cuts exactly the selection out of the whole returned picture and scales it to the tile file", () => {
  // the owner's live test geometry: context 2100x1400 sent as 1536x1024, selection 1050x700 in the middle
  const bbox = { x: 1400, y: 1750, width: 1050, height: 700 };
  const region = { x: 875, y: 1400, width: 2100, height: 1400 };
  const r = tileRaster({ bbox, region, resultW: 1536, resultH: 1024, ratio: 1.5 });
  near(r.scale, 1536 / 2100);
  assert.deepEqual(r.out, { width: Math.round(1050 * r.scale), height: Math.round(700 * r.scale) });
  near(r.draw.sx, 384); near(r.draw.sy, 256); near(r.draw.sw, 768); near(r.draw.sh, 512);
  assert.deepEqual([r.draw.dx, r.draw.dy, r.draw.dw, r.draw.dh], [0, 0, r.out.width, r.out.height]);
  // any scene point inside the selection maps to the same place through the result and through the file
  const pt = { x: 2000, y: 2000 };
  const inResult = { x: ((pt.x - region.x) / region.width) * 1536, y: ((pt.y - region.y) / region.height) * 1024 };
  const inFile = { x: (pt.x - bbox.x) * r.scale, y: (pt.y - bbox.y) * r.scale };
  near(r.draw.sx + (inFile.x / r.draw.dw) * r.draw.sw, inResult.x, 1e-9);
  near(r.draw.sy + (inFile.y / r.draw.dh) * r.draw.sh, inResult.y, 1e-9);
  // a result in another ratio: centre crop first, then the selection inside it
  const sq = tileRaster({ bbox, region, resultW: 1024, resultH: 1024, ratio: 1.5 });
  near(sq.draw.sx, 256); near(sq.draw.sy, 171 + 683 / 4, 1e-9); near(sq.draw.sw, 512);
  // off-centre selection (canvas edge): position from the region, not the middle
  const edge = tileRaster({ bbox: { x: 0, y: 3700, width: 400, height: 300 }, region: { x: 0, y: 3400, width: 900, height: 600 }, resultW: 1536, resultH: 1024, ratio: 1.5 });
  near(edge.draw.sx, 0); near(edge.draw.sy, 512); near(edge.draw.sh, 512);
  const capped = tileRaster({ bbox, region, resultW: 1536, resultH: 1024, ratio: 1.5, maxEdge: 512 });
  assert.equal(Math.max(capped.out.width, capped.out.height), 512);
  near(capped.draw.sw, 768, 1e-9, "source stays the whole selection when the file is capped");
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

test("tileData: v14 x/y = centre (anchor 0.5), rotation 0, sort above tiles of the same elevation", () => {
  const d = tileData({ bbox: { x: 1, y: 2, width: 3, height: 4 }, src: "a.webp", existing: [{ elevation: 0, sort: 5 }, { elevation: 20, sort: 99 }, { sort: 7 }] });
  assert.deepEqual({ x: d.x, y: d.y, width: d.width, height: d.height, rotation: d.rotation, elevation: d.elevation, sort: d.sort }, { x: 2.5, y: 4, width: 3, height: 4, rotation: 0, elevation: 0, sort: 8 });
  assert.equal(d.texture.src, "a.webp");
  assert.deepEqual([d.texture.anchorX, d.texture.anchorY], [0.5, 0.5]);
  const e = tileData({ bbox: { x: 1400, y: 1750, width: 1050, height: 700 }, src: "c" });
  assert.deepEqual([e.x - e.width * e.texture.anchorX, e.y - e.height * e.texture.anchorY], [1400, 1750], "top-left back at the selection");
  assert.equal(tileData({ bbox: { x: 0, y: 0, width: 1, height: 1 }, src: "b" }).sort, 0);
  // W8: a new AI tile starts hidden from the players (GM only) unless asked otherwise
  assert.equal(d.hidden, true);
  assert.equal(tileData({ bbox: { x: 0, y: 0, width: 1, height: 1 }, src: "b", hidden: false }).hidden, false);
});

test("prompt: one picture, edit only inside the red rectangle, keep framing, remove the outline; no mask, no second image", () => {
  const base = { description: "a collapsed wall with rubble. ", grid: 141.7, distance: 5, units: "ft", pos: positionText({ x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }) };
  const p = renderTilePrompt(DEFAULT_TILE_PROMPT, base);
  assert.match(p, /^This is a top-down battle map\./);
  assert.match(p, /Edit ONLY the area inside the red rectangle: a collapsed wall with rubble\./);
  assert.match(p, /Everything outside the red rectangle must stay exactly the same, pixel for pixel\./);
  assert.match(p, /Do not zoom out, do not crop, do not add or remove objects unless asked\./);
  assert.match(p, /Return the whole image with the same framing and remove the red rectangle outline\./);
  assert.match(p, /142 px/);
  assert.match(p, /5 ft/);
  assert.ok(!p.includes("{") && !/\s{2}/.test(p), p);
  assert.ok(!/mask|image 2|two images/i.test(p), p);
  assert.equal(renderTilePrompt("{description} on {scene}", { description: "x", scene: "Warehouse" }), "x on Warehouse");
  // old custom templates with {guide} / {pos} still render (guide is empty now)
  assert.equal(renderTilePrompt("A {guide} B ({pos})", { pos: "here" }), "A B (here)");
  near(gridInEdit(100, { width: 1536 }, { width: 2100 }), 73.1428, 0.001);
});

test("prompt migration: the earlier default (W7-A, two images) becomes the new default; own templates stay", () => {
  assert.equal(LEGACY_TILE_PROMPTS.length >= 1, true);
  const old = LEGACY_TILE_PROMPTS[0];
  assert.match(old, /You get two images/);
  assert.ok(isLegacyTilePrompt(old));
  assert.ok(isLegacyTilePrompt(old.replace(/ /g, "\r\n  ")), "whitespace differences from the text area do not matter");
  assert.equal(tilePromptTemplate(old), DEFAULT_TILE_PROMPT);
  assert.equal(tilePromptTemplate(""), DEFAULT_TILE_PROMPT);
  assert.equal(tilePromptTemplate(undefined), DEFAULT_TILE_PROMPT);
  assert.ok(!isLegacyTilePrompt(DEFAULT_TILE_PROMPT));
  const own = old.replace("battle map", "dungeon map");
  assert.equal(tilePromptTemplate(own), own, "an edited template is the user's own");
});

test("window options: defaults, context factor choices, old `mask` key ignored, clamping", () => {
  assert.deepEqual({ ...DEFAULT_TILE_OPTS }, { feather: 8, context: 2, count: 1 });
  assert.ok(!("mask" in DEFAULT_TILE_OPTS) && !("sendMask" in DEFAULT_TILE_OPTS));
  assert.deepEqual(normalizeTileOptions({ feather: 8, tokens: false, mask: true, count: 1 }), { feather: 8, context: 2, count: 1 }, "W7-A save");
  assert.deepEqual(normalizeTileOptions(), { feather: 8, context: 2, count: 1 });
  assert.deepEqual(normalizeTileOptions(null), { feather: 8, context: 2, count: 1 });
  assert.equal(normalizeTileOptions({ context: 1.5 }).context, 1.5);
  assert.equal(normalizeTileOptions({ context: "3" }).context, 3);
  assert.equal(normalizeTileOptions({ context: 5 }).context, 2);
  assert.equal(normalizeTileOptions({ feather: 0 }).feather, 0);
  assert.equal(normalizeTileOptions({ feather: 999 }).feather, 256);
  assert.equal(normalizeTileOptions({ count: 20 }).count, 8);
  assert.equal(normalizeTileOptions({ count: "x" }).count, 1);
});

test("geometry pack/unpack round trip (batch record)", () => {
  const pts = rectPoints({ x: 2000, y: 1000 }, { x: 2600, y: 1300 });
  const bbox = bboxOf(pts);
  const g = packGeometry({ sceneId: "s1", bbox, region: { x: 0, y: 0, width: 1, height: 1 }, ratio: 1.5, points: pts, feather: 8 });
  const u = unpackGeometry(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(u.points, pts);
  assert.equal(u.feather, 8);
});

test("W8 capture: ONLY the map (background + moinen-maps map layers) and the tiles under overhead (hidden too); nothing else", () => {
  const inc = captureInclude;
  // Foundry objects
  assert.equal(inc({ kind: "background", sortLayer: 0 }), true);
  assert.equal(inc({ kind: "foreground", sortLayer: 0, elevation: 20 }), false);
  assert.equal(inc({ kind: "tile", sortLayer: 500 }), true);
  assert.equal(inc({ kind: "tile", sortLayer: 500, hidden: true }), true, "a hidden tile is part of the map the GM builds (a new AI tile starts hidden)");
  assert.equal(inc({ kind: "tile", sortLayer: 500, overhead: true }), false, "roofs / overhead tiles are not the floor");
  assert.equal(inc({ kind: "token", sortLayer: 700 }), false);
  assert.equal(inc({ kind: "weather", sortLayer: 1000 }), false);
  // moinen-maps map layers stay: painted water, roads, ruins
  assert.deepEqual([...CAPTURE_MAP_LAYERS], [240, 245, 247]);
  for (const L of [240, 245, 247]) assert.equal(inc({ kind: "other", sortLayer: L, elevation: 0 }), true, `map layer ${L}`);
  // effects / marks / overlays go: reflections+shards 248, debris 249, districts 250, light glows 251, cars+ripples 255,
  // fire 256/750/800, zones 258, drawings 600, submerge 705, steam 801, presets 819-825, weather 990/995, orbit life 100, unknown
  for (const L of [100, 248, 249, 250, 251, 252, 253, 255, 256, 258, 600, 705, 750, 800, 801, 819, 820, 821, 825, 990, 995, 1100, undefined]) {
    assert.equal(inc({ kind: "other", sortLayer: L, elevation: 0 }), false, `effect layer ${L}`);
  }
  assert.equal(inc({ kind: "other", sortLayer: 247, elevation: 5 }), false, "a map layer number at another elevation is not the map");
  assert.equal(inc(null), false);
  // no window options for tokens / effects any more (old saves are ignored)
  assert.ok(!("tokens" in normalizeTileOptions({ tokens: true })) && !("effects" in normalizeTileOptions({ effects: true })));
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
