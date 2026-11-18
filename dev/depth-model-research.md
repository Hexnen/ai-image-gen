# Research: model głębi dla przycisku „Dodaj głębię”

Data: 2026-11-18. Zakres: wybór modelu monocular depth do portretów AI (komiks / ilustracja / malarstwo, jedna postać, popiersie lub pół postaci) dla shadera paralaksy w oknie Foundry. Ograniczenia właściciela: tylko lokalnie albo w przeglądarce, bez chmurowych API; licencje niekomercyjne dopuszczalne, ale zapisane.

Oznaczenia: **[Ź]** = twierdzenie ze źródła (link obok), **[W]** = mój wniosek / szacunek, niezweryfikowany pomiarem. Niczego nie pobierałem ani nie uruchamiałem na GPU. Jedyne lokalne sprawdzenie: odczyt plików istniejącego ComfyUI (bez uruchamiania).

---

## 1. Werdykt (TL;DR)

| Rola | Wybór | Dlaczego |
|---|---|---|
| **Główny w przeglądarce** | **Depth Anything V2 Large**, `onnx-community/depth-anything-v2-large`, Transformers.js 4.x, `device: 'webgpu'`, `dtype: 'fp16'` (669 MB) lub `'q4f16'` (235 MB) | Jedyny „duży” model głębi z oficjalnym wsparciem w Transformers.js (gotowy ONNX, pipeline `depth-estimation`), wyjście = względna odwrotna głębia (disparity), czyli dokładnie to, czego chce shader. Large ma najlepsze detale w rodzinie DA2. Licencja CC BY-NC 4.0 (OK dla prywatnego modułu). |
| Zapas w przeglądarce (słabsze GPU / brak WebGPU) | **Depth Anything V2 Small**, `onnx-community/depth-anything-v2-small`, `q4f16` 19 MB / `fp16` 50 MB | Apache-2.0, 25M parametrów, działa nawet na WASM. Krawędzie miększe. |
| Kandydat na upgrade w przeglądarce (eksperyment) | **Depth Anything 3 Mono-Large** jako ONNX: `Jens-Duttke/Depth-Anything-3-MONO-ONNX` (fp16 688 MB, q4f16 352 MB) przez onnxruntime-web WebGPU | Nowsza generacja, Apache-2.0, lepsze wyniki niż DA2 w benchmarkach. Ale eksport społecznościowy, testowany tylko na DirectML w Pythonie, nie w przeglądarce. Najpierw test. |
| **Główny lokalnie / ComfyUI** | **Depth Anything 3 Mono-Large**, natywne węzły ComfyUI (`LoadDA3Model` + `DA3Inference` + `DA3Render`), plik `depth_anything_3_mono_large.safetensors` z `Comfy-Org/Depth-Anything-3` | Już jest w lokalnym ComfyUI użytkownika (`C:\Users\santa\ComfyUI\comfy_extras\nodes_depth_anything_3.py`, commit z 2026-09-14). Apache-2.0, ~0.35B parametrów, rozdzielczość ustawiana do 2520 px. Uwaga na 8-bit przy zapisie (patrz §5). |
| Maska postaci (dla obu ścieżek) | **BiRefNet_lite** (`onnx-community/BiRefNet_lite`, MIT, fp16 115 MB) w przeglądarce; do testu **ToonOut** (BiRefNet dostrojony na anime, MIT) | Ostra sylwetka do „przyciągnięcia” krawędzi głębi. Bardziej warte dodania niż zmiana modelu głębi. |

Najkrócej: w przeglądarce DA2-Large + maska BiRefNet + post-processing z §7; w ComfyUI DA3 Mono-Large + ta sama maska. Modele dyfuzyjne o najostrzejszych krawędziach (Marigold V2, Lotus-2) nie mieszczą się sensownie w 8 GB VRAM / 16 GB RAM.

---

## 2. Co shader paralaksy naprawdę potrzebuje [W]

1. **Ostra i poprawnie położona sylwetka.** Halo (pas pośredniej głębi między postacią a tłem) daje rozciągnięte, „gumowe” piksele przy przesunięciu. To najważniejsze kryterium.
2. **Gładkie wnętrze.** Normalne liczone z głębi (do światła i rim light) wzmacniają szum. Ziarnisty model (np. Marigold v1) wygląda źle po oświetleniu, nawet przy dobrych krawędziach.
3. **Poprawny porządek głębi** (nos przed policzkami, włosy przed tłem, peleryna za ramieniem). Metryczna skala jest zbędna.
4. **Wyjście względne i odwrotne** (blisko = jasno), znormalizowane do 0..1. Model metryczny niczego tu nie dodaje (patrz §6).

Benchmarki (KITTI, NYU, ETH3D, Sintel) mierzą zdjęcia. **Żadne znalezione źródło nie testuje tych modeli na ilustracjach, anime ani portretach AI** (szukałem kilkukrotnie). Rankingi poniżej są więc ekstrapolacją z benchmarków i opisów autorów. Właściwy wybór i tak wymaga testu na 10–20 naszych portretach (§9).

---

## 3. Kandydaci: szczegóły

### 3.1 Depth Anything V2 (Small / Base / Large)
- Parametry: Small 24.8M, Base 97.5M, Large 335.3M [Ź] [README DA2](https://cdn.jsdelivr.net/gh/depthanything/depth-anything-v2@main/README.md).
- Licencje: Small = Apache-2.0 [Ź] [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small); Base = CC BY-NC 4.0 [Ź] [Depth-Anything-V2-Base-hf](https://huggingface.co/depth-anything/Depth-Anything-V2-Base-hf); Large = CC BY-NC 4.0 [Ź] [onnx-community/depth-anything-v2-large](https://huggingface.co/onnx-community/depth-anything-v2-large/blob/main/README.md).
- Gotowe ONNX dla Transformers.js (pipeline `depth-estimation`), pliki [Ź]:
  - Small ([tree](https://huggingface.co/onnx-community/depth-anything-v2-small/tree/main/onnx)): fp32 99.1 MB, fp16 49.6 MB, q4f16 19.1 MB, int8/q4 ~27 MB.
  - Base ([tree](https://huggingface.co/onnx-community/depth-anything-v2-base/tree/main/onnx)): fp32 389 MB, fp16 195 MB, q4f16 72.5 MB, int8 102 MB.
  - Large ([tree](https://huggingface.co/onnx-community/depth-anything-v2-large/tree/main/onnx)): fp32 1.34 GB, fp16 669 MB, q4f16 235 MB, q4 318 MB, int8 347 MB.
- Preprocessing: DPTImageProcessor, rozmiar 518, `keep_aspect_ratio: true`, wielokrotność 14, bicubic [Ź] [preprocessor_config.json](https://huggingface.co/onnx-community/depth-anything-v2-small/raw/main/preprocessor_config.json).
- Wyjście: względna głębia afinicznie niezmiennicza w przestrzeni odwrotnej (disparity, blisko = duże wartości). Model card mówi tylko „relative depth” [Ź]; to, że to disparity, wiem z artykułu DA i z tego, że wizualizacje są jasne z przodu [W, wysoka pewność].
- Krawędzie: DA2 „wygładza” granice, przewiduje pośrednie wartości na nieciągłościach (flying pixels) [Ź] [Pixel-Perfect Depth](https://arxiv.org/html/2510.07316v2); na włosach daje „broken depth” [Ź] [HairGuard, arXiv 2601.03362](https://arxiv.org/abs/2601.03362). LearnOpenCV / Roboflow: Depth Pro ma wyraźnie lepszy boundary-F1 niż DA2 na Sintel (0.409 vs 0.228) [Ź] [Roboflow](https://blog.roboflow.com/depth-estimation-models/), [LearnOpenCV](https://learnopencv.com/depth-pro-monocular-metric-depth/). Autorzy DA2 sami piszą, że Marigold lepiej modeluje detale, a DA2 jest stabilniejszy na złożonych scenach [Ź] [DA2 paper](https://arxiv.org/html/2406.09414v1).
- Dojrzałość: najszerzej używany model głębi w przeglądarce; oficjalne demo WebGPU [Ź] [Xenova/webgpu-realtime-depth-estimation](https://huggingface.co/spaces/Xenova/webgpu-realtime-depth-estimation/blob/main/index.html). Stary issue o błędzie „Unsupported” ([#857](https://github.com/huggingface/transformers.js/issues/857)) dotyczył starej wersji; nie potwierdziłem, czy wciąż występuje [Ź/W].

### 3.2 Depth Anything 3 (DA3) i Mono-Large
- Rodzina: Small 0.03B, Base 0.11B, Large ~0.36B, Giant 1.10B; plus osobne modele Monocular i Metric [Ź] [arXiv 2511.10647](https://arxiv.org/html/2511.10647v1).
- Licencje [Ź]: DA3-SMALL Apache-2.0 ([card](https://huggingface.co/depth-anything/DA3-SMALL)), DA3-BASE Apache-2.0 ([card](https://huggingface.co/depth-anything/DA3-BASE)), **DA3MONO-LARGE Apache-2.0** ([card](https://huggingface.co/depth-anything/DA3MONO-LARGE)), DA3-LARGE (1.0) CC BY-NC 4.0, DA3-LARGE-1.1 Apache-2.0, GIANT i NESTED-GIANT CC BY-NC 4.0 ([DA3-GIANT](https://huggingface.co/depth-anything/DA3-GIANT)).
- Jakość: model monokularny DA3 bije DA2 na wszystkich zbiorach w Tabeli 10 (np. ETH3D δ1 98.8 vs 86.5, Sintel 82.3 vs 77.2) [Ź] [paper](https://arxiv.org/html/2511.10647v1). Gradient loss „zachowuje ostre krawędzie przy gładkich płaszczyznach” [Ź], ale **brak ilościowej metryki krawędzi** i brak testów na obrazach stylizowanych [Ź].
- Wyjście: DA3 Mono przewiduje **głębię względną (nie disparity, jak DA2)** [Ź] [paper](https://arxiv.org/html/2511.10647v1), [ohaiibuzzle/DA3-ONNX](https://huggingface.co/ohaiibuzzle/DA3-ONNX) („larger = farther, take 1/depth”). Do shadera trzeba odwrócić. Mono-Large ma też wyjście nieba (dla portretów zbędne).
- Trening na bazie 504 px, z wariantami do 896×504 [Ź].
- **Przeglądarka**:
  - `onnx-community/depth-anything-v3-small`: istnieje, Apache-2.0, ale README puste, tylko fp32 (`model.onnx` 641 kB + `model.onnx_data` 105 MB), config `model_type: "depth_anything"` [Ź] ([tree](https://huggingface.co/onnx-community/depth-anything-v3-small/tree/main/onnx), [config](https://huggingface.co/onnx-community/depth-anything-v3-small/raw/main/config.json)). To DA3-**Small** (wariant multi-view), nie Mono. Nie znalazłem notatek wydania Transformers.js o wsparciu DA3 [Ź] ([releases](https://github.com/huggingface/transformers.js/releases)). Pipeline Transformers.js robi min-max, więc odwrócenie głębi trzeba zrobić samemu [W].
  - `en970/depth-anything-v3-small-onnx`: int8, 28.9 MB, ładowany przez `pipeline('depth-estimation', ...)`, 90–113 ms (nie podano sprzętu), Pearson r 0.990–0.998 względem fp32 [Ź] ([card](https://huggingface.co/en970/depth-anything-v3-small-onnx)). Społecznościowy, 122 pobrania/mies.
  - **`Jens-Duttke/Depth-Anything-3-MONO-ONNX`** (Mono-Large) [Ź] ([card](https://huggingface.co/Jens-Duttke/Depth-Anything-3-MONO-ONNX), [tree](https://huggingface.co/Jens-Duttke/Depth-Anything-3-MONO-ONNX/tree/main)): fp16 688 MB, q4f16 352 MB (blok 128, różnica <0.8% zakresu względem fp16), opset 21, wejście 1×3×S×S z S ∈ {1036, 728, 518, 364, 252}, inne rozmiary dają NaN; wyjście float16 disparity 0..5 (blisko = wyżej, autor odwrócił). Ostrzeżenie autora: nie przypinać wymiarów w ORT 1.24–1.27. Wymaga ORT ≥1.22 dla q4f16. Testowany tylko w Pythonie (DirectML, RX 7900 XTX: 6.9 fps przy 1036, 88.6 fps przy 252). Używa op `com.microsoft.Attention` [Ź]; **czy onnxruntime-web WebGPU obsługuje wszystkie użyte operatory, nie zweryfikowałem**. Uwaga: wejście kwadratowe, więc portret trzeba wpisać w kwadrat (padding) [W].
  - `ohaiibuzzle/DA3-ONNX`: Mono-Large i Small, statycznie 504×378, pod Androida/Snapdragon; fp32 1.34 GB, int8 431 MB, w8a16 340 MB [Ź] ([card](https://huggingface.co/ohaiibuzzle/DA3-ONNX)). Dynamiczne int8 bywało złe (Spearman 0.35 na niektórych zdjęciach) [Ź], więc unikać int8 dla Large.
- **ComfyUI**: natywne węzły DA3 [Ź] ([tutorial](https://docs.comfy.org/tutorials/utility/depth-anything-3), [DA3Render](https://docs.comfy.org/built-in-nodes/DA3Render.md)). Lokalnie potwierdzone: `C:\Users\santa\ComfyUI\comfy_extras\nodes_depth_anything_3.py`; `DA3Inference` ma `resolution` (domyślnie 504, 140..2520, krok 14) i `resize_method` (`upper_bound_resize` = dłuższy bok, `lower_bound_resize` = krótszy bok, więcej detalu); głębia jest interpolowana z powrotem do rozdzielczości oryginału (`torch.nn.functional.interpolate`) [Ź, odczyt pliku]. `DA3Render` normalizuje: `v2_style` (mean/std, domyślne), `min_max`, `raw` [Ź]. Pliki modeli: folder `models/geometry_estimation/`. W lokalnej instalacji nie znalazłem katalogu `models/` w `C:\Users\santa\ComfyUI` (ścieżki modeli są pewnie gdzie indziej, np. extra_model_paths); nie sprawdzałem, czy plik Mono-Large jest już pobrany.

### 3.3 Depth Pro (Apple)
- ~1.0B parametrów, wejście stałe 1536×1536, głębia **metryczna** + ogniskowa; „2.25 MP w 0.3 s na standardowym GPU” [Ź] ([apple/DepthPro-hf](https://huggingface.co/apple/DepthPro-hf)). Najlepszy znany boundary-F1 wśród klasyków (Sintel 0.409) [Ź] ([Roboflow](https://blog.roboflow.com/depth-estimation-models/)).
- Licencja: Apple, na karcie HF tagi „apple-amlr” i „Apple-ASCL” niespójne; repo mówi, że kod i wagi są na warunkach pliku LICENSE [Ź] ([ml-depth-pro](https://github.com/apple/ml-depth-pro)). Pełnej treści nie przeczytałem; „AMLR” to zwykle licencja badawcza [W]. Dla prywatnego modułu raczej OK, ale niezweryfikowane.
- Przeglądarka: `onnx-community/DepthPro-ONNX`, pliki [Ź] ([tree](https://huggingface.co/onnx-community/DepthPro-ONNX/tree/main/onnx)): fp32 3.8 GB, fp16 1.9 GB, q4f16 600 MB, q4 746 MB, int8 1.01 GB. Ładowanie przez `AutoModelForDepthEstimation` [Ź].
- Ocena [W]: 600 MB–1.9 GB do pobrania i ViT-L na wielu łatkach przy 1536² to w WebGPU prawdopodobnie kilka sekund i kilka GB VRAM; wyjście metryczne trzeba i tak odwrócić i znormalizować. Dobra jakość krawędzi na zdjęciach, ale ryzyko, że na płaskich ilustracjach skala metryczna „zgaduje” dziwnie. Wart testu porównawczego w Pythonie / ComfyUI, nie jako domyślny w przeglądarce.

### 3.4 Marigold (v1-0, LCM, v1-1, **V2**)
- v1-1: SD2-based, licencja tag `openrail++` [Ź] ([prs-eth/marigold-depth-v1-1](https://huggingface.co/prs-eth/marigold-depth-v1-1)); LCM v1-0 przestarzały (Apache-2.0) [Ź] ([card](https://huggingface.co/prs-eth/marigold-depth-lcm-v1-0)). Węzeł ComfyUI kijai `ComfyUI-Marigold` (strony z węzłem wymieniają tylko starsze modele) [Ź] ([opis](https://www.runcomfy.com/comfyui-nodes/ComfyUI-Marigold/MarigoldModelLoader)). Detal lepszy niż DA2, ale „noisy and grainy” według nieformalnych opisów [Ź, słabe źródło] ([Roboflow](https://blog.roboflow.com/depth-estimation-models/)); boundary-F1 Sintel 0.068 [Ź]. Ziarno szkodzi normalnym [W].
- **Marigold V2** (arXiv 2609.08084, wrzesień 2026): na bazie Qwen-Image-Edit-2509, wagi LoRA+VAE Apache-2.0, baza na własnej licencji [Ź] ([huawei-bayerlab/marigold-v2-0](https://huggingface.co/huawei-bayerlab/marigold-v2-0)). Najlepsze krawędzie w papierze (SEE na HyperSim: 0.352 vs PPD 0.404 vs InfiniDepth 0.470), „hair-thin edges” [Ź] ([paper](https://arxiv.org/html/2609.08084v1)). Wyjście afinicznie niezmiennicze (warianty log / disparity / uniform) [Ź]. **Pamięć: ~1.9 s i 16.9 GB przy 1024², 9.6 s i 29.3 GB przy 2048²** [Ź]. Natywnie w ComfyUI (baza `qwen_image_edit_2509_int8_convrot.safetensors` + LoRA/VAE/embeddings) [Ź] ([tutorial](https://docs.comfy.org/tutorials/utility/marigold-v2.md)), bez podanych wymagań VRAM. Wniosek [W]: baza Qwen-Image-Edit ma ~20B parametrów, int8 to ~20 GB, czyli więcej niż 16 GB RAM tej maszyny; na 8 GB VRAM praktycznie nierealne bez GGUF/agresywnego offloadu (którego nie znalazłem). **Odpada na tym sprzęcie**, ale to najlepszy kandydat, gdyby kiedyś był mocniejszy komputer.

### 3.5 Lotus i Lotus-2
- Lotus (SD2-based): `jingheya/lotus-depth-g-v2-1-disparity` (i v2-0), Apache-2.0, wyjście w disparity [Ź] ([card](https://huggingface.co/jingheya/lotus-depth-g-v2-1-disparity/blame/main/README.md), [v2-0](https://huggingface.co/jingheya/lotus-depth-g-v2-0-disparity/raw/main/README.md)). Paczka ComfyUI fp16 ~1.74 GB od 1038lab [Ź] ([1038lab/Lotus](https://huggingface.co/1038lab/Lotus)). Lokalnie wykonalne na 8 GB [W]. Brak ONNX do przeglądarki [W, nie znalazłem].
- Lotus-2 (arXiv 2512.01030, listopad 2025): na FLUX.1-dev, rdzeń + „sharpener” po ~1.43 GB jako LoRA do FLUX [Ź] ([1038lab/Lotus-2](https://huggingface.co/1038lab/Lotus-2), [arXiv](https://arxiv.org/abs/2512.01030)). Wzmianka o dobrych detalach na obrazach olejnych [Ź, źródło wtórne]. VRAM: 8–16 GB tylko z GGUF Q4/Q5, inaczej ~27–35 GB [Ź, źródła wtórne, rozbieżne]. Licencja Lotus-2 nieustalona; FLUX.1-dev to licencja niekomercyjna [Ź/W]. Ciężkie, wolne na 3070 Ti; nie jako domyślne.

### 3.6 MoGe / MoGe-2 (Microsoft)
- Mapa punktów 3D z metryczną skalą + (w wariantach `-normal`) normalne; afinicznie niezmiennicza geometria jako baza [Ź] ([arXiv 2507.02546](https://arxiv.org/html/2507.02546v1)). Kod MIT (DINOv2 Apache-2.0) [Ź]. Checkpointy `Ruicheng/moge-2-vitl`, `-vitl-normal`, `-vitb-normal`, `-vits-normal` [Ź]. Społecznościowe ONNX (Heliosoph, ViT-S/ViT-B normal), licencja MIT tylko „zakładana” przez mirror [Ź]; strona Heliosoph zwróciła 401, rozmiarów nie sprawdziłem.
- Ocena [W]: ciekawe, bo daje **gotowe normalne** (lepsze niż liczone z głębi do światła w shaderze), ale brak wsparcia w Transformers.js, licencja wag niepotwierdzona, a cel modelu (geometria sceny) jest dalej od „ładnego portretu” niż DA. Możliwy etap 2: normal map z MoGe-2 ViT-S jako opcja.

### 3.7 Nowsze / 2026
- **Pixel-Perfect Depth (PPD)**, NeurIPS 2025: dyfuzja w przestrzeni pikseli (bez VAE, więc bez flying pixels), 500M + semantyka z DA2-L lub MoGe-2; kod Apache-2.0; wagi `gangweix/Pixel-Perfect-Depth` [Ź] ([GitHub](https://github.com/gangweix/pixel-perfect-depth)). Brak węzła ComfyUI, brak danych o VRAM/czasie [Ź]. Wymaga też DA2-Large (CC BY-NC) [Ź]. Ocena [W]: obiecujące dla krawędzi, ale tylko jako skrypt Pythona, kilkuetapowa dyfuzja, raczej sekundy na obraz.
- **InfiniDepth** (CVPR 2026): wagi na HF od użytkownika `ritianyu`, tag Apache-2.0, status oficjalnego wydania niejasny [Ź] ([HF](https://huggingface.co/ritianyu/InfiniDepth)). W papierze Marigold V2 gorszy od PPD na krawędziach [Ź].
- **PXDepth** (arXiv 2608.16984, sierpień 2026): ViT + predyktor w przestrzeni pikseli, wieloskalowy loss gradientów [Ź] ([alphaxiv](https://www.alphaxiv.org/abs/2608.16984)); kod „publicznie dostępny” tylko według jednego źródła wtórnego, nie znalazłem repo ani licencji.
- **Distill Any Depth** (2025): ONNX społecznościowe (fp16 dla WebGPU, q4f16), licencja MIT według mirrorów [Ź] ([Ko033](https://huggingface.co/Ko033/distill-any-depth-base-onnx)); nic o krawędziach. Alternatywa dla DA2 z permisywną licencją, niesprawdzona.
- **See-through** (SIGGRAPH/TOG 2026): rozkład postaci anime na warstwy z pseudo-głębią na bazie Marigold, wtyczka ComfyUI istnieje [Ź] ([arXiv 2602.03749](https://www.alphaxiv.org/abs/2602.03749), [ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through)). Ciekawe na przyszłość (warstwy zamiast jednej mapy), nie na teraz.
- **HairGuard** (arXiv 2601.03362): plug-in „depth fixer” na miękkie granice (włosy) trenowany na danych matting; nie znalazłem kodu ani wag [Ź].

---

## 4. Ranking dla nas

Kryteria w kolejności zadania: (1) krawędzie, (2) przeglądarka, (3) ComfyUI/Python, (4) forma wyjścia, (5) licencja, (6) dojrzałość.

| # | Model | Krawędzie [W chyba że Ź] | Przeglądarka | Lokalnie | Licencja | Werdykt |
|---|---|---|---|---|---|---|
| 1 | DA2-Large (+maska) | średnie, halo na włosach (Ź); z maską dobre | **tak, oficjalnie**, 235–669 MB | tak | CC BY-NC 4.0 | **Główny w przeglądarce** |
| 2 | DA3 Mono-Large | lepsze od DA2 wg benchmarków (Ź), brak metryki krawędzi | eksport społecznościowy, niezweryfikowany w ORT-web | **natywnie w lokalnym ComfyUI** | Apache-2.0 | **Główny w ComfyUI**, upgrade w przeglądarce po teście |
| 3 | Depth Pro | najlepsze z dyskryminacyjnych na zdjęciach (Ź) | 600 MB+, ciężki | tak (Python) | Apple, do potwierdzenia | test porównawczy |
| 4 | DA2-Small / DA3-Small | najmiększe | tak, 19–105 MB | tak | Apache-2.0 | zapas na słabe GPU |
| 5 | Lotus v2-1 disparity | dobre detale, ryzyko porządku głębi (Ź wtórne) | nie | tak (~1.7 GB) | Apache-2.0 | opcja ComfyUI do testu |
| 6 | PPD | bardzo dobre (Ź) | nie | skrypt Python, ciężki | Apache-2.0 + DA2-L NC | eksperyment |
| 7 | Marigold v1-1 | detal, ale ziarno (Ź wtórne) | nie | tak | openrail++ | nie (ziarno psuje normalne) |
| 8 | Marigold V2 / Lotus-2 | najlepsze (Ź) | nie | **nie mieści się** w 8 GB / 16 GB RAM | Apache (+baza) / FLUX NC | nie na tym sprzęcie |
| 9 | MoGe-2 | dobre (Ź), plus normalne | tylko ONNX społ. | tak | MIT kod, wagi niepewne | etap 2 dla normalnych |

---

## 5. Szczegóły wdrożenia

### 5.1 Przeglądarka (główny tor)
- Biblioteka: **`@huggingface/transformers` 4.3.2** (wydane 28 X, najnowsze na dziś) [Ź] ([releases](https://github.com/huggingface/transformers.js/releases)). 4.0.0 przyniosło przepisany runtime WebGPU [Ź]. Najlepiej zvendorować plik ESM do modułu (moduł nie ma dziś żadnych zależności ML; sprawdzone grepem) albo ładować z jsDelivr z przypiętą wersją [W].
- Kod (wzór z karty modelu + opcje urządzenia [Ź] [model card](https://huggingface.co/onnx-community/depth-anything-v2-small), [dev.to](https://dev.to/martindelophy/building-cinematic-depth-in-the-browser-with-depth-anything-v2-small-and-webgpu-1k07)):
  ```js
  import { pipeline } from '.../transformers.min.js';
  const est = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-large',
    { device: 'webgpu', dtype: 'fp16' });          // fallback: dtype 'q4f16'; bez WebGPU -> Small na 'wasm'
  const { predicted_depth } = await est(imageUrl);   // float32, już w rozdzielczości oryginału
  ```
- Pipeline zwraca `predicted_depth` (float, przeskalowany **bilinearnie** do rozmiaru wejścia) i `depth` (uint8 po min-max) [Ź] ([kod pipeline 4.2.0](https://app.unpkg.com/@huggingface/transformers@4.2.0/files/src/pipelines/depth-estimation.js)). Używać `predicted_depth`, nie `depth` (8 bit, min-max bez obsługi zakresu zerowego) [W].
- Rozdzielczość: model liczy przy krótszym boku 518 [Ź]. Dla portretu 1024×1536 to ~518×777 wewnętrznie. Można spróbować podnieść `size` procesora (np. 770, wielokrotność 14) dla detalu; DA2 bywa niestabilny powyżej rozdzielczości treningu [W, niezweryfikowane]. Bezpieczniej: 518 + upsampling sterowany obrazem (§7).
- Wybór dtype [W]: 3070 Ti obsługuje `shader-f16`, więc `fp16` (669 MB) jest najpewniejszy jakościowo. `q4f16` (235 MB) 3× mniej do pobrania; kwantyzacja 4-bit może dodać szum w gładkich regionach, który wyjdzie w normalnych. Zrobić A/B.
- Czas [W, szacunek, nie mierzone]: pierwsze uruchomienie = pobranie (raz, potem cache przeglądarki) + kompilacja shaderów, kilka do kilkunastu sekund. Sama inferencja Large przy 518 na 3070 Ti WebGPU: rząd 0.1–0.5 s. Small: dziesiątki ms (źródło wtórne podaje ~65 ms Transformers.js WebGPU na M2 [Ź] [essamamdani](https://essamamdani.com/blog/litert-js-google-webgpu-browser-ai-july-2026)). Skromne GPU (np. zintegrowane): Large kilka sekund albo brak pamięci, więc auto-fallback na Small. Bez WebGPU (WASM, CPU): Large dziesiątki sekund, Small kilka sekund [W].
- Foundry [W]: WebGPU wymaga secure context; `localhost` i HTTPS za Cloudflare spełniają. Aplikacja Electron Foundry: WebGPU powinno działać w nowym Chromium, ale trzeba sprawdzić `navigator.gpu` w runtime i mieć fallback. Inferencję robi tylko klient MG; gracze dostają gotowy plik.
- Hosting wag [W]: domyślnie Transformers.js pobiera z huggingface.co przy pierwszym użyciu i trzyma w Cache Storage. To lokalna inferencja, nie generatywne API, więc mieści się w ograniczeniu właściciela; alternatywnie wagi w folderze Data i `env.localModelPath` + `env.allowRemoteModels = false`.

### 5.2 DA3 Mono-Large w przeglądarce (eksperyment)
- `onnxruntime-web` (stabilne 1.30.0 według newreleases [Ź] [newreleases.io](https://newreleases.io/project/npm/onnxruntime-web/release/1.30.0)), `executionProviders: ['webgpu']`, plik q4f16 352 MB lub fp16 688 MB [Ź].
- Wejście kwadratowe S=518 lub 728 (padding portretu do kwadratu, ImageNet mean/std), wyjście fp16 disparity [Ź]. Ryzyka [W]: op `com.microsoft.Attention` / `MatMulNBits` w WebGPU EP, zgodność z wersją ORT (autor ostrzega przed 1.24–1.27), 700 MB pobrania. Zrobić jako przełącznik „eksperymentalny” dopiero po udanym teście.

### 5.3 ComfyUI / Python (główny tor lokalny)
- Workflow: `LoadImage` → `LoadDA3Model` (Mono-Large) → `DA3Inference` (`resolution` 1036–1260, `resize_method: lower_bound_resize` dla detalu) → `DA3Render` (`depth`, `normalization: min_max`) [Ź].
- **Pułapka 16 bit** [W]: `DA3Render` zwraca IMAGE (float), ale standardowy `SaveImage` zapisuje PNG 8-bit. Dla 16 bit: węzeł zapisujący 16-bit PNG/EXR z custom nodes albo mały skrypt Pythona z pakietem `depth_anything_3` (`DepthAnything3.from_pretrained("depth-anything/da3mono-large")`, eksport `npz` [Ź] [card](https://huggingface.co/depth-anything/DA3MONO-LARGE)) i `cv2.imwrite` uint16.
- VRAM / czas [W]: ~0.35B parametrów, wagi ~0.7 GB w fp16 / ~1.4 GB fp32; przy 1036 px zmieści się w 8 GB z dużym zapasem; czas rzędu 0.2–1 s na obraz po załadowaniu (ComfyUI ładuje model raz). Wyjście DA3 to głębia, nie disparity: przy `min_max` jasne = daleko, trzeba odwrócić (1/d albo 1−x) przed shaderem; zweryfikować na jednym obrazie [W].
- Integracja z Foundry [W]: moduł może wysłać workflow do lokalnego API ComfyUI (`http://127.0.0.1:8188/prompt`) z klienta MG, jeśli ComfyUI działa; uwaga na CORS (ComfyUI ma flagę `--enable-cors-header`). To osobna decyzja projektowa.

---

## 6. Względna czy metryczna głębia
- Shader potrzebuje **względnej odwrotnej głębi** (disparity) znormalizowanej do 0..1: przesunięcie paralaksy jest proporcjonalne do disparity, nie do głębi [W, geometria].
- DA2 daje afinicznie niezmienniczą disparity (gotowe po normalizacji). DA3 Mono daje względną głębię (odwrócić) [Ź]. Marigold V2 / Lotus: afinicznie niezmiennicza, zależnie od wariantu log/disparity [Ź]. Depth Pro / DA3-Metric / MoGe-2: metryczne [Ź]; dla ilustracji skala metryczna jest fikcją, a odwracanie metrycznej głębi wzmacnia błędy daleko od kamery [W]. Brak korzyści, większy koszt: **metryczne odpada**.
- Ponieważ wyjścia są afiniczne (nieznane przesunięcie), a/b po normalizacji ustawiamy sami: tło = 0, najbliższy punkt = 1, plus regulowana „siła głębi” w shaderze [W].

---

## 7. Krawędzie: czy dodawać rafinację? Tak, i to tanio

Wniosek [W]: dla portretu z jedną postacią **maska postaci daje więcej niż zmiana modelu głębi**. Halo DA2 siedzi dokładnie na sylwetce, a sylwetkę segmentacja wyznacza ostro, także na pasmach włosów.

### 7.1 Model maski
- **BiRefNet_lite**, `onnx-community/BiRefNet_lite`, MIT [Ź] ([card](https://huggingface.co/onnx-community/BiRefNet_lite)); ONNX w repo `onnx-community/BiRefNet_lite-ONNX`: fp32 224 MB, fp16 115 MB [Ź] ([tree](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/tree/main/onnx)). Transformers.js `AutoModel` / pipeline `background-removal` [Ź]. Na karcie jest zgłoszenie błędu w Chrome bez widocznego rozwiązania [Ź] ([dyskusja](https://huggingface.co/onnx-community/BiRefNet_lite/discussions/1)), więc testować. Rozdzielczość robocza BiRefNet to zwykle 1024² [W/Ź dla RMBG-2.0].
- **ToonOut**: BiRefNet dostrojony na postaciach anime, pixel accuracy 95.3% → 99.5% na ich zbiorze testowym, wagi MIT (kod + wagi), zbiór CC-BY 4.0 [Ź] ([arXiv 2509.06839](https://arxiv.org/html/2509.06839v1), [joelseytre/toonout](https://huggingface.co/joelseytre/toonout)); społecznościowy ONNX `sprited/birefnet-toonout-onnx` [Ź] (rozmiaru i zgodności z Transformers.js nie sprawdziłem). Najbliższy naszej domenie (stylizowane postacie, włosy). Ma pełny BiRefNet (nie lite), czyli cięższy [W].
- RMBG-2.0 (BRIA): BiRefNet + własne dane, CC BY-NC 4.0, komercyjnie tylko z umową [Ź] ([card](https://huggingface.co/briaai/RMBG-2.0)); repo prawdopodobnie bramkowane (akceptacja warunków) [W, niesprawdzone], więc gorszy wybór dla runtime w przeglądarce.
- Lokalnie: w ComfyUI użytkownika jest już `custom_nodes/comfyui-rmbg` [Ź, odczyt katalogu]; nie sprawdzałem, które modele obsługuje.

### 7.2 Przepis post-processingu (shader-ready) [W, poza wskazanymi Ź]
Wejście: `D` = disparity float (blisko = duże) w rozdzielczości obrazu; `A` = alfa maski postaci 0..1; `I` = obraz RGB.
1. **Normalizacja odporna**: wytnij percentyle 1% i 99% `D` (tylko z pikseli `A>0.5` dla górnej granicy, z `A<0.5` dla dolnej), przeskaluj do 0..1. Odporne na pojedyncze skrajne piksele.
2. **Usuń flying pixels**: piksele z dużym gradientem `D` (Sobel powyżej progu) zastąp wartością najbliższego „stabilnego” sąsiada (metoda z [Learning Stereo from Single Images](https://arxiv.org/pdf/2008.01484) [Ź], tam użyta do danych treningowych).
3. **Joint bilateral / guided upsampling** sterowany `I` (lub lepiej `A`), jeśli model liczył w niższej rozdzielczości: krawędzie głębi idą za krawędziami obrazu. W przeglądarce: prosty guided filter (He et al.) w WebGL/JS, promień 4–8 px, eps ~1e-3 [W].
4. **Snap do maski**:
   - Wewnątrz postaci (`A≈1`): zostaw `D`.
   - Tło (`A≈0`): zastąp płaszczyzną/łagodnym gradientem, np. `D_bg = min(percentyl10(D|tło), percentyl5(D|postać)) − margines`, wygładzone mocno (blur 30–60 px). Daje to czystą separację postać/tło, czego ilustracje i tak oczekują.
   - Pas krawędzi: `D' = A·D_fg_dilated + (1−A)·D_bg`, gdzie `D_fg_dilated` to **dylatacja (max filter) disparity postaci o 2–4 px na zewnątrz**, aby kolorowe piksele obrysu (antyaliasing, linia konturu komiksu) poruszały się z postacią, a nie rozciągały z tłem. Miękka alfa włosów daje naturalne przejście.
5. **Wygładzenie wnętrza**: edge-preserving blur (bilateral lub guided) promień 2–4 px, żeby normalne z głębi nie łapały szumu/kwantyzacji. Krawędź maski zostawić ostrą.
6. **Gamma / krzywa**: `D'' = D'^γ`, γ ≈ 0.7–0.9 dla portretów (więcej rozdzielczości w twarzy, mniej w tle); suwak w oknie, nie zapiekać na stałe, jeśli shader może to robić [W].
7. **Zapis**: 16 bit, bezstratnie. Canvas w przeglądarce nie zapisze 16-bit PNG [W]; opcje: (a) mała biblioteka PNG (np. UPNG.js / fast-png) do PNG 16-bit grayscale, (b) **upakowanie 16 bit w kanały R (wysokie) i G (niskie) 8-bitowego PNG**, dekodowane w shaderze `d = (r*255*256 + g*255)/65535`. Nigdy WebP/JPEG stratny (artefakty bloków stają się schodami w paralaksie). Maskę `A` zapisać do kanału B lub osobnego pliku: przyda się w shaderze do rim light i do ukrycia dziur przy disokluzji.
8. **Normalne w shaderze**: z rozmytej kopii głębi (Sobel na teksturze), skala zależna od siły głębi; rim light z `A` i z kąta normalnej [W].

---

## 8. Czego nie udało się zweryfikować
- Jakość któregokolwiek modelu na **ilustracjach / anime / portretach AI**: brak źródeł porównawczych. Ranking krawędzi to ekstrapolacja ze zdjęć.
- **Czasy w przeglądarce na RTX 3070 Ti**: brak pomiarów w źródłach; wszystkie liczby czasu w §5 to szacunki [W].
- Czy `onnxruntime-web` WebGPU uruchomi `Jens-Duttke/Depth-Anything-3-MONO-ONNX` (operatory, wersja ORT).
- Czy Transformers.js 4.3.x oficjalnie wspiera DA3 (`onnx-community/depth-anything-v3-small` ma puste README; brak wzmianki w notach wydań).
- Pełna treść licencji Depth Pro (tagi niespójne na HF), licencja wag MoGe-2, Lotus-2, PXDepth, InfiniDepth (oficjalność).
- Rzeczywisty VRAM Marigold V2 z bazą int8 w ComfyUI na 8 GB (tylko liczby z papieru: 16.9 GB przy 1024²).
- Rozmiar i zgodność z Transformers.js ONNX ToonOut (`sprited/birefnet-toonout-onnx`); błąd BiRefNet_lite w Chrome z dyskusji HF.
- Czy WebGPU jest włączone w wersji Electron używanej przez aplikację Foundry v14.
- Gdzie lokalny ComfyUI trzyma modele i czy plik DA3 Mono-Large jest już pobrany.

---

## 9. Proponowany test przed decyzją (bez kodu modułu) [W]
1. Zestaw 15 portretów z modułu (z włosami, okularami, peleryną, tłem jednolitym i złożonym).
2. Przeglądarka: DA2-Small q4f16, DA2-Large fp16 i q4f16; opcjonalnie DA3-Mono q4f16 przez ORT-web. Zmierzyć czas (pierwszy i kolejny), VRAM, obejrzeć mapy i **render paralaksy w ruchu** (nie same mapy).
3. ComfyUI: DA3 Mono-Large przy 504 / 1036 / 1260; opcjonalnie Lotus v2-1 disparity i Depth Pro w Pythonie dla porównania krawędzi.
4. Każdy wariant z i bez maski BiRefNet_lite / ToonOut + przepis z §7. Spodziewam się, że maska zmniejszy różnice między modelami bardziej niż zmiana modelu.
