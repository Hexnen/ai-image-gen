// Strings of the builder harness (MAIG.Build.*) and its settings (MAIG.Settings.Build.*), EN/PL. Keys present in
// lang/*.json win (game.i18n.has); otherwise the built-in text is used. PURE apart from the optional `game`.

const EN = {
  "MAIG.Build.Cap.requests": "The AI needed more steps than allowed ({max} requests for one message). Say \"continue\" or simplify the request.",
  "MAIG.Build.Cap.toolCalls": "The AI reached the limit of {max} tool calls for one message. Say \"continue\" or simplify the request.",
  "MAIG.Build.Cap.invalidSubmits": "The proposal failed validation {max} times in a row. The last draft and its errors are shown.",
  "MAIG.Build.Cap.identicalInvalid": "The AI submitted the same invalid proposal again (same errors); stopped because it was looping.",
  "MAIG.Build.Cap.cost": "Stopped: the next step would exceed the cost cap of ${max} per message (spent ${spent}).",
  "MAIG.Build.Cap.wall": "Stopped after {minutes} min (time limit for one message).",
  "MAIG.Build.Stop.user": "Stopped.",
  "MAIG.Build.Stop.refusal": "The model declined this request.",
  "MAIG.Build.Stop.maxTokens": "The answer was cut off at the output limit. Say \"continue\".",
  "MAIG.Build.Stop.context": "The conversation no longer fits the model's context. Start a new conversation.",
  "MAIG.Build.HistoryFull": "This conversation is too long (about {tokens} tokens). Start a new conversation.",
  "MAIG.Build.Limit": "Blocked by the module's spending limits: {message}",
  "MAIG.Build.Error": "The request failed ({kind}): {detail}",
  "MAIG.Build.NoKey": "No Anthropic API key. Enter it in the module settings (it stays in this browser).",
  "MAIG.Build.NoPack": "The AI builder is not available for this document.",
  "MAIG.Build.Busy": "The AI is still working on the previous message.",
  "MAIG.Build.Empty": "Write a message first.",
  "MAIG.Build.SheetFailed": "The sheet could not be read for the AI ({error}); this message goes without it.",
  "MAIG.Build.Storage": "This browser could not save the conversation; it lasts until the page is reloaded.",
  "MAIG.Build.SettingsDrift": "The model or effort setting changed; this conversation keeps {model} / {effort}. Start a new conversation to use the new setting.",
  "MAIG.Build.PrefixChanged": "The rules or catalogue changed since the last message; the next request rebuilds the prompt cache.",
  "MAIG.Settings.Build.Model.Name": "AI builder: model",
  "MAIG.Settings.Build.Model.Hint": "Claude model of the character/item builder. Default claude-sonnet-5-5. A change applies to new conversations.",
  "MAIG.Settings.Build.Effort.Name": "AI builder: effort",
  "MAIG.Settings.Build.Effort.Hint": "Reasoning effort of the builder. Default medium. A change applies to new conversations.",
  "MAIG.Settings.Build.CacheTtl.Name": "AI builder: prompt cache lifetime",
  "MAIG.Settings.Build.CacheTtl.Hint": "How long the shared rules/catalogue prompt stays cached: 1 h (default, for bursty use) or 5 min.",
  "MAIG.Settings.Build.MaxCost.Name": "AI builder: cost cap per message (USD)",
  "MAIG.Settings.Build.MaxCost.Hint": "One GM message stops before a request that would exceed this (estimate + spent). 0 = no cap. The daily/monthly limits apply as well.",
  "MAIG.Settings.Build.MaxRequests.Name": "AI builder: model requests per message",
  "MAIG.Settings.Build.MaxRequests.Hint": "How many model requests one GM message may use (search, read, submit...).",
  "MAIG.Settings.Build.MaxToolCalls.Name": "AI builder: tool calls per message",
  "MAIG.Settings.Build.MaxToolCalls.Hint": "Maximum tool calls (catalogue searches, reads, checks) for one GM message.",
  "MAIG.Settings.Build.MaxInvalid.Name": "AI builder: invalid proposals in a row",
  "MAIG.Settings.Build.MaxInvalid.Hint": "Stop after this many proposals in a row failed validation.",
  "MAIG.Settings.Build.MaxMinutes.Name": "AI builder: minutes per message",
  "MAIG.Settings.Build.MaxMinutes.Hint": "Wall-clock limit for one GM message.",
  "MAIG.Settings.Build.Prewarm.Name": "AI builder: pre-warm the prompt cache",
  "MAIG.Settings.Build.Prewarm.Hint": "When a builder drawer opens, write the shared prompt to the cache with one cheap request (skipped when it is still warm).",
  "MAIG.Settings.Build.EndTurnOnSubmit.Name": "AI builder: end the turn after a proposal",
  "MAIG.Settings.Build.EndTurnOnSubmit.Hint": "When the AI submits a valid proposal, its turn ends at once (one request fewer); the proposal's rationale is its answer. Off: the AI gets one more request to comment.",
  "MAIG.Settings.Build.Effort.default": "Model default",
  "MAIG.Settings.Build.Effort.low": "Low",
  "MAIG.Settings.Build.Effort.medium": "Medium",
  "MAIG.Settings.Build.Effort.high": "High",
  "MAIG.Settings.Build.Effort.xhigh": "Extra high",
  "MAIG.Settings.Build.Effort.max": "Max",
  "MAIG.Settings.Build.CacheTtl.1h": "1 hour",
  "MAIG.Settings.Build.CacheTtl.5m": "5 minutes"
};

const PL = {
  "MAIG.Build.Cap.requests": "AI potrzebowało więcej kroków, niż wolno ({max} zapytań na jedną wiadomość). Napisz „dalej” albo uprość prośbę.",
  "MAIG.Build.Cap.toolCalls": "AI doszło do limitu {max} wywołań narzędzi na jedną wiadomość. Napisz „dalej” albo uprość prośbę.",
  "MAIG.Build.Cap.invalidSubmits": "Propozycja nie przeszła walidacji {max} razy z rzędu. Widać ostatni szkic i jego błędy.",
  "MAIG.Build.Cap.identicalInvalid": "AI zgłosiło drugi raz tę samą błędną propozycję (te same błędy); zatrzymane, bo się zapętliło.",
  "MAIG.Build.Cap.cost": "Zatrzymane: następny krok przekroczyłby limit ${max} na wiadomość (wydane ${spent}).",
  "MAIG.Build.Cap.wall": "Zatrzymane po {minutes} min (limit czasu na jedną wiadomość).",
  "MAIG.Build.Stop.user": "Zatrzymane.",
  "MAIG.Build.Stop.refusal": "Model odmówił tej prośby.",
  "MAIG.Build.Stop.maxTokens": "Odpowiedź urwała się na limicie długości. Napisz „dalej”.",
  "MAIG.Build.Stop.context": "Rozmowa nie mieści się już w kontekście modelu. Zacznij nową rozmowę.",
  "MAIG.Build.HistoryFull": "Ta rozmowa jest za długa (ok. {tokens} tokenów). Zacznij nową rozmowę.",
  "MAIG.Build.Limit": "Zablokowane przez limity wydatków modułu: {message}",
  "MAIG.Build.Error": "Zapytanie się nie udało ({kind}): {detail}",
  "MAIG.Build.NoKey": "Brak klucza API Anthropic. Wpisz go w ustawieniach modułu (zostaje w tej przeglądarce).",
  "MAIG.Build.NoPack": "Kreator AI nie jest dostępny dla tego dokumentu.",
  "MAIG.Build.Busy": "AI jeszcze pracuje nad poprzednią wiadomością.",
  "MAIG.Build.Empty": "Najpierw napisz wiadomość.",
  "MAIG.Build.SheetFailed": "Nie udało się odczytać karty dla AI ({error}); ta wiadomość idzie bez niej.",
  "MAIG.Build.Storage": "Ta przeglądarka nie mogła zapisać rozmowy; zostanie tylko do przeładowania strony.",
  "MAIG.Build.SettingsDrift": "Zmieniono model albo wysiłek w ustawieniach; ta rozmowa zostaje przy {model} / {effort}. Zacznij nową rozmowę, żeby użyć nowego ustawienia.",
  "MAIG.Build.PrefixChanged": "Zasady albo katalog zmieniły się od ostatniej wiadomości; następne zapytanie od nowa zapisze cache promptu.",
  "MAIG.Settings.Build.Model.Name": "Kreator AI: model",
  "MAIG.Settings.Build.Model.Hint": "Model Claude kreatora postaci i przedmiotów. Domyślnie claude-sonnet-5-5. Zmiana działa w nowych rozmowach.",
  "MAIG.Settings.Build.Effort.Name": "Kreator AI: wysiłek",
  "MAIG.Settings.Build.Effort.Hint": "Wysiłek rozumowania kreatora. Domyślnie medium. Zmiana działa w nowych rozmowach.",
  "MAIG.Settings.Build.CacheTtl.Name": "Kreator AI: czas życia cache promptu",
  "MAIG.Settings.Build.CacheTtl.Hint": "Jak długo wspólny prompt (zasady, katalog) zostaje w cache: 1 h (domyślnie) albo 5 min.",
  "MAIG.Settings.Build.MaxCost.Name": "Kreator AI: limit kosztu na wiadomość (USD)",
  "MAIG.Settings.Build.MaxCost.Hint": "Wiadomość MG zatrzymuje się przed zapytaniem, które przekroczyłoby tę kwotę (szacunek + wydane). 0 = bez limitu. Limity dzienne/miesięczne działają niezależnie.",
  "MAIG.Settings.Build.MaxRequests.Name": "Kreator AI: zapytania do modelu na wiadomość",
  "MAIG.Settings.Build.MaxRequests.Hint": "Ile zapytań do modelu może zużyć jedna wiadomość MG.",
  "MAIG.Settings.Build.MaxToolCalls.Name": "Kreator AI: wywołania narzędzi na wiadomość",
  "MAIG.Settings.Build.MaxToolCalls.Hint": "Najwięcej wywołań narzędzi (szukanie w katalogu, odczyty, sprawdzenia) na jedną wiadomość MG.",
  "MAIG.Settings.Build.MaxInvalid.Name": "Kreator AI: błędne propozycje z rzędu",
  "MAIG.Settings.Build.MaxInvalid.Hint": "Zatrzymaj po tylu kolejnych propozycjach, które nie przeszły walidacji.",
  "MAIG.Settings.Build.MaxMinutes.Name": "Kreator AI: minuty na wiadomość",
  "MAIG.Settings.Build.MaxMinutes.Hint": "Limit czasu na jedną wiadomość MG.",
  "MAIG.Settings.Build.Prewarm.Name": "Kreator AI: rozgrzewanie cache promptu",
  "MAIG.Settings.Build.Prewarm.Hint": "Przy otwarciu szuflady kreatora zapisz wspólny prompt w cache jednym tanim zapytaniem (pomijane, gdy cache jest ciepły).",
  "MAIG.Settings.Build.EndTurnOnSubmit.Name": "Kreator AI: koniec tury po propozycji",
  "MAIG.Settings.Build.EndTurnOnSubmit.Hint": "Gdy AI zgłosi poprawną propozycję, jej tura od razu się kończy (jedno zapytanie mniej); odpowiedzią jest uzasadnienie propozycji. Wyłączone: AI dostaje jeszcze jedno zapytanie na komentarz.",
  "MAIG.Settings.Build.Effort.default": "Domyślny modelu",
  "MAIG.Settings.Build.Effort.low": "Niski",
  "MAIG.Settings.Build.Effort.medium": "Średni",
  "MAIG.Settings.Build.Effort.high": "Wysoki",
  "MAIG.Settings.Build.Effort.xhigh": "Bardzo wysoki",
  "MAIG.Settings.Build.Effort.max": "Maksymalny",
  "MAIG.Settings.Build.CacheTtl.1h": "1 godzina",
  "MAIG.Settings.Build.CacheTtl.5m": "5 minut"
};

const fill = (s, data) => String(s).replace(/\{(\w+)\}/g, (m, k) => (data && k in data ? String(data[k]) : m));

/** t(key, data, game) -> localized text. */
export function t(key, data = {}, game = globalThis.game) {
  try { if (game?.i18n?.has?.(key)) return game.i18n.format(key, data); } catch { /* built-in text */ }
  const lang = String(game?.i18n?.lang ?? "en").toLowerCase();
  const dict = lang.startsWith("pl") ? PL : EN;
  return fill(dict[key] ?? EN[key] ?? key, data);
}

/** Add the built-in strings to game.i18n.translations without overwriting lang/*.json (call on i18nInit). */
export function injectStrings(game = globalThis.game) {
  try {
    const tr = game?.i18n?.translations;
    if (!tr) return;
    const dict = String(game.i18n.lang ?? "en").toLowerCase().startsWith("pl") ? { ...EN, ...PL } : EN;
    for (const [key, text] of Object.entries(dict)) {
      if (game.i18n.has?.(key)) continue;
      const parts = key.split(".");
      let o = tr;
      for (const p of parts.slice(0, -1)) { if (typeof o[p] !== "object" || o[p] === null) o[p] = {}; o = o[p]; }
      if (o[parts.at(-1)] === undefined) o[parts.at(-1)] = text;
    }
  } catch { /* never break start-up for strings */ }
}

export const STRINGS = { EN, PL };
