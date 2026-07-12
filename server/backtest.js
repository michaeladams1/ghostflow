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

import { fetchFeedsForRule } from "./quantDataClient.js";
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
//
// COOLDOWN — a real bug Claude caught by reading its own backtest:
// A single premium spike doesn't last one minute; it lasts several. Without a
// cooldown, one drift event re-triggers the rule on consecutive buckets and
// gets counted as 5 separate "trades". That inflates the sample size, makes 6
// real events look like 41 independent draws, and corrupts every statistic
// downstream. One signal event = ONE trade. The cooldown enforces that.
function findFirings(rule, briefing, { windowMin = 2, cooldownMin = 30 } = {}) {
  if (!rule?.conditions?.length) return [];

  const events = briefing.timeline.events;
  const firings = [];
  let lastFiringTs = -Infinity;

  for (const anchor of events) {
    // Still inside the cooldown from the previous firing — this is the SAME
    // event continuing, not a new independent opportunity.
    if (anchor.ts - lastFiringTs < cooldownMin * 60_000) continue;

    const nearby = events.filter((e) => Math.abs(e.ts - anchor.ts) <= windowMin * 60_000);

    const allMet = rule.conditions.every((cond) => nearby.some((e) => {
      if (e.endpoint !== cond.feed) return false;
      // Conditions are stated in sigma (the models were told so). Thresholds
      // under 100 are read as z-scores; larger ones as raw values.
      const t = Number(cond.threshold);
      const subject = Math.abs(t) < 100 ? e.z : e.value;
      switch (cond.operator) {
        case ">": return subject > t;
        case ">=": return subject >= t;
        case "<": return subject < t;
        case "<=": return subject <= t;
        case "==": return subject === t;
        default: return false;
      }
    }));

    if (allMet) {
      firings.push({ ts: anchor.ts, clock: anchor.clock });
      lastFiringTs = anchor.ts;
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

  // Only the feeds this rule actually references get fetched — not all 30.
  const feedIds = [...new Set(rule.conditions.map((c) => c.feed))];

  for (const sessionDate of sessions) {
    try {
      const bundle = await fetchFeedsForRule({ ticker, sessionDate, feedIds });

      // A rate-limited session is NOT a session with no signal. Conflating the
      // two is what made results irreproducible. Record it as a transient
      // failure so `dataIntegrity` can warn loudly instead of quietly lying.
      if (bundle.report.transientFailure) {
        errors.push({ sessionDate, error: "TRANSIENT (rate limit / network) — not a real 'no data' result", transient: true });
        continue;
      }

      const briefing = buildBriefing(bundle);

      const priceBars = bundle.results.stock_price_over_time?.ok
        ? Object.entries(bundle.results.stock_price_over_time.data.data)
            .map(([ts, v]) => ({ ts: Number(ts), value: v.closePrice }))
            .sort((a, b) => a.ts - b.ts)
        : [];

      if (!priceBars.length) {
        errors.push({ sessionDate, error: "no price bars (likely a market holiday)" });
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

  // REPRODUCIBILITY: sessions that failed to fetch were previously dropped in
  // silence, which meant the same rule on the same dates could return different
  // numbers on different runs. A backtest you cannot reproduce is worthless, so
  // failures are now surfaced as a first-class part of the result.
  const sessionsActuallyTested = sessionResults.length;
  const dataIntegrity = errors.length === 0
    ? "All requested sessions returned data."
    : `WARNING: ${errors.length}/${sessions.length} sessions returned no data and were excluded (${errors.map((e) => e.sessionDate).join(", ")}). Results are based on ${sessionsActuallyTested} sessions, not ${sessions.length}. Re-run if this looks like a transient fetch failure rather than market holidays.`;

  return {
    testable: true,
    rule: rule.description,
    ticker,
    sessionsRequested: sessions.length,
    sessionsTested: sessionsActuallyTested,
    sessionsWithErrors: errors.length,
    dataIntegrity,
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
      ? `INSUFFICIENT SAMPLE. Only ${trades.length} firings across ${sessionsActuallyTested} sessions. Any win rate here is noise — you need 20+ to say anything.`
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
