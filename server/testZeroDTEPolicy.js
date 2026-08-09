import assert from "node:assert/strict";
import {
  classifyResearchCandidate, classifyShenConviction, isFrontierFire,
  pickOtmStrike, playbookTouchPolicy,
} from "./zeroDTE.js";
import { frontierV3FlowVeto, passesFrontierV3 } from "./frontierV3.js";
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
  direction: "PUT", levelType: "WHOLE_DOLLAR", tier: "A", points: 13,
  etMinute: 610, entryPrice: 1.05, touchNumber: 1,
};
assert.equal(isFrontierFire(frontierBase), true);
assert.equal(isFrontierFire({ ...frontierBase, direction: "CALL", levelType: "PDL" }), false);
assert.equal(isFrontierFire({ ...frontierBase, tier: "A+" }), false);
assert.equal(isFrontierFire({ ...frontierBase, tier: "Extended A+" }), false);
assert.equal(isFrontierFire({ ...frontierBase, points: 11 }), true); // v3 soft band
assert.equal(isFrontierFire({ ...frontierBase, points: 15 }), true);
assert.equal(isFrontierFire({ ...frontierBase, points: 10 }), false);
assert.equal(isFrontierFire({ ...frontierBase, points: 16 }), false);
assert.equal(isFrontierFire({ ...frontierBase, etMinute: 595 }), false);
assert.equal(isFrontierFire({ ...frontierBase, etMinute: 615 }), true);
assert.equal(isFrontierFire({ ...frontierBase, etMinute: 670 }), true);
assert.equal(isFrontierFire({ ...frontierBase, entryPrice: 0.49 }), false);
assert.equal(isFrontierFire({ ...frontierBase, touchNumber: 2 }), false); // v3.1 first touch
assert.equal(isFrontierFire({ ...frontierBase, touchNumber: null }), false);
// All segments eligible — Shen / research / outside pass the same feature gates.
assert.equal(isFrontierFire({ ...frontierBase, tier: "Shen FULL 3/3" }), true);
assert.equal(isFrontierFire({ ...frontierBase, tier: "Research 13-14" }), true);
// Default veto threshold is 0.25 (v3.1).
assert.equal(frontierV3FlowVeto("CALL", -0.30), true);
assert.equal(frontierV3FlowVeto("PUT", 0.30), true);
assert.equal(frontierV3FlowVeto("CALL", -0.20), false);
assert.equal(frontierV3FlowVeto("PUT", 0.20), false);
assert.equal(frontierV3FlowVeto("CALL", null), false);
// frontierBase is PUT — opposing early flow is call-heavy (positive imbalance).
assert.equal(passesFrontierV3({ ...frontierBase, flowImbalance: 0.30 }), false);
assert.equal(passesFrontierV3({ ...frontierBase, flowImbalance: 0.20 }), true);
assert.equal(passesFrontierV3({ ...frontierBase, flowImbalance: -0.20 }), true);
assert.equal(passesFrontierV3({ ...frontierBase, flowImbalance: 0.05 }), true);
assert.equal(passesFrontierV3({ ...frontierBase, direction: "CALL", flowImbalance: -0.30 }), false);

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

console.log("0DTE policy regression tests passed");
