// Calendar performance chart series — cumulative P&L from $0 at month/year
// start, with per-period deployed capital (never cumulative).
// Aggregate "Capital deployed" widgets use avgDailyDeployed over trading days.

export const CALENDAR_LANES = {
  official: {
    label: "Playbook hours", pnlKey: "pnl", tradesKey: "tradePnls",
    deployedKey: "deployed", tradeDeployedsKey: "tradeDeployeds",
    intervalsKey: "tradeIntervals",
  },
  outside: {
    label: "Outside hours", pnlKey: "excludedPnl", tradesKey: "excludedTradePnls",
    deployedKey: "excludedDeployed", tradeDeployedsKey: "excludedTradeDeployeds",
    intervalsKey: "excludedTradeIntervals",
  },
  research: {
    label: "Research lanes", pnlKey: "experimentalPnl", tradesKey: "experimentalTradePnls",
    deployedKey: "experimentalDeployed", tradeDeployedsKey: "experimentalTradeDeployeds",
    intervalsKey: "experimentalTradeIntervals",
  },
  shen: {
    label: "Shen conviction", pnlKey: "shenPnl", tradesKey: "shenTradePnls",
    deployedKey: "shenDeployed", tradeDeployedsKey: "shenTradeDeployeds",
    intervalsKey: "shenTradeIntervals",
  },
  frontier: {
    label: "Frontier v7", pnlKey: "frontierPnl", tradesKey: "frontierTradePnls",
    deployedKey: "frontierDeployed", tradeDeployedsKey: "frontierTradeDeployeds",
    intervalsKey: "frontierTradeIntervals",
  },
  volume: {
    label: "Volume sleeve", pnlKey: "volumePnl", tradesKey: "volumeTradePnls",
    deployedKey: "volumeDeployed", tradeDeployedsKey: "volumeTradeDeployeds",
    intervalsKey: "volumeTradeIntervals",
  },
  gamma: {
    label: "Gamma sleeve", pnlKey: "gammaPnl", tradesKey: "gammaTradePnls",
    deployedKey: "gammaDeployed", tradeDeployedsKey: "gammaTradeDeployeds",
    intervalsKey: "gammaTradeIntervals",
  },
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function laneDay(day, lane) {
  if (!day) return null;
  const config = CALENDAR_LANES[lane];
  const tradePnls = day[config.tradesKey] || [];
  const tradeDeployeds = day[config.tradeDeployedsKey] || [];
  const tradeIntervals = day[config.intervalsKey] || [];
  const deployed = Number(day[config.deployedKey] != null
    ? day[config.deployedKey]
    : tradeDeployeds.reduce((s, d) => s + Number(d || 0), 0));
  return {
    ...day,
    pnl: Number(day[config.pnlKey] || 0),
    trades: tradePnls.length,
    tradePnls,
    tradeDeployeds,
    tradeIntervals,
    deployed,
  };
}

/**
 * Average capital in the book across trading days.
 * Mon $3k + Tue $1k → $2k. Skips empty / non-finite values (no $0 trade days).
 */
export function avgDailyDeployed(dayDeployeds) {
  const vals = (dayDeployeds || [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) return 0;
  return +(vals.reduce((sum, v) => sum + v, 0) / vals.length).toFixed(2);
}

/**
 * Max capital open at once from trade intervals (entry→exit sweep).
 * Sequential same-day trades do not stack.
 */
export function maxConcurrentDeployed(intervals) {
  const events = [];
  for (const it of intervals || []) {
    const deployed = Number(it?.deployed);
    const start = Number(it?.startMin);
    if (!Number.isFinite(deployed) || deployed <= 0 || !Number.isFinite(start)) continue;
    const endRaw = Number(it?.endMin);
    const end = Number.isFinite(endRaw) ? Math.max(endRaw, start) : start;
    events.push({ t: start, d: deployed });
    events.push({ t: end, d: -deployed });
  }
  if (!events.length) return 0;
  // At a shared timestamp, acquire before release so true overlaps still count.
  events.sort((a, b) => a.t - b.t || b.d - a.d);
  let cur = 0, peak = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > peak) peak = cur;
  }
  return +peak.toFixed(2);
}

/** Average a lane's daily deployed totals over days that actually traded. */
export function avgLaneDeployed(days, { deployedKey, tradesKey } = {}) {
  const active = (days || []).filter((d) => Number(d?.[tradesKey] || 0) > 0);
  return avgDailyDeployed(active.map((d) => d?.[deployedKey]));
}

/** Max concurrent across a lane: peak of each trading day's concurrent capital. */
export function maxLaneDeployed(days, { intervalsKey, deployedKey, tradesKey } = {}) {
  const active = (days || []).filter((d) => Number(d?.[tradesKey] || 0) > 0);
  const dailyPeaks = active.map((d) => {
    const concurrent = maxConcurrentDeployed(d?.[intervalsKey] || []);
    if (concurrent > 0) return concurrent;
    return Number(d?.[deployedKey] || 0);
  }).filter((v) => v > 0);
  return dailyPeaks.length ? +Math.max(...dailyPeaks).toFixed(2) : 0;
}

/**
 * Build chart points for a lane.
 * - cumulative: running sum of period P&L from $0 (month days or year months)
 * - deployed: that day's capital (month view), or avg daily capital that month (year view)
 * - dayPnl: the period's own P&L (kept for tooltips; not plotted as the gains line)
 */
export function buildLaneChartSeries(days, lane, { mode = "month" } = {}) {
  const laneDays = (days || [])
    .map((day) => laneDay(day, lane))
    .filter((day) => day && (day.trades > 0 || Number(day.pnl) !== 0 || Number(day.deployed) > 0))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let cumulative = 0;
  if (mode === "year") {
    const byMonth = new Map();
    for (const day of laneDays) {
      const month = Number(String(day.date).slice(5, 7));
      if (!byMonth.has(month)) byMonth.set(month, { pnl: 0, dayDeployeds: [], trades: 0 });
      const row = byMonth.get(month);
      row.pnl += Number(day.pnl || 0);
      if ((day.trades || 0) > 0) row.dayDeployeds.push(Number(day.deployed || 0));
      row.trades += day.trades || 0;
    }
    return Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
      const row = byMonth.get(month) || { pnl: 0, dayDeployeds: [], trades: 0 };
      cumulative += row.pnl;
      return {
        label: MONTH_SHORT[month - 1],
        date: month,
        dayPnl: +row.pnl.toFixed(2),
        cumulative: +cumulative.toFixed(2),
        deployed: avgDailyDeployed(row.dayDeployeds),
        trades: row.trades,
      };
    });
  }
  return laneDays.map((day) => {
    cumulative += Number(day.pnl || 0);
    return {
      label: String(day.date).slice(8, 10),
      date: day.date,
      dayPnl: Number(day.pnl || 0),
      cumulative: +cumulative.toFixed(2),
      deployed: Number(day.deployed || 0),
      trades: day.trades || 0,
    };
  });
}
