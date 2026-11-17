// AI builder harness loop (spec 5.2-5.4, 11; task T2). PURE: no Foundry globals. Everything outside (pack, key, settings,
// limits, call log, store, clock, fetch) comes in through `deps`, so node tests drive it with a scripted fake model.
//
// One Session per document (key `${worldId}:${docUuid}`). Session.send(text) runs ONE GM turn to completion:
//   user message = [tool_results for tool_uses left unanswered by an earlier stopped turn] + sheet block (5.4) + GM text
//   loop: caps -> estimate + per-message cost cap -> module limits reservation -> request (cached prefix + full history)
//         -> stream -> book real cost (limits + call log) -> append the assistant message EXACTLY as returned
//         -> tool_use: run every tool through the active pack's runTool (parallel), append ONE user message of results
//         -> repeat until end_turn / cap / Stop / error
// History is append-only (spec 5.2): nothing appended is ever edited, reordered or removed; the store refuses edits.
// Nothing partial is appended: a refused, failed or stopped request leaves the history ending with the last user message
// (the next GM message then follows as a second user message, which the API merges). A tool_use whose results were never
// sent (cap, Stop, max_tokens) is answered with is_error results at the START of the next GM message, so the history is
// always a valid request.
//
// Events (session.on(type, fn); "*" = all): see EVENT_TYPES. The drawer (T7) renders from them and from transcript().

import * as anthropic from "../anthropic/index.mjs";
import { HARNESS_RULES } from "./harness-prompt.mjs";
import { decideSheetBlock, encodeHeld, decodeHeld } from "./sheet-sync.mjs";
import { docKey } from "./session-store.mjs";
import { t as tDefault } from "./harness-lang.mjs";
import { DEFAULT_CAPS } from "./harness-defaults.mjs";

export const RECORD_VERSION = 1;

/** Defaults of the per-message caps (spec 5.3); the Foundry wiring reads the settings and passes them in. */
export { DEFAULT_CAPS };
/** Conversation size above which a new conversation is required (spec 5.3, not a setting). */
export const HISTORY_TOKEN_CAP = 150_000;
/** Output tokens assumed for the cost estimate of the next request [E]; real cost is booked from usage. */
export const EXPECTED_OUTPUT_TOKENS = 4000;
/** Safety cut of one tool result sent to the model (packs cut their own results earlier). */
export const MAX_TOOL_RESULT_CHARS = 24_000;
/** A pre-warm is skipped while the prefix was written less than this long ago (spec O14). */
export const PREWARM_FRESH_MS = 55 * 60_000;

export const EVENT_TYPES = Object.freeze([
  "state",            // { busy }
  "turn-start",       // { turn, text }
  "sheet",            // { kind: full|update|unchanged|none, tokensEst }
  "user-message",     // { index }
  "request-start",    // { request, estimateUsd }
  "stream",           // transport event (text / thinking / tool_input / tool_use / retry / fallback / usage ...)
  "assistant-message",// { index, stop, text }
  "request-end",      // { request, usage, usd, durationMs }
  "tool-start",       // { id, name, input }
  "tool-end",         // { id, name, ok, isError, summary }
  "proposal",         // { pending } successful submit
  "submit-failed",    // { id, name, input, errors, consecutive }
  "notice",           // { code, level, message, data }
  "turn-end",         // TurnSummary
  "conversation",     // { conversationId } new conversation started
  "prewarm"           // { ok, skipped?, usd? }
]);

const nowIso = (ms) => new Date(ms).toISOString();
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function cut(s, max) {
  const str = String(s ?? "");
  return str.length > max ? `${str.slice(0, max)}\n(truncated, ${str.length} chars)` : str;
}

/** Model-facing text of a pack ToolResult: a string as is, `{ modelContent }` when the pack separates it, else compact JSON. */
export function toolResultContent(res) {
  if (typeof res === "string") return cut(res, MAX_TOOL_RESULT_CHARS);
  if (res && typeof res === "object" && typeof res.modelContent === "string") return cut(res.modelContent, MAX_TOOL_RESULT_CHARS);
  let s;
  try { s = JSON.stringify(res ?? null); } catch { s = String(res); }
  return cut(s, MAX_TOOL_RESULT_CHARS);
}

/** Submit tools (`submit_*`) feed the consecutive / identical invalid caps and set the pending proposal. */
export const isSubmitTool = (name) => /^submit_/.test(String(name ?? ""));

/** Stable signature of a failed submission's errors (identical-failure cap). */
export function errorSignature(res, fallback = "") {
  const errs = Array.isArray(res?.errors) ? res.errors : [];
  if (!errs.length) return `x:${fallback}`;
  return JSON.stringify(errs.map((e) => [String(e?.code ?? ""), String(e?.path ?? e?.opId ?? ""), String(e?.message ?? "")]).sort());
}

/** tool_use blocks of the last message when it is an assistant message whose tools were never answered. */
export function unansweredToolUses(messages) {
  const last = messages?.[messages.length - 1];
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
  return last.content.filter((b) => b?.type === "tool_use");
}

function newRecord({ key, worldId, doc, pack, settings, now }) {
  return {
    v: RECORD_VERSION, key, conversationId: randomId(), worldId, docUuid: doc?.uuid ?? null, docName: String(doc?.name ?? ""),
    pack: pack?.id ?? null, packVersion: pack?.version ?? null,
    model: settings.model || anthropic.DEFAULT_MODEL, effort: settings.effort ?? anthropic.DEFAULT_EFFORT,
    createdAt: now, updatedAt: now,
    messages: [], timeline: [], turns: [],
    usage: { ...anthropic.emptyUsage(), usd: 0, requests: 0 },
    lastPromptTokens: 0, prefixFp: null, sheet: null, snapshotFingerprint: null,
    pendingProposal: null, lastRunId: null, options: {}
  };
}

/**
 * createHarness(deps) -> { openSession(doc), getSession(doc|uuid), sessions }
 * deps:
 *   getPack(): pack | null                         active system pack (registry.getPack)
 *   getApiKey(): string                             Anthropic key (client setting); never stored anywhere by the harness
 *   settings(): { model, effort, cacheTtl, prewarm, ...caps }   read at every turn (caps) / conversation start (model, effort)
 *   limits: { reserve(usd) -> release() (throws when over a limit), record(usd) -> Promise }
 *   log(entry) -> Promise                           call log (kind "build"); errors swallowed
 *   store                                           createSessionStore(...)
 *   worldId(): string
 *   redact(text): string                            module redact (masks the key and token-like strings)
 *   fetchImpl, now(), setTimer(fn, ms) -> handle, clearTimer(handle), t(key, data), warmMap {get, set} (pre-warm marks)
 *   transport                                       override of ../anthropic/index.mjs (tests)
 */
export function createHarness(deps = {}) {
  const tr = { ...anthropic, ...(deps.transport ?? {}) };
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const t = deps.t ?? ((k, d) => tDefault(k, d));
  const redactFn = (s) => { let x = String(s ?? ""); try { x = deps.redact ? String(deps.redact(x)) : x; } catch { /* keep */ } return x; };
  const warm = deps.warmMap ?? new Map();
  const sessions = new Map();

  const settings = () => {
    let s = {};
    try { s = deps.settings?.() ?? {}; } catch { s = {}; }
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    return {
      model: s.model || anthropic.DEFAULT_MODEL,
      effort: s.effort ?? anthropic.DEFAULT_EFFORT,
      cacheTtl: anthropic.CACHE_TTLS.includes(s.cacheTtl) ? s.cacheTtl : anthropic.DEFAULT_PREFIX_TTL,
      prewarm: s.prewarm !== false,
      maxRequests: Math.max(1, Math.floor(num(s.maxRequests, DEFAULT_CAPS.maxRequests))),
      maxToolCalls: Math.max(0, Math.floor(num(s.maxToolCalls, DEFAULT_CAPS.maxToolCalls))),
      maxInvalidSubmits: Math.max(1, Math.floor(num(s.maxInvalidSubmits, DEFAULT_CAPS.maxInvalidSubmits))),
      maxIdenticalInvalid: Math.max(2, Math.floor(num(s.maxIdenticalInvalid, DEFAULT_CAPS.maxIdenticalInvalid))),
      maxCostPerMessage: num(s.maxCostPerMessage, DEFAULT_CAPS.maxCostPerMessage),
      wallClockMs: Math.max(1, num(s.wallClockMs, DEFAULT_CAPS.wallClockMs))
    };
  };

  const ctx = { deps, tr, now, setTimer, clearTimer, t, redact: redactFn, warm, settings };

  async function openSession(doc) {
    const worldId = String(deps.worldId?.() ?? "world");
    const key = docKey(worldId, doc?.uuid);
    if (sessions.has(key)) { const s = sessions.get(key); s.doc = doc ?? s.doc; return s; }
    let rec = null;
    try { rec = await deps.store?.load?.(key); } catch { rec = null; }
    if (!rec || rec.v !== RECORD_VERSION) rec = newRecord({ key, worldId, doc, pack: safePack(deps), settings: settings(), now: now() });
    const s = new Session(ctx, doc, rec);
    sessions.set(key, s);
    return s;
  }

  function getSession(docOrUuid) {
    const uuid = typeof docOrUuid === "string" ? docOrUuid : docOrUuid?.uuid;
    const worldId = String(deps.worldId?.() ?? "world");
    return sessions.get(docKey(worldId, uuid)) ?? null;
  }

  return { openSession, getSession, sessions, settings };
}

function safePack(deps) { try { return deps.getPack?.() ?? null; } catch { return null; } }
const hasPrompt = (p) => !!p && ["staticPrompt", "tools", "runTool"].every((f) => typeof p[f] === "function");
const hasSheet = (p) => !!p && typeof p.snapshot === "function";

export class Session {
  #h; #handlers = new Map(); #ctl = null; #abortReason = null; #saveChain = Promise.resolve();
  constructor(h, doc, record) {
    this.#h = h;
    this.doc = doc;
    this.record = record;
    this.busy = false;
    this.storageOk = true;
  }

  get key() { return this.record.key; }
  get conversationId() { return this.record.conversationId; }
  get pendingProposal() { return plain(this.record.pendingProposal); }
  get messages() { return plain(this.record.messages); }

  /** Subscribe; returns an unsubscribe function. type "*" receives (data, type) for every event. */
  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.#handlers.get(type)?.delete(fn);
  }
  emit(type, data) {
    for (const fn of [...(this.#handlers.get(type) ?? []), ...(this.#handlers.get("*") ?? [])]) {
      try { fn(data, type); } catch { /* a UI handler never breaks the loop */ }
    }
  }

  /** UI-set options passed to the pack's snapshot / tools (rank, validation profile ...). Not history. */
  setOptions(o = {}) { this.record.options = { ...(this.record.options ?? {}), ...plain(o) }; return this.#persist(); }
  /** Discard (GM) or apply done: clear the pending proposal. */
  clearPendingProposal() { this.record.pendingProposal = null; return this.#persist(); }
  /** The writer's run id after an Apply (for Undo in the drawer). */
  setLastRun(runId) { this.record.lastRunId = runId ?? null; return this.#persist(); }

  usage() {
    const last = this.record.turns.at(-1) ?? null;
    return { session: plain(this.record.usage), lastTurn: plain(last), cacheHitRatio: anthropic.cacheHitRatio(this.record.usage) };
  }

  /** Stop the running turn (GM's Stop button). */
  stop() {
    if (!this.busy || !this.#ctl) return false;
    this.#abortReason ??= "stopped";
    try { this.#ctl.abort(); } catch { /* ignore */ }
    return true;
  }

  /** Start a new conversation (the old one is archived by the store). Refused while a turn runs. */
  async newConversation() {
    if (this.busy) return { ok: false, reason: "busy" };
    const h = this.#h;
    const old = this.record;
    const rec = newRecord({ key: old.key, worldId: old.worldId, doc: this.doc, pack: safePack(h.deps), settings: h.settings(), now: h.now() });
    rec.options = plain(old.options ?? {});
    this.record = rec;
    try { await h.deps.store?.save?.(rec, { newConversation: true }); } catch (e) { this.#storageWarn(e); }
    this.emit("conversation", { conversationId: rec.conversationId });
    return { ok: true, conversationId: rec.conversationId };
  }

  /** Display items for the drawer, rebuilt from the stored history (survives reloads). */
  transcript() { return transcriptOf(this.record); }

  // ------------------------------------------------------------------------------------------------ internals

  #persist() {
    const h = this.#h;
    this.record.updatedAt = h.now();
    const snap = plain(this.record);
    this.#saveChain = this.#saveChain.then(async () => {
      try { await h.deps.store?.save?.(snap); }
      catch (e) {
        if (e?.code === "history-edit") throw e;
        this.#storageWarn(e);
      }
    });
    return this.#saveChain;
  }

  #storageWarn(e) {
    if (!this.storageOk) return;
    this.storageOk = false;
    this.#notice("storage", "warn", {}, e);
  }

  #notice(code, level = "info", data = {}, err = null) {
    const h = this.#h;
    const keyMap = {
      storage: "MAIG.Build.Storage", noKey: "MAIG.Build.NoKey", noPack: "MAIG.Build.NoPack", busy: "MAIG.Build.Busy",
      empty: "MAIG.Build.Empty", historyFull: "MAIG.Build.HistoryFull", limit: "MAIG.Build.Limit", error: "MAIG.Build.Error",
      sheetFailed: "MAIG.Build.SheetFailed", settingsDrift: "MAIG.Build.SettingsDrift", prefixChanged: "MAIG.Build.PrefixChanged",
      "stop.stopped": "MAIG.Build.Stop.user", "stop.refusal": "MAIG.Build.Stop.refusal", "stop.max_tokens": "MAIG.Build.Stop.maxTokens",
      "stop.context": "MAIG.Build.Stop.context",
      "cap.requests": "MAIG.Build.Cap.requests", "cap.toolCalls": "MAIG.Build.Cap.toolCalls", "cap.invalidSubmits": "MAIG.Build.Cap.invalidSubmits",
      "cap.identicalInvalid": "MAIG.Build.Cap.identicalInvalid", "cap.cost": "MAIG.Build.Cap.cost", "cap.wall": "MAIG.Build.Cap.wall"
    };
    const safeData = {};
    for (const [k, v] of Object.entries(data ?? {})) safeData[k] = typeof v === "string" ? h.redact(v) : v;
    let message = "";
    try { message = h.redact(h.t(keyMap[code] ?? code, safeData)); } catch { message = code; }
    const n = { code, level, message, data: safeData, ...(err ? { error: h.redact(err?.message ?? err) } : {}) };
    this.record.timeline.push({ at: h.now(), msgIndex: this.record.messages.length, type: "notice", ...n });
    this.emit("notice", n);
    return n;
  }

  async #append(msg) {
    this.record.messages.push(plain(msg));
    await this.#persist();
    return this.record.messages.length - 1;
  }

  async #sheetBlock(pack) {
    if (!hasSheet(pack)) return { kind: "none", text: "" };
    let snap;
    try { snap = await pack.snapshot(this.doc, { liveForm: true, ...(this.record.options ?? {}) }); }
    catch (e) { this.#notice("sheetFailed", "warn", { error: String(e?.message ?? e) }); return { kind: "none", text: "" }; }
    if (!snap || typeof snap.text !== "string" || !snap.text.trim()) return { kind: "none", text: "" };
    // The pack's own 5.4 decision (e.g. Invincible snapshot.mjs nextSheetBlock, richer update lines) wins when exposed;
    // the generic line-based rule of sheet-sync.mjs otherwise. `held` of the other implementation is never mixed in.
    const prev = this.record.sheet;
    let d = null, by = "core";
    if (typeof pack.nextSheetBlock === "function") {
      try {
        const r = await pack.nextSheetBlock(prev?.by === "pack" ? decodeHeld(prev.held) : null, snap);
        if (r && ["full", "update", "unchanged"].includes(r.kind) && typeof r.text === "string" && r.text.trim()) { d = r; by = "pack"; }
      } catch { d = null; }
    }
    if (!d) d = decideSheetBlock(prev?.by === "core" ? prev.held : null, snap, { doc: this.doc?.uuid ?? "" });
    this.record.sheet = { by, held: encodeHeld(d.held ?? null) };
    this.record.snapshotFingerprint = snap.fingerprint ?? null;
    return { kind: d.kind, text: d.text, tokensEst: anthropic.estimateTokens(d.text) };
  }

  /** Cost estimate of the next request: new tail at the uncached write rate + the already-sent part at the read rate + expected output. */
  #estimate(body, model) {
    const all = anthropic.estimateTokens(JSON.stringify({ t: body.tools, s: body.system, m: body.messages }));
    const seen = Math.min(all, this.record.lastPromptTokens || 0);
    const fresh = Math.max(0, all - seen);
    const { row } = anthropic.priceFor(model);
    const usd = anthropic.estimateMaxCost({ model, promptTokens: fresh, maxOutput: EXPECTED_OUTPUT_TOKENS }).usd + (seen * row.cacheRead) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
  }

  async #book(turn, { usage, usd, model, durationMs, status, error, request, stop, promptText }) {
    const h = this.#h;
    if (usd > 0) { try { await h.deps.limits?.record?.(usd); } catch { /* booking failure never breaks the turn */ } }
    turn.usd = Math.round((turn.usd + usd) * 1e8) / 1e8;
    turn.usage = anthropic.addUsage(turn.usage, usage);
    const u = this.record.usage;
    Object.assign(u, anthropic.addUsage(u, usage));
    u.usd = Math.round(((u.usd ?? 0) + usd) * 1e8) / 1e8;
    u.requests = (u.requests ?? 0) + 1;
    try {
      await h.deps.log?.({
        kind: "build", status, provider: "anthropic", model, route: `turn ${turn.turn} / request ${request}${stop ? ` / ${stop}` : ""}`,
        prompt: promptText ? h.redact(promptText) : undefined, cost: usd, costKind: "actual",
        tokens: { in: usage?.input ?? 0, out: usage?.output ?? 0 }, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0,
        docUuid: this.doc?.uuid, docName: this.doc?.name, durationMs, caller: "builder",
        error: error ? h.redact(error) : undefined
      });
    } catch { /* log failure never breaks the turn */ }
  }

  /** Cost of the attempts of a failed request that got as far as usage (input was processed and may be billed). */
  #failedCost(err, model) {
    let usd = 0, usage = anthropic.emptyUsage();
    for (const a of err?.attempts ?? []) {
      if (!a?.usage) continue;
      const c = anthropic.costOfUsage(a.usage, a.model || model);
      usd += c.usd; usage = anthropic.addUsage(usage, c.usage);
    }
    return { usd: Math.round(usd * 1e8) / 1e8, usage };
  }

  async #runTools(pack, uses, turn, signal) {
    const h = this.#h;
    let known;
    try { known = new Set((pack.tools() ?? []).map((x) => x?.name)); } catch { known = new Set(); }
    const view = Object.freeze({ id: this.record.conversationId, key: this.record.key, docUuid: this.doc?.uuid ?? null, options: plain(this.record.options ?? {}), pendingProposal: plain(this.record.pendingProposal) });
    const one = async (u) => {
      this.emit("tool-start", { id: u.id, name: u.name, input: plain(u.input) });
      let res = null, isError = false, content;
      if (u.inputError) { isError = true; content = `Tool input was not valid JSON (${h.redact(u.inputError)}). Send the call again with valid input.`; }
      else if (!known.has(u.name)) { isError = true; content = `Unknown tool "${String(u.name).slice(0, 64)}".`; }
      else {
        try {
          res = await pack.runTool(u.name, u.input ?? {}, { doc: this.doc, session: view, signal, options: view.options });
          content = toolResultContent(res);
          if (res && typeof res === "object" && res.isError === true) isError = true;
        } catch (e) {
          isError = true;
          content = `The tool failed: ${h.redact(String(e?.message ?? e)).slice(0, 500)}`;
        }
      }
      const ok = !isError && res?.ok !== false;
      this.emit("tool-end", { id: u.id, name: u.name, ok, isError, summary: res && typeof res === "object" ? plain(res.summary ?? null) : null });
      return { use: u, res, isError, content };
    };
    let abortedP;
    const aborted = new Promise((resolve) => {
      abortedP = () => resolve(null);
      if (signal.aborted) resolve(null); else signal.addEventListener("abort", abortedP, { once: true });
    });
    const all = await Promise.race([Promise.all(uses.map(one)), aborted]);
    signal.removeEventListener?.("abort", abortedP);
    return all; // null when stopped
  }

  /**
   * Run one GM turn. Resolves with a TurnSummary (never rejects for model/transport/limit problems):
   * { ok, reason, cap?, turn, requests, toolCalls, usage, usd, text, stop, proposal, error? }
   * reason: done | cap | stopped | refusal | max_tokens | context | error | limit | busy | empty | no-key | no-pack | history-full
   */
  async send(text) {
    const h = this.#h;
    const msg = String(text ?? "").trim();
    const early = (reason, code, level = "warn", data = {}) => {
      const n = code ? this.#notice(code, level, data) : null;
      return { ok: false, reason, notice: n, turn: null, requests: 0, toolCalls: 0, usage: anthropic.emptyUsage(), usd: 0, text: "", stop: null, proposal: null };
    };
    if (this.busy) return early("busy", "busy", "info");
    if (!msg) return early("empty", "empty", "info");
    const pack = safePack(h.deps);
    if (!hasPrompt(pack)) return early("no-pack", "noPack");
    let apiKey = "";
    try { apiKey = String(h.deps.getApiKey?.() ?? "").trim(); } catch { apiKey = ""; }
    if (!apiKey) return early("no-key", "noKey");
    const s = h.settings();
    if (!this.record.messages.length) { this.record.model = s.model; this.record.effort = s.effort; this.record.pack = pack.id; this.record.packVersion = pack.version; }
    const estHistory = (this.record.lastPromptTokens || 0) + anthropic.estimateTokens(msg);
    if (this.record.messages.length && estHistory > HISTORY_TOKEN_CAP) return early("history-full", "historyFull", "warn", { tokens: estHistory });

    this.busy = true;
    this.emit("state", { busy: true });
    this.#ctl = new AbortController();
    this.#abortReason = null;
    const signal = this.#ctl.signal;
    const wall = h.setTimer(() => { this.#abortReason ??= "wall"; try { this.#ctl?.abort(); } catch { /* ignore */ } }, s.wallClockMs);
    const turn = { turn: this.record.turns.length + 1, at: h.now(), requests: 0, toolCalls: 0, usage: anthropic.emptyUsage(), usd: 0, reason: null, cap: null, stop: null, sheet: null, proposalId: null };
    const out = { text: "" };
    let reason = null, cap = null, error = null, lastStop = null;

    try {
      this.emit("turn-start", { turn: turn.turn, text: msg });
      if (s.model !== this.record.model || (s.effort ?? "") !== (this.record.effort ?? "")) {
        this.#notice("settingsDrift", "info", { model: this.record.model, effort: this.record.effort || "default" });
      }
      // static prefix (pack caches its own work); tools from the pack, harness rules static
      const sp = await pack.staticPrompt();
      const tools = pack.tools();
      const system = { rules: HARNESS_RULES, digest: String(sp?.rulesDigest ?? ""), catalog: String(sp?.catalogIndex ?? "") };

      // the GM message: unanswered tool_uses first (results must lead the user message), then the sheet block, then the text
      const pending = unansweredToolUses(this.record.messages);
      const lastStopReason = this.record.turns.at(-1)?.reason ?? "stopped";
      const content = pending.map((b) => ({
        type: "tool_result", tool_use_id: b.id, is_error: true,
        content: `Not run: the previous turn stopped (${lastStopReason}) before this tool ran. The GM has sent a new message.`
      }));
      const sheet = await this.#sheetBlock(pack);
      turn.sheet = sheet.kind;
      this.emit("sheet", { kind: sheet.kind, tokensEst: sheet.tokensEst ?? 0 });
      content.push(...h.tr.userTurn({ sheet: sheet.text, text: msg }).content);
      this.record.timeline.push({ at: h.now(), msgIndex: this.record.messages.length, type: "gm", text: msg });
      const idx = await this.#append({ role: "user", content });
      this.emit("user-message", { index: idx });

      let consecutiveInvalid = 0, identical = 0, lastSig = null;
      for (;;) {
        if (signal.aborted) { reason = "stopped"; break; }
        if (turn.requests >= s.maxRequests) { reason = "cap"; cap = "requests"; break; }
        const req = h.tr.buildMessagesRequest({
          apiKey, model: this.record.model, effort: this.record.effort, tools, system,
          messages: this.record.messages, prefixTtl: s.cacheTtl
        });
        const fp = h.tr.prefixFingerprint(req);
        if (this.record.prefixFp && this.record.prefixFp !== fp && turn.requests === 0) this.#notice("prefixChanged", "info");
        this.record.prefixFp = fp;
        const est = this.#estimate(req.body, this.record.model);
        if (s.maxCostPerMessage > 0 && turn.usd + est > s.maxCostPerMessage) { reason = "cap"; cap = "cost"; break; }
        let release;
        try { release = h.deps.limits?.reserve ? h.deps.limits.reserve(est) : () => {}; }
        catch (e) {
          reason = "limit";
          this.#notice("limit", "warn", { message: String(e?.message ?? e) });
          try { await h.deps.log?.({ kind: "build", status: "blocked", provider: "anthropic", model: this.record.model, cost: est, costKind: "estimated", docUuid: this.doc?.uuid, docName: this.doc?.name, caller: "builder", error: h.redact(e?.message ?? e), durationMs: 0 }); } catch { /* ignore */ }
          break;
        }
        turn.requests++;
        this.emit("request-start", { request: turn.requests, estimateUsd: est });
        let r;
        try {
          r = await h.tr.streamMessage(req, { fetchImpl: h.deps.fetchImpl, signal, redact: h.deps.redact, onEvent: (e) => this.emit("stream", e) });
        } catch (e) {
          const fc = this.#failedCost(e, this.record.model);
          const cancelled = e?.kind === "cancelled" || signal.aborted;
          await this.#book(turn, { usage: fc.usage, usd: fc.usd, model: this.record.model, durationMs: e?.durationMs ?? 0, status: cancelled ? "cancelled" : "error", error: cancelled ? "cancelled" : `${e?.kind ?? "error"}: ${e?.detail ?? e?.message ?? e}`, request: turn.requests, promptText: turn.requests === 1 ? msg : "" });
          release();
          if (cancelled) { reason = "stopped"; break; }
          reason = "error";
          error = { kind: e?.kind ?? "error", detail: h.redact(e?.detail ?? e?.message ?? String(e)), retryAfter: e?.retryAfter ?? null };
          this.#notice("error", "error", { kind: error.kind, detail: error.detail || "-" });
          break;
        }
        const usd = Math.round(((r.cost?.usd ?? 0) + (r.failedAttempts?.usdUpperBound ?? 0)) * 1e8) / 1e8;
        await this.#book(turn, { usage: r.usage, usd, model: r.model, durationMs: r.durationMs, status: "ok", request: turn.requests, stop: r.stop, promptText: turn.requests === 1 ? msg : "" });
        release();
        const u = r.usage ?? {};
        this.record.lastPromptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        try { h.warm.set?.(fp, h.now()); } catch { /* ignore */ }
        this.emit("request-end", { request: turn.requests, usage: plain(r.usage), usd, durationMs: r.durationMs });
        lastStop = r.stop;

        if (r.stop === "refusal") { reason = "refusal"; break; } // partial refused output is never appended (P10)
        const aIdx = await this.#append({ role: "assistant", content: r.historyContent });
        if (r.text) out.text += (out.text ? "\n\n" : "") + r.text;
        this.emit("assistant-message", { index: aIdx, stop: r.stop, text: r.text });
        // pause_turn (only with server tools, which the builder does not use): the transport refuses an assistant-last
        // request (no prefill), so the harness appends a short user "Continue." and goes on (harness-notes H5).
        if (r.stop === "pause_turn") { await this.#append({ role: "user", content: [{ type: "text", text: "Continue." }] }); continue; }
        if (r.stop === "max_tokens") { reason = "max_tokens"; break; }
        if (r.stop === "context") { reason = "context"; break; }
        if (r.stop !== "tool_use") { reason = "done"; break; }

        const uses = r.toolUses ?? [];
        if (!uses.length) { reason = "done"; break; }
        if (turn.toolCalls + uses.length > s.maxToolCalls) { reason = "cap"; cap = "toolCalls"; break; }
        if (signal.aborted) { reason = "stopped"; break; }
        const results = await this.#runTools(pack, uses, turn, signal);
        if (!results || signal.aborted) { reason = "stopped"; break; } // unanswered: answered at the next GM message
        await this.#append(h.tr.toolResultsTurn(results.map((x) => ({ toolUseId: x.use.id, content: x.content, isError: x.isError }))));
        turn.toolCalls += uses.length;

        let stopForSubmit = null;
        for (const x of results) {
          if (!isSubmitTool(x.use.name)) continue;
          if (!x.isError && x.res?.ok === true) {
            consecutiveInvalid = 0; identical = 0; lastSig = null;
            const pendingProposal = {
              proposalId: String(x.res.proposalId ?? x.use.id), tool: x.use.name, toolUseId: x.use.id, input: plain(x.use.input),
              summary: plain(x.res.summary ?? null), warnings: plain(x.res.warnings ?? []), at: h.now(), turn: turn.turn
            };
            this.record.pendingProposal = pendingProposal;
            turn.proposalId = pendingProposal.proposalId;
            this.record.timeline.push({ at: h.now(), msgIndex: this.record.messages.length, type: "proposal", proposalId: pendingProposal.proposalId });
            this.emit("proposal", { pending: plain(pendingProposal) });
          } else {
            consecutiveInvalid++;
            const sig = errorSignature(x.res, x.isError ? x.content : "");
            identical = sig === lastSig ? identical + 1 : 1;
            lastSig = sig;
            const errors = plain(Array.isArray(x.res?.errors) ? x.res.errors : [{ code: "tool.error", message: x.content }]);
            this.record.lastFailedSubmit = { tool: x.use.name, input: plain(x.use.input), errors, at: h.now() };
            this.emit("submit-failed", { id: x.use.id, name: x.use.name, input: plain(x.use.input), errors, consecutive: consecutiveInvalid });
            if (identical >= s.maxIdenticalInvalid) stopForSubmit = "identicalInvalid";
            else if (consecutiveInvalid >= s.maxInvalidSubmits) stopForSubmit ??= "invalidSubmits";
          }
        }
        await this.#persist();
        if (stopForSubmit) { reason = "cap"; cap = stopForSubmit; break; }
      }
    } catch (e) {
      if (e?.code === "history-edit") throw e;
      reason = "error";
      error = { kind: e?.kind ?? "internal", detail: h.redact(e?.message ?? String(e)) };
      this.#notice("error", "error", { kind: error.kind, detail: error.detail || "-" });
    } finally {
      h.clearTimer(wall);
      if (reason === "stopped" && this.#abortReason === "wall") { reason = "cap"; cap = "wall"; }
      if (reason === "cap") {
        const data = cap === "requests" ? { max: s.maxRequests } : cap === "toolCalls" ? { max: s.maxToolCalls }
          : cap === "invalidSubmits" ? { max: s.maxInvalidSubmits } : cap === "identicalInvalid" ? { max: s.maxIdenticalInvalid }
          : cap === "cost" ? { max: s.maxCostPerMessage.toFixed(2), spent: turn.usd.toFixed(4) } : cap === "wall" ? { minutes: Math.round(s.wallClockMs / 6000) / 10 } : {};
        this.#notice(`cap.${cap}`, "warn", data);
      } else if (["stopped", "refusal", "max_tokens", "context"].includes(reason)) {
        this.#notice(`stop.${reason}`, reason === "stopped" ? "info" : "warn");
      }
      turn.reason = reason ?? "error";
      turn.cap = cap;
      turn.stop = lastStop;
      turn.durationMs = h.now() - turn.at;
      this.record.turns.push(plain(turn));
      if (this.record.turns.length > 500) this.record.turns.splice(0, this.record.turns.length - 500); // bookkeeping only, not history
      this.busy = false;
      this.#ctl = null;
      try { await this.#persist(); } catch { /* reported */ }
      this.emit("state", { busy: false });
    }
    const summary = {
      ok: turn.reason === "done", reason: turn.reason, cap, turn: turn.turn, requests: turn.requests, toolCalls: turn.toolCalls,
      usage: plain(turn.usage), usd: turn.usd, text: out.text, stop: lastStop, sheet: turn.sheet,
      proposal: turn.proposalId ? plain(this.record.pendingProposal) : null,
      ...(error ? { error } : {}),
      ...(cap === "invalidSubmits" || cap === "identicalInvalid" ? { lastDraft: plain(this.record.lastFailedSubmit ?? null) } : {})
    };
    this.emit("turn-end", summary);
    return summary;
  }

  /** Pre-warm breakpoint 1 (spec 9.1, O14): one max_tokens:0 request, skipped when warm (< 55 min) or disabled. */
  async prewarm({ force = false } = {}) {
    const h = this.#h;
    const s = h.settings();
    const done = (r) => { this.emit("prewarm", r); return r; };
    if (!s.prewarm && !force) return done({ ok: true, skipped: "disabled" });
    if (this.busy) return done({ ok: true, skipped: "busy" });
    const pack = safePack(h.deps);
    if (!hasPrompt(pack)) return done({ ok: false, skipped: "no-pack" });
    let apiKey = "";
    try { apiKey = String(h.deps.getApiKey?.() ?? "").trim(); } catch { /* none */ }
    if (!apiKey) return done({ ok: false, skipped: "no-key" });
    const model = this.record.messages.length ? this.record.model : s.model;
    const effort = this.record.messages.length ? this.record.effort : s.effort;
    try {
      const sp = await pack.staticPrompt();
      const req = h.tr.buildPrewarmRequest({ apiKey, model, effort, tools: pack.tools(), system: { rules: HARNESS_RULES, digest: String(sp?.rulesDigest ?? ""), catalog: String(sp?.catalogIndex ?? "") }, prefixTtl: s.cacheTtl });
      const fp = h.tr.prefixFingerprint(req);
      const at = Number(h.warm.get?.(fp) ?? 0);
      if (!force && at && h.now() - at < PREWARM_FRESH_MS) return done({ ok: true, skipped: "warm" });
      const est = anthropic.estimateMaxCost({ model, promptTokens: anthropic.estimateTokens(JSON.stringify(req.body)), maxOutput: 0 }).usd;
      let release;
      try { release = h.deps.limits?.reserve ? h.deps.limits.reserve(est) : () => {}; }
      catch (e) { return done({ ok: false, skipped: "limit", error: h.redact(e?.message ?? e) }); }
      try {
        const r = await h.tr.sendMessage(req, { fetchImpl: h.deps.fetchImpl, redact: h.deps.redact });
        const usd = r.cost?.usd ?? 0;
        if (usd > 0) { try { await h.deps.limits?.record?.(usd); } catch { /* ignore */ } }
        try {
          await h.deps.log?.({ kind: "build-prewarm", status: "ok", provider: "anthropic", model: r.model, cost: usd, costKind: "actual", tokens: { in: r.usage?.input ?? 0, out: r.usage?.output ?? 0 }, cacheRead: r.usage?.cacheRead ?? 0, cacheWrite: r.usage?.cacheWrite ?? 0, docUuid: this.doc?.uuid, docName: this.doc?.name, durationMs: r.durationMs, caller: "builder" });
        } catch { /* ignore */ }
        try { h.warm.set?.(fp, h.now()); } catch { /* ignore */ }
        return done({ ok: true, usd, usage: plain(r.usage) });
      } finally { release(); }
    } catch (e) {
      return done({ ok: false, error: h.redact(e?.detail ?? e?.message ?? String(e)), kind: e?.kind ?? "error" });
    }
  }
}

/**
 * Drawer display items from a stored record: GM texts, AI texts, tool chips (with result state), sheet markers, notices,
 * proposal markers. Thinking blocks and raw JSON results are not shown (spec 4.2).
 */
export function transcriptOf(record) {
  const items = [];
  const tools = new Map();
  const tl = [...(record?.timeline ?? [])];
  const flush = (i) => { while (tl.length && (tl[0].msgIndex ?? 0) <= i) { const e = tl.shift(); if (e.type !== "gm") items.push({ role: e.type, ...e }); } };
  (record?.messages ?? []).forEach((m, i) => {
    flush(i);
    for (const b of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]) {
      if (m.role === "user") {
        if (b.type === "tool_result") {
          const tItem = tools.get(b.tool_use_id);
          if (tItem) { tItem.status = b.is_error ? "error" : "done"; }
        } else if (b.type === "text") {
          const s = String(b.text ?? "");
          const sm = /^\s*<(sheet_unchanged|sheet_update|sheet)\b/i.exec(s);
          if (sm) items.push({ role: "sheet", kind: sm[1] === "sheet" ? "full" : sm[1] === "sheet_update" ? "update" : "unchanged" });
          else items.push({ role: "gm", text: s });
        }
      } else if (m.role === "assistant") {
        if (b.type === "text" && b.text) items.push({ role: "ai", text: String(b.text) });
        else if (b.type === "tool_use") { const it = { role: "tool", id: b.id, name: b.name, input: plain(b.input), status: "pending" }; tools.set(b.id, it); items.push(it); }
      }
    }
  });
  flush(Infinity);
  return items;
}
