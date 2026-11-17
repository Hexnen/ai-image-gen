# Przegląd adwersarza nr 1: d8bef7b (różdżka Claude), 8052be1 (zmiana id na moinens-ai-gen), sketch-reveal cb245fc

Przegląd statyczny: czytany kod i diffy, Foundry nie był uruchamiany. Uruchomiłem tylko testy node `dev/test-enhance.mjs` (12 ok) i `dev/test-migrate-id.mjs` (14 ok).
Sygnatury Foundry v14 sprawdzone w `resources/app/public/scripts/foundry.mjs` (WorldSettings.getSetting, ClientSettings#setClient, settings.register).

## Znalezione problemy (od najpoważniejszego)

### 1. ŚREDNI, POTWIERDZONE: ponowna kopia przywraca usunięte rekordy batchy, więc batch jest zbierany drugi raz
- `scripts/migrate-id.mjs:362-363`: wartość jest kopiowana, jeśli nowe ustawienie ma wartość domyślną. Dla slotów batchy domyślna wartość to `{}` (`settings.mjs`, `ObjectField({initial: {}})`).
- `scripts/batch/record.mjs:97-103` (`removeBatch`) i `pruneBatches` (`:171-185`) zwalniają slot przez `writeSlot(i, null)`, czyli `{}`. Wolny slot wygląda więc dokładnie jak „jeszcze nie skopiowany”.
- Ponowna kopia startuje w dwóch przypadkach: (a) procedura ręczna z `dev/rename-notes.md` #4 (`set(...migratedFromAiImageGenWorld, false)`), (b) samoczynnie przy następnym starcie, gdy pierwsza kopia była częściowa: wtedy `complete=false` i flaga świata zostaje nieustawiona (`:365`, `:385`).
- Przebieg: stary rekord X był „pending” i został skopiowany. Nowy moduł go zebrał, a GM go usunął (albo usunął go prune). Ponowna kopia wpisuje stary rekord X z powrotem do slotu, wciąż z `status: "pending"` i starym markerem `ingest`. Poller (`ingest.mjs`) zbiera go jeszcze raz.
- Skutek:
  - `applyBatchItem` ponownie podmienia obraz w dokumencie, więc nadpisuje obraz, który GM wybrał później;
  - powstają duplikaty plików w `Data/ai-image-gen/`;
  - `recordCost` drugi raz zwiększa licznik `usage`, więc limity dzienne i miesięczne są zawyżone;
  - w `_log` pojawiają się podwójne wpisy, co skrzywia uczenie kosztów.
- Nie dotyczy to rekordów, których slot jest zajęty (nie są domyślne), ani terminalnych, które tylko wrócą na listę.

### 2. ŚREDNI, PRAWDOPODOBNE (stary kod nie był czytany w całości): powrót do starego modułu zbiera drugi raz to, co zebrał już nowy
- README („Rename from ai-image-gen”) i komentarz w `migrate-id.mjs:1-3` obiecują, że ponowne włączenie starego modułu przywraca stary stan. Ten stary stan zawiera jednak rekordy batchy w stanie sprzed kopii (`pending`).
- Nowy moduł zebrał je w nowej przestrzeni nazw, a stara przestrzeń o tym nie wie. Stary poller zbierze je jeszcze raz: te same dokumenty, ten sam `DATA_ROOT` i wspólny `_log`. Skutki są takie same jak w punkcie 1.
- `rename-notes.md` #4 opisuje tylko odwrotny kierunek (stary zebrał, nowy zbierze ponownie). Wystarczy ostrzeżenie w README albo oznaczenie w starej przestrzeni, że rekordy zostały przeniesione (np. zapisanie flagi). Same wartości zostają nietknięte, ale ostrzeżenie musi się pojawić.
- Do sprawdzenia na żywo: czy dostawca nadal trzyma wyniki (OpenAI kasuje pliki w `batch/openai.mjs:40`; które dokładnie, nie sprawdzałem).

### 3. ŚREDNI/NISKI, POTWIERDZONE w kodzie (założenie o stanie serwera jest PRAWDOPODOBNE): przy nieprzemianowanym folderze moduł uznaje sam siebie za „stary moduł”
- Serwer uruchomiony przed commitem 8052be1 zna pakiet z folderu `ai-image-gen` pod starym id. Po przeładowaniu przeglądarki klient wczytuje nowy `scripts/module.mjs`.
- `oldModuleActive()` (`module.mjs`) zwraca `game.modules.get("ai-image-gen").active === true`, a to jest ten sam moduł. Moduł jest więc bezczynny: bez API, przycisków i pollera. GM dostaje trwałe ostrzeżenie „wyłącz stary moduł AI Image Gen”, a wykonanie tej rady wyłącza jedyną kopię.
- Po restarcie serwera pakiet jest odrzucany całkiem. To jest opisane w `rename-notes.md` #1; opisu brakuje tylko dla stanu przed restartem.
- Do czasu zmiany nazwy folderu moduł nie działa w żadnym stanie. Treść ostrzeżenia w tym stanie wprowadza w błąd.
- Zdanie z README „the folder is Data/modules/moinens-ai-gen” jest dziś nieprawdziwe.
- Możliwa poprawka: sprawdzić `game.modules.get(OLD_MODULE_ID)?.id !== MODULE_ID`, a dokładniej sprawdzić, czy moduł, w którym działa ten kod, sam nie jest zarejestrowany pod starym id (np. porównać `import.meta.url` z folderem pakietu).

### 4. NISKI, POTWIERDZONE: szuflada testu nie przerywa trwającego ulepszania przed płatnym testem
- `GenerateDialog.#run` woła `cancelEnhance` (`generate-dialog.mjs`). Akcja testu w `config-app.mjs` tego nie robi.
- W czasie ulepszania pole jest tylko do odczytu, a test bierze bieżący, jeszcze nieulepszony opis i jest płatny. Chwilę później różdżka podmienia tekst w polu.
- W historii testów zostaje stary opis, a w polu jest już nowy. Użytkownik myśli, że przetestował wersję ulepszoną.

### 5. NISKI, POTWIERDZONE: „Cofnij” po ręcznych poprawkach bez ostrzeżenia kasuje te poprawki
- `ui.mjs:224-227`: ręczna edycja czyści tylko status „done”, a `store.original` zostaje.
- `undo()` (`:175-184`) wstawia oryginał w miejsce wszystkiego, co jest w polu, łącznie z ręcznymi zmianami wprowadzonymi po ulepszeniu.
- Odzyskanie przez Ctrl+Z działa tylko wtedy, gdy zadziałał `execCommand`; przy zapasowym `value=` nie działa.

### 6. NISKI, PRAWDOPODOBNE: komunikat „poczekaj N s” przy 429 prawdopodobnie nigdy się nie pokaże
- `anthropic.mjs:157` czyta `retry-after` w żądaniu cross-origin.
- Przeglądarka udostępnia ten nagłówek tylko wtedy, gdy API wymieni go w `Access-Control-Expose-Headers`. W przeciwnym razie `get()` zwraca `null` i zawsze pokazuje się ogólny komunikat. Do sprawdzenia na żywo.

### 7. NISKI, PRAWDOPODOBNE: twardy limit 120 s przy wysokim effort
- `TIMEOUT_MS = 120_000`, żądanie bez strumieniowania, `max_tokens 16000`.
- Przy `effort: max/xhigh` na Opusie odpowiedź może przyjść później. Użytkownik dostaje „timeout”, a żądanie i tak jest naliczone.
- Przy `max` myślenie może też zużyć całe 16000 tokenów i skończyć się błędem `truncated`. To jest obsłużone, ale płatne.

### 8. NISKI, PRAWDOPODOBNE: dwóch GM-ów startuje jednocześnie przy pierwszym uruchomieniu
- Obaj widzą flagę świata jako nieustawioną i obaj kopiują.
- Jeśli `runMigrations` u GM-a A zdąży wyczyścić starą mapę `batches` do `{}`, GM B skopiuje ją z powrotem. Schemat jest już 2, więc ta mapa nigdy nie zostanie zmigrowana.
- Skutek jest nieszkodliwy (mapa służy tylko migracji), ale zostaje martwy stan. Pozostałe klucze kopiują się do tych samych wartości.

### 9. NISKI, POTWIERDZONE: dokumentacja nie zgadza się z promptem
- `dev/enhance-notes.md` #5 mówi, że model dostaje instrukcję, żeby nie wpisywał nazwy dokumentu do opisu.
- `SYSTEM_PROMPT` (`anthropic.mjs:19-31`) takiej instrukcji nie ma. Mówi tylko „Keep proper names as written” i „treat context as material”.
- Nazwa aktora może więc trafić do opisu, a model obrazu może narysować ją jako napis.

## Sprawdzone i czyste
- **Wyciek klucza Anthropic.**
  - Klucz jest tylko w nagłówku `x-api-key`; ciało żądania zawiera wyłącznie system prompt, opis i kontekst (test to potwierdza).
  - `redact()` obejmuje teraz klucz `anthropic`, a także wzorce `sk-` i `api-key:`.
  - `console.warn` dostaje tekst po `redact`, a szczegóły błędu w UI po `redact(…, 300)`.
  - Ulepszanie nie trafia do logu wywołań, eksportów ani flag. Moduł nie używa flag dokumentów.
  - Klucz jest ustawieniem klienta z `restricted` (localStorage GM-a). Migracja kopiuje go z localStorage do localStorage tej samej przeglądarki i loguje tylko nazwy kluczy.
- **XSS.** Status, błędy i model idą przez `textContent`. Przyciski są budowane przez `createElement`, tooltip to tekst z i18n. Wynik modelu trafia tylko do `textarea.value`. Ostrzeżenie BothActive to stały tekst. W `descId` jest tylko id aplikacji.
- **Prompt injection.** Opis i nazwa (nazwę może ustawić gracz) są w tagach, a domykające tagi są wycinane. Wynik trafia wyłącznie do pola, które GM widzi i może cofnąć. Model nie ma narzędzi ani skutków ubocznych. Wpływ ogranicza się do treści opisu.
- **Wyścigi w różdżce.**
  - Podwójny klik jest blokowany, bo `controller` jest ustawiany synchronicznie.
  - Anulowanie, zamknięcie okna i zmiana typu w szufladzie przerywają żądanie, a spóźniona odpowiedź jest ignorowana.
  - Ponowny render podpina nowe pole i nowy slot (przy każdym renderze są nowe elementy, więc słuchacze się nie dublują).
  - Zmiana tekstu w trakcie nie jest nadpisywana (`Err.changed`).
  - `GenerateDialog` przerywa ulepszanie przed generowaniem.
- **Zgodność z Messages API (skill claude-api).**
  - Endpoint i `anthropic-version: 2026-10-21` są poprawne. Brak `temperature`, `top_p` i `top_k`, które w tej wersji dają błąd 400.
  - `output_config.effort` jest we właściwym miejscu, a `""` pomija ten parametr. Nie ma `thinking: disabled` ani `budget_tokens`.
  - Odpowiedź jest filtrowana do bloków `text`, więc bloki thinking i `fallback` są pomijane. Najpierw sprawdzany jest `stop_reason: refusal`, a `max_tokens` daje błąd `truncated`.
  - `fallbacks: "default"` z betą `server-side-fallback-2026-07-01` idzie tylko do modeli, które to przyjmują (sonnet-5-5, opus-5-5, opus-5, fable-5-1, fable-5-2), a nie do Haiku 5.5.
  - Nagłówek `anthropic-dangerous-direct-browser-access` jest ustawiony.
  - Mapowanie statusów 401/403/404/413/429/5xx/529 jest poprawne.
- **Stare id w kodzie.** Wszystkie wystąpienia `ai-image-gen` są zamierzone: `OLD_MODULE_ID`, `DATA_ROOT`, teksty o folderze danych i adresy w `module.json` (te ostatnie to otwarta decyzja #2). Hooki `aiImageGen.*` i prefiks `AIIMG` zostawiono celowo.
- **DATA_ROOT.** Wszystkie ścieżki danych (`save-image`, `api`, `call-log`, `apply`/`pick-app`, `_refs`/`_tests`/`_candidates`, profil optymalizatora) używają `DATA_ROOT`. Szablony używają `modules/${MODULE_ID}`, co jest poprawne po zmianie nazwy folderu.
- **Parzystość i18n.** Klucze en i pl są identyczne (skrypt node), placeholdery się zgadzają, a wszystkie klucze `Enhance.Err.*` używane w `ui.mjs` istnieją.
- **Migracja.**
  - Stare wartości są tylko czytane.
  - Koercja typów (Boolean/Number z min/String z choices/Object) odrzuca nieznane typy.
  - Kopia kluczy klienta działa per przeglądarka, a świata per świat, tylko u GM-a.
  - Kopia idzie przed `runMigrations`, więc stary schemat 1 jest podnoszony w nowej przestrzeni. Poller i optymalizator startują po kopii.
  - `WorldSettings.getSetting(key, null)` i format localStorage (`ns.key` = JSON) zgadzają się z v14.
  - Gracze nie mają nic do skopiowania (moduł jest tylko dla GM-a; przyciski na kartach sprawdzają `isGM`).
- **Oba moduły aktywne.** Ustawienia są rejestrowane, a poza tym nowy moduł jest bezczynny. Nie dochodzi do kolizji przestrzeni ustawień.
- **sketch-reveal cb245fc.** Najpierw szuka `moinens-ai-gen`, a jako zapasu starego id, i bierze pierwszy aktywny moduł z `api`. Gdy oba są aktywne, nowy nie ma api, więc trafia do starego (poprawnie). Rejestracja przez hook `aiImageGen.ready` pokrywa to, że api jest teraz publikowane po `await migrateFromAiImageGen()` (u GM-a już po zakończeniu handlerów `ready` innych modułów). `recommends` to tylko informacja.

## Czego nie mogłem sprawdzić
- Jak serwer, który teraz działa na porcie 30000, ma zarejestrowany pakiet (dotyczy punktu 3). Nie dotykałem serwera.
- Rzeczywistego zachowania API: czy CORS udostępnia nagłówek `retry-after`, czasów odpowiedzi przy wysokim effort, treści odpowiedzi 404 dla złego modelu.
- Czy dostawcy po zebraniu batcha nadal trzymają wyniki (od tego zależy realność punktu 2).
- Pełnego kodu starego modułu (punkt 2 wnioskuję z tego, że nowa wersja to ten sam kod pod innym id).
- Działania `execCommand("insertText")` i natywnego Ctrl+Z w Electronie/Chrome Foundry.
