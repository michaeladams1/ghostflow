// Calendar performance chart series — cumulative P&L from $0 at month/year
// start, with per-period deployed capital (never cumulative).
// Aggregate "Capital deployed" widgets use avgDailyDeployed over trading days.

export const CALENDAR_LANES = {
  official: {
    label: "Playbook hours", pnlKey: "pnl", tradesKey: "tradePnls",
    deployedKey: "deployed", tradeDeployedsKey: "tradeDeployeds",
  },
  outside: {
    label: "Outside hours", pnlKey: "excludedPnl", tradesKey: "excludedTradePnls",
    deployedKey: "excludedDeployed", tradeDeployedsKey: "excludedTradeDeployeds",
  },
  research: {
    label: "Research lanes", pnlKey: "experimentalPnl", tradesKey: "experimentalTradePnls",
    deployedKey: "experimentalDeployed", tradeDeployedsKey: "experimentalTradeDeployeds",
  },
  shen: {
    label: "Shen conviction", pnlKey: "shenPnl", tradesKey: "shenTradePnls",
    deployedKey: "shenDeployed", tradeDeployedsKey: "shenTradeDeployeds",
  },
  frontier: {
    label: "Frontier v7", pnlKey: "frontierPnl", tradesKey: "frontierTradePnls",
    deployedKey: "frontierDeployed", tradeDeployedsKey: "frontierTradeDeployeds",
  },
  volume: {
    label: "Volume sleeve", pnlKey: "volumePnl", tradesKey: "volumeTradePnls",
    deployedKey: "volumeDeployed", tradeDeployedsKey: "volumeTradeDeployeds",
  },
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function laneDay(day, lane) {
  if (!day) return null;
  const config = CALENDAR_LANES[lane];
  const tradePnls = day[config.tradesKey] || [];
  const tradeDeployeds = day[config.tradeDeployedsKey] || [];
  const deployed = Number(day[config.deployedKey] != null
    ? day[config.deployedKey]
    : tradeDeployeds.reduce((s, d) => s + Number(d || 0), 0));
  return {
    ...day,
    pnl: Number(day[config.pnlKey] || 0),
    trades: tradePnls.length,
    tradePnls,
    tradeDeployeds,
    deployed,
  };
}

/**
 * Average capital in the book across trading days.
 * Mon $3k + Tue $1k → $2k. Empty input → 0.
 */
export function avgDailyDeployed(dayDeployeds) {
  const vals = (dayDeployeds || [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return 0;
  return +(vals.reduce((sum, v) => sum + v, 0) / vals.length).toFixed(2);
}

/** Average a lane's daily deployed totals over days that actually traded. */
export function avgLaneDeployed(days, { deployedKey, tradesKey } = {}) {
  const active = (days || []).filter((d) => Number(d?.[tradesKey] || 0) > 0);
  return avgDailyDeployed(active.map((d) => d?.[deployedKey]));
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
