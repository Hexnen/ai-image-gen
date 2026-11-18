// W6-K: a paid batch result whose save failed must never be lost. Stubs only: fake Foundry (settings, FilePicker,
// documents), fake OpenAI fetch (GET batch, GET file content, DELETE file). No network, no API key, no generation.
// Run: node dev/test-batch-retry.mjs (from the module folder)
import assert from "node:assert/strict";

// ---------- fake Foundry ----------
const store = new Map();          // world settings "ns.key" -> value
const notes = [];                 // ui.notifications.error texts
globalThis.ui = { notifications: { error: (m) => { notes.push(String(m)); }, warn() {}, info() {} } };
globalThis.Hooks = { callAll() {}, on() {}, off() {} };
let rid = 0;
class DataField { constructor(o = {}) { Object.assign(this, o); } }
globalThis.foundry = {
  data: { fields: { DataField, StringField: DataField, NumberField: DataField, BooleanField: DataField, ObjectField: DataField, SchemaField: DataField, ArrayField: DataField } },
  utils: { randomID: () => `id${++rid}`, getRoute: (p) => `/${p}`, escapeHTML: (s) => s, deepClone: structuredClone },
  applications: { apps: { FilePicker: { implementation: null } } },
};
globalThis.game = {
  user: { id: "gm1", name: "Gamemaster", isGM: true, can: () => true },
  i18n: { has: () => false, format: (k) => k, localize: (k) => k },
  modules: new Map(),
  settings: {
    get: (ns, key) => (store.has(`${ns}.${key}`) ? structuredClone(store.get(`${ns}.${key}`)) : key === "optimizeImages" ? false : undefined),
    set: async (ns, key, v) => { store.set(`${ns}.${key}`, structuredClone(v)); return v; },
  },
};

// server: files on disk + the upload behaviour (mode)
const server = { files: new Map(), mode: "ok", uploads: 0, imageUploads: 0, inFlight: 0, maxInFlight: 0 };
const FP = {
  async createDirectory() { throw new Error("EEXIST: already exists"); },
  async browse() { return { files: [...server.files.keys()] }; },
  // Same contract as Foundry v14 FilePicker.upload: server error -> notification + false; thrown fetch -> {}
  async upload(source, dir, file) {
    server.uploads++;
    const isLog = dir.endsWith("_log");
    if (!isLog) server.imageUploads++;
    server.inFlight++; server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    server.inFlight--;
    if (server.mode === "session") { ui.notifications.error("User [] does not have permission to upload files."); return false; }
    if (server.mode === "network" && !isLog) return {};
    const path = `${dir}/${file.name}`;
    if (!isLog && server.files.has(path)) throw new Error(`collision on ${path}`);
    server.files.set(path, file.size);
    return { path, status: "success" };
  },
};
foundry.applications.apps.FilePicker.implementation = FP;

const docs = new Map();
const mkActor = (id) => {
  const d = { id, img: "start.webp", updates: 0, async update(p) { this.updates++; Object.assign(this, p); return this; } };
  docs.set(`Actor.${id}`, d);
  return d;
};
globalThis.fromUuid = async (u) => docs.get(u) ?? null;

// ---------- fake OpenAI ----------
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64");
const remote = new Map();   // remoteId -> {status, output_file_id}
const files = new Map();    // fileId -> jsonl text
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  calls.push(`${method} ${url}`);
  const u = String(url);
  let m;
  if (method === "GET" && (m = /\/v1\/batches\/([^/]+)$/.exec(u))) {
    const b = remote.get(m[1]);
    return b ? new Response(JSON.stringify({ id: m[1], ...b })) : new Response("{}", { status: 404 });
  }
  if (method === "GET" && (m = /\/v1\/files\/([^/]+)\/content$/.exec(u))) {
    return files.has(m[1]) ? new Response(files.get(m[1])) : new Response('{"error":{"message":"No such File"}}', { status: 404 });
  }
  if (method === "DELETE" && (m = /\/v1\/files\/([^/]+)$/.exec(u))) { files.delete(m[1]); return new Response("{}"); }
  if (u.includes("_log/")) return new Response("[]", { status: 404 });   // call-log month file: not there yet
  throw new Error(`unexpected fetch ${method} ${u}`);
};

const { MODULE_ID } = await import("../scripts/constants.mjs");
const { tuning, putBatch, getBatch } = await import("../scripts/batch/record.mjs");
const { ingestTuning, MAX_ATTEMPTS } = await import("../scripts/batch/ingest.mjs");
const { checkOpenAI } = await import("../scripts/batch/openai.mjs");
const { retryBatchSave, retryableItems } = await import("../scripts/batch/retry.mjs");
const { classifyUploadMessage, uploadOrThrow } = await import("../scripts/save-image.mjs");
const { readLog, flushLog } = await import("../scripts/call-log.mjs");
tuning.verifyMs = 0;

const KEY = "sk-test-not-real";
let n = 0;
/** One single-item batch for `actorId`, completed at the fake OpenAI with one image row. */
async function makeBatch(actorId, { cost = 0.009104, withRow = true } = {}) {
  const id = `b${++n}`;
  const remoteId = `batch_r${n}`;
  const out = `file-out-${n}`;
  const itemId = `item${n}`;
  remote.set(remoteId, { status: "completed", output_file_id: out });
  if (withRow) {
    files.set(out, JSON.stringify({ custom_id: itemId, response: { status_code: 200, body: {
      data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 662, output_tokens: 439, input_tokens_details: { image_tokens: 576, text_tokens: 86 } } } } }) + "\n");
  }
  files.set(`file-in-${n}`, "input");
  await putBatch({
    id, provider: "openai", model: "gpt-image-2.5-flare", status: "pending", createdAt: Date.now(), remoteId,
    endpoint: "/v1/images/edits", files: [`file-in-${n}`],
    items: [{ id: itemId, target: { uuid: `Actor.${actorId}`, field: "img" }, meta: { system: "invincible", docType: "Actor-superhero", name: "AI test", typeKey: "invincible.Actor.superhero" } }],
  });
  return { id, remoteId, out, itemId };
}
const usage = () => store.get(`${MODULE_ID}.usage`)?.dayCost ?? 0;
const generationCalls = () => calls.filter((c) => /POST .*\/(images|batches)(\/|$)/.test(c) || /POST .*\/files$/.test(c));

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

await test("classifyUploadMessage: empty user = session lost, named user = permission", () => {
  assert.equal(classifyUploadMessage("User [] does not have permission to upload files."), "session");
  assert.equal(classifyUploadMessage("User [abc] does not have permission to upload files."), "permission");
  assert.equal(classifyUploadMessage("Something else"), "refused");
  assert.equal(classifyUploadMessage(""), "unknown");
});

await test("uploadOrThrow surfaces the server's message, keeps the notification, restores ui.notifications.error", async () => {
  server.mode = "session"; notes.length = 0;
  const before = ui.notifications.error;
  await assert.rejects(uploadOrThrow("ai-image-gen/x", new File(["a"], "a.png")), (e) =>
    e.reason === "session" && /Reload this page or log in again/.test(e.message) && /User \[\] does not have permission/.test(e.message));
  assert.equal(notes.length, 1, "Foundry's notification still shown");
  assert.equal(ui.notifications.error, before, "notification hook restored");
  server.mode = "ok";
});

const A = mkActor("A");
let b1;
await test("session lost during ingest: one attempt only, record 'done, 1 failed, retry available', cost once, output kept", async () => {
  b1 = await makeBatch("A");
  server.mode = "session";
  const imgBefore = server.imageUploads;
  await checkOpenAI(KEY, getBatch(b1.id));
  const rec = getBatch(b1.id);
  assert.equal(rec.status, "done");
  assert.equal(rec.applied, 0);
  assert.equal(rec.failed.length, 1);
  assert.equal(rec.failed[0].retry, true);
  assert.equal(rec.failed[0].stage, "save");
  assert.equal(rec.failed[0].reason, "session");
  assert.match(rec.failed[0].error, /log in again/);
  assert.doesNotMatch(rec.failed[0].error, /gave up after/);
  assert.equal(rec.retryable, 1);
  assert.equal(rec.remote.outputFileId, b1.out);
  assert.equal(server.imageUploads - imgBefore, 1, "no 3 blind retries on a session error");
  assert.ok(files.has(b1.out), "output file NOT deleted at the provider");
  assert.ok(!files.has(`file-in-${n}`), "input file (prompts) still deleted");
  assert.ok(Math.abs(usage() - rec.cost) < 1e-9 && rec.cost > 0, "cost recorded once");
  assert.equal(A.updates, 0);
  assert.equal(retryableItems(rec).length, 1);
});

await test("retryBatchSave: re-downloads (GET only), saves + applies once, no new cost, cleans up, idempotent", async () => {
  server.mode = "ok";
  const costBefore = usage();
  const callsBefore = calls.length;
  const r = await retryBatchSave(b1.id, { apiKey: KEY });
  assert.deepEqual(r.saved, [b1.itemId]);
  assert.deepEqual(r.failed, []);
  const rec = getBatch(b1.id);
  assert.equal(rec.status, "done");
  assert.equal(rec.applied, 1);
  assert.deepEqual(rec.failed, []);
  assert.equal(rec.retryable, undefined);
  assert.equal(rec.retrying, undefined);
  assert.equal(A.updates, 1);
  assert.match(A.img, /^ai-image-gen\/invincible\/actor-superhero\/ai-test-.*\.png$/);
  assert.equal(usage(), costBefore, "no double billing in the limits");
  const newCalls = calls.slice(callsBefore);
  assert.ok(newCalls.every((c) => /^(GET|DELETE) /.test(c)), `only GET/DELETE: ${newCalls.join(", ")}`);
  assert.equal(generationCalls().length, 0, "nothing generated");
  assert.ok(!files.has(b1.out), "output deleted once nothing waits for a retry");
  const again = await retryBatchSave(b1.id, { apiKey: KEY });
  assert.deepEqual(again.saved, []);
  assert.equal(A.updates, 1, "no double apply");
  const log = (await readLog()).filter((e) => e.batchId === b1.id);
  const res = log.filter((e) => e.kind === "batch-result");
  assert.equal(res.length, 1, "one batch-result entry (the failure, with the real cost)");
  assert.equal(res[0].status, "error");
  assert.ok(res[0].cost > 0);
  const rt = log.filter((e) => e.kind === "batch-retry");
  assert.equal(rt.length, 1, "one batch-retry entry");
  assert.equal(rt[0].status, "ok");
  assert.equal(rt[0].cost, 0, "the retry costs nothing in the log");
});

await test("transient upload failure: attempts are spaced (backoff), then give up with retry available", async () => {
  const B = mkActor("B");
  const b = await makeBatch("B");
  server.mode = "network";
  ingestTuning.retryDelaysMs = [60_000, 60_000];
  await checkOpenAI(KEY, getBatch(b.id));
  await checkOpenAI(KEY, getBatch(b.id));   // immediately again ("Check now" / reload): must not count
  let rec = getBatch(b.id);
  assert.equal(rec.status, "pending");
  assert.equal(rec.ingest.attempts[b.itemId], 1);
  ingestTuning.retryDelaysMs = [0, 0];
  const cur = getBatch(b.id);
  await putBatch({ ...cur, ingest: { ...cur.ingest, nextTry: {} } });   // the minute has passed
  for (let i = 1; i < MAX_ATTEMPTS; i++) await checkOpenAI(KEY, getBatch(b.id));
  rec = getBatch(b.id);
  assert.equal(rec.status, "done");
  assert.equal(rec.failed[0].retry, true);
  assert.match(rec.failed[0].error, /gave up after 3 attempts; retry available/);
  assert.match(rec.failed[0].error, /no path in the server response/);
  server.mode = "ok";
  const r = await retryBatchSave(b.id, { apiKey: KEY });
  assert.deepEqual(r.saved, [b.itemId]);
  assert.equal(B.updates, 1);
  assert.equal(getBatch(b.id).applied, 1);
});

await test("legacy record (before W6-K: no retry flag, no stored output id) is recoverable via the batch GET", async () => {
  const C = mkActor("C");
  const b = await makeBatch("C");
  const rec = getBatch(b.id);
  await putBatch({ ...rec, status: "done", applied: 0, cost: 0.009104, completedAt: Date.now(),
    failed: [{ id: b.itemId, error: "Upload failed for ai-image-gen/invincible/actor-superhero/[redacted].webp (gave up after 3 attempts)" }] });
  const r = await retryBatchSave(b.id, { apiKey: KEY });
  assert.deepEqual(r.saved, [b.itemId]);
  assert.equal(C.updates, 1);
  assert.equal(getBatch(b.id).failed.length, 0);
});

await test("output already deleted at the provider: truthful 'cannot be recovered', retry flag cleared", async () => {
  mkActor("D");
  const b = await makeBatch("D");
  const rec = getBatch(b.id);
  files.delete(b.out);
  await putBatch({ ...rec, status: "done", applied: 0, completedAt: Date.now(),
    failed: [{ id: b.itemId, error: "Upload failed for x.webp (gave up after 3 attempts)" }] });
  const r = await retryBatchSave(b.id, { apiKey: KEY });
  assert.deepEqual(r.gone, [b.itemId]);
  const after = getBatch(b.id);
  assert.equal(after.failed[0].retry, false);
  assert.match(after.failed[0].error, /cannot be recovered/);
  assert.equal(retryableItems(after).length, 0);
  assert.equal(after.retryable, undefined);
});

await test("retry with apply:false saves the file only (document image untouched), path recorded", async () => {
  const E = mkActor("E");
  const b = await makeBatch("E");
  server.mode = "session";
  await checkOpenAI(KEY, getBatch(b.id));
  server.mode = "ok";
  const r = await retryBatchSave(b.id, { apiKey: KEY, apply: false });
  assert.deepEqual(r.saved, [b.itemId]);
  assert.equal(E.updates, 0);
  const rec = getBatch(b.id);
  assert.match(rec.recovered[0].path, new RegExp(`_candidates/${b.id}-recovered/`));
  assert.equal(rec.applied, 0);
});

await test("two retries at once on one client: second refused, applied once", async () => {
  const F = mkActor("F");
  const b = await makeBatch("F");
  server.mode = "session";
  await checkOpenAI(KEY, getBatch(b.id));
  server.mode = "ok";
  const res = await Promise.allSettled([retryBatchSave(b.id, { apiKey: KEY }), retryBatchSave(b.id, { apiKey: KEY })]);
  assert.equal(res.filter((x) => x.status === "fulfilled" && x.value.saved.length === 1).length, 1);
  assert.equal(F.updates, 1);
});

await test("six results for the same actor land at once: unique names, all saved and applied, none failed", async () => {
  const G = mkActor("G");
  const bs = [];
  for (let i = 0; i < 6; i++) bs.push(await makeBatch("G"));
  const filesBefore = server.files.size;
  await Promise.all(bs.map((b) => checkOpenAI(KEY, getBatch(b.id))));
  for (const b of bs) {
    const rec = getBatch(b.id);
    assert.equal(rec.status, "done", b.id);
    assert.equal(rec.applied, 1, b.id);
    assert.deepEqual(rec.failed, []);
  }
  assert.equal(G.updates, 6);
  const imgs = [...server.files.keys()].slice(filesBefore).filter((p) => p.includes("actor-superhero"));
  assert.equal(new Set(imgs).size, 6, "six distinct files");
  assert.ok(server.maxInFlight >= 2, "uploads really overlapped in the test");
});

await test("call log: a refused log upload is not counted as written (retried on the next flush)", async () => {
  server.mode = "session";
  const { logCall } = await import("../scripts/call-log.mjs");
  await logCall({ kind: "test", status: "ok", provider: "openai", model: "m", cost: 0 });
  const logPath = [...server.files.keys()].find((p) => p.endsWith("_log/" + new Date().toISOString().slice(0, 7) + ".json"));
  const sizeBefore = logPath ? server.files.get(logPath) : 0;
  server.mode = "ok";
  await flushLog();
  const p2 = [...server.files.keys()].find((p) => p.endsWith("_log/" + new Date().toISOString().slice(0, 7) + ".json"));
  assert.ok(p2 && server.files.get(p2) > sizeBefore, "entry written after the session came back");
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
process.exit(process.exitCode ?? 0);
