// ALPACA TRADING CLIENT — paper (or live) order placement for 0DTE sleeves.
// Market data stays in alpacaClient.js; this module only talks to the Trading API.
//
// Sleeve tagging: Alpaca has no freeform "note" on orders. We encode the sleeve
// in `client_order_id` (visible in the Alpaca UI / API), e.g.
//   gf-VOLUME-20260810-ORB_HOLD-CALL-590
//   gf-FRONTIER-20260810-PDH-PUT-612

const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const TRADE_BASE_URL = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").replace(/\/$/, "");
const DATA_BASE_URL = "https://data.alpaca.markets";

function authHeaders() {
  return {
    "APCA-API-KEY-ID": ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
    "Content-Type": "application/json",
  };
}

function roundPx(p) {
  return (Math.round(Number(p) * 100) / 100).toFixed(2);
}

/** Latest option quote → mid (prefer ask for buy sizing when available). */
export async function fetchAlpacaOptionLatestQuote(occ) {
  const params = new URLSearchParams({ symbols: occ });
  const res = await fetch(`${DATA_BASE_URL}/v1beta1/options/quotes/latest?${params}`, {
    headers: authHeaders(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Alpaca option quote failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const q = json.quotes?.[occ];
  if (!q) return null;
  const bid = Number(q.bp);
  const ask = Number(q.ap);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask > 0 ? ask : bid);
  return {
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    mid: mid > 0 ? mid : null,
    t: q.t || null,
  };
}

/**
 * Buy-to-open a single-leg option with a bracket (TP limit + SL stop).
 * `clientOrderId` must already include the sleeve tag (see livePaperIds.js).
 */
export async function submitAlpacaBracketBuy({
  symbol, qty, takeProfit, stopLoss, clientOrderId, timeInForce = "day",
} = {}) {
  if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) {
    throw new Error("missing ALPACA_API_KEY / ALPACA_SECRET_KEY");
  }
  const body = {
    symbol,
    qty: String(qty),
    side: "buy",
    type: "market",
    time_in_force: timeInForce,
    order_class: "bracket",
    take_profit: { limit_price: roundPx(takeProfit) },
    stop_loss: { stop_price: roundPx(stopLoss) },
    client_order_id: clientOrderId,
  };
  const res = await fetch(`${TRADE_BASE_URL}/v2/orders`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Alpaca order failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return json;
}

export async function getAlpacaOrderByClientId(clientOrderId) {
  const res = await fetch(
    `${TRADE_BASE_URL}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    { headers: authHeaders() },
  );
  if (res.status === 404) return null;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Alpaca get order failed (${res.status}): ${text.slice(0, 200)}`);
  return json;
}

/** Market close (sell) an open option position. */
export async function closeAlpacaPosition(symbol) {
  const res = await fetch(
    `${TRADE_BASE_URL}/v2/positions/${encodeURIComponent(symbol)}`,
    { method: "DELETE", headers: authHeaders() },
  );
  const text = await res.text();
  if (res.status === 404) return { ok: true, alreadyFlat: true };
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Alpaca close position failed (${res.status}): ${text.slice(0, 200)}`);
  return { ok: true, order: json };
}

export function alpacaTradingConfigured() {
  return Boolean(ALPACA_API_KEY && ALPACA_SECRET_KEY);
}

export function alpacaTradeBaseUrl() {
  return TRADE_BASE_URL;
}
