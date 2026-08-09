// FRONTIER v3 — live paper lane that beat Frontier v2 on 2026 holdout.
//
// Price-action core (soft score 11–15, from 10:00, toxins, premium ≥ $0.50)
// plus QuantData early net-flow veto: skip when the first ~30 flow buckets
// oppose the trade direction by more than 0.15. Missing QD data does NOT veto
// (keeps coverage on older sessions without QuantData history).
//
// Search artifact: server/frontierV3Search.js → data/frontier-v3/search-latest.json
// Champion id: v3_soft_score_11_15_from10__veto_flow_oppose_first30

import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";

export const FRONTIER_V3_MIN_MINUTE = 600;
export const FRONTIER_V3_MIN_POINTS = 11;
export const FRONTIER_V3_MAX_POINTS = 15;
export const FRONTIER_V3_MIN_ENTRY = 0.5;
export const FRONTIER_V3_FLOW_VETO = 0.15;
export const FRONTIER_V3_FLOW_BUCKETS = 30;

export function isFrontierV3Fire({
  direction, levelType, tier, points, etMinute, entryPrice,
} = {}) {
  if (direction === "CALL" && levelType === "PDL") return false;
  if (tier === "A+" || tier === "Extended A+") return false;
  const pts = Number(points);
  if (!Number.isFinite(pts) || pts < FRONTIER_V3_MIN_POINTS || pts > FRONTIER_V3_MAX_POINTS) return false;
  const minute = Number(etMinute);
  if (!Number.isFinite(minute) || minute < FRONTIER_V3_MIN_MINUTE) return false;
  const entry = Number(entryPrice);
  if (!Number.isFinite(entry) || entry < FRONTIER_V3_MIN_ENTRY) return false;
  return true;
}

export function netFlowEarlyImbalance(flowData, buckets = FRONTIER_V3_FLOW_BUCKETS) {
  const entries = Object.entries(flowData || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, buckets);
  let call = 0, put = 0;
  for (const [, v] of entries) {
    call += Number(v.callSum || v.call || 0);
    put += Number(v.putSum || v.put || 0);
  }
  const tot = call + put;
  return tot > 0 ? (call - put) / tot : null;
}

/** @returns {boolean} true when the trade should be excluded */
export function frontierV3FlowVeto(direction, flowImbalance, threshold = FRONTIER_V3_FLOW_VETO) {
  if (flowImbalance == null || !Number.isFinite(flowImbalance)) return false;
  if (direction === "CALL" && flowImbalance < -threshold) return true;
  if (direction === "PUT" && flowImbalance > threshold) return true;
  return false;
}

// Process-local memo so Year view (12 month loads) does not re-hit QuantData
// for the same session dates within one server lifetime.
const flowImbalanceMemo = new Map();
const FLOW_FETCH_CONCURRENCY = 4;

export async function loadFrontierV3FlowByDate(sessionDates) {
  const ep = QD_ENDPOINTS.find((e) => e.id === "net_flow");
  const out = new Map();
  if (!ep || !process.env.QUANTDATA_API_KEY) return out;
  const unique = [...new Set(sessionDates.filter(Boolean))];
  let cursor = 0;

  async function worker() {
    while (cursor < unique.length) {
      const sessionDate = unique[cursor++];
      if (flowImbalanceMemo.has(sessionDate)) {
        out.set(sessionDate, flowImbalanceMemo.get(sessionDate));
        continue;
      }
      try {
        const res = await fetchEndpointCached(ep, { ticker: "SPY", sessionDate });
        if (!res.ok) {
          flowImbalanceMemo.set(sessionDate, null);
          out.set(sessionDate, null);
          continue;
        }
        const data = res.data?.data || res.data;
        const imb = netFlowEarlyImbalance(data);
        flowImbalanceMemo.set(sessionDate, imb);
        out.set(sessionDate, imb);
      } catch (err) {
        console.warn(`[frontier-v3] flow fetch failed ${sessionDate}: ${err.message}`);
        flowImbalanceMemo.set(sessionDate, null);
        out.set(sessionDate, null);
      }
    }
  }

  const n = Math.min(FLOW_FETCH_CONCURRENCY, Math.max(1, unique.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export function passesFrontierV3({
  direction, levelType, tier, points, etMinute, entryPrice, flowImbalance,
} = {}) {
  if (!isFrontierV3Fire({ direction, levelType, tier, points, etMinute, entryPrice })) return false;
  if (frontierV3FlowVeto(direction, flowImbalance)) return false;
  return true;
}
