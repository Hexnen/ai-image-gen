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
- **Play the model honestly.**
  - Base every answer ONLY on what the request contains: the system blocks, the tool definitions, the messages (with the `<sheet>` block) and the tool results.
  - Do not read the module source, the vendored rules, the rulebook files or the world data to "know" answers. The real model cannot do that.
  - Use the tools the request offers, the way the system prompt says.
  - Never skip validation. Never write to the actor yourself (no `actor.update` from the page). The one exception is the GM's Apply in step 6a, which goes through `pack.apply`. Never hand-edit tool results.
- **Answer shape.**
  - Only `text` and `tool_use` blocks. No thinking blocks.
  - Tool inputs must fit the tool's `input_schema`. The driver checks the schema like the API does.
  - Parallel tool calls are several `tool_use` blocks in one answer.
- **Stopping.** End the turn (text only) when the system prompt says so, or when you need the GM. After a successful `submit_proposal` (alone in its answer) the harness ends the turn itself (W3-4, setting `build.endTurnOnSubmit`, default on): no request comes, and the submit's tool_result arrives at the start of the next GM message.
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

1. Open `http://localhost:30008/join` in the built-in browser (`preview_start` with the url). Note its `tabId` and pass it on every call.
2. With `javascript_tool` on the /join page:
   - run the `localStorage.setItem(...)` line from `snippet`, without the reload;
   - then join as the GM: `await fetch("/join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"join",userid:"<Gamemaster id from the select>",password:""})})`.
3. Navigate to `/game` and wait for `game.ready`.
4. If `game.modules.get("moinens-ai-gen").active` is false, enable the module in the LANE world and reload:
   `const mc=foundry.utils.deepClone(game.settings.get("core","moduleConfiguration")); mc["moinens-ai-gen"]=true; await game.settings.set("core","moduleConfiguration",mc);`
5. Check:
   - `game.modules.get("moinens-ai-gen").api.build.dry` shows `{ relay, wallMinutes, requestMinutes }`;
   - a permanent "builder DRY RUN" notification is shown;
   - `api.build.status().status === "ready"`, and `api.build.registry.getPack().tools().map(t => t.name)` lists the tools.

If `dry` is `null`, the console says why: `builder DRY mode NOT enabled (<reason>)`. The reasons are:
- `not-lane`: wrong port;
- `bad-relay`: the relay URL is wrong;
- `bad-token`: the token is wrong;
- `not-gm`: you are not logged in as the GM.

## 5. Make a throwaway actor and start a turn

```js
const a = await Actor.create({ name: "ZZ-AIGEN-<test>", type: "superhero" });   // or npc / an item for gear tests
const s = await game.modules.get("moinens-ai-gen").api.build.openSession(a);
window.__dry = { events: [], actorId: a.id, turns: [] };
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

Each request has 30 minutes before the transport gives up; the turn as a whole has at least 60 minutes. Answer well within these.

Simulating API failures (only when a test asks for it):
- `{ "error": { "type": "overloaded_error", "message": "x" } }`: the transport retries, so the same turn sends a new request.
- `{ "error": { "type": "invalid_request_error", "message": "x" } }`: a hard error.
- `"stop_reason": "refusal"` or `"max_tokens"` on a normal answer exercises those paths.

## 6a. Apply or discard a proposal (you stand in for the drawer)

There is no drawer yet (T7). When the test says the GM applies the proposal, do the GM's click from the page. This is the only write to the actor you may do, and only on a proposal the model submitted.

```js
const api = game.modules.get("moinens-ai-gen").api.build;
const a = game.actors.get(window.__dry.actorId);
const s = await api.openSession(a);
const pack = api.registry.getPack();
const p = s.pendingProposal;                       // null: nothing to apply
const opts = { rank: "street", profile: "creation" };   // the drawer's values: the same as setOptions, the rank KEY from api.build.ranks()
let r = await pack.apply(a, p.input, opts);
if (r.needsConfirm) {                              // removals and level swaps need confirmed:true (field name `confirmed`, not `confirm`)
  // r.confirm lists them: [{ opId, action: "remove"|"swap", name }]. Confirm only if the test's GM would.
  r = await pack.apply(a, p.input, { ...opts, confirmed: true });
}
if (r.ok) await s.markProposal(p.proposalId, "applied", { runId: r.runId });   // also clears the pending proposal
r;
```

- `profile`: `"creation"` for a build, `"in-play"` for edits of a finished hero.
- Always pass `rank` for a superhero. Without it the hero is checked as Global, and the result carries the warning `rank.defaulted`.
- The result is short: `{ ok, runId, message, ops: [{ opId, action, type, name, itemId, outcome }], budget: { before, after }, warnings, errors, created, updated, deleted, idMap }`.
  - `outcome` is `written`, `unchanged`, `dropped` or `not written`.
  - On a refusal you also get `needsConfirm` / `confirm`, `stale`, `unsaved`, `busy` or `rolledBack`.
  - `pack.apply(a, p.input, { ...opts, verbose: true })` gives the full plan with the projected actor (about 25 KB). Use it only to debug.
- If the GM rejects the proposal: `await s.markProposal(p.proposalId, "discarded")`.
- The model sees the state in the GM's NEXT message, as `<proposal id="..." status="applied"/>` right before the GM's text. A state the model has already seen is not repeated.
- `s.clearPendingProposal()` still works, but it does not tell the model anything. Use `markProposal` instead.

Check what was written. Read the sheet the way the model will see it:

```js
(await pack.snapshot(a, { rank: "street", profile: "creation" })).text
```

- Check the VALID line, the attributes and the items there. Do not use `actor.update` to fix anything.
- Undo, if the test needs it: `await pack.undo(a, r.runId)`, then `await s.markProposal(p.proposalId, "pending")`.
  - Use `pack.undoStatus(a)` first to see the run and any drift.

## 7. Results, accounting, transcripts

In the page:
- `window.__dry.turns.at(-1)` is the TurnSummary: `ok`, `reason` (`submitted` = ended by an accepted submit, W3-4), `cap`, `requests`, `toolCalls`, `usage`, `usd`, `text` (last assistant message only), `progress` (texts written before tool calls, W3-5), `proposal`, `error`.
- `s.transcript()` gives the drawer items; `s.pendingProposal` gives the proposal.

Cost and limits run through the real wiring:
- every request is booked in the module limits;
- every request writes a call-log entry with `kind: "build"` and `provider: "anthropic (dry)"` (`(await import("/modules/moinens-ai-gen/scripts/call-log.mjs")).readLog({})`).

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
2. Close your browser tab (`tabs_close`).
3. Stop the relay: kill its background task, or `Stop-Process -Id (Get-Content "<DRY>\relay.json" | ConvertFrom-Json).pid`.
4. If you repointed the junction in step 2, put it back:
   `cmd /c rmdir "$J"; cmd /c mklink /J "$J" "<MOD>"`.
5. Run `powershell -NoProfile -File C:/mmwt-ultra/lane8.ps1 restore -agent <yourname>`. This restores the world from the reference copy and puts the plus-ultra and moinen-maps junctions back to base.
6. Stop the server only if your brief says so: `lane8.ps1 stop -agent <yourname>`.
7. Run `node C:/mmwt-ultra/slot.mjs give <yourname>`.

## Report

For each GM message, report:
- the reason, the requests, the tool calls, the cost (dry) and the proposal y/n;
- where the transcript is;
- what you as the model could not do from what the request gave you.

Also say:
- which code ran (the HEAD sha or the live folder, and whether T5 / T6 files were present);
- what is verified (seen in the page or the transcript) and what is not.
