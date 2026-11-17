// System-pack registry + lazy loader + dependency check (spec 3.2, 3.3; task T3).
//
// Rules (binding, spec 3.3):
// - The core never imports a system pack statically. At `ready` the registry looks at game.system.id and dynamic-imports
//   ONLY the matching pack (BUNDLED_PACKS). On any other system nothing system-specific is loaded and the builder is off;
//   image generation and the prompt improver are untouched.
// - GM only: on a player's client the registry loads nothing and exposes nothing (spec 10.1).
// - A broken pack (import error, contract violation, check() throwing) never breaks the core: the registry records the
//   failure, shows ONE GM notification and stays off.
// - Optional modules (e.g. invincible-plus-ultra for the Invincible pack) are detected softly by the pack's check();
//   missing optional parts are reported, never block.
//
// ---------------------------------------------------------------------------------------------------------------------
// PACK CONTRACT (CONTRACT_VERSION 1). A pack module exports the pack object as `default` (or named `pack`).
//
// Required (validatePack refuses the pack without them):
//   id: string                 pack id (usually = systemId)
//   systemId: string           game.system.id this pack serves; the registry never activates it on another system
//   version: integer >= 1      pack version; part of the cache key of its static prompt (spec 9.1)
//   check(): { ok, missing:[{ kind: "module"|"pack"|"api"|"version"|"system", id, need, have }],
//              optional:[{ id, kind:"module", usable, why?, adds:[string], detail? }], notes:[string] }
//              readiness; MUST NOT throw (a throw is caught and treated as blocked). ok=false = blocking empty state.
//   supports(doc): null | { kind: "actor"|"item", mode: string, canWrite: boolean }
//              which documents get a drawer and in which mode.
//
// Capability groups (optional per group; a pack that lacks a group is "incomplete": the registry still activates it, and
// `capabilities` tells the drawer what is missing, so skeleton packs can ship before later tasks fill them in):
//   prompt  (catalogue + tools, T4/T8):   staticPrompt(): Promise<{ rulesDigest, catalogIndex, fingerprint }>
//                                         tools(): ToolDef[]   (static, deterministic order, strict schemas)
//                                         runTool(name, input, ctx): Promise<ToolResult>   (reads / dry runs only, never writes)
//   validate (validators, T5):            validate(doc, proposal, { profile }): Promise<{ ok, errors, warnings, info, budget }>
//   sheet   (sheet integration, T12):     snapshot(doc, { liveForm }): Promise<{ text, fingerprint, lines, tokensEst }>
//                                         diffSnapshots(oldText, newText): string
//   writer  (writers, T6):                plan(doc, proposal), apply(doc, proposal, { confirmed, expect }),
//                                         undo(doc, runId), undoStatus(doc)
//
// Optional hooks:
//   label: string                         human name shown in the drawer header
//   init({ game, registry }): void|Promise   one-time setup after activation (may throw: pack becomes "failed")
//   selfTest(): Promise<{ ok, error? }>   cheap check at first drawer open (e.g. plus-ultra API shape, spec 3.3 version guard);
//                                         run once through registry.ensureSelfTest(); a failure is reported, the pack decides
//                                         its own fallback (it must not throw; a throw counts as ok:false)
//
// Packs declare optional modules only through check().optional; helpers in ./deps.mjs (detectModule, hasPack,
// compareVersions) do the detection. External modules may add packs with registerSystemPack(pack). The registry starts in
// the GM's `ready` (after this module's settings copy), so "before ready" is not reachable: a pack takes precedence over
// the bundled one only when it is registered from the HOOK_REGISTER hook ("moinensAiGen.registerPacks", GM only, fired
// once right before load(), args { registerSystemPack, contractVersion }). Registered later (api.build.registerSystemPack),
// it activates only when the system has no active pack (no bundled pack, or the bundled one failed); it never replaces an
// active pack (packs-notes.md P2; bughunt-2 #10).
// ---------------------------------------------------------------------------------------------------------------------

import { t } from "./registry-lang.mjs";

export const CONTRACT_VERSION = 1;
export const REQUIRED = Object.freeze({ id: "string", systemId: "string", version: "number", check: "function", supports: "function" });
export const CAPABILITIES = Object.freeze({
  prompt: ["staticPrompt", "tools", "runTool"],
  validate: ["validate"],
  sheet: ["snapshot", "diffSnapshots"],
  writer: ["plan", "apply", "undo", "undoStatus"]
});
export const OPTIONAL_HOOKS = Object.freeze({ label: "string", init: "function", selfTest: "function" });

/** Bundled packs, keyed by game.system.id. Each value is a loader; only the matching one is ever called. */
export const BUNDLED_PACKS = Object.freeze({
  invincible: () => import("../systems/invincible/pack.mjs")
});

export const HOOK_READY = "moinensAiGen.packReady";
/** fired once (GM) right before the bundled pack loads: the only point where an external pack can take precedence */
export const HOOK_REGISTER = "moinensAiGen.registerPacks";
const NOTICE_KEY = "moinens-ai-gen.packs.noticeSeen";

/** Contract check. -> { ok, errors:[string], capabilities:{group:boolean}, missing:{group:[fn]} } */
export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object") return { ok: false, errors: ["not an object"], capabilities: {}, missing: {} };
  for (const [k, type] of Object.entries(REQUIRED)) {
    if (typeof pack[k] !== type) errors.push(`${k} must be a ${type}`);
  }
  if (typeof pack.id === "string" && !pack.id.trim()) errors.push("id is empty");
  if (typeof pack.systemId === "string" && !pack.systemId.trim()) errors.push("systemId is empty");
  if (typeof pack.version === "number" && !(Number.isInteger(pack.version) && pack.version >= 1)) errors.push("version must be an integer >= 1");
  for (const [k, type] of Object.entries(OPTIONAL_HOOKS)) {
    if (pack[k] != null && typeof pack[k] !== type) errors.push(`${k} must be a ${type}`);
  }
  const capabilities = {}, missing = {};
  for (const [group, fns] of Object.entries(CAPABILITIES)) {
    const present = fns.filter((f) => typeof pack[f] === "function");
    const absent = fns.filter((f) => typeof pack[f] !== "function");
    for (const f of fns) if (pack[f] != null && typeof pack[f] !== "function") errors.push(`${f} must be a function`);
    // a half-implemented group is a contract error (the drawer would call a missing function)
    if (present.length && absent.length) errors.push(`capability "${group}" is partial: missing ${absent.join(", ")}`);
    capabilities[group] = !absent.length;
    missing[group] = absent;
  }
  return { ok: !errors.length, errors, capabilities, missing };
}

/** Normalise a check() result; a throw or junk becomes a blocking result. Never throws. */
export function safeCheck(pack) {
  let r;
  try { r = pack.check(); }
  catch (e) { return { ok: false, missing: [{ kind: "api", id: `${pack?.id}.check`, need: "no error", have: String(e?.message ?? e) }], optional: [], notes: [] }; }
  if (r && typeof r.then === "function") {
    return { ok: false, missing: [{ kind: "api", id: `${pack?.id}.check`, need: "synchronous result", have: "Promise" }], optional: [], notes: [] };
  }
  const missing = Array.isArray(r?.missing) ? r.missing.filter(Boolean) : [];
  const optional = Array.isArray(r?.optional) ? r.optional.filter(Boolean) : [];
  const notes = Array.isArray(r?.notes) ? r.notes.map(String) : [];
  return { ok: r?.ok === true && !missing.length, missing, optional, notes };
}

const describeMissing = (m) => {
  const need = m.need != null ? ` ${m.need}` : "";
  const have = m.have != null ? ` (have ${m.have})` : "";
  return `${m.kind} ${m.id}${need}${have}`;
};

const whyOptional = (o, game) => {
  if (o.why) return o.why;
  const d = o.detail ?? {};
  if (d.installed === false) return t("MAIG.Packs.Why.NotInstalled", {}, game);
  if (d.active === false) return t("MAIG.Packs.Why.Inactive", {}, game);
  if (d.versionOk === false) return t("MAIG.Packs.Why.Version", { have: d.version ?? "?", need: d.minVersion ?? "?" }, game);
  if (d.missingApi?.length) return t("MAIG.Packs.Why.Api", { api: d.missingApi.join(", ") }, game);
  return "?";
};

/**
 * createRegistry(deps) -> registry. All Foundry access goes through `deps` (defaults = the real globals), so node tests
 * inject a mock game, loaders, notifier, hooks and storage.
 */
export function createRegistry({
  game = globalThis.game,
  loaders = BUNDLED_PACKS,
  notify = (level, msg, opts) => globalThis.ui?.notifications?.[level]?.(msg, opts),
  hooks = globalThis.Hooks,
  log = console,
  storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })()
} = {}) {
  const registered = new Map();   // systemId -> pack (registerSystemPack before activation)
  const state = {
    status: "idle",               // idle | loading | not-gm | none | failed | ready
    systemId: null, pack: null, source: null, error: null, contract: null, check: null, selfTest: null
  };
  let loading = null, selfTestP = null;

  const isGM = () => !!game?.user?.isGM;
  const sysId = () => game?.system?.id ?? null;

  const seenNotice = (key) => {
    try {
      const seen = JSON.parse(storage?.getItem?.(NOTICE_KEY) ?? "[]");
      if (Array.isArray(seen) && seen.includes(key)) return true;
      storage?.setItem?.(NOTICE_KEY, JSON.stringify([...(Array.isArray(seen) ? seen : []), key].slice(-20)));
    } catch { /* no storage: show every time */ }
    return false;
  };

  const fail = (code, error, message) => {
    Object.assign(state, { status: "failed", pack: null, error: { code, message: String(error?.message ?? error) } });
    try { log?.error?.(`moinens-ai-gen | system pack ${code}`, error); } catch { /* ignore */ }
    if (isGM()) { try { notify("error", message, { permanent: false }); } catch { /* ignore */ } }
    return null;
  };

  const report = (pack, check) => {
    if (!isGM()) return;
    if (!check.ok) {
      const missing = check.missing.map(describeMissing).join("; ");
      try { log?.warn?.(`moinens-ai-gen | system pack "${pack.id}" blocked: ${missing}`); } catch { /* ignore */ }
      if (!seenNotice(`blocked:${pack.id}:${missing}`)) {
        try { notify("warn", t("MAIG.Packs.Blocked", { system: pack.label ?? pack.systemId, missing }, game)); } catch { /* ignore */ }
      }
    }
    for (const o of check.optional) {
      if (o.usable) continue;
      const why = whyOptional(o, game);
      const adds = (o.adds ?? []).join(", ") || "-";
      try { log?.info?.(`moinens-ai-gen | optional module "${o.id}" not usable (${why}); missing extras: ${adds}`); } catch { /* ignore */ }
      if (!seenNotice(`optional:${pack.id}:${o.id}:${why}`)) {
        try { notify("info", t("MAIG.Packs.OptionalMissing", { module: o.id, why, adds }, game)); } catch { /* ignore */ }
      }
    }
  };

  async function activate(pack, source) {
    const system = sysId();
    const contract = validatePack(pack);
    state.contract = contract;
    if (!contract.ok) {
      return fail("invalid", contract.errors.join("; "), t("MAIG.Packs.Invalid", { pack: pack?.id ?? system, problems: contract.errors.join("; ") }, game));
    }
    if (pack.systemId !== system) {
      return fail("wrong-system", `pack for "${pack.systemId}" on system "${system}"`, t("MAIG.Packs.Invalid", { pack: pack.id, problems: `systemId ${pack.systemId} != ${system}` }, game));
    }
    try { if (typeof pack.init === "function") await pack.init({ game, registry: api }); }
    catch (e) { return fail("init", e, t("MAIG.Packs.ImportFailed", { system }, game)); }
    const check = safeCheck(pack);
    Object.assign(state, { status: "ready", pack, source, error: null, check, selfTest: null });
    report(pack, check);
    try { hooks?.callAll?.(HOOK_READY, status()); } catch { /* ignore */ }
    return pack;
  }

  /** Load the pack for the running system (once). GM only. Never throws. -> pack | null */
  function load() {
    if (loading) return loading;
    loading = (async () => {
      state.systemId = sysId();
      if (!isGM()) { state.status = "not-gm"; return null; }
      const system = state.systemId;
      if (!system) { state.status = "none"; return null; }
      if (registered.has(system)) { state.status = "loading"; return activate(registered.get(system), "registered"); }
      const loader = Object.prototype.hasOwnProperty.call(loaders ?? {}, system) ? loaders[system] : null;
      if (typeof loader !== "function") { state.status = "none"; return null; }
      state.status = "loading";
      let mod;
      try { mod = await loader(); }
      catch (e) { return fail("import", e, t("MAIG.Packs.ImportFailed", { system }, game)); }
      const pack = mod?.default ?? mod?.pack ?? null;
      return activate(pack, "bundled");
    })().catch((e) => fail("load", e, t("MAIG.Packs.ImportFailed", { system: sysId() }, game)));
    return loading;
  }

  /**
   * External registration (api.build.registerSystemPack). Ignored for other systems and for players. Before load():
   * remembered and preferred over the bundled pack. After load(): activates only when no pack is active yet.
   * -> { ok, reason? }
   */
  function registerSystemPack(pack) {
    if (!isGM()) return { ok: false, reason: "not-gm" };
    const v = validatePack(pack);
    if (!v.ok) return { ok: false, reason: `invalid: ${v.errors.join("; ")}` };
    if (pack.systemId !== sysId()) return { ok: false, reason: "other-system" };
    if (!loading) { registered.set(pack.systemId, pack); return { ok: true, reason: "queued" }; }
    if (state.status === "ready") return { ok: false, reason: "pack-already-active" };
    if (state.status === "loading") return { ok: false, reason: "loading" };
    loading = activate(pack, "registered");
    return { ok: true, reason: "activated" };
  }

  /** The active, unblocked pack or null. */
  const getPack = () => (state.status === "ready" && state.check?.ok ? state.pack : null);

  /** Drawer/header entry: pack.supports(doc) guarded; null when the builder is off for this doc. */
  function supports(doc) {
    const pack = getPack();
    if (!pack || !isGM()) return null;
    try { return pack.supports(doc) ?? null; } catch (e) { try { log?.warn?.("moinens-ai-gen | supports() failed", e); } catch { /* ignore */ } return null; }
  }

  /** Why there is no drawer for doc (for the drawer's empty state). null when the builder can work on it. */
  function emptyState(doc) {
    const system = sysId();
    if (!isGM()) return { reason: "not-gm", message: t("MAIG.Packs.NotGM", {}, game) };
    if (state.status === "idle" || state.status === "loading") return { reason: "loading", message: t("MAIG.Packs.Loading", {}, game) };
    if (state.status === "none") return { reason: "no-pack", message: t("MAIG.Packs.NoPack", { system }, game) };
    if (state.status === "failed") return { reason: "failed", message: t("MAIG.Packs.Failed", { error: state.error?.message ?? "?" }, game), error: state.error };
    if (!state.check?.ok) {
      const missing = state.check.missing.map(describeMissing).join("; ");
      return { reason: "blocked", message: t("MAIG.Packs.Blocked", { system: state.pack?.label ?? system, missing }, game), missing: state.check.missing };
    }
    if (doc !== undefined && !supports(doc)) return { reason: "unsupported", message: t("MAIG.Packs.Unsupported", {}, game) };
    return null;
  }

  /** Re-run check() (e.g. after modules/packs changed). -> normalised check or null */
  function recheck() {
    if (state.status !== "ready") return null;
    state.check = safeCheck(state.pack);
    return state.check;
  }

  /** Run the pack's selfTest once (first drawer open). -> { ok, error? } */
  function ensureSelfTest() {
    const pack = getPack();
    if (!pack) return Promise.resolve({ ok: false, error: "no active pack" });
    if (typeof pack.selfTest !== "function") return Promise.resolve({ ok: true, skipped: true });
    selfTestP ??= (async () => {
      let r;
      try { r = await pack.selfTest(); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
      r = { ok: r?.ok === true, ...(r?.error ? { error: String(r.error) } : {}) };
      state.selfTest = r;
      if (!r.ok) { try { log?.warn?.(`moinens-ai-gen | ${t("MAIG.Packs.SelfTestFailed", { error: r.error ?? "?" }, game)}`); } catch { /* ignore */ } }
      return r;
    })();
    return selfTestP;
  }

  /** Plain snapshot of the registry state (safe to log / show). */
  function status() {
    const p = state.pack;
    return {
      status: state.status, systemId: state.systemId ?? sysId(), source: state.source,
      pack: p ? { id: p.id, systemId: p.systemId, version: p.version, label: p.label ?? p.id } : null,
      capabilities: state.contract?.capabilities ?? null,
      check: state.check, error: state.error, selfTest: state.selfTest, contractVersion: CONTRACT_VERSION
    };
  }

  const api = { load, registerSystemPack, getPack, supports, emptyState, recheck, ensureSelfTest, status };
  return api;
}

/**
 * Hook-up from module.mjs (GM branch of `ready`, behind a dynamic import + catch): creates the registry, attaches
 * api.build (GM only) and starts loading the pack for the running system. Returns the registry (or null for players).
 */
export function startBuildRegistry(moduleApi, deps = {}) {
  const game = deps.game ?? globalThis.game;
  if (!game?.user?.isGM) return null;
  const registry = createRegistry(deps);
  // the window in which registerSystemPack() still "queues" (load() not started): let other modules use it (bughunt-2 #10)
  const hooks = "hooks" in deps ? deps.hooks : globalThis.Hooks;
  try { hooks?.callAll?.(HOOK_REGISTER, { registerSystemPack: registry.registerSystemPack, contractVersion: CONTRACT_VERSION }); }
  catch (e) { console.warn("moinens-ai-gen | registerPacks hook failed", e); }
  if (moduleApi) {
    moduleApi.build = Object.assign(moduleApi.build ?? {}, {
      contractVersion: CONTRACT_VERSION,
      registry,
      registerSystemPack: registry.registerSystemPack,
      status: registry.status,
      ready: registry.load()
    });
  } else registry.load();
  return registry;
}
