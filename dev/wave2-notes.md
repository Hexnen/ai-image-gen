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
