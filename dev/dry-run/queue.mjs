// Shared pieces of the dry-run relay and driver (dev only, node). A dry-run folder (always a scratch folder, never the
// repo or a Foundry Data folder) holds:
//   relay.json            { port, token, pid, startedAt }        written by relay.mjs
//   req/<id>.json         { id, at, origin, meta, body }          one model request, exactly as the real transport built it
//   ans/<id>.json         the stand-in's answer                    written by driver.mjs answer (validated)
//   cancelled/<id>.json   { at, why }                              the harness stopped waiting (Stop, cap, timeout)
//   saved/<name>          evidence saved FROM THE PAGE (POST /save, window.__dryRelay.save): apply results, items, turns...
// Ids are zero-padded sequence numbers ("0001"), so name order = time order.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAnswer, DRY_STORAGE_KEY, LANE_PORTS, OWNER_PORT } from "../../scripts/build/dry-transport.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Refuse folders inside the repo or inside any Foundry data folder (transcripts are scratch data, never module data). */
export function checkDir(dir) {
  if (!dir) throw new Error("no dry-run folder: pass --dir <scratch folder> or set DRY_DIR");
  const abs = path.resolve(dir);
  const low = abs.toLowerCase().replace(/\//g, "\\");
  const repo = REPO_ROOT.toLowerCase().replace(/\//g, "\\");
  if (low === repo || low.startsWith(repo + "\\")) throw new Error(`refusing ${abs}: it is inside the module repo`);
  if (/\\foundryvtt(-\d+)?\\(data|config|logs)(\\|$)/i.test(low)) throw new Error(`refusing ${abs}: it is inside a Foundry folder`);
  return abs;
}

export function dirs(root) {
  const d = { root, req: path.join(root, "req"), ans: path.join(root, "ans"), cancelled: path.join(root, "cancelled"), saved: path.join(root, "saved") };
  for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
  return d;
}

const ids = (p) => (fs.existsSync(p) ? fs.readdirSync(p).filter((f) => /^\d{4,}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort() : []);
export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export function writeJsonAtomic(p, v) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

export function listIds(d) { return { req: ids(d.req), ans: new Set(ids(d.ans)), cancelled: new Set(ids(d.cancelled)) }; }
export function pendingIds(d) { const l = listIds(d); return l.req.filter((id) => !l.ans.has(id) && !l.cancelled.has(id)); }
export function nextId(d) { const r = ids(d.req); return String((r.length ? Number(r[r.length - 1]) : 0) + 1).padStart(4, "0"); }
export const reqPath = (d, id) => path.join(d.req, `${id}.json`);
export const ansPath = (d, id) => path.join(d.ans, `${id}.json`);
export const cancelPath = (d, id) => path.join(d.cancelled, `${id}.json`);

// ------------------------------------------------------------------------------------------------ saved evidence

/** Limit of one saved file (bytes, UTF-8, after JSON formatting). */
export const MAX_SAVE_BYTES = 2 * 1024 * 1024;
const SAVE_NAME = /^[A-Za-z0-9._-]+\.(json|txt|md)$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** A saved file's name: [A-Za-z0-9._-]+.(json|txt|md), max 100 chars, no leading dot, no "..", no Windows device name. */
export function checkSaveName(name) {
  if (typeof name !== "string" || !name) return "name missing";
  if (name.length > 100) return "name longer than 100 chars";
  if (!SAVE_NAME.test(name)) return "name must match [A-Za-z0-9._-]+.json|txt|md (no folders)";
  if (name.startsWith(".") || name.includes("..")) return "name must not start with a dot or contain ..";
  if (WIN_RESERVED.test(name)) return "reserved device name";
  return null;
}

/** The text that goes to disk: .json -> pretty JSON (a string must already be valid JSON); .txt/.md -> the string as is. */
export function saveText(name, content) {
  if (content === undefined) throw Object.assign(new Error("content missing"), { status: 400 });
  if (name.endsWith(".json")) {
    if (typeof content === "string") {
      try { JSON.parse(content); } catch (e) { throw Object.assign(new Error(`content is not valid JSON: ${e.message}`), { status: 400 }); }
      return content;
    }
    return JSON.stringify(content, null, 2);
  }
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

/**
 * Write one saved file into d.saved (never anywhere else). Refuses an existing file unless overwrite === true.
 * Returns { name, path, bytes, overwritten }. Errors carry .status (400 bad name/content, 409 exists, 413 too large).
 */
export function saveFile(d, name, content, { overwrite = false } = {}) {
  const bad = checkSaveName(name);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  const text = saveText(name, content);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SAVE_BYTES) throw Object.assign(new Error(`content is ${bytes} bytes; the limit is ${MAX_SAVE_BYTES}`), { status: 413 });
  const dir = path.resolve(d.saved);
  const p = path.resolve(dir, name);
  if (path.dirname(p) !== dir) throw Object.assign(new Error("name escapes the saved folder"), { status: 400 });
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(p);
  if (overwrite === true) {
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, p);
  } else {
    try { fs.writeFileSync(p, text, { encoding: "utf8", flag: "wx" }); }
    catch (e) { if (e.code === "EEXIST") throw Object.assign(new Error(`${name} already exists (pass overwrite: true to replace it)`), { status: 409 }); throw e; }
  }
  return { name, path: p, bytes, overwritten: existed && overwrite === true };
}

export const savedNames = (d) => (fs.existsSync(d.saved) ? fs.readdirSync(d.saved).filter((f) => !checkSaveName(f)).sort() : []);

/**
 * JS the stand-in runs ON THE LANE PAGE (driver.mjs snippet prints it): defines window.__dryRelay.save(name, data, { overwrite }).
 * It carries no token: it reads the relay and token from the dry-mode localStorage value, and it refuses to exist unless
 * the page is a loopback lane port (never :30000) with dry mode configured. save() also needs the builder's dry mode on
 * (api.build.dry not null), so run it on /game after the reload.
 */
export function pageHelperSource() {
  const fn = function (KEY, LANES, OWNER) {
    const host = location.hostname, port = Number(location.port);
    if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(host) || port === OWNER || !LANES.includes(port)) throw new Error(`__dryRelay: not a lane page (${location.origin})`);
    let cfg;
    try { cfg = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { cfg = null; }
    if (!cfg || !cfg.relay || !cfg.token) throw new Error("__dryRelay: dry mode is not configured on this page (run the enable line first)");
    const relay = new URL(cfg.relay);
    if (relay.protocol !== "http:" || !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(relay.hostname) || !relay.port || LANES.includes(Number(relay.port)) || Number(relay.port) === OWNER) throw new Error("__dryRelay: bad relay url");
    window.__dryRelay = {
      async save(name, data, { overwrite = false } = {}) {
        const api = globalThis.game?.modules?.get?.("moinens-ai-gen")?.api?.build;
        if (!api?.dry) throw new Error("__dryRelay: the builder is not in dry mode on this page (api.build.dry is null)");
        const body = JSON.stringify({ token: cfg.token, name, content: data, overwrite: overwrite === true });
        const r = await fetch(`${relay.origin}/save`, { method: "POST", headers: { "content-type": "text/plain" }, body, cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`__dryRelay.save ${name}: ${r.status} ${j.error ?? ""}`);
        return j;
      }
    };
    return "window.__dryRelay ready";
  };
  return `(${fn.toString()})(${JSON.stringify(DRY_STORAGE_KEY)}, ${JSON.stringify([...LANE_PORTS])}, ${OWNER_PORT});`;
}

// ------------------------------------------------------------------------------------------------ schema check

/**
 * Small JSON-schema check of a tool input against the tool's input_schema (the real API enforces strict schemas):
 * type (object/array/string/integer/number/boolean/null, or a list), enum, const, required, properties,
 * additionalProperties:false, items, minItems/maxItems, minimum/maximum, minLength/maxLength, anyOf/oneOf.
 * Returns a list of "path: problem" strings.
 */
export function schemaErrors(schema, value, at = "input") {
  const out = [];
  if (!schema || typeof schema !== "object") return out;
  const typeOk = (t, v) => t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v)
    : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v)
    : t === "null" ? v === null : typeof v === t;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const alts = schema.anyOf ?? schema.oneOf;
    if (!alts.some((s) => !schemaErrors(s, value, at).length)) out.push(`${at}: matches none of the allowed shapes`);
    return out;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) { out.push(`${at}: expected ${types.join("|")}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`); return out; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...schemaErrors(schema.items, v, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!(k in value)) out.push(`${at}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) out.push(...schemaErrors(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k}: not allowed (additionalProperties: false)`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...schemaErrors(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return out;
}

/** Every tool_use id already used in the conversation (history of this request). */
export function usedToolIds(body) {
  const s = new Set();
  for (const m of body?.messages ?? []) for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === "tool_use") s.add(b.id);
  return s;
}

/**
 * Validate a stand-in answer against the request it answers. Fills missing tool_use ids (toolu_dry_<req>_<n>).
 * Returns { ok, answer?, errors[] }. Only text and tool_use blocks; tools must exist; inputs must fit the schema.
 */
export function checkAnswer(raw, reqRecord) {
  const errors = [];
  const body = reqRecord?.body ?? {};
  const a = JSON.parse(JSON.stringify(raw ?? {}));
  if (Array.isArray(a.content)) {
    let n = 0;
    for (const b of a.content) if (b?.type === "tool_use" && !b.id) b.id = `toolu_dry_${reqRecord.id}_${++n}`;
  }
  let ans;
  try { ans = normalizeAnswer(a); } catch (e) { return { ok: false, errors: [e.message] }; }
  if (ans.error) return { ok: true, answer: ans, errors: [] };
  const tools = new Map((body.tools ?? []).map((t) => [t.name, t]));
  const used = usedToolIds(body);
  const mine = new Set();
  ans.content.forEach((b, i) => {
    if (b.type === "text" && !b.text.trim()) errors.push(`content[${i}]: empty text block`);
    if (b.type !== "tool_use") return;
    if (used.has(b.id) || mine.has(b.id)) errors.push(`content[${i}]: tool_use id ${b.id} is already used in this conversation`);
    mine.add(b.id);
    const t = tools.get(b.name);
    if (!t) { errors.push(`content[${i}]: unknown tool "${b.name}" (tools: ${[...tools.keys()].join(", ")})`); return; }
    for (const e of schemaErrors(t.input_schema, b.input, `content[${i}].input`)) errors.push(`${b.name}: ${e}`);
  });
  return { ok: !errors.length, answer: ans, errors };
}

// ------------------------------------------------------------------------------------------------ rendering

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n... (${s.length - n} more chars; use show)` : s);

function blockText(b, toolNames) {
  if (b?.type === "text") return b.text;
  if (b?.type === "tool_use") return `[tool_use ${b.id} ${b.name}] ${JSON.stringify(b.input)}`;
  if (b?.type === "tool_result") {
    const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    return `[tool_result for ${b.tool_use_id}${toolNames.get(b.tool_use_id) ? ` (${toolNames.get(b.tool_use_id)})` : ""}${b.is_error ? " IS_ERROR" : ""}]\n${c}`;
  }
  return `[${b?.type}] ${JSON.stringify(b)}`;
}

export function toolNamesOf(body) {
  const m = new Map();
  for (const msg of body?.messages ?? []) for (const b of Array.isArray(msg.content) ? msg.content : []) if (b?.type === "tool_use") m.set(b.id, b.name);
  return m;
}

/** Messages from `from` on, as readable text. */
export function renderMessages(body, from = 0, { max = Infinity } = {}) {
  const names = toolNamesOf(body);
  const msgs = body?.messages ?? [];
  const out = [];
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i];
    const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    out.push(`--- messages[${i}] ${m.role} ---`);
    for (const b of content) out.push(clip(blockText(b, names), max));
  }
  return out.join("\n");
}

/** Index of the first message after the last assistant message (what is new for the model). */
export function newFrom(body) {
  const msgs = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") return i + 1;
  return 0;
}

export function summary(rec) {
  const b = rec.body ?? {};
  const sys = (b.system ?? []).map((s, i) => `system[${i}] ${String(s.text ?? "").length} chars${s.cache_control ? ` cache_control=${JSON.stringify(s.cache_control)}` : ""}`);
  return [
    `request ${rec.id}  at ${rec.at}  from ${rec.origin ?? "?"}`,
    `model=${b.model}  effort=${b.output_config?.effort ?? "(default)"}  max_tokens=${b.max_tokens}  thinking=${b.thinking ? JSON.stringify(b.thinking) : "(adaptive default)"}  tail cache=${b.cache_control ? JSON.stringify(b.cache_control) : "none"}  betas=${rec.meta?.betas || "-"}`,
    `tools (${(b.tools ?? []).length}): ${(b.tools ?? []).map((t) => t.name).join(", ")}`,
    ...sys,
    `messages: ${(b.messages ?? []).length}`
  ].join("\n");
}
