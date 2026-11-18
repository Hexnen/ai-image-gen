// GM-only window for the API keys (W5-F, bughunt-2 #1). The four key settings and the builder pre-warm are client-scope
// settings registered with `config: false`: v14's Configure Settings hides only WORLD settings from players (`restricted`
// does nothing for client settings), so a `config: true` key would show up, in clear text, in every player's settings
// window. They are edited here instead: a settings menu registered with `restricted: true` (hidden from users without
// SETTINGS_MODIFY), password inputs (masked, with a show toggle), and a GM check before every render.
// Storage is unchanged (`<module>.apiKey.<p>` in this browser's localStorage), so stored values and the migration from the
// old id (migrate-id.mjs) keep working. localStorage itself is readable by anyone who uses this browser profile.

import { MODULE_ID, PROVIDER_IDS } from "./constants.mjs";
import { checkApiKey } from "./key-check.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** client settings edited here (order = order in the window) */
export const KEY_SETTINGS = Object.freeze([...PROVIDER_IDS.map((p) => `apiKey.${p}`), "apiKey.anthropic"]);
const PREWARM = "build.prewarm";
const APP_ID = `${MODULE_ID}-keys`;

const has = (key) => game.settings.settings.has(`${MODULE_ID}.${key}`);
const get = (key) => { try { return game.settings.get(MODULE_ID, key); } catch { return undefined; } };

export class ApiKeysApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "form",
    classes: ["aiimg-keys"],
    window: { title: "AIIMG.Keys.Title", icon: "fa-solid fa-key", contentClasses: ["standard-form"] },
    position: { width: 520, height: "auto" },
    form: { handler: ApiKeysApp.#onSubmit, closeOnSubmit: true },
    actions: { reveal: ApiKeysApp.#onReveal }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/keys.hbs` }
  };

  /** Open (or focus) the window. GM only; returns null for anyone else. */
  static open() {
    if (!game.user?.isGM) return null;
    const app = foundry.applications.instances.get(APP_ID) ?? new ApiKeysApp();
    app.render({ force: true });
    return app;
  }

  /** a player never renders it, whatever opened it (the menu is restricted; this is the second lock) */
  _canRender(options) {
    if (!game.user?.isGM) return false;
    return super._canRender?.(options);
  }

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const show = game.i18n.localize("AIIMG.Keys.Show");
    const keys = KEY_SETTINGS.filter(has).map((key) => {
      const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
      return {
        name: key,
        id: `${this.id}-${key.replace(/\W/g, "-")}`,
        label: game.i18n.localize(cfg?.name ?? key),
        hint: cfg?.hint && cfg.hint !== "AIIMG.Settings.ApiKey.Hint" ? game.i18n.localize(cfg.hint) : "",
        value: String(get(key) ?? ""),
        // W6-B: a stored key that still has a visible non-ASCII character (saved before the check) is flagged
        bad: !checkApiKey(get(key)).ok
      };
    });
    const prewarm = has(PREWARM) ? {
      name: PREWARM,
      id: `${this.id}-prewarm`,
      label: game.i18n.localize("MAIG.Settings.Build.Prewarm.Name"),
      hint: game.i18n.localize("MAIG.Settings.Build.Prewarm.Hint"),
      checked: get(PREWARM) !== false
    } : null;
    return Object.assign(ctx, { keys, prewarm, show, badText: game.i18n.localize("AIIMG.Keys.NonAscii") });
  }

  /** eye button: show / hide one key (the input stays a password input otherwise) */
  static #onReveal(event, target) {
    const input = this.element.querySelector(`input[name="${CSS.escape(target.dataset.target ?? "")}"]`);
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    target.setAttribute("aria-pressed", String(reveal));
    target.classList.toggle("fa-eye", !reveal);
    target.classList.toggle("fa-eye-slash", reveal);
  }

  static async #onSubmit(event, form, formData) {
    if (!game.user?.isGM) return;
    const data = formData.object;
    // W6-B: strip invisible characters of a pasted key (NBSP, zero-width, BOM, newline...); a key with a visible
    // non-ASCII character (e.g. "…") is not saved and its field is marked. The other fields are saved as usual.
    const refused = [];
    for (const key of KEY_SETTINGS) {
      if (!has(key) || !(key in data)) continue;
      const { key: v, ok } = checkApiKey(data[key]);
      const input = form?.querySelector?.(`input[name="${CSS.escape(key)}"]`);
      if (!ok) {
        refused.push(game.i18n.localize(game.settings.settings.get(`${MODULE_ID}.${key}`)?.name ?? key));
        input?.setAttribute("aria-invalid", "true");
        continue;
      }
      input?.removeAttribute("aria-invalid");
      if (input && input.value !== v) input.value = v;
      if (v !== String(get(key) ?? "")) await game.settings.set(MODULE_ID, key, v);
    }
    if (has(PREWARM)) {
      const v = !!data[PREWARM];
      if (v !== (get(PREWARM) !== false)) await game.settings.set(MODULE_ID, PREWARM, v);
    }
    // throwing keeps the window open (ApplicationV2 shows the error as a notification and skips closeOnSubmit);
    // the text names the field only, never the value
    if (refused.length) throw new Error(game.i18n.format("AIIMG.Keys.NonAsciiField", { keys: refused.join(", ") }));
    ui.notifications.info(game.i18n.localize("AIIMG.Keys.Saved"));
  }
}

/** Settings menu (init): GM-only entry in Configure Settings -> this module. */
export function registerKeysMenu() {
  game.settings.registerMenu(MODULE_ID, "keys", {
    name: "AIIMG.Keys.MenuName",
    label: "AIIMG.Keys.MenuLabel",
    hint: "AIIMG.Keys.MenuHint",
    icon: "fa-solid fa-key",
    type: ApiKeysApp,
    restricted: true
  });
}

export const openKeys = () => ApiKeysApp.open();
