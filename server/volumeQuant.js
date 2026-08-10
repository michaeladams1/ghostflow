// Quant Data helpers for Volume sleeve fire-time context.
// Stores flow + GEX snapshots into trade.features (no new DB columns).

import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { netFlowEarlyImbalance } from "./frontierV3.js";

function etEpoch(sessionDate, etMinute) {
  const h = Math.floor(etMinute / 60);
  const m = etMinute % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return new Date(`${sessionDate}T${pad(h)}:${pad(m)}:00-04:00`).getTime();
}

/** Net call-put premium imbalance in [etMinute-windowMin, etMinute]. */
export function flowImbalanceAtMinute(flowData, sessionDate, etMinute, windowMin = 15) {
  if (!flowData || !sessionDate || !Number.isFinite(etMinute)) return null;
  const target = etEpoch(sessionDate, etMinute);
  const start = target - windowMin * 60000;
  let call = 0, put = 0;
  for (const [k, v] of Object.entries(flowData)) {
    const ts = Number(k);
    if (!Number.isFinite(ts) || ts < start || ts > target) continue;
    call += Number(v.callSum || v.call || 0);
    put += Number(v.putSum || v.put || 0);
  }
  const tot = call + put;
  if (!(tot > 0)) return null;
  return +((call - put) / tot).toFixed(4);
}

export function parseGexMap(gexPayload, sessionDate) {
  const root = gexPayload?.data?.data || gexPayload?.data || gexPayload;
  const spy = root?.SPY || root?.spy;
  if (!spy?.exposureMap) return null;
  const map = spy.exposureMap[sessionDate] || Object.values(spy.exposureMap)[0];
  if (!map) return null;
  return { map, stockPrice: Number(spy.stockPrice) || null };
}

function strikeNet(entry) {
  if (!entry || typeof entry !== "object") return 0;
  return Number(entry.callExposure || 0) + Number(entry.putExposure || 0);
}

export function gexNearLevel(gexParsed, level, { radius = 2 } = {}) {
  if (!gexParsed?.map || !(level > 0)) return null;
  const strikes = Object.keys(gexParsed.map).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!strikes.length) return null;
  const nearest = strikes.reduce((best, s) => (Math.abs(s - level) < Math.abs(best - level) ? s : best), strikes[0]);
  let netNear = 0;
  for (const s of strikes) {
    if (Math.abs(s - nearest) <= radius) netNear += strikeNet(gexParsed.map[`${s}.0`] || gexParsed.map[String(s)]);
  }
  const atSpot = gexParsed.stockPrice != null
    ? strikes.reduce((best, s) => (Math.abs(s - gexParsed.stockPrice) < Math.abs(best - gexParsed.stockPrice) ? s : best), strikes[0])
    : null;
  const netSpot = atSpot != null
    ? strikeNet(gexParsed.map[`${atSpot}.0`] || gexParsed.map[String(atSpot)])
    : null;
  return {
    nearestStrike: nearest,
    netAtLevel: netNear,
    signAtLevel: netNear > 0 ? 1 : netNear < 0 ? -1 : 0,
    spotStrike: atSpot,
    netAtSpot: netSpot,
    stockPrice: gexParsed.stockPrice,
  };
}

/** +1 if flow supports trade direction, −1 if opposes, 0 if flat/missing. */
export function flowSupportSign(direction, imbalance, { threshold = 0.05 } = {}) {
  if (imbalance == null || !Number.isFinite(imbalance)) return null;
  if (Math.abs(imbalance) < threshold) return 0;
  if (direction === "CALL") return imbalance > 0 ? 1 : -1;
  if (direction === "PUT") return imbalance < 0 ? 1 : -1;
  return null;
}

/**
 * Load session Quant Data once (flow + GEX) for Volume enrichment.
 * Safe when keys missing — returns null fields.
 */
export async function loadVolumeQuantSession(sessionDate) {
  if (!process.env.QUANTDATA_API_KEY) {
    return { ok: false, reason: "missing QUANTDATA_API_KEY", flowData: null, gexParsed: null };
  }
  const flowEp = QD_ENDPOINTS.find((e) => e.id === "net_flow");
  const gexEp = QD_ENDPOINTS.find((e) => e.id === "exposure_by_strike_gamma");
  const [flow, gex] = await Promise.all([
    fetchEndpointCached(flowEp, { ticker: "SPY", sessionDate }),
    fetchEndpointCached(gexEp, { ticker: "SPY", sessionDate }),
  ]);
  const flowData = flow.ok ? (flow.data?.data || flow.data) : null;
  const gexParsed = gex.ok ? parseGexMap(gex, sessionDate) : null;
  return {
    ok: !!(flowData || gexParsed),
    flowData,
    gexParsed,
    flowEarly: flowData ? netFlowEarlyImbalance(flowData, 30) : null,
  };
}

/** Attach fire-time QD fields onto a Volume fire object (featuresExtra-ready). */
export function enrichVolumeFireQuant(fire, qdSession) {
  if (!fire || !qdSession) return {};
  const flowAtEntry = qdSession.flowData
    ? flowImbalanceAtMinute(qdSession.flowData, fire.sessionDate, fire.etMinute, 15)
    : null;
  const flowEarly = qdSession.flowEarly ?? null;
  const gex = qdSession.gexParsed ? gexNearLevel(qdSession.gexParsed, fire.level) : null;
  return {
    flowEarly: flowEarly != null ? +Number(flowEarly).toFixed(4) : null,
    flowAtEntry,
    flowSupportEarly: flowSupportSign(fire.direction, flowEarly),
    flowSupportAtEntry: flowSupportSign(fire.direction, flowAtEntry),
    gexNearestStrike: gex?.nearestStrike ?? null,
    gexNetAtLevel: gex?.netAtLevel ?? null,
    gexSignAtLevel: gex?.signAtLevel ?? null,
    gexNetAtSpot: gex?.netAtSpot ?? null,
    gexSpot: gex?.stockPrice ?? null,
  };
}
