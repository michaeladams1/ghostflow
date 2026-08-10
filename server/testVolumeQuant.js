import assert from "node:assert/strict";
import {
  flowImbalanceAtMinute, flowSupportSign, gexNearLevel, parseGexMap, enrichVolumeFireQuant,
} from "./volumeQuant.js";

// Synthetic flow buckets (epoch ms)
const sessionDate = "2026-07-22";
const t0 = new Date(`${sessionDate}T10:00:00-04:00`).getTime();
const flowData = {};
for (let i = 0; i < 20; i++) {
  flowData[String(t0 - (19 - i) * 60000)] = {
    callSum: i < 10 ? 100 : 300,
    putSum: i < 10 ? 300 : 100,
  };
}
const imb = flowImbalanceAtMinute(flowData, sessionDate, 600, 15); // 10:00
assert.ok(imb != null && imb > 0, "late window should be call-heavy");
assert.equal(flowSupportSign("CALL", 0.2), 1);
assert.equal(flowSupportSign("PUT", 0.2), -1);
assert.equal(flowSupportSign("PUT", -0.2), 1);
assert.equal(flowSupportSign("CALL", 0.01), 0);

const gexPayload = {
  data: {
    SPY: {
      stockPrice: 750,
      exposureMap: {
        "2026-07-22": {
          "748.0": { callExposure: 1e6, putExposure: -2e6 },
          "750.0": { callExposure: 5e6, putExposure: -1e6 },
          "752.0": { callExposure: 2e6, putExposure: 0 },
        },
      },
    },
  },
};
const parsed = parseGexMap(gexPayload, sessionDate);
assert.equal(parsed.stockPrice, 750);
const near = gexNearLevel(parsed, 750, { radius: 0 });
assert.equal(near.nearestStrike, 750);
assert.equal(near.netAtLevel, 5e6 - 1e6);
assert.equal(near.signAtLevel, 1);

const q = enrichVolumeFireQuant(
  { sessionDate, etMinute: 600, direction: "CALL", level: 750 },
  { ok: true, flowData, flowEarly: 0.1, gexParsed: parsed },
);
assert.equal(q.flowSupportEarly, 1);
assert.ok(q.flowAtEntry != null);
assert.equal(q.gexSignAtLevel, 1);

console.log("testVolumeQuant: ok");
