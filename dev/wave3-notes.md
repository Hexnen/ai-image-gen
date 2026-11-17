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

## W3-6..W3-13 (grupa C1 + C2: walidator, podsumowanie, katalog)

Pliki: `scripts/systems/invincible/validate.mjs`, `proposal.mjs` (tylko `project` przy notatce + `summarize`), `catalog.mjs`, `dev/test-build-validate-invincible.mjs` (48), `dev/test-catalog-invincible.mjs` (21). `tools.mjs` bez zmian (wynik submitu buduje `toolResult` w `validate.mjs`). Prefiksowych tekstów (`rules-digest.mjs`, `harness-prompt.mjs`, `PROPOSAL_GUIDE`, `TOOL_DESC`) nie ruszano.

### Weryfikacja ustaleń w kodzie (przed zmianą)
- 1 potwierdzone: `limitOf` brał `_grants` modelu (validate.mjs:658, etykieta :681), `grants.heuristic` czytał heurystykę czytnika (:524-529); budżet zawsze liczy z czytnika (reader.mjs:331 -> chargenStateFromActor), `_grants` jest tylko znacznikiem projekcji (proposal.mjs:595), więc liczba slotów była ta sama, różnił się tylko tekst.
- 2 potwierdzone: `drawback.hardTimes` to info z wendorowanych reguł (rules.mjs:220), dokładane przy każdym submicie na karcie z Hard Times.
- 5 potwierdzone: `plan.destructive` = usunięcia (z kaskadą) lub zamiany poziomu mocy dzielonej (writer.mjs:358, 584, 611, 633); słowo „confirm” nie występowało w wyniku dla modelu.
- 6 potwierdzone (hint brzmiał jak polecenie). 7 potwierdzone: `attr.cap` nie jest w `BUDGET_CODES`, więc in-play blokuje nowy błąd. 8 potwierdzone: `npc.name.blank` wychodzi z rules.mjs:243, gdy w relationships nie ma linii `NPC:` z nazwą (także przy pustym tekście). 15 potwierdzone (pole `name` z `withNote`).
- 3 potwierdzone i na żywo: dokładnie 1 wpis katalogu ma klucz efektu z `[...]` i jest to MOC (nie talent): ostrzeżenie działa dla każdego typu. 4 potwierdzone (indeks nie miał efektów; dane `effects` ma tylko dokument, nie indeks).
- Poboczne (naprawione, bo w moim pliku): `effectsOf` (get_entries) czytał tylko `changes`; v14 trzyma je w `system.changes`, więc na prawdziwych danych zmiany mogły ginąć. Teraz oba kształty + `transfer: false`.

### Co działa teraz
- W3-6: etykieta limitu zawsze wg czytnika (`limitReading`: poziom, gdy moc > Basic, inaczej boost). `grants.heuristic` to INFO: „Limit "X": grants "boost" does not change the cost; the sheet reads it as paying for a level (...)”, hint „Nothing to fix.”.
- W3-7: `drawback.hardTimes` tylko gdy zmiana dotyka wady (dodanie/zmiana/usunięcie/kaskada) albo Resources (`updateActor resources`) albo tryb replace. `rank.defaulted` hint: „Nothing to do unless the GM's message names another rank; then ask them to set it in the drawer.”. `npc.name.blank`: bez linii `NPC:` -> „No NPC relationship is written (...)” + hint „At a build, invent one original NPC and write "NPC: Name (type)" in texts.relationships.” (D-15); linia `NPC:` bez nazwy -> „The NPC relationship line has no name.”.
- W3-8: zmiana samej notatki: `u: change drawback "Lean Times" [note "Invented debt"]` (nazwa bazowa + nowa notatka; usunięcie: `[note removed]`); obok innych pól `[level, note "..."]`. Zmiana nazwy gearu nadal `[name]`. `opInfo.changed` ma przy notatce dodatkowe pole `note`.
- W3-10: `submit_proposal` z `ok: true` dostaje `applyConfirm: ['remove power "X"', 'remove limit "Y" (with "X")', 'level swap power "Z" basic -> major']` i `applyConfirmNote: "The GM confirms these at Apply (removals and level swaps); nothing to do for you."`; tylko gdy lista niepusta; `check_proposal` bez tego. Pełny wynik `validate()` ma `applyConfirm` (także pusty) po stronie MG.
- W3-11: `attr.cap` w in-play: hint „The rank cap applies in-play too: keep every attribute within 1..N. If the GM wants a higher value, ask them to change the rank in the drawer.”; w creation bez zmian.
- W3-12 (D-17): info `gear.cost` „Gear "X" cost N at Resources R.” (hint: informacja, MG decyduje) dla gearu/broni pojazdu dodanych albo ze zmienionym `cost`; tylko superbohater; R = zapisane Resources po zmianie.
- W3-9: ostrzeżenie `effect.placeholder` dla przedmiotu DODANEGO tą zmianą (w creation+replace także dla każdego przedmiotu wyniku) z kluczem efektu zawierającym `[...]` (dodane: efekty z wpisu katalogu, bo projekcja ich nie ma; z karty: własne efekty). Model: „... has an effect with a choice left open (bonus.[attribute])” + hint „Write the choice (e.g. the attribute) in the item's note” / „Nothing to fix: the note names the choice” / dla typów bez notatki „Name the choice in choiceNotes”. MG (`gm`): „... edit the effect by hand after Apply (the builder does not fill it in).”. Bez podstawiania w writerze (D-13 otwarte).
- W3-13: katalog wczytuje dokumenty paczek przedmiotów (nowe opcjonalne `source.documents(pack)` = `pack.getDocuments()`, te same dokumenty, które i tak ładuje lookup czytnika) i zapisuje `entry.effects` oraz `entry.placeholders`. Kolumna `fx` w liniach talentów (`ref|name|fx|summary`) i wad (`ref|name|needs|fx|summary`): skrót efektów z dokumentu, np. `bonus.reason-3, 5 others -1`, `reason-3, 5 others -1` (wartość atrybutu), `all attributes -1`, `health+1 (disabled)`, `... (not transferred)`; `;` między efektami, maks. 70 znaków, `-` = brak. Znaczniki rzutów `[[D3]]`, `[[/r 1d6]]{etykieta}` -> `D3` / `etykieta` w `htmlToText` (streszczenia, rulesText). Sekcja `sampleHero` usunięta z indeksu (D-8); `search_catalog` i `get_entries` dalej je obsługują. Linia wstępu indeksu ma dopisek o `fx`.

### Pomiary (tor 8, kopia świata invincible, invincible-core 1.0.2; tylko liczby)
- Indeks (system[2]): 53 232 -> 48 198 znaków (-5 034; ~15 209 -> ~13 771 tok przy znaki/3,5, -1 438 tok). Sekcja sampleHero 5 717 znaków wycięta; kolumna `fx` + nagłówki ~+690 (talenty 5 772 -> ~6 160, wady 1 681 -> ~1 860).
- Prefiks statyczny (system[0] 3 262 + skrót 5 799 + narzędzia 19 314 + indeks): 81 607 -> 76 573 znaków (~23 316 -> ~21 878 tok). W liczeniu próby na sucho (82 424 w R3, z opakowaniem) to ~77 390.
- `fx`: 19/57 talentów i 6/15 wad ma efekty; 9 oznaczonych `disabled`, 0 `not transferred` wśród talentów/wad (efekty z `transfer: false` są w mocy i boostcie); 3 zgrupowane („others”/„all”); najdłuższy 41 znaków (0 obciętych). 348/485 wpisów ma dane efektów. 38 wpisów ma `[[...]]` w HTML, po `htmlToText` 0.
- Budowa katalogu 95-284 ms (wcześniej 133 ms; zależnie od pamięci podręcznej paczek). Indeks bajt w bajt stały między budowami, stary indeks też stały po wczytaniu dokumentów.
- Na żywo walidacja (niezapisany aktor w pamięci, `skipPlan`): dodanie mocy z placeholderem -> `effect.placeholder` z `opId`, `gm` w wyniku MG, brak `gm` w wyniku dla modelu. Nic nie zapisano w świecie.

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Wybór |
|---|---------|-------|
| W3-C-a | Format `applyConfirm` | Tablica opisów (`remove <typ> "<nazwa>"`, kaskada z `(with "...")`, `level swap ...`) + osobne pole `applyConfirmNote`. |
| W3-C-b | Nazwa w linii zmiany notatki | Nazwa bazowa + `[note "<nowa notatka>"]` (pełna nowa nazwa powtarzałaby notatkę). |
| W3-C-c | Kiedy `gear.cost` | Przy dodaniu gearu/broni pojazdu i zmianie `cost`; zawsze info (bez porównania), R = zapisane Resources. |
| W3-C-d | Kiedy `effect.placeholder` | Przedmioty dodane tą zmianą; w creation+replace wszystkie przedmioty wyniku. Przedmiot na karcie: jego własne efekty (MG mógł już poprawić). |
| W3-C-e | Etykiety `fx` | `system.attributes.X.value` -> `X`; `bonus.X` (klucze bonusów systemu) zostają `bonus.X`, bo to inny rodzaj zmiany niż wartość atrybutu; `system.derived.X.bonus` -> `X`; reszta bez `system.`. Grupowanie ta sama wartość na 3+ atrybutach jednej kategorii. |
| W3-C-f | Źródło efektów | Dokumenty paczek (`getDocuments`) w czasie budowy katalogu, nie pole `effects` indeksu (indeks kompendium gubi pola osadzonych dokumentów po wczytaniu, catalog-notes C10). Bez `documents` w adapterze: `fx` = `-`. |

### Texts for C3 (nie zmienione tutaj)
- W3-C-1 `proposal.mjs:90/94` (`PROPOSAL_GUIDE`, schemat limitu `grants`): `grants` nie zmienia kosztu; czytnik decyduje po poziomie mocy. Opisać jako opcjonalne/pochodne albo usunąć ze schematu (W3-14).
- W3-C-2 `tools.mjs:26` / opis `search_catalog`: przykładowi bohaterowie nie są już w indeksie; jedno zdanie „sample heroes: search_catalog kinds ["sampleHero"], then get_entries”.
- W3-C-3 `rules-digest.mjs:50` (wady) i ew. talenty: kolumna `fx` = efekty przedmiotu; wady mogą mieć kary do statystyk (czytać `fx`); `bonus.X` = premia do testu X, `X` = wartość atrybutu; `(disabled)` / `(not transferred)` = efekt nie działa na karcie. Ewentualnie przeredagować dopisek w linii wstępu indeksu (`catalog.mjs` indexText, jedyna moja zmiana tekstu prefiksu).
- W3-C-4 `validate.mjs` `TOOL_DESC.submit_proposal` / skrót: usunięcia i zamiany poziomów potwierdza MG przy Apply; wynik submitu ma `applyConfirm` (nic do zrobienia dla modelu).
- W3-C-5 `PROPOSAL_GUIDE` (note = wybór, D-19): przedmiot z efektem o otwartym wyborze (`[attribute]`): wybór w notatce; MG ustawia efekt.
- W3-C-6 `rules-digest.mjs:43` („ALL available points must be spent”): profil in-play (budżet informacyjny, limit rangi zostaje twardy, D-14); spójne z nowym hintem `attr.cap`.
- W3-C-7 system[0]/skrót (D-15): przy budowie wypełnić oczekiwane teksty, w tym jeden oryginalny NPC w relationships; nie wysyłać ponownie tylko z powodu ostrzeżeń.
- W3-C-8 skrót (D-17): koszt gearu wobec Resources tylko informacyjnie (`gear.cost` info).
- W3-C-9 legenda podsumowania (jeśli C3 ją opisuje): linia notatki `[note "..."]`, nie `[name]`.

### Zweryfikowane / niezweryfikowane
- Zweryfikowane: node `test-build-validate-invincible` 48/48 (nowe W3-6..W3-12, W3-9), `test-catalog-invincible` 21/21 (nowy W3-13), wszystkie `dev/test-*.mjs` zielone, `sync.mjs --check` OK. Na żywo (tor 8): rozmiary indeksu, stabilność, `fx`, znaczniki rzutów, placeholder i `gm` przez prawdziwy katalog.
- NIE zweryfikowane: zachowanie prawdziwego modelu z `applyConfirm`, `fx` i nowymi hintami (następna runda próby); czy `bonus.X` to rzeczywiście premia do testu (nazwa z kodu systemu, nie sprawdzałem silnika efektów); koszt `getDocuments` na zimnym serwerze (mierzone przy już wczytanych paczkach); szuflada T7 nie pokazuje jeszcze `applyConfirm` ani `gear.cost`.

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

## W3-14 (grupa C3: jeden przebieg po tekstach prefiksu + D-9)

Data: 2026-11-17. Pliki: `scripts/build/harness-prompt.mjs` (system[0], wersja 4), `scripts/build/harness.mjs` (tylko `isSubmitCall`), `scripts/systems/invincible/rules-digest.mjs` (`DIGEST_VERSION` 4), `proposal.mjs` (`PROPOSAL_SCHEMA.dryRun`, `PROPOSAL_GUIDE`, `normalize` usuwa `dryRun`), `validate.mjs` (`TOOL_DESC`, `MODEL_TOOL_NAMES`, `isDryRun`, `toolResult`, `runProposalTool`), `tools.mjs` (opis `search_catalog`), `pack.mjs` (komentarz); testy `dev/test-prompt-texts.mjs`, `dev/test-build-validate-invincible.mjs`, `dev/test-harness.mjs`; `dev/ai-gen-spec.md` (dwie linie o `check_proposal`). Wendor bez zmian. Indeks (`catalog.mjs`) nietknięty. Bez toru, bez sieci.

### Co zmienione (listy W3-A-T*, W3-B-1..5, W3-C-1..9 + zakres W3-14)
- D-9: model widzi JEDNO narzędzie propozycji `submit_proposal` z polem `dryRun` (boolean). `dryRun: true` = dawny check: ten sam wynik + `dryRun: true`, bez `proposalId`, bez `applyConfirm`, `rationale` niewymagane, nigdy pending. `check_proposal` zostaje wewnętrznym aliasem `runProposalTool` (testy, ewentualne stare wywołania); nie ma go w `proposalToolDefs()`, więc `prompt.mjs` go nie wysyła ani nie uruchamia z modelu. Harness: `isSubmitCall(name, input, res)` = `submit_*` bez `input.dryRun === true` i bez `res.dryRun === true`; tylko takie wywołania ustawiają propozycję pending, kończą turę (W3-4) i liczą się do limitów błędnych submitów. `normalize` usuwa `dryRun`, więc `proposalId` jest ten sam z `dryRun:false` i bez pola.
- system[0] (W3-B-1, W3-B-4, W3-B-5, D-15, drobne): usunięte „write one short sentence and stop” i „Submit directly; check tool...”; nowe: błędy blokują / ostrzeżenia nie (popraw w tym samym submicie, nigdy nie wysyłaj ponownie tylko z powodu ostrzeżenia); udany submit wysłany bez innych narzędzi kończy turę, nic po nim nie pisać, rationale = odpowiedź dla MG; wynik submitu przychodzi na początku następnej wiadomości MG; tekst przed wywołaniem narzędzia = notatka postępu; formy bezosobowe zamiast rodzaju gramatycznego (przykład „Dodano”).
- Skrót (W3-C-3, W3-C-6, W3-C-7, W3-C-8, zakres): sekcja `## Profiles (sheet header profile=)` (creation: wydaj WSZYSTKIE punkty; in-play: blokują tylko nowe błędy, budżet tylko informacyjny, limit atrybutu rangi nadal błąd, zasady rozwoju nieegzekwowane); „ALL available points” tylko raz (w creation); przykład slotów liczony z wendorowanych liczb („an empty Cosmic Champion sheet has 38 + 2 x 5 = 48 points”); D-18 (punkty zwolnione przy „resztę zostaw” -> atrybuty wg koncepcji, nazwać w rationale, bez pytania); D-10 (brakujące źródło archetypu -> najbliższe źródło z katalogu + zdanie w rationale); kolumna `fx` (wady mogą obniżać atrybuty, `(disabled)`/`(not transferred)` = brak efektu); `texts.role` = angielski klucz z listy ról; minions/challenges/vehicles poza zakresem, jedno zdanie; D-15 (przy budowie wypełnić oczekiwane teksty, jeden oryginalny NPC); D-16 (solo: team/teamBase puste, zdanie w rationale, nigdy „Solo”); D-17 (koszt gearu = info, MG decyduje).
- Opis `submit_proposal` (W3-B-2, W3-C-4): `ok:true` kończy turę, MG widzi podgląd; usunięcia i zamiany poziomów (`applyConfirm`) potwierdza MG przy Apply; `dryRun` tylko do porównania wariantów / wyceny, nigdy przed submitem.
- `PROPOSAL_GUIDE` (W3-C-1, W3-C-5, W3-A-T1, D-19, zakres): limit opłaca poziom swojej mocy (moc tylko Basic: boost), `grants` opcjonalne i nie zmienia kosztu; `limits [{ref}]` w replace; notatka tylko dla prawdziwego wyboru (bez ozdobnych), otwarty wybór efektu (`bonus.[attribute]`) w notatce, MG ustawia efekt; `role` = angielski klucz roli; budowa sama ustawia Health/Resolve na max; replace nigdy nie rusza gearu (gear przez ops); `rationale` wymagane poza `dryRun`.
- `search_catalog` (W3-C-2): indeks ma wszystko oprócz przykładowych bohaterów (`kinds ["sampleHero"]`).
- Pominięte: W3-C-9 (legenda podsumowania nie jest opisana w prefiksie, nic do zmiany); W3-A-T2 (strona MG, nie prefiks); finding 12 (opId w wynikach) bez osobnego zdania (replace już mówi „their opId is the summary's”).

### Rozmiar (znaki / tokeny znaki/3,5; indeks 48 198 znaków z pomiaru W3-13 na torze 8, niezmieniony)
| Blok | Przed | Po |
|---|---|---|
| system[0] | 3 262 / 932 | 3 467 / 991 |
| system[1] skrót | 5 799 / 1 657 | 6 723 / 1 921 |
| tools (JSON) | 19 314 / 5 518 (check 6 387 + submit 9 116 + 4 odczytu) | 13 504 / 3 858 (submit 9 648 + 4 odczytu) |
| razem bez indeksu | 28 375 / 8 107 | 23 694 / 6 770 |
| system[2] indeks | 48 198 / 13 771 | 48 198 / 13 771 |
| cały prefiks | 76 573 / 21 878 | 71 892 / 20 541 (-4 681 zn., ~-1 337 tok, -6,1 %) |

Prefiks zmienia się raz (nowy fingerprint, jeden zimny zapis cache); między wywołaniami bajt w bajt stały (test w procesie i w dwóch świeżych procesach). Bez dynamicznych tekstów (przykład slotów z wendorowanych stałych).

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Wybór |
|---|---------|-------|
| W3-T-1 | `grants`: usunąć ze schematu czy opisać | Zostaje w schemacie (stare wejścia, replay, `replaceToOps`, testy); przewodnik: opcjonalne, nie zmienia kosztu; z listy `limits` w replace usunięte. Usunięcie ze schematu oszczędziłoby ~100 znaków, ale L0 odrzucałby stare wejścia z `grants`. |
| W3-T-2 | Gdzie harness rozpoznaje dry run | `input.dryRun === true` LUB `res.dryRun === true` (`isSubmitCall`); wynik walidatora zawsze niesie `dryRun: true` przy sprawdzeniu. Nieudany dry run nie liczy się do `invalidSubmits` / `identicalInvalid` (jak dawny check). |
| W3-T-3 | Dry run + prawdziwy submit w jednej partii | Prawdziwy staje się pending, ale partia nie jest „tylko submity”, więc tura trwa (model widzi wynik dry runu). |
| W3-T-4 | Próg 16 000 znaków w teście | Teraz obejmuje WSZYSTKIE definicje narzędzi (13 504), nie tylko narzędzia propozycji (9 648); sufit prefiksu bez indeksu obniżony z 8 500 do 7 500 tok (jest 6 770). |
| W3-T-5 | „Submit directly” w system[0] | Usunięte (jedno narzędzie; „never before a submit” jest w opisie `dryRun`). |
| W3-T-6 | Przykład slotów | Liczony z `RANKS` najwyższej rangi (deterministyczny); test pilnuje też dosłownego „38 + 2 x 5 = 48”. |
| W3-T-7 | Gear w replace | Schemat replace nie ma tablicy gear (kod bez zmian); tekst: „gear is never touched (add it with ops)”. Test pilnuje, że schemat nadal nie ma `proposal.gear`. |
| W3-T-8 | Rodzaj gramatyczny | Jedno zdanie w system[0] (bez nazwy systemu gry): formy bezosobowe, przykład polski „Dodano”. |

### Testy
- `test-prompt-texts` 19 (+4 W3-14: system[0], skrót, narzędzia + przewodnik, wynik dry runu; zmienione: system[0] bez „check tool”, D-9 jedno narzędzie zamiast check/submit, dawne linie 148/160 bez „one short sentence”, `grants`, próg 16 000 na wszystkie narzędzia, sufit 7 500 tok).
- `test-build-validate-invincible` 48 (zmienione: lista narzędzi `["submit_proposal"]`, `dryRun` w schemacie, `submit_proposal` + `dryRun` = ten sam wynik co alias `check_proposal`, bez rationale, ten sam `proposalId` z `dryRun:false`, dry run bez `applyConfirm`).
- `test-harness` 36 (+1: dry run nie jest pending, nie kończy tury, nieudany nie trafia w limit (kontrola: prawdziwy trafia), znacznik `dryRun` w wyniku wystarcza, dry run + submit w jednej partii).
- Reszta zielona: ops 39, snapshot 32, catalog 21, dry-transport 12, enhance 22, migrate-id 18, packs 23, transport 27, vendor-sync OK, vendor load 9; `sync.mjs --check` OK.

### Niezweryfikowane
- Zachowanie prawdziwego modelu (i zastępcy) z nowymi tekstami: czy nie pisze nic po submicie, czy nie wysyła ponownie z powodu ostrzeżeń, czy używa `dryRun` rzadko, formy bezosobowe, solo/NPC/D-18/D-10 w praktyce: runda 4 próby na sucho.
- Rzeczywiste tokeny (`count_tokens`) i przyjęcie schematu strict z `dryRun` przez API: T8. Indeks na żywo nie mierzony ponownie (kod indeksu nietknięty, liczba z W3-13).
- Szuflada T7: wywołanie z `dryRun: true` pokazane jak zwykłe narzędzie (nie sprawdzane w UI).
