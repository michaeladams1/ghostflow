// Pure unit tests for volume-scan detectors (no DB / Alpaca).
import assert from "node:assert/strict";
import {
  attachVwap, detectVolumeScanFires, paperDeployed, paperPnl, pickWeeklyExpiration,
} from "./scanLib.js";

function bar(sessionDate, hour, minute, { o, h, l, c, v = 1000 } = {}) {
  // Build an epoch ms that formats to the requested ET wall clock.
  const pad = (n) => String(n).padStart(2, "0");
  const iso = `${sessionDate}T${pad(hour)}:${pad(minute)}:00-04:00`;
  return { ts: new Date(iso).getTime(), open: o, high: h, low: l, close: c, volume: v };
}

function makeOrbFailSession() {
  const d = "2025-06-02";
  const bars = [];
  // ORB 9:30–9:45: high 500, low 498
  for (let m = 30; m < 45; m++) {
    bars.push(bar(d, 9, m, { o: 499, h: 500, l: 498, c: 499 }));
  }
  // Break above ORB
  bars.push(bar(d, 9, 50, { o: 500.5, h: 501.5, l: 500.2, c: 501 }));
  // Fail back below ORB high → PUT
  bars.push(bar(d, 9, 55, { o: 500.5, h: 500.8, l: 499.2, c: 499.5 }));
  return { sessionDate: d, bars };
}

function makeVwapReclaimSession() {
  const d = "2025-06-03";
  const bars = [];
  // Flat ORB so it doesn't dominate
  for (let m = 30; m < 45; m++) {
    bars.push(bar(d, 9, m, { o: 500, h: 500.2, l: 499.8, c: 500, v: 5000 }));
  }
  // Grind below VWAP for 5+ minutes after 10:00, then reclaim
  for (let m = 0; m < 8; m++) {
    bars.push(bar(d, 10, m, { o: 499.5, h: 499.6, l: 499.0, c: 499.2, v: 2000 }));
  }
  bars.push(bar(d, 10, 8, { o: 499.5, h: 500.8, l: 499.4, c: 500.6, v: 3000 })); // reclaim CALL
  return { sessionDate: d, bars };
}

{
  const w = pickWeeklyExpiration("2025-06-02", { minDte: 3, maxDte: 7 });
  assert.ok(w, "weekly expiration found");
  assert.equal(w.expiration, "2025-06-06");
  assert.ok(w.dte >= 3 && w.dte <= 7);
}

{
  const { sessionDate, bars } = makeOrbFailSession();
  const fires = detectVolumeScanFires({
    rthBars: bars, sessionDate, pdh: 505, pdl: 495,
    enableVwapReclaim: false, enableWeeklyDrive: false,
  });
  assert.ok(fires.some((f) => f.scan === "ORB_FAIL" && f.direction === "PUT"), "ORB fail PUT");
}

{
  const { sessionDate, bars } = makeVwapReclaimSession();
  const withVwap = attachVwap(bars);
  assert.ok(withVwap.at(-1).vwap > 0);
  const fires = detectVolumeScanFires({
    rthBars: bars, sessionDate, pdh: 510, pdl: 490,
    enableOrbFail: false, enableOrbHold: false, enableWeeklyDrive: false,
    vwapStreakMin: 3,
  });
  assert.ok(fires.some((f) => f.scan === "VWAP_RECLAIM" && f.direction === "CALL"), "VWAP reclaim CALL");
}

{
  const d = "2025-06-04";
  const bars = [];
  for (let m = 30; m < 45; m++) bars.push(bar(d, 9, m, { o: 500, h: 500.5, l: 499.5, c: 500 }));
  // 3 closes above ORB → ORB_HOLD CALL
  bars.push(bar(d, 9, 46, { o: 500.6, h: 501, l: 500.5, c: 500.8 }));
  bars.push(bar(d, 9, 47, { o: 500.8, h: 501.2, l: 500.7, c: 501.0 }));
  bars.push(bar(d, 9, 48, { o: 501.0, h: 501.5, l: 500.9, c: 501.3 }));
  const fires = detectVolumeScanFires({
    rthBars: bars, sessionDate: d, pdh: 510, pdl: 490,
    enableOrbFail: false, enableVwapReclaim: false, enableWeeklyDrive: false,
  });
  assert.ok(fires.some((f) => f.scan === "ORB_HOLD" && f.direction === "CALL"), "ORB hold CALL");
}

{
  const { sessionDate, bars } = makeOrbFailSession();
  // Above PDH at 10:00 → weekly CALL
  const extended = [
    ...bars,
    bar(sessionDate, 10, 0, { o: 506, h: 507, l: 505.5, c: 506.5 }),
  ];
  const fires = detectVolumeScanFires({
    rthBars: extended, sessionDate, pdh: 505, pdl: 495,
    enableOrbFail: false, enableVwapReclaim: false,
  });
  assert.ok(fires.some((f) => f.scan === "WEEKLY_DRIVE" && f.direction === "CALL" && f.expirationMode === "WEEKLY"));
}

{
  assert.equal(paperPnl(2.0, 3.0, 1000), 500); // 5 contracts × $1 × 100
  assert.equal(paperDeployed(2.0, 1000), 1000);
  // Expensive contracts: paperPnl still sizes 1 lot; search harness rejects entry*100 > $1k.
  assert.equal(paperDeployed(12, 1000), 1200);
  assert.equal(paperPnl(12, 13, 1000), 100);
}

console.log("testScanLib: ok");
