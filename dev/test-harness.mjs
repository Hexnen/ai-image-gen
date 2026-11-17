// Tests of the AI builder harness (scripts/build/harness.mjs, session-store.mjs, sheet-sync.mjs; task T2).
// Scripted fake model behind a stub fetch emitting real SSE, fake IndexedDB, fake limits / log. No network, no real key.
// Run from the module folder: node dev/test-harness.mjs
import assert from "node:assert/strict";
import { createHarness, transcriptOf, unansweredToolUses, errorSignature, toolResultContent, isEmptyAnswer, HISTORY_TOKEN_CAP, MAX_TOOL_RESULT_CHARS, MAX_SHELVED_PROPOSALS } from "../scripts/build/harness.mjs";
import { createSessionStore, HistoryEditError, assertAppendOnly } from "../scripts/build/session-store.mjs";
import { decideSheetBlock, pairsOf, diffPairs, foldPairs, encodeHeld, decodeHeld, SUPERSEDES, UNCHANGED_BLOCK } from "../scripts/build/sheet-sync.mjs";
import { prefixBytes, buildMessagesRequest } from "../scripts/anthropic/index.mjs";
import { makeStubPack } from "../scripts/systems/_stub/pack.mjs";
import { HARNESS_RULES } from "../scripts/build/harness-prompt.mjs";
import { t, STRINGS } from "../scripts/build/harness-lang.mjs";

const FAKE_KEY = "sk-ant-fake-test-key-0000-not-real-ABCDEFGH";
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

// ------------------------------------------------------------------------------------------- fake IndexedDB

function fakeIndexedDB({ failOpen = false } = {}) {
  const dbs = new Map(); // name -> Map(store -> Map(key -> value))
  const later = (fn) => setTimeout(fn, 0);
  const request = () => ({ onsuccess: null, onerror: null, result: undefined, error: null });
  return {
    _dbs: dbs,
    open(name) {
      const r = { ...request(), onupgradeneeded: null, onblocked: null };
      later(() => {
        if (failOpen) { r.error = new Error("open failed"); r.onerror?.(); return; }
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => { stores.set(n, new Map()); },
          transaction(names, mode) {
            const tx = { oncomplete: null, onerror: null, onabort: null };
            let pending = 0;
            const done = () => { if (--pending === 0) later(() => tx.oncomplete?.()); };
            tx.objectStore = (n) => {
              const m = stores.get(n);
              const op = (fn) => { const q = request(); pending++; later(() => { q.result = fn(); q.onsuccess?.(); done(); }); return q; };
              return {
                get: (k) => op(() => (m.has(k) ? structuredClone(m.get(k)) : undefined)),
                put: (v, k) => op(() => { if (mode !== "readwrite") throw new Error("readonly"); m.set(k, structuredClone(v)); return k; }),
                delete: (k) => op(() => { m.delete(k); }),
                getAllKeys: () => op(() => [...m.keys()])
              };
            };
            return tx;
          }
        };
        r.result = db;
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    }
  };
}

// ------------------------------------------------------------------------------------------- SSE fake model

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
let msgSeq = 0;
const USAGE = { input_tokens: 300, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 };
const start = (usage = USAGE) => sse("message_start", { type: "message_start", message: { id: `msg_${++msgSeq}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage } });
const bStart = (i, b) => sse("content_block_start", { type: "content_block_start", index: i, content_block: b });
const bDelta = (i, d) => sse("content_block_delta", { type: "content_block_delta", index: i, delta: d });
const bStop = (i) => sse("content_block_stop", { type: "content_block_stop", index: i });
const mDelta = (stop, out = 200) => sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: out } });
const mStop = () => sse("message_stop", { type: "message_stop" });

/** A reply: optional thinking + text, then tool calls [{ id, name, input, rawJson? }], stop reason. */
function reply({ text = "", tools = [], stop, thinking = "plan", usage } = {}) {
  const ch = [start(usage)];
  let i = 0;
  if (thinking) { ch.push(bStart(i, { type: "thinking", thinking: "", signature: "" }), bDelta(i, { type: "thinking_delta", thinking }), bDelta(i, { type: "signature_delta", signature: `sig-${msgSeq}` }), bStop(i)); i++; }
  if (text) { ch.push(bStart(i, { type: "text", text: "" }), bDelta(i, { type: "text_delta", text }), bStop(i)); i++; }
  for (const tl of tools) {
    const json = tl.rawJson ?? JSON.stringify(tl.input ?? {});
    ch.push(bStart(i, { type: "tool_use", id: tl.id, name: tl.name, input: {} }), bDelta(i, { type: "input_json_delta", partial_json: json.slice(0, 5) }), bDelta(i, { type: "input_json_delta", partial_json: json.slice(5) }), bStop(i));
    i++;
  }
  ch.push(mDelta(stop ?? (tools.length ? "tool_use" : "end_turn")), mStop());
  return { chunks: ch };
}

/** Stub fetch: `script(i, body)` -> reply | { status, body } | { hang: true }. Honours the abort signal. */
function fakeModel(script) {
  const calls = [];
  const f = async (url, init) => {
    const i = calls.length;
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers, raw: init.body });
    const r = typeof script === "function" ? script(i, body) : script[Math.min(i, script.length - 1)];
    if (r.hang) {
      return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }
    if (!r.chunks) return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    const enc = new TextEncoder();
    let k = 0;
    const stream = new ReadableStream({
      start(ctrl) { init.signal?.addEventListener("abort", () => { try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* */ } }); },
      async pull(ctrl) {
        if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
        if (k >= r.chunks.length) { if (r.hangAtEnd) return new Promise(() => {}); try { ctrl.close(); } catch { /* */ } return; }
        try { ctrl.enqueue(enc.encode(r.chunks[k++])); } catch { /* errored */ }
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  f.calls = calls;
  return f;
}

// ------------------------------------------------------------------------------------------- fake pack / deps

const strictTool = (name, props, required) => ({ name, description: `${name} tool.`, strict: true, input_schema: { type: "object", additionalProperties: false, properties: props, required } });
const TOOLS = [
  strictTool("search_catalog", { query: { type: "string" } }, ["query"]),
  strictTool("get_entries", { refs: { type: "array", items: { type: "string" } } }, ["refs"]),
  strictTool("submit_proposal", { ops: { type: "array", items: { type: "object" } } }, ["ops"])
];

/** A sheet whose lines the test can change: sheet.lines = Map(key -> line). */
function makeSheet(n = 12) {
  const lines = new Map([["ATTR", "ATTR FIG 4 AGI 8"], ...Array.from({ length: n }, (_, k) => [`I id${k}`, `I id${k} power "Power ${k}" lvl=basic`])]);
  return { lines, snapshotCalls: 0 };
}
const sheetText = (doc, lines) => `<sheet doc="${doc.uuid}" type=superhero>\n${[...lines.values()].join("\n")}\n</sheet>`;

function makePack({ runTool, sheet, catalogIndex = "CATALOG INDEX\n".repeat(50), tools = TOOLS, extra = {} } = {}) {
  const base = makeStubPack({ systemId: "test-sys", id: "test-sys", version: 3 });
  return {
    ...base,
    staticPrompt: async () => ({ rulesDigest: "RULES DIGEST\n".repeat(40), catalogIndex, fingerprint: "cat-1" }),
    tools: () => tools,
    runTool: runTool ?? (async (name, input) => {
      if (name === "search_catalog") return { ok: true, results: [{ ref: "powers:abc", name: `Hit for ${input.query}` }] };
      if (name === "get_entries") return { ok: true, entries: input.refs.map((r) => ({ ref: r, rulesText: "Rules." })) };
      if (name === "submit_proposal") return { ok: true, proposalId: "p-1", summary: "ok", warnings: [] };
      return { ok: false };
    }),
    snapshot: async (doc) => {
      if (!sheet) return { text: "", lines: new Map() };
      sheet.snapshotCalls++;
      return { text: sheetText(doc, sheet.lines), fingerprint: `fp${[...sheet.lines.values()].join("|").length}`, lines: new Map(sheet.lines), tokensEst: 100 };
    },
    ...extra
  };
}

function makeDeps({ pack, fetchImpl, settings = {}, limits, store, key = FAKE_KEY, ...rest } = {}) {
  const logs = [];
  const booked = [];
  const reservations = { open: 0, total: 0 };
  const lim = limits ?? {
    reserve: (usd) => { reservations.open++; reservations.total++; let done = false; return () => { if (!done) { done = true; reservations.open--; } }; },
    record: async (usd) => { booked.push(usd); }
  };
  const deps = {
    getPack: () => pack,
    getApiKey: () => key,
    settings: () => ({ model: "claude-sonnet-5-5", effort: "medium", cacheTtl: "1h", ...settings }),
    limits: lim,
    log: async (e) => { logs.push(JSON.parse(JSON.stringify(e))); },
    store: store ?? createSessionStore({ indexedDB: fakeIndexedDB() }),
    worldId: () => "world-x",
    redact: (s) => String(s).split(FAKE_KEY).join("[redacted]"),
    fetchImpl,
    ...rest
  };
  return { deps, logs, booked, reservations };
}

const ACTOR = { uuid: "Actor.aaa111", name: "Spider-Man", documentName: "Actor", type: "superhero" };
const ACTOR2 = { uuid: "Actor.bbb222", name: "Omni-Man", documentName: "Actor", type: "superhero" };
const allText = (m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : String(m.content));

// =========================================================================================== tests

await test("happy path (endTurnOnSubmit off): search -> get -> submit ok -> end_turn; tool results in history; proposal pending; costs booked + logged", async () => {
  const sheet = makeSheet();
  const fetchImpl = fakeModel([
    reply({ text: "Searching.", tools: [{ id: "tu1", name: "search_catalog", input: { query: "web" } }] }),
    reply({ tools: [{ id: "tu2", name: "get_entries", input: { refs: ["powers:abc"] } }] }),
    reply({ tools: [{ id: "tu3", name: "submit_proposal", input: { ops: [{ opId: "a" }] } }] }),
    reply({ text: "Done: Spider-Man is ready." })
  ]);
  const pack = makePack({ sheet });
  const { deps, logs, booked, reservations } = makeDeps({ pack, fetchImpl, settings: { endTurnOnSubmit: false } });
  const h = createHarness(deps);
  const s = await h.openSession(ACTOR);
  const events = [];
  s.on("*", (d, type) => events.push(type));
  const r = await s.send("Złóż mi Spider-Mana");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, "done");
  assert.equal(r.requests, 4);
  assert.equal(r.toolCalls, 3);
  assert.equal(r.proposal.proposalId, "p-1");
  assert.equal(r.text, "Done: Spider-Man is ready.", "W3-5: text = the last assistant message only");
  assert.deepEqual(r.progress, ["Searching."], "W3-5: text before a tool call is progress");
  const m = s.messages;
  assert.deepEqual(m.map((x) => x.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.match(m[0].content[0].text, /^<sheet doc="Actor.aaa111"/, "sheet block is the FIRST block of the GM message");
  assert.equal(m[0].content[1].text, "Złóż mi Spider-Mana");
  assert.equal(m[2].content[0].type, "tool_result");
  assert.equal(m[2].content[0].tool_use_id, "tu1");
  assert.ok(m[1].content.some((b) => b.type === "thinking" && b.signature), "thinking block kept with its signature");
  assert.equal(fetchImpl.calls.length, 4);
  assert.equal(booked.length, 4);
  assert.ok(booked.every((x) => x > 0));
  assert.equal(reservations.total, 4);
  assert.equal(reservations.open, 0, "every reservation released");
  assert.equal(logs.length, 4);
  assert.ok(logs.every((l) => l.kind === "build" && l.status === "ok" && l.cacheRead === 20000 && l.cacheWrite === 1000 && l.provider === "anthropic"));
  assert.equal(logs[0].prompt, "Złóż mi Spider-Mana");
  assert.equal(logs[1].prompt, undefined);
  assert.ok(Math.abs(s.usage().session.usd - booked.reduce((a, b) => a + b, 0)) < 1e-9);
  assert.ok(s.usage().cacheHitRatio > 0.9);
  for (const tp of ["turn-start", "sheet", "user-message", "request-start", "stream", "assistant-message", "tool-start", "tool-end", "proposal", "turn-end", "state"]) assert.ok(events.includes(tp), `event ${tp}`);
  const tr = s.transcript();
  assert.deepEqual(tr.filter((x) => x.role === "tool").map((x) => [x.name, x.status]), [["search_catalog", "done"], ["get_entries", "done"], ["submit_proposal", "done"]]);
  assert.equal(tr.find((x) => x.role === "gm").text, "Złóż mi Spider-Mana");
  assert.equal(tr.find((x) => x.role === "sheet").kind, "full");
  assert.ok(tr.some((x) => x.role === "proposal"));
});

await test("parallel tool calls answered in ONE user message; tool exception -> is_error; unknown tool and bad JSON never run", async () => {
  const ran = [];
  const pack = makePack({
    runTool: async (name, input) => { ran.push(name); if (name === "get_entries") throw new Error(`boom ${FAKE_KEY}`); return { ok: true }; }
  });
  const fetchImpl = fakeModel([
    reply({ tools: [
      { id: "a", name: "search_catalog", input: { query: "x" } },
      { id: "b", name: "get_entries", input: { refs: [] } },
      { id: "c", name: "delete_world", input: {} },
      { id: "d", name: "search_catalog", rawJson: "{\"query\": \"unterminated" }
    ] }),
    reply({ text: "ok" })
  ]);
  const { deps } = makeDeps({ pack, fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("go");
  assert.equal(r.reason, "done");
  const res = s.messages[2];
  assert.equal(res.role, "user");
  assert.deepEqual(res.content.map((b) => [b.tool_use_id, !!b.is_error]), [["a", false], ["b", true], ["c", true], ["d", true]]);
  assert.deepEqual(ran.sort(), ["get_entries", "search_catalog"], "unknown tool and invalid JSON input are not run");
  assert.ok(!JSON.stringify(s.messages).includes(FAKE_KEY), "tool error text redacted");
  assert.equal(fetchImpl.calls[1].body.messages.at(-1).content.length, 4);
});

await test("self-repair: invalid submit -> errors back to the model -> valid submit -> end", async () => {
  let n = 0;
  const pack = makePack({ runTool: async (name) => (name === "submit_proposal" ? (++n === 1 ? { ok: false, errors: [{ code: "attr.unspent", path: "attrs", message: "3 unspent" }] } : { ok: true, proposalId: "p2" }) : { ok: true }) });
  const fetchImpl = fakeModel([
    reply({ tools: [{ id: "s1", name: "submit_proposal", input: { ops: [] } }] }),
    reply({ tools: [{ id: "s2", name: "submit_proposal", input: { ops: [{ opId: "x" }] } }] }),
    reply({ text: "Fixed." })
  ]);
  const { deps } = makeDeps({ pack, fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const failed = [];
  s.on("submit-failed", (d) => failed.push(d));
  const r = await s.send("build");
  assert.equal(r.reason, "submitted", "a failed submit continues the turn; the accepted one ends it (W3-4)");
  assert.equal(r.requests, 2);
  assert.equal(r.proposal.proposalId, "p2");
  assert.equal(failed.length, 1);
  assert.match(s.messages[2].content[0].content, /attr\.unspent/);
  assert.equal(s.messages[2].content[0].is_error, undefined, "validation errors are a normal result, not is_error");
});

await test("cap: model requests (stops before request N+1; tool results of the last one still appended)", async () => {
  const fetchImpl = fakeModel(() => reply({ tools: [{ id: `t${msgSeq + 1}`, name: "search_catalog", input: { query: "q" } }] }));
  const { deps } = makeDeps({ pack: makePack(), fetchImpl, settings: { maxRequests: 3 } });
  const s = await createHarness(deps).openSession(ACTOR);
  const notices = [];
  s.on("notice", (n) => notices.push(n));
  const r = await s.send("loop");
  assert.equal(r.reason, "cap"); assert.equal(r.cap, "requests");
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(s.messages.at(-1).role, "user", "results of the last tool call are in history");
  assert.ok(notices.some((x) => x.code === "cap.requests" && /3/.test(x.message)));
});

await test("cap: tool calls (batch over the cap is not run; answered with is_error at the next GM message)", async () => {
  let ran = 0;
  const pack = makePack({ runTool: async () => { ran++; return { ok: true }; } });
  const many = (k) => Array.from({ length: k }, (_, j) => ({ id: `m${msgSeq}_${j}`, name: "search_catalog", input: { query: String(j) } }));
  const fetchImpl = fakeModel((i) => (i < 2 ? reply({ tools: many(3) }) : reply({ text: "fine" })));
  const { deps } = makeDeps({ pack, fetchImpl, settings: { maxToolCalls: 5 } });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("search a lot");
  assert.equal(r.cap, "toolCalls");
  assert.equal(ran, 3);
  assert.equal(s.messages.at(-1).role, "assistant");
  assert.equal(unansweredToolUses(s.messages).length, 3);
  const r2 = await s.send("continue");
  assert.equal(r2.reason, "done");
  const um = fetchImpl.calls[2].body.messages.at(-1);
  assert.deepEqual(um.content.slice(0, 3).map((b) => [b.type, b.is_error]), [["tool_result", true], ["tool_result", true], ["tool_result", true]]);
  assert.match(um.content[0].content, /Not run: the previous turn stopped \(cap\)/);
  assert.equal(um.content.at(-1).text, "continue");
});

await test("cap: consecutive invalid submissions (different errors each time) stop at maxInvalidSubmits with the last draft", async () => {
  let n = 0;
  const pack = makePack({ runTool: async () => ({ ok: false, errors: [{ code: `e${++n}`, message: `err ${n}` }] }) });
  const fetchImpl = fakeModel(() => reply({ tools: [{ id: `s${msgSeq + 1}`, name: "submit_proposal", input: { ops: [{ opId: String(msgSeq) }] } }] }));
  const { deps } = makeDeps({ pack, fetchImpl, settings: { maxInvalidSubmits: 4 } });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("build");
  assert.equal(r.cap, "invalidSubmits");
  assert.equal(fetchImpl.calls.length, 4);
  assert.equal(r.lastDraft.errors[0].code, "e4");
  assert.equal(s.pendingProposal, null);
});

await test("cap: identical invalid submission (same errors twice) stops early", async () => {
  const pack = makePack({ runTool: async () => ({ ok: false, errors: [{ code: "attr.over", path: "attrs", message: "over" }] }) });
  const fetchImpl = fakeModel(() => reply({ tools: [{ id: `s${msgSeq + 1}`, name: "submit_proposal", input: { ops: [] } }] }));
  const { deps } = makeDeps({ pack, fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("build");
  assert.equal(r.cap, "identicalInvalid");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(errorSignature({ errors: [{ code: "a" }, { code: "b" }] }), errorSignature({ errors: [{ code: "b" }, { code: "a" }] }));
});

await test("cap: per-message cost (estimate + spent) refuses the next request", async () => {
  const fetchImpl = fakeModel(() => reply({ tools: [{ id: `c${msgSeq + 1}`, name: "search_catalog", input: { query: "q" } }] }));
  const { deps } = makeDeps({ pack: makePack(), fetchImpl, settings: { maxCostPerMessage: 0.06 } });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("x");
  assert.equal(r.cap, "cost");
  assert.ok(fetchImpl.calls.length >= 1 && fetchImpl.calls.length < 12);
  assert.ok(r.usd <= 0.06);
  // tiny cap: refused before the first request, nothing sent, nothing booked
  const f2 = fakeModel([reply({ text: "x" })]);
  const d2 = makeDeps({ pack: makePack(), fetchImpl: f2, settings: { maxCostPerMessage: 0.0001 } });
  const s2 = await createHarness(d2.deps).openSession(ACTOR);
  const r2 = await s2.send("x");
  assert.equal(r2.cap, "cost"); assert.equal(f2.calls.length, 0); assert.equal(d2.booked.length, 0);
});

await test("module limits: reservation refused -> no request, 'limit' reason, blocked log entry; reservation always released", async () => {
  const f = fakeModel([reply({ text: "x" })]);
  const logs2 = [];
  const { deps } = makeDeps({
    pack: makePack(), fetchImpl: f,
    limits: { reserve: () => { throw new Error("Daily limit $5 reached."); }, record: async () => {} },
    log: async (e) => { logs2.push(e); }
  });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("x");
  assert.equal(r.reason, "limit");
  assert.equal(f.calls.length, 0);
  assert.equal(logs2[0].status, "blocked");
  assert.equal(logs2[0].costKind, "estimated");
  // daily limit reached mid-turn: first request goes, second is blocked
  let k = 0;
  const f3 = fakeModel(() => reply({ tools: [{ id: `l${msgSeq + 1}`, name: "search_catalog", input: { query: "q" } }] }));
  const d3 = makeDeps({ pack: makePack(), fetchImpl: f3, limits: { reserve: () => { if (++k > 1) throw new Error("monthly"); return () => {}; }, record: async () => {} } });
  const r3 = await (await createHarness(d3.deps).openSession(ACTOR)).send("x");
  assert.equal(r3.reason, "limit"); assert.equal(f3.calls.length, 1);
});

await test("Stop during streaming: cancelled, no partial assistant message appended; next turn works", async () => {
  const fetchImpl = fakeModel((i) => (i === 0 ? { hang: true } : reply({ text: "back" })));
  const { deps, reservations, logs } = makeDeps({ pack: makePack(), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  s.on("request-start", () => setTimeout(() => s.stop(), 20));
  const r = await s.send("long one");
  assert.equal(r.reason, "stopped");
  assert.deepEqual(s.messages.map((x) => x.role), [], "B4: stopped before any answer -> the GM message is not history");
  assert.equal(r.unsent, "long one");
  assert.equal(reservations.open, 0);
  assert.equal(logs[0].status, "cancelled");
  const r2 = await s.send("again");
  assert.equal(r2.reason, "done");
  assert.deepEqual(s.messages.map((x) => x.role), ["user", "assistant"]);
});

await test("Stop during tool execution: results not appended; answered with is_error at the next GM message", async () => {
  let s;
  const pack = makePack({ runTool: (name, input, ctx) => new Promise((res) => { setTimeout(() => s.stop(), 10); ctx.signal.addEventListener("abort", () => res({ ok: true, late: true })); }) });
  const fetchImpl = fakeModel([reply({ tools: [{ id: "slow1", name: "search_catalog", input: { query: "q" } }] }), reply({ text: "ok" })]);
  const { deps } = makeDeps({ pack, fetchImpl });
  s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("x");
  assert.equal(r.reason, "stopped");
  assert.equal(s.messages.at(-1).role, "assistant");
  await s.send("next");
  const first = fetchImpl.calls[1].body.messages.at(-1).content[0];
  assert.equal(first.type, "tool_result"); assert.equal(first.tool_use_id, "slow1"); assert.equal(first.is_error, true);
  assert.match(first.content, /stopped \(stopped\)/);
});

await test("wall clock: a hanging request is aborted after wallClockMs -> cap 'wall'", async () => {
  const fetchImpl = fakeModel(() => ({ hang: true }));
  const { deps } = makeDeps({ pack: makePack(), fetchImpl, settings: { wallClockMs: 60 } });
  const s = await createHarness(deps).openSession(ACTOR);
  const t0 = Date.now();
  const r = await s.send("x");
  assert.equal(r.reason, "cap"); assert.equal(r.cap, "wall");
  assert.ok(Date.now() - t0 < 3000);
});

await test("refusal: partial refused output not appended, notice; max_tokens: appended, tool_use answered next turn; pause_turn continues", async () => {
  const fetchImpl = fakeModel([
    reply({ text: "I can't", stop: "refusal" }),
    reply({ text: "pausing", stop: "pause_turn" }),
    reply({ text: "resumed" }),
    reply({ tools: [{ id: "cut1", name: "search_catalog", input: { query: "a" } }], stop: "max_tokens" }),
    reply({ text: "fine" })
  ]);
  const { deps } = makeDeps({ pack: makePack(), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const n = [];
  s.on("notice", (x) => n.push(x.code));
  const r1 = await s.send("bad");
  assert.equal(r1.reason, "refusal"); assert.ok(n.includes("stop.refusal"));
  assert.deepEqual(s.messages.map((x) => x.role), [], "B4: the refused GM message is not history");
  assert.equal(r1.unsent, "bad");
  const r2 = await s.send("ok then");
  assert.equal(r2.reason, "done"); assert.equal(r2.requests, 2, "pause_turn re-sent");
  assert.deepEqual(fetchImpl.calls[2].body.messages.slice(-2).map((x) => [x.role, allText(x)]), [["assistant", "pausing"], ["user", "Continue."]], "pause_turn: paused message kept, harness Continue appended");
  const r3 = await s.send("more");
  assert.equal(r3.reason, "max_tokens");
  assert.equal(unansweredToolUses(s.messages)[0].id, "cut1");
  await s.send("continue");
  assert.equal(fetchImpl.calls[4].body.messages.at(-1).content[0].tool_use_id, "cut1");
});

await test("transport error (HTTP 400): turn ends with a redacted error notice, failed request logged, nothing appended", async () => {
  const fetchImpl = fakeModel([{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: `bad thing with ${FAKE_KEY}` } } }]);
  const { deps, logs } = makeDeps({ pack: makePack(), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("x");
  assert.equal(r.reason, "error"); assert.equal(r.error.kind, "request");
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  assert.equal(logs[0].status, "error");
  assert.ok(!JSON.stringify(logs).includes(FAKE_KEY));
});

await test("guards: busy, empty, no key, no pack, history too long", async () => {
  const fetchImpl = fakeModel(() => ({ hang: true }));
  const { deps } = makeDeps({ pack: makePack(), fetchImpl, settings: { wallClockMs: 100 } });
  const s = await createHarness(deps).openSession(ACTOR);
  const p = s.send("one");
  assert.equal((await s.send("two")).reason, "busy");
  await p;
  assert.equal((await s.send("   ")).reason, "empty");
  const nk = makeDeps({ pack: makePack(), fetchImpl, key: "" });
  assert.equal((await (await createHarness(nk.deps).openSession(ACTOR)).send("x")).reason, "no-key");
  const np = makeDeps({ pack: null, fetchImpl });
  assert.equal((await (await createHarness(np.deps).openSession(ACTOR)).send("x")).reason, "no-pack");
  const big = { ...USAGE, cache_read_input_tokens: HISTORY_TOKEN_CAP + 10 };
  const fb = fakeModel([reply({ text: "x", usage: big }), reply({ text: "y" })]);
  const db = makeDeps({ pack: makePack(), fetchImpl: fb });
  const sb = await createHarness(db.deps).openSession(ACTOR);
  assert.equal((await sb.send("x")).reason, "done");
  assert.equal((await sb.send("y")).reason, "history-full");
  assert.equal(fb.calls.length, 1);
});

await test("sheet rule: full first, unchanged, small update, big drift -> full supersedes, 8 diffs -> full", async () => {
  const sheet = makeSheet(20);
  const fetchImpl = fakeModel(() => reply({ text: "ok" }));
  const { deps } = makeDeps({ pack: makePack({ sheet }), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const kinds = [];
  s.on("sheet", (e) => kinds.push(e.kind));
  const firstBlock = () => fetchImpl.calls.at(-1).body.messages.at(-1).content[0].text;
  await s.send("1"); assert.match(firstBlock(), /^<sheet doc=/); assert.ok(!firstBlock().includes(SUPERSEDES));
  await s.send("2"); assert.equal(firstBlock(), UNCHANGED_BLOCK);
  sheet.lines.set("I id3", 'I id3 power "Power 3" lvl=major'); sheet.lines.delete("I id4"); sheet.lines.set("I new1", 'I new1 talent "Quick"');
  await s.send("3");
  const up = firstBlock();
  assert.match(up, /^<sheet_update doc="Actor.aaa111"/);
  assert.match(up, /^- I id4$/m); assert.match(up, /^\+ I new1 talent/m); assert.match(up, /^~ I id3 power "Power 3" lvl=major$/m);
  for (let k = 0; k < 12; k++) sheet.lines.set(`I id${k}`, `I id${k} power "Changed ${k}"`);
  await s.send("4"); assert.ok(firstBlock().startsWith(`<sheet ${SUPERSEDES}`), firstBlock().slice(0, 80));
  for (let k = 0; k < 8; k++) { sheet.lines.set("ATTR", `ATTR FIG ${k}`); await s.send(`d${k}`); }
  sheet.lines.set("ATTR", "ATTR FIG 99");
  await s.send("9th");
  assert.deepEqual(kinds, ["full", "unchanged", "update", "full", ...Array(8).fill("update"), "full"]);
  // fold of the held picture equals the fresh snapshot
  const fresh = pairsOf({ lines: sheet.lines });
  assert.equal(diffPairs(s.record.sheet.held.pairs, fresh).size, 0);
});

await test("sheet rule (pure): thresholds, fold, text fallback without lines, held codec", () => {
  const mk = (n) => ({ text: "<sheet>\nx\n</sheet>", lines: new Map(Array.from({ length: n }, (_, i) => [`k${i}`, `k${i} v`])) });
  const a = decideSheetBlock(null, mk(8));
  assert.equal(a.kind, "full");
  const b = mk(8); b.lines.set("k0", "k0 changed"); b.lines.set("k1", "k1 changed"); b.lines.set("k2", "k2 changed");
  assert.equal(decideSheetBlock(a.held, b).kind, "full", "3/8 lines = 37.5 % > 25 %");
  const c = mk(8); c.lines.set("k0", "k0 changed"); c.lines.set("k1", "k1 changed");
  const dc = decideSheetBlock(a.held, c);
  assert.equal(dc.kind, "update", "2/8 = 25 %");
  assert.deepEqual(foldPairs(a.held.pairs, diffPairs(a.held.pairs, [...c.lines])), [...c.lines]);
  const huge = mk(400); const hh = decideSheetBlock(null, huge);
  const h2 = mk(400); for (let i = 0; i < 90; i++) h2.lines.set(`k${i}`, `k${i} ${"long text ".repeat(20)}`);
  assert.equal(decideSheetBlock(hh.held, h2).kind, "full", "over 1,500 tokens");
  const tx = decideSheetBlock(null, { text: "<sheet a=1>\nA 1\nB 2\n</sheet>" });
  assert.deepEqual(tx.held.pairs, [["A 1", "A 1"], ["B 2", "B 2"]]);
  const m = { lines: new Map([["a", { x: new Map([["b", 1]]) }]]), n: 2 };
  const back = decodeHeld(JSON.parse(JSON.stringify(encodeHeld(m))));
  assert.ok(back.lines instanceof Map && back.lines.get("a").x instanceof Map && back.lines.get("a").x.get("b") === 1 && back.n === 2);
});

await test("pack-provided nextSheetBlock is used (held with Maps survives the store), core rule otherwise", async () => {
  const sheet = makeSheet(5);
  const seen = [];
  const pack = makePack({ sheet, extra: {
    nextSheetBlock: (held, snap) => {
      seen.push(held);
      if (!held) return { kind: "full", text: snap.text, held: { lines: new Map(snap.lines), diffs: 0 } };
      return { kind: "unchanged", text: "<sheet_unchanged/>", held };
    }
  } });
  const store = createSessionStore({ indexedDB: fakeIndexedDB() });
  const fetchImpl = fakeModel(() => reply({ text: "ok" }));
  const { deps } = makeDeps({ pack, fetchImpl, store });
  const s = await createHarness(deps).openSession(ACTOR);
  await s.send("1"); await s.send("2");
  assert.equal(seen[0], null);
  assert.ok(seen[1].lines instanceof Map && seen[1].lines.size === 6);
  assert.equal(s.record.sheet.by, "pack");
  // reload from the store in a new harness: Map restored
  const s2 = await createHarness({ ...deps }).openSession(ACTOR);
  await s2.send("3");
  assert.ok(seen[2].lines instanceof Map);
});

await test("cache prefix stability: tools+system bytes identical across turns 1,2,5 and across two actors; history is append-only", async () => {
  const sheet = makeSheet();
  const fetchImpl = fakeModel((i) => (i % 2 === 0 ? reply({ tools: [{ id: `p${i}`, name: "search_catalog", input: { query: String(i) } }] }) : reply({ text: `t${i}` })));
  const { deps } = makeDeps({ pack: makePack({ sheet }), fetchImpl });
  const h = createHarness(deps);
  const s1 = await h.openSession(ACTOR);
  for (let k = 1; k <= 5; k++) { if (k === 3) sheet.lines.set("ATTR", "ATTR FIG 9"); await s1.send(`turn ${k}`); }
  const s2 = await h.openSession(ACTOR2);
  await s2.send("other actor");
  assert.equal(fetchImpl.calls.length, 12, "5 turns x 2 requests (tool + text) + 2 for the second actor");
  const bytes = fetchImpl.calls.map((c) => prefixBytes({ body: c.body }));
  assert.ok(bytes.every((b) => b === bytes[0]), "prefix bytes identical for every request");
  for (const c of fetchImpl.calls) {
    assert.equal(c.body.system.length, 3);
    assert.equal(c.body.system[0].text, HARNESS_RULES);
    assert.deepEqual(c.body.system[2].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(c.body.cache_control, { type: "ephemeral" });
    assert.ok(!JSON.stringify(c.body.system).includes("<sheet"), "no sheet in system");
    assert.ok(!JSON.stringify(c.body.system).includes("Spider") && !JSON.stringify(c.body.tools).includes("Spider"));
  }
  const s1calls = fetchImpl.calls.slice(0, 10);
  for (let i = 1; i < s1calls.length; i++) {
    const prev = s1calls[i - 1].body.messages, cur = s1calls[i].body.messages;
    assert.ok(cur.length > prev.length);
    for (let j = 0; j < prev.length; j++) assert.equal(JSON.stringify(cur[j]), JSON.stringify(prev[j]), `request ${i} message ${j} unchanged`);
  }
});

await test("session store: persisted in IndexedDB, reload restores history, append-only guard, new conversation archives", async () => {
  const idb = fakeIndexedDB();
  const store = createSessionStore({ indexedDB: idb });
  const fetchImpl = fakeModel(() => reply({ text: "ok" }));
  const { deps } = makeDeps({ pack: makePack(), fetchImpl, store });
  const s = await createHarness(deps).openSession(ACTOR);
  await s.send("hello");
  const conv1 = s.conversationId;
  // a brand-new store on the same fake DB = page reload
  const store2 = createSessionStore({ indexedDB: idb });
  const rec = await store2.load("world-x:Actor.aaa111");
  assert.equal(rec.messages.length, 2);
  assert.equal(store2.mode, "idb");
  const s2 = await createHarness({ ...deps, store: store2 }).openSession(ACTOR);
  assert.equal(s2.conversationId, conv1);
  assert.equal(s2.transcript().find((x) => x.role === "gm").text, "hello");
  // edits are refused
  const edited = JSON.parse(JSON.stringify(rec)); edited.messages[0].content[0].text = "changed";
  await assert.rejects(store2.save(edited), HistoryEditError);
  const shorter = JSON.parse(JSON.stringify(rec)); shorter.messages.pop();
  await assert.rejects(store2.save(shorter), HistoryEditError);
  assert.throws(() => assertAppendOnly({ conversationId: "a", messages: [1, 2] }, { conversationId: "a", messages: [2, 1] }), HistoryEditError);
  const other = { ...rec, conversationId: "other", messages: [] };
  await assert.rejects(store2.save(other), HistoryEditError, "another conversation needs newConversation");
  // new conversation: old one archived, active is empty, model/effort from settings
  const nc = await s2.newConversation();
  assert.equal(nc.ok, true);
  assert.notEqual(s2.conversationId, conv1);
  assert.equal((await store2.load("world-x:Actor.aaa111")).messages.length, 0);
  const arch = await store2.listArchive("world-x:Actor.aaa111");
  assert.equal(arch.length, 1); assert.equal(arch[0].conversationId, conv1);
  // per actor: the other actor has its own record
  const s3 = await createHarness({ ...deps, store: store2 }).openSession(ACTOR2);
  assert.equal(s3.messages.length, 0);
  assert.notEqual(s3.key, s2.key);
});

await test("session store: IndexedDB missing or failing -> memory mode with one warning, harness keeps working", async () => {
  const warns = [];
  const st = createSessionStore({ indexedDB: fakeIndexedDB({ failOpen: true }), onWarn: (e) => warns.push(e) });
  const fetchImpl = fakeModel(() => reply({ text: "ok" }));
  const { deps } = makeDeps({ pack: makePack(), fetchImpl, store: st });
  const s = await createHarness(deps).openSession(ACTOR);
  assert.equal((await s.send("x")).reason, "done");
  assert.equal((await s.send("y")).reason, "done");
  assert.equal(st.mode, "memory");
  assert.equal(warns.length, 1);
  assert.equal((await st.load("world-x:Actor.aaa111")).messages.length, 4);
  const st2 = createSessionStore({ indexedDB: null });
  await st2.save({ key: "k", conversationId: "c", messages: [] });
  assert.equal(st2.mode, "memory");
});

await test("secrets: the key never reaches history, store, log, events, notices or transcript after a full mocked session", async () => {
  const idb = fakeIndexedDB();
  const store = createSessionStore({ indexedDB: idb });
  const pack = makePack({ runTool: async (name) => { if (name === "get_entries") throw new Error(`x-api-key: ${FAKE_KEY}`); return name === "submit_proposal" ? { ok: true, proposalId: "p" } : { ok: true }; } });
  const fetchImpl = fakeModel([
    reply({ tools: [{ id: "k1", name: "get_entries", input: { refs: [] } }] }),
    reply({ tools: [{ id: "k2", name: "submit_proposal", input: { ops: [] } }] }),
    reply({ text: "done" }),
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${FAKE_KEY}` } } }
  ]);
  const { deps, logs } = makeDeps({ pack, fetchImpl, store });
  const s = await createHarness(deps).openSession(ACTOR);
  const evs = [];
  s.on("*", (d, type) => evs.push({ type, d }));
  await s.send("build");
  await s.send("again");
  await s.prewarm({ force: true }).catch(() => {});
  const dump = JSON.stringify({ idb: [...idb._dbs.get("moinens-ai-gen").get("sessions").values()], logs, evs, tr: s.transcript(), rec: s.record });
  assert.ok(!dump.includes(FAKE_KEY), "fake key found in a persisted or emitted structure");
  assert.ok(fetchImpl.calls.every((c) => c.headers["x-api-key"] === FAKE_KEY), "the key is only in the request header");
  assert.ok(!fetchImpl.calls.some((c) => c.raw.includes(FAKE_KEY)), "never in a request body");
});

await test("pre-warm: max_tokens 0 non-streaming request with the same prefix; skipped while warm; costs booked", async () => {
  let t = 1_000_000;
  const fetchImpl = fakeModel((i, body) => (body.max_tokens === 0
    ? { body: { id: "msg_w", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: "max_tokens", usage: { input_tokens: 5, cache_creation_input_tokens: 21000, cache_creation: { ephemeral_1h_input_tokens: 21000, ephemeral_5m_input_tokens: 0 }, output_tokens: 0 } } }
    : reply({ text: "ok" })));
  const { deps, logs, booked } = makeDeps({ pack: makePack(), fetchImpl, now: () => t });
  const s = await createHarness(deps).openSession(ACTOR);
  const w1 = await s.prewarm();
  assert.equal(w1.ok, true); assert.ok(w1.usd > 0);
  assert.equal(fetchImpl.calls[0].body.max_tokens, 0); assert.equal(fetchImpl.calls[0].body.stream, undefined);
  assert.equal((await s.prewarm()).skipped, "warm");
  await s.send("hi");
  assert.equal(prefixBytes({ body: fetchImpl.calls[0].body }), prefixBytes({ body: fetchImpl.calls[1].body }), "pre-warm prefix = real prefix");
  t += 56 * 60_000;
  assert.equal((await s.prewarm()).skipped, undefined);
  assert.equal(logs.filter((l) => l.kind === "build-prewarm").length, 2);
  assert.equal(booked.length, 3);
  const off = makeDeps({ pack: makePack(), fetchImpl, settings: { prewarm: false } });
  assert.equal((await (await createHarness(off.deps).openSession(ACTOR)).prewarm()).skipped, "disabled");
});

await test("settings drift: model fixed per conversation (notice), new conversation adopts the setting; options reach the pack", async () => {
  let model = "claude-sonnet-5-5";
  const opts = [];
  const pack = makePack({ sheet: makeSheet(), runTool: async (n, i, ctx) => { opts.push(ctx.options); return { ok: true }; } });
  const snap = pack.snapshot;
  pack.snapshot = async (doc, o) => { opts.push(o); return snap(doc, o); };
  const fetchImpl = fakeModel((i) => (i === 0 ? reply({ tools: [{ id: "o1", name: "search_catalog", input: { query: "a" } }] }) : reply({ text: "ok" })));
  const { deps } = makeDeps({ pack, fetchImpl, settings: {} });
  deps.settings = () => ({ model, effort: "medium" });
  const s = await createHarness(deps).openSession(ACTOR);
  await s.setOptions({ rank: "global", profile: "creation" });
  await s.send("a");
  model = "claude-opus-5-5";
  const notes = [];
  s.on("notice", (n) => notes.push(n.code));
  await s.send("b");
  assert.ok(notes.includes("settingsDrift"));
  assert.equal(fetchImpl.calls.at(-1).body.model, "claude-sonnet-5-5");
  await s.newConversation();
  await s.send("c");
  assert.equal(fetchImpl.calls.at(-1).body.model, "claude-opus-5-5");
  assert.equal(opts[0].rank, "global"); assert.equal(opts[0].liveForm, true);
  assert.ok(opts.some((o) => o?.profile === "creation" && !("liveForm" in o)), "tool ctx.options");
});

await test("the plain stub pack (scripts/systems/_stub) drives a full turn: tool call, empty-sheet rule, unchanged on the next message", async () => {
  const pack = makeStubPack({ systemId: "stub-system" });
  const fetchImpl = fakeModel([reply({ tools: [{ id: "st1", name: "search_catalog", input: { query: "x" } }] }), reply({ text: "nothing found" }), reply({ text: "again" })]);
  const { deps } = makeDeps({ pack, fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("find x");
  assert.equal(r.reason, "done"); assert.equal(r.sheet, "full");
  assert.equal(s.messages[2].content[0].content, '{"ok":true,"results":[]}');
  assert.equal((await s.send("again")).sheet, "unchanged");
  assert.equal(fetchImpl.calls[1].body.system[1].text, "Stub rules.");
  assert.equal(fetchImpl.calls[1].body.system.length, 2, "empty catalogue part skipped; breakpoint on the last block");
});

await test("helpers: tool result content cut, strings EN/PL complete, transcript of an empty record", () => {
  const long = toolResultContent("x".repeat(MAX_TOOL_RESULT_CHARS + 10));
  assert.match(long, /\(truncated, \d+ chars\)$/);
  assert.equal(toolResultContent({ modelContent: "plain" }), "plain");
  assert.equal(toolResultContent({ ok: true }), '{"ok":true}');
  assert.deepEqual(Object.keys(STRINGS.EN).sort(), Object.keys(STRINGS.PL).sort());
  assert.match(t("MAIG.Build.Cap.requests", { max: 12 }, { i18n: { lang: "pl" } }), /12 zapytań/);
  assert.deepEqual(transcriptOf({ messages: [], timeline: [] }), []);
});

await test("static wiring: module.mjs loads builder-api dynamically for the GM; call log has cache fields; settings registered at init", async () => {
  const fs = await import("node:fs");
  const mod = fs.readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");
  assert.match(mod, /import\("\.\/build\/builder-api\.mjs"\)\.then\(\(m\) => m\.attachBuilder\(api\)\)\.catch/);
  const cl = fs.readFileSync(new URL("../scripts/call-log.mjs", import.meta.url), "utf8");
  assert.match(cl, /"cacheRead", "cacheWrite"/);
  const st = fs.readFileSync(new URL("../scripts/settings.mjs", import.meta.url), "utf8");
  assert.match(st, /registerBuildSettings\(\)/);
  // harness files never touch Foundry globals at import time and never import a system pack
  for (const f of ["harness.mjs", "session-store.mjs", "sheet-sync.mjs", "harness-defaults.mjs"]) {
    const src = fs.readFileSync(new URL(`../scripts/build/${f}`, import.meta.url), "utf8");
    assert.ok(!/systems\//.test(src.replace(/^\s*\/\/.*$/gm, "")), `${f} imports no system pack`);
    assert.ok(!/\b(game|ui|Hooks|foundry)\./.test(src.replace(/^\s*\/\/.*$/gm, "").replace(/globalThis\.\w+/g, "").replace(/\?\.\w+/g, "")), `${f} uses no Foundry global`);
  }
  // build-settings imports in node and registers with a fake game
  globalThis.foundry = { data: { fields: { NumberField: class { constructor(o) { Object.assign(this, o); } }, StringField: class { constructor(o) { Object.assign(this, o); } }, BooleanField: class { constructor(o) { Object.assign(this, o); } } } } };
  const reg = new Map();
  const { registerBuildSettings, readBuildSettings } = await import("../scripts/build/build-settings.mjs");
  const game = { settings: { register: (ns, k, o) => reg.set(k, o), get: (ns, k) => reg.get(k)?.type?.initial } };
  registerBuildSettings(game);
  assert.equal(reg.get("build.model").type.initial, "claude-sonnet-5-5");
  assert.equal(reg.get("build.prewarm").scope, "client");
  assert.ok([...reg.values()].every((o) => o.restricted === true));
  const r = readBuildSettings(game);
  assert.equal(r.maxRequests, 12); assert.equal(r.wallClockMs, 300_000); assert.equal(r.maxCostPerMessage, 0.5); assert.equal(r.cacheTtl, "1h");
  assert.equal(reg.get("build.endTurnOnSubmit").scope, "world"); assert.equal(reg.get("build.endTurnOnSubmit").type.initial, true);
  assert.equal(r.endTurnOnSubmit, true, "W3-4 default on");
  delete globalThis.foundry;
});

// ------------------------------------------------------------------------------------------- W2-7: options, proposal state

await test("W2-7 setOptions resolves with the effective options (merged, null removes a key) and persists them", async () => {
  const store = createSessionStore({ indexedDB: fakeIndexedDB() });
  const { deps } = makeDeps({ pack: makePack({ sheet: makeSheet() }), fetchImpl: fakeModel([reply({ text: "x" })]), store });
  const s = await createHarness(deps).openSession(ACTOR);
  assert.deepEqual(await s.setOptions({ rank: "street", profile: "creation" }), { rank: "street", profile: "creation" });
  assert.deepEqual(await s.setOptions({ profile: "in-play" }), { rank: "street", profile: "in-play" });
  const eff = await s.setOptions({ rank: null });
  assert.deepEqual(eff, { profile: "in-play" });
  eff.profile = "mutated";
  assert.deepEqual(s.options, { profile: "in-play" }, "a copy, not the record");
  const fresh = await createHarness({ ...deps }).openSession(ACTOR);
  assert.deepEqual(fresh.options, { profile: "in-play" }, "persisted in the store");
});

/** a pack whose submit_proposal returns proposal ids p1, p2 ... in order */
function proposalPack() {
  let n = 0;
  return makePack({ sheet: makeSheet(), runTool: async (name) => (name === "submit_proposal" ? { ok: true, proposalId: `p${++n}`, summary: "s", warnings: [] } : { ok: true }) });
}
const submitThenText = (i) => (i % 2 === 0 ? reply({ tools: [{ id: `sub${i}`, name: "submit_proposal", input: { ops: [{ opId: String(i) }] } }] }) : reply({ text: `t${i}` }));
const markersOf = (m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "text" && /^<proposal /.test(b.text)).map((b) => b.text) : []);

await test("W2-7 proposal marker (P1-H): pending on the next GM message, applied after markProposal, nothing when unchanged; before the GM text", async () => {
  const fetchImpl = fakeModel((i) => (i === 0 ? submitThenText(0) : reply({ text: `t${i}` })));
  const { deps } = makeDeps({ pack: proposalPack(), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  await s.send("build");                                         // submit p1
  assert.equal(s.pendingProposal.proposalId, "p1");
  assert.deepEqual(markersOf(s.messages[0]), [], "no marker before any proposal");
  await s.send("what now?");                                     // p1 still pending -> marker pending
  let gm = s.messages.filter((m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text === "what now?"))[0];
  assert.deepEqual(markersOf(gm), ['<proposal id="p1" status="pending"/>']);
  assert.deepEqual([gm.content[0].type, gm.content[0].tool_use_id], ["tool_result", "sub0"], "W3-4: held submit result leads the next GM message");
  const texts = gm.content.filter((b) => b.type === "text").map((b) => b.text);
  assert.match(texts[0], /^<sheet/, "sheet first after the results");
  assert.equal(texts.at(-1), "what now?", "GM text last");
  assert.equal(texts.at(-2), '<proposal id="p1" status="pending"/>', "marker right before the GM text");
  await s.send("again");                                         // unchanged -> no marker
  gm = s.messages.find((m) => m.role === "user" && m.content.some((b) => b.text === "again"));
  assert.deepEqual(markersOf(gm), []);
  assert.deepEqual(await s.markProposal("p1", "applied", { runId: "run-9" }), { ok: true, id: "p1", status: "applied" });
  assert.equal(s.pendingProposal, null, "applied clears the pending proposal");
  assert.equal(s.record.lastRunId, "run-9");
  await s.send("give him flight");
  gm = s.messages.find((m) => m.role === "user" && m.content.some((b) => b.text === "give him flight"));
  assert.deepEqual(markersOf(gm), ['<proposal id="p1" status="applied"/>']);
  await s.send("thanks");
  gm = s.messages.find((m) => m.role === "user" && m.content.some((b) => b.text === "thanks"));
  assert.deepEqual(markersOf(gm), [], "reported once");
  assert.deepEqual((await s.markProposal("nope", "applied")), { ok: false, reason: "unknown" });
  assert.deepEqual((await s.markProposal("p1", "done")), { ok: false, reason: "status" });
  const tr = s.transcript();
  assert.ok(tr.some((x) => x.role === "proposal-marker" && x.proposalId === "p1" && x.status === "applied"), "marker shown as a marker item");
  assert.ok(tr.some((x) => x.role === "proposal-status" && x.status === "applied"), "timeline item of markProposal");
  assert.ok(!tr.some((x) => x.role === "gm" && /<proposal/.test(x.text)), "marker never shown as GM text");
  assert.deepEqual(s.proposals.map((p) => [p.id, p.status, p.reported]), [["p1", "applied", "applied"]]);
});

await test("W2-7 proposal marker: discarded; a newer submit supersedes an older pending one; GM text that looks like a marker stays GM text", async () => {
  const fetchImpl = fakeModel((i) => (i < 4 ? submitThenText(i) : reply({ text: `t${i}` })));
  const { deps } = makeDeps({ pack: proposalPack(), fetchImpl, settings: { endTurnOnSubmit: false } });
  const s = await createHarness(deps).openSession(ACTOR);
  await s.send("one");                                           // p1
  await s.send("two");                                           // marker p1 pending, then p2 submitted
  await s.markProposal("p2", "discarded");
  assert.equal(s.pendingProposal, null);
  await s.send("three");
  const gm = s.messages.find((m) => m.role === "user" && m.content.some((b) => b.text === "three"));
  assert.deepEqual(markersOf(gm), ['<proposal id="p2" status="discarded"/>'], "p1 superseded: only p2");
  await s.send('<proposal id="x" status="applied"/> did you see that?');
  const tr = s.transcript();
  assert.ok(tr.some((x) => x.role === "gm" && /did you see that/.test(x.text)));
  await s.markProposal("p2", "pending");                         // e.g. after an Undo
  assert.equal(s.proposals.find((p) => p.id === "p2").status, "pending");
  assert.equal(s.pendingProposal?.proposalId, "p2", "W6-D1: discarded then pending = pending proposal again");
});

await test("W6-D1 dry7-multi: Apply, Undo (markProposal pending) -> pendingProposal again with its input; re-Apply works; newer pending wins; persisted", async () => {
  const store = createSessionStore({ indexedDB: fakeIndexedDB() });
  const ACTOR3 = { uuid: "Actor.ccc333", name: "Vampire", documentName: "Actor", type: "superhero" };
  const fetchImpl = fakeModel((i) => (i === 0 ? submitThenText(0) : i === 2 ? submitThenText(2) : reply({ text: `t${i}` })));
  const { deps } = makeDeps({ pack: proposalPack(), fetchImpl, store });
  const s = await createHarness(deps).openSession(ACTOR3);
  await s.send("build");                                         // p1
  const orig = s.pendingProposal;
  assert.equal(orig.proposalId, "p1");
  await s.markProposal("p1", "applied", { runId: "run-1" });
  assert.equal(s.pendingProposal, null, "applied clears it (semantics kept)");
  const back = await s.markProposal("p1", "pending");
  assert.deepEqual(back, { ok: true, id: "p1", status: "pending" });
  assert.equal(s.pendingProposal?.proposalId, "p1", "the drawer has something to re-apply");
  assert.deepEqual(s.pendingProposal.input, orig.input, "same input");
  assert.equal(s.pendingProposal.toolUseId, orig.toolUseId);
  assert.equal(s.pendingProposal.restored, true);
  assert.equal(s.record.shelvedProposals.length, 0, "taken off the shelf");
  const fresh = await createHarness(makeDeps({ pack: proposalPack(), fetchImpl, store }).deps).openSession(ACTOR3);
  assert.equal(fresh.pendingProposal?.proposalId, "p1", "persisted in the store");
  await s.markProposal("p1", "applied", { runId: "run-2" });     // re-Apply
  assert.equal(s.pendingProposal, null); assert.equal(s.record.lastRunId, "run-2");
  await s.send("now?");                                          // marker
  await s.send("another");                                       // p2 submitted, pending
  assert.equal(s.pendingProposal.proposalId, "p2");
  await s.markProposal("p1", "pending");                         // Undo of the older run while p2 is pending
  assert.equal(s.pendingProposal.proposalId, "p2", "a newer pending proposal stays the pending one");
  assert.equal(s.proposals.find((p) => p.id === "p1").status, "pending");
  assert.deepEqual(await s.markProposal("zz", "pending"), { ok: false, reason: "unknown" });
  // the shelf is bounded
  const sh = (s.record.shelvedProposals = []);
  for (let k = 0; k < 8; k++) {
    s.record.pendingProposal = { proposalId: `q${k}`, input: {} };
    s.record.proposalStates.push({ id: `q${k}`, status: "pending", reported: null });
    await s.markProposal(`q${k}`, "discarded");
  }
  assert.equal(s.record.shelvedProposals.length, MAX_SHELVED_PROPOSALS);
  assert.equal(s.record.shelvedProposals[0].proposalId, "q3");
  void sh;
});

await test("W2-7 prefix stability with proposal markers: tools + system bytes identical, marker only in messages, history a strict prefix", async () => {
  const fetchImpl = fakeModel((i) => (i === 0 ? submitThenText(0) : reply({ text: `t${i}` })));
  const { deps } = makeDeps({ pack: proposalPack(), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  await s.send("build");
  await s.send("pending?");
  await s.markProposal("p1", "applied");
  await s.send("applied?");
  const bytes = fetchImpl.calls.map((c) => prefixBytes({ body: c.body }));
  assert.ok(bytes.every((b) => b === bytes[0]), "prefix bytes identical for every request");
  for (const c of fetchImpl.calls) {
    // W2-8: system[0] describes the marker with placeholders (id="..." status="..."); a REAL marker never goes there
    const real = /<proposal id=\\"(?!\.\.\.\\")/;
    assert.ok(!real.test(JSON.stringify(c.body.system)), "no marker in system[]");
    assert.ok(!JSON.stringify(c.body.tools).includes("<proposal"), "no marker in tools");
  }
  const last = fetchImpl.calls.at(-1).body.messages;
  assert.ok(JSON.stringify(last).includes('<proposal id=\\"p1\\" status=\\"pending\\"/>') && JSON.stringify(last).includes('<proposal id=\\"p1\\" status=\\"applied\\"/>'));
  for (let i = 1; i < fetchImpl.calls.length; i++) {
    const prev = fetchImpl.calls[i - 1].body.messages, cur = fetchImpl.calls[i].body.messages;
    for (let j = 0; j < prev.length; j++) assert.equal(JSON.stringify(cur[j]), JSON.stringify(prev[j]), `request ${i} message ${j} unchanged`);
  }
});

// ------------------------------------------------------------------------------------------- W3-4 / W3-5

/** roles strictly alternate user/assistant, starting with user; every tool_use is answered at the start of the next message */
function assertValidHistory(messages, { allowOpenTail = false } = {}) {
  messages.forEach((m, i) => assert.equal(m.role, i % 2 === 0 ? "user" : "assistant", `message ${i} role (no two ${m.role} in a row)`));
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) return;
    const next = messages[i + 1];
    if (!next) { assert.ok(allowOpenTail, `tool_use in the last message ${i} not answered`); return; }
    const lead = next.content.slice(0, ids.length);
    assert.deepEqual(lead.map((b) => [b.type, b.tool_use_id]), ids.map((id) => ["tool_result", id]), `results of message ${i} lead message ${i + 1}`);
  });
}

await test("W3-4 end on submit (default): no request after an accepted submit; results held, then lead the next GM message; history valid and append-only; survives a reload", async () => {
  const idb = fakeIndexedDB();
  const store = createSessionStore({ indexedDB: idb });
  const fetchImpl = fakeModel([
    reply({ text: "Searching.", tools: [{ id: "w1", name: "search_catalog", input: { query: "web" } }] }),
    reply({ text: "Here is the build.", tools: [{ id: "w2", name: "submit_proposal", input: { ops: [{ opId: "a" }] } }] }),
    reply({ text: "Answer to the second message." })
  ]);
  const { deps } = makeDeps({ pack: proposalPack(), fetchImpl, store });
  const s = await createHarness(deps).openSession(ACTOR);
  const ends = [], aMsgs = [];
  s.on("turn-end", (x) => ends.push(x));
  s.on("assistant-message", (x) => aMsgs.push(x));
  const r = await s.send("Build Spider-Man");
  assert.equal(r.ok, true); assert.equal(r.reason, "submitted"); assert.equal(r.stop, "tool_use");
  assert.equal(r.requests, 2, "no third request"); assert.equal(fetchImpl.calls.length, 2);
  assert.equal(r.toolCalls, 2);
  assert.equal(r.text, "", "W3-4: the turn's text is empty, the drawer shows the rationale");
  assert.deepEqual(r.progress, ["Searching.", "Here is the build."], "W3-5");
  assert.equal(r.proposal.proposalId, "p1");
  assert.equal(ends[0].reason, "submitted");
  assert.deepEqual(aMsgs.map((x) => x.progress), [true, true]);
  // history ends with the assistant tool_use; its result is held outside messages
  assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assertValidHistory(s.messages, { allowOpenTail: true });
  assert.deepEqual(s.record.heldToolResults.map((b) => [b.type, b.tool_use_id, !!b.is_error]), [["tool_result", "w2", false]]);
  assert.match(s.record.heldToolResults[0].content, /"ok":true/);
  const tr = s.transcript();
  assert.equal(tr.find((x) => x.role === "tool" && x.id === "w2").status, "done", "held result marks the chip done");
  assert.deepEqual(tr.filter((x) => x.role === "progress").map((x) => x.text), ["Searching.", "Here is the build."]);
  assert.ok(!tr.some((x) => x.role === "ai"));
  // reload (new store + harness on the same DB): the held results survive
  const s2 = await createHarness({ ...deps, store: createSessionStore({ indexedDB: idb }) }).openSession(ACTOR);
  assert.equal(s2.record.heldToolResults.length, 1);
  const r2 = await s2.send("Make him faster");
  assert.equal(r2.reason, "done"); assert.equal(r2.text, "Answer to the second message."); assert.deepEqual(r2.progress, []);
  const sent = fetchImpl.calls[2].body.messages;
  assertValidHistory(sent);
  const gm = sent.at(-1);
  assert.equal(gm.role, "user");
  assert.deepEqual(gm.content.map((b) => b.type === "tool_result" ? `result:${b.tool_use_id}` : /^<sheet/.test(b.text) ? "sheet" : /^<proposal/.test(b.text) ? b.text : b.text),
    ["result:w2", "sheet", '<proposal id="p1" status="pending"/>', "Make him faster"], "held result, sheet, marker, GM text: one user message");
  assert.match(gm.content[0].content, /"ok":true/, "the REAL submit result, not a 'Not run' error");
  assert.equal(gm.content[0].is_error, undefined);
  assert.equal(s2.record.heldToolResults, null, "cleared once sent");
  assertValidHistory(s2.messages);
  // append-only + cache-stable: every request's messages are a strict prefix of the next
  for (let i = 1; i < fetchImpl.calls.length; i++) {
    const prev = fetchImpl.calls[i - 1].body.messages, cur = fetchImpl.calls[i].body.messages;
    for (let j = 0; j < prev.length; j++) assert.equal(JSON.stringify(cur[j]), JSON.stringify(prev[j]), `request ${i} message ${j} unchanged`);
  }
  const bytes = fetchImpl.calls.map((c) => prefixBytes({ body: c.body }));
  assert.ok(bytes.every((b) => b === bytes[0]), "tools + system bytes identical");
  assert.equal(s2.transcript().find((x) => x.role === "tool" && x.id === "w2").status, "done");
});

await test("W3-4 only a batch of accepted submits ends the turn: submit + other tool, failed submit, mixed submits continue; setting off continues", async () => {
  const run = async (first, settings = {}, pack = proposalPack()) => {
    const fetchImpl = fakeModel([first, reply({ text: "after" })]);
    const { deps } = makeDeps({ pack, fetchImpl, settings });
    const s = await createHarness(deps).openSession(ACTOR);
    const r = await s.send("go");
    return { r, s, fetchImpl };
  };
  let x = await run(reply({ tools: [{ id: "m1", name: "submit_proposal", input: { ops: [] } }, { id: "m2", name: "search_catalog", input: { query: "q" } }] }));
  assert.equal(x.r.reason, "done"); assert.equal(x.r.requests, 2, "submit with another tool: the model sees the other result");
  assert.equal(x.s.record.heldToolResults, null);
  assertValidHistory(x.s.messages);
  let n = 0;
  const failing = makePack({ sheet: makeSheet(), runTool: async () => (++n === 1 ? { ok: false, errors: [{ code: "e", message: "bad" }] } : { ok: true, proposalId: "q" }) });
  x = await run(reply({ tools: [{ id: "f1", name: "submit_proposal", input: { ops: [] } }] }), {}, failing);
  assert.equal(x.r.reason, "done"); assert.equal(x.r.requests, 2, "a failed submit goes back to the model");
  n = 0;
  x = await run(reply({ tools: [{ id: "g1", name: "submit_proposal", input: { ops: [] } }, { id: "g2", name: "submit_proposal", input: { ops: [] } }] }), {}, failing);
  assert.equal(x.r.reason, "done"); assert.equal(x.r.requests, 2, "one of two submits failed: continue");
  x = await run(reply({ tools: [{ id: "h1", name: "submit_proposal", input: { ops: [] } }, { id: "h2", name: "submit_proposal", input: { ops: [] } }] }));
  assert.equal(x.r.reason, "submitted"); assert.equal(x.r.requests, 1, "two accepted submits: end");
  assert.deepEqual(x.s.record.heldToolResults.map((b) => b.tool_use_id), ["h1", "h2"]);
  assert.equal(x.r.proposal.proposalId, "p2", "the later submit is the pending proposal");
  x = await run(reply({ tools: [{ id: "o1", name: "submit_proposal", input: { ops: [] } }] }), { endTurnOnSubmit: false });
  assert.equal(x.r.reason, "done"); assert.equal(x.r.requests, 2, "setting off: the old extra request");
  assert.equal(x.r.text, "after");
  assertValidHistory(x.s.messages);
});

await test("W3-14 / D-9: a submit with dryRun:true is a check: no pending proposal, the turn goes on, failed dry runs do not hit the invalid caps", async () => {
  const run = async (first, pack = proposalPack(), settings = {}) => {
    const fetchImpl = fakeModel([first, reply({ text: "after" })]);
    const { deps } = makeDeps({ pack, fetchImpl, settings });
    const s = await createHarness(deps).openSession(ACTOR);
    return { r: await s.send("go"), s };
  };
  let x = await run(reply({ tools: [{ id: "d1", name: "submit_proposal", input: { ops: [], dryRun: true } }] }));
  assert.equal(x.r.reason, "done"); assert.equal(x.r.requests, 2, "a dry run never ends the turn");
  assert.equal(x.r.proposal, null); assert.equal(x.s.record.pendingProposal ?? null, null);
  assert.equal(x.s.record.heldToolResults, null);
  assertValidHistory(x.s.messages);
  // the result flag alone is enough too (a pack that marks its dry runs)
  const marked = makePack({ sheet: makeSheet(), runTool: async () => ({ ok: true, dryRun: true, summary: "s" }) });
  x = await run(reply({ tools: [{ id: "d2", name: "submit_proposal", input: { ops: [] } }] }), marked);
  assert.equal(x.r.reason, "done"); assert.equal(x.r.proposal, null);
  // failed dry runs do not count as invalid submits (cap 1 would stop at the first failed real submit)
  const failingDry = makePack({ sheet: makeSheet(), runTool: async () => ({ ok: false, dryRun: true, errors: [{ code: "e", message: "bad" }] }) });
  x = await run(reply({ tools: [{ id: "d3", name: "submit_proposal", input: { ops: [], dryRun: true } }] }), failingDry, { maxInvalidSubmits: 1 });
  assert.equal(x.r.reason, "done"); assert.equal(x.r.cap ?? null, null);
  const failingReal = makePack({ sheet: makeSheet(), runTool: async () => ({ ok: false, errors: [{ code: "e", message: "bad" }] }) });
  x = await run(reply({ tools: [{ id: "d3b", name: "submit_proposal", input: { ops: [] } }] }), failingReal, { maxInvalidSubmits: 1 });
  assert.equal(x.r.cap, "invalidSubmits", "control: the same failure as a real submit hits the cap");
  // dry run + accepted real submit in one batch: the real one is pending, the batch is not "only submits" -> continue
  x = await run(reply({ tools: [{ id: "d4", name: "submit_proposal", input: { ops: [], dryRun: true } }, { id: "d5", name: "submit_proposal", input: { ops: [] } }] }));
  assert.equal(x.r.reason, "done"); assert.equal(x.r.requests, 2);
  assert.equal(x.s.record.pendingProposal.toolUseId, "d5");
});

await test("W3-4 held results: a new conversation drops them; Stop / cap on the next message keeps the history valid", async () => {
  const fetchImpl = fakeModel((i) => (i === 0 ? reply({ tools: [{ id: "n1", name: "submit_proposal", input: { ops: [] } }] }) : { hang: true }));
  const { deps } = makeDeps({ pack: proposalPack(), fetchImpl, settings: { wallClockMs: 100 } });
  const s = await createHarness(deps).openSession(ACTOR);
  assert.equal((await s.send("build")).reason, "submitted");
  const r = await s.send("next");                                  // request hangs -> wall cap; B4: no answer -> nothing appended
  assert.equal(r.cap, "wall");
  assert.equal(r.unsent, "next");
  assert.equal(s.record.heldToolResults.length, 1, "B4: held results wait for the next message that gets an answer");
  assert.equal(s.messages.at(-1).role, "assistant");
  assert.equal(fetchImpl.calls[1].body.messages.at(-1).content[0].tool_use_id, "n1", "the request carried the held result");
  assertValidHistory([...s.messages, fetchImpl.calls[1].body.messages.at(-1)]);
  // a fresh submit, then a new conversation: nothing carried over
  const f2 = fakeModel([reply({ tools: [{ id: "n2", name: "submit_proposal", input: { ops: [] } }] }), reply({ text: "fresh" })]);
  const d2 = makeDeps({ pack: proposalPack(), fetchImpl: f2 });
  const s2 = await createHarness(d2.deps).openSession(ACTOR2);
  await s2.send("build");
  assert.equal(s2.record.heldToolResults.length, 1);
  await s2.newConversation();
  assert.equal(s2.record.heldToolResults, null);
  await s2.send("hello");
  assert.deepEqual(f2.calls[1].body.messages.map((m) => m.role), ["user"]);
  assert.ok(!f2.calls[1].body.messages[0].content.some((b) => b.type === "tool_result"));
});

await test("W3-5 text = last assistant message only; progress = texts before tool calls; cap after tools -> text empty", async () => {
  const fetchImpl = fakeModel([
    reply({ text: "Let me look.", tools: [{ id: "x1", name: "search_catalog", input: { query: "a" } }] }),
    reply({ text: "One more.", tools: [{ id: "x2", name: "search_catalog", input: { query: "b" } }] }),
    reply({ text: "Final answer." })
  ]);
  const { deps } = makeDeps({ pack: makePack(), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const r = await s.send("look");
  assert.equal(r.text, "Final answer.");
  assert.deepEqual(r.progress, ["Let me look.", "One more."]);
  assert.deepEqual(s.transcript().filter((x) => x.role === "ai" || x.role === "progress").map((x) => [x.role, x.text]),
    [["progress", "Let me look."], ["progress", "One more."], ["ai", "Final answer."]]);
  const f2 = fakeModel(() => reply({ text: "Still looking.", tools: [{ id: `y${msgSeq + 1}`, name: "search_catalog", input: { query: "q" } }] }));
  const d2 = makeDeps({ pack: makePack(), fetchImpl: f2, settings: { maxRequests: 2 } });
  const r2 = await (await createHarness(d2.deps).openSession(ACTOR2)).send("loop");
  assert.equal(r2.cap, "requests");
  assert.equal(r2.text, "");
  assert.deepEqual(r2.progress, ["Still looking.", "Still looking."]);
});

// ------------------------------------------------------------------------------------------- W5-B-1 fix round
const FIX_W = { code: "talent.occ.list", message: "The occupation talent is not on the list.", hint: "Pick the occupation talent from that list." };
const QUIET_W = { code: "team.empty", message: "solo", hint: "Nothing to fix (a solo hero)." };
/** submit results in order: warnings per call (an entry of `false` = a refused submit) */
function warnPack(perCall, extra = {}) {
  let n = 0;
  return makePack({ sheet: makeSheet(), extra, runTool: async (name) => {
    if (name !== "submit_proposal") return { ok: true };
    const w = perCall[Math.min(n, perCall.length - 1)]; n++;
    return w === false ? { ok: false, errors: [{ code: "attr.over", message: "too many" }] } : { ok: true, proposalId: `p${n}`, summary: "s", warnings: w, info: [{ code: "rank.defaulted", message: "default", hint: "Nothing to do." }] };
  } });
}
const sub = (id) => reply({ tools: [{ id, name: "submit_proposal", input: { ops: [{ opId: id }] } }] });

await test("W5-B-1 fix round: no actionable warning -> the turn ends on the submit; quiet / 'nothing to fix' / info never count", async () => {
  for (const w of [[], [QUIET_W], [{ code: "x", message: "m", hint: "" }]]) {
    const fetchImpl = fakeModel([sub("a1"), reply({ text: "never" })]);
    const { deps } = makeDeps({ pack: warnPack([w]), fetchImpl });
    const s = await createHarness(deps).openSession(ACTOR);
    const r = await s.send("build");
    assert.equal(r.reason, "submitted"); assert.equal(r.requests, 1); assert.equal(fetchImpl.calls.length, 1); assert.equal(r.fixRound, undefined);
    assert.deepEqual(s.record.heldToolResults.map((b) => b.tool_use_id), ["a1"]);
  }
});

await test("W5-B-1 fix round: an actionable warning -> ONE more request with the result; the fix submit ends the turn even with warnings; history valid", async () => {
  const fetchImpl = fakeModel([sub("b1"), sub("b2"), reply({ text: "never" })]);
  const { deps } = makeDeps({ pack: warnPack([[FIX_W], [FIX_W]]), fetchImpl });
  const s = await createHarness(deps).openSession(ACTOR);
  const rounds = [];
  s.on("fix-round", (x) => rounds.push(x));
  const r = await s.send("build");
  assert.equal(r.reason, "submitted"); assert.equal(r.ok, true); assert.equal(r.fixRound, true);
  assert.equal(r.requests, 2, "one extra request, no third"); assert.equal(fetchImpl.calls.length, 2); assert.equal(r.toolCalls, 2);
  assert.deepEqual(rounds, [{ ids: ["b1"] }]);
  // the second request saw the first submit's result (warning included) at once
  const seen = fetchImpl.calls[1].body.messages.at(-1);
  assert.equal(seen.role, "user"); assert.equal(seen.content[0].tool_use_id, "b1"); assert.match(seen.content[0].content, /talent\.occ\.list/);
  assert.equal(r.proposal.proposalId, "p2", "the fix submit is the pending proposal");
  assert.deepEqual(s.record.heldToolResults.map((b) => b.tool_use_id), ["b2"], "the fix submit's result waits for the next GM message");
  assertValidHistory(s.messages, { allowOpenTail: true });
  // the next GM message: held result first, then the turn goes on normally (a new fix round is possible per GM message)
  const f2 = fakeModel([reply({ text: "ok" })]);
  const s2 = await createHarness({ ...deps, fetchImpl: f2 }).openSession(ACTOR);
  const r2 = await s2.send("thanks");
  assert.equal(r2.reason, "done"); assertValidHistory(f2.calls[0].body.messages);
});

await test("W5-B-1 fix round: text-only answer ends 'done'; a refused fix submit still ends the turn (earlier proposal stays pending)", async () => {
  let fetchImpl = fakeModel([sub("c1"), reply({ text: "The warning is intended." })]);
  let { deps } = makeDeps({ pack: warnPack([[FIX_W]]), fetchImpl });
  let r = await (await createHarness(deps).openSession(ACTOR)).send("build");
  assert.equal(r.reason, "done"); assert.equal(r.text, "The warning is intended."); assert.equal(r.requests, 2); assert.equal(r.proposal.proposalId, "p1");
  fetchImpl = fakeModel([sub("c2"), sub("c3"), reply({ text: "never" })]);
  ({ deps } = makeDeps({ pack: warnPack([[FIX_W], false]), fetchImpl }));
  const s = await createHarness(deps).openSession(ACTOR2);
  r = await s.send("build");
  assert.equal(r.reason, "submitted"); assert.equal(r.requests, 2); assert.equal(fetchImpl.calls.length, 2);
  assert.equal(r.proposal.proposalId, "p1", "the refused fix leaves the accepted proposal pending");
  assert.deepEqual(s.record.heldToolResults.map((b) => b.tool_use_id), ["c3"]);
  assert.match(s.record.heldToolResults[0].content, /"ok":false/);
});

await test("W5-B-1 fix round: setting off unchanged; request cap reached -> no fix round; the pack's own rule wins over the generic one", async () => {
  // endTurnOnSubmit off: the old extra request (no fix-round flag)
  let fetchImpl = fakeModel([sub("d1"), reply({ text: "after" })]);
  let { deps } = makeDeps({ pack: warnPack([[FIX_W]]), fetchImpl, settings: { endTurnOnSubmit: false } });
  let r = await (await createHarness(deps).openSession(ACTOR)).send("build");
  assert.equal(r.reason, "done"); assert.equal(r.requests, 2); assert.equal(r.text, "after"); assert.equal(r.fixRound, undefined);
  // maxRequests 1: the submit ends the turn as before
  fetchImpl = fakeModel([sub("d2"), reply({ text: "never" })]);
  ({ deps } = makeDeps({ pack: warnPack([[FIX_W]]), fetchImpl, settings: { maxRequests: 1 } }));
  r = await (await createHarness(deps).openSession(ACTOR)).send("build");
  assert.equal(r.reason, "submitted"); assert.equal(r.requests, 1); assert.equal(r.fixRound, undefined);
  // maxToolCalls 1: no room for the fix submit -> ends
  fetchImpl = fakeModel([sub("d3"), reply({ text: "never" })]);
  ({ deps } = makeDeps({ pack: warnPack([[FIX_W]]), fetchImpl, settings: { maxToolCalls: 1 } }));
  r = await (await createHarness(deps).openSession(ACTOR)).send("build");
  assert.equal(r.reason, "submitted"); assert.equal(r.requests, 1);
  // pack.actionableWarnings decides: [] -> ends although the hint asks for a fix; ["x"] -> fix round although no hint
  fetchImpl = fakeModel([sub("d4"), reply({ text: "never" })]);
  ({ deps } = makeDeps({ pack: warnPack([[FIX_W]], { actionableWarnings: () => [] }), fetchImpl }));
  r = await (await createHarness(deps).openSession(ACTOR)).send("build");
  assert.equal(r.reason, "submitted"); assert.equal(r.requests, 1);
  fetchImpl = fakeModel([sub("d5"), reply({ text: "fixed nothing" })]);
  ({ deps } = makeDeps({ pack: warnPack([[QUIET_W]], { actionableWarnings: (n, res) => res.warnings }), fetchImpl }));
  r = await (await createHarness(deps).openSession(ACTOR)).send("build");
  assert.equal(r.requests, 2); assert.equal(r.fixRound, true);
  // a dry run with warnings is never a fix round trigger
  fetchImpl = fakeModel([reply({ tools: [{ id: "d6", name: "submit_proposal", input: { ops: [], dryRun: true } }] }), reply({ text: "priced" })]);
  ({ deps } = makeDeps({ pack: makePack({ sheet: makeSheet(), runTool: async () => ({ ok: true, dryRun: true, warnings: [FIX_W] }) }), fetchImpl }));
  r = await (await createHarness(deps).openSession(ACTOR)).send("price it");
  assert.equal(r.reason, "done"); assert.equal(r.fixRound, undefined);
});

// =========================================================================================== bughunt-1 fixes

const rolesOf = (msgs) => msgs.map((m) => m.role + (Array.isArray(m.content) && !m.content.length ? "(EMPTY)" : "")).join(",");
const noSleepTr = { streamMessage: (req, o) => import("../scripts/anthropic/index.mjs").then((a) => a.streamMessage(req, { ...o, sleep: async () => {} })) };

await test("B2 bughunt-1: an empty answer (end_turn, content []) is never appended; turn 'done' + emptyReply; next request valid", async () => {
  const emptyMsg = { chunks: [start(), mDelta("end_turn", 3), mStop()] };
  const thinkOnly = reply({ thinking: "x", text: "" });
  const f = fakeModel([reply({ tools: [{ id: "tu1", name: "submit_proposal", input: { ops: [{ opId: "a" }] } }], thinking: "" }), emptyMsg, reply({ text: "ok" }), thinkOnly, reply({ text: "fine" })]);
  const { deps } = makeDeps({ pack: makePack({ sheet: makeSheet() }), fetchImpl: f, settings: { endTurnOnSubmit: false } });
  const s = await createHarness(deps).openSession(ACTOR);
  const r1 = await s.send("Zbuduj bohatera");
  assert.equal(r1.ok, true); assert.equal(r1.reason, "done"); assert.equal(r1.emptyReply, true); assert.equal(r1.text, "");
  assert.equal(r1.proposal.proposalId, "p-1");
  assert.deepEqual(rolesOf(s.messages).split(","), ["user", "assistant", "user"], "no empty assistant message");
  await s.send("Thanks, now change the note");
  assert.equal(rolesOf(f.calls[2].body.messages), "user,assistant,user,user", "the GM message follows the tool results (API merges)");
  // first answer of a GM message empty (only thinking): the GM message is still history, nothing else
  const r3 = await s.send("once more");
  assert.equal(r3.emptyReply, true); assert.equal(r3.unsent, undefined);
  assert.equal(s.messages.at(-1).role, "user");
  assert.ok(allText(s.messages.at(-1)).includes("once more"));
  assert.ok(!s.messages.some((m) => m.role === "assistant" && isEmptyAnswer(m.content)));
  assert.equal(isEmptyAnswer([]), true); assert.equal(isEmptyAnswer([{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: " \n" }]), true);
  assert.equal(isEmptyAnswer([{ type: "text", text: "a" }]), false); assert.equal(isEmptyAnswer([{ type: "tool_use", id: "x", name: "n", input: {} }]), false);
});

await test("B3 bughunt-1: after a mid-answer fallback only the tool_use kept in the history runs; no orphan tool_result", async () => {
  const tool = (i, id, name, input) => [bStart(i, { type: "tool_use", id, name, input: {} }), bDelta(i, { type: "input_json_delta", partial_json: JSON.stringify(input) }), bStop(i)];
  const fb = { chunks: [start(), ...tool(0, "tu1", "search_catalog", { query: "x" }),
    bStart(1, { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } }), bStop(1),
    ...tool(2, "tu2", "get_entries", { refs: ["powers:abc"] }), mDelta("tool_use"), mStop()] };
  const f = fakeModel([fb, reply({ text: "done" })]);
  const ran = [];
  const { deps } = makeDeps({ pack: makePack({ sheet: makeSheet(), runTool: async (name) => { ran.push(name); return { ok: true }; } }), fetchImpl: f });
  const s = await createHarness(deps).openSession(ACTOR);
  assert.equal((await s.send("build")).reason, "done");
  assert.deepEqual(ran, ["get_entries"]);
  const b = f.calls[1].body;
  assert.deepEqual(b.messages[1].content.filter((x) => x.type === "tool_use").map((x) => x.id), ["tu2"]);
  assert.deepEqual(b.messages[2].content.filter((x) => x.type === "tool_result").map((x) => x.tool_use_id), ["tu2"]);
  assertValidHistory(s.messages);
});

await test("B4 bughunt-1: refusal / 529 / cost cap / module limit before any answer append nothing; re-send not doubled; held + marker + sheet kept", async () => {
  // refusal: the refused text never reaches a later request
  const refusal = reply({ text: "I can not", stop: "refusal" });
  const f = fakeModel([refusal, reply({ text: "ok" })]);
  const { deps } = makeDeps({ pack: makePack({ sheet: makeSheet() }), fetchImpl: f });
  const s = await createHarness(deps).openSession(ACTOR);
  const a = await s.send("REFUSED-REQUEST-TEXT");
  assert.equal(a.reason, "refusal"); assert.equal(a.unsent, "REFUSED-REQUEST-TEXT");
  assert.equal(s.messages.length, 0);
  const tr = s.transcript();
  assert.deepEqual(tr.filter((x) => x.role === "gm").map((x) => [x.text, x.unsent]), [["REFUSED-REQUEST-TEXT", true]], "drawer still shows the unsent text");
  assert.ok(tr.findIndex((x) => x.role === "gm") < tr.findIndex((x) => x.role === "notice" && x.code === "stop.refusal"), "unsent text before its notice");
  await s.send("Unrelated new request");
  assert.equal(rolesOf(f.calls[1].body.messages), "user");
  assert.ok(!JSON.stringify(f.calls[1].body.messages).includes("REFUSED-REQUEST-TEXT"));
  assert.match(f.calls[1].body.messages[0].content[0].text, /^<sheet /, "the sheet block was not consumed by the refused send: full block again");
  // 529 after retries, the GM sends the same text again: once in the request
  const over = { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
  const f4 = fakeModel([over, over, over, reply({ text: "ok" })]);
  const d4 = makeDeps({ pack: makePack({ sheet: makeSheet() }), fetchImpl: f4, transport: noSleepTr });
  const s4 = await createHarness(d4.deps).openSession(ACTOR);
  const e1 = await s4.send("Build Atom Eve");
  assert.equal(e1.reason, "error"); assert.equal(e1.unsent, "Build Atom Eve"); assert.equal(s4.messages.length, 0);
  await s4.send("Build Atom Eve");
  assert.equal(rolesOf(f4.calls.at(-1).body.messages), "user");
  assert.equal((JSON.stringify(f4.calls.at(-1).body.messages).match(/Build Atom Eve/g) ?? []).length, 1);
  assert.deepEqual(rolesOf(s4.messages).split(","), ["user", "assistant"]);
  // cost cap / module limit: nothing stored, however often the GM tries
  const f3 = fakeModel([reply({ text: "ok" })]);
  const d3 = makeDeps({ pack: makePack({ sheet: makeSheet() }), fetchImpl: f3, settings: { maxCostPerMessage: 0.0001 } });
  const s3 = await createHarness(d3.deps).openSession(ACTOR);
  for (const x of ["try 1", "try 2", "try 3"]) assert.equal((await s3.send(x)).cap, "cost");
  assert.equal(f3.calls.length, 0); assert.equal(s3.messages.length, 0);
  const capN = s3.record.timeline.filter((x) => x.type === "notice" && x.code === "cap.cost").at(-1);
  assert.ok(Number(capN.data.estimate) > 0, "the cost notice carries the estimate");
  const f5 = fakeModel([reply({ text: "ok" })]);
  const d5 = makeDeps({ pack: makePack(), fetchImpl: f5, limits: { reserve: () => { throw new Error("Daily limit $5 reached"); }, record: async () => {} } });
  const s5 = await createHarness(d5.deps).openSession(ACTOR);
  await s5.send("a"); await s5.send("b");
  assert.equal(f5.calls.length, 0); assert.equal(s5.messages.length, 0);
  // held results and the proposal marker wait for a message that gets an answer
  const f6 = fakeModel([reply({ tools: [{ id: "h1", name: "submit_proposal", input: { ops: [] } }] }), refusal, reply({ text: "fine" })]);
  const d6 = makeDeps({ pack: proposalPack(), fetchImpl: f6 });
  const s6 = await createHarness(d6.deps).openSession(ACTOR);
  assert.equal((await s6.send("build")).reason, "submitted");
  assert.equal((await s6.send("bad")).reason, "refusal");
  assert.equal(s6.record.heldToolResults.length, 1);
  assert.equal(s6.record.proposalStates[0].reported, null, "marker not reported yet");
  await s6.send("good");
  const um = f6.calls[2].body.messages.at(-1);
  assert.equal(um.content[0].tool_use_id, "h1");
  assert.deepEqual(markersOf(um), ['<proposal id="p1" status="pending"/>']);
  assert.equal(s6.record.heldToolResults, null);
  assertValidHistory(s6.messages);
});

await test("B4 bughunt-1: while the first request runs the GM text shows as pending; after the answer it is history", async () => {
  let s;
  let seen = null;
  const f = fakeModel(() => { seen = s.transcript().filter((x) => x.role === "gm"); return reply({ text: "hi" }); });
  const { deps } = makeDeps({ pack: makePack(), fetchImpl: f });
  s = await createHarness(deps).openSession(ACTOR);
  await s.send("hello");
  assert.deepEqual(seen.map((x) => [x.text, !!x.pending]), [["hello", true]]);
  assert.deepEqual(s.transcript().filter((x) => x.role === "gm").map((x) => [x.text, !!x.pending, !!x.unsent]), [["hello", false, false]]);
});

await test("B5 bughunt-1: parallel openSession -> one Session; a refused save does not poison the chain; markProposal / send never reject", async () => {
  const f = fakeModel([reply({ text: "a" }), reply({ text: "b" })]);
  const { deps } = makeDeps({ pack: makePack({ sheet: makeSheet() }), fetchImpl: f });
  const h = createHarness(deps);
  const [s1, s2] = await Promise.all([h.openSession(ACTOR), h.openSession(ACTOR)]);
  assert.equal(s1, s2);
  assert.equal((await s1.send("one")).reason, "done");
  // a second harness (another conversation) takes the store key: this session's saves are refused
  const store = createSessionStore({ indexedDB: fakeIndexedDB() });
  const fx = fakeModel([reply({ text: "x" }), reply({ text: "y" }), reply({ text: "z" })]);
  const dA = makeDeps({ pack: makePack(), fetchImpl: fx, store });
  const sA = await createHarness(dA.deps).openSession(ACTOR);
  await sA.send("first");
  const sB = await createHarness(makeDeps({ pack: makePack(), fetchImpl: fx, store }).deps).openSession(ACTOR);
  await sB.newConversation();
  const r = await sA.send("second");                                    // its save is refused: error result, no rejection
  assert.equal(r.reason, "error"); assert.equal(r.error.kind, "history-edit");
  await assert.rejects(sA.setOptions({ rank: "teen" }), (e) => e.code === "history-edit");
  const mp = await sA.markProposal("x", "pending");                    // never rejects
  assert.equal(mp.ok, false);
  // the chain is not poisoned: a save that is allowed again goes through
  const store2 = { saves: 0, fail: true, async load() { return null; }, async save() { this.saves++; if (this.fail) { this.fail = false; const e = new Error("refused"); e.code = "history-edit"; throw e; } } };
  const sC = await createHarness(makeDeps({ pack: makePack(), fetchImpl: fx, store: store2 }).deps).openSession(ACTOR2);
  await assert.rejects(sC.setOptions({ a: 1 }));
  assert.deepEqual(await sC.setOptions({ b: 2 }), { a: 1, b: 2 }, "the next save resolves");
  // markProposal after a successful Apply: the save fails, the state is still applied (card not pending)
  const f7 = fakeModel([reply({ tools: [{ id: "q1", name: "submit_proposal", input: { ops: [] } }] })]);
  const store3 = { failNext: false, async load() { return null; }, async save() { if (this.failNext) { this.failNext = false; const e = new Error("refused"); e.code = "history-edit"; throw e; } } };
  const s7 = await createHarness(makeDeps({ pack: proposalPack(), fetchImpl: f7, store: store3 }).deps).openSession(ACTOR);
  await s7.send("build");
  store3.failNext = true;
  const m7 = await s7.markProposal("p1", "applied", { runId: "run-1" });
  assert.deepEqual([m7.ok, m7.saved], [true, false]);
  assert.equal(s7.pendingProposal, null); assert.equal(s7.record.lastRunId, "run-1");
  assert.equal(s7.proposals[0].status, "applied");
});

await test("B6 bughunt-1: a transport retry re-emits request-start (retry: true) so a live view drops the failed attempt's text", async () => {
  const over = { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
  const f = fakeModel([over, reply({ text: "ok" })]);
  const { deps } = makeDeps({ pack: makePack(), fetchImpl: f, transport: noSleepTr });
  const s = await createHarness(deps).openSession(ACTOR);
  const starts = [];
  s.on("request-start", (d) => starts.push(d));
  assert.equal((await s.send("x")).reason, "done");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].retry, undefined);
  assert.deepEqual([starts[1].request, starts[1].retry, starts[1].attempt], [1, true, 2]);
});

await test("B8 bughunt-1: estimate prices a cold prefix / expired history at write rates, a warm one at the read rate", async () => {
  let clock = 1_000_000_000;
  const warm = new Map();
  const f = fakeModel(() => reply({ text: "ok" }));
  const ests = [];
  const { deps } = makeDeps({ pack: makePack({ catalogIndex: "CATALOG INDEX LINE\n".repeat(3000) }), fetchImpl: f, now: () => clock, warmMap: warm });
  const s = await createHarness(deps).openSession(ACTOR);
  s.on("request-start", (d) => ests.push(d.estimateUsd));
  await s.send("first");                      // cold prefix
  clock += 60_000;
  await s.send("second");                     // prefix + history warm
  clock += 3 * 3600_000;
  await s.send("third");                      // both expired
  assert.ok(ests[0] > ests[1] * 2, `cold ${ests[0]} vs warm ${ests[1]}`);
  assert.ok(ests[2] > ests[1] * 2, `expired ${ests[2]} vs warm ${ests[1]}`);
  // a pre-warmed prefix makes the first message of a conversation cheap
  clock += 1000;
  await s.prewarm({ force: true });
  const s2 = await createHarness(deps).openSession(ACTOR2);
  const e2 = [];
  s2.on("request-start", (d) => e2.push(d.estimateUsd));
  await s2.send("first of another actor");
  assert.ok(e2[0] < ests[0] / 2, `warm first ${e2[0]} vs cold first ${ests[0]}`);
});

await test("B9 bughunt-1: 'Not run' names the reason of the turn that left the tools open, not a later turn's", async () => {
  const f = fakeModel([reply({ tools: [{ id: "o1", name: "search_catalog", input: { query: "q" } }], stop: "max_tokens" }), reply({ text: "x", stop: "refusal" }), reply({ text: "ok" })]);
  const { deps } = makeDeps({ pack: makePack(), fetchImpl: f });
  const s = await createHarness(deps).openSession(ACTOR);
  assert.equal((await s.send("a")).reason, "max_tokens");
  assert.equal((await s.send("b")).reason, "refusal");
  await s.send("c");
  assert.match(f.calls[1].body.messages.at(-1).content[0].content, /stopped \(max_tokens\)/);
  assert.match(f.calls[2].body.messages.at(-1).content[0].content, /stopped \(max_tokens\)/);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
