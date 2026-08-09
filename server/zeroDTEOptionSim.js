// BRACKET-ORDER OPTION SIMULATION — for each fired 0DTE signal, builds the
// exact 1-strike-OTM, SAME-DAY-EXPIRY contract per the Shen Lao playbook's
// strike-selection rule, then walks its REAL intraday price (via Quant
// Data's option pricing feed — reusing the same source your existing
// optionSim.js already trusts) to see whether the bracket order's +20%
// take-profit or -12.5% stop-loss would have hit first. "Set the moment
// you are filled. Not after. Not during." — simulated exactly that way.

import { fetchEndpointCached } from "./quantDataClient.js";
import { QD_CONTRACT_ENDPOINTS } from "./quantDataRegistry.js";
import { pickOtmStrike } from "./zeroDTE.js";

const contractEp = QD_CONTRACT_ENDPOINTS.find((e) => e.id === "option_price_over_time");

const TP_MULT = 1.20;   // +20% target — the playbook's stated bracket TP
const SL_MULT = 0.875;  // -12.5% stop — the playbook's stated bracket SL

function etMinutes(ts) {
  const d = new Date(isNaN(ts) ? ts : Number(ts));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const map = {}; for (const p of parts) map[p.type] = p.value;
  return Number(map.hour) * 60 + Number(map.minute);
}
function minToClock(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ET`;
}
function rowsOf(result) { return Object.entries(result?.data?.data || {}); }
function describeContract(c) { return `SPY ${c.strikePrice}${c.contractType[0]} ${c.expirationDate}`; }

async function contractBars({ ticker, sessionDate, contract }) {
  const r = await fetchEndpointCached(contractEp, { ticker, sessionDate, contract });
  if (!r.ok) return { ok: false, reason: `contract feed ${r.status || "failed"}` };
  const bars = rowsOf(r)
    .map(([ts, b]) => ({ min: etMinutes(b?.timestamp ?? ts), close: Number(b?.closePrice) }))
    .filter((b) => Number.isFinite(b.min) && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.min - b.min);
  return bars.length >= 2 ? { ok: true, bars } : { ok: false, reason: "no intraday price history for this contract (illiquid, or it doesn't exist)" };
}

// Simulates ONE fire's bracket-order trade: buy at the first contract price
// at/after the fire time, then walk forward bar by bar until the +20% TP or
// -12.5% SL is crossed — whichever happens first, matching a real OCO
// bracket order — or hold to the last available price if neither hits.
export async function simulateBracketTrade({ ticker = "SPY", sessionDate, fire }) {
  if (!fire.level) {
    return { ok: false, reason: `${fire.tier} ${fire.direction} at ${fire.clock} fired off pure RSI extension with no level touch — the playbook has no strike-selection rule for that (it always anchors the strike to a level), so there's no contract to simulate.` };
  }

  const strike = pickOtmStrike({ level: fire.level, direction: fire.direction });
  const contract = { strikePrice: String(strike), contractType: fire.direction, expirationDate: sessionDate };

  const cb = await contractBars({ ticker, sessionDate, contract });
  if (!cb.ok) return { ok: false, reason: cb.reason, contract: describeContract(contract) };

  const fireMin = etMinutes(fire.ts);
  const entryBar = cb.bars.find((b) => b.min >= fireMin);
  if (!entryBar) return { ok: false, reason: "no contract price at/after the fire time (illiquid at that hour)", contract: describeContract(contract) };

  const entryPrice = entryBar.close;
  const tpPrice = +(entryPrice * TP_MULT).toFixed(4);
  const slPrice = +(entryPrice * SL_MULT).toFixed(4);

  const after = cb.bars.filter((b) => b.min > entryBar.min);
  let exit = null, exitReason = "Held to end of day (neither TP nor SL hit)";
  for (const b of after) {
    if (b.close >= tpPrice) { exit = b; exitReason = "TP hit (+20%)"; break; }
    if (b.close <= slPrice) { exit = b; exitReason = "SL hit (-12.5%)"; break; }
  }
  if (!exit) exit = after[after.length - 1] || entryBar;

  const pctReturn = +(((exit.close - entryPrice) / entryPrice) * 100).toFixed(1);
  return {
    ok: true, contract: describeContract(contract), strike, contractType: fire.direction,
    entryClock: minToClock(entryBar.min), entryPrice,
    exitClock: minToClock(exit.min), exitPrice: exit.close,
    tpPrice, slPrice, exitReason, pctReturn, holdMinutes: exit.min - entryBar.min,
  };
}

// Runs the bracket sim for every fire in a session and attaches the outcome.
export async function simulateAllFires({ ticker = "SPY", sessionDate, fires }) {
  const out = [];
  for (const fire of fires) out.push({ ...fire, trade: await simulateBracketTrade({ ticker, sessionDate, fire }) });
  return out;
}
