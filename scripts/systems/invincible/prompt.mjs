// Prompt capability group of the Invincible pack (registry contract "prompt": staticPrompt / tools / runTool; task T4).
// Kept out of pack.mjs so parallel tasks only touch their own group there.
//
// staticPrompt() -> { rulesDigest, catalogIndex, fingerprint }: system[1] and system[2] of the cached prefix (spec 9.1).
//   Byte-stable for the same pack version + installed catalogue: no timestamps, no world/actor/user names, sorted output.
//   fingerprint = hash of everything static (digest, index, tool schemas, pack version), so the harness can tell when the
//   cached prefix changed.
// tools() -> the read tools of tools.mjs, plus the proposal tools of the validate group when that group provides them
//   (convention for T5: pack.proposalTools(): ToolDef[] and pack.runProposalTool(name, input, ctx); see catalog-notes C7).
// runTool(name, input, ctx) -> plain result object (the harness serialises it; toolResultText in tools.mjs).

import { getCatalog, foundrySource, indexText, hash } from "./catalog.mjs";
import { rulesDigest, DIGEST_VERSION } from "./rules-digest.mjs";
import { makeReadTools, READ_TOOL_NAMES } from "./tools.mjs";

const PU_MODULE = "invincible-plus-ultra";

/**
 * promptGroup(getPack, deps) -> { staticPrompt, tools, runTool }
 *   getPack(): the pack object (for version, proposal tools, snapshot), deps: { source, game } for tests.
 */
export function promptGroup(getPack, deps = {}) {
  let src = deps.source ?? null;
  const source = () => (src ??= foundrySource(deps.game ?? globalThis.game));
  const catalog = () => getCatalog(deps.source ?? null);
  const extras = {
    // plus-ultra (soft, Invincible only): structured archetype data parsed by its wizard (spec 3.4 c)
    async archetype(name) {
      const game = deps.game ?? globalThis.game;
      const mod = game?.modules?.get?.(PU_MODULE);
      const fn = mod?.active ? mod.api?.chargen?.catalog?.getArchetype : null;
      return typeof fn === "function" ? fn(name) : null;
    }
  };
  let reader = null;
  const readTools = () => (reader ??= makeReadTools({
    getCatalog: catalog, source: source(), extras,
    snapshot: (doc, opts) => (typeof getPack()?.snapshot === "function" ? getPack().snapshot(doc, opts) : null)
  }));

  const extraTools = () => {
    const p = getPack();
    const list = typeof p?.proposalTools === "function" ? p.proposalTools() ?? [] : [];
    return list.filter((t) => t && !READ_TOOL_NAMES.includes(t.name));
  };
  const tools = () => [...readTools().defs(), ...extraTools()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let staticP = null, staticKey = null;
  async function staticPrompt() {
    const cat = await catalog();
    const key = cat.meta.sourceFingerprint;
    if (staticP && staticKey === key) return staticP;
    const rules = rulesDigest();
    const index = indexText(cat);
    const version = getPack()?.version ?? 0;
    const fingerprint = hash([`pack:${version}`, `digest:${DIGEST_VERSION}`, rules, index, JSON.stringify(tools())].join("\n\u0000"));
    staticKey = key;
    staticP = { rulesDigest: rules, catalogIndex: index, fingerprint, ...(cat.meta.missing?.length ? { missing: [...cat.meta.missing] } : {}) };
    return staticP;
  }

  async function runTool(name, input, ctx = {}) {
    if (READ_TOOL_NAMES.includes(name)) return readTools().run(name, input ?? {}, ctx);
    const p = getPack();
    if (typeof p?.runProposalTool === "function" && extraTools().some((t) => t.name === name)) return p.runProposalTool(name, input ?? {}, ctx);
    return { ok: false, error: { code: "tool.unknown", message: `Unknown tool "${name}".` } };
  }

  return { staticPrompt, tools, runTool };
}
