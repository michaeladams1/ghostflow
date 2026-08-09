import assert from "node:assert/strict";
import { monthRange } from "./zeroDTEBacktestJobs.js";

const range = monthRange({ endYear: 2026, endMonth: 2, months: 24 });
assert.equal(range.length, 24);
assert.deepEqual(range[0], { year: 2024, month: 3 });
assert.deepEqual(range[23], { year: 2026, month: 2 });
assert.deepEqual(monthRange({ endYear: 2026, endMonth: 1, months: 2 }), [
  { year: 2025, month: 12 }, { year: 2026, month: 1 },
]);

console.log("0DTE durable backtest job tests passed");
