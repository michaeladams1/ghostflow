// OPTION P&L SIMULATION — the layer that answers "fine, the STOCK moved, but
// what did the OPTION make?" for every day a rule fired.
//
// Two contract-selection strategies, run side by side:
//
//   FLOW-PICKED: buy what the smart money bought. At fire time, scan the
//   session's consolidated order flow for the largest aggressive same-side
//   premium inside the lookback window and buy that exact contract. This is
//   the front-running discipline expressed as a backtest policy — the PATTERN
//   picks the contract, not a config knob.
//
//   CLASS GRID: price a small grid (ATM / next strike out, nearest / next
//   expiration) built from the REAL strike and expiry lists in that session's
//   open-interest data — never invented arithmetically, so a contract that
//   didn't exist can't be "bought". The grid is what turns one number into a
//   finding like "this pattern pays in short-dated ATM and dies in far OTM
//   via theta/IV crush".
//
// Everything fetched here flows through fetchEndpointCached, so every
// contract bar and flow row lands in the feed warehouse: the first simulation
// pays, the rest are nearly free.

import { fetchEndpointCached } from "./quantDataClient.js";
import { QD_ENDPOINTS, QD_CONTRACT_ENDPOINTS } from "./quantDataRegistry.js";

const flowEp = QD_ENDPOINTS.find((e) => e.id === "order_flow_consolidated");
const oiExpEp = QD_ENDPOINTS.find((e) => e.id === "open_interest_by_expiration");
const oiStrikeEp = QD_ENDPOINTS.find((e) => e.id === "open_interest_by_strike");
const priceEp = QD_ENDPOINTS.find((e) => e.id === "stock_price_over_time");
const contractEp = QD_CONTRACT_ENDPOINTS.find((e) => e.id === "option_price_over_time");

// NY-clock helpers. Timestamps from Quant Data are parseable by Date; clocks
// are compared in minutes-since-midnight NY time, same convention as the
// stock backtest.
function tsToClock(ts) {
  const d = new Date(isNaN(ts) ? ts : Number(ts));
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
}
function clockToMin(clock) {
  if (!clock) return null;
  const m = String(clock).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function rowsOf(result) {
  return Object.entries(result?.data?.data || {});
}

// Sorted intraday bars for one specific contract: [{min, close}].
async function contractBars(ticker, sessionDate, contract) {
  const r = await fetchEndpointCached(contractEp, { ticker, sessionDate, contract });
  if (!r.ok) return { ok: false, reason: `contract feed ${r.status || "failed"}` };
  const bars = rowsOf(r)
    .map(([ts, b]) => ({ min: clockToMin(tsToClock(b?.timestamp ?? ts)), close: Number(b?.closePrice) }))
    .filter((b) => b.min != null && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.min - b.min);
  if (bars.length < 2) return { ok: false, reason: "no intraday bars for this contract" };
  return { ok: true, bars };
}

// Buy at the first bar at/after entry, sell at the last bar within the hold
// window (or the last bar of the day). Mirrors the stock backtest's
// buy-at-bucket-close convention so the two P&Ls are comparable.
export async function simulateOptionTrade({ ticker, sessionDate, entryClock, holdMinutes = 15, contract }) {
  const cb = await contractBars(ticker, sessionDate, contract);
  if (!cb.ok) return { ok: false, reason: cb.reason, contract };
  const entryMin = clockToMin(entryClock);
  if (entryMin == null) return { ok: false, reason: `unparseable entry clock ${entryClock}`, contract };
  const entryBar = cb.bars.find((b) => b.min >= entryMin);
  if (!entryBar) return { ok: false, reason: "no contract bar at/after entry (illiquid at that hour)", contract };
  const inWindow = cb.bars.filter((b) => b.min > entryBar.min && b.min <= entryMin + holdMinutes);
  const exitBar = inWindow.length ? inWindow[inWindow.length - 1] : cb.bars[cb.bars.length - 1];
  if (exitBar.min <= entryBar.min) return { ok: false, reason: "no contract bar after entry", contract };
  const pctReturn = +(((exitBar.close - entryBar.close) / entryBar.close) * 100).toFixed(1);
  return { ok: true, contract, entryPrice: entryBar.close, exitPrice: exitBar.close, pctReturn };
}

// FLOW PICKER: the largest aggressive same-side premium in the lookback
// window before entry. Falls back to the day's largest same-side print before
// entry when row timestamps aren't parseable — stated in `basis` so the
// result is honest about which it used.
export async function pickContractFromFlow({ ticker, sessionDate, entryClock, direction = "CALL", windowMin = 45 }) {
  const r = await fetchEndpointCached(flowEp, { ticker, sessionDate });
  if (!r.ok) return { contract: null, reason: `flow feed ${r.status || "failed"}` };
  const entryMin = clockToMin(entryClock);
  // Bullish sentiment when the feed provides it; otherwise accept the row.
  // (Field survey on real data: rows carry tradeTime in epoch ms,
  // tradeSideCode, and sentimentType — NOT the tradeSide/timestamp names
  // originally guessed.)
  const sideOk = (row) => !row.sentimentType || /BULL/i.test(String(row.sentimentType));

  const candidates = rowsOf(r)
    .map(([, row]) => ({ row, min: clockToMin(tsToClock(row?.tradeTime ?? row?.timestamp ?? NaN)) }))
    .filter(({ row }) =>
      row && row.contractType === direction && Number(row.premium) > 0
      && row.strikePrice != null && row.expirationDate && sideOk(row));

  const timed = candidates.filter((c) => c.min != null && entryMin != null && c.min <= entryMin && c.min >= entryMin - windowMin);
  const pool = timed.length ? timed : candidates.filter((c) => c.min == null || entryMin == null || c.min <= entryMin);
  if (!pool.length) return { contract: null, reason: `no aggressive ${direction} flow before entry` };

  const best = pool.reduce((a, b) => (Number(b.row.premium) > Number(a.row.premium) ? b : a));
  return {
    contract: { strikePrice: String(best.row.strikePrice), contractType: direction, expirationDate: best.row.expirationDate },
    premium: Number(best.row.premium),
    basis: timed.length ? `largest ${direction} premium in the ${windowMin}min before entry` : `largest ${direction} premium earlier in the session (no large print inside the ${windowMin}min pre-entry window)`,
  };
}

// CLASS GRID from the session's REAL chain: strikes from OI-by-strike,
// expirations from OI-by-expiration, spot from the price feed at entry time.
export async function gridContractsForFire({ ticker, sessionDate, entryClock, direction = "CALL" }) {
  const [strikeR, expR, priceR] = [
    await fetchEndpointCached(oiStrikeEp, { ticker, sessionDate }),
    await fetchEndpointCached(oiExpEp, { ticker, sessionDate }),
    await fetchEndpointCached(priceEp, { ticker, sessionDate }),
  ];
  if (!strikeR.ok || !expR.ok || !priceR.ok) return { grid: [], reason: "chain/price feeds unavailable for grid" };

  const entryMin = clockToMin(entryClock);
  const priceBars = rowsOf(priceR)
    .map(([ts, b]) => ({ min: clockToMin(tsToClock(b?.timestamp ?? ts)), close: Number(b?.closePrice ?? b?.price) }))
    .filter((b) => b.min != null && Number.isFinite(b.close))
    .sort((a, b) => a.min - b.min);
  const atEntry = [...priceBars].reverse().find((b) => entryMin == null || b.min <= entryMin) || priceBars[0];
  if (!atEntry) return { grid: [], reason: "no stock price bars" };
  const spot = atEntry.close;

  // In these feeds the strike / expiration IS the object key:
  // open_interest_by_strike -> { "17.5": {callOpenInterest...} },
  // open_interest_by_expiration -> { "2026-08-21": {...} }.
  const strikes = [...new Set(rowsOf(strikeR).map(([k]) => Number(k)).filter(Number.isFinite))].sort((a, b) => a - b);
  const exps = [...new Set(rowsOf(expR).map(([k]) => String(k)).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e > sessionDate))].sort();
  if (!strikes.length || !exps.length) return { grid: [], reason: "no strikes/expirations in chain data" };

  const atm = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  const above = strikes.filter((s) => s > atm);
  const otm1 = direction === "CALL" ? above[0] : [...strikes].reverse().find((s) => s < atm);
  const nearExp = exps[0];
  const farExp = exps.find((e) => e > nearExp && (new Date(e) - new Date(nearExp)) / 86400000 >= 14) || exps[1] || null;

  const grid = [];
  const push = (label, strike, exp) => {
    if (strike != null && exp) grid.push({ label, contract: { strikePrice: String(strike), contractType: direction, expirationDate: exp } });
  };
  push("ATM near", atm, nearExp);
  push("OTM1 near", otm1, nearExp);
  push("ATM far", atm, farExp);
  push("OTM1 far", otm1, farExp);
  return { grid, spot };
}

// The full pass over one model's fires (across all tickers). Caps the fire
// count to bound API spend; the cap takes the MOST RECENT fires because
// recent chain data has the best coverage.
export async function runOptionSimForFires({ fires, holdMinutes = 15, maxFires = 20, direction = "CALL" }) {
  const capped = [...fires]
    .sort((a, b) => String(a.sessionDate).localeCompare(String(b.sessionDate)))
    .slice(-maxFires);

  const agg = { flow: mkAgg(), grid: {} };
  const examples = [];

  for (const fire of capped) {
    const { ticker, sessionDate, entryClock, stockPct } = fire;

    // Flow-picked contract
    const picked = await pickContractFromFlow({ ticker, sessionDate, entryClock, direction });
    let flowSim = null;
    if (picked.contract) {
      flowSim = await simulateOptionTrade({ ticker, sessionDate, entryClock, holdMinutes, contract: picked.contract });
      if (flowSim.ok) addAgg(agg.flow, flowSim.pctReturn);
    }

    // Class grid
    const { grid } = await gridContractsForFire({ ticker, sessionDate, entryClock, direction });
    const gridSims = [];
    for (const g of grid || []) {
      const sim = await simulateOptionTrade({ ticker, sessionDate, entryClock, holdMinutes, contract: g.contract });
      if (sim.ok) {
        agg.grid[g.label] = agg.grid[g.label] || mkAgg();
        addAgg(agg.grid[g.label], sim.pctReturn);
        gridSims.push({ label: g.label, ...describeContract(g.contract), pctReturn: sim.pctReturn });
      }
    }

    if (examples.length < 5) {
      examples.push({
        ticker, sessionDate, entryClock, stockPct: stockPct ?? null,
        flow: flowSim?.ok ? { ...describeContract(picked.contract), pctReturn: flowSim.pctReturn, basis: picked.basis } : { failed: flowSim?.reason || picked.reason },
        grid: gridSims,
      });
    }
  }

  return {
    holdMinutes,
    firesSimulated: capped.length,
    firesTotal: fires.length,
    flow: finishAgg(agg.flow),
    grid: Object.fromEntries(Object.entries(agg.grid).map(([k, v]) => [k, finishAgg(v)])),
    examples,
  };
}

function describeContract(c) {
  return { contract: `${c.strikePrice}${(c.contractType || "?")[0]} ${c.expirationDate}` };
}
function mkAgg() { return { n: 0, wins: 0, sumPct: 0 }; }
function addAgg(a, pct) { a.n++; if (pct > 0) a.wins++; a.sumPct += pct; }
function finishAgg(a) {
  return a.n === 0 ? { n: 0 }
    : { n: a.n, wins: a.wins, winRate: +((a.wins / a.n) * 100).toFixed(1), avgPct: +(a.sumPct / a.n).toFixed(1) };
}
