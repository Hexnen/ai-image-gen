# Dry run: you play the model for the AI builder

You stand in for the Anthropic model. The real builder runs on a lane Foundry server: the real harness, the real
Invincible pack (tools, sheet reader, validation, writer) and the real cost and limit wiring. Only the model's turns come from you.
- You get each request as a file.
- You answer with a JSON file through `driver.mjs`.
- The page streams your answer back through the real transport.

No API key and no call to api.anthropic.com are involved. The dry mode refuses to run on port 30000 and on non-lane ports.

Paths used below:
- `MOD` = `<DATA>\modules\moinens-ai-gen`
- `DRY` = a NEW folder in your scratchpad, for example `<scratchpad>\dry-<date>-<name>`.
  - It holds the requests, answers and transcripts.
  - Never use a folder inside `MOD` or any Foundry folder. The tools refuse them.

## Hard rules

- **Lanes only.** Never touch port 30000 or the owner's worlds. Only the world `invincible` of the lane you hold.
- **One browser.** Take a slot first and give it back at the end. Close your browser tab before `give`.
- **Your own tab only.** Open your OWN tab (`tabs_create`, step 4) and pass its `tabId` on every browser call. Never run JS in, navigate or close a tab you did not open, even when it shows a lane page: in round 3 two stand-ins touched each other's tabs.
  - Before each JS block, check `location.port` is your lane's port.
  - The Foundry session cookie belongs to `localhost` and is shared by ALL ports. Another stand-in's `/join` on another lane replaces yours. So join right before you navigate to `/game` (step 4), and if a reload drops you on `/join`, join again in your tab.
- **Play the model honestly.**
  - Base every answer ONLY on what the request contains: the system blocks, the tool definitions, the messages (with the `<sheet>` block) and the tool results.
  - Do not read the module source, the vendored rules, the rulebook files or the world data to "know" answers. The real model cannot do that.
  - Use the tools the request offers, the way the system prompt says.
  - Never skip validation. Never write to the actor yourself (no `actor.update` from the page). The one exception is the GM's Apply in step 6a, which goes through `pack.apply`. Never hand-edit tool results.
- **Answer shape.**
  - Only `text` and `tool_use` blocks. No thinking blocks.
  - Tool inputs must fit the tool's `input_schema`. The driver checks the schema like the API does.
  - Parallel tool calls are several `tool_use` blocks in one answer.
- **Stopping.** End the turn (text only) when the system prompt says so, or when you need the GM.
  - The harness ends the turn itself when your answer calls only `submit_*` tools and every one of them is accepted (W3-4, world setting `build.endTurnOnSubmit`, default on). No further request comes: `wait` times out, and the TurnSummary has `reason: "submitted"`, `ok: true`, `text: ""`.
  - The tool_results of that submit are held. They lead the NEXT GM message, before the `<sheet>` block, the `<proposal .../>` marker and the GM's text. `wait` shows them there.
  - A submit together with another tool call, or a refused submit, does not end the turn: you get the results in the next request as usual.
  - Text you write in an answer that also calls tools is a progress note (`progress[]`, W3-5). It is not the turn's `text`. Only the text of an answer without tool calls is the turn's `text`.
- **No secrets.** Never type a real API key anywhere. In dry mode the key is an in-memory placeholder.
- **No downloads. No commits.** Transcripts stay in `DRY`.

## 1. Take a lane

```powershell
node C:/mmwt-ultra/slot.mjs take <yourname> 40 --lane 8      # or --lane 20; prints HELD lane 8 http://localhost:30008
powershell -NoProfile -File C:/mmwt-ultra/lane8.ps1 status    # server up? (lane20.ps1 for lane 20)
powershell -NoProfile -File C:/mmwt-ultra/lane8.ps1 start     # only if it is down
```

The lane's world `invincible` is restored from a reference copy at the end (step 8). Anything you create there is throwaway.

## 2. Mount the module (junction `moinens-ai-gen`)

```powershell
Get-Item "$env:LOCALAPPDATA\FoundryVTT-8\Data\modules\moinens-ai-gen" | Select-Object LinkType, Target
```

- **Junction already points to `MOD`:** nothing to do.
- **Junction is missing:** create it with `cmd /c mklink /J "%LOCALAPPDATA%\FoundryVTT-8\Data\modules\moinens-ai-gen" "<MOD>"`.

If the pack fails to load because another agent's half-written file is in `MOD` (console: `system pack import SyntaxError`), run the committed code instead:

```powershell
$S = "<scratchpad>\maig-head"; New-Item -ItemType Directory -Force $S | Out-Null
git -C "<MOD>" archive --format=tar -o "$S.tar" HEAD; tar -xf "$S.tar" -C $S; Remove-Item "$S.tar"
$J = "$env:LOCALAPPDATA\FoundryVTT-8\Data\modules\moinens-ai-gen"; cmd /c rmdir "$J"; cmd /c mklink /J "$J" "$S"
```

In step 8, point the junction back to `MOD`. Say in your report which code you ran: the HEAD sha, or the live folder.

## 3. Start the relay

The relay is a local queue between the page and you. It listens on 127.0.0.1 only and needs a random token.

Run it in the background (Bash tool, `run_in_background`):

```bash
node "<MOD>/dev/dry-run/relay.mjs" --dir "<DRY>"
```

Set `DRY_DIR` for the driver in every shell call. PowerShell: `$env:DRY_DIR="<DRY>"`; Bash: `export DRY_DIR="<DRY>"`. Then:

```powershell
node "<MOD>/dev/dry-run/driver.mjs" snippet     # prints the enable / disable JS lines
```

## 4. Log in as the GM and enable dry mode

1. Open your own tab:
   - `tabs_context` first. If the browser pane is closed (`browserOpen: false`), open it with `preview_start` and the url `http://localhost:30008/join`. The tab it opens is yours: read its `tabId` from `tabs_context`.
   - If the pane is open, run `tabs_create`, then `navigate` that `tabId` to `http://localhost:30008/join`.
   - Write the `tabId` into `<DRY>\notes.md` and pass it on EVERY browser call.
2. With `javascript_tool` on the /join page (your tab):
   - check `location.port` is `30008`;
   - run the `localStorage.setItem(...)` line from `snippet`, without the reload;
   - then join as the GM: `await fetch("/join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"join",userid:"<Gamemaster id from the select>",password:""})})`.
3. Right after the join, navigate your tab to `/game` and wait for `game.ready`. Do not wait between the join and `/game`: the session cookie is shared by all localhost ports (Hard rules).
4. If `game.modules.get("moinens-ai-gen").active` is false, enable the module in the LANE world and reload:
   `const mc=foundry.utils.deepClone(game.settings.get("core","moduleConfiguration")); mc["moinens-ai-gen"]=true; await game.settings.set("core","moduleConfiguration",mc);`
5. Check:
   - `game.modules.get("moinens-ai-gen").api.build.dry` shows `{ relay, wallMinutes, requestMinutes }`;
   - a permanent "builder DRY RUN" notification is shown;
   - `api.build.status().status === "ready"`, and `api.build.registry.getPack().tools().map(t => t.name)` lists the tools.

If `dry` is `null`, the console says why: `builder DRY mode NOT enabled (<reason>)`. The reasons are:
- `not-lane`: wrong port (lane ports: 30001-30005, 30008, 30020; never 30000);
- `not-local`: the page is not on a loopback host;
- `bad-config`: the localStorage value is not valid JSON;
- `bad-relay`: the relay URL is wrong (it must be `http://127.0.0.1:<port>`, not a Foundry port);
- `bad-token`: the token is wrong;
- `not-gm`: you are not logged in as the GM.

With no localStorage value at all (`off`) nothing is logged.

## 5. Make a throwaway actor and start a turn

```js
const a = await Actor.create({ name: "ZZ-AIGEN-<test>", type: "superhero" });   // or npc / an item for gear tests
const s = await game.modules.get("moinens-ai-gen").api.build.openSession(a);
window.__dry = { events: [], actorId: a.id, turns: [], startedAt: new Date().toISOString() };
s.on("*", (d, t) => window.__dry.events.push(t === "stream" ? "stream:" + d?.type : t === "notice" ? "notice:" + d.code : t));
window.__dry.turn = s.send("<the GM's message, e.g. Złóż mi Spider-Mana>").then(r => window.__dry.turns.push(r));
```

- Do not `await` the `send`. It finishes only after you answered every request.
- Optional settings that change what the model sees: `await s.setOptions({ rank, profile })`. It resolves with the options now in effect, for example `{ rank: "street", profile: "creation" }`. `null` removes a key, so the sheet shows `(default)` again.
- Rank keys: `game.modules.get("moinens-ai-gen").api.build.ranks()` lists `{ key, name, points, cap, powers, reputation, ... }`. The keys are `teen`, `street`, `global` and `cosmic`. Use the key, not the name.

## 6. The loop: read, answer, repeat

```powershell
node "<MOD>/dev/dry-run/driver.mjs" wait --timeout 600
```

`wait` prints a summary of the request:
- model, effort, max_tokens, the tool names, the sizes of the system blocks;
- every message that is NEW since your last answer: the GM's text, the `<sheet>` / `<sheet_update>` / `<sheet_unchanged/>` block, and the `tool_result` blocks.

Read the rest when you need it:
- `driver.mjs show <id> system` shows the harness rules, the rules digest and the catalogue index. Read them at least once per conversation; they are your instructions.
- `driver.mjs show <id> tools` shows the tool schemas.
- `driver.mjs show <id> messages` shows the whole history.
- The full raw request is in `<DRY>\req\<id>.json`.

Write your answer to a file and send it:

```json
{ "content": [
  { "type": "text", "text": "Short note to the GM (optional)." },
  { "type": "tool_use", "name": "search_catalog", "input": { "query": "web", "kinds": ["power"] } }
] }
```

```powershell
node "<MOD>/dev/dry-run/driver.mjs" answer <id> "<DRY>\a<id>.json"
```

How the driver handles an answer:
- **`id` and `stop_reason`:** you may leave out the tool_use `id`. The driver fills `toolu_dry_<request>_<n>`. It also infers `stop_reason`: `tool_use` when you call a tool, else `end_turn`.
- **Rejected answer:** the driver prints why and sends nothing (unknown tool, schema error, reused id). Fix the file and answer again. Use `check` to test a file without sending it.
- **Tool calls:** the harness runs the real tools and sends the results as the next request. Run `wait` again.
- **Text only (`end_turn`):** the GM turn ends. Run `wait --timeout 20` once to be sure, then read the summary in the page.
- **Only `submit_*` calls, all accepted:** the turn ends too (`reason: "submitted"`, Hard rules). No request with the submit's results comes; `wait --timeout 20` times out. Read the summary in the page. You see the results at the start of the next GM message.

Each request has 30 minutes before the transport gives up; the turn as a whole has at least 60 minutes. Answer well within these.

Simulating API failures (only when a test asks for it):
- `{ "error": { "type": "overloaded_error", "message": "x" } }`: the transport retries, so the same turn sends a new request.
- `{ "error": { "type": "invalid_request_error", "message": "x" } }`: a hard error.
- `"stop_reason": "refusal"` or `"max_tokens"` on a normal answer exercises those paths.

## 6a. Apply or discard a proposal (you stand in for the drawer)

There is no drawer yet (T7). When the test says the GM applies the proposal, do the GM's click from the page. This is the only write to the actor you may do, and only on a proposal the model submitted.

Step 1, a first Apply WITHOUT `confirmed`. It writes nothing when the plan removes or swaps something:

```js
const api = game.modules.get("moinens-ai-gen").api.build;
const a = game.actors.get(window.__dry.actorId);
const s = await api.openSession(a);
const pack = api.registry.getPack();
const p = s.pendingProposal;                       // null: nothing to apply
const opts = { rank: "street", profile: "creation" };   // the drawer's values: the same as setOptions, the rank KEY from api.build.ranks()
window.__dry.apply = { proposalId: p.proposalId, input: p.input, opts, first: await pack.apply(a, p.input, opts) };
const r1 = window.__dry.apply.first;
({ ok: r1.ok, needsConfirm: r1.needsConfirm ?? false, confirm: r1.confirm ?? [], message: r1.message });
```

Step 2, only when `needsConfirm` is true. Removals and level swaps need `confirmed: true` (the field name is `confirmed`; `confirm` is the LIST in the result).
- `r1.confirm` is `[{ opId, action: "remove" | "swap", name }]`. The model saw the same items as `applyConfirm` (strings like `remove talent "X"`, `level swap power "Y" major -> massive`) in its submit result.
- Answer it as the test's GM would, and write the answer into your notes: for example "confirm: remove Martial Arts, swap Strike major -> massive: yes, the GM asked for it".
- If the GM would say no to any item, do not apply. Mark the proposal `discarded` and say so to the model in the next GM message.

Each block is one `javascript_tool` call and stands alone (it takes what it needs from `window.__dry.apply`). If a `const` name clashes with an earlier call, wrap the block in `(async () => { ... return <value>; })()`.

```js
const w = window.__dry.apply;
const a2 = game.actors.get(window.__dry.actorId);
w.confirmAnswer = "yes: <items and why, as the GM>";
w.final = await game.modules.get("moinens-ai-gen").api.build.registry.getPack().apply(a2, w.input, { ...w.opts, confirmed: true });
w.final.ok;
```

Step 3, mark the proposal and SAVE the result. The round 3 idMap suspicion could not be settled because nobody saved the results.

```js
const w = window.__dry.apply;
const r = w.final ?? w.first;
const s3 = await game.modules.get("moinens-ai-gen").api.build.openSession(game.actors.get(window.__dry.actorId));
if (r.ok) await s3.markProposal(w.proposalId, "applied", { runId: r.runId });   // also clears the pending proposal
w.items = game.actors.get(window.__dry.actorId).items.contents.map((i) => ({
  id: i.id, name: i.name, type: i.type, level: i.system?.level ?? null,
  power: i.system?.power ?? null, powerSource: i.system?.powerSource ?? null }));   // collection order = talent roles
JSON.stringify({ proposalId: w.proposalId, opts: w.opts, confirm: w.first.confirm ?? [], confirmAnswer: w.confirmAnswer ?? null,
  ok: r.ok, runId: r.runId, message: r.message, ops: r.ops, idMap: r.idMap, created: r.created, updated: r.updated,
  deleted: r.deleted, warnings: r.warnings, errors: r.errors, vitals: r.vitals ?? null, items: w.items });
```

- Write that JSON with the Write tool to `<DRY>\apply-<turn>.json` (one file per Apply, also for a refused one). The page cannot write files.
- Check it in the same step and put the answer in your notes:
  - every `add` op: `idMap[opId]` equals its `itemId` and is in `items` with the same name and type;
  - every boost or limit: `power` is the id of the power it belongs to;
  - every power: `powerSource` is the id of its source;
  - talents in a build: their order in `items` is the order of the talent ops (hero, occupation, extra). An added talent on a finished hero goes to the end.

Notes on the options and the result:
- `profile`: `"creation"` for a build, `"in-play"` for edits of a finished hero.
- Always pass `rank` for a superhero. Without it the hero is checked at the plus-ultra chargen rank flag if the actor has one, else as Global, and the result carries the warning `rank.defaulted`.
- Other options exist (`expect`, `only`, `deselect`, `allowVitals`, `label`). The drawer will use them. A stand-in does not need them.
- The result is short: `{ ok, runId, message, ops: [{ opId, action, type, name, itemId, outcome, cascade?, because? }], budget: { before, after }, warnings, errors, created, updated, deleted, idMap }`.
  - `outcome` is `written`, `unchanged`, `dropped` or `not written`.
  - `idMap` is `{ opId: itemId }`. The ids are made before the write and created with `keepId` (W3-1), so `idMap` and `ops[].itemId` no longer depend on the order the server answers in. `created` lists the new ids phase by phase (sources, powers, then boosts and limits, and so on).
  - `warnings` holds the plan's and the validator's warnings, on success too (W3-2).
  - A build from an empty actor also gives `vitals: { health: { from, to }, resolve: { from, to } }`: current Health and Resolve set to max (W3-3). The `message` names it too.
  - On a refusal you also get `needsConfirm` + `confirm`, `stale`, `unsaved`, `busy` or `rolledBack`.
  - `pack.apply(a, p.input, { ...opts, verbose: true })` gives the full plan with the projected actor (about 25 KB). Use it only to debug.
- If the GM rejects the proposal: `await s.markProposal(p.proposalId, "discarded")`.
- The model sees the state in the GM's NEXT message, as `<proposal id="..." status="applied"/>` right before the GM's text. A state the model has already seen is not repeated.
- `s.clearPendingProposal()` still works, but it does not tell the model anything. Use `markProposal` instead.

Check what was written. Read the sheet the way the model will see it (`pack`, `a`, `s`, `p` as in step 1; the `runId` is in your `apply-<turn>.json`):

```js
(await pack.snapshot(a, { rank: "street", profile: "creation" })).text
```

- Check the VALID line, the attributes and the items there. Do not use `actor.update` to fix anything.
- Undo, if the test needs it: `await pack.undo(a, r.runId)`, then `await s.markProposal(p.proposalId, "pending")`.
  - Use `pack.undoStatus(a)` first to see the run and any drift.

## 7. Results, accounting, transcripts

In the page:
- `window.__dry.turns.at(-1)` is the TurnSummary: `{ ok, reason, cap, turn, requests, toolCalls, usage, usd, text, progress, stop, sheet, proposal, error?, lastDraft? }`.
  - `reason`: `done`, `submitted` (ended by an accepted submit, W3-4; `ok: true`, `text: ""`, `stop: "tool_use"`), `cap`, `stopped`, `refusal`, `max_tokens`, `context`, `error`, `limit`, `busy`, `empty`, `no-key`, `no-pack` or `history-full`.
  - `cap` (with `reason: "cap"`): `requests`, `toolCalls`, `invalidSubmits`, `identicalInvalid`, `cost` or `wall`. With the two submit caps, `lastDraft` holds the last refused submit.
  - `text`: the text of the answer that ended the turn without a tool call, `""` otherwise. `progress`: texts written before tool calls, oldest first (W3-5).
  - `usage`: `{ input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, thinking }`. `sheet`: `full`, `update`, `unchanged` or `none`.
  - `proposal`: the pending proposal of this turn, or `null`.
- Save every TurnSummary: `JSON.stringify(window.__dry.turns)` written with the Write tool to `<DRY>\turns.json` after each GM message.
- `s.transcript()` gives the drawer items (`role: "progress"` for progress notes); `s.pendingProposal` gives the proposal.

Cost and limits run through the real wiring:
- every request is booked in the module limits;
- every request writes a call-log entry with `kind: "build"` and `provider: "anthropic (dry)"`.

Reading the call log. Use the module's own instance on the API (GM only):

```js
const log = await game.modules.get("moinens-ai-gen").api.callLog.readLog({ from: window.__dry.startedAt });
const a = game.actors.get(window.__dry.actorId);
const mine = log.filter((e) => e.kind === "build" && e.provider === "anthropic (dry)" && e.docUuid === a.uuid);
JSON.stringify(mine.map((e) => ({ ts: e.ts, status: e.status, route: e.route, cost: e.cost, costKind: e.costKind, tokens: e.tokens, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite, prompt: !!e.prompt })));
```

- Set `window.__dry.startedAt = new Date().toISOString()` in step 5, before the first `send`.
- `readLog({ from, to })` takes ISO dates or Date objects, both optional. It returns a plain array of entries, NEWEST FIRST. There is no `kind` filter: filter yourself.
- In round 3 `(await import("/modules/moinens-ai-gen/scripts/call-log.mjs")).readLog({})` returned `[]` twice. The cause is not known; the API path above uses the same module instance that writes the log. If it is empty too, say so in the report and add `game.modules.get("moinens-ai-gen").api.callLog` (exists?) and `game.user.isGM`.
- A `kind: "build"` entry, one per request:
  - `status`: `ok`, `error`, `cancelled`, or `blocked` (refused by the module limits before sending: then `costKind: "estimated"` and no request was made);
  - `route`: `turn <n> / request <m> / <stop_reason>`;
  - `cost` in USD (rounded to 6 places), `costKind: "actual"` (in dry mode the number is the simulation);
  - `tokens: { in, out }`, `cacheRead`, `cacheWrite`; `model`, `docUuid`, `docName`, `caller: "builder"`, `durationMs`, `user`, `id`, `ts`;
  - `prompt` (the GM's text, redacted) only on request 1 of a turn.
- Check: the entries of a turn (by `route`) with status `ok`, `error` or `cancelled` = that turn's `requests`; their `cost` sums to its `usd` (rounding aside). A turn ended by `submitted` has no entry after the submit request.
- Save the list to `<DRY>\calllog.json`.

Usage is simulated [E], at the module's own estimate of chars / 3.5 per token:
- the cached prefix is written on the first request and read on later ones;
- new history is written at the 5 min TTL.

The dollar figures are therefore plausible, not real. The caps (requests, tool calls, invalid submits, cost per message) are the real settings of the lane world.

Writing the transcript:
- Run `node "<MOD>/dev/dry-run/driver.mjs" transcript`. It writes `<DRY>\transcript.md`.
- Put your notes per GM message next to it, in `DRY` too: did the first submit pass y/n, the number of requests, problems you hit as the "model" (unclear tool descriptions, missing information in the sheet, misleading errors).

Stop and other clocks:
- `s.stop()` in the page cancels the open request. The driver then refuses a late answer ("cancelled by the page").
- If the harness hits a cap or a clock while you think, the same happens.

## 8. Clean up (always, also after a failure)

1. In the page:
   - delete your `ZZ-AIGEN-*` actors and items;
   - run `localStorage.removeItem("moinens-ai-gen.build.dry")`;
   - if you applied a proposal, undo it first, or rely on the world restore.
2. Close YOUR browser tab (`tabs_close` with your `tabId`; never another tab).
3. Stop the relay: kill its background task, or `Stop-Process -Id (Get-Content "<DRY>\relay.json" | ConvertFrom-Json).pid`.
4. If you repointed the junction in step 2, put it back:
   `cmd /c rmdir "$J"; cmd /c mklink /J "$J" "<MOD>"`.
5. Run `powershell -NoProfile -File C:/mmwt-ultra/lane8.ps1 restore -agent <yourname>`. This restores the world from the reference copy and puts the plus-ultra and moinen-maps junctions back to base.
   - Never pipe it (`| tail`, `| Select-Object -Last 5`, ...): through a pipe it hangs. Run it as is, or in the background (`run_in_background`) and wait for the exit notice.
6. Stop the server only if your brief says so: `lane8.ps1 stop -agent <yourname>`.
7. Run `node C:/mmwt-ultra/slot.mjs give <yourname>`.

## 7a. End-of-test GM questions (round 4, `round4-cases.md`)

Two tests end with a GM QUESTION, sent after the build is applied (step 6a) and read back with `pack.snapshot`:
- All Might: "czy ta postać może zadawać większy damage?"
- Spider-Man: "czy on może mieć jedno źródło mocy?"

How to play them:
- They are questions, not change requests. Answer in text, from the sheet and the rules the request holds (digest, index, tool results). Call a read tool only when you need a rule you do not have. Never submit and never rebuild unless the GM asks for a change.
- Send it as a normal GM message (`s.send(...)`, step 5). It is the first GM message after the Apply, so it starts with the held submit results and the `<proposal ... status="applied"/>` marker.
- In the notes and the report, give per question: the answer in short, right or wrong against the digest and the sheet, the requests and tool calls it cost, and what you had to guess.

## Report

For each GM message, report:
- the reason, the requests, the tool calls, the cost (dry) and the proposal y/n;
- `text` and `progress` as they came out (W3-5), and whether the turn ended by `submitted`;
- where the transcript is, and the saved files (`turns.json`, `apply-<turn>.json`, `calllog.json`);
- what you as the model could not do from what the request gave you.

For each Apply, report: needsConfirm y/n, the `confirm` list and the GM's answer, ok, `vitals`, and the idMap check against `items` (step 6a).

Also say:
- which code ran (the HEAD sha or the live folder, and whether T5 / T6 files were present);
- what is verified (seen in the page or the transcript) and what is not.
