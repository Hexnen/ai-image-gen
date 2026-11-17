# Dry-run analysis 3 (round 3: 6 characters) and wave-3 plan

Source: analyst agent report at HEAD 4849813 (read-only). [C] = confirmed in code/transcript, [P] = plausible.
Material (scratchpad, not in repo): dry3-fire, dry3-bat, dry3-spider, dry3-dd, dry3-nc, dry3-am (friction-log.md, transcript.md, metrics.md, final sheet, req\), an3\metrics.cjs.
Rulebook text is private: never copy prose into the repo.

## 1. Rounds compared

| Measure | R1 (4) | R2 (4) | R3 same 4 | R3 all 6 |
|---|---|---|---|---|
| Requests | 34 | 31 | 19 | 29 |
| Tool calls | 43 | 19 | 11 | 17 |
| get_entries per build | 2.75 | 2.5 | 0.75 | 0.83 |
| check/read_rules/search | 7/13/4 | 0/0/0 | 0/0/0 | 0/0/0 |
| Failed submits | 0 | 1 | 1 | 1 (Nightcrawler attr.cap) |
| Wasted calls | ~24 | ~1 | 1-2 | 1-2 |
| Requests with text only after successful submit | 8 | 8 | 7 | 11 (38 % of requests, 7.8 % of cost) |
| Simulated cost USD | 0.6285 | 0.5545 | 0.4829 | 0.7347 |
| Cost per character without cold prefix write | 0.068 | 0.046 | 0.027 | 0.028 |
| Prefix chars | 77,747 | 81,200 | 82,424 | 82,424 |
| Tool-result text in history (chars) | 109,448 | 49,881 | 19,926 | 37,114 |

Caveats: R3 tests have 2 GM messages (build + edit or rank question); R2 had extra verification turns. Prefix identical in all 29 R3 requests [C, hash]; the cold 1 h write (0.094 USD) is ~77 % of a test's cost; the index is 53,232 chars = 65 % of the prefix. check_proposal is 6,387 of 19,314 tool chars and was never used in 10 tests (argument for D-9).
Correctness: all 6 have reputation = rank value and Resources = occupation value; personality words Polish in all 6 (D-7 works); Batman not copied (original "Ćma"); D-6 worked (fire, bat); D-11 worked (dd, 1 request without tools); <proposal status="applied"/> marker reached the model everywhere.

## 2. Findings

F0 (new, high) idMap and creation order wrong [C: writer.mjs:878-880 maps ids by index; v14 server `_createDocuments` runs Promise.all over data.map with an await before the push, so the returned order is completion order]. Observed by the fire stand-in (ta8/dr9 ids swapped; the result was not saved) [P]. Consequences: opId->id in the Apply result and undo journal wrong [C]; two talents in one batch may swap hero/occupation roles [P]; two powers in one batch may link a boost/limit to the wrong power through idMap (writer.mjs:874) [P]. Fix: generate `_id` client side and create with `keepId: true`.
1. `grants` on a limit of a power above Basic: label uses the model's `_grants` (validate.mjs:658, 681), warning `grants.heuristic` uses the reader heuristic (validate.mjs:524-529, 141; reader.mjs:331). Slot count is the same in both (vendor rules.mjs:66-69): only contradictory text; fire wrote a wrong choiceNote [C].
2. Hard Times two numbers (-2 in get_entries rulesText vs -1 in effect/digest/info: data + D-3); info `drawback.hardTimes` on every submit (validate.mjs:449, 195-199) [C].
3. Signature Item: effect key has placeholder `[attribute]`, entry text says edit by hand; no placeholder handling in code [C]; validator ok; sheet shows `bonus.[attribute]+2`.
4. Obsessed and other drawbacks with large stat penalties invisible in the index line (catalog.mjs:62, 455); bat's build weakens itself [C].
5. Removal/level swap needs `confirmed:true` at Apply and the model is never told (word absent from all model texts) [C: writer.mjs:854-856, writer-group.mjs:54-57].
6. `rank.defaulted` hint reads like an order to ask (validate.mjs:137, 383); header returns to (default) after Apply because rank is not stored on the actor (D-2) [C].
7. in-play profile not explained anywhere in model texts; digest says "ALL available points must be spent" (rules-digest.mjs:43); attribute cap stays an error in-play (validate.mjs:103, 444) [C]; 1 failed submit.
8. npc.name.blank and team.empty on ok:true: message "relationship has no name" misleads (validate.mjs:110); system[0] does not say whether warnings must be fixed [C].
9. Apply result: act1 has the old actor name (writer.mjs:668); on success the validator warnings are lost (writer.mjs:843 carries only rank.defaulted; writer-group.mjs:50, writer.mjs:839) [C].
10. role/team/biography: role is checked as English key (role.unknown, validate.mjs:76; vendor ROLES) but nowhere said; "Solo" as team name is noise (rules-digest.mjs:53) [C].
11. Replace has no gear array (proposal.mjs:94); vehicles out of scope (O2) but the model has no sentence on it; validator knows custom gear/vehicleWeapon only (proposal.mjs:29) while writer also powerSource (writer.mjs:53) [C]; no guidance when an archetype power source is missing in the catalog (D-10).
12. opId: schema says own unique opId, results use harness ids; one sentence needed (proposal.mjs:94).
13. Full `<sheet supersedes>` after Apply: intended (drift > 25 % lines, sheet-sync.mjs:14, 91), ~0.7k tokens once per build. No change.
14. Text before a tool call lands in the GM-visible text: `out.text` concatenates all assistant texts (harness.mjs:556) [C]; 4 of 6 tests.
15. Note-only change summarised as `change drawback "X" [name]` (proposal.mjs:464-465, 804) [C].
16. Stored Health/Resolve 2/2 after build (D-1): writer clamps only downwards (writer.mjs:936-944) [C, all 6 sheets]; spec l.568 expects max, conflicts with O25.
17. Free points vs "leave the rest": no rule; All Might moved 3 points into attributes and said so.
18. System data (report only): Camouflage effect typo `^bonus.intuiton-1` (`^` = not transferred, snapshot.mjs:82); Obsessed different attribute in text vs effect; Martial Arts effect disabled; Hard Times -2 text vs -1 effect; Signature Item placeholder, no scaling per level; archetype rulesText has `[[D3]]` roll markers: ours to fix (catalog.mjs:84 strips only @links).
Other: truncated summaries (12 words, catalog.mjs:62) made fire read 8 refs at once (fine); the model counts slots itself (digest example: empty cosmic sheet = 38 + 2x5 = 48); decorative notes on powers ("Strike (Crushing blows)") although text says note = the choice (D-19); feminine grammatical gender of the model in Polish (cosmetic); readLog({}) returned empty in two tests, shape unknown.

## 3. Wave-3 tasks

Groups A, B, C are independent by files. C is a chain in the same files. C3 (one text pass over the prefix) runs after A, B and C1/C2, once.

Group A, writer. Files: scripts/systems/invincible/writer.mjs, writer-group.mjs, dev/test-build-ops.mjs.
- W3-1 (F0, top priority): ids generated up front (`foundry.utils.randomID()`) for every addition, `createEmbeddedDocuments(..., { keepId: true })`; idMap and links from these ids. Test: mock returning a shuffled order; check idMap, talent order, `pow=` and `src=`. Live: 5 builds with 2 powers + boost + 2 talents + 2 drawbacks, compare idMap with the actor.
- W3-2 (finding 9): actor op carries the new name when set.name is present; on success hand over the validator warnings (no duplicates).
- W3-3 (D-1, provisional yes): at build (replace, profile creation) after the actor phase: current Health/Resolve = max; undo journal entry and summary line. Edits unchanged (O25).

Group B, harness. Files: scripts/build/harness.mjs, dev/test-harness.mjs.
- W3-4 (D-5, provisional yes): after a successful submit with no other pending calls end the turn without another request; text empty, the drawer shows the rationale. Option `endTurnOnSubmit`, default on. Expected -11 of 29 requests, -7.8 % cost.
- W3-5 (finding 14): `text` = text of the last assistant message; earlier texts as `progress[]` in the event.

Group C, validator, catalog, prefix texts. Files: validate.mjs, proposal.mjs, catalog.mjs, rules-digest.mjs, tools.mjs, build/harness-prompt.mjs; tests test-build-validate-invincible, test-catalog-invincible, test-prompt-texts.
C1 (code, no prefix text):
- W3-6 (1): costLabel/limitOf use the effective reader reading, not `_grants`; `grants.heuristic` becomes info "grants does not change the cost".
- W3-7 (2, 6, 8): `drawback.hardTimes` only when ops touch drawbacks/Resources or in replace; `rank.defaulted` hint: "nothing to do unless the GM's message names another rank"; `npc.name.blank` for empty relationships: message "no NPC relationship".
- W3-8 (15): summary line `change drawback "Frightful" [note "..."]` with the new name.
- W3-9 (3): warning `effect.placeholder` when a projected item has an effect key with `[...]`; model gets "choice in the note", GM gets in `gm` that the effect needs editing. Writer substitution only after D-13.
- W3-10 (5): in the submit result (outside the prefix) `applyConfirm: [names]` when there are removals or swaps.
- W3-11 (7): in-play hint for `attr.cap`: "rank cap applies in-play too; ask the GM to change the rank in the drawer".
- W3-12 (D-17): info "gear cost N at Resources R".
C2 (catalog.mjs):
- W3-13: column `fx` in drawback (and talent) index lines with a short effect summary, e.g. `reason-3, 5 others -1`, flagged not-transferred/disabled; strip `[[...]]` from entry text; cut sampleHero from the index (D-8 provisional yes). Estimate +0.3-0.6k chars without D-8, -1.6k tokens with D-8.
C3 (one pass over the prefix texts, after C1, C2 and W3-4):
- W3-14: profiles creation and in-play (budget informational only, rank cap stays, growth not enforced); `role` = English key from the list of roles; warnings do not block: fix them in the same submit if you can, never resubmit only because of a warning; provisional D-15, D-16, D-18, D-19; vehicles out of scope; power source from an archetype missing in the catalog: nearest catalog source + one sentence in the rationale (D-10 provisional); gear: `gear` array in replace or "gear via ops"; removals and level swaps are confirmed by the GM at Apply; drawbacks may carry stat effects, read them when the `fx` column shows them; slot counting example; with W3-4 remove "write one short sentence"; `grants` removed from the schema or described as optional/derived; D-9 merge check into submit `{ dryRun }` (-6.4k chars); keep the 16,000-char limit check in the test.

Group D, documentation. Files: dev/dry-run/RUNBOOK.md, owner note.
- W3-15: Apply recipe with `confirmed`; save Apply results (idMap, ops) to the run folder; readLog shape.
- W3-16: report system-data issues (finding 18) without code changes.

## 4. Owner decisions (provisional value)

D-1 current Health/Resolve at build: yes = max when building from an empty actor; edits unchanged (O25). D-2 rank on actor: yes, flag at Apply of a creation build (needs implementation task, not in wave 3 unless decided). D-3 Hard Times: stays -1 (system effect); model sees one number, the book's -2 GM-only. D-5 auto end of turn after submit: yes. D-6 ambiguous request: choose and name the alternative in the rationale (works, approve). D-7/D-12 language of personality words and notes: the GM's language (works 6/6). D-8 cut sampleHero from the index: yes (not read in R2 or R3). D-9 merge check into submit dryRun: yes (0 uses in 10 tests). D-10 custom power source: provisional = nearest catalog source + sentence in rationale; the owner may prefer custom name+description only. D-11 rank in the message while drawer is (default): the model asks (works). New: D-13 placeholder effects: the model gives the attribute in a structured field, the writer substitutes the key, value per level from the entry table (provisional: warning for the GM only). D-14 attribute cap in in-play stays hard, growth not enforced (O24). D-15 expected texts at build: the model fills them, including one original NPC; no resubmit for warnings alone. D-16 solo hero: team/teamBase empty, one sentence in the rationale, no "Solo" as team name. D-17 gear cost vs Resources: info only. D-18 freed points with "leave the rest": move into attributes per concept and name it in the rationale, no question. D-19 decorative notes on powers: no, note only for a real choice. Minor: grammatical gender of the model in Polish: impersonal forms ("Dodano").

## 5. Not verified; round 4

Not verified: F0 live (server code and writer confirmed, observation only from a stand-in, Apply results not saved; role swap and wrong boost links are plausible, not seen); call log (`readLog` empty); all cost is simulated (chars/3.5, stand-in without thinking); never occurred: in-play change within the cap, `talent.role.shift`, note with parenthesis or > 60 chars, pending and discarded markers in real use, more than 8 sheet diffs.
Round 4: repeat F0 (5 builds with many items in one phase); scenarios "with gadgets" in the first message (after W3-14), Signature Item with an attribute, in-play edit within the cap (Street), villain NPC, vehicle request, Massive on Cosmic, hero-talent swap, removal of a hand-edited item (ask rule), second GM message while pending and after discarded, end of turn after W3-4. T8 real API (owner's spend approval and key typed by the owner; agents never type keys): count_tokens of the prefix, strict schemas accepted, real 1 h cache vs 5 min, thinking tokens, self-repair after an error, Sonnet vs Opus; budget about 1.5-3 USD. T7 drawer: proposal card with budget and warnings also after success; confirm dialog with remove/swap wording; rank and profile selectors plus D-2; markProposal from the real UI; Undo after a build (correct ids after W3-1); text and `progress` shown separately (W3-5); cost counter. Then T10 adversary.
