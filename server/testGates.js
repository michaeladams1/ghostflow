// Proves the session-gate architecture works end-to-end: a rule that gates on
// GEX regime (impossible before today) and triggers on flow. Also verifies the
// validator rejects a gates-only rule, which can never produce a trade.

import { backtestRule, priorSessions, validateRule } from "./backtest.js";

console.log("=== VALIDATOR ===");
const gatesOnly = {
  description: "gates only, no trigger",
  conditions: [{ feed: "exposure_by_strike_gamma", metric: "net_gamma", operator: "<", threshold: 0 }],
  action: "BUY_UNDERLYING",
};
const v = validateRule(gatesOnly);
console.log(`gates-only rule valid? ${v.valid}`);
v.errors.forEach((e) => console.log(`  -> ${e}`));

// A REAL rule of the kind that was previously impossible to express:
// GATE on dealer gamma regime + TRIGGER on a flow spike.
const RULE = {
  description: "When dealers are SHORT gamma (net_gamma < 0, so they amplify moves rather than pin price), buy on a large net-call-premium spike outside the last hour.",
  conditions: [
    // SESSION GATE — regime. Known before the bell (standing dealer positioning).
    { feed: "exposure_by_strike_gamma", metric: "net_gamma", operator: "<", threshold: 0 },
    // BAR TRIGGERS — the entry moment.
    { feed: "net_drift", metric: "netCallPremium", operator: ">", threshold: 10 },
    { feed: "dark_flow", metric: "notionalValue", operator: ">", threshold: 2.5 },
    // TIME FILTER.
    { feed: "time_of_day", metric: "minutes_to_close", operator: ">", threshold: 60 },
  ],
  action: "BUY_UNDERLYING",
};

console.log(`\ngamma-gated rule valid? ${validateRule(RULE).valid}`);

const sessions = priorSessions("2026-07-10", 30);
console.log(`\n=== BACKTEST (${sessions.length} sessions) ===`);
console.log(`${RULE.description}\n`);

const r = await backtestRule(RULE, {
  ticker: "META", sessions, holdMinutes: 15,
  onProgress: (p) => console.log(`  ${p.sessionDate}: ${p.gateBlocked ? `GATE BLOCKED (${p.gateReason})` : `${p.firings} firing(s)`}`),
});

console.log(`\n${"=".repeat(60)}`);
console.log(`VERDICT: ${r.verdict}`);
console.log(`Gates: ${r.gateCount}  Triggers: ${r.triggerCount}  Days blocked by gate: ${r.gateBlockedDays}/${r.sessionsTested}`);
console.log(`Trades: ${r.totalTrades} (${r.wins}W/${r.losses}L) | ${r.winRate}% win | ${r.avgReturnPct}% avg | PF ${r.profitFactor}`);
