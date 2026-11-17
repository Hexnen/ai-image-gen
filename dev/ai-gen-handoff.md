# Moinens AI Gen: dziennik przekazania (spec `dev/ai-gen-spec.md`, sekcja 13)

## 2026-11-17 T0: zmiana nazwy + migracja id
- `module.json`: id `moinens-ai-gen`, tytuł „Moinens AI Gen” (adresy repo bez zmian). Folder na dysku NIE zmieniony: zob. `dev/rename-notes.md` (kroki właściciela).
- `scripts/constants.mjs`: `MODULE_ID = "moinens-ai-gen"`, `OLD_MODULE_ID = "ai-image-gen"`, `DATA_ROOT = "ai-image-gen"` (ścieżki danych tylko z `DATA_ROOT`).
- `scripts/migrate-id.mjs`: jednorazowa kopia ze starego id (wzorzec plus-ultra), wołana w `ready` przed `runMigrations()`; `module.mjs`: tryb bezczynny, gdy stary moduł aktywny.
- Testy: `node dev/test-migrate-id.mjs` (kopia, nienaruszalność starych wartości, schemat 1->2, kontrole statyczne repo), `node dev/test-enhance.mjs`.
- Nowe pliki builder-a (T1-T7) używają `MODULE_ID` z `constants.mjs`; ścieżek w `Data/` nigdy z `MODULE_ID`, tylko `DATA_ROOT`.
- sketch-reveal: szuka `moinens-ai-gen`, potem `ai-image-gen` (aktywny i z `api`), relacja `recommends` na nowe id.
