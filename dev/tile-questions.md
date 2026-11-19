# AI Tile: pytania do właściciela (z zachowaniem tymczasowym)

Każde pytanie ma zachowanie, które działa do czasu decyzji. Nic tu nie blokuje użycia.

1. **Gdzie przycisk?** Tymczasowo: kategoria „Moinens AI Gen” w lewym pasku (obok Ustawień / Batchy / Logu), przycisk
   „AI Tile”. Alternatywa: także w pasku narzędzi Kafelków (Tiles).
2. **Tokeny w wycinku wysyłanym do modelu?** Tymczasowo: NIE (ukryte na czas renderu, przełącznik w oknie). Oświetlenie
   i mgła wojny nigdy nie trafiają do wycinka.
3. **Elewacja kafelka.** Tymczasowo: elewacja 0 (poziom tła), `sort` nad wszystkimi kafelkami tej elewacji, czyli pod
   tokenami i pod „overhead”. Alternatywa: elewacja jak najwyższy kafelek pod kształtem.
4. **Miękka krawędź.** Tymczasowo: 8 px sceny (rozmycie maski), ustawiane w oknie (0 = ostra krawędź).
5. **Margines kontekstu.** Tymczasowo: 25 % dłuższego boku kształtu (min. 1/2 pola siatki) z każdej strony; potem
   powiększenie do proporcji, które model zwróci.
6. **Rozdzielczość pliku kafelka.** Tymczasowo: skala wyniku modelu (zwykle więcej px niż scena dla małych kształtów),
   ograniczona wyjściem typu (maxEdge 4096, WebP z alfą).
7. **Batch z wieloma wariantami.** Tymczasowo: wyniki trafiają do `_candidates/<batch>/` już przycięte; okno wyboru
   otwiera podgląd na mapie dopiero, gdy MG ma tę scenę na płótnie (inaczej prosi o jej otwarcie).
8. **Maska OpenAI.** Tymczasowo: wysyłana w trybie Teraz (wyłączana w oknie), w Batchu nie (pole maski w JSON
   batcha niezweryfikowane); zamiast niej obraz przewodnika.
9. **Folder plików.** Tymczasowo: `ai-image-gen/tiles/<nazwa-sceny>/`.
