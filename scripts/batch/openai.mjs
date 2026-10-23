// OpenAI Batch API (/v1/batches) dla obrazów. Port z roleplay workshopBatch/openai.ts.
// Jeden endpoint na batch: edits (gdy itemy mają referencje) albo generations (gdy nie).
import { mimeOf, blobToB64, b64ToBlob } from "../providers/util.mjs";
import { UPLOAD_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, readError, jsonl, parseJsonl, uniqueRefs } from "./util.mjs";
import { openaiBatchCost } from "./cost.mjs";
import { openaiSizeFor, fitOpenAIQuality } from "../providers/models.mjs";
import { patchBatch, markIngested } from "./record.mjs";
import { applyBatchItem } from "./apply.mjs";
import { logBatchResult, tokensFrom } from "../call-log.mjs";

export const OPENAI_BASE = "https://api.openai.com/v1";
const auth = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });
const EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };

/** Rozmiar linii batcha: dla 2.5 dokładny (po normalizacji), dla starszych koszyk. */
export const openaiSize = (width, height, model = "gpt-image-2") => openaiSizeFor(model, { width, height });

async function uploadFile(apiKey, purpose, filename, blob) {
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("file", blob, filename);
  const res = await fetch(`${OPENAI_BASE}/files`, {
    method: "POST", headers: auth(apiKey), body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI files (${purpose}) ${res.status}: ${await readError(res)}`);
  const json = await res.json();
  if (!json?.id) throw new Error("OpenAI files: brak id w odpowiedzi");
  return json.id;
}

/** Wysyła batch. @returns {{remoteId:string, endpoint:string}} */
export async function submitOpenAI({ apiKey, model, items }) {
  const withRefs = items.filter((i) => i.refs?.length).length;
  if (withRefs && withRefs !== items.length) {
    throw new Error("OpenAI batch: wszystkie itemy muszą mieć referencje albo żaden (jeden endpoint na batch).");
  }
  const endpoint = withRefs ? "/v1/images/edits" : "/v1/images/generations";

  // Referencje RAZ (po tożsamości Blob): file_id (purpose vision), fallback → data URL.
  const refInput = new Map();
  let n = 0;
  for (const blob of uniqueRefs(items)) {
    const mime = await mimeOf(blob);
    try {
      const id = await uploadFile(apiKey, "vision", `ref-${n++}.${EXT[mime] ?? "png"}`, blob);
      refInput.set(blob, { file_id: id });
    } catch (e) {
      console.warn("ai-image-gen | OpenAI vision upload failed, falling back to image_url", e);
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
    },
  }));

  const inputId = await uploadFile(
    apiKey, "batch", `ai-image-gen-${Date.now()}.jsonl`,
    new Blob([jsonl(lines)], { type: "application/jsonl" }),
  );
  const res = await fetch(`${OPENAI_BASE}/batches`, {
    method: "POST",
    headers: { ...auth(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ input_file_id: inputId, endpoint, completion_window: "24h" }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI batches ${res.status}: ${await readError(res)}`);
  const json = await res.json();
  if (!json?.id) throw new Error("OpenAI batches: brak id w odpowiedzi");
  return { remoteId: json.id, endpoint };
}

async function fileContent(apiKey, fileId) {
  const res = await fetch(`${OPENAI_BASE}/files/${fileId}/content`, {
    headers: auth(apiKey), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI files/content ${res.status}: ${await readError(res)}`);
  return res.text();
}

async function getRemote(apiKey, remoteId) {
  const res = await fetch(`${OPENAI_BASE}/batches/${remoteId}`, {
    headers: auth(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI batches/get ${res.status}`);
  return res.json();
}

/** Wyniki → pliki + dokumenty. Wznawialne po rec.ingest.ids; mapowanie po custom_id. */
async function ingest(apiKey, rec, batch) {
  const done = new Set(rec.ingest?.ids ?? []);
  const applyFailed = [...(rec.ingest?.failed ?? [])];
  const out = { applied: done.size - applyFailed.length, failed: [...applyFailed], cost: rec.ingest?.cost ?? 0 };
  const byId = new Map(rec.items.map((i) => [i.id, i]));
  if (batch.output_file_id) {
    for (const row of parseJsonl(await fileContent(apiKey, batch.output_file_id))) {
      const id = String(row?.custom_id ?? "");
      const item = byId.get(id);
      if (!item || done.has(id)) continue;
      const body = row?.response?.body;
      const b64 = body?.data?.[0]?.b64_json;
      if (!b64) {
        out.failed.push({ id, error: "brak obrazu w odpowiedzi batcha" });
        await logBatchResult(rec, id, { ok: false, error: "brak obrazu w odpowiedzi batcha", tokens: tokensFrom(body) });
        continue;
      }
      const cost = openaiBatchCost(body?.usage);
      const r = await applyBatchItem(item, b64ToBlob(b64, "image/png"), cost);
      await logBatchResult(rec, id, { ok: r.ok, error: r.error, cost, tokens: tokensFrom(body) });
      out.cost += cost;
      done.add(id); // przetworzony (koszt już naliczony) — nie powtarzamy po wznowieniu
      if (!r.ok) { applyFailed.push({ id, error: r.error }); out.failed.push({ id, error: r.error }); }
      out.applied = done.size - applyFailed.length;
      if (!(await markIngested(rec.id, done, out.cost, applyFailed))) break;
    }
  }
  if (batch.error_file_id) {
    for (const row of parseJsonl(await fileContent(apiKey, batch.error_file_id))) {
      const failure = {
        id: String(row?.custom_id ?? "?"),
        error: String(row?.error?.message || row?.response?.body?.error?.message || "błąd"),
      };
      out.failed.push(failure);
      await logBatchResult(rec, failure.id, { ok: false, error: failure.error });
    }
  }
  return out;
}

export async function checkOpenAI(apiKey, rec) {
  const batch = await getRemote(apiKey, rec.remoteId);
  const status = String(batch?.status ?? "");
  if (status === "completed") {
    let r;
    try {
      r = await ingest(apiKey, rec, batch);
    } catch (e) {
      // Pliki wynikowe żyją 30 dni — po wygaśnięciu nie wisimy w pending w nieskończoność.
      if (/files\/content (404|410)/.test(String(e?.message))) {
        await patchBatch(rec.id, {
          status: "error", error: "wyniki batcha wygasły u OpenAI (30 dni)", completedAt: Date.now(), ingest: undefined,
        }, { onlyActive: true });
        return;
      }
      throw e; // błąd przejściowy: zostaje pending, kolejna próba w następnym ticku
    }
    await patchBatch(rec.id, {
      status: "done", completedAt: Date.now(), applied: r.applied, failed: r.failed, cost: r.cost, ingest: undefined,
    }, { onlyActive: true });
  } else if (["failed", "expired", "cancelled"].includes(status)) {
    // expired/cancelled: część mogła się policzyć — zbierz, co jest.
    const r = batch?.output_file_id ? await ingest(apiKey, rec, batch).catch(() => null) : null;
    await patchBatch(rec.id, {
      status: status === "cancelled" ? "cancelled" : "error",
      error: status === "failed" ? JSON.stringify(batch?.errors ?? {}).slice(0, 300) : status,
      completedAt: Date.now(),
      applied: r?.applied ?? 0, failed: r?.failed ?? [], cost: r?.cost ?? null, ingest: undefined,
    }, { onlyActive: true });
  }
  // validating / in_progress / finalizing / cancelling → czekamy dalej.
}

export async function cancelOpenAI(apiKey, rec) {
  const res = await fetch(`${OPENAI_BASE}/batches/${rec.remoteId}/cancel`, {
    method: "POST", headers: auth(apiKey), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI cancel ${res.status}: ${await readError(res)}`);
}
