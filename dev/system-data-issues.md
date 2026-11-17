# Problemy w danych systemu / książki (notatka dla właściciela)

Źródło: próby na sucho rundy 1-3 (`dev/dry-run/analysis-3.md`, ustalenie 18) i zadanie W3-16. Bez zmian w kodzie.
Bez prozy z podręcznika: tylko nazwy pozycji, nazwy pól, liczby i krótkie streszczenia.

Gdzie leżą dane: wszystkie pozycje poniżej są w paczkach modułu książki `invincible-core` („Invincible - Core Rules” 1.0.2, autorzy Hod Publishing), NIE w paczkach systemu `invincible` 2.1.8 (system ma tylko `critical-injuries`, `rolltables`, `macros`, `basic-data`). Oba są cudze i tylko do odczytu dla nas.

Jak sprawdzone (2026-11-17): kopia folderów paczek `invincible-core` w scratchpadzie (oryginał nietknięty, bez serwera, bez toru), odczyt LevelDB przez `classic-level` z instalacji Foundry. Wynik: pola i liczby niżej. „Zweryfikowane” = widziane w tej kopii. Na żywo w Foundry (jak efekt działa na aktora) nic tu nie było sprawdzane.

Kolumna „kto”: **opiekun** = opiekun treści `invincible-core` (Hod Publishing, zgłoszenie u nich); **właściciel** = Ty (decyzja albo zmiana po naszej stronie).

## 1. Camouflage: literówka w kluczu efektu

- **Gdzie:** `invincible-core`, paczka `powers`, przedmiot „Camouflage” (typ power), efekt nazwany „Illusion - Major”, pole `changes[0].key`.
- **Co jest źle:** klucz `bonus.intuiton` (brak litery „i”; atrybut to `intuition`). Efekt ma też `transfer: false`, więc i tak nie przechodzi na aktora (w naszym bloku `<sheet>` widać go jako `^bonus.intuiton-1`, `^` = nieprzenoszony, snapshot.mjs). Nazwa efektu nie pasuje do przedmiotu (moc „Illusion” w tej paczce nie ma żadnego efektu, więc to nie jest prosta kopia stamtąd).
- **Dowód:** zmiana `{ key: "bonus.intuiton", type: "add", value: -1 }`, `transfer: false`, `disabled: false`. Literówka występuje tylko w tym jednym efekcie (przeszukane paczki powers, talents, drawbacks, power-sources). Tekst mocy mówi o atrybucie Intuition.
- **Proponowana poprawka:** klucz `bonus.intuition`; opiekun decyduje, czy efekt ma być przenoszony i jak ma się nazywać.
- **Kto:** opiekun. U nas nic do zrobienia (czytnik pokazuje efekt wiernie).
- **Status:** zweryfikowane.

## 2. Obsessed: inny atrybut niż w tekście, kara -1 na wszystkie pozostałe atrybuty naraz, efekt stale włączony

- **Gdzie:** `invincible-core`, paczka `drawbacks`, przedmiot „Obsessed” (typ drawback), efekt „Obsessed”, pola `changes[]`, `disabled`.
- **Co jest źle:**
  - kara -3 jest na `bonus.reason`, a tekst wady daje -3 do rzutów innego atrybutu (Intuition, na zauważanie);
  - efekt daje -1 do pięciu pozostałych atrybutów (`intuition`, `agility`, `strength`, `presence`, `fighting`) na stałe; tekst daje -1 tylko sytuacyjnie (gdy obiekt obsesji jest obecny, o rzutach decyduje MG);
  - `disabled: false`, `transfer: true`: kara działa zawsze, od chwili dodania wady. Razem -8 do atrybutów na stałe.
- **Dowód:** 6 zmian: reason -3, pięć atrybutów po -1; `disabled: false`, `transfer: true`; automatyzacja typu `toggleActiveEffect`. Dla porównania punkt 3 (Martial Arts): efekt sytuacyjny jest tam domyślnie wyłączony.
- **Skutek u nas:** w rundzie 3 bohater w stylu Batmana (wada Obsessed) osłabił się sam, bo model nie widział kary w indeksie. Po W3-13 (commit `55394a1`) kolumna `fx` w liniach wad pokazuje skrót efektu, więc model ją widzi.
- **Proponowana poprawka:** -3 na `bonus.intuition` (albo bez stałej zmiany atrybutu, bo kara dotyczy tylko części rzutów) i efekt domyślnie wyłączony (`disabled: true`), żeby MG włączał go przełącznikiem, jak w Martial Arts.
- **Kto:** opiekun (dane). Właściciel: czy model ma odradzać Obsessed przy budowie, dopóki dane są takie (dziś tylko informacja w `fx`).
- **Status:** zweryfikowane (dane); skutek na arkuszu widziany w rundzie 3.

## 3. Martial Arts: efekt wyłączony, a Obsessed nie (niespójność)

- **Gdzie:** `invincible-core`, paczka `talents`, przedmiot „Martial Arts” (typ talent), efekt „Martial Arts”, pole `disabled`.
- **Co jest źle:** samo w sobie nic: kara -2 dotyczy tylko jednego rodzaju ataku, więc wyłączenie domyślne jest rozsądne. Problemem jest brak jednej reguły: dwa efekty sytuacyjne, jeden domyślnie wyłączony (Martial Arts), drugi włączony (Obsessed, punkt 2).
- **Dowód:** zmiana `{ key: "system.derived.slugfest.bonus", value: -2 }`, `disabled: true`, `transfer: true`, automatyzacja `toggleActiveEffect`.
- **Proponowana poprawka:** jedna reguła dla efektów sytuacyjnych w paczkach (domyślnie wyłączone, przełącznik w automatyzacji).
- **Kto:** opiekun. U nas: kolumna `fx` oznacza efekty wyłączone (W3-13).
- **Status:** zweryfikowane.

## 4. Hard Times: -2 w tekście, -1 w efekcie

- **Gdzie:** `invincible-core`, paczka `drawbacks`, przedmiot „Hard Times” (typ drawback), efekt „Hard Times”, pole `changes[0].value`; tekst w `system.description`.
- **Co jest źle:** tekst obniża Resources o 2 (z minimum), efekt odejmuje 1. Minimum z tekstu nie da się zapisać zmianą typu `add` (czy system gdzieś przycina Resources do minimum: niesprawdzone).
- **Dowód:** zmiana `{ key: "system.resources", type: "add", value: -1 }`, `disabled: false`, `transfer: true`. Wadę można brać wiele razy (vendor `rules.mjs`, `DRAWBACK_LIMITS`), więc różnica rośnie z każdym egzemplarzem.
- **Stan u nas:** decyzja D-3 (tymczasowa): model widzi jedną liczbę, -1 z efektu; liczba z książki tylko dla MG w polu `gm`. Uwaga `drawback.hardTimes` pojawia się tylko przy zmianie wad lub Resources (W3-7).
- **Proponowana poprawka:** opiekun: `value: -2` i obsługa minimum. Właściciel: potwierdzić D-3 albo przejść na -2 z książki.
- **Kto:** opiekun (dane), właściciel (D-3).
- **Status:** zweryfikowane (dane); przycinanie do minimum niesprawdzone.

## 5. Signature Item: zastępnik `[attribute]` w kluczu efektu, brak skalowania z poziomem

- **Gdzie:** `invincible-core`, paczka `powers`, przedmiot „Signature Item” (typ power), efekt „Signature Item”, pole `changes[0].key` i `value`.
- **Co jest źle:** klucz `bonus.[attribute]` to szablon, nie ścieżka: efekt nie podnosi żadnego atrybutu (w rundzie 3 arkusz pokazał dosłownie `bonus.[attribute]+2`). Wartość stała +2, a tekst mocy podaje premię rosnącą z poziomem (w tekście cztery wartości od +2 do +5). W paczce jest jeden dokument (pole `level` puste), bez osobnych dokumentów na poziomy.
- **Dowód:** zmiana `{ key: "bonus.[attribute]", type: "add", value: 2 }`, `disabled: false`, `transfer: true`; zastępnik `[...]` w kluczu tylko w tym jednym efekcie (przeszukane powers, talents, drawbacks, power-sources).
- **Stan u nas:** W3-9: ostrzeżenie `effect.placeholder` (model: wybór atrybutu w notatce; MG w `gm`: efekt trzeba poprawić ręcznie). Podstawianie klucza i wartości per poziom przez writer czeka na decyzję D-13.
- **Proponowana poprawka:** opiekun: wybór atrybutu w automatyzacji (np. wybór przy dodaniu) i wartość per poziom. Właściciel: D-13 (czy writer ma sam podstawiać atrybut i wartość z tabeli).
- **Kto:** opiekun (dane), właściciel (D-13).
- **Status:** zweryfikowane (dane); działanie efektu na aktora tylko z obserwacji rundy 3.

## 6. Archetyp Vigilante: źródła mocy, których nie ma w katalogu; znaczniki rzutów w tekstach archetypów

- **Gdzie:** `invincible-core`, paczka `core-book`, strona dziennika „Archetypes”, sekcja „The Vigilante”; paczka `power-sources`.
- **Co jest źle:**
  - sekcja Vigilante wymienia trzy źródła mocy: Ninjutsu, Utility Belt, Vengeful Spirit Possession. Paczka `power-sources` ma 36 pozycji i żadnej z tych nazw (najbliższe nazwy w paczce to np. „Peerless skill”, „Weapons proficiency”, „Cutting-edge inventions”, ocena podobieństwa nasza);
  - teksty archetypów mają znaczniki rzutów Foundry w podwójnych nawiasach kwadratowych: 160 na stronie, po 10 w każdym z 16 archetypów (rodzaje: `[[D3]]` x80, `[[D6]]` x64, `[[2D6]]` x16). W Foundry to rzuty inline, w tekście dla modelu to szum.
- **Dowód:** każda z trzech nazw występuje na stronie raz, w sekcji „The Vigilante”; lista nazw w `power-sources` sprawdzona w całości. Liczby znaczników policzone na stronie.
- **Stan u nas:** znaczniki: nasza sprawa, już zrobione w W3-13 (`catalog.mjs` zamienia `[[...]]` na sam wzór, commit `55394a1`). Brakujące źródła: D-10 tymczasowo (najbliższe źródło z katalogu + jedno zdanie w rationale).
- **Proponowana poprawka:** opiekun: dodać trzy źródła do `power-sources` albo w tekście archetypu wskazać istniejące. Właściciel: D-10 (najbliższe źródło czy własne źródło z nazwą i opisem).
- **Kto:** opiekun (brakujące źródła), właściciel (D-10). Znaczniki: zrobione u nas.
- **Status:** zweryfikowane. Niesprawdzone: czy inne archetypy też wymieniają źródła spoza katalogu.

## 7. Wendorowany `rules.mjs`: krótki cytat z książki, liczby rang, nazwy ról (pytanie do właściciela)

- **Gdzie:** `scripts/systems/invincible/vendor/chargen/rules.mjs` (kopia z plus-ultra, bajt w bajt ta sama co `invincible-plus-ultra/scripts/chargen/rules.mjs`, sprawdzone hashem; repo plus-ultra jest publiczne).
- **Co tam jest:**
  - linia 43: komentarz z krótkim cytatem z książki (około 8 słów, w cudzysłowie);
  - `RANKS` (linie 10-15): liczby rang (punkty atrybutów, limit atrybutu, sloty mocy, reputacja, ulepszenia);
  - `ROLES` (linia 17): 8 nazw ról drużyny.
  - Odwołań do stron nie znalazłem w żadnym pliku `vendor/` (szukane wzorce „page”, „p. NN”, „(NN)”); jeśli były w innym pliku plus-ultra, tu ich nie ma.
- **Uwaga:** nazwy rang z książki (`RANK_NAMES`) są w naszym `rules-digest.mjs`, nie w pliku wendorowanym.
- **Pytanie:** czy zostawić tak, jak jest (to samo co w publicznym repo plus-ultra), czy zamienić cytat z linii 43 na własne słowa? Zmiana musiałaby przejść przez plus-ultra i `sync.mjs` (plik jest wendorowany z hashem w `stamp.mjs`), nie przez edycję tutaj.
- **Kto:** właściciel.
- **Status:** zweryfikowane (zawartość i identyczność z plus-ultra).

## Niezweryfikowane

- Działanie efektów na żywym aktorze (punkty 1, 2, 5): tylko dane paczek + obserwacje rund 1-3; w tym zadaniu bez serwera.
- Czy system przycina Resources do minimum przy Hard Times (punkt 4).
- Inne archetypy niż Vigilante pod kątem źródeł spoza katalogu (punkt 6).
- Wersje: dane z `invincible-core` 1.0.2 na tym dysku; po aktualizacji modułu książki trzeba sprawdzić ponownie.
