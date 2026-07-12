// Backtests the REAL rule Grok proposed in the live run, against 20 sessions
// it has never seen. This is the moment of truth for the whole system: does a
// signal found on one afternoon actually hold up, or was it curve-fitting?

import { backtestRule, priorSessions } from "./backtest.js";

// Grok's actual output from the live 3-model run (machine-checkable, which is
// exactly why it can be tested at all — GPT's prose rule could not be).
const GROK_RULE = {
  description: "net_drift.netCallPremium z > 5 AND net_flow z > 3 inside same 2-min bucket -> buy underlying at bucket close",
  conditions: [
    { feed: "net_drift", metric: "netCallPremium", operator: ">", threshold: 5, window: "same 2-min bucket" },
    { feed: "net_flow", metric: "net premium change/min", operator: ">", threshold: 3, window: "same 2-min bucket" },
  ],
  action: "BUY_UNDERLYING",
};

const sessions = priorSessions("2026-07-10", 20);
console.log(`Backtesting Grok's rule on META across ${sessions.length} sessions (${sessions[0]} .. ${sessions[sessions.length - 1]})`);
console.log(`Rule: ${GROK_RULE.description}\n`);

const result = await backtestRule(GROK_RULE, {
  ticker: "META",
  sessions,
  holdMinutes: 15,
  onProgress: ({ sessionDate, firings }) => console.log(`  ${sessionDate}: ${firings} firing(s)`),
});

console.log("\n" + "=".repeat(64));
console.log(`VERDICT: ${result.verdict}`);
console.log("=".repeat(64));
console.log(`Trades:        ${result.totalTrades}  (${result.wins}W / ${result.losses}L)`);
console.log(`Win rate:      ${result.winRate}%`);
console.log(`Avg return:    ${result.avgReturnPct}% per trade`);
console.log(`Total return:  ${result.totalReturnPct}%`);
console.log(`Profit factor: ${result.profitFactor}`);
if (result.bestTrade) console.log(`Best:  ${result.bestTrade.sessionDate} ${result.bestTrade.entryClock}  ${result.bestTrade.pctReturn}%`);
if (result.worstTrade) console.log(`Worst: ${result.worstTrade.sessionDate} ${result.worstTrade.entryClock}  ${result.worstTrade.pctReturn}%`);
if (result.errors.length) console.log(`\nSessions with no data (holidays etc): ${result.errors.length}`);
