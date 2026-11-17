# Bughunt 2: UI and Foundry integration (drawer, settings, sheet/header wiring, old image-gen UI)

Date 2026-11-17. Code: HEAD `3130e1b` (live folder, clean tree). Read-only review plus one LIGHT live check on lane 20
(http://localhost:30020, world `invincible`, GM and Test Gracz 1, own tab, world restored from the reference afterwards,
slot given back). No API key, no Anthropic network, no downloads. Nothing in the module was edited.

Scope: `scripts/module.mjs`, `scripts/build/drawer-app.mjs`, `drawer-model.mjs`, `registry.mjs`, `builder-api.mjs`,
`build-settings.mjs`, `templates/builder-drawer.hbs`, `styles/builder-drawer.css`, `lang/en.json` + `pl.json`, `module.json`,
`scripts/settings.mjs`, `migrate-id.mjs`, `sheet-button.mjs` (wand), `context-menu.mjs`, `log-app.mjs` + `templates/log.hbs`.

Severity: **M** = medium (wrong behaviour a GM will meet), **L** = low (edge case, polish, a11y), **I** = info.
No high-severity bug found. Verified = seen live on lane 20 or by running the code; unverified = from reading only.

## Ranked findings

### 1. M: API key fields are plain text inputs, and players see them (and the pre-warm setting) in Configure Settings
- Where: `scripts/settings.mjs:14-33` (`apiKey.openai|gemini|openrouter|anthropic`, `scope: "client"`, `config: true`,
  `restricted: true`), `scripts/build/build-settings.mjs:60-63` (`build.prewarm`, client, config).
- Why: in v14 `restricted` does nothing for settings. `SettingsConfig` hides only WORLD-scope settings from non-GMs
  (`resources/app/client/applications/settings/config.mjs:73`, `const restricted = setting.scope === WORLD`). A
  `StringField` renders as `<input type="text">`.
- Repro (verified): log in as Test Gracz 1, open Configure Settings: the "Moinens AI Gen [5]" category lists OpenAI,
  Gemini, OpenRouter, Anthropic API key (all `type="text"`) and "AI builder: pre-warm the prompt cache". The hints say
  "never shared with players", which reads wrong to a player who sees the fields. As GM the four keys are shown in clear
  text (screen sharing / streaming leaks them).
- Fix: register the four keys and `build.prewarm` with `config: false` and edit them in the module's own GM-only config
  window (ImageConfigApp already exists) with `<input type="password" autocomplete="off">`; or keep `config: true` and on
  `renderSettingsConfig` remove the rows for non-GMs and set `type="password"` on the key inputs. Also update
  `AIIMG.Settings.ApiKey.anthropic.Name` ("description enhancer"): the AI builder uses the same key now.

### 2. M: the GM's message is lost when the send is refused before the turn (no key, no pack, limit, history full)
- Where: `scripts/build/drawer-app.mjs:466-477` (`#send`): `this.#draft = ""` and `ta.value = ""` run BEFORE
  `await s.send(text)`; the harness's early returns (`harness.mjs:491-494`, `early("no-key")` etc.) add only a notice.
- Repro (verified, lane 20, no key): type a message, press Enter: the textarea empties, the log shows only the notice
  "No Anthropic API key...", `session.transcript()` has no `gm` item. The text is gone; the GM must retype it after
  entering the key.
- Fix: clear the draft only when `send` started a turn (e.g. `const r = await s.send(text)`; restore `#draft` when
  `r?.ok === false && r.early`/no `user-message` event came), or keep the draft until the `user-message` event arrives.

### 3. M: open `<details>` sections collapse on every partial render (tool chips during a turn, info / re-order lists on the card)
- Where: `templates/builder-drawer.hbs:46` (`details.maig-tools`), `:77` (`details.maig-ops open`), `:84` and `:86`
  (`details.maig-issues is-info`); render batching `drawer-app.mjs:322-331`.
- Why: every part render replaces the part's DOM. The log part re-renders on every stream/tool event (up to every 80 ms
  during a turn), the card part on every actor/item update (`drawer-app.mjs:361-367`) and on every preview finish.
  The open state of `<details>` is not kept: an expanded tool group closes within 80 ms while the AI works; an expanded
  "info" / "re-orders" list on the card closes whenever anything on the actor changes (another user's HP edit is enough);
  a collapsed "operations" list pops open again.
- Fix: keep a `Set` of open detail keys (e.g. `data-key="tools-<index>"`, `"card-info"`) updated on `toggle`, and emit
  `open` from the context; or restore in `_onRender` before the replace (`_preSyncPartState`/`_syncPartState` in v14).
- Unverified live (needs a running turn; dry mode not used in this hunt), certain from the code.

### 4. M: composer re-renders during a turn reset the textarea (caret jumps to the end, manual height lost, IME broken)
- Where: `drawer-app.mjs:272, 283, 291, 307, 315` queue `"composer"` on request-start / request-end / tool-start / state;
  `#wireComposer` (`:384-398`) re-creates the textarea, sets `value = #draft` and puts the caret at the END.
- Effect: a GM drafting the next message while the AI works loses the caret position (typing in the middle continues at the
  end), a resized textarea snaps back to `rows=2`, and an IME composition (`isComposing`) is cut. The composer only needs
  the send/stop swap and the usage line.
- Fix: render the usage line and the send/stop button outside the textarea's part (e.g. split `composer` into `input` and
  `meta` parts, or update the button/usage via DOM in `#onEvent`), and never re-render the part that holds the textarea while
  it has focus; at least save/restore `selectionStart/End` and `style.height`.
- Unverified live (needs a running turn), certain from the code.

### 5. L: the drawer's theme follows the interface, not the sheet next to it
- Where: `styles/builder-drawer.css:44` (`body.theme-dark .maig-drawer, .maig-drawer.theme-dark`); nothing ever adds
  `theme-dark`/`theme-light` to the drawer (`drawer-app.mjs:424-439` copies z-index only).
- Repro (verified, screenshot): lane 20 body has `theme-dark`; the Invincible sheet (no `themed` class, paper/comic look)
  gets a dark drawer glued to it. The CSS header comment says the drawer follows the sheet's paper tone. A sheet with a
  per-document theme (`DocumentSheetConfig` theme -> `themed theme-light|dark` on the sheet, `document-sheet.mjs:143`)
  is not followed either.
- Fix: in `dock()` (or `_onRender`) copy the sheet's theme: `const t = sh.classList.contains("theme-dark") ? "dark" :
  sh.classList.contains("theme-light") ? "light" : <system default for unthemed sheets>`; toggle `themed theme-*` on the
  drawer and scope the dark tokens to `.maig-drawer.theme-dark` only. Decide which tone an unthemed Invincible sheet gets
  (the sheet is always light paper, so light is the natural pick).

### 6. L: a failed `ready()` leaves a dead drawer in the map; the click rejects unhandled
- Where: `drawer-app.mjs:71-80` (`openFor`: `drawers.set` before `await d.ready()`), `:139-149` (`#readyP` caches the
  rejected promise), `:637` (`toggleFor(sheet)` not awaited / caught in the header click), `:700` (3-dot entry, same).
- Repro (from code): `canUse` checks only the registry (`:29-33`); when the harness import failed or `openSession` throws
  (IndexedDB error), click 1 throws an unhandled rejection and leaves an unrendered drawer in `drawers` with
  `isOpen = true`; click 2 hits `setOpen(false)` (closes the dead one, nothing visible); click 3 tries again. The button
  shows `aria-pressed` wrongly in between.
- Fix: in `openFor` wrap `ready()`/`render()` in try/catch; on failure `drawers.delete(sheet.id)`, `d.close()`, notify
  once (`ui.notifications.error`), and catch in the click handler (`toggleFor(sheet).catch(...)`). `canUse` could also
  require `build()?.openSession`.

### 7. L: docking leaves the composer off-screen for a sheet near the bottom; on narrow windows it covers the sheet
- Where: `scripts/build/drawer-model.mjs:30-31`: `height = max(minHeight 160, min(rect.height - 38, view.height - top))`;
  `:20-29` shrink path.
- Repro (by the function): sheet top at 700 px in a 768 px window -> `top = 738`, `height = 160`, bottom at 898: the input
  row is below the window and cannot be reached (the drawer is `position: fixed`, the window does not scroll). With no
  300 px free on either side (e.g. 1024 px window, 720 px sheet at x=0) the drawer is clamped onto the sheet and covers its
  right column (tabs) - acceptable as a fallback, but there is no way to move it.
- Fix: when `view.height - top < minHeight`, move the drawer up (`top = max(0, view.height - minHeight)`) instead of
  overflowing; optionally a "dock below/beside" fallback.

### 8. L: duplicate element ids with two drawers open
- Where: `templates/builder-drawer.hbs:104` + `:112` (`aria-describedby="maig-keys"` / `id="maig-keys"`), `:64/:66`
  (`maig-card-title-{{card.id}}`, duplicated when the same actor's card shows in two drawers, e.g. actor + token sheet).
- Repro (verified): two sheets (two actors) with drawers open -> `#maig-keys` twice in the DOM; the second textarea's
  description points at the first drawer's text.
- Fix: prefix ids with the app id (`{{appId}}-keys`, pass `this.id` in the context).

### 9. L: accessibility of the drawer landmark and the live log
- `drawer-app.mjs:48` renders `<aside>` with no accessible name (verified: no `aria-label`/`aria-labelledby`); give it
  `aria-labelledby` -> the `h2` title (needs an id, see 8).
- `hbs:30` `role="log" aria-live="polite"` sits on the part root that is REPLACED on every render, so screen readers
  either announce nothing (new live region) or re-read everything. Put the live region on a stable wrapper outside the
  re-rendered part, or announce only new rows via a separate visually-hidden status element.
- Esc: the drawer's pointerdown brings the SHEET to front (`:368`), so Esc (outside the textarea) closes the whole sheet
  and the drawer with it; there is no key that closes only the drawer. Consider handling `keydown Escape` on the drawer
  root -> `setOpen(false)` and focus back to the header button (as `#onCollapse` does).

### 10. L: `registerSystemPack` "before ready takes precedence" can never happen
- Where: `registry.mjs:44-47` (contract text), `:229-239`; `module.mjs:89` (`startBuildRegistry` runs in `ready`, after the
  `await migrateFromAiImageGen()`, and calls `registry.load()` at once).
- Why: `api.build.registerSystemPack` exists only after that import resolves, and `load()` has already started, so for the
  bundled system (invincible) an external pack always gets `{ ok: false, reason: "loading" }` (or `pack-already-active`).
  It works only for systems without a bundled pack (verified with a mock game: status `none` -> `activated`).
  Also `Hooks.callAll("aiImageGen.ready", api)` (`module.mjs:93`) fires BEFORE the three dynamic imports attach
  `api.build`, so a listener of that hook never sees `api.build` (there is `moinensAiGen.packReady` / `harnessReady`, but
  they are not documented next to `aiImageGen.ready`).
- Fix: either drop the precedence promise from the contract, or create the registry synchronously at `init`/`setup`
  (expose `registerSystemPack` early) and call `load()` in `ready`. Document `moinensAiGen.harnessReady` as the hook to wait
  for `api.build`.

### 11. L: call log cannot filter builder calls; kind labels fall back to raw ids
- Where: `scripts/log-app.mjs:9` `KINDS = ["fast","test","batch-submit","batch-result","limit-blocked"]`; the builder logs
  `kind: "build"` and `"build-prewarm"` (`harness.mjs:418, 566, 740`); `lang/en.json` has no `AIIMG.Log.Kind.build*`, so
  `loc()` shows `build` / `build-prewarm` in the table (`log-app.mjs:12, 136`).
- Fix: add both kinds to `KINDS` and `AIIMG.Log.Kind.build` / `build-prewarm` to en.json and pl.json.

### 12. L: module.json points updates at the OLD package
- Where: `module.json:34-38` (`url`, `bugs`, `readme`, `manifest`, `download` all on `Hexnen/ai-image-gen`).
- Effect: "Check for updates" fetches the old repo's manifest (id `ai-image-gen`); Foundry refuses the id mismatch, or
  worse offers the old package. No `relationships` block: fine for the soft design (the pack checks `invincible-core` and
  plus-ultra at runtime), but `relationships.recommends` for `invincible-core` (with `systems: invincible`) would show the
  need in the package manager.
- Fix: new repo URLs (or remove `manifest`/`download` for a private module); optional `relationships`.

### 13. L: 3-dot menu entry always reads "AI builder" (no open/close state)
- `drawer-app.mjs:700`: the header-controls entry toggles but its label is the static `MAIG.Drawer.Open`; the header button
  carries the state (W5-E), the menu entry does not. Minor: compute `label` from `drawers.get(app.id)?.isOpen`
  (`getHeaderControls` runs on each open of the menu).

### 14. L (unverified, not reproduced): a drawer could outlive its sheet if the sheet closes while `openFor` awaits
- `openFor` (`:71-80`) awaits `ready()` then `render({force:true})`. If the sheet's `closeApplicationV2` fires in between,
  `d.close()` runs on a not-yet-rendered app (no `_onClose`), then `render` brings it up: hooks, observers and the session
  subscription are attached to a drawer whose sheet is gone and which is no longer in `drawers` (never closed again).
- Live: click + immediate `sheet.close()` did NOT reproduce (the in-memory session resolves first). Guard anyway: after
  `await d.ready()`, `if (!sheet.rendered || drawers.get(sheet.id) !== d) { d.close(); return null; }`.

### 15. I: lane servers serve a stale module manifest
- On lane 20 `game.modules.get("moinens-ai-gen").styles` lists only `module.css`; `builder-drawer.css` was injected by the
  fallback in `startDrawer` (`drawer-app.mjs:687-693`, verified it works). A lane restart picks up the manifest. Not a code
  bug; note for live checks that compare stylesheet loading.

## Checked and found OK

- **Lang keys** (script, both directions, incl. dynamic prefixes): every `MAIG.*`/`AIIMG.*` key used in scripts/templates
  exists in en.json AND pl.json or in the built-in tables (`harness-lang.mjs`, `registry-lang.mjs`); en/pl have the same key
  set; placeholders match. Dynamic families checked: `Drawer.Mode.*` (superhero/npc/gear/vehicleWeapon), `State.*`,
  `Event.*` (pending/applied/discarded = `PROPOSAL_STATUSES`), `Profile.*`, `Role.*`, `Confirm.*`, `Result.*`,
  `Undo.drift.*`, `Settings.Build.Effort.*`, `AIIMG.Settings.ApiKey.*`. Unused in en/pl (dead keys): `AIIMG.Batches.CostReal`,
  `AIIMG.Batches.CostEstimate`, `AIIMG.Gen.PromptTplConfig`, `AIIMG.Gen.PromptTplDefault`, `AIIMG.Gen.PromptRefs`.
- **XSS** (verified): actor named `<img src=x onerror=...> & "q"` - sheet title, drawer, notifications: escaped, no
  execution. GM text `<img onerror>`, `**<b>**`, `- <script>`, `**a" onmouseover="x**`, `1. <a href=javascript:>`:
  `renderText` escapes first, only `p/strong/ul/ol/li/br` survive. All other drawer strings go through `{{ }}`; confirm
  dialog items/lead escaped (`drawer-app.mjs:606-607`); `notifyPick` escapes the name (notifications do not double-escape
  without `format`). Log table: all `{{ }}`.
- **Player** (verified, Test Gracz 1 owning a supported actor): no header button, no wand, no 3-dot entry, no scene-control
  group, `api` = `{apiVersion, registerImageType, unregisterImageType}` only; importing `drawer-app.mjs` by hand:
  `canUse` false, `openFor` null; `startBuildRegistry` returns null; no builder CSS link. Only finding 1 leaks UI.
- **GM load, invincible world with plus-ultra** (verified): no module errors at init/setup/ready (only canvas errors from
  the hidden browser pane); pack `ready`, `check.ok`.
- **Invincible world WITHOUT plus-ultra** (verified, plus-ultra disabled + reload): pack `ready`, `check.ok`, optional
  plus-ultra `usable: false`, ranks still listed, drawer opens, no errors. module.json has no hard dependency.
- **Different system**: no world of another system on lane 20, so not run live. From code + mock: `BUNDLED_PACKS` has only
  `invincible`; registry status `none`, `supports()` null, `canUse` false -> no button/drawer; the drawer/header hooks still
  register but return at once.
- **Lifecycle / leaks** (verified): hook counts (`renderApplicationV2`, `closeApplicationV2`, `updateActor`, `createItem`,
  `updateItem`, `deleteItem`) return to the baseline after closing the drawer, after 6 rapid header clicks, and after closing
  the sheet with the drawer open; `drawers` map and `BuilderDrawer` instances back to 0; no `.maig-drawer` left in the DOM.
  Two sheets of different actors -> two drawers, independent. 20 back-to-back sheet renders -> one header button, same drawer
  instance, still open, no errors. Actor update with the drawer open -> no errors.
- **Settings migration** from `ai-image-gen` (`migrate-id.mjs`): read-only copy, never overwrites a stored new key,
  batch slots de-duplicated by id, flags per client/world; the build.* settings are new-only (correctly not in the lists).
  Not exercised live (the lane world has no `ai-image-gen` installed).

## Not covered
- A real/dry turn in the drawer (findings 3 and 4 are from the code only); light-theme screenshot; PL interface live; a
  world on another system live.
