// LIVE check of the Invincible catalogue + read tools (task T4) against the REAL invincible-core compendia.
// Paste into the browser console of a GM on a LANE world (never port 30000), or run it through a browser tool. The module does
// not need to be active: the files are imported by URL. Prints SIZES, COUNTS and TIMINGS only; it never prints or stores book
// text (everything read stays in this page's memory).
// Token numbers are local estimates (chars/3.5 = scripts/anthropic/pricing.mjs estimateTokens; chars/4 as a low bound); the
// real numbers need count_tokens with the API key (T8).
(async () => {
  const base = "/modules/moinens-ai-gen/scripts";
  const v = `?v=${Date.now()}`;
  const C = await import(`${base}/systems/invincible/catalog.mjs${v}`);
  const R = await import(`${base}/systems/invincible/rules-digest.mjs${v}`);
  const T = await import(`${base}/systems/invincible/tools.mjs${v}`);
  let harness = "";
  try { harness = (await import(`${base}/build/harness-prompt.mjs${v}`)).HARNESS_RULES ?? ""; } catch { /* T2 not there yet */ }
  const est = (s) => ({ chars: s.length, tok35: Math.ceil(s.length / 3.5), tok4: Math.ceil(s.length / 4) });
  const src = C.foundrySource(game);
  const t0 = performance.now();
  const cat = await C.buildCatalog(src);
  const buildMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await C.buildCatalog(src);
  const rebuildMs = Math.round(performance.now() - t1);
  const index = C.indexText(cat), digest = R.rulesDigest(), tools = JSON.stringify(T.readToolDefs());
  const refChars = cat.entries.reduce((a, e) => a + e.ref.length + 1, 0);
  const summaryChars = cat.entries.reduce((a, e) => a + (e.summaryText?.length ?? 0), 0);
  const perKind = {};
  for (const k of C.KINDS) {
    const lines = index.split("\n").filter((l) => cat.byKind(k).some((e) => l.startsWith(`${e.ref}|`)));
    perKind[k] = { n: cat.byKind(k).length, ...est(lines.join("\n")) };
  }
  // get_entries result sizes per kind (all entries of the kind, results discarded)
  const entrySizes = {};
  for (const k of C.KINDS) {
    const list = cat.byKind(k);
    const sizes = [];
    for (let i = 0; i < list.length; i += 8) {
      const r = await C.getEntries(cat, src, list.slice(i, i + 8).map((e) => e.ref));
      for (const e of r.entries) sizes.push(JSON.stringify(e).length);
    }
    if (sizes.length) entrySizes[k] = { n: sizes.length, avgChars: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), maxChars: Math.max(...sizes), truncated: 0 };
  }
  for (const k of ["power", "talent", "archetype", "occupation"]) {
    let cutN = 0;
    for (let i = 0; i < cat.byKind(k).length; i += 8) cutN += (await C.getEntries(cat, src, cat.byKind(k).slice(i, i + 8).map((e) => e.ref))).entries.filter((e) => /\(truncated, \d+ chars\)$/.test(e.rulesText ?? "")).length;
    if (entrySizes[k]) entrySizes[k].truncated = cutN;
  }
  const rules = {};
  for (const topic of R.TOPIC_KEYS) {
    const r = await R.readRules(src, { topic });
    rules[topic] = r.ok ? { parts: r.parts, part1Chars: r.text.length } : { error: r.error.code };
  }
  const searches = {};
  for (const q of ["flight", "strength", "web", "armor", "teleport"]) { const r = C.search(cat, { query: q }); searches[q] = { total: r.total, chars: JSON.stringify(r.results).length, top: r.results[0]?.kind ?? null }; }
  const split = cat.byKind("power").filter((p) => p.split).map((p) => `${p.name}:${Object.keys(p.levelDocs).length}`);
  const prefix = harness + digest + index + tools;
  const out = {
    buildMs, rebuildMs, missing: cat.meta.missing, counts: cat.meta.counts, entries: cat.entries.length, splitPowers: split,
    stable: C.indexText(await C.buildCatalog(src)) === index,
    sizes: { harnessRules: est(harness), rulesDigest: est(digest), catalogIndex: est(index), tools: est(tools), prefixTotal: est(prefix) },
    indexShare: { refChars, summaryChars, refPct: Math.round(100 * refChars / index.length), summaryPct: Math.round(100 * summaryChars / index.length) },
    perKind, entrySizes, rules, searches,
    quickstartReachable: R.TOPIC_KEYS.some((k) => /quickstart/i.test(R.RULE_TOPICS[k].name))
  };
  console.log("moinens-ai-gen T4 live catalogue check", out);
  return out;
})();
