# AI Image Gen (Foundry VTT v14)

Generate images for actors, items and macros with OpenAI, Gemini or OpenRouter, in fast (sync) or batch mode.
Per image type (system + document + subtype) you configure the model, size, quality, prompt template and
reference images. The plan and status live in [PLAN.md](PLAN.md).

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
