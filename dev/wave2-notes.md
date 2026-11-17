# Druga fala (W2-x): notatki agentów

Plik wspólny: każdy agent dopisuje własną sekcję, nie nadpisuje cudzych. Plan fali: `dev/dry-run/analysis-2.md` sekcja 4.

## W2-7: API dla szuflady (T7) i dokumentacja (D-I, D-J, D-L, D-R, P1-H)

Data: 2026-11-17.

### Defekty sprawdzone w kodzie przed zmianą
- D-I: `writer.mjs` `applyLocked` kładzie cały `plan` (z `projected`) do `base` (l. 833) i zwraca go przy sukcesie (l. 958). Potwierdzone.
- D-J: brak listy rang w `pack.mjs` i `builder-api.mjs` (l. 58-65); `setOptions` zwracał obietnicę zapisu (`harness.mjs:202`), stąd `{}`; `nextSheetBlock(held, snap)` (`pack.mjs:95`) bez opisu. Potwierdzone.
- D-L / PA1: `tools.mjs:197-198` bez notatki; `catalog.mjs:439-441` daje tę samą pustą listę dla nieznanej mocy i mocy bez boostów. Potwierdzone.
- D-R: RUNBOOK (l. 110) miał tylko `setOptions`. Potwierdzone.
- P1-H: tura MG (`harness.mjs:427-437`) bez stanu propozycji. Potwierdzone.

### Co zmienione
- `pack.ranks()` (`pack.mjs`): `[{ key, name, points, cap, powers, reputation, upgrades, maxLevel, isDefault }]` w kolejności książki. Liczby z wendorowanego `vendor/chargen/rules.mjs` (bez zmian w nim), nazwy w `RANK_NAMES` (te same słowa co tabela rang w skrócie zasad; test pilnuje zgodności). W szufladzie: `api.build.ranks()` (`builder-api.mjs`).
- `session.setOptions(o)` (`harness.mjs`): async, zapisuje i zwraca opcje w mocy; `null` usuwa klucz (powrót do domyślnej). Nowy getter `session.options`.
- `pack.apply` (`writer-group.mjs`): domyślnie zwięzły wynik `conciseApplyResult`: `{ ok, runId, message, ops:[{ opId, action, type, name, itemId, outcome }], budget:{ before, after }, warnings, errors, created, updated, deleted, idMap }` oraz przy odmowie `needsConfirm` + `confirm:[{ opId, action, name }]`, `stale`, `unsaved`, `busy`, `rolledBack`. `{ verbose: true }` = pełny wynik writera (plan z `projected`). Writer (`createWriter`) zwraca jak dotąd pełny wynik; dodane tylko pole `budget` z walidatora (`writer.mjs`, jedna linia). Testy writera bez zmian; w teście grupy P1-F/P1-G `r2.validation.warnings` zastąpione zwięzłym `r2.warnings` + wariant verbose.
- PA1: `search()` w `catalog.mjs` zwraca `powerFound` przy `forPower` (minimalna zmiana, 2 miejsca); `search_catalog` w `tools.mjs` dodaje `note` przy pustym wyniku: „This power has no boosts or limits.” / „No power with the name or ref ...” / brak trafień przy dodatkowych słowach lub rodzajach.
- P1-H: `session.markProposal(id, "pending"|"applied"|"discarded", { runId? })`; stan trafia do modelu jako osobny blok tekstu `<proposal id="..." status="..."/>` w NASTĘPNEJ wiadomości MG, po bloku arkusza, przed tekstem MG (tylko `messages`, nigdy `system[]`). Pierwsza wiadomość MG po udanym submit zawsze niesie znacznik (`pending`), potem tylko przy zmianie stanu. `applied`/`discarded` czyści oczekującą propozycję; `runId` przy `applied` ustawia `lastRunId`. `session.proposals` = lista stanów (najwyżej 20). Transkrypt: blok znacznika jako element `proposal-marker`, wywołanie `markProposal` jako `proposal-status`.
- `nextSheetBlock(held, snap)`: opis sygnatury w `pack.mjs` (komentarz) i w spec 3.2.
- RUNBOOK: nowy krok 6a (Apply/Discard/Undo zastępcy szuflady, `rank`/`profile`/`confirmed`, `markProposal`, sprawdzenie przez `(await pack.snapshot(a, { rank, profile })).text`, klucze rang z `api.build.ranks()`), poprawiona linia `setOptions`.
- Spec 3.2: akapit [CHANGED W2-7] o nowym API (tylko sekcja API).

### Teksty do zmiany w W2-8 (prefiks; tu NIE ruszane)
- `harness-prompt.mjs` (system[0]): opisać znacznik `<proposal id status/>`: `pending` = MG jeszcze nie zdecydował (nie wysyłaj tej samej propozycji ponownie, zmieniaj ją tylko na prośbę MG); `applied` = zapisane, arkusz to pokazuje, dalsze zmiany jako `ops`; `discarded` = MG odrzucił, nie ponawiaj bez prośby. Brak znacznika = stan bez zmian od ostatniego.
- `tools.mjs` opis `search_catalog`: zdanie „empty list = the power has no boosts or limits” zastąpić „an empty forPower result carries a `note` saying why”.
- `rules-digest.mjs`: `RANK_NAMES` jest teraz także w `pack.mjs` (kopia). Przy przepisywaniu skrótu można przenieść nazwy do jednego neutralnego modułu (np. `ranks.mjs`) i importować w obu miejscach (bez cyklu: `pack.mjs` -> `prompt.mjs` -> `rules-digest.mjs`). Bajty skrótu nie mogą się przy tym zmienić.

### Otwarte wybory (zachowanie tymczasowe)
| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| W7-1 | Stan propozycji po Undo | Szuflada woła `markProposal(id, "pending")` (zapis cofnięty, propozycję można zastosować znowu). Nie ma czwartego stanu `undone`. |
| W7-2 | Starsza propozycja `pending` zastąpiona nowszym submit | Bez znacznika dla starszej (model wie, że ją zastąpił); znacznik tylko dla nowszej. |
| W7-3 | `clearPendingProposal()` | Zostaje dla zgodności, nie zmienia stanu dla modelu. T7 i zastępcy używają `markProposal`. |
| W7-4 | Budżet w zwięzłym wyniku | `before`/`after` z walidatora (`points, spent, slots, rankPowers, cap`, plus `note`, jeśli W2-5 ją doda); bez `perOp`; `null` bez walidatora i dla dokumentów-przedmiotów. |
| W7-5 | Nazwy rang | Tylko angielskie nazwy z książki; tłumaczenie w T7 (klucze i18n szuflady). |
| W7-6 | Znacznik w transkrypcie | Element `proposal-marker` (z bloku w wiadomości) i `proposal-status` (z osi czasu); T7 może pokazać jeden z nich. Tekst MG, który tylko przypomina znacznik, zostaje tekstem MG (rozpoznawany jest wyłącznie cały blok złożony ze znaczników). |

### Testy
- `test-harness` 31 (+4: `setOptions`, znacznik pending/applied/brak powtórki, discarded + zastąpienie + tekst MG podobny do znacznika, stabilność prefiksu ze znacznikami i historia jako ścisły prefiks).
- `test-build-ops` 34 (+2: zwięzły wynik apply z `needsConfirm`/`confirm`, `ops.outcome`, budżet, verbose, wynik bez walidatora; `ranks()` = tabela wendorowana + nazwy zgodne ze skrótem).
- `test-catalog-invincible` +1 (PA1: brak boostów / nieznana moc / filtr słów / ref mocy).
- Pozostałe `dev/test-*.mjs` zielone poza `test-build-snapshot` (2 porażki w kodzie W2-3 w toku: kolejność talentów i linia talentu; nie moje pliki).
- Na żywo (tor 20, folder roboczy po commicie e8630b9, aktor ZZ-AIGEN usunięty, świat przywrócony): `api.build.ranks()` = 4 rangi z liczbami; `setOptions` zwraca opcje (`null` usuwa `profile`), nagłówek arkusza `rank=street(drawer)`; `search_catalog` z mocą bez boostów (notatka „no boosts or limits”) i z nieznaną nazwą (notatka „No power ...”); `pack.apply` dodanie talentu + Resources: zwięzły wynik ~600 znaków z `runId`, `ops[].outcome`, budżetem; usunięcie bez `confirmed` -> `needsConfirm` + `confirm`, nic nie zapisane; z `confirmed: true` zapisane; `verbose` ~6-9 KB z `plan.projected`; weryfikacja przez `pack.snapshot(...).text`.
- NIE sprawdzone na żywo: `markProposal` i znacznik w prawdziwej turze (wymaga przekaźnika próby na sucho; tylko testy node).

## W2-1, W2-2, W2-5: moc dzielona, ścieżki błędów replace, czytelny budżet (D-A, D-B, D-F, D-K, D-Q)

Data: 2026-11-17. Pliki: `proposal.mjs`, `validate.mjs`, testy w `dev/test-build-validate-invincible.mjs`; spec 7.5 pkt 4 (zmiana semantyki kosztu per op). `catalog.mjs` i `writer.mjs` bez zmian (niepotrzebne). Wendor bez zmian (`sync.mjs --check` OK).

### Defekty sprawdzone przed zmianą
- D-A: potwierdzone w kodzie (`catalog.mjs:359` daje dokumentowi bazowemu `levelOf` = "basic"; `buildAdded` zgłaszał `ref.level.conflict`) i w próbie `dry2-allmight` (req 0003-0007: dwa błędy `ref.level.conflict` dla Major przez ref bazowy). Writer (`resolveRef`) przyjmował to od zawsze.
- D-B: potwierdzone: ten sam wynik `dry2-allmight` miał `path: "ops[2].level", opId: "pw3"` dla propozycji replace.
- D-F: potwierdzone w `dry2-spider` (`act1 spent 22` przy sumie 34), `dry2-nightcrawler` (`before.points 24` na pustej karcie), `dry2-daredevil` (limit "-1 slot (slots 1/3) +2 pts" czytany jak zwrot slotu).
- D-K: potwierdzone (`dry2-spider`: "the book text says -2 each: 2" w info dla modelu).
- D-Q: potwierdzone w kodzie (`replaceToOps` zapisywał tylko różniące się pola aktora).

### Co zmienione
- W2-1: `splitRefLevel(catalog, ref, entry)` (`proposal.mjs`): główny ref mocy (jej dokument bazowy = ref z indeksu) + `level` = ten poziom; konflikt tylko dla refu INNEGO poziomu z innym `level`. Domyślny poziom bez `level` = poziom refu (jak dotąd). Podpowiedź `ref.level.conflict` podaje główny ref (`mainRef`). Walidator, konwersja replace i writer są teraz zgodne.
- W2-2: `replaceToOps` zwraca też `src` (opId -> `{ path: "proposal.powers[0]" | "proposal.powers[0].boosts[1]" | "proposal.talents[2]" | "proposal", name }`), `srcItems` (zachowany przedmiot karty -> wpis propozycji) i `kept`. `validate.mjs replacePath` w trybie replace przepisuje ścieżki WSZYSTKICH błędów/ostrzeżeń/info (L1 projekcja `ops[i].pole`, L2 ścieżki stanu chargen `attrs.x`/`occupation`/`heroTalent`..., `items.<id>`, L3 planu) na ścieżki propozycji i dodaje pole `entry` (nazwa wpisu). `opId` zostaje (łączy z `summary`/`perOp` i podglądem MG). Tryb ops bez zmian.
- W2-5: `perOp` = `{ opId, points, slots, label, spentAfter? }`: usunięta delta `spent`; op zmieniający atrybuty ma `spentAfter` i etykietę "attributes spent 12 -> 34". Dodany limit: "pays for a boost|level of "X" (no slot for it; slots 1/3) +2 pts"; usunięty limit: "limit gone: the level of "X" it paid for needs a slot again (...)". `budget.note` (stała `BUDGET_NOTE`): punkty liczą 2 za każdy niewykorzystany slot rangi. `drawback.hardTimes`: tekst dla modelu bez liczby z książki; liczba w polu `gm` (tylko MG), które `toolResult` usuwa z kopii dla modelu (ogólny mechanizm: każdy komunikat może mieć `gm`). Podsumowanie: linia aktora pokazuje `reputation N` / `resources N`; replace z wartościami już na karcie dodaje linię "act1: kept resources 3, reputation 2 (already on the sheet)". D-3 bez zmian (-1 zostaje).

### Teksty do zmiany w W2-8 (prefiks; tu NIE ruszane)
- `rules-digest.mjs` l. 38 (legenda VALID/budżetu): "per-op values are running changes in list order" -> per-op `points`/`slots` = zmiana tej op, `spentAfter` = suma atrybutów po niej, etykieta limitu "pays for ... (no slot for it)", `budget.note`. Zdanie o pustej karcie może zastąpić `budget.note` (wtedy usunąć notę z wyniku, wybór W5-2).
- `rules-digest.mjs` l. 51 (Hard Times): "(the book prints 2; the builder follows the system's effect)" kłóci się z D-K (liczba z książki tylko dla MG). Propozycja: "each Hard Times lowers the effective Resources by 1 through its item effect", bez wzmianki o książce.
- `rules-digest.mjs` l. 45 i `PROPOSAL_GUIDE` (moc dzielona: "the basic ref + level, or the level's own ref"): po W2-1 PRAWDZIWE, zmiana niepotrzebna; można dopisać, że "basic ref" = ref z indeksu.
- `PROPOSAL_GUIDE` / `TOOL_DESC.submit_proposal` (opcjonalnie): w replace błędy mają ścieżki `proposal.*` i pole `entry`; `opId` w błędzie replace to id z `summary`, nie z propozycji.

### Otwarte wybory (zachowanie tymczasowe)
| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| W1-1 | Ref poziomu innego niż bazowy + inny `level` | Nadal błąd `ref.level.conflict` (writer by przyjął: wygrywa `level`). Zgodne ze skrótem "(level omitted or the same)". |
| W2-a | `entry` i ścieżki propozycji tylko w replace | Tak; w ops model sam nadał opId. `talent.role.shift` (W2-3) w replace dostaje `proposal.talents[i]` (przez `srcItems`), w ops zostaje `items.<id>`. Pozostałości usuwane przez replace zostają `items.<id>` + `entry`. |
| W5-1 | `spent` w perOp | Usunięte (nie przemianowane); `spentAfter` tylko na op, które zmieniają atrybuty. |
| W5-2 | Notatka budżetu | `budget.note` w każdym wyniku proposal dla bohatera (~45 tokenów historii na wynik). Alternatywa: tylko legenda w skrócie (W2-8) i usunięcie noty. |
| W5-3 | Co opłaca limit w etykiecie | `grants` z propozycji, inaczej heurystyka czytnika (moc powyżej Basic = poziom, inaczej boost). |
| W5-4 | Pola `kept` w podsumowaniu | Osobna linia z opId op aktora (albo "actor:", gdy op aktora brak); tylko reputacja i Resources. |
| W5-5 | Pole `gm` | Ogólne: każdy komunikat może mieć `gm`; wynik `pack.validate` (MG) je zachowuje, `runProposalTool` (model) usuwa. T7 może je pokazać. |

### Incydent z commitem (do wiadomości W2-3)
Mój commit W2-2 (`36f0ed5`, `git commit <ścieżki>`) objął `validate.mjs` razem z ówczesnymi hunkami agenta W2-3 (import `talentRoleShifts, talentRolesOf` z `reader.mjs`, komunikat `talent.role.shift`, `talentShifts`). `reader.mjs` z tymi eksportami nie był wtedy w commicie, więc `validate.mjs` z HEAD sam się nie zaimportuje, dopóki W2-3 nie zacommituje `reader.mjs`. Commit W2-5 (`2893f36`) zrobiony przez osobny indeks, bez dalszych hunków W2-3 (ich przeniesienie bloku przed stop L2 zostało w drzewie roboczym). Historii nie przepisywałem.

### Testy
- `test-build-validate-invincible` 41 (+3: W2-1 ref bazowy + level w ops/replace, konflikt odwrotny z `mainRef`; W2-2 ścieżki L1/L2/wynik narzędzia/pozostałości, ops bez zmian; W2-5 Hard Times bez liczby z książki w wyniku modelu i z `gm` u MG; budżet: nota, `spentAfter`, etykiety limitu dodanego i usuniętego, `kept`). Zmienione: asercja `perOp` bez `spent`, test Hard Times P1-F, `deepEqual` wyniku `replaceToOps` (nowe pola).
- Reszta `dev/test-*.mjs` zielona (ops 34, snapshot 32, catalog 20, harness 31, packs 23, prompt-texts 11, transport 27, dry-transport 12, enhance 22, migrate-id 18, vendor OK).
- Nie sprawdzone na żywo (tor nieużyty): prawdziwy katalog (czy każdy prawdziwy podzielony Major/Massive ma dokument bazowy jako ref indeksu; tak wynika z `catalog.mjs:281`), prawdziwy model.

## W2-3, W2-4: rola talentu w karcie, chudsze get_entries, dane zawodu i archetypu (D-C, D-G, D-H)

Data: 2026-11-17. Pliki: `reader.mjs`, `snapshot.mjs`, `catalog.mjs`, `validate.mjs` (tylko ostrzeżenie `talent.role.shift`: komunikat, funkcja `talentShifts`, jeden blok przed stopem L2), testy `dev/test-build-snapshot.mjs`, `dev/test-catalog-invincible.mjs`; spec 6.0 (tylko format linii talentu). `tools.mjs` bez zmian (niepotrzebne). Wendor bez zmian (`sync.mjs --check` OK). Commity `c1eaed3` (W2-3), `6eaacac` (W2-4) i commit dokumentów.

### Defekty sprawdzone przed zmianą
- D-C: potwierdzone. `snapshot.mjs` sortował talenty po nazwie (`orderItems`), rola brała się z kolejności kolekcji (`reader.mjs` `chargenStateFromActor`, talenty[0]/[1]), skrót zasad mówi „pierwszy talent = talent bohatera”. W `dry2-spider` blok pokazywał "Knowledgeable (Natural Sciences)" przed "Sharp-Tongued" (talent bohatera); model zapisał to w friction-log (pkt 4).
- D-G: potwierdzone w kodzie (`slotNote` w każdym wpisie, `levels` z tym samym refem dla mocy niedzielonych, pełne automatyzacje) i w `dry2-*`: wyniki get_entries 10 wywołań, 39,2k znaków; `slotNote` 5,9k, automatyzacje 4,4k, `levels` 1,2k.
- D-H: potwierdzone: `occupationFacts` było w katalogu, ale get_entries zwracał tylko `rulesText`; linia zawodu w indeksie `ref|name|summary`; archetyp miał `structured` tylko z plus-ultra. W `dry2-*` zawód czytany drugi raz w 3 z 4 budów.

### Czy op może zachować rolę (zbadane)
- Kolejność kolekcji = kolejność tablicy `items` w `_source`. Serwer v14 zapisuje w dokumencie rodzica uporządkowaną listę id (`EmbeddedCollectionField._dbWrite`) i odczytuje ją `getMany` w tej kolejności (`resources/app/dist/database/fields-extensions.mjs`), więc kolejność przeżywa przeładowanie [V: kod serwera + tor 8: kolejność i role te same po przeładowaniu strony]. Pole `sort` (przeciąganie na karcie) nie ma wpływu na rolę.
- Writer dokłada nowe przedmioty zawsze na koniec (fazy tworzenia, w kolejności op). Zamiana talentu bohatera (remove + add) przesuwa więc role: dawny talent zawodu zostaje talentem bohatera, nowy talentem zawodu. Op nie może tego uniknąć, chyba że model usunie i doda ponownie talenty, które mają stać za nowym (test: wtedy brak ostrzeżenia).
- Dlatego: ostrzeżenie `talent.role.shift` (ops: rola zachowanego talentu inna niż teraz; replace: rola inna niż wynika z miejsca w `proposal.talents`; zachowane przedmioty replace zostają na swoich miejscach). Liczone przed stopem L2, więc model widzi je razem z błędami reguł. W replace ścieżkę przepisuje mechanizm W2-2 (`proposal.talents[i]`).

### Co zmienione
- W2-3: `talentRoles`, `talentRolesOf`, `talentRoleShifts` w `reader.mjs` (czyste). `readActor` daje wierszom talentów bohatera `role`; linia: `I <id> talent "Nazwa" role=hero|occupation|extra ref=...`. Talenty w kolejności kolekcji, reszta przedmiotów bez zmian (drzewo/nazwa). Zmiana roli = linia `~` w `<sheet_update>` (klucz linii to id, więc kolejność nie robi diffu). NPC bez `role=`.
- W2-4 get_entries: bez `slotNote` (żaden rodzaj); moc: `split: true` + `levels` tylko dla mocy dzielonych, inaczej `maxLevel`; bez `splitLevels`; `automations` = same nazwy (typ, gdy nazwy brak); `script: true` także gdy skrypt ma automatyzacja; gear/vehicleWeapon: `gear.attack { bonus, damage, range, bypassArmor? }`; zawód: `resources` + `talents` (nazwy); archetyp bez danych z plus-ultra: `structured { role, attrs, powers:[{ name, level, ref, boosts:[{name, ref}], note? }] }` z nowego `archetypeFacts(html, cat)` (ten sam odczyt co plus-ultra `parseArchetypes`).
- W2-4 indeks: sekcja zawodów `ref|name|resources|occupation talents|summary`. Pozostałe linie indeksu bajt w bajt bez zmian (sprawdzone na żywo). sampleHero nietknięte (D-8).

### Zmierzone (tor 8, kopia świata invincible, prawdziwe invincible-core, plus-ultra aktywny; tylko liczby)
- Indeks: 52 370 -> 53 232 znaków (+862, ~+246 tok przy znaki/3,5). Prefiks statyczny z próby R2 81 200 -> ~82 062 znaków (~23,2k -> ~23,4k tok). Zmiana prefiksu = jeden ponowny zapis cache (najlepiej razem z W2-8).
- get_entries, średnia znaków JSON na wpis, przed -> po (zmiana sumy): power 1229 -> 805 (-35 %), boost 441 -> 321 (-27 %), limit 488 -> 272 (-44 %), powerSource 324 -> 194 (-40 %), talent 475 -> 286 (-40 %), drawback 750 -> 598 (-20 %), gear 374 -> 281 (-25 %), vehicleWeapon 402 -> 288 (-28 %), occupation 943 -> 935 (-1 %: `slotNote` zamieniona na `resources`/`talents`), archetype 2198 -> 2091 (-5 %), npcProfile 622 -> 561 (-10 %), sampleHero 1972 -> 1901 (-4 %).
- Na mieszance rodzajów z R2 (moce, talenty, wady, źródła, zawody, archetypy) to około -30 % tekstu wyników get_entries; do tego zawód nie wymaga już czytania (Resources i talenty w indeksie), co w R2 było 1 wywołaniem w 3 z 4 budów. Oszacowanie, nie pomiar na modelu.
- Zawody: 22/22 mają Resources i 3 talenty. Archetypy (`archetypeFacts`): 16/16 z rolą, 6 atrybutami i mocami; 62/62 mocy i 6/6 boostów z refem; zgodność z plus-ultra `getArchetype`: nazwy mocy 16/16, poziomy 16/16, atrybuty 16/16, rola 16/16.
- W2-3 na żywo: aktor ZZ-W23 z 3 talentami tworzonymi w kolejności innej niż alfabetyczna: blok w kolejności tworzenia, role hero/occupation/extra; po przeładowaniu strony to samo; walidacja usunięcia talentu bohatera + dodania nowego daje 2 x `talent.role.shift` (2. talent occupation -> hero, 3. extra -> occupation), warstwa L4. Aktor usunięty, świat toru przywrócony (`lane8.ps1 restore`), slot oddany.

### Teksty do zmiany w W2-8 (prefiks; tu NIE ruszane)
- `rules-digest.mjs` l. 48 (talenty): "Order sets the role: the first talent (on the sheet and in a proposal's list) is the hero talent..." -> rola jest widoczna jako `role=` na linii talentu; nowy talent zawsze trafia na koniec, więc zamiana talentu bohatera/zawodu przesuwa role (ostrzeżenie `talent.role.shift`; żeby zachować role, usuń i dodaj ponownie talenty, które mają stać za nowym); w replace lista nadal w kolejności bohater, zawód, reszta.
- `rules-digest.mjs` l. 52 (zawód): wspomnieć, że indeks podaje Resources i talenty zawodu w kolumnach, get_entries zawodu zbędne przy budowie.
- `tools.mjs` opis `get_entries`: usunąć "and a slot/cost note"; "levels (split-level powers: one ref per level)" -> "levels only for split powers (one ref per level), else maxLevel"; "automations (numbers only)" -> "automation names"; zawód: pola `resources` i `talents`; archetyp: `structured` (rola, atrybuty, moce z refami) zawsze, nie tylko z plus-ultra.
- `harness-prompt.mjs` (D-O razem z W2-8): zawód można wybrać z indeksu bez get_entries.
- Nagłówek indeksu (`catalog.mjs indexText`, kod, już zmieniony): kolumny zawodu; przy W2-8 sprawdzić, czy skrót zasad nie opisuje kolumn inaczej.

### Otwarte wybory (zachowanie tymczasowe)
| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| W3-1 | Przesunięcie ról przy zamianie talentu | Tylko ostrzeżenie. Alternatywa: writer sam usuwa i tworzy ponownie (z `keepId`) talenty stojące za nowym, żeby trafiły za niego (id zostają, rola zachowana); więcej zapisów i grup cofania. |
| W3-2 | `role=` dla NPC | Brak (NPC nie ma ról talentów). |
| W3-3 | Brak tekstu zawodu | 2. talent = `extra` (jak plus-ultra import.mjs i walidator). |
| W4-1 | `slotNote` | Nigdy (nie "raz na rodzaj"): wszystko jest w skrócie zasad, a rzeczy właściwe dla wpisu są polami (`maxLevel`, `levels`, `power`, `needs`, `gear`). |
| W4-2 | Automatyzacje | Same nazwy; liczby ataku tylko dla gear/vehicleWeapon w `gear.attack`; moce mają liczby w `rulesText`. |
| W4-3 | Talenty zawodu | Nazwy (bez refów) w indeksie i w get_entries; ref model bierze z indeksu talentów; "Knowledgeable" = każdy wariant (skrót zasad). |
| W4-4 | Archetyp | `structured` z plus-ultra, gdy odpowie; inaczej `archetypeFacts` (ten sam kształt, na żywo zgodny 16/16). Alternatywa: zawsze własny odczyt (bez zależności od plus-ultra). |
| W4-5 | `rulesText` zawodu | Zostaje (opis zawodu, relacje). Do decyzji: pominąć, gdy są `resources`/`talents` (~-0,6..0,8k znaków na odczyt zawodu). |
| W4-6 | Kolumny zawodu w indeksie | Nazwy talentów pełne (bez skrótów), separator ", ". |

### Uwaga o commicie W2-2
Commit `36f0ed5` (agent W2-1/2/5) objął wczesne hunki W2-3 w `validate.mjs` bez `reader.mjs`; HEAD nie importował się do czasu mojego `c1eaed3` (reader + przeniesienie bloku przed stop L2). Po `c1eaed3` sprawdzone na czystym `git archive HEAD`: snapshot 32, catalog 20, validate 41.

### Testy
- `test-build-snapshot` 32 (+4: role w kolejności kolekcji / bez zawodu / NPC bez roli / zgodność ze stanem chargen; zmiana roli = linie `~`; `talentRoleShifts` czyste; `talent.role.shift` w ops (zamiana bohatera, dodanie extra bez ostrzeżenia, ponowne dodanie zawodu bez ostrzeżenia) i w replace (odwrócona lista)); zmienione: test kolejności (talenty wyłączone) i linia talentu z `role=hero`.
- `test-catalog-invincible` 20 (+1: `archetypeFacts` z refami, poziomem dokumentu podzielonego, boostem, notatką, brakującą mocą; get_entries bez plus-ultra; zmienione: get_entries bez `slotNote`/`levels` dla niedzielonych, automatyzacje jako nazwy; P1-F: linia zawodu z Resources/talentami, `-` bez danych, get_entries zawodu).
- Wszystkie `dev/test-*.mjs` zielone; `sync.mjs --check` OK.
- Niesprawdzone: zachowanie prawdziwego modelu z `role=` i nowymi polami (powtórka próby na sucho, W2-13); `count_tokens` (T8); szuflada T7.
