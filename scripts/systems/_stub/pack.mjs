// STUB system pack: a complete, harmless implementation of the pack contract (scripts/build/registry.mjs header).
// Not in BUNDLED_PACKS, so it is never loaded in a world. Uses: (1) the reference to copy when adding a pack for a new
// system, (2) a mock for the drawer (T7) and harness tests (T2) before the Invincible pack is complete, (3) dev/test-packs.mjs.
// makeStubPack({ systemId }) returns a fresh object, so a test can serve any system id.

export function makeStubPack({ systemId = "stub-system", id = systemId, version = 1, label = "Stub" } = {}) {
  const tools = [{
    name: "search_catalog",
    description: "Stub catalogue search: always returns an empty list.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" } } }
  }];
  const emptyPlan = { fields: [], creates: [], deletes: [], keeps: [], counts: {}, destructive: false, errors: [], warnings: [] };
  return {
    id, systemId, version, label,
    check: () => ({ ok: true, missing: [], optional: [], notes: ["stub pack"] }),
    supports: (doc) => (doc?.documentName === "Actor" ? { kind: "actor", mode: "stub", canWrite: false } : null),
    // prompt
    staticPrompt: async () => ({ rulesDigest: "Stub rules.", catalogIndex: "", fingerprint: `stub-${version}` }),
    tools: () => tools,
    runTool: async (name) => ({ ok: name === "search_catalog", results: [] }),
    // validate
    validate: async () => ({ ok: true, errors: [], warnings: [], info: [], budget: null }),
    // sheet
    snapshot: async (doc) => {
      const text = `<sheet doc="${doc?.uuid ?? "?"}" type=${doc?.type ?? "?"}>\n</sheet>`;
      return { text, fingerprint: "stub", lines: new Map(), tokensEst: Math.ceil(text.length / 4) };
    },
    diffSnapshots: () => "",
    // writer: never writes
    plan: async () => ({ ...emptyPlan }),
    apply: async () => ({ ok: false, ...emptyPlan, errors: [{ code: "stub.readOnly", message: "The stub pack never writes." }] }),
    undo: async () => ({ ok: false, errors: [{ code: "stub.noUndo", message: "Nothing to undo." }] }),
    undoStatus: () => ({ available: false, runId: null, age: null, drift: false }),
    selfTest: async () => ({ ok: true })
  };
}

export default makeStubPack({ systemId: "_stub", id: "_stub" });
