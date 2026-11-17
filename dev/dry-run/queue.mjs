// Shared pieces of the dry-run relay and driver (dev only, node). A dry-run folder (always a scratch folder, never the
// repo or a Foundry Data folder) holds:
//   relay.json            { port, token, pid, startedAt }        written by relay.mjs
//   req/<id>.json         { id, at, origin, meta, body }          one model request, exactly as the real transport built it
//   ans/<id>.json         the stand-in's answer                    written by driver.mjs answer (validated)
//   cancelled/<id>.json   { at, why }                              the harness stopped waiting (Stop, cap, timeout)
// Ids are zero-padded sequence numbers ("0001"), so name order = time order.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAnswer } from "../../scripts/build/dry-transport.mjs";

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
  const d = { root, req: path.join(root, "req"), ans: path.join(root, "ans"), cancelled: path.join(root, "cancelled") };
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
