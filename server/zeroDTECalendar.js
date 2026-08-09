// MONTH SIMULATOR — runs the 0DTE debrief for every completed trading day
// in a calendar month and aggregates it for the calendar view. Day results
// are cached in memory: a finished session's tape never changes, so the
// first month costs ~20 sequential day-sims and every later view is free
// until the server restarts.

import {
  analyzeZeroDTESession, frontierDedupeKey, frontierLanePriority, isFrontierFire,
} from "./zeroDTE.js";
import { simulateAllFires } from "./zeroDTEOptionSim.js";
import { buildSessionStory } from "./zeroDTEStory.js";
import { saveSessionTrades } from "./zeroDTEStore.js";

const dayCache = new Map(); // "SPY:2026-08-07" -> summary

const sizeToDollars = (s) => Number(String(s || "").replace(/[^0-9.]/g, "")) || 1000;
function etMinuteOf(ts) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ts));
  const m = {}; for (const p of parts) m[p.type] = p.value;
  return Number(m.hour) * 60 + Number(m.minute);
}
function contractsFor(f) {
  const dollars = sizeToDollars(f.size);
  return Math.max(1, Math.floor(dollars / (f.trade.entryPrice * 100)));
}
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
      const playbookExperiments = await simulateAllFires({ ticker: symbol, sessionDate: date, fires: s.playbookExperiments || [] });
      const story = buildSessionStory({ symbol, sessionDate: date, levels: s.levels, gap: s.gap, fires, bars: s.bars });
      const simmed = fires.filter((f) => f.level && f.trade?.ok);
      const counted = simmed.filter((f) => f.window === "in");
      const excluded = simmed.filter((f) => f.window !== "in");
      const experimental = experiments.filter((f) => f.level && f.trade?.ok);
      const shen = playbookExperiments.filter((f) => f.level && f.trade?.ok);
      // Frontier draws from every segment, then keeps the highest-priority
      // lane when several lanes fire the same setup clock.
      const frontierByKey = new Map();
      const considerFrontier = (f, lane, countedFlag) => {
        const etMinute = f.ts ? etMinuteOf(f.ts) : null;
        if (!isFrontierFire({
          direction: f.direction,
          levelType: f.levelType,
          tier: f.tier,
          points: f.points,
          etMinute,
          entryPrice: f.trade?.entryPrice,
          touchNumber: f.touchNumber,
        })) return;
        const key = frontierDedupeKey({
          sessionDate: date,
          etMinute,
          direction: f.direction,
          levelType: f.levelType,
          touchNumber: f.touchNumber,
        });
        const rank = frontierLanePriority(lane, { counted: countedFlag });
        const prev = frontierByKey.get(key);
        if (!prev || rank < prev.rank) frontierByKey.set(key, { f, rank });
      };
      for (const f of counted) considerFrontier(f, "official", true);
      for (const f of experimental) considerFrontier(f, f.lane || "HIGH_QUALITY_A", false);
      for (const f of excluded) considerFrontier(f, "official", false);
      for (const f of shen) considerFrontier(f, "SHEN_CONVICTION", false);
      const frontier = [...frontierByKey.values()].map((x) => x.f);
      summary = {
        date,
        pnl: +story.totalPnl.toFixed(2),
        excludedPnl: +story.excludedPnl.toFixed(2),
        trades: story.countedCount,
        excludedTrades: story.excludedCount,
        wins: story.winCount,
        signals: fires.length,
        tradePnls: counted.map(pnlOf),
        excludedTradePnls: excluded.map(pnlOf),
        experimentalPnl: +experimental.reduce((sum, f) => sum + pnlOf(f), 0).toFixed(2),
        experimentalTrades: experimental.length,
        experimentalWins: experimental.filter((f) => f.trade.pctReturn > 0).length,
        experimentalTradePnls: experimental.map(pnlOf),
        shenPnl: +shen.reduce((sum, f) => sum + pnlOf(f), 0).toFixed(2),
        shenTrades: shen.length,
        shenWins: shen.filter((f) => f.trade.pctReturn > 0).length,
        shenTradePnls: shen.map(pnlOf),
        frontierPnl: +frontier.reduce((sum, f) => sum + pnlOf(f), 0).toFixed(2),
        frontierTrades: frontier.length,
        frontierWins: frontier.filter((f) => f.trade.pctReturn > 0).length,
        frontierTradePnls: frontier.map(pnlOf),
        nearMissReasons: (s.nearMisses || []).flatMap((x) => x.reasons),
      };

      // PERSIST. Every fire — official and research, traded or not — is
      // written with the features that produced it. This is what makes the
      // strategy analyzable later instead of recomputed and forgotten.
      const toRow = (f, lane) => ({
        ...f, lane,
        etMinute: f.ts ? etMinuteOf(f.ts) : null,
        contracts: f.trade?.ok ? contractsFor(f) : null,
        pnl: f.trade?.ok ? pnlOf(f) : null,
        counted: lane === "official" && f.window === "in" && !!f.trade?.ok,
      });
      try {
        await saveSessionTrades({ symbol, sessionDate: date, rows: [
          ...fires.map((f) => toRow(f, "official")),
          ...experiments.map((f) => toRow(f, f.lane || "research")),
          ...playbookExperiments.map((f) => toRow(f, "SHEN_CONVICTION")),
        ] });
      } catch (err) {
        console.error(`[0dte:store] ${date} persist failed:`, err.message);
      }
    }
  } catch (err) {
    summary = { date, error: err.message };
  }
  dayCache.set(key, summary);
  return summary;
}

export function summarizeMonth({ symbol = "SPY", year, month, days, saved = false, codeVersion = null, sessionsCovered = null }) {
  const traded = days.filter((x) => (x.trades || 0) > 0);
  const allTradePnls = traded.flatMap((x) => x.tradePnls || []);
  const totalTrades = allTradePnls.length;
  const wins = allTradePnls.filter((p) => p > 0).length;
  const pnl = +days.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2);
  const excludedPnl = +days.reduce((s, x) => s + (x.excludedPnl || 0), 0).toFixed(2);
  const excludedTradePnls = days.flatMap((x) => x.excludedTradePnls || []);
  const excludedTrades = excludedTradePnls.length;
  const excludedWins = excludedTradePnls.filter((p) => p > 0).length;
  const dayPnls = traded.map((x) => x.pnl);
  const experimentalTradePnls = days.flatMap((x) => x.experimentalTradePnls || []);
  const experimentalTrades = experimentalTradePnls.length;
  const experimentalWins = experimentalTradePnls.filter((p) => p > 0).length;
  const shenTradePnls = days.flatMap((x) => x.shenTradePnls || []);
  const shenTrades = shenTradePnls.length;
  const shenWins = shenTradePnls.filter((p) => p > 0).length;
  const frontierTradePnls = days.flatMap((x) => x.frontierTradePnls || []);
  const frontierTrades = frontierTradePnls.length;
  const frontierWins = frontierTradePnls.filter((p) => p > 0).length;
  const nearMissReasons = {};
  for (const reason of days.flatMap((x) => x.nearMissReasons || [])) nearMissReasons[reason] = (nearMissReasons[reason] || 0) + 1;

  return {
    symbol, year, month, days, saved, codeVersion, sessionsCovered,
    totals: {
      pnl, excludedPnl, totalTrades, wins, losses: totalTrades - wins,
      winRate: totalTrades ? +((wins / totalTrades) * 100).toFixed(1) : null,
      excludedTrades,
      excludedWins,
      excludedLosses: excludedTrades - excludedWins,
      excludedWinRate: excludedTrades ? +((excludedWins / excludedTrades) * 100).toFixed(1) : null,
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
      shenPnl: +shenTradePnls.reduce((sum, x) => sum + x, 0).toFixed(2),
      shenTrades,
      shenWins,
      shenLosses: shenTrades - shenWins,
      shenWinRate: shenTrades ? +((shenWins / shenTrades) * 100).toFixed(1) : null,
      frontierPnl: +frontierTradePnls.reduce((sum, x) => sum + x, 0).toFixed(2),
      frontierTrades,
      frontierWins,
      frontierLosses: frontierTrades - frontierWins,
      frontierWinRate: frontierTrades ? +((frontierWins / frontierTrades) * 100).toFixed(1) : null,
      nearMissReasons,
    },
  };
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
  return summarizeMonth({ symbol, year, month, days });
}
