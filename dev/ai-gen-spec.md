# Moinens AI Gen: AI character and item builder (design spec v1)

Status: design only, no module code. Written 2026-11-17. Target: Foundry VTT v14, the module now at `Data/modules/ai-image-gen` (v0.1.0), first system pack = Invincible (system `invincible` 2.1.8, rulebook module `invincible-core` 1.0.2, `invincible-plus-ultra` 0.20.2: its chargen rules core vendored, the module itself a soft, Invincible-only extra; section 3.4).

Krótko po polsku: moduł zmienia nazwę na „Moinens AI Gen” (i id na `moinens-ai-gen`, z migracją ustawień i kluczy). Dochodzi część „Kreator AI”: szuflada przyklejona do karty postaci, w której MG pisze z Claude („złóż mi Spider-Mana”, „daj mu latanie”, „zrób z tego złoczyńcę”). Model układa klocki (moce, wzmocnienia, ograniczenia, talenty, wady, atrybuty, teksty) wyłącznie przez narzędzia: szuka w katalogu, czyta zasady, czyta postać i zgłasza propozycję. Harness waliduje propozycję zasadami systemu (rdzeń reguł kreatora Plus Ultra, skopiowany 1:1 ze skryptem kontroli zgodności; sam Plus Ultra jest miękkim dodatkiem tylko dla systemu Invincible, rdzeń modułu działa bez niego w każdym systemie), odsyła błędy modelowi do samonaprawy (z twardymi limitami pętli), a zapis na karcie następuje dopiero po kliknięciu „Zastosuj” przez MG, z podglądem różnic i cofnięciem. Pierwszy podmoduł: Invincible.

Reading order for an implementing agent: section 0, then the section(s) named for your task in section 13.

Revision 2026-11-17b (owner's binding addition: full sheet access + in-place per-item edits): every changed or new passage is marked **[CHANGED 2026-11-17b]**. Touched: R6/R9, section 4.2 items 3-5, 6.0 (new), the `read_document` / `submit_proposal` rows and the `ops` proposal shape, 7.5 (new), 8.4, 10.1, 11.2, 12.1/12.2, 13 (T5, T6, T12), 14 (O5, O21, O23-O25), 15.

Revision 2026-11-17c (owner: the model gets the WHOLE sheet in its context up front with every GM message, instead of exploring it through tool calls): passages marked **[CHANGED 2026-11-17c]**. Touched: 3.2 (`snapshot`), 3.5 (`reader.mjs`), 5.2, 5.4, 6.0, the tool table (`read_document` narrowed), 8.4, 9.1, 9.2, 10.3, 13 (T4, T12), 14 (O26-O29), 15.

Legend used everywhere below: **[V]** = verified in code or files on 2026-11-17 by the spec author (file named); **[A]** = assumption / design choice, not verified; **[E]** = estimate.

---------------------------------------------------------------------------------------------------

## 0. Map

1. Scope and interpretation of the owner's request
2. Rename and id migration
3. Architecture (core + system packs, dependency handling, plus-ultra dependency vs vendoring, file layout)
4. The drawer UI
5. Conversation harness (request loop, streaming, caps)
6. Tool set given to the model
7. Validation layer and self-repair
8. What Plus Ultra's chargen already offers (call, do not reimplement)
9. Prompt caching layout and token sizes
10. Permissions, safety, key handling
11. Settings, storage, cost accounting
12. Test plan
13. Implementation breakdown (one agent per task)
14. Open choices with provisional behaviour
15. Verified vs assumed (summary)

---------------------------------------------------------------------------------------------------

## 1. Scope and interpretation

Owner's request (PL, verbatim in the brief) reduced to requirements:

R1. Module title becomes "Moinens AI Gen". (Id decision: section 2.)
R2. New part: building WHOLE characters and items according to the game system's mechanics. First system sub-module: Invincible. Plus Ultra may be a dependency for now (its chargen is the rules engine), but only on system `invincible`; vendoring its pieces is allowed (owner's additions, 2026-11-17; decided in 3.4).
R3. A drawer next to the character sheet where the GM chats with the AI. Prompt caching must be optimised.
R4. GM writes e.g. "build me Spider-Man"; the AI picks abilities according to the rules, picks drawbacks if needed, etc., and fills a complete character on THAT sheet.
R5. "We support it with a harness and validation, it assembles the blocks." The model never writes documents directly; it composes catalogue entries and values; the harness validates and writes.
R6. It can also modify an existing character. **[CHANGED 2026-11-17b]** Including single items in place: add, edit or remove one power, boost, limit, talent, drawback (flaw), power source or piece of gear on an existing actor, keeping every other item and its id untouched, not only a whole rebuild.
R9. **[CHANGED 2026-11-17b]** The AI has full read access to the sheet: the whole actor (system data, derived values), all owned items, effects, and the sheet's current state including values typed but not yet saved.
R7. Items too, not only characters.
R8. Default model Sonnet 5.5 (`claude-sonnet-5-5`), configurable.

Interpretation notes:
- "dobiera umiejki studnie z zasadami" is read as "dobiera umiejki zgodnie z zasadami" (picks abilities in line with the rules). Invincible has NO skills [V: chargen-spec A10; system data model has attributes only]. "Abilities" therefore = powers (with levels), boosts, limits, power sources, talents, drawbacks, attributes. Stunts in this system are roll outcomes, not character content; the model may mention a power's stunt options in its explanation (read from the item's rules text) but there is nothing to pick. If the owner meant something else by "stunty", see open choice O1.
- "Whole character" for a superhero = everything the Plus Ultra wizard fills (rank budget, powers, sources, boosts, limits, talents, drawbacks, occupation, resources, reputation, personality, drive, flaw, names, appearance, relationships, team texts) [V: plus-ultra `scripts/chargen/state.mjs`, `apply.mjs` header].
- Character types in the system [V: `systems/invincible/system.json` documentTypes]: `superhero`, `npc`, `minions`, `challenge`, `vehicle`. Item types: `powerSource`, `power`, `talent`, `drawback`, `gear`, `criticalInjury`, `boost`, `limit`, `vehicleWeapon`.
- v1 scope (provisional, O2): `superhero` build + modify (full rules), `npc` build + modify (book's looser NPC rules, section 7.4), items = `gear` and `vehicleWeapon` (from catalogue or constrained custom). `minions`, `challenge`, `vehicle` and homebrew powers/talents are later.

Non-goals: no player access in v1; no automatic writes; no image generation inside the builder turn (the existing image button stays separate; a "make a portrait for this" hand-off is a later nice-to-have, O9); no rulebook text stored in the repo.

---------------------------------------------------------------------------------------------------

## 2. Rename and id migration

Decision (provisional, O3): title "Moinens AI Gen", id changes from `ai-image-gen` to `moinens-ai-gen`, folder `Data/modules/moinens-ai-gen`. Reasons: the module grows beyond images; the id is the brand used in other modules (`moinens-technical-break`, `moinens-assorted-dice` naming); the module is private with exactly one dependant to update (sketch-reveal); the rename is cheapest now, before the builder adds more settings and data. The alternative "keep the id, change only the title" costs nothing and loses nothing; it stays the fallback if the owner prefers zero risk (O3).

What depends on the old id [V: grep over `Data/modules` on 2026-11-17]:
- `sketch-reveal/module.json` relationship `"id": "ai-image-gen"` and `sketch-reveal/scripts/ai-image.mjs` `const AI_ID = "ai-image-gen"` (uses `game.modules.get(AI_ID).api`, hook `aiImageGen.ready`).
- `local-media-optimizer` profile prefix `"ai-image-gen/"` is a DATA folder prefix (set from ai-image-gen `optimize.mjs` `prefix: \`${MODULE_ID}/\``), not a module lookup.
- No document flags are written by ai-image-gen [V: grep for setFlag/getFlag/flags in `scripts/`: none].

Migration rules:
1. Split the constant: `MODULE_ID = "moinens-ai-gen"` (settings namespace, templates path, api) and `DATA_ROOT = "ai-image-gen"` (folder under `Data/` for images, `_log`, `_refs`, `_tests`, batch candidates). Keep `DATA_ROOT` unchanged: existing actors' `img` paths point into `Data/ai-image-gen/...`, Foundry has no file move/delete API for modules [V memory: "Foundry has no file-delete API"; A for "move"], and the optimizer profile keeps matching. Every place that today builds a path from `MODULE_ID` (`api.mjs:133`, `call-log.mjs:13`, `save-image.mjs:70/95/101`, `optimize.mjs:158`) switches to `DATA_ROOT` [V: lines from grep]. Template paths (`modules/${MODULE_ID}/templates/...`) switch to the new folder.
2. Settings copy, once, from the old namespace, READ-ONLY on the old values. Reuse the proven pattern of `invincible-plus-ultra/scripts/migrate-id.mjs` [V: file read]:
   - client scope: `window.localStorage.getItem("ai-image-gen.<key>")`, JSON-parse; keys `apiKey.openai`, `apiKey.gemini`, `apiKey.openrouter`, `apiKey.anthropic` and any other client key. The API keys never leave the GM's browser: the copy is localStorage -> localStorage on the same client. Each GM browser migrates itself on its first start (a client flag `migratedFromAiImageGen`).
   - world scope (GM only): `game.settings.storage.get("world").getSetting("ai-image-gen.<key>")?.value`; keys `enhance.model`, `enhance.effort`, `limit.daily|monthly|perRequest|batchSize`, `optimizeImages`, `usage`, `imageTypes`, `schema`, `batches`, `batch.<n>` (all slots). World flag `migratedFromAiImageGenWorld`.
   - copy only when the new key still holds its default and the old value differs (same rule as plus-ultra) so a re-run never clobbers newer values.
   - the existing `runMigrations()` (schema 1 -> 2) runs AFTER the copy, so an old world on schema 1 is upgraded in the new namespace.
3. Both modules enabled at once: the new module checks `game.modules.get("ai-image-gen")?.active`; if true it shows one GM warning ("disable AI Image Gen, its settings were copied") and does NOT start its batch poller, scene controls or sheet buttons until the old one is off (two pollers would ingest the same batch twice).
4. Hooks: keep the names `aiImageGen.ready`, `aiImageGen.batchUpdate`, `aiImageGen.logUpdate` (renaming buys nothing and breaks sketch-reveal); add new builder hooks under `moinensAiGen.*`. i18n prefix `AIIMG.` stays for existing strings; builder strings use `MAIG.`.
5. sketch-reveal gets a one-line change (separate task, its own repo): look up `game.modules.get("moinens-ai-gen") ?? game.modules.get("ai-image-gen")`, relationship id updated. Until then sketch-reveal simply hides its AI buttons (it already degrades when the API is missing [V: ai-image.mjs header comment]).
6. Manifest: `id`, `title`, `url`/`manifest`/`download` (repo rename on GitHub is the owner's call; pushing is never done without his go).
7. Rollback: old values are never deleted, so re-enabling the old module restores the old state.

Ordering constraint: the rename task (T0) starts only after the agent currently adding the Anthropic prompt-improver (wand button, `scripts/enhance/*`) has finished and the lead has committed; the working tree has uncommitted changes from that agent right now [V: `git status` shows modified lang/config-app/generate-dialog/redact/settings/styles/templates and untracked `dev/`].

---------------------------------------------------------------------------------------------------

## 3. Architecture

### 3.1 Layers

```
 drawer UI (ApplicationV2, docked to the sheet)           scripts/build/ui/*
        |  user text, Apply/Undo/Discard clicks
 session (one per document; append-only history, usage)    scripts/build/session.mjs
        |
 harness loop (request -> stream -> tool calls -> results, caps)   scripts/build/harness.mjs
        |                                  \
 anthropic transport (pure; fetch+SSE)      tool router -> system pack (catalogue / read / validate / plan / apply / undo)
 scripts/build/anthropic.mjs                scripts/build/registry.mjs  +  scripts/systems/<id>/*
```

- Core (`scripts/build/`) is system-agnostic: it knows sessions, the message format, caching, caps, cost, the drawer, the generic proposal/diff/undo shapes. It never knows what a "power" is.
- A system pack (`scripts/systems/<systemId>/`) knows the system: catalogue, rules digest, validator, how to turn a proposal into writes, how to undo. One pack per system id.

### 3.2 System pack interface (contract)

```js
// registered with api.build.registerSystemPack(pack) or bundled and loaded lazily when game.system.id === pack.systemId
pack = {
  id: "invincible", systemId: "invincible", version: 1,
  // readiness: dependencies, packs, versions. Never throws.
  check(): { ok, missing:[{ kind: "module"|"pack"|"api"|"version", id, need, have }], notes:[] },
  // which documents get a drawer, and in which mode
  supports(doc): null | { kind: "actor"|"item", mode: "superhero"|"npc"|"gear"|..., canWrite: boolean },
  // STATIC prompt material: must be byte-identical between calls with the same pack version + catalogue fingerprint
  staticPrompt(): Promise<{ rulesDigest: string, catalogIndex: string, fingerprint: string }>,
  // tool definitions (system part); the core adds nothing system-specific. Deterministic order, strict schemas.
  tools(): ToolDef[],
  // tool execution: pure reads or dry runs; NEVER writes documents
  runTool(name, input, ctx): Promise<ToolResult>,          // ctx = { doc, session, signal }
  // **[CHANGED 2026-11-17c]** the full sheet in the compact text format of 6.0, a fingerprint, and per-line keys so diffs are line-based
  snapshot(doc, { liveForm }): Promise<{ text, fingerprint, lines: Map<key, line>, tokensEst }>,
  diffSnapshots(oldText, newText): string,                  // short "sheet changed outside the drawer" note
  // proposal lifecycle (called by the core when the GM clicks)
  plan(doc, proposal): Promise<Plan>,                       // full diff, errors, warnings, destructive flag; writes nothing
  apply(doc, proposal, { confirmed, expect }): Promise<Result>,
  undo(doc, runId): Promise<Result>, undoStatus(doc): { available, runId, age, drift },
};
```
**[CHANGED 2026-11-17, W2-7]** Invincible pack additions for the drawer (T7): `pack.ranks()` -> `[{ key, name, points, cap, powers, reputation, upgrades, maxLevel, isDefault }]` (vendored rank table; also `api.build.ranks()`); `apply(doc, proposal, { rank, profile, confirmed, expect, only, verbose })` returns a CONCISE Result `{ ok, runId, message, ops:[{ opId, action, type, name, itemId, outcome }], budget:{ before, after }, warnings, errors, created, updated, deleted, idMap, needsConfirm?, confirm?, stale?, unsaved?, busy?, rolledBack? }`; `{ verbose: true }` returns the writer's full Result with `plan` (incl. `projected`) for the diff view. Session (harness): `await setOptions(o)` resolves with the effective options; `await markProposal(id, "pending"|"applied"|"discarded", { runId? })` sets the proposal state the model sees as `<proposal id="..." status="..."/>` before the GM's next text (messages only, never system[]). `nextSheetBlock(held, snap)` is documented in `pack.mjs`.
`Plan` / `Result` use the same field names as plus-ultra's chargen apply (fields, creates, deletes, keeps, counts, destructive, errors, warnings) [V: `apply.mjs` header], so the drawer's diff view renders any pack the same way.

### 3.3 Dependency handling (binding owner rule, 2026-11-17)

Owner's rule: the dependency on invincible-plus-ultra exists ONLY when the game system is `invincible`. The core module must install, load and work without plus-ultra on every other system. Owner's refinement: instead of depending on plus-ultra, the needed chargen pieces MAY be extracted and duplicated (vendored) into the Invincible sub-module if that is better; section 3.4 weighs both and picks.

- Core `module.json`: NO `relationships.requires` on plus-ultra or invincible-core (Foundry's `requires` is unconditional and would block or nag on every system). At most `relationships.recommends` with both ids, which is advisory only [A: v14 shows recommends as a hint and never blocks; verify in T3; if it nags on other systems, drop it and rely on runtime detection only].
- Core load path: `scripts/build/main.mjs` registers settings, the registry and header hooks; it imports NO system pack statically. The registry looks up `game.system.id` at `ready` and dynamic-`import()`s only the matching pack folder (`scripts/systems/<id>/pack.mjs`). On a system without a pack nothing system-specific is ever loaded and the header button is not shown; image generation and the prompt improver are unaffected.
- The Invincible pack's `check()` (runs only when `game.system.id === "invincible"`), hard requirements: system version >= 2.1.0; module `invincible-core` active with packs `powers, power-sources, boosts, limits, talents, drawbacks, gears, core-book, heroes-villans, npcs-creatures` (the six chargen packs are what plus-ultra's `Catalog.available()` checks [V: `catalog.mjs:57`]). Missing -> blocking empty state naming what is missing (same policy as plus-ultra's wizard: no half-working builder [V: chargen-spec 3, last bullet]).
- plus-ultra on Invincible: detected softly (`game.modules.get("invincible-plus-ultra")?.active` + presence of `api.chargen.apply.{plan,apply,undo,undoStatus}`, `api.chargen.catalog`, `api.chargen.provider` [V: attached in `catalog.mjs:387`, `apply.mjs:588`]). What it adds and what happens without it is defined by the chosen option in 3.4 (provisional: everything still works, a few extras are hidden).
- Version guard: plus-ultra is a moving target (its chargen changed as recently as 2026-11-16 [V: git log of `scripts/chargen`]). When its API is used, the pack runs a tiny self-test at first open (plan an empty state on a dry-run path, expect the known error codes). A failing self-test makes the pack fall back to its own path instead of guessing.

### 3.4 plus-ultra: soft dependency vs vendored copy

What the Invincible pack needs from chargen, with sizes [V: `wc -l` 2026-11-17] and coupling [V: import lines]:

| Piece | Lines | Foundry globals? | Couples to |
|---|---|---|---|
| `rules.mjs` (budget, validate, reconcile, rank table, level rules) | 277 | no (pure) | nothing |
| `state.mjs` (state shape, reducers, serialize) | 214 | no (pure) | rules |
| `import.mjs` (stateFromActor, describeActor) | 86 | yes (`foundry.utils`) | state, rules, plus-ultra flags, `api.base` |
| `bonuses.mjs` (effect bonus preview) | 97 | reads documents | rules |
| `catalog.mjs` (index, resolve, archetype parser from the installed book, provider) | 392 | yes | `tables.mjs` (532 lines, plus-ultra's own `chargen-tables` pack), `api.base` |
| `apply.mjs` (plan/apply/undo, lock, team base) | 591 | yes | catalog, `apply-lang.mjs` (89), plus-ultra flags, `api.base` (team-base cards) |
| `lang.mjs` (wizard strings, message texts for codes) | 2121 | yes | — |

Options:

(a) Soft dependency, Invincible only. Use plus-ultra's API and import its pure files by URL.
- Plus: zero duplication; the hardened write path (11 phases incl. adversary and two bughunts [V: chargen-handoff status table]) with lock, `expect` guard, 24 h undo with id-preserving restore, team-base integration; archetype/occupation lists parsed from the installed book; "Open in wizard".
- Minus: on Invincible without plus-ultra the builder is crippled unless a fallback exists; path-coupled imports of non-API files (`rules.mjs`, `state.mjs`) break silently on a plus-ultra refactor; module-level state (`setPowerMaxLevels`) is shared with plus-ultra's instance [A]; every plus-ultra release can change behaviour under us (self-test needed); node tests depend on a sibling checkout.

(b) Vendored copy of everything needed (rules, state, import, bonuses, catalog, tables, apply, lang parts) into `scripts/systems/invincible/vendor/chargen/`.
- Plus: works with plus-ultra absent; fully node-testable inside one repo; no runtime coupling.
- Minus: ~2,300 lines of hardened Foundry-side code (plus up to 2,100 lines of strings) to maintain twice; `catalog/tables/apply` are entangled with plus-ultra-only things (its `chargen-tables` compendium declared in ITS module.json, its flags namespace used for rank/undo/lock, `api.base` team-base cards), so a byte-identical copy is impossible: it must be edited, and an edited copy drifts with no mechanical check; two modules writing the same actors with two different undo/lock namespaces can step on each other.
- Licence/privacy: no blocker. plus-ultra is the owner's own code (its repo is public [V memory: module repos public]); it stores NO book text in code: archetypes, occupations and lists are parsed from the installed `invincible-core` journal at runtime and the generated tables pack is gitignored [V: chargen-handoff Decisions, tables.mjs header]. A vendored copy must keep that property: never vendor a data snapshot, a generated pack or book prose; only code and game numbers (rank table) that are already public in plus-ultra.

(c) Hybrid (RECOMMENDED, provisional): vendor only the pure rule core byte-identically, write our own Foundry-side layer, use plus-ultra softly for extras.
- Vendor `rules.mjs` + `state.mjs` (491 lines, pure, no Foundry globals [V]) into `scripts/systems/invincible/vendor/chargen/`, byte-identical, with the LETR mechanism [V: `invincible-plus-ultra/scripts/letters/sync.mjs`: canonical copy, `MANIFEST.json` of per-file hashes, `stamp.mjs` with a content hash, `sync.mjs <other>` copies, `sync.mjs --check [<other>]` exits 1 on any difference and is run by both modules' checks]. Canonical copy = plus-ultra (the wizard is the rules' primary user). The copy has its own module instance, so `setPowerMaxLevels` is fed by OUR catalogue (removes assumption [A] of option a). Validation, budget hints and all node tests then work with plus-ultra absent.
- Own Foundry-side layer (needed anyway, because NPCs have powers/sources/boosts/limits too and plus-ultra only writes `superhero` [V: apply.mjs `WrongType`]): catalogue index from the core packs (T4), sheet reader for the injected `<sheet>` block **[CHANGED 2026-11-17c]** (stateFromActor logic re-written, ~90 lines, documented heuristics kept identical), writer following plus-ultra's documented write order (chargen-spec 2.3: sources -> powers with embedded source id and level automations flipped -> boosts/limits with embedded power id -> talents/drawbacks -> one actor update -> Health/Resolve = max last) with our own undo flag and lock under `flags.moinens-ai-gen`.
- plus-ultra present (soft, Invincible only), extras switch on: superhero Apply goes through plus-ultra `apply.apply` (its hardened path, its undo, team-base cards), archetype/occupation lists from `api.chargen.provider`/`getArchetype` for the model's `search_catalog` kinds `archetype`/`occupation`, "Open in wizard". plus-ultra absent: superhero Apply uses our writer; archetype and occupation material comes from `read_rules` (the book's Archetypes and Occupation pages, whitelisted, read at runtime); "Open in wizard" is hidden. Nothing else changes.
- Validation messages: the vendored rules emit codes and i18n keys; our `validate.mjs` owns the English message + hint per code (section 7.2), so plus-ultra's 2,100-line `lang.mjs` is not needed.
- Drift control: `--check` in our test runner fails when the vendored copy differs from the MANIFEST; a second check (run when the sibling checkout exists) compares against plus-ultra's canonical copy. plus-ultra's own check gets the reverse comparison (T9). A plus-ultra change to `rules.mjs`/`state.mjs` is then a conscious sync step, not a silent behaviour change.
- Trade-off accepted: two superhero write paths (plus-ultra's when present, ours otherwise) means both are tested (T6, T10). If the owner prefers one path, the switch is O21.

Why (c): it satisfies the owner's binding rule fully (core works everywhere; Invincible works even without plus-ultra), keeps the only code that MUST agree between the wizard and the builder (the rules) mechanically identical, avoids copying the parts that are entangled with plus-ultra-only data, and keeps the battle-tested write path whenever plus-ultra is installed, which on this owner's tables it always is.

### 3.5 File layout (binding names)

```
scripts/build/
  main.mjs            start(): settings, header hooks, api.build, lazy imports; nothing runs until the GM opens a drawer
  anthropic.mjs       PURE: request builder (cache layout), SSE parser, error kinds, usage->cost. No Foundry globals (node-testable)
  harness.mjs         PURE-ish loop: run one GM turn to completion with caps; takes transport + router as parameters (mockable)
  session.mjs         per-document session, append-only history, persistence (IndexedDB), outside-edit detection
  registry.mjs        system pack registry + lazy loader + check()
  pricing.mjs         PURE: price table per model, cost of a usage block
  lang.mjs            MAIG.* strings EN/PL (or lang/*.json; follow the module's existing lang files)
  ui/drawer-app.mjs   the docked drawer (generalised from TestDrawerApp)
  ui/dock.mjs         docking maths extracted from test-drawer-app.mjs (shared by both drawers)
  ui/render.mjs       safe text/markdown-subset renderer for model output
  ui/diff-view.mjs    Plan -> HTML (fields from/to, items added/removed/kept, budget meter)
templates/build/*.hbs
styles/build.css      (imported from styles/module.css)
scripts/systems/invincible/
  pack.mjs            the pack object (3.2)
  catalog-index.mjs   builds the compact catalogue index + search + entry details (uses plus-ultra catalog)
  rules-digest.mjs    the paraphrased rules summary (numbers and rule structure only, no book prose) + read_rules page whitelist
  proposal.mjs        PURE: proposal schema <-> chargen state, npc/item proposal shapes, normalisation
  validate.mjs        validation pipeline (section 7)
  apply.mjs           own writer + undo (npc, items, and superheroes when plus-ultra is absent); delegates superheroes to plus-ultra apply when present
  reader.mjs          **[CHANGED 2026-11-17c]** actor -> model (items with ids, effects, unsaved form values, validation baseline); feeds snapshot.mjs and the projection of 7.5
  snapshot.mjs        **[CHANGED 2026-11-17c]** compact sheet serializer + line diff + the full-vs-diff decision (5.4)
  pu-bridge.mjs       soft plus-ultra detection, self-test, provider/archetype/apply/open wrappers (Invincible only)
  tools.mjs           tool definitions (section 6)
  vendor/chargen/     BYTE-IDENTICAL copy of plus-ultra rules.mjs + state.mjs, MANIFEST.json, stamp.mjs, sync.mjs (LETR-style); never edited here
dev/
  test-build-*.mjs    node tests (mock model, validator, cache layout)
  ai-gen-spec.md      this file
```

---------------------------------------------------------------------------------------------------

## 4. The drawer UI

### 4.1 Placement

- Opening: a header button on supported sheets (actor sheets of types the pack supports, item sheets of supported item types), GM only, plus a 3-dot dropdown entry via `getHeaderControls<SheetClass>` (same two mechanisms plus-ultra uses [V: chargen-spec section 4, `chargen/main.mjs` syncButton]). Icon must differ from plus-ultra's chargen button and from the image wand (both use `fa-wand-magic-sparkles` [V]); provisional `fa-solid fa-robot` (O10).
- The drawer is a frameless ApplicationV2 docked OUTSIDE the sheet's right edge (left edge when there is no room), same height minus the header, same z-index, hidden while the sheet is minimised, closed with the sheet. This is exactly what `TestDrawerApp.dock()` does for the config window today [V: `scripts/test-drawer-app.mjs`: ResizeObserver on the owner, window resize, flip, min width 280, panel 430]. Extract that maths into `ui/dock.mjs` and use it for both drawers.
- A collapsed tab (32 px) stays on the sheet edge when the drawer is closed but the session has a pending proposal (badge), so the GM sees there is something to apply.
- One drawer per document; reopening the sheet restores the session (section 11.2).

### 4.2 Content (top to bottom)

1. Header strip: system pack name, mode chip ("Superhero", "NPC", "Gear"), rank selector for superheroes (default: actor flag `invincible-plus-ultra.chargen.rank`, else plus-ultra client setting `chargenRank`, else Global Guardian [V: setting key `chargenRank` in `chargen/main.mjs`]), "New conversation" button, settings cog.
2. Chat stream: GM messages, model text (streamed), compact tool activity chips ("searched: web-slinging, wall-crawling", "read: Wall-Crawling (power)", "validation: 2 errors, retrying"), never raw JSON. Model text is rendered through `ui/render.mjs`: escape everything, then allow a tiny markdown subset (bold, lists, line breaks). No HTML from the model reaches the DOM.
3. **[CHANGED 2026-11-17b]** For `ops` proposals the card lists the operations one per row (add / change / remove, item name, one-line effect, its point cost) each with a checkbox. Proposal card (when the model submitted a valid proposal): one-paragraph rationale, the key picks as chips grouped (Powers, Talents, Drawbacks, Attributes, Texts), budget meter for superheroes (points budget/spent, slots vs rank, attribute cap) from `rules.attributeBudget` [V: exported in rules.mjs], warnings list. Buttons: Preview changes, Apply, Discard, "Open in wizard" (hand the state to plus-ultra's wizard for manual fine-tuning; needs task T9).
4. **[CHANGED 2026-11-17b]** Preview (diff) per item: one block per op with item name and kind and field-level before -> after (level, source, note, numbers, added description paragraph); cascade removals nested under the op that causes them; actor field changes as their own block; budget before -> after; untouched items only counted ("23 items unchanged, ids kept"); unsaved sheet input flagged with "save or discard first". For `replace` the same view is built from the ops the writer derived. Preview (diff) panel: from `pack.plan()`. Fields that change (from -> to), items to create (with level/source/power), items to delete (named, counted), items kept (gear, injuries never touched for superheroes [V: apply.mjs header]). Destructive plans (deletes > 0) need a deliberate confirm (hold-to-confirm, same rule the owner set for the wizard [V: chargen-handoff Decisions, answer 3]); `expect` = exactly the deletes/overwrites shown, so a sheet changed in between makes apply refuse instead of deleting more [V: apply.mjs `expect` (B6)].
5. **[CHANGED 2026-11-17b]** After apply: Undo all, plus an expandable list of the applied ops each with its own Undo (per-item undo, section 11.2). After apply: a result line with Undo (available while `undoStatus().available`; plus-ultra keeps 24 h [V: `UNDO_TTL`]) and the run id.
6. Footer: input box (Enter sends, Shift+Enter newline), Stop button while a turn runs (aborts the fetch via AbortController), usage indicator.

### 4.3 Usage / cost indicator

Per turn and per session: input tokens uncached, cache write, cache read, output tokens, cost in USD (and PLN if the module later gets an FX setting; O11), cache hit ratio = read / (read + write + uncached input). Colour: neutral; amber when a turn exceeded 50 % of the per-message cap. Tooltip lists model and effort. Also written to the existing call log (section 11.3).

### 4.4 Design process

Every visual decision goes to a design agent that has read the FULL impeccable + design-taste-frontend + foundry-vtt-module skills (owner's standing rule [V memory: feedback_full_skills_agents]); the drawer must look like the existing test drawer family, not a new chrome. Screenshots are checked by the lead, not trusted from agent claims.

---------------------------------------------------------------------------------------------------

## 5. Conversation harness

### 5.1 Transport

- Raw `fetch` to `https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2026-10-21`, `anthropic-dangerous-direct-browser-access: true`, exactly like the existing `scripts/enhance/anthropic.mjs` [V]. Rationale: the module has no bundler or npm dependencies [V: enhance/anthropic.mjs header comment]. (Vendoring the official SDK's ESM build is O12.)
- Streaming (`stream: true`), SSE parsed in `anthropic.mjs`, so text appears as it is generated and long turns never hit timeouts. `max_tokens` 32000 per request [A].
- `thinking`: leave default (adaptive on Sonnet 5.5); `output_config.effort` from settings, default `medium` (multi-step tool use; the claude-api skill recommends starting there for Sonnet 5.5 agentic work) [V: skill text].
- Server-side refusal fallback: `anthropic-beta: server-side-fallback-2026-07-01`, `fallbacks: "default"` for models in the existing `FALLBACK_MODELS` set [V: enhance/anthropic.mjs]. Always check `stop_reason` (`refusal`, `max_tokens`, `pause_turn`) before reading content.
- Tool choice `auto` only (forced `tool_choice` any/tool returns 400 on Sonnet 5.5 [V: skill]). Tools are `strict: true`.
- `eager_input_streaming` stays OFF for v1 (proposals are small, and with it on the client must re-validate truncated JSON). O13.

### 5.2 One GM turn

```
append user message: [sheet block (**[CHANGED 2026-11-17c]** full <sheet> on the first message, then <sheet_update> diff / <sheet_unchanged/> / fresh full <sheet>, rule 5.4)] + GM text
loop (request i = 1..maxRequests):
   reserve estimated cost in limits (existing limits.mjs reservation)  -> refuse turn if over budget
   send request (cached prefix + full history), stream
   append the assistant message EXACTLY as returned (all blocks, thinking blocks with signatures, unchanged)
   if stop_reason == "end_turn": stop
   if stop_reason == "tool_use": run every tool_use block (parallel allowed), append ONE user message with all tool_result blocks
   if stop_reason in (refusal, max_tokens): stop with a GM-visible notice
   check caps (5.3); on cap: append nothing more, stop, show the cap notice
book real usage + cost, release reservation
```
History is append-only: never edit, reorder, trim or delete earlier blocks (Sonnet 5.5 binds thinking blocks to the conversation; a history edit invalidates later thinking and the cache [V: skill, preserved thinking]). To shrink a long conversation the GM starts a new one (the new one begins from the current sheet snapshot).

### 5.3 Hard caps (per GM turn unless stated)

| Cap | Default | On hit |
|---|---|---|
| model requests | 12 | stop; "the AI needed more steps; say 'continue' or simplify" |
| tool calls (sum) | 40 | stop |
| consecutive invalid `submit_*` | 4 | stop; show the last draft with its errors; offer "Open in wizard" |
| identical invalid submission (same errors twice) | 2 | stop early (the model is looping) |
| estimated + actual cost | per-message cap setting (default USD 0.50) | refuse before the next request |
| wall clock | 5 min | abort |
| session history size | ~150k input tokens [A] | require "New conversation" |
| module daily/monthly limits | existing `limit.daily` / `limit.monthly` | refuse (same accounting as images) |

All caps are settings (world, GM-only) except the history size.

### 5.4 Outside edits

**[CHANGED 2026-11-17c]** The model always has the complete, current sheet in its context when it reads the GM's message, without any tool call. Rule per GM message (the sheet block is the FIRST text block of that user message, before the GM's words):
1. First message of a conversation (and after "New conversation"): a full `<sheet>` block (format 6.0).
2. Later messages: build a fresh snapshot (with live form values) and diff it line by line against the sheet the conversation currently holds (last full sheet + all later diffs, kept by the session):
   - no change: `<sheet_unchanged/>` (a few tokens; tells the model its picture is current);
   - change and the diff is small (<= 25 % of the full snapshot's lines AND <= 1,500 tokens [E thresholds, tune in T8]): `<sheet_update>` with removed/added/changed lines only (same line format, so a changed item line is simply its new line);
   - otherwise (big drift: an Apply of many ops, an undo of a run, a rebuild, edits outside the drawer on many items): a fresh full `<sheet>` block, marked `supersedes="all earlier sheet blocks"`.
3. Also a fresh full `<sheet>` when the conversation already holds 8 diffs since the last full sheet [E], so the model never has to fold a long chain of diffs.
Why diffs and not a full sheet every message: history is append-only (never edited, section 5.2), so each full copy stays in the context forever. A full copy per message would multiply the sheet tokens by the number of messages (e.g. 10 messages x 2.5k = 25k tokens of mostly duplicate text: more cache-write cost, slower requests, and several conflicting pictures of the same sheet for the model to keep apart). A diff keeps the picture complete (last full + its diffs) at a fraction of the size, and the size rule falls back to a full copy exactly when folding diffs would get error-prone. The cost difference is small either way (a 2.5k-token block is about $0.006 to write on Sonnet 5.5), so clarity for the model decides the thresholds, not price.
All of this is appended; nothing earlier is edited.

---------------------------------------------------------------------------------------------------

## 6. Tool set

### 6.0 Full sheet access **[CHANGED 2026-11-17b]**

**[CHANGED 2026-11-17c]** The WHOLE sheet is injected up front (5.4), not fetched by the model. The `<sheet>` block contains, in a compact line format:
- actor: `name`, `type`, every `system` field from `_source` (what is stored) AND the prepared values the sheet shows (derived Health/Resolve max, slugfest, bonuses, maxPush, initiativeSize) as a separate `prepared` block, so the model sees both what is written and what effects make of it [V: fields per chargen-spec 1.2 / 2.1 / 2.4];
- every owned item with a stable handle `itemId` (the embedded document id), `type`, `name`, `system` (level; powerSource also resolved to the source's name; boosts/limits' power link resolved to the power's name; gear numbers), description as plain text (cap 1,500 chars per item, marked when cut), automations summarised (type, name, showAsSelection, attack numbers; never the body of the JavaScript `extraConfiguration`, only a flag "has custom script"), the item's transfer effects (key, mode, value, disabled), and `origin`: the catalogue `ref` it matches by name, or `custom`, plus "hand-edited" when the description differs from the pack document;
- actor-level active effects (name, disabled, changes) and critical injuries (they are items);
- the flags that matter (plus-ultra chargen rank/archetype flag if present; our own undo journal summary), never other modules' flags;
- the sheet's live state: when the actor's sheet is open, the pack reads its form with `FormDataExtended` and reports fields whose live value differs from `_source` as `unsaved: [{ path, stored, live }]` [A: v14 class path `foundry.applications.ux.FormDataExtended`]. The Invincible actor and item sheets use `submitOnChange: true` [V: system/sheets/actor-sheet.mjs:34, item-sheet.mjs:41], so "unsaved" is mostly a field still focused or an open rich-text editor. The model is told that unsaved values are what the GM is looking at; before Apply the drawer asks the GM to save or discard them (an Apply over unsaved input would be overwritten by the sheet's next submit);
- `validation`: the current creation-rule result (vendored `rules.validate` on the actor read as a chargen state) and the budget block, labelled "current baseline" (section 7.5).
**[CHANGED 2026-11-17c]** Compact serialization (one line per fact, no JSON braces, no repeated keys; ids shortened to the 16-char item id; numbers bare; text quoted and cut). Example shape (illustrative values):
```
<sheet doc="Actor.x1" type=superhero name="Spider-Man" rank=global profile=creation fp=9f3a1c>
ATTR FIG 4 AGI 8 STR 6 REA 6 INT 7 PRE 4 | HP 9/9 RES 9/9 SLUG 3 REP 2 RSRC 3 KARMA 0 PUSH -
TEXT civilianName="Peter Parker" role="Wildcard" occupation="Photographer" personality="Witty, Anxious" drive="..." flaw="..." appearance="..." relationships="..." team="..." teamBase="..."
I abc123 powerSource "Radioactive spider bite" custom
I def456 power "Wall-Crawling" lvl=basic src=abc123 ref=powers:Xy12 fx=-
I ghi789 power "Super-Strength" lvl=major src=abc123 ref=powers:Ab34
I jkl012 boost "..." pow=ghi789 ref=boosts:Cd56
I mno345 talent "Quick Reflexes" role=hero ref=talents:Ef78 fx=initiativeSize+1
I pqr678 drawback "Hard Times" ref=drawbacks:WS54 fx=resources-1
I stu901 gear "Camera" custom cost=2 desc="Hand-edited: ..."
FX actor "Stunned" disabled
UNSAVED system.appearance stored="" live="Red and blue suit..."
VALID creation ok=false errors=attr.unspent(3) budget=34 spent=31 slots=3/4 cap=10
</sheet>
```
- **[CHANGED W2-3]** Superhero talents carry `role=hero|occupation|extra` and keep the actor's collection order (the order IS the role, as plus-ultra import.mjs reads it: 1st hero, 2nd occupation when the occupation text is set, the rest extras; the item `sort` field plays no part). Other items stay in tree/name order. New items are always appended, so replacing the hero or occupation talent shifts roles: the validator warns `talent.role.shift`.
- Item descriptions are NOT repeated for catalogue items (the model gets the rules text by `ref` through `get_entries`, cached in the conversation once read); only custom or hand-edited items carry `desc=` (plain text, cap 400 chars, marked when cut).
- Automations appear only as a short `auto=` tag when they differ from the pack copy or carry a custom script flag; the script body is never sent.
- Line keys for diffing: `ATTR`, `TEXT.<field>` (TEXT is split one field per line when it is long), `I <itemId>`, `FX <effectId>`, `UNSAVED <path>`, `VALID`.
- Size [E]: header + ATTR + TEXT 250-600 tokens; 15-30 items x 20-30 tokens = 300-900; custom descriptions 0-1,500; VALID ~60. Typical filled superhero **~1,000-2,500 tokens**, a big NPC with many custom items up to ~4,000. Hard cap 6,000: above it custom descriptions are cut first, then effects folded into counts, with a note that `read_document` gives the full text.




All tools are read-only or dry-run. None writes a document. Names, descriptions and schemas are static per pack version (cache stability). Inputs use `additionalProperties: false`, `required` lists. Results are compact JSON text; long text is cut with an explicit "(truncated, N chars)" marker. Catalogue entries are referenced by a short stable `ref` (pack short name + document id, e.g. `powers:abc123`), never by full UUID strings the model could mistype; the harness maps refs to UUIDs.

| Tool | Input | Output | Notes |
|---|---|---|---|
| `search_catalog` | `{ query, kinds:[power, boost, limit, powerSource, talent, drawback, gear, vehicleWeapon, archetype, occupation, npcProfile, sampleHero], forPower?, limit<=25 }` | `[{ ref, kind, name, type?, levels?, power?, summary, needs? }]` | Name + summary matching (lowercase, accent-insensitive, simple token scoring) over the in-memory index. `forPower` narrows boosts/limits to that power (plus-ultra `boostsFor/limitsFor` [V: catalog.mjs:132-133]). |
| `get_entries` | `{ refs:[...] <= 8 }` | `[{ ref, name, kind, rulesText, levels:{basic,major,...}, automations:[{type, bonus, damage, range}], effects:[{key, value}], needs?, slotNote }]` | `rulesText` = the item's description HTML converted to plain text, cap 2,500 chars each. Book text goes only to the API at runtime, never to the repo. |
| `read_rules` | `{ topic: enum }` | `{ topic, text }` | Whitelisted core-book pages only (creation steps, powers intro, talents/drawbacks intro, gear & resources, weapons, NPC creation, minions, vehicles). Page ids from chargen-spec section 1 [V there]. The Quickstart journal is never a source. Cap 6,000 chars per call. |
| `read_document` **[CHANGED 2026-11-17c]** (narrowed, kept) | `{ target: "this" | <world document name or uuid>, itemIds?: [id], fields?: [description, automations, effects, system] }` | full detail in the 6.0 line format plus requested deep fields | NOT for reading this sheet's normal state (that is already in context). Two uses only: (1) deep fields of this sheet's items that the compact block leaves out (full hand-edited descriptions over the cut, automation details, effect changes); (2) OTHER documents the GM refers to ("make him like the Omni-Man actor", "use the gear on Mark's sheet"): world actors/items by name or uuid, GM-visible only, read-only, same compact format. Kept rather than removed because both needs are real and rare; removing it would force the whole world or all deep fields into the context. |
| `check_proposal` | same input as `submit_proposal` | `{ ok, errors[], warnings[], info[], budget }` | Dry run of section 7, for exploring ("what does Flight at Major cost?"). Does not become the pending proposal. |
| `submit_proposal` **[CHANGED 2026-11-17b]** | `{ target: "this"|"newItem", mode: "ops"|"replace", ops?: [Op], proposal?: {...}, rationale, choiceNotes:[{opId|path, why}] }` | `{ ok, proposalId, errors[], warnings[], summary }` | Runs section 7 including the plan dry run. If `ok`, the proposal becomes the session's pending proposal and the drawer shows the card. The system prompt tells the model to end its turn after a successful submit and wait for the GM. |

Proposal shapes (system pack, `proposal.mjs`):
- `mode: "ops"` **[CHANGED 2026-11-17b]** (DEFAULT for any existing, non-blank document): a list of small operations applied in place; everything not named stays as it is (ids, descriptions, effects, other modules' flags). Each op has a model-chosen unique `opId` used by the diff, validation errors and undo.
  - `addItem { opId, ref | custom, level?, sourceItemId? | sourceOpId?, powerItemId? | powerOpId?, grants?, note? }`: copy of a catalogue entry (`custom` only for gear/vehicleWeapon, section 10.3); a boost/limit names its power (existing item or an add in the same list); a new power names its source the same way.
  - `updateItem { opId, itemId, set: { level?, powerSourceItemId?, note?, name?, descriptionAppend?, gear?: { cost, restricted, singleUse, attack? } } }`: whitelisted fields only. A level change flips the level automations exactly as a pack copy would (`showAsSelection` by level word [V: chargen-spec A6]); for split-level powers (Protection, Strike, Size Alteration, Extra Limbs: one document per level) it becomes remove+add of the level document with the SAME `system.powerSource` and the power's boosts/limits re-pointed to the new id (shown as one op in the diff).
  - `removeItem { opId, itemId, cascade?: boolean }`: removing a power that has boosts/limits, or a source that powers use, is an error unless `cascade: true` (dependants listed as nested removals) or the same list re-points them.
  - `updateActor { opId, set: { "system.<path>" | "name": value } }`: whitelist: name, attributes, texts (civilianName, role, appearance, occupation, personality, drive, flaw, relationships, team, teamBase), reputation, resources. Never derived max values, flags; karma and current Health/Resolve only per O25.
- `mode: "replace"`: for a blank actor or an explicit "rebuild from scratch": `superhero` = the plus-ultra chargen `state` object [V: shape in chargen-spec 6.1 / state.mjs] minus UI-only fields (`seed`, `locks`, `touched`, `mode`, `rolledAs`), with catalogue `ref`s in place of `packUuid`. **[CHANGED 2026-11-17b]** The writer diffs it against the actor and turns it into ops: items with the same ref+name are KEPT with their ids, only the difference is added/updated/removed (section 8.4).
- `npc`: `{ name, attributes{6}, powers[{ref, level}], boosts[], limits[], talents[], drawbacks[], texts{appearance, drive, flaw, personality, ...}, specialAbilities: string }`.
- `gear` / `vehicleWeapon`: `{ baseRef? , name, description, cost, restricted, singleUse, attack?: { bonus, damage, minRange, maxRange, bypassArmor } }` where `attack` maps to ONE `rollAttack` automation; no other automation types (section 10.3).

No tool returns or accepts images, macros, scripts, file paths or HTML.

---------------------------------------------------------------------------------------------------

## 7. Validation layer and self-repair

### 7.1 Pipeline (each layer stops the pipeline on errors and reports them all)

L0 Shape: strict tool schema (API-side) + a local schema check (the harness never trusts a tool input; also covers a future eager-streaming switch).
L1 References: every `ref` exists in the index; boost/limit belong to the named power (folder rule, plus-ultra `boostsFor/limitsFor`); requested level exists for that power (`powerMaxLevel`, level docs for split-level powers [V: chargen-spec A6, rules.mjs:50]); talent/drawback names resolve (`Catalog.resolveDoc`) [V: catalog.mjs:145].
L2 System rules:
  - superhero: plus-ultra `rules.validate(state)` [V: rules.mjs:174] = rank budget (points = P_R + 2(N_R - slots) - extra sources - extra talents + drawbacks), every attribute 1..cap, ALL points spent (owner's decision), level rules (needs previous level; Massive only at Cosmic; never Monstrous), limits paired with a grant, drawbacks <= 2, no duplicate talents except the repeatable ones, hero + occupation talent present, resources = occupation value, personality exactly 2 words, drive/flaw/hero name present, team upgrade count. Codes and severities exactly as plus-ultra emits them.
  - npc: section 7.4.
  - items: section 10.3 whitelist + numeric ranges (cost >= 0, damage >= 0, ranges >= 0, min <= max) + Foundry DataModel validation of the final item data (construct `new CONFIG.Item.documentClass(data)` in a throwaway way / `validate({strict:true})`) [A: exact v14 call to be confirmed by the implementing agent].
L3 Plan dry run (superhero: plus-ultra `apply.plan(actor, state)` [V: apply.mjs:206, writes nothing, resolves every document, checks owner/permission/team-base intents]; others: own plan). Its errors join the list.
L4 GM policy (warnings only): rank differs from the drawer's rank selector; the build deletes items the GM added by hand (named); the proposal changes fields the GM did not ask about (heuristic: fields outside the last instruction's scope are listed so the GM sees them in the diff, never blocked).

### 7.2 Error format back to the model

Plain JSON in the tool result (not `is_error`, which is reserved for "the tool itself failed"):
```json
{ "ok": false,
  "errors": [ { "code": "attr.unspent", "path": "attrs", "message": "3 attribute points are unspent (budget 34).", "hint": "Raise attributes by 3 total, each within 1..10." } ],
  "warnings": [ ... ], "budget": { "points": 34, "spent": 31, "slots": 3, "rankPowers": 4, "cap": 10 } }
```
`message` = English text from plus-ultra's EN strings for that code (its `apply-lang.mjs`/`lang.mjs` [V: files exist]; English because the system's item names are English [V: chargen-spec A9]); `hint` = a short fix template per code, written by us in `validate.mjs` (codes list from rules.mjs). The budget block is always included so the model can do the arithmetic without guessing.

### 7.3 Self-repair policy

- The model may call `check_proposal` freely (counts against tool-call cap) and `submit_proposal` up to the consecutive-invalid cap.
- The harness never "auto-fixes" a proposal silently. One exception set, all deterministic and listed in the result as `autoFixed`: trimming whitespace, collapsing duplicate personality words, mapping a talent name with different case to the catalogue name.
- Attribute arithmetic is the most likely failure. The pack offers plus-ultra `reconcileAttributes(attrs, target, cap)` [V: rules.mjs:105] as a hint generator: on `attr.over/attr.unspent` the hint contains a reconciled vector the model may adopt. It is a suggestion, the model still submits.

### 7.5 Validating per-item edits **[CHANGED 2026-11-17b]**

1. Projection: the ops are applied to an in-memory copy of the actor (`actor.toObject()` with its items), never to the document. The projected copy is read back through `reader.mjs` into a chargen state and validated by the vendored `rules.validate` (superhero) or the NPC rules (7.4); item-level checks (L0, L1, 10.3) run per op and errors point at its `opId`.
2. Structural rules are ALWAYS hard errors on the projection: references resolve; level legality per power (needs the previous level, Massive only at Cosmic, never Monstrous, no level the power does not have); every boost/limit points at a power present after the change; every power points at a source present after the change; no duplicate non-repeatable talent/drawback; drawbacks <= 2; limit grant pairing.
3. Budget rules depend on the validation profile chosen in the drawer (O23):
   - `creation` (default for heroes still being built): the projection must pass `rules.validate` fully, i.e. after "add Flight" the points and slots must still balance with ALL points spent; the model must pay for the new slot (lower attributes by 2 in total, drop a boost, take a drawback...) and say how in `choiceNotes`.
   - `in-play` (heroes that already grew in play; the GM picks it, and the drawer suggests it when the CURRENT actor already fails the creation budget): "no new errors": error codes/paths present in the baseline (the same pipeline on the unchanged actor) are tolerated, any error new in the projection blocks; the budget delta is reported as info ("under creation rules this change costs 2 attribute points"). Book growth rules are not enforced in v1 (O24).
4. The result always carries `budget.before` and `budget.after` (points, spent, slots, rank powers, cap) and a per-op cost (slot delta x 2 points; the hero talent and the occupation talent are free, each extra talent -1; drawback +1; the first power source free, each extra source -1; **[CHANGED 2026-11-17, P1-C]** actor-field ops are evaluated first, the list keeps the op order, and every entry carries a readable `label` such as "occupation talent (free)" or "+1 slot (slots 3/4) -2 pts"), so the model and the GM see what each single change costs. **[CHANGED 2026-11-17, W2-5]** per-op entry = `{ opId, points, slots, label, spentAfter? }`: points/slots are the change that op makes; the old `spent` delta is gone, an op that changes attributes carries `spentAfter` (the attribute sum after it) and the label "attributes spent 12 -> 34"; an added limit is labelled by what it pays for ("pays for a boost of \"X\" (no slot for it; slots 1/3) +2 pts"), a removed one by the slot it gives back; `budget.note` says that points include 2 per unused rank slot. Issues may carry a GM-only `gm` remark (the book's Hard Times -2) that the model's tool result drops.
5. Apply re-runs 1-4 on the CURRENT actor. If an `itemId` named by an op no longer exists or changed since the preview (per-item fingerprint: `_stats.modifiedTime` or a hash of its `_source` [A]), that op is named and the apply is refused as a whole (no silent partial write).
6. Partial selection: the GM can untick single ops in the preview; dependants of an unticked op are unticked with it (shown), and the remaining set is re-projected and re-validated before Apply is enabled.

### 7.4 NPC rules (book: NPCs work like heroes but creation is free-form)

Paraphrase [V: book-dump "Creating NPCs" section, read 2026-11-17]: start from a stock NPC profile or a hero archetype; attributes set to whatever fits the concept; powers only if they will be used, swaps at the same level are free; talents optional; drawbacks encouraged when they give the heroes a vulnerability to find; special abilities as free text; personal stuff = name/identity, appearance, drive, flaw, personality.
So the NPC validator enforces structure, not budget: attributes integers 0..12 (system model range [V: chargen-spec 1.2]), references resolve, level legality per power (no level above what exists), boosts/limits attached to a present power, no duplicate non-repeatable talents, drawbacks with required notes flagged. A soft "power level vs threat" warning compares against the rank's cap (info only). Minions (`minions` type: Health max fixed 10 [V: actor-minions.mjs]) are out of v1.

---------------------------------------------------------------------------------------------------

## 8. What plus-ultra's chargen already offers

With option (c) of section 3.4: `rules.mjs` + `state.mjs` are used from the vendored copy; the API rows below are the soft extras used only when plus-ultra is active on Invincible. Without plus-ultra the pack replaces them as stated in 3.4.

All [V] from `modules/invincible-plus-ultra/scripts/chargen/*` (read-only for this project) and `dev/chargen-spec.md`, `dev/chargen-handoff.md` (phases 1-11 DONE, live-verified per the handoff log).

### 8.1 Available through the public API today (`game.modules.get("invincible-plus-ultra").api.chargen`)

| API | What we use it for |
|---|---|
| `catalog.available()` | dependency check of the core packs |
| `catalog.powers()`, `powerSources`, `talents`, `drawbacks`, `boostsFor(power)`, `limitsFor(power)`, `findPower`, `findByName`, `resolveDoc`, `norm` | the catalogue index and L1 reference checks; name normalisation identical to the wizard |
| `catalog.getArchetype(id)`, `provider()` | archetype data (16 archetypes with suggested powers/attributes/talent lists) and the book lists (occupations with resources and their 3 talents, personality/drive/flaw lists) generated from the installed book; a strong starting point for "build X" |
| `tables.*` | the `chargen-tables` pack (181 tables) [V: chargen-spec 3.1] — only if we ever offer "roll" |
| `apply.plan(actor, state)` | the L3 dry run and the diff view (fields/creates/deletes/keeps/counts/destructive) |
| `apply.apply(actor, state, { confirmed, expect, onStage })` | the ONLY write path for superheroes: correct order (sources -> powers with embedded source id -> boosts/limits with embedded power id -> talents/drawbacks -> one actor update -> Health/Resolve current = max), level automations flipped, rollback on error, per-hero write lock (90 s TTL), undo backup |
| `apply.undo(actor)`, `hasUndo`, `undoStatus` | Undo button (24 h, refuses stale writes without drift confirmation) |
| `open(actor)`, `canUse(actor)` | "Open in wizard" (today without a state; see 8.3) |

### 8.2 Pure modules (not in the API, importable by path)

`rules.mjs` (validate, validateStep, budget, budgetFor, attributeBudget, reconcileAttributes, derive, RANKS, ATTRS, ROLES, MAX_DRAWBACKS, levelCap, powerMaxLevel, setPowerMaxLevels...), `state.mjs` (createState, reducers, serialize/deserialize), `import.mjs` (describeActor, stateFromActor) [V: exports listed by grep]. They are written to run in node without Foundry globals [V: chargen-spec section 5 hard rule; import.mjs uses `foundry.utils.getProperty`, so it is NOT node-pure]. Option (c): `rules.mjs` and `state.mjs` are VENDORED byte-identically (section 3.4); `import.mjs` is not vendored (Foundry-coupled) and is re-written as `reader.mjs`.
Note: `rules.powerMaxLevel` depends on `setPowerMaxLevels(entries)` having been fed by a catalogue [V: rules.mjs:46-50]; the vendored copy is its own module instance, so OUR catalogue index must call it at build time.

### 8.3 Small additions requested from plus-ultra (task T9, done in the plus-ultra repo by its own agent, not by builder agents)

1. Expose `api.chargen.rules`, `api.chargen.state`, `api.chargen.importer = { describeActor, stateFromActor }` (removes the path coupling).
2. `api.chargen.open(actor, { state })`: open the wizard pre-filled with a state (for "Open in wizard").
3. Optional: `api.chargen.buildItemData(type, ref, { level, note })` = the item-data builder inside apply (level automations flip, note in the name), so a future incremental "edit" writer does not duplicate it.
4. Optional: a stable `apiVersion` number on `api.chargen`.

### 8.4 Known limitation inherited

plus-ultra's apply is a DESTRUCTIVE REPLACE of the six creation item types (powerSource, power, boost, limit, talent, drawback); gear and injuries are kept [V: apply.mjs header, `WIPE_TYPES`]. A small edit ("add Flight") therefore re-creates all of those items with new ids, losing hand edits to their descriptions and any references to their ids (macros, combat-tracker data, tactical-combat state). ~~v1 accepts this for superheroes~~ **[CHANGED 2026-11-17b]** REVISED: not acceptable (owner: single items are modified in place). Our own writer is the write path for every `ops` and `replace` proposal on every actor type: in-place `createEmbeddedDocuments` / `updateEmbeddedDocuments` / `deleteEmbeddedDocuments` plus one `actor.update` for actor fields; untouched and updated items keep their ids; write order for adds keeps plus-ultra's documented rule (sources -> powers with embedded source id -> boosts/limits with embedded power id -> talents/drawbacks -> actor update -> current Health/Resolve re-clamped only if the new max is lower). plus-ultra's destructive `apply.apply` is used only behind an explicit "Full rebuild (plus-ultra)" action on a superhero when plus-ultra is active (O21).
`stateFromActor` is heuristic (which talent is the hero vs occupation talent; a limit's grant) [V: import.mjs header]; **[CHANGED 2026-11-17c]** the model sees the result in the injected `<sheet>` block (its `VALID` line) and validation flags inconsistencies.

---------------------------------------------------------------------------------------------------

## 9. Prompt caching layout and token sizes

### 9.1 Request layout (render order tools -> system -> messages)

```
tools[]                       static per pack version (core-agnostic + pack tools, sorted, deterministic JSON)
system[0]  harness rules      static, system-agnostic: role, the build workflow, "only via tools", end turn after submit, language policy
system[1]  pack rules digest  static per pack version: paraphrased creation rules, numbers, rank table, NPC/item rules, naming conventions
system[2]  catalogue index    static per catalogue fingerprint: one line per entry, sorted by kind then name
           cache_control: { type: "ephemeral", ttl: "1h" }        <- breakpoint 1 (explicit)
messages:
  user[0]  **[CHANGED 2026-11-17c]** <sheet ...> full block </sheet> + the GM's first message      (after breakpoint 1, so it never touches the shared prefix)
  user[k]  <sheet_update>/<sheet_unchanged/>/fresh <sheet> + the GM's k-th message (rule 5.4)
  assistant / user(tool_result) / ... append-only
top-level cache_control: { type: "ephemeral" }                    <- breakpoint 2 (automatic, 5 min, moves with the tail)
```
- Byte stability rules: no timestamps, actor names, user names, world names, random ids or settings values in tools/system. JSON serialised with fixed key order. The catalogue index is regenerated only when the catalogue fingerprint changes (pack ids + document counts + `_stats.modifiedTime` max [A: field availability in the index]).
- One tool set and one system prompt per pack for ALL modes (superhero, npc, items): the mode lives in the sheet block, so every drawer in the world shares breakpoint 1. **[CHANGED 2026-11-17c]** The sheet block is per-document data: it must never go into `system[]` (that would split the shared prefix per actor and rewrite it on every sheet change); it lives in the user turns and is cached by the automatic tail breakpoint like the rest of the conversation.
- TTL: 1 h on breakpoint 1 because GM use is bursty (minutes of reading between turns); 5 min (automatic) on the tail; longer TTL before shorter, as required [V: skill prompt-caching.md]. Pre-warm with a `max_tokens: 0` request when a drawer opens and no warm entry is known (cheap write, removes first-turn latency) [V: skill "Pre-warming"]; O14.
- Sheet changes go in as a `<sheet_update>` text block in the next user turn (5.4), never by editing system[] or old messages.
- Model or effort change mid-session invalidates the cache (caches are model-scoped; a top-level effort change invalidates the messages cache [V: skill]). The drawer warns and offers a new conversation.
- Minimum cacheable prefix on Sonnet 5.5 is 512 tokens [V: skill table] — we are far above.
- 20-block lookback: each loop request adds ~2 positions (assistant tool_use run + user tool_result run), so the automatic breakpoint always finds the previous entry [V: skill rule]; no extra markers needed. Breakpoints used: 2 of 4.

### 9.2 Expected sizes [E]

Basis: book-index section sizes (chars) [V: `invincible-plus-ultra/dev/book-index.txt`]: Powers chapter ~105k chars, Talents ~14k, Drawbacks ~7k; pack counts [V: chargen-spec 3]: powers 81, boosts 85, limits 40, talents 57, drawbacks 15, power sources 36, gears 46 (+ vehicle weapons unknown), archetypes 16, occupations 22, NPC profiles 30, sample heroes 64.

| Block | Content | Tokens [E] |
|---|---|---|
| tools | 6 tools, strict schemas, proposal schema is the biggest | 2,500-3,500 |
| system[0] harness | workflow + rules of engagement | 1,000-1,500 |
| system[1] rules digest | rank table, budget formula, level/limit rules, talent/drawback rules, field conventions, NPC and gear rules, item-type map | 2,500-4,000 |
| system[2] catalogue index | ~480 lines x ~20-30 tokens (ref, name, type/levels, 8-12-word summary) | 10,000-14,000 |
| **cached prefix total** | | **~16,000-23,000** |
| sheet block **[CHANGED 2026-11-17c]** | full `<sheet>` once per conversation (and on big drift) / `<sheet_update>` 50-1,500 / `<sheet_unchanged/>` ~5 | 1,000-2,500 full (cap 6,000) |
| per tool result | search 300-1,200; get_entries 600-700 per entry; read_rules <= 1,600; validation 200-600 | |
| typical "build Spider-Man" turn | **[CHANGED 2026-11-17c]** 5-9 requests (no read_document round trip) | |
| typical single-item edit ("give him Flight") | **[CHANGED 2026-11-17c]** 2-4 requests: get_entries, check/submit | |

Cost per first build turn, Sonnet 5.5 ($2 in / $10 out, cache read $0.10, write 1.25x 5 min, 2x 1 h per MTok [V: skill pricing]): prefix 20k written once at 1 h = 20k x $4/M = $0.08; each later request reads it for 20k x $0.10/M = $0.002; tail writes ~2-4k per request x $2.5/M ~ $0.008; output incl. thinking ~1-2k x $10/M ~ $0.015. Ten requests: ~$0.08 + 10 x $0.025 ~ **$0.30-0.40 for the first build, ~$0.15-0.25 for follow-ups** while the prefix is warm. Numbers must be replaced by measured `usage` in T8. **[CHANGED 2026-11-17c]** Injecting the sheet adds ~1-2.5k tokens to the first message (one tail write, about $0.003-0.006) and removes one or two `read_document` requests per turn (each ~$0.02), so cost goes slightly down and latency down by one round trip; a single-item edit turn is estimated at ~$0.05-0.10 with a warm prefix.

The full rules text of every entry (~35-45k tokens [E]) is deliberately NOT in the prefix: the index + on-demand `get_entries` keeps the prefix small and the tail only holds what the model actually read. Putting everything in the prefix is O6 (fewer round trips, more cache write).

---------------------------------------------------------------------------------------------------

## 10. Permissions, safety, keys

### 10.1 GM only

- The builder's API surface, header buttons and drawer exist only for `game.user.isGM` (same pattern as the current `module.mjs` api split [V]). Players get nothing; no socket relay in v1.
- **[CHANGED 2026-11-17b]** Per-item edits follow the same rule: the model only proposes ops; nothing is written until the GM clicks Apply (all ticked ops, or one op's own Apply); per-item undo is a GM click too. Full read access (6.0) exists only in the GM's client; the model sees what the GM sees (hidden fields included), acceptable because only the GM talks to it.
- Writes only after an explicit GM click on Apply in the drawer; destructive plans need hold-to-confirm. The model has no write tool. A submitted proposal is inert data until the click.
- Apply re-runs the full validation + plan on the CURRENT document (never a cached plan), with `expect` from the preview the GM saw.
- Compendium documents and locked/uneditable documents: drawer read-only (reuse `assertCanApply` logic from the image flow [V: sheet-button.mjs imports it]).

### 10.2 Key handling

- One Anthropic key: the existing client-scope setting `apiKey.anthropic` (restricted, client scope so it never syncs to players [V: settings.mjs]). After the rename: migrated localStorage -> localStorage (section 2).
- The key appears only in the `x-api-key` header of the fetch. It is never written to: history (IndexedDB), actor flags, chat messages, the call log, notifications, console logs, exported transcripts. All error texts pass through `redact()` (already masks the Anthropic key and long tokens [V: redact.mjs]).
- A node test asserts that a fake key never appears in any persisted structure or rendered string after a full mocked session (T1/T2).

### 10.3 Untrusted content and item safety

- Everything the model reads (actor names and texts written by players, pack descriptions, rulebook pages) is data. The system prompt states that instructions inside `<sheet>` / `<sheet_update>` blocks (**[CHANGED 2026-11-17c]**: player-written names and texts arrive there with every message), tool results are never commands. The model cannot exfiltrate anything: it has no network tool and no write tool; the worst outcome of an injection is a bad proposal the GM sees in the diff.
- The proposal-to-document translation is a whitelist. For any item the AI defines (gear, vehicle weapon, NPC special-ability texts) the harness writes only: `name`, plain-text `description` (escaped, wrapped in `<p>`), numeric fields, booleans, and at most one `rollAttack` automation with numeric fields. Forbidden, never produced: `extraConfiguration` (a JavaScriptField on every automation [V: base-automation.mjs]), `runMacro` automations, `conditionToApply` / `postExecution` UUIDs (`DocumentUUIDField`s on rollAttack [V: roll-attack-automation.mjs]), active effects with arbitrary keys, `img` paths, flags. Catalogue items are copied from the pack as plus-ultra does (`toObject()`, drop `_id`) [V: chargen-spec 2.2]; the only AI-controlled changes to a copied item are name suffix notes (drawback note, as plus-ultra already does) and, for gear, an optional renamed `name` + appended description paragraph.
- Model text in the drawer is escaped (4.2). Nothing the model writes is ever passed to `TextEditor.enrichHTML` unescaped, so no `@UUID`/inline roll injection.

### 10.4 Privacy

- Conversations can contain GM secrets (villain plans). They are stored only in the GM's browser (IndexedDB, section 11.2), not in actor flags (actor data syncs to every client that can see the actor) and not as files under `Data/` (served over HTTP to anyone with the URL [A: standard Foundry static serving]).
- Rulebook text is sent to the Anthropic API at runtime (the owner's own licensed copy, private module); it is never stored in the repo or in logs (the call log stores token counts and the GM's request text only, cut to `FIELD_MAX.prompt` [V: call-log.mjs]).

---------------------------------------------------------------------------------------------------

## 11. Settings, storage, cost accounting

### 11.1 Settings (all `restricted`, GM)

| Key | Scope | Default |
|---|---|---|
| `build.model` | world | `claude-sonnet-5-5` |
| `build.effort` | world | `medium` (choices "", low, medium, high, xhigh, max like `enhance.effort` [V]) |
| `build.cacheTtl` | world | `1h` (or `5m`) |
| `build.maxCostPerMessage` | world | 0.50 USD |
| `build.maxRequestsPerMessage` | world | 12 |
| `build.maxInvalidSubmits` | world | 4 |
| `build.prewarm` | client | true |
| `build.headerButton` | client | true |
| `apiKey.anthropic` | client | existing |

### 11.2 Storage

- Session history: IndexedDB database `moinens-ai-gen` store `sessions`, key `${worldId}:${docUuid}`, value `{ v, pack, packVersion, model, effort, createdAt, messages:[...], usage:{...}, snapshotFingerprint, pendingProposal, lastRunId }`. Wrapped in try/catch; when IndexedDB is unavailable the session lives in memory for the page lifetime.
- Pending proposal survives a reload (in the same record); it is re-planned before showing Apply.
- **[CHANGED 2026-11-17b]** Undo journal (our writer, every actor type): `flags.moinens-ai-gen.undo = { runs: [{ runId, at, ops: [{ opId, kind, itemId, before, after }] }] }`, newest 10 runs, 24 h TTL, game data only (never conversation text). `before` = the item's full `_source` for update/remove, restored with `keepId: true` so links from boosts/limits/powers survive (the technique plus-ultra's undo uses [V: apply.mjs header]); `null` for adds (undo = delete). Per-item undo is allowed when that item still equals `after`; otherwise the GM confirms the drift (like plus-ultra's confirmUndo [V: chargen/main.mjs]). Undoing a removed power restores its cascade with it. A plus-ultra full rebuild keeps plus-ultra's own backup.
- Catalogue index cache: memory, rebuilt per page load (or IndexedDB keyed by fingerprint if the build turns out slow; measure in T4).

### 11.3 Cost accounting

- Price table in `pricing.mjs` (model -> input, output, cache read, cache write 5m, cache write 1h), with Sonnet 5.5 / Opus 5.5 / Haiku 5.5 rows [V: skill table, cached 2026-11-03]; unknown model -> estimate with the Opus row and mark "estimated".
- Every request goes through the existing limits reservation (`limits.mjs` in-flight reservations + daily/monthly counters [V]) and is booked with the real cost from `usage`.
- Call-log entry per request with `kind: "build"`, `model`, `tokens`, `cost`, `docUuid`, `docName`, `durationMs`; extend `LOG_FIELDS` with `cacheRead`, `cacheWrite` [V: current LOG_FIELDS has `tokens` only]. The log window gets a "Builder" filter.

---------------------------------------------------------------------------------------------------

## 12. Test plan

### 12.1 Node, no network (every task ships its tests; runner like `dev/test-enhance.mjs` [V])

- `test-build-anthropic.mjs`: request builder (headers, fallback beta, effort, cache_control placement: exactly one explicit marker on system[last] with the chosen TTL + top-level automatic), SSE parser (text, thinking, tool_use with partial JSON, message_delta usage, error events, refusal, max_tokens, pause_turn), error kinds, usage -> cost.
- `test-build-cache-stability.mjs`: build turn 1, 2, 5 of a scripted session and assert the serialised bytes of tools + system are identical across turns and across two different actors and modes; assert history is a strict prefix of the next request's history (append-only).
- `test-build-harness.mjs` with a MOCK MODEL (scripted fetch returning SSE streams): happy path (search -> get -> submit ok -> end_turn); self-repair (submit invalid -> errors -> submit valid); each cap (requests, tool calls, consecutive invalid, identical invalid, cost, abort/Stop); parallel tool calls answered in ONE user message; tool exceptions -> `is_error: true` results; refusal surfaced.
- `test-build-validate-invincible.mjs`: imports the VENDORED `rules.mjs`/`state.mjs` (pure [V]); runs `vendor/chargen/sync.mjs --check` first and the pack's `proposal.mjs` / `validate.mjs` pure parts: all 16 archetype vectors pass the budget rule (same oracle as plus-ultra's check-rules: sum = 32 + 2(4 - slots) [V: chargen-spec 1.3]); hand-made invalid proposals produce the expected codes and hints; the hint generator's reconciled vector is valid; NPC structural rules; gear whitelist strips every forbidden field (extraConfiguration, runMacro, conditionToApply, postExecution, effects, img, flags).
- **[CHANGED 2026-11-17b]** `test-build-ops.mjs`: projection of every op kind on fixture actors (shapes like the sample heroes, no book text in fixtures); stable ids for untouched/updated items; cascade rules; split-level power level change keeps the source and re-points boosts; `creation` vs `in-play` ("no new errors"); per-op cost; partial selection re-validation; undo journal round trip (apply ops, undo one, undo all) on an in-memory actor stub.
- **[CHANGED 2026-11-17c]** `test-build-snapshot.mjs`: deterministic serialization (same actor -> same bytes), line diff correctness (fold full + diffs == fresh full), full-vs-diff thresholds, the every-8-diffs refresh, unsaved values appear, size caps and cut order, no script bodies or other modules' flags in the output.
- `test-build-secrets.mjs`: a full mocked session with a fake key; scan IndexedDB stand-in, log entries, rendered HTML strings, notification texts: the key never appears.
- `test-build-migrate.mjs`: the id migration with a fake localStorage and fake world storage (copy when default, skip when non-default, never delete old).

### 12.2 Live (lane server, never port 30000)

- Light tests only, one browser, through the slot tool (`node C:/mmwt-ultra/slot.mjs take <name> --any`, give back after) [V memory: feedback_one_measuring_agent]; lane = a copy of world `invincible` with its own pack copies [V memory]. Never touch the user's main world on port 30000 or other worlds.
- Throwaway actors named `ZZ-AIGEN-*`, deleted afterwards; the test players Test Gracz 1/2 exist for the "player sees nothing" check [V memory: project_test_players].
- Mocked-model live pass (no spend): patch `fetch` in the lane browser to the mock server/script, run: open drawer on a ZZ superhero, scripted "build" -> proposal card -> preview diff -> Apply -> sheet shows the hero (powers grouped by source, Health/Resolve = max) -> Undo restores. Same for edit, NPC, gear. **[CHANGED 2026-11-17b]** Per-item checks on a ZZ hero: add one power, raise one level, remove one talent, edit one gear item; every other item id unchanged (id lists compared before/after); the diff shows exactly those ops; per-item Undo restores the removed talent with its old id; a value typed into the sheet and not yet saved appears as an `UNSAVED` line in the next `<sheet_update>` **[CHANGED 2026-11-17c]**. Player check: log in as Test Gracz 1, no button, no api.
- Real-model pass: needs the owner's explicit OK for spend and the owner entering the Anthropic key himself in the lane browser (agents must not type real API keys). Golden prompts (T8): "Złóż mi Spider-Mana" (Global Guardian), same at Teen Upstart, "dodaj mu latanie", "zrób z niego złoczyńcę NPC", "daj mu sieciomiotacz jako sprzęt", an impossible request ("Monstrous power at start") that must be refused with an explanation. Record per prompt: valid on first submit y/n, number of requests, tokens (uncached/write/read/out), cost, cache hit ratio from turn 2, wall time.
- Visual checks (drawer docking on move/resize/minimise/close, flip left, narrow screens, dark/light) by a design agent with screenshots reviewed by the lead.

---------------------------------------------------------------------------------------------------

## 13. Implementation breakdown (one agent per task)

Each task: read this spec + the named sections, write code + node tests, append a dated entry to a handoff log `dev/ai-gen-handoff.md` (create it in T0), commit nothing (the lead commits). Skills to paste into each brief: foundry-vtt-module (all), claude-api (T1, T2, T8), impeccable + design-taste-frontend FULL (T7 and any visual fix).

| # | Task | Sections | Depends on | Output |
|---|---|---|---|---|
| T0 | Rename + id migration + DATA_ROOT split + both-enabled guard + handoff log | 2 | the current enhance agent finished and committed | new folder/id, `migrate-id.mjs`, test-build-migrate |
| T1 | Anthropic transport (pure): streaming request builder with cache layout, SSE parser, errors, pricing | 5.1, 9.1, 11.3 | none (can start now in a scratch branch; files are new) | `build/anthropic.mjs`, `build/pricing.mjs`, tests |
| T2 | Harness loop + caps + session store (IndexedDB) + outside-edit detection + limits/log integration | 5.2-5.4, 11 | T1 | `build/harness.mjs`, `build/session.mjs`, tests (mock model) |
| T3 | Pack registry + interface + dependency check + empty states + self-test hook | 3 | none | `build/registry.mjs`, interface doc in code |
| T4 | Invincible catalogue index + search + get_entries + read_rules; **[CHANGED 2026-11-17c]** `read_document` narrowed to deep fields and other world documents (6 table); measure real index token size with `count_tokens` (free [A]) | 6, 9.2 | T3, T12 | `systems/invincible/catalog-index.mjs`, `rules-digest.mjs` draft |
| T5 | Invincible validation pipeline + proposal <-> state mapping + hints + NPC + gear whitelist; **[CHANGED 2026-11-17b]** ops projection, creation/in-play profiles, per-op cost | 7, 7.5, 10.3 | T3, T11, T12 | `proposal.mjs`, `validate.mjs`, tests |
| T6 | **[CHANGED 2026-11-17b]** Invincible plan/apply/undo: own in-place ops writer for ALL actor types (stable ids, per-item undo journal, lock, unsaved-input guard), replace -> ops conversion, plus-ultra full rebuild only behind its explicit action; pu-bridge delegating superheroes to plus-ultra when present; reader.mjs | 3.2, 3.4, 8, 10.1 | T5, T11 | `systems/invincible/apply.mjs`, `reader.mjs`, `pu-bridge.mjs`, `pack.mjs` |
| T7 | Drawer UI: dock extraction, chat stream, tool chips, proposal card, diff view, apply/undo, usage meter, header buttons (design agent with full skills) | 4 | T2, T3 (can mock the pack) | `build/ui/*`, templates, css |
| T8 | System prompt + tool descriptions + golden prompts + real-model eval (spend only after the owner's OK) | 6, 9, 12.2 | T1-T7 | final prompt text, measured numbers replacing [E] in 9.2 |
| T9 | plus-ultra additions — in the plus-ultra repo, by an agent working there: reverse vendoring check (its check script compares its `rules.mjs`/`state.mjs` with our MANIFEST when the sibling exists), `open(actor, { state })`, `apiVersion`; optional buildItemData | 3.4, 8.3 | T11 | plus-ultra commit (lead) |
| T12 | **[CHANGED 2026-11-17c]** Reader + compact sheet serializer + line diff + full-vs-diff rule (6.0, 5.4): system, prepared values, items with ids, effects, flags, unsaved form values, VALID line; token-size tests on fixtures (assert typical hero <= 2,500 tokens with a local estimator, verify a sample with `count_tokens` in T8); fixtures for T5/T6 | 5.4, 6.0 | T3 | `reader.mjs`, `snapshot.mjs`, fixtures, `test-build-snapshot.mjs` |
| T11 | Vendor `rules.mjs` + `state.mjs` byte-identically with a LETR-style `sync.mjs` (copy, MANIFEST, stamp, `--check`), wire `--check` into our node test runner, no edits to the copies | 3.4 | none | `systems/invincible/vendor/chargen/*` |
| T10 | Adversary review (security: keys, injection, permissions, data loss on apply) on spec + code, then live bughunt on a lane, then fixes by fresh agents | 10, 12 | T1-T8 | `dev/ai-gen-adversary.md`, fixes |

Parallel lanes: T1, T3, T11, then T5 (pure parts) and T9 can start together; T2 after T1; T4 and T6 after T3; T7 after T2+T3 (mocks allowed earlier); T8 last; T0 whenever the enhance agent is done (T1-T7 write new files only, so they rebase cleanly onto the renamed folder).

---------------------------------------------------------------------------------------------------

## 14. Open choices (each has a provisional behaviour that ships unless the owner decides otherwise)

| # | Question | Provisional behaviour |
|---|---|---|
| O1 | "umiejki studnie z zasadami": skills/stunts? | Read as "zgodnie z zasadami"; the system has no skills; abilities = powers/boosts/limits/talents/drawbacks; stunts are explained from rules text, not picked. |
| O2 | v1 scope of actor/item types | superhero + npc + gear/vehicleWeapon; minions, challenge, vehicle, homebrew powers later. |
| O3 | Change the module id? | Yes, `moinens-ai-gen`, with the section-2 migration; fallback: keep `ai-image-gen`, title only. |
| O4 | Players use the builder on their own heroes? | No (GM only). Later: player requests relayed to the GM for approval. |
| O5 | Edits re-create all creation items (plus-ultra destructive replace) | **[CHANGED 2026-11-17b]** REVISED: no longer accepted. All edits go through our in-place ops writer with stable ids (8.4); plus-ultra's replace only behind an explicit "Full rebuild (plus-ultra)" action. |
| O6 | Full rules text in the cached prefix vs index + on-demand | Index + on-demand `get_entries`; revisit with T8 measurements (round trips vs cache write). |
| O7 | Where conversations live | GM browser IndexedDB only; no sync between two GMs/devices. |
| O8 | Rank of a new hero | Drawer selector, default from actor flag, then plus-ultra `chargenRank`, then Global Guardian; the model may suggest another rank but never changes it without the GM. |
| O9 | Portrait after a build | Not automatic; a "Generate portrait" link in the result line opens the existing image dialog with the built appearance text. |
| O10 | Header icon | `fa-solid fa-robot`, distinct from the chargen and image wands. |
| O11 | Cost shown in PLN | USD only in v1 (the module's limits are USD [V]). |
| O12 | Official SDK vs raw fetch | Raw fetch (matches the module, no bundler). |
| O13 | Eager input streaming for tool inputs | Off in v1. |
| O14 | Pre-warm the cache on drawer open | On (client setting), single `max_tokens: 0` request, skipped if a warm entry was written < 55 min ago. |
| O15 | Language of the model's replies / written texts | Replies in the GM's language; item and catalogue names stay English (system is English-only [V: chargen-spec A9]); free texts (appearance, drive, flaw, personality) in the GM's language unless he asks otherwise. |
| O16 | Licensed characters ("Spider-Man") | Allowed (private game); the model writes its own descriptions, never long quotes from other works. |
| O17 | Which drawbacks "if needed" | The model adds drawbacks only when they fit the concept or buy needed points, at most 2 (rules), and explains each in `choiceNotes`. |
| O18 | Model default | `claude-sonnet-5-5`, effort `medium`; GM can switch to `claude-opus-5-5` in settings. |
| O19 | Persist undo for npc/items in a document flag | Yes (24 h), game data only. |
| O20 | plus-ultra: soft dependency (a), full vendoring (b) or hybrid (c) | (c): vendor the pure rules core byte-identically with a sync/check script, own Foundry-side reader/writer, plus-ultra used softly (Invincible only) for superhero apply, archetype/occupation lists and "Open in wizard". |
| O21 | Superhero write paths | **[CHANGED 2026-11-17b]** REVISED: our ops writer is the default for every write (a build on a blank actor included); plus-ultra `apply.apply` only behind "Full rebuild (plus-ultra)" when it is active. Team-base card integration therefore only on that path in v1. |
| O23 | **[CHANGED 2026-11-17b]** Validation profile for edits | `creation` by default; the drawer suggests `in-play` when the current actor already fails the creation budget; one toggle; in-play = no new errors + budget delta as info. |
| O24 | **[CHANGED 2026-11-17b]** Book growth (advancement) rules for in-play edits | Not enforced in v1; the Growth page joins the `read_rules` whitelist so the model can cite it; the GM decides. |
| O25 | **[CHANGED 2026-11-17b]** Karma, current Health/Resolve, conditions | Never written by ops unless the GM asks for that field explicitly in the same message; max values are derived and never written. |
| O26 | **[CHANGED 2026-11-17c]** Sheet in context: full every message vs full once + diffs | Full on the first message, then `<sheet_update>` diffs / `<sheet_unchanged/>`; a fresh full sheet on big drift (> 25 % of lines or > 1,500 tokens) or after 8 diffs (5.4). Alternative if the owner wants it literally: full block every message (simple, ~2.5k extra tokens per message, more duplicate context). |
| O27 | **[CHANGED 2026-11-17c]** Descriptions in the sheet block | Only custom/hand-edited items, cut at 400 chars; catalogue items by `ref` (rules text via `get_entries`). |
| O28 | **[CHANGED 2026-11-17c]** Keep `read_document` | Kept, narrowed to deep fields and other world documents; no longer used to read this sheet. |
| O29 | **[CHANGED 2026-11-17c]** Sheet block size cap | 6,000 tokens; cut custom descriptions first, then fold effects into counts. |
| O22 | Canonical copy of the vendored rules | plus-ultra (the wizard is the primary user); the builder never edits its copy. |

---------------------------------------------------------------------------------------------------

## 15. Verified vs assumed

Verified by reading code/files on 2026-11-17:
- ai-image-gen structure, `MODULE_ID`, client-scope API keys incl. `apiKey.anthropic`, `enhance.model/effort` defaults (`claude-sonnet-5-5`, `medium`), raw-fetch Anthropic client with browser-access header, fallback beta, `ANTHROPIC_VERSION 2026-10-21`, redact covering the Anthropic key, call-log fields and data folder, limits reservations, sheet-button injection selectors, `TestDrawerApp` docking, migrations schema 2, no document flags; GM-only api split in module.mjs; uncommitted work of another agent.
- Dependants on the old id: sketch-reveal (module.json + ai-image.mjs), local-media-optimizer (data prefix only).
- plus-ultra: version 0.20.2; chargen files and exports (rules/state/import/catalog/apply/main), api.chargen members, apply's plan/apply/undo/expect/lock/24 h undo/destructive replace of six item types; migrate-id pattern for an id rename; chargen phases 1-11 DONE per handoff.
- System `invincible` 2.1.8 document types; power/gear/base item schemas; automation types incl. `extraConfiguration` JavaScriptField and `runMacro`; minions Health 10.
- invincible-core 1.0.2 pack list; NPC creation rules and the 30 NPC profiles (from `dev/book-dump.txt`); book section sizes from `dev/book-index.txt`.
- Prompt-caching facts (TTL, prices, 512-token minimum, 4 breakpoints, 20-block lookback, append-only history, forced tool_choice 400) from the claude-api skill (cached 2026-11-03).

- Owner's binding rules (2026-11-17, via the coordinator): plus-ultra is a dependency only on system `invincible`; core works without it everywhere; vendoring is allowed. Reflected in 3.3/3.4.
- Chargen file sizes and import graph (3.4 table), LETR sync/check mechanism (`invincible-plus-ultra/scripts/letters/sync.mjs`), plus-ultra stores no book text in code (tables generated at runtime into a gitignored pack).

- **[CHANGED 2026-11-17b]** Invincible actor and item sheets use `submitOnChange: true` (`system/sheets/actor-sheet.mjs:34`, `item-sheet.mjs:41`).

Assumed / not verified (each needs a check in its task):
- **[CHANGED 2026-11-17c]** All sheet-block sizes and the diff thresholds (estimates; T12 measures with a local estimator, T8 with `count_tokens`).
- **[CHANGED 2026-11-17b]** `FormDataExtended` class path in v14 for reading live sheet input; per-item fingerprint via `_stats.modifiedTime`; `keepId` restore of a deleted embedded item from our undo journal (plus-ultra uses the technique, not re-tested here); level-document swap for split-level powers keeping boosts/limits linked.
- `relationships.recommends` behaviour in v14; `game.settings.storage.get("world").getSetting` for keys of an uninstalled module (works in plus-ultra's migration, not re-tested here); localStorage key format for client settings in v14 (taken from plus-ultra's comment).
- That a plus-ultra-free Invincible world gets usable archetype/occupation material from `read_rules` alone (quality of builds without plus-ultra; measure in T8).
- DataModel `validate({strict})` call shape for throwaway item validation in v14.
- All token sizes and costs in 9.2 (estimates; T4/T8 measure).
- CORS for streaming SSE from the browser with the direct-access header (non-streaming works per the enhance feature's design; streaming not yet exercised in this module).
- That `count_tokens` is free of charge for measuring the prefix.
- Behaviour of the drawer next to sheets other than `InvincibleActorSheet` (item sheets, npc sheet class) — plus-ultra verified only the superhero sheet header.
