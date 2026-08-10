// GAMMA sleeve — paper-only research lane #3 (volume-accumulation / short-gamma).
//
// LIVE EXECUTION: permanently disabled. Frontier + Volume are the only sleeves
// the live-paper worker may shadow/submit. This module must never be imported
// into the submit path for order placement; livePaperIds.LIVE_EXEC_SLEEVES is
// the hard allowlist.
//
// Historic recipe is still TBD (Quant Data GEX/flow + Alpaca option bars).
// buildGammaFires returns [] until that recipe is locked and backfilled.
// Official / Frontier / Volume P&L paths are never touched here.

import { paperDeployed, paperPnl } from "./scanLib.js";

export const GAMMA_LANE = "GAMMA";
export const GAMMA_PAPER_DOLLARS = 1000;
/** Hard off — do not flip without a separate live-paper PR + allowlist change. */
export const GAMMA_LIVE_ENABLED = false;
export const GAMMA_VERSION = "scaffold_no_fires__research_only";
export const GAMMA_MAX_PER_DAY = 2;

/** Build GAMMA lane fire objects. Empty until the historic recipe lands. */
export function buildGammaFires(_args = {}) {
  return [];
}

export function gammaPaperPnl(entry, exit) {
  return paperPnl(entry, exit, GAMMA_PAPER_DOLLARS);
}

export function gammaDeployed(entry) {
  return paperDeployed(entry, GAMMA_PAPER_DOLLARS);
}

export function gammaEntryAllowed(entryPrice, dollars = GAMMA_PAPER_DOLLARS) {
  const entry = Number(entryPrice);
  return entry > 0 && entry * 100 <= dollars;
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

/** Guard used by tests and any future live wiring — always throws while disabled. */
export function assertGammaNotLive() {
  if (GAMMA_LIVE_ENABLED) {
    throw new Error("[gamma] GAMMA_LIVE_ENABLED unexpectedly true — refuse live path");
  }
}
