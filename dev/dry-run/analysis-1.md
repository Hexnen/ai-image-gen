# Dry-run analysis 1 (Spider-Man/Global, Daredevil/Street, Nightcrawler/Teen, All Might/rank 4 = cosmic)

Source: analyst agent report, code at HEAD fc6bd5f. [C] = confirmed in code or transcript, [P] = plausible, not run.
Material: scratchpad folders dry-spider, dry-daredevil, dry-nightcrawler, dry-allmight (friction-log.md, transcript.md, req\, a000N.json, w000N.txt).
Rulebook text is private: never copy prose into the repo.

## 1. Main findings

1. Cost is almost all the 1 h cache write of the static prefix (~22k tokens): catalog index ~15k (52,370 chars), tools ~5.3k (check 6,250 + submit 8,709 chars, same schema twice), rules digest ~1.25k, rules ~0.5k. One test costs 0.138-0.166 USD (chars/3.5, pricing.mjs:10); prefix write alone 0.088 USD = 53-64 %. Tail, reads and output ~15 % each [C].
2. Over half of tool-result text was waste: read_rules 13 calls, 48k chars = 44 % of all results, nearly all repeating the digest (tool description even invites "occupations in full"); search_catalog 4 calls, 8 %, index already in prompt [C].
3. Same pattern in every build [C]: check_proposal followed by an identical submit_proposal (6 of 7 checks); after a successful submit one more request only for the final text (8 of 34 requests).
4. Code defects tests did not catch:
   - A note with a parenthesis breaks catalog matching: `Targeted (Kingpin (Wilson Fisk))` does not match `\s*\([^)]*\)\s*$`; the item becomes `custom` and the full description lands in the sheet [C: Daredevil req 0008; reader.mjs:41,154-160, proposal.mjs:102-104, writer.mjs:82-83]. Effects on later replaceToOps / drawback note checks are from code only [P].
   - Notes silently cut at 60 chars, mid-word, no warning [C: NOTE_MAX proposal.mjs:41,105; writer.mjs:451,541].
   - Validator does not check: Resources equals the occupation's value; occupation talent is from the occupation's list; reputation equals the rank value. Vendored rules.mjs:237-243 checks only resources >= 1. Spider-Man passed with reputation 0 instead of 2 [C].
   - Ref prefixes differ: sheet shows `power-sources:` (reader.mjs:179), catalog uses `sources:` (catalog.mjs:31,297); useCatalogLookup is never called. Writer normalises refs (writer.mjs:93-99), validator does not (catalog.mjs:324-326; proposal.mjs:505,533,596) so copying a ref from the sheet should give ref.unknown [P].
   - `npc.name.blank` is not noise: it flags a missing `NPC: Name (type)` line in relationships (rules.mjs:243, reader.mjs:263-267). The hint exists (validate.mjs:104) but the model never sees it; an empty actor has the warning from the start and the validator shows only NEW warnings (validate.mjs:368,376) [C].
5. perOp misled the model in 4 of 4 tests: occupation talent looked paid (-1 pt), actor op +1. Cause [C: validate.mjs:477-486, proposal.mjs:655-661, reader.mjs:292-293]: cost is cumulative op by op; the updateActor that sets the occupation is the LAST op in replaceToOps; until the occupation exists the second talent counts as extra. Spec 7.5.4 also gives talent cost -1 without distinguishing free and extra.
6. Health/Resolve after apply = 2/2 with max 6-14. Not a writer bug versus writer-notes.md or spec 8.4: writer only clamps current when new max is lower [C: writer.mjs:925-936]. A functional gap: plus-ultra path sets current = max (spec 8.1 l.420), book's creation step too; O25 forbids writing these without GM request. Owner decision D-1.
7. Rank problems: whole Daredevil turn spent on rank (drawer global(default), GM wanted Street); `suggest` computed for the drawer's rank, i.e. misleading [C: validate.mjs:340,394-398]; apply without `rank` silently validates as Global [C: writer.mjs:26,832]; writer does not store rank on the actor (W11) so a new conversation returns to Global [P: reader.mjs:249-250].
8. Missing Apply path is due to missing T7, not a harness bug [C: builder-api.mjs:58-65]. Real gaps: RUNBOOK does not describe the stand-in `pack.apply(actor, input, {rank, profile, confirmed:true})` (stand-ins guessed `confirmed`, not `confirm`); the model gets no proposal state (pending/applied/discarded) [C: harness.mjs:427-437] so Spider-Man sent a second full replace. setOptions returns a write promise, hence `{}` [C: harness.mjs:202,239].

## 2. Character correctness

| Character | Result |
|---|---|
| Spider-Man (Global) | 34 = 32 + 2 drawbacks, slots 4/4. Reputation 0 instead of 2. Resources 3 (Student), with Hard Times effectively 2; per book would be 1. Not applied. |
| Daredevil (Street) | 26 = 26 + 1 drawback - 1 extra talent. OK. |
| Nightcrawler (Teen) | 22, slots 2/2. OK. |
| All Might (Cosmic) | 40, slots 5/5. OK. |

Health/Resolve max match `derive` for all applied characters.
- Strike Massive paid by limit Windup Strike (All Might): legal per validator [C: rules.mjs:56,59-70,206]; per book probably also [P]; final interpretation is the GM's.
- Hard Times -1 vs -2: deliberate plus-ultra choice "pack effect wins" (rules.mjs:149). Info message does not tell the model which Resources value to write. D-3.
- Personality words in English with a Polish GM in 2 of 4 tests. Vigilante archetype lists power sources absent from the catalog; a custom source is rejected by the validator.
- System data (not the builder): Obsessed effect acts on a different attribute than its text, -1 to all attributes, active at once. Martial Arts effect disabled, Obsessed not [C].

## 3. Efficiency

34 requests, 43 tool calls: read_rules 13, get_entries 11, submit 8, check 7, search 4. 0 rejected submits, so self-repair was not exercised. Estimate after P1 tasks: ~20-22 requests and about half the tool-result text.

Catalog index: model never used gear, vehicleWeapon, npcProfile, sampleHero (29 % of index); gear and npcProfile are needed in other modes (shared prefix).
- Safe cut: remove sampleHero from the index, keep it in search (-1.6k tokens).
- Keep boost/limit summaries (model chose by them).
- Add occupation talents + Resources to the occupation line and hero talents + occupations to the archetype line (+~1k tokens), saves calls each adding 1-6k chars to history.
- V14 (merge check and submit via dryRun): -1.8k tokens. C1 (shorter refs): after T8.
TTL cache: keep 1 h (5 min would be cheaper for a single build but a GM viewing a preview >5 min pays the write twice). Decide by measurement in T8.
Sheet blocks: thresholds worked (full block with `supersedes` after each Apply). Improve: BONUS is one line (snapshot.mjs:166); All Might's drawback name with note repeated 6 times (~700 chars); false `custom` with description from the parenthesis problem.

What the model had to guess: which talent is hero vs occupation (only order; occupation list never checked); hero talent without archetype is free choice; that Knowledgeable variants are valid occupation talents; what `texts.occupation` is (EN name, PL, ref); meaning of `budget` in VALID (points available at current slots, free slots counted +2) and perOp; which ref for a split power (digest says level ref, writer also accepts basic ref + `level`, writer.mjs:284-293); format of `relationships`, note length, parentheses; whether previous proposal was applied; ask or choose on ambiguous request; language of personality words.

## 4. Tasks (one agent each)

### P1 (before T7/T8)
- P1-A prompt and tool descriptions. Files: harness-prompt.mjs, tools.mjs, validate.mjs (TOOL_DESC), proposal.mjs (PROPOSAL_GUIDE). No decision needed.
  - system[0] and descriptions: read_rules only on an explicit rules question (for occupation and archetype use get_entries); submit_proposal directly, check_proposal only to compare variants; different rank in GM message than in sheet: no tools, one sentence asking to change it in the drawer; rule for ambiguous requests (provisional D-6).
  - search_catalog: say the index is already in the prompt; empty forPower gets a note "this power has no boosts or limits".
  - PROPOSAL_GUIDE: relationships format; note up to 60 chars without parentheses; occupation = EN name from catalog; reputation = rank value.
  - Effect -10..-12 requests over 4 tests. Risk low: prefix changes, one re-write of cache.
- P1-B rules digest. File rules-digest.mjs. Add (~+170 tokens): legend of VALID line (budget, spent, xsrc/xtal, (default)); hero talent without archetype is free; Knowledgeable variants; talent order hero, occupation, extra; reputation = rank value, must be given; split power: basic ref + `level` or level ref; Hard Times sentence (D-3).
- P1-C op order and readable per-op cost. proposal.mjs:655-661 (replaceToOps), perOpCost and summary in validate.mjs. updateActor first; each op annotated: free hero talent / free occupation talent / extra talent -1 / drawback +1; fix spec 7.5.4. Risk low-medium: tests hard-code opId.
- P1-D notes: length, parentheses, name matching. One shared function matching a balanced trailing parenthesis in reader.mjs, proposal.mjs, writer.mjs, catalog.mjs; autoFix of parentheses in notes; warning `note.cut`; cut at word boundary. Risk medium: same logic in 4 files, must stay compatible with plus-ultra for plain names.
- P1-E one ref format. Call useCatalogLookup in pack.mjs; catalog.get accepts long pack names. If T4's lookup lacks descHash/autoSig, only fix the prefix in reader.mjs:179.
- P1-F validation of occupation, Resources, reputation. validate.mjs; do not touch vendored rules.mjs. D-4 (warning vs error) and D-3. Check: occupation from catalog; Resources = occupation value; occupation talent from occupation list; reputation = rank value (in creation default to the rank value when missing). In creation + replace also show baseline warnings so the npc.name.blank hint reaches the model.
- P1-G rank. No decision: no `suggest` on rank.differs; document `rank` in apply; warning `rank.defaulted` instead of silent Global. With decision D-2: storing rank on the actor.
- P1-H proposal state in the GM turn. harness.mjs; marker `<proposal id=... status=pending|applied|discarded/>` before the GM text; status set by T7.

### P2
- P2-A end turn after successful submit, the text is `rationale` (D-5). ~25 % fewer requests.
- P2-B catalog index additions (occupation/archetype/split-power lines) without decision; cuts with D-8.
- P2-C merge check and submit (V14), D-9.
- P2-D leaner get_entries: slotNote once or never.
- P2-E BONUS line split per key or grouped per item.
- P2-F Health/Resolve = max at build (D-1).
- P2-G RUNBOOK: stand-in Apply with rank/profile/confirmed then clearPendingProposal; list of rank keys; setOptions returns the options.

### P3
- P3-A personality word language (D-7) and custom power source (D-10).
- P3-B report system data (Obsessed, Hard Times); builder changes nothing.

Order when parallel: P1-A and P1-B change the prefix: one series. P1-D, P1-C, P1-F touch the same files: in that order. P2-A depends on the text of P1-A.

## 5. Owner decisions (provisional variant in brackets)

D-1 current Health/Resolve at build (= max only when building from an empty actor). D-2 rank on the actor (plus-ultra flag chargen.rank at creation-profile build). D-3 Hard Times -1 pack effect vs -2 book (stays -1, message gives stored and effective value). D-4 occupation/Resources/talent/reputation mismatch (warning, not error). D-5 automatic end of turn after submit (yes). D-6 ambiguous request (choose and name the alternative; ask only for rank or removing GM-made items). D-7 personality words language (open). D-8 index cut (only remove sampleHero; C1 after T8). D-9 V14 (yes). D-10 custom power source (yes). D-11 rank from the message while drawer is (default) (model asks).

## 6. Not verified

Real tokens, cost, cache; behaviour of the real Sonnet, self-repair after validation errors, per-turn limits and Stop; effects of a parenthesis in a note on later replaceToOps and ref.unknown for `power-sources:` (from code only); whether T4's lookup has the same description/automation hashes as the reader loader; the book's final interpretation for Massive paid by a limit; node tests not run by the analyst; code version during the tests (friction logs say live folder, HEAD not checked).
