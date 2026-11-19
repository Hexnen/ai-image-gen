// W6-I: entry points of "Dodaj głębię" (GM only): the button next to the sheet image's wand, `api.depth` for macros and
// other modules. The heavy code (window, engine, vendored library) is imported on first use.
import { resolveTypeKey } from "../image-types.mjs";
import { getConfig } from "../config-store.mjs";

const openApp = (o) => import("./depth-app.mjs").then((m) => m.DepthApp.open(o));

/** A real image file (not the core default icons / mystery man). */
export const hasRealImage = (img) => !!img && !/^icons\/svg\//.test(img) && !/\.svg$/i.test(img);

/** Button for a document's image, or null when depth is off for its type. */
export function depthButtonFor(doc) {
  if (!game.user.isGM) return null;
  const key = resolveTypeKey(doc);
  if (!key || !hasRealImage(doc.img)) return null;
  let on = false;
  try { on = !!getConfig(key).depth?.enabled; } catch { on = false; }
  if (!on) return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "aiimg-btn aiimg-depth-btn";
  b.dataset.tooltip = game.i18n.localize("AIIMG.DepthRun.Button");
  b.setAttribute("aria-label", b.dataset.tooltip);
  b.innerHTML = '<i class="fa-solid fa-layer-group"></i>';
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openApp({ path: doc.img, typeKey: key });
  });
  return b;
}

let registered = false;
export function registerDepth() {
  if (registered) return;
  registered = true;
  Hooks.on("aiImageGen.ready", (api) => {
    if (!game.user.isGM || !api) return;
    api.depth = {
      /** Open the window, optionally on an image path and with a type's depth settings. */
      open: ({ path = "", typeKey = "" } = {}) => openApp({ path, typeKey }),
      /**
       * Run without the window; `depth` = cfg.depth (defaults when omitted). Paid / download confirmations are still asked.
       * W6-R: `signal` cancels before the paid call; `recover` = the `e.recover` of a failed generative run (or
       * {candidatePath}) saves that paid picture again without a new call.
       */
      run: async ({ path, typeKey = "", depth, signal = null, recover = null } = {}) => {
        const [{ runDepth }, { normalizeDepth }] = await Promise.all([import("./run.mjs"), import("../depth-settings.mjs")]);
        const d = normalizeDepth(depth ?? (typeKey ? getConfig(typeKey).depth : {}), { webgpu: !!navigator.gpu });
        const { DialogV2 } = foundry.applications.api;
        const ask = (title, text) => DialogV2.confirm({ window: { title }, content: `<p>${foundry.utils.escapeHTML(text)}</p>`, rejectClose: false, modal: true });
        return runDepth({
          path, depth: d, typeKey, signal, recover,
          ui: {
            confirmDownload: (items) => ask(game.i18n.localize("AIIMG.DepthRun.DlTitle"), items.map((i) => `${i.repo} ${i.dtype} ${i.sizeMB} MB`).join(", ")),
            confirmPaid: (est) => ask(game.i18n.localize("AIIMG.DepthRun.PaidTitle"), `${est.modelLabel}: ~$${(est.usd ?? 0).toFixed(3)}`)
          }
        });
      },
      probeWebGPU: () => import("./engine.mjs").then((m) => m.probeWebGPU()),
      release: () => import("./engine.mjs").then((m) => m.releaseAll())
    };
  });
}
