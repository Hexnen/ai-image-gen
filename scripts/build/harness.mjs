// AI builder harness loop (spec 5.2-5.4, 11; task T2). PURE: no Foundry globals. Everything outside (pack, key, settings,
// limits, call log, store, clock, fetch) comes in through `deps`, so node tests drive it with a scripted fake model.
//
// One Session per document (key `${worldId}:${docUuid}`). Session.send(text) runs ONE GM turn to completion:
//   user message = [tool_results for tool_uses left unanswered by an earlier stopped turn] + sheet block (5.4)
//                  + [proposal state marker `<proposal id="..." status="pending|applied|discarded"/>`, P1-H] + GM text
//   loop: caps -> estimate + per-message cost cap -> module limits reservation -> request (cached prefix + full history)
//         -> stream -> book real cost (limits + call log) -> append the assistant message EXACTLY as returned
//         -> tool_use: run every tool through the active pack's runTool (parallel), append ONE user message of results
//         -> repeat until end_turn / cap / Stop / error
//         -> W3-4 (D-5): a tool batch made ONLY of submit_* calls that all succeeded ends the turn (reason "submitted",
//            setting endTurnOnSubmit, default on) WITHOUT another request; its tool_result blocks are HELD in
//            record.heldToolResults (not in messages) and lead the NEXT GM message (held results, sheet, marker, text),
//            so the history never has two user messages in a row and stays a strict append-only prefix.
//         -> W5-B-1: unless an accepted submit's result has an actionable warning: then ONE more request (fix round, in the
//            limits) with the results appended; in it any batch with a real submit ends the turn whatever its result.
// The turn's `text` is the text of the assistant message that ended the turn without a tool call (W3-5); text written
// before a tool call is `progress[]` (and a "progress" transcript item), never part of `text`.
// History is append-only (spec 5.2): nothing appended is ever edited, reordered or removed; the store refuses edits.
// Nothing partial is appended: a refused, failed or stopped request leaves the history ending with the last user message
// (the next GM message then follows as a second user message, which the API merges). B4: the GM message itself is
// appended only with the first answer of its turn, so a turn with no answer at all appends nothing (summary.unsent); an
// answer with no content is never appended (B2, summary.emptyReply). A tool_use whose results were never
// sent (cap, Stop, max_tokens) is answered with is_error results at the START of the next GM message, so the history is
// always a valid request.
//
// Events (session.on(type, fn); "*" = all): see EVENT_TYPES. The drawer (T7) renders from them and from transcript().

import * as anthropic from "../anthropic/index.mjs";
import { checkApiKey } from "../key-check.mjs";
import { HARNESS_RULES } from "./harness-prompt.mjs";
import { decideSheetBlock, encodeHeld, decodeHeld } from "./sheet-sync.mjs";
import { docKey } from "./session-store.mjs";
import { t as tDefault } from "./harness-lang.mjs";
import { DEFAULT_CAPS, DEFAULT_END_TURN_ON_SUBMIT } from "./harness-defaults.mjs";

export const RECORD_VERSION = 1;

/** Defaults of the per-message caps (spec 5.3); the Foundry wiring reads the settings and passes them in. */
export { DEFAULT_CAPS, DEFAULT_END_TURN_ON_SUBMIT };
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
  "request-start",    // { request, estimateUsd, retry?, attempt?, discardPartial? } (B6: again with retry true when the transport retries)
  "stream",           // transport event (text / thinking / tool_input / tool_use / retry / fallback / usage ...)
  "assistant-message",// { index, stop, text, progress } progress: the text came before a tool call (W3-5)
  "request-end",      // { request, usage, usd, durationMs }
  "tool-start",       // { id, name, input }
  "tool-end",         // { id, name, ok, isError, summary }
  "proposal",         // { pending } successful submit
  "submit-failed",    // { id, name, input, errors, consecutive }
  "fix-round",        // { ids } W5-B-1: an accepted submit had actionable warnings; one more request so the model can fix them
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

/** Proposal states the drawer sets with session.markProposal (P1-H). */
export const PROPOSAL_STATUSES = Object.freeze(["pending", "applied", "discarded"]);
/** Proposal states kept per conversation (oldest dropped). */
export const MAX_PROPOSAL_STATES = 20;
/** Applied / discarded proposal objects kept so markProposal(id, "pending") can restore them (W6-D1; oldest dropped). */
export const MAX_SHELVED_PROPOSALS = 5;
const safeId = (s) => String(s ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "?";

/** `<proposal id="..." status="..."/>` lines for the states the model has not seen yet (null when none). */
export function proposalMarker(states) {
  const due = (states ?? []).filter((x) => x && x.status !== x.reported);
  if (!due.length) return null;
  return due.map((x) => `<proposal id="${safeId(x.id)}" status="${PROPOSAL_STATUSES.includes(x.status) ? x.status : "pending"}"/>`).join("\n");
}
const PROPOSAL_MARK = /^\s*(?:<proposal\s+id="[^"]*"\s+status="[^"]*"\s*\/>\s*)+$/i;   // a whole marker block, never GM text
const PROPOSAL_LINE = /<proposal\s+id="([^"]*)"\s+status="([^"]*)"\s*\/>/gi;

/** Submit tools (`submit_*`) feed the consecutive / identical invalid caps and set the pending proposal. */
export const isSubmitTool = (name) => /^submit_/.test(String(name ?? ""));
/** D-9 (W3-14): a submit_* call with input.dryRun true (or a result marked dryRun) is a check: never pending, never ends the
 *  turn, never counts towards the invalid-submit caps (what check_proposal was). */
export const isSubmitCall = (name, input, res) => isSubmitTool(name) && input?.dryRun !== true && res?.dryRun !== true;
/** W5-B-1: a hint that says there is nothing to do (generic rule for packs without `actionableWarnings`) */
const NO_FIX_HINT = /^(nothing to (fix|do)|information only|fine if)/i;
/**
 * W5-B-1: number of actionable warnings in an ACCEPTED real submit's result: the pack decides (`pack.actionableWarnings(name,
 * res)` -> array), else warnings with a hint that is not "nothing to do". Info entries never count; dry runs and refused
 * submits are 0.
 */
export function actionableCount(pack, x) {
  if (!x || x.isError || x.res?.ok !== true || !isSubmitCall(x.use?.name, x.use?.input, x.res)) return 0;
  try {
    if (typeof pack?.actionableWarnings === "function") { const a = pack.actionableWarnings(x.use.name, x.res); return Array.isArray(a) ? a.length : Number(a) || 0; }
  } catch { return 0; }
  return (Array.isArray(x.res.warnings) ? x.res.warnings : []).filter((w) => String(w?.hint ?? "").trim() && !NO_FIX_HINT.test(String(w.hint).trim())).length;
}

/** Stable signature of a failed submission's errors (identical-failure cap). */
export function errorSignature(res, fallback = "") {
  const errs = Array.isArray(res?.errors) ? res.errors : [];
  if (!errs.length) return `x:${fallback}`;
  return JSON.stringify(errs.map((e) => [String(e?.code ?? ""), String(e?.path ?? e?.opId ?? ""), String(e?.message ?? "")]).sort());
}

/**
 * B2: true when an assistant content array carries nothing the API accepts as content in a non-final message: no blocks,
 * or only thinking / redacted_thinking blocks and blank text blocks.
 */
export function isEmptyAnswer(content) {
  if (!Array.isArray(content) || !content.length) return true;
  return content.every((b) => !b || b.type === "thinking" || b.type === "redacted_thinking" || (b.type === "text" && !String(b.text ?? "").trim()));
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
    lastPromptTokens: 0, lastRequestAt: 0, prefixFp: null, sheet: null, snapshotFingerprint: null, unansweredReason: null,
    pendingProposal: null, lastRunId: null, options: {}, proposalStates: [], shelvedProposals: [],
    heldToolResults: null   // W3-4: tool_result blocks of a turn ended on submit, sent at the start of the next GM message
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
      endTurnOnSubmit: (s.endTurnOnSubmit ?? DEFAULT_END_TURN_ON_SUBMIT) !== false,
      maxRequests: Math.max(1, Math.floor(num(s.maxRequests, DEFAULT_CAPS.maxRequests))),
      maxToolCalls: Math.max(0, Math.floor(num(s.maxToolCalls, DEFAULT_CAPS.maxToolCalls))),
      maxInvalidSubmits: Math.max(1, Math.floor(num(s.maxInvalidSubmits, DEFAULT_CAPS.maxInvalidSubmits))),
      maxIdenticalInvalid: Math.max(2, Math.floor(num(s.maxIdenticalInvalid, DEFAULT_CAPS.maxIdenticalInvalid))),
      maxCostPerMessage: num(s.maxCostPerMessage, DEFAULT_CAPS.maxCostPerMessage),
      wallClockMs: Math.max(1, num(s.wallClockMs, DEFAULT_CAPS.wallClockMs))
    };
  };

  const ctx = { deps, tr, now, setTimer, clearTimer, t, redact: redactFn, warm, settings };

  // B5 (bughunt-1): one Session per key even when two openSession calls overlap (two drawers, macro + drawer, a fast
  // double render): the second call waits for the first one's store load instead of building a second record.
  const opening = new Map();
  async function openSession(doc) {
    const worldId = String(deps.worldId?.() ?? "world");
    const key = docKey(worldId, doc?.uuid);
    if (sessions.has(key)) { const s = sessions.get(key); s.doc = doc ?? s.doc; return s; }
    if (opening.has(key)) { const s = await opening.get(key); s.doc = doc ?? s.doc; return s; }
    const p = (async () => {
      let rec = null;
      try { rec = await deps.store?.load?.(key); } catch { rec = null; }
      if (!rec || rec.v !== RECORD_VERSION) rec = newRecord({ key, worldId, doc, pack: safePack(deps), settings: settings(), now: now() });
      const s = new Session(ctx, doc, rec);
      sessions.set(key, s);
      return s;
    })();
    opening.set(key, p);
    try { return await p; } finally { opening.delete(key); }
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
  #inflight = null; // B4: { text, at, tlAt } GM message of the running turn not appended yet
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

  /** The UI-set options in effect (a copy). */
  get options() { return plain(this.record.options ?? {}); }
  /**
   * UI-set options passed to the pack's snapshot / tools (rank, validation profile ...). Not history. Merged into the
   * current options; a key set to null (or undefined) is removed (back to the pack's default). Persists, then resolves
   * with the effective options: `await s.setOptions({ rank: "street" })` -> { rank: "street", profile: ... }.
   */
  async setOptions(o = {}) {
    const next = { ...(this.record.options ?? {}) };
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = plain(v);
    }
    this.record.options = next;
    await this.#persist();
    return plain(next);
  }
  /** Discard (GM) or apply done: clear the pending proposal. Prefer markProposal(id, status), which also tells the model. */
  clearPendingProposal() { this.record.pendingProposal = null; return this.#persist(); }

  /** Proposal states known to this conversation: [{ id, status, reported, at, turn }] oldest first (copies). */
  get proposals() { return plain(this.record.proposalStates ?? []); }
  /**
   * Proposal state set by the drawer (T7) or a stand-in: "applied" after a successful Apply, "discarded" on Discard,
   * "pending" again (e.g. after an Undo of that proposal). The model sees it as a marker
   * `<proposal id="..." status="..."/>` placed before the GM's text of the NEXT GM message (in messages only, never in
   * system[]: the cached prefix stays byte-identical). The first GM message after a submit always carries the marker;
   * later ones only when the status changed since the model last saw it.
   * applied / discarded of the pending proposal also clear it (no separate clearPendingProposal needed); "pending" of
   * such a proposal makes it the pending proposal again (`restored: true`) unless a newer proposal is pending (W6-D1).
   * opts.runId (with "applied") also stores the writer's run id for Undo (setLastRun).
   * -> { ok: true, id, status } | { ok: false, reason: "status" | "unknown" }
   */
  async markProposal(id, status, { runId } = {}) {
    if (!PROPOSAL_STATUSES.includes(status)) return { ok: false, reason: "status" };
    const pid = String(id ?? "");
    const list = (this.record.proposalStates ??= []);
    let e = list.find((x) => x.id === pid);
    if (!e && this.record.pendingProposal?.proposalId === pid) {
      e = { id: pid, status: "pending", reported: null, at: this.#h.now(), turn: this.record.pendingProposal.turn ?? null };
      list.push(e);
    }
    if (!e) return { ok: false, reason: "unknown" };
    e.status = status;
    const shelf = (this.record.shelvedProposals ??= []);
    if (status !== "pending" && this.record.pendingProposal?.proposalId === pid) {
      // W6-D1: keep the proposal object (input, summary) so "pending" again (Undo) can make it pending once more
      const i = shelf.findIndex((p) => p?.proposalId === pid);
      if (i >= 0) shelf.splice(i, 1);
      shelf.push(this.record.pendingProposal);
      if (shelf.length > MAX_SHELVED_PROPOSALS) shelf.splice(0, shelf.length - MAX_SHELVED_PROPOSALS);
      this.record.pendingProposal = null;
    }
    if (status === "pending" && !this.record.pendingProposal) {
      // W6-D1: an applied / discarded proposal marked pending again is the session's pending proposal again (the drawer
      // and a stand-in can Apply it once more). A newer proposal that is pending meanwhile stays the pending one.
      const i = shelf.findIndex((p) => p?.proposalId === pid);
      if (i >= 0) { this.record.pendingProposal = { ...shelf[i], restored: true }; shelf.splice(i, 1); }
    }
    if (status === "applied" && runId) this.record.lastRunId = String(runId);
    this.record.timeline.push({ at: this.#h.now(), msgIndex: this.record.messages.length, type: "proposal-status", proposalId: pid, status });
    // B5 (bughunt-1): never rejects. The state is set in memory (the drawer, the marker of the next GM message and the
    // next successful save carry it); a refused save is reported (saved: false + one storage notice), so a successful
    // Apply never looks like a failed write and the card never stays "pending".
    try { await this.#persist(); }
    catch (e) { this.#storageWarn(e); return { ok: true, id: pid, status, saved: false }; }
    return { ok: true, id: pid, status };
  }
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

  /**
   * Display items for the drawer, rebuilt from the stored history (survives reloads). B4: while the GM message of the
   * running turn is not in the history yet (it is appended with the first answer), it shows as { role: "gm", pending: true }.
   */
  transcript() {
    const f = this.#inflight;
    if (!f) return transcriptOf(this.record);
    const tl = [...(this.record.timeline ?? [])];
    tl.splice(Math.min(f.tlAt, tl.length), 0, { at: f.at, msgIndex: this.record.messages.length, type: "gm-pending", text: f.text });
    return transcriptOf({ ...this.record, timeline: tl });
  }

  // ------------------------------------------------------------------------------------------------ internals

  /**
   * Save the record (serialised). The returned promise rejects only for a history edit (HistoryEditError) of THIS save;
   * B5 (bughunt-1): the chain itself always continues, so one refused save never poisons the later ones.
   */
  #persist() {
    const h = this.#h;
    this.record.updatedAt = h.now();
    const snap = plain(this.record);
    const p = this.#saveChain.then(async () => {
      try { await h.deps.store?.save?.(snap); }
      catch (e) {
        if (e?.code === "history-edit") throw e;
        this.#storageWarn(e);
      }
    });
    this.#saveChain = p.catch(() => {});
    return p;
  }

  #storageWarn(e) {
    if (!this.storageOk) return;
    this.storageOk = false;
    this.#notice("storage", "warn", {}, e);
  }

  #notice(code, level = "info", data = {}, err = null) {
    const h = this.#h;
    const keyMap = {
      storage: "MAIG.Build.Storage", noKey: "MAIG.Build.NoKey", badKey: "MAIG.Build.BadKey", noPack: "MAIG.Build.NoPack", busy: "MAIG.Build.Busy",
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

  /**
   * Cost estimate of the next request (B4/B8, bughunt-1), by what is likely in the cache:
   *   static prefix (tools + system): read rate while its fingerprint was used (request or pre-warm) within the prefix TTL,
   *     else the prefix write rate (1 h or 5 min, the setting);
   *   history already sent: read rate while the last request is younger than the 5 min tail TTL, else the 5 min write rate;
   *   the new part of the history: 5 min write rate (the automatic tail breakpoint writes it);
   *   + EXPECTED_OUTPUT_TOKENS at the output rate.
   * Before: everything new at the highest input rate and the history always at the read rate, so a cold Fable first
   * message (~21k prefix tokens) went over the default 0.50 cap with nothing spent, and an expired history was under-priced.
   */
  #estimate(body, model, { fp = null, prefixTtl = anthropic.DEFAULT_PREFIX_TTL } = {}) {
    const h = this.#h;
    const tok = anthropic.estimateTokens;
    const prefix = tok(JSON.stringify({ t: body.tools, s: body.system }));
    const all = Math.max(prefix, tok(JSON.stringify({ t: body.tools, s: body.system, m: body.messages })));
    const hist = all - prefix;
    const { row: base } = anthropic.priceFor(model);
    const row = base.long && all > base.longAbove ? base.long : base;
    const now = h.now();
    const ttlMs = (ttl) => (ttl === "1h" ? 60 : 5) * 60_000;
    let warmAt = 0;
    try { warmAt = fp ? Number(h.warm.get?.(fp) ?? 0) || 0 : 0; } catch { warmAt = 0; }
    const prefixWarm = warmAt > 0 && now - warmAt < ttlMs(prefixTtl) - 60_000;
    const lastAt = Number(this.record.lastRequestAt ?? 0) || 0;
    const tailWarm = lastAt > 0 && now - lastAt < ttlMs(anthropic.DEFAULT_TAIL_TTL) - 15_000;
    const seenHist = tailWarm ? Math.min(hist, Math.max(0, (this.record.lastPromptTokens || 0) - prefix)) : 0;
    const prefixRate = prefixWarm ? row.cacheRead : (prefixTtl === "1h" ? row.cacheWrite1h : row.cacheWrite5m);
    const usd = (prefix * prefixRate + seenHist * row.cacheRead + (hist - seenHist) * row.cacheWrite5m + EXPECTED_OUTPUT_TOKENS * row.out) / 1e6;
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
   * { ok, reason, cap?, turn, requests, toolCalls, usage, usd, text, progress, stop, proposal, error? }
   * reason: done | submitted | cap | stopped | refusal | max_tokens | context | error | limit | busy | empty | no-key | bad-key | no-pack | history-full
   *   submitted (W3-4): a successful submit ended the turn without another request; ok true, text "" (the drawer shows
   *   the proposal's rationale), stop "tool_use".
   * text (W3-5): text of the assistant message that ended the turn without a tool call ("" when the last one called
   *   tools); progress: texts the model wrote before its tool calls in this turn, oldest first.
   * unsent (B4): the GM text when no answer came (refusal, error, cap, limit, Stop before the first answer): the message is
   *   NOT in the history (the next message does not carry it); the transcript shows it as { role: "gm", unsent: true }.
   * emptyReply (B2): the model ended its turn with no content; nothing was appended (reason done / max_tokens / context).
   */
  async send(text) {
    const h = this.#h;
    const msg = String(text ?? "").trim();
    const early = (reason, code, level = "warn", data = {}) => {
      const n = code ? this.#notice(code, level, data) : null;
      return { ok: false, reason, notice: n, turn: null, requests: 0, toolCalls: 0, usage: anthropic.emptyUsage(), usd: 0, text: "", progress: [], stop: null, proposal: null };
    };
    if (this.busy) return early("busy", "busy", "info");
    if (!msg) return early("empty", "empty", "info");
    const pack = safePack(h.deps);
    if (!hasPrompt(pack)) return early("no-pack", "noPack");
    let apiKey = "", keyOk = true;
    try { ({ key: apiKey, ok: keyOk } = checkApiKey(h.deps.getApiKey?.())); } catch { apiKey = ""; }
    if (!apiKey) return early("no-key", "noKey");
    // W6-B: a key with a visible non-ASCII character (e.g. "…") would make fetch throw; refuse before any request
    if (!keyOk) return early("bad-key", "badKey", "error");
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
    const said = []; // W3-5: { text, more } per assistant message of this turn; more = a tool call / pause followed
    let reason = null, cap = null, error = null, lastStop = null, emptyReply = false, capEst = null;
    // B4 (bughunt-1): the GM message is appended to the history only together with the first answer of the model. A turn
    // that ends with no answer (refusal, transport error after retries, cost cap, module limit, Stop) leaves the history,
    // the held tool results, the proposal marker state and the sheet state exactly as they were: nothing is appended,
    // so the history never gets consecutive user messages from failed sends, and a re-sent message is not doubled.
    const sheetBefore = { sheet: plain(this.record.sheet), fp: this.record.snapshotFingerprint ?? null };
    let gmMsg = null, committed = false, marker = null;
    this.#inflight = { text: msg, at: h.now(), tlAt: this.record.timeline.length };
    const commitGm = () => {
      if (committed || !gmMsg) return;
      committed = true;
      this.record.timeline.push({ at: this.#inflight?.at ?? h.now(), msgIndex: this.record.messages.length, type: "gm", text: msg });
      this.record.heldToolResults = null; // sent now (or stale): cleared in the same save as the append
      this.record.messages.push(plain(gmMsg));
      if (marker) for (const x of this.record.proposalStates ?? []) x.reported = x.status;
      this.#inflight = null;
      this.emit("user-message", { index: this.record.messages.length - 1 });
    };

    try {
      this.emit("turn-start", { turn: turn.turn, text: msg });
      if (s.model !== this.record.model || (s.effort ?? "") !== (this.record.effort ?? "")) {
        this.#notice("settingsDrift", "info", { model: this.record.model, effort: this.record.effort || "default" });
      }
      // static prefix (pack caches its own work); tools from the pack, harness rules static
      const sp = await pack.staticPrompt();
      const tools = pack.tools();
      const system = { rules: HARNESS_RULES, digest: String(sp?.rulesDigest ?? ""), catalog: String(sp?.catalogIndex ?? "") };

      // the GM message: results of the last assistant message's tool_uses first (results must lead the user message):
      // held real results of a turn that ended on submit (W3-4), is_error "Not run" for the rest; then sheet, then text
      const unanswered = unansweredToolUses(this.record.messages);
      const openIds = new Set(unanswered.map((b) => b.id));
      const held = (Array.isArray(this.record.heldToolResults) ? this.record.heldToolResults : []).filter((b) => b?.type === "tool_result" && openIds.has(b.tool_use_id));
      const heldIds = new Set(held.map((b) => b.tool_use_id));
      const pending = unanswered.filter((b) => !heldIds.has(b.id));
      // B9 (bughunt-1): the reason of the turn that left these tools unanswered (stored with them), not the last turn's
      const lastStopReason = this.record.unansweredReason ?? this.record.turns.at(-1)?.reason ?? "stopped";
      const content = plain(held);
      content.push(...pending.map((b) => ({
        type: "tool_result", tool_use_id: b.id, is_error: true,
        content: `Not run: the previous turn stopped (${lastStopReason}) before this tool ran. The GM has sent a new message.`
      })));
      const sheet = await this.#sheetBlock(pack);
      turn.sheet = sheet.kind;
      this.emit("sheet", { kind: sheet.kind, tokensEst: sheet.tokensEst ?? 0 });
      const gmBlocks = h.tr.userTurn({ sheet: sheet.text, text: msg }).content;
      // proposal state (P1-H): its own text block right before the GM's words (after the sheet block), messages only
      marker = proposalMarker(this.record.proposalStates);
      if (marker) gmBlocks.splice(gmBlocks.length - 1, 0, { type: "text", text: marker });
      content.push(...gmBlocks);
      gmMsg = { role: "user", content };

      let consecutiveInvalid = 0, identical = 0, lastSig = null;
      let fixRound = false;   // W5-B-1: at most one fix round per GM message
      for (;;) {
        if (signal.aborted) { reason = "stopped"; break; }
        if (turn.requests >= s.maxRequests) { reason = "cap"; cap = "requests"; break; }
        const req = h.tr.buildMessagesRequest({
          apiKey, model: this.record.model, effort: this.record.effort, tools, system,
          messages: committed ? this.record.messages : [...this.record.messages, plain(gmMsg)], prefixTtl: s.cacheTtl
        });
        const fp = h.tr.prefixFingerprint(req);
        if (this.record.prefixFp && this.record.prefixFp !== fp && turn.requests === 0) this.#notice("prefixChanged", "info");
        this.record.prefixFp = fp;
        const est = this.#estimate(req.body, this.record.model, { fp, prefixTtl: s.cacheTtl });
        if (s.maxCostPerMessage > 0 && turn.usd + est > s.maxCostPerMessage) { reason = "cap"; cap = "cost"; capEst = est; break; }
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
          // B6 (bughunt-1): a transport retry starts the same model request again; the partial text of the failed attempt
          // is never history, so "request-start" (retry: true) tells a live view to drop what it showed for that attempt.
          const reqNo = turn.requests;
          const onEvent = (e) => {
            this.emit("stream", e);
            if (e?.type === "retry") this.emit("request-start", { request: reqNo, estimateUsd: est, retry: true, attempt: e.nextAttempt ?? null, discardPartial: !!e.discardPartial });
          };
          r = await h.tr.streamMessage(req, { fetchImpl: h.deps.fetchImpl, signal, redact: h.deps.redact, onEvent });
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
        this.record.lastRequestAt = h.now();
        try { h.warm.set?.(fp, h.now()); } catch { /* ignore */ }
        this.emit("request-end", { request: turn.requests, usage: plain(r.usage), usd, durationMs: r.durationMs });
        lastStop = r.stop;

        if (r.stop === "refusal") { reason = "refusal"; break; } // partial refused output is never appended (P10)
        commitGm();   // B4: the GM message goes into the history with its first answer
        // B2 (bughunt-1): an answer with no content (end_turn with content [] or only thinking / blank text, typical right
        // after a tool_result) is never appended: an empty assistant message would make every later request a 400
        // ("all messages must have non-empty content") and the history cannot be edited. The history then ends with the
        // user message; the next GM message follows it (the API merges consecutive user messages).
        if (isEmptyAnswer(r.historyContent) && !(r.toolUses ?? []).length) {
          emptyReply = true;
          said.push({ text: "", more: false });
          await this.#persist();
          if (r.stop === "max_tokens") { reason = "max_tokens"; break; }
          if (r.stop === "context") { reason = "context"; break; }
          reason = "done"; break;
        }
        const more = r.stop === "pause_turn" || (r.stop === "tool_use" && (r.toolUses ?? []).length > 0);
        // B9: tool calls of this message are "interrupted" until answered (a reload mid-turn); the finally sets the reason
        this.record.unansweredReason = (r.toolUses ?? []).length ? "interrupted" : null;
        const aIdx = await this.#append({ role: "assistant", content: r.historyContent });
        said.push({ text: String(r.text ?? ""), more });
        this.emit("assistant-message", { index: aIdx, stop: r.stop, text: r.text, progress: more && !!r.text });
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
        const resultsTurn = h.tr.toolResultsTurn(results.map((x) => ({ toolUseId: x.use.id, content: x.content, isError: x.isError })));
        // W3-4 (D-5): only submit_* calls, all accepted -> the turn ends here; the results wait for the next GM message
        let endOnSubmit = s.endTurnOnSubmit && results.length > 0
          && results.every((x) => isSubmitCall(x.use.name, x.use.input, x.res) && !x.isError && x.res?.ok === true);
        // W5-B-1 (provisional): an accepted submit whose result carries an actionable warning keeps the turn open for ONE fix
        // round (the model sees the result now, not one GM message late); in that round any batch with a real submit ends the
        // turn whatever its result. The extra request counts in every limit; no fix round when the request / tool caps are
        // already reached (the turn then ends on the submit as before).
        if (s.endTurnOnSubmit && fixRound && results.some((x) => isSubmitCall(x.use.name, x.use.input, x.res))) endOnSubmit = true;
        else if (endOnSubmit && !fixRound && turn.requests < s.maxRequests && turn.toolCalls + uses.length < s.maxToolCalls
          && results.some((x) => actionableCount(pack, x) > 0)) {
          endOnSubmit = false;
          fixRound = true;
          turn.fixRound = true;
          this.emit("fix-round", { ids: results.map((x) => x.use.id) });
        }
        if (!endOnSubmit) await this.#append(resultsTurn);
        turn.toolCalls += uses.length;

        let stopForSubmit = null;
        for (const x of results) {
          if (!isSubmitCall(x.use.name, x.use.input, x.res)) continue;
          if (!x.isError && x.res?.ok === true) {
            consecutiveInvalid = 0; identical = 0; lastSig = null;
            const pendingProposal = {
              proposalId: String(x.res.proposalId ?? x.use.id), tool: x.use.name, toolUseId: x.use.id, input: plain(x.use.input),
              summary: plain(x.res.summary ?? null), warnings: plain(x.res.warnings ?? []), at: h.now(), turn: turn.turn
            };
            this.record.pendingProposal = pendingProposal;
            turn.proposalId = pendingProposal.proposalId;
            // proposal state for the marker of the next GM message (reported null: the next message always says "pending")
            const states = (this.record.proposalStates ??= []);
            const old = states.findIndex((p) => p.id === pendingProposal.proposalId);
            if (old >= 0) states.splice(old, 1);
            // an older proposal still pending is superseded by this one: the model knows, no marker for it
            for (const p of states) if (p.status === "pending") p.reported = "pending";
            states.push({ id: pendingProposal.proposalId, status: "pending", reported: null, at: h.now(), turn: turn.turn });
            if (states.length > MAX_PROPOSAL_STATES) states.splice(0, states.length - MAX_PROPOSAL_STATES);
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
        if (endOnSubmit) this.record.heldToolResults = plain(resultsTurn.content);
        await this.#persist();
        if (stopForSubmit) { reason = "cap"; cap = stopForSubmit; break; }
        if (endOnSubmit) { reason = "submitted"; break; }
      }
    } catch (e) {
      // B5 (bughunt-1): send never rejects; a refused save (another conversation took this document) is an error result
      reason = "error";
      error = { kind: e?.code === "history-edit" ? "history-edit" : (e?.kind ?? "internal"), detail: h.redact(e?.message ?? String(e)) };
      this.#notice("error", "error", { kind: error.kind, detail: error.detail || "-" });
    } finally {
      h.clearTimer(wall);
      if (reason === "stopped" && this.#abortReason === "wall") { reason = "cap"; cap = "wall"; }
      if (reason === "cap") {
        const data = cap === "requests" ? { max: s.maxRequests } : cap === "toolCalls" ? { max: s.maxToolCalls }
          : cap === "invalidSubmits" ? { max: s.maxInvalidSubmits } : cap === "identicalInvalid" ? { max: s.maxIdenticalInvalid }
          : cap === "cost" ? { max: s.maxCostPerMessage.toFixed(2), spent: turn.usd.toFixed(4), ...(capEst != null ? { estimate: capEst.toFixed(4) } : {}) } : cap === "wall" ? { minutes: Math.round(s.wallClockMs / 6000) / 10 } : {};
        this.#notice(`cap.${cap}`, "warn", data);
      } else if (["stopped", "refusal", "max_tokens", "context"].includes(reason)) {
        this.#notice(`stop.${reason}`, reason === "stopped" ? "info" : "warn");
      }
      if (!committed) {
        // B4: no answer came: the GM message is not history; held results, marker state and the sheet state stay for the
        // next message; the drawer shows the text as unsent (summary.unsent carries it back for the composer)
        this.record.sheet = sheetBefore.sheet;
        this.record.snapshotFingerprint = sheetBefore.fp;
        const at = this.#inflight?.at ?? h.now();
        const tlAt = Math.min(this.#inflight?.tlAt ?? this.record.timeline.length, this.record.timeline.length);
        this.record.timeline.splice(tlAt, 0, { at, msgIndex: this.record.messages.length, type: "gm-unsent", text: msg, reason: reason ?? "error" });
        this.#inflight = null;
      } else if (unansweredToolUses(this.record.messages).length) {
        this.record.unansweredReason = reason ?? "error";   // B9: the "Not run" text of the next GM message names it
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
    const last = said.at(-1);
    const finalText = last && !last.more ? last.text : "";
    const progress = said.filter((x) => x !== last || x.more).map((x) => x.text).filter((x) => x.trim());
    const summary = {
      ok: turn.reason === "done" || turn.reason === "submitted", reason: turn.reason, cap, turn: turn.turn, requests: turn.requests, toolCalls: turn.toolCalls,
      usage: plain(turn.usage), usd: turn.usd, text: finalText, progress, stop: lastStop, sheet: turn.sheet,
      proposal: turn.proposalId ? plain(this.record.pendingProposal) : null,
      ...(turn.fixRound ? { fixRound: true } : {}),
      ...(committed ? {} : { unsent: msg }),          // B4: no answer came; the GM message is not in the history
      ...(emptyReply ? { emptyReply: true } : {}),    // B2: the model ended without any content (nothing appended)
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
    let apiKey = "", keyOk = true;
    try { ({ key: apiKey, ok: keyOk } = checkApiKey(h.deps.getApiKey?.())); } catch { /* none */ }
    if (!apiKey) return done({ ok: false, skipped: "no-key" });
    if (!keyOk) return done({ ok: false, skipped: "bad-key" });
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
  // B4: "gm-unsent" (a GM message no answer came for: refusal, error, cap, limit, Stop before the first answer; not in the
  // history) and "gm-pending" (the running turn's message) show as GM items with unsent / pending true.
  const gmItem = (e) => ({ role: "gm", text: String(e.text ?? ""), ...(e.type === "gm-unsent" ? { unsent: true, reason: e.reason ?? null } : { pending: true }) });
  const flush = (i) => {
    while (tl.length && (tl[0].msgIndex ?? 0) <= i) {
      const e = tl.shift();
      if (e.type === "gm-unsent" || e.type === "gm-pending") items.push(gmItem(e));
      else if (e.type !== "gm") items.push({ role: e.type, ...e });
    }
  };
  (record?.messages ?? []).forEach((m, i) => {
    flush(i);
    const callsTools = m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_use");
    for (const b of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]) {
      if (m.role === "user") {
        if (b.type === "tool_result") {
          const tItem = tools.get(b.tool_use_id);
          if (tItem) { tItem.status = b.is_error ? "error" : "done"; }
        } else if (b.type === "text") {
          const s = String(b.text ?? "");
          const sm = /^\s*<(sheet_unchanged|sheet_update|sheet)\b/i.exec(s);
          if (sm) items.push({ role: "sheet", kind: sm[1] === "sheet" ? "full" : sm[1] === "sheet_update" ? "update" : "unchanged" });
          else if (PROPOSAL_MARK.test(s)) { for (const pm of s.matchAll(PROPOSAL_LINE)) items.push({ role: "proposal-marker", proposalId: pm[1], status: pm[2] }); }
          else items.push({ role: "gm", text: s });
        }
      } else if (m.role === "assistant") {
        // W3-5: text in a message that also calls tools is a progress note, not the answer
        if (b.type === "text" && b.text) items.push({ role: callsTools ? "progress" : "ai", text: String(b.text) });
        else if (b.type === "tool_use") { const it = { role: "tool", id: b.id, name: b.name, input: plain(b.input), status: "pending" }; tools.set(b.id, it); items.push(it); }
      }
    }
  });
  // W3-4: results held after a turn that ended on submit are not in messages yet; their tools did run
  for (const b of Array.isArray(record?.heldToolResults) ? record.heldToolResults : []) {
    const tItem = tools.get(b?.tool_use_id);
    if (tItem) tItem.status = b.is_error ? "error" : "done";
  }
  flush(Infinity);
  return items;
}
