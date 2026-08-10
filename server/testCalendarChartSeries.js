// Calendar chart series: cumulative P&L from $0; deployed stays per-period /
// avg-daily for aggregates (never a lifetime sum of entries).
import assert from "node:assert/strict";
import {
  avgDailyDeployed, buildLaneChartSeries,
} from "../src/calendarChartSeries.js";
import { summarizeMonth } from "./zeroDTECalendar.js";

assert.equal(avgDailyDeployed([3000, 1000]), 2000, "Mon $3k + Tue $1k → $2k avg");
assert.equal(avgDailyDeployed([]), 0);

const augustDays = [
  { date: "2026-08-03", pnl: 190, tradePnls: [190], deployed: 969, trades: 1 },
  { date: "2026-08-04", pnl: -120, tradePnls: [-120], deployed: 980, trades: 1 },
];

const series = buildLaneChartSeries(augustDays, "official", { mode: "month" });
assert.equal(series.length, 2, "two active August days");
assert.equal(series[0].cumulative, 190, "first plot is +$190 after day 1");
assert.equal(series[1].cumulative, 70, "second plot is +$70 after day 2");
assert.equal(series[0].dayPnl, 190);
assert.equal(series[1].dayPnl, -120);
assert.equal(series[0].deployed, 969, "day 1 deployed is that day's total only");
assert.equal(series[1].deployed, 980, "day 2 deployed is that day's total only — not cumulative");
assert.notEqual(series[1].deployed, 969 + 980, "deployed must not sum prior days");

const yearDays = [
  ...augustDays,
  { date: "2026-09-02", pnl: 50, tradePnls: [50], deployed: 500, trades: 1 },
];
const year = buildLaneChartSeries(yearDays, "official", { mode: "year" });
assert.equal(year[7].dayPnl, 70, "August month P&L");
assert.equal(year[7].cumulative, 70, "year cumulative through August");
assert.equal(year[7].deployed, 974.5, "August chart bar = avg daily deployed");
assert.equal(year[8].dayPnl, 50);
assert.equal(year[8].cumulative, 120, "year cumulative through September");
assert.equal(year[8].deployed, 500, "September avg daily with one day");

const monthTotals = summarizeMonth({
  symbol: "SPY", year: 2026, month: 8, days: [
    { date: "2026-08-03", pnl: 0, trades: 0, deployed: 0, volumeTrades: 3, volumeDeployed: 3000, volumeTradePnls: [1, 1, 1], tradePnls: [] },
    { date: "2026-08-04", pnl: 0, trades: 0, deployed: 0, volumeTrades: 1, volumeDeployed: 1000, volumeTradePnls: [1], tradePnls: [] },
  ],
}).totals;
assert.equal(monthTotals.volumeDeployed, 2000, "month cap = avg daily volume deployed");
assert.equal(monthTotals.volumeTrades, 4);

console.log("testCalendarChartSeries: ok");
