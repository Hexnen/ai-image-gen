# Bug hunt 1: różdżka Claude (d8bef7b), zmiana id + migracja (8052be1), sketch-reveal (cb245fc)

Data: 2026-11-17. Tylko zachowanie (testy + lane 8 na żywo); przegląd statyczny robi inny agent. Kod modułu nie był zmieniany.

Środowisko: lane 8 (http://localhost:30008, świat `invincible`, Foundry 14.363). Junction `modules/moinens-ai-gen` -> folder `Data/modules/ai-image-gen`
(nowa wersja), a `modules/ai-image-gen` tymczasowo -> kopia starego modułu z `git archive d8bef7b` (id `ai-image-gen`) w scratchpadzie,
żeby przejść prawdziwą ścieżkę „stary moduł -> oba włączone -> sam nowy”. Fałszywe klucze, `window.fetch` podmieniony dla
api.anthropic.com / api.openai.com / googleapis / openrouter (żadne zapytanie nie wyszło do dostawców). Po teście: świat z kopii
wzorcowej (`lane8.ps1 restore`), junction-y z powrotem, wpisy localStorage usunięte.

Zrzuty: `<SCRATCH>\shots\`
(`drawer-pl-wand-done.jpg`, `generate-dialog-en.jpg`, `generate-dialog-280px.png`; pane był mały, zrzuty są w niskiej rozdzielczości,
dowody to głównie odczyty DOM opisane niżej).

## Znalezione

### B1. Wynik ulepszenia kradnie fokus (średnia/niska)
Kroki: szuflada testu (albo okno „Generuj obraz”), wpisz „mag”, kliknij różdżkę, w trakcie żądania kliknij w pole „Przykładowa nazwa”
(albo w czat) i pisz dalej.
Oczekiwane: tekst wstawia się do opisu, fokus zostaje tam, gdzie użytkownik pisze.
Faktyczne: po odpowiedzi `replaceText()` (scripts/enhance/ui.mjs) robi `textarea.focus(); textarea.select()`: fokus skacze do opisu,
dalsze naciśnięcia klawiszy lądują w opisie zamiast w nazwie/czacie.
Dowód (odczyt po odpowiedzi): `{"focused":"testDescription","selStart":45,"selEnd":45}`, choć przed odpowiedzią fokus był w `testName`.
To samo w `cancelEnhance()` (focus na opisie po Anuluj, tu akurat zamierzone).

### B2. „Przywróć” po ręcznej edycji kasuje tę edycję (niska)
Kroki: okno „Generuj obraz”, opis „vampire countess”, różdżka (sukces), potem ręcznie przepisz cały opis na inny tekst, kliknij „Przywróć”.
Oczekiwane: albo przycisk znika po ręcznej edycji, albo cofnięcie nie niszczy nowej pracy bez pytania.
Faktyczne: przycisk zostaje (`["undo","run"]` po edycji), klik wstawia „vampire countess”, ręczny tekst znika z pola
(zostaje tylko natywne Ctrl+Z). Stare „Przywróć” wisi też po Anuluj, po nieudanej ponownej próbie i po kliknięciu „Teraz”
(`#run` woła `cancelEnhance`, który nie czyści `original`). Cofnięcie jest jednopoziomowe: dwa ulepszenia z rzędu gubią pierwotny tekst.

### B3. Surowy HTML strony błędu w linii statusu (niska)
Kroki: odpowiedź 502 z treścią HTML (np. strona Cloudflare).
Faktyczne: „Błąd serwera Anthropic. Spróbuj ponownie. (<!DOCTYPE html><html><head><title>502 Bad Gateway</title><style>body{…}…)”,
do 300 znaków znaczników. Bez XSS (wstawiane jako textContent), tylko nieczytelne. `errorDetail()` bierze surowy tekst, gdy to nie JSON.
Uwaga: w przeglądarce 502 bez nagłówków CORS i tak skończy się jako błąd sieci, więc realnie tylko gdy pośrednik dodaje CORS.

### B4. Link „Otwórz ustawienia” otwiera ustawienia na karcie „core” (niska)
Kroki: brak klucza / 401 / 404 modelu, klik „Otwórz ustawienia” w linii statusu (też w szufladzie testu).
Faktyczne: `SettingsConfig` otwiera się z `tabGroups.categories = "core"`; kategorię „Moinens AI Gen” trzeba znaleźć samemu.
Przy okazji (bez zmian względem starego modułu): pola kluczy API, także nowe Anthropic, są zwykłym `type=text`, klucz widać jawnie.

### B5. Szuflada testu: różdżka i opis aktywne podczas trwającego testu (niska, spójność)
Kroki: szuflada, „Generuj test” -> „Tak”, w trakcie (test.running = true) kliknij różdżkę.
Faktyczne: różdżka działa i podmienia przykładowy opis w trakcie testu (`wand:["run"]`, opis zmieniony, `running:true`).
W oknie „Generuj obraz” w tej samej sytuacji przycisk jest wyłączony, a pole `disabled` (`["run(dis)"]`). Bez szkody dla wyniku testu
(opis był już pobrany), ale zachowanie różni się między dwoma miejscami.

### B6. Kontekst „Kind” różni się między miejscami (niska)
Okno „Generuj obraz” wysyła wewnętrzny klucz typu: `Kind: invincible.Actor.superhero`, `invincible.Item.criticalInjury`, `core.Macro`.
Szuflada testu wysyła etykietę: `Kind: Superhero`. Model dostaje inny kontekst dla tego samego typu.

### B7. Okno „Generuj obraz” przy wąskiej szerokości ma poziomy scroll (niska, starsze niż ta zmiana)
Kroki: `setPosition({width:280})` albo 300 px.
Faktyczne: `.window-content` scrollWidth 320 vs clientWidth 278; wystaje `label.aiimg-preview-opt` (+42 px). Różdżka i linia statusu
mieszczą się i zawijają poprawnie (sprawdzone też z 80-znakowym id modelu w błędzie 404). Zrzut `generate-dialog-280px.png`.
Przy 1366x768 okno konfiguracji wychodzi dołem poza ekran (bottom = 768 przy top 88), szuflada dokuje się po lewej poprawnie.

### B8. Polszczyzna w oknie potwierdzenia testu (kosmetyka, starsze)
„…szacunkowo ~0.007 USD za 1 wersji.” (powinno być „za 1 wersję”; liczba mnoga dla 1 nieodmieniona).

### B9. Fixture testu migracji nie odpowiada prawdziwemu kluczowi (info)
`dev/test-migrate-id.mjs` używa `ai-image-gen.test.invincible|Actor|npc`, a moduł zapisuje `<ns>.test.invincible.Actor.superhero`
(kropki, `selectedKey`). Kopia działa po prefiksie `test.`, więc na żywo wszystko się skopiowało, ale test nie sprawdza realnego formatu.

### B10. Gracz w tej samej przeglądarce widzi klucze GM-a (info, bez zmian po rename)
Po zalogowaniu Test Gracz 1 w tej samej przeglądarce: `game.settings.get("moinens-ai-gen","apiKey.anthropic")` zwraca klucz GM-a
(ustawienia klienta = localStorage originu). Tak samo było w starym module; migracja niczego tu nie pogarsza.

### Nierozpoznane
Na starcie (GM i gracz) w konsoli jeden błąd `Failed to load resource: 404` bez widocznego adresu (bufor zasobów przepełniony).
Wszystkie ścieżki `modules/${MODULE_ID}/…` użyte w scripts/ istnieją na dysku, więc raczej nie z tego modułu.

## Sprawdzone i czyste
- `node dev/test-enhance.mjs` 12/12, `node dev/test-migrate-id.mjs` 14/14.
- Upgrade na żywo: stary moduł (d8bef7b) z wartościami (`apiKey.openai/anthropic`, `limit.daily=7`, `enhance.model=claude-opus-5-5`,
  `enhance.effort=""`, `batch.5`, `dialogPrefs`, `test.*`) -> oba włączone -> sam nowy. Oba włączone: nowy bez API, bez przycisku na karcie
  (jeden `aiimg-btn`, ze starego), bez grupy narzędzi, jedno trwałe ostrzeżenie GM-a w poprawnym języku, sketch-reveal używa API starego.
  Sam nowy: wszystko skopiowane (także effort "" i schema 2, usage, imageTypes), flagi klient/świat = true, stare wartości nietknięte,
  okno batchy pokazuje skopiowany rekord „Old Hero”, sketch-reveal rejestruje typy (`sketch-reveal.painted/sketch`) i `aiApi()` zwraca API
  nowego modułu; widać je w konfiguracji („Malunek”, „Szkic z malunku”).
- Gracz (Test Gracz 1): API tylko `apiVersion/registerImageType/unregisterImageType`, brak narzędzi i przycisków, `aiApi()` w sketch-reveal = null,
  bez kopii.
- Różdżka w oknie „Generuj obraz” (Actor, Item, Macro) i w szufladzie testu: sukces, puste pole, brak klucza (pusty i same spacje), 401, 403-ścieżka
  w testach, 404 (z linkiem do ustawień), 429 z `retry-after` („za 17 s”), 500 (klucz `sk-ant-…` w treści zamaskowany jako `[redacted]`), 529,
  błąd sieci, nie-JSON, odmowa, timeout 120 s (status „nie odpowiedział na czas”, pole odblokowane), Anuluj (od razu, spóźniona odpowiedź
  zignorowana), Ctrl+Enter, re-render w trakcie (pole readonly, wynik trafia do nowego pola, „Prompt końcowy” odświeżony), zamknięcie okna
  w trakcie, zmiana typu w szufladzie w trakcie (żądanie przerwane, cofnięcie wyczyszczone), 6000 znaków przechodzi, 6001 blokowane bez
  zapytania, tagi `</description>`/`<context>` wycięte z wysyłki, wynik z HTML/`</textarea>`/`{{description}}` wstawiony jako tekst (bez XSS,
  po re-renderze bez zmian), puste pole modelu -> `claude-sonnet-5-5`, „Teraz” w trakcie ulepszania przerywa je i generuje z bieżącym tekstem,
  różdżka zablokowana podczas generowania (także Ctrl+Enter). Nagłówki: klucz tylko w `x-api-key`, `anthropic-version`, beta fallback dla opus-5-5.
- i18n: en/pl mają te same klucze i placeholdery, wszystkie użyte klucze `AIIMG.Enhance.*` istnieją, nowe teksty przetłumaczone; okna w PL
  sprawdzone na żywo.
- Okno logu i batchy otwierają się (en), konfiguracja + szuflada przy 1600 i 1366 px.

## Nie zweryfikowane
- Prawdziwe odpowiedzi Anthropic (CORS na odpowiedziach błędów, realny kształt 429/529) — tylko atrapa fetch.
- Pełne logi konsoli na starcie: bufor konsoli w przeglądarce (500 wpisów) zapełniają inne moduły; filtr „tylko błędy” nie pokazał nic z tego modułu.
- Ścieżka `Err.changed` (opis zmieniony w trakcie): nie znalazłem sposobu wywołania z UI (pole readonly, re-render odtwarza ten sam tekst).
- Drugi GM / druga przeglądarka (kopia kluczy per przeglądarka), `loadTry` z historią prób, IME, wydajność.
