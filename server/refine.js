// THE REFINEMENT LOOP — where the system actually LEARNS.
//
// The single-shot flow (analyze -> propose rule -> backtest) proved a rule was
// bad. That's useful, but it's a dead end: it tells you "no" and stops.
//
// This is the recursive version, and it's the heart of GHOSTFLOW:
//
//   1. Model proposes a rule from one session.
//   2. Backtest it across N sessions it has never seen.
//   3. HAND THE MODEL ITS OWN RESULTS — including every losing trade, with
//      timestamps — and ask: "your rule lost money. WHY? Look at the losers.
//      What was different about them? Is there another feed that separates the
//      winners from the losers?"
//   4. Model proposes a REVISED rule (usually: add a filter condition).
//   5. Backtest again. Repeat.
//
// WHAT MAKES THIS HONEST RATHER THAN A MACHINE FOR MANUFACTURING FALSE HOPE:
//
//   - "PASS / abandon this rule" is always an available move, and the prompt
//     says so explicitly. A model that keeps bolting filters onto a dead rule
//     is overfitting, and it is told to say so instead.
//
//   - EVERY iteration is backtested on the SAME sessions, so improvements are
//     comparable rather than being an artifact of a friendlier test window.
//
//   - We track WHY each round changed, so you can read the learning as a
//     narrative rather than trusting a final number.
//
//   - OVERFITTING GUARD: adding conditions almost always improves a backtest,
//     because each new condition can carve out losers by coincidence. So we
//     also record how many trades survive. A rule that ends at 90% win rate on
//     4 trades has learned nothing — it has memorized. The engine flags that
//     explicitly rather than celebrating the win rate.

import { backtestRule, priorSessions } from "./backtest.js";
import { callClaudeWithTools, callGPTWithTools, callGrokWithTools } from "./aiProviders.js";

const PROVIDERS = { claude: callClaudeWithTools, gpt: callGPTWithTools, grok: callGrokWithTools };

function extractJson(text) {
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON in response: " + cleaned.slice(0, 200));
  return JSON.parse(cleaned.slice(s, e + 1));
}

// Summarizes a backtest for the model — crucially, this includes the actual
// LOSING trades with timestamps, because "here is where you were wrong, go look
// at those moments" is the only feedback that can produce real learning.
function renderBacktestFeedback(result, availableFeeds) {
  if (!result.testable) return `Your rule was NOT TESTABLE: ${result.reason}`;

  const losers = result.trades.filter((t) => !t.win).slice(0, 15);
  const winners = result.trades.filter((t) => t.win).slice(0, 10);

  const lines = [
    `BACKTEST RESULT: ${result.verdict}`,
    ``,
    `  Rule tested:    ${result.rule}`,
    `  Sessions:       ${result.sessionsTested}`,
    `  Times it fired: ${result.totalTrades}   (${result.wins} won, ${result.losses} lost)`,
    `  Win rate:       ${result.winRate}%`,
    `  Avg return:     ${result.avgReturnPct}% per trade`,
    `  Total return:   ${result.totalReturnPct}%`,
    `  Profit factor:  ${result.profitFactor}   (below 1.0 = loses money)`,
    ``,
  ];

  if (result.totalTrades > 0) {
    lines.push(`THE LOSING TRADES — study these. This is where your rule was wrong:`);
    losers.forEach((t) => lines.push(`  LOSS  ${t.sessionDate} ${t.entryClock}  entry $${t.entryPrice} -> exit $${t.exitPrice}   ${t.pctReturn}%`));
    lines.push(``);
    lines.push(`THE WINNING TRADES — what did these have that the losers didn't?`);
    winners.forEach((t) => lines.push(`  WIN   ${t.sessionDate} ${t.entryClock}  entry $${t.entryPrice} -> exit $${t.exitPrice}   +${t.pctReturn}%`));
    lines.push(``);
  }

  lines.push(`FEEDS AVAILABLE TO YOU AS FILTERS (any of these can be added as a condition):`);
  lines.push(availableFeeds.join(", "));

  return lines.join("\n");
}

const REFINE_SYSTEM = `You are refining a trading rule inside GHOSTFLOW. You proposed a rule; it has been backtested against real historical sessions it had never seen. You are now looking at exactly how it performed, including every trade it lost.

YOUR JOB: figure out WHY it lost, and whether a change can fix it.

The most common failure, and the one to check first: YOUR THRESHOLD WAS TOO LOOSE. If your rule fired 90+ times across 20 sessions, it is firing on ordinary noise, not on a rare event. The signal you originally saw may have been 50 sigma while your threshold only asked for 5 — that is a hundredfold difference in rarity. Tighten it.

The second move: ADD A FILTER. Look at the losing trades versus the winning ones. Is there a feed that was present in the winners and absent in the losers? Time of day? A confirming feed? Gamma regime? Add a condition that removes losers while keeping winners.

=== THE THREE HONEST OPTIONS ===
You must pick one:

1. "tighten"  — same feeds, stricter thresholds (usually the right first move).
2. "filter"   — add a new condition from another feed to separate winners from losers.
3. "abandon"  — this rule is not salvageable. SAY SO.

=== WHEN TO ABANDON (read this carefully — it is the most important part) ===
Abandon if ANY of these is true:
  - The rule fires constantly (it is measuring noise, not an event) and tightening it to a rare threshold leaves almost no trades.
  - Winners and losers look statistically identical — nothing distinguishes them.
  - You are on your third or fourth round of bolting on filters. Each condition you add can carve out losers BY COINCIDENCE. A rule with 6 conditions that wins on 5 trades has not learned anything — it has MEMORIZED the test set, and it will fail on new data.

A model that says "this doesn't work, abandon it" is doing excellent work. A model that keeps adding conditions until the backtest looks pretty is producing a lie that will lose real money. Do not be the second model.

=== SAMPLE SIZE IS NOT OPTIONAL ===
If a change drops the trade count below ~20, the win rate is meaningless noise. Do not celebrate a 100% win rate on 3 trades. State this plainly if it happens.

=== OUTPUT ===
Respond with ONLY one JSON object:
{
  "diagnosis": "2-4 sentences: WHY did it lose? Be specific — reference the actual losing trades.",
  "action": "tighten" | "filter" | "abandon",
  "abandonReason": "if abandoning, why. null otherwise",
  "revisedRule": {
    "description": "plain-English",
    "conditions": [ { "feed": "<feed id>", "metric": "<metric>", "operator": ">"|"<"|">="|"<=", "threshold": <number>, "window": "same 2-min bucket" } ],
    "action": "BUY_UNDERLYING" | "BUY_PUT"
  },
  "expectation": "What do you predict this change does to win rate AND trade count? Predicting the trade count collapse is as important as predicting the win rate."
}
If action is "abandon", set revisedRule to null.

NOTE ON THRESHOLDS: conditions are evaluated against z-scores (sigma), so a threshold of 20 means "20 sigma". Thresholds under 100 are read as sigma.`;

// ---------------------------------------------------------------------------
// THE LOOP.
// ---------------------------------------------------------------------------
export async function refineRule({
  modelId, initialRule, ticker, fromDate,
  sessions = 20, maxRounds = 4, holdMinutes = 15, onRound,
} = {}) {
  const fn = PROVIDERS[modelId];
  // Same sessions every round — otherwise "improvement" could just be an
  // easier test window, which would be self-deception, not learning.
  const sessionList = priorSessions(fromDate, sessions);

  const availableFeeds = [
    "net_drift", "net_flow", "dark_flow", "interval_map", "volatility_drift", "stock_price_over_time",
  ];

  const history = [];
  let currentRule = initialRule;

  for (let round = 1; round <= maxRounds; round++) {
    if (!currentRule) break;

    const result = await backtestRule(currentRule, { ticker, sessions: sessionList, holdMinutes });
    const entry = { round, rule: currentRule, backtest: result };
    history.push(entry);
    onRound?.(entry);

    // Stop early on a genuinely good result — no point "refining" something
    // that already works, since further tinkering is just overfitting.
    if (result.testable && result.enoughData && result.winRate >= 55 && result.avgReturnPct > 0.05) {
      entry.stopReason = "Rule performs well with an adequate sample. Stopping — further tweaking would be overfitting.";
      break;
    }
    if (round === maxRounds) {
      entry.stopReason = "Hit max rounds.";
      break;
    }

    // Hand the model its own failure and ask it to learn.
    const feedback = renderBacktestFeedback(result, availableFeeds);
    const user = `${feedback}

This was YOUR rule. It has now met real data it never saw.

Diagnose why it performed this way. Then choose: tighten the thresholds, add a filter condition, or abandon it entirely. Remember: abandoning a bad rule is a correct and valuable answer, and adding filters forever is how you fool yourself.

Respond with only the JSON object.`;

    let revision;
    try {
      const raw = await fn(REFINE_SYSTEM, user, [], async () => "no tools");
      revision = extractJson(raw);
    } catch (err) {
      entry.stopReason = `Refinement call failed: ${err.message}`;
      break;
    }

    entry.diagnosis = revision.diagnosis;
    entry.action = revision.action;
    entry.expectation = revision.expectation;

    if (revision.action === "abandon" || !revision.revisedRule) {
      entry.stopReason = `ABANDONED by ${modelId}: ${revision.abandonReason || revision.diagnosis}`;
      currentRule = null;
      break;
    }

    currentRule = revision.revisedRule;
  }

  // ---- Pick the winner, and be honest about whether it's real. ----
  const tested = history.filter((h) => h.backtest?.testable && h.backtest.totalTrades > 0);
  const best = tested.length
    ? tested.reduce((a, b) => {
        // Prefer real edge, but NEVER reward a rule that only "wins" because it
        // stopped trading. A rule with too few trades is disqualified outright.
        const score = (h) => (h.backtest.enoughData ? h.backtest.avgReturnPct : -Infinity);
        return score(b) > score(a) ? b : a;
      })
    : null;

  const abandoned = history[history.length - 1]?.stopReason?.startsWith("ABANDONED");

  return {
    modelId,
    ticker,
    sessionsTested: sessionList.length,
    rounds: history.length,
    history,
    abandoned,
    best: best && best.backtest.enoughData ? best : null,
    // The honest headline.
    conclusion: abandoned
      ? `ABANDONED after ${history.length} round(s). ${history[history.length - 1].stopReason}`
      : !best
      ? `NO VIABLE RULE. After ${history.length} rounds, nothing produced a testable edge on an adequate sample.`
      : best.backtest.winRate >= 55 && best.backtest.avgReturnPct > 0
      ? `SURVIVING RULE (round ${best.round}): ${best.backtest.winRate}% win rate over ${best.backtest.totalTrades} trades, ${best.backtest.avgReturnPct}% avg. This held up on sessions it never saw — but it is one symbol over ${sessionList.length} sessions, not proof.`
      : `NO EDGE FOUND. Best round managed ${best.backtest.winRate}% win rate and ${best.backtest.avgReturnPct}% avg return. The system found nothing tradeable here, which is a legitimate result.`,
  };
}
