# Rounds 5 and 6: cases (owner's order, 2026-11-17)

Run after the wave-4 text pass (W4-T) is committed.

## Round 5: the same test again
Same six cases as round 4 (dev/dry-run/round4-cases.md): Spider-Man/Global (+ question "czy on może mieć jedno źródło mocy?"), Daredevil/Street (+ rank-differs message + question about the drawback), Nightcrawler/Teen (+ in-play message + question), All Might/cosmic (+ swap/removal + question "czy ta postać może zadawać większy damage?"), "chcę kogoś kto super dobrze unika, ma ogniste moce i ma długi"/Street, "coś w stylu Batmana ale nie Batman"/(default). Compare with rounds 3-4 (requests, tool calls, failed submits, simulated cost, itemIds, vitals). Stand-ins save evidence with the relay `save` helper (RUNBOOK), never by hand.

## Round 6: one conversation, many heroes
ONE session on ONE actor, one long conversation. GM messages in this order (Polish, word for word where quoted):
1. "Złóż mi Spider-Mana" (drawer rank global).
2. "Zmień go na Daredevila" (drawer rank set to street by the GM before sending: setOptions({ rank: "street" })).
3. "Teraz Nightcrawler" (rank teen).
4. "Teraz All Might" (rank cosmic).
5. "Teraz jakiś wampir" (rank global).
6. "Edytuj tego wampira: jednak ma być bardziej nietoperz" (in-place edit of the vampire: in-play or creation profile as the stand-in GM decides and says; the model must modify the existing character, not rebuild it from nothing).
The stand-in GM applies each proposal before the next message (Apply as in RUNBOOK 6a with the rank/profile of that step; `confirmed` steps as the GM would), reads the sheet back, and compares itemIds. Watch:
- replacing one finished hero by another in place: old items removed, stable ids for kept items, confirm lists, vitals (W3-3: a build sets current = max only when the actor is empty or emptied in the run), undo journal growth (10 runs / 24 h);
- sheet sync after big replacements (full block with `supersedes`, thresholds, `<proposal/>` markers across 6 proposals, held tool results);
- history growth and cache behaviour across 6 heroes (tokens per request, cacheRead/cacheWrite in the call log, harness limits: 12 requests / 40 tool calls per GM message, ~150k tokens history: does anything get cut or refused);
- whether the model re-reads catalog entries it already read earlier in the conversation, confuses the previous hero with the current one, or leaves leftovers (talents, drawbacks, notes of the previous hero);
- the final edit: it must be a small ops change (swap powers/talents/drawbacks/note, maybe one removal), the rationale names what was kept;
- rank changes between messages come from the drawer (`setOptions`) and the sheet header shows them; the model must not ask for a rank change when the drawer already matches.
Deliverables: the same evidence as round 5 plus a per-message table (requests, tool calls, usd, cache read/write tokens, history tokens, proposal outcome) and the final sheet.
