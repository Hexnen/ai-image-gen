// Tests of the dry transport (scripts/build/dry-transport.mjs) + relay / driver (dev/dry-run/). Node, no Foundry, no
// network beyond 127.0.0.1, no key. The real harness, real transport and the stub pack run end to end; a scripted
// "stand-in" answers through the driver CLI. Run from the module folder: node dev/test-dry-transport.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dryConfig, dryWiring, createDryFetch, createUsageSim, normalizeAnswer, answerToSse, DRY_STORAGE_KEY, DRY_API_KEY, DRY_PROVIDER } from "../scripts/build/dry-transport.mjs";
import { createHarness } from "../scripts/build/harness.mjs";
import { createSessionStore } from "../scripts/build/session-store.mjs";
import { buildMessagesRequest, streamMessage, ANTHROPIC_URL } from "../scripts/anthropic/index.mjs";
import { makeStubPack } from "../scripts/systems/_stub/pack.mjs";
import { checkDir, checkAnswer, schemaErrors, dirs, pendingIds, listIds, readJson, reqPath } from "./dry-run/queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = (o) => ({ getItem: (k) => (k in o ? o[k] : null) });
const TOKEN = "abcdefghijklmnop1234";
const goodCfg = JSON.stringify({ relay: "http://127.0.0.1:47123", token: TOKEN });
const lane = { hostname: "localhost", port: "30008", protocol: "http:" };

// ------------------------------------------------------------------------------------------- guards

await test("dryConfig: off by default, GM only, lane ports only, never :30000", () => {
  assert.equal(dryConfig({ location: lane, storage: store({}), isGM: true }).reason, "off");
  assert.equal(dryConfig({ location: lane, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: false }).reason, "not-gm");
  assert.equal(dryConfig({ location: { ...lane, port: "30000" }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: true }).reason, "not-lane");
  assert.equal(dryConfig({ location: { ...lane, port: "" }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: true }).reason, "not-lane");
  assert.equal(dryConfig({ location: { ...lane, port: "30010" }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: true }).reason, "not-lane");
  assert.equal(dryConfig({ location: { ...lane, hostname: "foundry.example.org" }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: true }).reason, "not-local");
  assert.equal(dryConfig({ location: { ...lane, hostname: "192.168.1.5" }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: true }).reason, "not-local");
  for (const p of ["30001", "30005", "30008", "30020"]) assert.equal(dryConfig({ location: { ...lane, hostname: "127.0.0.38", port: p }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), isGM: true }).on, true, p);
  const bad = (cfg) => dryConfig({ location: lane, storage: store({ [DRY_STORAGE_KEY]: cfg }), isGM: true }).reason;
  assert.equal(bad("{not json"), "bad-config");
  assert.equal(bad(JSON.stringify({ relay: "https://api.anthropic.com", token: TOKEN })), "bad-relay");
  assert.equal(bad(JSON.stringify({ relay: "http://example.com:47123", token: TOKEN })), "bad-relay");
  assert.equal(bad(JSON.stringify({ relay: "http://127.0.0.1:30000", token: TOKEN })), "bad-relay");
  assert.equal(bad(JSON.stringify({ relay: "http://127.0.0.1:30008", token: TOKEN })), "bad-relay");
  assert.equal(bad(JSON.stringify({ relay: "http://127.0.0.1", token: TOKEN })), "bad-relay");
  assert.equal(bad(JSON.stringify({ relay: "http://127.0.0.1:47123", token: "short" })), "bad-token");
  const ok = dryConfig({ location: lane, storage: store({ [DRY_STORAGE_KEY]: JSON.stringify({ relay: "http://127.0.0.1:47123/x", token: TOKEN, wallMinutes: 9999 }) }), isGM: true });
  assert.equal(ok.config.relay, "http://127.0.0.1:47123");
  assert.equal(ok.config.wallMinutes, 240);
});

await test("dryWiring: null (real path unchanged) unless on; on = placeholder key, dry fetch, longer clocks, dry provider label", () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(dryWiring({ game: { user: { isGM: true } }, location: lane, storage: store({}) }), null);
    assert.equal(dryWiring({ game: { user: { isGM: true } }, location: { ...lane, port: "30000" }, storage: store({ [DRY_STORAGE_KEY]: goodCfg }) }), null);
    assert.equal(dryWiring({ game: { user: { isGM: false } }, location: lane, storage: store({ [DRY_STORAGE_KEY]: goodCfg }) }), null);
    const w = dryWiring({ game: { user: { isGM: true } }, location: lane, storage: store({ [DRY_STORAGE_KEY]: goodCfg }), relayFetch: async () => { throw new Error("no"); } });
    assert.equal(w.apiKey, DRY_API_KEY);
    assert.equal(typeof w.fetchImpl, "function");
    assert.equal(w.settings({ wallClockMs: 300000, maxRequests: 12 }).wallClockMs, 60 * 60000);
    assert.equal(w.settings({ wallClockMs: 300000, maxRequests: 12 }).maxRequests, 12);
    assert.equal(w.log({ kind: "build", provider: "anthropic" }).provider, DRY_PROVIDER);
    assert.equal(JSON.stringify(w.config).includes(TOKEN), false, "token not exposed on api.build.dry");
  } finally { console.warn = warn; }
});

await test("dry fetch refuses any other URL and any non-placeholder key; never calls the relay for them", async () => {
  let calls = 0;
  const f = createDryFetch({ relay: "http://127.0.0.1:1", token: TOKEN, relayFetch: async () => { calls++; throw new Error("x"); } });
  await assert.rejects(f("https://api.openai.com/v1/x", { headers: { "x-api-key": DRY_API_KEY }, body: "{}" }), /not the Anthropic/);
  await assert.rejects(f(ANTHROPIC_URL, { headers: { "x-api-key": "sk-ant-real-looking-0000000000" }, body: "{}" }), /placeholder key/);
  await assert.rejects(f(ANTHROPIC_URL, { headers: {}, body: "{}" }), /placeholder key/);
  assert.equal(calls, 0);
});

await test("normalizeAnswer / answerToSse: shapes, inferred stop, rejected blocks", () => {
  assert.equal(normalizeAnswer({ content: [{ type: "text", text: "hi" }] }).stop_reason, "end_turn");
  assert.equal(normalizeAnswer({ content: [{ type: "tool_use", id: "a", name: "x", input: {} }] }).stop_reason, "tool_use");
  assert.throws(() => normalizeAnswer({ content: [{ type: "thinking", thinking: "x" }] }), /only text and tool_use/);
  assert.throws(() => normalizeAnswer({ content: [] }), /empty/);
  assert.throws(() => normalizeAnswer({ content: [{ type: "tool_use", id: "a", name: "x", input: {} }], stop_reason: "end_turn" }), /need stop_reason/);
  const s = answerToSse(normalizeAnswer({ content: [{ type: "text", text: "hello world, long enough" }] }), { model: "m", usage: { input_tokens: 1, output_tokens: 5 }, id: "msg_1" });
  assert.match(s, /event: message_start/); assert.match(s, /text_delta/); assert.match(s, /event: message_stop/);
});

await test("usage simulation: first request writes the prefix (1 h), the next reads it and writes only the new tail", () => {
  const sim = createUsageSim();
  const mk = (messages) => buildMessagesRequest({ apiKey: DRY_API_KEY, tools: makeStubPack().tools(), system: { rules: "R".repeat(3500), digest: "D".repeat(350), catalog: "C" }, messages }).body;
  const m1 = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const u1 = sim.usage(mk(m1), [{ type: "text", text: "x" }]);
  assert.ok(u1.cache_creation.ephemeral_1h_input_tokens > 1000);
  assert.equal(u1.cache_read_input_tokens, 0);
  const m2 = [...m1, { role: "assistant", content: [{ type: "text", text: "a".repeat(700) }] }, { role: "user", content: [{ type: "text", text: "more" }] }];
  const u2 = sim.usage(mk(m2), [{ type: "text", text: "y" }]);
  assert.equal(u2.cache_creation.ephemeral_1h_input_tokens, 0);
  assert.ok(u2.cache_read_input_tokens > u1.cache_creation.ephemeral_1h_input_tokens);
  assert.ok(u2.cache_creation.ephemeral_5m_input_tokens >= 200 && u2.cache_creation.ephemeral_5m_input_tokens < 260);
});

await test("checkDir refuses the repo and Foundry folders; accepts a temp folder", () => {
  assert.throws(() => checkDir(path.join(ROOT, "dev", "x")), /inside the module repo/);
  assert.throws(() => checkDir(ROOT), /inside the module repo/);
  assert.throws(() => checkDir("C:\\Users\\x\\AppData\\Local\\FoundryVTT-8\\Data\\worlds\\invincible"), /Foundry folder/);
  assert.throws(() => checkDir(""), /no dry-run folder/);
  assert.ok(checkDir(path.join(os.tmpdir(), "dry-x")));
});

await test("checkAnswer: unknown tool, schema errors, duplicate ids, id filling", () => {
  const body = { tools: makeStubPack().tools(), messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "search_catalog", input: { query: "a" } }] }] };
  const rec = { id: "0003", body };
  assert.deepEqual(checkAnswer({ content: [{ type: "tool_use", name: "nope", input: {} }] }, rec).ok, false);
  const e1 = checkAnswer({ content: [{ type: "tool_use", name: "search_catalog", input: { q: 1 } }] }, rec);
  assert.equal(e1.ok, false);
  assert.ok(e1.errors.some((e) => /query: required/.test(e)) && e1.errors.some((e) => /q: not allowed/.test(e)));
  assert.equal(checkAnswer({ content: [{ type: "tool_use", id: "toolu_old", name: "search_catalog", input: { query: "b" } }] }, rec).ok, false);
  const ok = checkAnswer({ content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "search_catalog", input: { query: "flight" } }] }, rec);
  assert.equal(ok.ok, true);
  assert.equal(ok.answer.content[1].id, "toolu_dry_0003_1");
  assert.deepEqual(schemaErrors({ type: "array", items: { type: "integer", minimum: 0 }, maxItems: 2 }, [1, -1, 3]), ["input: more than 2 items", "input[1]: below 0"]);
  assert.equal(checkAnswer({ content: [{ type: "text", text: "  " }] }, rec).ok, false);
});

// ------------------------------------------------------------------------------------------- live relay + driver CLI

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maig-dry-test-"));
const relay = spawn(process.execPath, [path.join(HERE, "dry-run", "relay.mjs"), "--dir", tmp], { stdio: ["ignore", "pipe", "pipe"] });
let relayOut = "";
relay.stdout.on("data", (c) => { relayOut += c; });
relay.stderr.on("data", (c) => { relayOut += c; });
for (let i = 0; i < 100 && !fs.existsSync(path.join(tmp, "relay.json")); i++) await sleep(50);
const R = readJson(path.join(tmp, "relay.json"));
const RELAY = `http://127.0.0.1:${R.port}`;
const D = dirs(tmp);
const driver = (...a) => execFileSync(process.execPath, [path.join(HERE, "dry-run", "driver.mjs"), "--dir", tmp, ...a], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const driverFails = (...a) => { try { driver(...a); return null; } catch (e) { return String(e.stderr ?? e.message); } };
const answerFile = (name, obj) => { const p = path.join(tmp, `${name}.json`); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
async function waitPending(n = 1, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) { const p = pendingIds(D); if (p.length >= n) return p; if (Date.now() > until) throw new Error("no pending request"); await sleep(30); }
}

await test("relay: token required, owner origin (:30000) and foreign origins refused, lane origin gets CORS", async () => {
  assert.equal((await fetch(`${RELAY}/health?token=wrong`)).status, 401);
  assert.equal((await fetch(`${RELAY}/health?token=${R.token}`, { headers: { origin: "http://localhost:30000" } })).status, 403);
  assert.equal((await fetch(`${RELAY}/health?token=${R.token}`, { headers: { origin: "http://evil.example" } })).status, 403);
  const r = await fetch(`${RELAY}/health?token=${R.token}`, { headers: { origin: "http://localhost:30008" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:30008");
  const p = await fetch(`${RELAY}/requests`, { method: "POST", body: JSON.stringify({ token: "nope", body: { messages: [] } }) });
  assert.equal(p.status, 401);
});

function makeHarness({ pack = makeStubPack({ systemId: "invincible" }), extra = {} } = {}) {
  const wiring = dryWiring({ game: { user: { isGM: true } }, location: lane, storage: store({ [DRY_STORAGE_KEY]: JSON.stringify({ relay: RELAY, token: R.token }) }), relayFetch: fetch });
  const booked = [], logs = [];
  const h = createHarness({
    getPack: () => pack,
    getApiKey: () => wiring.apiKey,
    settings: () => wiring.settings({ maxRequests: 6 }),
    limits: { reserve: () => () => {}, record: async (usd) => { booked.push(usd); } },
    log: async (e) => { logs.push(wiring.log(e)); },
    store: createSessionStore({ indexedDB: null }),
    worldId: () => "lane-world",
    fetchImpl: wiring.fetchImpl, transport: wiring.transport,
    ...extra
  });
  return { h, booked, logs, wiring };
}

await test("end to end: real harness + real transport + stub pack, stand-in answers via the driver CLI (tool call, then end_turn)", async () => {
  const warn = console.warn; console.warn = () => {};
  const { h, booked, logs } = makeHarness();
  console.warn = warn;
  const doc = { uuid: "Actor.ZZAIGEN0001", name: "ZZ-AIGEN-dry", type: "superhero", documentName: "Actor" };
  const s = await h.openSession(doc);
  const events = [];
  s.on("*", (d, t) => events.push(t));
  const turn = s.send("Build me a flier");
  const [id1] = await waitPending(1);
  const rec1 = readJson(reqPath(D, id1));
  // the request is exactly what the real transport builds
  assert.equal(rec1.body.stream, true);
  assert.equal(rec1.body.model, "claude-sonnet-5-5");
  assert.equal(rec1.body.output_config.effort, "medium");
  assert.deepEqual(rec1.body.tools.map((t) => t.name), ["search_catalog"]);
  assert.match(rec1.body.messages[0].content[0].text, /^<sheet doc="Actor.ZZAIGEN0001"/);
  assert.equal(rec1.body.messages[0].content[1].text, "Build me a flier");
  assert.equal(JSON.stringify(rec1).includes(DRY_API_KEY), false, "the placeholder key is not even sent to the relay");
  const shown = driver("wait", "--timeout", "5");
  assert.match(shown, /NEW since your last answer/);
  assert.match(shown, /Build me a flier/);
  assert.match(driverFails("answer", id1, answerFile("bad", { content: [{ type: "tool_use", name: "search_catalog", input: { nope: 1 } }] })), /NOT accepted/);
  driver("answer", id1, answerFile("a1", { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", name: "search_catalog", input: { query: "flight" } }] }));
  const p2 = await waitPending(1);
  const rec2 = readJson(reqPath(D, p2[0]));
  const last = rec2.body.messages.at(-1);
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, `toolu_dry_${id1}_1`);
  assert.match(driver("show", p2[0], "new"), /tool_result for toolu_dry_0001_1 \(search_catalog\)/);
  driver("answer", p2[0], answerFile("a2", { content: [{ type: "text", text: "Nothing found in the stub; done." }] }));
  const sum = await turn;
  assert.equal(sum.ok, true, JSON.stringify(sum));
  assert.equal(sum.reason, "done");
  assert.equal(sum.requests, 2);
  assert.equal(sum.toolCalls, 1);
  assert.match(sum.text, /Let me look\.[\s\S]*done\./);
  assert.ok(sum.usd > 0 && sum.usage.cacheRead > 0, JSON.stringify(sum.usage));
  assert.equal(booked.length, 2);
  assert.ok(logs.length === 2 && logs.every((l) => l.provider === DRY_PROVIDER && l.kind === "build" && l.status === "ok"));
  assert.ok(events.includes("tool-start") && events.includes("assistant-message"));
  const tr = s.transcript();
  assert.ok(tr.some((x) => x.role === "tool" && x.name === "search_catalog" && x.status === "done"));
  driver("transcript");
  assert.match(fs.readFileSync(path.join(tmp, "transcript.md"), "utf8"), /## Request 0002[\s\S]*Nothing found/);
});

await test("Stop while the stand-in thinks: the page cancels the relay request; the driver refuses a late answer", async () => {
  const warn = console.warn; console.warn = () => {};
  const { h } = makeHarness();
  console.warn = warn;
  const s = await h.openSession({ uuid: "Actor.ZZAIGEN0002", name: "ZZ-AIGEN-stop", documentName: "Actor" });
  const turn = s.send("Something");
  const [id] = await waitPending(1);
  await sleep(100);
  s.stop();
  const sum = await turn;
  assert.equal(sum.reason, "stopped");
  for (let i = 0; i < 50 && !listIds(D).cancelled.has(id); i++) await sleep(50);
  assert.ok(listIds(D).cancelled.has(id), "cancel marker written");
  assert.match(driverFails("answer", id, answerFile("late", { content: [{ type: "text", text: "late" }] })), /cancelled/);
});

await test("pings keep a slow answer alive past the stall clock; a simulated mid-stream error surfaces as the real error kind", async () => {
  const wiring = createDryFetch({ relay: RELAY, token: R.token, relayFetch: fetch, pingMs: 100, pollMs: 50 });
  const req = buildMessagesRequest({ apiKey: DRY_API_KEY, tools: makeStubPack().tools(), system: { rules: "rules" }, messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }] });
  const p = streamMessage(req, { fetchImpl: wiring, idleTimeoutMs: 400, maxRetries: 0 });
  const [id] = await waitPending(1);
  await sleep(1200); // three stall windows
  driver("answer", id, answerFile("slow", { content: [{ type: "text", text: "made it" }] }));
  const r = await p;
  assert.equal(r.text, "made it");
  assert.equal(r.stop, "done");
  const p2 = streamMessage(req, { fetchImpl: wiring, maxRetries: 0 });
  const [id2] = await waitPending(1);
  driver("answer", id2, answerFile("err", { error: { type: "invalid_request_error", message: "simulated" } }));
  await assert.rejects(p2, (e) => e.kind === "request" && /simulated/.test(e.detail));
});

await test("pre-warm is answered locally (no relay request) and books simulated cache writes", async () => {
  const warn = console.warn; console.warn = () => {};
  const { h, booked } = makeHarness();
  console.warn = warn;
  const before = listIds(D).req.length;
  const s = await h.openSession({ uuid: "Actor.ZZAIGEN0003", name: "ZZ-AIGEN-warm", documentName: "Actor" });
  const r = await s.prewarm({ force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.usd > 0);
  assert.equal(booked.length, 1);
  assert.equal(listIds(D).req.length, before);
});

relay.kill();
await sleep(100);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
if (process.exitCode) console.log(relayOut);
