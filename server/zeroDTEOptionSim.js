// BRACKET-ORDER OPTION SIMULATION — for each fired 0DTE signal, builds the
// exact 1-strike-OTM, SAME-DAY-EXPIRY contract per the Shen Lao playbook's
// strike-selection rule, then walks its REAL intraday price to see whether
// the +20% take-profit or the -12.5% stop-loss would have hit first.
// "Set the moment you are filled. Not after. Not during." — simulated that way.
//
// WHY ALPACA BARS AND NOT A CLOSES-ONLY FEED: a 0DTE option can run +20% and
// give it all back inside a single minute. Checking only the minute's CLOSE
// misses those entirely — it under-reports both winners and stop-outs. These
// bars carry full OHLC, so the bracket is evaluated against the minute's
// actual high and low, which is what a resting OCO order would have seen.
//
// KNOWN LIMIT: no historical option bid/ask exists on Alpaca (any plan), so
// these are TRADED prices. Real fills cross the spread. On a $0.20 contract
// a $0.01 spread is 5% — larger than a third of the profit target. Every
// number produced here is therefore optimistic by an unmeasured amount.

import { fetchAlpacaOptionBars, occSymbol } from "./alpacaClient.js";
import { pickOtmStrike } from "./zeroDTE.js";
import {
  FRONTIER_HARD_STOP_MIN, FRONTIER_PAPER_DOLLARS, FRONTIER_SL_MULT, FRONTIER_TP_MULT,
  frontierContracts, frontierPaperPnl,
} from "./frontierV3.js";

const TP_MULT = 1.20;   // +20% target — the playbook's bracket TP
const SL_MULT = 0.875;  // -12.5% stop — the playbook's bracket SL
const HARD_STOP_MIN = 675; // 11:15 ET / 8:15 PST

function etMinutes(ts) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ts));
  const map = {}; for (const p of parts) map[p.type] = p.value;
  return Number(map.hour) * 60 + Number(map.minute);
}
function minToClock(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ET`;
}

export function walkBracketBars({
  bars, entryIdx, tpPrice, slPrice, enforceHardStop = true, cutoffMin = HARD_STOP_MIN,
  tpLabel = "+20%", slLabel = "-12.5%",
  hardStopReason = null,
} = {}) {
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (enforceHardStop && etMinutes(b.ts) >= cutoffMin) {
      const reason = hardStopReason
        || (cutoffMin === HARD_STOP_MIN
          ? "Playbook hard stop at 11:15 AM ET"
          : cutoffMin === 750
            ? "Research window ended at 12:30 PM ET"
            : `Session cutoff at ${minToClock(cutoffMin)}`);
      return { exitBar: b, exitPrice: b.open ?? b.close, exitReason: reason };
    }
    const hitTp = b.high >= tpPrice, hitSl = b.low <= slPrice;
    if (hitTp && hitSl) {
      return { exitBar: b, exitPrice: slPrice, exitReason: `SL hit (${slLabel}) — TP and SL both touched in the same minute, stop assumed first` };
    }
    if (hitTp) return { exitBar: b, exitPrice: tpPrice, exitReason: `TP hit (${tpLabel})` };
    if (hitSl) return { exitBar: b, exitPrice: slPrice, exitReason: `SL hit (${slLabel})` };
  }
  const exitBar = bars[bars.length - 1];
  return { exitBar, exitPrice: exitBar.close, exitReason: "Neither TP nor SL hit — held to the last trade of the day" };
}

export async function simulateBracketTrade({ ticker = "SPY", sessionDate, fire }) {
  // Gamma (and any flow-picked sleeve) may supply the exact contract strike.
  // Playbook / Frontier / Volume still require a level for 1-strike-OTM selection.
  const useFireStrike = fire.useFireStrike || (fire.strike != null && fire.levelType === "GAMMA");
  if (!useFireStrike && !fire.level) {
    return { ok: false, noLevel: true, reason: `Fired on RSI extension alone with no level touch. Both source documents anchor strike selection to a level ("1 strike OTM from the level"), and the Edge Lens guide calls these "information, not instructions" — so there is no playbook contract to simulate.` };
  }

  const expiration = fire.expiration || sessionDate;
  const strike = useFireStrike
    ? Number(fire.strike)
    : pickOtmStrike({ level: fire.level, direction: fire.direction });
  if (!(strike > 0)) {
    return { ok: false, reason: "invalid strike for simulation", strike };
  }
  const occ = occSymbol({ underlying: ticker, expiration, contractType: fire.direction, strike });

  let bars;
  try {
    bars = await fetchAlpacaOptionBars({ occ, sessionDate });
  } catch (err) {
    return { ok: false, reason: `option data unavailable: ${err.message}`, contract: occ, strike };
  }
  if (bars.length < 2) return { ok: false, reason: `no intraday bars for ${occ} — contract may not exist or never traded`, contract: occ, strike };

  const fireMin = etMinutes(fire.ts);
  const entryIdx = bars.findIndex((b) => etMinutes(b.ts) >= fireMin);
  if (entryIdx === -1) return { ok: false, reason: "no contract price at/after the fire time (illiquid at that hour)", contract: occ, strike };

  const entryBar = bars[entryIdx];
  const entryPrice = entryBar.close;
  // Cheap-premium gate (Gamma: ask/last ≤ $1.25). Checked before $1k lot sizing.
  if (fire.maxEntryPrice != null && entryPrice > Number(fire.maxEntryPrice)) {
    return {
      ok: false,
      reason: `entry $${entryPrice.toFixed(2)} above maxEntryPrice $${Number(fire.maxEntryPrice).toFixed(2)}`,
      contract: occ, strike,
    };
  }
  // Volume sleeve (and any fire with maxPremiumDollars) must fit ≥1 lot under the cap.
  if (fire.maxPremiumDollars != null && entryPrice * 100 > Number(fire.maxPremiumDollars)) {
    return {
      ok: false,
      reason: `entry $${entryPrice.toFixed(2)} needs >$${fire.maxPremiumDollars} for 1 contract`,
      contract: occ, strike,
    };
  }
  const tpMult = Number(fire.tpMult) > 0 ? Number(fire.tpMult) : TP_MULT;
  const slMult = Number(fire.slMult) > 0 ? Number(fire.slMult) : SL_MULT;
  const tpPrice = +(entryPrice * tpMult).toFixed(2);
  const slPrice = +(entryPrice * slMult).toFixed(2);

  // Walk forward against the minute's HIGH and LOW, not its close — a
  // resting bracket triggers the moment price trades through it.
  // Entries before the playbook cutoff must be flat at 11:15 ET. Signals
  // after the cutoff are still simulated for learning and remain excluded
  // from playbook P&L, so they cannot be force-exited before they exist.
  const cutoffMin = fire.exitCutoffMin ?? HARD_STOP_MIN;
  const { exitBar, exitPrice, exitReason } = walkBracketBars({
    bars, entryIdx, tpPrice, slPrice, cutoffMin, enforceHardStop: fireMin < cutoffMin,
    tpLabel: fire.tpMult ? `+${Math.round((tpMult - 1) * 100)}%` : "+20%",
    slLabel: fire.slMult ? `-${Math.round((1 - slMult) * 100)}%` : "-12.5%",
  });

  let frontierExitPrice = null;
  let frontierPctReturn = null;
  let frontierPnl = null;
  let frontierExitMin = null;
  let frontierContractsN = null;
  let frontierWalk = null;
  let frontierTp = null;
  let frontierSl = null;
  if (!fire.skipFrontierWalk) {
    // Frontier-only exit on the SAME bars: runner / -50%, no 11:15 hard stop.
    // Official P&L above is unchanged.
    frontierTp = +(entryPrice * FRONTIER_TP_MULT).toFixed(2);
    frontierSl = +(entryPrice * FRONTIER_SL_MULT).toFixed(2);
    frontierWalk = walkBracketBars({
      bars,
      entryIdx,
      tpPrice: frontierTp,
      slPrice: frontierSl,
      cutoffMin: FRONTIER_HARD_STOP_MIN,
      enforceHardStop: fireMin < FRONTIER_HARD_STOP_MIN,
      tpLabel: "+900% runner",
      slLabel: "-50%",
      hardStopReason: "Frontier session end",
    });
    frontierExitPrice = +Number(frontierWalk.exitPrice).toFixed(2);
    frontierPctReturn = +(((frontierExitPrice - entryPrice) / entryPrice) * 100).toFixed(1);
    frontierPnl = frontierPaperPnl(entryPrice, frontierExitPrice, FRONTIER_PAPER_DOLLARS);
    frontierExitMin = etMinutes(frontierWalk.exitBar.ts);
    frontierContractsN = frontierContracts(entryPrice, FRONTIER_PAPER_DOLLARS);
  }

  const entryMin = etMinutes(entryBar.ts), exitMin = etMinutes(exitBar.ts);
  const pctReturn = +(((exitPrice - entryPrice) / entryPrice) * 100).toFixed(1);

  return {
    ok: true,
    contract: occ,
    contractLabel: `SPY $${strike} ${fire.direction === "CALL" ? "Call" : "Put"} · expires ${expiration}`,
    strike, contractType: fire.direction, expiration,
    entryClock: minToClock(entryMin), entryPrice: +entryPrice.toFixed(2), entryMin,
    exitClock: minToClock(exitMin), exitPrice: +exitPrice.toFixed(2), exitMin,
    tpPrice, slPrice, exitReason, pctReturn, holdMinutes: exitMin - entryMin,
    frontierExitPrice,
    frontierExitClock: frontierExitMin != null ? minToClock(frontierExitMin) : null,
    frontierExitMin,
    frontierExitReason: frontierWalk?.exitReason ?? null,
    frontierPctReturn,
    frontierPnl,
    frontierContracts: frontierContractsN,
    frontierHoldMinutes: frontierExitMin != null ? frontierExitMin - entryMin : null,
    frontierTpPrice: frontierTp,
    frontierSlPrice: frontierSl,
    frontierDeployed: frontierContractsN != null
      ? +(frontierContractsN * entryPrice * 100).toFixed(2)
      : null,
    series: bars.map((b) => {
      const m = etMinutes(b.ts);
      return { min: m, clock: minToClock(m), price: +b.close.toFixed(2), high: +b.high.toFixed(2), low: +b.low.toFixed(2) };
    }),
  };
}

export async function simulateAllFires({ ticker = "SPY", sessionDate, fires }) {
  const out = [];
  for (const fire of fires) out.push({ ...fire, trade: await simulateBracketTrade({ ticker, sessionDate, fire }) });
  return out;
}
