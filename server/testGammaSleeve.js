// Gamma sleeve isolation — research lane must never enter live-paper exec.
import assert from "node:assert/strict";
import {
  GAMMA_LANE, GAMMA_LIVE_ENABLED, GAMMA_VERSION, assertGammaNotLive,
  buildGammaFires, summarizeGammaFires,
} from "./frontierGamma.js";
import {
  LIVE_EXEC_SLEEVES, LIVE_SLEEVE_FRONTIER, LIVE_SLEEVE_VOLUME,
  buildClientOrderId, isLiveExecSleeve, liveFireKey, sleeveNote,
} from "./livePaperIds.js";
import { CALENDAR_LANES } from "../src/calendarChartSeries.js";
import { summarizeMonth } from "./zeroDTECalendar.js";

assert.equal(GAMMA_LANE, "GAMMA");
assert.equal(GAMMA_LIVE_ENABLED, false);
assert.equal(GAMMA_VERSION, "scaffold_no_fires__research_only");
assert.deepEqual(buildGammaFires({ sessionDate: "2026-08-10" }), []);
assertGammaNotLive();

const empty = summarizeGammaFires([]);
assert.equal(empty.trades, 0);
assert.equal(empty.pnl, 0);
assert.equal(empty.liveEnabled, false);

// Live allowlist is exactly Frontier + Volume.
assert.deepEqual([...LIVE_EXEC_SLEEVES], [LIVE_SLEEVE_FRONTIER, LIVE_SLEEVE_VOLUME]);
assert.equal(isLiveExecSleeve(LIVE_SLEEVE_FRONTIER), true);
assert.equal(isLiveExecSleeve(LIVE_SLEEVE_VOLUME), true);
assert.equal(isLiveExecSleeve("GAMMA"), false);
assert.equal(isLiveExecSleeve(GAMMA_LANE), false);
assert.equal(sleeveNote("GAMMA"), null);
assert.equal(sleeveNote("VOLUME"), "VOLUME");
assert.equal(sleeveNote("FRONTIER"), "FRONTIER");

assert.throws(
  () => buildClientOrderId({
    sleeve: "GAMMA",
    sessionDate: "2026-08-10",
    setup: "VOL_ACCUM",
    direction: "CALL",
    etMinute: 600,
  }),
  /invalid sleeve/,
);

assert.throws(
  () => liveFireKey({
    symbol: "SPY",
    sessionDate: "2026-08-10",
    sleeve: "GAMMA",
    setup: "VOL_ACCUM",
    direction: "CALL",
    etMinute: 600,
  }),
  /invalid sleeve/,
);

// Frontier/Volume client ids unchanged.
assert.equal(
  buildClientOrderId({
    sleeve: LIVE_SLEEVE_VOLUME,
    sessionDate: "2026-08-10",
    setup: "ORB_HOLD",
    direction: "CALL",
    etMinute: 590,
  }),
  "gf-VOLUME-20260810-ORB_HOLD-CALL-590",
);
assert.equal(
  buildClientOrderId({
    sleeve: LIVE_SLEEVE_FRONTIER,
    sessionDate: "2026-08-10",
    setup: "PDH",
    direction: "PUT",
    etMinute: 612,
  }),
  "gf-FRONTIER-20260810-PDH-PUT-612",
);

assert.ok(CALENDAR_LANES.gamma);
assert.equal(CALENDAR_LANES.gamma.pnlKey, "gammaPnl");

const month = summarizeMonth({
  symbol: "SPY", year: 2026, month: 8, days: [
    {
      date: "2026-08-10",
      trades: 0, tradePnls: [], deployed: 0,
      gammaTrades: 2, gammaDeployed: 2000, gammaTradePnls: [100, -40],
      gammaTradeIntervals: [
        { startMin: 600, endMin: 610, deployed: 1000 },
        { startMin: 620, endMin: 630, deployed: 1000 },
      ],
      volumeTrades: 1, volumeDeployed: 1000, volumeTradePnls: [10],
      volumeTradeIntervals: [{ startMin: 600, endMin: 605, deployed: 1000 }],
    },
  ],
}).totals;
assert.equal(month.gammaPnl, 60);
assert.equal(month.gammaTrades, 2);
assert.equal(month.gammaWins, 1);
assert.equal(month.volumePnl, 10, "volume totals must stay independent of gamma");
assert.equal(month.volumeTrades, 1);

console.log("testGammaSleeve: ok");
