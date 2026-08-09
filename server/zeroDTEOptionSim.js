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

export function walkBracketBars({ bars, entryIdx, tpPrice, slPrice, enforceHardStop = true, cutoffMin = HARD_STOP_MIN }) {
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (enforceHardStop && etMinutes(b.ts) >= cutoffMin) {
      return { exitBar: b, exitPrice: b.open ?? b.close, exitReason: cutoffMin === HARD_STOP_MIN ? "Playbook hard stop at 11:15 AM ET" : "Research window ended at 12:30 PM ET" };
    }
    const hitTp = b.high >= tpPrice, hitSl = b.low <= slPrice;
    if (hitTp && hitSl) {
      return { exitBar: b, exitPrice: slPrice, exitReason: "SL hit (-12.5%) — TP and SL both touched in the same minute, stop assumed first" };
    }
    if (hitTp) return { exitBar: b, exitPrice: tpPrice, exitReason: "TP hit (+20%)" };
    if (hitSl) return { exitBar: b, exitPrice: slPrice, exitReason: "SL hit (-12.5%)" };
  }
  const exitBar = bars[bars.length - 1];
  return { exitBar, exitPrice: exitBar.close, exitReason: "Neither TP nor SL hit — held to the last trade of the day" };
}

export async function simulateBracketTrade({ ticker = "SPY", sessionDate, fire }) {
  if (!fire.level) {
    return { ok: false, noLevel: true, reason: `Fired on RSI extension alone with no level touch. Both source documents anchor strike selection to a level ("1 strike OTM from the level"), and the Edge Lens guide calls these "information, not instructions" — so there is no playbook contract to simulate.` };
  }

  const strike = pickOtmStrike({ level: fire.level, direction: fire.direction });
  const occ = occSymbol({ underlying: ticker, expiration: sessionDate, contractType: fire.direction, strike });

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
  const tpPrice = +(entryPrice * TP_MULT).toFixed(2);
  const slPrice = +(entryPrice * SL_MULT).toFixed(2);

  // Walk forward against the minute's HIGH and LOW, not its close — a
  // resting bracket triggers the moment price trades through it.
  // Entries before the playbook cutoff must be flat at 11:15 ET. Signals
  // after the cutoff are still simulated for learning and remain excluded
  // from playbook P&L, so they cannot be force-exited before they exist.
  const cutoffMin = fire.exitCutoffMin ?? HARD_STOP_MIN;
  const { exitBar, exitPrice, exitReason } = walkBracketBars({
    bars, entryIdx, tpPrice, slPrice, cutoffMin, enforceHardStop: fireMin < cutoffMin,
  });

  const entryMin = etMinutes(entryBar.ts), exitMin = etMinutes(exitBar.ts);
  const pctReturn = +(((exitPrice - entryPrice) / entryPrice) * 100).toFixed(1);

  return {
    ok: true,
    contract: occ,
    contractLabel: `SPY $${strike} ${fire.direction === "CALL" ? "Call" : "Put"} · expires ${sessionDate}`,
    strike, contractType: fire.direction,
    entryClock: minToClock(entryMin), entryPrice: +entryPrice.toFixed(2), entryMin,
    exitClock: minToClock(exitMin), exitPrice: +exitPrice.toFixed(2), exitMin,
    tpPrice, slPrice, exitReason, pctReturn, holdMinutes: exitMin - entryMin,
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
