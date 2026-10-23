// Gemini Batch Mode (batchGenerateContent + File API). Port z roleplay workshopBatch/gemini.ts.
// CORS: upload plików idzie JEDNYM żądaniem multipart (X-Goog-Upload-Protocol: multipart),
// bez resumable — nie czytamy nagłówka x-goog-upload-url.
import { mimeOf, b64ToBlob, nearestAspect } from "../providers/util.mjs";
import { getModel, fitGeminiSize, fitGeminiThinking } from "../providers/models.mjs";
import { UPLOAD_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, readError, jsonl, parseJsonl, uniqueRefs } from "./util.mjs";
import { geminiBatchCost } from "./cost.mjs";
import { patchBatch, markIngested } from "./record.mjs";
import { applyBatchItem } from "./apply.mjs";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const hdr = (apiKey) => ({ "x-goog-api-key": apiKey });

/** Upload do File API. @returns {{name:string, uri:string}} */
async function uploadFile(apiKey, displayName, blob, mime) {
  const boundary = `aiig-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ file: { display_name: displayName } });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: { ...hdr(apiKey), "X-Goog-Upload-Protocol": "multipart", "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini files upload ${res.status}: ${await readError(res)}`);
  const file = (await res.json())?.file;
  if (!file?.name || !file?.uri) throw new Error("Gemini files: brak name/uri w odpowiedzi");
  return { name: file.name, uri: file.uri };
}

/** thinking_config tylko gdy poziom różni się od domyślnego modelu. */
function thinkingCfg(model, level) {
  const m = getModel("gemini", model);
  const t = fitGeminiThinking(model, level);
  return t && t !== m?.defaultThinking ? { thinking_config: { thinking_level: t } } : {};
}

/** Wysyła batch. @returns {{remoteId:string, endpoint:string}} */
export async function submitGemini({ apiKey, model, items }) {
  const ups = new Map();
  let n = 0;
  for (const blob of uniqueRefs(items)) {
    const mime = await mimeOf(blob);
    const f = await uploadFile(apiKey, `ai-image-gen-ref-${Date.now()}-${n++}`, blob, mime);
    ups.set(blob, { uri: f.uri, mime });
  }
  // Wszystkie modele Gemini idą przez batchGenerateContent (oficjalnie jedyny batch obrazów).
  // NIEZWERYFIKOWANE z kluczem: czy gemini-nano-banana-2.1 przyjmuje ten kształt w batchu
  // oraz pola image_config.image_size / thinking_config w linii JSONL.
  const m = getModel("gemini", model);
  const lines = items.map((it) => {
    const parts = [];
    (it.refs ?? []).forEach((b, i) => {
      const u = ups.get(b);
      parts.push({ text: `ref${i + 1}:` }, { file_data: { file_uri: u.uri, mime_type: u.mime } });
    });
    parts.push({ text: it.prompt });
    return {
      key: it.id,
      request: {
        contents: [{ parts }],
        generation_config: {
          response_modalities: m?.modalities ?? ["IMAGE"],
          image_config: {
            aspect_ratio: nearestAspect({ width: it.width, height: it.height }, m?.aspects ?? ASPECTS),
            image_size: fitGeminiSize(model, it.imageSize),
          },
          ...thinkingCfg(model, it.thinkingLevel),
        },
      },
    };
  });
  const input = await uploadFile(
    apiKey, `ai-image-gen-${Date.now()}.jsonl`,
    new Blob([jsonl(lines)], { type: "application/jsonl" }), "application/jsonl",
  );
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:batchGenerateContent`, {
    method: "POST",
    headers: { ...hdr(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ batch: { display_name: `ai-image-gen-${Date.now()}`, input_config: { file_name: input.name } } }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini batch create ${res.status}: ${await readError(res)}`);
  const name = (await res.json())?.name;
  if (!name) throw new Error("Gemini batch: brak name operacji w odpowiedzi");
  return { remoteId: name, endpoint: "batchGenerateContent" };
}

async function ingest(apiKey, rec, op) {
  const done = new Set(rec.ingest?.ids ?? []);
  const applyFailed = [...(rec.ingest?.failed ?? [])];
  const out = { applied: done.size - applyFailed.length, failed: [...applyFailed], cost: rec.ingest?.cost ?? 0 };
  const respFile =
    op?.response?.responsesFile || op?.response?.responses_file ||
    op?.metadata?.output?.responsesFile || op?.response?.dest?.fileName || op?.response?.dest?.file_name;
  if (!respFile) throw new Error(`Gemini batch: brak pliku wyników w operacji (${JSON.stringify(op).slice(0, 300)})`);
  const dl = await fetch(`${GEMINI_BASE}/download/v1beta/${respFile}:download?alt=media`, {
    headers: hdr(apiKey), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!dl.ok) throw new Error(`Gemini download ${dl.status}: ${await readError(dl)}`);
  const byId = new Map(rec.items.map((i) => [i.id, i]));
  for (const row of parseJsonl(await dl.text())) {
    const id = String(row?.key ?? row?.metadata?.key ?? "");
    const item = byId.get(id);
    if (!item || done.has(id)) continue;
    if (row?.error) { out.failed.push({ id, error: String(row.error?.message || "błąd batcha") }); continue; }
    const resp = row?.response ?? row;
    const parts = resp?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
    const b64 = img?.inlineData?.data || img?.inline_data?.data;
    if (!b64) { out.failed.push({ id, error: "brak obrazu w odpowiedzi batcha" }); continue; }
    const mime = img?.inlineData?.mimeType || img?.inline_data?.mime_type || "image/png";
    const cost = geminiBatchCost(resp?.usageMetadata ?? resp?.usage_metadata, rec.model);
    const r = await applyBatchItem(item, b64ToBlob(b64, mime), cost);
    out.cost += cost;
    done.add(id); // przetworzony (koszt już naliczony) — nie powtarzamy po wznowieniu
    if (!r.ok) { applyFailed.push({ id, error: r.error }); out.failed.push({ id, error: r.error }); }
    out.applied = done.size - applyFailed.length;
    if (!(await markIngested(rec.id, done, out.cost, applyFailed))) break;
  }
  return out;
}

export async function checkGemini(apiKey, rec) {
  const res = await fetch(`${GEMINI_BASE}/v1beta/${rec.remoteId}`, {
    headers: hdr(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini batches/get ${res.status}`);
  const op = await res.json();
  const state = String(op?.metadata?.state ?? op?.state ?? "");
  if (state.endsWith("SUCCEEDED")) {
    const r = await ingest(apiKey, rec, op);
    await patchBatch(rec.id, {
      status: "done", completedAt: Date.now(), applied: r.applied, failed: r.failed, cost: r.cost, ingest: undefined,
    }, { onlyActive: true });
  } else if (/FAILED|CANCELLED|EXPIRED/.test(state)) {
    await patchBatch(rec.id, {
      status: state.endsWith("CANCELLED") ? "cancelled" : "error",
      error: String(op?.error?.message || state),
      completedAt: Date.now(), ingest: undefined,
    }, { onlyActive: true });
  }
  // PENDING / RUNNING → czekamy dalej.
}

export async function cancelGemini(apiKey, rec) {
  const res = await fetch(`${GEMINI_BASE}/v1beta/${rec.remoteId}:cancel`, {
    method: "POST", headers: hdr(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini cancel ${res.status}: ${await readError(res)}`);
}
