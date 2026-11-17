# Round 7: same test again after wave 5 (owner's order "Testuj", 2026-11-17)

Run after W5-A..G and the W5-T text pass (prefix texts v6). Cases = round 4/5 (dev/dry-run/round4-cases.md) and the round 6 multi-hero conversation (dev/dry-run/round5-6-cases.md).
New things to watch: fix round (one extra request after an accepted submit with an actionable warning), no empty assistant answers, replace vitals = max, talent order in replace = submitted order (no false talent.role.shift / talent.occ.list), Undo restores order, quiet rank.defaulted, new limit summary text, sheet_update without FLAG undo (`removed`), VALID note after rank change, strict off on submit_proposal, unsent GM message handling.
Evidence: relay `save` helper only, never by hand. Compare with rounds 4-6 (requests, tool calls, failed submits, simulated cost, itemIds, vitals).

Literal GM messages of all six cases (word for word, with drawer values): `dev/dry-run/round-messages.md`.
