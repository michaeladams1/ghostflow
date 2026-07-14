// PRICE BACKTEST ENGINE — takes a structured strategy rule (from
// strategyParser.js) plus raw 1-minute bars (from databentoClient.js) and
// simulates it, bar by bar, to produce an equity curve and honest stats.
//
// This is DETERMINISTIC CODE, not an AI judgment call. The AI's only job was
// translating the strategy description into the structured rule; this file
// just executes that rule exactly as written against real price history.
//
// SCOPE OF V1:
//   - Single symbol per run (rule.symbols[0])
//   - RTH only (9:30am-4:00pm ET) — matches rule.session = "RTH"
//   - Indicators (VWAP/SMA/EMA) reset at the start of each session
//   - No commissions/slippage yet (noted in the result so it isn't mistaken
//     for a complete accounting — the SSRN paper's own numbers are net of a
//     small per-share commission, ours are currently gross)
//   - Equity is marked at each trade's close, not intra-bar

function etDateAndMinutes(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { dateStr: `${map.year}-${map.month}-${map.day}`, minutes: Number(map.hour) * 60 + Number(map.minute) };
}

// Group raw bars into RTH-only sessions: { "2026-07-08": [bar, bar, ...], ... }
function groupIntoSessions(bars) {
  const sessions = new Map();
  for (const b of bars) {
    const { dateStr, minutes } = etDateAndMinutes(b.ts);
    if (minutes < 570 || minutes >= 960) continue; // outside 9:30am-4:00pm ET
    if (!sessions.has(dateStr)) sessions.set(dateStr, []);
    sessions.get(dateStr).push(b);
  }
  // Sessions in chronological order, bars within each already sorted (input was sorted).
  return [...sessions.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function computeIndicatorSeries(sessionBars, indicators) {
  const out = {};
  for (const ind of indicators) {
    if (ind.type === "VWAP") {
      let cumPV = 0, cumV = 0;
      out[ind.id] = sessionBars.map((b) => {
        const typical = (b.high + b.low + b.close) / 3;
        cumPV += typical * b.volume;
        cumV += b.volume;
        return cumV > 0 ? cumPV / cumV : b.close;
      });
    } else if (ind.type === "SMA") {
      const period = ind.period || 20;
      out[ind.id] = sessionBars.map((_, i) => {
        const start = Math.max(0, i - period + 1);
        const slice = sessionBars.slice(start, i + 1);
        return slice.reduce((a, x) => a + x.close, 0) / slice.length;
      });
    } else if (ind.type === "EMA") {
      const period = ind.period || 20;
      const k = 2 / (period + 1);
      let prev = null;
      out[ind.id] = sessionBars.map((b) => {
        prev = prev === null ? b.close : b.close * k + prev * (1 - k);
        return prev;
      });
    }
  }
  return out;
}

// Simulates ONE session (one trading day) and returns the trades it produced.
function simulateSession(sessionBars, rule, indicatorSeries, sessionDate) {
  const dirOf = { long: 1, short: -1 };
  const trades = [];
  let i = rule.entry.waitBars || 0;

  while (i < sessionBars.length) {
    // --- find next entry from index i onward ---
    // (Stops one bar before the close: an entry on the day's FINAL bar has no
    // future bar to exit on, producing a phantom zero-duration "trade" that
    // pollutes the stats as a 0% loss.)
    let entryIdx = -1, direction = null;
    for (let j = i; j < sessionBars.length - 1; j++) {
      const bar = sessionBars[j];
      for (const cond of rule.entry.conditions) {
        const indVal = indicatorSeries[cond.indicator]?.[j];
        if (!Number.isFinite(indVal)) continue;
        const above = bar.close > indVal, below = bar.close < indVal;
        if ((cond.if === "price_above" && above) || (cond.if === "price_below" && below)) {
          entryIdx = j; direction = cond.then; break;
        }
      }
      if (entryIdx !== -1) break;
    }
    if (entryIdx === -1) break; // no more entries possible today

    const entryBar = sessionBars[entryIdx];
    const entryPrice = entryBar.close;
    const d = dirOf[direction];

    // --- find exit: stop, target, or end of day ---
    let exitIdx = sessionBars.length - 1;
    let exitReason = "endOfDay";
    for (let k = entryIdx + 1; k < sessionBars.length; k++) {
      const bar = sessionBars[k];
      const pctMove = ((bar.close - entryPrice) / entryPrice) * d * 100;

      if (rule.exit.stop?.type === "indicator_cross") {
        const indVal = indicatorSeries[rule.exit.stop.indicator]?.[k];
        if (Number.isFinite(indVal)) {
          if (d === 1 && bar.close < indVal) { exitIdx = k; exitReason = "stop"; break; }
          if (d === -1 && bar.close > indVal) { exitIdx = k; exitReason = "stop"; break; }
        }
      } else if (rule.exit.stop?.type === "fixed_pct" && pctMove <= -rule.exit.stop.value) {
        exitIdx = k; exitReason = "stop"; break;
      }
      if (rule.exit.target?.type === "fixed_pct" && pctMove >= rule.exit.target.value) {
        exitIdx = k; exitReason = "target"; break;
      }
    }

    const exitBar = sessionBars[exitIdx];
    const exitPrice = exitBar.close;
    const pctReturn = ((exitPrice - entryPrice) / entryPrice) * d * 100;

    trades.push({
      sessionDate, direction, entryTs: entryBar.ts, entryPrice,
      exitTs: exitBar.ts, exitPrice, pctReturn: +pctReturn.toFixed(4), exitReason,
    });

    if (exitReason === "endOfDay" || exitIdx >= sessionBars.length - 1) break;
    i = exitIdx + 1; // keep scanning for the NEXT entry right after this exit
  }
  return trades;
}

// Chart detail for ONE session: full bars, every indicator's value bar-by-bar,
// and the trades that fired that day. Used by the "inspect this day" view so
// the UI can draw price + VWAP + entry/exit markers, mirroring the paper's
// own illustrations (Figures 3/4).
export function getSessionChart(rule, dayBars) {
  const sessions = groupIntoSessions(dayBars);
  if (!sessions.length) return null;
  const [sessionDate, sessionBars] = sessions[0]; // dayBars should already be one day
  const indicatorSeries = computeIndicatorSeries(sessionBars, rule.indicators);
  const trades = simulateSession(sessionBars, rule, indicatorSeries, sessionDate);
  return {
    sessionDate,
    bars: sessionBars.map((b, i) => {
      const point = { ts: b.ts, close: b.close, open: b.open, high: b.high, low: b.low };
      for (const id of Object.keys(indicatorSeries)) point[id] = +indicatorSeries[id][i]?.toFixed(4);
      return point;
    }),
    indicators: rule.indicators,
    trades,
  };
}

function maxDrawdown(equityCurve) {
  let peak = -Infinity, worst = 0;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.equity);
    worst = Math.min(worst, (pt.equity - peak) / peak);
  }
  return worst * 100; // negative %
}

function sharpeRatio(dailyReturnsPct) {
  if (dailyReturnsPct.length < 2) return 0;
  const mean = dailyReturnsPct.reduce((a, b) => a + b, 0) / dailyReturnsPct.length;
  const variance = dailyReturnsPct.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturnsPct.length - 1);
  const std = Math.sqrt(variance);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

// rule: structured strategy from strategyParser.js
// bars: raw 1-min OHLCV bars for ONE symbol, from databentoClient.js
export function runBacktest(rule, bars, { startingCapital = 25000 } = {}) {
  const sessions = groupIntoSessions(bars);
  if (!sessions.length) {
    return { testable: false, reason: "No RTH sessions found in the supplied bars." };
  }

  const allTrades = [];
  for (const [sessionDate, sessionBars] of sessions) {
    if (sessionBars.length < 2) continue;
    const indicatorSeries = computeIndicatorSeries(sessionBars, rule.indicators);
    allTrades.push(...simulateSession(sessionBars, rule, indicatorSeries, sessionDate));
  }

  // --- Equity curve: apply trades in order, one point per session date ---
  let equity = startingCapital;
  const equityByDate = new Map();
  for (const t of allTrades) {
    equity *= 1 + t.pctReturn / 100;
    equityByDate.set(t.sessionDate, equity); // last write per date wins = end-of-day equity
  }
  // Carry equity forward on days with no trades, so the chart has one point per session.
  const strategyEquityCurve = [];
  let running = startingCapital;
  for (const [sessionDate] of sessions) {
    if (equityByDate.has(sessionDate)) running = equityByDate.get(sessionDate);
    strategyEquityCurve.push({ date: sessionDate, equity: +running.toFixed(2) });
  }

  // --- Buy & hold comparison: buy at first session's first bar, hold flat ---
  const firstBar = sessions[0][1][0];
  const shares = startingCapital / firstBar.close;
  const buyHoldEquityCurve = sessions.map(([sessionDate, sessionBars]) => ({
    date: sessionDate,
    equity: +(shares * sessionBars[sessionBars.length - 1].close).toFixed(2),
  }));

  // --- Daily returns (for Sharpe) ---
  const dailyReturns = [];
  for (let i = 1; i < strategyEquityCurve.length; i++) {
    const prev = strategyEquityCurve[i - 1].equity, curr = strategyEquityCurve[i].equity;
    dailyReturns.push(((curr - prev) / prev) * 100);
  }

  const wins = allTrades.filter((t) => t.pctReturn > 0);
  const losses = allTrades.filter((t) => t.pctReturn <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pctReturn, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pctReturn, 0) / losses.length : 0;
  const finalEquity = strategyEquityCurve[strategyEquityCurve.length - 1].equity;
  const finalBuyHold = buyHoldEquityCurve[buyHoldEquityCurve.length - 1].equity;
  const totalReturnPct = ((finalEquity - startingCapital) / startingCapital) * 100;
  const buyHoldReturnPct = ((finalBuyHold - startingCapital) / startingCapital) * 100;
  const yearsElapsed = sessions.length / 252;

  return {
    testable: true,
    symbol: rule.symbols?.[0],
    sessionsTested: sessions.length,
    totalTrades: allTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: allTrades.length ? +((wins.length / allTrades.length) * 100).toFixed(1) : 0,
    avgWinPct: +avgWin.toFixed(2),
    avgLossPct: +avgLoss.toFixed(2),
    riskReward: avgLoss !== 0 ? +Math.abs(avgWin / avgLoss).toFixed(2) : null,
    startingCapital,
    finalEquity: +finalEquity.toFixed(2),
    totalReturnPct: +totalReturnPct.toFixed(2),
    avgYearlyReturnPct: yearsElapsed > 0 ? +(totalReturnPct / yearsElapsed).toFixed(2) : null,
    maxDrawdownPct: +maxDrawdown(strategyEquityCurve).toFixed(2),
    sharpeRatio: +sharpeRatio(dailyReturns).toFixed(2),
    buyHold: {
      finalEquity: +finalBuyHold.toFixed(2),
      totalReturnPct: +buyHoldReturnPct.toFixed(2),
      maxDrawdownPct: +maxDrawdown(buyHoldEquityCurve).toFixed(2),
    },
    strategyEquityCurve,
    buyHoldEquityCurve,
    trades: allTrades,
    // Dates that actually had at least one trade — populates the "inspect this
    // day" dropdown without making the UI guess which days are worth viewing.
    tradeDates: [...new Set(allTrades.map((t) => t.sessionDate))],
    caveats: [
      "No commissions or slippage modeled yet.",
      "Equity marked only at trade close, not intra-bar.",
      "Single symbol only in this version.",
      "VWAP uses Nasdaq (XNAS) volume, not full-market consolidated volume — the closest available on the current Databento subscription (verified: EQUS.MINI is a small-venue subset with LESS volume than Nasdaq alone; EQUS.SIP/PLUS/ALL not entitled). Tracks consolidated VWAP closely for Nasdaq-listed names like QQQ, but is not identical.",
      "Entries/exits are evaluated at 1-min bar CLOSES, so entry lands one minute after the paper's 9:31:00 timing.",
    ],
  };
}
