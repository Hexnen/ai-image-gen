# AI Image Gen (Foundry VTT v14)

Generate images for actors, items and macros with OpenAI, Gemini or OpenRouter, in "Now" (sync) or batch mode (up to 24 h, about half price).
Per image type (system + document + subtype) you configure the model, size, quality, prompt template and
reference images. The plan and status live in [PLAN.md](PLAN.md).

## API for other modules

`game.modules.get("ai-image-gen").api` (GM only for anything that spends money; `apiVersion: 1`). Modules that start
earlier than this one can wait for the `aiImageGen.ready` hook (it passes the API).

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

## Privacy & limits

These are properties of Foundry itself, not something the module can work around:

- **Files under `Data/` are public to anyone who knows the URL.** Foundry serves the user Data folder
  without a login. That includes `ai-image-gen/_log/*.json` (your prompts, descriptions, document names and
  costs), `_refs/` (reference images), `_candidates/` (batch results waiting for a pick) and `_tests/`.
  Nobody can list them, but a guessed or leaked address works. Do not put anything in a prompt or reference
  that must stay secret from people who can reach your server.
- **World settings are readable by every player.** `game.settings.get` returns them to all clients. The
  module keeps image-type configuration (prompt templates, reference paths), the usage counters, the limits
  and the batch records (including prompt-related metadata and error texts) in world settings. Only GMs
  can change them through the module, but players can read them. Error texts are masked for keys and tokens.
- **API keys are per-client** (client settings): stored in the browser that typed them, never synced, never
  written to the log, never sent to players. Anyone with access to that browser profile can read them.
- **Foundry has no API to delete files.** Unused batch candidates, replaced references and test examples stay
  on disk until you delete them in the file browser or on the server.
- **Budget limits are best-effort.** A limit of `0` means *no limit*. The daily/monthly counters add the
  real cost after a result arrives; batches that are still running are only estimated.
- **Provider side:** OpenAI batch input and result files are deleted after a finished batch (best effort).
  Gemini result files expire on their own. Check the provider's own retention policy for prompts and
  reference images you send.

## Transparent background
OpenAI `gpt-image-2.5-flare` / `-sunburst` get a "Transparent background"
switch in the type's settings and a one-off checkbox in the generate dialog. The request carries `background: "transparent"`
with PNG output; the saved file is WebP or PNG (JPEG has no alpha, so it is switched to WebP). Gemini and OpenRouter models have
no switch because no native alpha is documented.

## Models
OpenAI is limited to `gpt-image-2.5-flare` (default) and `-sunburst`; older GPT Image models (1, 1-mini, 1.5, 2) are no longer
offered, also on OpenRouter. A type saved with an old model keeps all its other settings: it runs on Flare (size and quality are
fitted to 2.5) and the editor says so until you save the type again. Old entries in the call log keep their model names.
