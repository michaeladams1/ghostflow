// CONFIRMATION LIFT — separating SIGNAL from CONFIRMATION from NOISE.
//
// THE IDEA (Michael's, and it's the right one):
// A signal might work 60% of the time on its own. But if a volume spike or a
// bear trap ALSO appears alongside it, the win rate might jump to 90%. That
// second thing is NOT a signal — on its own it predicts nothing. It is a
// CONFIRMATION: it doesn't tell you to trade, it tells you THIS trade is a good
// one, once the base signal has already fired.
//
// The three roles are statistically distinct and the difference is measurable:
//
//   SIGNAL       — fires on its own and beats random. It IS the trade.
//   CONFIRMATION — worthless alone, but conditional on a signal, it lifts the
//                  win rate substantially. It is a filter, not a trigger.
//   NOISE        — no standalone edge, and no lift when added. Discard it.
//
// This engine MEASURES which is which instead of asking a model to guess:
//
//   1. Backtest the base rule alone.                    -> baseline win rate
//   2. For each candidate confirmer, backtest base+confirmer.
//   3. LIFT = confirmed win rate − baseline win rate.
//   4. Also backtest the confirmer ALONE. If it wins on its own, it is a
//      SIGNAL in its own right, not a confirmation.
//
// THE TRAP THIS AVOIDS:
// Adding ANY condition to a rule will usually raise its win rate, simply by
// removing trades — and with enough conditions you can carve out every loser by
// coincidence. So lift is only believed when the confirmed sample is still big
// enough to mean anything. A confirmer that lifts win rate to 100% by cutting
// the trade count from 40 to 3 has taught us nothing; it has memorized.

import { backtestRule } from "./backtest.js";
import { buildVocabulary } from "./metrics.js";

// Every bar metric is a candidate confirmer, except the ones already used by
// the base rule (a condition cannot confirm itself).
function candidateConfirmers(baseRule) {
  const vocab = buildVocabulary();
  const used = new Set(baseRule.conditions.map((c) => `${c.feed}.${c.metric}`));
  const out = [];
  for (const [feed, metrics] of Object.entries(vocab.bar)) {
    if (feed === "stock_price_over_time" || feed === "option_price_over_time") continue;
    for (const metric of metrics) {
      const key = `${feed}.${metric}`;
      if (!used.has(key)) out.push({ feed, metric });
    }
  }
  return out;
}

function classify({ baseWinRate, confirmedWinRate, aloneWinRate, confirmedTrades, aloneTrades, lift }) {
  // Not enough confirmed trades to say anything at all. Silence beats a guess.
  if (confirmedTrades < 8) {
    return {
      role: "UNTESTABLE",
      why: `Only ${confirmedTrades} trades survived when this was required alongside the base signal. That is too few to distinguish a real lift from luck.`,
    };
  }
  // It wins on its own -> it is a signal in its own right, not a confirmation.
  if (aloneTrades >= 15 && aloneWinRate >= 55) {
    return {
      role: "SIGNAL",
      why: `Wins ${aloneWinRate.toFixed(0)}% on its own across ${aloneTrades} trades — this is a standalone signal, not merely a confirmation.`,
    };
  }
  // Worthless alone, but lifts the base signal materially -> CONFIRMATION.
  if (lift >= 8) {
    return {
      role: "CONFIRMATION",
      why: `Alone it wins only ${aloneWinRate.toFixed(0)}% (no standalone edge), but when it appears ALONGSIDE the base signal the win rate goes ${baseWinRate.toFixed(0)}% -> ${confirmedWinRate.toFixed(0)}% (+${lift.toFixed(0)} pts). It does not tell you to trade; it tells you THIS trade is a good one.`,
    };
  }
  if (lift <= -8) {
    return {
      role: "ANTI-CONFIRMATION",
      why: `When this appears alongside the base signal, the win rate DROPS ${baseWinRate.toFixed(0)}% -> ${confirmedWinRate.toFixed(0)}% (${lift.toFixed(0)} pts). Its presence is a reason to SKIP the trade.`,
    };
  }
  return {
    role: "NOISE",
    why: `No standalone edge (${aloneWinRate.toFixed(0)}% alone) and no meaningful lift when added (${lift >= 0 ? "+" : ""}${lift.toFixed(0)} pts). It carries no information about this setup.`,
  };
}

export async function analyzeConfirmers(baseRule, { ticker, sessions, holdMinutes = 15, threshold = 2.5, onProgress } = {}) {
  // 1. Baseline: how does the rule do on its own?
  const base = await backtestRule(baseRule, { ticker, sessions, holdMinutes });
  if (!base.testable || base.totalTrades < 10) {
    return {
      ok: false,
      reason: base.testable
        ? `The base rule only produced ${base.totalTrades} trades. There is no meaningful baseline to lift, so confirmation analysis would be measuring noise.`
        : base.reason,
      base,
    };
  }

  const candidates = candidateConfirmers(baseRule);
  const results = [];

  for (const c of candidates) {
    const key = `${c.feed}.${c.metric}`;
    try {
      // 2. Base rule + this candidate as an extra trigger.
      const withConfirmer = {
        ...baseRule,
        description: `${baseRule.description}  [+ ${key} z > ${threshold}]`,
        conditions: [...baseRule.conditions, { feed: c.feed, metric: c.metric, operator: ">", threshold }],
      };
      const confirmed = await backtestRule(withConfirmer, { ticker, sessions, holdMinutes });

      // 3. The candidate ENTIRELY ON ITS OWN — is it actually a signal?
      const alone = await backtestRule({
        description: `${key} alone`,
        conditions: [{ feed: c.feed, metric: c.metric, operator: ">", threshold }],
        action: baseRule.action,
      }, { ticker, sessions, holdMinutes });

      if (!confirmed.testable) continue;

      const lift = confirmed.winRate - base.winRate;
      const verdict = classify({
        baseWinRate: base.winRate,
        confirmedWinRate: confirmed.winRate,
        aloneWinRate: alone.testable ? alone.winRate : 0,
        confirmedTrades: confirmed.totalTrades,
        aloneTrades: alone.testable ? alone.totalTrades : 0,
        lift,
      });

      const row = {
        key, feed: c.feed, metric: c.metric,
        baseWinRate: base.winRate,
        confirmedWinRate: confirmed.winRate,
        confirmedTrades: confirmed.totalTrades,
        aloneWinRate: alone.testable ? alone.winRate : null,
        aloneTrades: alone.testable ? alone.totalTrades : 0,
        lift: +lift.toFixed(1),
        // Honest guard: a lift produced by shrinking the sample from 40 to 3 is
        // memorization, not learning. Surfaced rather than buried.
        tradesRetainedPct: +((confirmed.totalTrades / base.totalTrades) * 100).toFixed(0),
        role: verdict.role,
        why: verdict.why,
      };
      results.push(row);
      onProgress?.(row);
    } catch (err) {
      // A candidate that errors is skipped, never silently counted as noise.
      results.push({ key, feed: c.feed, metric: c.metric, role: "ERROR", why: err.message });
    }
  }

  const confirmations = results.filter((r) => r.role === "CONFIRMATION").sort((a, b) => b.lift - a.lift);
  const signals = results.filter((r) => r.role === "SIGNAL");
  const anti = results.filter((r) => r.role === "ANTI-CONFIRMATION").sort((a, b) => a.lift - b.lift);
  const noise = results.filter((r) => r.role === "NOISE");

  return {
    ok: true,
    baseRule: baseRule.description,
    baseWinRate: base.winRate,
    baseTrades: base.totalTrades,
    sessionsTested: base.sessionsTested,
    results,
    confirmations,
    signals,
    antiConfirmations: anti,
    noise,
    summary: confirmations.length
      ? `Base signal wins ${base.winRate}% over ${base.totalTrades} trades. ${confirmations.length} genuine CONFIRMATION(s) found — the strongest is ${confirmations[0].key}, which lifts the win rate to ${confirmations[0].confirmedWinRate}% (+${confirmations[0].lift} pts) while retaining ${confirmations[0].tradesRetainedPct}% of the trades.`
      : `Base signal wins ${base.winRate}% over ${base.totalTrades} trades. NO genuine confirmations found — nothing tested materially lifted the win rate. That is an honest result, not a failure: it means this setup does not have a reliable confirming tell.`,
  };
}
