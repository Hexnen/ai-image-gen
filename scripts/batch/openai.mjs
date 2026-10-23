// OpenAI Batch API (/v1/batches) dla obrazów. Port z roleplay workshopBatch/openai.ts.
// Jeden endpoint na batch: edits (gdy itemy mają referencje) albo generations (gdy nie).
import { mimeOf, blobToB64 } from "../providers/util.mjs";
import {
  UPLOAD_TIMEOUT_MS, HttpError, readError, jsonl, iterJsonl, openStream, uniqueRefs,
} from "./util.mjs";
import { openaiBatchCost } from "./cost.mjs";
import { openaiSizeFor, fitOpenAIQuality, supportsTransparent } from "../providers/models.mjs";
import { patchBatch } from "./record.mjs";
import { ingestRows, failMissing, finishBatch, expireBatch, withLease } from "./ingest.mjs";
import { tokensFrom } from "../call-log.mjs";

export const OPENAI_BASE = "https://api.openai.com/v1";
/** Limit OpenAI na plik wejściowy batcha to 200 MB; zostaw zapas na narzut. */
export const openaiLimits = { maxBytes: 190 * 1024 * 1024 };
const auth = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });
const EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };

/** Rozmiar linii batcha: dla 2.5 dokładny (po normalizacji), dla starszych koszyk. */
export const openaiSize = (width, height, model = "gpt-image-2.5-flare") => openaiSizeFor(model, { width, height });

async function uploadFile(apiKey, purpose, filename, blob) {
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("file", blob, filename);
  const res = await fetch(`${OPENAI_BASE}/files`, {
    method: "POST", headers: auth(apiKey), body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(`OpenAI files (${purpose}) ${res.status}: ${await readError(res)}`, res.status);
  const json = await res.json();
  if (!json?.id) throw new Error("OpenAI files: brak id w odpowiedzi");
  return json.id;
}

/** Kasowanie plików u OpenAI (best effort): prompty i referencje nie powinny tam leżeć bez końca. */
export async function deleteOpenAIFiles(apiKey, ids) {
  for (const id of ids ?? []) {
    if (!id) continue;
    try {
      await fetch(`${OPENAI_BASE}/files/${id}`, { method: "DELETE", headers: auth(apiKey), signal: AbortSignal.timeout(15_000) });
    } catch { /* best effort */ }
  }
}

/** Wysyła batch. @returns {{remoteId:string, endpoint:string, files:string[]}} */
export async function submitOpenAI({ apiKey, model, items }) {
  const withRefs = items.filter((i) => i.refs?.length).length;
  if (withRefs && withRefs !== items.length) {
    throw new Error("OpenAI batch: wszystkie itemy muszą mieć referencje albo żaden (jeden endpoint na batch).");
  }
  const endpoint = withRefs ? "/v1/images/edits" : "/v1/images/generations";
  const files = [];

  try {
    // Referencje RAZ (po tożsamości Blob): file_id (purpose vision), fallback → data URL.
    const refInput = new Map();
    let dataUrlFallback = false;
    let n = 0;
    for (const blob of uniqueRefs(items)) {
      const mime = await mimeOf(blob);
      try {
        const id = await uploadFile(apiKey, "vision", `ref-${n++}.${EXT[mime] ?? "png"}`, blob);
        files.push(id);
        refInput.set(blob, { file_id: id });
      } catch (e) {
        console.warn("ai-image-gen | OpenAI vision upload failed, falling back to image_url", e);
        dataUrlFallback = true;
        refInput.set(blob, { image_url: `data:${mime};base64,${await blobToB64(blob)}` });
      }
    }

    const lines = items.map((it) => ({
      custom_id: it.id,
      method: "POST",
      url: endpoint,
      body: {
        model,
        prompt: it.prompt,
        ...(withRefs ? { images: it.refs.map((b) => refInput.get(b)) } : {}),
        size: openaiSize(it.width, it.height, model),
        quality: fitOpenAIQuality(model, it.quality ?? "medium"),
        n: 1,
        output_format: "png",
        ...(it.transparent && supportsTransparent("openai", model) ? { background: "transparent" } : {}),
      },
    }));

    // Fallback data: URL powiela base64 referencji w KAŻDEJ linii: sprawdź rozmiar przed wysyłką,
    // zamiast dostać odrzucenie po wgraniu 200 MB.
    const body = new Blob([jsonl(lines)], { type: "application/jsonl" });
    if (body.size > openaiLimits.maxBytes) {
      throw new Error(
        `OpenAI batch input would be ${(body.size / 1048576).toFixed(0)} MB (limit 200 MB)` +
        `${dataUrlFallback ? ": reference upload failed, so images were inlined in every line" : ""}. ` +
        "Use fewer or smaller reference images, or fewer versions."
      );
    }
    const inputId = await uploadFile(apiKey, "batch", `ai-image-gen-${Date.now()}.jsonl`, body);
    files.push(inputId);
    const res = await fetch(`${OPENAI_BASE}/batches`, {
      method: "POST",
      headers: { ...auth(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ input_file_id: inputId, endpoint, completion_window: "24h" }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(`OpenAI batches ${res.status}: ${await readError(res)}`, res.status);
    const json = await res.json();
    if (!json?.id) throw new Error("OpenAI batches: brak id w odpowiedzi");
    return { remoteId: json.id, endpoint, files };
  } catch (e) {
    await deleteOpenAIFiles(apiKey, files); // nic nie powstało po stronie dostawcy: nie zostawiaj plików
    throw e;
  }
}

async function getRemote(apiKey, remoteId) {
  const res = await fetch(`${OPENAI_BASE}/batches/${remoteId}`, {
    headers: auth(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(`OpenAI batches/get ${res.status}`, res.status);
  return res.json();
}

// ---------- wiersze wyników ----------

function outputRow(row, stats) {
  const id = String(row?.custom_id ?? "");
  if (!id) { stats.skipped = (stats.skipped ?? 0) + 1; return null; }
  const body = row?.response?.body;
  const status = Number(row?.response?.status_code);
  const error = row?.error?.message
    || (status && status !== 200 ? (body?.error?.message || `HTTP ${status}`) : "");
  return {
    id,
    b64: error ? undefined : body?.data?.[0]?.b64_json,
    mime: "image/png",
    error: error || undefined,
    cost: openaiBatchCost(body?.usage),
    tokens: tokensFrom(body),
  };
}

function errorRow(row, stats) {
  const id = String(row?.custom_id ?? "");
  if (!id) { stats.skipped = (stats.skipped ?? 0) + 1; return null; }
  return { id, error: String(row?.error?.message || row?.response?.body?.error?.message || "batch error"), cost: 0 };
}

/** Wiersze z pliku wyników, potem z pliku błędów (strumieniowo, bez całego pliku w pamięci). */
async function* openaiRows(apiKey, batch, stats) {
  for (const [fileId, isErrors] of [[batch.output_file_id, false], [batch.error_file_id, true]]) {
    if (!fileId) continue;
    const { res, ctrl } = await openStream(`${OPENAI_BASE}/files/${fileId}/content`, { headers: auth(apiKey) });
    if (!res.ok) {
      // Brak pliku błędów nie przekreśla zaaplikowanych obrazów.
      if (isErrors && (res.status === 404 || res.status === 410)) continue;
      throw new HttpError(`OpenAI files/content ${res.status}: ${await readError(res)}`, res.status);
    }
    for await (const row of iterJsonl(res, { stats, ctrl })) {
      const out = isErrors ? errorRow(row, stats) : outputRow(row, stats);
      if (out) yield out;
    }
  }
}

const isGone = (e) => e?.status === 404 || e?.status === 410;

export async function checkOpenAI(apiKey, rec) {
  let batch;
  try {
    batch = await getRemote(apiKey, rec.remoteId);
  } catch (e) {
    if (e?.status === 404) {
      await patchBatch(rec.id, {
        status: "error", error: "Batch not found at OpenAI (deleted, or the API key belongs to another account).",
        completedAt: Date.now(), ingest: undefined, lease: undefined,
      }, { onlyActive: true });
      return;
    }
    throw e;   // 401/5xx/sieć: zostaje pending, kolejna próba w następnym ticku
  }
  const status = String(batch?.status ?? "");
  const hasResults = !!(batch?.output_file_id || batch?.error_file_id);

  if (status === "completed" || (["failed", "expired", "cancelled"].includes(status) && hasResults)) {
    await withLease(rec.id, async (cur) => {
      const stats = { skipped: 0 };
      let st;
      try {
        st = await ingestRows(cur, openaiRows(apiKey, batch, stats));
      } catch (e) {
        if (isGone(e)) { await expireBatch(cur, "Batch results expired at OpenAI (files are kept for 30 days)."); return; }
        throw e;   // błąd przejściowy: nie kończymy rekordu, marker zachowuje postęp
      }
      if (st.lost) return;
      await failMissing(cur, st, status === "completed" ? `${stats.skipped} unreadable lines` : status);
      if (st.lost || st.incomplete) return;
      const terminal = status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "error";
      const error = terminal === "done" ? undefined
        : status === "failed" ? JSON.stringify(batch?.errors ?? {}).slice(0, 300) : status;
      const saved = await finishBatch(cur, st, { terminalStatus: terminal, error });
      if (saved && terminal === "done") {
        await deleteOpenAIFiles(apiKey, [...(cur.files ?? []), batch.output_file_id, batch.error_file_id]);
      }
    });
  } else if (["failed", "expired", "cancelled"].includes(status)) {
    await patchBatch(rec.id, {
      status: status === "cancelled" ? "cancelled" : "error",
      error: status === "failed" ? JSON.stringify(batch?.errors ?? {}).slice(0, 300) : status,
      completedAt: Date.now(), ingest: undefined, lease: undefined,
    }, { onlyActive: true });
  }
  // validating / in_progress / finalizing / cancelling → czekamy dalej.
}

export async function cancelOpenAI(apiKey, rec) {
  const res = await fetch(`${OPENAI_BASE}/batches/${rec.remoteId}/cancel`, {
    method: "POST", headers: auth(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(`OpenAI cancel ${res.status}: ${await readError(res)}`, res.status);
}
