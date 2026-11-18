// W6-B: API key hygiene. A key pasted with an invisible character is normalised and used; a key with a visible non-ASCII
// character ("…", "—") is refused with the Polish message BEFORE any fetch, and the key never appears in an error.
// Every header value the module builds is printable ASCII. No network, fake keys only.
// Run from the module folder: node dev/test-key-check.mjs
import assert from "node:assert/strict";
import {
  normalizeApiKey, checkApiKey, requireUsableKey, assertHeadersSafe, isHeaderSafe, ApiKeyError,
  KEY_NON_ASCII_PL, KEY_NON_ASCII_EN, keyNonAsciiMessage
} from "../scripts/key-check.mjs";
import { buildMessagesRequest, buildPrewarmRequest, streamMessage, RequestBuildError } from "../scripts/anthropic/index.mjs";
import * as enhance from "../scripts/enhance/anthropic.mjs";

const CLEAN = "sk-ant-TEST-0000";
const PL = "Klucz API zawiera znak spoza ASCII (np. wielokropek lub twarda spacja) — wklej go ponownie";
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

const DIRTY = {
  "NBSP around": " sk-ant-TEST-0000 ",
  "zero-width space inside": "sk-ant-​TEST-0000",
  "BOM + trailing newline": "﻿sk-ant-TEST-0000\n",
  "CRLF + tab + spaces": "  sk-ant-TEST-0000\t\r\n",
  "word joiner + soft hyphen + ZWNJ": "sk-ant-TE⁠ST-­00‌00",
  "line separator + narrow NBSP": " sk-ant-TEST-0000 "
};
const REFUSED = { ellipsis: "sk-ant-TEST…0000", "em dash": "sk-ant-TEST—0000", "smart quote": "“sk-ant-TEST-0000”", "Polish letter": "sk-ant-TEŚT-0000" };

const stubFetch = () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers });
    // a real browser fetch rejects a non-Latin-1 header value; mimic it so a missed guard fails loudly
    for (const v of Object.values(init.headers ?? {})) if (/[^\x00-\xFF]/.test(String(v))) throw new TypeError("String contains non ISO-8859-1 code point.");
    return new Response(JSON.stringify({ type: "message", id: "m1", model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
};
const msgs = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

await test("clean key passes through unchanged", () => {
  assert.equal(normalizeApiKey(CLEAN), CLEAN);
  assert.deepEqual(checkApiKey(CLEAN), { key: CLEAN, ok: true });
  assert.equal(requireUsableKey(CLEAN), CLEAN);
  assert.equal(buildMessagesRequest({ apiKey: CLEAN, messages: msgs }).headers["x-api-key"], CLEAN);
  assert.equal(enhance.buildRequest({ apiKey: CLEAN, text: "x" }).headers["x-api-key"], CLEAN);
});

await test("NBSP / zero-width / BOM / newline keys are normalised to the clean key and accepted", () => {
  for (const [name, k] of Object.entries(DIRTY)) {
    assert.deepEqual(checkApiKey(k), { key: CLEAN, ok: true }, name);
    const req = buildMessagesRequest({ apiKey: k, messages: msgs });
    assert.equal(req.headers["x-api-key"], CLEAN, name);
    for (const [h, v] of Object.entries(req.headers)) assert.ok(isHeaderSafe(v), `${name}: header ${h}`);
  }
});

await test("empty / whitespace-only key stays empty (callers report 'no key')", () => {
  assert.deepEqual(checkApiKey(""), { key: "", ok: true });
  assert.deepEqual(checkApiKey("  ​\n"), { key: "", ok: true });
  assert.deepEqual(checkApiKey(null), { key: "", ok: true });
});

await test("key with a visible non-ASCII character is refused with the Polish message, key never echoed", () => {
  assert.equal(KEY_NON_ASCII_PL, PL);
  assert.equal(keyNonAsciiMessage("pl"), PL);
  assert.equal(keyNonAsciiMessage(undefined), PL);
  assert.equal(keyNonAsciiMessage("en"), KEY_NON_ASCII_EN);
  for (const [name, k] of Object.entries(REFUSED)) {
    assert.equal(checkApiKey(k).ok, false, name);
    assert.throws(() => requireUsableKey(k, "pl"), (e) => {
      assert.ok(e instanceof ApiKeyError, name);
      assert.equal(e.kind, "bad-key");
      assert.equal(e.message, PL);
      assert.ok(!JSON.stringify({ m: e.message, d: e.detail, s: String(e.stack) }).includes("TEST"), `${name}: key echoed`);
      return true;
    });
    assert.throws(() => buildMessagesRequest({ apiKey: k, messages: msgs }), (e) => e.kind === "bad-key" && !String(e.message).includes("TEST"), name);
    assert.throws(() => buildPrewarmRequest({ apiKey: k }), (e) => e.kind === "bad-key", name);
  }
});

await test("builder transport: refused key -> TransportError bad-key, not retried, NO fetch call", async () => {
  // a request object built around the builder (e.g. by hand) still cannot reach fetch with a bad header
  const f = stubFetch();
  for (const k of Object.values(REFUSED)) {
    const req = { url: "https://example.invalid/v1/messages", body: { model: "claude-sonnet-5-5", stream: false } };
    Object.defineProperty(req, "headers", { value: { "content-type": "application/json", "x-api-key": k }, enumerable: false });
    await assert.rejects(streamMessage(req, { fetchImpl: f, sleep: async () => {} }), (e) => {
      assert.equal(e.kind, "bad-key");
      assert.equal(e.retryable, false);
      assert.ok(String(e.message).includes("ASCII"));
      assert.ok(!JSON.stringify({ m: e.message, d: e.detail }).includes("TEST"));
      return true;
    });
  }
  assert.equal(f.calls.length, 0);
  // and a normalised dirty key goes through the stub (which throws like a browser on a non-Latin-1 header)
  const g = stubFetch();
  const ok = await streamMessage(buildMessagesRequest({ apiKey: DIRTY["BOM + trailing newline"], messages: msgs, stream: false, tailTtl: null }), { fetchImpl: g });
  assert.equal(ok.text, "ok");
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].headers["x-api-key"], CLEAN);
});

await test("other headers can never carry non-ASCII: betas validated, model / user text only in the body", () => {
  assert.throws(() => buildMessagesRequest({ apiKey: CLEAN, messages: msgs, betas: ["beta—2026"] }), RequestBuildError);
  assert.throws(() => buildMessagesRequest({ apiKey: CLEAN, messages: msgs, betas: ["a,b"] }), RequestBuildError);
  const req = buildMessagesRequest({ apiKey: CLEAN, model: "claude-sonnet-5-5", messages: [{ role: "user", content: [{ type: "text", text: "Złóż mi bohatera… — „Ślązak”" }] }] });
  for (const [h, v] of Object.entries(req.headers)) assert.ok(isHeaderSafe(v), `header ${h}`);
  const er = enhance.buildRequest({ apiKey: CLEAN, model: "claude-sonnet-5-5", text: "opis… — „ż”", context: { name: "Żółw" } });
  for (const [h, v] of Object.entries(er.headers)) assert.ok(isHeaderSafe(v), `enhance header ${h}`);
  assert.throws(() => assertHeadersSafe({ "x-custom": "a…" }), (e) => e.kind === "request" && !String(e.message).includes("a…"));
  assert.throws(() => assertHeadersSafe({ Authorization: "Bearer sk-ant-TEST…0000" }), ApiKeyError);
  assert.equal(assertHeadersSafe({ "x-api-key": CLEAN, "anthropic-beta": "x-1,y-2" })["x-api-key"], CLEAN);
});

await test("description enhancer: dirty key normalised and sent; refused key -> EnhanceError bad-key with no fetch", async () => {
  const f = stubFetch();
  const r = await enhance.enhanceDescription({ apiKey: DIRTY["NBSP around"], text: "a knight", fetchImpl: f });
  assert.equal(r.text, "ok");
  assert.equal(f.calls[0].headers["x-api-key"], CLEAN);
  const g = stubFetch();
  for (const k of Object.values(REFUSED)) {
    await assert.rejects(enhance.enhanceDescription({ apiKey: k, text: "a knight", fetchImpl: g }), (e) => e.kind === "bad-key" && !String(e.message).includes("TEST"));
  }
  assert.equal(g.calls.length, 0);
  await assert.rejects(enhance.enhanceDescription({ apiKey: "​\n", text: "x", fetchImpl: g }), (e) => e.kind === "no-key");
});

await test("image providers: refused key throws the Polish ApiKeyError before any fetch", async () => {
  // providers -> util -> redact -> settings.mjs reads foundry.data.fields at import time: a minimal stub is enough
  const hadFoundry = "foundry" in globalThis;
  if (!hadFoundry) { const F = class {}; globalThis.foundry = { data: { fields: { NumberField: F, StringField: F, ObjectField: F, BooleanField: F } } }; }
  let providers;
  try { providers = await import("../scripts/providers/index.mjs"); }
  finally { if (!hadFoundry) delete globalThis.foundry; }
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no network in tests"); };
  try {
    for (const p of ["openai", "gemini", "openrouter"]) {
      await assert.rejects(providers.generate({ provider: p, apiKey: REFUSED.ellipsis, model: "x", prompt: "p" }), (e) => e.kind === "bad-key" && e.message === PL);
    }
  } finally { globalThis.fetch = real; }
  assert.equal(calls, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
