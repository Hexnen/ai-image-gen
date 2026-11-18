// W6-H: GM-only world key store (scripts/key-store.mjs) + in-memory vault and migration (scripts/key-vault.mjs).
// The fake server below copies the rules of Foundry v14's data storage that the store relies on (dist/files/local.mjs):
// a private directory is hidden from and refused to non-admin browsing; a non-media file cannot be overwritten; an
// svg can. FAKE keys only, no network. Run from the module folder: node dev/test-key-store.mjs
import assert from "node:assert/strict";
import {
  createKeyStore, encodeStore, decodeStore, randomName, STORE_PREFIX, STORE_FILE, STORE_PROVIDERS
} from "../scripts/key-store.mjs";
import {
  configureVault, initVault, vaultKey, vaultConflicts, vaultStatus, saveVault, reloadVault, MIGRATED_FLAG, FOLLOW_STORE,
  listenVault, SOCKET_TYPE, PING_GAP_MS
} from "../scripts/key-vault.mjs";

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

const FAKE = { openai: "sk-TEST-0000", gemini: "AIzaTEST-0000", openrouter: "sk-or-TEST-0000", anthropic: "sk-ant-TEST-0000" };
const PARENT = "worlds/invincible";

/** Fake "data" storage with Foundry's private-directory and overwrite rules. */
function fakeServer() {
  const dirs = new Map([[PARENT, { private: false }]]);
  const files = new Map();
  const srv = {
    dirs, files, failUpload: false, failConfigure: false, failBrowse: false, uploads: 0,
    browse(target, { admin }) {
      if (srv.failBrowse) throw new Error("browse failed");
      const d = dirs.get(target);
      if (!d || (d.private && !admin)) throw new Error(`Directory ${target} does not exist or is not accessible`);
      const out = { dirs: [], privateDirs: [], files: [] };
      for (const [p, c] of dirs) {
        if (!p.startsWith(`${target}/`) || p.slice(target.length + 1).includes("/")) continue;
        if (c.private) { if (!admin) continue; out.privateDirs.push(p); }
        out.dirs.push(p);
      }
      for (const f of files.keys()) if (f.startsWith(`${target}/`) && !f.slice(target.length + 1).includes("/")) out.files.push(f);
      return out;
    },
    adapter({ admin = true } = {}) {
      return {
        parent: PARENT,
        rng: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } },
        browse: async (t) => srv.browse(t, { admin }),
        createDirectory: async (t) => { if (!admin) throw new Error("no"); if (dirs.has(t)) throw new Error("exists"); dirs.set(t, { private: false }); },
        configurePath: async (t, o) => { if (srv.failConfigure) return; dirs.get(t).private = !!o.private; },
        upload: async (dir, name, text) => {
          if (srv.failUpload) return false;
          const p = `${dir}/${name}`;
          if (files.has(p) && !/\.(svg|png|webp)$/.test(name)) throw new Error("You may not upload non-media files which would overwrite an existing file");
          files.set(p, text); srv.uploads++; return true;
        },
        // static file serving: anyone with the exact path (that is the capability)
        fetchText: async (p) => (files.has(p) ? files.get(p) : null)
      };
    }
  };
  return srv;
}

/** Fake client settings (this browser's localStorage) + game. */
function fakeClient(initial = {}, { isGM = true } = {}) {
  const ls = new Map(Object.entries(initial).map(([p, v]) => [`apiKey.${p}`, v]));
  const notes = [];
  return {
    ls, notes, emits: 0,
    deps(server) {
      const self = this;
      return {
        isGM: () => isGM,
        getClient: (p) => String(ls.get(`apiKey.${p}`) ?? ""),
        getSetting: (k, fb) => (ls.has(k) ? ls.get(k) : fb),
        setSetting: async (k, v) => { ls.set(k, v); },
        notify: (level, key) => notes.push(`${level}:${key}`),
        emit: () => { self.emits++; },
        store: () => createKeyStore(server.adapter({ admin: isGM }))
      };
    },
    clientKeys: () => Object.fromEntries(STORE_PROVIDERS.map((p) => [p, ls.get(`apiKey.${p}`)]))
  };
}

const storedKeys = (srv) => {
  const f = [...srv.files.keys()].find((k) => k.endsWith(`/${STORE_FILE}`));
  return f ? decodeStore(srv.files.get(f)) : null;
};

await test("encode/decode round trip; the svg does not contain the key in clear text", () => {
  const svg = encodeStore(FAKE);
  assert.deepEqual(decodeStore(svg), FAKE);
  for (const v of Object.values(FAKE)) assert.ok(!svg.includes(v));
  assert.ok(svg.startsWith("<svg"));
  assert.deepEqual(decodeStore(encodeStore({ openai: "", junk: "x", gemini: 5 })), {});
  assert.throws(() => decodeStore("<svg/>"), /expected format/);
  assert.throws(() => decodeStore("<!--moinens-ai-gen-keys:%%%-->"), (e) => !String(e.message).includes("TEST"));
});

await test("random directory name carries 128 bits (32 hex)", () => {
  const n = randomName();
  assert.match(n, new RegExp(`^${STORE_PREFIX}[0-9a-f]{32}$`));
  assert.notEqual(randomName(), n);
});

await test("save creates a PRIVATE random directory; a non-admin cannot list or browse it", async () => {
  const srv = fakeServer();
  const st = createKeyStore(srv.adapter());
  await st.save(FAKE);
  const dir = st.dir;
  assert.ok(dir.startsWith(`${PARENT}/${STORE_PREFIX}`));
  assert.equal(srv.dirs.get(dir).private, true);
  const player = srv.adapter({ admin: false });
  const listing = await player.browse(PARENT);
  assert.deepEqual(listing.dirs, []);
  await assert.rejects(player.browse(dir), /not accessible/);
  // the player store sees nothing
  const ps = createKeyStore(player);
  assert.deepEqual((await ps.load()).keys, {});
  // GM in a NEW browser (fresh store object) finds it by browsing
  assert.deepEqual((await createKeyStore(srv.adapter()).load()).keys, FAKE);
});

await test("never writes keys into a directory that is not private", async () => {
  const srv = fakeServer(); srv.failConfigure = true;
  const st = createKeyStore(srv.adapter());
  await assert.rejects(st.save(FAKE), /could not be made private/);
  assert.equal(srv.uploads, 0);
  assert.equal(srv.files.size, 0);
});

await test("overwrite in place: one file after several saves", async () => {
  const srv = fakeServer();
  const st = createKeyStore(srv.adapter());
  await st.save({ openai: "sk-TEST-0001" });
  await st.save({ openai: "sk-TEST-0002" });
  await createKeyStore(srv.adapter()).save({ openai: "sk-TEST-0003" });
  assert.equal(srv.files.size, 1);
  assert.equal([...srv.dirs.keys()].filter((d) => d.includes(STORE_PREFIX)).length, 1);
  assert.deepEqual(storedKeys(srv), { openai: "sk-TEST-0003" });
});

await test("a store directory that lost its private flag is made private again (and the GM warned)", async () => {
  const srv = fakeServer();
  await createKeyStore(srv.adapter()).save(FAKE);
  const dir = [...srv.dirs.keys()].find((d) => d.includes(STORE_PREFIX));
  srv.dirs.get(dir).private = false;
  const c = fakeClient();
  configureVault(c.deps(srv));
  await initVault();
  assert.equal(srv.dirs.get(dir).private, true);
  assert.ok(c.notes.includes("warn:AIIMG.KeyStore.WasPublic"));
  assert.equal(vaultKey("openai"), FAKE.openai);
});

await test("migration: client keys copied, read back, flag set; client copies untouched", async () => {
  const srv = fakeServer();
  const c = fakeClient(FAKE);
  const before = c.clientKeys();
  configureVault(c.deps(srv));
  const st = await initVault();
  assert.equal(st.migration, "done");
  assert.equal(c.ls.get(MIGRATED_FLAG), true);
  assert.deepEqual(storedKeys(srv), FAKE);
  assert.deepEqual(c.clientKeys(), before);
  assert.ok(c.notes.includes("info:AIIMG.KeyStore.Migrated"));
  // a second browser with no client keys gets them from the world store
  const c2 = fakeClient({});
  configureVault(c2.deps(srv));
  await initVault();
  for (const p of STORE_PROVIDERS) assert.equal(vaultKey(p), FAKE[p]);
  assert.deepEqual(c2.clientKeys(), { openai: undefined, gemini: undefined, openrouter: undefined, anthropic: undefined });
});

await test("failed migration: client copies untouched, still used, notice, flag NOT set, retried next load", async () => {
  const srv = fakeServer(); srv.failUpload = true;
  const c = fakeClient(FAKE);
  const before = c.clientKeys();
  configureVault(c.deps(srv));
  const st = await initVault();
  assert.equal(st.migration, "failed");
  assert.notEqual(c.ls.get(MIGRATED_FLAG), true);
  assert.deepEqual(c.clientKeys(), before);
  for (const p of STORE_PROVIDERS) assert.equal(vaultKey(p), FAKE[p]);
  assert.ok(c.notes.includes("warn:AIIMG.KeyStore.MigrateFailed"));
  // next load: the server works again
  srv.failUpload = false;
  configureVault(c.deps(srv));
  assert.equal((await initVault()).migration, "done");
  assert.deepEqual(storedKeys(srv), FAKE);
  assert.deepEqual(c.clientKeys(), before);
});

await test("store unreadable: client copies used, notice, no flag", async () => {
  const srv = fakeServer(); srv.failBrowse = true;
  const c = fakeClient(FAKE);
  configureVault(c.deps(srv));
  const st = await initVault();
  assert.equal(st.migration, "failed");
  assert.equal(st.loaded, false);
  assert.ok(c.notes.includes("warn:AIIMG.KeyStore.LoadFailed"));
  assert.equal(vaultKey("gemini"), FAKE.gemini);
  assert.notEqual(c.ls.get(MIGRATED_FLAG), true);
  assert.ok(!JSON.stringify(st).includes("TEST"));
});

await test("conflict: store not overwritten, this browser keeps its copy, conflict reported by name only", async () => {
  const srv = fakeServer();
  await createKeyStore(srv.adapter()).save({ openai: "sk-TEST-WORLD", gemini: "AIzaTEST-SAME" });
  const c = fakeClient({ openai: "sk-TEST-LOCAL", gemini: "AIzaTEST-SAME", anthropic: "sk-ant-TEST-0000" });
  configureVault(c.deps(srv));
  await initVault();
  assert.deepEqual(storedKeys(srv), { openai: "sk-TEST-WORLD", gemini: "AIzaTEST-SAME", anthropic: "sk-ant-TEST-0000" });
  assert.equal(vaultKey("openai"), "sk-TEST-LOCAL");
  assert.deepEqual(vaultConflicts(), ["openai"]);
  assert.ok(!JSON.stringify(vaultStatus()).includes("TEST"));
  assert.equal(c.ls.get("apiKey.openai"), "sk-TEST-LOCAL");
});

await test("keys window save: world store updated, this browser follows it, client copies still untouched", async () => {
  const srv = fakeServer();
  await createKeyStore(srv.adapter()).save({ openai: "sk-TEST-WORLD" });
  const c = fakeClient({ openai: "sk-TEST-LOCAL", gemini: "AIzaTEST-0000" });
  const before = c.clientKeys();
  configureVault(c.deps(srv));
  await initVault();
  await saveVault({ openai: "sk-TEST-NEW", gemini: "AIzaTEST-0000", openrouter: "", anthropic: "" });
  assert.deepEqual(storedKeys(srv), { openai: "sk-TEST-NEW", gemini: "AIzaTEST-0000" });
  assert.equal(vaultKey("openai"), "sk-TEST-NEW");
  assert.deepEqual(vaultConflicts(), []);
  assert.deepEqual(c.clientKeys(), before);
  assert.equal(c.ls.get(FOLLOW_STORE).openai, true);
  assert.ok(c.emits >= 1);
  // clearing a key in the window clears it for this browser even though the old client copy stays
  await saveVault({ gemini: "" });
  assert.equal(vaultKey("gemini"), "");
  assert.equal(c.ls.get("apiKey.gemini"), "AIzaTEST-0000");
});

await test("save failure in the window throws without the value and changes nothing", async () => {
  const srv = fakeServer();
  const c = fakeClient({});
  configureVault(c.deps(srv));
  await initVault();
  srv.failUpload = true;
  await assert.rejects(saveVault({ openai: "sk-TEST-0000" }), (e) => !String(e.message).includes("TEST"));
  assert.equal(storedKeys(srv), null);
  assert.equal(c.ls.get(FOLLOW_STORE), undefined);
});

await test("non-GM: no key from the store nor from a client copy; store never touched", async () => {
  const srv = fakeServer();
  await createKeyStore(srv.adapter()).save(FAKE);
  const c = fakeClient(FAKE, { isGM: false });
  let made = 0;
  const deps = c.deps(srv);
  configureVault({ ...deps, store: () => { made++; return deps.store(); } });
  assert.equal((await initVault()).migration, "skipped");
  assert.equal(await reloadVault(), false);
  for (const p of STORE_PROVIDERS) assert.equal(vaultKey(p), "");
  assert.deepEqual(vaultConflicts(), []);
  assert.equal(made, 0);
  await assert.rejects(saveVault({ openai: "x" }), /GM only/);
});

await test("settings.getKey normalises the vault value (W6-B) and is empty for a player", async () => {
  const F = class { constructor(o) { Object.assign(this, o); } };
  globalThis.foundry ??= { data: { fields: { NumberField: F, StringField: F, ObjectField: F, BooleanField: F } } };
  const { getKey } = await import("../scripts/settings.mjs");
  const srv = fakeServer();
  const c = fakeClient({ openai: " sk-TEST-0000\n" });
  configureVault(c.deps(srv));
  await initVault();
  assert.equal(getKey("openai"), "sk-TEST-0000");
  assert.deepEqual(storedKeys(srv), { openai: "sk-TEST-0000" });
  const p = fakeClient({ openai: "sk-TEST-0000" }, { isGM: false });
  configureVault(p.deps(srv));
  assert.equal(getKey("openai"), "");
});

// ---- W6-S: socket ping (sender check + coalescing) ----
/** Vault deps with a counting, manually-resolved store load and a fake clock/timers. */
function pingRig({ isGM = true } = {}) {
  const rig = { loads: 0, inFlight: 0, maxInFlight: 0, resolvers: [], clock: 0, timers: [], handler: null };
  const users = { gm1: true, gm2: true, pl1: false };
  configureVault({
    isGM: () => isGM,
    getClient: () => "", getSetting: (k, fb) => fb, setSetting: async () => {}, notify: () => {}, emit: () => {},
    store: () => ({
      load: () => {
        rig.loads++; rig.inFlight++; rig.maxInFlight = Math.max(rig.maxInFlight, rig.inFlight);
        return new Promise((res) => rig.resolvers.push(() => { rig.inFlight--; res({ keys: { openai: `sk-TEST-${rig.loads}` }, wasPublic: false }); }));
      },
      save: async (k) => k
    }),
    isUserGM: (id) => !!users[id],
    onSocket: (h) => { rig.handler = h; },
    now: () => rig.clock,
    setTimer: (fn, ms) => { const t = { at: rig.clock + ms, fn }; rig.timers.push(t); return t; }
  });
  listenVault();
  rig.finishAll = async () => { while (rig.resolvers.length) rig.resolvers.shift()(); await new Promise((r) => setTimeout(r, 0)); };
  rig.advance = async (ms) => {
    rig.clock += ms;
    for (const t of rig.timers.filter((t) => t.at <= rig.clock)) { rig.timers.splice(rig.timers.indexOf(t), 1); t.fn(); }
    await new Promise((r) => setTimeout(r, 0));
  };
  return rig;
}
const PING = { type: SOCKET_TYPE };

await test("W6-S: ping from a non-GM sender (or with no sender) is ignored", async () => {
  const rig = pingRig();
  assert.equal(typeof rig.handler, "function");
  assert.equal(rig.handler(PING, "pl1"), false);
  assert.equal(rig.handler(PING, undefined), false);
  assert.equal(rig.handler(PING, "nobody"), false);
  assert.equal(rig.handler({ type: "other" }, "gm2"), false);
  await rig.advance(PING_GAP_MS * 3);
  assert.equal(rig.loads, 0);
});

await test("W6-S: ping from a GM sender reloads the cache on a GM client; a player client never loads", async () => {
  const rig = pingRig();
  assert.equal(rig.handler(PING, "gm2"), true);
  assert.equal(rig.loads, 1);
  await rig.finishAll();
  assert.equal(vaultKey("openai"), "sk-TEST-1");
  const pr = pingRig({ isGM: false });
  assert.equal(pr.handler(PING, "gm2"), false);
  await pr.advance(PING_GAP_MS * 3);
  assert.equal(pr.loads, 0);
  assert.equal(vaultKey("openai"), "");
});

await test("W6-S: a flood of 500 GM pings = 1 reload in flight + 1 trailing reload, spaced by the gap", async () => {
  const rig = pingRig();
  for (let i = 0; i < 500; i++) rig.handler(PING, "gm2");
  assert.equal(rig.loads, 1);
  assert.equal(rig.maxInFlight, 1);
  await rig.finishAll();
  for (let i = 0; i < 500; i++) rig.handler(PING, "gm2");   // more while the gap runs
  assert.equal(rig.loads, 1);
  assert.equal(rig.timers.length, 1);
  await rig.advance(PING_GAP_MS - 1);
  assert.equal(rig.loads, 1);
  await rig.advance(1);
  assert.equal(rig.loads, 2);
  await rig.finishAll();
  await rig.advance(PING_GAP_MS * 5);
  assert.equal(rig.loads, 2);
  assert.equal(rig.maxInFlight, 1);
  // pings arriving while a reload is in flight: still one trailing reload, only after the gap
  rig.handler(PING, "gm1");
  assert.equal(rig.loads, 3);
  for (let i = 0; i < 100; i++) rig.handler(PING, "gm1");
  await rig.advance(PING_GAP_MS);   // in flight, not finished: no second load
  assert.equal(rig.loads, 3);
  await rig.finishAll();
  assert.equal(rig.loads, 4);       // gap already passed -> trailing reload runs at once
  await rig.finishAll();
  await rig.advance(PING_GAP_MS * 5);
  assert.equal(rig.loads, 4);
  assert.equal(rig.maxInFlight, 1);
});

await test("W6-S: the saving GM updates its own cache at once (no wait for a ping) and notifies; old reload cannot overwrite it", async () => {
  const rig = pingRig();
  rig.handler(PING, "gm2");                 // a ping reload is in flight
  assert.equal(rig.loads, 1);
  await saveVault({ openai: "sk-TEST-SAVED" });
  assert.equal(vaultKey("openai"), "sk-TEST-SAVED");
  await rig.finishAll();                    // the older read finishes after the save
  assert.equal(vaultKey("openai"), "sk-TEST-SAVED");
  // the saving client emits the ping (fake client counts emits); the local save is not throttled
  const srv = fakeServer();
  const c = fakeClient({});
  configureVault(c.deps(srv));
  await initVault();
  await saveVault({ openai: "sk-TEST-0000" });
  await saveVault({ openai: "sk-TEST-0001" });
  assert.equal(c.emits, 2);
  assert.equal(vaultKey("openai"), "sk-TEST-0001");
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
