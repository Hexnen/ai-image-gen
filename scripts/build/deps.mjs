// PURE helpers for dependency checks of system packs (spec 3.3). No Foundry globals at import time: every function takes
// the `game`-like object as a parameter, so node tests pass a mock. Never throws.

/** "2.1.8" vs "2.1.0" -> 1 / 0 / -1. Missing parts count as 0; non-numeric parts compare as strings. */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(/[.+-]/), pb = String(b ?? "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) { if (nx !== ny) return nx > ny ? 1 : -1; }
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const getPath = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * Soft detection of another module. `api` = dotted paths under `module.api` that must exist (e.g. "chargen.apply.plan").
 * -> { id, installed, active, version, versionOk, missingApi, usable }  (usable = active && versionOk && no missing api)
 */
export function detectModule(game, id, { minVersion = null, api = [] } = {}) {
  let mod = null;
  try { mod = game?.modules?.get?.(id) ?? null; } catch { mod = null; }
  const version = mod?.version ?? mod?.data?.version ?? null;
  const active = !!mod?.active;
  const versionOk = !minVersion || (version != null && compareVersions(version, minVersion) >= 0);
  const missingApi = active ? api.filter((p) => getPath(mod?.api, p) == null) : [...api];
  return { id, installed: !!mod, active, version, minVersion, versionOk, missingApi, usable: active && versionOk && !missingApi.length };
}

/** game.packs lookup that never throws. */
export function hasPack(game, collectionId) {
  try { return !!game?.packs?.get?.(collectionId); } catch { return false; }
}

/** System id/version of the running world (null when absent). */
export function systemInfo(game) {
  return { id: game?.system?.id ?? null, version: game?.system?.version ?? game?.system?.data?.version ?? null };
}
