# Fala 3: notatki wykonawców

Każdy wykonawca dopisuje własną sekcję. Plan: `dev/dry-run/analysis-3.md` (sekcja 3).

## W3-4 / W3-5 (grupa B, harness)

Pliki: `scripts/build/harness.mjs`, `harness-defaults.mjs`, `build-settings.mjs`, `harness-lang.mjs`, `dev/test-harness.mjs`, `dev/test-dry-transport.mjs`, `dev/dry-run/RUNBOOK.md` (dwie linie).

### Co działa teraz
- W3-4 (D-5, tymczasowo tak): partia narzędzi złożona WYŁĄCZNIE z `submit_*`, wszystkie przyjęte (`ok: true`, bez `is_error`) -> tura kończy się bez kolejnego żądania. TurnSummary: `ok: true`, `reason: "submitted"`, `stop: "tool_use"`, `text: ""` (szuflada pokazuje rationale z propozycji), `proposal` jak dotąd. Submit razem z innym narzędziem, nieudany submit albo dwa submity z jednym błędnym: tura trwa jak dawniej.
- Ustawienie `build.endTurnOnSubmit` (świat, MG, domyślnie włączone, `DEFAULT_END_TURN_ON_SUBMIT` w `harness-defaults.mjs`); wyłączone = stare zachowanie (jeszcze jedno żądanie). Teksty EN/PL w `harness-lang.mjs`.
- Historia po wczesnym końcu: wyniki `tool_result` submitu NIE trafiają do `messages`; leżą w `record.heldToolResults` (zapisywane w magazynie, przeżywają przeładowanie). Następna wiadomość MG to JEDNA wiadomość `user`: [wstrzymane wyniki, "Not run" dla ewentualnych innych niewysłanych tool_use, blok arkusza, znacznik `<proposal .../>`, tekst MG]. Dzięki temu nigdy nie ma dwóch wiadomości `user` z rzędu, każdy `tool_use` ma swój `tool_result` na początku następnej wiadomości, a historia zostaje ściśle dopisywana (prefiks cache bez zmian, test). `heldToolResults` czyszczone w tym samym zapisie co dopisanie; „Nowa rozmowa” je porzuca. Transkrypt oznacza chip submitu jako `done` także, gdy wynik jest jeszcze wstrzymany.
- W3-5: `text` tury = tekst wiadomości asystenta, która zakończyła turę BEZ wywołania narzędzia (`""`, gdy ostatnia wywołała narzędzia: koniec na submit, limit, Stop). Teksty pisane przed wywołaniami narzędzi: `progress[]` w TurnSummary (od najstarszego), `progress: true` w zdarzeniu `assistant-message`, element transkryptu `role: "progress"` (zamiast `ai`) dla tekstu w wiadomości z `tool_use`.

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Wybór |
|---|---------|-------|
| W3-B-a | Jak oddać `tool_result` po wczesnym końcu | Wstrzymać i wysłać na początku następnej wiadomości MG (jedna wiadomość `user`). Odrzucone: dopisać od razu i wysłać MG jako drugą wiadomość `user` z rzędu (tabela błędów skilla claude-api podaje dla kolejnych wiadomości tej samej roli 400; dokumentacja API mówi o scalaniu: niesprawdzone, więc wariant bezpieczny w obu przypadkach). |
| W3-B-b | Kiedy kończyć | Tylko gdy KAŻDE wywołanie w partii to przyjęty `submit_*`. Inne narzędzie w tej samej partii: model musi zobaczyć jego wynik, więc kolejne żądanie. |
| W3-B-c | Nazwa powodu | `reason: "submitted"`, `ok: true` (dawniej tylko `done` dawało `ok`). |
| W3-B-d | Gdzie ustawienie | Ustawienie świata `build.endTurnOnSubmit` (czytane co turę), nie opcja sesji (opcje sesji idą do pakietu). |
| W3-B-e | Tekst przed narzędziem w transkrypcie | Nowa rola `progress`; szuflada (T7) pokazuje ją osobno od odpowiedzi `ai`. |

### Texts for C3 (nie zmienione tutaj; C3 zmienia je raz)
- W3-B-1 `scripts/build/harness-prompt.mjs:21`: „After a successful submission write one short sentence and stop.” jest nieaktualne: po przyjętym submicie (wysłanym bez innych narzędzi) harness sam kończy turę, model nie dostaje już żądania. Propozycja sensu: udany submit kończy turę; wszystko, co MG ma przeczytać, należy do rationale; submit wysyłaj sam w odpowiedzi (z innym narzędziem tura trwa).
- W3-B-2 `scripts/systems/invincible/validate.mjs:700` (`TOOL_DESC.submit_proposal`): „On ok:true the GM sees a preview and decides: write one short sentence and stop.” -> sens: on ok:true your turn ends; the GM sees a preview with your rationale.
- W3-B-3 `dev/test-prompt-texts.mjs:148` i `:160` sprawdzają oba zdania; C3 zmienia je razem z tekstami.
- W3-B-4 (opcjonalnie): tekst przed wywołaniem narzędzia jest teraz notatką postępu, nie odpowiedzią dla MG; odpowiedź = tekst po ostatnim narzędziu albo rationale. Jedno zdanie w system[0], jeśli C3 uzna za potrzebne.
- W3-B-5 (opcjonalnie): wynik udanego submitu model widzi dopiero na początku następnej wiadomości MG (przed arkuszem i znacznikiem `<proposal status="pending"/>`); znacznik nadal działa. Nie wymaga tekstu, chyba że C3 opisuje kolejność bloków wiadomości MG.

### Zweryfikowane / niezweryfikowane
- Zweryfikowane w node: `dev/test-harness.mjs` 35/35 (nowe: koniec na submicie z przeładowaniem magazynu, naprzemienność ról i parowanie `tool_use`/`tool_result` w każdym żądaniu, ścisły prefiks historii i bajty prefiksu, warunki końca (submit + inne narzędzie, nieudany submit, mieszane submity, dwa przyjęte, ustawienie wyłączone), nowa rozmowa, limit czasu w kolejnej wiadomości, W3-5 tekst/progress/transkrypt, rejestracja ustawienia); `dev/test-dry-transport.mjs` 12/12; reszta `dev/test-*.mjs` zielona.
- NIE zweryfikowane: prawdziwe API (czy model po wczesnym końcu zachowuje się dobrze, gdy wynik submitu przychodzi razem z kolejną wiadomością MG; myślenie zachowane z podpisem przy takim kształcie), próba na sucho z zastępcą (następna runda), szuflada T7 (render `progress`, rationale jako odpowiedź).
- Znalezione, NIE naprawione (poza zakresem): inne ścieżki nadal zostawiają historię zakończoną wiadomością `user`, więc następna wiadomość MG jest drugą `user` z rzędu: limit żądań po wykonaniu narzędzi (H3), limity błędnych submitów (`invalidSubmits`, `identicalInvalid`), limit kosztu po wynikach narzędzi, odmowa / błąd transportu / Stop w strumieniu po dopisaniu wiadomości MG (H2). Dziś zakłada to scalanie przez API (harness-notes H2); jeżeli API odrzuca kolejne wiadomości tej samej roli (tabela skilla), te ścieżki dadzą 400. Do sprawdzenia w T8 (prawdziwe API); mechanizm `heldToolResults` da się rozszerzyć na przypadki limitów znanych przed dopisaniem.
