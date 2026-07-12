// Verifies the rule validator catches the exact failures that burned real
// refinement rounds. Each of these previously returned a SILENT "0 trades",
// which the models misread as "my threshold is too high".

import { validateRule } from "./backtest.js";

const CASES = [
  ["GPT round 3: invented feed + metric",
    { conditions: [{ feed: "call_premium_drift", metric: "zscore", operator: ">=", threshold: 25 }], action: "BUY_UNDERLYING" }],

  ["GPT round 4: invented metric on a real feed",
    { conditions: [{ feed: "interval_map", metric: "minutes_to_close", operator: ">", threshold: 60 }], action: "BUY_UNDERLYING" }],

  ["GPT round 3: logically impossible time window",
    { conditions: [
      { feed: "net_drift", metric: "netCallPremium", operator: ">=", threshold: 35 },
      { feed: "time_of_day", metric: "minutes_since_open", operator: "<=", threshold: 120 },
      { feed: "time_of_day", metric: "minutes_since_open", operator: ">=", threshold: 240 },
    ], action: "BUY_UNDERLYING" }],

  ["VALID rule (GPT round 2 — the one that actually learned)",
    { conditions: [
      { feed: "net_drift", metric: "netCallPremium", operator: ">", threshold: 8 },
      { feed: "net_flow", metric: "net premium change/min", operator: ">", threshold: 5 },
      { feed: "time_of_day", metric: "minutes_to_close", operator: ">", threshold: 90 },
    ], action: "BUY_UNDERLYING" }],
];

for (const [label, rule] of CASES) {
  const v = validateRule(rule);
  console.log(`\n${v.valid ? "PASS ✓" : "REJECT ✗"}  ${label}`);
  v.errors.forEach((e) => console.log(`     -> ${e}`));
}
