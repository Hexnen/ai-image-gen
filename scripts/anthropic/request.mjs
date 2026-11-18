// Request builder for the AI builder drawer (spec 5.1, 9.1): Messages API body with the prompt-cache layout.
// PURE: no Foundry globals (node-testable). Raw fetch shape, no SDK (module has no bundler / npm deps).
//
// Cache layout (render order tools -> system -> messages):
//   tools[]      static per pack version, sorted by name, fixed key order
//   system[0]    harness rules        (static, system-agnostic)
//   system[1]    pack rules digest    (static per pack version)
//   system[2]    catalogue index      (static per catalogue fingerprint)  + cache_control {ephemeral, ttl}  <- breakpoint 1
//   messages     sheet blocks + GM text + assistant / tool_result turns, append-only (never touched here)
//   top-level    cache_control {ephemeral}                                                            <- breakpoint 2 (automatic tail)
// The sheet snapshot is per-document data: it lives ONLY in user messages; a system block that looks like a sheet is refused.

import { ANTHROPIC_URL, ANTHROPIC_VERSION, EFFORTS } from "../enhance/anthropic.mjs";
import { requireUsableKey, isHeaderSafe, assertHeadersSafe } from "../key-check.mjs";

export { ANTHROPIC_URL, ANTHROPIC_VERSION, EFFORTS };
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_EFFORT = "medium";
export const MAX_TOKENS = 32000;
export const CACHE_TTLS = ["5m", "1h"];
export const DEFAULT_PREFIX_TTL = "1h";
export const DEFAULT_TAIL_TTL = "5m";
export const MAX_BREAKPOINTS = 4;

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`); same set as scripts/enhance/anthropic.mjs. */
export const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5-2"]);
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** `thinking.display` values we may send; undefined = leave thinking at the model default (adaptive). */
export const THINKING_DISPLAYS = ["summarized", "omitted"];

/** Local request error (never sent): kind "request", like a 400 we caught before spending money. */
export class RequestBuildError extends Error {
  constructor(detail) { super(`request: ${detail}`); this.name = "RequestBuildError"; this.kind = "request"; this.detail = detail; }
}

const SHEET_TAG = /<\s*(sheet|sheet_update|sheet_unchanged)\b/i;
const TOOL_KEY_ORDER = ["name", "description", "input_schema", "strict", "type", "cache_control"];

/** Tools in a deterministic form: sorted by name, top-level keys in a fixed order (inner schema kept as the pack wrote it). */
export function canonicalTools(tools) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw new RequestBuildError("tools must be an array");
  const seen = new Set();
  const out = tools.map((t) => {
    if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name) throw new RequestBuildError("every tool needs a name");
    if (seen.has(t.name)) throw new RequestBuildError(`duplicate tool name ${t.name}`);
    seen.add(t.name);
    if (t.cache_control) throw new RequestBuildError(`tool ${t.name}: cache_control is placed by the transport, not by tools`);
    const o = {};
    for (const k of TOOL_KEY_ORDER) if (t[k] !== undefined) o[k] = t[k];
    for (const k of Object.keys(t).sort()) if (!(k in o)) o[k] = t[k];
    return JSON.parse(JSON.stringify(o));
  });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * System blocks from the three static parts (strings). Empty parts are skipped; the LAST block carries breakpoint 1.
 * Throws when a part contains a sheet block (sheet data belongs in messages, spec 9.1).
 */
export function buildSystem({ rules = "", digest = "", catalog = "" } = {}, { ttl = DEFAULT_PREFIX_TTL } = {}) {
  const parts = [rules, digest, catalog].map((s) => String(s ?? ""));
  parts.forEach((s, i) => { if (SHEET_TAG.test(s)) throw new RequestBuildError(`system[${i}] contains a sheet block; sheet snapshots go into user messages only`); });
  const blocks = parts.filter((s) => s.trim()).map((text) => ({ type: "text", text }));
  if (!blocks.length) return [];
  blocks[blocks.length - 1].cache_control = cacheControl(ttl);
  return blocks;
}

function cacheControl(ttl) {
  if (!CACHE_TTLS.includes(ttl)) throw new RequestBuildError(`unknown cache ttl ${ttl}`);
  return ttl === "5m" ? { type: "ephemeral" } : { type: "ephemeral", ttl };
}

/** A GM user turn: sheet block (full / update / unchanged) FIRST, then the GM's words (spec 5.4). */
export function userTurn({ sheet = "", text = "" } = {}) {
  const content = [];
  if (String(sheet).trim()) content.push({ type: "text", text: String(sheet) });
  if (String(text).trim()) content.push({ type: "text", text: String(text) });
  if (!content.length) throw new RequestBuildError("empty user turn");
  return { role: "user", content };
}

/**
 * ONE user message answering every tool_use of the previous assistant message (parallel calls -> one message).
 * results: [{ toolUseId, content: string | blocks, isError? }]
 */
export function toolResultsTurn(results) {
  if (!Array.isArray(results) || !results.length) throw new RequestBuildError("no tool results");
  return {
    role: "user",
    content: results.map((r) => {
      if (!r?.toolUseId) throw new RequestBuildError("tool result without toolUseId");
      const b = { type: "tool_result", tool_use_id: String(r.toolUseId), content: typeof r.content === "string" ? r.content : r.content ?? "" };
      if (r.isError) b.is_error = true;
      return b;
    })
  };
}

function countMarkers(v) {
  if (!v || typeof v !== "object") return 0;
  if (Array.isArray(v)) return v.reduce((s, x) => s + countMarkers(x), 0);
  let c = v.cache_control ? 1 : 0;
  for (const [k, x] of Object.entries(v)) if (k !== "cache_control" && x && typeof x === "object") c += countMarkers(x);
  return c;
}

function checkMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new RequestBuildError("messages must be a non-empty array");
  if (messages[0]?.role !== "user") throw new RequestBuildError("the first message must be a user message");
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") throw new RequestBuildError("the last message must not be an assistant message (no prefill on these models)");
  // B2 (bughunt-1): the API refuses a message with empty content (400); refuse it here, before money is spent
  messages.forEach((m, i) => {
    const c = m?.content;
    if (Array.isArray(c) ? !c.length : !String(c ?? "").length) throw new RequestBuildError(`messages.${i}: empty content`);
  });
  const lastBlock = Array.isArray(last?.content) ? last.content[last.content.length - 1] : null;
  if (lastBlock?.cache_control) throw new RequestBuildError("no explicit cache_control on the last block (the automatic tail breakpoint owns it)");
  return countMarkers(messages);
}

/**
 * Build one Messages request. Returns { url, body, headers } where `headers` is NON-enumerable (JSON.stringify(req)
 * never prints the key) and `redactedHeaders()` gives a loggable copy.
 *
 * opts: apiKey, model, effort ("" = model default), maxTokens, tools, system {rules,digest,catalog}, messages,
 *       prefixTtl ("1h"|"5m"), tailTtl ("5m"|"1h"|null = no automatic tail), stream (default true),
 *       thinkingDisplay (undefined | "summarized" | "omitted"), fallbacks (default true when the model accepts it),
 *       betas (extra anthropic-beta values), toolChoice (only "auto"/"none"; forced choices 400 on these models).
 */
export function buildMessagesRequest(opts = {}) {
  const model = String(opts.model || DEFAULT_MODEL).trim();
  const effort = opts.effort === undefined ? DEFAULT_EFFORT : String(opts.effort ?? "");
  if (effort && !EFFORTS.includes(effort)) throw new RequestBuildError(`unknown effort ${effort}`);
  const prefixTtl = opts.prefixTtl ?? DEFAULT_PREFIX_TTL;
  const tailTtl = opts.tailTtl === undefined ? DEFAULT_TAIL_TTL : opts.tailTtl;
  if (tailTtl && prefixTtl === "5m" && tailTtl === "1h") throw new RequestBuildError("a 1 h tail after a 5 min prefix breaks the TTL ordering rule");
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 0) throw new RequestBuildError("maxTokens must be a non-negative integer");
  const stream = opts.stream !== false;
  if (stream && maxTokens === 0) throw new RequestBuildError("max_tokens 0 (pre-warm) cannot stream");

  const tools = canonicalTools(opts.tools);
  const system = buildSystem(opts.system, { ttl: prefixTtl });
  const msgMarkers = checkMessages(opts.messages);
  const markers = (system.length ? 1 : 0) + (tailTtl ? 1 : 0) + msgMarkers;
  if (markers > MAX_BREAKPOINTS) throw new RequestBuildError(`too many cache breakpoints (${markers} > ${MAX_BREAKPOINTS})`);

  const body = { model, max_tokens: maxTokens };
  if (stream) body.stream = true;
  if (tools.length) body.tools = tools;
  if (system.length) body.system = system;
  body.messages = opts.messages; // by reference: the transport never edits history
  if (opts.toolChoice && opts.toolChoice !== "auto") {
    if (opts.toolChoice !== "none") throw new RequestBuildError("forced tool_choice (any/tool) returns 400 on these models; use auto");
    body.tool_choice = { type: "none" };
  }
  if (opts.thinkingDisplay !== undefined && opts.thinkingDisplay !== null && opts.thinkingDisplay !== "") {
    if (!THINKING_DISPLAYS.includes(opts.thinkingDisplay)) throw new RequestBuildError(`unknown thinking display ${opts.thinkingDisplay}`);
    body.thinking = { type: "adaptive", display: opts.thinkingDisplay };
  }
  if (effort) body.output_config = { effort };
  if (tailTtl) body.cache_control = cacheControl(tailTtl);

  const betas = [...(opts.betas ?? [])].map(String).filter(Boolean);
  if ((opts.fallbacks ?? true) && FALLBACK_MODELS.has(model)) {
    body.fallbacks = "default";
    if (!betas.includes(FALLBACK_BETA)) betas.unshift(FALLBACK_BETA);
  }
  return finishRequest(body, opts.apiKey, betas);
}

/**
 * Pre-warm request (spec 9.1, O14): same tools / system / thinking / effort as real traffic, `max_tokens: 0`,
 * non-streaming (stream + max_tokens 0 is a 400), NO top-level cache_control (it would key the tail to the placeholder),
 * a placeholder user message. Writes breakpoint 1 only.
 */
export function buildPrewarmRequest(opts = {}) {
  return buildMessagesRequest({
    ...opts, maxTokens: 0, stream: false, tailTtl: null,
    messages: [{ role: "user", content: [{ type: "text", text: "warmup" }] }]
  });
}

function finishRequest(body, apiKey, betas) {
  // W6-B: strip invisible characters of a pasted key; a visible non-ASCII one (e.g. "…") throws ApiKeyError (kind
  // "bad-key", no key in the text) here, before any fetch. Betas are header values too: printable ASCII only.
  const key = requireUsableKey(apiKey);
  for (const b of betas) if (!isHeaderSafe(b) || b.includes(",")) throw new RequestBuildError("anthropic-beta values must be printable ASCII without commas");
  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    // Required for calls from a browser (CORS); the key lives only in the GM's client setting.
    "anthropic-dangerous-direct-browser-access": "true"
  };
  if (betas.length) headers["anthropic-beta"] = betas.join(",");
  assertHeadersSafe(headers);
  const req = { url: ANTHROPIC_URL, body };
  Object.defineProperty(req, "headers", { value: headers, enumerable: false });
  Object.defineProperty(req, "redactedHeaders", { value: () => ({ ...headers, "x-api-key": key ? "[redacted]" : "" }), enumerable: false });
  return req;
}

/**
 * The bytes that must stay identical between requests of one pack version for breakpoint 1 to hit:
 * model, tools, system, thinking, effort (cache_control markers stripped). For cache-stability tests and diagnostics.
 */
export function prefixBytes(req) {
  const b = req?.body ?? req ?? {};
  const strip = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "cache_control" ? undefined : x)));
  return JSON.stringify({ model: b.model, tools: strip(b.tools), system: strip(b.system), thinking: b.thinking ?? null, output_config: b.output_config ?? null });
}

/** FNV-1a 32-bit hex of a string (sync, pure): short fingerprint for logs and stability checks. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function prefixFingerprint(req) { return fnv1a(prefixBytes(req)); }
