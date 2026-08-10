// Pure unit tests for live-paper id / mode helpers (no DB / Alpaca).
import assert from "node:assert/strict";
import {
  LIVE_SLEEVE_FRONTIER, LIVE_SLEEVE_VOLUME, buildClientOrderId, isRthEtMinute,
  lastClosedEtMinute, liveFireKey, parseLivePaperMode, sleeveNote,
} from "./livePaperIds.js";

assert.equal(sleeveNote("VOLUME"), "VOLUME");
assert.equal(sleeveNote("frontier"), "FRONTIER");
assert.equal(sleeveNote("official"), null);

assert.equal(parseLivePaperMode("off"), "off");
assert.equal(parseLivePaperMode(undefined), "off");
assert.equal(parseLivePaperMode("shadow"), "shadow");
assert.equal(parseLivePaperMode("dry-run"), "shadow");
assert.equal(parseLivePaperMode("submit"), "submit");
assert.equal(parseLivePaperMode("paper"), "submit");

const volId = buildClientOrderId({
  sleeve: LIVE_SLEEVE_VOLUME,
  sessionDate: "2026-08-10",
  setup: "ORB_HOLD",
  direction: "CALL",
  etMinute: 590,
});
assert.equal(volId, "gf-VOLUME-20260810-ORB_HOLD-CALL-590");
assert.ok(volId.length <= 128);
assert.match(volId, /^gf-VOLUME-/);

const frId = buildClientOrderId({
  sleeve: LIVE_SLEEVE_FRONTIER,
  sessionDate: "2026-08-10",
  setup: "PDH",
  direction: "PUT",
  etMinute: 612,
});
assert.equal(frId, "gf-FRONTIER-20260810-PDH-PUT-612");
assert.match(frId, /^gf-FRONTIER-/);

const key = liveFireKey({
  symbol: "SPY",
  sessionDate: "2026-08-10",
  sleeve: "VOLUME",
  setup: "ORB_HOLD",
  direction: "CALL",
  etMinute: 590,
  levelType: "ORB_HOLD",
});
assert.equal(key, "SPY|2026-08-10|VOLUME|ORB_HOLD|CALL|590|ORB_HOLD");

assert.equal(isRthEtMinute(570), true);
assert.equal(isRthEtMinute(959), true);
assert.equal(isRthEtMinute(560), false);
assert.equal(isRthEtMinute(960), false);

const closed = lastClosedEtMinute(new Date("2026-08-10T15:22:30-04:00"));
assert.equal(closed.dateStr, "2026-08-10");
assert.equal(closed.wallMinutes, 15 * 60 + 22);
assert.equal(closed.minutes, 15 * 60 + 21);

console.log("testLivePaperIds: ok");
