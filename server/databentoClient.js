// DATABENTO CLIENT — pulls raw 1-minute OHLCV bars for a symbol/date range.
//
// This is DIFFERENT from quantDataClient.js (which pulls options-flow/GEX/DEX
// data from Quant Data). Databento gives us the raw underlying price history
// we need to compute things like VWAP ourselves, for testing strategies that
// are defined purely in terms of price/volume action (like the VWAP paper),
// not options positioning.
//
// Databento's HTTP API returns NEWLINE-DELIMITED JSON (one JSON object per
// line), not a single JSON array — this trips people up the first time.
// Prices come back as fixed-precision integers (1 unit = 1e-9), and
// timestamps as nanoseconds since the Unix epoch. Both need converting.

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
const DATABENTO_DATASET = process.env.DATABENTO_DATASET || "XNAS.ITCH";
const BASE_URL = "https://hist.databento.com/v0/timeseries.get_range";

// Fetch 1-minute OHLCV bars for one symbol between startDate and endDate
// (both "YYYY-MM-DD", end is exclusive per Databento's convention).
// Returns bars sorted ascending by time, each as:
//   { ts: <ms since epoch>, open, high, low, close, volume }
export async function fetchOhlcvBars({ symbol, startDate, endDate, dataset = DATABENTO_DATASET }) {
  if (!DATABENTO_API_KEY) {
    throw new Error("DATABENTO_API_KEY is not set. Add it to your .env file.");
  }

  const params = new URLSearchParams({
    dataset,
    symbols: symbol,
    schema: "ohlcv-1m",
    start: startDate,
    end: endDate,
    encoding: "json",
    stype_in: "raw_symbol",
  });

  // Databento uses HTTP Basic Auth with the API key as the username and an
  // empty password — no request body auth, just the header.
  const auth = Buffer.from(`${DATABENTO_API_KEY}:`).toString("base64");

  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Databento error ${res.status}: ${text.slice(0, 500)}`);
  }

  const raw = await res.text();
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const bars = lines.map((line) => {
    const rec = JSON.parse(line);
    // ts_event arrives as a STRING (it's a uint64 too big for JS numbers to
    // hold precisely), in nanoseconds. Divide down to milliseconds.
    const ts = Math.round(Number(BigInt(rec.hd.ts_event) / 1_000_000n));
    // Prices are fixed-precision integers, also strings for large values.
    const scale = 1e-9;
    const round = (n) => Math.round(n * 10000) / 10000; // kill float noise, keep 4dp
    return {
      ts,
      open: round(Number(rec.open) * scale),
      high: round(Number(rec.high) * scale),
      low: round(Number(rec.low) * scale),
      close: round(Number(rec.close) * scale),
      volume: Number(rec.volume),
    };
  });

  bars.sort((a, b) => a.ts - b.ts);
  return bars;
}
