// T11: the vendored chargen rules core (scripts/systems/invincible/vendor/chargen) stays byte-identical to invincible-plus-ultra.
// 1) the real `sync.mjs --check` (manifest, stamp, closure, purity, canonical copy when the sibling checkout exists) must pass;
// 2) in a throwaway copy under the OS temp folder (never the real folders, never plus-ultra): every kind of drift must fail the check,
//    a sync from a changed fake source must repair it, and unsafe sources must be refused without touching the copy.
// Then the loadability test (test-vendor-chargen-load.mjs) runs. No network, no Foundry.  Run: node dev/test-vendor-sync.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "scripts/systems/invincible/vendor/chargen");
const CANON = path.resolve(ROOT, "..", "invincible-plus-ultra/scripts/chargen");
let n = 0;
const ok = (name) => { n++; console.log(`  ok ${name}`); };
const run = (dir, ...args) => {
  const r = spawnSync(process.execPath, [path.join(dir, "sync.mjs"), ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

console.log("vendor/chargen sync");

// ---------- 1. the real copy ----------
{
  const r = run(VENDOR, "--check");
  assert.equal(r.code, 0, r.out);
  ok(`real --check passes: ${r.out.trim()}`);
  const files = fs.readdirSync(VENDOR).sort();
  assert.deepEqual(files, [".gitattributes", "MANIFEST.json", "rules.mjs", "stamp.mjs", "state.mjs", "sync.mjs"]);
  ok("vendor folder holds exactly the expected files");
  if (fs.existsSync(CANON)) {
    for (const f of ["rules.mjs", "state.mjs"]) assert.ok(fs.readFileSync(path.join(VENDOR, f)).equals(fs.readFileSync(path.join(CANON, f))), `${f} differs from plus-ultra`);
    ok("rules.mjs + state.mjs byte-identical to plus-ultra (independent Buffer.equals)");
  } else console.log("  -- plus-ultra checkout absent: canonical comparison skipped");
  for (const f of ["rules.mjs", "state.mjs"]) assert.ok(!fs.readFileSync(path.join(VENDOR, f)).includes("\r\n"), `${f} has CRLF (line-ending conversion?)`);
  ok("no CRLF in the vendored files (LF like the canonical copy)");
}

// ---------- 2. sandbox ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maig-vendor-"));
try {
  const V = path.join(tmp, "vendor", "chargen"), SRC = path.join(tmp, "src");
  const fresh = () => {
    fs.rmSync(path.join(tmp, "vendor"), { recursive: true, force: true });
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.cpSync(VENDOR, V, { recursive: true });
    fs.mkdirSync(SRC, { recursive: true });
    for (const f of ["rules.mjs", "state.mjs"]) fs.copyFileSync(path.join(VENDOR, f), path.join(SRC, f));
  };
  const expectFail = (label, re, ...args) => {
    const r = run(V, "--check", ...args);
    assert.equal(r.code, 1, `${label}: expected exit 1, got ${r.code}: ${r.out}`);
    assert.match(r.out, re, label);
    ok(`${label} -> --check fails`);
  };

  fresh();
  assert.equal(run(V, "--check", "--source", SRC).code, 0);
  assert.equal(run(V, "--check", "--no-source").code, 0);
  ok("sandbox copy passes --check (with fake source and with --no-source)");

  fresh(); fs.appendFileSync(path.join(V, "rules.mjs"), "\n// edited here\n");
  expectFail("edited vendored file", /differ from MANIFEST\.json: rules\.mjs.*stamp\.mjs is stale.*canonical copy/s, "--source", SRC);

  fresh(); fs.writeFileSync(path.join(V, "state.mjs"), fs.readFileSync(path.join(V, "state.mjs"), "utf8").replace(/\n/g, "\r\n"));
  expectFail("CRLF conversion of a vendored file", /differ from MANIFEST\.json: state\.mjs/, "--no-source");

  fresh(); fs.rmSync(path.join(V, "stamp.mjs"));
  expectFail("missing stamp.mjs", /stamp\.mjs missing/, "--no-source");

  fresh(); fs.writeFileSync(path.join(V, "stamp.mjs"), fs.readFileSync(path.join(V, "stamp.mjs"), "utf8").replace(/hash: "[0-9a-f]{16}"/, 'hash: "0000000000000000"'));
  expectFail("stale stamp hash", /stamp\.mjs is stale/, "--no-source");

  fresh(); fs.rmSync(path.join(V, "MANIFEST.json"));
  expectFail("missing MANIFEST.json", /MANIFEST\.json missing/, "--no-source");

  fresh(); fs.writeFileSync(path.join(V, "MANIFEST.json"), JSON.stringify({ files: { "rules.mjs": "x" } }));
  expectFail("tampered MANIFEST.json", /differ from MANIFEST\.json/, "--no-source");

  fresh(); fs.writeFileSync(path.join(V, "catalog.mjs"), "export const x = 1;\n");
  expectFail("unexpected extra file", /unexpected file\(s\).*catalog\.mjs/, "--no-source");

  fresh(); fs.rmSync(path.join(V, "rules.mjs"));
  expectFail("missing vendored file", /rules\.mjs missing/, "--no-source");

  fresh();
  expectFail("--source pointing nowhere", /does not exist/, "--source", path.join(tmp, "nope"));

  // canonical drift, then the conscious sync step repairs it
  fresh();
  const stamp0 = fs.readFileSync(path.join(V, "stamp.mjs"), "utf8").match(/hash: "([0-9a-f]{16})"/)[1];
  fs.appendFileSync(path.join(SRC, "rules.mjs"), "export const NEW_RULE = 1;\n");
  expectFail("canonical copy changed upstream", /differs from the canonical copy.*rules\.mjs/, "--source", SRC);
  assert.equal(run(V, "--check", "--no-source").code, 0, "local checks alone still pass (the copy itself is consistent)");
  let r = run(V, "--source", SRC);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.readFileSync(path.join(V, "rules.mjs")).equals(fs.readFileSync(path.join(SRC, "rules.mjs"))));
  assert.equal(run(V, "--check", "--source", SRC).code, 0);
  const stamp1 = fs.readFileSync(path.join(V, "stamp.mjs"), "utf8").match(/hash: "([0-9a-f]{16})"/)[1];
  assert.notEqual(stamp1, stamp0);
  const man = JSON.parse(fs.readFileSync(path.join(V, "MANIFEST.json"), "utf8"));
  assert.deepEqual(Object.keys(man.files).sort(), ["rules.mjs", "stamp.mjs", "state.mjs"]);
  ok("sync from the changed source copies byte-identically, refreshes stamp + MANIFEST, --check passes again");
  r = run(V, "--source", SRC);
  assert.equal(fs.readFileSync(path.join(V, "stamp.mjs"), "utf8").match(/hash: "([0-9a-f]{16})"/)[1], stamp1);
  assert.match(r.out, /unchanged/);
  ok("re-sync of unchanged content keeps the stamp");

  // unsafe sources are refused before anything is copied
  const refuse = (label, mutate, re, from = SRC) => {
    fresh();
    mutate();
    const before = fs.readFileSync(path.join(V, "rules.mjs"));
    const rr = run(V, "--source", from);
    assert.equal(rr.code, 2, `${label}: ${rr.out}`);
    assert.match(rr.out, re, label);
    assert.ok(fs.readFileSync(path.join(V, "rules.mjs")).equals(before), `${label}: copy was touched`);
    ok(`${label} -> sync refuses (exit 2), copy untouched`);
  };
  refuse("source imports outside the set", () => fs.appendFileSync(path.join(SRC, "rules.mjs"), 'import { x } from "./catalog.mjs";\n'), /imports "\.\/catalog\.mjs"/);
  refuse("source touches a Foundry global", () => fs.appendFileSync(path.join(SRC, "state.mjs"), "export const s = () => game.settings.get('x', 'y');\n"), /runtime global/);
  refuse("source uses foundry.utils", () => fs.appendFileSync(path.join(SRC, "rules.mjs"), "export const g = (o) => foundry.utils.getProperty(o, 'a');\n"), /runtime global/);
  refuse("source missing a file", () => fs.rmSync(path.join(SRC, "state.mjs")), /state\.mjs missing/);
  refuse("source = the vendor folder itself", () => {}, /it is this folder/, V);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`vendor/chargen sync: ${n} checks passed`);

// ---------- 3. loadability ----------
const load = spawnSync(process.execPath, [path.join(ROOT, "dev/test-vendor-chargen-load.mjs")], { encoding: "utf8" });
process.stdout.write(load.stdout ?? ""); process.stderr.write(load.stderr ?? "");
assert.equal(load.status, 0, "test-vendor-chargen-load.mjs failed");
console.log("ALL OK");
