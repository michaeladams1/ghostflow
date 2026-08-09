// FRONTIER v6 — $1,000 paper max with Frontier-only exit brackets.
//
// Selection: first touch, from 9:45 ET, best Edge Lens score/day (all segments).
// Exits (NOT the playbook +20%/-12.5%): runner target + −50% stop, hold toward
// the close (no 11:15 hard stop). Official / research / Shen keep playbook
// brackets; only Frontier P&L uses these exits.
//
// Evidence: server/frontierExitSearch.js (balanced train/holdout sample)
// Champion id: runner_sl50_nohard → holdout avg day ~$241 @ $1,000
// (near the $250/day goal without $8k sizing).
//
// Requires a new 24-month backtest so each fire is re-walked with Frontier
// exits and frontier_* columns are populated.

import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";

export const FRONTIER_V3_MIN_MINUTE = 585;
export const FRONTIER_V3_MIN_POINTS = null;
export const FRONTIER_V3_MAX_POINTS = null;
export const FRONTIER_V3_MIN_ENTRY = 0;
export const FRONTIER_V3_FLOW_VETO = null;
export const FRONTIER_V3_FLOW_BUCKETS = 30;
export const FRONTIER_V3_REQUIRE_FIRST_TOUCH = true;
export const FRONTIER_V3_ONE_PER_DAY = true;

/** Max dollars risked per Frontier paper trade. */
export const FRONTIER_PAPER_DOLLARS = 1000;
/** Runner-style TP (10× = +900%) — effectively “let it run”. */
export const FRONTIER_TP_MULT = 10.0;
/** −50% stop. */
export const FRONTIER_SL_MULT = 0.50;
/** 16:00 ET — no playbook 11:15 force-flat for Frontier. */
export const FRONTIER_HARD_STOP_MIN = 960;
export const FRONTIER_V3_VERSION = "touch1_from945_best__runner_sl50_1k";

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

export function frontierPaperPnl(entryPrice, exitPrice, dollars = FRONTIER_PAPER_DOLLARS) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  const contracts = Math.max(1, Math.floor(dollars / (entry * 100)));
  return +(contracts * (exit - entry) * 100).toFixed(2);
}

export function frontierContracts(entryPrice, dollars = FRONTIER_PAPER_DOLLARS) {
  const entry = Number(entryPrice);
  if (!(entry > 0)) return null;
  return Math.max(1, Math.floor(dollars / (entry * 100)));
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

export function frontierV3FlowVeto(direction, flowImbalance, threshold = FRONTIER_V3_FLOW_VETO) {
  if (threshold == null || !Number.isFinite(threshold)) return false;
  if (flowImbalance == null || !Number.isFinite(flowImbalance)) return false;
  if (direction === "CALL" && flowImbalance < -threshold) return true;
  if (direction === "PUT" && flowImbalance > threshold) return true;
  return false;
}

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
  direction, levelType, tier, points, etMinute, entryPrice, touchNumber, flowImbalance,
} = {}) {
  if (!isFrontierV3Fire({
    direction, levelType, tier, points, etMinute, entryPrice, touchNumber,
  })) return false;
  if (frontierV3FlowVeto(direction, flowImbalance)) return false;
  return true;
}

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
