// Frontier VOLUME sleeve — paper-only cadence next to Frontier v7.
// Live recipe (2026 YTD tighten): ORB_HOLD + VWAP_RECLAIM only.
// Dropped ORB_FAIL + WEEKLY_DRIVE (net-negative / low quality on stored book).
// Exits: +30% / −15%, ≤$1k/trade. Official playbook P&L is never touched.

import {
  detectVolumeScanFires, paperDeployed, paperPnl, sessionRthBars,
} from "./scanLib.js";
import { enrichVolumeFireQuant, loadVolumeQuantSession } from "./volumeQuant.js";

export const VOLUME_LANE = "VOLUME";
export const VOLUME_PAPER_DOLLARS = 1000;
export const VOLUME_TP_MULT = 1.30;
export const VOLUME_SL_MULT = 0.85;
export const VOLUME_HARD_STOP_MIN = 675; // 11:15 ET
/** Scans promoted into the live VOLUME lane. */
export const VOLUME_SCANS = Object.freeze(["ORB_HOLD", "VWAP_RECLAIM"]);
/** Version bumps when scan set, exits, or fire-time feature schema changes. */
export const VOLUME_VERSION = "orb_hold_vwap__tp30_sl15_1k__qd_flow_gex";

function minToClock(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? "PM" : "AM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Build VOLUME lane fire objects ready for simulateBracketTrade. */
export function buildVolumeFires({ bars, sessionDate, pdh, pdl } = {}) {
  if (!bars?.length || !sessionDate || pdh == null || pdl == null) return [];
  const rth = sessionRthBars(bars, sessionDate);
  const raw = detectVolumeScanFires({
    rthBars: rth, sessionDate, pdh, pdl,
    enableOrbFail: false,
    enableOrbHold: true,
    enableVwapReclaim: true,
    enableWeeklyDrive: false,
  });
  const out = [];
  for (const f of raw) {
    if (!VOLUME_SCANS.includes(f.scan)) continue;
    out.push({
      ...f,
      lane: VOLUME_LANE,
      tier: f.scan,
      levelType: f.levelType,
      level: f.level,
      clock: minToClock(f.etMinute),
      window: "research",
      size: `FULL $${VOLUME_PAPER_DOLLARS}`,
      paperOnly: true,
      expiration: sessionDate,
      expirationMode: "0DTE",
      dte: 0,
      tpMult: VOLUME_TP_MULT,
      slMult: VOLUME_SL_MULT,
      exitCutoffMin: VOLUME_HARD_STOP_MIN,
      skipFrontierWalk: true,
      maxPremiumDollars: VOLUME_PAPER_DOLLARS,
      touchNumber: 1,
      points: null,
      method: VOLUME_VERSION,
    });
  }
  return out;
}

/**
 * Build Volume fires and attach Quant Data flow/GEX at fire time.
 * QD failures are non-fatal — fires still simulate; features just omit QD fields.
 */
export async function buildVolumeFiresWithQuant({ bars, sessionDate, pdh, pdl } = {}) {
  const fires = buildVolumeFires({ bars, sessionDate, pdh, pdl });
  if (!fires.length) return fires;
  let qd = null;
  try {
    qd = await loadVolumeQuantSession(sessionDate);
  } catch (err) {
    console.warn(`[frontier-volume] QD load failed ${sessionDate}: ${err.message}`);
  }
  if (!qd?.ok) return fires.map((f) => ({ ...f, featuresExtra: { ...(f.featuresExtra || {}), qdOk: false } }));
  return fires.map((f) => {
    const q = enrichVolumeFireQuant(f, qd);
    return {
      ...f,
      featuresExtra: {
        ...(f.featuresExtra || {}),
        qdOk: true,
        ...q,
      },
    };
  });
}

export function volumePaperPnl(entry, exit) {
  return paperPnl(entry, exit, VOLUME_PAPER_DOLLARS);
}

export function volumeDeployed(entry) {
  return paperDeployed(entry, VOLUME_PAPER_DOLLARS);
}

/** Reject contracts that need more than $1k for a single lot. */
export function volumeEntryAllowed(entryPrice, dollars = VOLUME_PAPER_DOLLARS) {
  const entry = Number(entryPrice);
  return entry > 0 && entry * 100 <= dollars;
}

export function summarizeVolumeFires(fires) {
  const selected = (fires || []).filter((f) => f?.trade?.ok && volumeEntryAllowed(f.trade.entryPrice));
  const tradePnls = selected.map((f) => volumePaperPnl(f.trade.entryPrice, f.trade.exitPrice) ?? 0);
  const tradeDeployeds = selected.map((f) => volumeDeployed(f.trade.entryPrice) ?? 0);
  return {
    version: VOLUME_VERSION,
    trades: selected.length,
    wins: tradePnls.filter((p) => p > 0).length,
    pnl: +tradePnls.reduce((s, p) => s + p, 0).toFixed(2),
    deployed: +tradeDeployeds.reduce((s, d) => s + d, 0).toFixed(2),
    tradePnls,
    tradeDeployeds,
    selected,
  };
}
