// THE NEGATIVE-PATTERN MINER.
//
// THE IDEA (Michael's): the initial one-day thesis can only ever find
// POSITIVE patterns — it has exactly one outcome (the day it was born from)
// in front of it, so there is no losing example anywhere for it to learn
// from. The first place real losing examples of the SAME trigger exist in
// quantity is the 260-session backtest. This module is the second pass over
// that backtest's firing history: of the (say) 100 times the trigger fired,
// what separated the ~50 that worked from the ~50 that didn't? Can filtering
// on that separation narrow 100 down to something like 60 winners / 10
// losers, instead of leaving the full noisy 100 in place?
//
// WHY THIS ISN'T JUST confirmation.js AGAIN:
// confirmation.js re-backtests the FULL (already gated) rule plus one
// candidate at a time — expensive (one live data pull per candidate) and, for
// rules like BE/MAN, starved before it starts (0-7 trades after gating).
// This module instead runs the TRIGGER ALONE (gates stripped) ONCE to get a
// real sample, captures a snapshot of every other feed at each trade's entry,
// and mines candidates from that ALREADY-COLLECTED data — no extra live pulls.
//
// WHY THE HOLDOUT SPLIT IS NOT OPTIONAL:
// Testing dozens of candidate filters against the same trades and keeping the
// best-looking one will manufacture an apparent "genuine lift" out of pure
// chance on some of them, even if none are real (the more candidates tried,
// the more of this happens — it's the same math as "some of 80 fair coins
// will look biased after 40 flips each, purely by luck"). So candidates are
// mined ONLY on the first 70% of firings (chronological), and the single best
// one is then tested — once, no second attempts — against the untouched most
// recent 30%. Only a filter that survives THAT counts as real.
//
// NO LOOKAHEAD IN THE FILTER ITSELF:
// Every candidate is built from data captured strictly at-or-before each
// trade's entry (backtest.js's snapshotBarMetricsBeforeEntry enforces this for
// bar metrics), and same-day cumulative feeds already flagged elsewhere as
// lookahead-risky (LOOKAHEAD_GATE_FEEDS) are excluded from candidate
// generation entirely, not just warned about after the fact.

import { backtestRule, splitConditions, priorSessions, LOOKAHEAD_GATE_FEEDS } from "./backtest.js";
import { buildVocabulary } from "./metrics.js";

const MIN_TOTAL_FIRINGS = 70;   // below this, neither 70% nor 30% means anything
const MIN_MINING_RETAINED = 15; // a candidate kept by too few mining trades is a guess
const MIN_HOLDOUT_RETAINED = 8; // ditto for the holdout check
const MIN_MINING_LIFT = 8;      // pts — same bar confirmation.js already uses
const MIN_HOLDOUT_LIFT = 5;     // pts — a bit more lenient; holdout is the smaller, noisier side
const BAR_Z_THRESHOLD = 2;      // "elevated" for a bar metric snapshot, in sigma

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function winRateOf(trades) {
  if (!trades.length) return 0;
  return (trades.filter((t) => t.win).length / trades.length) * 100;
}

function profitFactorOf(trades) {
  const wins = trades.filter((t) => t.win), losses = trades.filter((t) => !t.win);
  const grossWin = wins.reduce((a, t) => a + t.pctReturn, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pctReturn, 0));
  return grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
}

// Same compounding-equity math as backtest.js, applied to whatever subset of
// trades survives a filter — so the "narrowed" result is judged in real
// dollars the same way the unfiltered rule already is.
function equityOf(trades, startingCapital) {
  let equity = startingCapital, peak = startingCapital, maxDrawdownPct = 0;
  for (const t of trades) {
    equity *= 1 + t.pctReturn / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, ((equity - peak) / peak) * 100);
  }
  return { endingEquity: +equity.toFixed(2), maxDrawdownPct: +maxDrawdownPct.toFixed(2) };
}

// Builds every candidate filter worth trying, using ONLY the mining set to
// decide thresholds/directions — the holdout set must never influence what
// gets tried, or it stops being a holdout.
function buildCandidates(miningTrades) {
  const candidates = [];
  const vocab = buildVocabulary();

  // ---- SESSION-level candidates: median split, both directions ----
  const sessionKeys = new Set();
  for (const t of miningTrades) {
    for (const k of Object.keys(t.sessionMetricsSnapshot || {})) sessionKeys.add(k);
  }
  for (const key of sessionKeys) {
    const feed = key.split(".")[0];
    if (LOOKAHEAD_GATE_FEEDS.has(feed)) continue; // same-day cumulative — excluded, not just warned
    const values = miningTrades.map((t) => t.sessionMetricsSnapshot?.[key]).filter(Number.isFinite);
    if (values.length < miningTrades.length * 0.6) continue; // too sparse to trust
    const m = median(values);
    if (m == null) continue;
    candidates.push({
      key, kind: "session", direction: "above", threshold: m,
      matches: (t) => Number.isFinite(t.sessionMetricsSnapshot?.[key]) && t.sessionMetricsSnapshot[key] > m,
    });
    candidates.push({
      key, kind: "session", direction: "below", threshold: m,
      matches: (t) => Number.isFinite(t.sessionMetricsSnapshot?.[key]) && t.sessionMetricsSnapshot[key] < m,
    });
  }

  // ---- BAR-level candidates: elevated in either direction near entry ----
  const barKeys = new Set();
  for (const t of miningTrades) {
    for (const k of Object.keys(t.nearbyBarSnapshot || {})) barKeys.add(k);
  }
  for (const key of barKeys) {
    candidates.push({
      key, kind: "bar", direction: "above", threshold: BAR_Z_THRESHOLD,
      matches: (t) => Number.isFinite(t.nearbyBarSnapshot?.[key]) && t.nearbyBarSnapshot[key] > BAR_Z_THRESHOLD,
    });
    candidates.push({
      key, kind: "bar", direction: "below", threshold: -BAR_Z_THRESHOLD,
      matches: (t) => Number.isFinite(t.nearbyBarSnapshot?.[key]) && t.nearbyBarSnapshot[key] < -BAR_Z_THRESHOLD,
    });
  }

  return candidates;
}

function scoreCandidate(candidate, trades, baselineWinRate, minRetained) {
  const retained = trades.filter(candidate.matches);
  if (retained.length < minRetained) return null;
  const winRate = winRateOf(retained);
  return { ...candidate, retainedCount: retained.length, winRate: +winRate.toFixed(1), lift: +(winRate - baselineWinRate).toFixed(1) };
}

// ---------------------------------------------------------------------------
// THE MAIN ENTRY POINT.
// baseRule: the model's original rule (gates + trigger), from the standard
// per-model analysis. This function strips the gates, backtests the trigger
// ALONE across `sessions` days to get a real sample, then mines + validates
// a filter on that sample.
// ---------------------------------------------------------------------------
export async function mineNegativePattern(baseRule, { ticker, fromDate, sessions = 260, holdMinutes = 15, startingCapital = 10000 } = {}) {
  const { gates, triggers, timeFilters } = splitConditions(baseRule);

  if (!triggers.length) {
    return { ok: false, reason: "Rule has no bar-level trigger condition — gates alone cannot fire, so there is nothing to mine." };
  }

  const triggerOnlyRule = {
    ...baseRule,
    description: `${baseRule.description}  [TRIGGER ONLY — ${gates.length} original session gate(s) stripped for pattern mining]`,
    conditions: [...triggers, ...timeFilters],
  };

  const sessionList = priorSessions(fromDate, sessions);
  const triggerResult = await backtestRule(triggerOnlyRule, {
    ticker, sessions: sessionList, holdMinutes, startingCapital, captureSnapshots: true,
  });

  if (!triggerResult.testable) {
    return { ok: false, reason: triggerResult.reason, triggerOnlyRule };
  }
  if (triggerResult.totalTrades < MIN_TOTAL_FIRINGS) {
    return {
      ok: false,
      reason: `The trigger alone (gates stripped) fired only ${triggerResult.totalTrades} times across ${triggerResult.sessionsTested} sessions — need at least ${MIN_TOTAL_FIRINGS} to split 70/30 and have both sides mean anything. Not enough data to safely mine a filter.`,
      triggerOnlyRule,
      triggerOnlyResult: triggerResult,
    };
  }

  const sorted = [...triggerResult.trades].sort((a, b) => a.entryTs - b.entryTs);
  const splitIdx = Math.floor(sorted.length * 0.7);
  const mining = sorted.slice(0, splitIdx);
  const holdout = sorted.slice(splitIdx);

  const miningBaselineWinRate = winRateOf(mining);
  const holdoutBaselineWinRate = winRateOf(holdout);

  const candidates = buildCandidates(mining);
  const scored = candidates
    .map((c) => scoreCandidate(c, mining, miningBaselineWinRate, MIN_MINING_RETAINED))
    .filter(Boolean)
    .sort((a, b) => b.lift - a.lift || b.retainedCount - a.retainedCount);

  const topCandidates = scored.slice(0, 5).map((c) => ({
    key: c.key, kind: c.kind, direction: c.direction, threshold: +c.threshold.toFixed(2),
    miningRetained: c.retainedCount, miningWinRate: c.winRate, miningLift: c.lift,
  }));

  const best = scored.find((c) => c.lift >= MIN_MINING_LIFT) || null;

  const baseResult = {
    ok: true,
    triggerOnlyRule,
    totalFirings: triggerResult.totalTrades,
    sessionsTested: triggerResult.sessionsTested,
    miningCount: mining.length,
    holdoutCount: holdout.length,
    miningBaselineWinRate: +miningBaselineWinRate.toFixed(1),
    holdoutBaselineWinRate: +holdoutBaselineWinRate.toFixed(1),
    candidatesConsidered: candidates.length,
    topCandidates,
  };

  if (!best) {
    return {
      ...baseResult,
      bestCandidate: null,
      holdout: null,
      narrowedRule: null,
      narrowedBacktest: null,
      verdict: `NO NEGATIVE PATTERN FOUND. Tested ${candidates.length} candidate filters against the ${mining.length} mining trades; none lifted the win rate by ${MIN_MINING_LIFT}+ points while retaining ${MIN_MINING_RETAINED}+ trades. This is a legitimate result — it means the winners and losers of this trigger don't separate cleanly on any single feed available. The full unfiltered trigger result stands as-is.`,
    };
  }

  // ---- THE ONE-SHOT HOLDOUT TEST. Best candidate only, no second attempts. ----
  const holdoutRetained = holdout.filter(best.matches);
  const holdoutWinRate = winRateOf(holdoutRetained);
  const holdoutLift = +(holdoutWinRate - holdoutBaselineWinRate).toFixed(1);
  const holdoutEnough = holdoutRetained.length >= MIN_HOLDOUT_RETAINED;
  const confirmed = holdoutEnough && holdoutLift >= MIN_HOLDOUT_LIFT;

  const holdoutSummary = {
    key: best.key, kind: best.kind, direction: best.direction, threshold: +best.threshold.toFixed(2),
    retained: holdoutRetained.length,
    winRate: +holdoutWinRate.toFixed(1),
    lift: holdoutLift,
    enoughData: holdoutEnough,
    confirmed,
  };

  if (!confirmed) {
    return {
      ...baseResult,
      bestCandidate: { key: best.key, kind: best.kind, direction: best.direction, threshold: +best.threshold.toFixed(2), miningRetained: best.retainedCount, miningWinRate: best.winRate, miningLift: best.lift },
      holdout: holdoutSummary,
      narrowedRule: null,
      narrowedBacktest: null,
      verdict: !holdoutEnough
        ? `NOT ENOUGH HOLDOUT DATA TO CONFIRM. Best mining candidate (${best.key} ${best.direction} ${best.threshold.toFixed(2)}) showed +${best.lift}pts lift on ${best.retainedCount} mining trades, but only ${holdoutRetained.length} holdout trades matched it — below the ${MIN_HOLDOUT_RETAINED} needed to say anything. Treat this as unconfirmed, not disproven.`
        : `FILTER DID NOT SURVIVE THE HOLDOUT. Best mining candidate (${best.key} ${best.direction} ${best.threshold.toFixed(2)}) showed +${best.lift}pts lift on ${best.retainedCount} mining trades (${miningBaselineWinRate.toFixed(0)}% -> ${best.winRate}%), but on the ${holdoutRetained.length} untouched holdout trades it only produced ${holdoutLift >= 0 ? "+" : ""}${holdoutLift}pts (${holdoutBaselineWinRate.toFixed(0)}% -> ${holdoutWinRate.toFixed(1)}%). This is exactly the overfitting check working as intended — the apparent pattern was likely a coincidence of the mining window, not a real filter. The full unfiltered trigger result stands as-is.`,
    };
  }

  // ---- CONFIRMED: survived the holdout. Build the narrowed rule + its real stats. ----
  const allFiltered = [...mining, ...holdout].filter(best.matches).sort((a, b) => a.entryTs - b.entryTs);
  const narrowedWinRate = winRateOf(allFiltered);
  const narrowedPF = profitFactorOf(allFiltered);
  const { endingEquity, maxDrawdownPct } = equityOf(allFiltered, startingCapital);

  const filterCondition = best.kind === "session"
    ? { feed: best.key.split(".")[0], metric: best.key.split(".").slice(1).join("."), operator: best.direction === "above" ? ">" : "<", threshold: +best.threshold.toFixed(2), window: "session gate (empirically mined, holdout-confirmed)" }
    : { feed: best.key.split(".")[0], metric: best.key.split(".").slice(1).join("."), operator: best.direction === "above" ? ">" : "<", threshold: +best.threshold.toFixed(2), window: "within 10 min before entry, sigma units (empirically mined, holdout-confirmed)" };

  const narrowedRule = {
    ...triggerOnlyRule,
    description: `${triggerOnlyRule.description}  [+ mined filter: ${best.key} ${best.direction === "above" ? ">" : "<"} ${best.threshold.toFixed(2)}]`,
    conditions: [...triggerOnlyRule.conditions, filterCondition],
  };

  return {
    ...baseResult,
    bestCandidate: { key: best.key, kind: best.kind, direction: best.direction, threshold: +best.threshold.toFixed(2), miningRetained: best.retainedCount, miningWinRate: best.winRate, miningLift: best.lift },
    holdout: holdoutSummary,
    narrowedRule,
    narrowedBacktest: {
      totalTrades: allFiltered.length,
      winRate: +narrowedWinRate.toFixed(1),
      profitFactor: narrowedPF === Infinity ? "Inf" : +narrowedPF.toFixed(2),
      startingCapital,
      endingEquity,
      totalPnlDollars: +(endingEquity - startingCapital).toFixed(2),
      maxDrawdownPct,
    },
    verdict: `FILTER CONFIRMED. ${best.key} ${best.direction === "above" ? ">" : "<"} ${best.threshold.toFixed(2)} lifted win rate on BOTH the mining set (+${best.lift}pts, ${best.retainedCount} trades) AND the untouched holdout set (+${holdoutLift}pts, ${holdoutRetained.length} trades) — this is real, not a mining-window coincidence. Applying it across all ${triggerResult.totalTrades} original firings narrows the trade set to ${allFiltered.length}, at a ${narrowedWinRate.toFixed(0)}% win rate, profit factor ${narrowedPF === Infinity ? "Inf" : narrowedPF.toFixed(2)}. $${startingCapital.toLocaleString()} -> $${endingEquity.toLocaleString()}.`,
  };
}
