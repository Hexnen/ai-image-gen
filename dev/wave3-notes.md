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

## W3-1 / W3-2 / W3-3 (grupa A, writer)

Data: 2026-11-17. Pliki: `scripts/systems/invincible/writer.mjs`, `writer-group.mjs`, `dev/test-build-ops.mjs`. `undo.mjs` bez zmian (niepotrzebne). Commit `0520163`.

### Defekty sprawdzone przed zmianą
- F0: potwierdzone w kodzie (`writer.mjs:877-882` przed zmianą: `docs.forEach((d, i) => batch[i])`) i w kodzie serwera v14 (`resources/app/dist/database/backend/server-backend.mjs`, `_createDocuments`, build 363): `await Promise.all(data.map(async o => { if (keepId && o._id || (o._id = await sublevel.createNewId())) ...; f.push(doc) }))`. Bez `keepId` push następuje po `await`, więc kolejność wpisów do kolekcji rodzica (`m.set` w kolejności `f`) i zwracanej tablicy = kolejność zakończenia. Z `keepId` i `_id` warunek nie wykonuje `await`: push synchronicznie w kolejności danych, zwrot (`Promise.all(g.map)`) w tej samej kolejności.
- 9 (nazwa): potwierdzone (`writer.mjs:668` `name: actor.name`). 9 (ostrzeżenia): potwierdzone (`writer.mjs:845` przenosił tylko `rank.defaulted`).
- 16 / D-1: potwierdzone (`writer.mjs:936-944` tylko w dół).

### Co zmienione
- W3-1: id każdego dodania nadawane przed zapisem (`D.randomID()`, w grupie `foundry.utils.randomID()`; sprawdzane `^[A-Za-z0-9]{16}$` i brak kolizji z przedmiotami aktora, inaczej własny generator), `createEmbeddedDocuments(..., { keepId: true })`. `idMap`, `created`, wpisy dziennika i linki (`system.powerSource`, `system.power`) z tych id; zwracana tablica służy tylko do kontroli. Gdy serwer zwróci przedmiot o obcym id albo innej liczbie: błąd, obce id trafiają do dziennika jako `_foreign` add, więc wycofanie je usuwa (`write.failed`, `rolledBack`). Kolejność kolekcji = kolejność op w partii (talenty: rola hero/occupation/extra wg kolejności op).
- W3-2: op aktora z `set.name` ma `name` = nowa nazwa (także w zwięzłym wyniku `ops[]`). Po udanym zapisie wszystkie ostrzeżenia walidatora trafiają do `warnings` wyniku, raz każde (klucz `code|opId|message`; `rank.defaulted` też tylko raz). Zwięzły wynik bierze z nich `code/message/hint/opId/itemId/path` (pole `gm` odpada jak dotąd).
- W3-3 (D-1 tymczasowo tak): `plan.build` = profil != `in-play` I żaden przedmiot tworzenia (powerSource, power, boost, limit, talent, drawback) aktora nie przetrwa przebiegu (pusty albo w tym przebiegu wyczyszczony) I przebieg dodaje taki przedmiot. Wtedy po fazie aktora bieżące Health/Resolve = max (wpis dziennika `_vitals`, undo przywraca), `result.vitals { health?, resolve?: { from, to } }` (też w zwięzłym wyniku), linia w `message` ("New build: current Health 2 -> 7, Resolve 2 -> 5 (max)."), w planie info `vitals.build`. Wartość jawnie zapisana przez op (allowVitals) wygrywa. Edycje i in-play: tylko dotychczasowe przycięcie w dół (O25).

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| W3-A-1 | Co to „budowa” dla D-1 | Profil creation + pusty/wyczyszczony aktor + dodania przedmiotów tworzenia; tryb (ops/replace) bez znaczenia. Replace na istniejącym bohaterze, który zachowuje choć jeden przedmiot tworzenia, to edycja (Health/Resolve bez zmian). Gear nie liczy się do „pustego”. |
| W3-A-2 | Wartość jawnie podana przez MG (allowVitals) przy budowie | Wygrywa wartość z op; druga wartość idzie na max. |
| W3-A-3 | Odporność na serwer ignorujący `keepId` | Odmowa + wycofanie (z obcymi id). Alternatywa: mapować po nazwie; odrzucona (nazwy się powtarzają). |
| W3-A-4 | Ostrzeżenia walidatora na sukcesie | Wszystkie, deduplikowane; nie filtrowane po kodzie. Jeśli szuflada T7 uzna je za szum, filtr po stronie T7. |
| W3-A-5 | Nazwa w wpisie dziennika op aktora | Bez zmian (nazwa przed zapisem); zmieniona tylko nazwa w planie/wyniku. |

### Texts for C3 (nie zmienione tutaj)
- W3-A-T1: `proposal.mjs:93` (`PROPOSAL_GUIDE` / opis updateActor) mówi „karma/health/resolve (current values) only when the GM asked for them” — nadal prawda; można dopisać „a build from an empty sheet sets current Health/Resolve to max by itself”, żeby model nie dodawał ich sam. Opcjonalne.
- W3-A-T2: podsumowanie walidatora (`proposal.mjs` summary, grupa C) mogłoby pokazać linię „build: current Health/Resolve -> max” dla MG; writer już daje `plan.info vitals.build`. Opcjonalne, nie dla modelu.

### Testy
- `test-build-ops` 39 (+5): fałszywy aktor `serverOrder` (bez keepId kolejność odwrócona, z keepId zwracana tablica przesunięta) i `ignoreKeepId`; idMap, `created`, linki, kolejność i role talentów, linie `pow=`/`src=`/`role=` w bloku arkusza, dziennik, undo per item; ta sama ścieżka przez grupę writera (zwięzłe `ops[].itemId`); wycofanie przy obcych id; D-1 (budowa, undo, in-play, edycja, wyczyszczony aktor, jawna wartość); W3-2 (nazwa, ostrzeżenia raz, bez `gm`). Te same testy na writerze sprzed zmiany: 4 nowe testy padają (sprawdzone).
- Reszta: snapshot 32, catalog 20, enhance 22, harness 31, migrate-id 18, packs 23, prompt-texts 15, transport 27, vendor OK. W chwili uruchomienia czerwone (cudze prace w toku, nie writer): `test-build-validate-invincible` (`grants.heuristic`, `effect.placeholder` w `validate.mjs` grupy C) i `test-dry-transport` (tekst tury, W3-5 grupy B).

### Na żywo (tor 20, kod HEAD `0520163` przez junction na kopię `git archive`; świat przywrócony, slot oddany)
- 5 budów (`pack.apply`, ops, rank teen, profile creation) na pustych aktorach ZZ-W3A-*: źródło + 2 moce + na każdej boost i limit (2+2) + 2 talenty + 2 wady + op aktora. Wszystkie `ok`: każde `idMap[opId]` = przedmiot o oczekiwanej nazwie, `ops[].itemId` = `idMap`, linki mocy/boostów/limitów poprawne, kolejność kolekcji = kolejność op, talenty hero/occupation, wpisy dziennika z właściwymi id, Health/Resolve = max (np. 2 -> 9 / 2 -> 5), wpis `_vitals`, linia w `message`, ostrzeżenia walidatora na sukcesie (`resources.occupation`, `talent.occ.list`), op aktora z nową nazwą.
- Po przeładowaniu strony: kolejność, role (`talentRolesOf` i `role=` w `pack.snapshot`), `pow=`/`src=`, Health/Resolve bez zmian, VALID ok.
- Undo jednej budowy: stan czysty, 13 zmian cofniętych, 0 przedmiotów, nazwa, atrybuty 2 i Health/Resolve 2/2 wrócone.
- Edycja zbudowanego bohatera (Health ustawione na 3, op tekstu): Health zostaje 3 (O25).
- Nie sprawdzone na żywo: tryb replace przez grupę (tylko testy node), budowa w in-play, NPC, serwer ignorujący keepId (tylko mock); wyścig kolejności bez keepId nie był odtworzony na żywo (wynika z kodu serwera).
