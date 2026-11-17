// Gemini (Nano Banana) bezpośrednio.
//  • gemini-nano-banana-2.1: oficjalna dokumentacja pokazuje WYŁĄCZNIE Interactions API
//    (POST /v1beta/interactions). Próbujemy go najpierw; gdy zwróci błąd "nie wspierane /
//    nie znaleziono" (404/400/405/501), spadamy na models/<model>:generateContent.
//    NIEZWERYFIKOWANE z prawdziwym kluczem: kształt body Interactions i odpowiedzi.
//  • pozostałe modele: generateContent (port z roleplay imageGen/gemini.ts).
import { GEN_TIMEOUT_MS, withTimeout, scaledTimeout, httpError, b64ToBlob, blobToB64, mimeOf, nearestAspect } from "./util.mjs";
import { getModel, fitGeminiSize, fitGeminiThinking } from "./models.mjs";
import { geminiSyncCost } from "../batch/cost.mjs";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const LEGACY_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

/** Ostrożny szacunek dla modelu spoza katalogu (jak najdroższy znany: Pro 4K), gdy brak usage. */
const UNKNOWN_MODEL_COST = 0.24;

/** Koszt za obraz: tabela z oficjalnego cennika (stawka standard) albo null dla nieznanego modelu. */
export function imageCost(modelId, size) {
  const m = getModel("gemini", modelId);
  if (!m) return null;
  return m.price?.[size] ?? m.price?.["1K"] ?? null;
}

const usageOf = (json) => json?.usageMetadata ?? json?.usage_metadata ?? json?.usage ?? null;

/** Koszt odpowiedzi: max(tabela, tokeny z usage — z thinking i referencjami); nieznany model bez usage = szacunek. */
function responseCost(json, ctx) {
  const table = imageCost(ctx.model, ctx.size);
  const u = usageOf(json);
  const usageCost = u ? geminiSyncCost(u, ctx.model) : 0;
  if (table == null && !usageCost) return { cost: UNKNOWN_MODEL_COST, estimated: true };
  return { cost: Math.max(table ?? 0, usageCost), estimated: false };
}

/** Odpowiedź BEZ obrazu (odmowa/sam tekst): tokeny z usage i tak są rozliczone, więc wynoszą koszt w `e.cost`. */
function noImageError(json, ctx) {
  const txt = findText(json);
  const e = new Error(`Gemini: brak obrazu w odpowiedzi${txt ? ` — ${txt.slice(0, 300)}` : ` (${JSON.stringify(json).slice(0, 300)})`}`);
  const u = usageOf(json);
  if (u) e.cost = geminiSyncCost(u, ctx.model);
  return e;
}

/** Timeout rośnie z rozmiarem obrazu i poziomem thinking (zakres 120–300 s). */
function requestTimeout(ctx) {
  const sizeF = { "0.5K": 1, "1K": 1, "2K": 1.3, "4K": 2 }[ctx.size] ?? 1;
  const thinkF = ctx.think === "high" ? 1.5 : 1;
  return scaledTimeout(GEN_TIMEOUT_MS, { factor: sizeF * thinkF, max: 300_000 });
}

/** Fallback Interactions -> generateContent TYLKO gdy endpoint/model nie jest obsługiwany. */
const UNSUPPORTED_RE = /not (found|supported)|unsupported|unknown|unrecogni[sz]ed/i;
export const isUnsupportedStatus = (status, message = "") =>
  status === 404 || status === 405 || status === 501 || (status === 400 && UNSUPPORTED_RE.test(message));

export async function generate({ apiKey, model, prompt, refs = [], width, height, aspectRatio, imageSize, thinkingLevel, signal }) {
  const m = getModel("gemini", model);
  const size = fitGeminiSize(model, imageSize);
  const think = fitGeminiThinking(model, thinkingLevel);
  const aspect = nearestAspect({ aspectRatio, width, height }, m?.aspects ?? LEGACY_ASPECTS);
  const ctx = { apiKey, model, prompt, refs, aspect, size, think, defaultThink: m?.defaultThinking ?? "", modalities: m?.modalities ?? ["IMAGE"], signal };

  if (m?.api === "interactions") {
    try {
      return await viaInteractions(ctx);
    } catch (e) {
      if (!e?.fallbackOk) throw e;
      console.warn("moinens-ai-gen | Interactions API unavailable for", model, "- falling back to generateContent", e.message);
      return viaGenerateContent(ctx, "generateContent (fallback from interactions)");
    }
  }
  return viaGenerateContent(ctx, "generateContent");
}

// ---------- Interactions API ----------

export function buildInteractionsBody({ model, prompt, parts, aspect, size, think }) {
  return {
    model,
    // domyślnie Interactions zapisuje prompt i referencje po stronie Google (store=true); wyłączamy
    store: false,
    input: parts.length ? [...parts, { type: "text", text: prompt }] : prompt,
    // Schemat OpenAPI (ImageResponseFormat): mime_type dopuszcza TYLKO "image/jpeg" (przykład w dokumentacji
    // ma png, sprzeczny ze schematem), więc go nie wysyłamy — serwer wybiera domyślny, a odpowiedź niesie własny mime.
    // image_size: enum "512" | "1K" | "2K" | "4K" ("0.5K" z katalogu to w Interactions "512").
    response_format: { type: "image", delivery: "inline", aspect_ratio: aspect, image_size: size === "0.5K" ? "512" : size },
    ...(think ? { generation_config: { thinking_level: think } } : {}),
  };
}

async function viaInteractions(ctx) {
  const parts = [];
  for (const blob of ctx.refs) parts.push({ type: "image", data: await blobToB64(blob), mime_type: await mimeOf(blob) });
  const res = await fetch(`${GEMINI_BASE}/v1beta/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": ctx.apiKey, "Content-Type": "application/json" },
    // domyślny poziom thinking modelu pomijamy (jak w generateContent)
    body: JSON.stringify(buildInteractionsBody({ ...ctx, parts, think: ctx.think !== ctx.defaultThink ? ctx.think : "" })),
    signal: withTimeout(requestTimeout(ctx), ctx.signal),
  });
  if (!res.ok) {
    const err = await httpError(`Gemini ${ctx.model} (interactions)`, res);
    // Tylko "endpoint/model nieobsługiwany" uprawnia do fallbacku; 400 tylko z takim komunikatem,
    // a 401/403/429 i inne 400 (zły klucz, blokada promptu, za dużo referencji) propagujemy bez zmian.
    err.fallbackOk = isUnsupportedStatus(res.status, err.message);
    throw err;
  }
  const json = await res.json();
  const img = findImage(json);
  if (!img) throw noImageError(json, ctx);
  const { cost, estimated } = responseCost(json, ctx);
  return { blob: b64ToBlob(img.data, img.mime), cost, ...(estimated ? { costEstimated: true } : {}), raw: json, route: "interactions" };
}

/**
 * Odporne wyszukanie obrazu: interaction.output_image.data (wynik końcowy), a w pozostałych kształtach
 * OSTATNI obraz w odpowiedzi; części `thought: true` (szkice myślenia) są pomijane.
 */
export function findImage(json) {
  const direct = json?.output_image ?? json?.outputImage;
  if (typeof direct?.data === "string" && direct.data) return { data: direct.data, mime: direct.mime_type || direct.mimeType || "image/png" };
  let found = null;
  const walk = (n, depth = 0) => {
    if (!n || typeof n !== "object" || depth > 8) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (n.thought === true) return;
    const inl = n.inlineData ?? n.inline_data;
    if (typeof inl?.data === "string" && inl.data) { found = { data: inl.data, mime: inl.mimeType || inl.mime_type || "image/png" }; return; }
    const mime = n.mime_type || n.mimeType;
    if (typeof n.data === "string" && n.data.length > 64 && (n.type === "image" || String(mime).startsWith("image/"))) {
      found = { data: n.data, mime: mime || "image/png" };
      return;
    }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(json);
  return found;
}

function findText(json) {
  if (typeof json?.output_text === "string") return json.output_text;
  const out = [];
  const walk = (n, d = 0) => {
    if (!n || typeof n !== "object" || d > 8) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
    if (typeof n.text === "string") out.push(n.text);
    for (const k of Object.keys(n)) walk(n[k], d + 1);
  };
  walk(json);
  return out.join(" ");
}

// ---------- generateContent ----------

export function buildGenerateContentBody({ prompt, parts, aspect, size, think, defaultThink, modalities }) {
  const generationConfig = {
    response_modalities: modalities,
    // To ŻĄDANIE aspektu/rozmiaru; realne wymiary mogą się różnić.
    image_config: { aspect_ratio: aspect, image_size: size },
  };
  // thinking tylko gdy wybrano inny niż domyślny poziom modelu (kształt pola niezweryfikowany).
  if (think && think !== defaultThink) generationConfig.thinking_config = { thinking_level: think };
  return { contents: [{ parts: [...parts, { text: prompt }] }], generationConfig };
}

async function viaGenerateContent(ctx, route = "generateContent") {
  const parts = [];
  for (const blob of ctx.refs) parts.push({ inline_data: { mime_type: await mimeOf(blob), data: await blobToB64(blob) } });
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${ctx.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": ctx.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(buildGenerateContentBody({ ...ctx, parts })),
    signal: withTimeout(requestTimeout(ctx), ctx.signal),
  });
  if (!res.ok) throw await httpError(`Gemini ${ctx.model}`, res);
  const json = await res.json();
  const img = findImage(json);
  if (!img) throw noImageError(json, ctx);
  const { cost, estimated } = responseCost(json, ctx);
  return { blob: b64ToBlob(img.data, img.mime), cost, ...(estimated ? { costEstimated: true } : {}), raw: json, route };
}
