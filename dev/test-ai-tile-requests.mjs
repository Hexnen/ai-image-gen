// W7-A/W7-B AI Tile: what the providers really send for a tile edit (mocked fetch, fake keys, no network).
// W7-B: ONE picture (the surroundings with the red outline), no mask, no second image: OpenAI images/edits = image[]
// with one file and no mask field; Gemini / OpenRouter = one image, then the prompt. Also source contracts: the tile
// flow passes the picture as `editImage` (first and unshrunk), no extra refs, no mask; batch sends the same one picture.
// Run from the module folder: node dev/test-ai-tile-requests.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

// minimal Foundry stubs: settings.mjs reads foundry.data.fields at import time
class Field { constructor(o) { this.o = o; } }
globalThis.foundry = { data: { fields: { NumberField: Field, StringField: Field, ObjectField: Field, BooleanField: Field } }, utils: {} };
globalThis.game = { settings: { get: () => undefined }, user: { isGM: true } };

const openai = await import("../scripts/providers/openai.mjs");
const gemini = await import("../scripts/providers/gemini.mjs");
const openrouter = await import("../scripts/providers/openrouter.mjs");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// 1x1 PNG standing in for the sent picture (surroundings + red outline)
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const picture = new Blob([PNG, new Uint8Array([1])], { type: "image/png" });
const B64 = Buffer.from(PNG).toString("base64");

function mockFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(respond(String(url))), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

await test("OpenAI: images/edits multipart with ONE image[] (the picture), no mask field, size from the plan", async () => {
  const calls = mockFetch(() => ({ data: [{ b64_json: B64 }], usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { image_tokens: 8, text_tokens: 2 } } }));
  const r = await openai.generate({ apiKey: "sk-test-0000", model: "gpt-image-2.6-flare", prompt: "p", refs: [picture], width: 1536, height: 1024, quality: "medium" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/images\/edits$/);
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  const imgs = form.getAll("image[]");
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].size, picture.size);
  assert.equal(form.get("mask"), null, "no mask");
  assert.equal(form.get("size"), "1536x1024");
  assert.equal(form.get("background"), null, "never transparent for tiles");
  assert.ok(r.blob instanceof Blob);
  assert.equal(r.route, "images/edits");
});

await test("OpenAI without refs never sends a mask (generations JSON)", async () => {
  const calls = mockFetch(() => ({ data: [{ b64_json: B64 }] }));
  await openai.generate({ apiKey: "sk-test-0000", model: "gpt-image-2.6-flare", prompt: "p", refs: [], width: 1024, height: 1024 });
  assert.match(calls[0].url, /\/images\/generations$/);
  assert.ok(!/mask/.test(calls[0].init.body));
});

await test("Gemini: the one picture inline, then the prompt; no mask field anywhere", async () => {
  const calls = mockFetch(() => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: B64 } }] } }] }));
  await gemini.generate({ apiKey: "g-test", model: "gemini-3.1-flash-image", prompt: "tile prompt", refs: [picture], aspectRatio: "16:9", imageSize: "1K" });
  const body = JSON.parse(calls[0].init.body);
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].inline_data.data, Buffer.from(await picture.arrayBuffer()).toString("base64"));
  assert.equal(parts[1].text, "tile prompt");
  assert.equal(body.generationConfig.image_config.aspect_ratio, "16:9");
  assert.ok(!JSON.stringify(body).includes("mask"));
});

await test("OpenRouter: one input_reference, no mask", async () => {
  const calls = mockFetch(() => ({ data: [{ b64_json: B64 }], usage: { cost: 0.01 } }));
  await openrouter.generate({ apiKey: "or-test", model: "google/gemini-3.1-flash-image", prompt: "p", refs: [picture], width: 1024, height: 576 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.input_references.length, 1);
  assert.ok(body.input_references[0].image_url.url.endsWith(Buffer.from(await picture.arrayBuffer()).toString("base64")));
  assert.ok(!JSON.stringify(body).includes("mask"));
  assert.equal(body.aspect_ratio, "16:9");
});

await test("executeGeneration: editImage goes first and unshrunk (source contract)", () => {
  const src = fs.readFileSync(new URL("../scripts/generate-flow.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(editImage\) refs = \[editImage, \.\.\.refs\];/);
  // the edit image is added AFTER sendableRefs (which would shrink it)
  assert.ok(src.indexOf("sendableRefs(cfg, await loadRefs") < src.indexOf("if (editImage) refs = [editImage"));
});

await test("tile flow: Now sends the one picture as editImage, no extra refs, no mask; batch sends the same one picture", () => {
  const src = fs.readFileSync(new URL("../scripts/tile/tile-flow.mjs", import.meta.url), "utf8");
  assert.match(src, /extraRefs: \[\], signal, runKind: "fast", caller: "ai-tile",\s*editImage: job\.sendBlob\s*\}/);
  assert.match(src, /const refs = \[job\.sendBlob\];/);
  assert.ok(!/mask/i.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "no mask anywhere in the tile flow code");
  assert.ok(!/contextBlob|cropBlob|prepareRefs/.test(src), "no second image, no reference shrinking");
  assert.match(src, /outlinedImage\(cap\.canvas, plan\.sel/);
  assert.match(src, /target: \{ uuid: job\.sceneUuid, field: "tile" \}/);
  const img = fs.readFileSync(new URL("../scripts/tile/tile-image.mjs", import.meta.url), "utf8");
  assert.ok(!/openaiMask|contextImage/.test(img));
  assert.match(img, /outlineBands\(sel, w, h\)\.bands/);
  const tpl = fs.readFileSync(new URL("../templates/tile-dialog.hbs", import.meta.url), "utf8");
  assert.ok(!/mask/i.test(tpl), "no mask option in the window");
  assert.match(tpl, /name="context"/);
});

await test("W9 tile flow: every result (test seam or provider) goes through the change analysis; file + Tile use the candidate's rectangle", () => {
  const src = fs.readFileSync(new URL("../scripts/tile/tile-flow.mjs", import.meta.url), "utf8");
  // the test seam replaces only executeGeneration: its candidates take the same path as real ones
  assert.match(src, /await \(tileTestHooks\.execute \?\? executeGeneration\)\(/);
  assert.match(src, /\.\.\.\(await processCandidate\(job, c\.blob\)\)/);
  assert.match(src, /if \(job\.opts\?\.expand !== false && job\.send\)/);
  assert.match(src, /measureExpansion\(job\.send, bmp, job\.geom, \{ bounds: job\.bounds \}\)/);
  assert.match(src, /const rect = expansion\?\.expanded \? expansion\.rect : job\.tileRect;/);
  assert.match(src, /processResult\(bmp, \{ \.\.\.job\.geom, tileRect: rect \}/, "the saved file is cut to the expanded rectangle");
  assert.match(src, /createTile\(scene, cand\.rect \?\? job\.tileRect, path/, "the Tile document follows the same rectangle");
  assert.match(src, /bounds: \{ x: bounds\.x, y: bounds\.y, width: bounds\.width, height: bounds\.height \}/);
  const app = fs.readFileSync(new URL("../scripts/tile/tile-app.mjs", import.meta.url), "utf8");
  assert.match(app, /this\.job\.opts = \{ \.\.\.this\.job\.opts, expand: this\.opts\.expand \}/, "the checkbox state reaches the job");
  assert.match(app, /this\.preview\.setRect\(this\.rect\)/, "the map preview shows the candidate's rectangle");
  const tpl = fs.readFileSync(new URL("../templates/tile-dialog.hbs", import.meta.url), "utf8");
  assert.match(tpl, /type="checkbox" name="expand" \{\{#if expand\}\}checked\{\{\/if\}\}/);
  for (const l of ["en", "pl"]) {
    const j = JSON.parse(fs.readFileSync(new URL(`../lang/${l}.json`, import.meta.url), "utf8"));
    for (const k of ["Expand", "ExpandHint", "Expanded", "ExpandedHint"]) assert.ok(j[`AIIMG.Tile.${k}`], `${l} ${k}`);
  }
});

await test("batch apply routes tile items to the tile branch; picker routes tile batches to the tile window", () => {
  const a = fs.readFileSync(new URL("../scripts/batch/apply.mjs", import.meta.url), "utf8");
  assert.match(a, /if \(item\.meta\?\.tile\)[\s\S]*applyTileBatchItem\(item, blob, rec, savedPath, \{ candidateDir \}\)/);
  const p = fs.readFileSync(new URL("../scripts/pick-app.mjs", import.meta.url), "utf8");
  assert.match(p, /first\?\.meta\?\.tile[\s\S]*openTileBatchPick\(rec\)/);
});

await test("capture renders canvas.primary children one by one (v14 cached group draws nothing), weather skipped; compose uses the v14 anchor", () => {
  const s = fs.readFileSync(new URL("../scripts/tile/tile-image.mjs", import.meta.url), "utf8");
  assert.match(s, /for \(const c of canvas\.primary\.children\)/);
  assert.match(s, /renderer\.render\(c, \{ renderTexture: rt, transform: m, clear: false \}\)/);
  assert.match(s, /WeatherEffects/);
  assert.ok(!/renderer\.render\(canvas\.primary,/.test(s), "never render the cached group itself");
  assert.match(s, /t\.x \+ \(0\.5 - ax\) \* t\.width/);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
