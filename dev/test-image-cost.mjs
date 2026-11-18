// W6-D: pure maths of reference-image sizing and image cost estimates (scripts/image-cost.mjs). No network, no canvas.
// The token numbers are the owner's third-party estimates (not verified by us); these tests pin OUR implementation of them.
// Run from the module folder: node dev/test-image-cost.mjs
import assert from "node:assert/strict";
import {
  planRef, openaiInputTokens, clampMaxEdge, rulesFor, outputFamily, outputTokens, estimateRequest, cheaperSize,
  mergeTables, usd, REF_PURPOSES, OUTPUT_TABLES, DEFAULTS
} from "../scripts/image-cost.mjs";
import { OPENAI_26_TOKENS, openaiOutputTokens, openaiPriceFloor } from "../scripts/providers/models.mjs";
import { estimateSyncCost, estimateBatchCost } from "../scripts/batch/cost.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const sq = (n) => ({ width: n, height: n });
const dims = (p) => `${p.width}x${p.height}`;

// ---------- billing estimate of what is sent ----------
test("token table from the owner's summary (square refs)", () => {
  assert.equal(openaiInputTokens(512, 512).tokens, 1024);
  assert.equal(openaiInputTokens(384, 384).tokens, 576);
  assert.equal(openaiInputTokens(304, 304).tokens, 361);
  assert.equal(openaiInputTokens(208, 208).tokens, 169);
  assert.equal(openaiInputTokens(1024, 1024).tokens, 1024, "1024 is halved to 512");
  assert.equal(openaiInputTokens(1248, 1248).tokens, 1521, ">=1248 is seen as 624");
  assert.equal(openaiInputTokens(1248, 1248).seenW, 624);
});
test("624 SENT is the 513-1023 trap: billed as 512 (the 1521 row means 624 SEEN, i.e. >=1248 sent)", () => {
  const t = openaiInputTokens(624, 624);
  assert.equal(t.tokens, 1024);
  assert.equal(t.trap, true);
  assert.equal(openaiInputTokens(700, 700).tokens, 1024);
});
test("1536-token cap: 2000 px is halved to 1000, then shrunk to fit", () => {
  const t = openaiInputTokens(2000, 2000);
  assert.ok(t.tokens <= 1536 && t.capped);
  assert.equal(t.tokens, 1521);
});
test("300 px sent costs a full 19x19 tiles = 361 tokens (same as 304)", () => {
  assert.equal(openaiInputTokens(300, 300).tokens, 361);
});
test("strips wider than 3:1 pay for padding: 512x128 = 32x11 tiles (4 strips 1408, as in the summary)", () => {
  const t = openaiInputTokens(512, 128);
  assert.equal(t.tokens, 352);
  assert.equal(t.padded, true);
  assert.equal(4 * t.tokens, 1408);
  assert.equal(openaiInputTokens(128, 512).tokens, 352, "portrait too");
  assert.equal(openaiInputTokens(512, 256).padded, false);
});

// ---------- send plan ----------
test("purpose tiers", () => {
  assert.deepEqual(REF_PURPOSES, { max: 512, detail: 384, style: 304, color: 208 });
  assert.equal(DEFAULTS.purpose, "detail");
  assert.equal(DEFAULTS.maxEdge, 512);
});
test("300 -> 304 (snapped up to a full tile, not a real upscale)", () => {
  for (const purpose of ["max", "detail", "style"]) assert.equal(dims(planRef(sq(300), { purpose })), "304x304", purpose);
  assert.equal(dims(planRef(sq(300), { purpose: "color" })), "208x208");
});
test("700 -> 512 with max detail (never 513-1023), 384 with the default purpose", () => {
  assert.equal(dims(planRef(sq(700), { purpose: "max" })), "512x512");
  assert.equal(dims(planRef(sq(700))), "384x384");
});
test("1024 and 2000 -> 512 (max) / 384 (detail) / 304 (style) / 208 (color)", () => {
  for (const n of [1024, 2000]) {
    assert.equal(dims(planRef(sq(n), { purpose: "max" })), "512x512");
    assert.equal(dims(planRef(sq(n), { purpose: "detail" })), "384x384");
    assert.equal(dims(planRef(sq(n), { purpose: "style" })), "304x304");
    assert.equal(dims(planRef(sq(n), { purpose: "color" })), "208x208");
  }
});
test("smaller than the purpose tier: down to the next lower tier (450 -> 384 even for max detail)", () => {
  const p = planRef(sq(450), { purpose: "max" });
  assert.equal(dims(p), "384x384");
  assert.equal(p.reason, "ladder");
  assert.equal(planRef(sq(1000)).reason, "cap");
  assert.equal(dims(planRef(sq(350))), "304x304");
  assert.equal(dims(planRef(sq(384))), "384x384");
  assert.equal(dims(planRef(sq(383))), "384x384", "one pixel short still reaches the 384 tile row");
});
test("100 px is not upscaled (and 192 neither)", () => {
  const p = planRef(sq(100));
  assert.equal(dims(p), "100x100");
  assert.equal(p.resize, false);
  assert.equal(p.reason, "small");
  assert.equal(planRef(sq(192)).resize, false);
  assert.equal(dims(planRef(sq(200))), "208x208", "200 reaches the 208 tier within one tile");
});
test("non-square: long side to the tier, short side to the NEAREST multiple of 16 (<= 8 px aspect error)", () => {
  assert.equal(dims(planRef({ width: 1920, height: 1080 })), "384x224"); // 216 -> 224
  assert.equal(dims(planRef({ width: 1080, height: 1920 })), "224x384");
  assert.equal(dims(planRef({ width: 1000, height: 600 }, { purpose: "max" })), "512x304"); // 307.2 -> 304
  assert.equal(dims(planRef({ width: 2048, height: 100 }, { purpose: "max" })), "512x32"); // 25 -> 32 (16 would be 36 % off)
  const p = planRef({ width: 333, height: 100 });
  assert.equal(p.width % 16, 0);
  assert.equal(p.height % 16, 0);
});
test("every planned side is a multiple of 16 and never in 513-1023 (sweep)", () => {
  for (let w = 193; w <= 4096; w += 37) for (const h of [w, Math.round(w * 0.6), Math.round(w * 1.4), Math.round(w / 3.5)]) {
    for (const purpose of Object.keys(REF_PURPOSES)) {
      const p = planRef({ width: w, height: Math.max(1, h) }, { purpose, maxEdge: 512 });
      const L = Math.max(p.width, p.height);
      assert.ok(L <= 512, `${w}x${h} ${purpose} -> ${dims(p)}`);
      if (Math.max(w, h) >= 193) assert.equal(L % 16, 0, `${w}x${h} ${purpose} -> ${dims(p)}`);
      assert.ok(Math.max(w, h) + 15 >= L, `never a real upscale: ${w}x${h} -> ${dims(p)}`);
    }
  }
});
test("4:1 strips are flagged", () => {
  assert.equal(planRef({ width: 2048, height: 512 }).wide, true);
  assert.equal(planRef({ width: 1536, height: 512 }).wide, false, "exactly 3:1 is fine");
});
test("max edge setting caps the purpose and snaps to the ladder", () => {
  assert.equal(clampMaxEdge(512), 512);
  assert.equal(clampMaxEdge(700), 512);
  assert.equal(clampMaxEdge(400), 384);
  assert.equal(clampMaxEdge(100), 208);
  assert.equal(clampMaxEdge("x"), 512);
  assert.equal(dims(planRef(sq(2000), { purpose: "max", maxEdge: 304 })), "304x304");
});
test("generic rules (Gemini, Google via OpenRouter): only a conservative cap, no ladder or snapping", () => {
  assert.equal(rulesFor("gemini", "gemini-3-pro-image"), "generic");
  assert.equal(rulesFor("openrouter", "google/gemini-3-pro-image"), "generic");
  assert.equal(rulesFor("openrouter", "openai/gpt-image-2.5-flare"), "openai");
  assert.equal(rulesFor("openai", "gpt-image-2.5-flare"), "openai");
  assert.equal(dims(planRef({ width: 1000, height: 700 }, { rules: "generic" })), "1000x700");
  assert.equal(planRef({ width: 1000, height: 700 }, { rules: "generic" }).resize, false);
  assert.equal(dims(planRef({ width: 3000, height: 2000 }, { rules: "generic" })), "1536x1024");
});
test("ref cost: 384 px at $8/1M = $0.0046 (summary table)", () => {
  assert.equal(usd(576, 8).toFixed(4), "0.0046");
  assert.equal(usd(1521, 8).toFixed(4), "0.0122");
  assert.equal(usd(169, 8).toFixed(4), "0.0014");
});

// ---------- output ----------
test("output family by model", () => {
  assert.equal(outputFamily("openai", "gpt-image-2.5-flare"), "gpt-image-2.5");
  assert.equal(outputFamily("openai", "gpt-image-2.6-flare"), "gpt-image-2.6");
  assert.equal(outputFamily("openrouter", "openai/gpt-image-2.5-sunburst"), "gpt-image-2.5");
  assert.equal(outputFamily("gemini", "gemini-3-pro-image"), null);
});
test("2.6 output table (owner's section 4)", () => {
  const f = "gpt-image-2.6";
  const exp = { low: [824, 664], medium: [1449, 1132], high: [1756, 1353], xhigh: [3122, 2470], max: [7024, 5500] };
  for (const [q, [a, b]] of Object.entries(exp)) {
    assert.equal(outputTokens(f, q, 1024, 1024), a, q);
    assert.equal(outputTokens(f, q, 1536, 1024), b, q);
    assert.equal(outputTokens(f, q, 1024, 1536), b, `${q} portrait`);
  }
  assert.equal(usd(outputTokens(f, "low", 1024, 1024), 30).toFixed(4), "0.0247");
  assert.equal(usd(outputTokens(f, "medium", 1024, 1024), 30).toFixed(4), "0.0435");
  assert.equal(usd(outputTokens(f, "high", 1024, 1024), 30).toFixed(4), "0.0527");
});
test("2.5 output: square = catalogue upper bound, wide from the summary ($0.0051/$0.0107/$0.0415)", () => {
  const f = "gpt-image-2.5";
  assert.equal(outputTokens(f, "medium", 1024, 1024), 439);
  assert.equal(usd(outputTokens(f, "low", 1536, 1024), 30).toFixed(4), "0.0051");
  assert.equal(usd(outputTokens(f, "medium", 1536, 1024), 30).toFixed(4), "0.0107");
  assert.equal(usd(outputTokens(f, "high", 1536, 1024), 30).toFixed(4), "0.0415");
  assert.equal(outputTokens(f, "auto", 1024, 1024), outputTokens(f, "high", 1024, 1024), "auto = high");
});
test("partial images +100 tokens each; 4K grows ~1.9x; unknown family = null", () => {
  assert.equal(outputTokens("gpt-image-2.6", "low", 1024, 1024, { partialImages: 2 }), 1024);
  assert.equal(outputTokens("gpt-image-2.6", "high", 3840, 2160), Math.round(1353 * 1.9));
  assert.equal(outputTokens("nope", "low", 1024, 1024), null);
});
test("request estimate: owner's final table formula (output + k x 0.0046), 2.6 low 1024, 1 ref at 384", () => {
  const r = estimateRequest({ outTokens: 824, refTokens: [576] });
  assert.equal(r.perImage.toFixed(4), "0.0293"); // 0.0247 + 0.0046
  // OpenAI Fast with n=3: one request, refs billed once
  const fast = estimateRequest({ outTokens: 824, refTokens: [576, 576], count: 3 });
  assert.equal(fast.total.toFixed(4), (3 * 0.024720 + 2 * 0.004608).toFixed(4));
  // separate requests (Gemini/OpenRouter Fast, or Batch): refs billed every time; batch at half rates
  const sep = estimateRequest({ outTokens: 824, refTokens: [576], count: 2, refsShared: false });
  assert.equal(sep.total.toFixed(5), (2 * (0.02472 + 0.004608)).toFixed(5));
  const batch = estimateRequest({ outTokens: 824, refTokens: [576], count: 2, mode: "batch" });
  assert.equal(batch.total.toFixed(5), (2 * (0.02472 + 0.004608) / 2).toFixed(5));
  assert.equal(estimateRequest({ outTokens: null, refTokens: [576] }).total, null);
});
test("cheaper frame hint: 1536x1024 vs square, only for squares", () => {
  const h = cheaperSize("gpt-image-2.6", "medium", 1024, 1024);
  assert.equal(h.width, 1536);
  assert.equal(h.savingTokens, 1449 - 1132);
  assert.equal(h.pct, 22);
  assert.equal(cheaperSize("gpt-image-2.6", "medium", 1536, 1024), null);
  assert.equal(cheaperSize(null, "medium", 1024, 1024), null);
  // 2.5 xhigh: no wide data, no hint
  assert.equal(cheaperSize("gpt-image-2.5", "xhigh", 1024, 1024), null);
});
test("table overrides from the world setting (JSON), bad input ignored", () => {
  const t = mergeTables('{"gpt-image-2.6":{"square":{"low":900}},"gpt-image-3":{"wide":{"low":10},"square":{"low":20}}}');
  assert.equal(t["gpt-image-2.6"].square.low, 900);
  assert.equal(t["gpt-image-2.6"].square.medium, 1449);
  assert.equal(outputTokens("gpt-image-3", "low", 1024, 1024, { tables: t }), 20);
  assert.deepEqual(mergeTables("{not json"), JSON.parse(JSON.stringify(OUTPUT_TABLES)));
  assert.deepEqual(mergeTables(""), JSON.parse(JSON.stringify(OUTPUT_TABLES)));
});

// ---------- W6-F: gpt-image-2.6 wired into the catalogue cost maths (limits, fallback price, batch estimate) ----------
test("W6-F: 2.6 family for both variants, direct and via OpenRouter", () => {
  for (const id of ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]) {
    assert.equal(outputFamily("openai", id), "gpt-image-2.6", id);
    assert.equal(outputFamily("openrouter", `openai/${id}`), "gpt-image-2.6", id);
    assert.equal(rulesFor("openai", id), "openai");
  }
});
test("W6-F: the 2.6 square column is the catalogue's OPENAI_26_TOKENS (one source)", () => {
  for (const q of ["low", "medium", "high", "xhigh", "max"]) assert.equal(OUTPUT_TABLES["gpt-image-2.6"].square[q], OPENAI_26_TOKENS[q], q);
  assert.equal(outputTokens("gpt-image-2.6", "auto", 1024, 1024), 1756, "auto = high");
});
test("W6-F: catalogue output tokens / price floor pick the 2.6 table by model id (2.5 unchanged)", () => {
  assert.equal(openaiOutputTokens("gpt-image-2.6-flare", "low", 1024, 1024), 824);
  assert.equal(openaiOutputTokens("gpt-image-2.6-sunburst", "medium", 1024, 1024), 1449);
  assert.equal(openaiOutputTokens("openai/gpt-image-2.6-flare", "high", 1024, 1024), 1756);
  assert.equal(openaiOutputTokens("gpt-image-2.5-flare", "low", 1024, 1024), 196);
  assert.equal(openaiOutputTokens("gpt-image-2.6-flare", "high", 3840, 2160), Math.round(1756 * 1.9));
  // owner's summary: 4K high ≈ $0.10
  assert.ok(Math.abs(usd(openaiOutputTokens("gpt-image-2.6-flare", "high", 3840, 2160), 30) - 0.10) < 0.005);
  assert.equal(openaiPriceFloor("low", 1024, 1024, "gpt-image-2.6-flare").toFixed(4), "0.0247");
  assert.equal(openaiPriceFloor("low", 1024, 1024).toFixed(5), (196 * 30 / 1e6).toFixed(5), "no model = old 2.5 floor");
});
test("W6-F: sync table estimate (limits) for 2.6 is about 4x the 2.5 one at low", () => {
  const it = [{ quality: "low", width: 1024, height: 1024 }];
  const s26 = estimateSyncCost("openai", "gpt-image-2.6-flare", it);
  const s25 = estimateSyncCost("openai", "gpt-image-2.5-flare", it);
  // sync = standard rates: 824 tok × $30/1M + 150 text tok × $5/1M
  assert.equal(s26.toFixed(6), (824 * 30 / 1e6 + 150 * 5 / 1e6).toFixed(6));
  assert.ok(s26 / s25 > 3.5 && s26 / s25 < 4.5, String(s26 / s25));
  assert.ok(estimateBatchCost("openai", "gpt-image-2.6-flare", it) > 0, "estimator still answers (batch itself is refused elsewhere)");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
