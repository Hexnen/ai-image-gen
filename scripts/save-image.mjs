// Zapis wygenerowanego obrazu do Data/ i podpięcie go pod dokument (wspólne dla fast i batch).
import { MODULE_ID } from "./constants.mjs";

const FP = () => foundry.applications.apps.FilePicker.implementation;

const slug = (s, fallback = "image") =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;

const EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };

/** Re-encode to WebP via canvas. Any failure (no canvas, decode error) returns the original blob. */
export async function blobToWebp(blob, quality = 0.92) {
  try {
    if (blob.type === "image/webp") return blob;
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    const out = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
    return out?.type === "image/webp" ? out : blob;
  } catch {
    return blob;
  }
}

export async function ensureDir(path) {
  let cur = "";
  for (const p of path.split("/")) {
    cur = cur ? `${cur}/${p}` : p;
    try { await FP().createDirectory("data", cur); }
    catch { /* already exists */ }
  }
}

/**
 * Upload a blob to `ai-image-gen/<system>/<docType>/` in the user Data folder (or to `dir` when given).
 * @returns {Promise<string>} path usable as `img`
 */
export async function saveImageBlob(blob, { system = "core", docType = "Document", name = "image", webp = true, dir: dirOverride } = {}) {
  const data = webp ? await blobToWebp(blob) : blob;
  const type = data.type || "image/png";
  const dir = dirOverride ?? `${MODULE_ID}/${slug(system, "core")}/${slug(docType, "doc")}`;
  await ensureDir(dir);
  const filename = `${slug(name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${EXT[type] ?? "png"}`;
  const file = new File([data], filename, { type });
  const res = await FP().upload("data", dir, file, {}, { notify: false });
  if (!res?.path) throw new Error(`Upload failed for ${dir}/${filename}`);
  return res.path;
}

export const MAX_REF_BYTES = 20 * 1024 * 1024;
const REF_EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif" };

/** Folder for the permanent references of an image type key (`<system>.<Doc>.<type>`). */
export function refsDirFor(typeKey) {
  const [system = "core", ...rest] = String(typeKey).split(".");
  return `${MODULE_ID}/_refs/${slug(system, "core")}/${slug(rest.join("-"), "type")}`;
}

/** Folder for saved test samples of an image type key (`ai-image-gen/_tests/<system>/<type>`). */
export function testsDirFor(typeKey) {
  const [system = "core", ...rest] = String(typeKey).split(".");
  return `${MODULE_ID}/_tests/${slug(system, "core")}/${slug(rest.join("-"), "type")}`;
}

/** Save one test-drawer result (only on the user's explicit click). @returns {Promise<string>} stored path */
export function saveTestExample(blob, typeKey, name = "test") {
  return saveImageBlob(blob, { dir: testsDirFor(typeKey), name });
}

/**
 * Upload original bytes (no re-encoding) of a reference image to `ai-image-gen/_refs/<system>/<type>/`.
 * Throws for non-images and files over 20 MB.
 * @returns {Promise<string>} stored path
 */
export async function saveRefFile(file, typeKey) {
  if (!file?.type?.startsWith("image/")) throw new Error(`${file?.name ?? "file"}: not an image`);
  if (file.size > MAX_REF_BYTES) throw new Error(`${file.name}: larger than ${MAX_REF_BYTES / 1048576} MB`);
  const dir = refsDirFor(typeKey);
  await ensureDir(dir);
  const base = (file.name ?? "").replace(/\.[^.]+$/, "");
  const filename = `${slug(base, "ref")}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${REF_EXT[file.type] ?? "png"}`;
  const res = await FP().upload("data", dir, new File([file], filename, { type: file.type }), {}, { notify: false });
  if (!res?.path) throw new Error(`Upload failed for ${dir}/${filename}`);
  return res.path;
}

/** Set `field` (dot-path, default "img") on the document with the given UUID. */
export async function applyImage(uuid, path, field = "img") {
  const doc = await fromUuid(uuid);
  if (!doc) throw new Error(`Document not found: ${uuid}`);
  await doc.update({ [field]: path });
  return doc;
}
