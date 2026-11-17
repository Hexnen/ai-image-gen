# Dry run (subagent jako model): notatki i otwarte wybory

Data: 2026-11-17.

Kod:
- `scripts/build/dry-transport.mjs`: podmieniony `fetch`, strażnicy, symulacja usage.
- `dev/dry-run/relay.mjs`: lokalna kolejka 127.0.0.1 z tokenem.
- `dev/dry-run/driver.mjs`: CLI dla zastępcy modelu.
- `dev/dry-run/queue.mjs`: wspólne części: folder, sprawdzanie odpowiedzi ze schematem, render.
- Podpięcie: kilka linii w `scripts/build/builder-api.mjs`.

Testy: `node dev/test-dry-transport.mjs` (12). Instrukcja dla zastępcy: `RUNBOOK.md`.

## Projekt w skrócie

- **Co podmieniamy.** Podmieniony jest TYLKO `fetch`, z którego korzysta prawdziwy transport (`streamMessage`). Prawdziwe zostają:
  - budowanie żądania, parser SSE i akumulator;
  - koszt, pętla harnessu, limity na wiadomość;
  - limity modułu (`reserveBudget` / `recordCost`) i log wywołań.
- **Droga żądania.** Dry fetch dostaje dokładnie to ciało, które poszłoby do API, i oddaje je relayowi (POST text/plain, bez preflightu). Relay zapisuje je jako plik `req/<id>.json`.
- **Droga odpowiedzi.** Zastępca odpowiada plikiem przez `driver.mjs answer`, ze sprawdzeniem narzędzi i schematów. Strona odpytuje relay, a w czasie czekania wysyła pingi SSE co 15 s, jak API. Odpowiedź przychodzi jako prawdziwy strumień SSE.
- **Dlaczego kolejka plików, a nie samo `javascript_tool`.**
  - Żądania są duże: indeks katalogu ma ok. 52 tys. znaków, do tego historia. Wyjście narzędzia przeglądarki byłoby ucinane.
  - Pliki dają od razu transkrypt.
  - Zastępca pracuje zwykłym shellem.
  - `javascript_tool` służy tylko do startu tury i odczytu wyniku.
- **Włączanie.** Wszystkie warunki naraz:
  - MG;
  - host loopback;
  - port z listy lane (30001-30005, 30008, 30020), nigdy 30000;
  - wpis `localStorage["moinens-ai-gen.build.dry"]` z adresem relaya (127.0.0.1, nie port lane / 30000) i tokenem;
  - przeładowanie strony.

  localStorage jest per origin, więc wpis z lane nie istnieje na `localhost:30000`. Strażnik portu i tak go tam odrzuca. Relay dodatkowo odrzuca origin `:30000` i obce originy.
- **Klucz.** W pamięci jest placeholder `dry-run-placeholder-not-a-key`. Dry fetch odrzuca każde żądanie z innym kluczem (np. prawdziwym) i każdy inny URL. Do relaya klucz nie trafia wcale. Nic nie jest zapisywane w ustawieniach.

## Otwarte wybory (zachowanie tymczasowe)

| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| D1 | Zastępca jest wolniejszy niż API: zegar tury (5 min) i limit całego żądania (10 min) | W trybie dry zegar tury jest równy max(ustawienie, 60 min), a limit żądania 30 min (`wallMinutes` / `requestMinutes` w konfiguracji, granice 1-240 / 1-120). Detektor zawieszenia 90 s zostaje prawdziwy (pingi). Ustawienia świata nie są zmieniane. Wada: test limitu czasu tury wymaga podania małego `wallMinutes`. |
| D2 | Usage / koszt | Symulowany [E], znaki / 3,5. Prefiks (model + narzędzia + system) jest zapisywany przy pierwszym żądaniu strony (TTL 1 h), potem odczytywany. Wspólny początek historii jest odczytywany, nowy ogon zapisywany (5 min). Wejście niecache'owane = 0, bo automatyczny ogon obejmuje całość. Wygasanie cache nie jest symulowane (stan żyje do przeładowania). Zastępca może nadpisać `usage` w odpowiedzi. Dolary są wiarygodne co do rzędu wielkości, ale nie prawdziwe (prawdziwe dopiero T8). |
| D3 | Wpisy logu | Wpisy przechodzą przez prawdziwe `logCall`, ale z `provider: "anthropic (dry)"`, żeby nie mieszać się z prawdziwymi kosztami ani nauką kosztów. Limity modułu księgują normalnie (w świecie lane). |
| D4 | Bloki thinking | Nieobsługiwane: driver i transport je odrzucają. Fałszywy podpis i tak nie miałby sensu. Rozumowanie zastępcy nie trafia do historii, tak jak przy `display: "omitted"`. |
| D5 | Pre-warm | Odpowiadany lokalnie na stronie (pusta wiadomość, `max_tokens`, symulowany zapis prefiksu), bez udziału zastępcy i bez wpisu w relayu. |
| D6 | Błędy API | `{"error":{"type":...}}` daje zdarzenie `error` w strumieniu, a z `"status"` błąd HTTP. Do testów ponowień i odmów. Nieprawidłowa odpowiedź, która mimo to dotarła do strony, staje się błędem `api_error` (driver nie powinien jej przepuścić). |
| D7 | Id narzędzi | Driver uzupełnia brakujące id jako `toolu_dry_<żądanie>_<n>` i odrzuca id użyte już w rozmowie. |
| D8 | Gdzie transkrypty | Tylko folder scratch zastępcy. `relay` / `driver` odrzucają folder w repo i w folderach Foundry. |
| D9 | Kod na lane | Junction lane wskazuje na żywy folder, a w nim bywają w połowie zapisane pliki innych agentów (w smoke teście `proposal.mjs` T5 miał błąd składni i pakiet się nie ładował). Instrukcja ma ścieżkę zapasową: `git archive HEAD` do scratch + chwilowe przepięcie junction, potem powrót. |
| D10 | Ręczne wyłączenie | Usunięcie wpisu localStorage + przeładowanie. Bez wpisu ścieżka produkcyjna jest bez zmian: `dryWiring` zwraca `null`, a `builder-api` przekazuje te same deps co wcześniej. |

## Zweryfikowane / niezweryfikowane

### Zweryfikowane w node (`dev/test-dry-transport.mjs`, 12/12; regresja: test-harness 27, test-transport 27, test-packs 23)
- strażnicy (port 30000, porty spoza lane, host nie-loopback, nie-MG, zły relay / token);
- odrzucanie obcego URL i klucza innego niż placeholder;
- relay: token, origin `:30000` i obce originy odrzucone, CORS dla lane;
- pełna tura: prawdziwy harness + prawdziwy transport + pakiet stub + CLI drivera; żądanie identyczne z budowanym przez transport, z arkuszem jako pierwszym blokiem;
- odrzucenie złego schematu, `tool_result` w następnym żądaniu, `end_turn`;
- księgowanie limitów i logu, transkrypt;
- Stop w trakcie czekania (anulowanie w relayu, driver odmawia spóźnionej odpowiedzi);
- pingi utrzymują wolną odpowiedź mimo krótkiego zegara zawieszenia;
- symulowany błąd w strumieniu;
- lokalny pre-warm.

### Zweryfikowane na żywo (lane 8, świat `invincible`, 2026-11-17)
- Kod: HEAD 4db3720 + moje pliki, przez `git archive` i chwilowe przepięcie junction, bo żywy `proposal.mjs` T5 był w trakcie zapisu.
- `api.build.dry` aktywne, komunikat DRY RUN widoczny, pakiet Invincible `ready` z 4 narzędziami T4.
- Aktor ZZ-AIGEN-dry-smoke. Pierwsze żądanie zawierało pełny `<sheet>` z czytnika T12.
- Prawdziwe `search_catalog` zwróciło `Flight` z katalogu świata lane.
- Wynik tury: `ok: true`, `reason: done`, 2 żądania, 1 narzędzie, symulowany koszt 0,075 USD (zapis 1 h przy pierwszym, odczyt 18 186 przy drugim).
- 2 wpisy w logu `provider: "anthropic (dry)"`.
- W sieci strony żadnego żądania do api.anthropic.com.
- Sprzątanie: aktor usunięty, wpis localStorage usunięty, junction z powrotem, `lane8.ps1 restore`, serwer zatrzymany, slot oddany.

### NIE zweryfikowane
- Na żywo: Stop / limity / błędy w trybie dry (tylko node).
- Narzędzia T5 / T6 (`check_proposal`, `submit_proposal`, zapis) przez kanał dry: jeszcze ich nie było w HEAD.
- Szuflada T7.
- Prawdziwy Sonnet jako zastępca: smoke test grał skrypt.
