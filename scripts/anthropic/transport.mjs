// Anthropic transport for the AI builder (spec 5.1): one Messages request over plain fetch, streamed (SSE),
// with abort / timeout / stall detection, retries, error mapping, usage + cost. PURE: no Foundry globals.
// The harness loop (T2) calls `streamMessage` once per model request and owns history, caps, limits and the log.
//
// Key handling: the key enters only through `buildMessagesRequest({ apiKey })` and leaves only in the `x-api-key`
// header of fetch. Every text this module returns or emits (errors, details, events) is redacted for the key.

import { SSEParser, MessageAccumulator, StreamProtocolError, kindForErrorType } from "./sse.mjs";
import { costOfUsage, normalizeUsage, addUsage, emptyUsage } from "./pricing.mjs";

export const REQUEST_TIMEOUT_MS = 10 * 60_000; // whole request incl. streaming (the harness has its own 5 min turn clock)
export const IDLE_TIMEOUT_MS = 90_000;        // no bytes at all for this long (pings included) -> "stalled"
export const MAX_RETRIES = 2;
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
export const MAX_RETRY_AFTER_S = 60;          // a longer server wait is surfaced to the GM instead of sleeping

/** Kinds: no-key, auth, billing, permission, model, too-long, rate-limit, overloaded, server, request, network,
 *  timeout, stalled, cancelled, bad-stream, bad-response. `retryable` tells the harness whether a later retry makes sense. */
export class TransportError extends Error {
  constructor(kind, detail = "", extra = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "TransportError";
    this.kind = kind;
    this.detail = detail;
    this.retryable = RETRYABLE.has(kind);
    Object.assign(this, extra);
  }
}

// "timeout" (whole request over its wall clock) is NOT retried: a second 10-minute wait is the harness's call.
const RETRYABLE = new Set(["rate-limit", "overloaded", "server", "network", "stalled"]);

/** HTTP status -> error kind. */
export function kindForStatus(status) {
  if (status === 400) return "request";
  if (status === 401) return "auth";
  if (status === 402) return "billing";
  if (status === 403) return "permission";
  if (status === 404) return "model";
  if (status === 408) return "server";
  if (status === 409) return "server";
  if (status === 413) return "too-long";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 500) return "server";
  return "request";
}

/** Strip the key (and anything key-shaped) from a text. `extra` = the module's own redact() when available. */
export function redactSecrets(text, secrets = [], extra = null) {
  let s = String(text ?? "");
  for (const k of secrets) if (k && String(k).length >= 4) s = s.split(String(k)).join("[redacted]");
  s = s
    .replace(/\bsk-ant-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/(x-api-key|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1$2[redacted]");
  if (typeof extra === "function") { try { s = String(extra(s)); } catch { /* keep ours */ } }
  return s;
}

function errorFromBody(raw) {
  try {
    const j = JSON.parse(raw);
    return { message: typeof j?.error?.message === "string" ? j.error.message : "", type: j?.error?.type ?? null, requestId: j?.request_id ?? null };
  } catch { return { message: String(raw ?? ""), type: null, requestId: null }; }
}

const header = (res, k) => { try { return res?.headers?.get?.(k) ?? null; } catch { return null; } };

/** B7 (bughunt-1): base backoff of a 429 without a readable retry-after (the browser may hide it: CORS expose list). */
export const RATE_LIMIT_BASE_MS = 10_000;

/**
 * Backoff delay for attempt n (1-based), honouring retry-after (seconds) when given. A rate limit without retry-after
 * backs off from RATE_LIMIT_BASE_MS (10 s, 20 s) instead of 1 s / 2 s, which would almost surely hit the same limit.
 */
export function retryDelay(attempt, retryAfterS, { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS, random = Math.random, kind = null } = {}) {
  if (Number.isFinite(retryAfterS) && retryAfterS >= 0) return Math.min(retryAfterS * 1000, MAX_RETRY_AFTER_S * 1000);
  if (kind === "rate-limit") baseMs = Math.max(baseMs, RATE_LIMIT_BASE_MS);
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.75 + 0.5 * random()));
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TransportError("cancelled"));
    const t = setTimeout(() => { signal?.removeEventListener?.("abort", on); resolve(); }, ms);
    const on = () => { clearTimeout(t); reject(new TransportError("cancelled")); };
    signal?.addEventListener?.("abort", on, { once: true });
  });
}

/**
 * Send one request and stream the answer.
 *
 * @param {object} req      from buildMessagesRequest (headers non-enumerable)
 * @param {object} o
 *   fetchImpl, signal (GM Stop), onEvent(evt) (normalised events, see sse.mjs + attempt/retry), redact (module redact),
 *   timeoutMs, idleTimeoutMs, maxRetries, retryMidStream (default true), sleep(ms, signal), random, now,
 *   defaultWriteTtl ("5m"|"1h") for unitemised cache writes.
 * @returns {Promise<TurnResult>} see `finish()` below.
 * Throws TransportError; `err.partial` = what streamed before the failure (never to be appended to history),
 * `err.attempts` = per-attempt records (usage seen so far, status).
 */
export async function streamMessage(req, o = {}) {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const key = req?.headers?.["x-api-key"] ?? "";
  const red = (t) => redactSecrets(t, [key], o.redact);
  const emit = (e) => { try { o.onEvent?.(e); } catch { /* UI errors never break the transport */ } };
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? defaultSleep;
  const maxRetries = o.maxRetries ?? MAX_RETRIES;
  const retryMidStream = o.retryMidStream !== false;
  const started = now();
  const attempts = [];

  if (!String(key).trim()) throw new TransportError("no-key");
  if (typeof fetchImpl !== "function") throw new TransportError("network", "fetch is not available");
  if (o.signal?.aborted) throw new TransportError("cancelled", "", { attempts });

  for (let attempt = 1; ; attempt++) {
    emit({ type: "attempt", attempt, model: req.body?.model ?? null });
    const rec = { attempt, status: null, kind: null, usage: null, model: req.body?.model ?? null, streamed: false, requestId: null };
    attempts.push(rec);
    try {
      const out = await oneAttempt(req, { ...o, fetchImpl, emit, red, rec, key, now });
      rec.status = rec.status ?? 200;
      return finish(out, { attempts, started, now, defaultWriteTtl: o.defaultWriteTtl, req });
    } catch (e0) {
      const e = e0 instanceof TransportError ? e0 : new TransportError("network", red(e0?.message ?? String(e0)));
      e.detail = red(e.detail ?? "");
      e.message = red(e.message ?? "");
      rec.kind = e.kind;
      e.attempts = attempts;
      e.durationMs = now() - started;
      // x-should-retry from the server overrides our own classification (as the official SDKs do).
      const wanted = e.shouldRetry === true || (e.retryable && e.shouldRetry !== false);
      const canRetry = wanted && attempt <= maxRetries && !o.signal?.aborted
        && (!rec.streamed || retryMidStream)
        && !(Number.isFinite(e.retryAfter) && e.retryAfter > MAX_RETRY_AFTER_S);
      if (!canRetry) throw e;
      const delayMs = retryDelay(attempt, e.retryAfter, { random: o.random, kind: e.kind });
      emit({ type: "retry", attempt, nextAttempt: attempt + 1, kind: e.kind, delayMs, discardPartial: !!rec.streamed });
      try { await sleep(delayMs, o.signal); }
      catch { throw new TransportError("cancelled", "", { attempts, partial: e.partial ?? null }); }
    }
  }
}

async function oneAttempt(req, o) {
  const { emit, red, rec, key } = o;
  const ctl = new AbortController();
  let why = null; // "cancelled" | "timeout" | "stalled"
  const abort = (reason) => { if (!why) { why = reason; try { ctl.abort(); } catch { /* ignore */ } } };
  const onUser = () => abort("cancelled");
  o.signal?.addEventListener?.("abort", onUser, { once: true });
  const wall = setTimeout(() => abort("timeout"), o.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const idleMs = o.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  let idle = setTimeout(() => abort("stalled"), idleMs);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => abort("stalled"), idleMs); };
  // A promise that rejects when we abort: reads are raced against it, so a body that ignores the signal cannot hang us.
  let rejectAbort;
  const aborted = new Promise((_, rej) => { rejectAbort = rej; });
  aborted.catch(() => {});
  ctl.signal.addEventListener("abort", () => rejectAbort(new Error("aborted")), { once: true });

  const acc = new MessageAccumulator(emit);
  const abortError = () => {
    const kind = why === "stalled" ? "stalled" : why === "timeout" ? "timeout" : "cancelled";
    return new TransportError(kind, "", { partial: acc.partial() });
  };
  let reader = null;
  try {
    let res;
    try {
      res = await Promise.race([
        o.fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal }),
        aborted
      ]);
    } catch (e) {
      if (why) throw abortError();
      throw new TransportError("network", red(e?.message ?? String(e)));
    }
    bump();
    rec.status = res.status;
    rec.requestId = header(res, "request-id");
    if (!res.ok) {
      let raw = "";
      try { raw = await Promise.race([res.text(), aborted]); } catch { if (why) throw abortError(); }
      const b = errorFromBody(raw);
      const ra = Number(header(res, "retry-after"));
      const xs = header(res, "x-should-retry");
      const kind = kindForErrorType(b.type) ?? kindForStatus(res.status);
      throw new TransportError(kind, red(String(b.message || raw).trim().slice(0, 400)), {
        status: res.status, errorType: b.type, requestId: b.requestId ?? rec.requestId,
        retryAfter: Number.isFinite(ra) && ra >= 0 && header(res, "retry-after") !== null ? ra : null,
        shouldRetry: xs === "true" ? true : xs === "false" ? false : undefined
      });
    }
    const ctype = String(header(res, "content-type") ?? "");
    if (!res.body || !/event-stream/i.test(ctype)) {
      // Non-streaming answer (stream:false, e.g. pre-warm) or a proxy that buffered: parse as one Message.
      let j;
      try { j = JSON.parse(await Promise.race([res.text(), aborted])); }
      catch { if (why) throw abortError(); throw new TransportError("bad-response", "response is neither SSE nor JSON"); }
      if (j?.type === "error") throw new TransportError(kindForErrorType(j.error?.type) ?? "server", red(String(j.error?.message ?? "").slice(0, 400)), { errorType: j.error?.type ?? null });
      if (!j || j.type !== "message") throw new TransportError("bad-response", "not a message");
      rec.usage = j.usage ?? null;
      return { message: j, inputErrors: new Map(), requestId: rec.requestId };
    }
    reader = res.body.getReader();
    const dec = new TextDecoder();
    const sse = new SSEParser();
    const handle = (evs) => {
      for (const ev of evs) {
        try { acc.handle(ev); }
        catch (e) {
          if (e instanceof StreamProtocolError) {
            throw new TransportError(e.kind, red(e.detail), { errorType: e.errorType ?? null, midStream: true, partial: acc.partial() });
          }
          throw e;
        }
        if (acc.message) rec.usage = acc.message.usage;
        if (acc.sawOutput) rec.streamed = true;
      }
    };
    for (;;) {
      let r;
      try { r = await Promise.race([reader.read(), aborted]); }
      catch (e) {
        if (why) throw abortError();
        throw new TransportError("network", red(`stream read failed: ${e?.message ?? e}`), { partial: acc.partial(), midStream: true });
      }
      if (r.done) break;
      bump();
      const text = typeof r.value === "string" ? r.value : dec.decode(r.value, { stream: true });
      handle(sse.push(text));
      if (acc.stopped) break;
    }
    if (!acc.stopped) handle(sse.push(dec.decode()).concat(sse.end()));
    if (!acc.stopped) throw new TransportError("network", "stream ended before message_stop", { partial: acc.partial(), midStream: true });
    return { message: acc.result(), inputErrors: acc.inputErrors, requestId: rec.requestId };
  } catch (e) {
    if (e instanceof TransportError && why && !["cancelled", "timeout", "stalled"].includes(e.kind)) throw abortError();
    if (e instanceof TransportError && e.partial === undefined) e.partial = acc.partial();
    throw e;
  } finally {
    clearTimeout(wall); clearTimeout(idle);
    o.signal?.removeEventListener?.("abort", onUser);
    if (reader) { try { await reader.cancel(); } catch { /* already closed */ } }
  }
}

/** Stop reason -> what the harness does next. */
export function classifyStop(message) {
  const r = message?.stop_reason ?? null;
  switch (r) {
    case "end_turn": case "stop_sequence": return "done";
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    case "refusal": return "refusal";
    case "pause_turn": return "pause_turn";            // re-send the same history (assistant appended) to resume
    case "model_context_window_exceeded": return "context";
    default: return r ? "other" : "unknown";
  }
}

/**
 * The assistant content to append to history, exactly as returned, with the documented fallback echo rule applied:
 * after a mid-output server-side fallback, thinking / redacted_thinking / tool_use blocks (and unpaired server tool
 * blocks) BEFORE the last `fallback` block are omitted; the fallback block itself stays where it was.
 * Deep copy; no transport-internal fields.
 */
export function historyContent(message) {
  const content = JSON.parse(JSON.stringify(Array.isArray(message?.content) ? message.content : []));
  let lastFb = -1;
  content.forEach((b, i) => { if (b?.type === "fallback") lastFb = i; });
  if (lastFb < 0) return content;
  const resultIds = new Set(content.filter((b) => /_tool_result$/.test(String(b?.type)) && b.tool_use_id).map((b) => b.tool_use_id));
  const known = new Set(["text", "fallback", "tool_result"]);
  return content.filter((b, i) => {
    if (i >= lastFb) return true;
    const t = String(b?.type);
    if (t === "server_tool_use") return resultIds.has(b.id);
    if (/_tool_result$/.test(t)) return true;
    return known.has(t);
  });
}

/** tool_use blocks of a final message, with `inputError` when the streamed JSON did not parse and `truncated` on max_tokens. */
export function toolUses(message, inputErrors = new Map()) {
  const truncated = message?.stop_reason === "max_tokens";
  return (message?.content ?? []).filter((b) => b?.type === "tool_use").map((b) => ({
    id: b.id, name: b.name, input: b.input ?? {},
    ...(inputErrors.get?.(b.id) ? { inputError: inputErrors.get(b.id) } : {}),
    ...(truncated ? { truncated: true } : {})
  }));
}

/** Plain text of a message (text blocks only, in order). */
export function messageText(message) {
  return (message?.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

function finish(out, { attempts, started, now, defaultWriteTtl, req }) {
  const message = out.message;
  const model = message.model ?? req.body?.model;
  const writeTtl = defaultWriteTtl ?? (req.body?.system?.some?.((b) => b.cache_control?.ttl === "1h") ? "1h" : "5m");
  const cost = costOfUsage(message.usage, model, { defaultWriteTtl: writeTtl });
  // Failed attempts that streamed output may be billed; their known usage is an upper-bound side note.
  let failedUsage = emptyUsage(); let failedUsd = 0;
  for (const a of attempts.slice(0, -1)) {
    if (!a.streamed || !a.usage) continue;
    const c = costOfUsage(a.usage, a.model, { defaultWriteTtl: writeTtl });
    failedUsage = addUsage(failedUsage, c.usage); failedUsd += c.usd;
  }
  const iters = Array.isArray(message.usage?.iterations) ? message.usage.iterations : [];
  const fallbackRan = iters.some((x) => x?.type === "fallback_message") || (message.content ?? []).some((b) => b?.type === "fallback");
  const hist = historyContent(message);
  return {
    message,                                  // the API message as streamed (content blocks complete)
    historyContent: hist,                     // append { role: "assistant", content: historyContent } as-is
    stop: classifyStop(message),
    stopDetails: message.stop_details ?? null,
    // B3 (bughunt-1): only the tool_use blocks that stay in the history are run and answered; a tool_use the fallback echo
    // rule dropped (before the last `fallback` block) would get an orphan tool_result -> 400 on every later request.
    toolUses: toolUses({ ...message, content: hist }, out.inputErrors),
    text: messageText(message),
    model,
    fallback: { ran: fallbackRan, model: fallbackRan ? model : null },
    usage: cost.usage,                        // normalised counters of the served request
    cost: { usd: cost.usd, estimated: cost.estimated, ...(cost.iterations ? { iterations: cost.iterations } : {}) },
    failedAttempts: { usage: failedUsage, usdUpperBound: Math.round(failedUsd * 1e8) / 1e8 },
    attempts: attempts.map((a) => ({ attempt: a.attempt, status: a.status, kind: a.kind, streamed: a.streamed, requestId: a.requestId })),
    requestId: out.requestId ?? null,
    messageId: message.id ?? null,
    durationMs: now() - started
  };
}

/** Non-streaming send (pre-warm). Same errors / retries; returns the same TurnResult shape. */
export function sendMessage(req, o = {}) {
  if (req?.body?.stream) throw new TransportError("request", "sendMessage needs a non-streaming request");
  return streamMessage(req, o);
}

/** Usage block of a turn result for logs: counters only (no text, no key). */
export function usageForLog(result) {
  return { ...normalizeUsage({}), ...(result?.usage ?? {}), usd: result?.cost?.usd ?? 0, estimated: !!result?.cost?.estimated };
}
