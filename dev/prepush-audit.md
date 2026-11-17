# Audyt przed pushem (2026-11-17)

Zakres: 53 lokalne commity `origin/main..HEAD` (d8bef7b .. 3130e1b) do PUBLICZNEGO repo `https://github.com/Hexnen/ai-image-gen`,
plus drzewo robocze (czyste, 162 pliki). Audyt tylko do odczytu: nic nie wypchnięte, historia nie przepisana, żaden inny plik nie zmieniony.

Metody:
- `git fetch origin` (jedyna operacja sieciowa). `origin/main` = c756999 = tag `v0.1.0`; 53 commity na origin, 53 lokalnie przed nim, 0 za nim;
  `git merge-base --is-ancestor origin/main HEAD` = prawda, więc push `main` to fast-forward.
- Sekrety: regex (sk-ant-, sk-/sk-proj-, sk-or-v1-, AIza, `Bearer`, ghp_, github_pat_, xox, PRIVATE KEY) po `git log --all -p --text`
  (cała historia) + szukanie ścieżek lokalnych, e-maili, haseł, tokenów, adresów IP i hostów w drzewie i historii.
- Tekst książki: wszystkie paczki `invincible-core` (w tym journal core-book) i paczki systemu `invincible` (kopie w scratchpadzie,
  oryginały nietknięte) wyciągnięte do zwykłego tekstu i porównane 7-gramami słów z każdym plikiem tekstowym drzewa ORAZ z każdą
  wersją bloba w 53 commitach. Ciągi zgodne >= 7 słów są wymienione niżej. Tekstu książki nie cytuję tutaj, tylko miejsca.
- Zrzuty `dev/screenshots/*.png` (13): obejrzane wszystkie wizualnie; chunki metadanych PNG sprawdzone (brak tEXt/iTXt).

## Podsumowanie

| # | Waga | Ustalenie | Blokuje push? |
|---|------|-----------|---------------|
| A1 | WYSOKA | Zrzuty 04-08 (szczególnie 05-08) pokazują czytelną prozę książki (opisy mocy/talentów/wad) i grafikę komiksu Invincible | TAK (wg zasady projektu „tekst książki nigdy w repo”) |
| A2 | ŚREDNIA | Brak pliku LICENSE i ATTRIBUTION w publicznym repo z kodem vendorowanym z plus-ultra | nie (decyzja właściciela) |
| A3 | ŚREDNIA | module.json: adresy na stare repo, `manifest` latest + `download` v0.1.0 dają stary moduł `ai-image-gen`; wersja nadal 0.1.0 | nie (ale instalacja z manifestu jest teraz błędna) |
| A4 | NISKA | Ścieżka lokalna `C:\Users\<konto>\...` (nazwa konta Windows + id sesji) w 2 plikach dev | nie (zalecana redakcja) |
| A5 | NISKA | Krótkie dosłowne ciągi z książki w kodzie i testach (łącznie ~75 słów, najdłuższy 12) | nie |
| A6 | NISKA | Nazwy postaci Marvela/innych (Spider-Man, Peter Parker, Kraven, ...) w docs/testach/lang i na zrzutach | nie |
| A7 | INFO | Folder `dev/` (wewnętrzne notatki, analizy, RUNBOOK) jest w publicznym repo; spec nazywa moduł „prywatnym” | nie (decyzja właściciela) |
| A8 | INFO | Sekrety: brak prawdziwych kluczy; tylko jawnie fałszywe wartości testowe | nie |
| A9 | INFO | Rozmiar: 13 PNG = 6,9 MB (największy 826 KB); brak node_modules / buildów; .gitignore minimalny | nie |

Blokery: tylko A1. Ponieważ żaden z 53 commitów nie jest jeszcze publiczny, przepisanie lokalnej historii przed pushem jest tanie
i bezpieczne (nikt inny jej nie ma).

## A1 (WYSOKA): proza książki i grafika na zrzutach

Wszystkie zrzuty dodane w commicie **b0d3231** („AI builder T7: GM chat drawer docked to the actor sheet”); 09-10 w ffe2304, 11-13 w 3130e1b.

| Plik | Co widać (tekst książki, przybliżona liczba słów) |
|------|------|
| `dev/screenshots/05-after-apply-live.png` | opis źródła mocy Freak Accident (~25 słów), cały opis mocy Adhesion (~70), początek Danger Sense (~12) |
| `dev/screenshots/06-confirm-dialog.png` | to samo co 05 (Freak Accident ~25, Adhesion ~40 widoczne, Danger Sense ~12) |
| `dev/screenshots/07-after-edit-live.png` | talent Evasive (~10), cały talent Investigator (~70), początek wady Hard Times (~8) |
| `dev/screenshots/08-narrow-flipped.png` | Freak Accident (~25), Adhesion (~45) |
| `dev/screenshots/04-proposal-card.png` | bez prozy książki; wzmianka „The book text says -2 per Hard Times” to parafraza liczby |
| wszystkie 13 | tło arkusza z grafiką komiksu Invincible (kadry komiksu) z arkusza systemu/plus-ultra; logo „INVINCIBLE” |

Łącznie ~200 słów prozy podręcznika w obrazach (z powtórzeniami ~300). To łamie zasadę zapisaną w samym repo
(`dev/ai-gen-spec.md:516`, `dev/dry-run/analysis-1.md:5`: tekst książki nigdy w repo). Dodatkowo 09-13 nie mają prozy, ale mają kadry komiksu.

Środek zaradczy (NIE wykonany):
1. Usunąć `dev/screenshots/` z drzewa i dodać do `.gitignore` (zrzuty i tak służą tylko do przeglądu).
2. Usunąć je z historii przed pushem, np. `git filter-repo --path dev/screenshots --invert-paths --refs origin/main..main`
   (albo `git rebase -i origin/main` i poprawka b0d3231, ffe2304, 3130e1b). Zmienią się SHA wszystkich commitów od b0d3231;
   commity sprzed b0d3231 i origin/main zostają, więc push nadal będzie fast-forward.
3. Alternatywa minimum: podmienić 04-08 na zrzuty z arkuszem pustym/zamazanym (jak 01-03) i usunąć oryginały z historii jak wyżej.
   Samo `git rm` bez przepisania historii NIE wystarcza: bloby zostaną publiczne w historii.

## A2 (ŚREDNIA): licencja i atrybucja

- Brak `LICENSE`, `ATTRIBUTION*`, brak pola licencji w `module.json`. Publiczne repo bez licencji = „wszystkie prawa zastrzeżone”
  (inni mogą czytać, nie mogą legalnie używać/forkować). To decyzja właściciela, ale powinna być świadoma.
- Vendorowany kod: `scripts/systems/invincible/vendor/chargen/{rules,state,stamp}.mjs` = kopia bajt w bajt z `invincible-plus-ultra`
  (`MANIFEST.json`, `sync.mjs`); `scripts/providers/util.mjs:2` = port z `Hexnen/roleplay`. Ten sam autor, więc brak konfliktu licencji;
  `invincible-plus-ultra` też nie ma pliku LICENSE (sprawdzone), więc nie ma czego dziedziczyć ani niezgodności.
- Brak kodu stron trzecich (brak nagłówków `@license`/`Copyright`, brak node_modules, brak bibliotek).
- Treść/marki osób trzecich: „Invincible” (Skybound/Image), gra Invincible RPG (Free League, `rules-digest.mjs:28`), nazwy stron
  podręcznika i id stron journala w `rules-digest.mjs:73-96`, nazwy mocy/talentów w testach. Tylko nazwy i liczby mechaniki.

Środek zaradczy: dodać `LICENSE` (wybór właściciela, np. MIT dla kodu) i krótkie `ATTRIBUTION.md`: kod z invincible-plus-ultra i
Hexnen/roleplay (ten sam autor), zastrzeżenie, że Invincible i Invincible RPG należą do właścicieli, moduł nie zawiera tekstu podręcznika
i wymaga własnej licencjonowanej kopii `invincible-core`; ewentualnie `"license"` w module.json.

## A3 (ŚREDNIA): tożsamość repo i manifest

- `git remote`: `origin = https://github.com/Hexnen/ai-image-gen.git` (stara nazwa).
- `module.json:34-38`: `url`, `bugs`, `readme`, `manifest`, `download` wskazują `Hexnen/ai-image-gen` (świadomie, `dev/rename-notes.md:8`).
  - `manifest` = `releases/latest/download/module.json`: najnowsze wydanie (o ile istnieje; tag `v0.1.0` = c756999) ma `"id": "ai-image-gen"`.
    Instalacja nowego modułu z tego manifestu da STARY moduł o innym id. Wydania na GitHubie nie sprawdzałem (bez sieci poza fetch).
  - `download` = `.../download/v0.1.0/module.zip`: stary moduł.
  - `version` nadal `0.1.0` (`module.json:5`) mimo zmiany id i 53 commitów; Foundry nie zobaczy aktualizacji.
- README (`README.md:3, 76-97`) poprawnie opisuje zmianę id; folder danych celowo zostaje `Data/ai-image-gen/`.
- Historia: stara historia `ai-image-gen` (53 commity) jest przodkiem HEAD; zmiana id to zwykła kontynuacja (8052be1), nie konflikt.
  Push `main` = fast-forward (0 commitów za origin). Tag `v0.1.0` jest na origin i lokalnie na c756999, bez kolizji.

Co wymaga zmiana nazwy repo (decyzja właściciela, `gh repo rename` NIE uruchomione):
1. `gh repo rename moinens-ai-gen -R Hexnen/ai-image-gen` (GitHub przekierowuje stare adresy web, git i pobierania wydań).
2. `git remote set-url origin https://github.com/Hexnen/moinens-ai-gen.git`.
3. W `module.json` zmienić 5 adresów na nowe repo, podnieść `version` (np. 0.2.0), `download` na nowy tag.
4. Zrobić wydanie z `module.json` + `module.zip` nowego id, żeby `releases/latest/download/module.json` dawał `moinens-ai-gen`.
5. Stara instalacja `ai-image-gen` u kogokolwiek, kto ją ma z manifestu, po wydaniu dostanie manifest z innym id (Foundry odrzuci
   aktualizację); w praktyce tylko właściciel, a README opisuje przejście.
Kolejność: rename -> set-url -> zmiana module.json (osobny commit) -> push -> wydanie. Push przed rename też działa (przekierowanie).

## A4 (NISKA): dane osobowe i ścieżki lokalne

- `dev/dry-run/RUNBOOK.md:12`: pełna ścieżka `C:\Users\<konto>\AppData\Local\FoundryVTT\...` (nazwa konta Windows). Dodane w c817a88/1db729f/670a98a.
- `dev/review-bughunt-1.md:11`: ścieżka scratchpadu z nazwą konta i UUID sesji. Dodane w 670a98a.
- Pozostałe ścieżki są generyczne (`%LOCALAPPDATA%`, `C:\Users\x\...` w `dev/test-dry-transport.mjs:106`, `<scratchpad>`).
- E-mail autora w metadanych wszystkich 106 commitów: już publiczny przez 53 commity na origin; nic nowego.
- Zrzuty: brak kluczy (pole klucza nie jest widoczne; 09-10 pokazują tylko komunikat „Brak klucza API Anthropic”), brak e-maili;
  widać nazwę użytkownika „Gamemaster [MG]” i świat testowy (sceny „The Warehouse”), nic prywatnego.
Środek zaradczy: zamienić obie ścieżki na `<MOD>`/`%LOCALAPPDATA%`/`<scratchpad>`. Jeśli i tak robimy przepisanie z A1, można w tym samym
przebiegu wyczyścić te linie w historii (`git filter-repo --replace-text`); inaczej wystarczy zwykły commit z redakcją (niska waga).

## A5 (NISKA): dosłowne fragmenty książki w kodzie i testach

Wynik porównania 7-gramów (drzewo i wszystkie wersje w 53 commitach; historia nie zawiera nic ponad drzewo):

| Miejsce | Najdłuższy ciąg zgodny | Uwagi |
|---------|------|------|
| `scripts/systems/invincible/vendor/chargen/rules.mjs:43` | 9 słów (cytat ~8) | znany, w komentarzu; plik vendorowany (zmiana tylko w plus-ultra + sync) |
| `scripts/systems/invincible/catalog.mjs:131` | 11 | formuła wady w regexie (funkcjonalna, do rozpoznawania tekstu) |
| `scripts/systems/invincible/catalog.mjs:193` | 10 | ta sama formuła w regexie |
| `dev/test-catalog-invincible.mjs:438` | 12 | tekst „mock” = wada Cursed z wstawionym słowem „mock” |
| `dev/test-catalog-invincible.mjs:424` | 7 (zdanie ~28) | wada Vulnerable przerobiona na „mock”; drugie zdanie prawie dosłowne |
| `dev/test-catalog-invincible.mjs:442` | 7 (zdanie ~19) | j.w. |
| `dev/test-catalog-invincible.mjs:427-428` | 7 i 8 | talent Evasive i fraza o stresie, z „mock” |
| `dev/test-catalog-invincible.mjs:50-51`, `dev/test-build-validate-invincible.mjs:40-41` | 7 | fraza z wady Power Loss |
| `dev/test-catalog-invincible.mjs:364,368,399` | 7 | fałszywe trafienia (ciągi UUID `Compendium.invincible-core...`) |

Łącznie ~75 słów dosłownie, w krótkich formułach mechaniki. `rules-digest.mjs` jest faktycznie parafrazą (0 trafień), fixture
`dev/fixtures/invincible-sheets.mjs` wymyślony (0 trafień), dev/*.md: 0 trafień. Brak tekstu Quickstartu (0 trafień w paczkach systemu).
Środek zaradczy (opcjonalny): w testach zastąpić teksty „mock” zdaniami w pełni wymyślonymi z tą samą strukturą (rule summary testuje
strukturę, nie treść). Regexy w catalog.mjs i cytat w rules.mjs można zostawić (krótkie, funkcjonalne).

## A6 (NISKA): nazwy postaci i marek

67 wystąpień (Spider-Man, Peter Parker, Kraven, Norman Osborn, Daily Bugle, Daredevil, Nightcrawler, All Might, Batman) w
`dev/ai-gen-spec.md`, `dev/dry-run/*`, `dev/*-notes.md`, testach, `lang/en.json`, `lang/pl.json` (przykład „Złóż mi Spider-Mana”),
`scripts/build/builder-api.mjs`, i na zrzutach 05-08 (Spider-Man/Peter Parker). Nazwy, nie treść; ryzyko niskie.
Opcjonalnie: przykład w `lang/*.json` zamienić na postać z domeny publicznej lub własną.

## A7 (INFO): dev/ w publicznym repo

`dev/` (38 plików: spec, handoff, notatki fal, analizy prób na sucho, RUNBOOK, przeglądy) jest śledzony w tym publicznym repo, a
`dev/ai-gen-spec.md:516` i `:617` opisują moduł jako prywatny. W plus-ultra dev/ jest osobnym prywatnym repo. Brak tam sekretów
(poza A4), ale ujawnia wewnętrzny proces i porty torów. Decyzja właściciela: zostawić, przenieść do prywatnego repo jak w plus-ultra,
albo ograniczyć do testów.

## A8 (INFO): sekrety

Brak prawdziwych kluczy w całej historii (`--all`). Trafienia to jawne atrapy testowe:
`dev/test-transport.mjs` (`sk-ant-real-looking-0000000000`), `FAKE_KEY = "sk-ant-fake-test-key-..."`, `redactSecrets` test
(`sk-ant-api03-abcdefghijkl`), `FAKE = { openai: "sk-test-not-real-...", gemini: "AIza-test-not-real-gemini", ... }`,
`dev/test-dry-transport.mjs:26` (`TOKEN = "abcdefghijklmnop1234"`). Token przekaźnika (`dev/dry-run/relay.mjs:27`) losowany przy starcie,
nigdzie nie zapisany w repo; `relay.json` nie jest śledzony. Klucze API w ustawieniach `scope: "client"` (PLAN.md:9), nie w kodzie.
Brak haseł (jedyne `password:""` to pusty login MG na lokalnym torze w RUNBOOK). Brak hostów publicznych/IP poza 127.0.0.x i 192.168.1.5 (test).

## A9 (INFO): rozmiar i .gitignore

- Bloby > 200 KB w zakresie: tylko 13 PNG (6,9 MB). Reszta to tekst; największy `dev/test-build-ops.mjs` 102 KB.
- `.gitignore`: `node_modules/`, `*.log`. Brak śmieci w drzewie (`git status --ignored` pusty).
- Propozycja: dopisać `dev/screenshots/`, `*.zip`, `relay.json`, `dry-*/`, `.claude/` (zabezpieczenie na przyszłość).

## Kolejność proponowana (nic z tego nie wykonane)

1. A1: usunąć `dev/screenshots/` z historii zakresu (filter-repo/rebase) i dodać do `.gitignore`.
2. A4: zredagować 2 ścieżki (najlepiej w tym samym przebiegu).
3. A2/A3: LICENSE + ATTRIBUTION, decyzja o rename repo, potem module.json (adresy, wersja) i wydanie.
4. `git fetch` + sprawdzić fast-forward, dopiero potem push.
