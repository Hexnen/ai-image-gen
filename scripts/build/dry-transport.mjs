// DRY transport of the AI builder (dev only): a stand-in model (a Claude Code subagent driving dev/dry-run/driver.mjs)
// answers the harness's requests instead of api.anthropic.com. No key, no network call to Anthropic.
//
// What it swaps: ONLY the `fetch` the real transport (scripts/anthropic/transport.mjs streamMessage) calls. The real
// request builder, SSE parser, accumulator, cost, harness loop, caps, module limits and call log all run unchanged.
// The dry fetch takes the exact request body the real transport would POST, hands it to a local relay
// (dev/dry-run/relay.mjs, 127.0.0.1 only, token), waits for the stand-in's answer (keeping the stream alive with SSE
// pings, as the API does) and streams that answer back as a real Messages SSE stream with simulated usage.
//
// Enabling (all must hold, checked once when the builder attaches; reload the page after changing it):
//   - the user is a GM (builder-api only attaches for GMs; checked again here);
//   - the page is served from a loopback host on a LANE port (30001-30005, 30008, 30020), never port 30000;
//   - this browser origin's localStorage has DRY_STORAGE_KEY = JSON { relay: "http://127.0.0.1:<port>", token }.
// localStorage is per origin, so a value set on a lane page never exists on the owner's http://localhost:30000; the
// port guard refuses it there anyway. Nothing is written to settings or worlds by this file; the API key is an
// in-memory placeholder that the dry fetch insists on (a real-looking key makes it refuse).
// PURE: no Foundry globals at import; Foundry pieces come in as arguments (node-testable).

import { ANTHROPIC_URL, estimateTokens, streamMessage as realStreamMessage } from "../anthropic/index.mjs";

export const DRY_STORAGE_KEY = "moinens-ai-gen.build.dry";
export const DRY_API_KEY = "dry-run-placeholder-not-a-key";
export const OWNER_PORT = 30000;
export const LANE_PORTS = Object.freeze([30001, 30002, 30003, 30004, 30005, 30008, 30020]);
export const DRY_PROVIDER = "anthropic (dry)";
/** Defaults of the dry clocks: a stand-in model is far slower than the API (reading files, writing JSON by hand). */
export const DRY_DEFAULTS = Object.freeze({ wallMinutes: 60, requestMinutes: 30, pingMs: 15_000, pollMs: 750 });

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Decide whether dry mode is on. Returns { on: true, config } or { on: false, reason }.
 * reason: off | not-gm | not-local | not-lane | bad-config | bad-relay | bad-token
 */
export function dryConfig({ location, storage, isGM } = {}) {
  let raw = null;
  try { raw = storage?.getItem?.(DRY_STORAGE_KEY) ?? null; } catch { raw = null; }
  if (raw == null || raw === "") return { on: false, reason: "off" };
  if (!isGM) return { on: false, reason: "not-gm" };
  const host = String(location?.hostname ?? "");
  const port = Number(location?.port || (location?.protocol === "https:" ? 443 : 80));
  if (!LOOPBACK.test(host)) return { on: false, reason: "not-local" };
  if (port === OWNER_PORT || !LANE_PORTS.includes(port)) return { on: false, reason: "not-lane" };
  let c;
  try { c = JSON.parse(raw); } catch { return { on: false, reason: "bad-config" }; }
  if (!c || typeof c !== "object") return { on: false, reason: "bad-config" };
  let relay;
  try { relay = new URL(String(c.relay ?? "")); } catch { return { on: false, reason: "bad-relay" }; }
  const rport = Number(relay.port);
  if (relay.protocol !== "http:" || !LOOPBACK.test(relay.hostname) || !rport || rport === OWNER_PORT || LANE_PORTS.includes(rport)) return { on: false, reason: "bad-relay" };
  const token = String(c.token ?? "");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return { on: false, reason: "bad-token" };
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    on: true,
    config: {
      relay: relay.origin, token,
      wallMinutes: num(c.wallMinutes, DRY_DEFAULTS.wallMinutes, 1, 240),
      requestMinutes: num(c.requestMinutes, DRY_DEFAULTS.requestMinutes, 1, 120)
    }
  };
}

// ------------------------------------------------------------------------------------------------ usage simulation

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Simulated prompt-cache usage [E] (chars / 3.5 per token, like the module's own estimator):
 *   prefix (model + tools + system): written at its TTL the first time this page sees it, read afterwards;
 *   messages: the part identical to the previous request's messages is read, the new tail is written (automatic tail
 *   breakpoint, 5 min); without the tail breakpoint (pre-warm) the messages are plain input.
 * Cache expiry is not simulated (state lives as long as the page). Real numbers come only from the real API (T8).
 */
export function createUsageSim() {
  const st = { prefix: null, msgs: "" };
  return {
    state: st,
    usage(body, outputContent = []) {
      const prefixStr = JSON.stringify({ m: body?.model, t: body?.tools ?? [], s: body?.system ?? [] });
      const prefixTok = estimateTokens(prefixStr);
      const ttl1h = Array.isArray(body?.system) && body.system.some((b) => b?.cache_control?.ttl === "1h");
      const msgsStr = JSON.stringify(body?.messages ?? []);
      let read = 0, w1h = 0, w5m = 0, input = 0;
      if (st.prefix === prefixStr) read += prefixTok;
      else { if (ttl1h) w1h += prefixTok; else w5m += prefixTok; }
      if (body?.cache_control) {
        const same = st.prefix === prefixStr ? commonPrefix(st.msgs, msgsStr) : 0;
        read += estimateTokens(msgsStr.slice(0, same));
        w5m += estimateTokens(msgsStr.slice(same));
        st.msgs = msgsStr;
      } else {
        input += estimateTokens(msgsStr);
      }
      st.prefix = prefixStr;
      const output = Array.isArray(outputContent) && outputContent.length ? Math.max(1, estimateTokens(JSON.stringify(outputContent))) : 0;
      return {
        input_tokens: input,
        cache_creation_input_tokens: w1h + w5m,
        cache_read_input_tokens: read,
        cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h },
        output_tokens: output
      };
    }
  };
}

// ------------------------------------------------------------------------------------------------ answer -> SSE

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Split a string into a few chunks (deltas), so the real accumulator sees a realistic multi-delta stream. */
function pieces(s, n = 3) {
  const str = String(s ?? "");
  if (str.length < 2 * n) return [str];
  const size = Math.ceil(str.length / n);
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

/**
 * Normalise a stand-in answer: { content: [text | tool_use blocks], stop_reason?, usage? } or { error: { type, message } }.
 * Throws an Error with a readable message when the shape is wrong (the relay/driver check this too).
 */
export function normalizeAnswer(answer) {
  if (!answer || typeof answer !== "object") throw new Error("answer must be an object");
  if (answer.error) {
    const e = answer.error;
    if (typeof e !== "object" || typeof e.type !== "string") throw new Error("error must be { type, message }");
    return { error: { type: e.type, message: String(e.message ?? e.type), ...(Number.isInteger(e.status) ? { status: e.status } : {}) } };
  }
  if (!Array.isArray(answer.content)) throw new Error("answer.content must be an array of blocks");
  const content = answer.content.map((b, i) => {
    if (b?.type === "text") return { type: "text", text: String(b.text ?? "") };
    if (b?.type === "tool_use") {
      if (typeof b.id !== "string" || !b.id) throw new Error(`content[${i}]: tool_use needs an id`);
      if (typeof b.name !== "string" || !b.name) throw new Error(`content[${i}]: tool_use needs a name`);
      if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw new Error(`content[${i}]: tool_use input must be an object`);
      return { type: "tool_use", id: b.id, name: b.name, input: JSON.parse(JSON.stringify(b.input)) };
    }
    throw new Error(`content[${i}]: only text and tool_use blocks are supported in dry runs (got ${b?.type})`);
  });
  if (!content.length) throw new Error("answer.content is empty");
  const hasTool = content.some((b) => b.type === "tool_use");
  const stop = answer.stop_reason ?? (hasTool ? "tool_use" : "end_turn");
  if (!["end_turn", "tool_use", "max_tokens", "refusal", "stop_sequence"].includes(stop)) throw new Error(`unsupported stop_reason ${stop}`);
  if (stop === "tool_use" && !hasTool) throw new Error("stop_reason tool_use without a tool_use block");
  if (hasTool && stop === "end_turn") throw new Error("tool_use blocks need stop_reason tool_use (or leave it out)");
  return { content, stop_reason: stop, ...(answer.usage && typeof answer.usage === "object" ? { usage: answer.usage } : {}) };
}

/** SSE text of one complete message (or of a mid-stream error) in the Messages API wire format. */
export function answerToSse(ans, { model, usage, id }) {
  const startUsage = { ...usage, output_tokens: 1 };
  let s = sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: startUsage } });
  if (ans.error) return s + sse("error", { type: "error", error: { type: ans.error.type, message: ans.error.message } });
  ans.content.forEach((b, i) => {
    if (b.type === "text") {
      s += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      for (const p of pieces(b.text)) s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: p } });
    } else {
      s += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (const p of pieces(JSON.stringify(b.input))) s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: p } });
    }
    s += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  s += sse("message_delta", { type: "message_delta", delta: { stop_reason: ans.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  s += sse("message_stop", { type: "message_stop" });
  return s;
}

// ------------------------------------------------------------------------------------------------ dry fetch

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(() => { signal?.removeEventListener?.("abort", on); resolve(); }, ms);
  const on = () => { clearTimeout(t); resolve(); };
  signal?.addEventListener?.("abort", on, { once: true });
});

const headerOf = (h, k) => {
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(k) ?? undefined;
  const hit = Object.keys(h).find((x) => x.toLowerCase() === k);
  return hit ? h[hit] : undefined;
};

/**
 * A fetch replacement for the real transport. Only ANTHROPIC_URL is accepted and it is NEVER forwarded anywhere but
 * the local relay. relayFetch = the page's real fetch (used only for the relay).
 */
export function createDryFetch({ relay, token, relayFetch = globalThis.fetch, pingMs = DRY_DEFAULTS.pingMs, pollMs = DRY_DEFAULTS.pollMs, sim = createUsageSim(), onNote = () => {} } = {}) {
  if (!relay || !token) throw new Error("dry transport: relay and token are required");
  let seq = 0;
  const rf = (path, init = {}) => relayFetch(`${relay}${path}`, { cache: "no-store", ...init });

  return async function dryFetch(url, init = {}) {
    if (String(url) !== ANTHROPIC_URL) throw new TypeError("dry transport: refusing a request that is not the Anthropic Messages URL");
    if (headerOf(init.headers, "x-api-key") !== DRY_API_KEY) throw new TypeError("dry transport: refusing a request that does not carry the dry placeholder key");
    const signal = init.signal;
    const body = JSON.parse(String(init.body ?? "{}"));
    const msgId = `msg_dry_${Date.now().toString(36)}_${++seq}`;

    // Pre-warm (max_tokens 0, not streamed): nothing for the stand-in to answer; a JSON message with simulated usage.
    if (body.stream !== true) {
      const usage = sim.usage(body, []);
      onNote({ type: "prewarm", usage });
      const msg = { id: msgId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: "max_tokens", stop_sequence: null, usage };
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } });
    }

    const meta = { betas: String(headerOf(init.headers, "anthropic-beta") ?? ""), version: String(headerOf(init.headers, "anthropic-version") ?? ""), page: String(globalThis.location?.origin ?? "") };
    // text/plain + token in the body: a CORS "simple" request (no preflight); the relay checks the token and the origin.
    const posted = await rf("/requests", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token, meta, body }), signal });
    if (!posted.ok) {
      const txt = await posted.text().catch(() => "");
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `dry relay refused the request (${posted.status}): ${txt.slice(0, 200)}` } }), { status: 500, headers: { "content-type": "application/json" } });
    }
    const { id } = await posted.json();
    onNote({ type: "request", id });

    const enc = new TextEncoder();
    let done = false;
    const cancelRelay = (why) => { if (done) return; done = true; rf(`/requests/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token, why }) }).catch(() => {}); };
    const stream = new ReadableStream({
      start(ctrl) { pump(ctrl).catch((e) => { try { ctrl.error(e); } catch { /* closed */ } }); }, // not awaited: chunks flow while it polls
      cancel() { cancelRelay("cancelled"); }
    });
    async function pump(ctrl) {
      {
        let lastPing = Date.now();
        const onAbort = () => { cancelRelay("stopped"); try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener?.("abort", onAbort, { once: true });
        try {
          for (;;) {
            if (done || signal?.aborted) return;
            let r;
            try { r = await rf(`/requests/${encodeURIComponent(id)}/answer?token=${encodeURIComponent(token)}`, { signal }); }
            catch (e) { if (signal?.aborted) return; await sleep(pollMs, signal); continue; } // relay hiccup: keep polling; the transport's clocks decide
            if (r.status === 200) {
              const raw = await r.json();
              let ans;
              try { ans = normalizeAnswer(raw); }
              catch (e) { ans = { error: { type: "api_error", message: `dry answer rejected: ${e.message}` } }; }
              const content = ans.error ? [] : ans.content;
              const usage = { ...sim.usage(body, content), ...(ans.usage ?? {}) };
              done = true;
              ctrl.enqueue(enc.encode(answerToSse(ans, { model: body.model, usage, id: msgId })));
              ctrl.close();
              onNote({ type: "answer", id });
              return;
            }
            if (r.status === 410) { done = true; ctrl.enqueue(enc.encode(answerToSse({ error: { type: "api_error", message: "dry relay: request was cancelled" } }, { model: body.model, usage: sim.usage(body, []), id: msgId }))); ctrl.close(); return; }
            if (Date.now() - lastPing >= pingMs) { ctrl.enqueue(enc.encode(sse("ping", { type: "ping" }))); lastPing = Date.now(); }
            await sleep(pollMs, signal);
          }
        } finally { signal?.removeEventListener?.("abort", onAbort); }
      }
    }
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

/**
 * Wiring for builder-api.mjs. Returns null when dry mode is off (the normal case: nothing changes), else
 *   { apiKey, fetchImpl, transport: { streamMessage }, settings(s) -> s, log(entry) -> entry, config }
 * game / location / storage are injected (node tests); defaults are the browser globals.
 */
export function dryWiring({ game = globalThis.game, location = globalThis.location, storage = globalThis.localStorage, relayFetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const d = dryConfig({ location, storage, isGM: !!game?.user?.isGM });
  if (!d.on) {
    if (d.reason !== "off") console.warn(`moinens-ai-gen | builder DRY mode NOT enabled (${d.reason}); using the real transport`);
    return null;
  }
  const c = d.config;
  const fetchImpl = createDryFetch({ relay: c.relay, token: c.token, relayFetch });
  console.warn(`moinens-ai-gen | builder DRY mode: model turns come from the local relay ${c.relay}, not from Anthropic`);
  return {
    config: { relay: c.relay, wallMinutes: c.wallMinutes, requestMinutes: c.requestMinutes },
    apiKey: DRY_API_KEY,
    fetchImpl,
    // the real transport, only with a longer whole-request clock (the stand-in is slow); the 90 s stall check stays (pings)
    transport: { streamMessage: (req, o = {}) => realStreamMessage(req, { ...o, timeoutMs: c.requestMinutes * 60_000 }) },
    settings: (s) => ({ ...s, wallClockMs: Math.max(Number(s?.wallClockMs) || 0, c.wallMinutes * 60_000) }),
    log: (entry) => ({ ...entry, provider: DRY_PROVIDER })
  };
}
