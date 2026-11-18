// W6-G: pure depth settings (scripts/depth-settings.mjs): defaults, validation, catalogue. No network, no Foundry.
// Run from the module folder: node dev/test-depth-settings.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEPTH_SCHEMA, DEPTH_MODELS, MASK_MODELS, ENGINES, PRECISIONS, OUTPUT_FORMATS, SPEEDS, RANGES, COMFY_URL_DEFAULT,
  depthDefaults, normalizeDepth, depthFromForm, defaultModelKey, modelsFor, modelByKey, precisionsOf,
  cleanComfyUrl, fmtMB, sizeLine
} from "../scripts/depth-settings.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// ---------- catalogue matches the research doc ----------
test("catalogue ids, licences and sizes are the ones in dev/depth-model-research.md", () => {
  const doc = readFileSync(new URL("./depth-model-research.md", import.meta.url), "utf8");
  for (const m of [...DEPTH_MODELS, ...MASK_MODELS]) {
    assert.ok(doc.includes(m.id) || doc.includes(m.id.split("/")[1]), `${m.id} is named in the research`);
    assert.ok(doc.includes(m.licence), `${m.licence} appears in the research`);
    assert.match(m.source, /^https:\/\/huggingface\.co\//);
  }
  const L = modelByKey("da2-large"), S = modelByKey("da2-small");
  assert.deepEqual([L.sizes.fp16, L.sizes.q4f16, L.sizes.fp32], [669, 235, 1340]);
  assert.equal(L.licence, "CC BY-NC 4.0");
  assert.deepEqual([S.sizes.fp16, S.sizes.q4f16, S.sizes.fp32], [49.6, 19.1, 99.1]);
  assert.equal(S.licence, "Apache-2.0");
  const D3 = modelByKey("da3-mono-large-onnx");
  assert.deepEqual([D3.sizes.fp16, D3.sizes.q4f16], [688, 352]);
  assert.deepEqual(D3.resolutions.map((r) => r.px), [252, 364, 518, 728, 1036], "only the sizes that do not give NaN");
  assert.equal(D3.experimental, true);
  assert.equal(modelByKey("da3-mono-large").file, "depth_anything_3_mono_large.safetensors");
  assert.equal(modelByKey("da3-mono-large").sizesEstimated, true);
  assert.deepEqual(MASK_MODELS.find((m) => m.key === "birefnet-lite").sizes, { fp16: 115, fp32: 224 });
});
test("every model is well formed (engine, speed class, defaults inside its own lists)", () => {
  for (const m of DEPTH_MODELS) {
    assert.ok(ENGINES.includes(m.engine), m.key);
    assert.ok(SPEEDS.includes(m.speed), m.key);
    assert.ok(precisionsOf(m).includes(m.defaultPrecision), m.key);
    assert.ok(m.resolutions.some((r) => r.px === m.defaultResolution), m.key);
    for (const p of Object.keys(m.sizes)) assert.ok(PRECISIONS.includes(p), `${m.key} ${p}`);
  }
  // W6-I: the generative engine draws with the module's image providers (cfg.depth.gen), not with a depth model
  for (const e of ENGINES) assert.ok(e === "generative" ? modelsFor(e).length === 0 : modelsFor(e).length > 0, e);
});

// ---------- W6-I: generative engine (schema v2) ----------
test("v1 saves normalise to v2 with generative defaults; generative keeps a browser model for the compare", () => {
  const v1 = { v: 1, enabled: true, engine: "browser", model: "da2-small", precision: "q4f16", post: { gamma: 0.75 } };
  const n = normalizeDepth(v1);
  assert.equal(n.v, DEPTH_SCHEMA);
  assert.equal(DEPTH_SCHEMA, 2);
  assert.equal(n.model, "da2-small");
  assert.equal(n.precision, "q4f16");
  assert.equal(n.post.gamma, 0.75);
  assert.deepEqual(Object.keys(n.gen).sort(), ["imageSize", "model", "prompt", "provider", "quality"]);
  assert.equal(n.gen.provider, "openai");
  const g = normalizeDepth({ engine: "generative", model: "da2-small", gen: { provider: "gemini", model: "gemini-3.1-flash-image", prompt: "  depth please  " } });
  assert.equal(g.engine, "generative");
  assert.equal(g.model, "da2-small", "browser model kept for the local compare");
  assert.equal(g.gen.provider, "gemini");
  assert.equal(g.gen.model, "gemini-3.1-flash-image");
  assert.equal(g.gen.prompt, "depth please");
  assert.deepEqual(normalizeDepth(g), g, "idempotent");
  const bad = normalizeDepth({ engine: "generative", model: "da3-mono-large", gen: { provider: "evil", model: "x y <script>", prompt: "" } });
  assert.equal(bad.model, "da2-large", "a ComfyUI model is not a browser model");
  assert.equal(bad.gen.provider, "openai");
  assert.equal(bad.gen.model, "gpt-image-2.6-flare");
  assert.ok(bad.gen.prompt.includes("white is nearest"));
  assert.equal(normalizeDepth({ gen: { prompt: "x".repeat(5000) } }).gen.prompt.length, 2000);
  const f = depthFromForm({ "depth.engine": "generative", "depth.gen.provider": "openrouter", "depth.gen.model": "openai/gpt-image-2.6-flare", "depth.gen.prompt": "p" }, n);
  assert.equal(f.engine, "generative");
  assert.equal(f.gen.provider, "openrouter");
  assert.equal(f.gen.prompt, "p");
});

// ---------- defaults ----------
test("defaults: off, browser engine, V2 Large with WebGPU, V2 Small without, lossless output, gamma 0.8", () => {
  const d = depthDefaults();
  assert.equal(d.v, DEPTH_SCHEMA);
  assert.equal(d.enabled, false);
  assert.equal(d.engine, "browser");
  assert.equal(d.model, "da2-large");
  assert.equal(d.precision, "fp16");
  assert.equal(d.resolution, 518);
  assert.equal(depthDefaults({ webgpu: false }).model, "da2-small");
  assert.equal(d.output.format, "png16");
  assert.equal(d.post.gamma, 0.8);
  assert.ok(d.post.gamma >= RANGES.gamma[0] && d.post.gamma <= RANGES.gamma[1]);
  assert.equal(d.mask.model, "birefnet-lite");
  assert.equal(d.comfyUrl, COMFY_URL_DEFAULT);
  assert.equal(defaultModelKey("comfyui"), "da3-mono-large");
});
test("defaults are fresh objects (no shared nested state between types)", () => {
  const a = depthDefaults(), b = depthDefaults();
  a.post.gamma = 0.7;
  assert.equal(b.post.gamma, 0.8);
});

// ---------- normalizeDepth ----------
test("missing / garbage input gives the defaults", () => {
  assert.deepEqual(normalizeDepth(undefined), depthDefaults());
  assert.deepEqual(normalizeDepth("x"), depthDefaults());
  assert.deepEqual(normalizeDepth(null, { webgpu: false }), depthDefaults({ webgpu: false }));
});
test("normalisation is idempotent and drops unknown keys", () => {
  const n = normalizeDepth({ enabled: "on", junk: 1, post: { gamma: 0.85, evil: "x" } });
  assert.deepEqual(normalizeDepth(n), n);
  assert.equal("junk" in n, false);
  assert.equal("evil" in n.post, false);
  assert.equal(n.enabled, true);
  assert.equal(n.post.gamma, 0.85);
});
test("model must belong to the engine; precision and resolution must exist on the model", () => {
  const a = normalizeDepth({ engine: "comfyui", model: "da2-large" });
  assert.equal(a.model, "da3-mono-large");
  assert.equal(a.resolution, 1036);
  const b = normalizeDepth({ engine: "browser", model: "da3-mono-large-onnx", precision: "fp32", resolution: 600 });
  assert.equal(b.precision, "q4f16", "DA3 ONNX has no fp32");
  assert.equal(b.resolution, 518, "600 would give NaN");
  const c = normalizeDepth({ engine: "browser", model: "da2-large", precision: "q4f16", resolution: "770" });
  assert.equal(c.precision, "q4f16");
  assert.equal(c.resolution, 770);
  assert.equal(normalizeDepth({ engine: "cloud" }).engine, "browser");
});
test("numbers are clamped to their ranges and snapped to the step", () => {
  const n = normalizeDepth({ post: { gamma: 2, lowPct: -5, highPct: 50, edgeSnap: 0.333, dilatePx: 99, smoothPx: "2.6" }, parallax: { strength: "0.42", sway: -1 } });
  assert.equal(n.post.gamma, 0.9);
  assert.equal(n.post.lowPct, 0);
  assert.equal(n.post.highPct, 90);
  assert.equal(n.post.edgeSnap, 0.35);
  assert.equal(n.post.dilatePx, 8);
  assert.equal(n.post.smoothPx, 3);
  assert.equal(n.parallax.strength, 0.4);
  assert.equal(n.parallax.sway, 0);
  assert.equal(normalizeDepth({ post: { gamma: 0.1 } }).post.gamma, 0.7);
  assert.equal(normalizeDepth({ post: { gamma: "abc" } }).post.gamma, 0.8);
});
test("output is never lossy", () => {
  for (const f of ["webp", "jpeg", "png", "png8", ""]) assert.equal(normalizeDepth({ output: { format: f } }).output.format, "png16", f);
  assert.equal(normalizeDepth({ output: { format: "png-rg16" } }).output.format, "png-rg16");
  assert.ok(OUTPUT_FORMATS.every((f) => f.startsWith("png")));
});
test("booleans accept form values and keep defaults when absent", () => {
  const n = normalizeDepth({ mask: { enabled: false, model: "toonout" }, parallax: { dust: "true", light: false } });
  assert.equal(n.mask.enabled, false);
  assert.equal(n.mask.model, "toonout");
  assert.equal(n.parallax.dust, true);
  assert.equal(n.parallax.light, false);
  assert.equal(n.parallax.rim, true);
  assert.equal(normalizeDepth({ mask: { model: "rmbg-2" } }).mask.model, "birefnet-lite");
});
test("ComfyUI address: loopback only", () => {
  assert.equal(cleanComfyUrl("http://127.0.0.1:8188/"), "http://127.0.0.1:8188");
  assert.equal(cleanComfyUrl("http://localhost:9000"), "http://localhost:9000");
  assert.equal(cleanComfyUrl("http://[::1]:8188"), "http://[::1]:8188");
  for (const bad of ["http://evil.com:8188", "http://127.0.0.1.evil.com", "file:///C:/x", "javascript:alert(1)", "http://127.0.0.1:8188/prompt", ""]) {
    assert.equal(cleanComfyUrl(bad), COMFY_URL_DEFAULT, bad);
  }
});

// ---------- form ----------
test("depthFromForm merges the flat depth.* fields over the previous value", () => {
  const prev = normalizeDepth({ enabled: true, post: { gamma: 0.75 } });
  const flat = { provider: "openai", "depth.mask.enabled": false, "depth.post.dilatePx": 5, "depth.parallax.strength": "0.8", "depth.nope.x": 1, "depth.__proto__": 1, "depth.__proto__.toString": 1, "depth.constructor.prototype.polluted": 1, "depth.post": "flat" };
  const n = depthFromForm(flat, prev);
  assert.equal(n.enabled, true, "absent field keeps the previous value");
  assert.equal(n.post.gamma, 0.75);
  assert.equal(n.mask.enabled, false);
  assert.equal(n.post.dilatePx, 5);
  assert.equal(n.parallax.strength, 0.8);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(typeof Object.prototype.toString, "function");
  assert.equal(n.post.gamma, 0.75, "a flat value cannot replace a nested group");
  assert.deepEqual(normalizeDepth(n), n);
});
// ---------- formatting ----------
test("size formatting", () => {
  assert.equal(fmtMB(669), "669 MB");
  assert.equal(fmtMB(19.1), "19.1 MB");
  assert.equal(fmtMB(1340), "1.34 GB");
  assert.equal(fmtMB(1400), "1.4 GB");
  assert.equal(fmtMB(null), "");
  assert.equal(sizeLine(modelByKey("da2-large")), "fp16 669 MB · q4f16 235 MB · fp32 1.34 GB");
  assert.equal(sizeLine(modelByKey("da3-mono-large")), "fp16 ~700 MB · fp32 ~1.4 GB");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
