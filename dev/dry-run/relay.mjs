// Dry-run relay (dev only): the local queue between the lane browser (scripts/build/dry-transport.mjs) and the stand-in
// model (driver.mjs). Listens on 127.0.0.1 only, needs a random token, accepts browser origins on lane ports only
// (never :30000), stores everything in a scratch folder (refuses the repo and Foundry folders). Never calls Anthropic.
//
//   node dev/dry-run/relay.mjs --dir <scratch folder> [--port 0]
// Prints the port, the token and the JS line that enables dry mode on the lane page (also saved in <dir>/relay.json).
// HTTP (browser side only; the driver works on the files):
//   POST /requests                 text/plain JSON { token, meta, body }  -> 200 { id }
//   GET  /requests/<id>/answer?token=   -> 200 answer JSON | 204 not yet | 410 cancelled
//   POST /requests/<id>/cancel     text/plain JSON { token, why }       -> 200
//   GET  /health?token=            -> 200 { ok, pending }
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkDir, dirs, nextId, pendingIds, reqPath, ansPath, cancelPath, writeJsonAtomic, readJson } from "./queue.mjs";
import { DRY_STORAGE_KEY, LANE_PORTS, OWNER_PORT } from "../../scripts/build/dry-transport.mjs";

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const root = checkDir(arg("--dir", process.env.DRY_DIR));
const d = dirs(root);
const token = crypto.randomBytes(24).toString("base64url");
const MAX_BODY = 8 * 1024 * 1024;

function originAllowed(origin) {
  if (!origin) return true; // non-browser client on the loopback (tests); the token still applies
  try {
    const u = new URL(origin);
    const port = Number(u.port || 80);
    return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname) && port !== OWNER_PORT && LANE_PORTS.includes(port);
  } catch { return false; }
}

function send(res, status, obj, origin) {
  const h = { "cache-control": "no-store" };
  if (origin && originAllowed(origin)) { h["access-control-allow-origin"] = origin; h.vary = "Origin"; }
  if (obj === undefined) { res.writeHead(status, h); return res.end(); }
  h["content-type"] = "application/json";
  res.writeHead(status, h);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

const okToken = (t) => typeof t === "string" && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  try {
    if (!originAllowed(origin)) { log(`refused origin ${origin}`); return send(res, 403, { error: "origin not allowed" }); }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "Origin" });
      return res.end();
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const m = /^\/requests\/(\d{4,})\/(answer|cancel)$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/health") {
      if (!okToken(url.searchParams.get("token") ?? "")) return send(res, 401, { error: "token" }, origin);
      return send(res, 200, { ok: true, pending: pendingIds(d) }, origin);
    }
    if (req.method === "POST" && url.pathname === "/requests") {
      const j = JSON.parse(await readBody(req));
      if (!okToken(j?.token)) return send(res, 401, { error: "token" }, origin);
      if (!j.body || typeof j.body !== "object" || !Array.isArray(j.body.messages)) return send(res, 400, { error: "no request body" }, origin);
      const id = nextId(d);
      writeJsonAtomic(reqPath(d, id), { id, at: new Date().toISOString(), origin: origin ?? null, meta: j.meta ?? {}, body: j.body });
      log(`request ${id} (${j.body.messages.length} messages) waiting for the stand-in: node dev/dry-run/driver.mjs wait`);
      return send(res, 200, { id }, origin);
    }
    if (m && req.method === "GET" && m[2] === "answer") {
      if (!okToken(url.searchParams.get("token") ?? "")) return send(res, 401, { error: "token" }, origin);
      const id = m[1];
      if (fs.existsSync(cancelPath(d, id))) return send(res, 410, { error: "cancelled" }, origin);
      if (fs.existsSync(ansPath(d, id))) { log(`answer ${id} delivered`); return send(res, 200, readJson(ansPath(d, id)), origin); }
      if (!fs.existsSync(reqPath(d, id))) return send(res, 404, { error: "unknown id" }, origin);
      return send(res, 204, undefined, origin);
    }
    if (m && req.method === "POST" && m[2] === "cancel") {
      const j = JSON.parse(await readBody(req) || "{}");
      if (!okToken(j?.token)) return send(res, 401, { error: "token" }, origin);
      const id = m[1];
      if (fs.existsSync(reqPath(d, id)) && !fs.existsSync(ansPath(d, id))) {
        writeJsonAtomic(cancelPath(d, id), { at: new Date().toISOString(), why: String(j.why ?? "") });
        log(`request ${id} cancelled by the page (${j.why ?? ""})`);
      }
      return send(res, 200, { ok: true }, origin);
    }
    return send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    log(`error ${e?.message ?? e}`);
    return send(res, 400, { error: String(e?.message ?? e).slice(0, 200) }, origin);
  }
});

server.listen(Number(arg("--port", 0)), "127.0.0.1", () => {
  const port = server.address().port;
  writeJsonAtomic(path.join(root, "relay.json"), { port, token, pid: process.pid, startedAt: new Date().toISOString() });
  const cfg = JSON.stringify({ relay: `http://127.0.0.1:${port}`, token });
  console.log(`dry relay on http://127.0.0.1:${port}  folder ${root}`);
  console.log(`enable on the LANE GM page (then reload):  localStorage.setItem(${JSON.stringify(DRY_STORAGE_KEY)}, ${JSON.stringify(cfg)})`);
  console.log(`disable:  localStorage.removeItem(${JSON.stringify(DRY_STORAGE_KEY)})`);
});
const stop = () => { try { fs.rmSync(path.join(root, "relay.json"), { force: true }); } catch { /* */ } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
