import assert from "node:assert/strict";
import { calendarDaysFromRows } from "./zeroDTEStore.js";
import { summarizeMonth } from "./zeroDTECalendar.js";
import { frontierPaperPnl } from "./frontierV3.js";

const day = calendarDaysFromRows([
  {
    session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.05, exit_price: 1.26, pnl: "100", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "A", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    // Same setup from Shen — dedupe keeps official counted (priority 0).
    session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in",
    entry_price: 1.05, exit_price: 1.20, pnl: "80", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "Shen FULL 3/3", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    // CALL@PDL allowed in v5, but lower points than the 13-pt PUT — best/day keeps PUT.
    session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.2, exit_price: 1.05, pnl: "-90", direction: "CALL", level_type: "PDL",
    tier: "A", points: 12, et_minute: 610, touch_number: 1,
  },
  {
    session_date: "2026-08-03", lane: "HIGH_QUALITY_A", counted: false, pb_window: "in",
    entry_price: 1, exit_price: 1.2, pnl: "50", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "Research 13-14", points: 12, et_minute: 640, touch_number: 1,
  },
  {
    // Before 9:45 — excluded.
    session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after",
    entry_price: 1.1, exit_price: 1.3, pnl: "40", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "A", points: 13, et_minute: 580, touch_number: 1,
  },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: 1, exit_price: 0.9, pnl: "-25" },
  {
    // Second touch — excluded from Frontier v5.
    session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in",
    entry_price: 1, exit_price: 1.2, pnl: "75",
    direction: "PUT", level_type: "PDH", tier: "Shen STANDARD 2/3", points: 15, et_minute: 605, touch_number: 2,
  },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: null, pnl: null },
])[0];

assert.deepEqual(day.tradePnls, [100, -90]);
assert.deepEqual(day.excludedTradePnls, [40, -25]);
assert.deepEqual(day.experimentalTradePnls, [50]);
assert.deepEqual(day.shenTradePnls, [80, 75]);

// Frontier P&L is recomputed at $8k paper size from entry/exit, not stored pnl.
const expectedFrontier = frontierPaperPnl(1.05, 1.26);
assert.deepEqual(day.frontierTradePnls, [expectedFrontier]);
assert.equal(day.frontierPnl, expectedFrontier);
assert.ok(expectedFrontier > 100, "paper size should lift P&L above the $1k stored row");

const totals = summarizeMonth({ symbol: "SPY", year: 2026, month: 8, days: [day] }).totals;
assert.equal(totals.totalTrades, 2);
assert.equal(totals.winRate, 50);
assert.equal(totals.frontierTrades, 1);
assert.equal(totals.frontierWinRate, 100);
assert.equal(totals.frontierPnl, expectedFrontier);

console.log("0DTE saved calendar tests passed");
