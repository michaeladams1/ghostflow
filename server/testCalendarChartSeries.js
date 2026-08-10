// Calendar chart series: cumulative P&L from $0; deployed stays per-period.
import assert from "node:assert/strict";
import { buildLaneChartSeries } from "../src/calendarChartSeries.js";

const augustDays = [
  { date: "2026-08-03", pnl: 190, tradePnls: [190], deployed: 969 },
  { date: "2026-08-04", pnl: -120, tradePnls: [-120], deployed: 980 },
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
  { date: "2026-09-02", pnl: 50, tradePnls: [50], deployed: 500 },
];
const year = buildLaneChartSeries(yearDays, "official", { mode: "year" });
assert.equal(year[7].dayPnl, 70, "August month P&L");
assert.equal(year[7].cumulative, 70, "year cumulative through August");
assert.equal(year[7].deployed, 1949, "August deployed = sum of August days only");
assert.equal(year[8].dayPnl, 50);
assert.equal(year[8].cumulative, 120, "year cumulative through September");
assert.equal(year[8].deployed, 500, "September deployed is not cumulative with August");

console.log("testCalendarChartSeries: ok");
