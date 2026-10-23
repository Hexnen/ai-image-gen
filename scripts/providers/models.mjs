// Katalog modeli: możliwości (rozmiary, jakości, thinking) i ceny. Jedno źródło prawdy dla
// providerów, batcha i UI. Dane z oficjalnych stron OpenAI/Google (research 2026-10).
// Wszystko, co nie było sprawdzone z prawdziwym kluczem, jest oznaczone `unverified`.

export const OPENAI_QUALITIES_OLD = ["low", "medium", "high", "auto"];
export const OPENAI_QUALITIES_25 = ["low", "medium", "high", "xhigh", "max", "auto"];

// Ceny za 1M tokenów (USD). Wspólne dla gpt-image-2 i 2.5.
export const OPENAI_RATES = {
  sync: { textIn: 5, imageIn: 8, imageOut: 30 },
  batch: { textIn: 2.5, imageIn: 4, imageOut: 15 },
};

// Cena SYNC za obraz (USD) gpt-image-2 i starszych — dolna granica szacunku i fallback, gdy odpowiedź nie ma `usage`.
// Wpisy low/medium/high x 3 rozmiary z roleplay; reszta jest skalowana polem od 1024x1024.
export const OPENAI_PRICES = {
  low: { "1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005 },
  medium: { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 },
  high: { "1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165 },
};
const OPENAI_SQUARE_PRICE = { low: 0.006, medium: 0.053, high: 0.211, auto: 0.211 };

// gpt-image-2.5 (sunburst i flare mają TEN SAM koszt tokenowy przy tej samej jakości i rozmiarze).
// Tokeny wyjścia na obraz: NIEZALEŻNE POMIARY osób trzecich (nie dane OpenAI; OpenAI podaje tylko stawki za 1M tokenów
// i kalkulator, którego nie da się odczytać): tosea.ai (2048x1152, 41 wywołań), OneWave (1024x1024 high $0,0532),
// kirahina note.com (1536x1024 high 1372 tok.). Liczba tokenów NIE rośnie liniowo z pikselami (kwadrat 1024² jest droższy
// niż 2048x1152), więc nie skalujemy po polu: do ~2,4 Mpx bierzemy ostrożną górną granicę (wiersz 1024²), powyżej
// rośnie liniowo do ~1,9× przy 3840x2160 (zmierzone: high 3336 vs 1772, max 13342 vs 7024).
// Uczący się szacunek (cost-learning.mjs) ma pierwszeństwo po 3 próbkach z logu.
export const OPENAI_25_TOKENS = {
  low: 196, medium: 439, high: 1772, xhigh: 3122, max: 7024, auto: 1772, // 1024x1024, górna granica
};
const PX_FLAT = 2_400_000, PX_4K = 3840 * 2160, GROWTH_4K = 1.9;

/** Czy model OpenAI jest z rodziny 2.5 (tokenowy cennik z pomiarów powyżej). */
export const isOpenAI25 = (model) => getModel("openai", model)?.family === "gpt-image-2.5";

/** Ostrożna liczba tokenów wyjścia obrazu dla gpt-image-2.5. */
export function openai25OutputTokens(quality, width, height) {
  const base = OPENAI_25_TOKENS[quality] ?? OPENAI_25_TOKENS.medium;
  const px = (Number(width) || 1024) * (Number(height) || 1024);
  if (px <= PX_FLAT) return base;
  const k = Math.min(1, (px - PX_FLAT) / (PX_4K - PX_FLAT));
  return Math.round(base * (1 + (GROWTH_4K - 1) * k));
}

export function openaiPriceFloor(quality, width, height, model) {
  if (model && isOpenAI25(model)) return openai25OutputTokens(quality, width, height) * OPENAI_RATES.sync.imageOut / 1e6;
  const exact = OPENAI_PRICES[quality]?.[`${width}x${height}`];
  if (exact != null) return exact;
  const base = OPENAI_SQUARE_PRICE[quality] ?? OPENAI_SQUARE_PRICE.medium;
  return base * ((Number(width) || 1024) * (Number(height) || 1024)) / (1024 * 1024);
}

/** Konserwatywny szacunek za obraz przez OpenRouter (brak cennika w kodzie): gpt-image/pro drogie, reszta tania. */
export function openrouterEstimate(modelId = "") {
  const m = String(modelId).toLowerCase();
  return m.startsWith("openai/") || m.includes("pro") ? 0.25 : 0.08;
}

const PRESETS_3 = ["1024x1024", "1536x1024", "1024x1536"];
const PRESETS_25 = [...PRESETS_3, "1536x864", "2048x2048"];

const ASPECTS_BASE = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const ASPECTS_WIDE = [...ASPECTS_BASE, "1:4", "4:1", "1:8", "8:1"];

export const MODELS = {
  openai: [
    {
      id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", note: "fast", // OpenAI's default; default model for new OpenAI types
      family: "gpt-image-2.5", qualities: OPENAI_QUALITIES_25, defaultQuality: "medium",
      customSize: true, presets: PRESETS_25,
    },
    {
      id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", note: "detailed", // same token cost as Flare, ~50% slower (independent tests)
      family: "gpt-image-2.5", qualities: OPENAI_QUALITIES_25, defaultQuality: "medium",
      customSize: true, presets: PRESETS_25,
    },
    { id: "gpt-image-2", label: "GPT Image 2", family: "gpt-image-2", qualities: OPENAI_QUALITIES_OLD, defaultQuality: "medium", customSize: false, presets: PRESETS_3 },
    { id: "gpt-image-1.5", label: "GPT Image 1.5", family: "gpt-image-1", qualities: OPENAI_QUALITIES_OLD, defaultQuality: "medium", customSize: false, presets: PRESETS_3 },
    { id: "gpt-image-1", label: "GPT Image 1", family: "gpt-image-1", qualities: OPENAI_QUALITIES_OLD, defaultQuality: "medium", customSize: false, presets: PRESETS_3 },
    { id: "gpt-image-1-mini", label: "GPT Image 1 mini", family: "gpt-image-1", qualities: OPENAI_QUALITIES_OLD, defaultQuality: "medium", customSize: false, presets: PRESETS_3 },
  ],
  gemini: [
    {
      id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1", note: "newest",
      api: "interactions", // dokumentacja pokazuje tylko Interactions API; fallback → generateContent
      tier: "nb21", sizes: ["1K", "2K", "4K"], defaultSize: "1K",
      thinking: ["minimal", "medium", "high"], defaultThinking: "medium",
      aspects: ASPECTS_WIDE, maxRefs: 14, modalities: ["TEXT", "IMAGE"],
      price: { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 },
      batchPrice: { "1K": 0.0168, "2K": 0.0252, "4K": 0.0567 },
      tokens: { "1K": 1120, "2K": 1680, "4K": 3767 },
    },
    {
      id: "gemini-3.1-flash-image", label: "Nano Banana 2", api: "generateContent",
      tier: "flash", sizes: ["0.5K", "1K", "2K", "4K"], defaultSize: "1K",
      thinking: ["minimal", "high"], defaultThinking: "minimal",
      aspects: ASPECTS_WIDE, maxRefs: 14, modalities: ["TEXT", "IMAGE"],
      price: { "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 },
      batchPrice: { "0.5K": 0.022, "1K": 0.034, "2K": 0.05, "4K": 0.076 },
      tokens: { "0.5K": 750, "1K": 1120, "2K": 1683, "4K": 2520 },
    },
    {
      id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite", note: "cheapest", api: "generateContent",
      tier: "lite", sizes: ["1K"], defaultSize: "1K",
      thinking: ["minimal", "high"], defaultThinking: "minimal",
      aspects: ASPECTS_BASE, maxRefs: 14, modalities: ["IMAGE"], // zweryfikowane w roleplay
      price: { "1K": 0.0336 }, batchPrice: { "1K": 0.0168 }, tokens: { "1K": 1120 },
    },
    {
      id: "gemini-3-pro-image", label: "Nano Banana Pro", api: "generateContent",
      tier: "pro", sizes: ["1K", "2K", "4K"], defaultSize: "1K",
      thinking: [], defaultThinking: "", // thinking zawsze włączone, nie do ustawienia
      aspects: ASPECTS_BASE, maxRefs: 9, modalities: ["TEXT", "IMAGE"],
      price: { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
      batchPrice: { "1K": 0.067, "2K": 0.067, "4K": 0.12 },
      tokens: { "1K": 1120, "2K": 1120, "4K": 2000 },
    },
  ],
  // Ids come from OpenRouter's public Images API list (GET /api/v1/images/models, 2026-10). No per-image prices:
  // the list gives none, so costs stay a conservative estimate (openrouterEstimate) until usage.cost arrives.
  openrouter: [
    { id: "google/gemini-nano-banana-2.1", label: "Nano Banana 2.1", note: "newest" },
    { id: "openai/gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", note: "fast" },
    { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", note: "detailed" },
    { id: "google/gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite", note: "cheapest" },
    { id: "google/gemini-3.1-flash-image", label: "Nano Banana 2" },
    { id: "google/gemini-3-pro-image", label: "Nano Banana Pro" },
    { id: "openai/gpt-image-2", label: "GPT Image 2" },
    { id: "openai/gpt-5.4-image-2", label: "GPT-5.4 Image 2 (via chat)" },
  ],
};

export const getModel = (provider, id) => (MODELS[provider] ?? []).find((m) => m.id === id) ?? null;

/** Pierwszy model providera (domyślny dla nowych konfiguracji). */
export const defaultModelId = (provider) => MODELS[provider]?.[0]?.id ?? "";

/** Czy model OpenAI przyjmuje dowolne WxH (rodzina 2.5). */
export const openaiCustomSize = (modelId) => !!getModel("openai", modelId)?.customSize;

const r16 = (v) => Math.round(v / 16) * 16;
const MAX_RATIO = 2.9;

/**
 * Normalizacja rozmiaru gpt-image-2.5 do reguł API: wielokrotność 16, krawędź ≤ 3840,
 * proporcje < 3:1 (ostrożnie 2.9), 655 360 ≤ piksele ≤ 8 294 400. Zachowuje proporcje przy skalowaniu.
 * (> 2560x1440 jest oznaczone przez OpenAI jako eksperymentalne.)
 */
export function normalizeOpenAISize(width, height) {
  let w = Number(width) || 1024, h = Number(height) || 1024;
  // proporcje: dokumentacja mówi „between 1:3 and 3:1" (końce niejasne), więc zostajemy ostrożnie poniżej 3:1
  if (w / h > MAX_RATIO) h = w / MAX_RATIO;
  if (h / w > MAX_RATIO) w = h / MAX_RATIO;
  const MIN = 655_360, MAX = 8_294_400;
  let px = w * h;
  if (px < MIN) { const k = Math.sqrt(MIN / px); w *= k; h *= k; }
  px = w * h;
  if (px > MAX) { const k = Math.sqrt(MAX / px); w *= k; h *= k; }
  if (Math.max(w, h) > 3840) { const k = 3840 / Math.max(w, h); w *= k; h *= k; }
  w = Math.max(16, r16(w)); h = Math.max(16, r16(h));
  // zaokrąglenia mogą wypchnąć poza limity o 1 krok: skoryguj
  while (w * h > MAX) { if (w >= h) w -= 16; else h -= 16; }
  while (w * h < MIN) { if (w <= h) w += 16; else h += 16; }
  if (w / h > MAX_RATIO) w = Math.floor((h * MAX_RATIO) / 16) * 16;
  if (h / w > MAX_RATIO) h = Math.floor((w * MAX_RATIO) / 16) * 16;
  return { width: w, height: h };
}

/** Rozmiar dla starszych modeli OpenAI: jeden z trzech koszyków API. */
export function bucketOpenAISize(width, height, aspectRatio) {
  if (width && height && PRESETS_3.includes(`${width}x${height}`)) return `${width}x${height}`;
  let r = 1;
  if (width && height) r = width / height;
  else if (aspectRatio && /^\d+:\d+$/.test(aspectRatio)) { const [a, b] = aspectRatio.split(":").map(Number); r = a / b; }
  return r > 1.2 ? "1536x1024" : r < 0.83 ? "1024x1536" : "1024x1024";
}

/** Rozmiar żądania OpenAI zależnie od modelu ("WxH"). */
export function openaiSizeFor(modelId, { width, height, aspectRatio } = {}) {
  if (openaiCustomSize(modelId) && width && height) {
    const n = normalizeOpenAISize(width, height);
    return `${n.width}x${n.height}`;
  }
  return bucketOpenAISize(width, height, aspectRatio);
}


const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const aspectOf = (a) => a.split(":").map(Number);
// Aspekty obsługiwane przez OpenRouter /images (jak w openrouter.mjs).
const OPENROUTER_ASPECTS = ASPECTS_BASE;

/** Aspekty, które provider/model faktycznie przyjmuje (null = dowolny rozmiar WxH / koszyki OpenAI). */
export function allowedAspects(provider, modelId) {
  if (provider === "gemini") return getModel("gemini", modelId)?.aspects ?? null;
  if (provider === "openrouter") return OPENROUTER_ASPECTS;
  return null;
}

/** Wymiary reprezentujące aspekt "a:b": preset 1024/1536, inaczej krok 16 z dłuższym bokiem ~1536. */
function dimsForAspect(aspect) {
  let [a, b] = aspectOf(aspect);
  const g = gcd(a, b); a /= g; b /= g;
  for (const id of [...PRESETS_25]) {
    const [pw, ph] = id.split("x").map(Number);
    if (pw * b === ph * a && pw <= 1536 && ph <= 1536) return { width: pw, height: ph };
  }
  const k = 16 * Math.max(1, Math.round(1536 / (16 * Math.max(a, b))));
  return { width: a * k, height: b * k };
}

/**
 * Rozmiar dozwolony dla modelu (czysta funkcja, idempotentna): OpenAI 2.5 → reguły API,
 * starsze OpenAI → jeden z 3 koszyków, Gemini/OpenRouter → najbliższy obsługiwany aspekt
 * (rozmiar pikseli określa wtedy imageSize, nie WxH). Rozmiar już dozwolony zostaje bez zmian.
 */
export function fitSizeFor(provider, modelId, width, height) {
  const w = Number(width) || 1024, h = Number(height) || 1024;
  if (provider === "openai") {
    if (openaiCustomSize(modelId)) { const n = normalizeOpenAISize(w, h); return { ...n, changed: n.width !== w || n.height !== h }; }
    const [bw, bh] = bucketOpenAISize(w, h).split("x").map(Number);
    return { width: bw, height: bh, changed: bw !== w || bh !== h };
  }
  const allowed = allowedAspects(provider, modelId);
  if (!allowed) return { width: w, height: h, changed: false };
  // porównanie przez iloczyn krzyżowy: "7:3" i "21:9" to ten sam aspekt
  if (allowed.some((asp) => { const [a, b] = aspectOf(asp); return a * h === b * w; })) return { width: w, height: h, changed: false };
  let best = allowed[0], bd = Infinity;
  for (const asp of allowed) {
    const [a, b] = aspectOf(asp);
    const d = Math.abs(Math.log(a / b / (w / h)));
    if (d < bd) { bd = d; best = asp; }
  }
  const out = dimsForAspect(best);
  return { ...out, changed: out.width !== w || out.height !== h };
}

/** Jakość dopuszczalna dla modelu (xhigh/max tylko 2.5); nieznana → domyślna. */
export function fitOpenAIQuality(modelId, quality) {
  const m = getModel("openai", modelId);
  const list = m?.qualities ?? OPENAI_QUALITIES_OLD;
  if (list.includes(quality)) return quality;
  if (quality === "xhigh" || quality === "max") return "high";
  return m?.defaultQuality ?? "medium";
}

/** Rozmiar Gemini dopuszczalny dla modelu (np. 0.5K → 1K dla 2.1). */
export function fitGeminiSize(modelId, size) {
  const m = getModel("gemini", modelId);
  if (!m) return size || "1K";
  if (m.sizes.includes(size)) return size;
  const order = ["0.5K", "1K", "2K", "4K"];
  const want = order.indexOf(size);
  let best = m.defaultSize, bd = Infinity;
  for (const s of m.sizes) {
    const d = Math.abs(order.indexOf(s) - (want < 0 ? order.indexOf("1K") : want));
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** Thinking dopuszczalny dla modelu; brak wsparcia → "". */
export function fitGeminiThinking(modelId, level) {
  const m = getModel("gemini", modelId);
  if (!m || !m.thinking.length) return "";
  return m.thinking.includes(level) ? level : m.defaultThinking;
}
