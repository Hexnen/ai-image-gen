// System-pack registry tests (spec 3.2/3.3, task T3). Node, mock `game`, no Foundry, no network.
// Run: node dev/test-packs.mjs (from the module folder)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createRegistry, startBuildRegistry, validatePack, safeCheck, BUNDLED_PACKS, CAPABILITIES, HOOK_READY
} from "../scripts/build/registry.mjs";
import { compareVersions, detectModule } from "../scripts/build/deps.mjs";
import { t } from "../scripts/build/registry-lang.mjs";
import invPack, { CORE_PACKS, PU_MODULE, CORE_MODULE } from "../scripts/systems/invincible/pack.mjs";
import stubDefault, { makeStubPack } from "../scripts/systems/_stub/pack.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

/* ---------------------------------------------------------------- mocks */
const PU_API_OBJ = () => ({ chargen: { catalog: {}, provider: () => ({}), apply: { plan() {}, apply() {}, undo() {}, undoStatus() {} } } });
function mockGame({ system = "invincible", sysVersion = "2.1.8", gm = true, modules = {}, packs = null, lang = "en" } = {}) {
  const mods = new Map(Object.entries(modules));
  const packIds = new Set(packs ?? CORE_PACKS.map((p) => `${CORE_MODULE}.${p}`));
  return {
    system: { id: system, version: sysVersion },
    user: { isGM: gm },
    modules: { get: (id) => mods.get(id) },
    packs: { get: (id) => (packIds.has(id) ? { collection: id } : undefined) },
    i18n: { lang, has: () => false, format: (k) => k }
  };
}
const coreMod = { active: true, version: "1.0.2" };
const puMod = (over = {}) => ({ active: true, version: "0.20.2", api: PU_API_OBJ(), ...over });
function spyDeps(game, loaders) {
  const notes = [], hookCalls = [], store = new Map();
  return {
    notes, hookCalls, store,
    deps: {
      game, loaders,
      notify: (level, msg) => notes.push({ level, msg }),
      hooks: { callAll: (name, data) => hookCalls.push({ name, data }) },
      log: { error() {}, warn() {}, info() {} },
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    }
  };
}
const spyLoader = (mod) => { const f = async () => { f.calls++; return mod; }; f.calls = 0; return f; };
const actor = (type, extra = {}) => ({ documentName: "Actor", type, isOwner: true, ...extra });
const item = (type, extra = {}) => ({ documentName: "Item", type, isOwner: true, ...extra });

/* ---------------------------------------------------------------- contract */
await test("validatePack: stub pack is complete, every capability present", () => {
  const v = validatePack(stubDefault);
  assert.equal(v.ok, true, v.errors.join("; "));
  for (const g of Object.keys(CAPABILITIES)) assert.equal(v.capabilities[g], true, g);
});

await test("validatePack: invincible skeleton is valid, capability groups reported missing (later tasks fill them)", () => {
  const v = validatePack(invPack);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.deepEqual(v.capabilities, { prompt: false, validate: false, sheet: false, writer: false });
});

await test("validatePack: junk, missing required, partial capability group, wrong types are refused", () => {
  assert.equal(validatePack(null).ok, false);
  assert.equal(validatePack({ id: "x", systemId: "x", version: 1, supports() {} }).ok, false); // no check
  const partial = { ...makeStubPack(), apply: undefined };
  const v = validatePack(partial);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /writer.*partial/);
  assert.equal(validatePack({ ...makeStubPack(), version: 1.5 }).ok, false);
  assert.equal(validatePack({ ...makeStubPack(), tools: "nope" }).ok, false);
});

await test("safeCheck: a throwing or async check() becomes a blocking result, never throws", () => {
  const r1 = safeCheck({ id: "p", check() { throw new Error("boom"); } });
  assert.equal(r1.ok, false); assert.match(r1.missing[0].have, /boom/);
  const r2 = safeCheck({ id: "p", check: async () => ({ ok: true }) });
  assert.equal(r2.ok, false);
  const r3 = safeCheck({ id: "p", check: () => ({ ok: true, missing: [{ kind: "module", id: "m" }] }) });
  assert.equal(r3.ok, false, "missing entries override ok:true");
});

/* ---------------------------------------------------------------- loading by system */
await test("matching system: only its loader is called, pack becomes ready, hook fires", async () => {
  const game = mockGame({ modules: { [CORE_MODULE]: coreMod, [PU_MODULE]: puMod() } });
  const inv = spyLoader({ default: invPack }), other = spyLoader({ default: makeStubPack({ systemId: "dnd5e" }) });
  const s = spyDeps(game, { invincible: inv, dnd5e: other });
  const reg = createRegistry(s.deps);
  const pack = await reg.load();
  assert.equal(pack, invPack);
  assert.equal(inv.calls, 1); assert.equal(other.calls, 0);
  const st = reg.status();
  assert.equal(st.status, "ready"); assert.equal(st.check.ok, true); assert.equal(st.source, "bundled");
  assert.equal(s.hookCalls.length, 1); assert.equal(s.hookCalls[0].name, HOOK_READY);
  assert.equal(reg.emptyState(), null);
  assert.deepEqual(reg.supports(actor("superhero")), { kind: "actor", mode: "superhero", canWrite: true });
  assert.equal(s.notes.length, 0, "everything present: no notification");
  await reg.load(); assert.equal(inv.calls, 1, "load is once");
});

await test("other system: nothing is loaded, nothing of Invincible, no notification, empty state no-pack", async () => {
  for (const system of ["dnd5e", "pf2e", "worldbuilding", "invincible-not"]) {
    const game = mockGame({ system, modules: { [CORE_MODULE]: coreMod, [PU_MODULE]: puMod() } });
    const inv = spyLoader({ default: invPack });
    const s = spyDeps(game, { invincible: inv });
    const reg = createRegistry(s.deps);
    assert.equal(await reg.load(), null);
    assert.equal(inv.calls, 0, system);
    assert.equal(reg.status().status, "none");
    assert.equal(reg.getPack(), null);
    assert.equal(reg.supports(actor("superhero")), null);
    assert.equal(reg.emptyState(actor("character")).reason, "no-pack");
    assert.equal(s.notes.length, 0); assert.equal(s.hookCalls.length, 0);
  }
});

await test("prototype keys are not loaders (system id 'constructor' / '__proto__')", async () => {
  for (const system of ["constructor", "__proto__", "toString"]) {
    const s = spyDeps(mockGame({ system }), BUNDLED_PACKS);
    const reg = createRegistry(s.deps);
    assert.equal(await reg.load(), null);
    assert.equal(reg.status().status, "none");
  }
});

await test("real BUNDLED_PACKS loader resolves the invincible pack file", async () => {
  const s = spyDeps(mockGame({ modules: { [CORE_MODULE]: coreMod } }), BUNDLED_PACKS);
  const reg = createRegistry(s.deps);
  const p = await reg.load();
  assert.equal(p?.id, "invincible");
});

/* ---------------------------------------------------------------- plus-ultra optional */
await test("plus-ultra absent: pack ready and unblocked, optional reported once (info), never blocking", async () => {
  const game = mockGame({ modules: { [CORE_MODULE]: coreMod } });
  const s = spyDeps(game, { invincible: spyLoader({ default: invPack }) });
  const reg = createRegistry(s.deps);
  await reg.load();
  const st = reg.status();
  assert.equal(st.check.ok, true);
  const pu = st.check.optional.find((o) => o.id === PU_MODULE);
  assert.equal(pu.usable, false); assert.equal(pu.detail.installed, false);
  assert.ok(reg.getPack());
  assert.equal(s.notes.length, 1); assert.equal(s.notes[0].level, "info");
  assert.match(s.notes[0].msg, /invincible-plus-ultra.*not installed/);
  // second load in the same browser: notice deduped through storage
  const reg2 = createRegistry({ ...s.deps });
  await reg2.load();
  assert.equal(s.notes.length, 1, "shown once per browser");
});

await test("plus-ultra installed but inactive / API incomplete: usable false with the reason", async () => {
  const g1 = mockGame({ modules: { [CORE_MODULE]: coreMod, [PU_MODULE]: puMod({ active: false }) } });
  const s1 = spyDeps(g1, { invincible: spyLoader({ default: invPack }) });
  const r1 = createRegistry(s1.deps); await r1.load();
  assert.equal(r1.status().check.ok, true);
  assert.match(s1.notes[0].msg, /not enabled/);
  const api = PU_API_OBJ(); delete api.chargen.apply.undoStatus;
  const g2 = mockGame({ modules: { [CORE_MODULE]: coreMod, [PU_MODULE]: puMod({ api }) } });
  const s2 = spyDeps(g2, { invincible: spyLoader({ default: invPack }) });
  const r2 = createRegistry(s2.deps); await r2.load();
  const pu = r2.status().check.optional[0];
  assert.equal(pu.usable, false); assert.deepEqual(pu.detail.missingApi, ["chargen.apply.undoStatus"]);
  assert.match(s2.notes[0].msg, /chargen\.apply\.undoStatus/);
});

await test("plus-ultra present: usable, no notification, note says extras on", async () => {
  const s = spyDeps(mockGame({ modules: { [CORE_MODULE]: coreMod, [PU_MODULE]: puMod() } }), { invincible: spyLoader({ default: invPack }) });
  const reg = createRegistry(s.deps); await reg.load();
  const st = reg.status();
  assert.equal(st.check.optional[0].usable, true);
  assert.ok(st.check.notes.some((n) => /extras on/.test(n)));
  assert.equal(s.notes.length, 0);
});

/* ---------------------------------------------------------------- hard requirements */
await test("invincible-core missing / a pack missing / old system: blocked with named items, warn once", async () => {
  const cases = [
    [mockGame({ modules: {} }), /module invincible-core/],
    [mockGame({ modules: { [CORE_MODULE]: coreMod }, packs: ["invincible-core.powers"] }), /pack invincible-core\.boosts/],
    [mockGame({ sysVersion: "2.0.9", modules: { [CORE_MODULE]: coreMod } }), /version invincible >= 2\.1\.0/]
  ];
  for (const [game, re] of cases) {
    const s = spyDeps(game, { invincible: spyLoader({ default: invPack }) });
    const reg = createRegistry(s.deps); await reg.load();
    assert.equal(reg.status().status, "ready");
    assert.equal(reg.getPack(), null, "blocked pack is not handed out");
    assert.equal(reg.supports(actor("superhero")), null);
    const es = reg.emptyState(actor("superhero"));
    assert.equal(es.reason, "blocked"); assert.match(es.message, re);
    assert.ok(s.notes.some((n) => n.level === "warn" && re.test(n.msg)));
  }
});

/* ---------------------------------------------------------------- broken packs */
await test("broken pack import does not throw: status failed, one GM error notification, core untouched", async () => {
  const bad = async () => { throw new SyntaxError("Unexpected token in pack.mjs"); };
  const s = spyDeps(mockGame({ modules: { [CORE_MODULE]: coreMod } }), { invincible: bad });
  const reg = createRegistry(s.deps);
  assert.equal(await reg.load(), null);
  const st = reg.status();
  assert.equal(st.status, "failed"); assert.equal(st.error.code, "import");
  assert.equal(s.notes.length, 1); assert.equal(s.notes[0].level, "error");
  assert.equal(reg.emptyState(actor("superhero")).reason, "failed");
  assert.equal(reg.supports(actor("superhero")), null);
});

await test("startBuildRegistry with a broken pack: moduleApi stays usable, api.build.ready resolves null", async () => {
  const moduleApi = { generate() { return "image"; } };
  const s = spyDeps(mockGame({ modules: { [CORE_MODULE]: coreMod } }), { invincible: async () => { throw new Error("404"); } });
  startBuildRegistry(moduleApi, s.deps);
  assert.equal(await moduleApi.build.ready, null);
  assert.equal(moduleApi.generate(), "image");
  assert.equal(moduleApi.build.status().status, "failed");
});

await test("invalid pack object, wrong systemId, throwing init, missing default export: failed, never throws", async () => {
  const variants = [
    [{ default: { id: "invincible" } }, "invalid"],
    [{ default: makeStubPack({ systemId: "dnd5e" }) }, "wrong-system"],
    [{ default: { ...makeStubPack({ systemId: "invincible" }), init() { throw new Error("init boom"); } } }, "init"],
    [{}, "invalid"]
  ];
  for (const [mod, code] of variants) {
    const s = spyDeps(mockGame({ modules: { [CORE_MODULE]: coreMod } }), { invincible: spyLoader(mod) });
    const reg = createRegistry(s.deps);
    assert.equal(await reg.load(), null, code);
    assert.equal(reg.status().error.code, code);
    assert.equal(s.notes.filter((n) => n.level === "error").length, 1);
  }
});

await test("pack whose check() throws: blocked, not failed; supports() throwing returns null", async () => {
  const p = { ...makeStubPack({ systemId: "invincible" }), check() { throw new Error("x"); } };
  const s = spyDeps(mockGame(), { invincible: spyLoader({ default: p }) });
  const reg = createRegistry(s.deps); await reg.load();
  assert.equal(reg.status().status, "ready"); assert.equal(reg.getPack(), null);
  const p2 = { ...makeStubPack({ systemId: "invincible" }), supports() { throw new Error("y"); } };
  const s2 = spyDeps(mockGame(), { invincible: spyLoader({ default: p2 }) });
  const reg2 = createRegistry(s2.deps); await reg2.load();
  assert.equal(reg2.supports(actor("x")), null);
});

/* ---------------------------------------------------------------- GM only */
await test("player client: no loader call, no api.build, no notification", async () => {
  const game = mockGame({ gm: false, modules: { [CORE_MODULE]: coreMod, [PU_MODULE]: puMod() } });
  const inv = spyLoader({ default: invPack });
  const s = spyDeps(game, { invincible: inv });
  const moduleApi = {};
  assert.equal(startBuildRegistry(moduleApi, s.deps), null);
  assert.equal(moduleApi.build, undefined);
  const reg = createRegistry(s.deps);
  assert.equal(await reg.load(), null);
  assert.equal(inv.calls, 0);
  assert.equal(reg.status().status, "not-gm");
  assert.equal(reg.supports(actor("superhero")), null);
  assert.equal(reg.emptyState().reason, "not-gm");
  assert.equal(reg.registerSystemPack(makeStubPack({ systemId: "invincible" })).ok, false);
  assert.equal(s.notes.length, 0);
});

/* ---------------------------------------------------------------- external registration */
await test("registerSystemPack: other system ignored; on a system without bundled pack it activates; never replaces an active pack", async () => {
  const s = spyDeps(mockGame({ system: "dnd5e" }), {});
  const reg = createRegistry(s.deps);
  assert.equal(reg.registerSystemPack(makeStubPack({ systemId: "pf2e" })).reason, "other-system");
  assert.equal(reg.registerSystemPack({ id: "bad" }).ok, false);
  // queued before load -> used by load
  const queued = makeStubPack({ systemId: "dnd5e", id: "dnd-ext" });
  assert.equal(reg.registerSystemPack(queued).reason, "queued");
  assert.equal(await reg.load(), queued);
  assert.equal(reg.status().source, "registered");
  assert.equal(reg.registerSystemPack(makeStubPack({ systemId: "dnd5e", id: "second" })).reason, "pack-already-active");
  // after load found nothing -> activates
  const s2 = spyDeps(mockGame({ system: "dnd5e" }), {});
  const reg2 = createRegistry(s2.deps);
  await reg2.load();
  assert.equal(reg2.status().status, "none");
  assert.equal(reg2.registerSystemPack(makeStubPack({ systemId: "dnd5e" })).reason, "activated");
  await reg2.load();
  assert.equal(reg2.status().status, "ready");
});

/* ---------------------------------------------------------------- supports + self-test */
await test("invincible supports(): v1 scope only; compendium/locked docs read-only", async () => {
  invPack.init({ game: mockGame({ modules: { [CORE_MODULE]: coreMod } }) });
  assert.equal(invPack.supports(actor("npc")).mode, "npc");
  assert.equal(invPack.supports(item("gear")).kind, "item");
  assert.equal(invPack.supports(item("vehicleWeapon")).mode, "vehicleWeapon");
  for (const t of ["minions", "challenge", "vehicle"]) assert.equal(invPack.supports(actor(t)), null, t);
  for (const t of ["power", "talent", "criticalInjury"]) assert.equal(invPack.supports(item(t)), null, t);
  assert.equal(invPack.supports(actor("superhero", { pack: "world.heroes" })).canWrite, false);
  assert.equal(invPack.supports(actor("superhero", { compendium: { locked: true } })).canWrite, false);
  assert.equal(invPack.supports(actor("superhero", { isOwner: false })).canWrite, false);
  assert.equal(invPack.supports(null), null);
});

await test("ensureSelfTest runs once; throwing selfTest = ok:false; pack without selfTest = skipped", async () => {
  let n = 0;
  const p = { ...makeStubPack({ systemId: "invincible" }), selfTest: async () => { n++; throw new Error("api changed"); } };
  const s = spyDeps(mockGame(), { invincible: spyLoader({ default: p }) });
  const reg = createRegistry(s.deps); await reg.load();
  const r = await reg.ensureSelfTest(); await reg.ensureSelfTest();
  assert.equal(r.ok, false); assert.match(r.error, /api changed/); assert.equal(n, 1);
  assert.equal(reg.status().selfTest.ok, false);
  const s2 = spyDeps(mockGame({ modules: { [CORE_MODULE]: coreMod } }), { invincible: spyLoader({ default: invPack }) });
  const reg2 = createRegistry(s2.deps); await reg2.load();
  assert.equal((await reg2.ensureSelfTest()).skipped, true);
});

/* ---------------------------------------------------------------- helpers + i18n */
await test("compareVersions / detectModule", () => {
  assert.equal(compareVersions("2.1.8", "2.1.0"), 1);
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
  assert.equal(compareVersions("2.0.10", "2.0.9"), 1);
  assert.equal(compareVersions("13.351", "14"), -1);
  const d = detectModule(mockGame({ modules: { m: { active: true, version: "1.0.0", api: { a: { b: 1 } } } } }), "m", { minVersion: "1.2", api: ["a.b", "a.c"] });
  assert.deepEqual([d.active, d.versionOk, d.missingApi, d.usable], [true, false, ["a.c"], false]);
  assert.equal(detectModule({ modules: { get() { throw new Error("x"); } } }, "m").installed, false);
});

await test("messages: Polish when game.i18n.lang is pl, lang-file key wins when present", () => {
  assert.match(t("MAIG.Packs.NoPack", { system: "dnd5e" }, { i18n: { lang: "pl", has: () => false } }), /nie ma jeszcze pakietu.*dnd5e/);
  assert.match(t("MAIG.Packs.NoPack", { system: "dnd5e" }, { i18n: { lang: "en", has: () => false } }), /no pack.*dnd5e/);
  assert.equal(t("MAIG.Packs.NoPack", {}, { i18n: { has: () => true, format: () => "FROM LANG" } }), "FROM LANG");
});

/* ---------------------------------------------------------------- static repo checks */
await test("module.json: no requires on plus-ultra / invincible-core; core files import no system pack statically", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
  const req = manifest.relationships?.requires ?? [];
  assert.ok(!req.some((r) => [PU_MODULE, CORE_MODULE].includes(r.id)), "no hard requirement");
  assert.ok(!(manifest.relationships?.systems ?? []).some((s) => s.id === "invincible"), "no system lock");
  for (const f of ["scripts/module.mjs", "scripts/build/registry.mjs", "scripts/build/deps.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.ok(!/^\s*import\s[^(]*from\s*["'][^"']*systems\//m.test(src), `${f} has a static import of a system pack`);
  }
  const mm = readFileSync(join(ROOT, "scripts/module.mjs"), "utf8");
  assert.ok(!/^\s*import\s[^(]*from\s*["'][^"']*build\/registry/m.test(mm), "module.mjs must load the registry dynamically");
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
