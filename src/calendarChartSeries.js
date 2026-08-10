// Calendar performance chart series — cumulative P&L from $0 at month/year
// start, with per-period deployed capital (never cumulative).

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
 * Build chart points for a lane.
 * - cumulative: running sum of period P&L from $0 (month days or year months)
 * - deployed: that period's capital only (day total / month total) — never cumulative
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
      if (!byMonth.has(month)) byMonth.set(month, { pnl: 0, deployed: 0, trades: 0 });
      const row = byMonth.get(month);
      row.pnl += Number(day.pnl || 0);
      row.deployed += Number(day.deployed || 0);
      row.trades += day.trades || 0;
    }
    return Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
      const row = byMonth.get(month) || { pnl: 0, deployed: 0, trades: 0 };
      cumulative += row.pnl;
      return {
        label: MONTH_SHORT[month - 1],
        date: month,
        dayPnl: +row.pnl.toFixed(2),
        cumulative: +cumulative.toFixed(2),
        deployed: +row.deployed.toFixed(2),
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
