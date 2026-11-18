// Zapis wygenerowanego obrazu do Data/ i podpięcie go pod dokument (wspólne dla fast i batch).
import { DATA_ROOT } from "./constants.mjs";
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

/**
 * W6-K: upload error with the real reason. `reason`: "session" (the server did not accept this browser's HTTP login
 * session: the cookie is missing/expired, while the game socket still works), "permission" (no FILES_UPLOAD),
 * "refused" (the server answered with an error, shown in a Foundry notification), "network" (the request threw),
 * "unknown". `retryable`: worth retrying later / from another client.
 */
export class UploadError extends Error {
  constructor(message, { reason = "unknown", status, retryable = true } = {}) {
    super(message);
    this.name = "UploadError";
    this.reason = reason;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Foundry's FilePicker.upload hands the server's error text (`response.error`, HTTP 200 body) only to
 * ui.notifications.error and returns false. While our uploads run we tee those messages (still shown as before) so the
 * real reason reaches the batch record. No extra request: an HTTP probe would itself set a new session cookie and could
 * log out another tab of the same host.
 */
let sessionWarned = false;
let capturing = 0;
let captured = [];
let origError = null;
function beginCapture() {
  const n = globalThis.ui?.notifications;
  if (!n || typeof n.error !== "function") return () => [];
  if (capturing++ === 0) {
    origError = n.error;
    captured = [];
    n.error = function (msg, ...rest) { try { captured.push(String(msg ?? "")); } catch { /* ignore */ } return origError.call(this, msg, ...rest); };
  }
  const from = captured.length;
  return () => {
    const mine = captured.slice(from);
    if (--capturing === 0 && origError) { n.error = origError; origError = null; }
    return mine;
  };
}

/** Classify the server's upload error text. "User [] does not have permission" = no user on the HTTP session. */
export function classifyUploadMessage(msg) {
  const m = String(msg ?? "");
  if (/User \[\s*\] does not have permission to upload/i.test(m)) return "session";
  if (/does not have permission to upload/i.test(m)) return "permission";
  return m ? "refused" : "unknown";
}

const SESSION_HINT = "the server did not see a logged-in user on this browser's HTTP session (session cookie missing, expired or " +
  "overwritten, e.g. by another Foundry tab on the same host with a different port; the game socket still works). " +
  "Reload this page or log in again, then use Retry save.";

/**
 * FilePicker.upload with a real error. Foundry's upload swallows the reason: a server error becomes `false` (the text
 * goes only to a notification), a thrown fetch becomes `{}`. This keeps going through FilePicker.upload (other modules
 * wrap it, e.g. local-media-optimizer) and only explains the failure.
 * Throws UploadError {reason: "session" | "permission" | "refused" | "network" | "unknown", retryable}.
 * @returns {Promise<{path:string}>}
 */
export async function uploadOrThrow(dir, file, options = {}) {
  let res, thrown = null;
  const end = beginCapture();
  let msgs;
  try { res = await FP().upload("data", dir, file, {}, { notify: false, ...options }); }
  catch (e) { thrown = e; }
  finally { msgs = end(); }
  if (res?.path) return res;
  const where = `${dir}/${file?.name ?? "file"}`;
  const server = msgs.find((m) => /upload|permission|file/i.test(m)) ?? msgs[0] ?? "";
  const kind = classifyUploadMessage(server);
  if (kind === "session") {
    if (!sessionWarned) {   // once per page load: Foundry's own text ("User [] does not have permission") is cryptic
      sessionWarned = true;
      try { ui.notifications.warn(`Moinens AI Gen: ${SESSION_HINT}`, { permanent: true }); } catch { /* UI not ready */ }
    }
    throw new UploadError(`Upload failed for ${where}: ${SESSION_HINT} (server: "${server}")`, { reason: "session", retryable: false });
  }
  if (kind === "permission" || (game.user && typeof game.user.can === "function" && !game.user.can("FILES_UPLOAD"))) {
    throw new UploadError(`Upload failed for ${where}: user "${game.user?.name ?? "?"}" may not upload files${server ? ` (server: "${server}")` : ""}`,
      { reason: "permission", retryable: false });
  }
  if (thrown) throw new UploadError(`Upload failed for ${where}: ${thrown?.message ?? thrown}`, { reason: "network" });
  if (server) throw new UploadError(`Upload failed for ${where}: server said "${server}"`, { reason: "refused" });
  throw new UploadError(`Upload failed for ${where}: no path in the server response (network error, or a response that was not JSON)`, { reason: "unknown" });
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
  const dir = dirOverride ?? `${DATA_ROOT}/${slug(system, "core")}/${slug(docType, "doc")}`;
  await ensureDir(dir);
  const filename = `${slug(name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${EXT[type] ?? "png"}`;
  const file = new File([data], filename, { type });
  // `optimized: true` tells local-media-optimizer's upload hook not to encode the file a second time.
  const res = await uploadOrThrow(dir, file, stats && stats.via !== "error" ? { optimized: true } : {});
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
  return `${DATA_ROOT}/_refs/${slug(system, "core")}/${slug(rest.join("-"), "type")}`;
}

/** Folder for saved test samples of an image type key (`ai-image-gen/_tests/<system>/<type>`). */
export function testsDirFor(typeKey) {
  const [system = "core", ...rest] = String(typeKey).split(".");
  return `${DATA_ROOT}/_tests/${slug(system, "core")}/${slug(rest.join("-"), "type")}`;
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
  const res = await uploadOrThrow(dir, new File([data], filename, { type: outType }), flag ? { optimized: true } : {});
  return res.path;
}

/** Set `field` (dot-path, default "img") on the document with the given UUID. */
export async function applyImage(uuid, path, field = "img") {
  const doc = await fromUuid(uuid);
  if (!doc) throw new Error(`Document not found: ${uuid}`);
  await doc.update({ [field]: path });
  return doc;
}
