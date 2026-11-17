// Tests of the builder's Anthropic transport (scripts/anthropic/*) with a stub fetch emitting realistic SSE streams.
// No network, no real key. Run from the module folder: node dev/test-transport.mjs
import assert from "node:assert/strict";
import {
  buildMessagesRequest, buildPrewarmRequest, buildSystem, canonicalTools, userTurn, toolResultsTurn, prefixBytes, prefixFingerprint,
  RequestBuildError, DEFAULT_MODEL, DEFAULT_EFFORT, MAX_TOKENS, FALLBACK_BETA, ANTHROPIC_URL, ANTHROPIC_VERSION,
  streamMessage, sendMessage, TransportError, kindForStatus, redactSecrets, retryDelay, classifyStop, historyContent,
  SSEParser, MessageAccumulator,
  PRICES, priceFor, costOfUsage, normalizeUsage, addUsage, cacheHitRatio, estimateMaxCost
} from "../scripts/anthropic/index.mjs";
import * as enhance from "../scripts/enhance/anthropic.mjs";

const FAKE_KEY = "fake-test-key-0000-not-real-abcdef";
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const rejectsKind = (p, kind) => assert.rejects(p, (e) => { assert.equal(e.kind, kind, `got ${e.kind}: ${e.message}`); return true; });

// ---------------------------------------------------------------- stub SSE server

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const msgStart = (over = {}) => sse("message_start", {
  type: "message_start",
  message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 120, cache_creation_input_tokens: 18000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 16000 }, output_tokens: 1 }, ...over }
});
const blockStart = (index, content_block) => sse("content_block_start", { type: "content_block_start", index, content_block });
const delta = (index, d) => sse("content_block_delta", { type: "content_block_delta", index, delta: d });
const blockStop = (index) => sse("content_block_stop", { type: "content_block_stop", index });
const msgDelta = (stop_reason, usage = { output_tokens: 300 }, extra = {}) => sse("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null, ...extra }, usage });
const msgStop = () => sse("message_stop", { type: "message_stop" });
const ping = () => sse("ping", { type: "ping" });

/** Text-only answer with a thinking block first. */
const textStream = (text = "Hello GM.") => [
  msgStart(), ping(),
  blockStart(0, { type: "thinking", thinking: "", signature: "" }),
  delta(0, { type: "thinking_delta", thinking: "Plan: " }), delta(0, { type: "thinking_delta", thinking: "answer." }),
  delta(0, { type: "signature_delta", signature: "sig-AAA" }), blockStop(0),
  blockStart(1, { type: "text", text: "" }),
  ...[...text].reduce((a, ch, i) => { if (i % 4 === 0) a.push(""); a[a.length - 1] += ch; return a; }, []).map((t) => delta(1, { type: "text_delta", text: t })),
  blockStop(1),
  msgDelta("end_turn"), msgStop()
];

/** Two parallel tool calls with input split into partial JSON fragments. */
const toolStream = () => {
  const in1 = JSON.stringify({ query: "web-slinging wall-crawling", kinds: ["power"], limit: 10 });
  const in2 = JSON.stringify({ refs: ["powers:Xy12", "powers:Ab34"] });
  const frags = (s) => [s.slice(0, 7), s.slice(7, 20), s.slice(20, 21), s.slice(21)];
  return [
    msgStart(),
    blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Searching the catalogue." }), blockStop(0),
    blockStart(1, { type: "tool_use", id: "toolu_1", name: "search_catalog", input: {} }),
    ...frags(in1).map((p) => delta(1, { type: "input_json_delta", partial_json: p })), blockStop(1),
    blockStart(2, { type: "tool_use", id: "toolu_2", name: "get_entries", input: {} }),
    delta(2, { type: "input_json_delta", partial_json: "" }),
    ...frags(in2).map((p) => delta(2, { type: "input_json_delta", partial_json: p })), blockStop(2),
    blockStart(3, { type: "tool_use", id: "toolu_3", name: "read_rules_noargs", input: {} }), blockStop(3),
    msgDelta("tool_use", { output_tokens: 210 }), msgStop()
  ];
};

/**
 * Stub fetch. `script` = array of replies, one per call: { status, headers, chunks[] | body, splitEvery, delayMs, hang,
 * errorAfter (chunk index -> stream error) }. Honours init.signal like real fetch (rejects / errors the body with AbortError).
 */
function stubFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    const i = calls.length;
    calls.push({ url, init, body: JSON.parse(init.body), headers: init.headers });
    const r = typeof script === "function" ? script(i) : script[Math.min(i, script.length - 1)];
    if (r.throw) throw r.throw;
    const status = r.status ?? 200;
    const headers = new Headers({ "content-type": r.chunks ? "text/event-stream; charset=utf-8" : "application/json", "request-id": `req_${i}`, ...(r.headers ?? {}) });
    if (!r.chunks) return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status, headers });
    let text = r.chunks.join("");
    if (r.crlf) text = text.replace(/\n/g, "\r\n");
    const step = r.splitEvery ?? 0;
    const pieces = step ? Array.from({ length: Math.ceil(text.length / step) }, (_, k) => text.slice(k * step, (k + 1) * step)) : r.chunks.map((c) => (r.crlf ? c.replace(/\n/g, "\r\n") : c));
    const enc = new TextEncoder();
    let k = 0; let closed = false;
    const stream = new ReadableStream({
      start(ctrl) {
        init.signal?.addEventListener("abort", () => { if (!closed) { closed = true; try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* */ } } });
      },
      async pull(ctrl) {
        if (closed) return;
        if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
        if (closed) return;
        if (r.errorAfter !== undefined && k === r.errorAfter) { closed = true; ctrl.error(new TypeError("network connection lost")); return; }
        if (r.hangAfter !== undefined && k === r.hangAfter) return new Promise(() => {}); // never delivers more bytes
        if (k >= pieces.length) { closed = true; ctrl.close(); return; }
        ctrl.enqueue(enc.encode(pieces[k++]));
      }
    });
    return new Response(stream, { status, headers });
  };
  f.calls = calls;
  return f;
}

const TOOLS = [
  { name: "search_catalog", description: "Search.", strict: true, input_schema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] } },
  { input_schema: { type: "object", additionalProperties: false, properties: { refs: { type: "array", items: { type: "string" } } }, required: ["refs"] }, strict: true, description: "Get.", name: "get_entries" }
];
const SYS = { rules: "HARNESS RULES ".repeat(50), digest: "RULES DIGEST ".repeat(50), catalog: "CATALOG INDEX ".repeat(100) };
const SHEET = '<sheet doc="Actor.x1" type=superhero name="Spider-Man">\nATTR FIG 4\n</sheet>';
const baseReq = (over = {}) => buildMessagesRequest({ apiKey: FAKE_KEY, tools: TOOLS, system: SYS, messages: [userTurn({ sheet: SHEET, text: "Złóż mi Spider-Mana" })], ...over });
const noSleep = { sleep: async () => {}, random: () => 0.5 };

// ---------------------------------------------------------------- request builder

await test("defaults: sonnet 5.5, effort medium, 32k max tokens, stream, reuse of enhance constants", () => {
  assert.equal(DEFAULT_MODEL, "claude-sonnet-5-5");
  assert.equal(DEFAULT_EFFORT, "medium");
  assert.equal(MAX_TOKENS, 32000);
  assert.equal(ANTHROPIC_URL, enhance.ANTHROPIC_URL);
  assert.equal(ANTHROPIC_VERSION, enhance.ANTHROPIC_VERSION);
  const r = baseReq();
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.body.model, "claude-sonnet-5-5");
  assert.equal(r.body.max_tokens, 32000);
  assert.equal(r.body.stream, true);
  assert.deepEqual(r.body.output_config, { effort: "medium" });
  assert.equal(r.body.thinking, undefined, "thinking left at the model default (adaptive)");
  assert.equal(r.body.tool_choice, undefined, "tool_choice auto by omission");
});

await test("headers: key only in x-api-key, version, browser access, fallback beta; headers non-enumerable", () => {
  const r = baseReq();
  assert.equal(r.headers["x-api-key"], FAKE_KEY);
  assert.equal(r.headers["anthropic-version"], "2026-10-21");
  assert.equal(r.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(r.headers["anthropic-beta"], FALLBACK_BETA);
  assert.equal(r.body.fallbacks, "default");
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), "JSON.stringify(request) must not print the key");
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY));
  assert.equal(r.redactedHeaders()["x-api-key"], "[redacted]");
  const h = buildMessagesRequest({ apiKey: FAKE_KEY, model: "claude-haiku-5-5", messages: [userTurn({ text: "hi" })], betas: ["x-beta-1"] });
  assert.equal(h.body.fallbacks, undefined, "haiku 5.5 has no server-side fallback");
  assert.equal(h.headers["anthropic-beta"], "x-beta-1");
  const both = buildMessagesRequest({ apiKey: FAKE_KEY, messages: [userTurn({ text: "hi" })], betas: ["x-beta-1"] });
  assert.equal(both.headers["anthropic-beta"], `${FALLBACK_BETA},x-beta-1`);
});

await test("cache layout: one explicit 1h marker on system[last], top-level automatic 5m tail, nothing in messages", () => {
  const r = baseReq();
  assert.equal(r.body.system.length, 3);
  assert.equal(r.body.system[0].cache_control, undefined);
  assert.equal(r.body.system[1].cache_control, undefined);
  assert.deepEqual(r.body.system[2].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(r.body.cache_control, { type: "ephemeral" });
  assert.ok(!JSON.stringify(r.body.messages).includes("cache_control"));
  assert.ok(!JSON.stringify(r.body.tools).includes("cache_control"));
  const five = baseReq({ prefixTtl: "5m" });
  assert.deepEqual(five.body.system[2].cache_control, { type: "ephemeral" });
  assert.throws(() => baseReq({ prefixTtl: "5m", tailTtl: "1h" }), RequestBuildError, "1h after 5m breaks TTL ordering");
});

await test("sheet blocks only in messages: first user block is the sheet, system refusing sheet text", () => {
  const r = baseReq();
  assert.equal(r.body.messages[0].content[0].text, SHEET);
  assert.equal(r.body.messages[0].content[1].text, "Złóż mi Spider-Mana");
  assert.ok(!JSON.stringify(r.body.system).includes("<sheet"));
  assert.throws(() => buildSystem({ rules: "x", catalog: "<sheet doc=1>" }), /sheet/);
  assert.throws(() => buildSystem({ digest: "<sheet_update>" }), /sheet/);
  assert.deepEqual(userTurn({ sheet: "<sheet_unchanged/>", text: "dodaj mu latanie" }).content.map((b) => b.text), ["<sheet_unchanged/>", "dodaj mu latanie"]);
});

await test("tools: sorted by name, fixed key order, deterministic bytes; duplicates and tool markers refused", () => {
  const a = canonicalTools(TOOLS);
  const b = canonicalTools([...TOOLS].reverse());
  assert.deepEqual(a.map((t) => t.name), ["get_entries", "search_catalog"]);
  assert.deepEqual(Object.keys(a[0]), ["name", "description", "input_schema", "strict"]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.throws(() => canonicalTools([TOOLS[0], TOOLS[0]]), /duplicate/);
  assert.throws(() => canonicalTools([{ ...TOOLS[0], cache_control: { type: "ephemeral" } }]), /cache_control/);
});

await test("cache stability: prefix bytes identical across turns, actors and tool order; history passed by reference", () => {
  const h1 = [userTurn({ sheet: SHEET, text: "build" })];
  const r1 = buildMessagesRequest({ apiKey: FAKE_KEY, tools: TOOLS, system: SYS, messages: h1 });
  const h2 = [...h1, { role: "assistant", content: [{ type: "text", text: "ok" }] }, userTurn({ sheet: "<sheet_unchanged/>", text: "more" })];
  const r2 = buildMessagesRequest({ apiKey: "another-key-xyz", tools: [...TOOLS].reverse(), system: { ...SYS }, messages: h2 });
  const r3 = buildMessagesRequest({ apiKey: FAKE_KEY, tools: TOOLS, system: SYS, messages: [userTurn({ sheet: '<sheet doc="Actor.zz" type=npc name="Omni-Man">\n</sheet>', text: "x" })] });
  assert.equal(prefixBytes(r1), prefixBytes(r2));
  assert.equal(prefixBytes(r1), prefixBytes(r3));
  assert.equal(prefixFingerprint(r1), prefixFingerprint(r3));
  assert.equal(r2.body.messages, h2, "messages are not copied or edited");
  assert.equal(JSON.stringify(r2.body.messages.slice(0, 1)), JSON.stringify(r1.body.messages), "history prefix preserved");
  assert.notEqual(prefixFingerprint(buildMessagesRequest({ apiKey: FAKE_KEY, tools: TOOLS, system: SYS, effort: "high", messages: h1 })), prefixFingerprint(r1));
});

await test("guards: forced tool_choice, prefill, empty messages, marker on last block, too many markers, bad effort", () => {
  const m = [userTurn({ text: "x" })];
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, messages: m, toolChoice: "any" }), /tool_choice/);
  assert.equal(buildMessagesRequest({ apiKey: FAKE_KEY, messages: m, toolChoice: "none" }).body.tool_choice.type, "none");
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, messages: [...m, { role: "assistant", content: "pre" }] }), /prefill/);
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, messages: [] }), RequestBuildError);
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] }), /last block/);
  const marked = (t) => ({ role: "user", content: [{ type: "text", text: t, cache_control: { type: "ephemeral" } }, { type: "text", text: "tail" }] });
  const two = [marked("a"), { role: "assistant", content: "b" }, marked("c")];
  assert.ok(buildMessagesRequest({ apiKey: FAKE_KEY, system: SYS, messages: two }), "1 + 1 + 2 = 4 breakpoints is allowed");
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, system: SYS, messages: [...two, { role: "assistant", content: "d" }, marked("e")] }), /too many/);
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, messages: m, effort: "ultra" }), /effort/);
  assert.equal(buildMessagesRequest({ apiKey: FAKE_KEY, messages: m, effort: "" }).body.output_config, undefined);
  assert.equal(buildMessagesRequest({ apiKey: FAKE_KEY, messages: m, thinkingDisplay: "summarized" }).body.thinking.display, "summarized");
  assert.throws(() => buildMessagesRequest({ apiKey: FAKE_KEY, messages: m, maxTokens: 0 }), /pre-warm/);
});

await test("pre-warm request: max_tokens 0, no stream, no tail marker, same prefix as real traffic", () => {
  const p = buildPrewarmRequest({ apiKey: FAKE_KEY, tools: TOOLS, system: SYS });
  assert.equal(p.body.max_tokens, 0);
  assert.equal(p.body.stream, undefined);
  assert.equal(p.body.cache_control, undefined);
  assert.deepEqual(p.body.system[2].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(prefixBytes(p), prefixBytes(baseReq()));
});

await test("toolResultsTurn: all results in ONE user message, is_error kept", () => {
  const t = toolResultsTurn([{ toolUseId: "toolu_1", content: "[]" }, { toolUseId: "toolu_2", content: "boom", isError: true }]);
  assert.equal(t.role, "user");
  assert.deepEqual(t.content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "[]" },
    { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }
  ]);
  assert.throws(() => toolResultsTurn([]), RequestBuildError);
});

// ---------------------------------------------------------------- SSE parser

await test("SSE parser: split anywhere, CRLF, CR, comments, multi-line data, missing final blank line", () => {
  const raw = ": comment\nevent: a\ndata: {\"x\":\ndata: 1}\n\nevent: b\r\ndata: 2\r\n\r\nevent: c\rdata: 3\r\rdata: 4";
  for (const step of [1, 2, 3, 5, 1000]) {
    const p = new SSEParser(); const out = [];
    for (let i = 0; i < raw.length; i += step) out.push(...p.push(raw.slice(i, i + step)));
    out.push(...p.end());
    assert.deepEqual(out, [{ event: "a", data: '{"x":\n1}' }, { event: "b", data: "2" }, { event: "c", data: "3" }, { event: "message", data: "4" }], `step ${step}`);
  }
});

// ---------------------------------------------------------------- streaming

await test("stream text + thinking: events in order, thinking signature kept, history content exact", async () => {
  for (const variant of [{}, { splitEvery: 7 }, { splitEvery: 1, crlf: true }]) {
    const f = stubFetch([{ chunks: textStream("Hello GM, ready."), ...variant }]);
    const ev = [];
    const r = await streamMessage(baseReq(), { fetchImpl: f, onEvent: (e) => ev.push(e) });
    assert.equal(r.stop, "done");
    assert.equal(r.text, "Hello GM, ready.");
    assert.equal(ev.filter((e) => e.type === "text").map((e) => e.text).join(""), "Hello GM, ready.");
    assert.equal(ev.filter((e) => e.type === "thinking").map((e) => e.text).join(""), "Plan: answer.");
    assert.deepEqual(r.historyContent[0], { type: "thinking", thinking: "Plan: answer.", signature: "sig-AAA" });
    assert.deepEqual(r.historyContent[1], { type: "text", text: "Hello GM, ready." });
    assert.equal(ev[0].type, "attempt");
    assert.equal(ev[1].type, "message_start");
    assert.equal(ev.at(-1).type, "message_stop");
    assert.equal(r.requestId, "req_0");
    assert.equal(r.messageId, "msg_01");
    assert.deepEqual(f.calls[0].body, JSON.parse(JSON.stringify(baseReq().body)));
    assert.equal(f.calls[0].headers["x-api-key"], FAKE_KEY);
  }
});

await test("stream tool_use: partial JSON fragments assembled, parallel calls, empty input -> {}", async () => {
  const f = stubFetch([{ chunks: toolStream(), splitEvery: 11 }]);
  const ev = [];
  const r = await streamMessage(baseReq(), { fetchImpl: f, onEvent: (e) => ev.push(e) });
  assert.equal(r.stop, "tool_use");
  assert.deepEqual(r.toolUses, [
    { id: "toolu_1", name: "search_catalog", input: { query: "web-slinging wall-crawling", kinds: ["power"], limit: 10 } },
    { id: "toolu_2", name: "get_entries", input: { refs: ["powers:Xy12", "powers:Ab34"] } },
    { id: "toolu_3", name: "read_rules_noargs", input: {} }
  ]);
  assert.deepEqual(ev.filter((e) => e.type === "tool_use").map((e) => e.id), ["toolu_1", "toolu_2", "toolu_3"]);
  assert.ok(ev.some((e) => e.type === "tool_input" && e.id === "toolu_1" && e.chars > 0));
  assert.deepEqual(r.historyContent[1], { type: "tool_use", id: "toolu_1", name: "search_catalog", input: { query: "web-slinging wall-crawling", kinds: ["power"], limit: 10 } });
  // the harness answers all of them in one message
  const t = toolResultsTurn(r.toolUses.map((u) => ({ toolUseId: u.id, content: "{}" })));
  assert.equal(t.content.length, 3);
});

await test("broken tool JSON -> inputError, input {}; max_tokens marks tool uses truncated", async () => {
  const chunks = [msgStart(), blockStart(0, { type: "tool_use", id: "toolu_x", name: "submit_proposal", input: {} }),
    delta(0, { type: "input_json_delta", partial_json: '{"mode":"ops","ops":[{"op' }), blockStop(0), msgDelta("max_tokens"), msgStop()];
  const ev = [];
  const r = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks }]), onEvent: (e) => ev.push(e) });
  assert.equal(r.stop, "max_tokens");
  assert.equal(r.toolUses[0].truncated, true);
  assert.match(r.toolUses[0].inputError, /not valid JSON/);
  assert.deepEqual(r.toolUses[0].input, {});
  assert.ok(ev.find((e) => e.type === "tool_use").inputError);
});

await test("stop reasons: refusal (stop_details), pause_turn, context window", async () => {
  const refusal = [msgStart(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Partial" }), blockStop(0),
    msgDelta("refusal", { output_tokens: 5 }, { stop_details: { type: "refusal", category: "cyber", explanation: null } }), msgStop()];
  const r = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks: refusal }]) });
  assert.equal(r.stop, "refusal");
  assert.equal(r.stopDetails.category, "cyber");
  for (const [sr, kind] of [["pause_turn", "pause_turn"], ["model_context_window_exceeded", "context"], ["stop_sequence", "done"]]) {
    const r2 = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks: [msgStart(), msgDelta(sr), msgStop()] }]) });
    assert.equal(r2.stop, kind);
  }
  assert.equal(classifyStop({}), "unknown");
});

await test("server-side fallback: fallback block event, iterations priced per model, echo rule in historyContent", async () => {
  const chunks = [
    msgStart({ model: "claude-sonnet-5" }),
    blockStart(0, { type: "thinking", thinking: "", signature: "" }), delta(0, { type: "signature_delta", signature: "s1" }), blockStop(0),
    blockStart(1, { type: "text", text: "" }), delta(1, { type: "text_delta", text: "Part A. " }), blockStop(1),
    blockStart(2, { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } }), blockStop(2),
    blockStart(3, { type: "text", text: "" }), delta(3, { type: "text_delta", text: "Part B." }), blockStop(3),
    msgDelta("end_turn", { output_tokens: 50, iterations: [
      { type: "message", model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 20 },
      { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 30 }
    ] }), msgStop()
  ];
  const ev = [];
  const r = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks }]), onEvent: (e) => ev.push(e) });
  assert.deepEqual(ev.find((e) => e.type === "fallback"), { type: "fallback", index: 2, from: "claude-sonnet-5-5", to: "claude-sonnet-5" });
  assert.equal(r.fallback.ran, true);
  assert.equal(r.model, "claude-sonnet-5");
  assert.deepEqual(r.historyContent.map((b) => b.type), ["text", "fallback", "text"], "thinking before the fallback block is omitted");
  assert.equal(r.message.content.length, 4, "raw message keeps everything");
  near(r.cost.usd, (1000 * 2 + 20 * 10 + 1000 * 2 + 30 * 10) / 1e6);
  assert.equal(r.cost.iterations.length, 2);
});

await test("usage: message_start + cumulative message_delta merged; cost with 1h/5m writes", async () => {
  const r = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks: textStream("x") }]) });
  assert.deepEqual(r.usage, { input: 120, output: 300, cacheRead: 0, cacheWrite: 18000, cacheWrite5m: 2000, cacheWrite1h: 16000, thinking: 0 });
  near(r.cost.usd, (120 * 2 + 300 * 10 + 2000 * 2.5 + 16000 * 4) / 1e6);
  assert.equal(r.cost.estimated, false);
});

// ---------------------------------------------------------------- errors, retries, abort

await test("HTTP errors map to kinds; 400/401/402/403/404/413 are not retried", async () => {
  const cases = [[400, "invalid_request_error", "request"], [401, "authentication_error", "auth"], [402, "billing_error", "billing"],
    [403, "permission_error", "permission"], [404, "not_found_error", "model"], [413, "request_too_large", "too-long"]];
  for (const [status, type, kind] of cases) {
    const f = stubFetch([{ status, body: { type: "error", error: { type, message: `nope ${status}` }, request_id: "req_err" } }]);
    await assert.rejects(streamMessage(baseReq(), { fetchImpl: f, ...noSleep }), (e) => {
      assert.equal(e.kind, kind); assert.equal(e.status, status); assert.equal(e.requestId, "req_err"); assert.equal(e.retryable, false);
      assert.match(e.detail, new RegExp(`nope ${status}`));
      return true;
    });
    assert.equal(f.calls.length, 1, `${status} not retried`);
  }
  assert.equal(kindForStatus(529), "overloaded");
  assert.equal(kindForStatus(503), "overloaded");
  assert.equal(kindForStatus(502), "server");
});

await test("429 retried after retry-after, 529 retried with backoff, then success; retry events emitted", async () => {
  const f = stubFetch([
    { status: 429, headers: { "retry-after": "3" }, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } },
    { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
    { chunks: textStream("ok") }
  ]);
  const sleeps = []; const ev = [];
  const r = await streamMessage(baseReq(), { fetchImpl: f, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, onEvent: (e) => ev.push(e) });
  assert.equal(r.text, "ok");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [3000, 2000]);
  assert.deepEqual(ev.filter((e) => e.type === "retry").map((e) => e.kind), ["rate-limit", "overloaded"]);
  assert.deepEqual(r.attempts.map((a) => a.status), [429, 529, 200]);
});

await test("retries are capped; long retry-after is surfaced, not slept; x-should-retry respected", async () => {
  const over = { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
  const f = stubFetch([over, over, over, over]);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: f, ...noSleep }), "overloaded");
  assert.equal(f.calls.length, 3, "1 try + 2 retries");
  const f2 = stubFetch([{ status: 429, headers: { "retry-after": "600" }, body: { type: "error", error: { type: "rate_limit_error", message: "x" } } }]);
  await assert.rejects(streamMessage(baseReq(), { fetchImpl: f2, ...noSleep }), (e) => { assert.equal(e.kind, "rate-limit"); assert.equal(e.retryAfter, 600); return true; });
  assert.equal(f2.calls.length, 1);
  const f3 = stubFetch([{ status: 500, headers: { "x-should-retry": "false" }, body: { type: "error", error: { type: "api_error", message: "x" } } }]);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: f3, ...noSleep }), "server");
  assert.equal(f3.calls.length, 1);
  const f4 = stubFetch([{ status: 409, headers: { "x-should-retry": "true" }, body: {} }, { chunks: textStream("fine") }]);
  assert.equal((await streamMessage(baseReq(), { fetchImpl: f4, ...noSleep })).text, "fine");
  assert.equal(retryDelay(1, null, { random: () => 0.5 }), 1000);
  assert.equal(retryDelay(3, null, { random: () => 0.5 }), 4000);
  assert.equal(retryDelay(9, null, { random: () => 0.5 }), 30000);
});

await test("error event mid-stream (overloaded): partial discarded, retried, failed attempt usage reported", async () => {
  const broken = [msgStart(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Half an ans" }),
    sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })];
  const f = stubFetch([{ chunks: broken }, { chunks: textStream("Full answer.") }]);
  const ev = [];
  const r = await streamMessage(baseReq(), { fetchImpl: f, ...noSleep, onEvent: (e) => ev.push(e) });
  assert.equal(r.text, "Full answer.");
  const retry = ev.find((e) => e.type === "retry");
  assert.equal(retry.kind, "overloaded");
  assert.equal(retry.discardPartial, true);
  assert.equal(r.attempts[0].streamed, true);
  assert.ok(r.failedAttempts.usdUpperBound > 0);
  // with mid-stream retries off, the error surfaces with the partial message
  const f2 = stubFetch([{ chunks: broken }]);
  await assert.rejects(streamMessage(baseReq(), { fetchImpl: f2, ...noSleep, retryMidStream: false }), (e) => {
    assert.equal(e.kind, "overloaded"); assert.equal(e.midStream, true);
    assert.equal(e.partial.incomplete, true); assert.equal(e.partial.content[0].text, "Half an ans");
    return true;
  });
  // a non-retryable mid-stream error (invalid request) is not retried
  const f3 = stubFetch([{ chunks: [msgStart(), sse("error", { type: "error", error: { type: "invalid_request_error", message: "bad" } })] }]);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: f3, ...noSleep }), "request");
  assert.equal(f3.calls.length, 1);
});

await test("connection drop mid-stream and stream without message_stop -> network, retried", async () => {
  const f = stubFetch([{ chunks: textStream("lost"), errorAfter: 3 }, { chunks: textStream("again") }]);
  assert.equal((await streamMessage(baseReq(), { fetchImpl: f, ...noSleep })).text, "again");
  const cut = textStream("x").slice(0, -2);
  const f2 = stubFetch([{ chunks: cut }, { chunks: cut }, { chunks: cut }]);
  await assert.rejects(streamMessage(baseReq(), { fetchImpl: f2, ...noSleep }), (e) => { assert.equal(e.kind, "network"); assert.match(e.detail, /message_stop/); return true; });
  assert.equal(f2.calls.length, 3);
  const f3 = stubFetch([{ throw: new TypeError("Failed to fetch") }, { chunks: textStream("up") }]);
  assert.equal((await streamMessage(baseReq(), { fetchImpl: f3, ...noSleep })).text, "up");
});

await test("abort (GM Stop) mid-stream -> cancelled with partial, no retry; aborted before start -> cancelled, no fetch", async () => {
  const ctl = new AbortController();
  const f = stubFetch([{ chunks: textStream("A long answer that is being streamed slowly."), splitEvery: 3, delayMs: 5 }]);
  const ev = [];
  const p = streamMessage(baseReq(), { fetchImpl: f, signal: ctl.signal, ...noSleep, onEvent: (e) => { ev.push(e); if (e.type === "text" && ev.filter((x) => x.type === "text").length === 3) ctl.abort(); } });
  await assert.rejects(p, (e) => { assert.equal(e.kind, "cancelled"); assert.equal(e.retryable, false); assert.ok(e.partial?.content?.length >= 1); return true; });
  assert.equal(f.calls.length, 1);
  const c2 = new AbortController(); c2.abort();
  const f2 = stubFetch([{ chunks: textStream("x") }]);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: f2, signal: c2.signal }), "cancelled");
  assert.equal(f2.calls.length, 0);
  // abort during the backoff sleep
  const c3 = new AbortController();
  const f3 = stubFetch([{ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "x" } } }]);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: f3, signal: c3.signal, sleep: async () => { c3.abort(); throw new Error("aborted"); } }), "cancelled");
});

await test("stall (no bytes) -> stalled + retry; whole-request timeout -> timeout, not retried", async () => {
  const f = stubFetch([{ chunks: textStream("never"), hangAfter: 2 }, { chunks: textStream("second") }]);
  const r = await streamMessage(baseReq(), { fetchImpl: f, idleTimeoutMs: 40, ...noSleep });
  assert.equal(r.text, "second");
  assert.equal(r.attempts[0].kind, "stalled");
  const f2 = stubFetch([{ chunks: textStream("slow but alive"), splitEvery: 2, delayMs: 15 }]);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: f2, timeoutMs: 60, idleTimeoutMs: 1000, ...noSleep }), "timeout");
  assert.equal(f2.calls.length, 1);
  // a fetch that ignores the signal still cannot hang the transport
  const hang = Object.assign(async () => new Promise(() => {}), { calls: [] });
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: hang, timeoutMs: 30, maxRetries: 0 }), "timeout");
});

await test("no key -> no-key without a fetch; non-SSE JSON answer accepted (pre-warm)", async () => {
  const f = stubFetch([{ chunks: textStream("x") }]);
  await rejectsKind(streamMessage(buildMessagesRequest({ apiKey: "  ", messages: [userTurn({ text: "x" })] }), { fetchImpl: f }), "no-key");
  assert.equal(f.calls.length, 0);
  const warm = buildPrewarmRequest({ apiKey: FAKE_KEY, tools: TOOLS, system: SYS });
  const fw = stubFetch([{ body: { id: "msg_w", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: "max_tokens", usage: { input_tokens: 5, cache_creation_input_tokens: 17000, cache_read_input_tokens: 0, output_tokens: 0 } } }]);
  const r = await sendMessage(warm, { fetchImpl: fw });
  assert.equal(r.stop, "max_tokens");
  assert.equal(r.usage.cacheWrite1h, 17000, "unitemised writes priced at the prefix TTL (1h)");
  assert.equal(fw.calls[0].body.stream, undefined);
  assert.throws(() => sendMessage(baseReq(), { fetchImpl: fw }), TransportError);
  await rejectsKind(streamMessage(baseReq(), { fetchImpl: stubFetch([{ body: "<html>proxy</html>" }]) }), "bad-response");
});

await test("a throwing onEvent handler never breaks the stream", async () => {
  const r = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks: toolStream() }]), onEvent: () => { throw new Error("ui bug"); } });
  assert.equal(r.toolUses.length, 3);
});

// ---------------------------------------------------------------- secrets

await test("the key never appears in results, events, errors or partials (server echo, fetch TypeError, module redact hook)", async () => {
  const dump = [];
  const collect = (x) => dump.push(JSON.stringify(x, (k, v) => (v instanceof Map ? [...v] : v)));
  const ok = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ chunks: toolStream() }]), onEvent: collect });
  collect(ok);
  const echo = stubFetch([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${FAKE_KEY}` } } }]);
  await streamMessage(baseReq(), { fetchImpl: echo, onEvent: collect }).catch((e) => { collect({ m: e.message, d: e.detail, p: e.partial, a: e.attempts }); });
  const midEcho = stubFetch([{ chunks: [msgStart(), sse("error", { type: "error", error: { type: "invalid_request_error", message: `key ${FAKE_KEY} bad` } })] }]);
  await streamMessage(baseReq(), { fetchImpl: midEcho, onEvent: collect }).catch((e) => collect({ m: e.message, d: e.detail, p: e.partial }));
  const te = stubFetch([{ throw: new TypeError(`Invalid header value ${FAKE_KEY}`) }]);
  await streamMessage(baseReq(), { fetchImpl: te, maxRetries: 0 }).catch((e) => collect({ m: e.message, d: e.detail, s: String(e) }));
  const all = dump.join("\n");
  assert.ok(dump.length > 10);
  assert.ok(!all.includes(FAKE_KEY), "fake key leaked");
  assert.ok(all.includes("[redacted]"));
  // the module's own redact() is applied on top
  const hook = await streamMessage(baseReq(), { fetchImpl: stubFetch([{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "secret-word here" } } }]), redact: (s) => s.replace("secret-word", "[mod]") }).catch((e) => e);
  assert.match(hook.detail, /\[mod\] here/);
  assert.equal(redactSecrets("sk-ant-api03-abcdefghijkl and x-api-key: zzz"), "[redacted] and x-api-key: [redacted]");
});

// ---------------------------------------------------------------- pricing

await test("pricing: table rows, unknown model estimated with the Opus row, haiku long-context card, helpers", () => {
  assert.deepEqual(PRICES["claude-sonnet-5-5"], { in: 2, out: 10, cacheRead: 0.10, cacheWrite5m: 2.5, cacheWrite1h: 4 });
  assert.equal(PRICES["claude-opus-5-5"].cacheRead, 0.20);
  const unk = costOfUsage({ input_tokens: 1_000_000 }, "claude-mystery-9");
  assert.equal(unk.estimated, true); near(unk.usd, 4);
  const dated = priceFor("claude-sonnet-5-5-fast");
  assert.equal(dated.model, "claude-sonnet-5-5"); assert.equal(dated.estimated, true);
  near(costOfUsage({ input_tokens: 50_000, output_tokens: 1_000_000 }, "claude-haiku-5-5").usd, 0.005 + 0.5);
  near(costOfUsage({ input_tokens: 150_000, output_tokens: 1_000_000 }, "claude-haiku-5-5").usd, 0.075 + 2.5);
  // spec 9.2 example: 20k prefix written at 1 h = $0.08 on Sonnet 5.5, read = $0.002
  near(costOfUsage({ cache_creation_input_tokens: 20000, cache_creation: { ephemeral_1h_input_tokens: 20000 } }, "claude-sonnet-5-5").usd, 0.08);
  near(costOfUsage({ cache_read_input_tokens: 20000 }, "claude-sonnet-5-5").usd, 0.002);
  const u = addUsage(normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 80 }), normalizeUsage({ cache_creation_input_tokens: 10 }));
  assert.equal(u.cacheWrite5m, 10);
  near(cacheHitRatio(u), 0.8);
  assert.equal(cacheHitRatio(normalizeUsage({})), null);
  assert.ok(estimateMaxCost({ model: "claude-sonnet-5-5", promptTokens: 20000, maxOutput: 32000 }).usd >= 0.08 + 0.32);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
