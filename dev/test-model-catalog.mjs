// W6-F: model catalogue and default-model selection (gpt-image-2.6 added and made the default). Pure Node, no network.
// Run from the module folder: node dev/test-model-catalog.mjs
import assert from "node:assert/strict";
import { MODELS, getModel, defaultModelId, modelHasBatch, supportsTransparent, fitOpenAIQuality, fitSizeFor } from "../scripts/providers/models.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// Minimal Foundry stubs: providers/index.mjs and config-store.mjs only touch these at call time.
const store = {};
const F = class {};
globalThis.foundry ??= { data: { fields: { NumberField: F, StringField: F, ObjectField: F, BooleanField: F, DataField: F } }, utils: { escapeHTML: (s) => s } };
globalThis.game = {
  settings: { get: (_m, k) => (k === "imageTypes" ? store : undefined), set: async (_m, k, v) => { if (k === "imageTypes") { for (const x of Object.keys(store)) delete store[x]; Object.assign(store, v); } } },
  user: { isGM: true }, i18n: { localize: (k) => k, format: (k) => k, has: () => false }, system: { id: "test" }, modules: new Map()
};
const providers = await import("../scripts/providers/index.mjs");
let cs = null, csErr = null;
try { cs = await import("../scripts/config-store.mjs"); } catch (e) { csErr = e; }

await test("catalogue: OpenAI has 2.6 Flare, 2.6 Sunburst, 2.5 Flare, 2.5 Sunburst, in that order", () => {
  assert.deepEqual(MODELS.openai.map((m) => m.id), ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
});
await test("default: 2.6 Flare for OpenAI; OpenRouter's first model is unchanged (Nano Banana 2.1)", () => {
  assert.equal(defaultModelId("openai"), "gpt-image-2.6-flare");
  assert.equal(defaultModelId("openrouter"), "google/gemini-nano-banana-2.1");
  assert.ok(getModel("openrouter", "openai/gpt-image-2.6-flare"));
  assert.ok(getModel("openrouter", "openai/gpt-image-2.6-sunburst"));
});
await test("2.6 has no batch; 2.5 and Gemini keep it; OpenRouter never has it", () => {
  assert.equal(modelHasBatch("openai", "gpt-image-2.6-flare"), false);
  assert.equal(modelHasBatch("openai", "gpt-image-2.6-sunburst"), false);
  assert.equal(modelHasBatch("openai", "gpt-image-2.5-flare"), true);
  assert.equal(providers.supportsBatchFor("openai", "gpt-image-2.6-flare"), false);
  assert.equal(providers.supportsBatchFor("openai", "gpt-image-2.5-sunburst"), true);
  assert.equal(providers.supportsBatchFor("gemini", "gemini-3-pro-image"), true);
  assert.equal(providers.supportsBatchFor("openrouter", "openai/gpt-image-2.5-flare"), false);
  assert.equal(providers.noBatchReason("openai", "gpt-image-2.6-flare"), "model");
  assert.equal(providers.noBatchReason("openrouter", "openai/gpt-image-2.6-flare"), "provider");
  assert.equal(providers.noBatchReason("openai", "gpt-image-2.5-flare"), "");
});
await test("2.6 capabilities: qualities low..max+auto, transparent switch, size rules like 2.5, 16 refs", () => {
  for (const id of ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]) {
    const m = getModel("openai", id);
    assert.deepEqual(m.qualities, ["low", "medium", "high", "xhigh", "max", "auto"]);
    assert.equal(m.defaultQuality, "medium");
    assert.equal(m.maxRefs, 16);
    assert.equal(supportsTransparent("openai", id), true);
    assert.equal(fitOpenAIQuality(id, "max"), "max");
    assert.equal(fitOpenAIQuality(id, "ultra"), "medium");
  }
  assert.deepEqual(fitSizeFor("openai", "gpt-image-2.6-flare", 3840, 2160), { width: 3840, height: 2160, changed: false });
  assert.equal(fitSizeFor("openai", "gpt-image-2.6-flare", 1000, 1000).width, 1008);
});

await test("config-store imports in Node", () => { if (csErr) throw csErr; });
if (cs) {
  await test("unsaved type gets 2.6 Flare; a saved 2.5 choice is kept", () => {
    assert.equal(cs.DEFAULT_CONFIG.model, "gpt-image-2.6-flare");
    for (const k of Object.keys(store)) delete store[k];
    assert.equal(cs.getConfig("Actor.npc").model, "gpt-image-2.6-flare");
    store["Actor|character"] = { provider: "openai", model: "gpt-image-2.5-flare", defaultMode: "batch", quality: "low" };
    const c = cs.getConfig("Actor.character");
    assert.equal(c.model, "gpt-image-2.5-flare", "explicit choice not changed");
    assert.equal(c.defaultMode, "batch", "2.5 keeps batch");
    assert.equal(c.retiredModel, undefined);
  });
  await test("a saved 2.6 + batch falls back to Fast on read; setConfig stores fast for 2.6", async () => {
    store["Item|weapon"] = { provider: "openai", model: "gpt-image-2.6-sunburst", defaultMode: "batch" };
    assert.equal(cs.getConfig("Item.weapon").defaultMode, "fast");
    const saved = await cs.setConfig("Item.gear", { provider: "openai", model: "gpt-image-2.6-flare", defaultMode: "batch", width: 1024, height: 1024 });
    assert.equal(saved.defaultMode, "fast");
    const saved25 = await cs.setConfig("Item.loot", { provider: "openai", model: "gpt-image-2.5-flare", defaultMode: "batch", width: 1024, height: 1024 });
    assert.equal(saved25.defaultMode, "batch");
  });
  await test("retired GPT Image saves move to the default Flare (2.6), per provider", () => {
    assert.equal(cs.replacementModel("openai", "gpt-image-1"), "gpt-image-2.6-flare");
    assert.equal(cs.replacementModel("openrouter", "openai/gpt-image-1-mini"), "openai/gpt-image-2.6-flare");
    assert.equal(cs.replacementModel("gemini", "gemini-2.0-image"), "gemini-nano-banana-2.1");
    store["Macro|x"] = { provider: "openai", model: "gpt-image-1.5" };
    const c = cs.getConfig("Macro.x");
    assert.equal(c.model, "gpt-image-2.6-flare");
    assert.equal(c.retiredModel, "gpt-image-1.5");
  });
}

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
