# Moinens AI Gen (Foundry VTT v14)

Formerly **AI Image Gen** (module id `ai-image-gen`); the id is now `moinens-ai-gen`. See "Rename from ai-image-gen" below.

Generate images for actors, items and macros with OpenAI, Gemini or OpenRouter, in "Now" (sync) or batch mode (up to 24 h, about half price).
Per image type (system + document + subtype) you configure the model, size, quality, prompt template and
reference images. The plan and status live in [PLAN.md](PLAN.md).

## API for other modules

`game.modules.get("moinens-ai-gen").api` (GM only for anything that spends money; `apiVersion: 1`). Modules that start
earlier than this one can wait for the `aiImageGen.ready` hook (it passes the API; the hook names `aiImageGen.*` were kept
on purpose). `api.build` (AI builder) is attached later, after that hook: wait for `moinensAiGen.harnessReady` (passes
`api.build`) or `moinensAiGen.packReady`. A module with its own system pack registers it from the
`moinensAiGen.registerPacks` hook (GM only, fired once right before the bundled pack loads; it passes
`{ registerSystemPack, contractVersion }`); a pack registered later only fills a system that has no bundled pack.
Modules that should also work with the old id look it up as
`game.modules.get("moinens-ai-gen") ?? game.modules.get("ai-image-gen")` (take the one that is active and has an `api`).

- `registerImageType({ key, label, group, owner, requiresRef?, defaults? })`: adds an image type of your own
  (key `<your-module-id>.<name>`; it must not look like a document type). It appears in the config window under its own
  group with the usual provider, model, size, quality, prompt and reference settings. `defaults` is the starting
  configuration: `promptTemplate`, `width`, `height`, `refs`, `quality`, `provider`, `model` and
  `output: { maxEdge, format, quality }`. Registrations live in memory: register again at every start.
  `unregisterImageType(key)` removes it, `listImageTypes()` lists everything.
- `estimateGeneration({ typeKey, count?, refsCount?, width?, height?, aspectRatio? })`: estimated cost, model, size,
  whether a key is set, whether the type needs a reference. No network call.
- `generateImage({ typeKey, description?, name?, refs?, width?, height?, aspectRatio?, count?, pick?, saveTo?, output?, caller?, signal?, title? })`
  → `{ paths, path, cost, candidates, failed, prompt, picked }`. It uses the same core as "Now" mode (budget
  reservation and limits, the call log with a `caller` column, optimization on save, `optimized: true` uploads) and
  never touches a document. `refs` are extra reference images for this call (Blobs or Data paths) on top of the type's own.
  `saveTo: { dir, name }` chooses the folder inside Data and the file name stem; `output: { maxEdge, quality, format }`
  overrides the saved-file settings. With `pick: true` the picker window opens and the promise resolves with the chosen
  version (rejects with `Error("cancelled")` if the window is closed without choosing).

## AI Tile (change a part of the map)

GM only. Left toolbar → **Moinens AI Gen** → **AI Tile** (square icon).

1. Drag a rectangle on the map (right-drag pans, the wheel zooms). Drag a corner or the whole rectangle to adjust,
   Esc cancels, Enter or **Next** opens the window.
2. The window shows the ONE picture that is sent: the map around the rectangle (by default twice as wide and twice as
   high around the same centre, **Surroundings** 1.5× / 2× / 3×; cut at the canvas edge, so there the rectangle is not
   in the middle), fitted to a size the model returns, with a red frame drawn just outside the rectangle. No mask and
   no second picture are sent. Write what should change, pick the number of versions, Now or Batch, the soft edge (px,
   fades the tile's border inwards) and whether tokens appear in the picture. The window shows the sent size, the
   estimated input tokens (OpenAI) and the estimated cost.
3. The model is asked to edit only inside the red frame, keep everything else and the framing, and remove the frame.
   From the whole returned picture exactly the rectangle is cut out (its position in the picture is known), scaled to
   the tile and given the soft edge. **Now**: the versions appear in a window and the selected one is previewed on the
   map in place of the rectangle; **Accept and paste** saves it to `ai-image-gen/tiles/<scene>/` and creates a Tile
   exactly over the rectangle (rotation 0, elevation 0, above the other tiles of that elevation, below tokens).
   **Again** asks for more versions with the same picture, **Discard** drops them (nothing saved). **Batch** sends the
   same single picture; the tile is pasted on the same scene when the result arrives (several versions: the usual
   "ready to pick" notification opens the versions window).

Known limit: an object lying across the red frame may be changed only partly (the part inside the rectangle), and the
pasted tile then cuts it at the rectangle's edge; draw the rectangle around whole objects. The size limit of the type
caps the sent picture: with the default 2048 px and 2× surroundings, a rectangle wider than about 1000 scene px is sent
slightly below its native resolution (raise the limit in the type for more pixels, at a higher cost).

Model, quality, size limit (the longer side of the request), the prompt template (fields `{description}`, `{grid}`,
`{distance}`, `{units}`, `{scene}`, `{pos}`) and output are set in the settings window under the type **AI Tile**. A
saved template equal to the earlier default (two pictures) is replaced by the new default on load; edited templates
are kept. Lighting, fog, weather and overhead tiles never go into the picture. Only rectangles for now. The
single-picture method was checked by the owner with gpt-image-2.6-flare (medium): framing and scale kept, edit only
inside the frame, frame removed; Gemini / OpenRouter and Batch have not been checked with real calls.
## Privacy & limits

These are properties of Foundry itself, not something the module can work around:

- **Files under `Data/` are public to anyone who knows the URL.** Foundry serves the user Data folder
  without a login. That includes `ai-image-gen/_log/*.json` (the data folder keeps its old name after the rename) (your prompts, descriptions, document names and
  costs), `_refs/` (reference images), `_candidates/` (batch results waiting for a pick) and `_tests/`.
  Nobody can list them, but a guessed or leaked address works. Do not put anything in a prompt or reference
  that must stay secret from people who can reach your server.
- **World settings are readable by every player.** `game.settings.get` returns them to all clients. The
  module keeps image-type configuration (prompt templates, reference paths), the usage counters, the limits
  and the batch records (including prompt-related metadata and error texts) in world settings. Only GMs
  can change them through the module, but players can read them. Error texts are masked for keys and tokens.
- **API keys are per-client** (client settings): stored in the browser that typed them, never synced, never
  written to the log, never sent to players. Anyone with access to that browser profile can read them.
  They are entered in Configure Settings -> Moinens AI Gen -> **API keys (this browser)** (GM only, masked inputs);
  they are not plain fields of the settings window, because Foundry v14 shows client settings to players too.
- **Foundry has no API to delete files.** Unused batch candidates, replaced references and test examples stay
  on disk until you delete them in the file browser or on the server.
- **Budget limits are best-effort.** A limit of `0` means *no limit*. The daily/monthly counters add the
  real cost after a result arrives; batches that are still running are only estimated.
- **Provider side:** OpenAI batch input and result files are deleted after a finished batch (best effort).
  Gemini result files expire on their own. Check the provider's own retention policy for prompts and
  reference images you send.

## Transparent background
OpenAI `gpt-image-2.6-flare` / `-sunburst` and `gpt-image-2.5-flare` / `-sunburst` get a "Transparent background"
switch (for 2.6 not yet checked against the live API) in the type's settings and a one-off checkbox in the generate dialog. The request carries `background: "transparent"`
with PNG output; the saved file is WebP or PNG (JPEG has no alpha, so it is switched to WebP). Gemini and OpenRouter models have
no switch because no native alpha is documented.

## Models
OpenAI is limited to `gpt-image-2.6-flare` (default), `gpt-image-2.6-sunburst`, `gpt-image-2.5-flare` and `-sunburst`; older
GPT Image models (1, 1-mini, 1.5, 2) are no longer offered, also on OpenRouter (where `openai/gpt-image-2.6-*` are listed too).
The default only applies to types with no saved settings: a type you saved keeps the model you chose. GPT Image 2.6 has **no
Batch API** (OpenAI model pages), so Batch is off for it; 2.5 keeps Batch at half price and is about 4× cheaper at low/medium.
A type saved with an old model keeps all its other settings: it runs on the default Flare (size and quality are fitted) and the
editor says so until you save the type again. Old entries in the call log keep their model names.

## Enhance a description with Claude (wand)
The magic-wand button next to the description (the "Generate image" dialog and the test drawer's sample description)
sends what you typed to Anthropic's Messages API and replaces the text with a richer appearance description in the same
language (e.g. "młody superbohater" becomes a paragraph about build, costume, pose, light and background). The arrow
button (or Ctrl+Z) restores the text from before; Ctrl+Enter in the field runs the wand. It needs its own **Anthropic API
key** (client setting, like the other keys). The model (`claude-sonnet-5-5` by default) and the reasoning effort
(`medium` by default) are world settings. The call goes straight from the GM's browser (`anthropic-dangerous-direct-browser-access`);
it is not written to the call log and does not count towards the image budget limits. The system prompt lives in
`scripts/enhance/anthropic.mjs`; tests with a mocked fetch: `node dev/test-enhance.mjs`. Open choices: `dev/enhance-notes.md`.

## Rename from ai-image-gen
The module id changed from `ai-image-gen` to `moinens-ai-gen` (title "Moinens AI Gen"). Foundry requires the module
folder to carry the id, so the folder is `Data/modules/moinens-ai-gen`.

- **Settings are copied once, old values are never deleted.** On its first start without the old module, each GM browser
  copies its own API keys (OpenAI, Gemini, OpenRouter, Anthropic) from `localStorage` to `localStorage` (they never leave
  that browser), plus the generate-dialog preferences and the test-drawer samples. The first GM in a world copies the
  world settings: limits, optimization switch, Claude model/effort, usage counters, image-type configuration, schema and
  every batch slot. A value is copied only while the new setting has never been stored in the new namespace, so a later
  re-run never overwrites newer values and never brings back a batch that was already collected and removed.
  Code: `scripts/migrate-id.mjs`, tests: `node dev/test-migrate-id.mjs`.
- **Going back to the old module is not a clean undo.** Re-enabling `ai-image-gen` brings back its old *settings*, but it
  does not know what Moinens AI Gen did in the meantime. Batches that were still running at the copy are still "pending"
  there: the old module would collect them a second time (the document image replaced again, duplicate files, usage and
  log counted twice) as soon as it starts; nothing guards against that. Switch back only if no batch was running when
  Moinens AI Gen first started (its batch window lists the copied ones), or check those documents' images afterwards.
- **Server started before the rename:** if the running Foundry server still knows the package as `ai-image-gen`, the
  module stays idle and tells the GM to restart Foundry (it does not ask to disable "the old module", which would be itself).
- **Images stay where they are.** The data folder is still `Data/ai-image-gen/` (`DATA_ROOT` in `scripts/constants.mjs`),
  so existing actor/item images, the call log, references, test samples and batch candidates keep working.
- **Hooks keep their names** (`aiImageGen.ready`, `aiImageGen.batchUpdate`, `aiImageGen.logUpdate`).
- **Both enabled at once:** if the old `ai-image-gen` is still active, Moinens AI Gen stays idle (no API, no batch poller,
  no buttons, no copy) and shows one GM warning, so a batch is never collected twice.
