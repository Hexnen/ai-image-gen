// Dry-run driver (dev only): what the stand-in model runs from its shell. Works on the relay's scratch folder.
// Folder: --dir <folder> or env DRY_DIR (the same folder the relay was started with).
//
//   node dev/dry-run/driver.mjs wait [--timeout 600]      block until a request is pending; print its summary + the NEW messages
//   node dev/dry-run/driver.mjs show <id> [part]          part: new (default) | messages | system | system0 | system1 | system2 | tools | body | meta
//   node dev/dry-run/driver.mjs answer <id> <file|->      validate the answer against that request and hand it to the page
//   node dev/dry-run/driver.mjs check <id> <file|->       validate only (nothing is sent)
//   node dev/dry-run/driver.mjs status                    relay + pending / answered / cancelled ids
//   node dev/dry-run/driver.mjs snippet                   the JS lines that enable / disable dry mode on the lane page, and the
//                                                         save helper (window.__dryRelay.save) to run on /game after the reload
//   node dev/dry-run/driver.mjs helper                    only the save helper line
//   node dev/dry-run/driver.mjs transcript [out.md]       every request's new messages + every answer, as Markdown (default <dir>/transcript.md)
// Answer file: { "content": [ {"type":"text","text":"..."}, {"type":"tool_use","name":"search_catalog","input":{...}} ], "stop_reason"? }
//   tool_use ids may be left out (filled as toolu_dry_<req>_<n>); stop_reason is inferred (tool_use when a tool is called, else end_turn).
//   A simulated API error instead: { "error": { "type": "overloaded_error", "message": "..." } } (add "status": 529 for an HTTP error).
import fs from "node:fs";
import path from "node:path";
import { checkDir, dirs, listIds, pendingIds, reqPath, ansPath, cancelPath, readJson, writeJsonAtomic, checkAnswer, renderMessages, newFrom, summary, pageHelperSource, savedNames } from "./queue.mjs";
import { DRY_STORAGE_KEY } from "../../scripts/build/dry-transport.mjs";

const args = process.argv.slice(2);
const flag = (k, dflt) => { const i = args.indexOf(k); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const dirArg = flag("--dir", process.env.DRY_DIR);
const timeoutS = Number(flag("--timeout", 600));
const [cmd, a1, a2] = args;
const root = checkDir(dirArg);
const d = dirs(root);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const loadReq = (id) => { const p = reqPath(d, String(id).padStart(4, "0")); if (!fs.existsSync(p)) die(`no request ${id} in ${d.req}`); return readJson(p); };
const readAnswerArg = (src) => {
  if (!src) die("answer file missing (path or - for stdin)");
  const txt = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
  try { return JSON.parse(txt.replace(/^﻿/, "")); } catch (e) { die(`answer is not valid JSON: ${e.message}`); }
};

function printRequest(rec) {
  const from = newFrom(rec.body);
  console.log(summary(rec));
  console.log(`full request: ${reqPath(d, rec.id)}`);
  console.log(`\n===== NEW since your last answer (messages[${from}..]) =====`);
  console.log(renderMessages(rec.body, from));
  console.log(`===== end of request ${rec.id}; answer with: node dev/dry-run/driver.mjs answer ${rec.id} <file.json> =====`);
}

switch (cmd) {
  case "wait": {
    const until = Date.now() + timeoutS * 1000;
    for (;;) {
      const p = pendingIds(d);
      if (p.length) { printRequest(loadReq(p[0])); if (p.length > 1) console.log(`(also pending: ${p.slice(1).join(", ")})`); break; }
      if (Date.now() > until) die(`no pending request after ${timeoutS} s (is the relay running and was send() started?)`, 2);
      await sleep(500);
    }
    break;
  }
  case "show": {
    const rec = loadReq(a1);
    const b = rec.body;
    const part = a2 ?? "new";
    if (part === "new") console.log(renderMessages(b, newFrom(b)));
    else if (part === "messages") console.log(renderMessages(b, 0));
    else if (part === "system") (b.system ?? []).forEach((s, i) => console.log(`===== system[${i}] =====\n${s.text}`));
    else if (/^system\d$/.test(part)) console.log(b.system?.[Number(part.slice(6))]?.text ?? "(none)");
    else if (part === "tools") console.log(JSON.stringify(b.tools ?? [], null, 2));
    else if (part === "body") console.log(JSON.stringify(b, null, 2));
    else if (part === "meta") console.log(JSON.stringify({ id: rec.id, at: rec.at, origin: rec.origin, meta: rec.meta }, null, 2));
    else die(`unknown part ${part}`);
    break;
  }
  case "check":
  case "answer": {
    const rec = loadReq(a1);
    const id = rec.id;
    if (cmd === "answer") {
      if (fs.existsSync(ansPath(d, id))) die(`request ${id} is already answered`);
      if (fs.existsSync(cancelPath(d, id))) die(`request ${id} was cancelled by the page (${readJson(cancelPath(d, id)).why}); wait for the next one`);
    }
    const r = checkAnswer(readAnswerArg(a2), rec);
    if (!r.ok) die(`answer NOT accepted:\n- ${r.errors.join("\n- ")}`);
    if (cmd === "check") { console.log(`ok (not sent): ${JSON.stringify(r.answer).slice(0, 400)}`); break; }
    writeJsonAtomic(ansPath(d, id), r.answer);
    const tools = (r.answer.content ?? []).filter((x) => x.type === "tool_use").map((x) => `${x.name} (${x.id})`);
    console.log(`answered ${id}: stop_reason=${r.answer.stop_reason ?? "error"}${tools.length ? `; tool calls: ${tools.join(", ")}` : ""}${r.answer.error ? `; simulated error ${r.answer.error.type}` : ""}`);
    console.log(tools.length ? "the harness now runs the tools and sends the results: run `wait` again" : "end of turn for the harness (it may still send another request: `wait --timeout 20` to be sure)");
    break;
  }
  case "status": {
    const l = listIds(d);
    const relay = fs.existsSync(path.join(root, "relay.json")) ? readJson(path.join(root, "relay.json")) : null;
    console.log(JSON.stringify({ folder: root, relay: relay ? { port: relay.port, pid: relay.pid, startedAt: relay.startedAt } : "not running", requests: l.req.length, pending: pendingIds(d), answered: [...l.ans], cancelled: [...l.cancelled], saved: savedNames(d) }, null, 2));
    break;
  }
  case "snippet": {
    const p = path.join(root, "relay.json");
    if (!fs.existsSync(p)) die("relay.json missing: start the relay first");
    const r = readJson(p);
    const cfg = JSON.stringify({ relay: `http://127.0.0.1:${r.port}`, token: r.token });
    console.log(`// 1. enable (on the lane page, before /game):`);
    console.log(`localStorage.setItem(${JSON.stringify(DRY_STORAGE_KEY)}, ${JSON.stringify(cfg)}); location.reload();`);
    console.log(`// 2. save helper (on /game after every page load; then: await window.__dryRelay.save("apply-1.json", obj) -> ${path.join(root, "saved")}):`);
    console.log(pageHelperSource());
    console.log(`// 3. afterwards: localStorage.removeItem(${JSON.stringify(DRY_STORAGE_KEY)}); location.reload();`);
    break;
  }
  case "helper":
    console.log(pageHelperSource());
    break;
  case "transcript": {
    const out = a1 ? checkDir(a1) : path.join(root, "transcript.md");
    const l = listIds(d);
    const lines = [`# Dry-run transcript`, ``, `Folder: ${root}`, ``];
    for (const id of l.req) {
      const rec = readJson(reqPath(d, id));
      lines.push(`## Request ${id}`, "", "```", summary(rec), "```", "", "### New messages", "", "```", renderMessages(rec.body, newFrom(rec.body)), "```", "");
      if (l.ans.has(id)) lines.push("### Answer", "", "```json", JSON.stringify(readJson(ansPath(d, id)), null, 2), "```", "");
      else if (l.cancelled.has(id)) lines.push(`### Cancelled by the page: ${readJson(cancelPath(d, id)).why}`, "");
      else lines.push("### (no answer yet)", "");
    }
    fs.writeFileSync(out, lines.join("\n"));
    console.log(`wrote ${out}`);
    break;
  }
  default:
    die("usage: driver.mjs wait|show|answer|check|status|snippet|helper|transcript (see the header of this file)");
}
