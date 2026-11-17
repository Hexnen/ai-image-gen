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
await test("system[0]: tool economy, drawer settings, ambiguous requests", () => {
  const h = HARNESS_RULES;
  assert.match(h, /catalogue index already lists every entry/);
  assert.match(h, /Read a rules page only when the GM asks a rules question/);
  assert.ok(!/check tool/.test(h), "no separate check tool any more (D-9)");
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

await test("W3-14 / D-9: one proposal tool; dryRun = check only, for variants, never before a submit", () => {
  assert.deepEqual(tools().map((t) => t.name), ["get_entries", "read_document", "read_rules", "search_catalog", "submit_proposal"]);
  assert.ok(!JSON.stringify(tools()).includes("check_proposal"), "check_proposal is gone from the model-facing prefix");
  const d = desc("submit_proposal");
  assert.match(d, /dryRun:true = check only: same result, nothing reaches the GM, your turn goes on; only to compare variants or to price a change you may not propose/);
  assert.match(d, /never before a submit/);
  assert.ok(d.endsWith(PROPOSAL_GUIDE));
  assert.match(PROPOSAL_GUIDE, /required unless dryRun/);
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
  assert.ok(!/one short sentence/.test(h), "W3-4: no reply after a successful submit (the turn ends)");
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
  assert.ok(!/one short sentence|write one|and stop/.test(desc("submit_proposal")), "W3-4: no closing sentence after a submit");
  assert.match(desc("submit_proposal"), /ok:true ends your turn/);
  const g = PROPOSAL_GUIDE;
  assert.match(g, /Its errors name proposal\.\* paths and the entry; their opId is the summary's/);   // W2-2
  assert.match(g, /note = the choice shown in brackets, in the GM's language/);
  assert.match(g, /exactly two words in the GM's language/);
  assert.match(g, /name \(the hero name\)/);
  assert.match(g, /a limit pays for a level of its power \(a Basic-only power: a boost\); grants is optional and never changes the cost/);   // W3-6
  assert.ok(!/limits \[\{ref, grants\}\]/.test(g), "replace limits list no grants");
  assert.match(g, /the main alternative/);
  // after D-9 one proposal tool is ~9.7k: the cap now covers ALL tool definitions (was check+submit alone)
  assert.ok(JSON.stringify(tools()).length < 16000, `all tool definitions under the 16,000-char test cap (${JSON.stringify(tools()).length})`);
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

/* ---------------------------------------------------------------- W3-14 (C3): one text pass after wave 3 */
await test("W3-14 system[0]: warnings do not block, turn ends on submit, held result, progress note, impersonal forms", () => {
  const h = HARNESS_RULES;
  assert.match(h, /Errors block: fix exactly those errors and submit again/);
  assert.match(h, /Warnings do not block: fix them in the same submission when you can; never resubmit only because of a warning/);   // D-15
  assert.match(h, /A successful submission sent without other tool calls ends your turn: write nothing after it; its rationale is your answer for the GM/);   // W3-4
  assert.match(h, /You see its result at the start of the GM's next message/);           // W3-4 held results (W3-B-5)
  assert.match(h, /Text you write before a tool call is a progress note, not your answer/);   // W3-5 (W3-B-4)
  assert.match(h, /impersonal forms, never a grammatical gender \(Polish "Dodano"\)/);
  assert.ok(!/invincible/i.test(h), "system[0] stays system-agnostic");
});

await test("W3-14 digest: profiles, role keys, out of scope, slot example, freed points, archetype source, fx, expected texts, solo, gear info", () => {
  const d = rulesDigest();
  // profiles (finding 7, D-14): creation spends all, in-play budget informational, cap stays, growth not enforced
  const prof = d.slice(d.indexOf("## Profiles"), d.indexOf("## Superhero budget"));
  assert.match(prof, /profile=/);
  assert.match(prof, /creation[^.]*spend ALL available points/);
  assert.match(prof, /in-play[^]*the budget is information only/);
  assert.match(prof, /the rank's attribute cap is still an error/);
  assert.match(prof, /growth rules are not enforced/);
  assert.equal((d.match(/ALL available points/g) ?? []).length, 1, "the spend-all rule lives once, under creation");
  // role = English key (finding 10)
  assert.match(d, /Roles \(texts\.role = one of these English keys/);
  // vehicles and other actors out of scope, in one sentence
  assert.match(d, /minions, challenges and vehicles are out of scope: say so in one sentence/);
  // slot example from the vendored numbers (cosmic: 38 + 2 x 5 = 48)
  const c = RANKS.cosmic;
  assert.ok(d.includes(`an empty Cosmic Champion sheet has ${c.points} + 2 x ${c.powers} = ${c.points + 2 * c.powers} points`));
  assert.ok(d.includes("38 + 2 x 5 = 48"), "the dry run's example");
  // D-18, D-10, fx (W3-13), D-15, D-16, D-17
  assert.match(d, /leave the rest[^.]*: put them into attributes that fit the concept and say so in the rationale; do not ask/);
  assert.match(d, /An archetype's source missing from the catalogue: take the nearest catalogue source and say so in the rationale/);
  assert.match(d, /Drawbacks may lower attributes: read the index column fx \(\(disabled\), \(not transferred\) = no effect\) before you pick one/);
  assert.match(d, /at a build fill them, with one original NPC in relationships/);
  assert.match(d, /A solo hero: team and teamBase empty, one sentence in the rationale, never "Solo" as a team/);
  assert.match(d, /paid from Resources; reported as info, the GM decides/);
});

await test("W3-14 tools + guide: applyConfirm, gear in replace, D-19 notes, placeholder choice, role key, Health/Resolve at build, sample heroes", () => {
  const sub = desc("submit_proposal");
  assert.match(sub, /removals and level swaps \(applyConfirm\) are confirmed by the GM at Apply/);   // W3-10
  const g = PROPOSAL_GUIDE;
  assert.match(g, /gear is never touched \(add it with ops\)/);                       // finding 11: replace has no gear array
  assert.match(g, /only for a real choice \(no decorative notes/);                    // D-19
  assert.match(g, /an effect with an open choice such as bonus\.\[attribute\]: name it here, the GM sets the effect/);   // W3-9
  assert.match(g, /role \(an English role key\)/);
  assert.match(g, /a build sets Health\/Resolve to max itself/);                     // W3-3
  assert.match(desc("search_catalog"), /every entry except sample heroes \(kinds \["sampleHero"\]\)/);   // D-8
  // the replace schema still has no gear array (the guide's sentence stays true)
  assert.equal(proposalToolDefs()[0].input_schema.properties.proposal.properties.gear, undefined);
});

await test("W3-14 dry-run tool result: marked dryRun, no proposalId, summary kept; a submit result has no dryRun mark", () => {
  const r = { ok: true, errors: [], warnings: [], info: [], autoFixed: [], layer: null, budget: null, summary: "s", normalized: {}, applyConfirm: ["remove power \"X\""] };
  const dry = toolResult("submit_proposal", r, null, { dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(dry.proposalId, undefined); assert.equal(dry.summary, "s"); assert.equal(dry.applyConfirm, undefined);
  const real = toolResult("submit_proposal", r, null);
  assert.equal(real.dryRun, undefined); assert.match(real.proposalId, /^prop-/); assert.deepEqual(real.applyConfirm, r.applyConfirm);
  assert.equal(toolResult("check_proposal", r, null).dryRun, true, "internal alias");
});

/* ---------------------------------------------------------------- size */
await test("static prefix (without the catalogue index) stays under 7,500 tokens (W3-14: was 8,500 before D-9)", () => {
  const p = prefixParts();
  const sizes = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { chars: v.length, tokens: estimateTokens(v) }]));
  const total = Object.values(sizes).reduce((a, s) => a + s.tokens, 0);
  console.log(`     sizes (chars/3.5 tokens): ${JSON.stringify(sizes)} total ${total}`);
  assert.ok(total < 7500, `static prefix ${total} tokens`);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
