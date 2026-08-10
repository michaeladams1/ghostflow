// ALPACA CLIENT — pulls SPY's real consolidated (SIP) 1-minute bars.
//
// Why Alpaca and not Databento here: Alpaca's SIP feed is fed directly by
// the CTA (NYSE consolidated tape) + UTP (Nasdaq consolidated tape) streams
// combined — 100% of market volume across every exchange, which is the same
// composite tape TradingView shows by default. Databento's available
// datasets (XNAS.ITCH, DBEQ.BASIC) are each a partial slice of venues.
//
// Free-tier accounts get an error requesting SIP data from the last 15
// minutes. Algo Trader Plus removes that wall. Historical debriefs and the
// live-paper worker both use this client; order placement lives in
// alpacaTrading.js.

const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const DATA_BASE_URL = "https://data.alpaca.markets";

function authHeaders() {
  return {
    "APCA-API-KEY-ID": ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
  };
}

// Fetches ALL 1-min bars (including pre/post market — Alpaca doesn't filter
// by session, we do that downstream) for one symbol between two ISO dates.
// Alpaca paginates via next_page_token; we follow it until exhausted.
export async function fetchAlpacaBars({ symbol, startDate, endDate, feed = "sip" }) {
  const bars = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      timeframe: "1Min",
      start: `${startDate}T00:00:00Z`,
      end: `${endDate}T23:59:59Z`,
      limit: "10000",
      feed,
      adjustment: "raw",
    });
    if (pageToken) params.set("page_token", pageToken);

    const url = `${DATA_BASE_URL}/v2/stocks/${symbol}/bars?${params.toString()}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Alpaca bars request failed (${res.status}): ${text || res.statusText}`);
    }
    const json = await res.json();
    for (const b of json.bars || []) {
      bars.push({
        ts: new Date(b.t).getTime(),
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      });
    }
    pageToken = json.next_page_token || null;
  } while (pageToken);

  return bars.sort((a, b) => a.ts - b.ts);
}

// ---- OPTIONS ----
//
// OCC symbol format: SPY + YYMMDD + C|P + strike x1000, zero-padded to 8.
//   SPY $770 call expiring 2026-08-06 -> SPY260806C00770000
export function occSymbol({ underlying = "SPY", expiration, contractType, strike }) {
  const [y, m, d] = expiration.split("-");
  const cp = String(contractType).toUpperCase().startsWith("C") ? "C" : "P";
  const strikePart = String(Math.round(Number(strike) * 1000)).padStart(8, "0");
  return `${underlying}${y.slice(2)}${m}${d}${cp}${strikePart}`;
}

// Historical 1-min bars for ONE option contract. Unlike the closes-only feed
// this returns full OHLC — which is what makes an honest bracket simulation
// possible: a +20% target can be touched INSIDE a minute and never show up
// in that minute's close.
//
// NOTE ON SPREAD: Alpaca does not offer historical option QUOTES (bid/ask
// time series) on any plan — only latest-quote snapshots. So these are
// traded prices, and any simulation built on them is implicitly assuming
// you could transact at the last trade. Real fills cross the spread, which
// on a $0.20 contract is material. Stated here so it isn't forgotten.
export async function fetchAlpacaOptionBars({ occ, sessionDate }) {
  const bars = [];
  let pageToken = null;
  do {
    // NOTE: unlike the stock bars endpoint, /v1beta1/options/bars rejects a
    // `feed` parameter outright (400 "unexpected query parameter(s): feed").
    // The feed is implied by the account's entitlements.
    const params = new URLSearchParams({
      symbols: occ, timeframe: "1Min",
      start: `${sessionDate}T00:00:00Z`, end: `${sessionDate}T23:59:59Z`,
      limit: "10000",
    });
    if (pageToken) params.set("page_token", pageToken);
    const res = await fetch(`${DATA_BASE_URL}/v1beta1/options/bars?${params}`, { headers: authHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Alpaca option bars failed (${res.status}): ${text || res.statusText}`);
    }
    const json = await res.json();
    for (const b of (json.bars?.[occ] || [])) {
      bars.push({ ts: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, vwap: b.vw, volume: b.v, trades: b.n });
    }
    pageToken = json.next_page_token || null;
  } while (pageToken);
  return bars.sort((a, b) => a.ts - b.ts);
}
