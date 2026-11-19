// W7-A AI Tile: what the providers really send for a tile edit (mocked fetch, fake keys, no network):
// OpenAI images/edits = image[] (1 = selection, 2 = context) + mask; Gemini / OpenRouter = 2 images, no mask; the mask
// never leaks to providers without one. Also: executeGeneration passes `editImage` first and unshrunk (source check).
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

// 1x1 PNG / a different-looking "PNG" for the context
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const crop = new Blob([PNG, new Uint8Array([1])], { type: "image/png" });
const context = new Blob([PNG, new Uint8Array([2, 2])], { type: "image/png" });
const mask = new Blob([PNG, new Uint8Array([3, 3, 3])], { type: "image/png" });
const B64 = Buffer.from(PNG).toString("base64");

function mockFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(respond(String(url))), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

await test("OpenAI: images/edits multipart, image 1 = selection, image 2 = context, mask set, size from the plan", async () => {
  const calls = mockFetch(() => ({ data: [{ b64_json: B64 }], usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { image_tokens: 8, text_tokens: 2 } } }));
  const r = await openai.generate({ apiKey: "sk-test-0000", model: "gpt-image-2.6-flare", prompt: "p", refs: [crop, context], mask, width: 1536, height: 1024, quality: "medium" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/images\/edits$/);
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  const imgs = form.getAll("image[]");
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].size, crop.size, "first image is the selection");
  assert.equal(imgs[1].size, context.size, "second image is the context");
  const m = form.get("mask");
  assert.ok(m, "mask sent");
  assert.equal(m.size, mask.size);
  assert.equal(m.type, "image/png");
  assert.equal(form.get("size"), "1536x1024");
  assert.equal(form.get("background"), null, "never transparent for tiles");
  assert.ok(r.blob instanceof Blob);
  assert.equal(r.route, "images/edits");
});

await test("OpenAI without refs never sends a mask (generations JSON)", async () => {
  const calls = mockFetch(() => ({ data: [{ b64_json: B64 }] }));
  await openai.generate({ apiKey: "sk-test-0000", model: "gpt-image-2.6-flare", prompt: "p", refs: [], mask, width: 1024, height: 1024 });
  assert.match(calls[0].url, /\/images\/generations$/);
  assert.ok(!/mask/.test(calls[0].init.body));
});

await test("Gemini: both images inline in order, then the prompt; no mask field anywhere", async () => {
  const calls = mockFetch(() => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: B64 } }] } }] }));
  await gemini.generate({ apiKey: "g-test", model: "gemini-3.1-flash-image", prompt: "tile prompt", refs: [crop, context], mask, aspectRatio: "16:9", imageSize: "1K" });
  const body = JSON.parse(calls[0].init.body);
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.equal(parts[0].inline_data.data, Buffer.from(await crop.arrayBuffer()).toString("base64"));
  assert.equal(parts[1].inline_data.data, Buffer.from(await context.arrayBuffer()).toString("base64"));
  assert.equal(parts[2].text, "tile prompt");
  assert.equal(body.generationConfig.image_config.aspect_ratio, "16:9");
  assert.ok(!JSON.stringify(body).includes("mask"));
});

await test("OpenRouter: two input_references in order, no mask", async () => {
  const calls = mockFetch(() => ({ data: [{ b64_json: B64 }], usage: { cost: 0.01 } }));
  await openrouter.generate({ apiKey: "or-test", model: "google/gemini-3.1-flash-image", prompt: "p", refs: [crop, context], mask, width: 1024, height: 576 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.input_references.length, 2);
  assert.ok(body.input_references[0].image_url.url.endsWith(Buffer.from(await crop.arrayBuffer()).toString("base64")));
  assert.ok(!JSON.stringify(body).includes("mask"));
  assert.equal(body.aspect_ratio, "16:9");
});

await test("executeGeneration: editImage goes first and unshrunk, the mask only to OpenAI (source contract)", () => {
  const src = fs.readFileSync(new URL("../scripts/generate-flow.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(editImage\) refs = \[editImage, \.\.\.refs\];/);
  assert.match(src, /\.\.\.\(mask && cfg\.provider === "openai" \? \{ mask \} : \{\}\)/);
  // the edit image is added AFTER sendableRefs (which would shrink it)
  assert.ok(src.indexOf("sendableRefs(cfg, await loadRefs") < src.indexOf("if (editImage) refs = [editImage"));
});

await test("tile flow sends [selection] as editImage + [context] as the only extra ref; batch sends both as refs", () => {
  const src = fs.readFileSync(new URL("../scripts/tile/tile-flow.mjs", import.meta.url), "utf8");
  assert.match(src, /extraRefs: \[job\.contextBlob\]/);
  assert.match(src, /editImage: job\.cropBlob, mask: job\.maskBlob \?\? undefined/);
  assert.match(src, /const refs = \[job\.cropBlob, ctx\];/);
  assert.match(src, /target: \{ uuid: job\.sceneUuid, field: "tile" \}/);
});

await test("batch apply routes tile items to the tile branch; picker routes tile batches to the tile window", () => {
  const a = fs.readFileSync(new URL("../scripts/batch/apply.mjs", import.meta.url), "utf8");
  assert.match(a, /if \(item\.meta\?\.tile\)[\s\S]*applyTileBatchItem\(item, blob, rec, savedPath, \{ candidateDir \}\)/);
  const p = fs.readFileSync(new URL("../scripts/pick-app.mjs", import.meta.url), "utf8");
  assert.match(p, /first\?\.meta\?\.tile[\s\S]*openTileBatchPick\(rec\)/);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
