// W6-U: conditions token depth maps off the main thread (downscale + conditionDepth + binary16 packing, ~50-550 ms
// per map), so loading many maps does not produce long tasks on the page. Pure code only (token-core.mjs).
// Message in: {id, src: {D, mask, w, h, bits, format}, maxSide}; out: {id, half, w, h} or {id, error}.
import { prepareDepthTexture } from "./token-core.mjs";

self.onmessage = (ev) => {
  const { id, src, maxSide } = ev.data ?? {};
  try {
    const r = prepareDepthTexture(src, maxSide);
    self.postMessage({ id, half: r.half, w: r.w, h: r.h }, [r.half.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e) });
  }
};
