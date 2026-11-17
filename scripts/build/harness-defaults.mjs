// Defaults of the per-message caps of the builder harness (spec 5.3). Own file so build-settings.mjs (loaded at `init`
// from settings.mjs) does not pull the whole harness into the module's start-up.
export const DEFAULT_CAPS = Object.freeze({
  maxRequests: 12,
  maxToolCalls: 40,
  maxInvalidSubmits: 4,
  maxIdenticalInvalid: 2,
  maxCostPerMessage: 0.5,     // USD; 0 = no cap
  wallClockMs: 5 * 60_000
});
