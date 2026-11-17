// Module id (settings namespace, templates path, API) — the module was called "AI Image Gen" with id "ai-image-gen".
export const MODULE_ID = "moinens-ai-gen";
// Old id: read-only source of the one-time settings copy (migrate-id.mjs) and the "both enabled" guard (module.mjs).
export const OLD_MODULE_ID = "ai-image-gen";
// Folder under Data/ for images, _log, _refs, _tests, _candidates. Deliberately the OLD name: existing documents' img paths
// point there, Foundry cannot move files, and the local-media-optimizer profile matches this prefix. Never derive it from MODULE_ID.
export const DATA_ROOT = "ai-image-gen";
export const PROVIDER_IDS = ["openai", "gemini", "openrouter"];
// Hidden flags of the one-time copy from OLD_MODULE_ID (migrate-id.mjs): per GM browser (client) and per world.
export const MIGRATED_CLIENT = "migratedFromAiImageGen";
export const MIGRATED_WORLD = "migratedFromAiImageGenWorld";
