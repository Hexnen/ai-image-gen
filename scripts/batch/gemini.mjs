// Gemini Batch Mode (batchGenerateContent + File API). Port z roleplay workshopBatch/gemini.ts.
// CORS: upload plików idzie JEDNYM żądaniem multipart (X-Goog-Upload-Protocol: multipart),
// bez resumable — nie czytamy nagłówka x-goog-upload-url.
import { mimeOf, nearestAspect } from "../providers/util.mjs";
import { getModel, fitGeminiSize, fitGeminiThinking } from "../providers/models.mjs";
import { UPLOAD_TIMEOUT_MS, HttpError, readError, jsonl, iterJsonl, openStream, uniqueRefs } from "./util.mjs";
import { geminiBatchCost } from "./cost.mjs";
import { patchBatch } from "./record.mjs";
import { ingestRows, failMissing, finishBatch, expireBatch, withLease } from "./ingest.mjs";
import { tokensFrom } from "../call-log.mjs";

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
  if (!res.ok) throw new HttpError(`Gemini files upload ${res.status}: ${await readError(res)}`, res.status);
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
    const f = await uploadFile(apiKey, `moinens-ai-gen-ref-${Date.now()}-${n++}`, blob, mime);
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
    apiKey, `moinens-ai-gen-${Date.now()}.jsonl`,
    new Blob([jsonl(lines)], { type: "application/jsonl" }), "application/jsonl",
  );
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:batchGenerateContent`, {
    method: "POST",
    headers: { ...hdr(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ batch: { display_name: `moinens-ai-gen-${Date.now()}`, input_config: { file_name: input.name } } }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(`Gemini batch create ${res.status}: ${await readError(res)}`, res.status);
  const name = (await res.json())?.name;
  if (!name) throw new Error("Gemini batch: brak name operacji w odpowiedzi");
  return { remoteId: name, endpoint: "batchGenerateContent" };
}

// ---------- wyniki ----------

const imageOf = (p) => p?.inlineData ?? p?.inline_data;

/** Wiersz wyniku -> znormalizowany. Ostatni obraz nie będący „thought" (modele z myśleniem mogą zwracać szkice). */
function resultRow(row, model, stats) {
  const id = String(row?.key ?? row?.metadata?.key ?? "");
  if (!id) { stats.skipped = (stats.skipped ?? 0) + 1; return null; }
  if (row?.error) return { id, error: String(row.error?.message || "batch error"), cost: 0 };
  const resp = row?.response ?? row;
  const usage = resp?.usageMetadata ?? resp?.usage_metadata;
  const cost = geminiBatchCost(usage, model);   // wiersz bez obrazu też został naliczony
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  const img = [...parts].reverse().find((p) => !p?.thought && imageOf(p)?.data);
  if (!img) {
    const why = resp?.promptFeedback?.blockReason
      ? `blocked (${resp.promptFeedback.blockReason})`
      : resp?.candidates?.[0]?.finishReason ? `no image (${resp.candidates[0].finishReason})` : "no image in the batch response";
    return { id, error: why, cost, tokens: tokensFrom(resp) };
  }
  return { id, b64: imageOf(img).data, mime: imageOf(img).mimeType || imageOf(img).mime_type || "image/png", cost, tokens: tokensFrom(resp) };
}

async function* geminiRows(apiKey, respFile, model, stats) {
  const { res, ctrl } = await openStream(`${GEMINI_BASE}/download/v1beta/${respFile}:download?alt=media`, { headers: hdr(apiKey) });
  if (!res.ok) throw new HttpError(`Gemini download ${res.status}: ${await readError(res)}`, res.status);
  for await (const row of iterJsonl(res, { stats, ctrl })) {
    const out = resultRow(row, model, stats);
    if (out) yield out;
  }
}

const isGone = (e) => e?.status === 404 || e?.status === 410;

export async function checkGemini(apiKey, rec) {
  const res = await fetch(`${GEMINI_BASE}/v1beta/${rec.remoteId}`, {
    headers: hdr(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.status === 404) {
      await patchBatch(rec.id, {
        status: "error", error: "Batch operation not found at Gemini (expired, or the API key belongs to another project).",
        completedAt: Date.now(), ingest: undefined, lease: undefined,
      }, { onlyActive: true });
      return;
    }
    throw new HttpError(`Gemini batches/get ${res.status}`, res.status);
  }
  const op = await res.json();
  const state = String(op?.metadata?.state ?? op?.state ?? "");
  if (state.endsWith("SUCCEEDED")) {
    await withLease(rec.id, async (cur) => {
      const respFile =
        op?.response?.responsesFile || op?.response?.responses_file ||
        op?.metadata?.output?.responsesFile || op?.response?.dest?.fileName || op?.response?.dest?.file_name;
      if (!respFile) {
        await expireBatch(cur, "Gemini reported success but returned no results file.");
        return;
      }
      const stats = { skipped: 0 };
      let st;
      try {
        st = await ingestRows(cur, geminiRows(apiKey, respFile, cur.model, stats));
      } catch (e) {
        if (isGone(e)) { await expireBatch(cur, "Batch results expired at Gemini (result files are kept for a limited time)."); return; }
        throw e;   // błąd przejściowy: rekord zostaje pending, marker zachowuje postęp
      }
      if (st.lost) return;
      await failMissing(cur, st, `${stats.skipped} unreadable lines`);
      if (st.lost || st.incomplete) return;
      await finishBatch(cur, st, { terminalStatus: "done" });
    });
  } else if (/FAILED|CANCELLED|EXPIRED/.test(state)) {
    await patchBatch(rec.id, {
      status: state.endsWith("CANCELLED") ? "cancelled" : "error",
      error: String(op?.error?.message || state),
      completedAt: Date.now(), ingest: undefined, lease: undefined,
    }, { onlyActive: true });
  }
  // PENDING / RUNNING → czekamy dalej.
}

export async function cancelGemini(apiKey, rec) {
  const res = await fetch(`${GEMINI_BASE}/v1beta/${rec.remoteId}:cancel`, {
    method: "POST", headers: hdr(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(`Gemini cancel ${res.status}: ${await readError(res)}`, res.status);
}
