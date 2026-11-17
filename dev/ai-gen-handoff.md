# Moinens AI Gen: dziennik przekazania (spec `dev/ai-gen-spec.md`, sekcja 13)

## 2026-11-17 T0: zmiana nazwy + migracja id
- `module.json`: id `moinens-ai-gen`, tytuł „Moinens AI Gen” (adresy repo bez zmian). Folder na dysku NIE zmieniony: zob. `dev/rename-notes.md` (kroki właściciela).
- `scripts/constants.mjs`: `MODULE_ID = "moinens-ai-gen"`, `OLD_MODULE_ID = "ai-image-gen"`, `DATA_ROOT = "ai-image-gen"` (ścieżki danych tylko z `DATA_ROOT`).
- `scripts/migrate-id.mjs`: jednorazowa kopia ze starego id (wzorzec plus-ultra), wołana w `ready` przed `runMigrations()`; `module.mjs`: tryb bezczynny, gdy stary moduł aktywny.
- Testy: `node dev/test-migrate-id.mjs` (kopia, nienaruszalność starych wartości, schemat 1->2, kontrole statyczne repo), `node dev/test-enhance.mjs`.
- Nowe pliki builder-a (T1-T7) używają `MODULE_ID` z `constants.mjs`; ścieżek w `Data/` nigdy z `MODULE_ID`, tylko `DATA_ROOT`.
- sketch-reveal: szuka `moinens-ai-gen`, potem `ai-image-gen` (aktywny i z `api`), relacja `recommends` na nowe id.

## 2026-11-17 T3: rejestr pakietów systemowych
- `scripts/build/registry.mjs` (kontrakt pakietu w nagłówku, dynamiczny import tylko dla `game.system.id`, tylko MG, `api.build`, `emptyState`, `ensureSelfTest`, hook `moinensAiGen.packReady`), `deps.mjs`, `registry-lang.mjs`; `scripts/systems/invincible/pack.mjs` (szkielet: `check` + `supports`; grupy prompt/validate/sheet/writer dopisują T4/T5/T12/T6), `scripts/systems/_stub/pack.mjs` (mock pełnego kontraktu).
- `module.mjs`: jedna linia, dynamiczny import rejestru z `.catch`. Brak `requires` na plus-ultra.
- Testy: `node dev/test-packs.mjs`. Otwarte wybory P1-P6 i weryfikacja: `dev/packs-notes.md`.

## 2026-11-17 T4: katalog Invincible + narzędzia odczytu
- `scripts/systems/invincible/catalog.mjs` (indeks z paczek invincible-core + sekcje h2 stron Archetypes/Occupation, refy `<paczka>:<id>`, wyszukiwanie, `getEntries`, `indexText` = system[2], `refToUuid`, adapter `foundrySource`, pamięć podręczna z hookami; zasila wendorowane `setPowerMaxLevels`), `rules-digest.mjs` (szkic skrótu zasad = system[1], 22 tematy `read_rules` z częściami po 6 000 znaków, Quickstart nieosiągalny), `tools.mjs` (schematy strict `search_catalog`, `get_entries`, `read_rules`, `read_document` zawężony wg 2026-11-17c), `prompt.mjs` (grupa `prompt`: `staticPrompt`/`tools`/`runTool`); w `pack.mjs` tylko import + `Object.assign(pack, promptGroup(...))`.
- Dla T5: narzędzia propozycji dołączają się same, gdy pakiet ma `proposalTools()` + `runProposalTool(name, input, ctx)` (catalog-notes C7). Dla T6/T5: `refToUuid(cat, ref)`, `cat.get/findByName/boostsFor/limitsFor/levelOf`, `getCatalog()`.
- `dev/test-packs.mjs`: test szkieletu sprawdza teraz grupy jako wartości logiczne (prompt = true), nie „wszystko false”.
- Testy: `node dev/test-catalog-invincible.mjs` (15, fikstura wymyślona), żywo `dev/live-catalog-invincible.js` na torze (tylko rozmiary). Zmierzone: prefiks ~17,7k tokenów (znaki/3.5; indeks ~15,0k, skrót ~1,25k, narzędzia odczytu ~1,0k, reguły harnessu ~0,5k). Szczegóły, wybory C1-C13 i niesprawdzone: `dev/catalog-notes.md`.
