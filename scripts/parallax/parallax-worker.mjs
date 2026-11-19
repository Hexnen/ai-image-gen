// W6-T: depth decode + conditioning off the main thread (module worker, started by parallax-load.mjs). Opening a sheet
// used to cost one ~0.9 s main-thread long task (conditionDepth on the full 941×1672 map); here the same pure pipeline
// (parallax-core.mjs prepareDepth: capped streaming PNG inflate, browser decode for WebP / JPEG, downscale, condition,
// half floats) runs in the worker and only the finished buffers come back (transferred, not copied).
// Message in: {id, bytes: ArrayBuffer, opts}; out: {id, ok: true, r} | {id, ok: false, error, code}. Nothing else: no
// network, no Foundry, no DOM.
import { prepareDepth } from "./parallax-core.mjs";

self.onmessage = async (ev) => {
  const { id, bytes, opts } = ev.data ?? {};
  if (id === "ping") { self.postMessage({ id, ok: true }); return; }
  try {
    const t0 = performance.now();
    const r = await prepareDepth(new Uint8Array(bytes), opts ?? {});
    r.ms = Math.round(performance.now() - t0);
    const transfer = [r.D?.buffer, r.mask?.buffer, r.cond?.rgba?.buffer, r.cond?.half?.buffer].filter(Boolean);
    self.postMessage({ id, ok: true, r }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e), code: e?.code ?? null });
  }
};
