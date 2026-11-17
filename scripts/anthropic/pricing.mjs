// Price table and usage -> cost for the Anthropic Messages API (builder transport, spec 11.3).
// PURE: no Foundry globals, node-testable (dev/test-transport.mjs).
// Source: claude-api skill model table (cached 2026-11-03) + prompt-caching economics (5 min write 1.25x, 1 h write 2x).
// All prices in USD per 1M tokens. Update this table when Anthropic changes prices; nothing else hard-codes a price.

export const PRICES_AS_OF = "2026-11-03";

/** in / out / cacheRead / cacheWrite5m / cacheWrite1h; `long` = second rate card above `longAbove` prompt tokens. */
export const PRICES = Object.freeze({
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.10, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.20, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-haiku-5-5": {
    in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.20,
    longAbove: 100_000, long: { in: 0.50, out: 2.50, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1.0 }
  },
  // Server-side refusal fallback targets (sonnet-5-5 -> sonnet-5, opus-5-5 -> opus-5 / opus-4-8).
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.20, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-fable-5-2": { in: 8, out: 40, cacheRead: 0.20, cacheWrite5m: 10, cacheWrite1h: 16 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }
});

/** Unknown model: price it like Opus 5.5 and mark the cost "estimated" (spec 11.3). */
export const FALLBACK_PRICE_MODEL = "claude-opus-5-5";

/** Price row for a model id (exact id, else a known id the string starts with, e.g. a dated or "-fast" variant). */
export function priceFor(model) {
  const m = String(model ?? "").trim();
  if (PRICES[m]) return { model: m, row: PRICES[m], estimated: false };
  const prefix = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => m.startsWith(k));
  if (prefix) return { model: prefix, row: PRICES[prefix], estimated: true };
  return { model: FALLBACK_PRICE_MODEL, row: PRICES[FALLBACK_PRICE_MODEL], estimated: true };
}

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * Normalise an API usage block to plain counters.
 * `cacheWrite5m` / `cacheWrite1h` come from `usage.cache_creation` when the API itemises them; otherwise all writes
 * are attributed to `defaultWriteTtl` ("5m" | "1h").
 */
export function normalizeUsage(usage, { defaultWriteTtl = "5m" } = {}) {
  const u = usage && typeof usage === "object" ? usage : {};
  const write = n(u.cache_creation_input_tokens);
  let w5 = n(u.cache_creation?.ephemeral_5m_input_tokens);
  let w1 = n(u.cache_creation?.ephemeral_1h_input_tokens);
  if (w5 + w1 === 0 && write > 0) { if (defaultWriteTtl === "1h") w1 = write; else w5 = write; }
  else if (w5 + w1 < write) { // unitemised remainder: attribute it to the default TTL
    if (defaultWriteTtl === "1h") w1 += write - (w5 + w1); else w5 += write - (w5 + w1);
  }
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: Math.max(write, w5 + w1),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    thinking: n(u.output_tokens_details?.thinking_tokens)
  };
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
}

/** Sum normalised usage blocks (session / turn totals). */
export function addUsage(a, b) {
  const out = { ...emptyUsage(), ...(a ?? {}) };
  for (const k of Object.keys(emptyUsage())) out[k] = (out[k] ?? 0) + (b?.[k] ?? 0);
  return out;
}

/** Cache hit ratio = read / (read + write + uncached input); null when nothing was sent (spec 4.3). */
export function cacheHitRatio(u) {
  const tot = (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0) + (u?.input ?? 0);
  return tot > 0 ? (u.cacheRead ?? 0) / tot : null;
}

/** USD cost of one normalised usage block on one model. */
export function costOfNormalized(u, model) {
  const { model: priced, row, estimated } = priceFor(model);
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const r = row.long && prompt > row.longAbove ? row.long : row;
  const parts = {
    input: (u.input * r.in) / 1e6,
    output: (u.output * r.out) / 1e6,
    cacheRead: (u.cacheRead * r.cacheRead) / 1e6,
    cacheWrite: (u.cacheWrite5m * r.cacheWrite5m + u.cacheWrite1h * r.cacheWrite1h) / 1e6
  };
  const usd = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
  return { usd: round(usd), parts: mapRound(parts), model: priced, estimated, longRate: r !== row };
}

/**
 * Cost of a response's `usage`. When `usage.iterations` is present (server-side fallback, compaction) it is the
 * per-attempt source of truth: each entry is priced at its own model (entry.model, else `model`), and the top-level
 * counters are ignored (they cover only the attempt that produced the message).
 */
export function costOfUsage(usage, model, opts = {}) {
  const its = Array.isArray(usage?.iterations) ? usage.iterations.filter((x) => x && typeof x === "object") : [];
  if (its.length) {
    let usd = 0; let estimated = false; let total = emptyUsage();
    const perIteration = its.map((it) => {
      const u = normalizeUsage(it, opts);
      const c = costOfNormalized(u, it.model || model);
      usd += c.usd; estimated ||= c.estimated; total = addUsage(total, u);
      return { type: String(it.type ?? "message"), model: it.model || model, usage: u, usd: c.usd };
    });
    return { usd: round(usd), estimated, usage: total, iterations: perIteration };
  }
  const u = normalizeUsage(usage, opts);
  const c = costOfNormalized(u, model);
  return { usd: c.usd, estimated: c.estimated, usage: u, parts: c.parts, longRate: c.longRate };
}

/**
 * Upper-bound estimate before sending (for the limits reservation): every prompt token billed as an uncached 1 h
 * write (the most expensive input rate) plus `maxOutput` output tokens.
 */
export function estimateMaxCost({ model, promptTokens = 0, maxOutput = 0 }) {
  const { row, estimated } = priceFor(model);
  const r = row.long && promptTokens > row.longAbove ? row.long : row;
  const inRate = Math.max(r.in, r.cacheWrite1h, r.cacheWrite5m);
  return { usd: round((n(promptTokens) * inRate + n(maxOutput) * r.out) / 1e6), estimated };
}

/** Rough local token estimate (chars / 3.5); only for reservations and caps, never for billing. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3.5);
}

function round(x) { return Math.round(x * 1e8) / 1e8; }
function mapRound(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = round(v); return r; }
