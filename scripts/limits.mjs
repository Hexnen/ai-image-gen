import { MODULE_ID } from "./constants.mjs";
import { getLimit } from "./settings.mjs";
import { listBatches, isActive } from "./batch/record.mjs";

// Doba i miesiąc liczone w czasie LOKALNYM (nie UTC), żeby "dzienny" limit resetował się o północy użytkownika.
const p2 = (n) => String(n).padStart(2, "0");
const monthKey = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
const dayKey = (d = new Date()) => `${monthKey(d)}-${p2(d.getDate())}`;

/** Zaksięgowane wydatki (USD), z automatycznym rolloverem doby/miesiąca. */
export function getUsage() {
  const u = game.settings.get(MODULE_ID, "usage") ?? {};
  return {
    day: u.day === dayKey() ? u.dayCost ?? 0 : 0,
    month: u.month === monthKey() ? u.monthCost ?? 0 : 0
  };
}

// ---- rezerwacje (żądania w locie) i batche w toku ----

/** Szacunki żądań, które właśnie lecą do API (jeszcze niezaksięgowane). Tylko ten klient. */
const inflight = new Set();
const inflightTotal = () => [...inflight].reduce((s, r) => s + r.cost, 0);

/**
 * Szacowany koszt batchy w toku (pending/cancelling): licznik rośnie dopiero przy odbiorze wyników
 * (do 24 h później), więc bez tego kolejne batche przechodziłyby przy "zerowym" liczniku.
 * Koszt już zaksięgowany w trakcie trwającego ingestu (`ingest.cost`) jest odejmowany.
 */
export function pendingBatchCost() {
  let sum = 0;
  try {
    for (const r of listBatches()) {
      if (!isActive(r)) continue;
      sum += Math.max(0, (Number(r.estimatedCost) || 0) - (Number(r.ingest?.cost) || 0));
    }
  } catch { /* ustawienie niedostępne */ }
  return sum;
}

function check(estimatedCost, { count = 1, batch = false } = {}) {
  const est = Number.isFinite(Number(estimatedCost)) && estimatedCost > 0 ? Number(estimatedCost) : 0;
  const lim = (k) => getLimit(k) || Infinity; // 0 = bez limitu
  const { day, month } = getUsage();
  const committed = inflightTotal() + pendingBatchCost();
  if (est > lim("perRequest")) throw new Error(game.i18n.format("AIIMG.Limits.PerRequest", { limit: lim("perRequest") }));
  if (batch && count > lim("batchSize")) throw new Error(game.i18n.format("AIIMG.Limits.BatchSize", { limit: lim("batchSize") }));
  if (day + committed + est > lim("daily")) throw new Error(game.i18n.format("AIIMG.Limits.Daily", { limit: lim("daily") }));
  if (month + committed + est > lim("monthly")) throw new Error(game.i18n.format("AIIMG.Limits.Monthly", { limit: lim("monthly") }));
  return est;
}

/** Rzuca, gdy żądanie o szacowanym koszcie złamałoby limit (wlicza żądania w locie i batche w toku). Nie rezerwuje. */
export function assertWithinLimits(estimatedCost = 0, opts = {}) {
  check(estimatedCost, opts);
}

/**
 * Sprawdza limity i REZERWUJE szacunek na czas trwania żądania (równoległe wywołania widzą się nawzajem).
 * Zwraca idempotentne `release()` — wołać w `finally`, po zaksięgowaniu realnego kosztu.
 */
export function reserveBudget(estimatedCost = 0, opts = {}) {
  const entry = { cost: check(estimatedCost, opts) };
  inflight.add(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflight.delete(entry);
  };
}

// ---- księgowanie ----

let chain = Promise.resolve();

/** Dolicz koszt (USD) do liczników. Tylko GM (world setting). Zapisy idą kolejką, wartość czytana tuż przed zapisem. */
export function recordCost(cost) {
  const c = Number(cost);
  if (!(c > 0) || !game.user.isGM) return Promise.resolve();
  const run = chain.then(async () => {
    const u = getUsage();
    await game.settings.set(MODULE_ID, "usage", {
      day: dayKey(), dayCost: u.day + c,
      month: monthKey(), monthCost: u.month + c
    });
  });
  chain = run.catch(() => {});
  return run;
}
