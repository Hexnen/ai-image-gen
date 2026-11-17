// Invincible system pack (spec 3.2-3.4). Loaded ONLY by the registry (scripts/build/registry.mjs) via dynamic import when
// game.system.id === "invincible", and only in a GM client. Must not touch Foundry globals at import time.
//
// SKELETON (task T3): identity, dependency check and supports() are real. The capability groups are filled in by later
// tasks, each adding its functions to this object (the registry reports a group as missing until all its functions exist;
// a half-filled group is a contract error, so add a group's functions together):
//   prompt   staticPrompt / tools / runTool      T4 (catalog-index.mjs, rules-digest.mjs, tools.mjs) + T8 (prompt text)
//   validate validate                           T5 (proposal.mjs, validate.mjs)
//   sheet    snapshot / diffSnapshots            T12 (reader.mjs, snapshot.mjs)
//   writer   plan / apply / undo / undoStatus    T6 (apply.mjs, pu-bridge.mjs)
//   selfTest (optional)                         T6 (pu-bridge: plus-ultra API self-test, spec 3.3 version guard)
//
// invincible-plus-ultra is an OPTIONAL extra (spec 3.4 option c): never a requirement. It is reported in check().optional;
// the pack works without it (T6 decides per feature through pu-bridge.mjs using puStatus()).

import { detectModule, hasPack, systemInfo, compareVersions } from "../../build/deps.mjs";

export const SYSTEM_ID = "invincible";
export const MIN_SYSTEM_VERSION = "2.1.0";
export const CORE_MODULE = "invincible-core";
// The six chargen packs (plus-ultra Catalog.available) + gear, rules journal, sample heroes and NPC profiles (spec 3.3).
export const CORE_PACKS = Object.freeze(["powers", "power-sources", "boosts", "limits", "talents", "drawbacks", "gears", "core-book", "heroes-villans", "npcs-creatures"]);
export const PU_MODULE = "invincible-plus-ultra";
// API members the soft extras rely on [V: plus-ultra chargen/catalog.mjs start(), apply.mjs applyApi, main.mjs open/canUse].
export const PU_API = Object.freeze(["chargen.catalog", "chargen.provider", "chargen.apply.plan", "chargen.apply.apply", "chargen.apply.undo", "chargen.apply.undoStatus"]);
export const PU_ADDS = Object.freeze(["Full rebuild (plus-ultra)", "archetype and occupation lists", "Open in wizard"]);

// v1 scope (spec O2): superhero + npc actors, gear + vehicleWeapon items.
export const ACTOR_MODES = Object.freeze({ superhero: "superhero", npc: "npc" });
export const ITEM_MODES = Object.freeze({ gear: "gear", vehicleWeapon: "vehicleWeapon" });

let gameRef = null;
const g = () => gameRef ?? globalThis.game;

/** Soft plus-ultra status (Invincible only). Never throws. */
export function puStatus(game = g()) {
  return detectModule(game, PU_MODULE, { api: [...PU_API] });
}

function check() {
  const game = g();
  const missing = [], notes = [];
  const sys = systemInfo(game);
  if (sys.id !== SYSTEM_ID) missing.push({ kind: "system", id: SYSTEM_ID, need: "active", have: sys.id ?? "none" });
  else if (!sys.version || compareVersions(sys.version, MIN_SYSTEM_VERSION) < 0) {
    missing.push({ kind: "version", id: SYSTEM_ID, need: `>= ${MIN_SYSTEM_VERSION}`, have: sys.version ?? "?" });
  }
  const core = detectModule(game, CORE_MODULE);
  if (!core.active) missing.push({ kind: "module", id: CORE_MODULE, need: "active", have: core.installed ? "inactive" : "not installed" });
  else {
    for (const p of CORE_PACKS) if (!hasPack(game, `${CORE_MODULE}.${p}`)) missing.push({ kind: "pack", id: `${CORE_MODULE}.${p}`, need: "present", have: "missing" });
  }
  const pu = puStatus(game);
  const optional = [{ id: PU_MODULE, kind: "module", usable: pu.usable, adds: [...PU_ADDS], detail: pu }];
  if (pu.usable) notes.push(`${PU_MODULE} ${pu.version ?? "?"} detected: extras on`);
  return { ok: !missing.length, missing, optional, notes };
}

function supports(doc) {
  if (!doc) return null;
  const docName = doc.documentName ?? doc.constructor?.documentName;
  const modes = docName === "Actor" ? ACTOR_MODES : docName === "Item" ? ITEM_MODES : null;
  const mode = modes?.[doc.type];
  if (!mode) return null;
  // compendium / locked documents: read-only drawer (spec 10.1)
  const inPack = !!doc.pack;
  const locked = !!doc.compendium?.locked;
  const canWrite = !inPack && !locked && doc.isOwner !== false;
  return { kind: docName === "Actor" ? "actor" : "item", mode, canWrite };
}

const pack = {
  id: "invincible",
  systemId: SYSTEM_ID,
  version: 1,
  label: "Invincible",
  init({ game } = {}) { gameRef = game ?? null; },
  check,
  supports
};

export default pack;
