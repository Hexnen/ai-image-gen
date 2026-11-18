// W6-J: language-file guard.
// 1. Every lang/*.json must survive Foundry's dotted-key expansion (foundry.utils.expandObject):
//    a key that is a string AND the parent of other keys ("A.Engine" + "A.Engine.browser") makes Foundry
//    throw "Cannot create property 'browser' on string" (or silently drop the children, depending on order)
//    and the WHOLE language file is not loaded.
// 2. Every literal key passed to game.i18n.localize/format (also through the usual `L`/`F` aliases)
//    in scripts/ and every {{localize "..."}} literal in templates/ must exist in en.json and pl.json.
// Run: node dev/test-lang-expand.mjs [moduleRoot]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Optional argument: another module root to check (e.g. an exported commit), default = this checkout.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (msg) => { failures++; console.log("FAIL " + msg); };

/** Same semantics as foundry.utils.expandObject + setProperty, but reports conflicts instead of throwing. */
function expand(flatObj, file) {
  const out = {};
  const errors = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, full);
      else set(full, v);
    }
  };
  const set = (key, value) => {
    const parts = key.split(".");
    let target = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!(p in target)) target[p] = {};
      else if (typeof target[p] !== "object" || target[p] === null) {
        errors.push(`${file}: "${parts.slice(0, i + 1).join(".")}" is a string but "${key}" needs it to be an object`);
        return;
      }
      target = target[p];
    }
    const last = parts[parts.length - 1];
    if (last in target && typeof target[last] === "object" && target[last] !== null) {
      errors.push(`${file}: "${key}" (string) would overwrite the object holding ${Object.keys(target[last]).map((c) => `"${key}.${c}"`).join(", ")}`);
      return;
    }
    target[last] = value;
  };
  walk(flatObj, "");
  return { out, errors };
}

const has = (tree, key) => {
  let t = tree;
  for (const p of key.split(".")) { if (!t || typeof t !== "object" || !(p in t)) return false; t = t[p]; }
  return typeof t === "string";
};

// ---- 1. expansion of every language file
const langDir = path.join(ROOT, "lang");
const trees = {};
for (const f of fs.readdirSync(langDir).filter((n) => n.endsWith(".json"))) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(langDir, f), "utf8")); } catch (e) { fail(`lang/${f}: invalid JSON (${e.message})`); continue; }
  const { out, errors } = expand(json, `lang/${f}`);
  errors.forEach(fail);
  if (!errors.length) console.log(`ok   lang/${f}: expands cleanly (${Object.keys(json).length} top-level entries)`);
  trees[f] = out;
}

// ---- 2. literal keys used in code and templates
const files = [];
const collect = (dir, exts) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, exts);
    else if (exts.some((x) => e.name.endsWith(x))) files.push(p);
  }
};
collect(path.join(ROOT, "scripts"), [".mjs", ".js"]);
collect(path.join(ROOT, "templates"), [".hbs", ".html"]);

const KEY = String.raw`["'\x60]([A-Z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)["'\x60]`;
const patterns = [
  new RegExp(String.raw`(?:i18n|\bL)\.(?:localize|format)\(\s*` + KEY, "g"),  // game.i18n.localize("...") / format, const L = game.i18n
  new RegExp(String.raw`(?<![\w.$])[LF]\(\s*` + KEY, "g"),                     // const L = (k) => game.i18n.localize(k)
  new RegExp(String.raw`\{\{\s*localize\s+` + KEY, "g")                         // {{localize "..."}}
];
const used = new Map(); // key -> [file:line]
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const key = m[1];
      if (key.includes("${")) continue; // template literal with interpolation: dynamic, not checked
      const line = src.slice(0, m.index).split("\n").length;
      if (!used.has(key)) used.set(key, []);
      used.get(key).push(`${rel}:${line}`);
    }
  }
}
// Keys of this module only (other prefixes, e.g. Foundry core "Cancel", are not ours to check).
const ours = [...used.keys()].filter((k) => k.startsWith("AIIMG."));
let missing = 0;
for (const lang of ["en.json", "pl.json"]) {
  if (!trees[lang]) { fail(`lang/${lang} not loaded`); continue; }
  for (const k of ours) if (!has(trees[lang], k)) { missing++; fail(`lang/${lang}: missing "${k}" (used at ${used.get(k).join(", ")})`); }
}
console.log(`${missing ? "FAIL" : "ok  "} ${ours.length} literal AIIMG.* keys used in scripts/ + templates/, ${missing} missing`);

console.log(failures ? `\n${failures} failure(s)` : "\nall lang checks passed");
process.exit(failures ? 1 : 0);
