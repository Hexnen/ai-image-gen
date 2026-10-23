// Zapis wygenerowanego obrazu do Data/ i podpięcie go pod dokument (wspólne dla fast i batch).
import { MODULE_ID } from "./constants.mjs";
import { optimizeForSave, optimizeEnabled, REF_OUTPUT, fmtBytes } from "./optimize.mjs";

const FP = () => foundry.applications.apps.FilePicker.implementation;

/** Nazwy zastrzeżone przez Windows (jako katalog/plik tworzyłyby kłopoty): dostają prefiks. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export const slug = (s, fallback = "image") => {
  const v = String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
  return RESERVED.test(v) ? `_${v}` : v;
};

/** Typ obrazu po magic bytes (nie ufamy file.type ani MIME z odpowiedzi): png | jpeg | webp | gif | avif | null. */
export function sniffMime(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^(avif|avis)$/.test(ascii(8, 12))) return "image/avif";
  return null;
}

const sniffBlob = async (blob) => sniffMime(await blob.slice(0, 16).arrayBuffer());

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
 * With `optimize` ({maxEdge, quality, format}) the image is shrunk/re-encoded first (see optimize.mjs; skipped when
 * the world setting "Optimize AI images" is off, then the old plain WebP re-encode applies). `preOptimized` is an
 * earlier optimizeForSave result for this same blob (the picker measures candidates up front).
 * @returns {Promise<{path:string, stats:object}>} stored path and the optimization stats (bytes before/after, via)
 */
export async function saveImageBlobEx(blob, { system = "core", docType = "Document", name = "image", webp = true, dir: dirOverride, optimize, preOptimized } = {}) {
  let data, stats = null;
  if (preOptimized && preOptimized.via !== "error") { stats = preOptimized; data = stats.blob; }
  else if (optimize && optimizeEnabled()) { stats = await optimizeForSave(blob, optimize); data = stats.blob; }
  else data = webp ? await blobToWebp(blob) : blob;
  const type = (await sniffBlob(data)) ?? (data.type || "image/png");
  const dir = dirOverride ?? `${MODULE_ID}/${slug(system, "core")}/${slug(docType, "doc")}`;
  await ensureDir(dir);
  const filename = `${slug(name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${EXT[type] ?? "png"}`;
  const file = new File([data], filename, { type });
  // `optimized: true` tells local-media-optimizer's upload hook not to encode the file a second time.
  const res = await FP().upload("data", dir, file, {}, { notify: false, ...(stats && stats.via !== "error" ? { optimized: true } : {}) });
  if (!res?.path) throw new Error(`Upload failed for ${dir}/${filename}`);
  return {
    path: res.path,
    stats: stats ?? { changed: data !== blob, bytesBefore: blob.size, bytesAfter: data.size, via: "off", blob: data }
  };
}

/** Like saveImageBlobEx, path only (older call sites). */
export async function saveImageBlob(blob, opts) {
  return (await saveImageBlobEx(blob, opts)).path;
}

export const MAX_REF_BYTES = 20 * 1024 * 1024;
// Stałe referencje trafiają później do dostawców, którzy przyjmują tylko png/jpeg/webp.
const REF_EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };

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

/** Save one test-drawer result (only on the user's explicit click). @returns {Promise<{path:string, stats:object}>} */
export function saveTestExampleEx(blob, typeKey, name = "test", optimize) {
  return saveImageBlobEx(blob, { dir: testsDirFor(typeKey), name, optimize });
}

/** Save one test-drawer result, path only. */
export async function saveTestExample(blob, typeKey, name = "test", optimize) {
  return (await saveTestExampleEx(blob, typeKey, name, optimize)).path;
}

/**
 * Upload original bytes (no re-encoding) of a reference image to `ai-image-gen/_refs/<system>/<type>/`.
 * Throws for non-images and files over 20 MB.
 * @returns {Promise<string>} stored path
 */
export async function saveRefFile(file, typeKey) {
  if (!file) throw new Error("No file");
  if (file.size > MAX_REF_BYTES) throw new Error(`${file.name}: larger than ${MAX_REF_BYTES / 1048576} MB`);
  // Typ z zawartości, nie z file.type (SVG/HTML przebrany za .png nie przejdzie).
  const type = await sniffBlob(file);
  if (!type || !REF_EXT[type]) throw new Error(`${file.name ?? "file"}: not a PNG, JPEG or WebP image`);
  const dir = refsDirFor(typeKey);
  await ensureDir(dir);
  const base = (file.name ?? "").replace(/\.[^.]+$/, "");
  // Oversized references only cost upload bandwidth and tokens: shrink them (never enlarge; keep the original when not smaller).
  let data = file, outType = type, flag = false;
  if (optimizeEnabled()) {
    const stats = await optimizeForSave(file, { ...REF_OUTPUT, kind: "ref" });
    if (stats.via !== "error") flag = true;
    if (stats.changed) {
      const t = (await sniffBlob(stats.blob)) ?? stats.blob.type;
      if (REF_EXT[t]) { data = stats.blob; outType = t; }
    }
  }
  const filename = `${slug(base, "ref")}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${REF_EXT[outType]}`;
  const res = await FP().upload("data", dir, new File([data], filename, { type: outType }), {}, { notify: false, ...(flag ? { optimized: true } : {}) });
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
