# AI Tile (W7-A, W7-B): zaznaczasz prostokąt na mapie, model go zmienia, wynik wklejany jako Tile

## 0. Interpretacja zlecenia (wiążąca dla tej pracy)

Zlecenie właściciela (dosłownie): „nowy element ai gen. nowy button w ai gen, który pozwala na tworzenie tilei. rysujemy
kształt na mapie i wysyłamy to do modelu z promptem co ma zmienić, a potem wklejamy tile".

**Zmiana właściciela 2026-11-19 (W7-A, zastępuje wcześniejszy zakres):**
1. Na razie TYLKO prostokąt (bez wielokąta, elipsy, odręcznego: usunięte z UI i ze specyfikacji). Rdzeń geometrii
   zostaje ogólny (kształt = lista punktów, bbox, punkty w batchu), ale inne kształty NIE są zaimplementowane.

**Zmiana właściciela 2026-11-19 (W7-B, po teście na żywo; zastępuje „obraz 1 + obraz 2 + maska” z W7-A):**
2. Do modelu idzie JEDEN duży obraz = otoczenie zaznaczenia (domyślnie 2× szersze i 2× wyższe wokół tego samego
   środka, przycięte do granic płótna) z CZERWONYM OBRYSEM prostokąta zaznaczenia, bez maski, bez drugiego pliku.
   Model zwraca cały obraz; wycinamy z niego dokładnie prostokąt zaznaczenia (znamy jego położenie), skalujemy do
   rozmiaru kafelka, miękka krawędź jak dotąd, wklejenie jako Tile.
   Powód (test na żywo właściciela, gpt-image-2.6-flare medium, scena ze skrzyniami): maska całkowicie przezroczysta
   = model rysuje kadr od nowa (oddala, zmienia skalę i układ); dwa obrazy bez maski trzymały kadr, ale jeden obraz
   1536×1024 (otoczenie 2100×1400 px sceny, zaznaczenie 1050×700 pośrodku, obrys #ff0000 6 px) dał idealny kadr
   i skalę, edycję tylko w obrysie i usunięty obrys. Dokumentacja OpenAI images/edits: maska dotyczy tylko pierwszego
   obrazu, przezroczyste = do zastąpienia; całkowicie przezroczysta maska = generacja od zera.

Zakres:
- Przycisk „AI Tile” w kategorii „Moinens AI Gen” lewego paska (obok Ustawień / Batchy / Logu; tylko MG) uruchamia tryb
  zaznaczania: przeciągnięcie LPM rysuje prostokąt na płótnie (nakładka PIXI w układzie sceny), narożniki i cały
  prostokąt można przeciągać, Esc anuluje, Enter / „Dalej” otwiera okno.
- Okno: prompt „co zmienić”, wersje 1-8, Teraz/Batch, miękka krawędź, tokeny na obrazie, otoczenie 1,5×/2×/3×,
  podgląd wysyłanego obrazu (z obrysem), rozmiar wysyłany i szacunek tokenów wejścia, szacunek kosztu, model z typu.
- Wynik: wycięty prostokąt zaznaczenia z całego wyniku, skalowany do pliku kafelka, miękka krawędź do środka, zapis
  w `ai-image-gen/tiles/<scena>/` (optymalizacja z typu, alfa), wklejenie Tile dokładnie w miejscu prostokąta.
- Wersje: podgląd przyciętego wyniku na mapie w miejscu prostokąta, przełączanie, Akceptuj / Odrzuć / Powtórz / Oryginał.
- Fast i Batch jak reszta modułu, oba z tym samym jednym obrazem. Batch: geometria (scena, prostokąt, region)
  w rekordzie, po wyniku wklejenie na tej samej scenie; >1 wersja = okno wersji.
- Typ obrazu „AI Tile” (wirtualny, `moinens-ai-gen.tile`) w oknie Ustawień: dostawca, model, jakość, rozmiar (= górny
  limit żądania), szablon promptu (edytowalny), referencje typu (własne obrazy typu, jeśli MG je doda), wyjście.

## 1. Przepływ

1. Klik „AI Tile” (ikona `fa-vector-square`); wymaga sceny na płótnie.
2. Zaznaczanie: HUD u góry (podpowiedź, Anuluj, Dalej). LPM przechwytywany na `window` w fazie capture (przed PIXI,
   który słucha na `<canvas id="board">`, też w capture), tylko gdy cel = płótno; PPM (przesuwanie) i kółko (zoom)
   idą do Foundry. Współrzędne: `canvas.canvasCoordinatesFromClient`. Prostokąt w całych px sceny.
3. Okno AI Tile przygotowuje zadanie od razu (podgląd), ponownie po zmianie trybu / tokenów / otoczenia / krawędzi.
4. Teraz: `executeGeneration` (wspólny rdzeń: rezerwacja budżetu, limity, log, koszt) z `editImage` = wysyłany obraz
   (pierwszy, bez zmniejszania), `extraRefs` = [], bez maski.
5. Przegląd wersji -> Akceptuj: zapis + `scene.createEmbeddedDocuments("Tile", …)` z flagą `moinens-ai-gen.aiTile`.

## 2. Geometria (`scripts/tile/tile-core.mjs`, testy `dev/test-ai-tile-core.mjs`)

- Otoczenie (`contextRect`): prostokąt `factor`× szer. i wys. wokół środka zaznaczenia (domyślnie 2, w oknie 1,5/2/3),
  PRZYCIĘTY do `canvas.dimensions.rect` (nie przesuwany), zawsze zawiera zaznaczenie.
- Region (`planRegion`): otoczenie powiększone TYLKO do proporcji, które model zwróci (OpenAI: `normalizeOpenAISize`
  z px sceny otoczenia ograniczonych dłuższym bokiem typu, domyślnie 2048, bez powiększania ponad px sceny poza
  minimum API; Gemini: najbliższy dozwolony aspekt + najmniejszy `imageSize` ≥ dłuższy bok, ≤ limit typu; OpenRouter:
  aspekt bazowy, 1024), symetrycznie, w granicach płótna. `sel` = położenie zaznaczenia w regionie w ułamkach 0..1
  (przy krawędzi płótna zaznaczenie nie jest pośrodku). Wysyłany obraz: OpenAI = rozmiar żądania; inni ≤ 1536 i ≤ px
  sceny regionu (min. 512).
- Zaznaczenie ma natywną rozdzielczość, gdy region mieści się w limicie typu; przy domyślnym 2048 i otoczeniu 2×
  prostokąt szerszy niż ok. 1000 px sceny dostaje trochę mniej (limit podnosi MG w typie, koszt rośnie).
- Obrys (`outlineBands`): 4 pasy tuż POZA zaznaczeniem (granice zaokrąglone na zewnątrz, żaden czerwony piksel
  w zaznaczeniu), kolor #ff0000, grubość max(4, round(0,4 % dłuższego boku obrazu)), przycięte do obrazu. Obraz
  spłaszczony na kolor tła sceny (bez przezroczystości).
- Wynik (`tileRaster`): kadr środka przy różnicy proporcji > 1 % (`resultCrop`), potem źródło = dokładnie prostokąt
  zaznaczenia w px wyniku, cel = cały plik kafelka (prostokąt × s, s = px wyniku / px sceny, ≤ maxEdge wyjścia typu,
  domyślnie 4096). Alfa: miękka krawędź DO ŚRODKA (`alphaRect`), więc Tile nigdy nie wychodzi poza zaznaczenie.
- Tile: `width,height` = prostokąt, `x,y` = ŚRODEK prostokąta z jawną kotwicą `texture.anchorX/Y = 0.5` (v14: x/y
  Tile to punkt kotwicy kształtu, nie lewy górny róg; sprawdzone na żywo), `rotation 0`, `elevation 0`, `sort` = max(sort kafelków elewacji 0) + 1.
- Siatka w prompcie: `grid.size × (szer. wysyłanego obrazu / szer. regionu)` px na pole, `grid.distance grid.units`.

## 3. Jak zaznaczenie jest pokazane (decyzja właściciela, W7-B)

Czerwony obrys tuż poza zaznaczeniem na jedynym wysyłanym obrazie; prompt każe edytować tylko wnętrze obrysu,
resztę zostawić piksel w piksel i usunąć obrys. Położenie słowami (`{pos}`) dostępne dla własnych szablonów, domyślny
go nie używa. Znane ograniczenie: obiekt leżący na granicy obrysu może być zmieniony tylko częściowo, a kafelek tnie go
na krawędzi prostokąta (opisane w README).

## 4. API dostawców

- OpenAI `images/edits` (multipart): `image[]` = [wysyłany obraz], bez maski. Batch OpenAI: JSON `images/edits` z tym
  samym jednym obrazem.
- Gemini (Interactions / generateContent) i OpenRouter `/images`: jeden obraz, potem prompt; bez maski.
- Koszt: 1 obraz wejściowy (`estimateInfo(cfg, refs + 1)`), szacunek tokenów OpenAI w oknie = wysyłany obraz bez
  zmniejszania (`inputEstimate`). Log: `refsCount` liczy ten obraz.
- Wspólny rdzeń (`executeGeneration`, `providers/openai.mjs`) nadal umie wysłać maskę, AI Tile jej nie używa.

## 5. Domyślny szablon promptu (EN, edytowalny w Ustawieniach -> AI Tile)

Pola: `{description}`, `{grid}`, `{distance}`, `{units}`, `{scene}`, `{pos}` (położenie zaznaczenia w obrazie);
`{guide}` tylko dla starych własnych szablonów (pusty). Treść (wg promptu sprawdzonego przez właściciela): mapa
z góry; edytuj TYLKO obszar w czerwonym prostokącie: {description}; wszystko poza nim bez zmian, piksel w piksel;
ta sama kamera, zoom i skala (pole siatki ≈ {grid} px = {distance} {units}), światło i styl; nie oddalaj, nie przycinaj,
nie dodawaj ani nie usuwaj obiektów bez polecenia; zwróć cały obraz w tym samym kadrze i usuń czerwony obrys; bez
siatki, napisów i etykiet.
Migracja: zapisany szablon równy dawnemu domyślnemu (W7-A, dwa obrazy; porównanie bez różnic w białych znakach)
zastępowany przy starcie (MG) nowym domyślnym (`patchSavedConfig`); w locie też (`tilePromptTemplate`). Własne
szablony zostają.

## 6. Dane i ustawienia

- `tileOptions` (świat, config: false): `feather` (8), `tokens` (false), `context` (2; 1,5/2/3), `count` (1);
  dawny klucz `mask` z zapisów W7-A pomijany (`normalizeTileOptions`).
- Typ `moinens-ai-gen.tile`: domyślnie OpenAI / model domyślny, 2048×2048 (limit), medium, referencje typu „max” 512,
  wyjście WebP 4096 q 0.9.
- Batch: `item.target = {uuid: scene.uuid, field: "tile"}`, `item.meta.tile = {sceneId, bbox, region, ratio, feather,
  points}`; gałąź w `applyBatchItem`; Tile z flagą `key = <batch>-<item>` (ponowienie nie robi duplikatu).

## 7. Ryzyka

- Render `canvas.primary` do RenderTexture z własną macierzą (stan ekranu, okluzja). Plan B: złożenie z plików
  (tło + kafelki poniżej `foregroundElevation`). Kafelki „overhead”, pogoda i (domyślnie) tokeny ukryte.
- Model może nie trzymać kadru dokładnie: kadr środka przy innej proporcji + miękka krawędź. Sprawdzone przez
  właściciela tylko dla gpt-image-2.6-flare medium; Gemini / OpenRouter / Batch bez prawdziwych wywołań.
- Obiekty na granicy obrysu (patrz 3).
