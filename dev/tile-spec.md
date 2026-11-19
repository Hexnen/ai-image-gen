# AI Tile (W7-A): rysujesz kształt na mapie, model go zmienia, wynik wklejany jako Tile

## 0. Interpretacja zlecenia (wiążąca dla tej pracy)

Zlecenie właściciela (dosłownie): „nowy element ai gen. nowy button w ai gen, który pozwala na tworzenie tilei. rysujemy
kształt na mapie i wysyłamy to do modelu z promptem co ma zmienić, a potem wklejamy tile".

- Nowy przycisk w pasku narzędzi AI Gen (kategoria „Moinens AI Gen” po lewej, obok Ustawień / Batchy / Logu; tylko MG)
  uruchamia tryb „AI Tile”: MG rysuje kształt (wielokąt, prostokąt, elipsa, odręcznie z wygładzeniem) bezpośrednio na
  płótnie sceny (nakładka PIXI w układzie sceny), może przeciągać punkty, anuluje (Esc) albo zatwierdza (Enter).
- Moduł wycina z aktualnej sceny fragment pod kształtem (bounding box + margines kontekstu, dopasowany do proporcji,
  które model naprawdę zwraca), renderuje go z płótna (tło + kafelki; tokeny domyślnie ukryte, oświetlenie nigdy, bo
  renderujemy tylko grupę `primary`), buduje maskę kształtu i wysyła do modelu obrazowego z promptem MG-a „co zmienić”.
- Wynik jest skalowany z powrotem do regionu, przycinany do kształtu (alfa z maski, miękka krawędź opcjonalna),
  optymalizowany i zapisywany w `ai-image-gen/tiles/<scena>/` jak inne obrazy, a potem wklejany jako Tile dokładnie w
  miejscu kształtu (x/y/szer./wys. = bounding box kształtu w px sceny, rotacja 0, nad tłem i pod tokenami).
- Kilka wariantów: podgląd na mapie (sprite w miejscu kształtu), przełączanie wariantów, Akceptuj / Odrzuć / Powtórz.
- Fast i Batch jak reszta modułu (Batch: zadanie czeka; po wyniku wklejenie na TEJ SAMEJ scenie, geometria zapisana w
  rekordzie batcha; >1 wariant w batchu = okno wyboru z podglądem na mapie, gdy MG otworzy tę scenę).
- Używamy istniejących: konfiguracji typu obrazu (dostawca, model, jakość, rozmiar = górny limit, wyjście), limitów
  budżetu, logu wywołań, licznika kosztu, kluczy (GM-only), lang pl/en. Domyślny szablon promptu (perspektywa, światło,
  skala siatki, dopasowanie krawędzi) jest edytowalny w oknie Ustawień jako typ „AI Tile”.
- Rzeczy niejasne -> `dev/tile-questions.md` z zachowaniem tymczasowym.

## 1. Przepływ

1. MG klika „AI Tile” (ikona `fa-vector-square`). Moduł wymaga aktywnej sceny na płótnie (`canvas.ready`).
2. Tryb rysowania: pasek HUD u góry płótna (kształt: wielokąt / prostokąt / elipsa / odręcznie; Cofnij punkt; Anuluj;
   Dalej). Wielokąt: klik dodaje punkt, klik w pierwszy punkt / podwójny klik / Enter zamyka. Prostokąt i elipsa:
   przeciągnięcie. Odręcznie: przeciągnięcie, potem uproszczenie (Ramer-Douglas-Peucker) i wygładzenie (Chaikin).
   Po zamknięciu kształtu punkty można przeciągać (uchwyty). PPM i kółko zostają dla Foundry (przesuwanie, zoom).
   Zdarzenia przechwytujemy na elemencie `<canvas id="board">` w fazie capture (LPM), żeby warstwy Foundry (zaznaczanie
   tokenów) ich nie dostały; współrzędne: `canvas.canvasCoordinatesFromClient`.
3. Okno „AI Tile”: prompt „co zmienić”, liczba wariantów (1-8), tryb Teraz/Batch, margines kontekstu (%), miękka
   krawędź (px sceny), tokeny w wycinku (domyślnie nie), maska OpenAI (domyślnie tak, gdy dostawca = OpenAI), podgląd
   wycinka i maski, szacunek kosztu, dostawca/model z typu „AI Tile” (link do ustawień).
4. Generacja: `executeGeneration` (ten sam rdzeń co Fast: rezerwacja budżetu, log, koszt) z nowymi opcjami
   `editImage` (obraz do edycji, wysłany bez zmniejszania) i `mask` (tylko OpenAI `images/edits`).
5. Przegląd: każdy wynik od razu przetworzony (skalowanie do regionu, wycięcie bbox, alfa z maski), podgląd na mapie
   w miejscu kształtu; okno z miniaturami: Akceptuj (zapis + Tile), Odrzuć (nic nie zapisane), Powtórz (kolejne
   warianty z tym samym wycinkiem), Pokaż oryginał (ukrywa podgląd).
6. Akceptuj: `saveImageBlobEx` (optymalizacja z typu, alfa wymuszona: WebP/PNG) do `ai-image-gen/tiles/<scena>`,
   potem `scene.createEmbeddedDocuments("Tile", [data])` z flagą `moinens-ai-gen.aiTile` (prompt, model, batch).

## 2. Geometria (czysta, `scripts/tile/tile-core.mjs`, testy Node)

- Kształt: zamknięty wielokąt w px sceny (elipsa = 48 punktów, prostokąt = 4). `bbox` = zaokrąglony na zewnątrz.
- Region = bbox + margines `max(minMarginPx, margin% × dłuższy bok)` z każdej strony, potem POWIĘKSZONY (nigdy
  zmniejszony) do proporcji, które model zwróci: OpenAI = proporcje rozmiaru po `normalizeOpenAISize` (×16, < 2,9:1),
  Gemini/OpenRouter = najbliższy dozwolony aspekt (`nearestAspect`). Region przesuwany tak, by mieścił się w
  `canvas.dimensions` (rect całego płótna z paddingiem), gdy to możliwe; bez przycinania proporcji.
- Rozmiar żądania: OpenAI = wymiary regionu w px sceny, ograniczone dłuższym bokiem typu (`max(width,height)` z
  konfiguracji, domyślnie 2048) i regułami API (min. 655 360 px: mały kształt jest powiększany przez model). Gemini:
  `imageSize` = najmniejszy z modelu ≥ dłuższy bok regionu, ale nie większy niż w konfiguracji typu.
- Obraz do edycji: OpenAI = dokładnie rozmiar żądania (maska musi mieć te same wymiary); inni = dłuższy bok ≤ 1536.
- Wynik: gdy proporcje wyniku różnią się od oczekiwanych o > 1 %, środek wyniku przycinany do oczekiwanych proporcji
  (`resultCrop`), potem skala `s = wynikW / regionW` (px obrazu na px sceny). Plik kafelka = wycinek bbox w tej skali
  (`bbox.w × s` na `bbox.h × s`), alfa = maska kształtu (opcjonalne rozmycie `feather × s`).
- Tile: `x = bbox.x`, `y = bbox.y`, `width = bbox.w`, `height = bbox.h`, `rotation 0`, `elevation` = 0 (poziom tła;
  poniżej `scene.foregroundElevation`, więc nie jest „overhead”), `sort` = max(sort kafelków na tej elewacji) + 1.
  Tokeny są nad kafelkami na tej samej elewacji (warstwa sortowania TOKENS > TILES w v14).
- Siatka: `scene.grid.size` px = `scene.grid.distance` `scene.grid.units`; do promptu idzie rozmiar pola W OBRAZIE
  wysyłanym (`grid.size × skala wycinka`).

## 3. Dane

- Typ obrazu (wirtualny, w pamięci, jak typy innych modułów): klucz `moinens-ai-gen.tile`, grupa „AI Tile”, domyślnie:
  OpenAI, domyślny model, 2048×2048 (górny limit), jakość medium, szablon promptu z §5, wyjście maxEdge 4096 WebP.
  Konfigurację zapisaną w oknie Ustawień trzyma istniejące ustawienie `imageTypes`.
- Ustawienia świata (restricted, config: false; zmieniane w oknie AI Tile i zapamiętywane): `tile.margin` (0.25),
  `tile.feather` (8), `tile.tokens` (false), `tile.mask` (true), `tile.count` (1), `tile.shape` ("polygon").
- Batch: `item.target = {uuid: scene.uuid, field: "tile"}`, `item.meta.tile = {sceneId, bbox, region, points
  (względem bbox), feather, crop:{w,h}}`; refs = [wycinek, przewodnik]. `applyBatchItem` ma gałąź tile (przetworzenie
  + zapis + Tile; Tile z flagą `{batchId, itemId}`, więc ponowienie nie tworzy duplikatu).

## 4. API dostawców

- OpenAI `images/edits` (multipart): `image[]` = wycinek (+ przewodnik, gdy bez maski), `mask` = PNG tych samych
  wymiarów co pierwszy obraz, przezroczysty tam, gdzie wolno zmieniać (kształt + miękka krawędź). Wg dokumentacji
  OpenAI maska dotyczy pierwszego obrazu i jest „wskazówką” (model może zmienić więcej), dlatego i tak przycinamy
  wynik maską po swojej stronie. NIEZWERYFIKOWANE dla 2.5/2.6 na prawdziwym kluczu.
- Gemini / OpenRouter: brak maski; wysyłamy 2 obrazy: 1 = wycinek, 2 = przewodnik (ten sam wycinek, obszar poza
  kształtem przyciemniony, kontur czerwony), prompt mówi, że kontur i przyciemnienie mają NIE trafić do wyniku.
- Batch OpenAI: JSON `images/edits` z `images` (bez maski: pole maski w JSON niezweryfikowane) = wycinek + przewodnik.
  Batch Gemini: inline obrazy. OpenRouter: bez batcha (jak wszędzie).

## 5. Domyślny szablon promptu (EN, bo modele; edytowalny)

Zmienne: `{description}` (prompt MG), `{grid}` (px pola siatki w obrazie 1), `{distance}` `{units}`, `{scene}`,
`{guide}` (zdanie o masce albo o obrazie przewodnika, wstawiane przez moduł).

## 6. Ryzyka

- Render `canvas.primary` do RenderTexture z własną macierzą: grupa primary w v14 może zależeć od stanu ekranu
  (okluzja, głębia). Plan B: złożenie 2D z plików (tło sceny + kafelki wg sort/elewacji, z rotacją/alfą/odbiciem).
  Wybór metody sprawdzany na żywo.
- Modele nie trzymają dokładnie kadru (przesunięcie/obrót treści, inny aspekt): przycinamy środek, krawędź miękka
  maskuje drobne przesunięcia. Prawdziwej odpowiedzi modeli NIE sprawdzamy (zero płatnych wywołań).
- Duże regiony: koszt rośnie z rozmiarem (OpenAI płaci tokenami wyjścia); limit = rozmiar z konfiguracji typu.
- Tile poza `sceneRect` (w paddingu) jest dozwolony, render daje tam tło płótna.
- Gracze: nic (przycisk, okna i API tylko MG; Tile widzą normalnie jak każdy kafelek).
