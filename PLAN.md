# ai-image-gen: plan (Foundry v14)

Źródło wzorców: repo Hexnen/roleplay (workshop). Porty z TS/Node do czystego JS w przeglądarce:
- src/lib/roleplay/imageGen/{openai,gemini,openrouter,shared}.ts: sync (fast)
- src/lib/roleplay/workshopBatch/{openai,gemini,cost,record}.ts + WORKSHOP-BATCH-RESEARCH.md: batch

## Zasady architektury
1. Moduł = kod przeglądarkowy (nie ma backendu). Wywołania API idą bezpośrednio z klienta GM-a. Trzeba sprawdzić CORS (OpenAI, Gemini File API, OpenRouter); jeśli któryś blokuje, potrzebny jest proxy.
2. Klucze API w ustawieniu `scope: "client"` (world-scope jest synchronizowany do graczy = wyciek). Limity (budżet dzienny/miesięczny, max koszt na żądanie, max obrazów w batchu) w `scope: "world"`.
3. Tylko GM generuje (v1). Zapis wyniku: FilePicker upload do `ai-image-gen/<system>/<doctype>/`, potem `document.update({img})`.
4. Batch jest asynchroniczny (do 24 h): rekord batcha trwa w world setting, poller działa gdy GM jest online, ingest jest wznawialny (jak `ingest` marker w roleplay). OpenRouter nie ma batcha: przycisk Batch wyłączony z tooltipem.
5. Koszt liczony z `usage` odpowiedzi, sumowany do licznika limitów; przekroczenie limitu blokuje generację.

## Typ obrazka (klucz konfiguracji)
`<systemId>.<documentName>.<subtype>` np. `dnd5e.Actor.character`, `dnd5e.Item.weapon`, `core.Macro`, plus `Scene/JournalEntry/...` później.
Wykrywanie: `game.system.id` + `CONFIG[docName].typeLabels` / `game.documentTypes` + klasa arkusza. Każdy typ ma: rozdzielczość/aspekt, model (z dostawcą), szablon promptu (`{description} {name} {type}`), referencje (ścieżki plików), tryb domyślny.

## UI
- Ikona w lewym pasku narzędzi (`getSceneControlButtons`, v14 = obiekt kluczowany) otwiera ApplicationV2 "AI Image Config" (lista wykrytych typów, edytor per typ).
- Przycisk na obrazku arkusza (hooki `renderActorSheetV2`, `renderItemSheetV2`, `renderMacroConfig`; selektory `[data-action="editImage"]`, `img[data-edit]` + fallback konfigurowalny per arkusz). Klik otwiera modal: opis + [Fast] [Batch].

## Fazy (kolejność)
0. Szkielet: module.json, settings (klucze/limity), lang, API-singleton. Spike CORS dla 3 dostawców (blokuje resztę).
1. Provider layer (sync): openai / gemini / openrouter, wspólny interfejs `generate({model, prompt, refs, size})` → Blob + koszt. Moduł liczenia kosztu i limitów.
2. Detekcja typów + store konfiguracji + okno konfiguracji (ikona w pasku).
3. Przycisk na arkuszu Actor/Item + modal + tryb Fast + zapis do pliku i `update(img)`.
4. Macro (to samo, inny hook).
5. Batch: OpenAI (Files + /v1/batches), Gemini (File API JSONL + batchGenerateContent), rekord, poller, ingest, UI statusu.
6. Szlify: referencje (upload raz), błędy/moderacja, i18n pl/en, testy na żywo w świecie.

Równolegle po fazie 1: 2 (config UI) i provider-batch (5, sam kod bez UI) są niezależne; 3 zależy od 1+2.

## Do potwierdzenia przez użytkownika
- Id/nazwa modułu, system(y) do testów (Invincible?), dozwolone kto-generuje.
