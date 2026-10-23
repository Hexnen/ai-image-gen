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

const PRESETS_3 = ["1024x1024", "1536x1024", "1024x1536"];
const PRESETS_25 = [...PRESETS_3, "1536x864", "2048x2048"];

const ASPECTS_BASE = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const ASPECTS_WIDE = [...ASPECTS_BASE, "1:4", "4:1", "1:8", "8:1"];

export const MODELS = {
  openai: [
    {
      id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", note: "detailed",
      family: "gpt-image-2.5", qualities: OPENAI_QUALITIES_25, defaultQuality: "medium",
      customSize: true, presets: PRESETS_25,
    },
    {
      id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", note: "fast",
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
  openrouter: [
    { id: "google/gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite (OpenRouter)" },
    { id: "openai/gpt-5.4-image-2", label: "GPT Image 2 (OpenRouter, chat)" },
  ],
};

export const getModel = (provider, id) => (MODELS[provider] ?? []).find((m) => m.id === id) ?? null;

/** Pierwszy model providera (domyślny dla nowych konfiguracji). */
export const defaultModelId = (provider) => MODELS[provider]?.[0]?.id ?? "";

/** Czy model OpenAI przyjmuje dowolne WxH (rodzina 2.5). */
export const openaiCustomSize = (modelId) => !!getModel("openai", modelId)?.customSize;

const r16 = (v) => Math.round(v / 16) * 16;

/**
 * Normalizacja rozmiaru gpt-image-2.5 do reguł API: wielokrotność 16, krawędź ≤ 3840,
 * proporcje 1:3..3:1, 655 360 ≤ piksele ≤ 8 294 400. Zachowuje proporcje przy skalowaniu.
 * (> 2560x1440 jest oznaczone przez OpenAI jako eksperymentalne.)
 */
export function normalizeOpenAISize(width, height) {
  let w = Number(width) || 1024, h = Number(height) || 1024;
  // proporcje: podciągnij krótszą krawędź
  if (w / h > 3) h = w / 3;
  if (h / w > 3) w = h / 3;
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
  if (w / h > 3) w = Math.floor((h * 3) / 16) * 16;
  if (h / w > 3) h = Math.floor((w * 3) / 16) * 16;
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
