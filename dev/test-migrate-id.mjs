// Testy zmiany id ai-image-gen -> moinens-ai-gen: kopia ustawień (migrate-id.mjs) na atrapie game/localStorage, potem
// migracja schematu 1 -> 2 w nowej przestrzeni, plus statyczne kontrole repo (stałe, manifest, ścieżki, języki).
// Bez sieci, bez Foundry, wyłącznie fałszywe klucze. Uruchom: node dev/test-migrate-id.mjs (z folderu modułu)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD = "ai-image-gen", NEW = "moinens-ai-gen";

// ---------- atrapy Foundry ----------
class DataField {
  constructor(o = {}) { Object.assign(this, o); }
  getInitialValue() { const i = this.initial; return structuredClone(typeof i === "function" ? i() : i); }
}
class StringField extends DataField {}
class NumberField extends DataField {}
class BooleanField extends DataField {}
class ObjectField extends DataField {}
globalThis.foundry = { data: { fields: { DataField, StringField, NumberField, BooleanField, ObjectField } }, utils: { escapeHTML: (s) => s } };
const hookCalls = [];
globalThis.Hooks = { callAll: (n, v) => hookCalls.push([n, v]), on() {}, off() {} };

class MemStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  snapshot(prefix) { return Object.fromEntries([...this.#m].filter(([k]) => k.startsWith(prefix))); }
}

/** Minimalny game.settings: rejestr, wartości klienta w localStorage (JSON), świata w "dokumentach" Setting. */
function makeGame({ isGM = true, worldDocs = [], ls }) {
  const settings = new Map();
  const world = worldDocs.map((d) => ({ ...d, value: structuredClone(d.value) }));
  const store = {
    getSetting: (key) => world.find((s) => s.key === key) ?? undefined
  };
  const g = {
    user: { id: "gm1", isGM },
    modules: new Map(),
    settings: {
      settings,
      register(ns, key, cfg) { settings.set(`${ns}.${key}`, { ...cfg, key, namespace: ns }); },
      storage: new Map([["world", store], ["client", ls]]),
      get(ns, key) {
        const cfg = settings.get(`${ns}.${key}`);
        if (!cfg) throw new Error(`not registered: ${ns}.${key}`);
        if (cfg.scope === "client") {
          const raw = ls.getItem(`${ns}.${key}`);
          return raw === null ? cfg.type.getInitialValue() : JSON.parse(raw);
        }
        const doc = store.getSetting(`${ns}.${key}`);
        return doc ? structuredClone(doc.value) : cfg.type.getInitialValue();
      },
      async set(ns, key, value) {
        const cfg = settings.get(`${ns}.${key}`);
        if (!cfg) throw new Error(`not registered: ${ns}.${key}`);
        if (cfg.scope === "client") ls.setItem(`${ns}.${key}`, JSON.stringify(value));
        else {
          if (!g.user.isGM) throw new Error("player cannot write world settings");
          const k = `${ns}.${key}`;
          const doc = store.getSetting(k);
          if (doc) doc.value = structuredClone(value); else world.push({ key: k, value: structuredClone(value) });
        }
        cfg.onChange?.(value);
        return value;
      }
    }
  };
  g._world = world;
  return g;
}

// ---------- dane "starego" modułu (wyłącznie fałszywe klucze) ----------
const FAKE = { openai: "sk-test-not-real-openai-0000", gemini: "AIza-test-not-real-gemini", openrouter: "or-test-not-real", anthropic: "ant-test-not-real" };
const seedLocal = (ls) => {
  for (const [p, k] of Object.entries(FAKE)) ls.setItem(`${OLD}.apiKey.${p}`, JSON.stringify(k));
  ls.setItem(`${OLD}.dialogPrefs`, JSON.stringify({ count: 3, mode: "batch" }));
  ls.setItem(`${OLD}.test.invincible|Actor|npc`, JSON.stringify({ description: "zielony olbrzym", count: 2 }));
  ls.setItem(`${OLD}.test.keepmine`, JSON.stringify({ description: "stary" }));
  ls.setItem(`${NEW}.test.keepmine`, JSON.stringify({ description: "nowszy" }));   // już istnieje w nowej przestrzeni
  ls.setItem(`unrelated.key`, "x");
};
const BATCH = { id: "b-123", provider: "openai", status: "pending", createdAt: 1, items: [{ meta: { name: "Kid" } }] };
const oldWorld = () => [
  { key: `${OLD}.limit.daily`, value: 12 },
  { key: `${OLD}.limit.monthly`, value: 20 },          // nowa wartość już ustawiona -> nie nadpisywać
  { key: `${OLD}.limit.perRequest`, value: -4 },        // nieprawidłowa (min 0) -> odrzucić
  { key: `${OLD}.limit.batchSize`, value: 50 },          // równa domyślnej -> nic do kopiowania
  { key: `${OLD}.optimizeImages`, value: false },
  { key: `${OLD}.enhance.model`, value: "claude-opus-5-5" },
  { key: `${OLD}.enhance.effort`, value: "turbo" },      // spoza choices -> odrzucić
  { key: `${OLD}.usage`, value: { day: "2026-11-17", dayUsd: 1.25, month: "2026-11", monthUsd: 7.5 } },
  { key: `${OLD}.imageTypes`, value: { invincible: { Actor: { npc: { provider: "openai", model: "gpt-image-2.5-flare" } } } } }, // schema-1 (zagnieżdżone)
  { key: `${OLD}.schema`, value: 1 },
  { key: `${OLD}.batches`, value: { "b-legacy": { id: "b-legacy", provider: "gemini", status: "done", createdAt: 0 } } },
  { key: `${OLD}.batch.5`, value: BATCH },
  { key: `${NEW}.limit.monthly`, value: 99 }
];

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

const ls = new MemStorage();
seedLocal(ls);
globalThis.window = { localStorage: ls };
globalThis.localStorage = ls;
globalThis.game = makeGame({ ls, worldDocs: oldWorld() });

const C = await import("../scripts/constants.mjs");
const { registerSettings } = await import("../scripts/settings.mjs");
const M = await import("../scripts/migrate-id.mjs");
const { runMigrations } = await import("../scripts/migrate.mjs");
const { tuning } = await import("../scripts/batch/record.mjs");
tuning.verifyMs = 0;
registerSettings();

const oldLocalBefore = ls.snapshot(`${OLD}.`);
const oldWorldBefore = structuredClone(game._world.filter((d) => d.key.startsWith(`${OLD}.`)));

await test("constants: new id, old id, data root kept", () => {
  assert.equal(C.MODULE_ID, NEW);
  assert.equal(C.OLD_MODULE_ID, OLD);
  assert.equal(C.DATA_ROOT, OLD);
});

await test("every copied key is registered in the new namespace", () => {
  for (const k of [...M.CLIENT_KEYS, ...M.WORLD_KEYS, C.MIGRATED_CLIENT, C.MIGRATED_WORLD]) assert.ok(game.settings.settings.has(`${NEW}.${k}`), k);
  assert.ok(M.WORLD_KEYS.includes("batch.31") && M.WORLD_KEYS.includes("batch.0"));
  assert.ok(M.CLIENT_KEYS.includes("apiKey.anthropic"));
});

let first;
await test("GM first run copies keys, world settings, slots and raw prefs", async () => {
  first = await M.migrateFromAiImageGen();
  for (const [p, k] of Object.entries(FAKE)) assert.equal(game.settings.get(NEW, `apiKey.${p}`), k, p);
  assert.equal(game.settings.get(NEW, "limit.daily"), 12);
  assert.equal(game.settings.get(NEW, "optimizeImages"), false);
  assert.equal(game.settings.get(NEW, "enhance.model"), "claude-opus-5-5");
  assert.deepEqual(game.settings.get(NEW, "usage"), oldWorldBefore.find((d) => d.key === `${OLD}.usage`).value);
  assert.deepEqual(game.settings.get(NEW, "batch.5"), BATCH);
  assert.equal(game.settings.get(NEW, "schema"), 1);
  assert.deepEqual(JSON.parse(ls.getItem(`${NEW}.dialogPrefs`)), { count: 3, mode: "batch" });
  assert.deepEqual(JSON.parse(ls.getItem(`${NEW}.test.invincible|Actor|npc`)), { description: "zielony olbrzym", count: 2 });
  assert.equal(game.settings.get(NEW, C.MIGRATED_CLIENT), true);
  assert.equal(game.settings.get(NEW, C.MIGRATED_WORLD), true);
  assert.ok(hookCalls.some(([n, v]) => n === "aiImageGen.batchUpdate" && v?.id === "b-123"), "slot onChange fired");
});

await test("never clobbers newer values; rejects invalid and default-equal old values", () => {
  assert.equal(game.settings.get(NEW, "limit.monthly"), 99);
  assert.equal(game.settings.get(NEW, "limit.perRequest"), 1);
  assert.equal(game.settings.get(NEW, "enhance.effort"), "medium");
  assert.ok(!first.world.includes("limit.batchSize"));
  assert.deepEqual(JSON.parse(ls.getItem(`${NEW}.test.keepmine`)), { description: "nowszy" });
  assert.equal(ls.getItem(`${NEW}.unrelated.key`), null);
});

await test("old values are only read: old localStorage and old world settings unchanged", () => {
  assert.deepEqual(ls.snapshot(`${OLD}.`), oldLocalBefore);
  assert.deepEqual(game._world.filter((d) => d.key.startsWith(`${OLD}.`)), oldWorldBefore);
});

await test("schema 1 -> 2 runs on the copied data in the new namespace (old untouched)", async () => {
  assert.equal(await runMigrations(), true);
  assert.equal(game.settings.get(NEW, "schema"), 2);
  assert.deepEqual(Object.keys(game.settings.get(NEW, "imageTypes")), ["invincible|Actor|npc"]);
  const slots = Array.from({ length: 32 }, (_, i) => game.settings.get(NEW, `batch.${i}`)).filter((r) => r?.id);
  assert.deepEqual(slots.map((r) => r.id).sort(), ["b-123", "b-legacy"]);
  assert.deepEqual(game.settings.get(NEW, "batches"), {});
  assert.deepEqual(game._world.filter((d) => d.key.startsWith(`${OLD}.`)), oldWorldBefore);
});

await test("second start: flags set, nothing copied again even after the user changed values", async () => {
  await game.settings.set(NEW, "limit.daily", 5);   // back to default by hand
  M._resetForTests();
  const again = await M.migrateFromAiImageGen();
  assert.deepEqual(again, { client: [], world: [], raw: [] });
  assert.equal(game.settings.get(NEW, "limit.daily"), 5);
});

await test("a missing registration leaves the flag unset (retried next start)", async () => {
  const ls2 = new MemStorage(); seedLocal(ls2);
  globalThis.window = { localStorage: ls2 }; globalThis.localStorage = ls2;
  globalThis.game = makeGame({ ls: ls2, worldDocs: oldWorld() });
  registerSettings();
  game.settings.settings.delete(`${NEW}.batch.7`);
  M._resetForTests();
  const r = await M.migrateFromAiImageGen();
  assert.ok(r.world.includes("limit.daily"));
  assert.equal(game.settings.get(NEW, C.MIGRATED_WORLD), false);
  assert.equal(game.settings.get(NEW, C.MIGRATED_CLIENT), true);
});

await test("a player copies nothing (not even client keys)", async () => {
  const ls3 = new MemStorage(); seedLocal(ls3);
  globalThis.window = { localStorage: ls3 }; globalThis.localStorage = ls3;
  globalThis.game = makeGame({ isGM: false, ls: ls3, worldDocs: oldWorld() });
  registerSettings();
  M._resetForTests();
  assert.deepEqual(await M.migrateFromAiImageGen(), { client: [], world: [], raw: [] });
  assert.equal(ls3.getItem(`${NEW}.apiKey.openai`), null);
});

await test("fresh world (no old module ever): nothing copied, flags set", async () => {
  const ls4 = new MemStorage();
  globalThis.window = { localStorage: ls4 }; globalThis.localStorage = ls4;
  globalThis.game = makeGame({ ls: ls4, worldDocs: [] });
  registerSettings();
  M._resetForTests();
  assert.deepEqual(await M.migrateFromAiImageGen(), { client: [], world: [], raw: [] });
  assert.equal(game.settings.get(NEW, C.MIGRATED_CLIENT), true);
  assert.equal(game.settings.get(NEW, C.MIGRATED_WORLD), true);
});

await test("coerce / parseStored edge cases", () => {
  const F = foundry.data.fields;
  assert.equal(M.coerce({ type: new F.NumberField({ min: 0 }) }, "7"), 7);
  assert.equal(M.coerce({ type: new F.NumberField({ min: 0 }) }, "x"), undefined);
  assert.equal(M.coerce({ type: new F.BooleanField() }, "true"), undefined);
  assert.equal(M.coerce({ type: new F.StringField({ choices: { a: "A" } }) }, "b"), undefined);
  assert.equal(M.coerce({ type: new F.ObjectField() }, [1]), undefined);
  assert.equal(M.coerce({ type: {} }, "x"), undefined);
  assert.equal(M.parseStored("not json"), "not json");
  assert.equal(M.parseStored(null), undefined);
});

// ---------- statyczne kontrole repo ----------
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

await test("manifest: id/title match the constants", () => {
  const m = JSON.parse(read("module.json"));
  assert.equal(m.id, NEW);
  assert.equal(m.title, "Moinens AI Gen");
  assert.ok(!m.relationships?.requires?.some?.((r) => r.id === "invincible-plus-ultra"), "no requires on plus-ultra");
});

await test("scripts: no old id outside constants; data paths via DATA_ROOT; templates via MODULE_ID", () => {
  for (const f of walk("scripts").filter((f) => f.endsWith(".mjs"))) {
    const code = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");   // comments may name the data folder
    if (f.endsWith("constants.mjs")) continue;
    assert.ok(!code.includes(`"${OLD}"`) && !code.includes(`'${OLD}'`), `${f}: literal old id`);
    assert.ok(!/[`"']ai-image-gen\//.test(code), `${f}: hard-coded data path`);
    assert.ok(!/\$\{MODULE_ID\}\/_(log|refs|tests|candidates)/.test(code), `${f}: data path built from MODULE_ID`);
    assert.ok(!/modules\/ai-image-gen/.test(code), `${f}: old template path`);
  }
});

await test("lang: en and pl have the same keys, new warning present, no old title left", () => {
  const en = JSON.parse(read("lang/en.json")), pl = JSON.parse(read("lang/pl.json"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pl).sort());
  assert.ok(en["AIIMG.Rename.BothActive"] && pl["AIIMG.Rename.BothActive"]);
  for (const [k, v] of [...Object.entries(en), ...Object.entries(pl)]) {
    if (k === "AIIMG.Rename.BothActive") continue;
    assert.ok(!v.includes("AI Image Gen"), k);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
process.exit(process.exitCode ?? 0);
