# Zmiana nazwy ai-image-gen -> Moinens AI Gen (moinens-ai-gen): otwarte decyzje

Każdy wiersz: decyzja czeka na właściciela; do tego czasu działa zachowanie tymczasowe. (T0 ze spec `dev/ai-gen-spec.md`, sekcja 2.)

| # | Pytanie | Zachowanie tymczasowe |
|---|---------|------------------------|
| 1 | Zmiana nazwy folderu modułu na dysku | NIE zrobiona przez agenta (w folderze pracował wtedy inny agent nad spec; Foundry na 30000 działał). Manifest ma już id `moinens-ai-gen`, a Foundry odrzuca moduł, którego folder nie zgadza się z id („Invalid module "moinens-ai-gen" detected in directory "ai-image-gen"”, sprawdzone na lane 8). Do zmiany nazwy folderu moduł jest więc niewidoczny po każdym restarcie serwera. Kroki właściciela: niżej. |
| 2 | Adresy w manifeście (`url`, `manifest`, `download`, `bugs`, `readme`) | Bez zmian: wskazują `github.com/Hexnen/ai-image-gen`. Zmiana nazwy repo na GitHubie to decyzja właściciela (GitHub przekierowuje stare adresy). Brak nowego wydania i podbicia wersji. |
| 3 | Gdy oba moduły są włączone | Nowy moduł jest całkiem bezczynny: brak API, pollera, przycisków na kartach, menu kontekstowego, grupy narzędzi, profilu optymalizatora i KOPII ustawień; jedno trwałe ostrzeżenie dla GM-a. Kopia czeka do pierwszego startu bez starego modułu, bo wartości starego wciąż by się zmieniały (spec mówiło „ustawienia zostały skopiowane”; zmienione na „skopiuje przy pierwszym starcie bez niego”). Ustawienia nowego modułu są zarejestrowane (widać je w konfiguracji). |
| 4 | Kopia jest jednorazowa | Flagi `migratedFromAiImageGen` (klient) i `migratedFromAiImageGenWorld` (świat). Powrót do starego modułu na dłużej i potem znów do nowego NIE kopiuje drugi raz (nowsze wartości starego zostają w starym). Ponowna kopia ręcznie: `game.settings.set("moinens-ai-gen","migratedFromAiImageGenWorld",false)` (i klient analogicznie), przeładuj; skopiuje się tylko to, co w nowym nadal ma wartość domyślną. Uwaga: rekord batcha skopiowany jako „pending”, który stary moduł potem zebrał, nowy moduł zebrałby jeszcze raz. |
| 5 | Kto kopiuje | Tylko GM (klucze klienta też tylko w przeglądarce GM-a; gracze nie używają modułu). Kopiowane klucze klienta: `apiKey.openai/gemini/openrouter/anthropic`; świata: `enhance.model/effort`, `limit.*`, `optimizeImages`, `usage`, `imageTypes`, `schema`, `batches`, `batch.0..31`. Do tego surowe wpisy localStorage `dialogPrefs` i `test.<typ>` (tylko gdy w nowej przestrzeni ich nie ma). |
| 6 | Nazwy po stronie dostawców i plików | Logi konsoli `moinens-ai-gen |`, pliki/batche u OpenAI/Gemini `moinens-ai-gen-…`, eksport logu `moinens-ai-gen-log-…`, nagłówek OpenRouter `X-Title: Foundry Moinens AI Gen`. Folder danych (`DATA_ROOT`) i id profilu local-media-optimizer zostają `ai-image-gen`. |
| 7 | Prefiks i18n i hooki | Bez zmian: `AIIMG.*`, `aiImageGen.ready/batchUpdate/logUpdate` (spec 2.4). Nowy tekst: `AIIMG.Rename.BothActive`. |

## Co musi zrobić właściciel (kolejność)
1. Zamknij Foundry (port 30000) i upewnij się, że żaden agent nie pracuje w `Data/modules/ai-image-gen` ani nie trzyma lane 5/8/20.
2. Zmień nazwę folderu: `Data/modules/ai-image-gen` -> `Data/modules/moinens-ai-gen` (repo git jedzie razem z folderem, nic więcej nie trzeba).
3. Junction-y lane 5, 8, 20 (`%LOCALAPPDATA%\FoundryVTT-{5,8,20}\Data\modules\ai-image-gen` -> stary folder) przestaną działać: usuń je i utwórz `moinens-ai-gen` -> nowy folder (lanes 1-4 mają własne kopie starego modułu, bez zmian).
4. Uruchom Foundry, w świecie włącz „Moinens AI Gen” (stary „AI Image Gen” zniknie z listy jako brakujący; jeśli trzymasz jego kopię, wyłącz go).
5. Po pierwszym starcie każdy GM w swojej przeglądarce dostaje skopiowane klucze API (raz). Sprawdź w Ustawieniach modułu, że klucze są.
6. (Opcjonalnie) zmiana nazwy repo na GitHubie i adresów w `module.json`, push dopiero po Twoim „tak”.
