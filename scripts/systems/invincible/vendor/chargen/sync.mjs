// Vendored chargen rules core (spec dev/ai-gen-spec.md 3.4 option c, task T11): rules.mjs + state.mjs of invincible-plus-ultra's chargen,
// kept BYTE-IDENTICAL here. The canonical copy is plus-ultra (scripts/chargen); never edit rules.mjs / state.mjs in this folder.
// LETR-style (moinen-maps scripts/letters/sync.mjs): MANIFEST.json of per-file hashes, stamp.mjs with a content hash.
//
//   node sync.mjs                         copy rules.mjs + state.mjs from the plus-ultra checkout (sibling module folder), then rewrite
//                                         stamp.mjs (only when the content changed) and MANIFEST.json. Refuses (exit 2) when the source
//                                         is missing, when a file imports something outside the vendored set or touches Foundry globals.
//   node sync.mjs --source <dir>          the same from another chargen folder (a folder holding rules.mjs + state.mjs)
//   node sync.mjs --check                 exit 1 when a vendored file differs from MANIFEST.json, MANIFEST.json or stamp.mjs is missing or
//                                         stale, an unexpected file sits in this folder, the import closure or purity breaks, or (when the
//                                         plus-ultra checkout exists) the copy differs from plus-ultra's canonical files
//   node sync.mjs --check --source <dir>  compare against <dir> instead (it must exist)
//   node sync.mjs --check --no-source     only the local checks (manifest, stamp, closure, purity)
// The source folder is only ever READ. This script writes only into its own folder, and only the files named in FILES, stamp.mjs and
// MANIFEST.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** the vendored set: the import closure of rules.mjs + state.mjs (state imports rules, rules imports nothing) */
export const FILES = ["rules.mjs", "state.mjs"];
/** files of this folder that are not vendored content */
const OWN = new Set(["sync.mjs", "stamp.mjs", "MANIFEST.json", ".gitattributes"]);
const NOTE = "Vendored chargen rules core: byte-identical copy of invincible-plus-ultra scripts/chargen/{rules,state}.mjs (canonical). Never edit here; run sync.mjs.";
const SOURCE_REL = "invincible-plus-ultra/scripts/chargen";
/** default source: the sibling module folder (modules/<this module>/scripts/systems/invincible/vendor/chargen -> modules/invincible-plus-ultra/scripts/chargen) */
const DEFAULT_SOURCE = path.resolve(here, "../../../../../..", SOURCE_REL);
/** Foundry / browser runtime globals the rules core must never touch (it runs in plain Node) */
const FORBIDDEN = /\b(game|foundry|Hooks|CONFIG|canvas|ui|fromUuid|fromUuidSync|document|window|localStorage)\s*(\.|\(|\?\.)/;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fileHash = (dir, f) => sha256(fs.readFileSync(path.join(dir, f)));
export const contentHash = (dir) => sha256(FILES.map((f) => `${f}:${fileHash(dir, f)}`).join("\n")).slice(0, 16);
const readStamp = (dir) => { try { const m = fs.readFileSync(path.join(dir, "stamp.mjs"), "utf8").match(/hash: "([0-9a-f]{16})", at: "([^"]+)"/); return m ? { hash: m[1], at: m[2] } : null; } catch { return null; } };
const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "MANIFEST.json"), "utf8")); } catch { return null; } };
const manifest = (dir) => ({ note: NOTE, source: SOURCE_REL, algo: "sha256", files: Object.fromEntries([...FILES, "stamp.mjs"].filter((f) => fs.existsSync(path.join(dir, f))).sort().map((f) => [f, fileHash(dir, f)])) });

/** strip comments (good enough for these files: no "//" or "/*" inside string literals that matter for the scan) */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
/** problems of one folder's copy: missing files, imports outside the set, Foundry globals */
export function scan(dir) {
  const bad = [];
  for (const f of FILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { bad.push(`${f} missing in ${dir}`); continue; }
    const src = fs.readFileSync(p, "utf8"), c = code(src);
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (!spec.startsWith("./") || !FILES.includes(spec.slice(2))) bad.push(`${f} imports "${spec}" (outside the vendored set ${FILES.join(", ")})`);
    }
    if (/\bimport\s*\(/.test(c)) bad.push(`${f} uses a dynamic import()`);
    const g = c.match(FORBIDDEN);
    if (g) bad.push(`${f} touches a runtime global ("${g[0].trim()}")`);
  }
  return bad;
}

function gitInfo(srcDir) {
  try {
    const opt = { cwd: srcDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    const commit = execFileSync("git", ["log", "-1", "--format=%H", "--", ...FILES], opt).trim() || null;
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ...FILES], opt).trim().length > 0;
    return { commit, dirty };
  } catch { return { commit: null, dirty: null }; }
}

function parseArgs(argv) {
  const o = { check: false, source: null, noSource: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") o.check = true;
    else if (a === "--no-source") o.noSource = true;
    else if (a === "--source") { o.source = argv[++i]; if (!o.source) { console.error("sync.mjs: --source needs a folder"); process.exit(2); } }
    else { console.error(`sync.mjs: unknown argument ${a}`); process.exit(2); }
  }
  return o;
}

function check(o) {
  const bad = [], info = [];
  const m = readManifest(here);
  if (!m || typeof m.files !== "object") bad.push("MANIFEST.json missing or unreadable");
  else {
    const now = manifest(here).files;
    const want = [...FILES, "stamp.mjs"];
    const diff = [...new Set([...Object.keys(m.files), ...Object.keys(now), ...want])].filter((f) => m.files[f] !== now[f] || !want.includes(f));
    if (diff.length) bad.push(`${diff.length} file(s) differ from MANIFEST.json: ${diff.join(", ")}`);
  }
  const st = readStamp(here);
  if (!st) bad.push("stamp.mjs missing or unreadable (run sync.mjs)");
  else if (FILES.every((f) => fs.existsSync(path.join(here, f))) && st.hash !== contentHash(here)) bad.push("stamp.mjs is stale (run sync.mjs)");
  const extra = fs.readdirSync(here).filter((f) => !OWN.has(f) && !FILES.includes(f));
  if (extra.length) bad.push(`unexpected file(s) in the vendor folder: ${extra.join(", ")}`);
  bad.push(...scan(here));
  if (!o.noSource) {
    const src = path.resolve(o.source ?? DEFAULT_SOURCE);
    if (!fs.existsSync(src)) {
      if (o.source) bad.push(`source folder ${src} does not exist`);
      else info.push(`canonical copy not found (${src}), source comparison skipped`);
    } else {
      const d = FILES.filter((f) => !fs.existsSync(path.join(src, f)) || !fs.existsSync(path.join(here, f)) || !fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(here, f))));
      if (d.length) bad.push(`differs from the canonical copy in ${src}: ${d.join(", ")} (a conscious sync step: review the change, then run sync.mjs)`);
      else info.push("identical to the canonical copy");
    }
  }
  const tag = "vendor/chargen";
  console.log(bad.length ? `${tag}: FAIL: ${bad.join("; ")}` : `${tag}: OK (${FILES.length} files, stamp ${st.hash}${info.length ? "; " + info.join("; ") : ""})`);
  process.exit(bad.length ? 1 : 0);
}

function sync(o) {
  const src = path.resolve(o.source ?? DEFAULT_SOURCE);
  const refuse = (why) => { console.error(`sync.mjs: refusing to sync from ${src}: ${why}`); process.exit(2); };
  if (src === here) refuse("it is this folder");
  if (here.split(path.sep).includes("invincible-plus-ultra")) refuse("this vendor folder lies inside invincible-plus-ultra (that repo is the canonical copy and is never written)");
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) refuse("no such folder");
  const problems = scan(src);
  if (problems.length) refuse(`the source is no longer a pure, closed rules core: ${problems.join("; ")}. Extend FILES / the reader instead of vendoring blindly.`);
  const before = FILES.every((f) => fs.existsSync(path.join(here, f))) ? contentHash(here) : null;
  for (const f of FILES) fs.copyFileSync(path.join(src, f), path.join(here, f));
  const h = contentHash(here), st = readStamp(here);
  if (!st || st.hash !== h) {
    const { commit, dirty } = gitInfo(src);
    fs.writeFileSync(path.join(here, "stamp.mjs"),
      "// Vendored chargen rules core: written by sync.mjs (content hash of rules.mjs + state.mjs, when it last changed, plus-ultra commit it came from)\n" +
      `export const STAMP = { hash: "${h}", at: "${new Date().toISOString()}", source: "${SOURCE_REL}", commit: ${commit ? `"${commit}"` : "null"}, dirty: ${dirty} };\n`);
  }
  fs.writeFileSync(path.join(here, "MANIFEST.json"), JSON.stringify(manifest(here), null, 1) + "\n");
  console.log(`vendor/chargen: synced ${FILES.join(", ")} from ${src} (${before === h ? "unchanged" : `content ${before ?? "none"} -> ${h}`})`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.check) check(o); else sync(o);
}
