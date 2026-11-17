// Tests of the dry-run relay's save path (dev/dry-run/relay.mjs POST /save, queue.mjs saveFile / checkSaveName /
// pageHelperSource, driver.mjs snippet|helper|status). Node only: a real relay on 127.0.0.1 and a FAKE lane page (vm
// context with location / localStorage / game / fetch that sends the page's Origin like a browser). No Foundry, no lane,
// no network beyond 127.0.0.1, no key. Run from the module folder: node dev/test-dry-relay.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DRY_STORAGE_KEY } from "../scripts/build/dry-transport.mjs";
import { checkSaveName, saveFile, saveText, pageHelperSource, dirs, readJson, MAX_SAVE_BYTES } from "./dry-run/queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------- pure pieces

await test("checkSaveName: only [A-Za-z0-9._-]+.json|txt|md, no folders, no dot-dot, no device names", () => {
  for (const ok of ["apply-1.json", "turns.json", "snapshot_final.txt", "notes.v2.md", "A.json"]) assert.equal(checkSaveName(ok), null, ok);
  for (const bad of ["", null, 7, "x.js", "x.json.exe", "x", ".json", ".hidden.json", "a/b.json", "a\\b.json", "../x.json", "..\\x.json",
    "a..b.json", "C:x.json", "x y.json", "zażółć.json", "x.JSON", "CON.json", "nul.txt", "com1.md", "a".repeat(101) + ".json", "x.json\n"]) {
    assert.notEqual(checkSaveName(bad), null, JSON.stringify(bad));
  }
});

await test("saveText: objects become pretty JSON, a JSON string must parse, txt/md keep the string", () => {
  assert.equal(saveText("a.json", { a: 1 }), '{\n  "a": 1\n}');
  assert.equal(saveText("a.json", "[1,2]"), "[1,2]");
  assert.throws(() => saveText("a.json", "{nope"), /not valid JSON/);
  assert.throws(() => saveText("a.json", undefined), /content missing/);
  assert.equal(saveText("a.txt", "line 1\nline 2"), "line 1\nline 2");
  assert.equal(saveText("a.md", { b: 2 }), '{\n  "b": 2\n}');
});

await test("saveFile: writes only into <dir>/saved, wx without overwrite, atomic replace with overwrite", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maig-save-unit-"));
  try {
    const d = dirs(tmp);
    const r = saveFile(d, "x.json", { n: 1 });
    assert.equal(r.path, path.join(tmp, "saved", "x.json"));
    assert.equal(r.overwritten, false);
    assert.throws(() => saveFile(d, "x.json", { n: 2 }), (e) => e.status === 409);
    assert.equal(readJson(r.path).n, 1);
    assert.equal(saveFile(d, "x.json", { n: 3 }, { overwrite: true }).overwritten, true);
    assert.equal(readJson(r.path).n, 3);
    assert.throws(() => saveFile(d, "x.json", { n: 4 }, { overwrite: "yes" }), (e) => e.status === 409, "only overwrite === true");
    assert.throws(() => saveFile(d, "../relay.json", {}), (e) => e.status === 400);
    assert.throws(() => saveFile(d, "big.txt", "x".repeat(MAX_SAVE_BYTES + 1)), (e) => e.status === 413);
    assert.equal(fs.existsSync(path.join(tmp, "saved", "big.txt")), false);
    assert.deepEqual(fs.readdirSync(path.join(tmp, "saved")), ["x.json"], "no temp files left");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------- live relay

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maig-dry-relay-test-"));
const relay = spawn(process.execPath, [path.join(HERE, "dry-run", "relay.mjs"), "--dir", tmp], { stdio: ["ignore", "pipe", "pipe"] });
let relayOut = "";
relay.stdout.on("data", (c) => { relayOut += c; });
relay.stderr.on("data", (c) => { relayOut += c; });
for (let i = 0; i < 100 && !fs.existsSync(path.join(tmp, "relay.json")); i++) await sleep(50);
const R = readJson(path.join(tmp, "relay.json"));
const RELAY = `http://127.0.0.1:${R.port}`;
const SAVED = path.join(tmp, "saved");
const driver = (...a) => execFileSync(process.execPath, [path.join(HERE, "dry-run", "driver.mjs"), "--dir", tmp, ...a], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const save = (payload, origin) => fetch(`${RELAY}/save`, { method: "POST", headers: { "content-type": "text/plain", ...(origin ? { origin } : {}) }, body: JSON.stringify(payload) });
const listing = () => { const out = []; const walk = (p) => { for (const f of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, f.name); out.push(path.relative(tmp, q)); if (f.isDirectory()) walk(q); } }; walk(tmp); return out.sort(); };

await test("relay /save: token required (missing, wrong, other length)", async () => {
  assert.equal((await save({ name: "t.json", content: {} })).status, 401);
  assert.equal((await save({ token: "x".repeat(R.token.length), name: "t.json", content: {} })).status, 401);
  assert.equal((await save({ token: R.token + "x", name: "t.json", content: {} })).status, 401);
  assert.equal(fs.existsSync(path.join(SAVED, "t.json")), false);
});

await test("relay /save: owner origin :30000, non-lane ports and foreign hosts refused; a lane origin gets CORS", async () => {
  for (const o of ["http://localhost:30000", "http://127.0.0.1:30000", "http://localhost:30010", "http://localhost", "http://evil.example:30008", "http://192.168.1.5:30008", "null"]) {
    assert.equal((await save({ token: R.token, name: "o.json", content: {} }, o)).status, 403, o);
  }
  assert.equal(fs.existsSync(path.join(SAVED, "o.json")), false);
  const r = await save({ token: R.token, name: "o.json", content: { ok: 1 } }, "http://localhost:30008");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:30008");
});

await test("relay /save: bad names refused, nothing written anywhere", async () => {
  const before = listing();
  for (const name of ["x.js", "x", "a/b.json", "a\\b.json", ".x.json", "CON.json", "x.json.exe", "", 5, null]) {
    const r = await save({ token: R.token, name, content: { a: 1 } });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.match((await r.json()).error, /name/);
  }
  assert.deepEqual(listing(), before);
});

await test("relay /save: path traversal refused (.., encoded, absolute, the relay's own files)", async () => {
  const before = listing();
  const relayJson = fs.readFileSync(path.join(tmp, "relay.json"), "utf8");
  for (const name of ["../relay.json", "..\\relay.json", "../../x.json", "..%2Fx.json", "%2e%2e/x.json", "C:\\x.json", "/x.json", path.join(tmp, "x.json"), "saved/../../x.json", "..json"]) {
    assert.equal((await save({ token: R.token, name, content: {} })).status, 400, name);
  }
  assert.equal((await fetch(`${RELAY}/save/../relay.json`, { method: "POST", body: JSON.stringify({ token: R.token, name: "r.json", content: {} }) })).status, 404, "a traversing URL path is no endpoint");
  assert.equal(fs.readFileSync(path.join(tmp, "relay.json"), "utf8"), relayJson, "relay.json untouched");
  assert.deepEqual(listing(), before, "nothing written anywhere");
});

await test("relay /save: size limit 2 MB (413, nothing written); just under the limit is fine", async () => {
  const big = await save({ token: R.token, name: "big.txt", content: "x".repeat(MAX_SAVE_BYTES + 1) });
  assert.equal(big.status, 413);
  assert.equal(fs.existsSync(path.join(SAVED, "big.txt")), false);
  const huge = await save({ token: R.token, name: "huge.txt", content: "y".repeat(5 * MAX_SAVE_BYTES) });
  assert.equal(huge.status, 413, "an oversized body gets a 413, not a reset connection");
  const ok = await save({ token: R.token, name: "near.txt", content: "z".repeat(MAX_SAVE_BYTES - 10) });
  assert.equal(ok.status, 200);
  assert.equal(fs.statSync(path.join(SAVED, "near.txt")).size, MAX_SAVE_BYTES - 10);
});

await test("relay /save: never overwrites without overwrite:true; with it, replaces", async () => {
  assert.equal((await save({ token: R.token, name: "apply-1.json", content: { v: 1 } })).status, 200);
  const r2 = await save({ token: R.token, name: "apply-1.json", content: { v: 2 } });
  assert.equal(r2.status, 409);
  assert.match((await r2.json()).error, /overwrite: true/);
  assert.equal(readJson(path.join(SAVED, "apply-1.json")).v, 1);
  assert.equal((await save({ token: R.token, name: "apply-1.json", content: { v: 3 }, overwrite: "true" })).status, 409, "string 'true' is not true");
  const r3 = await save({ token: R.token, name: "apply-1.json", content: { v: 4 }, overwrite: true });
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).overwritten, true);
  assert.equal(readJson(path.join(SAVED, "apply-1.json")).v, 4);
});

await test("relay /save: content round-trip (object, JSON string, text, markdown, Polish letters), bad JSON string refused", async () => {
  const obj = { proposalId: "p_1", idMap: { op1: "abcdefABCDEF0123" }, items: [{ name: "Zażółć gęślą jaźń", level: null, n: 1.5, ok: true }], nested: { deep: [[1, [2, { x: "\"q\"\n\t" }]]] } };
  const r = await save({ token: R.token, name: "obj.json", content: obj });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.path, path.join(SAVED, "obj.json"));
  assert.equal(j.bytes, Buffer.byteLength(JSON.stringify(obj, null, 2)));
  assert.deepEqual(readJson(path.join(SAVED, "obj.json")), obj);
  assert.equal((await save({ token: R.token, name: "str.json", content: "[1,\"ą\"]" })).status, 200);
  assert.equal(fs.readFileSync(path.join(SAVED, "str.json"), "utf8"), "[1,\"ą\"]");
  assert.equal((await save({ token: R.token, name: "bad.json", content: "{oops" })).status, 400);
  const txt = "<sheet doc=\"Actor.x\">\nVALID: yes\nŚciana — 3\n</sheet>\n";
  assert.equal((await save({ token: R.token, name: "snapshot-final.txt", content: txt })).status, 200);
  assert.equal(fs.readFileSync(path.join(SAVED, "snapshot-final.txt"), "utf8"), txt);
  assert.equal((await save({ token: R.token, name: "n.md", content: "# x\n" })).status, 200);
  assert.equal((await save({ token: R.token, name: "nocontent.json" })).status, 400);
});

// ------------------------------------------------------------------------------------------- fake lane page

/** A fake browser page: the helper source runs in its own vm context; fetch adds the page's Origin like a browser. */
function fakePage({ origin = "http://localhost:30008", cfg = { relay: RELAY, token: R.token }, dry = { relay: RELAY, wallMinutes: 60, requestMinutes: 30 } } = {}) {
  const u = new URL(origin);
  const ls = new Map(cfg ? [[DRY_STORAGE_KEY, typeof cfg === "string" ? cfg : JSON.stringify(cfg)]] : []);
  const window = {};
  const ctx = {
    window, URL, JSON, Error, Number, Promise,
    location: { hostname: u.hostname, port: u.port, origin: u.origin, protocol: u.protocol },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null) },
    game: { ready: true, modules: new Map([["moinens-ai-gen", { api: { build: { dry } } }]]) },
    fetch: (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), origin: u.origin } })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, window, run: (src) => vm.runInContext(src, ctx) };
}

await test("page helper: window.__dryRelay.save on a lane page writes saved/<name> (object, text, overwrite rule, errors thrown)", async () => {
  const p = fakePage();
  assert.equal(p.run(pageHelperSource()), "window.__dryRelay ready");
  const items = [{ id: "a1", name: "Flight", type: "power", level: "major", power: null, powerSource: "s1" }];
  const r = await p.window.__dryRelay.save("items-1.json", { items });
  assert.equal(r.ok, true);
  assert.deepEqual(readJson(path.join(SAVED, "items-1.json")), { items });
  await assert.rejects(p.window.__dryRelay.save("items-1.json", { items: [] }), /409.*overwrite/);
  assert.equal((await p.window.__dryRelay.save("items-1.json", { items: [] }, { overwrite: true })).overwritten, true);
  await p.window.__dryRelay.save("turns.txt", "plain text");
  assert.equal(fs.readFileSync(path.join(SAVED, "turns.txt"), "utf8"), "plain text");
  await assert.rejects(p.window.__dryRelay.save("../x.json", {}), /400/);
  const helper = pageHelperSource();
  assert.equal(helper.includes(R.token), false, "the helper source carries no token");
});

await test("page helper: refuses to exist off the lanes, without dry config, with a bad relay; save refuses without builder dry mode", async () => {
  assert.throws(() => fakePage({ origin: "http://localhost:30000" }).run(pageHelperSource()), /not a lane page/);
  assert.throws(() => fakePage({ origin: "http://localhost:30010" }).run(pageHelperSource()), /not a lane page/);
  assert.throws(() => fakePage({ origin: "http://foundry.example.org:30008" }).run(pageHelperSource()), /not a lane page/);
  assert.throws(() => fakePage({ cfg: null }).run(pageHelperSource()), /not configured/);
  assert.throws(() => fakePage({ cfg: "{bad" }).run(pageHelperSource()), /not configured/);
  assert.throws(() => fakePage({ cfg: { relay: "http://127.0.0.1:30008", token: R.token } }).run(pageHelperSource()), /bad relay/);
  assert.throws(() => fakePage({ cfg: { relay: "https://example.com:443", token: R.token } }).run(pageHelperSource()), /bad relay/);
  const off = fakePage({ dry: null });
  off.run(pageHelperSource());
  await assert.rejects(off.window.__dryRelay.save("z.json", {}), /not in dry mode/);
  assert.equal(fs.existsSync(path.join(SAVED, "z.json")), false);
  const wrongTok = fakePage({ cfg: { relay: RELAY, token: "A".repeat(R.token.length) } });
  wrongTok.run(pageHelperSource());
  await assert.rejects(wrongTok.window.__dryRelay.save("z.json", {}), /401/);
});

await test("driver: snippet prints enable line + helper + disable line; helper alone; status lists saved files", () => {
  const s = driver("snippet");
  assert.match(s, /localStorage\.setItem\("moinens-ai-gen\.build\.dry"/);
  assert.ok(s.includes(pageHelperSource()));
  assert.match(s, /localStorage\.removeItem/);
  assert.equal(driver("helper").trim(), pageHelperSource());
  const st = JSON.parse(driver("status"));
  assert.ok(st.saved.includes("apply-1.json") && st.saved.includes("snapshot-final.txt"), JSON.stringify(st.saved));
});

relay.kill();
await sleep(100);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
if (process.exitCode) console.log(relayOut);
