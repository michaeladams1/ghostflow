import assert from "node:assert/strict";
import { calendarDaysFromRows } from "./zeroDTEStore.js";
import { summarizeMonth } from "./zeroDTECalendar.js";

const day = calendarDaysFromRows([
  {
    session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.05, pnl: "100", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "A", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    // Same setup from Shen — dedupe keeps official counted (priority 0).
    session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in",
    entry_price: 1.05, pnl: "80", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "Shen FULL 3/3", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in",
    entry_price: 1.2, pnl: "-90", direction: "CALL", level_type: "PDL",
    tier: "A", points: 13, et_minute: 610, touch_number: 1,
  },
  {
    // Outside 10:00–10:15 — not Frontier.
    session_date: "2026-08-03", lane: "HIGH_QUALITY_A", counted: false, pb_window: "in",
    entry_price: 1, pnl: "50", direction: "PUT", level_type: "WHOLE_DOLLAR",
    tier: "Research 13-14", points: 13, et_minute: 640, touch_number: 1,
  },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: 1, pnl: "-25" },
  { session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in", entry_price: 1, pnl: "75",
    direction: "PUT", level_type: "PDH", tier: "Shen STANDARD 2/3", points: 8, et_minute: 605, touch_number: 1 },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: null, pnl: null },
])[0];

assert.deepEqual(day.tradePnls, [100, -90]);
assert.deepEqual(day.excludedTradePnls, [-25]);
assert.deepEqual(day.experimentalTradePnls, [50]);
assert.deepEqual(day.shenTradePnls, [80, 75]);
assert.deepEqual(day.frontierTradePnls, [100]);
assert.equal(day.pnl, 10);
assert.equal(day.excludedPnl, -25);
assert.equal(day.experimentalPnl, 50);
assert.equal(day.shenPnl, 155);
assert.equal(day.frontierPnl, 100);

const totals = summarizeMonth({ symbol: "SPY", year: 2026, month: 8, days: [day] }).totals;
assert.equal(totals.totalTrades, 2);
assert.equal(totals.winRate, 50);
assert.equal(totals.excludedTrades, 1);
assert.equal(totals.excludedWinRate, 0);
assert.equal(totals.experimentalWinRate, 100);
assert.equal(totals.shenWinRate, 100);
assert.equal(totals.frontierTrades, 1);
assert.equal(totals.frontierWinRate, 100);
assert.equal(totals.frontierPnl, 100);

console.log("0DTE saved calendar tests passed");
