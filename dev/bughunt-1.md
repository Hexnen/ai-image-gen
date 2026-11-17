# Bug hunt 1: logika AI buildera (harness, transport, writer/undo/validate)

Data: 2026-11-17. Tylko odczyt kodu + repro w node (atrapa fetch/SSE ze `dev/test-harness.mjs`, bez sieci, bez prawdziwego klucza).
Zakres: `scripts/build/{harness,harness-prompt,builder-api,session-store}.mjs`, `scripts/anthropic/*`, `scripts/systems/invincible/{writer,writer-group,undo,validate,proposal,snapshot,reader,catalog,tools}.mjs`.
Stan odniesienia: wszystkie `dev/test-*.mjs` zielone (harness 40, transport 27, ops 54, validate 56, ...).

Repro: skrypty pomocnicze = pierwsze 181 linii `dev/test-harness.mjs` (fakeIndexedDB, fakeModel, reply, makePack, makeDeps) z
importami na ścieżki modułu + `export { ... }`. Kod każdego repro jest niżej, wynik skopiowany z uruchomienia.

Ważne tło: historia rozmowy jest TYLKO dopisywana (spec 5.2, `session-store.mjs assertAppendOnly`). Każda wiadomość, która raz
trafi do `record.messages` i powoduje 400 API, psuje rozmowę NA STAŁE (każde kolejne żądanie ją niesie), aż MG kliknie
„Nowa rozmowa”. Dlatego B2 i B3 są poważniejsze, niż wygląda sam wyzwalacz.

Nic z tego nie było jeszcze wysłane do prawdziwego API (próby na sucho szły przez relay/zastępcę), więc kształt żądania
nie jest potwierdzony przez serwer.

---

## B1. Schemat strict `submit_proposal` ma 126 opcjonalnych pól (WYSOKA, ryzyko blokujące, do potwierdzenia 1 żądaniem)

- Miejsce: `scripts/systems/invincible/proposal.mjs:49-87` (`PROPOSAL_SCHEMA`), `validate.mjs:850-852` (`strict: true`),
  `tools.mjs:24-79` (4 narzędzia odczytu, też strict).
- Scenariusz: każde żądanie buildera (także pre-warm) wysyła 5 narzędzi `strict: true`. Policzone: opcjonalne właściwości
  (nie w `required`) łącznie 132, z czego 126 w `submit_proposal` (`SET` 17, `OP` 11, `REPLACE` + zagnieżdżenia, `CUSTOM`,
  `ATTACK` x3 ...). Słów kluczowych nieobsługiwanych przez strict (min/max/length/pattern) brak, `additionalProperties:false`
  wszędzie, unii 0: to jest OK.
- Ryzyko: dokumentacja structured outputs Anthropic (z pamięci, NIE ma tego w lokalnym skillu claude-api, którego tabela
  ograniczeń wymienia tylko nieobsługiwane słowa) podaje limity złożoności gramatyki strict: ok. 20 narzędzi strict na
  żądanie, 24 parametry opcjonalne łącznie we wszystkich schematach strict, 16 parametrów z unią; przekroczenie = 400
  („schema too complex”). Jeśli to aktualne, KAŻDE żądanie buildera dostaje 400 i builder nie działa wcale. Moduł woła API
  surowym `fetch` (SDK nie usuwa niczego po drodze).
- Repro (node, scratch `schema.mjs`): przejście po `readToolDefs()` + `PROPOSAL_SCHEMA`:
  ```
  get_entries optional: 0 | read_document optional: 2 | read_rules optional: 1 | search_catalog optional: 3
  submit_proposal optional: 126 bad: [] unions: 0 noAP: [] schemaChars: 6652
  TOTAL optional params across strict tools: 132 strict tools: 5
  ```
- Sugestia: przed pierwszym prawdziwym testem wysłać jedno małe żądanie z obecnym `tools` (decyzja właściciela: koszt
  centów, prawdziwy klucz). Jeśli 400: `strict: false` na `submit_proposal` (L0 `checkShape` + `normalize` i tak sprawdzają
  wejście lokalnie, harness nigdy nie ufa wejściu narzędzia) i zostawić strict na małych narzędziach odczytu; ewentualnie
  spłaszczyć schemat. Zmiana schematu = jeden ponowny zapis cache prefiksu.

## B2. Pusta odpowiedź asystenta (`end_turn`, `content: []`) jest dopisywana do historii -> trwałe 400 (WYSOKA)

- Miejsce: `harness.mjs:595` (`#append({ role: "assistant", content: r.historyContent })` bez sprawdzenia pustej treści),
  `anthropic/request.mjs:108-116` (`checkMessages` nie sprawdza pustych wiadomości), tekst `harness-prompt.mjs:23-24`.
- Scenariusz: model kończy turę bez żadnego bloku (dokumentowane zachowanie Claude „empty response with end_turn”, typowo
  zaraz po `tool_result`). Prompt wręcz o to prosi: system[0] linia 24 „A successful submission ... ends your turn: write
  nothing after it” i linia 23 „never resubmit only because of a warning”. Model widzi wynik udanego submitu w środku tury w
  trzech domyślnych ścieżkach: (1) runda poprawki W5-B-1 (przyjęty submit z ostrzeżeniem do poprawy, `harness.mjs:621-628`),
  (2) partia [submit + inne narzędzie] (`endOnSubmit` false, `:614-628`), (3) `endTurnOnSubmit` wyłączone. Wtedy `[]` trafia do
  historii, a API odrzuca każde następne żądanie: „messages.N: all messages must have non-empty content except for the
  optional final assistant message”. Historii nie wolno edytować -> rozmowa martwa do „Nowej rozmowy”. (W5-B-T1 opisuje tę
  sprzeczność tekstu z rundą poprawki, ale tekst nie jest zmieniony.)
- Repro (`repro-harness.mjs` R1):
  ```js
  const emptyMsg = { chunks: [start(), mDelta("end_turn", 3), mStop()] };
  const f = fakeModel([reply({ tools: [{ id: "tu1", name: "submit_proposal", input: { ops: [{ opId: "a" }] } }], thinking: "" }), emptyMsg, reply({ text: "ok" })]);
  // settings { endTurnOnSubmit: false }; s.send("Zbuduj bohatera"); s.send("Dzięki, a teraz zmień notatkę")
  ```
  Wynik: `[R1 turn1] {"ok":true,"reason":"done","text":""}`, `[R1 request3 roles] user,assistant,user,assistant(EMPTY),user`.
- Sugestia: gdy `historyContent` nie ma żadnego bloku (albo tylko bloki thinking z pustym tekstem) i `stop` != tool_use:
  NIE dopisywać (historia kończy się wtedy `tool_result`/wiadomością MG, następna wiadomość MG się z nią scali), `reason: "done"`.
  Dodatkowo `checkMessages` może odmawiać wiadomości z `content: []` lokalnie (RequestBuildError zamiast płatnego 400).
  Tekst: wdrożyć W5-B-T1 (w rundzie poprawki: jedna poprawiona propozycja albo JEDNO zdanie, nigdy pusto).

## B3. Po fallbacku w trakcie odpowiedzi harness odsyła `tool_result` dla `tool_use`, którego nie ma w historii -> trwałe 400 (ŚREDNIA)

- Miejsce: `anthropic/transport.mjs:315` vs `:318` (`historyContent` usuwa `tool_use` sprzed ostatniego bloku `fallback`,
  ale `toolUses: toolUses(message, ...)` bierze PEŁNE `message.content`), `harness.mjs:606-612` (uruchamia i odpowiada na
  wszystkie `r.toolUses`).
- Scenariusz: `fallbacks: "default"` (włączone dla sonnet-5-5 / opus-5-5, `request.mjs:162-165`). Pierwszy model wypuszcza
  `tool_use`, potem odmowa w połowie i model zapasowy kończy. Wg reguły echa (zapisanej w samym `historyContent`) wcześniejszy
  `tool_use` wypada z historii, ale harness i tak wykonuje to narzędzie i dopisuje jego `tool_result` -> „unexpected
  tool_use_id found in tool_result blocks” (400) w każdym kolejnym żądaniu.
- Repro (`repro-fallback.mjs`): strumień `tool_use tu1`, blok `fallback`, `tool_use tu2`, `stop_reason tool_use`:
  ```
  tools run: [ 'search_catalog', 'get_entries' ]
  assistant tool_use ids in history: [ 'tu2' ]
  tool_result ids sent: [ 'tu1', 'tu2' ]
  orphan tool_result ids (400 'unexpected tool_use_id'): [ 'tu1' ]
  ```
- Sugestia: `toolUses` liczyć z `historyContent` (albo filtrować po id obecnych w `historyContent`); test z blokiem `fallback`.

## B4. Odmowa / błąd / limit zostawiają wiadomość MG w historii; następna wiadomość MG się z nią skleja (ŚREDNIA)

- Miejsce: `harness.mjs:543` (wiadomość MG dopisana PRZED pętlą), wyjścia bez odpowiedzi asystenta: `:551` (Stop przed
  żądaniem), `:560` (limit kosztu na wiadomość już przed PIERWSZYM żądaniem), `:563-567` (limit modułu: dzienny/miesięczny/na
  żądanie), `:574-583` (błąd transportu po retry: 401/429/529/sieć), `:594` (odmowa). Nagłówek pliku (`:20-21`) zakłada
  scalanie przez API: to prawda (skill: kolejne wiadomości tej samej roli są łączone), więc 400 tu NIE ma, ale skutki są
  realne:
  1. Odmowa „zatruwa” rozmowę: odrzucony tekst zostaje w scalonej turze użytkownika i jest wysyłany przy każdej kolejnej
     wiadomości, więc klasyfikator najpewniej odmawia znowu (każda próba płatna), aż do „Nowej rozmowy”.
  2. Po 529/401/sieci MG zwykle wysyła tę samą prośbę ponownie: model dostaje ją dwa razy w jednej turze.
  3. Limit kosztu / modułu: 0 żądań, ale każda próba dopisuje kolejną wiadomość `user` na stałe.
  4. Z modelem Fable szacunek pierwszego żądania przekracza domyślny limit 0,50 USD na wiadomość (prefiks ~21,4k tok liczony
     po stawce zapisu 1 h + 4000 tok wyjścia: fable-5-2 ok. 0,53, fable-5-1 ok. 0,66), więc KAŻDA pierwsza wiadomość kończy się
     `cap.cost` („wydano 0.0000 z 0.50”) bez żądania i dopisuje wiadomość. Sonnet/Opus 5.5 mieszczą się.
- Repro (`repro-harness.mjs` R2-R4):
  ```
  [R2 reasons] ["refusal","refusal"]
  [R2 request2 roles] user,user
  [R2 request2 still carries refused text] true
  [R2 request3 roles] user,user,user
  [R3 reasons] ["cap/cost","cap/cost","cap/cost"]      (maxCostPerMessage 0.0001)
  [R3 requests sent] 0
  [R3 stored roles] user,user,user
  [R3b (module daily limit) requests / stored roles] [0,"user,user"]
  [R4 first] {"reason":"error","error":{"kind":"overloaded","detail":"Overloaded","retryAfter":null},"attempts":3}
  [R4 retry request roles] user,user
  [R4 'Build Atom Eve' occurrences in retry request] 2
  ```
- Sugestia: budować wiadomość MG, ale dopisywać ją dopiero razem z pierwszą udaną odpowiedzią (żądanie = historia +
  wiadomość w locie); przy odmowie / błędzie / limicie przed jakąkolwiek odpowiedzią asystenta nie dopisywać nic i oddać
  tekst do pola wiadomości (wstrzymane `heldToolResults` i znacznik `<proposal/>` zostają na następną próbę). Limit kosztu i
  rezerwację sprawdzać przed złożeniem wiadomości. Dla odmowy można też pokazać MG `stop_details.category`.

## B5. Dwa obiekty Session dla jednego aktora -> HistoryEditError, `send` odrzuca, łańcuch zapisu zatruty na stałe (ŚREDNIO-NISKA)

- Miejsce: `harness.mjs:193-202` (`openSession`: `sessions.has` sprawdzane przed `await store.load`, bez obietnicy w locie),
  `:328-340` (`#saveChain = #saveChain.then(...)`: po jednym odrzuceniu każdy kolejny `.then` też jest odrzucony), `:670`
  (`send` przepuszcza `history-edit`, choć kontrakt `:473` mówi „never rejects”).
- Scenariusz: dwa równoległe `openSession(actor)` (dwie szuflady / makro + szuflada, szybki podwójny render) dają dwa
  rekordy z różnym `conversationId`. Pierwszy zapis wygrywa; druga sesja dostaje HistoryEditError przy pierwszym zapisie i
  od tej chwili KAŻDE `send` / `setOptions` / `markProposal` tej sesji odrzuca (do przeładowania strony). Skutek uboczny w
  szufladzie: `#onApply` (`drawer-app.mjs:538-547`) po udanym zapisie woła `markProposal`; gdy ten odrzuci, MG widzi „Zapis
  nieudany”, karta zostaje „pending”, a drugie Zastosuj zapisze te same przedmioty drugi raz (bez `expect`, gdy podgląd
  unieważniony).
- Repro (`repro-harness.mjs` R5):
  ```
  [R5 same object] false
  [R5 s1] done
  [R5 s2.send REJECTED (contract: never rejects)] HistoryEditError: history is append-only: another conversation is active for this document (use newConversation)
  [R5 s2.setOptions rejected (save chain poisoned)] history is append-only: another conversation is active ...
  ```
- Sugestia: w `openSession` trzymać mapę obietnic w locie (`pending.get(key) ?? load`); w `#persist` łańcuch kontynuować po
  błędzie (`.catch(() => {})` na łańcuchu, błąd zwracać tylko bieżącemu wywołaniu); w szufladzie błąd `markProposal` po
  `r.ok` traktować jako ostrzeżenie (zapis się udał), nie jako błąd zapisu.

## B6. Szuflada skleja częściowy tekst z nieudanej próby z tekstem ponowionej (NISKA, kosmetyka)

- Miejsce: `transport.mjs:137` (emituje `{ type: "retry", discardPartial }`), `drawer-app.mjs:274-280` (obsługuje tylko
  `text` / `tool_input`; `retry` nie czyści `#live.text`).
- Scenariusz: zerwany strumień (sieć/`overloaded_error` w środku) jest ponawiany (`retryMidStream` domyślnie true); blok
  „AI pracuje” pokazuje „Szukam…Szukam…”. Historia jest poprawna (tylko ostatnia próba).
- Sugestia: w `case "stream"` przy `data.type === "retry"` (albo `attempt` > 1) wyzerować `#live.text` / `toolName`.

## B7. Ponowienia 429 bez czytelnego `retry-after` po 1 s i 2 s (NISKA, niezweryfikowane w przeglądarce)

- Miejsce: `transport.mjs:185-191` (`retry-after`, `x-should-retry`, `request-id` z nagłówków), `:72-76` (backoff 1 s / 2 s).
- Scenariusz: w przeglądarce nagłówki spoza listy CORS-safelisted są widoczne tylko, gdy serwer poda je w
  `Access-Control-Expose-Headers` (nie sprawdzone dla api.anthropic.com). Bez tego `retry-after` = null i limit minutowy
  ponawiany po 1 s i 2 s (repro `repro-transport.mjs`: `429 ... retry delays ms: [ 1000, 2000 ]`), oba prawie na pewno
  przegrywają, MG dostaje błąd po ~3 s. Klucz: we wszystkich ścieżkach błędu zredagowany (repro: 401 z kluczem w treści,
  wyjątek fetch z kluczem, `JSON.stringify(req)` -> `leaks: false`).
- Sugestia: dla `rate-limit` bez `retry-after` minimalne opóźnienie ok. 10-20 s (w ramach zegara tury) albo brak ponowień i
  komunikat; sprawdzić na żywo, czy `retry-after` jest czytelny.

## B8. Szacunek kosztu zakłada, że cała wcześniejsza historia jest w cache, także po wygaśnięciu TTL (NISKA)

- Miejsce: `harness.mjs:398-405` (`seen = lastPromptTokens` po stawce `cacheRead`).
- Scenariusz: rozmowa wznowiona po godzinach (ogon 5 min, prefiks 1 h już wygasły): 140k tok historii na Sonnet 5.5 jest
  szacowane na ok. 0,05 USD, realnie ok. 0,39 USD (zapis 5 min). Rezerwacja limitów modułu i limit na wiadomość sprawdzane na
  zaniżonej kwocie; realny koszt i tak jest księgowany po fakcie.
- Sugestia: gdy od ostatniego żądania minęło > TTL ogona, liczyć `seen` po stawce zapisu (albo max obu).

## B9. Drobne (NISKA)

- `writer.mjs:876-879`: TTL blokady porównuje `Date.now()` tego klienta z `at` zapisanym przez inny klient (inny zegar); przy
  rozjechanym zegarze drugiego MG blokada wygasa od razu albo trzyma do TTL. Każde wywołanie `apply` (też pierwsze, które
  kończy się tylko `needsConfirm`) zapisuje flagę blokady 2x na aktorze (dwie aktualizacje, przerysowanie arkusza, unieważniony
  podgląd szuflady).
- `harness.mjs:527`: „Not run: the previous turn stopped (X)” bierze `reason` POPRZEDNIEJ zapisanej tury; po przeładowaniu
  strony w trakcie tury (tura nie zapisana) tekst podaje powód starszej tury (np. `submitted`). Kosmetyka dla modelu.
- `build-settings.mjs:28-31`: model to dowolny tekst, a `effort` domyślnie `medium`; np. `claude-haiku-4-5` z `output_config.effort`
  dostaje 400 przy każdym żądaniu (skill: effort nie działa na Haiku 4.5). Lista wyboru albo walidacja id modelu.

---

## Sprawdzone, bez błędu

- Kształt żądania na `anthropic-version: 2026-10-21`: brak `temperature/top_p/top_k`, brak wymuszonego `tool_choice`, brak
  prefill (`checkMessages`), narzędzia posortowane i stałe, 2 punkty cache (system[2] 1 h + górny automatyczny 5 min) <= 4,
  kolejność TTL poprawna (1 h przed 5 min), `fallbacks: "default"` z nagłówkiem beta, pre-warm `max_tokens: 0` bez strumienia.
- Klucz: tylko nagłówek `x-api-key` (nieenumerowalny), redakcja we wszystkich błędach transportu i powiadomieniach harnessu.
- Parowanie `tool_use`/`tool_result`: wszystkie wyniki partii w JEDNEJ wiadomości; „Not run” na początku następnej wiadomości
  MG po Stop / limicie narzędzi / `max_tokens`; wstrzymane wyniki W3-4 i runda poprawki (poza B2/B3) dają poprawne kolejności.
- Stop / zegar tury: przerwanie w trakcie strumienia, uśpienia retry i narzędzi; `wall` -> `cap.wall`; rezerwacje zwalniane.
- Writer: blokada w pamięci + flaga (dwa Apply naraz -> `busy`), `guard` (tylko MG, nie kompendium, niezapisany formularz),
  rollback faz create/swap/update/remove/order/actor z przywróceniem kolejności, dziennik undo (10 przebiegów, 24 h, 400k
  znaków, najnowszy zawsze zostaje), dryf -> potwierdzenie. Szuflada blokuje Apply/Undo/Discard w trakcie tury i odwrotnie.
- Uprawnienia: builder tylko dla MG (`attachBuilder`, `canUse`, `writer.guard`), aktor innego systemu / typu odrzucany
  (`registry.supports`, `planInternal` `doc.type`), bez plus-ultra mosty zwracają „niedostępne”.
- Wstrzyknięcia w bloku arkusza: nazwy i teksty w cudzysłowie z ucieczką `\"`/`\n` (`snapshot.mjs:67`).
