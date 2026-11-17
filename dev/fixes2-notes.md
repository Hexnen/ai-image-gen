# Poprawki P1-C/D/E/F/G (analiza próby na sucho 1): wybory i weryfikacja

Zakres: P1-D (notatki), P1-E (jeden format ref), P1-C (kolejność op + czytelny koszt), P1-F (zawód / Resources / reputacja), P1-G bez decyzji (rank.differs bez `suggest`, `rank` w apply, ostrzeżenie `rank.defaulted`). Nie zrobione: D-2 (ranga zapisywana na aktorze), P1-H, P2/P3.

## Co zmieniono
- `names.mjs` (nowy, czysty): zrównoważony nawias końcowy "Nazwa (notatka)" (`splitNote`, `baseName`, `noteOf`, `normBase`), `cleanNote` (nawiasy w notatce -> ", " / usunięte, cięcie na granicy słowa przy `NOTE_MAX` = 60), `withNote`. Jedno źródło dla czytnika, walidatora, katalogu, writera i replace.
- Czytnik: ref = krótki prefiks katalogu (`sources:`, nie `power-sources:`); `catalog.get`/`levelOf` przyjmują też długie nazwy paczek (`shortRef`).
- `normalize`: notatki w `ops[].note`, `ops[].set.note`, `proposal.powers/talents/drawbacks[].note` czyszczone; nawiasy -> autoFixed, cięcie -> ostrzeżenie `note.cut`. Writer i replace tną tak samo (`writeNote`).
- `replaceToOps`: op `updateActor` pierwszy (`act1`); koszt per op liczony z op aktora najpierw, lista w kolejności op, każde wejście ma `label` ("occupation talent (free)", "extra talent -1 pt", "+1 slot (slots 3/4) -2 pts", "(…, over the rank)").
- Katalog: `occupationFacts(text)` -> `{ resources, talents }` z sekcji zawodu; wpisy zawodów mają te pola.
- `creationIssues` (tylko profil creation, bohater): `occupation.unknown`, `resources.occupation`, `talent.occ.list`, `reputation.rank` (ostrzeżenia). Replace w creation: brak reputacji -> wartość rangi + info `reputation.defaulted`.
- P1-G: `rank.differs` bez `suggest` (wektor byłby dla złej rangi), nowy tekst; `rank.defaulted` (ostrzeżenie), gdy ani szuflada, ani flaga plus-ultra nie podają rangi; writer `apply` przekazuje `rank` + `profile` do konwersji i kopiuje `rank.defaulted`; nagłówek writer.mjs dokumentuje `rank` jako WYMAGANE dla bohatera.
- Spec 7.5 pkt 4 (koszt per op) poprawiony: talent bohatera i zawodu darmowe, każdy dodatkowy -1, pierwsze źródło darmowe, op aktora najpierw, `label`.

## Otwarte wybory (zachowanie tymczasowe)
- F1 (D-3): Hard Times zostaje -1 w budżecie; info `drawback.hardTimes` podaje wartość zapisaną, efektywną i z książki. Do decyzji, czy zapisywać inaczej.
- F2 (D-4): niezgodność zawodu / Resources / talentu zawodu / reputacji = OSTRZEŻENIA, tylko profil creation; własny lub nieznany zawód (`occupation.unknown`) pomija dalsze kontrole. Alternatywa: błędy.
- F3: domyślna reputacja (wartość rangi) tylko przy replace w creation i tylko gdy pole puste; w ops nic nie jest uzupełniane.
- F4: brak rangi = ostrzeżenie `rank.defaulted` i walidacja jako Global, nie odmowa. Odmowa możliwa po D-2.
- F5: autopoprawka notatki zamienia "(" na ", " i usuwa ")"; nie odrzuca.
- F6: cięcie notatki na granicy słowa przy 60 znakach (całe słowo dłuższe niż limit: twarde cięcie).
- F7: `useCatalogLookup` nie jest podpięty do katalogu T4 (brak `descHash`/`autoSig` w katalogu); naprawiony tylko prefiks czytnika + akceptacja długich nazw w `catalog.get`.
- F8: etykiety kosztu (wolny talent bohatera/zawodu, które źródło jest pierwsze) liczone ze stanu końcowego, nie pośredniego.
- F9: pokazywanie wszystkich ostrzeżeń (bez filtra „tylko nowe” względem stanu wyjściowego) tylko w creation + replace; w ops filtr zostaje.
- F10: dopasowanie nawiasu jest zrównoważone (zagnieżdżone nawiasy); dla zwykłych nazw wynik = wzorce plus-ultra (test zgodności), dla nazw z zagnieżdżeniem różni się celowo.

## Weryfikacja
- Testy: `test-build-validate-invincible` 38, `test-build-snapshot` 28, `test-catalog-invincible` 18, `test-build-ops` 32, reszta `dev/test-*.mjs` zielona; `sync.mjs --check` OK (vendor bez zmian).
- Na żywo, tor 20 (świat testowy `invincible`, aktor `ZZ-AIGEN-P1 note`, potem usunięty):
  - `occupationFacts`: 22/22 zawody z prawdziwego podręcznika mają Resources (2-6) i 3 talenty; wszystkie 66 talentów istnieją w katalogu.
  - Czytnik na 85 bohaterach: 722 refy, prefiksy `sources/powers/boosts/talents/drawbacks/limits`, wszystkie rozwiązywane przez `catalog.get`; długi prefiks `power-sources:` też.
  - Writer: notatka "Kingpin (Wilson Fisk) …" (ponad 60 zn.) -> autoFixed + `note.cut`, przedmiot "Targeted (Kingpin, Wilson Fisk and every one of his hired thugs across)", koszt "drawback +1 pt".
  - `rank.defaulted` pojawia się bez rangi w opcjach.
  - `creationIssues` na 85 przykładowych bohaterach (świadomie w creation): 62 x resources, 55 x reputacja, 48 x talent zawodu, 3 x nieznany zawód (Creative / Operative / Technical). To bohaterowie rozwinięci w grze, więc oczekiwane; pokazuje, że w creation na takich aktorach ostrzeżeń będzie dużo (w ops filtr „tylko nowe” je ukrywa).
- Niesprawdzone: pełna sesja z modelem (brak klucza), szuflada T7 z nowymi etykietami, powtórka próby na sucho.
