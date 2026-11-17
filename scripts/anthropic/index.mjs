// Anthropic transport for the AI builder: one import point for the harness (T2) and the drawer (T7).
// PURE (no Foundry globals). See dev/transport-notes.md for open choices.
//
// Typical use per model request:
//   const req = buildMessagesRequest({ apiKey, model, effort, tools, system: { rules, digest, catalog }, messages });
//   const r = await streamMessage(req, { signal, onEvent, redact });
//   history.push({ role: "assistant", content: r.historyContent });
//   if (r.stop === "tool_use") history.push(toolResultsTurn(results for r.toolUses));
export * from "./request.mjs";
export * from "./transport.mjs";
export { SSEParser, MessageAccumulator, StreamProtocolError, kindForErrorType } from "./sse.mjs";
export * from "./pricing.mjs";
