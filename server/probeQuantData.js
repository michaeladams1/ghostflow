// One-off discovery script: probes every Quant Data endpoint with a real
// request and records the ACTUAL response shape (or the actual error), so
// the endpoint registry we build is grounded in what the API really returns
// rather than in guesses. Run with: node server/probeQuantData.js
//
// Not part of the running app. Safe to delete once the registry is settled.

import fs from "node:fs";

const KEY = process.env.QUANTDATA_API_KEY;
const BASE = "https://api.quantdata.us";
const TICKER = "META";
const SESSION = "2026-07-10"; // a recent completed session (Friday)
const RANGE_START = "2026-06-25";

// Every endpoint from the docs index, with our best-guess minimal body.
// Where the guess is wrong, the API's own error message tells us the truth —
// which is exactly what this script is for.
const ENDPOINTS = [
  // --- Options (23) ---
  ["options", "contract-statistics", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "contract-trade-side-statistics", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "exposure-by-expiration", { sessionDate: SESSION, filter: { ticker: TICKER }, greekMode: "GAMMA" }],
  ["options", "exposure-by-strike", { sessionDate: SESSION, filter: { ticker: TICKER }, greekMode: "GAMMA" }],
  ["options", "gainers-losers", { sessionDate: SESSION }],
  ["options", "heat-map", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "interval-map", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "iv-rank", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "market-share", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "max-pain", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "max-pain-over-time", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "net-drift", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "net-flow", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "open-interest-by-expiration", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "open-interest-by-strike", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "open-interest-change", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "open-interest-over-time", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "option-price-over-time", { sessionDate: SESSION, filter: { ticker: TICKER, expirationDate: "2026-07-17", strikePrice: 700.0, contractType: "CALL" } }],
  ["options", "order-flow/consolidated", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "order-flow/unconsolidated", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "term-structure", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "volatility-drift", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["options", "volatility-skew", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  // --- Equities (6) ---
  ["equities", "dark-flow", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["equities", "dark-pool-levels", { sessionDateRange: { startDate: RANGE_START, endDate: SESSION }, filter: { ticker: TICKER } }],
  ["equities", "equity-prints", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  ["equities", "exchange-notifications", { sessionDate: SESSION }],
  ["equities", "market-map", { sessionDate: SESSION }],
  ["equities", "stock-price-over-time", { sessionDate: SESSION, filter: { ticker: TICKER } }],
  // --- News (1) ---
  ["news", "news-articles", { filter: { ticker: TICKER } }],
];

// Truncates a response so the probe log stays readable — we want the SHAPE
// (keys, nesting, field names, value types), not thousands of rows.
function shapeOf(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : [shapeOf(value[0], depth + 1), `...(${value.length} items)`];
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const out = {};
    // For bucket-keyed maps (timestamps/strikes as keys), one sample is enough.
    const sample = keys.slice(0, depth === 0 ? 8 : 3);
    sample.forEach((k) => { out[k] = shapeOf(value[k], depth + 1); });
    if (keys.length > sample.length) out[`...(${keys.length} keys total)`] = "";
    return out;
  }
  return typeof value;
}

async function probe(surface, name, body) {
  const url = `${BASE}/v1/${surface}/tool/${name}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
    return {
      endpoint: `${surface}/${name}`,
      url,
      requestBody: body,
      status: res.status,
      ok: res.ok,
      // On success: the real response shape. On failure: the API's own error,
      // which names the missing/conflicting field — just as useful.
      result: res.ok ? shapeOf(parsed) : parsed,
    };
  } catch (err) {
    return { endpoint: `${surface}/${name}`, url, requestBody: body, status: "NETWORK_ERROR", ok: false, result: err.message };
  }
}

const results = [];
for (const [surface, name, body] of ENDPOINTS) {
  const r = await probe(surface, name, body);
  results.push(r);
  console.log(`${r.ok ? "OK  " : "FAIL"} ${String(r.status).padEnd(4)} ${r.endpoint}`);
  await new Promise((r) => setTimeout(r, 300)); // stay well under 240 req/min
}

fs.writeFileSync("/tmp/qd_probe.json", JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} endpoints returned OK. Full detail: /tmp/qd_probe.json`);
