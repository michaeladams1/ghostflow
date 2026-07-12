// Data provider functions — Databento (raw price/volume) and Quant Data
// (options flow/GEX/dark pool). Both read keys from process.env only.
// Nothing here is called from the frontend directly; it's server-side.

const DATABENTO_KEY = process.env.DATABENTO_API_KEY;
const DATABENTO_DATASET = process.env.DATABENTO_DATASET || "XNAS.ITCH";
const QUANTDATA_KEY = process.env.QUANTDATA_API_KEY;

// --- Databento: HTTP Basic Auth, API key as username, blank password ---
function databentoAuthHeader() {
  const token = Buffer.from(`${DATABENTO_KEY}:`).toString("base64");
  return `Basic ${token}`;
}

// Free call — confirms the key works and shows which datasets you're entitled to.
export async function listDatabentoDatasets() {
  const res = await fetch("https://hist.databento.com/v0/metadata.list_datasets", {
    headers: { Authorization: databentoAuthHeader() },
  });
  if (!res.ok) throw new Error(`Databento error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Daily OHLCV bars for a symbol over a date range. This is a paid call once you
// go beyond metadata endpoints — check cost with metadata.get_cost first if
// you're unsure about your plan.
export async function getDatabentoOHLCV(symbol, start, end) {
  const params = new URLSearchParams({
    dataset: DATABENTO_DATASET,
    symbols: symbol,
    schema: "ohlcv-1d",
    start,
    end,
    encoding: "json",
  });
  const res = await fetch(`https://hist.databento.com/v0/timeseries.get_range?${params}`, {
    headers: { Authorization: databentoAuthHeader() },
  });
  if (!res.ok) throw new Error(`Databento error ${res.status}: ${await res.text()}`);
  return res.text(); // JSON-lines format, one record per line
}

// --- Quant Data: Bearer token, POST + JSON body ---
export async function getQuantDataNetDrift(ticker, sessionDate) {
  const res = await fetch("https://api.quantdata.us/v1/options/tool/net-drift", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${QUANTDATA_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionDate, filter: { ticker } }),
  });
  if (!res.ok) throw new Error(`Quant Data error ${res.status}: ${await res.text()}`);
  return res.json();
}
