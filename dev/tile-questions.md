# AI Tile: pytania do właściciela (z zachowaniem tymczasowym)

Każde pytanie ma zachowanie, które działa do czasu decyzji. Nic tu nie blokuje użycia.
Rozstrzygnięte 2026-11-19: tylko prostokąt (W7-A); JEDEN obraz = otoczenie 2× z czerwonym obrysem, bez maski
i bez drugiego obrazu (W7-B, po teście na żywo).

**Wynik testu na żywo właściciela (2026-11-19, gpt-image-2.6-flare medium, scena ze skrzyniami, zaznaczenie 1050×700):**
- dwa obrazy + maska całkowicie przezroczysta + kontekst: model przerysował kadr (oddalił, skrzynie ~2× mniejsze,
  inne ściany);
- maska bez kontekstu: zupełnie inny obraz (maska zachęca do generacji od zera);
- bez maski, bez kontekstu: kadr i skala idealne, zmiana tylko stanu (rozbite, płonące);
- bez maski, z kontekstem i promptem „nie oddalaj, ten sam kadr”: kadr i skala zachowane, wynik dobry;
- JEDEN obraz 1536×1024 (otoczenie 2100×1400 px sceny, zaznaczenie pośrodku, obrys #ff0000 6 px): idealny kadr
  i skala, edycja tylko w obrysie, obrys usunięty. To jest metoda od W7-B.

1. **Gdzie przycisk?** Tymczasowo: kategoria „Moinens AI Gen” w lewym pasku (obok Ustawień / Batchy / Logu), przycisk
   „AI Tile”. Alternatywa: także w narzędziach Kafelków (Tiles).
2. **Tokeny na obrazie?** Tymczasowo: NIE (ukryte na czas renderu, przełącznik w oknie). Oświetlenie, mgła, pogoda
   i kafelki „overhead” nigdy.
3. **Elewacja kafelka.** Tymczasowo: 0 (poziom tła), `sort` nad kafelkami tej elewacji, czyli pod tokenami i pod
   „overhead”.
4. **Miękka krawędź.** Tymczasowo: 8 px sceny DO ŚRODKA prostokąta (0 = ostro). Tile nie wychodzi poza zaznaczenie.
5. **Jak pokazać zaznaczenie.** ROZSTRZYGNIĘTE (W7-B): czerwony obrys tuż poza zaznaczeniem na jedynym obrazie.
6. **Rozdzielczość wysyłanego obrazu.** Tymczasowo: px sceny otoczenia (bez powiększania), ograniczone limitem typu
   AI Tile (domyślnie 2048 px dłuższego boku). Przy otoczeniu 2× prostokąt szerszy niż ok. 1000 px sceny dostaje
   trochę mniej niż natywnie (np. 1050×700 -> ok. 1020×680 w obrazie 2048×1360). Pytanie: podnieść domyślny limit
   typu (np. 3072) kosztem ceny? Na razie nie.
7. **Rozdzielczość pliku kafelka.** Tymczasowo: skala wyniku modelu, ograniczona wyjściem typu (4096, WebP z alfą).
8. **Batch z wieloma wersjami.** Tymczasowo: wyniki w `_candidates/<batch>/` już przycięte; okno wersji pokazuje
   podgląd na mapie, gdy ta scena jest otwarta (wkleić można i bez tego).
9. **Maska OpenAI.** ROZSTRZYGNIĘTE (W7-B): usunięta z AI Tile (UI, koszt, wysyłka). Wspólny rdzeń nadal ją umie.
10. **Folder plików.** Tymczasowo: `ai-image-gen/tiles/<nazwa-sceny>/`.
11. **Obiekty na granicy obrysu** (W7-B). Mogą zostać zmienione częściowo, a kafelek tnie je na krawędzi prostokąta.
    Tymczasowo: opis w README („rysuj prostokąt wokół całych obiektów”), bez automatyki.
12. **Domyślne otoczenie.** Tymczasowo 2× (opcje 1,5× / 2× / 3× w oknie, zapamiętywane).
