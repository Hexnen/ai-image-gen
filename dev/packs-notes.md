# T3: rejestr pakietów systemowych: notatki i otwarte wybory

Pliki: `scripts/build/registry.mjs` (kontrakt w nagłówku, loader, empty states, self-test hook, `startBuildRegistry`), `scripts/build/deps.mjs` (czyste: `detectModule`, `hasPack`, `compareVersions`, `systemInfo`), `scripts/build/registry-lang.mjs` (teksty `MAIG.Packs.*` EN/PL), `scripts/systems/invincible/pack.mjs` (szkielet: `check`, `supports`; reszta dla T4/T5/T6/T12), `scripts/systems/_stub/pack.mjs` (pełny, nieszkodliwy pakiet: wzór i mock dla T2/T7), `dev/test-packs.mjs`.
Podpięcie: jedna linia w `scripts/module.mjs` (gałąź GM w `ready`): dynamiczny `import("./build/registry.mjs")` z `.catch`, więc nawet błąd składni w rejestrze nie rusza generowania obrazów. Nazwy plików według spec 3.5 (`scripts/build/`, `scripts/systems/<id>/`), nie `scripts/packs/`.

## Ustalenia kontraktu (dla kolejnych zadań)
- Wymagane: `id`, `systemId`, `version` (int >= 1), `check()` (synchroniczne, nie rzuca), `supports(doc)`.
- Grupy zdolności: `prompt` (staticPrompt/tools/runTool), `validate` (validate), `sheet` (snapshot/diffSnapshots), `writer` (plan/apply/undo/undoStatus). Grupa jest albo cała, albo wcale: połowiczna grupa = pakiet odrzucony. Brak grupy = pakiet aktywny, `status().capabilities[group] === false` (szuflada pokaże „jeszcze niezaimplementowane”).
- `validate` to dodatek względem spec 3.2 (brief prosił o deklarację walidatorów); `runTool` nadal może wołać walidację sam.
- Opcjonalne moduły deklaruje się tylko w `check().optional: [{ id, kind, usable, adds, detail }]`. Nigdy nie blokują.
- Hook `moinensAiGen.packReady` (dane = `status()`), API `api.build = { contractVersion, registry, registerSystemPack, status, ready }`, tylko u MG.
- Pakiet jest singletonem modułu ES na stronę: `init({ game })` ustawia referencję `game` pakietu. Drugi rejestr na tej samej stronie (np. test w konsoli) przestawia ją; w produkcji jest jeden.

## Otwarte wybory (zachowanie tymczasowe)
- P1. Powiadomienia: blokada (brak invincible-core / paczek / za stary system) = `warn`, brak opcjonalnego plus-ultra = `info`, każde RAZ na przeglądarkę na dany zestaw braków (localStorage `moinens-ai-gen.packs.noticeSeen`, ostatnie 20). Błąd wczytania pakietu = `error` przy każdym starcie (to błąd kodu). Zawsze też w konsoli i w `emptyState()` szuflady. Alternatywa: blokada przy każdym starcie.
- P2. `registerSystemPack` z zewnątrz: zarejestrowany przed `load()` wygrywa z pakietem wbudowanym; po `load()` aktywuje się tylko, gdy nic nie jest aktywne (`none`/`failed`); nigdy nie podmienia aktywnego. W praktyce `api.build` powstaje dopiero w `ready`, więc moduły zewnętrzne trafiają w drugi przypadek.
- P3. `relationships.recommends` w `module.json`: NIE dodane (spec 3.3 dopuszcza; zachowanie v14 niesprawdzone, a moduł działa na wykrywaniu w runtime). Do decyzji, czy chcemy podpowiedź w instalatorze.
- P4. `supports()` Invincible: zakres v1 (O2) superhero/npc + gear/vehicleWeapon; dokument z kompendium, zablokowany albo bez `isOwner` = `canWrite:false` (szuflada tylko do odczytu).
- P5. Minimalna wersja plus-ultra: brak (wykrywanie po kształcie API: `chargen.catalog`, `chargen.provider`, `chargen.apply.{plan,apply,undo,undoStatus}`). Właściwy strażnik zmian to `selfTest` (T6, pu-bridge).
- P6. `check()` musi być synchroniczne (Promise = blokada). Jeśli T4 potrzebuje asynchronicznego sprawdzenia indeksów, to idzie do `selfTest`/`staticPrompt`, nie do `check`.

## Weryfikacja 2026-11-17
- Node: `node dev/test-packs.mjs` 23/23 (zgodny system, inny system nic nie ładuje, plus-ultra brak/nieaktywny/niepełne API/obecny, brak invincible-core/paczki/stara wersja systemu, zepsuty import/niepoprawny obiekt/zły systemId/rzucający init/check/supports, tylko MG, rejestracja zewnętrzna, self-test, i18n, statycznie: brak `requires`, brak statycznego importu pakietów).
- Na żywo (lane 8, kopia świata invincible, potem `restore`): MG: `api.build.status()` = ready, check ok, plus-ultra 0.20.2 usable, sieć: `build/registry.mjs`, `registry-lang.mjs`, `deps.mjs`, `systems/invincible/pack.mjs` 200. Rejestr z ukrytym plus-ultra (proxy `game.modules`): ready, ok, info po angielsku. Gracz (Test Gracz 1): `api` bez `build`, żaden plik `build/`/`systems/` modułu nie pobrany.
- Niesprawdzone: inny system na żywo (tylko node), zachowanie `recommends` w v14, wygląd powiadomień (tylko tekst).
