// W6-D: the thin canvas wrapper (scripts/ref-convert.mjs) with stubbed createImageBitmap / OffscreenCanvas / game.
// Checks the wiring only (plan -> canvas size, keep-original rules, per-image purposes, token sum, failure fallback);
// real pixel encoding is NOT exercised here (needs a browser). Run from the module folder: node dev/test-ref-convert.mjs
import assert from "node:assert/strict";

// ---- stubs: a "bitmap" is described by the blob's first bytes "WxH"; the "encoder" returns a blob of w*h/40 bytes ----
const drawn = [];
globalThis.createImageBitmap = async (blob) => {
  const txt = await blob.slice(0, 32).text();
  const m = /^(\d+)x(\d+)/.exec(txt);
  if (!m) throw new Error("not an image");
  return { width: Number(m[1]), height: Number(m[2]), close() {} };
};
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() { return { drawImage: (_b, _x, _y, w, h) => drawn.push(`${w}x${h}`) }; }
  async convertToBlob({ type }) { return new Blob([new Uint8Array(Math.max(1, Math.round(this.w * this.h / 40)))], { type }); }
};
const settings = { "est.imageInPrice": 8, "est.imageOutPrice": 30, "est.outputTokens": "" };
globalThis.game = { settings: { get: (_m, k) => settings[k] }, i18n: { localize: (k) => k, format: (k, d) => `${k}${JSON.stringify(d)}`, has: () => false } };

const { prepareRefs, convertRef, estimateSettings, refOptsFor, purposeOverride, costBreakdown } = await import("../scripts/ref-convert.mjs");
const img = (w, h, pad = 0) => new Blob([`${w}x${h}`, new Uint8Array(pad)], { type: "image/png" });

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

await test("OpenAI: 2000x2000 detail -> canvas 384x384 WebP, 576 tokens", async () => {
  drawn.length = 0;
  const r = await convertRef(img(2000, 2000, 500000), refOptsFor({ provider: "openai", model: "gpt-image-2.5-flare" }));
  assert.deepEqual(drawn, ["384x384"]);
  assert.equal(r.blob.type, "image/webp");
  assert.equal(r.tokens, 576);
  assert.deepEqual([r.src.w, r.sent.w, r.converted], [2000, 384, true]);
});
await test("OpenAI: small source kept when WebP is not smaller (100x100, tiny file)", async () => {
  const src = img(100, 100);
  const r = await convertRef(src, refOptsFor({ provider: "openai", model: "gpt-image-2.5-flare" }));
  assert.equal(r.blob, src);
  assert.equal(r.converted, false);
  assert.equal(r.tokens, 49);
});
await test("Gemini: 1000x700 untouched (no re-encode), 3000x2000 capped to 1536", async () => {
  drawn.length = 0;
  const o = refOptsFor({ provider: "gemini", model: "gemini-3-pro-image" });
  const a = img(1000, 700, 9000);
  const r1 = await convertRef(a, o);
  assert.equal(r1.blob, a);
  assert.equal(r1.tokens, null);
  const r2 = await convertRef(img(3000, 2000), o);
  assert.deepEqual(drawn, ["1536x1024"]);
  assert.equal(r2.converted, true);
});
await test("prepareRefs: per-image purposes, token sum, failed image falls back to the original", async () => {
  const cfg = { provider: "openai", model: "gpt-image-2.5-flare", refPurpose: "detail", refMaxEdge: 512 };
  const bad = new Blob(["garbage"], { type: "image/png" });
  const r = await prepareRefs([img(1024, 1024), img(1024, 1024), bad], cfg, ["", "color"]);
  assert.equal(r.blobs[2], bad);
  assert.equal(r.infos[0].sent.w, 384);
  assert.equal(r.infos[1].sent.w, 208);
  assert.equal(r.tokens, null, "unknown size -> no sum (never under-report)");
  const ok = await prepareRefs([img(1024, 1024), img(1024, 1024)], cfg, ["max", "style"]);
  assert.equal(ok.tokens, 1024 + 361);
});
await test("purpose overrides by path; settings fallback", async () => {
  const cfg = { refPurposes: [{ path: "a.webp", purpose: "style" }, { path: "b.webp", purpose: "nope" }] };
  assert.equal(purposeOverride(cfg, "a.webp"), "style");
  assert.equal(purposeOverride(cfg, "b.webp"), "");
  assert.equal(purposeOverride(cfg, "c.webp"), "");
  settings["est.imageInPrice"] = 0;
  assert.equal(estimateSettings().inPrice, 8, "0/invalid price falls back to the default");
  settings["est.imageInPrice"] = 8;
});
await test("costBreakdown: OpenAI lines + cheaper-frame hint; Gemini none", async () => {
  const b = costBreakdown({ provider: "openai", model: "gpt-image-2.5-flare", quality: "medium", width: 1024, height: 1024 }, { refTokens: [576], count: 2 });
  assert.equal(b.outTokens, 439);
  assert.equal(b.refTokens, 576);
  assert.equal(b.lines.length, 3);
  assert.match(b.hint, /1536×1024/);
  assert.equal(costBreakdown({ provider: "gemini", model: "gemini-3-pro-image", width: 1024, height: 1024 }), null);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
