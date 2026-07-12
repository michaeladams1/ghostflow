// Builds a per-trade dataset from real vendor data: a price series (from
// Databento) plus raw options flow (from Quant Data), for the window
// surrounding a logged trade.

import { getDatabentoOHLCV, getQuantDataNetDrift } from "./dataProviders.js";

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Databento's HTTP API price scaling isn't fully confirmed for the JSON
// encoding at time of writing (fixed-point 1e-9 scaling applies to the
// binary DBN format; JSON may or may not already be descaled). This
// defensively descales anything that looks like a fixed-point integer
// (real stock prices aren't in the billions). Check the first few prices
// returned against a known real price when testing this for the first time.
function descalePrice(raw) {
  const n = Number(raw);
  return n > 1_000_000 ? n / 1e9 : n;
}

function parseDatabentoOHLCV(jsonLinesText) {
  return jsonLinesText
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .map((rec) => ({
      // ts_event is nanoseconds since epoch; convert to a plain date string.
      date: new Date(Number(rec.ts_event) / 1e6).toISOString().slice(0, 10),
      close: descalePrice(rec.close),
      volume: rec.volume,
    }));
}

function closestIndex(bars, targetDate) {
  const target = new Date(targetDate).getTime();
  let best = 0, bestDiff = Infinity;
  bars.forEach((bar, i) => {
    const diff = Math.abs(new Date(bar.date).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  return best;
}

export async function buildTradeDataset({ symbol, entryDate, exitDate }) {
  const lookbackStart = addDays(entryDate, -30);
  const rangeEnd = exitDate ? addDays(exitDate, 1) : addDays(entryDate, 5);

  const [ohlcvText, flowData] = await Promise.all([
    getDatabentoOHLCV(symbol, lookbackStart, rangeEnd).catch((err) => {
      console.error("Databento fetch failed:", err.message);
      return null;
    }),
    getQuantDataNetDrift(symbol, entryDate).catch((err) => {
      console.error("Quant Data fetch failed:", err.message);
      return null;
    }),
  ]);

  let prices = [], entryIdx = 0, exitIdx = 0;
  if (ohlcvText) {
    const bars = parseDatabentoOHLCV(ohlcvText);
    prices = bars.map((b) => b.close);
    entryIdx = closestIndex(bars, entryDate);
    exitIdx = exitDate ? closestIndex(bars, exitDate) : Math.min(entryIdx + 3, bars.length - 1);
  }

  return {
    prices,
    entryIdx,
    exitIdx,
    rawFlow: flowData, // kept for the future AI orchestration step, not used in the UI yet
    dataFetchOk: { databento: !!ohlcvText, quantData: !!flowData },
  };
}
