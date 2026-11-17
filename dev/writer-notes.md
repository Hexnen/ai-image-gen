# T6: zapis w miejscu (writer) pakietu Invincible: notatki i otwarte wybory

## Pliki
- `scripts/systems/invincible/writer.mjs`: `createWriter(deps)` -> `plan`, `apply`, `undo`, `undoStatus`. Normalizacja op, biała lista, plan z per-op, zapis fazami, wycofanie przy błędzie, blokada, dziennik.
- `undo.mjs` (czysty): dziennik `flags.moinens-ai-gen.undo`, przycinanie, grupy cofania per przedmiot, dryf, kolejność.
- `replace.mjs`: stan chargen / płaski NPC -> ops.
- `pu-bridge.mjs`: miękki most do plus-ultra.
- `writer-group.mjs`: grupa `writer` na obiekcie pakietu, czyli `selfTest` + `plusUltra` + `selectOps`.
- `pack.mjs`: tylko import + `Object.assign(pack, writerGroup(...))`.
- Testy: `dev/test-build-ops.mjs` (30, atrapa warstwy Actor/Item).

## Kontrakt (skrót, pełny opis w nagłówku writer.mjs)

### `plan(doc, proposal, opts)`
Nic nie zapisuje. Format propozycji:
- `{ target, mode: "ops", ops }`, gdzie op ma klucz `op` (format T5) albo `kind`;
- albo `mode: "replace"` (zamiana na ops).

Wynik:
- `ok`, `errors`, `warnings`;
- `ops[]` (per op), `creates`, `updates`, `swaps`, `deletes` (z `cascadeOf`), `keeps`, `fields`, `counts`;
- `destructive`, `unsaved`;
- `expect` (odciski przedmiotów + wartości pól aktora);
- `projected`: aktor po zmianach, w kształcie zgodnym z czytnikiem. Nowe przedmioty mają id-zaślepkę `+opId`.

### `apply(doc, proposal, { expect, confirmed, profile, rank, deselect|only, allowVitals })`
Kolejność kroków:
1. tylko MG;
2. blokada;
3. plan;
4. `pack.validate(..., { skipPlan: true })`;
5. kontrola przestarzałości;
6. operacja niszcząca wymaga `confirmed`;
7. zapis fazami: źródła -> moce -> boosty/limity -> talenty/wady -> sprzęt, potem zamiany poziomów, zmiany, usunięcia, pola aktora, przycięcie HP/RES (tylko gdy nowe maks. niższe);
8. odciski „po” -> dziennik.

Każdy błąd w trakcie: wycofanie tego, co już zapisano.

Wynik: `runId`, `created`, `updated`, `deleted`, `idMap { opId: itemId }`.

### `undo(doc, runId?, { opIds?, confirmDrift })` i `undoStatus(doc)`
- Bez `opIds` cofa cały przebieg, z `opIds` tylko wybrane przedmioty z ich grupą.
- Dryf (zmiana po zapisie) wymaga `confirmDrift: true`.
- Usunięte przedmioty wracają z tym samym id (`keepId`).

### Szuflada przedmiotu (gear / vehicleWeapon)
- `mode: "replace"` z `proposal.item` (format T5) albo jeden op `updateItem` na tym przedmiocie.
- `target: "newItem"` tworzy przedmiot świata; cofnięcie go usuwa.

## Otwarte wybory (zachowanie tymczasowe)
- **W1.** Zmiana poziomu mocy dzielonej (osobny dokument na poziom) jest robiona tak: usuń stary dokument, utwórz dokument nowego poziomu z TYM SAMYM id (`keepId`).
  - Zachowane: `system.powerSource`, `sort`, notatka.
  - Boosty/limity nie są przepinane, bo id się nie zmienia.
  - Alternatywa: nowe id + przepięcie boostów/limitów (więcej zapisów, gorszy diff).
- **W2.** Karma oraz bieżące Health/Resolve są zapisywane tylko z ostrzeżeniem `field.sensitive` (nie są blokowane). `allowVitals: true` wycisza ostrzeżenie. Spec O25 mówi „tylko na prośbę MG”: o tym decyduje szuflada (T7).
- **W3.** Własny (custom) przedmiot dozwolony dla gear, vehicleWeapon i powerSource.
  - Pozostałe typy tylko z katalogu.
  - T5 dopuszcza custom tylko dla gear/vehicleWeapon, więc w praktyce powerSource custom odpada na walidacji.
- **W4.** `updateItem` na gear: `name`, `descriptionAppend` (akapit tekstu jawnego) i `gear{cost, restricted, singleUse, attack}`. Na przedmiotach z katalogu: tylko poziom, linki i notatka. Nigdy: `extraConfiguration`, `runMacro`, UUID, efekty, obrazy, flagi.
- **W5.** Dziennik:
  - najnowsze 10 przebiegów, TTL 24 h, przebiegi w pełni cofnięte są usuwane;
  - limit 400 000 znaków JSON (najstarsze odpadają, najnowszy zostaje zawsze);
  - odcisk „po” liczony po zapisie, służy do wykrywania dryfu.
- **W6.** `specialAbilities` (NPC, kształt płaski) są dopisywane do biografii (`biographyAppend`), bo NPC w systemie nie ma osobnego pola.
- **W7.** Zamiana replace -> ops:
  - dla kształtu walidatora writer bierze `replaceToOps` z `proposal.mjs` (T5), więc ops w podglądzie i w zapisie są te same;
  - dla kształtu stanu chargen (plus-ultra) bierze `replace.mjs`;
  - gdy modułu T5 brak, `replace.mjs` dla obu kształtów.
  - Do ujednolicenia z T5 (validate-notes V13).
- **W8.** `grants` na limicie (level|boost): writer go przyjmuje, ale nic z nim nie robi (to informacja dla walidatora; system nie ma tego pola).
- **W9.** Blokada `flags.moinens-ai-gen.lock` (TTL 90 s). Świeża blokada plus-ultra `chargenLock` też oznacza „zajęte”.
- **W10.** Dziennik szuflady `newItem` jest zapisywany na dokumencie, z którego otwarto szufladę (nowy przedmiot świata nie ma jeszcze historii).
- **W11.** Writer nie zapisuje flagi rangi. Ranga żyje w szufladzie i w walidatorze; plus-ultra zapisuje swoją flagę tylko przy „Pełnej przebudowie”.
- **W12.** Cofnięcie samego dodanego źródła mocy nie zabiera mocy przepiętych na nie innymi op w tym samym przebiegu. Takie moce wskazywałyby wtedy brakujące id: `undoStatus` pokazuje grupy, MG wybiera.
- **W13.** Nazwa pliku: spec mówi o `apply.mjs`, kod jest w `writer.mjs` (żeby nie mylić z `apply.mjs` plus-ultra).
- **W14.** Znaczenie `selfTest`:
  - bez plus-ultra: `{ ok: true, skipped: true }`, bo writer nie zależy od plus-ultra;
  - z plus-ultra: plan na fałszywym NPC musi dać `WrongType`, inaczej `ok: false` i dodatki plus-ultra wyłączone.
- **W15.** Szuflada przedmiotu przyjmuje też `mode: "ops"` (jeden `updateItem`). Walidator T5 przyjmuje dla przedmiotu tylko `replace`, więc `apply` w trybie ops na przedmiocie zostaje odrzucony przez T5 (sprawdzone na żywo). Do decyzji: usunąć tę ścieżkę albo dodać ją w T5.

## Most plus-ultra (`pack.plusUltra`)
- `status()` zwraca: active, version, api, selfTest, usable, wizard, lists.
- `fullRebuild.{available, plan, apply, undo, undoStatus}` przekazuje do `api.chargen.apply` (refy -> `packUuid`, dokumenty poziomów mocy dzielonych). Kopię zapasową robi wtedy sam plus-ultra.
- `openWizard(actor, state?)`: otwiera kreator.
- `installWizardButton(openBuilder)`: przycisk „Open in builder” w oknach `ipc-chargen-*`.
- `lists("archetypes"|"occupations")`.
- Bez plus-ultra wszystko zwraca „niedostępne” i nic nie rzuca wyjątku.

## Weryfikacja

### Node
`node dev/test-build-ops.mjs`: 30 testów. Regresje pozostałych suit zielone:
- test-packs: 23
- test-build-snapshot: 25
- test-catalog-invincible: 15
- test-harness: 27
- test-build-validate-invincible: 28
- vendor-sync: 22+9

`validateProposal` T5 woła `pack.plan` z tego writera jako L3.

### Na żywo (tor 20, 2026-11-17)
Warunki:
- kopia świata `invincible`, plus-ultra 0.20.2, system 2.1.8;
- moduł przez junction, NIEAKTYWNY w świecie (pliki importowane po URL);
- MG Gamemaster, aktorzy `ZZ-AIGEN-*`.

Sprawdzone:
- **selfTest z prawdziwym plus-ultra:** `ok: true`, `usable: true`, `wizard: true`.
- **Przebieg 1 (bohater, format T5, profil in-play), 7 nowych przedmiotów:** źródło, moc dzielona Protection (basic), boost, limit, talent, wada, własny gear z atakiem; do tego pola aktora.
  - Linki moc->źródło i boost/limit->moc poprawne.
  - Atak gear: `rollAttack` z bonusem, obrażeniami, zasięgiem i atrybutem `agility`.
  - Blokada zdjęta po zapisie.
  - Snapshot T12 rozpoznaje wszystkie przedmioty jako `ref`.
- **Przebieg 2: Protection basic->major, usunięcie wady, zmiana nazwy/kosztu gear.**
  - Id wszystkich pozostałych przedmiotów bez zmian; moc ma TO SAMO id.
  - Opis mocy = dokument major z paczki.
  - Linki źródła i boost/limit nienaruszone.
- **Cofanie per przedmiot:** cofnięta sama wada wraca z tym samym id. Potem ręczna edycja gear -> cofnięcie reszty wymaga potwierdzenia (dryf „ZZ Hook: edited”). Po potwierdzeniu: moc wraca do basic z tym samym id, opis = dokument basic, linki całe.
- **Usunięcie mocy z kaskadą:** bez `confirmed` odmowa `plan.needConfirm`; z `confirmed` usunięte moc + boost + limit. Cofnięcie per przedmiot (`opIds: ["rp"]`) przywraca całą grupę z tymi samymi id i poprawnymi linkami, bez dryfu.
- **Przestarzałość:** plan, potem ręczna zmiana kosztu gear -> `apply` odrzuca całość („Changed since the preview: "ZZ Hook"”), nic nie zapisane.
- **Niezapisane pole:** wartość wpisana w `system.civilianName` otwartego arkusza bez zdarzenia change -> `plan.unsaved` ją pokazuje, `apply` i `undo` odmawiają (`sheet.unsaved`).
- **NPC:** talent + własny gear + nazwa, zapis i cofnięcie.
- **Szuflada przedmiotu świata (replace):** nazwa, opis (enricher `@UUID` rozbrojony), koszt, atak; id bez zmian, bez dryfu, cofnięcie do stanu wyjściowego.
- **`newItem`:** utworzony przedmiot świata, cofnięcie go usuwa.

Błędy znalezione na żywo i naprawione (oba mają teraz test regresji):
1. Foundry rozwija klucze z kropkami także wewnątrz zapisywanej flagi. Wpis `actor` w dzienniku był zapisywany zagnieżdżony, więc cofnięcie nie przywracało atrybutów i zgłaszało fałszywy dryf „system: field”. `readJournal` odczytuje teraz wpisy `actor` po `paths`, niezależnie od zapisanego kształtu. Atrapa w testach rozwija klucze tak jak Foundry.
2. Odcisk ignorował tylko `_stats` przedmiotu, a nie `_stats` efektów osadzonych. Przedmiot odtworzony z `keepId` dawał fałszywy dryf. Teraz `_stats` jest pomijane na każdej głębokości.
3. Szuflada przedmiotu nie rozpoznawała op w formacie T5 (`op` zamiast `kind`): poprawione.

Sprzątanie: aktorzy i przedmioty `ZZ-AIGEN-*` usunięte, świat toru przywrócony (`restore`), slot oddany.

Uwagi z toru:
- Moduł był nieaktywny, więc `getFlag("moinens-ai-gen")` rzuca wyjątek. Writer czyta i pisze flagi przez `_source` / `update`, a to działa także wtedy.
- Walidator T5 w profilu `creation` blokuje op na niekompletnym bohaterze (`attr.unspent` itd.), dlatego przebiegi szły z `profile: "in-play"`.
- T5 odrzuca usunięcie ostatniej mocy (`powers.none`) i jedynego talentu (`talent.hero.missing`).

## Niesprawdzone
- **Listy archetypów i zawodów:** na torze 20 provider plus-ultra sam zwraca 0, bo w tym świecie nie ma paczki tabel chargen. Most wywołuje go poprawnie, ale danych nie widziałem.
- **„Pełna przebudowa (plus-ultra)”** (`fullRebuild.apply`) na żywo: tylko test node z atrapą plus-ultra.
- **Przycisk „Open in builder”** w oknie kreatora: tylko atrapa (wymaga T7 i aktywnego modułu).
- **Blokada** przy dwóch MG / równoległym kreatorze plus-ultra: tylko node.
- **Gracz** (brak przycisku/api): nie sprawdzane tutaj; writer odmawia, gdy `!isGM` (test node).
- **Przycięcie HP/RES na żywo** (tylko node).
- **Zapis z modułem AKTYWNYM w świecie:** tor używał importu po URL.
