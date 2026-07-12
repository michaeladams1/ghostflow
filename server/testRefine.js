// Runs the recursive refinement loop for real, starting from the rule Grok
// proposed (which the backtest already killed: 96 firings, 41.7% win rate).
// The question this answers: can the model diagnose its own failure and fix
// it — or will it honestly abandon?

import { refineRule } from "./refine.js";

const GROK_RULE = {
  description: "net_drift.netCallPremium z > 5 AND net_flow z > 3 in same 2-min bucket -> buy underlying",
  conditions: [
    { feed: "net_drift", metric: "netCallPremium", operator: ">", threshold: 5, window: "same 2-min bucket" },
    { feed: "net_flow", metric: "net premium change/min", operator: ">", threshold: 3, window: "same 2-min bucket" },
  ],
  action: "BUY_UNDERLYING",
};

const modelId = process.argv[2] || "grok";
console.log(`Refining ${modelId}'s rule on META. Backtesting each round on 20 unseen sessions.\n`);

const out = await refineRule({
  modelId,
  initialRule: GROK_RULE,
  ticker: "META",
  fromDate: "2026-07-10",
  sessions: 20,
  maxRounds: 4,
  onRound: (e) => {
    const b = e.backtest;
    console.log(`\n${"=".repeat(66)}`);
    console.log(`ROUND ${e.round}`);
    console.log(`  rule:   ${e.rule.description}`);
    console.log(`  conds:  ${e.rule.conditions.map((c) => `${c.feed}.${c.metric} ${c.operator} ${c.threshold}`).join("  AND  ")}`);
    if (b.testable) {
      console.log(`  -> ${b.totalTrades} trades | ${b.winRate}% win | ${b.avgReturnPct}% avg | PF ${b.profitFactor}`);
      console.log(`  -> ${b.verdict}`);
    } else {
      console.log(`  -> NOT TESTABLE: ${b.reason}`);
    }
  },
});

console.log(`\n${"=".repeat(66)}`);
console.log("MODEL'S REASONING EACH ROUND:");
out.history.forEach((h) => {
  if (h.diagnosis) {
    console.log(`\n[round ${h.round}] action=${h.action}`);
    console.log(`  diagnosis:   ${h.diagnosis}`);
    console.log(`  expectation: ${h.expectation}`);
  }
  if (h.stopReason) console.log(`\n  STOP: ${h.stopReason}`);
});

console.log(`\n${"=".repeat(66)}`);
console.log(`CONCLUSION: ${out.conclusion}`);
