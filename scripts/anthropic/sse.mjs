// Server-Sent Events parser + Messages API stream accumulator (spec 5.1). PURE, node-testable.
//
// Wire events handled: message_start, content_block_start, content_block_delta (text_delta, input_json_delta,
// thinking_delta, signature_delta, citations_delta, unknown deltas ignored), content_block_stop, message_delta,
// message_stop, ping, error. Block types are kept exactly as streamed (text, thinking, redacted_thinking, tool_use,
// fallback, server tool blocks, unknown types) so the assistant message can be appended to history unchanged.

/** Incremental SSE parser (WHATWG rules: \n, \r\n or \r line ends; "event", "data" (multi-line), comments ignored). */
export class SSEParser {
  constructor() { this.buf = ""; this.event = ""; this.data = []; }

  /** Feed a decoded text chunk; returns the complete events [{ event, data }] it finished. */
  push(chunk) {
    this.buf += chunk;
    const out = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A lone \r at the very end may be the first half of \r\n: wait for more input.
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.#line(line, out);
    }
    return out;
  }

  /** End of stream: dispatch a final event that lacked its blank line. */
  end() {
    const out = [];
    if (this.buf) { this.#line(this.buf, out); this.buf = ""; }
    this.#line("", out);
    return out;
  }

  #line(line, out) {
    if (line === "") {
      if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n") });
      this.event = ""; this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    // id / retry: not used by the Messages API
  }
}

/** Error raised from inside a stream (an `error` event, malformed JSON, protocol violation). */
export class StreamProtocolError extends Error {
  constructor(kind, detail, extra = {}) { super(`${kind}: ${detail}`); this.name = "StreamProtocolError"; this.kind = kind; this.detail = detail; Object.assign(this, extra); }
}

/** Map an API error type (body or stream `error` event) to our error kind. */
export function kindForErrorType(type) {
  switch (type) {
    case "authentication_error": return "auth";
    case "billing_error": return "billing";
    case "permission_error": return "permission";
    case "not_found_error": return "model";
    case "request_too_large": return "too-long";
    case "rate_limit_error": return "rate-limit";
    case "overloaded_error": return "overloaded";
    case "api_error": return "server";
    case "timeout_error": return "server";
    case "invalid_request_error": return "request";
    default: return null;
  }
}

/**
 * Accumulates stream events into the final Message object ({ id, type, role, model, content, stop_reason,
 * stop_details, usage, ... }) and emits normalised UI events through `emit(evt)`:
 *   message_start {id, model, usage} | block_start {index, blockType, id?, name?} | text {index, text}
 *   thinking {index, text} | tool_input {index, id, name, partialJson, chars} | tool_use {index, id, name, input, inputError?}
 *   fallback {index, from, to} | block_stop {index, blockType} | usage {usage} | message_stop {stopReason, stopDetails}
 */
export class MessageAccumulator {
  constructor(emit = () => {}) {
    this.emit = emit;
    this.message = null;
    this.partialJson = new Map(); // index -> accumulated input_json string
    this.inputErrors = new Map(); // tool_use id -> parse error text
    this.open = new Set();
    this.stopped = false;
    this.sawOutput = false; // any content delta / block received (a retry must then discard partial UI state)
  }

  /** Handle one parsed SSE event. Throws StreamProtocolError for `error` events and broken data. */
  handle({ event, data }) {
    if (event === "ping") return;
    let j;
    try { j = JSON.parse(data); } catch { throw new StreamProtocolError("bad-stream", `unparseable ${event} data`); }
    const type = j?.type ?? event;
    switch (type) {
      case "ping": return;
      case "error": {
        const et = j?.error?.type ?? "";
        throw new StreamProtocolError(kindForErrorType(et) ?? "server", String(j?.error?.message ?? et ?? "stream error").slice(0, 400), { errorType: et || null, midStream: true });
      }
      case "message_start": {
        const m = j.message ?? {};
        this.message = { ...m, content: Array.isArray(m.content) ? [...m.content] : [], usage: { ...(m.usage ?? {}) } };
        this.safeEmit({ type: "message_start", id: m.id ?? null, model: m.model ?? null, usage: { ...(m.usage ?? {}) } });
        return;
      }
      case "content_block_start": {
        this.#need();
        const idx = j.index;
        const b = structuredCloneSafe(j.content_block ?? {});
        if (b.type === "tool_use" || b.type === "server_tool_use") { this.partialJson.set(idx, ""); if (b.input === undefined) b.input = {}; }
        if (b.type === "thinking") { b.thinking ??= ""; b.signature ??= ""; }
        if (b.type === "text") b.text ??= "";
        this.message.content[idx] = b;
        this.open.add(idx);
        this.sawOutput = true;
        this.safeEmit({ type: "block_start", index: idx, blockType: b.type, id: b.id, name: b.name });
        if (b.type === "fallback") this.safeEmit({ type: "fallback", index: idx, from: b.from?.model ?? null, to: b.to?.model ?? null });
        if (b.type === "text" && b.text) this.safeEmit({ type: "text", index: idx, text: b.text });
        return;
      }
      case "content_block_delta": {
        this.#need();
        const idx = j.index;
        const b = this.message.content[idx];
        if (!b) throw new StreamProtocolError("bad-stream", `delta for unknown block ${idx}`);
        const d = j.delta ?? {};
        this.sawOutput = true;
        switch (d.type) {
          case "text_delta": b.text = (b.text ?? "") + (d.text ?? ""); this.safeEmit({ type: "text", index: idx, text: d.text ?? "" }); break;
          case "thinking_delta": b.thinking = (b.thinking ?? "") + (d.thinking ?? ""); this.safeEmit({ type: "thinking", index: idx, text: d.thinking ?? "" }); break;
          case "signature_delta": b.signature = (b.signature ?? "") + (d.signature ?? ""); break;
          case "citations_delta": (b.citations ??= []).push(d.citation); break;
          case "input_json_delta": {
            const s = (this.partialJson.get(idx) ?? "") + (d.partial_json ?? "");
            this.partialJson.set(idx, s);
            this.safeEmit({ type: "tool_input", index: idx, id: b.id, name: b.name, partialJson: d.partial_json ?? "", chars: s.length });
            break;
          }
          default: break; // unknown delta types: ignore (forward compatible)
        }
        return;
      }
      case "content_block_stop": {
        this.#need();
        const idx = j.index;
        const b = this.message.content[idx];
        if (!b) throw new StreamProtocolError("bad-stream", `stop for unknown block ${idx}`);
        this.open.delete(idx);
        if (this.partialJson.has(idx)) {
          const raw = this.partialJson.get(idx);
          this.partialJson.delete(idx);
          if (raw.trim()) {
            try { b.input = JSON.parse(raw); }
            catch (e) { b.input = {}; if (b.id) this.inputErrors.set(b.id, `tool input is not valid JSON (${raw.length} chars)`); }
          }
          if (b.input === null || typeof b.input !== "object" || Array.isArray(b.input)) {
            if (b.id) this.inputErrors.set(b.id, "tool input is not a JSON object");
            b.input = {};
          }
          if (b.type === "tool_use") {
            const err = b.id ? this.inputErrors.get(b.id) : null;
            this.safeEmit({ type: "tool_use", index: idx, id: b.id, name: b.name, input: b.input, ...(err ? { inputError: err } : {}) });
          }
        }
        this.safeEmit({ type: "block_stop", index: idx, blockType: b.type });
        return;
      }
      case "message_delta": {
        this.#need();
        const d = j.delta ?? {};
        if ("stop_reason" in d) this.message.stop_reason = d.stop_reason;
        if ("stop_sequence" in d) this.message.stop_sequence = d.stop_sequence;
        if ("stop_details" in d) this.message.stop_details = d.stop_details;
        for (const [k, v] of Object.entries(d)) if (!["stop_reason", "stop_sequence", "stop_details"].includes(k)) this.message[k] = v;
        if (j.usage && typeof j.usage === "object") {
          this.message.usage = { ...this.message.usage, ...j.usage }; // message_delta counters are cumulative
          this.safeEmit({ type: "usage", usage: { ...this.message.usage } });
        }
        if (j.message && typeof j.message === "object") { // e.g. block-binding diagnostics after a mid-stream fallback
          for (const [k, v] of Object.entries(j.message)) if (k !== "content") this.message[k] = v;
        }
        return;
      }
      case "message_stop": {
        this.#need();
        this.stopped = true;
        this.safeEmit({ type: "message_stop", stopReason: this.message.stop_reason ?? null, stopDetails: this.message.stop_details ?? null });
        return;
      }
      default: return; // unknown event types: ignore
    }
  }

  #need() { if (!this.message) throw new StreamProtocolError("bad-stream", "event before message_start"); }

  safeEmit(evt) { try { this.emit(evt); } catch { /* a UI handler must never break the stream */ } }

  /** Final message (only valid after message_stop). Content array without holes. */
  result() {
    if (!this.message || !this.stopped) throw new StreamProtocolError("network", "stream ended before message_stop");
    const msg = { ...this.message, content: this.message.content.filter((b) => b != null) };
    return msg;
  }

  /** What arrived so far (for a cancelled / failed stream): never appended to history, shown and discarded by the UI. */
  partial() {
    if (!this.message) return null;
    return { ...this.message, content: this.message.content.filter((b) => b != null), incomplete: true };
  }
}

function structuredCloneSafe(v) { return JSON.parse(JSON.stringify(v)); }
