// Foundry wiring of the builder harness (task T2): builds the harness from the module's real pieces and exposes it on
// api.build (GM only). Loaded by a dynamic import from module.mjs (GM branch of `ready`), so a failure here never touches
// image generation. The drawer (T7) uses:
//   const s = await game.modules.get("moinens-ai-gen").api.build.openSession(actor);
//   s.on("*", (data, type) => ...); await s.send("Build me Spider-Man"); s.stop(); s.transcript(); s.prewarm();
//   await s.setOptions({ rank, profile }) -> the effective options; api.build.ranks() -> rank keys/names/numbers;
//   await s.markProposal(id, "applied"|"discarded"|"pending") -> proposal state the model sees next turn (W2-7, P1-H; "pending" restores the pendingProposal, W6-D1);
//   pack = api.build.registry.getPack(): pack.apply(doc, input, { rank, profile, confirmed }) -> concise result
//   ({ verbose: true } adds plan/projected), pack.snapshot(doc, { rank, profile }) -> { text, ... }.
// Order with registry.mjs is free: both merge into api.build; the pack is looked up at each call.

import { MODULE_ID } from "../constants.mjs";
import { getKey } from "../settings.mjs";
import { reserveBudget, recordCost } from "../limits.mjs";
import { logCall } from "../call-log.mjs";
import { redact } from "../redact.mjs";
import { createHarness, transcriptOf } from "./harness.mjs";
import { createSessionStore } from "./session-store.mjs";
import { readBuildSettings } from "./build-settings.mjs";
import { t } from "./harness-lang.mjs";
import { dryWiring } from "./dry-transport.mjs";

const WARM_KEY = `${MODULE_ID}.build.prewarm`;

/** Pre-warm marks per prefix fingerprint, kept in this browser (localStorage, newest 20). */
function warmMap() {
  const read = () => { try { return JSON.parse(globalThis.localStorage?.getItem(WARM_KEY) ?? "{}") ?? {}; } catch { return {}; } };
  return {
    get: (fp) => read()[fp] ?? 0,
    set: (fp, at) => {
      try {
        const m = read(); m[fp] = at;
        const keep = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 20);
        globalThis.localStorage?.setItem(WARM_KEY, JSON.stringify(Object.fromEntries(keep)));
      } catch { /* no storage */ }
    }
  };
}

export function attachBuilder(api, { game = globalThis.game } = {}) {
  if (!game?.user?.isGM || !api) return null;
  const store = createSessionStore({
    indexedDB: (() => { try { return globalThis.indexedDB ?? null; } catch { return null; } })(),
    onWarn: (e) => console.warn(`${MODULE_ID} | builder conversations kept in memory only (IndexedDB unavailable)`, e)
  });
  // dev only: null unless a lane page (never :30000) opted in via localStorage (dry-transport.mjs, dev/dry-run/RUNBOOK.md)
  const dry = dryWiring({ game });
  const harness = createHarness({
    getPack: () => api.build?.registry?.getPack?.() ?? null,
    getApiKey: () => (dry ? dry.apiKey : getKey("anthropic")),
    settings: () => (dry ? dry.settings(readBuildSettings(game)) : readBuildSettings(game)),
    // module limits: the per-request estimate is checked against limit.perRequest too (reserveBudget rule)
    limits: { reserve: (usd) => reserveBudget(usd, { perRequest: usd }), record: (usd) => recordCost(usd) },
    log: (entry) => logCall(dry ? dry.log(entry) : entry),
    ...(dry ? { fetchImpl: dry.fetchImpl, transport: dry.transport } : {}),
    store,
    worldId: () => game.world?.id ?? "world",
    redact: (s) => redact(s),
    t: (key, data) => t(key, data, game),
    warmMap: warmMap()
  });
  api.build = Object.assign(api.build ?? {}, {
    harness,
    openSession: (doc) => harness.openSession(doc),
    getSession: (doc) => harness.getSession(doc),
    listArchive: (doc) => store.listArchive(`${game.world?.id ?? "world"}:${doc?.uuid ?? doc}`),
    transcriptOf,
    // rank keys / names / numbers for the drawer's rank selector (T7): the active pack's ranks(), [] when it has none
    ranks: () => { try { const p = api.build?.registry?.getPack?.(); return typeof p?.ranks === "function" ? p.ranks() : []; } catch { return []; } },
    dry: dry ? Object.freeze({ ...dry.config }) : null
  });
  if (dry) globalThis.ui?.notifications?.warn?.("Moinens AI Gen: builder DRY RUN (lane test mode, no Anthropic calls)", { permanent: true });
  globalThis.Hooks?.callAll?.("moinensAiGen.harnessReady", api.build);
  return harness;
}
