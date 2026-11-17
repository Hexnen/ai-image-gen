// Strings of the system-pack registry (MAIG.Packs.*). Keys in lang/*.json win when present (game.i18n.has); otherwise
// the built-in EN/PL text below is used, so the registry never shows a raw key. PURE apart from the optional `game`.

const EN = {
  "MAIG.Packs.ImportFailed": "Moinens AI Gen: the AI builder pack for system \"{system}\" failed to load. Image generation works as before. Details in the console (F12).",
  "MAIG.Packs.Invalid": "Moinens AI Gen: the AI builder pack \"{pack}\" is incomplete ({problems}). The builder stays off; image generation works as before.",
  "MAIG.Packs.Blocked": "Moinens AI Gen: the AI builder for \"{system}\" is off until these are available: {missing}.",
  "MAIG.Packs.OptionalMissing": "Moinens AI Gen: optional module \"{module}\" is not available ({why}). The AI builder works without it; missing extras: {adds}.",
  "MAIG.Packs.NoPack": "The AI builder has no pack for system \"{system}\" yet.",
  "MAIG.Packs.NotGM": "The AI builder is for the GM only.",
  "MAIG.Packs.Unsupported": "The AI builder does not support this document type.",
  "MAIG.Packs.Failed": "The AI builder pack could not be loaded: {error}",
  "MAIG.Packs.Loading": "The AI builder is still loading.",
  "MAIG.Packs.SelfTestFailed": "The AI builder self-test failed: {error}",
  "MAIG.Packs.Why.NotInstalled": "not installed",
  "MAIG.Packs.Why.Inactive": "not enabled in this world",
  "MAIG.Packs.Why.Version": "version {have}, needs {need}",
  "MAIG.Packs.Why.Api": "its API lacks {api}"
};

const PL = {
  "MAIG.Packs.ImportFailed": "Moinens AI Gen: nie udało się wczytać pakietu kreatora AI dla systemu „{system}”. Generowanie obrazów działa jak dotąd. Szczegóły w konsoli (F12).",
  "MAIG.Packs.Invalid": "Moinens AI Gen: pakiet kreatora AI „{pack}” jest niekompletny ({problems}). Kreator jest wyłączony; generowanie obrazów działa jak dotąd.",
  "MAIG.Packs.Blocked": "Moinens AI Gen: kreator AI dla „{system}” jest wyłączony, dopóki brakuje: {missing}.",
  "MAIG.Packs.OptionalMissing": "Moinens AI Gen: opcjonalny moduł „{module}” jest niedostępny ({why}). Kreator AI działa bez niego; brakujące dodatki: {adds}.",
  "MAIG.Packs.NoPack": "Kreator AI nie ma jeszcze pakietu dla systemu „{system}”.",
  "MAIG.Packs.NotGM": "Kreator AI jest tylko dla MG.",
  "MAIG.Packs.Unsupported": "Kreator AI nie obsługuje tego typu dokumentu.",
  "MAIG.Packs.Failed": "Nie udało się wczytać pakietu kreatora AI: {error}",
  "MAIG.Packs.Loading": "Kreator AI jeszcze się wczytuje.",
  "MAIG.Packs.SelfTestFailed": "Autotest kreatora AI nie przeszedł: {error}",
  "MAIG.Packs.Why.NotInstalled": "nie jest zainstalowany",
  "MAIG.Packs.Why.Inactive": "nie jest włączony w tym świecie",
  "MAIG.Packs.Why.Version": "wersja {have}, potrzebna {need}",
  "MAIG.Packs.Why.Api": "jego API nie ma {api}"
};

const fill = (s, data) => String(s).replace(/\{(\w+)\}/g, (m, k) => (data && k in data ? String(data[k]) : m));

/** t(key, data, game) -> localized text. */
export function t(key, data = {}, game = globalThis.game) {
  try {
    if (game?.i18n?.has?.(key)) return game.i18n.format(key, data);
  } catch { /* fall through to the built-in text */ }
  const lang = String(game?.i18n?.lang ?? "en").toLowerCase();
  const dict = lang.startsWith("pl") ? PL : EN;
  return fill(dict[key] ?? EN[key] ?? key, data);
}

export const STRINGS = { EN, PL };
