// Gamma sleeve — recipe detector + live-exec isolation.
import assert from "node:assert/strict";
import {
  GAMMA_LANE, GAMMA_LIVE_ENABLED, GAMMA_MIN_DTE, GAMMA_MAX_DTE,
  GAMMA_MIN_ENTRY, GAMMA_MAX_ENTRY, GAMMA_MIN_PREMIUM, GAMMA_WINDOW_START_MIN,
  GAMMA_VERSION,
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
assert.equal(GAMMA_MIN_DTE, 2);
assert.equal(GAMMA_MAX_DTE, 5);
assert.equal(GAMMA_MIN_ENTRY, 0.4);
assert.equal(GAMMA_MAX_ENTRY, 1.25);
assert.equal(GAMMA_MIN_PREMIUM, 30_000);
assert.equal(GAMMA_WINDOW_START_MIN, 720);
assert.match(GAMMA_VERSION, /noon_prem30k/);
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

// --- Detector fixture: short-gamma + noon+ window + prem floor ---
const sessionDate = "2026-08-06";
const spotMorning = Date.parse("2026-08-06T14:00:00Z"); // 10:00 ET
const spotNoon = Date.parse("2026-08-06T16:00:00Z"); // 12:00 ET
const priceResult = {
  ok: true,
  data: {
    data: {
      [String(spotMorning)]: { timestamp: spotMorning, closePrice: 500 },
      [String(spotNoon)]: { timestamp: spotNoon, closePrice: 500.5 },
      [String(spotNoon + 60_000)]: { timestamp: spotNoon + 60_000, closePrice: 500.6 },
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
            "500": { callExposure: -2e6, putExposure: -1e6 },
            "510": { callExposure: 5e6, putExposure: 1e6 },
          },
          "2026-08-08": {
            "505": { callExposure: -1e6, putExposure: -5e5 },
          },
        },
      },
    },
  },
};
const tMorning = Date.parse("2026-08-06T14:15:00Z"); // 10:15 ET — before noon gate
const tNoon = Date.parse("2026-08-06T16:15:00Z"); // 12:15 ET = 735
const flowResult = {
  ok: true,
  data: {
    data: {
      morning: {
        tradeTime: tMorning,
        strikePrice: 505,
        expirationDate: "2026-08-08",
        contractType: "CALL",
        premium: 90_000, // would qualify except time
      },
      a: {
        tradeTime: tNoon,
        strikePrice: 505,
        expirationDate: "2026-08-08", // DTE 2
        contractType: "CALL",
        premium: 50_000,
        optionPrice: 0.75,
      },
      b: {
        tradeTime: tNoon + 60_000,
        strikePrice: 510, // positive wall on 0DTE expiry map → skip
        expirationDate: "2026-08-06",
        contractType: "PUT",
        premium: 80_000,
        optionPrice: 0.8,
      },
      cheapPrem: {
        tradeTime: tNoon + 90_000,
        strikePrice: 502,
        expirationDate: "2026-08-08",
        contractType: "PUT",
        premium: 10_000, // below $30k floor
        optionPrice: 0.55,
      },
      d: {
        tradeTime: tNoon + 120_000,
        strikePrice: 498,
        expirationDate: "2026-08-06", // DTE 0
        contractType: "PUT",
        premium: 40_000,
        optionPrice: 0.5,
      },
    },
  },
};

const hits = detectGammaFires({ sessionDate, flowResult, gexResult, priceResult });
assert.equal(hits.length, 1, `noon+ DTE≥2 prem≥30k should keep only CALL, got ${hits.length}`);
assert.ok(hits.every((h) => h.dte >= GAMMA_MIN_DTE && h.dte <= GAMMA_MAX_DTE));
assert.ok(hits.every((h) => h.etMinute >= GAMMA_WINDOW_START_MIN && h.etMinute < 960));
assert.ok(!hits.some((h) => h.strike === 510), "positive gamma wall strike must be excluded");
assert.ok(!hits.some((h) => h.strike === 498), "DTE 0 flow must be excluded");
assert.ok(!hits.some((h) => h.etMinute < 720), "pre-noon flow must be excluded");
assert.equal(hits[0].direction, "CALL");
assert.equal(hits[0].dte, 2);

const fires = firesFromGammaCandidates(hits, { sessionDate });
assert.equal(fires[0].lane, GAMMA_LANE);
assert.equal(fires[0].useFireStrike, true);
assert.equal(fires[0].maxEntryPrice, 1.25);
assert.equal(fires[0].minEntryPrice, 0.4);
assert.equal(fires[0].tpMult, 1.3);
assert.equal(fires[0].skipFrontierWalk, true);

assert.equal(gammaEntryAllowed(1.25), true);
assert.equal(gammaEntryAllowed(1.26), false);
assert.equal(gammaEntryAllowed(0.5), true);
assert.equal(gammaEntryAllowed(0.39), false, "entry floor $0.40");

const empty = summarizeGammaFires([]);
assert.equal(empty.trades, 0);
assert.equal(empty.liveEnabled, false);

// Cap to max 2 after entry filter (over-fetch sim results).
const capped = summarizeGammaFires([
  { trade: { ok: true, entryPrice: 0.5, exitPrice: 0.65 }, etMinute: 730, featuresExtra: { score: 40_000 } },
  { trade: { ok: true, entryPrice: 0.55, exitPrice: 0.4 }, etMinute: 740, featuresExtra: { score: 90_000 } },
  { trade: { ok: true, entryPrice: 0.6, exitPrice: 0.8 }, etMinute: 750, featuresExtra: { score: 60_000 } },
  { trade: { ok: true, entryPrice: 0.2, exitPrice: 0.3 }, etMinute: 760, featuresExtra: { score: 99_000 } }, // below floor
], { maxPerDay: 2 });
assert.equal(capped.trades, 2);
assert.equal(capped.selected[0].featuresExtra.score, 90_000);
assert.equal(capped.selected[1].featuresExtra.score, 60_000);

assert.ok(CALENDAR_LANES.gamma);
const month = summarizeMonth({
  symbol: "SPY", year: 2026, month: 8, days: [
    {
      date: "2026-08-10",
      trades: 0, tradePnls: [], deployed: 0,
      gammaTrades: 2, gammaDeployed: 2000, gammaTradePnls: [100, -40],
      gammaTradeIntervals: [
        { startMin: 720, endMin: 730, deployed: 1000 },
        { startMin: 740, endMin: 750, deployed: 1000 },
      ],
      volumeTrades: 1, volumeDeployed: 1000, volumeTradePnls: [10],
      volumeTradeIntervals: [{ startMin: 600, endMin: 605, deployed: 1000 }],
    },
  ],
}).totals;
assert.equal(month.gammaPnl, 60);
assert.equal(month.volumePnl, 10, "volume totals independent of gamma");

console.log("testGammaSleeve: ok");
