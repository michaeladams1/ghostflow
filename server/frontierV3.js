// FRONTIER v4 — live paper lane targeting high session coverage.
//
// Eligibility (all segments): not CALL@PDL, not A+/Extended A+, et_minute >= 585
// (9:45 ET), entry_price >= $0.50.
// Selection: keep the single highest-points eligible fire per session day
// (ties → earlier et_minute). No QuantData veto — coverage comes from the
// wide net + 1-trade/day score pick.
//
// Evidence: server/frontierCoverageSearch.js
// Champion id: any_from945__cap1_best
//   ~69% day coverage, holdout +$2081 vs v2 +$991 / v3.1 +$2718,
//   full +$4012 (best full-sample among profitable high-coverage books).

import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";

export const FRONTIER_V3_MIN_MINUTE = 585; // 9:45 ET — playbook open
export const FRONTIER_V3_MIN_POINTS = null; // no score floor (best-of-day picks quality)
export const FRONTIER_V3_MAX_POINTS = null;
export const FRONTIER_V3_MIN_ENTRY = 0.5;
export const FRONTIER_V3_FLOW_VETO = null; // disabled for v4 coverage book
export const FRONTIER_V3_FLOW_BUCKETS = 30;
export const FRONTIER_V3_REQUIRE_FIRST_TOUCH = false;
export const FRONTIER_V3_ONE_PER_DAY = true;
export const FRONTIER_V3_VERSION = "any_from945__cap1_best";

/** Price-action eligibility only (before per-day selection). */
export function isFrontierV3Fire({
  direction, levelType, tier, points, etMinute, entryPrice, touchNumber,
} = {}) {
  void points; void touchNumber;
  if (direction === "CALL" && levelType === "PDL") return false;
  if (tier === "A+" || tier === "Extended A+") return false;
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
  if (threshold == null || !Number.isFinite(threshold)) return false;
  if (flowImbalance == null || !Number.isFinite(flowImbalance)) return false;
  if (direction === "CALL" && flowImbalance < -threshold) return true;
  if (direction === "PUT" && flowImbalance > threshold) return true;
  return false;
}

const flowImbalanceMemo = new Map();
const FLOW_FETCH_CONCURRENCY = 4;

/** Kept for research / optional future vetoes; calendar no longer requires QD. */
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
  direction, levelType, tier, points, etMinute, entryPrice, touchNumber, flowImbalance,
} = {}) {
  if (!isFrontierV3Fire({
    direction, levelType, tier, points, etMinute, entryPrice, touchNumber,
  })) return false;
  if (frontierV3FlowVeto(direction, flowImbalance)) return false;
  return true;
}

/**
 * Among same-day Frontier candidates, keep the highest points trade
 * (tie → earlier et_minute). Used after setup-key dedupe.
 */
export function selectFrontierBestPerDay(candidates) {
  if (!FRONTIER_V3_ONE_PER_DAY) return candidates;
  const byDay = new Map();
  for (const c of candidates) {
    const date = c.sessionDate || c.session_date || c.date;
    const points = Number(c.points);
    const minute = Number(c.etMinute ?? c.et_minute);
    const prev = byDay.get(date);
    if (!prev
      || points > prev._points
      || (points === prev._points && minute < prev._minute)) {
      byDay.set(date, { ...c, _points: points, _minute: minute });
    }
  }
  return [...byDay.values()].map(({ _points, _minute, ...rest }) => rest);
}
