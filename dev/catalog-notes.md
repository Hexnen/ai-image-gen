# T4: katalog Invincible + narzędzia odczytu: notatki i otwarte wybory

Pliki: `scripts/systems/invincible/catalog.mjs` (indeks, wyszukiwanie, szczegóły wpisów, tekst indeksu do prefiksu, adapter Foundry, pamięć podręczna), `rules-digest.mjs` (skrót zasad = system[1], biała lista stron `read_rules`), `tools.mjs` (schematy 4 narzędzi, `read_document`, dyspozytor), `prompt.mjs` (grupa `prompt` pakietu: `staticPrompt`/`tools`/`runTool`), 2 linie w `pack.mjs`. Testy: `node dev/test-catalog-invincible.mjs` (fikstura wymyślona, zero tekstu z podręcznika), żywo: `dev/live-catalog-invincible.js` (wkleić w konsolę MG na torze; drukuje tylko rozmiary/liczby).

Spec (`ai-gen-spec.md` 3.5) nazywa plik `catalog-index.mjs`; brief zadania proponował `catalog.mjs`: zostało `catalog.mjs`.

## Zmierzone na żywo (tor 8, kopia świata invincible, invincible-core 1.0.2, system 2.1.8, plus-ultra aktywny), 2026-11-17
Tokeny = lokalne oszacowanie (znaki/3.5 jak `estimateTokens` w `scripts/anthropic/pricing.mjs`; w nawiasie znaki/4 jako dolna granica). Prawdziwe liczby da dopiero `count_tokens` z kluczem (T8).
| Blok | Znaki | Tokeny ~ |
|---|---|---|
| system[2] indeks katalogu (485 wpisów, 578 linii) | 52 370 | 14 963 (13 093) |
| system[1] skrót zasad (szkic) | 4 376 | 1 251 (1 094) |
| tools: 4 narzędzia odczytu | 3 483 | 996 (871) |
| system[0] reguły harnessu (szkic T2 w chwili pomiaru) | 1 711 | 489 (428) |
| razem prefiks (bez narzędzi propozycji T5) | 61 940 | ~17 700 (15 500) |
Spec 9.2 szacował prefiks 16-23k, indeks 10-14k: indeks wyszedł nieco ponad (15k), całość w widełkach. Udział w indeksie: refy 22 % znaków, streszczenia 55 %.
Na rodzaj (tokeny ~): power 69 wpisów 2 255, boost 85 2 495, limit 40 1 231, powerSource 36 1 191, talent 57 1 640, drawback 15 461, gear 37 1 211, vehicleWeapon 9 326, archetype 16 454, occupation 22 616, npcProfile 35 936, sampleHero 64 1 610.
Wyniki narzędzi (znaki JSON): get_entries na wpis średnio power 1 229 (max 2 571), boost 441, limit 488, talent 475, drawback 750, gear 374, archetype 1 733, occupation 943, npcProfile 622, sampleHero 1 972 (max 2 895); żaden tekst nie przekroczył limitów (0 obciętych). search_catalog 10 wyników ~1,4-1,8k znaków. read_rules: 22 tematy, wszystkie dostępne; części: occupation 4, archetypes 5, powers_intro 3, other_gear 2, vehicles 2, reszta 1.
Budowa katalogu: 118-207 ms na zimno, 13 ms ponownie; `staticPrompt` z gotowym katalogiem 19 ms. Pamięć podręczna w pamięci strony wystarcza (bez IndexedDB, spec 11.2).
Stabilność: tekst indeksu identyczny bajt w bajt między budowami, także po wczytaniu dokumentów (po poprawce C10).

## Otwarte wybory (zachowanie tymczasowe)
- C1. Format refa: `<krótka paczka>:<id dokumentu>` jak w spec 6 (`powers:…`, `boosts:`, `limits:`, `sources:`, `talents:`, `drawbacks:`, `gears:`, `npcs:`, `heroes:`), sekcje książki `archetype:<slug>` / `occupation:<slug>`. Refy to 22 % indeksu (~3,3k tokenów, losowe 16-znakowe id tokenizują się słabo). Alternatywa: krótkie refy porządkowe albo nazwowe (oszczędność ~2-3k tokenów, ale ryzyko zmiany znaczenia przy zmianie kompendium). Ref poziomu mocy dzielonej (Protection itd.) też jest przyjmowany i rozwiązuje się do mocy + poziomu (`levelOf`).
- C2. Streszczenia: pierwsze zdanie opisu, max 12 słów, dla każdego wpisu (55 % indeksu, ~8k tokenów). Alternatywa przy cięciu kosztów: bez streszczeń dla boostów/limitów/źródeł/przykładowych bohaterów (~-5k tokenów, więcej wywołań get_entries). Decyzja po pomiarach T8 (O6).
- C3. Limity tekstu: get_entries 2 500 znaków na przedmiot (spec), 4 000 na sekcję archetypu/zawodu (spec nie mówi; zmierzone max 1 824, więc limit nie gryzie), read_document 8 000 na opis i 16 000 na cały wynik.
- C4. `read_rules` dostał opcjonalne `part` (spec ma tylko `{topic}`): strony dłuższe niż 6 000 znaków przychodzą w częściach, model widzi `parts` i `more`. Biała lista 22 tematów: z rozdz. 2 wszystkie 14 stron kreacji (w tym Growth (O24), Archetypes, Occupation), z rozdz. 3 wstęp Powers, z rozdz. 4 Weapons, Other Gear, Vehicles, Minions, z rozdz. 6 Non-Player Characters, NPC Profiles, Creatures. Strony list mocy/talentów/wad z rozdz. 3 pominięte (to samo daje get_entries). Quickstart: nieosiągalny (inna paczka; adapter odrzuca nazwę „Quickstart” w dzienniku/stronie).
- C5. `npcProfile` = aktorzy typu `npc` z `npcs-creatures` (35: foldery NPCs + Creatures); minions/vehicles/challenges pominięci (zakres v1, O2). `sampleHero` = 64 bohaterów `heroes-villans`.
- C6. Archetypy i zawody zawsze z sekcji h2 stron książki (niezależnie od plus-ultra), więc prefiks jest ten sam z plus-ultra i bez. Plus-ultra (miękko) dokłada tylko w get_entries pole `structured` (atrybuty, moce z refami, boosty) z `api.chargen.catalog.getArchetype`; na żywo: 16/16 zawiera refy, sprawdzone dla Speedster i Mastermind.
- C7. Konwencja dla T5: grupa `prompt` sama dokleja narzędzia propozycji, jeśli pakiet ma `proposalTools(): ToolDef[]` i `runProposalTool(name, input, ctx)`. `tools()` jest posortowane po nazwie; nazw narzędzi odczytu nie da się nadpisać.
- C8. Schematy `strict: true` bez `minimum/maximum/maxItems/minLength` (gramatyka strict ich nie obsługuje wg skilla claude-api); limity (8 refów, 25 wyników, część >= 1) są w opisach i egzekwowane w kodzie. Niesprawdzone przez API.
- C9. `read_document`: cel `"this"` bez `itemIds` jest odrzucany („arkusz już jest w kontekście”); inne dokumenty tylko światowe Actor/Item (po dokładnej nazwie bez wielkości liter albo uuid), widoczne dla MG (OBSERVER), kompendia odsyłane do get_entries. Tekst arkusza innego aktora z `pack.snapshot` (T12; na żywo działało), bez niego prosty format zastępczy. Treść skryptów (`extraConfiguration`) nigdy nie wychodzi, tylko flaga `script: true`.
- C10. Streszczenie aktorów (NPC, przykładowi bohaterowie) = same nazwy mocy, bez poziomu: indeks kompendium traci `system` osadzonych przedmiotów aż do wczytania dokumentu, przez co prefiks zmieniał się w trakcie sesji (złapane na żywo). 
- C11. Moce dzielone na poziomy: jeden wpis w indeksie (ref dokumentu `basic`, znacznik `split`), refy poziomów w get_entries `levels`. Maks. poziom pozostałych mocy z etykiet „Major:/Massive:/Monstrous:” w opisie (logika plus-ultra B2); katalog zasila nim WENDOROWANE `setPowerMaxLevels` (spec 8.2).
- C12. Odcisk (`fingerprint`) = hash wersji pakietu + wersji skrótu + tekstu skrótu + indeksu + schematów narzędzi; katalog przebudowuje się po hookach create/update/delete Item/Actor/JournalEntryPage w paczkach invincible-core.
- C13. Skrót zasad to szkic (liczby z wendorowanego `rules.mjs`, sformułowania własne); ostateczne słowa w T8.

## Niesprawdzone
- Prawdziwe liczby tokenów (`count_tokens` wymaga klucza; czy jest bezpłatne: [A]).
- Czy API przyjmuje te schematy w trybie strict (żadnego wywołania API).
- Jakość wyszukiwania na prawdziwych zapytaniach modelu (punktacja prosta; np. „strength” zwraca najpierw boost, potem moc).
