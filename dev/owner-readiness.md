# Moinens AI Gen na serwerze właściciela (port 30000): gotowość

Stan na 2026-11-17 wieczór, HEAD `3130e1b` (drzewo czyste). Badanie bez dotykania portu 30000 i światów właściciela:
tylko odczyt plików w `Data/`, ustawienia światów czytane z KOPII w scratchpadzie, test ładowania na torze 8 (świat przywrócony, slot oddany).

## Werdykt

**TAK, z krokami.** Kod jest gotowy do włączenia, ale serwer na 30000 trzeba najpierw zrestartować (zna moduł jeszcze pod starym id).
Część AI-kreatora (szuflada przy karcie) nigdy nie rozmawiała z prawdziwym Anthropic: pierwsze użycie to pierwszy prawdziwy test (lista niżej).

## 1. Serwer 30000 i jego Data

| Fakt | Dowód |
|---|---|
| Serwer 30000 używa TEGO SAMEGO folderu Data, więc `Data/modules/moinens-ai-gen` jest już żywą kopią | `Config/options.json`: `dataPath = <DATA>/..` (the Foundry user-data folder), `port = 30000`; port 30000 słucha proces 12248 (`Foundry Virtual Tabletop.exe` bez `--dataPath`) |
| Foundry 14.363 (stable, build 363) | `C:\Program Files\Foundry Virtual Tabletop\resources\app\package.json` (`version 14.363.0`); log: dostępna aktualizacja 14.370 (niezainstalowana) |
| Serwer 30000 wystartował **2026-11-16 23:56:53**, PRZED zmianą nazwy (commit `8052be1` 2026-11-17 13:14) | `Get-Process 12248 StartTime`, `Logs/debug.2026-11-16.log` „Server started and listening on port 30000” 23:56:56; od tego czasu żaden świat nie był uruchomiony (ostatni „Launching World” 21:35) |
| Systemy | `invincible` 2.1.8 (min 14, verified 14.368), `mythicbastionland` v1.0.10, `stonetop` 0.11.0 |
| Światy | `invincible` (system invincible, ostatnio 2026-11-16), `mythic-test` (mythicbastionland, 2026-10-11), `stonetop` (stonetop, 2026-06-27); wszystkie core 14.363 |
| plus-ultra | `Data/modules/invincible-plus-ultra` v0.20.2, commit `4d4984f`, drzewo czyste; relacja: system invincible >= 2.1.0, compat min 13 / verified 14 |
| Folder `Data/modules/ai-image-gen` | **nie istnieje** (zmieniony na `moinens-ai-gen`); nie ma więc podwójnego ładowania |

Uwaga z boku (nie ten moduł): log 30000 ma błędy migracji paczek `invincible-core` („Documents from a core version newer than the running version”).
Paczki się mimo to czytają (katalog kreatora na torach, też 14.363, działał), ale aktualizacja Foundry do 14.370 by to uciszyła.

## 2. Manifest i stare id

- `module.json`: id `moinens-ai-gen` = nazwa folderu, wersja 0.1.0, compat min 14 / verified 14 (pasuje do 14.363).
- Ścieżki istnieją: `scripts/module.mjs`, `styles/module.css`, `styles/builder-drawer.css`, `lang/en.json`, `lang/pl.json`.
- Brak `relationships`: plus-ultra jest MIĘKKIM dodatkiem wykrywanym w kodzie (`scripts/systems/invincible/pack.mjs`, `pu-bridge.mjs`), pakiet systemu ładuje się tylko dla `game.system.id === "invincible"` (`scripts/build/registry.mjs`).
- `url`/`manifest`/`download` nadal wskazują repo `Hexnen/ai-image-gen` (kosmetyka, decyzja 2 w `dev/rename-notes.md`; aktualizacja z poziomu Foundry pobrałaby STARY moduł: **nie klikaj „Aktualizuj” przy tym module**).
- Pozostałe wystąpienia `ai-image-gen` są celowe: `OLD_MODULE_ID` (kopia ustawień), `DATA_ROOT` (folder danych `Data/ai-image-gen/` zostaje), teksty i18n. `node dev/test-migrate-id.mjs`: 18/18 ok (statyczne kontrole repo, w tym „uruchomiony pod starym id” ≠ „stary moduł aktywny”).
- Flagi dokumentów: stary moduł nie pisał flag; nowe flagi tylko `flags.moinens-ai-gen.undo` / `.lock` (writer kreatora). Makr starego id brak.
- Gdy stary moduł jest aktywny jednocześnie: nowy zostaje bezczynny z ostrzeżeniem (`module.mjs` `oldModuleActive`). Na 30000 starego folderu nie ma, więc to nie zajdzie.
- **Serwer sprzed zmiany nazwy** (stan 30000 teraz): jeśli serwer wciąż zna pakiet jako `ai-image-gen`, moduł wstaje bezczynny z komunikatem `AIIMG.Rename.StaleServer` („uruchom Foundry ponownie”). Restart serwera to rozwiązuje.
- Wpis `ai-image-gen: true` w konfiguracji modułów świata po restarcie to tylko martwy wpis brakującego pakietu: na torze 8 ten sam stan (stary `true`, pakietu brak) nie przeszkadzał.

## 3. Światy właściciela: co jest włączone dziś

Odczyt z kopii `worlds/*/data/settings` (LevelDB przez `classic-level` z instalacji Foundry, oryginały nietknięte):

| Świat | `core.moduleConfiguration` | Ustawienia `ai-image-gen.*` | `moinens-ai-gen.*` |
|---|---|---|---|
| invincible | `ai-image-gen: true`, `invincible-plus-ultra: true`, `invincible-core`, `invincible-balancer`, `invincible-splash`, `sketch-reveal` | `imageTypes` (1 typ: `invincible\|Actor\|superhero`), `usage` (listopad 0,00613 USD), `schema 2`, limity domyślne (5 / 50 / 1 / 50), `optimizeImages true`, `batches {}`, sloty `batch.21`, `batch.31` puste `{}` | brak |
| mythic-test | ani stary, ani nowy | brak | brak |
| stonetop | ani stary, ani nowy | brak | brak |

- **Brak oczekujących batchy** w starym id: powrót do starego modułu nie zbierze niczego drugi raz.
- Kopia, która nastąpi w świecie `invincible`: `usage`, `imageTypes`, `schema` (limity są domyślne, więc nie są kopiowane; to samo wyszło na torze 8: konsola „copied settings from "ai-image-gen": usage, imageTypes, schema”).
- Kreator AI działa tylko w systemie Invincible (świat `invincible`; wg ustaleń to świat testowy). W `mythic-test` i `stonetop` moduł dałby tylko generowanie obrazów (kreator się nie ładuje).
- plus-ultra 0.20.2: wendorowane `rules.mjs`/`state.mjs` bajt w bajt równe żywemu drzewu (`sync.mjs --check`: OK, stamp `c4899e159f5c1a50`, źródło `321fd77`); API, którego używa most (`chargen.apply.plan/apply/undo/undoStatus`, `open`, `canUse`, `provider`), istnieje w żywym drzewie (`scripts/chargen/apply.mjs:579`, `main.mjs:120`, `catalog.mjs:387`); `apply(actor, state, { confirmed, expect })` i `undo(actor, { confirmDrift })` przyjmują opcje mostu.
- **T9 (`api.chargen.open(actor, { state })`)**: plus-ultra 0.20.2 przyjmuje tylko `{ surprise }` (`main.mjs:40`), stan jest ignorowany. Na torze 8 wywołanie z `{ state }` otworzyło kreatora bez błędu (stan pominięty). Dodatkowo: szuflada nie podpina dziś `openWizard`, `installWizardButton` ani `fullRebuild` (brak wywołań w `scripts/build/`), więc te dodatki plus-ultra nie są osiągalne z UI; z plus-ultra korzysta tylko katalog (dane archetypów) i flaga rangi chargen.

## 4. Lista kontrolna pierwszego użycia (właściciel)

1. **Zrób kopię świata `invincible`** (Foundry: Kopie zapasowe, albo skopiuj folder świata przy wyłączonym Foundry).
2. **Zrestartuj Foundry** (zamknij aplikację na 30000 i uruchom znowu), żeby serwer zobaczył `moinens-ai-gen`. Nie trzeba niczego kopiować: folder już jest na miejscu.
3. Wejdź do świata **`invincible`** jako MG, Zarządzaj modułami: włącz **„Moinens AI Gen”** (stary „AI Image Gen” pokaże się jako brakujący albo wcale; zostaw). Zapisz, świat się przeładuje.
4. Po starcie w konsoli (F12) powinno być `moinens-ai-gen | ready` i `copied settings from "ai-image-gen": ...`. Komunikat „działa pod starym id” = serwer nie był zrestartowany (krok 2).
5. **Klucz API Anthropic wpisujesz sam**: Konfiguruj ustawienia → Moinens AI Gen → „Klucz API Anthropic (ulepszanie opisów)” (ten sam klucz używa kreator). Zakres **client**: zapisany w `localStorage` tej przeglądarki i tego adresu (`http://localhost:30000` w aplikacji Foundry to inne miejsce niż np. `127.0.0.1:30000` czy zdalna domena), nie trafia na serwer, do świata ani do graczy; czyta go każdy, kto ma dostęp do tego profilu przeglądarki.
6. **Klucze ze starego modułu**: jeśli kiedyś wpisałeś klucze (OpenAI/Gemini/OpenRouter/Anthropic) w „AI Image Gen” w tej samej przeglądarce i pod tym samym adresem, skopiują się same przy pierwszym starcie (raz). Sprawdź w ustawieniach, że są; jeśli nie, wpisz ręcznie.
7. **Limity kosztów** (świat, tylko MG zmienia; gracze mogą je odczytać): moduł 5 USD/dzień, 50 USD/miesiąc, 1 USD na jedno żądanie (0 = brak limitu); kreator na jedną wiadomość: 0,50 USD, 12 żądań, 40 narzędzi, 4 błędne propozycje, 5 min. Kreator rezerwuje i księguje koszt w limitach modułu (różdżka opisów nie).
8. **Domyślne**: model `claude-sonnet-5-5`, wysiłek `medium`, cache prefiksu 1 h, koniec tury po udanej propozycji włączony; w szufladzie ranga „Domyślna” = flaga rangi z kreatora plus-ultra, inaczej Global Guardian; zasady „Tworzenie” (zmień na „W grze” przy edycji grającej postaci).
9. **Uwaga na pre-warm**: przy otwarciu szuflady z kluczem leci jedno płatne żądanie rozgrzewające cache (~21k tokenów prefiksu, raz na ~55 min). Nie chcesz: wyłącz ustawienie klienta „Kreator AI: rozgrzewanie cache promptu”.
10. **Co wypróbować najpierw**: nowy, pusty aktor typu superhero (nie postać gracza). Otwórz kartę → przycisk z robotem w nagłówku → wybierz rangę → napisz np. „Zbuduj młodego bohatera z supersiłą i lotem” → przeczytaj kartę propozycji (budżet przed/po, zmiany, uwagi „Dla MG”) → **Zastosuj** → sprawdź kartę → **Cofnij ostatni zapis**. Potem jedna drobna edycja istniejącego bohatera w profilu „W grze”. Sprawdź koszt w „Log wywołań Moinens AI Gen” (grupa narzędzi modułu na lewym pasku).
11. **Cofanie**: dziennik w aktorze (`flags.moinens-ai-gen.undo`): 10 ostatnich zapisów, 24 h, cofanie całego zapisu albo pojedynczego przedmiotu; gdy karta zmieniła się po zapisie, cofnięcie prosi o potwierdzenie. Odrzucenie propozycji niczego nie zapisuje.
12. **Wyłączenie / powrót**: wyłącz „Moinens AI Gen” w Zarządzaniu modułami (dane, obrazy w `Data/ai-image-gen/` i ustawienia zostają). Stare wartości `ai-image-gen.*` w świecie są nietknięte, ale samego starego modułu na dysku już nie ma (wrócić można tylko ze starego commita git, pod starą nazwą folderu). Nie klikaj aktualizacji modułu w Foundry (manifest wskazuje stare repo).

## 5. Test ładowania na torze 8 (2026-11-17, slot `rd`, własna karta, `lane8.ps1 restore` bez potoku, slot oddany)

Tor 8: ten sam exe 14.363, `moinens-ai-gen` = junction do żywego folderu, plus-ultra = `C:\ipu-tactics` (ten sam commit `4d4984f`, 0.20.2). Świat toru miał ten sam stan co świat właściciela (`ai-image-gen: true`, nowy wyłączony).

| Przebieg | Wynik |
|---|---|
| Włączenie nowego modułu (plus-ultra ON) | `active`, pełne API MG (19 kluczy, `build` 14), grupa narzędzi na pasku, kopia ustawień `usage, imageTypes, schema`, flaga `migratedFromAiImageGenWorld = true`; `build.status` = `ready`, pakiet invincible, wszystkie możliwości true, plus-ultra 0.20.2 „extras on”, self-test mostu `{ ok: true }`; przycisk robota na karcie, szuflada otwiera się z banerem „Brak klucza API Anthropic” |
| plus-ultra OFF | moduł `active`, `build.status` `ready`, plus-ultra „not usable”, info w konsoli bez błędu; przycisk i szuflada działają |
| plus-ultra ON ponownie | self-test ok, `chargen.open(actor, { state })` otwiera kreatora bez błędu |
| Błędy konsoli | żadnego błędu z `moinens-ai-gen`. Inne: 404 `modules/moinen-maps/build.json` (moinen-maps), błędy canvas „0px” i `tokens-tab` (ukryty panel przeglądarki, środowisko testu) |
| Sieć | zero żądań do Anthropic (brak klucza); log `Data/ai-image-gen/_log/2026-11.json` czytany 200 |

Ograniczenie: bufor konsoli karty gubił starsze wiadomości przy pełnym przeładowaniu (do ~1900), więc lista błędów ładowania jest kompletna dla końcówki startu i wiadomości modułu, nie dla całego startu.

## 6. Czego NIE sprawdzono (tylko zastępcy na sucho / atrapy)

- **Prawdziwe wywołanie Anthropic z przeglądarki**: CORS z nagłówkiem `anthropic-dangerous-direct-browser-access`, także z aplikacji Electron i z adresu zdalnego.
- **Strumień SSE** z prawdziwego serwera (parsowanie, przerwania, `overloaded`/429/5xx, ponowienia).
- **Schematy `strict`** narzędzi (`submit_proposal`, `get_entries`, `read_rules`, `search_catalog`, `read_document`) przyjęte przez prawdziwe API.
- **Cache promptu**: dwa punkty `cache_control`, TTL 1 h, czy trafienia faktycznie są i ile kosztują; pre-warm z `max_tokens: 0`.
- Nagłówek beta `server-side-fallback-2026-07-01`, dostęp konta do modelu `claude-sonnet-5-5`, parametr wysiłku.
- **Koszty**: księgowanie z prawdziwego `usage` vs tabela cen modułu; zatrzymanie limitem na prawdziwej turze.
- **Jakość odpowiedzi prawdziwego modelu** (wszystkie rundy prób to zastępcy-agenci, nie Claude przez API).
- Kopia kluczy klienta w przeglądarce właściciela (profil Electron, `localhost:30000`): sprawdzone tylko testami node i na torze bez kluczy.
- Restart serwera 30000 po zmianie nazwy (wniosek z kodu i dat, nie z próby).
- plus-ultra T9 (stan dla kreatora) nie istnieje; „Pełna przebudowa”, „Otwórz w kreatorze” i przycisk w oknie kreatora nie są podpięte w szufladzie.
