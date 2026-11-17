# Fala 5: notatki wykonawców

Każdy wykonawca dopisuje własną sekcję (przeczytaj plik tuż przed zapisem).

## W5-B: szum harnessu i walidatora (próba na sucho, rundy 5 i 6)

Pliki: `scripts/build/harness.mjs`, `scripts/systems/invincible/validate.mjs`, `snapshot.mjs`; testy `dev/test-harness.mjs` (+4), `dev/test-build-validate-invincible.mjs` (+3, 2 asercje zmienione), `dev/test-build-snapshot.mjs` (+2, 1 asercja zmieniona), `dev/test-build-ops.mjs` (1 asercja zmieniona). `harness-defaults.mjs`, `build-settings.mjs`, `proposal.mjs`, writer, wendor bez zmian. Teksty prefiksu nietknięte (lista niżej).

### Weryfikacja w kodzie (przed zmianą)
- 1 potwierdzone: `harness.mjs` (przed zmianą ok. :596-637) kończył turę na partii samych przyjętych `submit_*` bez patrzenia na ostrzeżenia; wynik szedł do `heldToolResults`, więc model widział `talent.occ.list` / `talent.role.shift` (dry6 wiadomość 5) dopiero w następnej wiadomości MG, a system[0] mówi „fix them in the same submission” i odradza `dryRun` przed submitem.
- 2 potwierdzone: `validate.mjs:417` dodawał `rank.defaulted` jako ostrzeżenie przy każdym submicie bohatera bez rangi z szuflady/flagi (dry5-bat: 3 razy w jednej próbie); writer (`writer.mjs` W3-2) przenosił je potem do ostrzeżeń wyniku Apply.
- 3 potwierdzone: `costLabel` (`validate.mjs`) mówił tylko `pays for a level of "X"` (W3-6 `limitReading`), także gdy moc ma poziom ORAZ boost (dry5-fire: Fire Control Major + Firestarter + Destructive Flames). Liczba slotów była dobra; brakowało, co zostaje opłacone slotem.
- 4 potwierdzone: `snapshot.mjs buildLines` daje `FLAG undo runs=N last=<runId>`; każdy Apply zmienia tę linię, więc `nextSheetBlock` wysyłał ją w każdym `sheet_update` (dry5-fire 6). `lineDelta` pokazywał brak wartości jako `-` (`resources 2 -> -`, dry5-fire 7), a `-` jest też prawdziwą wartością na karcie (`src=-`, `lvl=-`).
- 5 potwierdzone: linia VALID zawsze liczy obecny (stary) build pod rangą/profilem z szuflady; po zmianie rangi błędy starego bohatera (`attr.over`, `slots.over`, `power.level.massive`, dry6 4) stoją bez słowa wyjaśnienia.
- 6 tylko weryfikacja (plik writera należy do innego agenta, bez zmian): (a) `message` wyniku Apply używa `doc.name` PO fazie aktora (`writer.mjs` faza `actor` przed złożeniem `message`), więc nowa nazwa: OK. (b) `ops[]` aktora: nowa nazwa (W3-2, `writer.mjs` ok. :731-733): OK. (c) `ops[]` `addItem`: nazwa z danych nowego przedmiotu (`data.name`, z notatką): OK. (d) `ops[]` `updateItem` NIE jest kompletne: plan bierze `name: it.name` (`writer.mjs` ok. :564, także `p.updates`/`exec.updates`/`p.swaps` :647-659) = nazwa PRZED zmianą, choć `changes` zawiera `name` (notatka przez `withNote`, :609; zmiana nazwy gearu, :613; zamiana poziomu z notatką). To jest obserwacja dry5-dd 3 („ops list reports the old name … after the change”). Poprawka dla właściciela writera: `name` = `changes.find(c => c.path === "name")?.to ?? it.name` w `pl`/`p.updates` (dziennik undo może zostać przy starej nazwie, jak W3-A-5). (e) `created[]` NIE jest w kolejności op: zapis idzie fazami `CREATE_PHASES` (źródła, moce, boosty/limity, talenty/wady, gear), w fazie w kolejności op; `created.push` w pętli faz (`writer.mjs` ok. :1008-1013). Wiarygodne mapowanie op -> przedmiot to `idMap` (i `ops[].itemId`), nie indeks w `created`. Kolejność kolekcji aktora = kolejność faz (dry5-sp 13: moce alfabetycznie w bloku karty to sortowanie czytnika `orderItems`, nie zapisu).

### Co zmienione
- W5-B-1 (tymczasowo, do decyzji): runda poprawki. Gdy partia samych przyjętych submitów niosłaby turę do końca (W3-4), ale wynik ma co najmniej jedno ostrzeżenie DO POPRAWY, harness NIE kończy tury: dopisuje wyniki do historii i wysyła jeszcze jedno żądanie (zdarzenie `fix-round { ids }`, `TurnSummary.fixRound: true`, `turn.fixRound` w zapisie tury). W tej rundzie każda partia z prawdziwym submitem kończy turę bez względu na wynik (przyjęty: nowa propozycja pending; z ostrzeżeniami: koniec; odrzucony: koniec, wcześniejsza przyjęta propozycja zostaje pending, wynik błędu czeka w `heldToolResults`). Najwyżej jedna runda na wiadomość MG. Odpowiedź tekstem w rundzie = `reason: "done"` z tym tekstem. Dodatkowe żądanie liczy się do limitów (żądania, koszt, czas, narzędzia); gdy limit żądań albo narzędzi jest już osiągnięty, rundy nie ma (koniec na submicie jak dotąd). `endTurnOnSubmit` wyłączone: bez zmian (stare dodatkowe żądanie, bez `fixRound`). Dry run nigdy nie uruchamia rundy.
- „Do poprawy” (`validate.mjs` `isActionableWarning`, `actionableWarnings(name, res)`, wystawione w grupie walidatora, więc `pack.actionableWarnings` przez `Object.assign` w `pack.mjs`): ostrzeżenie (nie info) z niepustą podpowiedzią, kod spoza `QUIET_CODES` i spoza `NO_FIX_WARNINGS` (`rank.defaulted`, `rank.differs`, `slots.over`, `remove.handEdited`, `note.cut`, `npc.threat`, `field.sensitive`, `baseline.tolerated`, `budget.delta`, `gear.cost`, `effect.filled`), podpowiedź nie zaczyna się od „Nothing to fix/do”, „Information only”, „Fine if”, „In-play:”. Wynik odrzucony albo dry run: zawsze pusto. Harness bez `pack.actionableWarnings`: ogólna reguła (podpowiedź niepusta i nie „nothing to …/information only/fine if”).
- W5-B-2: `rank.defaulted` jest INFO, gdy ranga domyślna i nic nie koliduje; ostrzeżeniem zostaje tylko, gdy wynik jest odrzucony (błąd może wynikać z rangi domyślnej) albo propozycja podaje inną rangę (`rank.differs`). Decyzja w `finish` walidatora (jedno miejsce dla wszystkich warstw). Komunikat i podpowiedź bez zmian. Skutek: udany Apply bez rangi nie ma już `rank.defaulted` w ostrzeżeniach wyniku (writer przenosi tylko ostrzeżenia); odrzucony nadal ma.
- W5-B-3: etykieta limitu w podsumowaniu (i `budget.perOp[].label`) wg czytnika, oba fakty, gdy moc ma poziom i boost: `add limit "Destructive Flames" cost: pays for the level Major of "Fire Control" (no slot for it; slots 2/3); the boost "Firestarter" stays paid by a slot +2 pts`. Massive i wyżej: `pays for a level (Massive) of "X"`; kilka boostów: `the boosts "A", "B" stay paid by slots`. Bez boostu i na Basic: tekst W3-6 bez zmian. Funkcja `limitPays` (eksport, test czysty).
- W5-B-4: `sheet_update` nie niesie linii `FLAG undo` (zbiór `GM_ONLY_KEYS`): zmiana tylko tej linii = `<sheet_unchanged/>`, zmiana razem z innymi = aktualizacja bez niej; `held` zostaje tym, co ma model (stara linia FLAG), pełny blok (pierwszy, `supersedes`, po 8 diffach, dryf) nadal ją pokazuje. `FLAG pu` (ranga plus-ultra) idzie jak dotąd. Progi (25 %, 1500 tok, 8 diffów) i `supersedes` bez zmian. W `(changed: ...)` brak wartości po nowej stronie = `removed` (`resources 2 -> removed`), po starej = `none` (`resources none -> 4`).
- W5-B-5: gdy ranga albo profil w linii ACTOR różni się od tej, którą ma model, a nowa linia VALID ma `errors=` lub `warns=`, pod linią VALID stoi wcięta notatka `  (rank changed global -> teen: VALID checks the existing build against the new setting)` (profil: `profile changed creation -> in-play`; oba naraz po przecinku). W aktualizacji pod `~ VALID` (po `(changed: ...)`), w pełnym bloku pod `VALID`. Notatka nie jest linią karty: `held`, złożenie i `parseSheet` (pomija wcięte linie) bez zmian; przy kolejnej wiadomości pod tą samą rangą znika.

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Wybór |
|---|---------|-------|
| W5-B-a | Co to ostrzeżenie „do poprawy” | Reguła pakietu (`actionableWarnings`): podpowiedź prosi o zmianę, kod spoza listy „sprawa MG / zamierzone”. `talent.role.shift` liczy się (podpowiedź warunkowa, ale dry6 pokazał realny błąd roli); `remove.handEdited` nie (MG widzi w podglądzie). |
| W5-B-b | Runda poprawki: co kończy turę | Każda partia z prawdziwym submitem (także odrzuconym, także z innym narzędziem); partia bez submitu (np. `get_entries`, dry run) toczy się dalej w limitach. |
| W5-B-c | Limity przy rundzie | Dodatkowe żądanie jest zwykłym żądaniem (liczone wszędzie). Rundy nie ma, gdy limit żądań lub narzędzi już osiągnięty (żeby tura nie kończyła się `cap` mimo przyjętej propozycji). Limit kosztu sprawdzany dopiero przy żądaniu (może dać `cap: cost`; propozycja zostaje pending). |
| W5-B-d | `rank.defaulted`: kiedy ostrzeżenie | Walidator NIE widzi wiadomości MG (pakiet dostaje tylko wejście narzędzia), więc „nie da się dopasować wiadomości do rangi” przybliżone przez: propozycja podaje inną rangę (`rank.differs`) albo wynik odrzucony. Dopasowanie słów rangi w wiadomości MG wymagałoby nowego kanału harness -> walidator (odrzucone: model już ma regułę „inna ranga = zapytaj”). |
| W5-B-e | Linia `FLAG undo` w pełnym bloku | Zostaje (zakres zadania: tylko `sheet_update`). Alternatywa: usunąć ją z karty modelu całkiem (oszczędność ~10 tok na pełny blok); decyzja właściciela. |
| W5-B-f | Słowa dla braku wartości | `removed` (nowa strona) i `none` (stara strona). |
| W5-B-g | Kiedy notatka o zmianie rangi | Tylko gdy VALID ma `errors=`/`warns=` (bez problemów nic nie myli); porównanie słowa rangi (bez `(drawer)`/`(default)`), więc `global(default)` -> `global(drawer)` nie daje notatki. |

### Texts for W5-T (nie zmienione tutaj)
- W5-B-T1 (ważne, sprzeczność z kodem) `harness-prompt.mjs:23-24` (system[0]): „never resubmit only because of a warning” i „You see its result at the start of the GM's next message” kłócą się z rundą poprawki. Sens nowego zdania: „ok:true with a warning that asks for a fix: you get the result at once (one fix step): send ONE corrected submission, or end with one sentence why the warning stays; a submission in that step ends your turn whatever its result. Without such warnings you see the result at the start of the GM's next message.” Testy `dev/test-prompt-texts.mjs:212-214` sprawdzają obecne zdania: zmienić razem z tekstem.
- W5-B-T2 `TOOL_DESC.submit_proposal` (`validate.mjs`): „ok:true ends your turn” -> sens „ok:true ends your turn (warnings to fix: after one more step)”; `dev/test-prompt-texts.mjs:164` sprawdza „ok:true ends your turn” (zostaje prawdziwe jako początek zdania). `dryRun ... never before a submit` może zostać (runda poprawki zastępuje potrzebę dry runu).
- W5-B-T3 skrót/system[0] (ranga): `rank.defaulted` przychodzi teraz w `info` („Nothing to do …”), w `warnings` tylko przy odrzuceniu albo innej randze w propozycji; jeśli tekst gdzieś mówi o „warning rank.defaulted”, zmienić na info.
- W5-B-T4 `harness-prompt.mjs` (blok `sheet_update`): wcięta notatka pod VALID `(rank changed a -> b: VALID checks the existing build against the new setting)` opisuje stan, nie jest linią do złożenia i nie jest winą ostatniej propozycji; `(changed: x -> removed)` / `none -> y`.
- W5-B-T5 skrót (limity, opcjonalnie): podsumowanie mówi, co limit opłaca, także „the boost Y stays paid by a slot”; cytować je w rationale (obecne zdanie „the summary says it” już wystarcza).

### Testy
- `test-harness` 40 (+4 W5-B-1: bez ostrzeżenia / tylko ciche / bez podpowiedzi -> koniec po 1 żądaniu; ostrzeżenie do poprawy -> dokładnie 1 dodatkowe żądanie, model widzi wynik od razu, drugi submit z ostrzeżeniami kończy turę, nowa propozycja pending, wynik czeka w held, historia poprawna, następna wiadomość MG działa; odpowiedź tekstem = `done`; odrzucony submit w rundzie kończy turę, pending = pierwsza; ustawienie wyłączone = stare zachowanie; `maxRequests: 1` / `maxToolCalls: 1` -> bez rundy; reguła pakietu wygrywa w obie strony; dry run nigdy).
- `test-build-validate-invincible` 54 (+3: W5-B-2 info / odrzucenie -> ostrzeżenie raz / inna ranga -> oba ostrzeżenia / ranga wybrana -> nic, także w wyniku narzędzia; W5-B-3 etykieta i linia podsumowania na prawdziwej projekcji + czyste przypadki Massive / kilka boostów / Basic / bez boostu; W5-B-1 `actionableWarnings`/`isActionableWarning`/`NO_FIX_WARNINGS`, grupa wystawia funkcję, czysta budowa bez rangi = 0. Zmienione: P1-G i W3-7 czytają `rank.defaulted` z `info`).
- `test-build-snapshot` 37 (+2: W5-B-4 FLAG undo: sama zmiana = unchanged, z inną zmianą = update bez FLAG, pełny blok ją ma, `FLAG pu` idzie, `removed`/`none`; W5-B-5 notatka po zmianie rangi (update) i profilu (pełny blok), brak przy tej samej randze i na pierwszym bloku, `held` = świeża karta, `parseSheet` pomija wcięcia. Zmieniona asercja W4-B-6: `-> removed`).
- `test-build-ops` 41 (asercja P1-F/P1-G: udany Apply bez rangi nie ma `rank.defaulted` w ostrzeżeniach; odrzucony nadal ma).
- Wszystkie `dev/test-*.mjs` zielone w żywym folderze (z cudzymi niezacommitowanymi zmianami writera i szuflady): ops 41, snapshot 37, validate 54, catalog 25, drawer-model 9, dry-relay 13, dry-transport 12, enhance 22, harness 40, migrate-id 18, packs 23, prompt-texts 22, transport 27, vendor load 9, vendor-sync ALL OK (wendor bajt w bajt).

### Niezweryfikowane
- Bez toru i bez prawdziwego modelu: czy model w rundzie poprawki rzeczywiście poprawia (a nie pisze tekstu), ile kosztuje dodatkowe żądanie (szacunek: ~1 odczyt cache + wynik submitu, rząd 0,005-0,01 USD przy cenach z próby 5), zachowanie prawdziwego API przy wyniku z ostrzeżeniami w środku tury (ten sam kształt co przed W3-4, więc bez ryzyka formatu).
- Szuflada T7 nie pokazuje jeszcze `fix-round` ani `fixRound` (nowe zdarzenie/pole; render to sprawa T7).
- Punkt 6d (nazwa `updateItem` w `ops[]`) zostaje do poprawki w writerze (inny agent).

## W5-A: writer i Undo (próba na sucho, runda 6: jedna rozmowa, sześciu bohaterów na jednym aktorze)

Pliki: `scripts/systems/invincible/writer.mjs`, `writer-group.mjs`, `undo.mjs`, `replace.mjs` (tylko `talentOrder` w wyniku `toOps`), test `dev/test-build-ops.mjs` (+11). Walidator, `proposal.mjs`, teksty prefiksu, wendor bez zmian. Commit `c632b47` (kod + testy).

### Weryfikacja przed zmianą (dry6-multi)
- 1 potwierdzone: `plan.build` (W3-3) wymagał, żeby żaden przedmiot tworzenia nie przetrwał przebiegu. Replace „zmień go w X” zachowuje choć jeden (tu: źródło Freak accident, Compelling, Mutation), więc build = false i zostaje tylko przycięcie w dół: `STORED health 6 resolve 5` przy max 14/7 (wiadomość 4), 6/11 (5-6).
- 2 potwierdzone: `revert` odtwarzał usunięte przedmioty `createEmbeddedDocuments(keepId)` NA KOŃCU kolekcji, zamiana poziomu (delete + create) też przesuwa moc na koniec; dziennik nie znał kolejności. Bieg `mcOZl9j2q53tpEtI` (op: usuń Compelling, dodaj Compelling, Strike major -> basic, usuń Mind Control): po Undo te same id, ale kolejność `[..., Menacing, ..., Mind Control, Compelling, Strike]` (`items-after-undo.json`), więc Menacing = hero, Compelling = occupation, odwrotnie niż `snapshot-5.txt`.
- 3 potwierdzone: replace zachowuje dopasowane talenty w miejscu, nowe trafiają na koniec; kolejność listy `talents` modelu nie wpływała na wynik (dry6 5: [Menacing, Compelling] dało Compelling = hero).
- W5-B 6d (z sekcji W5-B): potwierdzone, `pl.name` / `p.updates[].name` = nazwa sprzed zmiany notatki / nazwy gearu.

### Co zmienione
- W5-A-1 (tymczasowo): KAŻDY replace w profilu creation to budowa: po fazie aktora bieżące Health/Resolve = max (także gdy przebieg usuwa stare przedmioty). Tryb ops: reguła W3-3 bez zmian (pusty / wyczyszczony aktor + dodania). In-play: nigdy (O25). Wpis dziennika `_vitals` (Undo przywraca), `result.vitals`, linia w `message` („New build: current Health 6 -> 14, Resolve 5 -> 7 (max).”), w planie info `vitals.build` z tekstem „Replace in the creation profile is a build: ...”. Wartość jawnie zapisana przez op (allowVitals) nadal wygrywa.
- W5-A-2: każdy przebieg zapisuje `Run.order` = id przedmiotów aktora w kolejności kolekcji PRZED przebiegiem. Undo całego przebiegu (albo wszystkiego, co z niego zostało) i wycofanie po błędzie (rollback) stawiają KAŻDY przedmiot z powrotem na jego miejscu; Undo per przedmiot stawia tylko odtwarzane przedmioty (usunięte, stare dokumenty poziomu) obok ich dawnego poprzednika, resztę zostawia. Mechanizm (czysty, `undo.mjs`): `restoreTarget(current, order, pending, full)` -> docelowa kolejność; `movePlan(current, target)` -> najdłuższy prefiks celu, który już stoi w tej kolejności, zostaje, reszta jest tworzona na nowo (keepId, bieżące źródło, ten sam `_id`) w docelowej kolejności: JEDNO usunięcie i JEDNO utworzenie (`placeItems`), także dla odtwarzanych przedmiotów (nie są już tworzone wcześniej osobno). `createKeep`: jedna ponowna próba dla brakujących, potem błąd z nazwami. Odcisk (`fingerprint`) pomija `_stats` i `sort`, więc dryf innych przebiegów po takim odtworzeniu = brak (test). Przebiegi zapisane przed W5-A (bez `order`): Undo jak dawniej (odtworzone na końcu).
- W5-A-3: replace zapisuje kolejność talentów z propozycji. Plan: talenty po fazach (zachowane w miejscu + nowe na końcu) vs kolejność z propozycji (`talentOrderOf`: `srcItems`/`src` konwertera walidatora po ścieżce `proposal.talents[i]`, albo `talentOrder` z `replace.mjs`); talenty od pierwszej pozycji nie na miejscu są po fazie usunięć tworzone na nowo (keepId, to samo źródło, te same id) w kolejności propozycji (faza `order`). Deterministyczne (`movePlan`). Talenty, których propozycja nie wymienia (odznaczone usunięcie), idą za nimi w swojej kolejności. Tryb ops: nigdy (model układa sam przez usuń + dodaj).
  - Plan: `reorders [{ id|null, opId|null, name, from, to, roleChange }]`, `counts.reorder`, info `talent.order`, projekcja w zapisanej kolejności. `roleChange` = ZACHOWANY talent zmienia rolę (hero/occupation/extra) -> `plan.destructive`, Apply wymaga `confirmed: true`, zwięzły wynik `confirm` ma wpis `{ opId: "_order", action: "reorder", name, itemId, from, to }`. Odtworzenie bez zmiany roli (albo nowy talent odtworzony drugi raz) nie trafia na listę potwierdzeń.
  - Apply: wpis dziennika `{ opId: "_order", kind: "order", itemId: null, type: "talent", name: "talent order", ids }` (źródła tylko w pamięci na wypadek rollbacku, w dzienniku `before: null`); Undo przebiegu przywraca kolejność przez `Run.order`. Wynik: `reordered [{ itemId, name, from?, to? }]` (też w zwięzłym), zwięzły `reorders`, linia w `message` („Talents in the proposal's order ("Compelling" hero -> occupation; same ids).”).
  - Ostrzeżenie walidatora `talent.role.shift` jest w trybie replace pomijane w wyniku Apply (rzutowanie walidatora trzyma zachowane talenty w miejscu, więc opisuje przesunięcie, które już nie nastąpi). Wynik `submit_proposal` (walidator) nadal je ma: patrz W5-A-V1.
- W5-B 6d: op `updateItem` / zamiana poziomu w `ops[]` i `p.updates` nosi nową nazwę (`changes.name.to`), jak op aktora (W3-2). `p.swaps[].name` i dziennik zostają przy nazwie sprzed zmiany (W3-A-5).

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| W5-A-a | Kiedy replace jest budową | Zawsze w profilu creation (także bez usunięć i gdy nic się nie zmienia: wtedy Health/Resolve idą na max). Tryb ops bez zmian (W3-3). In-play nigdy (O25). |
| W5-A-b | Undo per przedmiot a kolejność | Tylko odtwarzane przedmioty wracają na miejsce (obok dawnego poprzednika); reszta przebiegu (np. przestawione talenty) zostaje. Undo reszty przebiegu = pełna kolejność sprzed przebiegu. |
| W5-A-c | Undo starszego przebiegu (nie ostatniego) | Pełna kolejność sprzed TEGO przebiegu dla przedmiotów, które wtedy były; późniejsze przedmioty za nimi w obecnej kolejności. Dryf jak dotąd pyta o potwierdzenie. |
| W5-A-d | Jak zmieniać kolejność w v14 | Usunięcie + utworzenie z keepId (to samo źródło i id), minimalny ogon (`movePlan`). Innej drogi niż kolejność tworzenia nie ma: v14 trzyma listę id w rodzicu w kolejności zapisu (W2-3); `sort` nie ma wpływu na rolę. Skutek uboczny: dziennik plus-ultra (scribe) widzi `item.remove` + `item.add` dla odtworzonych przedmiotów (jak przy dotychczasowym Undo usunięć i zamianach poziomu). |
| W5-A-e | Replace: kolejność talentów z propozycji | Wdrożone (nie za ryzykowne: ta sama operacja co Undo usunięć, id i źródła bez zmian, rollback odtwarza brakujące). Zachowany talent zmieniający rolę = potwierdzenie MG (jak usunięcie). |
| W5-A-f | Lista potwierdzeń | Tylko odtworzenia ZACHOWANEGO talentu ze zmianą roli; id nigdy się nie zmienia. Inne odtworzenia: tylko w `reorders`/`reordered` i w info planu. |
| W5-A-g | (4) `markProposal` po Undo | Zostaje W7-1: szuflada woła `markProposal(id, "pending")` (zapis cofnięty, propozycję można zastosować znowu); bez czwartego stanu. Kod bez zmian. |

### Dla agenta walidatora (kod, nie tekst prefiksu)
- W5-A-V1 (ważne): `validate.mjs` `talentShifts` w trybie replace porównuje rolę z rzutowania `proposal.mjs project` (zachowane talenty w miejscu, nowe na końcu) z kolejnością listy; writer od W5-A-3 zapisuje kolejność listy, więc w replace przesunięcia nie ma. Do zmiany: w replace `talentShifts` -> `[]` (albo rzutowanie talentów w kolejności propozycji). Bez tego wynik `submit_proposal` nadal ma fałszywe `talent.role.shift`, a od W5-B-1 to ostrzeżenie „do poprawy”, więc wywołuje zbędną rundę poprawki. Tryb ops: bez zmian (tam przesunięcie jest prawdziwe).
- W5-A-V2 (opcjonalnie): `applyConfirm` (W3-10) mógłby wymieniać `reorder talent "X" hero -> occupation` dla zachowanego talentu zmieniającego rolę (writer potwierdza go przy Apply). Model nic z tym nie robi, więc niski priorytet.
- W5-A-V3 (szuflada T7): zwięzły wynik ma nowe pola `reorders`, `reordered` i akcję `reorder` w `confirm` (z `from`/`to`); okno potwierdzenia powinno ją pokazać („Quick Wits: hero -> occupation”).

### Texts for W5-T (nie zmienione tutaj)
- W5-A-T1 `rules-digest.mjs:53` (skrót, talenty): „A new talent is always added last, so replacing the hero or occupation talent shifts roles (warning talent.role.shift)” jest prawdą tylko w ops. Sens: „replace: the talents list order IS the result (the builder re-orders kept talents); ops: a new talent is added last, so removing the hero or occupation talent shifts roles (warning talent.role.shift)”.
- W5-A-T2 `validate.mjs:168` (`talent.role.shift` hint): „remove and re-add the talents that must come after the new one” zostaje dla ops; w replace po W5-A-V1 ostrzeżenia nie będzie. Jeśli V1 zostawi je w replace, hint powinien mówić „in replace the list order is the result: just order the list”.
- W5-A-T3 `proposal.mjs:97` (`PROPOSAL_GUIDE`, replace): „talents [{ref, note}] (hero talent first, then the occupation talent, then extras)”: dopisać „this order is written as is (kept talents are re-ordered)”.
- W5-A-T4 skrót/`PROPOSAL_GUIDE` (budowa, rozszerza W3-A-T1): „a build sets current Health/Resolve to max” -> „a replace in the creation profile (and a build from an empty sheet) sets current Health/Resolve to max by itself; ops edits and in-play never touch them unless the GM asks”.
- W5-A-T5 (opcjonalnie) `applyConfirmNote`/system[0]: przy Apply MG potwierdza też zmianę roli zachowanego talentu (replace); nic do zrobienia dla modelu.

### Testy
- `test-build-ops` 52 (+11): czyste `restoreTarget`/`movePlan`/`talentOrderOf`; Undo usuń + dodaj talent bohatera (przypadek dry6) przywraca id, kolejność, źródła i role, z `serverOrder` i bez; Undo zamiany poziomu (Iron Hide) wraca moc na miejsce, starszy przebieg czysty, dryf nadal wykrywany; Undo per przedmiot (usunięty talent zawodu wraca na miejsce, reszta zostaje; potem reszta przebiegu = pełna kolejność); rollback po błędzie w fazie aktora = kolejność sprzed przebiegu; przebieg bez `order` nadal cofalny; replace z odwróconą listą talentów (tylko kolejność, bez op): plan `reorders`, potwierdzenie, Apply, te same id i źródła, wpis `_order` bez źródeł, powtórny plan bez odtworzeń, Undo; przypadek dry6 przez grupę writera (nowy talent bohatera + zachowany, usunięcie): kolejność propozycji, `talent.role.shift` pominięte, inne ostrzeżenia zostają, `confirm` bez wpisu reorder przy tej samej roli, Health z 3 na max, Undo; ops nigdy nie przestawia, `replace.mjs` daje `talentOrder`; W5-A-1 replace z usunięciem -> max, Undo, in-play i edycja ops bez zmian; W5-B 6d nazwy. Kontrola mutacją: bez przywracania kolejności 6 nowych testów pada, bez fazy `order` 2.
- Reszta `dev/test-*.mjs` zielona w żywym folderze: snapshot, validate 54, catalog 25, drawer-model 9, dry-relay 13, dry-transport 12, enhance 22, harness 40, migrate-id 18, packs 23, prompt-texts 22, transport 27, vendor load 9, vendor-sync ALL OK.

### Na żywo (tor 8, kod: żywy folder MOD po commicie `c632b47`; świat przywrócony, slot oddany)
- Odtworzenie rundy 6 na nowym aktorze ZZ-W5A-replay (Health/Resolve startowo 2/2): prawdziwe wejścia `input` z `dry6-multi/saved/apply-1..6.json` (rationale skrócone), `pack.apply(..., { rank, profile, confirmed: true })`; w biegu 6 (ops) id z `snapshot-5.txt` przemapowane po nazwie i typie.
- Witalność (W5-A-1): po każdym replace Health/Resolve = max: 10/10 8/8, 7/7 7/7, 6/6 5/5, 14/14 7/7 (dry6: 6/14 5/7), 11/11 7/7 (dry6: 6/11); linia „New build: current ...” w `message` każdego replace. Bieg 6 (ops): bez zmian (O25).
- Kolejność z propozycji (W5-A-3): bieg 5 (wampir, [Menacing nowy, Compelling zachowany], Mighty usunięty) dał Menacing = hero, Compelling = occupation (dry6: odwrotnie); `reordered` = Compelling (rola occupation -> occupation, więc bez wpisu w `confirm`); `talent.role.shift` nie było w ostrzeżeniach wyniku (zostało `talent.occ.list`).
- Undo biegu 6 (usuń + dodaj Compelling, zamiana poziomu Strike, usunięcie Mind Control): te same id w tej samej kolejności co przed biegiem, tekst `pack.snapshot` identyczny z tym sprzed biegu (diff pusty, także `fp`), role Menacing hero / Compelling occupation, undoStatus czysty (następny bieg 5 bez dryfu).
- Undo biegu 5 (replace z odtworzeniem talentu): kolejność = `Run.order` biegu 5, All Might z Mighty hero / Compelling occupation, Health 14/14; po przeładowaniu strony te same id w tej samej kolejności i identyczny tekst karty (`role=hero`/`role=occupation`).
- Replace samą zmianą kolejności talentów ([Compelling, Mighty]): bez `confirmed` -> `needsConfirm`, `confirm` = `{ action: "reorder", name: "Mighty", from: "hero", to: "occupation" }`, nic nie zapisane; z `confirmed` -> 0 op, Compelling hero / Mighty occupation, te same id; Undo -> poprzednia kolejność.
- Niezweryfikowane: szuflada T7 (render `reorder` w oknie potwierdzenia, `reorders`/`reordered`); prawdziwy model po zmianie (W5-A-V1 i teksty W5-T jeszcze nie wdrożone, więc wynik `submit_proposal` w replace nadal może mieć fałszywe `talent.role.shift` i rundę poprawki W5-B-1); Undo per przedmiot i rollback tylko w node (mock); dziennik plus-ultra przy odtworzeniach (`item.remove`/`item.add`) nie oglądany; serwer bez keepId (tylko mock).

## W5-T7: szuflada MG (czat z AI przy karcie postaci)

### Pliki
- `scripts/build/drawer-app.mjs` (ApplicationV2 bez ramki, części tab/head/log/card/composer, dokowanie, akcje), `scripts/build/drawer-model.mjs` (czysta logika, testy w node), `templates/builder-drawer.hbs`, `styles/builder-drawer.css` (dopisany do `module.json`), klucze `MAIG.Drawer.*` w `lang/en.json` i `lang/pl.json` (103, tylko dopisane), dynamiczny import w `scripts/module.mjs` (tylko MG), test `dev/test-drawer-model.mjs` (9), zrzuty `dev/screenshots/01..08`.
- Harness i pakiet systemu bez zmian (żadna luka API nie wymagała poprawki).

### Wybory
| id | Temat | Wybór |
|---|---|---|
| W5-T7-1 | Karta po Cofnij | `markProposal(id,"pending")` nie przywraca `pendingProposal` w harnessie; szuflada liczy kartę z najnowszego stanu propozycji `pending` i bierze wejście z transkryptu (`cardProposal` z flagą `restored`). Bez zmian w harnessie. |
| W5-T7-2 | Apply | Opcje do `pack.apply` = `effectiveOptions(session.options, domyślna ranga)`; `expect` z `pack.plan` tej samej propozycji (cache po `proposalId|rank|profile`, unieważniany hookami aktora/przedmiotów). `needsConfirm` -> DialogV2 z listą `confirm` (Usuń/Zamień) -> drugie wywołanie z `confirmed:true` -> `markProposal(applied,{runId})`. |
| W5-T7-3 | Odświeżanie karty | Szuflada czeka 250 ms po zapisie; gdy arkusz sam się nie przerysował, wywołuje `render()` na otwartych arkuszach aktora (`lastWriteStats.forced`). W próbie nie było potrzebne (forced 0 przy Apply, edycji i Cofnij). |
| W5-T7-4 | Dokowanie | Prawa krawędź arkusza, top = arkusz + 38 px (pod nagłówkiem); za mało miejsca po prawej -> lewa strona (`flip`), dalej za mało -> panel min 300 px przyciśnięty do ekranu. ResizeObserver + MutationObserver na style/klasie arkusza; zminimalizowany arkusz chowa szufladę. Zamknięcie arkusza zamyka szufladę (sesja zostaje w pamięci). |
| W5-T7-5 | Przycisk | Kontrolka nagłówka `fa-robot` przed copyUuid/close (`aria-pressed`) + wpis w menu trzech kropek; tylko MG, tylko aktor obsługiwany przez pakiet i z prawem zapisu. Sesja w pamięci z kartą pending -> po otwarciu arkusza zwinięta zakładka z kropką. |
| W5-T7-6 | Wygląd | Tryb Operate: jasny papier / ciemny wariant pod `body.theme-dark`, pasek tytułu w niebieskim arkusza (#3465a3 / ciemny #3a6fb5), żółty systemu #ffe72a tylko na fokus, zaznaczenie i kropkę; Roboto, bez gradientów, bez wielkich liter w etykietach; Stop pełny czerwony. Nazwy rang tylko po angielsku. |
| W5-T7-7 | Licznik | Pod polem: koszt rozmowy, tokeny, cache %; w turze `Żądanie n/12 · narzędzia n/40 · $x z $0.500` (limity z `harness.settings()`), bursztyn blisko limitu. Skróty klawiszy chowane w turze (jedna linia). |
| W5-T7-8 | Runda poprawki (W5-B-1) | Zdarzenie `fix-round` daje w bloku „AI pracuje” linię „Sprawdza uwagi: jeden krok poprawki”. Niezweryfikowane na żywo (dodane po próbie). |
| W5-T7-9 | Wąskie okno | Siatka opcji `minmax(0, …)`: przy panelu 300 px selekty się zwężają zamiast wypychać „Zasady” poza szufladę (znalezione na zrzucie 08, poprawione). |
| W5-T7-10 | Zamknięcie arkusza | Hook `closeApplicationV2` od razu wyjmuje szufladę z mapy (jej zamknięcie trwa do ~2,5 s z animacją arkusza). |

### Próba na żywo (tor 8, świat przywrócony, slot oddany; relay na sucho, odpowiedzi z `dry5-sp`)
- Apply budowy Spider-Mana (9 przedmiotów) przy otwartym arkuszu: arkusz przerysował się sam 8 razy (render hook), 0 wymuszeń; DOM 0 -> 9 przedmiotów, imiona, atrybuty (Walka 6, Zwinność 8…), Zdrowie 10, Determinacja 7, Resources 2 (efekt Hard Times) od razu. 14 zdarzeń dokumentów.
- Edycja (zawód -> Investigator, usuń Knowledgeable z dialogiem potwierdzenia, dodaj Investigator, notatka Targeted -> Kraven the Hunter): 9 renderów, 0 wymuszeń; DOM pokazuje Investigator i Kravena, Knowledgeable zniknął, pole zawodu = Investigator.
- Cofnij: 8 renderów, 0 wymuszeń; wróciły Knowledgeable, Targeted (Norman Osborn), zawód Student; karta propozycji wróciła jako pending (W5-T7-1). Bez dryfu, więc dialog dryfu nie testowany na żywo.
- Nic nie wymagało ponownego otwarcia arkusza. `lastWriteStats.ms` przy edycji (8,9 s) liczy też czas otwartego dialogu.

### Niezweryfikowane
- Prawdziwy model i prawdziwy klucz (tylko relay na sucho); banery „brak klucza” i „limit budżetu” tylko w testach/modelu, nie na zrzucie.
- Dialog dryfu przy Cofnij (`confirmDrift`) i `stale`/`busy`/`rolledBack` z apply; linia `fix-round`; szybkie ponowne otwarcie arkusza w trakcie zamykania po poprawce W5-T7-10 (sprawdzone tylko, że szufladę da się otworzyć).
- Jasny motyw na żywo (świat toru ma ciemny); czytnik ekranu.
- Komunikat po Apply (`message` z pakietu) jest po angielsku.

## W5-C: walidator po W5-A, akcja `reorder`, szuflada T7 (W5-A-V1..V3, W5-B-6)

Pliki: `scripts/systems/invincible/validate.mjs`, `scripts/build/drawer-model.mjs`, `scripts/build/drawer-app.mjs`, `templates/builder-drawer.hbs`, `lang/en.json` + `lang/pl.json` (13 kluczy, tylko dopisane); testy `dev/test-build-validate-invincible.mjs` (+2), `dev/test-build-ops.mjs` (+2), `dev/test-build-snapshot.mjs` (1 asercja zmieniona), `dev/test-drawer-model.mjs` (+4, lista kluczy dynamicznych). Writer, harness, teksty prefiksu, wendor bez zmian. `styles/builder-drawer.css` ma cudze niezacommitowane zmiany: nie ruszane.

### Co zmienione
- W5-A-V1: `talentShifts` (eksport) w trybie replace zwraca `[]` (writer zapisuje kolejność listy), więc wynik `submit_proposal` replace nie niesie fałszywego `talent.role.shift` i nie wywołuje rundy poprawki W5-B-1. Tryb ops bez zmian (ostrzeżenie zostaje).
- W5-A-V1 (rozszerzone, ta sama przyczyna): rzutowanie walidatora w replace dostaje kolejność zapisu (`talentOrderPlan`: te same kroki co writer, `talentOrderOf` z `writer.mjs` + `movePlan` z `undo.mjs`; przenoszone talenty na koniec w kolejności propozycji), więc reguły czytają role po zapisie. Bez tego zostawało fałszywe `talent.occ.list` (też ostrzeżenie „do poprawy”): w przypadku dry6 [nowy talent bohatera, zachowany talent zawodu] rzutowanie czytało zachowany jako talent bohatera, nowy jako talent zawodu (test; mutacja bez przestawienia pada).
- W5-A-V2: `applyConfirm` (`applyConfirmList(proj, reorders)`) wymienia `reorder talent "X" hero -> occupation` dla zachowanego talentu, który writer odtwarza w innej roli (te same przypadki co `plan.reorders[].roleChange`; test porównuje walidator z writerem na 5 listach). Odtworzenia bez zmiany roli i nowe talenty: nie. Przesunięcie roli wynikające tylko z usunięcia (bez odtworzenia) też nie (jak writer: potwierdzane jest usunięcie).
- W5-A-V3 / szuflada: okno potwierdzenia Apply przez `confirmItems` (remove/swap/reorder; „Przestaw talent Quick Wits: talent bohatera → talent zawodu”); karta: zwinięta sekcja „Kolejność talentów (n)” z `plan.reorders` podglądu `pack.plan` (`reorderRows`: zmiana roli pogrubiona, „zostaje jako …”, „nowy, …”); lista potwierdzeń karty = `applyConfirm` walidatora (z `reorder`, po angielsku jak pozostałe wpisy); baner po Apply: najpierw `vitals` („Nowa budowa: bieżące Zdrowie 6 → 14, Determinacja 5 → 7 (max).”) i `reordered`, potem ostrzeżenia, najwyżej 6 linii (`applyResultLines`).
- W5-B-6 (weryfikacja po W5-A): `ops[]` zwięzłego wyniku ma nową nazwę dla `updateItem` (notatka, nazwa gearu) i dla zamiany poziomu z notatką (nowy test na `conciseApplyResult`: nazwa op = nazwa przedmiotu na karcie po zapisie). `confirm` (`swap`) i dziennik undo zostają przy nazwie sprzed zmiany (W3-A-5, zamierzone). `message` i op aktora: nowa nazwa (jak w W5-B). Punkt 6 zamknięty.

### Wybory (zachowanie tymczasowe)
| # | Pytanie | Wybór |
|---|---------|-------|
| W5-C-a | V1: `[]` czy rzutowanie w kolejności propozycji | Oba: `talentShifts` = `[]` w replace i rzutowanie w kolejności zapisu (inaczej role talentów w regułach, np. `talent.occ.list`, błędne). |
| W5-C-b | `budget.perOp` w replace | Bez zmian: etykiety per op („hero talent (free)” / „extra talent -1 pt”) liczone w kolejności op, nie zapisu; suma i `budget.after` zgodne (liczba darmowych talentów ta sama). Może mylić przy przestawieniu; do decyzji. |
| W5-C-c | Język wpisów karty „Potwierdzisz to przy zastosowaniu” | Zostają angielskie stringi walidatora (jak dotąd `remove` / `level swap`); okno dialogowe Apply jest lokalizowane. |
| W5-C-d | Baner po Apply | `message` pakietu (EN, zawiera też witalność i kolejność) zostaje nagłówkiem; lokalizowane linie pod nim powtarzają te fakty. |

### Texts for W5-T (nie zmienione tutaj)
- W5-C-T1 `APPLY_CONFIRM_NOTE` (`validate.mjs`, wynik submitu): „(removals and level swaps)” -> „(removals, level swaps and kept talents moved to another role)”. Test W3-10 sprawdza `/the GM confirms these at Apply/i` (zostaje prawdą).
- W5-C-T2 `TOOL_DESC.submit_proposal`: „(applyConfirm: the removals and level swaps the GM confirms at Apply)” -> dopisać „and kept talents a replace moves to another role”; `dev/test-prompt-texts.mjs:251` sprawdza obecne zdanie: zmienić razem.
- W5-C-T3 (= W5-A-T1, nadal potrzebne) `rules-digest.mjs:53`: „a new talent is always added last … (warning talent.role.shift)” prawdziwe tylko w ops; w replace kolejność listy = wynik, `talent.role.shift` w replace już nie przychodzi.
- W5-C-T4 (= W5-A-T3) `PROPOSAL_GUIDE` replace `talents`: dopisać sens „this order is written as is (kept talents are re-ordered; the GM confirms a kept talent changing role)”.
- W5-A-T2 (podpowiedź `talent.role.shift`) nieaktualne: ostrzeżenie jest już tylko w ops, gdzie obecna podpowiedź pasuje.

### Testy
- `test-build-validate-invincible` 56 (+2: V1/V2 przez `submit_proposal`: odwrócona lista = brak shiftu, `applyConfirm` z `reorder`, brak rundy poprawki wg `actionableWarnings`; ta sama kolejność = nic; przypadek dry6 = usunięcie + reorder; nowy talent zawodu = tylko usunięcie; czyste helpery; ops zachowuje shift. Kolejność zapisu w regułach: `talent.occ.list` tylko gdy zapisana kolejność naprawdę jest zła; mutacja sprawdzona).
- `test-build-ops` 54 (+2: walidator vs writer na 5 listach talentów, `reorder` = `plan.reorders` z `roleChange`, co najmniej 2 przypadki ze zmianą roli; nazwa op zamiany poziomu z notatką w `conciseApplyResult`).
- `test-build-snapshot` 37 (asercja W2-3 replace: brak shiftu przy odwróconej liście).
- `test-drawer-model` 13 (+4: `confirmItems` z prawdziwym pl.json, `reorderRows`, `applyResultLines` z limitem, szablon/aplikacja używają funkcji modelu; klucze dynamiczne `Confirm.reorder`, `Role.*`, `Result.health/resolve` w kontroli en/pl).
- Wszystkie `dev/test-*.mjs` zielone: ops 54, snapshot 37, validate 56, catalog 25, drawer-model 13, dry-relay 13, dry-transport 12, enhance 22, harness 40, migrate-id 18, packs 23, prompt-texts 22, transport 27, vendor load 9, vendor-sync ALL OK.

### Niezweryfikowane
- Bez toru: render szuflady (sekcja „Kolejność talentów”, dialog z `reorder`, linie banera) nie oglądany na żywo; tylko model w node i `node --check`.
- Prawdziwy model: czy po V1 runda poprawki przestaje się włączać w replace (powinna: oba fałszywe ostrzeżenia znikają).
- Zgodność walidatora z writerem sprawdzona na atrapie (`hero()` + `convW5`) i fiksturze `typicalHero`; nie na prawdziwym katalogu (np. talenty z notatką / odmiany Knowledgeable dopasowane przez `srcItems`).

## W5-D: szuflada przylega do arkusza (bez szczeliny)

### Przyczyna
- Nie cień ani ramka arkusza: `sheet.getBoundingClientRect()` jest dokładny, `dockGeometry` daje `left = rect.right` (szczelina w geometrii 0 px).
- Szczelina była w CSS: siatka szuflady ma kolumnę zakładki 32 px (`DOCK.tab`), a powierzchnia panelu (`::before`) i wszystkie części poza zakładką stały tylko w kolumnie 2. Pod zakładką (wysoka ~100 px, z marginesem 14 px) kolumna 1 była przezroczysta, więc między arkuszem a panelem prześwitywała mapa (zrzut 05).

### Poprawka (tylko `styles/builder-drawer.css`, bez zmian w JS/modelu/hbs)
- Otwarta szuflada: `::before` na `grid-column: 1 / -1`, obszary `log`/`card`/`composer` na całą szerokość (`"log log"` itd., też dla `flip`).
- Otwarta zakładka staje się krawędzią panelu obok nagłówka: `align-self: stretch`, bez marginesu, ramki, zaokrąglenia i cienia (niebieski pasek przy niebieskim pasku tytułu); hover = `--maig-accent-hover`.
- Zwinięta zakładka (sama, z kropką propozycji) bez zmian: i tak stała przy krawędzi arkusza.

### Próba na żywo (tor 8, kod z żywego folderu, świat przywrócony, slot oddany; bez relay, bez klucza)
- Viewport 1400x850, aktor `ZZ-AIGEN-flush` (usunięty), pomiar `getBoundingClientRect`:
  - prawa strona: arkusz right 820, szuflada left 820, zakładka left 820, log left 820 -> szczelina 0 px (`dev/screenshots/09-flush-right.png`);
  - lewa strona (`flip`): arkusz left 600, szuflada right 600, zakładka right 600, log right 600 -> 0 px (`10-flush-left.png`);
  - po przesunięciu i zmianie rozmiaru (`setPosition`) 0 px; minimalizacja chowa szufladę, przywrócenie: 0 px;
  - wąsko (po obu stronach po 330 px): panel min 300 + zakładka 32 = 332 px, przyciśnięty do ekranu -> nachodzi 2 px na arkusz (bez szczeliny; zachowanie `dockGeometry` bez zmian); arkusz przy prawej krawędzi -> `flip`, szczelina 0 px.
- Testy: wszystkie `dev/test-*.mjs` zielone (drawer-model 13).

### Niezweryfikowane
- Jasny motyw (świat toru ma ciemny); przeciąganie rogu arkusza myszą (sprawdzone `setPosition`, ten sam obserwator).
