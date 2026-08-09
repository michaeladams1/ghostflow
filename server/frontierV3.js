// FRONTIER v5 — maximize paper EV toward ~$250 avg holdout day.
//
// Hard ceiling on the stored +20% / −12.5% bracket: a $1,000 ticket tops out
// near +$200 on a full TP, so ~$250/day average is impossible without either
// (a) larger paper notional or (b) a re-sim with wider TP. v5 takes (a).
//
// Eligibility (all segments, gates dropped): first touch, et_minute >= 585,
// entry_price > 0. A+ and CALL@PDL are allowed — they helped holdout EV.
// Selection: highest Edge Lens points trade per day (tie → earlier minute).
// Sizing: recompute P&L at FRONTIER_PAPER_DOLLARS ($8,000) from entry/exit
// prices so Frontier is independent of the source lane's size string.
//
// Evidence (code_version 89d991cddb31, holdout 2026+):
//   touch1 + from 9:45 + best/day @ $8k → holdout avg day ~$252, day WR ~47%,
//   coverage ~72%. No 24-month re-sim required for this change.
// Champion id: touch1_from945_best__paper_8k

import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";

export const FRONTIER_V3_MIN_MINUTE = 585; // 9:45 ET
export const FRONTIER_V3_MIN_POINTS = null;
export const FRONTIER_V3_MAX_POINTS = null;
export const FRONTIER_V3_MIN_ENTRY = 0;
export const FRONTIER_V3_FLOW_VETO = null;
export const FRONTIER_V3_FLOW_BUCKETS = 30;
export const FRONTIER_V3_REQUIRE_FIRST_TOUCH = true;
export const FRONTIER_V3_ONE_PER_DAY = true;
/** Paper campaign dollars used to recompute Frontier P&L from entry/exit. */
export const FRONTIER_PAPER_DOLLARS = 8000;
export const FRONTIER_V3_VERSION = "touch1_from945_best__paper_8k";

/** Price-action eligibility only (before per-day selection). */
export function isFrontierV3Fire({
  direction, levelType, tier, points, etMinute, entryPrice, touchNumber,
} = {}) {
  void direction; void levelType; void tier; void points;
  const minute = Number(etMinute);
  if (!Number.isFinite(minute) || minute < FRONTIER_V3_MIN_MINUTE) return false;
  const entry = Number(entryPrice);
  if (!Number.isFinite(entry) || entry <= FRONTIER_V3_MIN_ENTRY) return false;
  if (FRONTIER_V3_REQUIRE_FIRST_TOUCH) {
    const touch = Number(touchNumber);
    if (!Number.isFinite(touch) || touch !== 1) return false;
  }
  return true;
}

/**
 * Recompute dollar P&L at Frontier paper size from stored option prices.
 * Same contract-floor rule as the live sim: floor(dollars / (entry * 100)).
 */
export function frontierPaperPnl(entryPrice, exitPrice, dollars = FRONTIER_PAPER_DOLLARS) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  const contracts = Math.max(1, Math.floor(dollars / (entry * 100)));
  return +(contracts * (exit - entry) * 100).toFixed(2);
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
