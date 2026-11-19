# AI Tile (W7-A): zaznaczasz prostokąt na mapie, model go zmienia, wynik wklejany jako Tile

## 0. Interpretacja zlecenia (wiążąca dla tej pracy)

Zlecenie właściciela (dosłownie): „nowy element ai gen. nowy button w ai gen, który pozwala na tworzenie tilei. rysujemy
kształt na mapie i wysyłamy to do modelu z promptem co ma zmienić, a potem wklejamy tile".

**Zmiana właściciela 2026-11-19 (zastępuje wcześniejszy zakres):**
1. Na razie TYLKO prostokąt (bez wielokąta, elipsy, odręcznego: usunięte z UI i ze specyfikacji). Rdzeń geometrii
   zostaje ogólny (kształt = lista punktów, bbox, punkty w batchu, maska z punktów), ale inne kształty NIE są zaimplementowane.
2. Do modelu idą DWA obrazy: obraz 1 = wycięty zaznaczony prostokąt (+ maska tam, gdzie dostawca ją wspiera),
   obraz 2 = kontekst: obszar sceny 2× szerszy i 2× wyższy wokół tego samego środka (zaznaczenie pośrodku), przycięty
   do granic płótna, z zaznaczeniem pokazanym w obrazie 2. Szablon promptu wyjaśnia, który obraz jest którym.
   Wynik dalej przycinany do prostokąta i wklejany jako Tile.

Zakres:
- Przycisk „AI Tile” w kategorii „Moinens AI Gen” lewego paska (obok Ustawień / Batchy / Logu; tylko MG) uruchamia tryb
  zaznaczania: przeciągnięcie LPM rysuje prostokąt na płótnie (nakładka PIXI w układzie sceny), narożniki i cały
  prostokąt można przeciągać, Esc anuluje, Enter / „Dalej” otwiera okno.
- Okno: prompt „co zmienić”, wersje 1-8, Teraz/Batch, miękka krawędź, tokeny na obrazach, maska (OpenAI), podgląd
  obrazów 1, 2 i maski, liczba obrazów wejściowych z szacunkiem tokenów, szacunek kosztu, model z typu „AI Tile”.
- Wynik: skalowany do regionu, przycięty do prostokąta, miękka krawędź do środka, zapis w `ai-image-gen/tiles/<scena>/`
  (optymalizacja z typu, alfa), wklejenie Tile dokładnie w miejscu prostokąta (x/y/szer./wys. = prostokąt w px sceny,
  rotacja 0, nad kafelkami tej elewacji, pod tokenami).
- Wersje: podgląd na mapie w miejscu prostokąta, przełączanie, Akceptuj / Odrzuć / Powtórz / Oryginał.
- Fast i Batch jak reszta modułu. Batch: geometria (scena, prostokąt, region) w rekordzie, po wyniku wklejenie na tej
  samej scenie; >1 wersja = okno wersji (podgląd na mapie, gdy ta scena jest otwarta).
- Typ obrazu „AI Tile” (wirtualny, `moinens-ai-gen.tile`) w oknie Ustawień: dostawca, model, jakość, rozmiar (= górny
  limit żądania), szablon promptu (edytowalny), referencje (przeznaczenie/limit dotyczą obrazu 2), wyjście.

## 1. Przepływ

1. Klik „AI Tile” (ikona `fa-vector-square`); wymaga sceny na płótnie.
2. Zaznaczanie: HUD u góry (podpowiedź, Anuluj, Dalej). LPM przechwytywany na `window` w fazie capture (przed PIXI,
   który słucha na `<canvas id="board">`, też w capture), tylko gdy cel = płótno; PPM (przesuwanie) i kółko (zoom)
   idą do Foundry. Współrzędne: `canvas.canvasCoordinatesFromClient`. Prostokąt w całych px sceny.
3. Okno AI Tile przygotowuje zadanie od razu (podgląd), ponownie po zmianie trybu / tokenów / maski / krawędzi.
4. Teraz: `executeGeneration` (wspólny rdzeń: rezerwacja budżetu, limity, log, koszt) z `editImage` = obraz 1 (bez
   zmniejszania), `extraRefs` = [obraz 2] (zwykłe zmniejszanie referencji wg typu), `mask` (tylko OpenAI).
5. Przegląd wersji -> Akceptuj: zapis + `scene.createEmbeddedDocuments("Tile", …)` z flagą `moinens-ai-gen.aiTile`.

## 2. Geometria (`scripts/tile/tile-core.mjs`, testy `dev/test-ai-tile-core.mjs`)

- Obraz 1: region = prostokąt powiększony TYLKO do proporcji, które model zwróci (OpenAI: `normalizeOpenAISize`
  z wymiarów prostokąta, ograniczonych dłuższym bokiem typu, domyślnie 2048; Gemini/OpenRouter: najbliższy dozwolony
  aspekt), symetrycznie, w granicach płótna, nigdy nie odsłaniając zaznaczenia. Obraz 1 renderowany w rozmiarze
  żądania (OpenAI: maska musi mieć te same wymiary) albo ≤ 1536 i ≤ 2× px sceny (inni).
- Obraz 2: prostokąt 2× szer. i 2× wys. wokół środka zaznaczenia, PRZYCIĘTY do `canvas.dimensions.rect` (nie
  przesuwany), dłuższy bok ≤ 1024 px i bez powiększania; `sel` = położenie zaznaczenia w ułamkach 0..1.
- Wynik: kadr środka przy różnicy proporcji > 1 % (`resultCrop`), skala s = px wyniku / px sceny regionu, plik
  kafelka = prostokąt × s (≤ maxEdge wyjścia typu, domyślnie 4096). Alfa: miękka krawędź DO ŚRODKA (`alphaRect`:
  prostokąt zwężony o pół krawędzi, rozmycie σ = krawędź/4), więc Tile nigdy nie wychodzi poza zaznaczenie.
- Tile: `x,y,width,height` = prostokąt, `rotation 0`, `elevation 0`, `sort` = max(sort kafelków elewacji 0) + 1.
- Siatka w prompcie: `grid.size × (szer. obrazu 1 / szer. regionu)` px na pole, `grid.distance grid.units`.

## 3. Jak zaznaczenie jest pokazane w obrazie 2 (decyzja)

Czerwona ramka narysowana NA ZEWNĄTRZ zaznaczenia (nie zasłania jego brzegów) + położenie w prompcie słowami
(„from 25% to 75% of its width and from 25% to 75% of its height”), dla wszystkich dostawców jednakowo. Bez
przyciemniania (otoczenie ma być czytelne, to ono jest kontekstem). Powód: obraz 2 jest tylko referencją; ramka to
najprostszy, jednoznaczny znak dla modeli bez maski, a procenty działają także, gdy kontekst przy krawędzi sceny jest
przycięty i zaznaczenie nie jest pośrodku. Maska (OpenAI) dotyczy wyłącznie obrazu 1.

## 4. API dostawców

- OpenAI `images/edits` (multipart): `image[]` = [obraz 1, obraz 2], `mask` = PNG wymiarów obrazu 1, przezroczysty
  w zaznaczeniu (nieprzezroczysty tylko w pasku dopełnienia do proporcji). Wg dokumentacji maska dotyczy pierwszego
  obrazu. Wynik i tak przycinamy u siebie. NIEZWERYFIKOWANE prawdziwym kluczem.
- Gemini (Interactions / generateContent) i OpenRouter `/images`: 2 obrazy w kolejności, potem prompt; bez maski.
- Batch: OpenAI (JSON `images/edits`, `images` = [obraz 1, obraz 2], bez maski: pole maski w JSON batcha
  niezweryfikowane), Gemini (inline). Obraz 2 zmniejszany przed wysyłką tak samo jak w Teraz (`prepareRefs`).
- Koszt: 2 obrazy wejściowe (`estimateInfo(cfg, refs + 2)`), szacunek tokenów OpenAI w oknie: obraz 1 wg rozmiaru
  wysyłanego + obraz 2 po drabince referencji (`inputEstimate`). Log: `refsCount` liczy obraz 1.

## 5. Domyślny szablon promptu (EN, edytowalny w Ustawieniach -> AI Tile)

Pola: `{description}`, `{pos}` (położenie w obrazie 2), `{guide}` (zdanie o masce albo nic), `{grid}`, `{distance}`,
`{units}`, `{scene}`. Treść: dwa obrazy tej samej mapy; obraz 1 = dokładny obszar do edycji; obraz 2 = szerszy
widok tylko jako kontekst, czerwona ramka ({pos}) = gdzie leży obraz 1; edytuj obraz 1: {description}; zachowaj
kamerę z góry, światło, paletę, styl i skalę (pole siatki ≈ {grid} px = {distance} {units}); krawędzie mają
przechodzić w otoczenie z obrazu 2; zwróć tylko obraz 1 w tym samym kadrze, bez ramki, siatki i napisów.

## 6. Dane i ustawienia

- `tileOptions` (świat, config: false): `feather` (8), `tokens` (false), `mask` (true), `count` (1).
- Typ `moinens-ai-gen.tile`: domyślnie OpenAI / model domyślny, 2048×2048 (limit), medium, referencje „max” 512,
  wyjście WebP 4096 q 0.9.
- Batch: `item.target = {uuid: scene.uuid, field: "tile"}`, `item.meta.tile = {sceneId, bbox, region, ratio, feather,
  points}`; gałąź w `applyBatchItem`; Tile z flagą `key = <batch>-<item>` (ponowienie nie robi duplikatu).

## 7. Ryzyka

- Render `canvas.primary` do RenderTexture z własną macierzą (stan ekranu, okluzja). Plan B: złożenie z plików
  (tło + kafelki poniżej `foregroundElevation`). Kafelki „overhead” i (domyślnie) tokeny ukryte na czas renderu.
- Modele nie trzymają kadru dokładnie: kadr środka + miękka krawędź; prawdziwych odpowiedzi NIE sprawdzamy.
- Obraz 2 domyślnie 512 px (OpenAI) po zmniejszeniu: tani, ale mało szczegółów; MG może podnieść w typie.
