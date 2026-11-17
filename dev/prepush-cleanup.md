# Porządki przed pushem (2026-11-17)

Wykonanie zaleceń z `dev/prepush-audit.md` (A1, A4, A5, A9). Nic nie zostało wypchnięte. `origin/main` = c756999 (tag `v0.1.0`)
nietknięty; `git merge-base origin/main HEAD` = c756999, więc push `main` to nadal fast-forward.

## Kopie zapasowe (lokalne, NIE do pushowania)

- Gałąź `backup/pre-cleanup-2026-11-17` = stary HEAD 165e647 (historia przed przepisaniem, ze zrzutami).
- `refs/original/refs/heads/main` = to samo (zostawione przez `git filter-branch`).
- Bundle całego repo sprzed porządków: `<SCRATCH>\pre-cleanup.bundle` (`git bundle verify`: okay).
- Kopia 13 zrzutów: `<SCRATCH>\screenshots-backup\`; zrzuty są też z powrotem w `dev/screenshots/` (teraz ignorowane).
- Po udanym pushu można usunąć: `git branch -D backup/pre-cleanup-2026-11-17` i `git update-ref -d refs/original/refs/heads/main`.
  Nie pushować tej gałęzi (zawiera zrzuty).

## A1: zrzuty usunięte z historii

- `git filter-branch --index-filter 'git rm -r --cached --ignore-unmatch -q dev/screenshots' -- origin/main..main`
  (git filter-repo nie jest zainstalowany). Przepisane tylko 62 lokalne commity; origin/main i wcześniejsze bez zmian.
- Wiadomości, autorzy, daty autora i committera oraz trailery: identyczne (porównanie `git log --format='%B%an%ae%ad%cn%ce%cd'`
  przed/po: bajt w bajt).
- Drzewo ostatniego przepisanego commitu (5d6c58c) różni się od starego HEAD (165e647) tylko brakiem 13 plików `dev/screenshots/*.png`.
- `git log main -- dev/screenshots` = 0 commitów. Innych obrazów (png/webp/jpg/gif/webm/mp4) w zakresie nie było.
- `.gitignore` (commit 1315a68): `dev/screenshots/`, `*.zip`, `relay.json`, `dry-*/`, `.claude/`.

## A5: dosłowne fragmenty książki

- `scripts/systems/invincible/catalog.mjs` (`compressRule`, `needsChoice`): klauzula „defined ... when you select” jest teraz
  dopasowywana z ograniczoną luką (`defined\b[^.,;]{0,30}?\bwhen you select`) zamiast wypisywać brzmienie książki. Te same
  dopasowania dla obu wariantów z książki (sprawdzone na próbkach), testy zielone.
- `dev/test-catalog-invincible.mjs`, `dev/test-build-validate-invincible.mjs`: teksty „mock” przepisane na własne zdania o tej
  samej strukturze (commity f114343, 844d5e1).
- Kontrola 7-gramami słów (paczki `invincible-core` + paczki systemu, kopie w scratchpadzie) na drzewie HEAD: zostały tylko
  - `scripts/systems/invincible/vendor/chargen/rules.mjs:43`: cytat 9 słów w komentarzu (plik vendorowany, patrz niżej);
  - `dev/test-catalog-invincible.mjs`: fałszywe trafienie (ciąg UUID `Compendium.invincible-core...`).
- Plik vendorowany NIE został zmieniony (MANIFEST sha256 + sync.mjs). Ta sama linia 43 jest w żywym źródle
  `invincible-plus-ultra/scripts/chargen/rules.mjs`; poprawka musi zajść tam, potem `sync.mjs` tutaj.
- Starsze wersje plików w lokalnej historii (przed f114343) nadal mają stare teksty: regex w catalog.mjs (10-11 słów),
  teksty mock w testach (7-12 słów). Zgodnie z poleceniem nie ukrywano ich w starej historii.

## A4: ścieżki lokalne

- Zastąpione placeholderami (`<DATA>`, `<SCRATCH>`, `C:\Users\<konto>\...`) w `dev/dry-run/RUNBOOK.md`, `dev/review-bughunt-1.md`,
  `dev/owner-readiness.md`, `dev/dry-run/analysis-2.md`, `dev/prepush-audit.md` (także e-mail autora w treści) (commity 8ec0a08, 47ef950).
- `git grep` po nazwie konta, id sesji, e-mailach: 0 trafień w drzewie HEAD.
- Starsze wersje tych plików w historii zakresu nadal mają ścieżki z nazwą konta Windows (nowy commit, bez przepisywania historii).
- Zostają: ścieżki `C:/mmwt-ultra/...` (narzędzia torów, bez danych osobowych) i e-mail autora w metadanych commitów (już publiczny).

## Weryfikacja (po porządkach)

- Sekrety w `git log -p origin/main..HEAD`: tylko jawne atrapy testowe i regex redakcji `sk-ant-`.
- Wszystkie `dev/test-*.mjs` zielone (15 plików), `test-vendor-sync.mjs`: ALL OK.
- `git diff origin/main --stat`: 132 pliki, +26070/-79, brak plików binarnych.

## Do decyzji właściciela

1. `vendor/chargen/rules.mjs:43`: cytat z książki w komentarzu; poprawić w plus-ultra i zsynchronizować, albo zostawić (9 słów).
2. Czy wyczyścić także stare wersje (teksty mock/regex, ścieżki z nazwą konta) w lokalnej historii drugim przebiegiem filter-branch.
3. LICENSE / ATTRIBUTION (A2).
4. Nazwa repo i `module.json` (A3: adresy, wersja, wydanie).
5. Czy `dev/` ma być publiczne (A7); nazwy postaci (A6).

## Drugi przebieg (2026-11-17): stare wersje w historii zakresu

Punkt 2 powyżej wykonany. Nic nie wypchnięte; `origin/main` = c756999 nietknięty, merge-base = c756999 (fast-forward).

- Kopie: gałąź `backup/pre-scrub2` = da669db (historia po pierwszym przebiegu); `refs/original/refs/heads/main` = da669db
  (nadpisane, wcześniej 165e647; ta wersja jest dalej w `backup/pre-cleanup-2026-11-17`); bundle `<SCRATCH>\pre-scrub2.bundle`
  (`git bundle verify`: okay). Żadnej gałęzi `backup/*` ani `refs/original` nie pushować.
- `git filter-branch -f --prune-empty --index-filter "node <SCRATCH>\scrub2\filter.cjs" -- origin/main..main`: filtr na indeksie
  (bez checkoutu, więc bez konwersji CRLF), te same zamiany co pierwszy przebieg (regexy w `catalog.mjs`, teksty mock w obu testach,
  ścieżki z nazwą konta i id sesji, e-mail w treści notatek), też dla starszych kształtów tych linii. Każda stara wersja bloba przechodzi
  dokładnie w blob z HEAD.
- Commity pierwszego przebiegu (f114343, 844d5e1, 8ec0a08, 47ef950) stały się puste i zostały usunięte: 68 -> 64 commity.
  SHA w sekcjach wyżej odnoszą się do historii sprzed tego przebiegu (jest w `backup/pre-scrub2`).
- Drzewo HEAD przed i po: `6d6a1deeee3d87bb79dfc4a1808b42665562c344` (identyczne). Wiadomości, autorzy, daty i trailery 64 commitów:
  bajt w bajt jak w pozostawionych commitach `backup/pre-scrub2`.
- Kontrola: `git log -p origin/main..HEAD` i każdy blob każdego commitu zakresu: 0 trafień nazwy konta, id sesji, ścieżek
  `C:\Users\<konto>`, starych regexów i starych tekstów mock. E-mail autora tylko w nagłówkach `Author:` (metadane, zostają).
  7-gramy z książką na wszystkich blobach zakresu: tylko `vendor/chargen/rules.mjs:43` (punkt 1) i fałszywe trafienie UUID w teście.
- Wszystkie `dev/test-*.mjs` zielone, `test-vendor-sync.mjs`: ALL OK, `git status` czysty.
