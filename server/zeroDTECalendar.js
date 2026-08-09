// MONTH SIMULATOR — runs the 0DTE debrief for every completed trading day
// in a calendar month and aggregates it for the calendar view. Day results
// are cached in memory: a finished session's tape never changes, so the
// first month costs ~20 sequential day-sims and every later view is free
// until the server restarts.

import { analyzeZeroDTESession } from "./zeroDTE.js";
import { simulateAllFires } from "./zeroDTEOptionSim.js";
import { buildSessionStory } from "./zeroDTEStory.js";

const dayCache = new Map(); // "SPY:2026-08-07" -> summary

const sizeToDollars = (s) => Number(String(s || "").replace(/[^0-9.]/g, "")) || 1000;
function pnlOf(f) {
  const dollars = sizeToDollars(f.size);
  const contracts = Math.max(1, Math.floor(dollars / (f.trade.entryPrice * 100)));
  return +(contracts * (f.trade.exitPrice - f.trade.entryPrice) * 100).toFixed(2);
}

async function simulateDay(symbol, date) {
  const key = `${symbol}:${date}`;
  if (dayCache.has(key)) return dayCache.get(key);

  let summary;
  try {
    const s = await analyzeZeroDTESession({ symbol, sessionDate: date });
    if (!s.ok) {
      summary = { date, noData: true };
    } else {
      const fires = await simulateAllFires({ ticker: symbol, sessionDate: date, fires: s.fires });
      const experiments = await simulateAllFires({ ticker: symbol, sessionDate: date, fires: s.experiments || [] });
      const story = buildSessionStory({ symbol, sessionDate: date, levels: s.levels, gap: s.gap, fires, bars: s.bars });
      const simmed = fires.filter((f) => f.level && f.trade?.ok);
      const counted = simmed.filter((f) => f.window === "in");
      const experimental = experiments.filter((f) => f.level && f.trade?.ok);
      summary = {
        date,
        pnl: +story.totalPnl.toFixed(2),
        excludedPnl: +story.excludedPnl.toFixed(2),
        trades: story.countedCount,
        excludedTrades: story.excludedCount,
        wins: story.winCount,
        signals: fires.length,
        tradePnls: counted.map(pnlOf),
        experimentalPnl: +experimental.reduce((sum, f) => sum + pnlOf(f), 0).toFixed(2),
        experimentalTrades: experimental.length,
        experimentalWins: experimental.filter((f) => f.trade.pctReturn > 0).length,
        experimentalTradePnls: experimental.map(pnlOf),
        nearMissReasons: (s.nearMisses || []).flatMap((x) => x.reasons),
      };
    }
  } catch (err) {
    summary = { date, error: err.message };
  }
  dayCache.set(key, summary);
  return summary;
}

export async function simulateMonth({ symbol = "SPY", year, month }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dow = new Date(date + "T12:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;       // weekends
    if (date >= todayIso) continue;             // only completed sessions
    console.log(`[0dte:month] ${date}...`);
    days.push(await simulateDay(symbol, date));
  }

  const traded = days.filter((x) => (x.trades || 0) > 0);
  const allTradePnls = traded.flatMap((x) => x.tradePnls || []);
  const totalTrades = allTradePnls.length;
  const wins = allTradePnls.filter((p) => p > 0).length;
  const pnl = +days.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2);
  const excludedPnl = +days.reduce((s, x) => s + (x.excludedPnl || 0), 0).toFixed(2);
  const dayPnls = traded.map((x) => x.pnl);
  const experimentalTradePnls = days.flatMap((x) => x.experimentalTradePnls || []);
  const experimentalTrades = experimentalTradePnls.length;
  const experimentalWins = experimentalTradePnls.filter((p) => p > 0).length;
  const nearMissReasons = {};
  for (const reason of days.flatMap((x) => x.nearMissReasons || [])) nearMissReasons[reason] = (nearMissReasons[reason] || 0) + 1;

  return {
    symbol, year, month, days,
    totals: {
      pnl, excludedPnl, totalTrades, wins, losses: totalTrades - wins,
      winRate: totalTrades ? +((wins / totalTrades) * 100).toFixed(1) : null,
      excludedTrades: days.reduce((s, x) => s + (x.excludedTrades || 0), 0),
      bestDay: dayPnls.length ? Math.max(...dayPnls) : null,
      worstDay: dayPnls.length ? Math.min(...dayPnls) : null,
      bestTrade: allTradePnls.length ? Math.max(...allTradePnls) : null,
      worstTrade: allTradePnls.length ? Math.min(...allTradePnls) : null,
      tradingDays: days.filter((x) => !x.noData).length,
      experimentalPnl: +experimentalTradePnls.reduce((sum, x) => sum + x, 0).toFixed(2),
      experimentalTrades,
      experimentalWins,
      experimentalLosses: experimentalTrades - experimentalWins,
      experimentalWinRate: experimentalTrades ? +((experimentalWins / experimentalTrades) * 100).toFixed(1) : null,
      nearMissReasons,
    },
  };
}
