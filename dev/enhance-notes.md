# Różdżka „ulepsz opis” (Claude): otwarte decyzje

Każdy wiersz: decyzja czeka na użytkownika; do tego czasu działa zachowanie tymczasowe.

| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| 1 | Czy wywołania Claude mają trafiać do logu wywołań i liczyć się w limitach USD (dzienny/miesięczny)? | Nie: ulepszanie nie jest logowane ani wliczane w limity obrazów; koszt to pojedyncze centy (Sonnet 5.5: 2/10 USD za 1M tokenów). |
| 2 | Model i effort: ustawienie świata (wspólne dla GM-ów) czy klienta (per przeglądarka, jak klucz)? | Świata, restricted (GM ustawia raz); klucz Anthropic pozostaje ustawieniem klienta jak pozostałe klucze. |
| 3 | Pole modelu: wolny tekst czy lista wyboru? | Wolny tekst (puste = claude-sonnet-5-5), żeby nowy model nie wymagał aktualizacji modułu; zły identyfikator daje czytelny błąd 404 z linkiem do ustawień. |
| 4 | Czy różdżka ma być też przy szablonie promptu w konfiguracji typu (`promptTemplate`)? | Nie: to szablon z `{description}`, nie opis; przepisanie go przez model psułoby placeholdery. Różdżka jest przy opisie w oknie „Generuj obraz” i przy przykładowym opisie w szufladzie testu. |
| 5 | Czy model ma dostawać nazwę i typ dokumentu jako kontekst? | Tak (w tagu `<context>`), z instrukcją, żeby nie wpisywał nazwy do opisu, tylko użył jej do zrozumienia tematu. |
| 6 | Długość wyniku i styl | Jeden akapit ok. 50–120 słów, bez stylu/medium/aparatu (styl dodaje szablon promptu typu), w języku wejścia. |
| 7 | Fallback po odmowie (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) | Włączony dla modeli, które go przyjmują (sonnet-5-5, opus-5-5, opus-5, fable-5-1/5-2); inne modele wysyłane bez niego. |
| 8 | Skrót klawiszowy | Ctrl/Cmd+Enter w polu opisu = ulepsz (podany w podpowiedzi przycisku). |
