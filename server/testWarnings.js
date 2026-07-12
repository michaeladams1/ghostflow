// Runs GPT's ACTUAL rule from the live run — the one with a no-op gate
// (net_gamma > 50 against a raw value of 65,426,346) and a lookahead gate
// (contract_statistics.call_put_premium_ratio, a same-day cumulative total).
// Both would previously have passed in total silence.

import { backtestRule, priorSessions } from "./backtest.js";

const GPT_RULE = {
  description: "In a call-dominant, positive-gamma, eventful session, buy META when an extremely rare intraday burst of net call premium and volume occurs.",
  conditions: [
    { feed: "exposure_by_strike_gamma", metric: "net_gamma", operator: ">", threshold: 50 },        // NO-OP: real value is ~65,000,000
    { feed: "term_structure", metric: "front_minus_back_iv", operator: ">", threshold: 25 },
    { feed: "contract_statistics", metric: "call_put_premium_ratio", operator: ">", threshold: 3 }, // LOOKAHEAD: same-day cumulative
    { feed: "net_drift", metric: "netCallPremium", operator: ">", threshold: 30 },
    { feed: "net_flow", metric: "net_premium", operator: ">", threshold: 20 },
    { feed: "time_of_day", metric: "minutes_to_close", operator: ">", threshold: 60 },
  ],
  action: "BUY_UNDERLYING",
};

const sessions = priorSessions("2026-07-10", 25);
const r = await backtestRule(GPT_RULE, { ticker: "META", sessions, holdMinutes: 15 });

console.log(`VERDICT: ${r.verdict}\n`);
console.log(`Gates: ${r.gateCount}  Triggers: ${r.triggerCount}  Gate-blocked days: ${r.gateBlockedDays}/${r.sessionsTested}\n`);

console.log("Per-gate block counts (0 = the gate never did anything):");
Object.entries(r.gateBlockCounts).forEach(([k, v]) => console.log(`  ${k.padEnd(50)} blocked ${v} days`));

console.log(`\nWARNINGS (${r.warnings.length}):`);
r.warnings.forEach((w) => console.log(`\n  !! ${w}`));

console.log(`\nTrades: ${r.totalTrades} | ${r.winRate}% win | ${r.avgReturnPct}% avg`);
console.log(`Lookahead-contaminated: ${r.hasLookahead}`);
