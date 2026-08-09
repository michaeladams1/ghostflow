// ALPACA CLIENT — pulls SPY's real consolidated (SIP) 1-minute bars.
//
// Why Alpaca and not Databento here: Alpaca's SIP feed is fed directly by
// the CTA (NYSE consolidated tape) + UTP (Nasdaq consolidated tape) streams
// combined — 100% of market volume across every exchange, which is the same
// composite tape TradingView shows by default. Databento's available
// datasets (XNAS.ITCH, DBEQ.BASIC) are each a partial slice of venues.
//
// Free-tier accounts get an error requesting SIP data from the last 15
// minutes. This client is ONLY ever used retrospectively (end-of-day, or
// later), so that limit never actually applies here.

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
