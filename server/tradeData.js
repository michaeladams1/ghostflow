// Builds a per-trade dataset from real vendor data: daily OHLC bars, an
// intraday 15-minute OHLC series for the interactive chart, and raw options
// flow — all for the window surrounding a logged trade.

import { getDatabentoOHLCV, getDatabentoIntraday, getQuantDataNetDrift } from "./dataProviders.js";

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Databento's HTTP API price scaling isn't fully confirmed for the JSON
// encoding at time of writing (fixed-point 1e-9 scaling applies to the
// binary DBN format; JSON may or may not already be descaled). This
// defensively descales anything that looks like a fixed-point integer
// (real stock prices aren't in the billions).
function descalePrice(raw) {
  const n = Number(raw);
  return n > 1_000_000 ? n / 1e9 : n;
}

// Shared parser for both daily and minute OHLCV JSON-lines responses.
// Header fields (including the timestamp) are nested under "hd".
// Exported so server/tools.js can reuse it for arbitrary AI-requested fetches.
export function parseOHLCV(jsonLinesText) {
  return jsonLinesText
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .map((rec) => ({
      // ts_event is nanoseconds since epoch.
      ts: Number(rec.hd.ts_event) / 1e6, // -> milliseconds, easier to bucket
      date: new Date(Number(rec.hd.ts_event) / 1e6).toISOString(),
      open: descalePrice(rec.open),
      high: descalePrice(rec.high),
      low: descalePrice(rec.low),
      close: descalePrice(rec.close),
      volume: Number(rec.volume),
    }));
}

// Aggregates 1-minute bars into 15-minute OHLCV buckets. Exported for reuse
// by server/tools.js.
export function aggregateTo15Min(minuteBars) {
  const buckets = new Map();
  const bucketMs = 15 * 60 * 1000;
  for (const bar of minuteBars) {
    const bucketStart = Math.floor(bar.ts / bucketMs) * bucketMs;
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, { ts: bucketStart, date: new Date(bucketStart).toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    } else {
      const b = buckets.get(bucketStart);
      b.high = Math.max(b.high, bar.high);
      b.low = Math.min(b.low, bar.low);
      b.close = bar.close; // bars arrive chronologically, so last write wins
      b.volume += bar.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
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

// For intraday bars: "closest to midnight" isn't what we want for entry/exit
// markers. Entry should be the first bar of that calendar day; exit should
// be the last bar of that calendar day.
function findDayBoundary(bars, dateStr, edge) {
  let found = -1;
  bars.forEach((bar, i) => {
    if (bar.date.slice(0, 10) === dateStr) {
      if (edge === "start" && found === -1) found = i;
      if (edge === "end") found = i;
    }
  });
  return found !== -1 ? found : closestIndex(bars, dateStr);
}

export async function buildTradeDataset({ symbol, entryDate, exitDate }) {
  const lookbackStart = addDays(entryDate, -30);
  const rangeEnd = exitDate ? addDays(exitDate, 1) : addDays(entryDate, 5);

  const [ohlcvText, intradayText, flowData] = await Promise.all([
    getDatabentoOHLCV(symbol, lookbackStart, rangeEnd).catch((err) => {
      console.error("Databento daily fetch failed:", err.message);
      return null;
    }),
    getDatabentoIntraday(symbol, `${entryDate}T00:00:00`, `${rangeEnd}T00:00:00`).catch((err) => {
      console.error("Databento intraday fetch failed:", err.message);
      return null;
    }),
    getQuantDataNetDrift(symbol, entryDate).catch((err) => {
      console.error("Quant Data fetch failed:", err.message);
      return null;
    }),
  ]);

  let prices = [], entryIdx = 0, exitIdx = 0, bars = null;
  if (ohlcvText) {
    bars = parseOHLCV(ohlcvText);
    prices = bars.map((b) => b.close);
    entryIdx = closestIndex(bars, entryDate);
    exitIdx = exitDate ? closestIndex(bars, exitDate) : Math.min(entryIdx + 3, bars.length - 1);
  }

  let intradayBars = null, intradayEntryIdx = null, intradayExitIdx = null;
  if (intradayText) {
    const minuteBars = parseOHLCV(intradayText);
    intradayBars = aggregateTo15Min(minuteBars);
    if (intradayBars.length) {
      intradayEntryIdx = findDayBoundary(intradayBars, entryDate, "start");
      intradayExitIdx = findDayBoundary(intradayBars, exitDate || entryDate, "end");
    }
  }

  return {
    prices,
    entryIdx,
    exitIdx,
    bars, // daily {date, open, high, low, close, volume} — used by the AI analysis prompt
    intradayBars, // 15-min bars — used by the interactive chart
    intradayEntryIdx,
    intradayExitIdx,
    rawFlow: flowData,
    dataFetchOk: { databento: !!ohlcvText, databentoIntraday: !!intradayText, quantData: !!flowData },
  };
}
