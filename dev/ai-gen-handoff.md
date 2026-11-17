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

## 2026-11-17 T2: pętla harnessu + sesje + limity
- `scripts/build/harness.mjs` (czysty: tura MG = arkusz 5.4 + tekst, pętla żądań przez transport T1, narzędzia przez `pack.runTool` równolegle, wyniki w JEDNEJ wiadomości, limity 5.3: żądania / narzędzia / kolejne i identyczne błędne `submit_*` / koszt na wiadomość / czas, Stop, rezerwacja i księgowanie w limitach modułu, wpis `kind: "build"` w logu z `cacheRead`/`cacheWrite`, redakcja, pre-warm, transkrypt), `session-store.mjs` (IndexedDB `moinens-ai-gen`: `sessions` per dokument + `archive`; tylko dopisywanie, edycja historii = błąd; pamięć, gdy IndexedDB brak), `sheet-sync.mjs` (ogólna reguła pełny / bez zmian / aktualizacja / pełny supersedes; pakiet z `nextSheetBlock` ma pierwszeństwo), `harness-prompt.mjs` (system[0] tymczasowy, T8), `harness-lang.mjs`, `harness-defaults.mjs`, `build-settings.mjs` (`build.*`), `builder-api.mjs` (`api.build.openSession(doc)` -> sesja ze zdarzeniami; T7 steruje nią).
- Linie podpięcia: `module.mjs` (dynamiczny import `build/builder-api.mjs` dla MG), `settings.mjs` (`registerBuildSettings()` w `init`), `call-log.mjs` (`cacheRead`, `cacheWrite` w `LOG_FIELDS` i CSV).
- Dla T7: API i zdarzenia w `dev/harness-notes.md`. Dla T12: wystaw `nextSheetBlock` na obiekcie pakietu, jeśli harness ma używać formatu z `snapshot.mjs`. Dla T5: propozycja oczekuje, gdy narzędzie `submit_*` zwróci `ok: true` (+ `proposalId`, `summary`, `warnings`).
- Testy: `node dev/test-harness.mjs` (27, atrapa modelu przez stub fetch + SSE, atrapa IndexedDB). Wybory H1-H13, zweryfikowane / niezweryfikowane: `dev/harness-notes.md`.

## 2026-11-17 T12: czytnik karty + blok `<sheet>` + diff
- `scripts/systems/invincible/reader.mjs` (dokument -> model: `_source` i wartości przygotowane osobno, przedmioty z id/poziomem/linkami/sprzętem, ref katalogu albo `custom`, `edited`, `auto=` tylko przy różnicy z paczką, nigdy treść skryptu; efekty, flagi plus-ultra/undo; `chargenStateFromActor` = heurystyki import.mjs 1:1 dla VALID; `readLiveForm` przez `foundry.applications.ux.FormDataExtended`; loader katalogu z dokumentów paczek, podmienialny `useCatalogLookup`), `snapshot.mjs` (serializacja linia-fakt, estymator, limit 6000 z kolejnością cięcia, `diffLines/formatUpdate/applyUpdate`, `nextSheetBlock` 5.4, `snapshot(doc, opts)`).
- `pack.mjs`: grupa `sheet` (`snapshot`, `diffSnapshots`) + opcjonalne `nextSheetBlock` (harness T2 je preferuje).
- Fikstury dla T5/T6: `dev/fixtures/invincible-sheets.mjs` (wymyślony katalog, `typicalHero` poprawny wg reguł Global, `bigNpc`, `hugeNpc`, budowniczowie `actor/item/effect/fromCatalog`).
- Testy: `node dev/test-build-snapshot.mjs` (25). Rozmiary: typowy bohater ~0,9k tokenów (fikstura), na żywo 64 próbnych bohaterów mediana ~1,2k / max ~2,2k, 35 NPC mediana ~0,35k / max ~1,5k. Wybory S1-S12, weryfikacja, niesprawdzone: `dev/snapshot-notes.md`.

## 2026-11-17 T5: walidacja + narzędzia propozycji
- `scripts/systems/invincible/proposal.mjs` (czysty: schemat strict `PROPOSAL_SCHEMA` + `PROPOSAL_GUIDE`, L0 `checkShape`/`normalize` + autoFixed, biała lista gear `customItemData`/`gearPatch`, `project` = op na kopii aktora, `replaceToOps`, `selectOps`/`dependants`, `expectFor`/`checkStale`), `validate.mjs` (L0-L4, profile creation/in-play, NPC 7.4, komunikaty EN + podpowiedzi + `suggest` z `reconcileAttributes`, budżet przed/po + koszt na op, `check_proposal`/`submit_proposal`, `validateGroup`); w `pack.mjs` tylko import + `Object.assign(pack, validateGroup(...))`.
- Dla T6: `pack.validate(doc, proposal, { profile, rank, only|deselect, expect, allowVitals, plan })`; obiekt Plan w `plan` jest tylko dołączany (bez wywołania zwrotnego), funkcja `pack.plan` jest wołana jako L3 z `{ dryRun: true, fromValidate: true }` i propozycją w trybie ops. Dwie konwersje replace -> ops (moja i `replace.mjs toOps`) do ujednolicenia (validate-notes V13).
- Dla T7: wynik `validate` ma `opInfo` (per op: zmiany, kaskada, `splitSwap`), `selection.withThem`, `expect`, `budget.{before,after,perOp}`, `summary`. Dla T8: opis pól jest raz w opisie `submit_proposal`; narzędzia ~4,3k tokenów (V14).
- Testy: `node dev/test-build-validate-invincible.mjs` (28). Na żywo tor 8 (tylko liczby): 64 bohaterów / 35 NPC bez wyjątków, in-play ok, archetypy 16/16 wg reguły sumy. Wybory V1-V16, weryfikacja, niesprawdzone: `dev/validate-notes.md`.
