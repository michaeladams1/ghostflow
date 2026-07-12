// Second discovery pass: the first probe told us WHICH fields are required
// (dataMode, representationMode, greekMode, lookBackPeriod, maturity).
// This pass sends a deliberately invalid value for each so the API's own
// validation error enumerates the allowed values. Ground truth, not guesses.

const KEY = process.env.QUANTDATA_API_KEY;
const BASE = "https://api.quantdata.us";
const TICKER = "META";
const SESSION = "2026-07-10";

const PROBES = [
  ["options", "net-flow", { sessionDate: SESSION, filter: { ticker: TICKER }, dataMode: "__INVALID__" }],
  ["options", "contract-trade-side-statistics", { sessionDate: SESSION, filter: { ticker: TICKER }, dataMode: "__INVALID__" }],
  ["options", "heat-map", { sessionDate: SESSION, filter: { ticker: TICKER }, dataMode: "__INVALID__" }],
  ["options", "exposure-by-strike", { sessionDate: SESSION, filter: { ticker: TICKER }, representationMode: "__INVALID__" }],
  ["options", "exposure-by-expiration", { sessionDate: SESSION, filter: { ticker: TICKER }, representationMode: "__INVALID__" }],
  ["options", "interval-map", { sessionDate: SESSION, filter: { ticker: TICKER }, greekMode: "__INVALID__" }],
  ["options", "iv-rank", { sessionDate: SESSION, filter: { ticker: TICKER }, lookBackPeriod: "__INVALID__", maturity: "__INVALID__" }],
];

for (const [surface, name, body] of PROBES) {
  const res = await fetch(`${BASE}/v1/${surface}/tool/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n=== ${surface}/${name} (${res.status})`);
  console.log(text.slice(0, 1200));
  await new Promise((r) => setTimeout(r, 300));
}
