import assert from "node:assert/strict";
import { calendarDaysFromRows } from "./zeroDTEStore.js";

const day = calendarDaysFromRows([
  { session_date: "2026-08-03", lane: "official", counted: true, pb_window: "in", entry_price: 1, pnl: "100" },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: 1, pnl: "-25" },
  { session_date: "2026-08-03", lane: "HIGH_QUALITY_A", counted: false, pb_window: "in", entry_price: 1, pnl: "50" },
  { session_date: "2026-08-03", lane: "SHEN_CONVICTION", counted: false, pb_window: "in", entry_price: 1, pnl: "75" },
  { session_date: "2026-08-03", lane: "official", counted: false, pb_window: "after", entry_price: null, pnl: null },
])[0];

assert.deepEqual(day.tradePnls, [100]);
assert.deepEqual(day.excludedTradePnls, [-25]);
assert.deepEqual(day.experimentalTradePnls, [50]);
assert.deepEqual(day.shenTradePnls, [75]);
assert.equal(day.pnl, 100);
assert.equal(day.excludedPnl, -25);
assert.equal(day.experimentalPnl, 50);
assert.equal(day.shenPnl, 75);

console.log("0DTE saved calendar tests passed");
