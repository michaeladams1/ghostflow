// DATABENTO CLIENT — pulls raw 1-minute OHLCV bars for a symbol/date range.
//
// This is DIFFERENT from quantDataClient.js (which pulls options-flow/GEX/DEX
// data from Quant Data). Databento gives us the raw underlying price history
// we need to compute things like VWAP ourselves, for testing strategies that
// are defined purely in terms of price/volume action (like the VWAP paper),
// not options positioning.
//
// TWO SAFETY PROPERTIES, both added after the first version:
//
//   1. CHUNKING. Requests are split into month-sized pieces. A single request
//      for 2018-2023 is ~2 million bars of newline-JSON — hundreds of MB
//      parsed in memory at once, which is an out-of-memory kill on a small
//      Railway container even though it works on a Mac.
//
//   2. DISK CACHE. Databento streaming requests are METERED — re-requesting
//      the same bytes bills again. Completed past months never change, so
//      they're cached to disk (server/data/, git-ignored) and only fetched
//      once, ever. Chunks that touch today are NOT cached (still growing).
//
// Databento's HTTP API returns NEWLINE-DELIMITED JSON (one object per line),
// prices as fixed-precision integers (1 unit = 1e-9), and timestamps as
// nanoseconds since the Unix epoch — all converted here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
const DATABENTO_DATASET = process.env.DATABENTO_DATASET || "XNAS.ITCH";
const BASE_URL = "https://hist.databento.com/v0/timeseries.get_range";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "data", "databento");

function cachePath(dataset, symbol, start, end) {
  return path.join(CACHE_DIR, `${dataset}_${symbol}_${start}_${end}.json`.replaceAll("/", "-"));
}

// Split [startDate, endDate) into calendar-month-aligned chunks.
function monthChunks(startDate, endDate) {
  const chunks = [];
  let cur = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur < end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const chunkEnd = next < end ? next : end;
    chunks.push([cur.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
    cur = chunkEnd;
  }
  return chunks;
}

function parseBars(rawText) {
  const scale = 1e-9;
  const round = (n) => Math.round(n * 10000) / 10000; // kill float noise, keep 4dp
  const bars = [];
  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    // ts_event arrives as a STRING (uint64 too big for JS numbers), in ns.
    const ts = Math.round(Number(BigInt(rec.hd.ts_event) / 1_000_000n));
    bars.push({
      ts,
      open: round(Number(rec.open) * scale),
      high: round(Number(rec.high) * scale),
      low: round(Number(rec.low) * scale),
      close: round(Number(rec.close) * scale),
      volume: Number(rec.volume),
    });
  }
  return bars;
}

async function fetchChunk({ symbol, start, end, dataset }) {
  const params = new URLSearchParams({
    dataset,
    symbols: symbol,
    schema: "ohlcv-1m",
    start,
    end,
    encoding: "json",
    stype_in: "raw_symbol",
  });

  // HTTP Basic Auth: API key as username, empty password.
  const auth = Buffer.from(`${DATABENTO_API_KEY}:`).toString("base64");
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Databento error ${res.status} (${symbol} ${start}->${end}): ${text.slice(0, 300)}`);
  }
  return parseBars(await res.text());
}

// Fetch 1-minute OHLCV bars for one symbol between startDate and endDate
// (both "YYYY-MM-DD", end exclusive per Databento's convention).
// Returns bars sorted ascending: { ts (ms), open, high, low, close, volume }.
export async function fetchOhlcvBars({ symbol, startDate, endDate, dataset = DATABENTO_DATASET, onProgress }) {
  if (!DATABENTO_API_KEY) {
    throw new Error("DATABENTO_API_KEY is not set. Add it to your .env file.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const chunks = monthChunks(startDate, endDate);
  const all = [];

  for (const [start, end] of chunks) {
    const file = cachePath(dataset, symbol, start, end);
    // Only chunks that end strictly in the past are immutable and cacheable.
    const cacheable = end <= today;

    if (cacheable && fs.existsSync(file)) {
      all.push(...JSON.parse(fs.readFileSync(file, "utf8")));
      onProgress?.({ start, end, source: "cache" });
      continue;
    }

    const bars = await fetchChunk({ symbol, start, end, dataset });
    if (cacheable) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(bars));
    }
    all.push(...bars);
    onProgress?.({ start, end, source: "api", bars: bars.length });
  }

  all.sort((a, b) => a.ts - b.ts);
  return all;
}
