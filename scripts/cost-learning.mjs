// Cost estimates that learn from the call log.
// The built-in price tables are deliberately cautious. Once the log holds enough REAL (billed) costs for the same
// kind of request, those replace the table: shown as-is in the UI, and with a safety margin for the budget limits.
// Pure functions first (testable without Foundry), then the small stateful part (cache + log hook).
import { estimateBatchCost } from "./batch/cost.mjs";

export const MIN_SAMPLES = 3;      // fewer real runs than this: keep using the table
export const WINDOW = 20;          // newest samples per key that count
export const OUTLIER = 3;          // a sample further than this factor from the median is ignored
export const LIMIT_MARGIN = 1.25;  // limits use median × margin (never less than the most expensive of the last 3 runs)

const KINDS = new Set(["fast", "test", "batch-result"]);

const refsBucket = (n) => {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v >= 5 ? "5+" : String(v);
};

/** Fast, tests and API calls are billed at sync rates; batch results at batch rates. They are never mixed. */
export const modeOfKind = (kind) => (kind === "batch-result" ? "batch" : "sync");

/**
 * Key of a "kind of request" whose cost is comparable. Works for a log entry and for a configuration alike
 * (size as "WxH" or width/height). OpenAI cost follows quality and size; Gemini follows image size and thinking;
 * OpenRouter only the model. Reference images matter (they are billed as input), so they are part of the key.
 */
export function learnKey(p, mode = "sync") {
  const size = p.size ?? (p.width && p.height ? `${p.width}x${p.height}` : "");
  const refs = refsBucket(p.refsCount ?? p.refs);
  if (p.provider === "openai") return ["openai", p.model, p.quality || "", size, refs, mode].join("|");
  if (p.provider === "gemini") return ["gemini", p.model, p.imageSize || "", p.thinkingLevel || "", refs, mode].join("|");
  return [p.provider, p.model, refs, mode].join("|");
}

export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Entries that carry a real, billed, per-image cost. */
export function isSample(e) {
  return !!e && e.status === "ok" && e.costKind === "actual" && Number(e.cost) > 0 && KINDS.has(e.kind) && !!e.provider && !!e.model;
}

/**
 * @param {object[]} entries log entries (any order)
 * @returns {Map<string,{median:number, n:number, max3:number}>} per key; only keys with at least `minSamples` usable runs
 *   median: of the newest `window` samples without outliers; max3: the dearest of the 3 newest raw samples
 */
export function summarize(entries, { minSamples = MIN_SAMPLES, window = WINDOW, outlier = OUTLIER } = {}) {
  const groups = new Map();
  const sorted = [...entries].filter(isSample).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first
  for (const e of sorted) {
    const k = learnKey(e, modeOfKind(e.kind));
    const g = groups.get(k) ?? [];
    if (g.length < window) g.push(Number(e.cost));
    groups.set(k, g);
  }
  const out = new Map();
  for (const [k, costs] of groups) {
    const m0 = median(costs);
    const kept = costs.filter((c) => c <= m0 * outlier && c >= m0 / outlier);
    if (kept.length < minSamples) continue;
    out.set(k, { median: median(kept), n: kept.length, max3: Math.max(...costs.slice(0, 3)) });
  }
  return out;
}

/** Value used for the budget limits: median with a margin, never below the dearest of the last 3 runs. */
export const learnedLimit = (l) => Math.max(l.median * LIMIT_MARGIN, l.max3);

// ---- stateful part: cache refreshed from the log ----

let learned = new Map();

export function setLearned(map) { learned = map instanceof Map ? map : new Map(); }
export const getLearned = () => learned;

/** Learned stats for one request (config-like params), or null when there are too few real runs. */
export function lookupLearned(params, mode = "sync") {
  return learned.get(learnKey(params, mode)) ?? null;
}

/** Rebuild the cache from the call log (GM only: players have no log). */
export async function refreshLearned() {
  try {
    const { readLog } = await import("./call-log.mjs");
    setLearned(summarize(await readLog()));
  } catch (e) {
    console.warn("ai-image-gen | cost learning: could not read the log", e);
  }
  return learned;
}

let timer = null;
/** Start learning: build now and again (debounced) whenever the log changes. */
export async function initCostLearning() {
  Hooks.on("aiImageGen.logUpdate", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refreshLearned(); }, 500);
    timer?.unref?.(); // Node (tests) only
  });
  return refreshLearned();
}

/**
 * Cost of a batch for the LIMITS: per item the learned (batch-rate) limit value when known, else the cautious table.
 * @param {{refs?:any[], width?:number, height?:number, quality?:string, imageSize?:string, thinkingLevel?:string}[]} items
 */
export function estimateBatchLimit(provider, model, items) {
  let total = 0;
  for (const it of items) {
    const l = lookupLearned({
      provider, model, width: it.width, height: it.height, quality: it.quality,
      imageSize: it.imageSize, thinkingLevel: it.thinkingLevel, refsCount: it.refs?.length ?? 0
    }, "batch");
    total += l ? learnedLimit(l) : estimateBatchCost(provider, model, [it]);
  }
  return total;
}

/** Short label for where an estimate comes from ("from 7 runs" / "table estimate"). */
export function sourceTag(source, n) {
  return source === "learned"
    ? game.i18n.format("AIIMG.Cost.FromRuns", { n })
    : game.i18n.localize("AIIMG.Cost.Table");
}
