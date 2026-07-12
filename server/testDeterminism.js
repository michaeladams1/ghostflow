// DETERMINISM CHECK. The same rule on the same sessions MUST produce the same
// numbers, every time. Earlier, Grok's run reported 89 trades and Claude's
// reported 41 for the identical rule — that irreproducibility made every
// backtest number meaningless. This proves the fix.

import { backtestRule, priorSessions } from "./backtest.js";

const RULE = {
  description: "net_drift z>5 AND net_flow z>3",
  conditions: [
    { feed: "net_drift", metric: "netCallPremium", operator: ">", threshold: 5 },
    { feed: "net_flow", metric: "net premium change/min", operator: ">", threshold: 3 },
  ],
  action: "BUY_UNDERLYING",
};

const sessions = priorSessions("2026-07-10", 10);

const a = await backtestRule(RULE, { ticker: "META", sessions, holdMinutes: 15 });
const b = await backtestRule(RULE, { ticker: "META", sessions, holdMinutes: 15 });

console.log(`Run A: ${a.totalTrades} trades | ${a.winRate}% win | sessions tested ${a.sessionsTested}/${a.sessionsRequested}`);
console.log(`Run B: ${b.totalTrades} trades | ${b.winRate}% win | sessions tested ${b.sessionsTested}/${b.sessionsRequested}`);
console.log(`\nData integrity: ${a.dataIntegrity}`);
console.log(`\nDETERMINISTIC: ${a.totalTrades === b.totalTrades && a.winRate === b.winRate ? "YES — identical results" : "NO — STILL BROKEN"}`);
console.log(`\nWith 30-min cooldown, firings per session:`);
a.sessionResults.forEach((s) => console.log(`  ${s.sessionDate}: ${s.firings}`));
