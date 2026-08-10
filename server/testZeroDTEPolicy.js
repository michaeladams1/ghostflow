import assert from "node:assert/strict";
import {
  classifyResearchCandidate, classifyShenConviction, isFrontierFire,
  pickOtmStrike, playbookTouchPolicy,
} from "./zeroDTE.js";
import {
  FRONTIER_PAPER_DOLLARS, FRONTIER_SL_MULT, FRONTIER_TP_MULT,
  FRONTIER_V3_DIRECTION, FRONTIER_V3_LEVEL_TYPES, FRONTIER_V3_MIN_POINTS,
  frontierDeployedNotional, frontierPaperPnl, frontierV3FlowVeto,
  passesFrontierV3, selectFrontierBestPerDay, summarizeFrontierFires,
} from "./frontierV3.js";
import { walkBracketBars } from "./zeroDTEOptionSim.js";

const ts = (clock) => `2026-08-07T${clock}:00-04:00`;

assert.equal(pickOtmStrike({ level: 753.42, direction: "CALL" }), 754);
assert.equal(pickOtmStrike({ level: 753.42, direction: "PUT" }), 753);
assert.equal(pickOtmStrike({ level: 755, direction: "CALL" }), 756);
assert.equal(pickOtmStrike({ level: 755, direction: "PUT" }), 754);

assert.deepEqual(playbookTouchPolicy({ touchNumber: 1, exhaustionMove: 0 }), {
  eligible: true, dropSizeTier: false, exhaustionException: false,
});
assert.deepEqual(playbookTouchPolicy({ touchNumber: 2, exhaustionMove: 0 }), {
  eligible: true, dropSizeTier: true, exhaustionException: false,
});
assert.equal(playbookTouchPolicy({ touchNumber: 3, exhaustionMove: 3.99 }).eligible, false);
assert.equal(playbookTouchPolicy({ touchNumber: 3, exhaustionMove: 4 }).eligible, true);
assert.equal(playbookTouchPolicy({ touchNumber: 4, exhaustionMove: 10 }).eligible, false);

assert.equal(classifyResearchCandidate({ minutes: 600, points: 13, aplusThreshold: 15, levelPoints: 4, hasTwoConfirmations: true, touchNumber: 1, isAplus: false }), "HIGH_QUALITY_A");
assert.equal(classifyResearchCandidate({ minutes: 600, points: 12, aplusThreshold: 15, levelPoints: 4, hasTwoConfirmations: true, touchNumber: 1, isAplus: false }), null);
assert.equal(classifyResearchCandidate({ minutes: 700, points: 15, aplusThreshold: 15, levelPoints: 4, hasTwoConfirmations: true, touchNumber: 1, isAplus: true }), "EXTENDED_A_PLUS");
assert.equal(classifyResearchCandidate({ minutes: 751, points: 15, aplusThreshold: 15, levelPoints: 4, hasTwoConfirmations: true, touchNumber: 1, isAplus: true }), null);

assert.equal(classifyShenConviction({ minutes: 600, levelType: "PDL", touchNumber: 1, exhaustionMove: 2.5, moveDistance: 2.5, rsi: 35, direction: "CALL" }).convictionCount, 2);
assert.equal(classifyShenConviction({ minutes: 600, levelType: "PDH", touchNumber: 1, exhaustionMove: 2.5, moveDistance: 2.5, rsi: 75, direction: "PUT" }).grade, "FULL");
assert.equal(classifyShenConviction({ minutes: 600, levelType: "VWAP", touchNumber: 1, exhaustionMove: 3, moveDistance: 3, rsi: 75, direction: "PUT" }), null);
assert.equal(classifyShenConviction({ minutes: 580, levelType: "PDH", touchNumber: 1, exhaustionMove: 3, moveDistance: 3, rsi: 75, direction: "PUT" }), null);
assert.equal(classifyShenConviction({ minutes: 600, levelType: "PDH", touchNumber: 2, exhaustionMove: 1, moveDistance: 1, rsi: 75, direction: "PUT" }), null);
assert.equal(classifyShenConviction({ minutes: 600, levelType: "PDH", touchNumber: 1, exhaustionMove: 3, moveDistance: 3, rsi: 75, direction: "PUT", approachValid: false }), null);
assert.equal(classifyShenConviction({ minutes: 600, levelType: "PDL", touchNumber: 2, exhaustionMove: 3, moveDistance: 3, rsi: null, direction: "CALL" }), null);

const frontierBase = {
  direction: "PUT", levelType: "PDH", tier: "A", points: 12,
  etMinute: 590, entryPrice: 1.05, touchNumber: 1,
};
assert.equal(FRONTIER_V3_DIRECTION, "PUT");
assert.equal(FRONTIER_V3_MIN_POINTS, 12);
assert.deepEqual(FRONTIER_V3_LEVEL_TYPES, ["PDH", "PDL"]);
assert.equal(isFrontierFire(frontierBase), true);
assert.equal(isFrontierFire({ ...frontierBase, levelType: "PDL" }), true);
assert.equal(isFrontierFire({ ...frontierBase, levelType: "WHOLE_DOLLAR" }), false);
assert.equal(isFrontierFire({ ...frontierBase, direction: "CALL", levelType: "PDL" }), false);
assert.equal(isFrontierFire({ ...frontierBase, points: 11 }), false);
assert.equal(isFrontierFire({ ...frontierBase, tier: "A+" }), true);
assert.equal(isFrontierFire({ ...frontierBase, etMinute: 584 }), false);
assert.equal(isFrontierFire({ ...frontierBase, touchNumber: 2 }), false);
assert.equal(isFrontierFire({ ...frontierBase, entryPrice: 0 }), false);

assert.equal(FRONTIER_PAPER_DOLLARS, 1000);
assert.equal(FRONTIER_TP_MULT, 10);
assert.equal(FRONTIER_SL_MULT, 0.5);
assert.equal(frontierPaperPnl(1.00, 1.20, 1000), 200);
assert.equal(frontierDeployedNotional(1.00), 1000);
assert.equal(frontierDeployedNotional(1.05), 945);
assert.equal(frontierV3FlowVeto("CALL", -0.50), false);
assert.equal(passesFrontierV3({ ...frontierBase, flowImbalance: 0.90 }), true);

const frontierDay = summarizeFrontierFires([
  {
    direction: "PUT", levelType: "PDH", points: 13, touchNumber: 1, clock: "10:10 AM ET",
    trade: { ok: true, entryPrice: 1.00, exitPrice: 1.20, frontierPnl: 400 },
  },
  {
    direction: "PUT", levelType: "WHOLE_DOLLAR", points: 16, touchNumber: 1, clock: "10:05 AM ET",
    trade: { ok: true, entryPrice: 1.00, exitPrice: 1.20, frontierPnl: 999 },
  },
  {
    direction: "CALL", levelType: "PDL", points: 14, touchNumber: 1, clock: "10:20 AM ET",
    trade: { ok: true, entryPrice: 1.00, exitPrice: 1.20, frontierPnl: 999 },
  },
], { sessionDate: "2026-08-04" });
assert.equal(frontierDay.trades, 1);
assert.equal(frontierDay.pnl, 400);
assert.equal(frontierDay.deployed, 1000);

const best = selectFrontierBestPerDay([
  { sessionDate: "2026-08-04", points: 11, etMinute: 600, pnl: 10 },
  { sessionDate: "2026-08-04", points: 14, etMinute: 640, pnl: 50 },
  { sessionDate: "2026-08-04", points: 14, etMinute: 610, pnl: 40 },
  { sessionDate: "2026-08-05", points: 12, etMinute: 600, pnl: -20 },
]);
assert.equal(best.length, 2);
assert.equal(best.find((x) => x.sessionDate === "2026-08-04").pnl, 40);

const bars = [
  { ts: ts("11:13"), open: 1.00, high: 1.01, low: 0.99, close: 1.00 },
  { ts: ts("11:14"), open: 1.00, high: 1.02, low: 0.98, close: 1.01 },
  { ts: ts("11:15"), open: 1.02, high: 1.30, low: 0.70, close: 1.10 },
];
const exit = walkBracketBars({ bars, entryIdx: 0, tpPrice: 1.20, slPrice: 0.875 });
assert.equal(exit.exitReason, "Playbook hard stop at 11:15 AM ET");
assert.equal(exit.exitPrice, 1.02);

const researchBars = [
  { ts: ts("12:28"), open: 1.00, high: 1.01, low: 0.99, close: 1.00 },
  { ts: ts("12:29"), open: 1.01, high: 1.02, low: 1.00, close: 1.01 },
  { ts: ts("12:30"), open: 1.02, high: 1.03, low: 1.01, close: 1.02 },
];
const researchExit = walkBracketBars({ bars: researchBars, entryIdx: 0, tpPrice: 1.20, slPrice: 0.875, cutoffMin: 750 });
assert.equal(researchExit.exitReason, "Research window ended at 12:30 PM ET");
assert.equal(researchExit.exitPrice, 1.02);

// Frontier runner stop: -50% hits before a huge TP.
const runnerBars = [
  { ts: ts("10:00"), open: 1.00, high: 1.01, low: 0.99, close: 1.00 },
  { ts: ts("10:01"), open: 0.90, high: 0.95, low: 0.40, close: 0.45 },
];
const runnerExit = walkBracketBars({
  bars: runnerBars, entryIdx: 0, tpPrice: 10, slPrice: 0.50,
  cutoffMin: 960, enforceHardStop: true, tpLabel: "+900% runner", slLabel: "-50%",
});
assert.equal(runnerExit.exitPrice, 0.50);
assert.match(runnerExit.exitReason, /SL hit \(-50%\)/);

console.log("0DTE policy regression tests passed");
