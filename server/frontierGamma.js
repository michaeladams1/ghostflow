// GAMMA sleeve — paper-only research lane #3.
//
// Recipe v1 (historic, refine later):
//   SPY · CALL or PUT · DTE 0–5 · strikes within ±3% of spot
//   short-gamma regime (net GEX < 0 on that expiry) · flow-print trigger
//   entry premium ≤ $1.25 · $1k paper · +30% / −15% · full RTH · max 2/day
//   No playbook 9:45–11:15 lock — multi-DTE doesn't need that window.
//
// LIVE EXECUTION: permanently disabled. LIVE_EXEC_SLEEVES stays Frontier+Volume.
// Day calendar re-sims do not call this; use frontierGammaBackfill.js.

import { paperDeployed, paperPnl } from "./scanLib.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { QD_ENDPOINTS } from "./quantDataRegistry.js";

export const GAMMA_LANE = "GAMMA";
export const GAMMA_PAPER_DOLLARS = 1000;
export const GAMMA_TP_MULT = 1.30;
export const GAMMA_SL_MULT = 0.85;
export const GAMMA_HARD_STOP_MIN = 960; // flat by 16:00 ET (session end)
export const GAMMA_WINDOW_START_MIN = 570; // 9:30 ET RTH open
export const GAMMA_WINDOW_END_MIN = 960; // 16:00 ET — full regular session
export const GAMMA_MAX_PER_DAY = 2;
export const GAMMA_MIN_DTE = 0;
export const GAMMA_MAX_DTE = 5; // "a few days out" — not locked to 0DTE
export const GAMMA_MONEYNESS = 0.03;
export const GAMMA_MAX_ENTRY = 1.25; // premium price proxy (Alpaca last/trade)
/** Hard off — do not flip without a separate live-paper allowlist PR. */
export const GAMMA_LIVE_ENABLED = false;
export const GAMMA_VERSION = "flow_shortgex_dte0to5_mny3_px125_rth__tp30_sl15_1k_max2";

const flowEp = QD_ENDPOINTS.find((e) => e.id === "order_flow_consolidated");
const gexEp = QD_ENDPOINTS.find((e) => e.id === "exposure_by_strike_gamma");
const priceEp = QD_ENDPOINTS.find((e) => e.id === "stock_price_over_time");

function minToClock(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? "PM" : "AM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function nyParts(ts) {
  const d = new Date(Number.isFinite(Number(ts)) ? Number(ts) : ts);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    minutes: Number(map.hour) * 60 + Number(map.minute),
  };
}

function dteDays(sessionDate, expirationDate) {
  const a = Date.parse(`${sessionDate}T00:00:00Z`);
  const b = Date.parse(`${expirationDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function rowsOf(result) {
  return Object.entries(result?.data?.data || {});
}

/** Spot series: [{ min, close }] regular hours. */
export function parseSpotSeries(priceResult) {
  return rowsOf(priceResult)
    .map(([ts, b]) => {
      const p = nyParts(b?.timestamp ?? ts);
      const close = Number(b?.closePrice ?? b?.price);
      if (!p || !Number.isFinite(close) || close <= 0) return null;
      return { min: p.minutes, close };
    })
    .filter(Boolean)
    .sort((a, b) => a.min - b.min);
}

export function spotAt(series, etMinute) {
  if (!series?.length) return null;
  let best = null;
  for (const s of series) {
    if (s.min <= etMinute) best = s.close;
    else break;
  }
  return best ?? series[0].close;
}

/**
 * Net GEX by expiration from exposure_by_strike_gamma.
 * Returns Map(expiration -> { net, byStrike: Map(strike -> net) }).
 */
export function parseGexByExpiry(gexResult) {
  const out = new Map();
  const root = gexResult?.data?.data;
  if (!root || typeof root !== "object") return out;
  // Shape: { [tickerKey]: { exposureMap: { exp: { strike: {callExposure, putExposure} } } } }
  for (const node of Object.values(root)) {
    const map = node?.exposureMap;
    if (!map || typeof map !== "object") continue;
    for (const [exp, strikes] of Object.entries(map)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exp) || !strikes || typeof strikes !== "object") continue;
      let net = 0;
      const byStrike = new Map();
      for (const [k, v] of Object.entries(strikes)) {
        const strike = Number(k);
        const sn = Number(v?.callExposure || 0) + Number(v?.putExposure || 0);
        if (!Number.isFinite(strike)) continue;
        byStrike.set(strike, sn);
        net += sn;
      }
      out.set(exp, { net, byStrike });
    }
  }
  return out;
}

/** Timed flow prints with contract identity. */
export function parseFlowPrints(flowResult, sessionDate) {
  const out = [];
  for (const [, row] of rowsOf(flowResult)) {
    if (!row || row.strikePrice == null || !row.expirationDate || !row.contractType) continue;
    const premium = Number(row.premium);
    if (!(premium > 0)) continue;
    const dir = String(row.contractType).toUpperCase().startsWith("P") ? "PUT" : "CALL";
    const p = nyParts(row.tradeTime ?? row.timestamp);
    if (!p) continue;
    // Keep prints dated on the session (ignore overnight junk).
    if (p.dateStr !== sessionDate) continue;
    out.push({
      etMinute: p.minutes,
      ts: Number(row.tradeTime ?? row.timestamp) || null,
      strike: Number(row.strikePrice),
      expiration: String(row.expirationDate),
      direction: dir,
      premium,
      tradeSide: row.tradeSide || row.tradeSideCode || null,
      sentimentType: row.sentimentType || null,
    });
  }
  return out.filter((x) => Number.isFinite(x.strike)).sort((a, b) => a.etMinute - b.etMinute);
}

/**
 * Pure historic detector. Feeds are Quant Data fetchEndpointCached results
 * (or fixtures with the same { ok, data: { data } } shape).
 */
export function detectGammaFires({
  sessionDate,
  flowResult,
  gexResult,
  priceResult,
  maxPerDay = GAMMA_MAX_PER_DAY,
  minDte = GAMMA_MIN_DTE,
  maxDte = GAMMA_MAX_DTE,
  moneyness = GAMMA_MONEYNESS,
  windowStart = GAMMA_WINDOW_START_MIN,
  windowEnd = GAMMA_WINDOW_END_MIN,
} = {}) {
  if (!sessionDate) return [];
  const spots = parseSpotSeries(priceResult);
  const gex = parseGexByExpiry(gexResult);
  const prints = parseFlowPrints(flowResult, sessionDate);
  if (!spots.length || !prints.length) return [];

  const candidates = [];
  const seen = new Set(); // one fire per contract/day (first qualifying print)
  for (const pr of prints) {
    if (pr.etMinute < windowStart || pr.etMinute >= windowEnd) continue;
    const dte = dteDays(sessionDate, pr.expiration);
    if (dte == null || dte < minDte || dte > maxDte) continue;
    const spot = spotAt(spots, pr.etMinute);
    if (!(spot > 0)) continue;
    if (Math.abs(pr.strike / spot - 1) > moneyness) continue;
    const g = gex.get(pr.expiration);
    // Short-gamma regime on that expiry (dealers amplify). If missing GEX, skip.
    if (!g || !(g.net < 0)) continue;
    const strikeGex = g.byStrike.get(pr.strike);
    // Prefer strikes that are themselves short/neutral; allow if expiry net short.
    if (strikeGex != null && strikeGex > 0 && Math.abs(strikeGex) > Math.abs(g.net) * 0.05) {
      // Strong positive wall at this strike — skip for v1.
      continue;
    }
    const key = `${pr.expiration}|${pr.strike}|${pr.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...pr,
      spot,
      dte,
      netGex: g.net,
      strikeGex: strikeGex ?? null,
      score: pr.premium,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.etMinute - b.etMinute);
  return candidates.slice(0, Math.max(1, maxPerDay));
}

/** Turn detector hits into simulateBracketTrade fire objects. */
export function firesFromGammaCandidates(candidates, { sessionDate } = {}) {
  return (candidates || []).map((c) => {
    const etMinute = c.etMinute;
    const ts = c.ts || Date.parse(`${sessionDate}T00:00:00Z`) + etMinute * 60_000;
    return {
      lane: GAMMA_LANE,
      tier: "GAMMA_FLOW",
      scan: "GAMMA_FLOW",
      levelType: "GAMMA",
      level: c.strike, // level = strike so sim has an anchor; strike override wins
      strike: c.strike,
      useFireStrike: true,
      direction: c.direction,
      expiration: c.expiration,
      expirationMode: c.dte === 0 ? "0DTE" : `DTE${c.dte}`,
      dte: c.dte,
      etMinute,
      ts,
      clock: minToClock(etMinute),
      window: "research",
      size: `FULL $${GAMMA_PAPER_DOLLARS}`,
      paperOnly: true,
      tpMult: GAMMA_TP_MULT,
      slMult: GAMMA_SL_MULT,
      exitCutoffMin: GAMMA_HARD_STOP_MIN,
      skipFrontierWalk: true,
      maxPremiumDollars: GAMMA_PAPER_DOLLARS,
      maxEntryPrice: GAMMA_MAX_ENTRY,
      touchNumber: 1,
      points: null,
      method: GAMMA_VERSION,
      featuresExtra: {
        score: c.score,
        premium: c.premium,
        spot: c.spot,
        netGex: c.netGex,
        strikeGex: c.strikeGex,
        moneyness: c.spot ? +(c.strike / c.spot - 1).toFixed(4) : null,
      },
    };
  });
}

/**
 * Async builder used by backfill. Returns [] without QUANTDATA_API_KEY.
 * Never used by live-paper.
 */
export async function buildGammaFires({ sessionDate, ticker = "SPY" } = {}) {
  if (!sessionDate) return [];
  if (!process.env.QUANTDATA_API_KEY) {
    console.log(`[gamma] skipped: no QUANTDATA_API_KEY date=${sessionDate}`);
    return [];
  }
  if (!flowEp || !gexEp || !priceEp) return [];
  const [flowResult, gexResult, priceResult] = await Promise.all([
    fetchEndpointCached(flowEp, { ticker, sessionDate }),
    fetchEndpointCached(gexEp, { ticker, sessionDate }),
    fetchEndpointCached(priceEp, { ticker, sessionDate }),
  ]);
  const hits = detectGammaFires({ sessionDate, flowResult, gexResult, priceResult });
  return firesFromGammaCandidates(hits, { sessionDate });
}

export function gammaPaperPnl(entry, exit) {
  return paperPnl(entry, exit, GAMMA_PAPER_DOLLARS);
}

export function gammaDeployed(entry) {
  return paperDeployed(entry, GAMMA_PAPER_DOLLARS);
}

export function gammaEntryAllowed(entryPrice, dollars = GAMMA_PAPER_DOLLARS) {
  const entry = Number(entryPrice);
  return entry > 0
    && entry <= GAMMA_MAX_ENTRY
    && entry * 100 <= dollars;
}

export function summarizeGammaFires(fires) {
  const selected = (fires || []).filter((f) => f?.trade?.ok && gammaEntryAllowed(f.trade.entryPrice));
  const tradePnls = selected.map((f) => gammaPaperPnl(f.trade.entryPrice, f.trade.exitPrice) ?? 0);
  const tradeDeployeds = selected.map((f) => gammaDeployed(f.trade.entryPrice) ?? 0);
  return {
    version: GAMMA_VERSION,
    liveEnabled: GAMMA_LIVE_ENABLED,
    trades: selected.length,
    wins: tradePnls.filter((p) => p > 0).length,
    pnl: +tradePnls.reduce((s, p) => s + p, 0).toFixed(2),
    deployed: +tradeDeployeds.reduce((s, d) => s + d, 0).toFixed(2),
    tradePnls,
    tradeDeployeds,
    selected,
  };
}

export function assertGammaNotLive() {
  if (GAMMA_LIVE_ENABLED) {
    throw new Error("[gamma] GAMMA_LIVE_ENABLED unexpectedly true — refuse live path");
  }
}
