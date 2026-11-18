// W6-I: experimental generative depth engine (scripts/depth/generative.mjs). Node only, stubbed providers and fetch:
// NO real call, NO real key (the test key below is a fixed placeholder that only reaches the stubbed fetch).
// Covers: config / request shape (through the real providers code with a captured fetch), cost estimate, the mandatory
// confirmation, post-processing of a returned picture, errors. Run from the module folder: node dev/test-depth-gen.mjs
import assert from "node:assert/strict";
import { genDepthConfig, genEstimate, genModelsFor, genPrompt, runGenerativeDepth, GEN_REF_PURPOSE } from "../scripts/depth/generative.mjs";
import { normalizeDepth, GEN_PROMPT_DEFAULT } from "../scripts/depth-settings.mjs";
import { postProcess, encodeDepthPng16 } from "../scripts/depth/post.mjs";
import { planRef, openaiInputTokens, outputTokens, estimateRequest, DEFAULTS } from "../scripts/image-cost.mjs";
import { estimateSyncCost } from "../scripts/batch/cost.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// Foundry stubs: providers/index.mjs only touches these at call time
const F = class {};
globalThis.foundry ??= { data: { fields: { NumberField: F, StringField: F, ObjectField: F, BooleanField: F, DataField: F } }, utils: { escapeHTML: (s) => s } };
globalThis.game ??= { settings: { get: () => undefined }, user: { isGM: true }, i18n: { localize: (k) => k, format: (k) => k, has: () => false }, modules: new Map() };
const providers = await import("../scripts/providers/index.mjs");

const TEST_KEY = "sk-test-depth-0000"; // placeholder, never a real key
const realFetch = globalThis.fetch;
let calls = [];
const fakePngB64 = async () => Buffer.from(await encodeDepthPng16(new Float32Array(4).fill(0.5), 2, 2)).toString("base64");
function stubFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
}
const restore = () => { globalThis.fetch = realFetch; };

const src = { w: 1024, h: 1536, blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])], { type: "image/png" }) };
// gradient "depth picture" 8×12, white at the top
const pic = (w = 8, h = 12) => { const rgba = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = 255 - Math.round(255 * y / (h - 1)); rgba.set([v, v, v, 255], (y * w + x) * 4); } return { rgba, w, h }; };

/** execute stub = what generate-flow's runGeneration does for one OpenAI version: providers.generate with the cfg. */
const viaProviders = (sink) => async (args) => {
  sink.push(args);
  const c = args.cfg;
  const r = await providers.generate({ provider: c.provider, apiKey: TEST_KEY, model: c.model, prompt: args.prompt, refs: args.extraRefs, width: c.width, height: c.height, quality: c.quality, transparent: !!c.transparent, imageSize: c.imageSize, thinkingLevel: c.thinkingLevel, n: args.count });
  return { candidates: [{ index: 0, blob: r.blob, cost: r.cost }], failed: [], cost: r.cost };
};

await test("config: provider/model from cfg.depth.gen, source aspect kept inside the model's size rules, no refs/transparency", () => {
  const d = normalizeDepth({ engine: "generative", gen: { provider: "openai", model: "gpt-image-2.6-sunburst", quality: "high" } });
  const c = genDepthConfig(d, { width: 1024, height: 1536 });
  assert.equal(c.provider, "openai"); assert.equal(c.model, "gpt-image-2.6-sunburst"); assert.equal(c.quality, "high");
  assert.equal(c.width % 16, 0); assert.equal(c.height % 16, 0);
  assert.ok(Math.abs(c.width / c.height - 2 / 3) < 0.02, `${c.width}x${c.height}`);
  assert.ok(c.width * c.height >= 655360);
  assert.deepEqual([c.transparent, c.refs.length, c.refPurpose, c.defaultMode], [false, 0, GEN_REF_PURPOSE, "fast"]);
  // unknown model -> the depth default (W6-M: Sunburst 2.6); Gemini gets an aspect it supports and a valid size tier
  assert.equal(genDepthConfig(normalizeDepth({ gen: { provider: "openai", model: "nope" } }), { width: 10, height: 10 }).model, "gpt-image-2.6-sunburst");
  const g = genDepthConfig(normalizeDepth({ gen: { provider: "gemini", model: "gemini-3.1-flash-lite-image", imageSize: "4K" } }), { width: 1024, height: 1536 });
  assert.equal(g.provider, "gemini"); assert.equal(g.imageSize, "1K", "lite only has 1K");
  assert.equal(g.width * 3, g.height * 2, "2:3");
  assert.ok(genModelsFor("openrouter").length > 0);
  assert.equal(genPrompt(normalizeDepth({})), GEN_PROMPT_DEFAULT);
  assert.ok(/Pure white: closest objects./.test(GEN_PROMPT_DEFAULT) && /Do not add, remove or modify objects.$/.test(GEN_PROMPT_DEFAULT));
});

await test("estimate: OpenAI output + reference tokens like W6-D, the module's estimate is the shown cost", () => {
  const d = normalizeDepth({ gen: { provider: "openai", model: "gpt-image-2.6-flare", quality: "medium" } });
  const c = genDepthConfig(d, { width: 1024, height: 1536 });
  const table = estimateSyncCost(c.provider, c.model, [{ refs: [1], width: c.width, height: c.height, quality: c.quality }]);
  const e = genEstimate(c, { width: 1024, height: 1536 }, table);
  const plan = planRef({ width: 1024, height: 1536 }, { rules: "openai", purpose: "max", maxEdge: DEFAULTS.maxEdge });
  assert.deepEqual(e.ref, { width: plan.width, height: plan.height });
  assert.equal(e.ref.height, 512, "largest tier");
  assert.equal(e.refTokens, openaiInputTokens(plan.width, plan.height).tokens);
  assert.equal(e.outTokens, outputTokens("gpt-image-2.6", "medium", c.width, c.height) ?? e.outTokens);
  const req = estimateRequest({ outTokens: e.outTokens, refTokens: [e.refTokens], count: 1 });
  assert.equal(e.tokensUSD, req.perImage);
  assert.equal(e.usd, table);
  assert.ok(e.usd > 0.01 && e.usd < 1, `${e.usd}`);
  // no module estimate -> token estimate; Gemini -> no token table, cost from the module estimate only
  assert.equal(genEstimate(c, { width: 1024, height: 1536 }, NaN).usd, req.perImage);
  const g = genDepthConfig(normalizeDepth({ gen: { provider: "gemini", model: "gemini-3.1-flash-image" } }), { width: 1024, height: 1536 });
  const ge = genEstimate(g, { width: 1024, height: 1536 }, 0.067);
  assert.equal(ge.refTokens, null); assert.equal(ge.usd, 0.067);
});

await test("confirmation is required: a no, a dismissed dialog or a truthy non-true value never reaches execute/fetch", async () => {
  for (const answer of [false, null, undefined, "yes", 1]) {
    let executed = 0;
    stubFetch(() => { throw new Error("no network in tests"); });
    try {
      await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({ engine: "generative" }), name: "x", img: src }, {
        estimate: () => ({ display: 0.05, source: "table", n: 0 }), execute: async () => { executed++; return {}; },
        confirm: async () => answer, decode: async () => pic()
      }), (e) => e.cancelled === true && e.name === "AbortError");
    } finally { restore(); }
    assert.equal(executed, 0, String(answer));
    assert.equal(calls.length, 0, String(answer));
  }
});

await test("the confirmation sees the estimate before the call; one request, count 1, fast, the source as the only reference", async () => {
  const order = [];
  const sink = [];
  stubFetch(async () => new Response(JSON.stringify({ data: [{ b64_json: await fakePngB64() }], usage: { input_tokens: 700, output_tokens: 1400, input_tokens_details: { image_tokens: 600, text_tokens: 100 } } }), { status: 200, headers: { "content-type": "application/json" } }));
  let r;
  try {
    r = await runGenerativeDepth({ depth: normalizeDepth({ engine: "generative", gen: { prompt: "make depth" } }), typeKey: "invincible.Actor.superhero", name: "hero", img: src }, {
      estimate: (cfg) => { order.push("estimate"); return { display: 0.051, source: "learned", n: 4 }; },
      confirm: async (est) => { order.push("confirm"); assert.equal(est.usd, 0.051); assert.equal(est.source, "learned"); assert.equal(est.provider, "openai"); return true; },
      execute: async (args) => { order.push("execute"); return viaProviders(sink)(args); },
      decode: async (blob) => { assert.equal(blob.type, "image/png"); return pic(); }
    });
  } finally { restore(); }
  assert.deepEqual(order, ["estimate", "confirm", "execute"]);
  const a = sink[0];
  assert.deepEqual([a.count, a.runKind, a.caller, a.extraRefs.length, a.extraRefPurposes[0], a.key, a.prompt], [1, "fast", "depth", 1, "max", "invincible.Actor.superhero", "make depth"]);
  assert.equal(a.extraRefs[0], src.blob);
  assert.equal(a.doc.uuid, undefined);
  // the real provider code built the request: OpenAI image EDIT, multipart, our size/quality, one image, no n
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(form.get("prompt"), "make depth");
  assert.equal(form.get("size"), `${a.cfg.width}x${a.cfg.height}`);
  assert.equal(form.get("quality"), "low");
  assert.equal(form.get("n"), null);
  assert.equal(form.get("background"), null);
  assert.equal(form.getAll("image[]").length, 1);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`);
  // result: picture resized to the source size, near = white at the top
  assert.equal(r.D.length, src.w * src.h);
  assert.ok(r.D[0] > 0.99 && r.D[src.w * src.h - 1] < 0.01);
  assert.ok(r.cost > 0);
  assert.deepEqual(r.returned, { w: 8, h: 12 });
});

await test("Gemini and OpenRouter go through their own provider request (stubbed), still one call", async () => {
  for (const [provider, model, host] of [["gemini", "gemini-3.1-flash-image", "generativelanguage.googleapis.com"], ["openrouter", "openai/gpt-image-2.6-flare", "openrouter.ai"]]) {
    const sink = [];
    stubFetch(async () => new Response("{}", { status: 500 }));
    try {
      await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({ engine: "generative", gen: { provider, model } }), name: "x", img: src }, {
        estimate: () => ({ display: 0.07, source: "table", n: 0 }), confirm: async () => true, execute: viaProviders(sink), decode: async () => pic()
      }));
    } finally { restore(); }
    assert.ok(calls.length >= 1 && calls.every((c) => c.url.includes(host)), `${provider}: ${calls.map((c) => c.url).join(",")}`);
    assert.equal(sink[0].cfg.provider, provider);
    assert.equal(sink[0].count, 1);
  }
});

await test("post-processing of a returned picture: the same pure recipe gives a 0..1 map at the source size", async () => {
  const w = 64, h = 96;
  const r = await runGenerativeDepth({ depth: normalizeDepth({ engine: "generative" }), name: "x", img: { ...src, w, h } }, {
    estimate: () => ({ display: 0.05 }), confirm: async () => true,
    execute: async () => ({ candidates: [{ blob: new Blob(["png"], { type: "image/png" }), cost: 0.05 }], cost: 0.05 }),
    decode: async () => pic(16, 24)
  });
  const A = new Float32Array(w * h); for (let y = 20; y < 80; y++) for (let x = 16; x < 48; x++) A[y * w + x] = 1;
  const p = postProcess(r.D, { w, h, mask: A, guide: null, post: normalizeDepth({}).post, modelSize: 16 });
  assert.equal(p.flat, false);
  assert.equal(p.depth.length, w * h);
  assert.ok(p.depth.every((v) => v >= 0 && v <= 1));
  assert.deepEqual(p.steps.map((s) => s.name), ["normalize", "flyingPixels", "maskSnap", "smooth", "gamma"]);
});

await test("errors: no source, no picture back, unreadable picture, provider error passes through", async () => {
  const base = { estimate: () => ({ display: 0.05 }), confirm: async () => true, decode: async () => pic() };
  await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({}), img: { w: 0, h: 0 } }, base), /No source image/);
  await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({}), img: src }, { ...base, execute: async () => ({ candidates: [] }) }), /returned no picture/);
  await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({}), img: src }, { ...base, execute: async () => ({ candidates: [{ blob: new Blob(["x"]) }] }), decode: async () => ({ rgba: new Uint8ClampedArray(3), w: 2, h: 2 }) }), /could not be read/);
  await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({}), img: src }, { ...base, execute: async () => { throw new Error("OpenAI gpt-image-2.6-flare: HTTP 401"); } }), /HTTP 401/);
  // an HTTP error from the real provider code never shows the key
  stubFetch(async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
  try {
    await assert.rejects(runGenerativeDepth({ depth: normalizeDepth({}), img: src }, { ...base, execute: viaProviders([]) }), (e) => !String(e.message).includes(TEST_KEY));
  } finally { restore(); }
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
