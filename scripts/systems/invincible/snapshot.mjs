// Compact sheet serializer + line diff + full-vs-diff rule (spec 5.4, 6.0; task T12). PURE: no Foundry globals.
//
// Block format (one fact per line, no JSON braces; every line starts with its KEY, so a diff is line-based):
//   <sheet doc="Actor.<id>" fp=<hash>>                         (+ supersedes="all earlier sheet blocks" when re-sent)
//   ACTOR type=superhero name="..." rank=global(flag) profile=creation
//   ATTR fighting 4 agility 8 strength 6 reason 6 intuition 7 presence 4            stored (_source)
//   STORED health 7 resolve 9 reputation 2 resources 3 karma 0                       stored current values
//   PREPARED healthMax 9 resolveMax 9 slugfest 3 ... overrides=resources=4          what effects/derivation make of it
//   BONUS health: Durable +2; attack: Martial Arts +1                               system.bonuses (prepared)
//   LIMITED slugfestDamage "Strike" +3 limits="Windup Strike" (...)                 a power's bonus while the power has limits (W4-B-4)
//   TEXT <field> "..."                                                               one line per non-empty text field
//   EMPTY drive flaw ...                                                             text fields that are blank
//   I <itemId> <type> "<name>" lvl= src=<id> role=hero|occupation|extra pow=<id> ref=<pack:id>|custom edited cost= ... auto=[...] script fx=... desc="..."
//     (role= on superhero talents only; talents stay in the actor's collection order, which IS the role order)
//   FX <effectId> "<name>" disabled statuses=... changes                             actor-level effects
//   FLAG pu rank=global archetype=...  /  FLAG undo runs=2 last=<runId>
//   UNSAVED <path> stored="..." live="..."
//   NOTE ...                                                                          cut notices (size cap)
//   VALID <kind> ok=false errors=... warns=... budget=34 spent=31 slots=3/4 cap=10 drawbacks=1/2
//   </sheet>
// Line keys: ACTOR, ATTR, STORED, PREPARED, BONUS, EMPTY, NOTE, VALID (first word); TEXT/I/FX/FLAG/UNSAVED/LIMITED + second word.
//
// Update block (5.4): `<sheet_update doc=... fp=<new> base=<old>>` with `+ <line>` added, `~ <line>` changed (the full new
// line, then an indented `  (changed: field old -> new, ...)` line, W4-B-6), `- <key> "<name>"` removed (a one-key line:
// `- <KEY> (was: ...)`). `<sheet_unchanged/>` when nothing changed.

import { LEVEL_WORDS, readActor, readItemDocument, getCatalogLookup, readLiveForm } from "./reader.mjs";

export const FORMAT_VERSION = 1;
export const LIMITS = Object.freeze({
  capTokens: 6000,      // hard cap of a full block (spec 6.0 / O29)
  descChars: 400,       // custom / hand-edited item description (O27)
  itemDescChars: 1500,  // the subject of an item drawer (spec 6.0 first bullet)
  textChars: 600,       // one actor text field
  bioChars: 1500,       // biography (plain text)
  unsavedChars: 200,    // one side of an UNSAVED line
  diffRatio: 0.25,      // <= 25 % of the full block's lines ...
  diffTokens: 1500,     // ... AND <= 1500 tokens, else a fresh full block
  maxDiffs: 8           // a fresh full block after 8 diffs
});
const KEY2 = new Set(["TEXT", "I", "FX", "FLAG", "UNSAVED", "LIMITED"]);
export const SUPERSEDES = "all earlier sheet blocks";

/* ------------------------------------------------------------------ token estimate (local, no API) */
/**
 * Rough Claude-tokenizer estimate: lowercase/capitalised words ~1 token per 7 letters, mixed-case runs (random ids) ~1 per
 * 2 letters, digits ~1 per 3, each punctuation mark 1, newlines 1, single spaces folded into the next word. Calibrated to land
 * near chars/3.5 on English prose and ~0.65 tokens per char on 16-char Foundry ids. Measured sizes are checked with
 * count_tokens in T8.
 */
export function estimateTokens(text) {
  let n = 0;
  const re = /[A-Za-z]+|\d+|\n|[ \t]+|[^A-Za-z\d\s]/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const t = m[0];
    if (t === "\n") n += 1;
    else if (/^[ \t]+$/.test(t)) n += t.length > 1 ? 1 : 0;
    else if (/^\d+$/.test(t)) n += Math.ceil(t.length / 3);
    else if (/^[A-Za-z]+$/.test(t)) n += /^[A-Z]?[a-z]+$|^[A-Z]+$/.test(t) ? Math.max(1, Math.ceil(t.length / 7)) : Math.ceil(t.length / 2);
    else n += 1;
  }
  return n;
}

/* ------------------------------------------------------------------ formatting helpers */
export const quote = (s) => `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n")}"`;
/** cut plain text to n chars with an explicit marker */
export function cut(s, n) {
  const str = String(s ?? "");
  if (n <= 0) return str.length ? `[cut, ${str.length} chars]` : "";
  return str.length > n ? `${str.slice(0, n).trimEnd()}…[cut, ${str.length} chars]` : str;
}
const signed = (v) => { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== "" ? (n >= 0 ? `+${n}` : `${n}`) : `=${quote(v)}`; };
const MODE_SIGN = { add: (v) => signed(v), override: (v) => `=${Number.isFinite(Number(v)) && String(v).trim() !== "" ? v : quote(v)}`, multiply: (v) => `*${v}`, upgrade: (v) => `>=${v}`, downgrade: (v) => `<=${v}`, custom: (v) => `~${quote(v)}` };
const fxKey = (k) => String(k).replace(/^system\./, "");
export function fmtChange(c) { return `${fxKey(c.key)}${(MODE_SIGN[c.mode] ?? MODE_SIGN.custom)(c.value)}`; }
/** item effects -> "fx=initiativeSize+1;!derived.slugfest.bonus+1" ('!' = disabled, a name when the effect has no changes) */
function fmtItemEffects(effects, fold) {
  if (!effects?.length) return "";
  if (fold) return ` fx=${effects.length}`;
  const parts = effects.map((e) => {
    const body = e.changes.length ? e.changes.map(fmtChange).join(",") : quote(e.name);
    return `${e.disabled ? "!" : ""}${e.transfer ? "" : "^"}${body}`;
  });
  return ` fx=${parts.join(";")}`;
}
function fmtAuto(auto) {
  if (!auto?.length) return "";
  return ` auto=[${auto.map((a) => `${a.type} ${quote(a.name)}${a.sel ? "*" : ""}${a.nums.length ? ` ${a.nums.join(" ")}` : ""}`).join("; ")}]`;
}

/* ------------------------------------------------------------------ item lines in tree order */
const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
/** items ordered: each source -> its powers -> each power's boosts, limits; then powers/boosts/limits without a present link;
    then talents, drawbacks, gear, vehicle weapons, injuries, other types (each group by name, then id). Talents (W2-3) keep the
    actor's collection order instead: that order is their role (hero, occupation, extras), shown as role= on the line. */
export function orderItems(items) {
  const ids = new Set(items.map((i) => i.id));
  const of = (t) => (t === "talent" ? items.filter((i) => i.type === t) : items.filter((i) => i.type === t).sort(byName));
  const out = [], seen = new Set();
  const push = (i) => { if (!seen.has(i.id)) { seen.add(i.id); out.push(i); } };
  const powers = of("power"), boosts = of("boost"), limits = of("limit");
  const tail = (p) => { for (const b of boosts) if (b.powerId === p.id) push(b); for (const l of limits) if (l.powerId === p.id) push(l); };
  for (const s of of("powerSource")) { push(s); for (const p of powers) if (p.sourceId === s.id) { push(p); tail(p); } }
  for (const p of powers) if (!seen.has(p.id)) { push(p); tail(p); }
  for (const b of [...boosts, ...limits]) if (!seen.has(b.id)) push(b);
  for (const t of ["talent", "drawback", "gear", "vehicleWeapon", "criticalInjury"]) for (const i of of(t)) push(i);
  for (const i of items.slice().sort((a, b) => a.type.localeCompare(b.type) || byName(a, b))) push(i);
  return { list: out, ids };
}
export function itemLine(i, ids, { descChars = LIMITS.descChars, foldFx = false } = {}) {
  let s = `I ${i.id} ${i.type} ${quote(i.name)}`;
  if (i.type === "power") {
    s += ` lvl=${i.level || "-"}`;
    s += ` src=${i.sourceId ? (ids.has(i.sourceId) ? i.sourceId : `${i.sourceId}(missing)`) : "-"}`;
  }
  if (i.role) s += ` role=${i.role}`;
  if (i.type === "boost" || i.type === "limit") s += ` pow=${i.powerId ? (ids.has(i.powerId) ? i.powerId : `${i.powerId}(missing)`) : "-"}`;
  s += i.ref ? ` ref=${i.ref}${i.edited ? " edited" : ""}` : " custom";
  if (i.gear) {
    s += ` cost=${i.gear.cost}${i.gear.restricted ? " restricted" : ""}${i.gear.singleUse ? " singleUse" : ""}`;
    const a = i.gear.attack;
    if (a) s += ` atk=${a.bonus >= 0 ? "+" : ""}${a.bonus} dmg=${a.damage} rng=${a.minRange}-${a.maxRange}${a.bypassArmor ? " bypass" : ""}`;
  }
  if (i.injury) s += `${i.injury.lethal ? " lethal" : ""}${i.injury.healingTime ? ` heal=${quote(i.injury.healingTime)}` : ""}`;
  if (i.auto && !i.gear) s += fmtAuto(i.auto);
  else if (i.auto && i.gear && i.auto.length > (i.gear.attack ? 1 : 0)) s += fmtAuto(i.auto);
  if (i.script) s += " script";
  s += fmtItemEffects(i.effects, foldFx);
  if (i.desc != null && i.desc !== "") s += ` desc=${quote(cut(i.desc, descChars))}`;
  return s;
}

/* ------------------------------------------------------------------ full block */
const lineKey = (line) => {
  const sp = line.indexOf(" ");
  const first = sp < 0 ? line : line.slice(0, sp);
  if (!KEY2.has(first)) return first;
  const rest = line.slice(sp + 1);
  const sp2 = rest.indexOf(" ");
  return `${first} ${sp2 < 0 ? rest : rest.slice(0, sp2)}`;
};
export { lineKey };

/** model -> ordered [line] at a given cut level (0 = full detail) */
function buildLines(model, level = 0) {
  const L = [];
  // cut order (spec 6.0 / O29): custom descriptions first (150 chars, then none), then effects folded into counts and texts cut
  const descChars = [LIMITS.descChars, 150, 0, 0][level] ?? 0;
  const textChars = [LIMITS.textChars, LIMITS.textChars, LIMITS.textChars, 200][level] ?? 200;
  const bioChars = [LIMITS.bioChars, 600, 200, 0][level] ?? 0;
  const foldFx = level >= 3;
  if (model.kind === "item") {
    const i = model.items[0];
    L.push(`ITEM type=${i.type} name=${quote(i.name)}`);
    L.push(itemLine({ ...i, desc: null }, new Set(), { foldFx }));
    if (i.desc) L.push(`DESC ${quote(cut(i.desc, [LIMITS.itemDescChars, 800, 400, 200][level] ?? 200))}`);
  } else {
    const v = model.validation;
    L.push(`ACTOR type=${model.doc.type} name=${quote(model.doc.name)}${model.doc.type === "superhero" ? ` rank=${model.rank}(${model.rankFrom}) profile=${model.profile}` : ""}`);
    L.push(`ATTR ${Object.entries(model.attrs).map(([k, n]) => `${k} ${n ?? "-"}`).join(" ")}`);
    const st = model.stored;
    L.push(`STORED health ${st.health ?? "-"} resolve ${st.resolve ?? "-"} reputation ${st.reputation ?? "-"} resources ${st.resources ?? "-"} karma ${st.karma ?? "-"}`);
    const p = model.prepared ?? {};
    const pk = Object.keys(p).filter((k) => k !== "overrides");
    if (pk.length || p.overrides?.length) L.push(`PREPARED ${pk.map((k) => `${k} ${p[k]}`).join(" ")}${p.overrides?.length ? `${pk.length ? " " : ""}overrides=${p.overrides.join(",")}` : ""}`);
    if (model.bonuses?.length) {
      const by = new Map();
      for (const b of model.bonuses) { if (!by.has(b.key)) by.set(b.key, []); by.get(b.key).push(`${b.from} ${signed(b.value)}`); }
      L.push(`BONUS ${[...by].map(([k, l]) => `${k}: ${l.join(", ")}`).join("; ")}`);
    }
    L.push(...limitedLines(model.items));
    const empty = [];
    for (const [k, t] of Object.entries(model.texts ?? {})) {
      if (!t) { empty.push(k); continue; }
      L.push(`TEXT ${k} ${quote(cut(t, k === "biography" ? bioChars : textChars))}`);
    }
    if (empty.length) L.push(`EMPTY ${empty.join(" ")}`);
    const { list, ids } = orderItems(model.items);
    for (const i of list) L.push(itemLine(i, ids, { descChars, foldFx }));
    if (foldFx && model.effects.length) L.push(`FX all count=${model.effects.length} disabled=${model.effects.filter((e) => e.disabled).length}`);
    else for (const e of model.effects) {
      L.push(`FX ${e.id} ${quote(e.name)}${e.disabled ? " disabled" : ""}${e.statuses.length ? ` statuses=${e.statuses.join(",")}` : ""}${e.changes.length ? ` ${e.changes.map(fmtChange).join(",")}` : ""}`);
    }
    if (model.flags?.pu) L.push(`FLAG pu${model.flags.pu.rank ? ` rank=${model.flags.pu.rank}` : ""}${model.flags.pu.archetype ? ` archetype=${quote(model.flags.pu.archetype)}` : ""}`);
    if (model.flags?.undo) L.push(`FLAG undo runs=${model.flags.undo.runs} last=${model.flags.undo.last}`);
    pushUnsaved(L, model.unsaved);
    if (level > 0) L.push(`NOTE cut level ${level}: ${["", "custom descriptions cut to 150 chars", "custom descriptions left out", "custom descriptions left out, effects folded into counts, texts cut"][level]}; read_document gives the full text`);
    if (v) L.push(validLine(v, model.profile));
    else if (model.doc.type) L.push(`VALID none type=${model.doc.type}`);
    return L;
  }
  pushUnsaved(L, model.unsaved);
  if (level > 0) L.push(`NOTE cut level ${level}; read_document gives the full text`);
  return L;
}
/* ---- W4-B-4: a number on the sheet that includes a bonus of a power with a limit (dry run 4: slugfestDamage 9 shown while the
   +3 of Strike needs Windup Strike's preparation). The sheet's effects apply always; the line names the power, its bonus and its
   limits so the model reads the limit before it states the number. No rule is guessed: only effects and links on the sheet. */
const PREP_FIELD = [
  [/^derived\.slugfest\.damage$/, "slugfestDamage"], [/^derived\.slugfest\.(?:max|bonus|value)$/, "slugfest"],
  [/^derived\.health\.(?:max|bonus)$/, "healthMax"], [/^derived\.resolve\.(?:max|bonus)$/, "resolveMax"]
];
/** effect change key -> the PREPARED / ATTR field it changes ("system.derived.slugfest.damage" -> "slugfestDamage"), else the key */
export function preparedField(key) {
  const k = fxKey(key);
  for (const [re, f] of PREP_FIELD) if (re.test(k)) return f;
  return /^attributes\.(\w+)\.value$/.exec(k)?.[1] ?? k;
}
/** items -> ['LIMITED <field> "<power or boost>" <value> limits="A","B" (...)'], one line per field, fields sorted */
export function limitedLines(items) {
  const list = items ?? [];
  const limits = new Map();
  for (const l of list) if (l.type === "limit" && l.powerId) { if (!limits.has(l.powerId)) limits.set(l.powerId, []); limits.get(l.powerId).push(l.name); }
  if (!limits.size) return [];
  const byField = new Map();
  for (const it of list) {
    const pid = it.type === "power" ? it.id : it.type === "boost" ? it.powerId : null;
    const lims = pid ? limits.get(pid) : null;
    if (!lims?.length) continue;
    for (const e of it.effects ?? []) {
      if (e.disabled || e.transfer === false) continue;
      for (const c of e.changes ?? []) {
        const f = preparedField(c.key);
        if (!byField.has(f)) byField.set(f, []);
        byField.get(f).push(`${quote(it.name)} ${(MODE_SIGN[c.mode] ?? MODE_SIGN.custom)(c.value)} limits=${[...lims].sort().map(quote).join(",")}`);
      }
    }
  }
  return [...byField.keys()].sort().map((f) => `LIMITED ${f} ${byField.get(f).join("; ")} (the sheet counts it always; the limit's text may restrict it)`);
}

function pushUnsaved(L, unsaved) {
  for (const u of unsaved ?? []) {
    const f = (x) => quote(cut(typeof x === "object" && x !== null ? JSON.stringify(x) : String(x ?? ""), LIMITS.unsavedChars));
    L.push(`UNSAVED ${u.path} stored=${f(u.stored)} live=${f(u.live)}`);
  }
}
/** W4-A-1: vendored warnings the VALID line lists under info (an empty team = a solo hero, D-16; same as validate.mjs QUIET_CODES) */
const QUIET_TAGS = new Set(["team.empty"]);
export function validLine(v, profile) {
  let s = `VALID ${v.kind === "creation" ? `baseline profile=${profile ?? "creation"} rank=${v.rank}` : v.kind} ok=${v.ok}`;
  const warns = v.warnings.filter((w) => !QUIET_TAGS.has(w)), info = [...v.warnings.filter((w) => QUIET_TAGS.has(w)), ...(v.info ?? [])];
  if (v.errors.length) s += ` errors=${v.errors.join(",")}`;
  if (warns.length) s += ` warns=${warns.join(",")}`;
  if (info.length) s += ` info=${info.join(",")}`;
  const b = v.budget;
  if (b) s += ` budget=${b.points} spent=${b.spent} slots=${b.slots}/${b.rankPowers} cap=${b.cap} drawbacks=${b.drawbacks}/${b.maxDrawbacks} xsrc=${b.extraSources} xtal=${b.extraTalents}`;
  return s;
}

/**
 * serializeSheet(model, { supersedes, capTokens }) -> { text, body, fingerprint, lines: Map<key,line>, order:[key], tokensEst, cutLevel }
 * Deterministic: same model -> same bytes. The fingerprint covers the body (header excluded).
 */
export function serializeSheet(model, { supersedes = false, capTokens = LIMITS.capTokens } = {}) {
  let level = 0, L, body;
  for (;;) {
    L = dedupeKeys(buildLines(model, level));
    body = L.join("\n");
    if (estimateTokens(body) + 30 <= capTokens || level >= 3) break;
    level++;
  }
  const fingerprint = hashText(body);
  const text = `${header("sheet", model.doc.uuid, fingerprint, supersedes ? ` supersedes=${quote(SUPERSEDES)}` : "")}\n${body}\n</sheet>`;
  const lines = new Map(L.map((l) => [lineKey(l), l]));
  return { text, body, fingerprint, lines, order: [...lines.keys()], tokensEst: estimateTokens(text), cutLevel: level };
}
/** two lines with one key would break the diff: number the later ones (only possible with corrupted duplicate ids) */
function dedupeKeys(L) {
  const seen = new Map();
  return L.map((l) => {
    const k = lineKey(l);
    const c = seen.get(k) ?? 0;
    seen.set(k, c + 1);
    if (!c) return l;
    const parts = l.split(" ");
    if (KEY2.has(parts[0])) parts[1] = `${parts[1]}#${c + 1}`; else parts[0] = `${parts[0]}#${c + 1}`;
    return parts.join(" ");
  });
}
const header = (tag, doc, fp, extra = "") => `<${tag} doc=${quote(doc)} fp=${fp}${extra}>`;
function hashText(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36).padStart(7, "0"); }

/* ------------------------------------------------------------------ parse / diff / fold */
/** <sheet ...> text -> { doc, fp, lines: Map } (also accepts a bare body) */
export function parseSheet(text) {
  const raw = String(text ?? "").split("\n");
  let doc = null, fp = null;
  const lines = new Map();
  for (const l of raw) {
    if (!l) continue;
    const h = l.match(/^<sheet\b[^>]*?doc="((?:[^"\\]|\\.)*)"[^>]*?fp=(\w+)/);
    if (h) { doc = h[1]; fp = h[2]; continue; }
    if (/^<\/?sheet/.test(l)) continue;
    if (/^\s/.test(l)) continue;   // indented notes ("  (changed: ...)", W5-B-5 "  (rank changed ...)") are not sheet lines
    lines.set(lineKey(l), l);
  }
  return { doc, fp, lines };
}
const toLines = (x) => (x instanceof Map ? x : x?.lines instanceof Map ? x.lines : parseSheet(x).lines);
/** line diff of two key->line maps. -> { added:[line], changed:[line], removed:[key], count } in the NEW block's order */
export function diffLines(oldLines, newLines) {
  const o = toLines(oldLines), n = toLines(newLines);
  const added = [], changed = [], removed = [];
  for (const [k, l] of n) { if (!o.has(k)) added.push(l); else if (o.get(k) !== l) changed.push(l); }
  for (const [k] of o) if (!n.has(k)) removed.push(k);
  return { added, changed, removed, count: added.length + changed.length + removed.length };
}
const removedLabel = (key, oldLine) => {
  const m = String(oldLine ?? "").match(/^I \S+ \S+ ("(?:[^"\\]|\\.)*")/) ?? String(oldLine ?? "").match(/^FX \S+ ("(?:[^"\\]|\\.)*")/);
  return m ? `${key} ${m[1]}` : key;
};
/* ---- W4-B-6: what changed inside a "~" line (dry run 4: "resources 2" vanished from PREPARED and "Hard Times -1" from BONUS
   with nothing saying so). Under each "~ <new line>" an indented "  (changed: ...)" line lists the fields whose value differs:
   "field old -> new" (W5-B-4: "x -> removed" / "none -> y" when absent on one side), "+flag" / "-flag" for bare words; long values (> DELTA_VALUE chars) only "field changed".
   applyUpdate ignores indented lines, so the folded picture stays the same. */
export const DELTA_VALUE = 60;
export const DELTA_CHARS = 240;
const PAIR_LINES = new Set(["ATTR", "STORED", "PREPARED"]);
const LIST_KEYS = new Set(["errors", "warns", "info"]);
/** quote-aware split on spaces */
const tokens = (s) => String(s ?? "").match(/(?:[^\s"]+|"(?:[^"\\]|\\.)*")+/g) ?? [];
/** line -> { kv: Map(field -> value), flags: Set } (fields as the line shows them; the line's key words are skipped) */
export function lineFields(line) {
  const kv = new Map(), flags = new Set();
  const key = lineKey(line), first = key.split(" ")[0];
  const rest = line.slice(key.length).trim();
  if (first === "TEXT") { kv.set("text", rest); return { kv, flags }; }
  if (first === "BONUS") {
    for (const g of rest.split("; ")) { const i = g.indexOf(": "); if (i > 0) kv.set(g.slice(0, i), g.slice(i + 2)); else if (g) flags.add(g); }
    return { kv, flags };
  }
  if (first === "LIMITED") { kv.set("bonus", rest); return { kv, flags }; }
  const t = tokens(rest);
  for (let i = 0; i < t.length; i++) {
    const tok = t[i], eq = tok.indexOf("=");
    if (eq > 0 && !tok.startsWith("\"")) kv.set(tok.slice(0, eq), tok.slice(eq + 1));
    else if (tok.startsWith("\"")) kv.set("name", tok);
    else if (PAIR_LINES.has(first) && i + 1 < t.length && !t[i + 1].includes("=")) { kv.set(tok, t[i + 1]); i++; }
    else flags.add(tok);
  }
  return { kv, flags };
}
/** old line, new line -> "changed: a 1 -> 2, b 3 -> removed, c none -> 4, +flag" | "" (W5-B-4: words, not "-", for a value
    that went away or came new: "-" is also a real value on the sheet, e.g. src=-) */
export function lineDelta(oldLine, newLine) {
  const a = lineFields(oldLine), b = lineFields(newLine);
  const parts = [];
  const show = (v, side) => (v === undefined ? (side === "new" ? "removed" : "none") : v);
  for (const k of [...new Set([...a.kv.keys(), ...b.kv.keys()])]) {
    const x = a.kv.get(k), y = b.kv.get(k);
    if (x === y) continue;
    if (LIST_KEYS.has(k)) {   // VALID errors / warns / info: which codes went, which came
      const xs = x ? x.split(",") : [], ys = y ? y.split(",") : [];
      parts.push(`${k} ${[...xs.filter((c) => !ys.includes(c)).map((c) => `-${c}`), ...ys.filter((c) => !xs.includes(c)).map((c) => `+${c}`)].join(" ")}`);
      continue;
    }
    parts.push((x?.length ?? 0) > DELTA_VALUE || (y?.length ?? 0) > DELTA_VALUE ? `${k} changed` : `${k} ${show(x, "old")} -> ${show(y, "new")}`);
  }
  for (const f of a.flags) if (!b.flags.has(f)) parts.push(`-${f}`);
  for (const f of b.flags) if (!a.flags.has(f)) parts.push(`+${f}`);
  if (!parts.length) return "";
  const s = `changed: ${parts.join(", ")}`;
  return s.length > DELTA_CHARS ? `${s.slice(0, DELTA_CHARS - 1).replace(/[,\s]+$/, "")}…` : s;
}
/** "- <key>" label: items and actor effects with their name; a whole one-key line (PREPARED, BONUS, ...) with what it said */
const removedText = (key, oldLine) => {
  const label = removedLabel(key, oldLine);
  if (label !== key || KEY2.has(key.split(" ")[0]) || !oldLine) return label;
  const was = String(oldLine).slice(key.length).trim();
  return was ? `${key} (was: ${was.length > 120 ? `${was.slice(0, 119)}…` : was})` : key;
};
/** -> "<sheet_update ...>...</sheet_update>" text (or "<sheet_unchanged/>"); validNote (W5-B-5): an indented note under "~ VALID" */
export function formatUpdate(oldLines, fresh, { doc, base, validNote = "" } = {}) {
  const o = toLines(oldLines);
  const d = diffLines(o, fresh.lines);
  if (!d.count) return "<sheet_unchanged/>";
  const note = (l) => (validNote && lineKey(l) === "VALID" ? [`  (${validNote})`] : []);
  const body = [
    ...d.changed.flatMap((l) => { const x = lineDelta(o.get(lineKey(l)) ?? "", l); return [`~ ${l}`, ...(x ? [`  (${x})`] : []), ...note(l)]; }),
    ...d.added.flatMap((l) => [`+ ${l}`, ...note(l)]), ...d.removed.map((k) => `- ${removedText(k, o.get(k))}`)
  ];
  return `${header("sheet_update", doc ?? "", fresh.fingerprint, base ? ` base=${base}` : "")}\n${body.join("\n")}\n</sheet_update>`;
}
/** fold an update block (or unchanged) into a key->line map. -> new Map (input untouched) */
export function applyUpdate(lines, updateText) {
  const out = new Map(toLines(lines));
  const t = String(updateText ?? "");
  if (/^<sheet_unchanged\/>/.test(t.trim())) return out;
  for (const l of t.split("\n")) {
    if (!l || /^<\/?sheet_update/.test(l)) continue;
    const op = l.slice(0, 2), rest = l.slice(2);
    if (op === "~ " || op === "+ ") out.set(lineKey(rest), rest);
    else if (op === "- ") {
      const k = rest.match(/^(\S+ \S+|\S+)/)[0];
      const key = KEY2.has(k.split(" ")[0]) ? k : k.split(" ")[0];
      out.delete(key);
    }
  }
  return out;
}
/** same set of key->line pairs (order-independent) */
export function sameLines(a, b) {
  const x = toLines(a), y = toLines(b);
  if (x.size !== y.size) return false;
  for (const [k, l] of x) if (y.get(k) !== l) return false;
  return true;
}

/**
 * The 5.4 rule. `held` = what the conversation currently holds (null on the first message):
 *   { lines: Map, fullLineCount, diffs, fingerprint, doc }
 * `fresh` = serializeSheet(...) of the current sheet.
 * -> { kind: "full"|"update"|"unchanged", text, held: newHeld, reason }
 * Full on the first message; unchanged when the lines are identical; an update when it touches <= 25 % of the fresh block's
 * lines AND <= 1500 tokens AND fewer than 8 diffs were sent since the last full block; otherwise a fresh full block marked
 * supersedes.
 */
export function nextSheetBlock(held, fresh, { limits = LIMITS } = {}) {
  const validNote = held?.lines ? settingNote(held.lines, fresh.lines) : "";
  const full = (reason) => ({
    kind: "full", reason,
    text: withValidNote(held ? markSupersedes(fresh.text) : fresh.text, validNote),
    held: { lines: new Map(fresh.lines), fullLineCount: fresh.lines.size, diffs: 0, fingerprint: fresh.fingerprint, doc: docOf(fresh) }
  });
  if (!held?.lines) return full("first");
  // W5-B-4: GM-only lines (the undo journal flag) never make an update on their own and are never sent in one; the full block
  // still shows them. held keeps what the model has.
  const heldM = modelLines(held.lines), freshM = modelLines(fresh.lines);
  if (sameLines(heldM, freshM)) return { kind: "unchanged", text: "<sheet_unchanged/>", reason: "same", held };
  if ((held.diffs ?? 0) >= limits.maxDiffs) return full("diff-count");
  const d = diffLines(heldM, freshM);
  const text = formatUpdate(heldM, { ...fresh, lines: freshM }, { doc: held.doc ?? docOf(fresh), base: held.fingerprint, validNote });
  const tooMany = d.count > limits.diffRatio * Math.max(1, fresh.lines.size);
  const tooBig = estimateTokens(text) > limits.diffTokens;
  if (tooMany || tooBig) return full(tooMany ? "drift-lines" : "drift-tokens");
  return { kind: "update", text, reason: "diff", held: { ...held, lines: applyUpdate(held.lines, text), diffs: (held.diffs ?? 0) + 1, fingerprint: fresh.fingerprint } };
}
/** W5-B-4: line keys that are for the GM only (undo status): never sent in a sheet_update, never a change on their own */
export const GM_ONLY_KEYS = Object.freeze(new Set(["FLAG undo"]));
const modelLines = (m) => { const o = new Map(toLines(m)); for (const k of GM_ONLY_KEYS) o.delete(k); return o; };
/**
 * W5-B-5: the drawer's rank / profile changed since the sheet the model holds (ACTOR line) and the new VALID line reports
 * problems -> "rank changed global -> street: VALID checks the existing build against the new setting" ("" otherwise). The
 * VALID result is the hero built before the change, judged under the new rank, not a fault of the last proposal.
 */
export function settingNote(heldLines, freshLines) {
  const a = toLines(heldLines).get("ACTOR") ?? "", b = toLines(freshLines).get("ACTOR") ?? "", v = toLines(freshLines).get("VALID") ?? "";
  if (!a || !b || !/\b(errors|warns)=/.test(v)) return "";
  const get = (l, k) => l.match(new RegExp(`\\b${k}=([\\w-]+)`))?.[1] ?? null;
  const ch = ["rank", "profile"].filter((k) => get(a, k) !== get(b, k) && get(b, k)).map((k) => `${k} changed ${get(a, k) ?? "none"} -> ${get(b, k)}`);
  return ch.length ? `${ch.join(", ")}: VALID checks the existing build against the new setting` : "";
}
/** a full block's text with the W5-B-5 note as an indented line under VALID (not a sheet line: parseSheet / held skip it) */
const withValidNote = (text, note) => (note ? String(text).replace(/^(VALID .*)$/m, (l) => `${l}\n  (${note})`) : text);
/** add supersedes="all earlier sheet blocks" to a full block's header (idempotent) */
export const markSupersedes = (text) => String(text).replace(/^<sheet\b([^>]*)>/, (m, a) => (/supersedes=/.test(a) ? m : `<sheet${a} supersedes=${quote(SUPERSEDES)}>`));
const docOf = (fresh) => String(fresh.text ?? "").match(/^<sheet\b[^>]*?doc="((?:[^"\\]|\\.)*)"/)?.[1] ?? null;

/** contract helper (registry `diffSnapshots(oldText, newText)`): the plain line diff of two full blocks */
export function diffSnapshots(oldText, newText) {
  const o = parseSheet(oldText), n = parseSheet(newText);
  return formatUpdate(o.lines, { lines: n.lines, fingerprint: n.fp ?? hashText([...n.lines.values()].join("\n")) }, { doc: n.doc ?? o.doc ?? "", base: o.fp });
}

/* ------------------------------------------------------------------ pack entry (registry contract `sheet` group) */
const isItemDoc = (doc) => (doc?.documentName ?? doc?.constructor?.documentName) === "Item";
/**
 * snapshot(doc, { liveForm, rank, profile, lookup, supersedes, game }) -> { text, fingerprint, lines, order, tokensEst, cutLevel, model }
 * liveForm: true = read the open sheet form(s) of doc (readLiveForm), an object = those live values (tests), false = none.
 * rank: the drawer's rank selector (beats the plus-ultra flag); profile: "creation" | "in-play" (label of the VALID line).
 * Reads only; never writes, never submits a form.
 */
export async function snapshot(doc, { liveForm = true, rank = null, profile = "creation", lookup = null, supersedes = false, game = globalThis.game } = {}) {
  const lk = lookup ?? await getCatalogLookup(game);
  const live = liveForm === true ? readLiveForm(doc) : liveForm && typeof liveForm === "object" ? liveForm : null;
  const model = isItemDoc(doc) ? readItemDocument(doc, { lookup: lk, live }) : readActor(doc, { lookup: lk, live, rank, profile });
  return { ...serializeSheet(model, { supersedes }), model };
}

export { LEVEL_WORDS };
