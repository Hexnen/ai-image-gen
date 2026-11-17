# P1-A / P1-B: teksty promptu, opisy narzędzi, skrót zasad: notatki i otwarte wybory

Data: 2026-11-17. Źródło zadań: `dev/dry-run/analysis-1.md` (P1-A, P1-B). Zmienione wyłącznie stałe tekstowe: `HARNESS_RULES` (`scripts/build/harness-prompt.mjs`, wersja 2), opisy w `readToolDefs` (`scripts/systems/invincible/tools.mjs`), `TOOL_DESC` (`validate.mjs`), `PROPOSAL_GUIDE` (`proposal.mjs`), `rulesDigest` (`rules-digest.mjs`, `DIGEST_VERSION` 2). Test: `node dev/test-prompt-texts.mjs` (11).

## Co i dlaczego (problem z próby na sucho -> zmiana)
- read_rules 13 wywołań, 44 % tekstu wyników, opis zachęcał do „occupations in full” -> system[0]: strona zasad tylko na pytanie MG o zasady albo gdy skrót nie wystarcza; opis `read_rules` to samo + „nigdy dla jednego zawodu/archetypu, użyj get_entries”; opis `get_entries` mówi, co daje ref zawodu (Resources, lista talentów) i archetypu.
- search_catalog przy indeksie w prompcie -> system[0] i opis: indeks już ma każdy wpis z refem; szukać tylko gdy indeks nie wystarcza. Pusta lista `forPower` -> opis: „pusta lista = moc nie ma boostów ani limitów”.
- check_proposal przed identycznym submit (6 z 7) -> system[0] „Submit directly”, opisy obu narzędzi: check tylko do porównania wariantów / wyceny zmiany, której nie proponujesz.
- Ranga z wiadomości MG inna niż w nagłówku (Daredevil, cała tura) -> system[0] (ogólnie: ustawienia szuflady) i skrót (`rank=<key>(drawer|flag|default)`, „(default)” = nikt nie wybrał): bez narzędzi, jedno zdanie z prośbą o zmianę w szufladzie (D-11).
- Odwołania: system[0] mówił „tylko refy zwrócone przez narzędzie”, a indeks jest w prompcie -> „z indeksu w tym prompcie albo z wyniku narzędzia”.
- PROPOSAL_GUIDE: notatka najwyżej `NOTE_MAX` (60) znaków, bez nawiasów w środku (przykład Kingpin); `texts.occupation` = angielska nazwa z katalogu; `relationships` = linie „NPC: Name (who they are)” / „Hero: Name” (to czyta `reader.mjs` i reguła `npc.name.blank`); `reputation` = wartość rangi, `resources` = Resources zawodu (replace: podaj oba); moc dzielona: ref bazowy + level albo ref poziomu.
- Skrót (P1-B): legenda linii VALID i bloku budżetu (budget/points, spent, slots, cap, drawbacks, xsrc/xtal = extraSources/extraTalents, ocena po `budget.after`, perOp = zmiany narastające w kolejności listy); kolejność talentów (1. bohatera, 2. zawodu, reszta dodatkowe); talent bohatera bez archetypu = dowolny; warianty Knowledgeable (temat) liczą się jako talent zawodu, gdy lista zawodu ma Knowledgeable; wartości zapisywane przy kreacji (reputacja = wartość rangi, efekty dodają; Resources = wartość zawodu); zdanie o Hard Times (D-3); `texts.occupation` = angielska nazwa. Usunięte zdanie „Reputation starts at the rank value” z wartości pochodnych (reputacja jest zapisywana, nie liczona).
- Bez prozy z podręcznika: tylko nasze sformułowania i liczby z wendorowanego `rules.mjs` (tabela rang, limity talentów/wad).

## Otwarte wybory (zachowanie tymczasowe)
| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| D-3 | Hard Times: -1 (efekt paczki) czy -2 (podręcznik) | Zostaje -1. Skrót: wpisz wartość Resources zawodu; każde Hard Times obniża efektywne Resources o 1 przez efekt przedmiotu („book prints 2; the builder follows the system's effect”). Komunikat walidatora `drawback.hardTimes` (wartość zapisana i efektywna) należy do P1-F, nie zmieniony tutaj. |
| D-6 | Niejednoznaczna prośba: pytać czy wybierać | Wybierz najlepiej pasujące do koncepcji, wyślij, w podsumowaniu nazwij główną alternatywę. Pytaj przed wysłaniem tylko gdy trzeba zmienić ustawienie szuflady (ranga) albo usunąć przedmioty spoza katalogu / edytowane ręcznie (przybliżenie „zrobionych przez MG”: model nie zna autora, widzi `custom` / `edited`). |
| PA1 | Notatka w wyniku `search_catalog` przy pustym `forPower` („this power has no boosts or limits” / „no power with this name or ref”) | Nie zrobiona: zmiana w kodzie `run()` w `tools.mjs` została zablokowana przez zasadę „tylko stałe tekstowe”. Tymczasowo tylko zdanie w opisie narzędzia. Do zrobienia przez agenta od kodu (kilka linii w `case "search_catalog"`, z testem w `test-catalog-invincible.mjs`). |
| PA2 | Język słów osobowości (D-7) | Bez zmian (D-7 otwarte). |
| PA3 | Opis perOp w skrócie | Ogólny („zmiany narastające w kolejności listy; oceniaj po budget.after”), żeby pozostał prawdziwy po P1-C (adnotacje per op). Po P1-C można dopisać znaczenie adnotacji. |

## Rozmiar prefiksu (szacunek lokalny znaki/3,5, `estimateTokens`; indeks katalogu = system[2] z próby na sucho, 52 370 znaków, bez zmian)
| Blok | Przed (znaki / tokeny) | Po |
|---|---|---|
| tools (6, JSON) | 18 444 / 5 270 | 19 397 / 5 542 |
| system[0] harness | 1 750 / 500 | 2 772 / 792 |
| system[1] skrót | 4 376 / 1 251 | 5 846 / 1 671 |
| system[2] indeks | 52 370 / 14 963 | 52 370 / 14 963 |
| razem | 76 940 / 21 984 | 80 385 / 22 968 (+984, +4,5 %) |
„Przed” zgadza się bajtowo z rozmiarami z `req/0001.json` próby (18 444 / 1 750 / 4 376 / 52 370). Zapis 1 h tej różnicy ~0,004 USD na zimny prefiks; analiza szacuje -10..-12 żądań na 4 testy.
Uwaga: `check_proposal` + `submit_proposal` razem 15 474 znaków JSON; test `test-build-validate-invincible.mjs` ma próg 16 000 (zostało ~500 znaków na dopiski do `PROPOSAL_GUIDE`, który jest tylko w opisie submit; schemat jest w obu narzędziach).

## Zweryfikowane / niezweryfikowane
- Zweryfikowane (node): `test-prompt-texts` 11/11 (stabilność bajtów w procesie i w dwóch świeżych procesach, brak znaczników arkusza / dat / id / nazw testowych postaci w system[], flagi treści, legenda VALID zawiera każdy klucz drukowany przez `snapshot.mjs validLine`, sufit 8 500 tokenów bez indeksu); regresja: test-catalog-invincible 15, test-build-validate-invincible 28, test-harness 27, test-packs 23, test-build-ops 30, test-build-snapshot 25, test-transport 27, test-dry-transport 12.
- NIE zweryfikowane: czy prawdziwy model (albo zastępca) faktycznie wykonuje mniej wywołań (potrzebna powtórka próby na sucho na 4 postaciach); rzeczywiste tokeny i koszt (`count_tokens`, T8); zachowanie przy regule rangi i D-6 w rozmowie.
