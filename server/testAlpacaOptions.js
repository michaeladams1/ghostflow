// Probe: does this Alpaca plan return historical OPTION quotes (bid/ask)?
const KEY = process.env.ALPACA_API_KEY, SEC = process.env.ALPACA_SECRET_KEY;
const H = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC };
const sym = process.argv[2] || "SPY260806C00770000";

for (const feed of ["indicative", "opra"]) {
  const p = new URLSearchParams({ symbols: sym, start: "2026-08-06T13:30:00Z", end: "2026-08-06T14:30:00Z", limit: "5", feed });
  const url = `https://data.alpaca.markets/v1beta1/options/quotes?${p}`;
  const res = await fetch(url, { headers: H });
  const txt = await res.text();
  console.log(`\n--- quotes feed=${feed} -> HTTP ${res.status}`);
  console.log(txt.slice(0, 400));
}

// Also check bars for the same contract, to confirm the symbol is valid.
const p2 = new URLSearchParams({ symbols: sym, timeframe: "1Min", start: "2026-08-06T13:30:00Z", end: "2026-08-06T14:30:00Z", limit: "3" });
const r2 = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?${p2}`, { headers: H });
console.log(`\n--- bars -> HTTP ${r2.status}`);
console.log((await r2.text()).slice(0, 400));
