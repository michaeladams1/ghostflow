// Frontier VOLUME sleeve — paper-only scans that cleared local gates when
// combined with Frontier v7 Core:
//   holdout ~$256 avg/day · ~30 tpm · ≤$1k/trade (tp +30% / sl −15%)
// Official playbook P&L is never touched.

import {
  detectVolumeScanFires, paperDeployed, paperPnl, pickWeeklyExpiration, sessionRthBars,
} from "./scanLib.js";

export const VOLUME_LANE = "VOLUME";
export const VOLUME_PAPER_DOLLARS = 1000;
export const VOLUME_TP_MULT = 1.30;
export const VOLUME_SL_MULT = 0.85;
export const VOLUME_HARD_STOP_MIN = 675; // 11:15 for 0DTE; weeklies override to 960
export const VOLUME_VERSION = "orb_hold_vwap_weekly__tp30_sl15_1k";

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
  const raw = detectVolumeScanFires({ rthBars: rth, sessionDate, pdh, pdl });
  const out = [];
  for (const f of raw) {
    let expiration = sessionDate;
    let dte = 0;
    if (f.expirationMode === "WEEKLY") {
      const w = pickWeeklyExpiration(sessionDate);
      if (!w) continue;
      expiration = w.expiration;
      dte = w.dte;
    }
    const hard = f.expirationMode === "WEEKLY" ? 960 : VOLUME_HARD_STOP_MIN;
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
      expiration,
      expirationMode: f.expirationMode,
      dte,
      tpMult: VOLUME_TP_MULT,
      slMult: VOLUME_SL_MULT,
      exitCutoffMin: hard,
      skipFrontierWalk: true,
      maxPremiumDollars: VOLUME_PAPER_DOLLARS,
      touchNumber: 1,
      points: null,
      method: VOLUME_VERSION,
    });
  }
  return out;
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
