// Calendar capital: avg daily (no $0 days) + max concurrent — never lifetime sum.
import assert from "node:assert/strict";
import {
  avgDailyDeployed, buildLaneChartSeries, maxConcurrentDeployed,
} from "../src/calendarChartSeries.js";
import { summarizeMonth } from "./zeroDTECalendar.js";

assert.equal(avgDailyDeployed([3000, 1000]), 2000, "Mon $3k + Tue $1k → $2k avg");
assert.equal(avgDailyDeployed([3000, 0, 1000]), 2000, "skip $0 days");
assert.equal(avgDailyDeployed([]), 0);

// July Playbook shape: sequential trades on the 27th must not stack for max.
assert.equal(maxConcurrentDeployed([
  { startMin: 611, endMin: 615, deployed: 981 },
  { startMin: 626, endMin: 628, deployed: 404 },
]), 981, "sequential same-day trades → max is the larger fill");
assert.equal(maxConcurrentDeployed([
  { startMin: 600, endMin: 620, deployed: 981 },
  { startMin: 610, endMin: 615, deployed: 404 },
]), 1385, "overlapping trades stack while both are open");

const julyDays = [
  {
    date: "2026-07-27", trades: 2, deployed: 1385, tradePnls: [198, -52], tradeDeployeds: [981, 404],
    tradeIntervals: [
      { startMin: 611, endMin: 615, deployed: 981 },
      { startMin: 626, endMin: 628, deployed: 404 },
    ],
  },
  {
    date: "2026-07-29", trades: 1, deployed: 258, tradePnls: [-32], tradeDeployeds: [258],
    tradeIntervals: [{ startMin: 625, endMin: 640, deployed: 258 }],
  },
  {
    date: "2026-07-30", trades: 1, deployed: 885, tradePnls: [175], tradeDeployeds: [885],
    tradeIntervals: [{ startMin: 602, endMin: 608, deployed: 885 }],
  },
  {
    date: "2026-07-31", trades: 2, deployed: 799, tradePnls: [-54, 72], tradeDeployeds: [435, 364],
    tradeIntervals: [
      { startMin: 600, endMin: 601, deployed: 435 },
      { startMin: 616, endMin: 617, deployed: 364 },
    ],
  },
];

const july = summarizeMonth({ symbol: "SPY", year: 2026, month: 7, days: julyDays }).totals;
assert.equal(july.deployed, 831.75, "July avg daily — not the $3327 sum");
assert.equal(july.maxDeployed, 981, "July max at once — not peak-day sum $1385");
assert.notEqual(july.deployed, 3327);
assert.notEqual(july.maxDeployed, 3327);

const augustDays = [
  { date: "2026-08-03", pnl: 190, tradePnls: [190], deployed: 969, trades: 1 },
  { date: "2026-08-04", pnl: -120, tradePnls: [-120], deployed: 980, trades: 1 },
];

const series = buildLaneChartSeries(augustDays, "official", { mode: "month" });
assert.equal(series[0].cumulative, 190);
assert.equal(series[1].cumulative, 70);
assert.equal(series[0].deployed, 969);
assert.equal(series[1].deployed, 980);

const year = buildLaneChartSeries([
  ...augustDays,
  { date: "2026-09-02", pnl: 50, tradePnls: [50], deployed: 500, trades: 1 },
], "official", { mode: "year" });
assert.equal(year[7].deployed, 974.5, "August year-bar = avg daily");
assert.equal(year[8].deployed, 500);

const monthTotals = summarizeMonth({
  symbol: "SPY", year: 2026, month: 8, days: [
    { date: "2026-08-03", pnl: 0, trades: 0, deployed: 0, volumeTrades: 3, volumeDeployed: 3000, volumeTradePnls: [1, 1, 1], tradePnls: [],
      volumeTradeIntervals: [
        { startMin: 600, endMin: 601, deployed: 1000 },
        { startMin: 602, endMin: 603, deployed: 1000 },
        { startMin: 604, endMin: 605, deployed: 1000 },
      ] },
    { date: "2026-08-04", pnl: 0, trades: 0, deployed: 0, volumeTrades: 1, volumeDeployed: 1000, volumeTradePnls: [1], tradePnls: [],
      volumeTradeIntervals: [{ startMin: 600, endMin: 610, deployed: 1000 }] },
  ],
}).totals;
assert.equal(monthTotals.volumeDeployed, 2000, "month cap = avg daily volume deployed");
assert.equal(monthTotals.volumeMaxDeployed, 1000, "month max at once with sequential fills");

console.log("testCalendarChartSeries: ok");
