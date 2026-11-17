// View-model of the AI builder drawer (task T7). PURE: no Foundry globals, no DOM. The drawer app (drawer-app.mjs) feeds it
// the session transcript, the pending proposal, the pack's validation preview, ranks, usage and settings, and renders what
// comes back with Handlebars. Everything the model wrote is escaped here (renderText); no HTML from the model reaches the DOM.
// Node tests: dev/test-drawer-model.mjs.

/** Width / height constants of the drawer (docking, dock()). No side tab (W5-E): the panel is the whole drawer. */
export const DOCK = Object.freeze({ panel: 420, minPanel: 300, header: 38, minHeight: 160 });

/**
 * Where the open drawer goes next to the sheet (right edge, else left, else shrink; never off-screen). Closed, the drawer
 * is hidden (it opens from the sheet's header button only).
 * rect = the sheet's bounding rect, view = { width, height } of the window.
 * -> { left, top, width, height, flip, panelW }
 */
export function dockGeometry(rect, view, d = DOCK) {
  const roomR = view.width - rect.right;
  const roomL = rect.left;
  let flip = false;
  let panelW = d.panel;
  if (roomR < d.panel) {
    if (roomL >= d.panel) flip = true;
    else {
      flip = roomL > roomR;
      panelW = Math.max(d.minPanel, Math.min(d.panel, Math.max(roomL, roomR)));
    }
  }
  const width = panelW;
  let left = flip ? rect.left - width : rect.right;
  left = Math.max(0, Math.min(left, view.width - width));
  // below the sheet's header; never off-screen (bughunt-2 #7): a sheet near the bottom moves the drawer up so the composer
  // stays reachable (the drawer is position: fixed, the window does not scroll); a sheet dragged above the top clamps to 0
  let top = Math.max(0, rect.top + d.header);
  const height = Math.min(view.height, Math.max(d.minHeight, Math.min(rect.top + rect.height - top, view.height - top)));
  if (top + height > view.height) top = Math.max(0, view.height - height);
  return { left, top, width, height, flip, panelW };
}

/**
 * W6-R4: lang key suffix of one Undo drift row (MAIG.Drawer.Undo.drift.<key>): a change made by a LATER builder run
 * (writer `laterRun`) says so instead of the alarming "edited"; else removed / edited.
 */
export function driftKey(d) {
  if (d?.laterRun) return "later";
  return d?.why === "missing" ? "missing" : "edited";
}

/**
 * State of the robot button in the sheet header (W5-E: it carries what the side tab used to: open, a proposal waiting, a
 * turn still running). -> { pressed, pending, working, tooltip }
 */
export function headerButtonState({ open = false, pending = false, busy = false } = {}, L = (k2) => k2) {
  const tooltip = busy ? L("MAIG.Drawer.OpenWorking") : pending ? L("MAIG.Drawer.OpenPending") : L("MAIG.Drawer.Open");
  return { pressed: !!open, pending: !!pending, working: !!busy, tooltip };
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Model text -> safe HTML: everything escaped first, then a tiny markdown subset (spec 4.2): **bold**, `- ` / `* ` / `1. `
 * lists, blank-line paragraphs, single line breaks. Nothing else (no links, no raw HTML).
 */
export function renderText(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!src) return "";
  const inline = (s) => escapeHtml(s).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const out = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const ul = lines.every((l) => /^\s*[-*]\s+/.test(l));
    const ol = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      out.push(`<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))}</li>`).join("")}</${tag}>`);
    } else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

/** Short, GM-readable label of a tool call (chips). L = localizer (key, data) -> string. */
export function toolLabel(item, L = (k) => k) {
  const i = item?.input ?? {};
  const short = (s, n = 40) => { const x = String(s ?? "").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  switch (item?.name) {
    case "search_catalog": return L("MAIG.Drawer.Tool.search", { what: short(i.query || i.forPower || (i.kinds ?? []).join(", ") || "…") });
    case "get_entries": return L("MAIG.Drawer.Tool.entries", { n: (i.refs ?? []).length || 1 });
    case "read_rules": return L("MAIG.Drawer.Tool.rules", { what: short(i.topic ?? "…") });
    case "read_document": return L("MAIG.Drawer.Tool.document", { what: short(i.target === "this" ? L("MAIG.Drawer.Tool.thisSheet") : i.target ?? "…", 28) });
    default:
      if (/^submit_/.test(String(item?.name ?? ""))) return L(i.dryRun ? "MAIG.Drawer.Tool.check" : "MAIG.Drawer.Tool.submit");
      return short(item?.name ?? "?", 28);
  }
}

const isSubmit = (it) => it?.role === "tool" && /^submit_/.test(String(it.name ?? "")) && it.input?.dryRun !== true;

/** proposalId -> the input of the submit call that made it (from transcript items: a "proposal" item follows its submit chip). */
export function proposalInputs(items) {
  const map = new Map();
  let last = null;
  for (const it of items ?? []) {
    if (isSubmit(it)) last = it;
    else if (it?.role === "proposal" && last) { map.set(String(it.proposalId), last.input ?? null); last = null; }
  }
  return map;
}

/**
 * The proposal the card shows: the session's pending one, else the NEWEST proposal state when it is "pending" again
 * (an Undo of an applied proposal marks it pending, W7-1; since W6-D1 the harness makes it the pending proposal again with
 * `restored: true`; a record without that object (older harness) takes the input from the transcript).
 * -> { proposalId, input, summary?, warnings?, restored } | null
 */
export function cardProposal(pending, states, items) {
  if (pending?.proposalId) return { ...pending, restored: !!pending.restored };
  const last = (states ?? []).at(-1);
  if (!last || last.status !== "pending") return null;
  const input = proposalInputs(items).get(String(last.id));
  return input ? { proposalId: String(last.id), input, restored: true } : null;
}

/**
 * Conversation rows for the log from transcript items (harness transcriptOf):
 *   { kind: "gm", html } | { kind: "ai", html } | { kind: "progress", html } | { kind: "tools", tools:[{label,status,name}], count, running, failed }
 *   | { kind: "proposal", html (rationale), proposalId, status } | { kind: "status", status, proposalId } | { kind: "notice", level, text }
 * Sheet blocks and model-facing proposal markers are not shown. Consecutive tool chips become one collapsed group.
 */
export function conversationRows(items, { states = [], L = (k) => k } = {}) {
  const rows = [];
  const status = new Map((states ?? []).map((s) => [String(s.id), s.status]));
  const inputs = proposalInputs(items);
  let group = null;
  const flush = () => { if (group) { rows.push(group); group = null; } };
  for (const it of items ?? []) {
    switch (it?.role) {
      case "tool": {
        group ??= { kind: "tools", tools: [], count: 0, running: 0, failed: 0 };
        const st = it.status === "error" ? "error" : it.status === "done" ? "done" : "pending";
        group.tools.push({ name: it.name, label: toolLabel(it, L), status: st });
        group.count++;
        if (st === "pending") group.running++;
        if (st === "error") group.failed++;
        break;
      }
      case "gm": flush(); rows.push({ kind: "gm", html: renderText(it.text) }); break;
      case "ai": flush(); rows.push({ kind: "ai", html: renderText(it.text) }); break;
      case "progress": flush(); rows.push({ kind: "progress", html: renderText(it.text) }); break;
      case "proposal": {
        flush();
        const id = String(it.proposalId ?? "");
        rows.push({ kind: "proposal", proposalId: id, status: status.get(id) ?? "pending", html: renderText(inputs.get(id)?.rationale ?? "") });
        break;
      }
      case "proposal-status": flush(); rows.push({ kind: "status", status: it.status, proposalId: String(it.proposalId ?? "") }); break;
      case "notice": flush(); rows.push({ kind: "notice", level: it.level ?? "info", text: String(it.message ?? it.code ?? "") }); break;
      default: break; // sheet, proposal-marker: model-facing only
    }
  }
  flush();
  return rows;
}

/**
 * Validator summary -> op rows. Lines "opId: text" become { opId, action, text, cost }; other lines (budget, kept) are
 * `extra`. opInfo (validate result) gives the action kind per op.
 */
export function summaryRows(summary, opInfo = {}) {
  const ops = [], extra = [];
  for (const raw of String(summary ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z][\w-]{0,15}):\s+(.*)$/.exec(line);
    if (!m || /^budget$/i.test(m[1])) { if (!/^budget\s+\d/i.test(line)) extra.push(line); continue; }
    const [, opId, rest] = m;
    const at = rest.indexOf(" cost: ");
    const text = at >= 0 ? rest.slice(0, at) : rest;
    const cost = at >= 0 ? rest.slice(at + 7) : "";
    const info = opInfo?.[opId] ?? {};
    const verb = /^(add|change|remove|level swap|swap)\b/i.exec(text)?.[1]?.toLowerCase();
    const action = info.kind ?? (verb === "add" ? "add" : verb === "remove" ? "remove" : verb?.includes("swap") ? "swap" : verb === "change" ? "update" : "actor");
    ops.push({ opId, action: action === "noop" ? "update" : action, text, cost });
  }
  return { ops, extra };
}

/** Budget before/after (validate result budget) -> rows { label, before, after, changed, over }. */
export function budgetRows(budget, L = (k) => k) {
  if (!budget || typeof budget !== "object" || (!budget.before && !budget.after)) return [];
  const b = budget.before ?? {}, a = budget.after ?? {};
  const rows = [];
  const pair = (x) => (x && Number.isFinite(Number(x.points)) ? `${x.spent ?? 0}/${x.points}` : "–");
  const slots = (x) => (x && Number.isFinite(Number(x.rankPowers)) ? `${x.slots ?? 0}/${x.rankPowers}` : "–");
  rows.push({ label: L("MAIG.Drawer.Budget.points"), before: pair(b), after: pair(a), changed: pair(b) !== pair(a), over: Number(a.spent) > Number(a.points) });
  rows.push({ label: L("MAIG.Drawer.Budget.slots"), before: slots(b), after: slots(a), changed: slots(b) !== slots(a), over: Number(a.slots) > Number(a.rankPowers) });
  if (a.cap != null || b.cap != null) rows.push({ label: L("MAIG.Drawer.Budget.cap"), before: String(b.cap ?? "–"), after: String(a.cap ?? "–"), changed: b.cap !== a.cap, over: false });
  return rows;
}

/** Talent role key ("hero" | "occupation" | "extra", reader.mjs TALENT_ROLES) -> localized label; unknown keys as they are. */
export function roleLabel(role, L = (k2) => k2) {
  return ["hero", "occupation", "extra"].includes(role) ? L(`MAIG.Drawer.Role.${role}`) : String(role ?? "?");
}

/**
 * Apply confirmation list (pack.apply concise `confirm`: [{ action: "remove"|"swap"|"reorder", name, from?, to? }]) -> lines for
 * the dialog. "reorder" (W5-A-3) = a kept talent the replace re-creates into another role: "Quick Wits: hero -> occupation".
 */
export function confirmItems(confirm, L = (k2) => k2) {
  return (confirm ?? []).filter(Boolean).map((c) => {
    const name = String(c.name ?? "?");
    if (c.action === "reorder") return L("MAIG.Drawer.Confirm.reorder", { name, from: roleLabel(c.from, L), to: roleLabel(c.to, L) });
    return L(`MAIG.Drawer.Confirm.${c.action === "swap" ? "swap" : "remove"}`, { name });
  });
}

/**
 * Plan talent re-orders (writer plan `reorders` [{ id|itemId, opId, name, from, to, roleChange }], W5-A-3: a replace writes the
 * proposal's talent order by re-creating talents with their ids) -> card rows { name, text, roleChange }.
 * A kept talent changing role, a kept one that keeps its role, a new talent placed in the order.
 */
export function reorderRows(reorders, L = (k2) => k2) {
  return (reorders ?? []).filter(Boolean).map((r) => {
    const name = String(r.name ?? "?");
    const isNew = !(r.id ?? r.itemId) && !!r.opId;
    const text = r.roleChange || (r.from && r.to && r.from !== r.to)
      ? L("MAIG.Drawer.Card.reorderChange", { name, from: roleLabel(r.from, L), to: roleLabel(r.to, L) })
      : isNew || !r.from ? L("MAIG.Drawer.Card.reorderNew", { name, role: roleLabel(r.to, L) })
        : L("MAIG.Drawer.Card.reorderSame", { name, role: roleLabel(r.to, L) });
    return { name, text, roleChange: !!r.roleChange };
  });
}

/**
 * Lines under the Apply banner (pack.apply concise result): the build's Health / Resolve (`vitals`, W3-3 / W5-A-1), the talents
 * re-created into the proposal's order (`reordered`, W5-A-3), then the warnings. At most `max` lines.
 */
export function applyResultLines(r, L = (k2) => k2, max = 6) {
  const out = [];
  const v = r?.vitals ?? {};
  const parts = ["health", "resolve"].filter((k2) => v[k2]).map((k2) => L(`MAIG.Drawer.Result.${k2}`, { from: v[k2].from ?? "?", to: v[k2].to ?? "?" }));
  if (parts.length) out.push(L("MAIG.Drawer.Result.vitals", { list: parts.join(", ") }));
  const re = (r?.reordered ?? []).filter(Boolean);
  if (re.length) {
    const list = re.map((x) => (x.from && x.to && x.from !== x.to ? `${x.name} (${roleLabel(x.from, L)} → ${roleLabel(x.to, L)})` : String(x.name ?? x.itemId ?? "?"))).join(", ");
    out.push(L("MAIG.Drawer.Result.reordered", { list }));
  }
  for (const w of r?.warnings ?? []) if (w?.message) out.push(String(w.message));
  return out.slice(0, max);
}

/** Messages (validator issues) -> { text, hint, gm } with the GM-only `gm` text kept (it never goes to the model). */
export function issueRows(list) {
  return (list ?? []).filter(Boolean).map((m) => ({ code: String(m.code ?? ""), text: String(m.message ?? m.code ?? ""), gm: m.gm ? String(m.gm) : "" }));
}

/** Rank select options: default first ("(default)" + which rank it resolves to), then each rank with its numbers. */
export function rankOptions(ranks, selected, defaultKey, L = (k) => k) {
  const def = (ranks ?? []).find((r) => r.key === defaultKey) ?? (ranks ?? []).find((r) => r.isDefault) ?? null;
  const opts = [{ value: "", label: L("MAIG.Drawer.Rank.default", { name: def?.name ?? "?" }), selected: !selected }];
  for (const r of ranks ?? []) {
    opts.push({ value: r.key, label: L("MAIG.Drawer.Rank.option", { name: r.name, points: r.points, cap: r.cap, powers: r.powers }), selected: selected === r.key });
  }
  return opts;
}

export const PROFILES = Object.freeze(["creation", "in-play"]);
export function profileOptions(selected, L = (k) => k) {
  return [
    { value: "", label: L("MAIG.Drawer.Profile.default", { name: L("MAIG.Drawer.Profile.creation") }), selected: !selected },
    ...PROFILES.map((p) => ({ value: p, label: L(`MAIG.Drawer.Profile.${p}`), selected: selected === p }))
  ];
}

/** Apply / Undo options in effect: the session's, with the default rank resolved and the default profile "creation". */
export function effectiveOptions(options, defaultRank) {
  return { rank: options?.rank || defaultRank || "global", profile: PROFILES.includes(options?.profile) ? options.profile : "creation" };
}

const k = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
export const fmtUsd = (usd) => { const v = Number(usd) || 0; return `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(v < 1 ? 3 : 2)}`; };
export const fmtTokens = k;

/**
 * Usage line + tooltip (spec 4.3). usage = session.usage(); caps = harness settings(); live = running turn counters.
 * -> { line, tip, amber, turn: { requests, maxRequests, tools, maxTools, usd, maxUsd } | null }
 */
export function usageView(usage, caps = {}, live = null, L = (k2) => k2, { model = "", effort = "" } = {}) {
  const s = usage?.session ?? {};
  const inTok = (s.input ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0);
  const ratio = Number(usage?.cacheHitRatio);
  const hit = Number.isFinite(ratio) && inTok > 0 ? `${Math.round(ratio * 100)}%` : "–";
  const line = L("MAIG.Drawer.Usage.line", { usd: fmtUsd(s.usd ?? 0), tokens: k(inTok + (s.output ?? 0)), hit });
  const tip = L("MAIG.Drawer.Usage.tip", { model: model || "?", effort: effort || "default", input: k(s.input ?? 0), write: k(s.cacheWrite ?? 0), read: k(s.cacheRead ?? 0), output: k(s.output ?? 0), requests: s.requests ?? 0 });
  const lastUsd = Number(usage?.lastTurn?.usd ?? 0);
  const maxUsd = Number(caps.maxCostPerMessage ?? 0);
  const amber = maxUsd > 0 && lastUsd > maxUsd / 2;
  const turn = live ? { requests: live.requests ?? 0, maxRequests: caps.maxRequests ?? "?", tools: live.tools ?? 0, maxTools: caps.maxToolCalls ?? "?", usd: fmtUsd(live.usd ?? 0), maxUsd: maxUsd > 0 ? fmtUsd(maxUsd) : "∞" } : null;
  return { line, tip, amber, turn };
}

/** Elapsed m:ss. */
export const fmtElapsed = (ms) => { const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Undo row from pack.undoStatus(doc): { available, runId, ageText, drift:[{name, why}], clean } | null */
export function undoView(st, L = (k2) => k2) {
  if (!st?.available) return st?.expired ? { available: false, expired: true } : null;
  const mins = Math.max(0, Math.round((Number(st.age) || 0) / 60000));
  const ageText = mins < 1 ? L("MAIG.Drawer.Undo.justNow") : mins < 60 ? L("MAIG.Drawer.Undo.minutes", { n: mins }) : L("MAIG.Drawer.Undo.hours", { n: Math.round(mins / 60) });
  return { available: true, runId: String(st.runId ?? ""), ageText, drift: (st.drift ?? []).map((d) => ({ name: String(d.name ?? d.itemId ?? "?"), why: String(d.why ?? "") })), clean: !(st.drift ?? []).length };
}
