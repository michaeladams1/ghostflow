import assert from "node:assert/strict";
import { calendarDaysFromRows } from "./zeroDTEStore.js";
import { summarizeMonth } from "./zeroDTECalendar.js";
import { frontierPaperPnl } from "./frontierV3.js";

const day = calendarDaysFromRows([
  {
    session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.05, exit_price: 1.26, frontier_exit_price: 2.10, frontier_pnl: 800,
    pnl: "100", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "A", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in",
    entry_price: 1.05, exit_price: 1.20, frontier_pnl: 400,
    pnl: "80", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "Shen FULL 3/3", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.2, exit_price: 1.05, frontier_pnl: -500,
    pnl: "-90", direction: "CALL", level_type: "PDL",
    tier: "A", points: 12, et_minute: 610, touch_number: 1,
  },
  {
    session_date: "2026-08-03", lane: "HIGH_QUALITY_A", counted: false, pb_window: "in",
    entry_price: 1, exit_price: 1.2, frontier_pnl: 200,
    pnl: "50", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "Research 13-14", points: 12, et_minute: 640, touch_number: 1,
  },
  {
    session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after",
    entry_price: 1.1, exit_price: 1.3, frontier_pnl: 300,
    pnl: "40", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "A", points: 13, et_minute: 580, touch_number: 1,
  },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: 1, exit_price: 0.9, pnl: "-25" },
  {
    session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in",
    entry_price: 1, exit_price: 1.2, frontier_pnl: 900,
    pnl: "75", direction: "PUT", level_type: "PDH", tier: "Shen STANDARD 2/3",
    points: 15, et_minute: 605, touch_number: 2,
  },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: null, pnl: null },
])[0];

assert.deepEqual(day.tradePnls, [100, -90]);
assert.deepEqual(day.excludedTradePnls, [40, -25]);
assert.deepEqual(day.experimentalTradePnls, [50]);
assert.deepEqual(day.shenTradePnls, [80, 75]);
// Best points first-touch uses stored frontier_pnl ($800), not playbook $100.
assert.deepEqual(day.frontierTradePnls, [800]);
assert.equal(day.frontierPnl, 800);

// Fallback path: no frontier_pnl column → $1k paper on playbook exit.
const fallback = calendarDaysFromRows([
  {
    session_date: "2026-08-04", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.00, exit_price: 1.20, pnl: "80",
    direction: "PUT", level_type: "WHOLE_DOLLAR", tier: "A",
    points: 12, et_minute: 610, touch_number: 1,
  },
])[0];
assert.equal(fallback.frontierPnl, frontierPaperPnl(1.00, 1.20));

const totals = summarizeMonth({ symbol: "SPY", year: 2026, month: 8, days: [day] }).totals;
assert.equal(totals.frontierTrades, 1);
assert.equal(totals.frontierPnl, 800);

console.log("0DTE saved calendar tests passed");
