import { MODULE_ID } from "./constants.mjs";
import { getLimit } from "./settings.mjs";

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** Current spend, auto-rolling over when the day/month changes. */
export function getUsage() {
  const u = game.settings.get(MODULE_ID, "usage") ?? {};
  return {
    day: u.day === dayKey() ? u.dayCost ?? 0 : 0,
    month: u.month === monthKey() ? u.monthCost ?? 0 : 0
  };
}

/** Throws if a request with the estimated cost would break a configured limit. */
export function assertWithinLimits(estimatedCost = 0, { count = 1, batch = false } = {}) {
  const lim = (k) => getLimit(k) || Infinity;
  const { day, month } = getUsage();
  if (estimatedCost > lim("perRequest")) throw new Error(game.i18n.format("AIIMG.Limits.PerRequest", { limit: lim("perRequest") }));
  if (batch && count > lim("batchSize")) throw new Error(game.i18n.format("AIIMG.Limits.BatchSize", { limit: lim("batchSize") }));
  if (day + estimatedCost > lim("daily")) throw new Error(game.i18n.format("AIIMG.Limits.Daily", { limit: lim("daily") }));
  if (month + estimatedCost > lim("monthly")) throw new Error(game.i18n.format("AIIMG.Limits.Monthly", { limit: lim("monthly") }));
}

/** Add real cost (USD) to the counters. GM only (world setting). */
export async function recordCost(cost) {
  if (!cost || !game.user.isGM) return;
  const u = getUsage();
  await game.settings.set(MODULE_ID, "usage", {
    day: dayKey(), dayCost: u.day + cost,
    month: monthKey(), monthCost: u.month + cost
  });
}
