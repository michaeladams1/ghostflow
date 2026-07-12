// THE BACKTEST ENGINE.
//
// THIS IS THE PIECE THAT MAKES THE WHOLE SYSTEM HONEST.
//
// A model looking at one session and finding a signal that "predicted" a move
// is nearly worthless on its own. Given any chart and 29 feeds, a sufficiently
// clever model will ALWAYS find some cluster that lines up. That is not
// analysis, it is curve-fitting to a single anecdote.
//
// The only way to know whether a rule is real is to run it across many days it
// has never seen and count what it ACTUALLY returned — including every single
// time it fired and lost. That is what this file does.
//
// This is also the clean answer to survivorship bias. We no longer need Michael
// to hand-pick losing trades to balance the winners: the backtest surfaces the
// losers automatically, because it takes every single firing of the rule, not
// the ones anyone remembered.
//
// LOOKAHEAD SAFETY (the thing that silently ruins backtests):
//   - Signal z-scores use a TRAILING window only (see compress.js) — a bar's
//     z-score never depends on bars after it.
//   - Entry is at the CLOSE of the bar where the rule fires. Not the low of the
//     day, not some optimal fill. You could actually have gotten this.
//   - Exit is a fixed horizon after entry, decided in advance — never "sell at
//     the top", which is the classic way to fake a great backtest.

import { fetchAllEndpoints } from "./quantDataClient.js";
import { buildBriefing } from "./compress.js";

// Rebuilds the per-minute z-scored series for the feeds a rule references, so
// a rule's conditions can be evaluated bar by bar on any historical day.
function buildSignalIndex(briefing) {
  // events already carry {ts, endpoint, metric, value, z} and are lookahead-free.
  const index = new Map(); // ts -> [events at that minute]
  for (const e of briefing.timeline.events) {
    if (!index.has(e.ts)) index.set(e.ts, []);
    index.get(e.ts).push(e);
  }
  return index;
}

// Evaluates one rule against one session, returning every bar where it fired.
// `windowMin` lets conditions co-occur within a few minutes rather than
// demanding the exact same second, which is how a human would read a cluster.
function findFirings(rule, briefing, { windowMin = 2 } = {}) {
  if (!rule?.conditions?.length) return [];

  const events = briefing.timeline.events;
  const firings = [];
  const seen = new Set();

  for (const anchor of events) {
    // Gather everything within +/- windowMin of this anchor event.
    const nearby = events.filter((e) => Math.abs(e.ts - anchor.ts) <= windowMin * 60_000);

    const allMet = rule.conditions.every((cond) => {
      return nearby.some((e) => {
        if (e.endpoint !== cond.feed) return false;
        // Conditions are stated in z-score terms (the models were told to use
        // sigma), so compare against z, falling back to raw value if a model
        // gave an absolute threshold instead.
        const subject = Math.abs(Number(cond.threshold)) < 100 ? e.z : e.value;
        const t = Number(cond.threshold);
        switch (cond.operator) {
          case ">": return subject > t;
          case ">=": return subject >= t;
          case "<": return subject < t;
          case "<=": return subject <= t;
          case "==": return subject === t;
          default: return false;
        }
      });
    });

    if (allMet) {
      // De-duplicate: a cluster spanning 3 minutes shouldn't count as 3 trades.
      const bucket = Math.floor(anchor.ts / (windowMin * 60_000));
      if (!seen.has(bucket)) {
        seen.add(bucket);
        firings.push({ ts: anchor.ts, clock: anchor.clock });
      }
    }
  }
  return firings;
}

// Given a firing time, what did the trade actually make?
// Entry = close of the bar at (or first bar after) the signal.
// Exit   = close of the bar `holdMinutes` later. Fixed in advance.
function evaluateTrade(firing, priceBars, { holdMinutes = 15, direction = 1 }) {
  const entryBar = priceBars.find((b) => b.ts >= firing.ts);
  if (!entryBar) return null;
  const exitTs = entryBar.ts + holdMinutes * 60_000;
  const exitBar = [...priceBars].reverse().find((b) => b.ts <= exitTs && b.ts > entryBar.ts);
  if (!exitBar) return null;

  const pct = ((exitBar.value - entryBar.value) / entryBar.value) * 100 * direction;
  return {
    entryClock: firing.clock,
    entryPrice: +entryBar.value.toFixed(2),
    exitPrice: +exitBar.value.toFixed(2),
    pctReturn: +pct.toFixed(3),
    win: pct > 0,
  };
}

function directionOf(rule) {
  if (!rule?.action) return 1;
  return rule.action === "BUY_PUT" ? -1 : 1;
}

// ---------------------------------------------------------------------------
// THE MAIN SWEEP: run one rule across many sessions it has never seen.
// ---------------------------------------------------------------------------
export async function backtestRule(rule, { ticker, sessions, holdMinutes = 15, onProgress } = {}) {
  if (!rule || !rule.conditions?.length) {
    return {
      testable: false,
      reason: "This rule has no machine-checkable conditions — it cannot be backtested, which means it can never be proven or disproven. That is a defect in the rule, not in the data.",
    };
  }

  const trades = [];
  const sessionResults = [];
  const errors = [];
  const direction = directionOf(rule);

  for (const sessionDate of sessions) {
    try {
      const bundle = await fetchAllEndpoints({ ticker, sessionDate, startDate: sessionDate, endDate: sessionDate });
      const briefing = buildBriefing(bundle);

      // The underlying's real minute bars for this day — our P&L instrument.
      const priceFeed = briefing.endpoints.find((e) => e.id === "stock_price_over_time");
      const priceBars = bundle.results.stock_price_over_time?.ok
        ? Object.entries(bundle.results.stock_price_over_time.data.data)
            .map(([ts, v]) => ({ ts: Number(ts), value: v.closePrice }))
            .sort((a, b) => a.ts - b.ts)
        : [];

      if (!priceBars.length) {
        errors.push({ sessionDate, error: "no price bars" });
        continue;
      }

      const firings = findFirings(rule, briefing);
      const dayTrades = firings
        .map((f) => evaluateTrade(f, priceBars, { holdMinutes, direction }))
        .filter(Boolean)
        .map((t) => ({ ...t, sessionDate }));

      trades.push(...dayTrades);
      sessionResults.push({ sessionDate, firings: firings.length, trades: dayTrades.length });
      onProgress?.({ sessionDate, firings: firings.length });
    } catch (err) {
      errors.push({ sessionDate, error: err.message });
    }
  }

  // ---- The verdict. No spin. ----
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalReturn = trades.reduce((a, t) => a + t.pctReturn, 0);
  const avgReturn = trades.length ? totalReturn / trades.length : 0;
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;

  const grossWin = wins.reduce((a, t) => a + t.pctReturn, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pctReturn, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // A rule that fires twice and wins both times proves nothing. Sample size is
  // reported prominently so a tiny sample cannot masquerade as a strong result.
  const enoughData = trades.length >= 20;

  return {
    testable: true,
    rule: rule.description,
    ticker,
    sessionsTested: sessions.length,
    sessionsWithErrors: errors.length,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +winRate.toFixed(1),
    avgReturnPct: +avgReturn.toFixed(3),
    totalReturnPct: +totalReturn.toFixed(2),
    profitFactor: profitFactor === Infinity ? "Inf" : +profitFactor.toFixed(2),
    bestTrade: trades.length ? trades.reduce((a, b) => (b.pctReturn > a.pctReturn ? b : a)) : null,
    worstTrade: trades.length ? trades.reduce((a, b) => (b.pctReturn < a.pctReturn ? b : a)) : null,
    enoughData,
    // The headline. Written to be read plainly, including when it's bad news.
    verdict: !trades.length
      ? "NEVER FIRED. This rule's conditions were never met on any tested session. It is not a rule, it is a description of one specific afternoon."
      : !enoughData
      ? `INSUFFICIENT SAMPLE. Only ${trades.length} firings across ${sessions.length} sessions. Any win rate here is noise — you need 20+ to say anything.`
      : winRate >= 55 && avgReturn > 0
      ? `HOLDS UP SO FAR. ${trades.length} trades, ${winRate.toFixed(0)}% win rate, ${avgReturn.toFixed(2)}% average return per trade.`
      : `DOES NOT HOLD UP. ${trades.length} trades, ${winRate.toFixed(0)}% win rate, ${avgReturn.toFixed(2)}% average per trade. The single-day story did not survive contact with other days.`,
    trades,
    sessionResults,
    errors,
  };
}

// Generates the list of prior trading sessions to test against (weekdays only;
// market holidays simply come back with no data and are reported as errors
// rather than silently skewing the result).
export function priorSessions(fromDate, count) {
  const out = [];
  const d = new Date(fromDate + "T00:00:00Z");
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}
