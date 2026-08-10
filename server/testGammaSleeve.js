// Gamma sleeve — recipe detector + live-exec isolation.
import assert from "node:assert/strict";
import {
  GAMMA_LANE, GAMMA_LIVE_ENABLED, GAMMA_MAX_DTE, GAMMA_MAX_ENTRY, GAMMA_VERSION,
  assertGammaNotLive, buildGammaFires, detectGammaFires, firesFromGammaCandidates,
  gammaEntryAllowed, summarizeGammaFires,
} from "./frontierGamma.js";
import {
  LIVE_EXEC_SLEEVES, LIVE_SLEEVE_FRONTIER, LIVE_SLEEVE_VOLUME,
  buildClientOrderId, isLiveExecSleeve, liveFireKey, sleeveNote,
} from "./livePaperIds.js";
import { CALENDAR_LANES } from "../src/calendarChartSeries.js";
import { summarizeMonth } from "./zeroDTECalendar.js";

assert.equal(GAMMA_LANE, "GAMMA");
assert.equal(GAMMA_LIVE_ENABLED, false);
assert.equal(GAMMA_MAX_DTE, 5);
assert.equal(GAMMA_MAX_ENTRY, 1.25);
assert.match(GAMMA_VERSION, /flow_pages/);
assertGammaNotLive();
// Without a sessionDate the async builder is a no-op (does not hit vendors).
assert.deepEqual(await buildGammaFires({}), []);

// --- Live allowlist unchanged ---
assert.deepEqual([...LIVE_EXEC_SLEEVES], [LIVE_SLEEVE_FRONTIER, LIVE_SLEEVE_VOLUME]);
assert.equal(isLiveExecSleeve("GAMMA"), false);
assert.equal(sleeveNote("GAMMA"), null);
assert.throws(() => buildClientOrderId({
  sleeve: "GAMMA", sessionDate: "2026-08-10", setup: "GAMMA_FLOW", direction: "CALL", etMinute: 600,
}), /invalid sleeve/);
assert.throws(() => liveFireKey({
  symbol: "SPY", sessionDate: "2026-08-10", sleeve: "GAMMA", setup: "GAMMA_FLOW",
  direction: "CALL", etMinute: 600,
}), /invalid sleeve/);
assert.equal(buildClientOrderId({
  sleeve: LIVE_SLEEVE_VOLUME, sessionDate: "2026-08-10", setup: "ORB_HOLD",
  direction: "CALL", etMinute: 590,
}), "gf-VOLUME-20260810-ORB_HOLD-CALL-590");

// --- Detector fixture: short-gamma + in-window flow within ±3% ---
const sessionDate = "2026-08-06";
const spotTs = Date.parse("2026-08-06T14:00:00Z"); // 10:00 ET
const priceResult = {
  ok: true,
  data: {
    data: {
      [String(spotTs)]: { timestamp: spotTs, closePrice: 500 },
      [String(spotTs + 60_000)]: { timestamp: spotTs + 60_000, closePrice: 500.5 },
    },
  },
};
const gexResult = {
  ok: true,
  data: {
    data: {
      SPY: {
        exposureMap: {
          "2026-08-06": {
            "500": { callExposure: -2e6, putExposure: -1e6 }, // short gamma
            "510": { callExposure: 5e6, putExposure: 1e6 },   // long wall
          },
          "2026-08-08": {
            "505": { callExposure: -1e6, putExposure: -5e5 },
          },
        },
      },
    },
  },
};
const tFlow = Date.parse("2026-08-06T14:15:00Z"); // 10:15 ET = 615
const flowResult = {
  ok: true,
  data: {
    data: {
      a: {
        tradeTime: tFlow,
        strikePrice: 505,
        expirationDate: "2026-08-08", // DTE 2
        contractType: "CALL",
        premium: 50_000,
      },
      b: {
        tradeTime: tFlow + 60_000,
        strikePrice: 510, // positive wall → skip
        expirationDate: "2026-08-06",
        contractType: "PUT",
        premium: 80_000,
      },
      c: {
        tradeTime: Date.parse("2026-08-06T13:00:00Z"), // 9:00 ET — before window
        strikePrice: 500,
        expirationDate: "2026-08-06",
        contractType: "PUT",
        premium: 90_000,
      },
      d: {
        tradeTime: tFlow + 120_000,
        strikePrice: 498,
        expirationDate: "2026-08-06", // DTE 0, short gamma strike
        contractType: "PUT",
        premium: 40_000,
      },
    },
  },
};

const hits = detectGammaFires({ sessionDate, flowResult, gexResult, priceResult });
assert.ok(hits.length >= 1 && hits.length <= 2, `expected 1-2 hits, got ${hits.length}`);
assert.ok(hits.every((h) => h.dte >= 0 && h.dte <= 5));
assert.ok(hits.every((h) => h.etMinute >= 570 && h.etMinute < 960));
assert.ok(!hits.some((h) => h.strike === 510), "positive gamma wall strike must be excluded");
assert.ok(hits.some((h) => h.direction === "CALL") || hits.some((h) => h.direction === "PUT"));

const fires = firesFromGammaCandidates(hits, { sessionDate });
assert.equal(fires[0].lane, GAMMA_LANE);
assert.equal(fires[0].useFireStrike, true);
assert.equal(fires[0].maxEntryPrice, 1.25);
assert.equal(fires[0].tpMult, 1.3);
assert.equal(fires[0].skipFrontierWalk, true);

assert.equal(gammaEntryAllowed(1.25), true);
assert.equal(gammaEntryAllowed(1.26), false);
assert.equal(gammaEntryAllowed(0.5), true);

const empty = summarizeGammaFires([]);
assert.equal(empty.trades, 0);
assert.equal(empty.liveEnabled, false);

assert.ok(CALENDAR_LANES.gamma);
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
assert.equal(month.volumePnl, 10, "volume totals independent of gamma");

console.log("testGammaSleeve: ok");
