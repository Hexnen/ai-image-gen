// W7-A AI Tile: przygotowanie zadania (wycinek, maska, prompt), Fast / Batch, zapis pliku i wklejenie Tile.
// UI w tile-app.mjs, rysowanie w tile-draw.mjs, czysta geometria w tile-core.mjs.
import { MODULE_ID, DATA_ROOT } from "../constants.mjs";
import { getKey } from "../settings.mjs";
import { getConfig, fitConfig } from "../config-store.mjs";
import * as providers from "../providers/index.mjs";
import { executeGeneration, estimateInfo } from "../generate-flow.mjs";
import { submitBatch } from "../batch/index.mjs";
import { saveImageBlobEx, slug } from "../save-image.mjs";
import { outputOptsFromConfig, statsPatch } from "../optimize.mjs";
import { updateCall } from "../call-log.mjs";
import {
  TILE_TYPE_KEY, DEFAULT_TILE_OPTS, DEFAULT_TILE_PROMPT, GUIDE_MASK, GUIDE_NONE, planRegion, contextPlan, positionText,
  inputEstimate, tileData, renderTilePrompt, gridInEdit, packGeometry, unpackGeometry, validShape
} from "./tile-core.mjs";
import { captureRegion, openaiMask, contextImage, processResult, canvasToBlob } from "./tile-image.mjs";

export const TILE_FLAG = "aiTile";
/**
 * Test seam (dev/live checks only): `execute` replaces executeGeneration with the same arguments and result shape, so a
 * live run can check what would be sent and feed a test image without any API key or paid call. null in normal use.
 */
export const tileTestHooks = { execute: null };
/** Plik kafelka: domyślnie do 4096 px dłuższego boku (typ może ustawić inaczej w sekcji Wyjście). */
export const TILE_OUT_EDGE = 4096;

export const tileDir = (scene) => `${DATA_ROOT}/tiles/${slug(scene?.name ?? "scene", "scene")}`;

/** Opcje okna (zapamiętane w ustawieniu świata `tileOptions`), uzupełnione domyślnymi. */
export function tileOptions() {
  let saved = {};
  try { saved = game.settings.get(MODULE_ID, "tileOptions") ?? {}; } catch { /* przed rejestracją */ }
  return { ...DEFAULT_TILE_OPTS, ...saved };
}

export async function saveTileOptions(o) {
  const clean = {
    feather: Math.min(256, Math.max(0, Math.round(Number(o.feather) || 0))),
    tokens: !!o.tokens,
    mask: o.mask !== false,
    count: Math.min(8, Math.max(1, Math.floor(Number(o.count)) || 1))
  };
  try { await game.settings.set(MODULE_ID, "tileOptions", clean); } catch (e) { console.warn(`${MODULE_ID} | tile options not saved`, e); }
  return clean;
}

/** Konfiguracja typu „AI Tile” z rozmiarem żądania z planu. */
export function requestConfig(plan, base = getConfig(TILE_TYPE_KEY)) {
  return fitConfig({
    ...base, width: plan.request.width, height: plan.request.height, custom: false, transparent: false,
    ...(plan.request.imageSize ? { imageSize: plan.request.imageSize } : {})
  });
}

/** Czy maska idzie do dostawcy (tylko OpenAI images/edits, tylko Fast). */
export const usesMask = (cfg, opts, mode = "fast") => cfg.provider === "openai" && opts.mask !== false && mode !== "batch";

/**
 * Przygotuj zadanie: obraz 1 (zaznaczenie, + maska OpenAI), obraz 2 (kontekst 2× z obrysem), prompt. Bez sieci
 * (oprócz wczytania plików przy złożeniu z plików).
 * @param {object} p
 * @param {Scene} p.scene
 * @param {{x,y}[]} p.points  prostokąt w px sceny (4 punkty)
 * @param {object} [p.opts]   opcje okna (feather, tokens, mask)
 * @param {string} [p.description]
 * @param {"fast"|"batch"} [p.mode]
 */
export async function prepareJob({ scene = canvas.scene, points, opts = tileOptions(), description = "", mode = "fast", method = "auto" }) {
  const v = validShape(points);
  if (!v.ok) throw new Error(game.i18n.localize(v.reason === "small" ? "AIIMG.Tile.ErrSmall" : "AIIMG.Tile.ErrShape"));
  if (!canvas.ready || canvas.scene?.id !== scene.id) throw new Error(game.i18n.localize("AIIMG.Tile.ErrScene"));
  const base = getConfig(TILE_TYPE_KEY);
  const bounds = canvas.dimensions.rect;
  const plan = planRegion({ points, bounds, cfg: base });
  const cfg = requestConfig(plan, base);
  const tileRect = plan.bbox;
  const ctxPlan = contextPlan(plan.bbox, bounds);
  const cap = await captureRegion(plan.region, plan.edit.width, plan.edit.height, { tokens: !!opts.tokens, method });
  const crop = cap.canvas;
  const ctxCap = await captureRegion(ctxPlan.rect, ctxPlan.size.width, ctxPlan.size.height, { tokens: !!opts.tokens, method: cap.method });
  const context = contextImage(ctxCap.canvas, ctxPlan.sel);
  const maskOn = usesMask(cfg, opts, mode);
  const maskCanvas = maskOn ? openaiMask(points, plan.region, plan.edit.width, plan.edit.height, 0) : null;
  const job = {
    id: foundry.utils.randomID(),
    sceneId: scene.id, sceneUuid: scene.uuid, sceneName: scene.name,
    points: points.map((p) => ({ x: p.x, y: p.y })),
    opts: { ...opts }, mode, plan, cfg, tileRect, ctxPlan,
    geom: { points, region: plan.region, tileRect, ratio: plan.ratio, feather: Number(opts.feather) || 0 },
    crop, cropBlob: await canvasToBlob(crop, "image/png"), captureMethod: cap.method,
    context, contextBlob: await canvasToBlob(context, "image/png"),
    mask: maskCanvas, maskBlob: maskCanvas ? await canvasToBlob(maskCanvas, "image/png") : null,
    input: inputEstimate(cfg, plan.edit, ctxPlan.size),
    description
  };
  job.prompt = buildJobPrompt(job, description);
  return job;
}

export function buildJobPrompt(job, description, { mask = !!job.maskBlob } = {}) {
  const scene = game.scenes.get(job.sceneId);
  const base = getConfig(TILE_TYPE_KEY);
  return renderTilePrompt(base.promptTemplate || DEFAULT_TILE_PROMPT, {
    description,
    grid: gridInEdit(scene?.grid?.size ?? 100, job.plan.edit, job.plan.region),
    distance: scene?.grid?.distance ?? "", units: scene?.grid?.units ?? "",
    scene: job.sceneName,
    pos: positionText(job.ctxPlan.sel),
    guide: mask ? GUIDE_MASK : GUIDE_NONE
  });
}

/** Obrazy wejściowe (do kosztu): zawsze 2 (zaznaczenie + kontekst); maska nie jest obrazem referencyjnym. */
export const INPUT_IMAGES = 2;

/** Szacunek kosztu (USD) dla UI. */
export function estimateJob(job, count = 1, mode = "fast") {
  const refs = (job.cfg.refs?.length ?? 0) + INPUT_IMAGES;
  return estimateInfo(job.cfg, refs, mode === "batch" ? "batch" : "sync").display * count;
}

export function readinessFor(cfg) {
  return {
    hasKey: !!getKey(cfg.provider),
    providerLabel: providers.PROVIDERS[cfg.provider]?.label ?? cfg.provider,
    modelLabel: providers.listModels(cfg.provider).find((m) => m.id === cfg.model)?.label ?? cfg.model,
    canBatch: providers.supportsBatchFor(cfg.provider, cfg.model),
    noBatchReason: providers.noBatchReason(cfg.provider, cfg.model)
  };
}

const metaFor = (job) => ({
  system: MODULE_ID, docType: "tile", name: `ai-tile-${slug(job.sceneName, "scene")}`, typeKey: TILE_TYPE_KEY,
  description: String(job.description ?? "").trim()
});

/**
 * Fast: `count` wariantów; każdy od razu przetworzony do kanwy kafelka (w pamięci, nic na dysku).
 * @returns {Promise<{candidates:{index, blob, tile:HTMLCanvasElement, cost, logId}[], failed, cost}>}
 */
export async function generateTileVariants(job, { count = 1, signal } = {}) {
  const doc = { name: `AI Tile: ${job.sceneName}`, uuid: job.sceneUuid, documentName: "Scene", type: "tile" };
  const res = await (tileTestHooks.execute ?? executeGeneration)({
    doc, description: job.description ?? "", key: TILE_TYPE_KEY, cfg: job.cfg, prompt: job.prompt, meta: metaFor(job),
    count, extraRefs: [job.contextBlob], signal, runKind: "fast", caller: "ai-tile",
    editImage: job.cropBlob, mask: job.maskBlob ?? undefined
  });
  const out = [];
  const failed = [...res.failed];
  for (const c of res.candidates) {
    try {
      const { canvas: tile } = await processResult(c.blob, job.geom, { maxEdge: outEdge(job.cfg) });
      out.push({ index: c.index, blob: c.blob, tile, cost: c.cost, logId: c.logId });
    } catch (e) {
      failed.push({ index: c.index, error: `Could not process the image: ${e.message}` });
    }
  }
  return { candidates: out, failed, cost: res.cost };
}

const outEdge = (cfg) => (Number(cfg?.outMaxEdge) > 0 ? Math.min(Number(cfg.outMaxEdge), 8192) : TILE_OUT_EDGE);

/** Ustawienia zapisu pliku kafelka: z typu, alfa wymuszona (JPEG -> WebP). */
export function tileSaveOpts(cfg) {
  const o = { ...outputOptsFromConfig(cfg), alpha: true };
  if (o.format === "jpeg") o.format = "webp";
  return o;
}

/**
 * Wklej Tile na scenie (idempotentnie po `flags.<mod>.aiTile.key`: ponowienie batcha nie tworzy duplikatu).
 * @returns {Promise<TileDocument>}
 */
export async function createTile(scene, tileRect, path, info = {}) {
  if (!scene) throw new Error(game.i18n.localize("AIIMG.Tile.ErrSceneGone"));
  if (info.key) {
    const dup = scene.tiles.find((t) => t.getFlag?.(MODULE_ID, TILE_FLAG)?.key === info.key);
    if (dup) return dup;
  }
  const data = tileData({
    bbox: tileRect, src: path,
    existing: scene.tiles.contents.map((t) => ({ elevation: t.elevation, sort: t.sort })),
    flags: { [MODULE_ID]: { [TILE_FLAG]: { ...info, createdAt: Date.now() } } }
  });
  const [doc] = await scene.createEmbeddedDocuments("Tile", [data]);
  return doc;
}

/** Akceptuj wariant Fast: zapis pliku (optymalizacja z typu) + Tile. @returns {Promise<{path, tile}>} */
export async function acceptVariant(job, cand) {
  const scene = game.scenes.get(job.sceneId);
  const blob = cand.tileBlob ?? (cand.tileBlob = await canvasToBlob(cand.tile, "image/png"));
  const { path, stats } = await saveImageBlobEx(blob, { dir: tileDir(scene), name: `ai-tile-${slug(job.description || "tile", "tile").slice(0, 32)}`, optimize: tileSaveOpts(job.cfg) });
  if (cand.logId) await updateCall(cand.logId, statsPatch(stats)).catch(() => {});
  const tile = await createTile(scene, job.tileRect, path, {
    key: `${job.id}-${cand.index}`, prompt: String(job.description ?? "").slice(0, 500), provider: job.cfg.provider, model: job.cfg.model
  });
  return { path, tile };
}

// ---------- Batch ----------

/** Wyślij zadanie jako batch (jak Batch w oknie generacji). Bez maski: obraz 1 + obraz 2 (kontekst). */
export async function submitTileBatch(job, { count = 1 } = {}) {
  if (!providers.supportsBatchFor(job.cfg.provider, job.cfg.model)) throw new Error(game.i18n.localize("AIIMG.Tile.ErrNoBatch"));
  const prompt = buildJobPrompt(job, job.description, { mask: false });
  const geometry = packGeometry({ sceneId: job.sceneId, bbox: job.tileRect, region: job.plan.region, ratio: job.plan.ratio, points: job.points, feather: job.geom.feather });
  // batch does not shrink references: send the context as the Fast path would (type's reference size rules)
  const { prepareRefs } = await import("../ref-convert.mjs");
  const ctx = (await prepareRefs([job.contextBlob], job.cfg, [""])).blobs[0] ?? job.contextBlob;
  const refs = [job.cropBlob, ctx];
  const meta = metaFor(job);
  const items = Array.from({ length: count }, (_, i) => ({
    id: foundry.utils.randomID(),
    prompt, refs, width: job.cfg.width, height: job.cfg.height, quality: job.cfg.quality, transparent: false,
    imageSize: job.cfg.imageSize, thinkingLevel: job.cfg.thinkingLevel,
    target: { uuid: job.sceneUuid, field: "tile" },
    meta: { ...meta, tile: geometry, ...(count > 1 ? { variant: i + 1, variants: count } : {}) }
  }));
  return submitBatch({ provider: job.cfg.provider, model: job.cfg.model, items, pick: count > 1 });
}

/** Geometria z rekordu batcha -> to, czego potrzebuje processResult / createTile. */
export function geomFromMeta(tile) {
  const g = unpackGeometry(tile);
  return { points: g.points, region: g.region, tileRect: g.bbox, ratio: g.ratio, feather: g.feather, sceneId: g.sceneId };
}

/**
 * Gałąź tile w batch/apply.mjs: przetworzenie wyniku, zapis (do kandydatów przy `rec.pick`) i Tile.
 * Kontrakt jak applyBatchItem: {ok, path, candidate?, stats?, error?, permanent?}.
 */
export async function applyTileBatchItem(item, blob, rec, savedPath, { candidateDir }) {
  const geom = geomFromMeta(item.meta.tile);
  const scene = game.scenes.get(geom.sceneId);
  let path = savedPath, stats = null;
  try {
    if (!scene) return { ok: false, error: `Document not found: Scene ${geom.sceneId}`, permanent: true };
    if (!path) {
      const cfg = getConfig(TILE_TYPE_KEY);
      const { canvas: tile } = await processResult(blob, geom, { maxEdge: outEdge(cfg) });
      const png = await canvasToBlob(tile, "image/png");
      const r = await saveImageBlobEx(png, { dir: rec?.pick ? candidateDir(rec.id) : tileDir(scene), name: item.meta?.name ?? "ai-tile", optimize: tileSaveOpts(cfg) });
      path = r.path; stats = r.stats;
    }
    if (rec?.pick) return { ok: true, path, candidate: true, stats };
    await createTile(scene, geom.tileRect, path, { key: `${rec?.id}-${item.id}`, batchId: rec?.id, prompt: String(item.meta?.description ?? "").slice(0, 500), provider: rec?.provider, model: rec?.model });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), path, ...(e?.reason ? { reason: e.reason } : {}) };
  }
  return { ok: true, path, stats };
}
