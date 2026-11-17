# Vendored chargen rules core (T11): notes and open choices

2026-11-17, T11 (spec `dev/ai-gen-spec.md` 3.4 option c, 3.5, 13).

## What exists
- `scripts/systems/invincible/vendor/chargen/`: `rules.mjs`, `state.mjs` (byte-identical to `invincible-plus-ultra/scripts/chargen/`, plus-ultra commit `321fd77`), `stamp.mjs` (content hash + when it changed + source commit), `MANIFEST.json` (sha256 per file), `sync.mjs` (copy / `--check`), `.gitattributes` (`* -text`).
- `dev/test-vendor-sync.mjs`: runs the real `--check`, then drift cases in an OS-temp sandbox, then `dev/test-vendor-chargen-load.mjs` (plain-Node import + pure functions).

## Set of vendored files (verified, not taken from the spec)
- `rules.mjs` imports nothing; `state.mjs` imports only `./rules.mjs`. The closure is exactly these two files (277 + 214 = 491 lines). No Foundry globals: checked by a scan in `sync.mjs` and by importing them in plain Node with no `game`/`foundry`/... defined.
- `sync.mjs` refuses to vendor a future source that imports anything outside the set or touches a runtime global (exit 2, copy untouched): extending the set is a conscious change of `FILES`, never automatic.

## Content check (book text)
- No book prose or book tables. Present, and kept because the copy must be byte-identical and the spec (3.4 b, last bullet) explicitly allows "code and game numbers (rank table) already public in plus-ultra": the `RANKS` numbers (points/cap/powers/reputation/upgrades per rank), the eight role names, the repeatable-talent limits by talent name (windfall, durable, determined, hard times), page refs `[B197] [B324]` in a comment, and one 8-word quoted phrase from the book in a comment (rules.mjs:43). Flagged for the lead; not a reason to stop in my reading.

## Open choices (provisional behaviour in place)
1. Where `sync.mjs` / `stamp.mjs` live: inside the vendor folder (spec 3.5 says so). Unlike LETR, the canonical side (plus-ultra) has no manifest/stamp; `stamp.mjs` and `MANIFEST.json` describe OUR copy only. The reverse check in plus-ultra is T9 (it can read our `MANIFEST.json` `files["rules.mjs"]` / `files["state.mjs"]`, full sha256 of the raw bytes).
2. `--check` without a sibling plus-ultra checkout: local checks only, the source comparison is reported as skipped and the check PASSES (spec: "run when the sibling checkout exists"). With `--source <dir>` the folder must exist.
3. Upstream drift (plus-ultra changed `rules.mjs`/`state.mjs`): `--check` FAILS while the sibling exists, so our tests go red until someone reviews and runs `node scripts/systems/invincible/vendor/chargen/sync.mjs`. This is the "conscious sync step" of 3.4; the alternative (warn only) would let behaviour diverge silently.
4. Line endings: global `core.autocrlf=true` on this machine would check the copy out as CRLF and break byte identity; `.gitattributes` `* -text` in the vendor folder stops that. The check counts a CRLF copy as drift.
5. "Wire `--check` into our node test runner": the module has no runner (only per-file `node dev/test-*.mjs`), so `dev/test-vendor-sync.mjs` is the hook. When a runner (`dev/test-build-*.mjs` or a run-all) appears, it should call `sync.mjs --check` first (spec 12.1 `test-build-validate-invincible.mjs`).
6. `stamp.mjs` records the plus-ultra commit and a `dirty` flag (uncommitted plus-ultra changes at sync time). It is rewritten only when the content hash changes, like LETR.
7. Not done here (separate tasks): T9 reverse check in plus-ultra; `setPowerMaxLevels` feeding by our catalogue (T4/T5); handoff log entry in `dev/ai-gen-handoff.md` (left to the lead, the brief limited me to my own new files).
