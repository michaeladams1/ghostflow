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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function fetchChunk({ symbol, start, end, dataset }, { retries = 2, timeoutMs = 60000 } = {}) {
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
  const url = `${BASE_URL}?${params.toString()}`;

  // TIMEOUT + RETRY — this request previously had NEITHER. A stalled
  // connection (server accepts it but never responds) left `await fetch()`
  // hanging with no possible resolution, and there was no retry loop at all
  // to fall back on even for an ordinary transient failure. In production
  // this blocked an entire backtest — and everything sequential after it —
  // for 9+ hours on ONE unlucky chunk. 60s is generous (a month of 1-minute
  // bars is a real amount of data to stream), but guarantees this eventually
  // fails instead of hanging forever.
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();
        // 5xx/429 are worth retrying; 4xx (bad request, bad auth, bad dataset)
        // will never succeed on retry — fail fast instead of wasting time.
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          console.warn(`[databento] HTTP ${res.status} on ${symbol} ${start}->${end}, retrying (${attempt + 1}/${retries})...`);
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`Databento error ${res.status} (${symbol} ${start}->${end}): ${text.slice(0, 300)}`);
      }
      return parseBars(await res.text());
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err.name === "AbortError";
      if (attempt < retries) {
        console.warn(`[databento] ${timedOut ? "timed out" : "network error"} on ${symbol} ${start}->${end}, retrying (${attempt + 1}/${retries})...`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(timedOut
        ? `Databento request timed out after ${timeoutMs}ms across ${retries + 1} attempts (${symbol} ${start}->${end})`
        : err.message);
    }
  }
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
