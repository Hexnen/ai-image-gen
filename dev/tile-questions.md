# AI Tile: pytania do właściciela (z zachowaniem tymczasowym)

Każde pytanie ma zachowanie, które działa do czasu decyzji. Nic tu nie blokuje użycia.
Rozstrzygnięte 2026-11-19: tylko prostokąt; dwa obrazy (zaznaczenie + kontekst 2×).

1. **Gdzie przycisk?** Tymczasowo: kategoria „Moinens AI Gen” w lewym pasku (obok Ustawień / Batchy / Logu), przycisk
   „AI Tile”. Alternatywa: także w narzędziach Kafelków (Tiles).
2. **Tokeny na obrazach?** Tymczasowo: NIE (ukryte na czas renderu, przełącznik w oknie). Oświetlenie, mgła i kafelki
   „overhead” nigdy.
3. **Elewacja kafelka.** Tymczasowo: 0 (poziom tła), `sort` nad kafelkami tej elewacji, czyli pod tokenami i pod
   „overhead”.
4. **Miękka krawędź.** Tymczasowo: 8 px sceny DO ŚRODKA prostokąta (0 = ostro). Tile nie wychodzi poza zaznaczenie.
5. **Jak pokazać zaznaczenie w obrazie 2.** Tymczasowo: czerwona ramka na zewnątrz zaznaczenia + położenie w procentach
   w prompcie, dla wszystkich dostawców (bez przyciemnienia). Do sprawdzenia na prawdziwych modelach.
6. **Rozdzielczość obrazu 2.** Tymczasowo: render ≤ 1024 px, potem zwykłe zmniejszanie referencji typu (OpenAI „max”
   = 512 px, ok. 1024 tokeny wejścia). Więcej szczegółów = wyższy limit w typie AI Tile.
7. **Rozdzielczość pliku kafelka.** Tymczasowo: skala wyniku modelu, ograniczona wyjściem typu (4096, WebP z alfą).
8. **Batch z wieloma wersjami.** Tymczasowo: wyniki w `_candidates/<batch>/` już przycięte; okno wersji pokazuje
   podgląd na mapie, gdy ta scena jest otwarta (wkleić można i bez tego).
9. **Maska OpenAI.** Tymczasowo: wysyłana w trybie Teraz (wyłączana w oknie), w Batchu nie (pole maski w JSON
   batcha niezweryfikowane). Przy prostokącie maska obejmuje prawie cały obraz 1 (poza paskiem dopełnienia
   proporcji), więc głównie mówi modelowi „zmieniaj tylko to”.
10. **Folder plików.** Tymczasowo: `ai-image-gen/tiles/<nazwa-sceny>/`.
