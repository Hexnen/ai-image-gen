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
