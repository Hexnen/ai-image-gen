// Drawer view-model tests (task T7): pure functions of scripts/build/drawer-model.mjs. Node, no Foundry, no network.
// Run: node dev/test-drawer-model.mjs (from the module folder). The drawer UI itself is only checked live (lane).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "../scripts/build/drawer-model.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};
const L = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);

await test("renderText escapes everything, keeps only bold / lists / breaks", () => {
  const h = M.renderText('<img src=x onerror="alert(1)"> **bold** & "q"\nline two\n\n- a <b>\n- **b**\n\n1. one\n2. two');
  assert.ok(!/<img|<b>/.test(h), "no raw HTML");
  assert.ok(h.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(h.includes("<strong>bold</strong>"));
  assert.ok(h.includes("line two") && h.includes("<br>"));
  assert.ok(h.includes("<ul><li>a &lt;b&gt;</li><li><strong>b</strong></li></ul>"));
  assert.ok(h.includes("<ol><li>one</li><li>two</li></ol>"));
  assert.equal(M.renderText(""), "");
  assert.equal(M.renderText(null), "");
  assert.ok(!M.renderText("**<script>x</script>**").includes("<script>"));
});

await test("dockGeometry: right edge, flip left, shrink, clamp, height below the header", () => {
  const view = { width: 1600, height: 900 };
  const r = (left, width, top = 100, height = 700) => ({ left, right: left + width, top, height, bottom: top + height });
  const a = M.dockGeometry(r(200, 700), view, true);
  assert.deepEqual([a.left, a.flip, a.width], [900, false, 32 + M.DOCK.panel]);
  assert.equal(a.top, 100 + M.DOCK.header);
  assert.equal(a.height, 700 - M.DOCK.header);
  const b = M.dockGeometry(r(800, 700), view, true);          // no room right (100), room left (800)
  assert.equal(b.flip, true);
  assert.equal(b.left, 800 - (32 + M.DOCK.panel));
  const c = M.dockGeometry(r(400, 900), { width: 1700, height: 900 }, true);   // 400 left, 400 right: shrink
  assert.equal(c.panelW, 400 - 32);
  assert.ok(c.left >= 0 && c.left + c.width <= 1700);
  const d = M.dockGeometry(r(0, 1500), view, true);           // nothing fits: min panel, clamped on screen
  assert.equal(d.panelW, M.DOCK.minPanel);
  assert.ok(d.left >= 0 && d.left + d.width <= 1600);
  const e = M.dockGeometry(r(200, 700), view, false);          // closed: tab only
  assert.equal(e.width, 32);
  const f = M.dockGeometry(r(200, 700, 500, 700), view, true);  // sheet runs below the window: the drawer stays inside
  assert.ok(f.top + f.height <= 900);
});

const items = [
  { role: "sheet", kind: "full" },
  { role: "gm", text: "Złóż mi Spider-Mana" },
  { role: "progress", text: "Szukam mocy." },
  { role: "tool", id: "t1", name: "search_catalog", input: { query: "web swing" }, status: "done" },
  { role: "tool", id: "t2", name: "submit_proposal", input: { dryRun: true }, status: "done" },
  { role: "tool", id: "t3", name: "submit_proposal", input: { mode: "replace", rationale: "Spider-Man **Global**." }, status: "done" },
  { role: "proposal", proposalId: "prop-a" },
  { role: "proposal-status", proposalId: "prop-a", status: "applied" },
  { role: "sheet", kind: "update" },
  { role: "proposal-marker", proposalId: "prop-a", status: "applied" },
  { role: "gm", text: "zmień notatkę" },
  { role: "tool", id: "t4", name: "submit_proposal", input: { mode: "ops", rationale: "Nowa notatka." }, status: "pending" },
  { role: "proposal", proposalId: "prop-b" },
  { role: "notice", level: "warn", message: "Stopped." },
  { role: "ai", text: "Gotowe." }
];

await test("conversationRows: GM / AI / progress / grouped tools / proposal with rationale / status / notice; sheet and markers hidden", () => {
  const rows = M.conversationRows(items, { states: [{ id: "prop-a", status: "applied" }, { id: "prop-b", status: "pending" }], L });
  assert.deepEqual(rows.map((r) => r.kind), ["gm", "progress", "tools", "proposal", "status", "gm", "tools", "proposal", "notice", "ai"]);
  const tools = rows[2];
  assert.equal(tools.count, 3);
  assert.equal(tools.running, 0);
  assert.equal(tools.tools[0].label, 'MAIG.Drawer.Tool.search{"what":"web swing"}');
  assert.equal(tools.tools[1].label, "MAIG.Drawer.Tool.check");
  assert.equal(tools.tools[2].label, "MAIG.Drawer.Tool.submit");
  assert.equal(rows[3].status, "applied");
  assert.ok(rows[3].html.includes("<strong>Global</strong>"));
  assert.equal(rows[6].running, 1);
  assert.equal(rows[7].status, "pending");
  assert.ok(rows[7].html.includes("Nowa notatka."));
  assert.equal(rows[8].level, "warn");
});

await test("proposalInputs / cardProposal: pending wins; an undone (pending again) newest proposal comes back from the transcript", () => {
  const map = M.proposalInputs(items);
  assert.equal(map.get("prop-a").rationale, "Spider-Man **Global**.");
  assert.equal(map.get("prop-b").mode, "ops");
  assert.ok(!map.has("t2"), "dry-run checks are no proposals");
  const pend = { proposalId: "prop-b", input: { x: 1 } };
  assert.deepEqual(M.cardProposal(pend, [], items), { ...pend, restored: false });
  const back = M.cardProposal(null, [{ id: "prop-b", status: "discarded" }, { id: "prop-a", status: "pending" }], items);
  assert.equal(back.proposalId, "prop-a");
  assert.equal(back.restored, true);
  assert.equal(back.input.mode, "replace");
  assert.equal(M.cardProposal(null, [{ id: "prop-a", status: "pending" }, { id: "prop-b", status: "applied" }], items), null, "an older pending one is superseded");
  assert.equal(M.cardProposal(null, [], items), null);
  assert.equal(M.cardProposal(null, [{ id: "nope", status: "pending" }], items), null, "no input -> no card");
});

await test("summaryRows: op lines with action and cost, budget line dropped, other lines extra", () => {
  const s = 'act1: actor name, fighting\nsrc2: add powerSource "Freak accident" cost: first power source (free)\npw3: add power "Adhesion" (basic) cost: +1 slot (slots 1/4) -2 pts\nr1: remove talent "Knowledgeable (Natural Sciences)"\nu5: change drawback "Targeted" [note "Osborn"]\nact1: kept reputation 2 (already on the sheet)\nbudget 34 spent 34 slots 4/4';
  const { ops, extra } = M.summaryRows(s, { act1: { kind: "actor" }, r1: { kind: "remove" } });
  assert.equal(ops.length, 6);
  assert.deepEqual(ops.map((o) => o.action), ["actor", "add", "add", "remove", "update", "actor"]);
  assert.equal(ops[2].text, 'add power "Adhesion" (basic)');
  assert.equal(ops[2].cost, "+1 slot (slots 1/4) -2 pts");
  assert.equal(ops[3].cost, "");
  assert.deepEqual(extra, []);
  assert.deepEqual(M.summaryRows("", {}), { ops: [], extra: [] });
  assert.deepEqual(M.summaryRows("something odd\nbudget 30 spent 2 slots 1/4").extra, ["something odd"]);
});

await test("budgetRows / issueRows / undoView / usageView", () => {
  const rows = M.budgetRows({ before: { points: 34, spent: 0, slots: 0, rankPowers: 4, cap: 8 }, after: { points: 34, spent: 36, slots: 4, rankPowers: 4, cap: 8 } }, L);
  assert.deepEqual(rows.map((r) => [r.before, r.after, r.changed, r.over]), [["0/34", "36/34", true, true], ["0/4", "4/4", true, false], ["8", "8", false, false]]);
  assert.deepEqual(M.budgetRows(null), []);
  assert.deepEqual(M.budgetRows({ kind: "npc" }), []);
  const iss = M.issueRows([{ code: "effect.placeholder", message: "m", gm: "edit by hand" }, null, { code: "x" }]);
  assert.deepEqual(iss, [{ code: "effect.placeholder", text: "m", gm: "edit by hand" }, { code: "x", text: "x", gm: "" }]);
  assert.equal(M.undoView({ available: false }), null);
  assert.deepEqual(M.undoView({ available: false, expired: true }), { available: false, expired: true });
  const u = M.undoView({ available: true, runId: "r1", age: 5 * 60000, drift: [{ name: "Strike", why: "edited" }] }, L);
  assert.equal(u.clean, false);
  assert.equal(u.ageText, 'MAIG.Drawer.Undo.minutes{"n":5}');
  const v = M.usageView({ session: { input: 100, output: 600, cacheRead: 20000, cacheWrite: 2000, usd: 0.1, requests: 3 }, lastTurn: { usd: 0.3 }, cacheHitRatio: 0.9 }, { maxCostPerMessage: 0.5, maxRequests: 12, maxToolCalls: 40 }, { requests: 2, tools: 3, usd: 0.02 }, L);
  assert.equal(v.amber, true, "last turn above half the cap");
  assert.ok(v.line.includes('"hit":"90%"'));
  assert.deepEqual(v.turn, { requests: 2, maxRequests: 12, tools: 3, maxTools: 40, usd: "$0.020", maxUsd: "$0.500" });
  assert.equal(M.usageView({ session: {} }, {}, null, L).turn, null);
});

await test("rank / profile options and effective options", () => {
  const ranks = [{ key: "teen", name: "Teen", points: 26, cap: 6, powers: 3 }, { key: "global", name: "Global Guardian", points: 34, cap: 8, powers: 4, isDefault: true }];
  const o = M.rankOptions(ranks, "", "global", L);
  assert.equal(o[0].value, "");
  assert.equal(o[0].selected, true);
  assert.ok(o[0].label.includes("Global Guardian"));
  assert.ok(o[1].label.includes('"points":26'));
  assert.equal(M.rankOptions(ranks, "teen", "global", L)[1].selected, true);
  const p = M.profileOptions("in-play", L);
  assert.deepEqual(p.map((x) => [x.value, x.selected]), [["", false], ["creation", false], ["in-play", true]]);
  assert.deepEqual(M.effectiveOptions({}, "street"), { rank: "street", profile: "creation" });
  assert.deepEqual(M.effectiveOptions({ rank: "teen", profile: "in-play" }, "street"), { rank: "teen", profile: "in-play" });
  assert.deepEqual(M.effectiveOptions({ profile: "bogus" }, null), { rank: "global", profile: "creation" });
});

await test("lang: every MAIG.Drawer key used in code and template exists in en.json and pl.json", () => {
  const en = JSON.parse(readFileSync(join(ROOT, "lang/en.json"), "utf8"));
  const pl = JSON.parse(readFileSync(join(ROOT, "lang/pl.json"), "utf8"));
  const src = ["scripts/build/drawer-app.mjs", "scripts/build/drawer-model.mjs", "templates/builder-drawer.hbs"].map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  const used = new Set([...src.matchAll(/MAIG\.Drawer\.[A-Za-z0-9.-]+[A-Za-z0-9]/g)].map((m) => m[0]));
  // keys built at runtime: Profile.<p>, Profile.hint.<p>, Mode.<m>, State.<s>, Event.<s>, Confirm.<a>, Undo.drift.<w>
  for (const k of ["Profile.creation", "Profile.in-play", "Profile.hint.creation", "Profile.hint.in-play", "Mode.superhero", "Mode.npc", "State.pending", "State.applied", "State.discarded", "Event.pending", "Event.applied", "Event.discarded", "Confirm.remove", "Confirm.swap", "Undo.drift.edited", "Undo.drift.missing"]) used.add(`MAIG.Drawer.${k}`);
  // a template-literal prefix (`MAIG.Drawer.Confirm.${...}`) is a namespace of real keys, not a key
  const partial = [...used].filter((k) => !(k in en) && Object.keys(en).some((x) => x.startsWith(`${k}.`)));
  for (const k of [...used].filter((x) => !partial.includes(x))) {
    assert.ok(k in en, `en.json misses ${k}`);
    assert.ok(k in pl, `pl.json misses ${k}`);
  }
  for (const k of Object.keys(en).filter((x) => x.startsWith("MAIG.Drawer."))) assert.ok(k in pl, `pl.json misses ${k}`);
});

await test("module.json registers the drawer stylesheet; module.mjs loads the drawer dynamically", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
  assert.ok(manifest.styles.includes("styles/builder-drawer.css"));
  const mm = readFileSync(join(ROOT, "scripts/module.mjs"), "utf8");
  assert.ok(/import\("\.\/build\/drawer-app\.mjs"\)/.test(mm));
  assert.ok(!/^\s*import\s[^(]*from\s*["'][^"']*drawer-app/m.test(mm), "no static import of the drawer");
  const css = readFileSync(join(ROOT, "styles/builder-drawer.css"), "utf8");
  assert.ok(!/gradient\(/.test(css), "no gradients");
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
