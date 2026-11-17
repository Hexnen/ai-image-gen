// Settings of the AI builder harness (spec 11.1; task T2). Registered from settings.mjs registerSettings() at `init`.
// World scope + restricted (GM) for model / effort / caps; client for pre-warm (config: false, GM keys window). The header-button setting belongs to the
// drawer task (T7). Foundry globals are touched only inside the functions, so node can import this file.

import { MODULE_ID } from "../constants.mjs";
import { EFFORTS } from "../enhance/anthropic.mjs";
import { DEFAULT_MODEL, DEFAULT_EFFORT, DEFAULT_PREFIX_TTL } from "../anthropic/request.mjs";
import { DEFAULT_CAPS, DEFAULT_END_TURN_ON_SUBMIT } from "./harness-defaults.mjs";
import { injectStrings } from "./harness-lang.mjs";

export const BUILD_SETTINGS = Object.freeze({
  model: "build.model",
  effort: "build.effort",
  cacheTtl: "build.cacheTtl",
  maxCostPerMessage: "build.maxCostPerMessage",
  maxRequests: "build.maxRequestsPerMessage",
  maxToolCalls: "build.maxToolCallsPerMessage",
  maxInvalidSubmits: "build.maxInvalidSubmits",
  maxMinutes: "build.maxMinutesPerMessage",
  prewarm: "build.prewarm",
  endTurnOnSubmit: "build.endTurnOnSubmit"
});

export function registerBuildSettings(game = globalThis.game) {
  const { NumberField, StringField, BooleanField } = globalThis.foundry.data.fields;
  globalThis.Hooks?.once?.("i18nInit", () => injectStrings(game));
  const reg = (key, o) => game.settings.register(MODULE_ID, key, { config: true, restricted: true, ...o });
  reg(BUILD_SETTINGS.model, {
    name: "MAIG.Settings.Build.Model.Name", hint: "MAIG.Settings.Build.Model.Hint", scope: "world",
    type: new StringField({ initial: DEFAULT_MODEL, blank: false })
  });
  reg(BUILD_SETTINGS.effort, {
    name: "MAIG.Settings.Build.Effort.Name", hint: "MAIG.Settings.Build.Effort.Hint", scope: "world",
    type: new StringField({ initial: DEFAULT_EFFORT, blank: true, choices: Object.fromEntries(EFFORTS.map((e) => [e, `MAIG.Settings.Build.Effort.${e || "default"}`])) })
  });
  reg(BUILD_SETTINGS.cacheTtl, {
    name: "MAIG.Settings.Build.CacheTtl.Name", hint: "MAIG.Settings.Build.CacheTtl.Hint", scope: "world",
    type: new StringField({ initial: DEFAULT_PREFIX_TTL, blank: false, choices: { "1h": "MAIG.Settings.Build.CacheTtl.1h", "5m": "MAIG.Settings.Build.CacheTtl.5m" } })
  });
  reg(BUILD_SETTINGS.maxCostPerMessage, {
    name: "MAIG.Settings.Build.MaxCost.Name", hint: "MAIG.Settings.Build.MaxCost.Hint", scope: "world",
    type: new NumberField({ initial: DEFAULT_CAPS.maxCostPerMessage, min: 0, step: 0.05, nullable: false })
  });
  reg(BUILD_SETTINGS.maxRequests, {
    name: "MAIG.Settings.Build.MaxRequests.Name", hint: "MAIG.Settings.Build.MaxRequests.Hint", scope: "world",
    type: new NumberField({ initial: DEFAULT_CAPS.maxRequests, min: 1, max: 50, step: 1, integer: true, nullable: false })
  });
  reg(BUILD_SETTINGS.maxToolCalls, {
    name: "MAIG.Settings.Build.MaxToolCalls.Name", hint: "MAIG.Settings.Build.MaxToolCalls.Hint", scope: "world",
    type: new NumberField({ initial: DEFAULT_CAPS.maxToolCalls, min: 1, max: 200, step: 1, integer: true, nullable: false })
  });
  reg(BUILD_SETTINGS.maxInvalidSubmits, {
    name: "MAIG.Settings.Build.MaxInvalid.Name", hint: "MAIG.Settings.Build.MaxInvalid.Hint", scope: "world",
    type: new NumberField({ initial: DEFAULT_CAPS.maxInvalidSubmits, min: 1, max: 20, step: 1, integer: true, nullable: false })
  });
  reg(BUILD_SETTINGS.maxMinutes, {
    name: "MAIG.Settings.Build.MaxMinutes.Name", hint: "MAIG.Settings.Build.MaxMinutes.Hint", scope: "world",
    type: new NumberField({ initial: DEFAULT_CAPS.wallClockMs / 60_000, min: 1, max: 30, step: 1, nullable: false })
  });
  reg(BUILD_SETTINGS.prewarm, {
    name: "MAIG.Settings.Build.Prewarm.Name", hint: "MAIG.Settings.Build.Prewarm.Hint", scope: "client",
    config: false,   // W5-F: a client setting would show in every player's Configure Settings; edited in the GM keys window (keys-app.mjs)
    type: new BooleanField({ initial: true })
  });
  reg(BUILD_SETTINGS.endTurnOnSubmit, {
    name: "MAIG.Settings.Build.EndTurnOnSubmit.Name", hint: "MAIG.Settings.Build.EndTurnOnSubmit.Hint", scope: "world",
    type: new BooleanField({ initial: DEFAULT_END_TURN_ON_SUBMIT })
  });
}

/** Current values for the harness (createHarness deps.settings). Missing / unregistered settings fall back to defaults. */
export function readBuildSettings(game = globalThis.game) {
  const get = (k, d) => { try { const v = game.settings.get(MODULE_ID, k); return v ?? d; } catch { return d; } };
  return {
    model: get(BUILD_SETTINGS.model, DEFAULT_MODEL),
    effort: get(BUILD_SETTINGS.effort, DEFAULT_EFFORT),
    cacheTtl: get(BUILD_SETTINGS.cacheTtl, DEFAULT_PREFIX_TTL),
    maxCostPerMessage: get(BUILD_SETTINGS.maxCostPerMessage, DEFAULT_CAPS.maxCostPerMessage),
    maxRequests: get(BUILD_SETTINGS.maxRequests, DEFAULT_CAPS.maxRequests),
    maxToolCalls: get(BUILD_SETTINGS.maxToolCalls, DEFAULT_CAPS.maxToolCalls),
    maxInvalidSubmits: get(BUILD_SETTINGS.maxInvalidSubmits, DEFAULT_CAPS.maxInvalidSubmits),
    wallClockMs: Number(get(BUILD_SETTINGS.maxMinutes, DEFAULT_CAPS.wallClockMs / 60_000)) * 60_000,
    prewarm: get(BUILD_SETTINGS.prewarm, true),
    endTurnOnSubmit: get(BUILD_SETTINGS.endTurnOnSubmit, DEFAULT_END_TURN_ON_SUBMIT)
  };
}
