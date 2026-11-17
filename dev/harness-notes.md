# T2: pętla harnessu kreatora AI: notatki i otwarte wybory

Data: 2026-11-17. Kod: `scripts/build/harness.mjs` (pętla, limity, zdarzenia, transkrypt), `session-store.mjs` (IndexedDB + pamięć, tylko dopisywanie), `sheet-sync.mjs` (reguła 5.4 ogólna, na liniach), `harness-prompt.mjs` (system[0], tymczasowy tekst; ostateczny = T8), `harness-lang.mjs` (MAIG.Build.* i MAIG.Settings.Build.* EN/PL), `harness-defaults.mjs` (domyślne limity), `build-settings.mjs` (ustawienia `build.*`), `builder-api.mjs` (podpięcie w Foundry: `api.build.openSession` itd.). Testy: `node dev/test-harness.mjs` (27).

## API dla szuflady (T7)

```js
const b = game.modules.get("moinens-ai-gen").api.build;      // tylko MG
const s = await b.openSession(actor);                          // jedna sesja na dokument (klucz `${worldId}:${uuid}`), odtwarzana z IndexedDB
s.on("*", (data, type) => ...);                                // zdarzenia: harness.mjs EVENT_TYPES
await s.send("Złóż mi Spider-Mana");                           // jedna tura MG -> TurnSummary { ok, reason, cap, requests, toolCalls, usage, usd, text, proposal, error?, lastDraft? }
s.stop();                                                      // Stop (AbortController; także w trakcie narzędzi)
s.transcript();                                                // elementy do wyświetlenia: gm / ai / tool (status pending|done|error) / sheet / notice / proposal
s.pendingProposal; s.clearPendingProposal(); s.setLastRun(runId);
s.setOptions({ rank, profile });                               // trafia do pack.snapshot(doc, {liveForm:true, ...options}) i ctx.options w runTool
await s.newConversation();                                     // stara rozmowa do archiwum (5 najnowszych na dokument): b.listArchive(actor)
await s.prewarm();                                             // max_tokens:0, pomijane gdy ciepłe (< 55 min) albo wyłączone
s.usage();                                                     // { session, lastTurn, cacheHitRatio }
```
`reason`: done | cap | stopped | refusal | max_tokens | context | error | limit | busy | empty | no-key | no-pack | history-full. `cap`: requests | toolCalls | invalidSubmits | identicalInvalid | cost | wall. Komunikaty (`notice`) mają `code`, `level`, `message` (już przetłumaczony, po redakcji).

## Kontrakt z pakietem (to, czego harness używa)
- `staticPrompt()` co turę (pakiet sam cache'uje), `tools()`, `runTool(name, input, { doc, session, signal, options })`.
- Wynik narzędzia: string idzie bez zmian; obiekt z `modelContent: string` -> ten tekst; inny obiekt -> `JSON.stringify` (zwięzły). Cięcie bezpieczeństwa 24 000 znaków z dopiskiem `(truncated, N chars)`. `isError: true` w obiekcie -> `is_error`. Wyjątek z `runTool` -> `is_error` z redagowanym komunikatem.
- Narzędzia `submit_*`: `ok: true` -> oczekująca propozycja (`proposalId` z wyniku albo id wywołania, `summary`, `warnings`); `ok: false` (albo błąd) -> licznik kolejnych błędnych i podpis błędów (`code`, `path|opId`, `message`, posortowane).
- Arkusz: `snapshot(doc, { liveForm: true, ...options })`; jeżeli pakiet wystawia `nextSheetBlock(held, snap)` (np. `systems/invincible/snapshot.mjs`), harness używa JEGO decyzji 5.4 i przechowuje jego `held` (Mapy kodowane do JSON); bez tego ogólna reguła `sheet-sync.mjs` na `snap.lines` (albo na liniach tekstu, gdy `lines` puste).

## Otwarte wybory (zachowanie tymczasowe)

| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| H1 | Narzędzia niewywołane z powodu limitu / Stop / max_tokens: spec mówi „nic więcej nie dopisuj”, ale niesparowany `tool_use` psuje następne żądanie | W tej turze nic nie jest dopisywane; następna wiadomość MG zaczyna się od `tool_result` z `is_error: true` („Not run: the previous turn stopped (powód)…”) dla każdego takiego wywołania, potem arkusz, potem tekst. Historia nadal tylko dopisywana. |
| H2 | Odmowa (P10), błąd transportu, Stop w trakcie strumienia | Nic częściowego nie trafia do historii. Następna wiadomość MG to druga z rzędu wiadomość `user` (API je scala). |
| H3 | Limit żądań, gdy ostatnia odpowiedź to `tool_use` | Narzędzia ostatniej odpowiedzi są uruchamiane i wyniki dopisane (udana propozycja w ostatnim kroku nie przepada), dopiero potem stop przed kolejnym żądaniem. Limit narzędzi: partia, która by go przekroczyła, NIE jest uruchamiana (H1). |
| H4 | Szacunek kosztu następnego żądania (limit na wiadomość + rezerwacja w `limits.mjs`) | Nowy ogon (znaki/3,5 minus tokeny promptu poprzedniego żądania) po stawce zapisu 1 h + reszta po stawce odczytu + 4000 tokenów wyjścia [E]. Rezerwacja przez `reserveBudget(est, { perRequest: est })`, więc działa też limit `perRequest` modułu. Do strojenia w T8. |
| H5 | `pause_turn` (tylko przy narzędziach serwerowych, których kreator nie używa) | Transport odrzuca żądanie z asystentem na końcu (brak prefill), więc harness dopisuje krótkie `user: "Continue."` i kontynuuje. |
| H6 | Koszt nieudanych prób (P6) | Do limitów i logu: koszt udanej próby + `failedAttempts.usdUpperBound`; przy błędzie / Stop: koszt każdej próby, która dostała `usage` (wejście było przetworzone). Ostrożnie (raczej za dużo niż za mało). |
| H7 | Zmiana modelu / effort w ustawieniach w trakcie rozmowy | Rozmowa zostaje przy swoim modelu i effort (cache), komunikat `settingsDrift`; nowa rozmowa (albo pusta) bierze nowe ustawienia. |
| H8 | Limit rozmiaru historii (~150k) | Liczone z rzeczywistych tokenów promptu ostatniego żądania + szacunku nowej wiadomości; powyżej: `history-full`, trzeba zacząć nową rozmowę. Nie jest ustawieniem (spec 5.3). |
| H9 | Wpis w logu wywołań | Jeden wpis `kind: "build"` na żądanie: `tokens.in` = wejście NIEcache'owane, `cacheRead`/`cacheWrite` osobno (nowe pola `LOG_FIELDS` i kolumny CSV), `prompt` = tekst MG tylko przy pierwszym żądaniu tury, `route` = „turn N / request M / stop”. Zablokowane przez limity: `status: "blocked"`, `costKind: "estimated"`. Pre-warm: `kind: "build-prewarm"`. Filtr „Builder” w oknie logu = T7. |
| H10 | Ustawienia | Rejestrowane w `init` z `settings.mjs` (statyczny import `build/build-settings.mjs`: czyste pliki, test importu w node). Nazwy przez `harness-lang.mjs` wstrzykiwane w `i18nInit` (lang/*.json wygrywa). Dodatkowo względem tabeli 11.1: `build.maxToolCallsPerMessage` (40), `build.maxMinutesPerMessage` (5). `build.headerButton` zostawione dla T7. Limit identycznych błędów (2) nie jest ustawieniem. |
| H11 | Archiwum rozmów | „Nowa rozmowa” przenosi starą do magazynu `archive` (5 najnowszych na dokument); nic nie jest kasowane bez limitu. Czy MG ma je oglądać: decyzja T7. |
| H12 | Tekst system[0] | Tymczasowy, bez dosłownych znaczników arkusza (transport odrzuca blok systemowy wyglądający jak arkusz). Ostateczny tekst = T8; każda zmiana tekstu zmienia prefiks cache (jednorazowy zapis). |
| H13 | Kolejność „pakiet nextSheetBlock vs reguła rdzenia” | Pakiet wygrywa, gdy wystawia `nextSheetBlock`; przy przejściu między implementacjami (rzadkie) wysyłany jest pełny arkusz. Invincible: T12 musi tylko dopisać `nextSheetBlock` do obiektu pakietu (w `pack.mjs`, plik T12/T6), jeśli chce swojego formatu `<sheet_update>`. |
| H14 | Koniec tury po przyjętym submicie (W3-4, D-5) | Partia tylko z przyjętych `submit_*` kończy turę (`reason: "submitted"`), bez kolejnego żądania; wyniki w `record.heldToolResults`, wysyłane na początku następnej wiadomości MG (jedna wiadomość `user`). Ustawienie `build.endTurnOnSubmit` (domyślnie tak). `text` tury = ostatnia wiadomość bez narzędzi, wcześniejsze teksty = `progress[]` (W3-5). Szczegóły: `dev/wave3-notes.md`. |
| H15 | Ostrzeżenia przyjętego submitu (W5-B-1, tymczasowo) | Gdy wynik ma ostrzeżenie do poprawy (`pack.actionableWarnings(name, res)`, bez niego: podpowiedź niepusta i nie „nothing to …”), tura NIE kończy się na submicie: jedno dodatkowe żądanie (zdarzenie `fix-round`, `TurnSummary.fixRound`), w nim każda partia z prawdziwym submitem kończy turę bez względu na wynik. Najwyżej raz na wiadomość MG, w limitach; bez rundy, gdy limit żądań/narzędzi już osiągnięty. Szczegóły: `dev/wave5-notes.md` (W5-B). |

## Zweryfikowane / niezweryfikowane
- Zweryfikowane (node, `dev/test-harness.mjs`, 27/27; regresja: test-transport 27, test-packs 23, test-enhance 22, test-migrate-id 18): pełna tura z wieloma żądaniami i narzędziami, równoległe wywołania w jednej wiadomości, wyjątek narzędzia / nieznane narzędzie / zły JSON, samonaprawa, każdy limit (żądania, narzędzia, kolejne błędne, identyczne błędne, koszt na wiadomość, czas), limity modułu (odmowa przed i w trakcie tury, zwolnienie rezerwacji), Stop w strumieniu i w narzędziach, odmowa, max_tokens, pause_turn, błąd HTTP z redakcją, reguła arkusza (pełny, bez zmian, aktualizacja, duży dryf, 8 diffów, decyzja pakietu z Mapami przez magazyn), stabilność bajtów prefiksu (tury 1-5, dwóch aktorów) i historia jako ścisły prefiks, IndexedDB (zapis, przeładowanie, odmowa edycji, archiwum, per aktor, tryb pamięci), klucz nigdy w historii / magazynie / logu / zdarzeniach / transkrypcie, pre-warm, zmiana ustawień, rejestracja ustawień (atrapy globali Foundry), import `settings.mjs` + `builder-api.mjs` z atrapami.
- NIE zweryfikowane: na żywo w Foundry (rejestracja ustawień w `init`, wstrzyknięcie tekstów w `i18nInit`, prawdziwe IndexedDB przeglądarki, `api.build.openSession` z prawdziwym pakietem Invincible), prawdziwy model i prawdziwe ceny / cache (T8), integracja z prawdziwymi `runTool` T4 i `snapshot` T12 (tylko pakiet stub i atrapa).
