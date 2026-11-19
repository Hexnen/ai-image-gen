// W6-M: generative depth engine tuned from the owner's depth-map tests: default prompt (verbatim), default model/quality
// (GPT Image 2.6 Sunburst, low), v2 -> v3 migration of an untouched old default, output size from the source's shape,
// optional style-example depth map (second reference + prefix, default OFF).
// Node only, stubbed fetch: NO real call, NO real key. Run from the module folder: node dev/test-depth-gen-tuning.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEPTH_SCHEMA, GEN_PROMPT_DEFAULT, GEN_PROMPT_DEFAULT_V2, GEN_STYLE_PREFIX, RANGES,
  depthDefaults, normalizeDepth, depthFromForm, cleanStylePath
} from "../scripts/depth-settings.mjs";
import { genDepthConfig, genOutputSize, genPrompt, genEstimate, runGenerativeDepth, GEN_REF_PURPOSE, GEN_STYLE_PURPOSE, GEN_MAX_LONG } from "../scripts/depth/generative.mjs";
import { planRef, openaiInputTokens } from "../scripts/image-cost.mjs";
import { encodeDepthPng16 } from "../scripts/depth/post.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// Foundry stubs: providers/index.mjs only touches these at call time
const Fld = class {};
globalThis.foundry ??= { data: { fields: { NumberField: Fld, StringField: Fld, ObjectField: Fld, BooleanField: Fld, DataField: Fld } }, utils: { escapeHTML: (s) => s } };
globalThis.game ??= { settings: { get: () => undefined }, user: { isGM: true }, i18n: { localize: (k) => k, format: (k) => k, has: () => false }, modules: new Map() };
const providers = await import("../scripts/providers/index.mjs");

// The owner's prompt exactly as given in the brief (2026-11-18). Must be the default, byte for byte.
const OWNER_PROMPT = [
  "Create a grayscale depth map from the input image.",
  "",
  "Preserve the original composition, geometry, proportions and object boundaries.",
  "",
  "Represent depth as luminance:",
  "- Pure white: closest objects.",
  "- Light gray: foreground.",
  "- Mid gray: middle distance.",
  "- Dark gray: background.",
  "- Pure black: farthest areas.",
  "",
  "Use smooth, continuous depth transitions.",
  "Objects closer to the camera must be brighter than objects farther away.",
  "Maintain clear depth separation between overlapping objects.",
  "Avoid shadows, lighting effects, textures, colors and artistic interpretation.",
  "",
  "Output a single-channel grayscale depth map.",
  "Do not add, remove or modify objects."
].join("\n");
const OWNER_STYLE_PREFIX = "Generate a depth map in the style of image 2 (the style example) for the picture in image 1 (the source). Image 2 only shows the desired look of the depth map; do not copy its content or shape.";

// ---------- defaults ----------
await test("default prompt is the owner's prompt verbatim (LF line breaks, no stray whitespace) and survives normalisation", () => {
  assert.equal(GEN_PROMPT_DEFAULT, OWNER_PROMPT);
  assert.ok(!GEN_PROMPT_DEFAULT.includes("\r"));
  assert.equal(depthDefaults().gen.prompt, OWNER_PROMPT);
  assert.equal(normalizeDepth({}).gen.prompt, OWNER_PROMPT);
  assert.equal(genPrompt(normalizeDepth({})), OWNER_PROMPT);
  assert.equal(genPrompt({ gen: { prompt: "   " } }), OWNER_PROMPT, "empty prompt -> default");
  assert.ok(OWNER_PROMPT.length < 2000, "fits GEN_PROMPT_MAX and the textarea maxlength");
  // a CRLF copy of the source file (git autocrlf) still gives LF: template literals normalise line terminators
  assert.ok(/GEN_PROMPT_DEFAULT = `Create a grayscale depth map/.test(readFileSync(new URL("../scripts/depth-settings.mjs", import.meta.url), "utf8")));
});

await test("default model / quality: GPT Image 2.6 Sunburst, low, sync; other models and qualities stay selectable", () => {
  const d = depthDefaults().gen;
  assert.deepEqual([d.provider, d.model, d.quality, d.maxLong, d.styleRef], ["openai", "gpt-image-2.6-sunburst", "low", 1280, ""]);
  assert.equal(GEN_MAX_LONG, 1280);
  const c = genDepthConfig(normalizeDepth({ engine: "generative" }), { width: 1024, height: 1024 });
  assert.deepEqual([c.provider, c.model, c.quality, c.defaultMode, c.defaultCount], ["openai", "gpt-image-2.6-sunburst", "low", "fast", 1]);
  // unknown quality -> low (the depth default), not the model's image default
  assert.equal(genDepthConfig({ gen: { provider: "openai", model: "gpt-image-2.6-sunburst", quality: "bogus" } }, { width: 8, height: 8 }).quality, "low");
  // the others are still accepted as chosen
  for (const [model, quality] of [["gpt-image-2.6-flare", "medium"], ["gpt-image-2.5-flare", "high"], ["gpt-image-2.5-sunburst", "low"]]) {
    const x = genDepthConfig(normalizeDepth({ gen: { provider: "openai", model, quality } }), { width: 1024, height: 1024 });
    assert.deepEqual([x.model, x.quality], [model, quality]);
  }
  const g = genDepthConfig(normalizeDepth({ gen: { provider: "gemini", model: "gemini-3.1-flash-image" } }), { width: 1024, height: 1024 });
  assert.equal(g.model, "gemini-3.1-flash-image");
  // other provider without a model -> that provider's first model (Sunburst is OpenAI-only)
  assert.equal(genDepthConfig({ gen: { provider: "gemini" } }, { width: 8, height: 8 }).model, providers.getModel("gemini", "gemini-nano-banana-2.1") ? "gemini-nano-banana-2.1" : g.model);
});

// ---------- migration ----------
await test("migration v2 -> v3: an untouched old default prompt is replaced; untouched Flare/medium moves to Sunburst/low", () => {
  assert.equal(DEPTH_SCHEMA, 3);
  const v2 = { v: 2, engine: "generative", gen: { provider: "openai", model: "gpt-image-2.6-flare", quality: "medium", imageSize: "1K", prompt: GEN_PROMPT_DEFAULT_V2 } };
  const n = normalizeDepth(v2);
  assert.equal(n.v, 3);
  assert.equal(n.gen.prompt, OWNER_PROMPT);
  assert.deepEqual([n.gen.model, n.gen.quality, n.gen.maxLong, n.gen.styleRef], ["gpt-image-2.6-sunburst", "low", 1280, ""]);
  assert.deepEqual(normalizeDepth(n), n, "idempotent after the migration");
  // a save without `v` counts as old
  assert.equal(normalizeDepth({ gen: { prompt: GEN_PROMPT_DEFAULT_V2 } }).gen.prompt, OWNER_PROMPT);
  // stray whitespace around the old default (textarea round trip) still counts as untouched
  assert.equal(normalizeDepth({ v: 2, gen: { prompt: `  ${GEN_PROMPT_DEFAULT_V2}\n` } }).gen.prompt, OWNER_PROMPT);
});

await test("migration never touches what the GM chose: own prompt, own model/quality, other provider, current schema", () => {
  const own = normalizeDepth({ v: 2, gen: { provider: "openai", model: "gpt-image-2.6-flare", quality: "medium", prompt: "my own depth prompt" } });
  assert.equal(own.gen.prompt, "my own depth prompt");
  assert.deepEqual([own.gen.model, own.gen.quality], ["gpt-image-2.6-flare", "medium"], "an edited gen block keeps its model");
  const hi = normalizeDepth({ v: 2, gen: { provider: "openai", model: "gpt-image-2.6-flare", quality: "high", prompt: GEN_PROMPT_DEFAULT_V2 } });
  assert.equal(hi.gen.prompt, OWNER_PROMPT, "old default prompt replaced");
  assert.deepEqual([hi.gen.model, hi.gen.quality], ["gpt-image-2.6-flare", "high"], "a chosen quality keeps the model too");
  const s25 = normalizeDepth({ v: 2, gen: { provider: "openai", model: "gpt-image-2.5-sunburst", quality: "medium", prompt: GEN_PROMPT_DEFAULT_V2 } });
  assert.deepEqual([s25.gen.model, s25.gen.quality], ["gpt-image-2.5-sunburst", "medium"]);
  const gem = normalizeDepth({ v: 2, gen: { provider: "gemini", model: "gemini-3.1-flash-image", quality: "medium", prompt: GEN_PROMPT_DEFAULT_V2 } });
  assert.deepEqual([gem.gen.provider, gem.gen.model, gem.gen.prompt], ["gemini", "gemini-3.1-flash-image", OWNER_PROMPT]);
  // in a v3 save the old text is a deliberate choice: kept
  const v3 = normalizeDepth({ v: 3, gen: { provider: "openai", model: "gpt-image-2.6-flare", quality: "medium", prompt: GEN_PROMPT_DEFAULT_V2 } });
  assert.deepEqual([v3.gen.prompt, v3.gen.model, v3.gen.quality], [GEN_PROMPT_DEFAULT_V2, "gpt-image-2.6-flare", "medium"]);
  // a v1 save (no gen) just gets the new defaults; its other values stay
  const v1 = normalizeDepth({ v: 1, enabled: true, model: "da2-small", post: { gamma: 0.75 } });
  assert.deepEqual([v1.enabled, v1.model, v1.post.gamma, v1.gen.model, v1.gen.prompt], [true, "da2-small", 0.75, "gpt-image-2.6-sunburst", OWNER_PROMPT]);
});

// ---------- output size ----------
const MIN_PX = 655_360, MAX_PX = 8_294_400;
const valid26 = (s) => s.width % 16 === 0 && s.height % 16 === 0 && s.width * s.height >= MIN_PX && s.width * s.height <= MAX_PX && Math.max(s.width, s.height) <= 3840;

await test("output size: square -> 1024x1024, 9:16 -> 720x1280 (owner's test sizes), 16:9 -> 1280x720, 2:3 -> 832x1248", () => {
  const M = "gpt-image-2.6-sunburst";
  assert.deepEqual(genOutputSize("openai", M, 1024, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(genOutputSize("openai", M, 2048, 2048), { width: 1024, height: 1024 });
  assert.deepEqual(genOutputSize("openai", M, 1080, 1920), { width: 720, height: 1280 });
  assert.deepEqual(genOutputSize("openai", M, 941, 1672), { width: 720, height: 1280 }, "the owner's 9:16-ish portrait");
  assert.deepEqual(genOutputSize("openai", M, 1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(genOutputSize("openai", M, 1024, 1536), { width: 832, height: 1248 });
  // through the config, with the stored maxLong
  const c = genDepthConfig(normalizeDepth({ engine: "generative" }), { width: 1080, height: 1920 });
  assert.deepEqual([c.width, c.height], [720, 1280]);
  const sq = genDepthConfig(normalizeDepth({ engine: "generative" }), { width: 512, height: 512 });
  assert.deepEqual([sq.width, sq.height], [1024, 1024], "a tall portrait is not forced into a square, a square stays one");
});

await test("output size: always valid for the 2.6 rules, aspect close to the source, long side <= maxLong unless the pixel minimum needs more", () => {
  const M = "gpt-image-2.6-sunburst";
  for (const maxLong of [1024, 1280, 1536, 2048]) {
    for (const [w, h] of [[1, 1], [2, 3], [3, 2], [3, 4], [4, 5], [9, 16], [16, 9], [1, 2], [2, 1], [5, 13], [1, 2.8], [2.8, 1], [1, 5], [7, 1]]) {
      const s = genOutputSize("openai", M, w * 300, h * 300, maxLong);
      assert.ok(valid26(s), `${w}:${h} cap ${maxLong} -> ${s.width}x${s.height}`);
      const ar = w / h, got = s.width / s.height;
      if (ar >= 1 / 2.8 && ar <= 2.8) assert.ok(Math.abs(Math.log(got / ar)) < 0.04, `${w}:${h} aspect kept: ${s.width}x${s.height}`);
      const long = Math.max(s.width, s.height);
      // the cap holds whenever ~1 MP at that cap still reaches the API minimum
      const capped = maxLong * maxLong * Math.min(ar, 1 / ar);
      if (capped >= MIN_PX * 1.05 && ar >= 1 / 2.8 && ar <= 2.8) assert.ok(long <= maxLong, `${w}:${h} cap ${maxLong}: ${s.width}x${s.height}`);
    }
  }
  // 9:16 with cap 1024: 576x1024 would be below 655 360 px -> the API minimum wins (still 9:16-ish)
  const s = genOutputSize("openai", M, 1080, 1920, 1024);
  assert.ok(valid26(s) && s.height > s.width, `${s.width}x${s.height}`);
  // the stored cap is clamped to its range
  assert.equal(normalizeDepth({ gen: { maxLong: 99999 } }).gen.maxLong, RANGES.genMaxLong[1]);
  assert.equal(normalizeDepth({ gen: { maxLong: 10 } }).gen.maxLong, RANGES.genMaxLong[0]);
  assert.equal(normalizeDepth({ gen: { maxLong: 1283 } }).gen.maxLong % 16, 0);
  assert.equal(depthFromForm({ "depth.gen.maxLong": 1536 }, normalizeDepth({})).gen.maxLong, 1536);
  // Gemini / OpenRouter: nearest supported aspect, a tall portrait stays tall
  const g = genOutputSize("gemini", "gemini-3.1-flash-image", 1080, 1920);
  assert.equal(g.width * 16, g.height * 9);
  const o = genOutputSize("openrouter", "openai/gpt-image-2.6-sunburst", 1080, 1920);
  assert.ok(o.height > o.width);
});

// ---------- style example ----------
await test("style example: OFF by default; only a Data path or http(s) URL is stored; set/cleared through the form", () => {
  assert.equal(depthDefaults().gen.styleRef, "");
  assert.equal(normalizeDepth({}).gen.styleRef, "");
  for (const bad of ["data:image/png;base64,AAAA", "blob:http://x/1", "javascript:alert(1)", "file:///C:/x.png", "a\nb.png", "x".repeat(2000), 42, null]) {
    assert.equal(cleanStylePath(bad), "", String(bad).slice(0, 30));
  }
  assert.equal(cleanStylePath("  worlds/w/depth/style_depth.png "), "worlds/w/depth/style_depth.png");
  assert.equal(cleanStylePath("https://example.test/s.webp"), "https://example.test/s.webp");
  const set = depthFromForm({ "depth.gen.styleRef": "assets/style.png" }, normalizeDepth({}));
  assert.equal(set.gen.styleRef, "assets/style.png");
  assert.equal(depthFromForm({ "depth.gen.styleRef": "" }, set).gen.styleRef, "");
  assert.equal(depthFromForm({}, set).gen.styleRef, "assets/style.png", "a field missing from the form keeps its value");
  // the prefix is the owner's wording; with a style example it goes first, then the depth prompt
  assert.equal(GEN_STYLE_PREFIX, OWNER_STYLE_PREFIX);
  assert.equal(genPrompt(normalizeDepth({}), { style: true }), `${OWNER_STYLE_PREFIX}\n\n${OWNER_PROMPT}`);
  assert.equal(genPrompt({ gen: { prompt: "own" } }, { style: true }), `${OWNER_STYLE_PREFIX}\n\nown`);
  assert.equal(genPrompt(normalizeDepth({})), OWNER_PROMPT, "no prefix without a style example");
});

await test("style example in the estimate: second reference's tokens added, its sent size shown", () => {
  const c = genDepthConfig(normalizeDepth({}), { width: 1080, height: 1920 });
  const one = genEstimate(c, { width: 1080, height: 1920 }, NaN);
  const two = genEstimate(c, { width: 1080, height: 1920 }, NaN, undefined, { width: 1024, height: 1024 });
  const sp = planRef({ width: 1024, height: 1024 }, { rules: "openai", purpose: GEN_STYLE_PURPOSE, maxEdge: c.refMaxEdge });
  assert.equal(one.styleRef, null);
  assert.deepEqual(two.styleRef, { width: sp.width, height: sp.height });
  assert.ok(Math.max(sp.width, sp.height) <= 512);
  assert.equal(two.refTokens, one.refTokens + openaiInputTokens(sp.width, sp.height).tokens);
  assert.ok(two.tokensUSD > one.tokensUSD);
  // the source reference itself is sent at <= 512 px (the owner's test condition)
  assert.ok(Math.max(one.ref.width, one.ref.height) <= 512 && GEN_REF_PURPOSE === "max");
});

const TEST_KEY = "sk-test-depth-0000"; // placeholder, never a real key
const realFetch = globalThis.fetch;
const pic = (w = 8, h = 12) => { const rgba = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = 255 - Math.round(255 * y / (h - 1)); rgba.set([v, v, v, 255], (y * w + x) * 4); } return { rgba, w, h }; };
const png = (tag) => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, tag])], { type: "image/png" });
const src = { w: 1080, h: 1920, blob: png(1) };
const style = { w: 1024, h: 1024, blob: png(2), path: "assets/style_depth.png" };

await test("style example wiring: second reference after the source, prefix in the prompt, refCount 2 in the estimate, one request with two images", async () => {
  const seen = { estimateRefs: null, confirm: null, args: null };
  const calls = [];
  const b64 = Buffer.from(await encodeDepthPng16(new Float32Array(4).fill(0.5), 2, 2)).toString("base64");
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }], usage: { input_tokens: 800, output_tokens: 800 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await runGenerativeDepth({ depth: normalizeDepth({ engine: "generative", gen: { styleRef: style.path } }), name: "hero", img: src, style }, {
      estimate: (cfg, refCount) => { seen.estimateRefs = refCount; return { display: 0.03, source: "table", n: 0 }; },
      confirm: async (est) => { seen.confirm = est; return true; },
      execute: async (args) => {
        seen.args = args;
        const c = args.cfg;
        const r = await providers.generate({ provider: c.provider, apiKey: TEST_KEY, model: c.model, prompt: args.prompt, refs: args.extraRefs, width: c.width, height: c.height, quality: c.quality, transparent: false, imageSize: c.imageSize, thinkingLevel: c.thinkingLevel, n: args.count });
        return { candidates: [{ index: 0, blob: r.blob, cost: r.cost }], cost: r.cost };
      },
      decode: async () => pic()
    });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen.estimateRefs, 2);
  assert.ok(seen.confirm.styleRef && seen.confirm.stylePath === style.path);
  const a = seen.args;
  assert.deepEqual(a.extraRefs, [src.blob, style.blob], "image 1 = source, image 2 = style example");
  assert.deepEqual(a.extraRefPurposes, [GEN_REF_PURPOSE, GEN_STYLE_PURPOSE]);
  assert.ok(a.prompt.startsWith(`${OWNER_STYLE_PREFIX}\n\n`) && a.prompt.endsWith(OWNER_PROMPT));
  assert.equal(a.count, 1);
  assert.equal(calls.length, 1);
  const form = calls[0].init.body;
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(form.get("quality"), "low");
  assert.equal(form.get("size"), "720x1280");
  assert.equal(form.get("prompt"), a.prompt);
});

await test("without a style example: one reference, no prefix, refCount 1; with one the confirmation is still required", async () => {
  let args = null, refs = null;
  await runGenerativeDepth({ depth: normalizeDepth({ engine: "generative" }), name: "x", img: src }, {
    estimate: (cfg, n) => { refs = n; return { display: 0.03 }; }, confirm: async () => true,
    execute: async (x) => { args = x; return { candidates: [{ blob: png(3), cost: 0.03 }], cost: 0.03 }; }, decode: async () => pic()
  });
  assert.equal(refs, 1);
  assert.deepEqual(args.extraRefs, [src.blob]);
  assert.equal(args.prompt, OWNER_PROMPT);
  let executed = 0;
  await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({ engine: "generative" }), name: "x", img: src, style }, {
    estimate: () => ({ display: 0.05 }), confirm: async () => false, execute: async () => { executed++; return {}; }, decode: async () => pic()
  }), (e) => e.cancelled === true);
  assert.equal(executed, 0);
  await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({}), name: "x", img: src, style: { w: 0, h: 0 } }, {
    estimate: () => ({ display: 0.05 }), confirm: async () => true, execute: async () => { executed++; return {}; }, decode: async () => pic()
  }), /style example/);
  assert.equal(executed, 0);
});

await test("run.mjs loads the style example from cfg.depth.gen.styleRef before the estimate and passes the reference count", () => {
  const run = readFileSync(new URL("../scripts/depth/run.mjs", import.meta.url), "utf8");
  assert.match(run, /depth\.gen\?\.styleRef/);
  assert.match(run, /load\(normalizeImagePath\(stylePath\) \|\| stylePath\)/);
  assert.match(run, /runGenerativeDepth\(\{ depth, typeKey, name: depthPathsFor\(key\)\.base, img, style \}/);
  assert.match(run, /estimate: \(cfg, refCount = 1\) => F\.estimateInfo\(cfg, refCount, "sync"\)/);
  assert.match(run, /code: "styleRef"/);
  // nothing bundled: no style-example image ships with the module
  const tpl = readFileSync(new URL("../templates/config.hbs", import.meta.url), "utf8");
  assert.match(tpl, /name="depth\.gen\.styleRef" value="\{\{depth\.gen\.styleRef\}\}"/);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
