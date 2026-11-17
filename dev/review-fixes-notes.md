# Poprawki po przeglądach 1 (adversary-1 + bughunt-1): co nie zostało poprawione i decyzje właściciela

Źródła: `dev/review-adversary-1.md` (A1–A9), `dev/review-bughunt-1.md` (B1–B10). Poprawione punkty są w commicie
„Fix review findings…” i w testach `dev/test-enhance.mjs` / `dev/test-migrate-id.mjs`; tu tylko to, czego nie poprawiono
(z powodem), oraz wybory, które należą do właściciela (z zachowaniem tymczasowym).

## Nie poprawione (z powodem)

| Punkt | Powód |
|---|---|
| A2 powrót do starego modułu zbiera drugi raz batche zebrane już przez nowy | Kodem nie da się tego zablokować bez zapisu do przestrzeni starego modułu (stary poller nie wie nic o nowej przestrzeni), a nagłówek `migrate-id.mjs` i README obiecywały, że stare wartości są tylko czytane. Zamiast tego poprawiono obietnicę: README („Going back to the old module is not a clean undo”) i nagłówek `migrate-id.mjs` mówią wprost, że wracają tylko ustawienia, a batche trwające w chwili kopii stary moduł zbierze jeszcze raz. Decyzja nr 1 niżej. |
| A8 dwóch GM-ów startuje jednocześnie przy pierwszym uruchomieniu | Po poprawce A1 klucz kopiuje się tylko, gdy w nowej przestrzeni NIGDY nie był zapisany, więc GM B nie nadpisze już mapy `batches`, którą GM A zdążył wyczyścić. Zostaje tylko okno wyścigu w tej samej sekundzie (obaj czytają przed zapisem drugiego); skutek nadal nieszkodliwy (martwa mapa `batches`, której nic poza migracją nie czyta). Blokada między klientami kosztowałaby więcej niż ten skutek. |
| B10 gracz w tej samej przeglądarce widzi klucze GM-a | Tak działają ustawienia klienta Foundry (localStorage danego originu); bez zmian względem starego modułu i niezależne od zmiany id. Decyzja nr 3 niżej. |
| B4 (dopisek) pola kluczy API to zwykłe `type=text` | Poza zakresem tych przeglądów (stan sprzed zmian); decyzja nr 3 niżej. Sam link „Otwórz ustawienia” poprawiono. |
| B3 w praktyce | Poprawione (strona HTML → sam tytuł), ale jak zauważył bughunt, 502 bez nagłówków CORS i tak kończy się w przeglądarce jako błąd sieci. |
| A6 `retry-after` pod CORS | Poprawione na tyle, na ile się da: odczyt `retry-after` (sekundy albo data HTTP), a w zapasie `anthropic-ratelimit-*-reset`. Czy przeglądarka w ogóle widzi któryś z tych nagłówków, zależy od `Access-Control-Expose-Headers` po stronie API: NIE sprawdzone na prawdziwym API (bez prawdziwych kluczy). Gdy nie widzi, pokazuje się ogólny komunikat 429, jak dotąd. |
| A7 `truncated` przy `effort: max` | Limit czasu rośnie teraz z effort (low/medium 120 s, high i domyślny modelu 180 s, xhigh 300 s, max 600 s). `max_tokens` zostało 16000: żądanie bez strumieniowania, a wyższy limit wydłużyłby czekanie; przy `max` obcięcie jest obsłużone czytelnym błędem. Decyzja nr 4 niżej. |

## Decyzje właściciela (zachowanie tymczasowe działa do odpowiedzi)

| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| 1 | Czy nowy moduł ma przy kopii oznaczać w przestrzeni STAREGO modułu rekordy batchy jako „przeniesione” (np. zapis statusu `cancelled`/flagi w `ai-image-gen.batch.N`), żeby powrót do starego modułu ich nie zbierał drugi raz? To łamie zasadę „stare wartości tylko czytane”. | Nie: stare wartości tylko czytane; README ostrzega, że powrót nie jest czystym cofnięciem i co sprawdzić. |
| 2 | „Cofnij” po ręcznych poprawkach | Przycisk znika po pierwszej ręcznej zmianie (także gdy ktoś przepisze z powrotem ten sam tekst); ręcznej pracy nic nie nadpisuje; natywne Ctrl+Z dalej działa. Dwa ulepszenia z rzędu bez ręcznych zmian: „Cofnij” wraca do tekstu sprzed PIERWSZEGO. Anuluj / „Teraz” / nieudana ponowna próba nie kasują ważnego cofnięcia (pole nadal trzyma wynik różdżki). Alternatywa: zostawić przycisk i pytać przed nadpisaniem. |
| 3 | Klucze API w przeglądarce współdzielonej z graczem (B10) i pola kluczy jako jawny tekst | Bez zmian (jak w starym module). Możliwe: pole typu password z przyciskiem „pokaż”; ostrzeżenie w README o wspólnej przeglądarce. |
| 4 | Limity czasu i `max_tokens` przy wysokim effort | Czas jak wyżej (do 600 s przy `max`), `max_tokens` 16000. Alternatywa: strumieniowanie (brak limitu czasu całego żądania) albo blokada `max` w ustawieniu. |
| 5 | Wynik różdżki, gdy użytkownik pisze w innym polu (B1) | Tekst trafia do opisu bez przenoszenia fokusu; w tym przypadku natywne Ctrl+Z nie obejmuje wstawki (zostaje przycisk „Cofnij”). Gdy fokus jest na różdżce/polu/nigdzie, wstawka idzie jak dotąd przez `execCommand` (z Ctrl+Z). |
| 6 | Kontekst „Kind” dla modelu (B6) | Oba miejsca wysyłają etykietę typu („Superhero”, „Macro”), nie wewnętrzny klucz; gdy etykiety brak, nazwę dokumentu Foundry (Actor/Item). |
| 7 | Szuflada testu w trakcie testu (B5) | Różdżka wyłączona w czasie potwierdzania i trwania testu; samo pole opisu zostaje edytowalne (test ma już swój opis). Uruchomienie testu przerywa trwające ulepszanie (A4), tak jak „Teraz” w oknie „Generuj obraz”. |
