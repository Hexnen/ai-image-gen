// Static prompt texts of the cached prefix (spec 9.1): system[0] harness rules, system[1] Invincible rules digest, tool
// descriptions (read tools + proposal tools). Tasks P1-A / P1-B of dev/dry-run/analysis-1.md. Node, no Foundry, no network.
// Run from the module folder: node dev/test-prompt-texts.mjs
// Checks: byte stability (in process and across two fresh processes), no per-world data or sheet tags, the guidance the
// dry run asked for is present (content flags), the VALID legend names every key the sheet prints, size ceiling.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_RULES } from "../scripts/build/harness-prompt.mjs";
import { rulesDigest } from "../scripts/systems/invincible/rules-digest.mjs";
import { readToolDefs } from "../scripts/systems/invincible/tools.mjs";
import { proposalToolDefs, toolResult, MESSAGES, BUDGET_NOTE } from "../scripts/systems/invincible/validate.mjs";
import { PROPOSAL_GUIDE, NOTE_MAX } from "../scripts/systems/invincible/proposal.mjs";
import { RANKS, RANK_ORDER } from "../scripts/systems/invincible/vendor/chargen/rules.mjs";
import { estimateTokens } from "../scripts/anthropic/pricing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

const tools = () => [...readToolDefs(), ...proposalToolDefs()].sort((a, b) => a.name.localeCompare(b.name));
const desc = (name) => tools().find((t) => t.name === name).description;
const prefixParts = () => ({ tools: JSON.stringify(tools()), harness: HARNESS_RULES, digest: rulesDigest() });

/* ---------------------------------------------------------------- stability */
await test("prefix texts: byte-identical on repeated calls", () => {
  const a = prefixParts(), b = prefixParts();
  for (const k of Object.keys(a)) assert.equal(a[k], b[k], k);
});

await test("prefix texts: byte-identical across two fresh node processes", () => {
  const script = [
    "import { createHash } from 'node:crypto';",
    "const u = (p) => new URL(p, 'file:///' + process.cwd().replace(/\\\\/g, '/') + '/').href;",
    "const { HARNESS_RULES } = await import(u('scripts/build/harness-prompt.mjs'));",
    "const { rulesDigest } = await import(u('scripts/systems/invincible/rules-digest.mjs'));",
    "const { readToolDefs } = await import(u('scripts/systems/invincible/tools.mjs'));",
    "const { proposalToolDefs } = await import(u('scripts/systems/invincible/validate.mjs'));",
    "const t = [...readToolDefs(), ...proposalToolDefs()].sort((a, b) => a.name.localeCompare(b.name));",
    "process.stdout.write(createHash('sha256').update([JSON.stringify(t), HARNESS_RULES, rulesDigest()].join('\\u0000')).digest('hex'));"
  ].join("\n");
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
  const h1 = run(), h2 = run();
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2);
});

await test("prefix texts: no sheet tags, no dates, no ids, no world names", () => {
  for (const [k, v] of Object.entries(prefixParts())) {
    // the transport refuses system blocks that look like a sheet (request.mjs SHEET_TAG); tool descriptions may name the tag
    if (k !== "tools") assert.ok(!/<\s*(sheet|sheet_update|sheet_unchanged)\b/i.test(v), `${k} has a sheet tag`);
    assert.ok(!/\b20\d\d-\d\d-\d\d/.test(v), `${k} has a date`);
    assert.ok(!/\b(Actor|Item|Compendium)\.[A-Za-z0-9]{16}\b/.test(v), `${k} has a document id`);
    assert.ok(!/ZZ-AIGEN|Spider-Man|Daredevil|Nightcrawler|All Might/i.test(v), `${k} names a test character`);
  }
});

/* ---------------------------------------------------------------- P1-A: harness rules + tool descriptions */
await test("system[0]: tool economy, submit directly, drawer settings, ambiguous requests", () => {
  const h = HARNESS_RULES;
  assert.match(h, /catalogue index already lists every entry/);
  assert.match(h, /Read a rules page only when the GM asks a rules question/);
  assert.match(h, /Submit directly/);
  assert.match(h, /check tool only to compare variants/);
  assert.match(h, /drawer/); assert.match(h, /call no tools/);
  assert.match(h, /name the main alternative/);                     // D-6 provisional
  assert.match(h, /refs\) from the catalogue index in this prompt or from a tool result/);
  assert.ok(!/invincible/i.test(h), "system[0] stays system-agnostic");
});

await test("read_rules: explicit rules questions only, occupations/archetypes via get_entries", () => {
  const d = desc("read_rules");
  assert.ok(!/occupations in full/i.test(d), "the dry-run invitation to read occupations in full is gone");
  assert.match(d, /only when the GM asks a rules question/);
  assert.match(d, /get_entries/);
  assert.match(desc("get_entries"), /occupation: resources and talents, already in the index line/);
});

await test("search_catalog: index already in the prompt; empty forPower list explained", () => {
  const d = desc("search_catalog");
  assert.match(d, /index in the system prompt already lists every entry/);
  assert.match(d, /an empty forPower result carries a note saying why/);   // W2-7 PA1 note
});

await test("check/submit: submit directly, check only for variants", () => {
  assert.match(desc("check_proposal"), /Not needed before a submit/);
  assert.match(desc("check_proposal"), /only to compare variants/);
  assert.match(desc("submit_proposal"), /without a check_proposal first/);
  assert.ok(desc("submit_proposal").endsWith(PROPOSAL_GUIDE));
});

await test("PROPOSAL_GUIDE: note length and parentheses, occupation name, relationships format, reputation and resources", () => {
  const g = PROPOSAL_GUIDE;
  assert.ok(g.includes(`at most ${NOTE_MAX} characters`), "note limit follows NOTE_MAX");
  assert.match(g, /no parentheses inside/);
  assert.match(g, /occupation \(the occupation's English catalogue name\)/);
  assert.match(g, /"NPC: Name \(who they are\)", "Hero: Name"/);
  assert.match(g, /reputation \(the rank's reputation value\)/);
  assert.match(g, /resources \(the occupation's Resources value\)/);
  assert.match(g, /the power's index ref \+ level, or the level's own ref/);
  assert.match(g, /hero talent first, then the occupation talent, then extras/);
});

/* ---------------------------------------------------------------- P1-B: rules digest */
await test("digest: VALID legend names every key the sheet's VALID line prints", () => {
  const d = rulesDigest();
  const src = fs.readFileSync(path.join(ROOT, "scripts/systems/invincible/snapshot.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export function validLine"), src.indexOf("return s;", src.indexOf("export function validLine")));
  const keys = [...fn.matchAll(/ (\w+)=\$\{b\./g)].map((m) => m[1]);
  assert.ok(keys.length >= 7, `VALID keys found: ${keys}`);
  const legend = d.slice(d.indexOf("## Reading VALID and budget"), d.indexOf("## Superhero budget"));
  for (const k of keys) assert.ok(new RegExp(`\\b${k}\\b`).test(legend), `legend misses ${k}`);
  for (const k of ["extraSources", "extraTalents", "budget.after"]) assert.ok(legend.includes(k), `legend misses ${k}`);
  assert.ok(d.includes("rank=<key>(drawer|flag|default)"), "rank origin marker explained");
});

await test("digest: talents (order, free hero talent, Knowledgeable variants), reputation, split refs, Hard Times", () => {
  const d = rulesDigest();
  assert.match(d, /role=hero\|occupation\|extra\): 1st hero, 2nd occupation, the rest extras/);
  assert.match(d, /otherwise any talent/);
  assert.match(d, /any Knowledgeable \(subject\) entry of the catalogue counts/);
  assert.match(d, /reputation = the rank's reputation value/);
  for (const k of RANK_ORDER) assert.ok(d.includes(`|${RANKS[k].reputation}|${RANKS[k].upgrades}`), `rank table reputation for ${k}`);
  assert.match(d, /give the power's index ref with a level, or that level's own ref/);
  assert.match(d, /Hard Times: still write the occupation's value; each Hard Times lowers the effective Resources by 1/);   // D-3 provisional
  assert.match(d, /texts\.occupation = its English catalogue name/);
  assert.match(d, /call no tools and ask the GM to set it in the drawer/);
});

/* ---------------------------------------------------------------- W2-8: one text pass after wave 2 */
await test("W2-8 system[0]: proposal marker, unchanged update lines, read scope, stop after submit, language", () => {
  const h = HARNESS_RULES;
  assert.ok(h.includes('<proposal id="..." status="..."/>'), "marker shape named");
  assert.match(h, /pending = the GM has not decided \(do not resend it; change it only when asked\)/);
  assert.match(h, /applied = saved, further changes are ops/);
  assert.match(h, /discarded = do not retry it unless asked/);
  assert.match(h, /No marker = no change/);
  assert.match(h, /a line it does not list, the VALID line too, is unchanged/);               // D-E
  assert.match(h, /Read entries in one call, never twice in a conversation/);                  // D-O
  assert.match(h, /other entries only when their summary does not settle the choice/);
  assert.ok(!/Read an entry before you pick it/.test(h), "the old blanket read rule is gone");
  assert.match(h, /After a successful submission write one short sentence and stop/);         // D-P (D-5 open)
  assert.match(h, /name the main alternative in the rationale/);
  assert.match(h, /rationale and every free text \(descriptions, personality words, notes\) in the language of the GM's message/);   // D-7/D-12
  assert.match(h, /catalogue names exactly as the catalogue spells them/);
});

await test("W2-8 tools + guide: get_entries fields, submit stop, replace error paths, note/personality language, name, Basic-only limit", () => {
  const ge = desc("get_entries");
  assert.ok(!/slot\/cost note|slotNote/.test(ge), "no slot note any more (W2-4)");
  assert.match(ge, /split powers: levels \(one ref per level\), other powers: maxLevel/);
  assert.match(ge, /automation names/);
  assert.match(ge, /archetype: role, attributes, powers with refs/);
  assert.match(desc("submit_proposal"), /write one short sentence and stop/);
  assert.ok(!/end your turn then/.test(desc("submit_proposal")));
  const g = PROPOSAL_GUIDE;
  assert.match(g, /Its errors name proposal\.\* paths and the entry; their opId is the summary's/);   // W2-2
  assert.match(g, /note = the choice shown in brackets, in the GM's language/);
  assert.match(g, /exactly two words in the GM's language/);
  assert.match(g, /name \(the hero name\)/);
  assert.match(g, /grants level\|boost \(a Basic-only power: boost\)/);
  assert.match(g, /the main alternative/);
  assert.ok(JSON.stringify(proposalToolDefs()).length < 16000, "check+submit under the 16,000-char test cap");
});

await test("W2-8 digest: budget legend (perOp, spentAfter, label), talent roles, occupation columns, Hard Times without the book's number", () => {
  const d = rulesDigest();
  const legend = d.slice(d.indexOf("## Reading VALID and budget"), d.indexOf("## Superhero budget"));
  assert.match(legend, /every unused rank slot adds 2, so an empty sheet starts high/);
  assert.match(legend, /perOp: points\/slots = that op's own change, spentAfter = attribute sum after it, label = what it costs or pays for/);
  assert.ok(!/running changes in list order/.test(legend), "old perOp wording gone");
  assert.match(d, /role=hero\|occupation\|extra/);
  assert.match(d, /A new talent is always added last, so replacing the hero or occupation talent shifts roles \(warning talent\.role\.shift\)/);
  assert.match(d, /its index line gives its Resources and occupation talents, so it needs no read/);
  assert.match(d, /\(a Basic-only power: a boost\)/);
  assert.match(d, /hero name \(name\)/);
  // Hard Times: the digest and the model-facing message say the same (-1 through the effect), neither names the book's number
  const ht = MESSAGES["drawback.hardTimes"]({ stored: 5, effective: 4, book: 3 });
  assert.match(d, /each Hard Times lowers the effective Resources by 1 through its item effect\./);
  assert.match(ht.message, /lowers it by 1 through its effect/);
  const sentence = /Hard Times: [^.]*\./.exec(d)[0];
  for (const t of [sentence, ht.message, ht.hint]) assert.ok(!/book|prints|-2|\b2\b/i.test(t), `no book number for the model: ${t}`);
  assert.ok(!/## Names/.test(d), "the names rule lives once, in system[0]");
});

await test("W2-8 tool result: budget legend in the digest, so the model copy has no budget.note (GM side keeps it)", () => {
  const r = { ok: false, errors: [], warnings: [], info: [], autoFixed: [], layer: 2, budget: { before: { points: 40 }, after: { points: 30 }, note: BUDGET_NOTE, perOp: [] } };
  const out = toolResult("check_proposal", r, null);
  assert.equal(out.budget.note, undefined);
  assert.deepEqual(out.budget, { before: { points: 40 }, after: { points: 30 }, perOp: [] });
  assert.equal(r.budget.note, BUDGET_NOTE, "the GM-side result is not mutated");
  assert.equal(toolResult("check_proposal", { ...r, budget: null }, null).budget, null);
});

/* ---------------------------------------------------------------- size */
await test("static prefix (without the catalogue index) stays under 8,500 tokens", () => {
  const p = prefixParts();
  const sizes = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { chars: v.length, tokens: estimateTokens(v) }]));
  const total = Object.values(sizes).reduce((a, s) => a + s.tokens, 0);
  console.log(`     sizes (chars/3.5 tokens): ${JSON.stringify(sizes)} total ${total}`);
  assert.ok(total < 8500, `static prefix ${total} tokens`);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
