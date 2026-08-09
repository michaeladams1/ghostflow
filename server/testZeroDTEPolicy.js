import assert from "node:assert/strict";
import { pickOtmStrike, playbookTouchPolicy } from "./zeroDTE.js";
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

const bars = [
  { ts: ts("11:13"), open: 1.00, high: 1.01, low: 0.99, close: 1.00 },
  { ts: ts("11:14"), open: 1.00, high: 1.02, low: 0.98, close: 1.01 },
  { ts: ts("11:15"), open: 1.02, high: 1.30, low: 0.70, close: 1.10 },
];
const exit = walkBracketBars({ bars, entryIdx: 0, tpPrice: 1.20, slPrice: 0.875 });
assert.equal(exit.exitReason, "Playbook hard stop at 11:15 AM ET");
assert.equal(exit.exitPrice, 1.02);

console.log("0DTE policy regression tests passed");
