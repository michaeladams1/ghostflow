// Fetches Quant Data endpoints, including "fetch EVERY endpoint" in one call.
//
// DESIGN DECISION WORTH UNDERSTANDING:
// Michael's requirement is that all 3 AI analysts consume ALL available data
// before making any call. There were two ways to do that:
//
//   (a) Expose 30 tools and TRUST each model to remember to call all 30.
//   (b) Fetch all 30 in code, deterministically, and hand every model the
//       same complete bundle.
//
// This file does (b), on purpose. With (a), a model that "forgot" GEX would
// silently produce a thesis with a hole in it and nobody would ever know.
// With (b), completeness is a fact enforced by a for-loop, and the fetch
// report below proves which endpoints succeeded or failed. The models still
// reason INDEPENDENTLY — independence lives in the reasoning, not in whether
// each model separately re-downloads the same numbers.

import { QD_ENDPOINTS, QD_CONTRACT_ENDPOINTS } from "./quantDataRegistry.js";

const BASE = "https://api.quantdata.us";
const KEY = () => process.env.QUANTDATA_API_KEY;

// Quant Data allows 240 requests/minute. We stay comfortably under it with a
// small delay + limited concurrency, so a backtest sweep can reuse this
// client without tripping a 429.
const CONCURRENCY = 4;
const DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Builds the request body for one endpoint. The time selector is NOT uniform
// across endpoints (some take sessionDate, one takes sessionDateRange, news
// takes neither) — the registry records which, and this honors it.
function buildBody(ep, { ticker, sessionDate, startDate, endDate, contract }) {
  const body = { filter: { ticker } };

  if (ep.timeSel === "sessionDate") body.sessionDate = sessionDate;
  if (ep.timeSel === "sessionDateRange") {
    body.sessionDateRange = { startDate: startDate || sessionDate, endDate: endDate || sessionDate };
  }
  // timeSel === "none" -> no time field at all.

  if (ep.needs) Object.assign(body, ep.needs);

  // Contract-scoped endpoints need the full option identifier.
  if (ep.scope === "contract" && contract) {
    body.filter.expirationDate = contract.expirationDate;
    body.filter.strikePrice = Number(contract.strikePrice);
    body.filter.contractType = contract.contractType;
  }
  return body;
}

export async function fetchEndpoint(ep, params) {
  const body = buildBody(ep, params);
  const url = `${BASE}/v1/${ep.surface}/tool/${ep.path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // A 422 "data-unavailable" is an EXPECTED no-data outcome (e.g. no dark
      // pool prints that day), not a bug. It's reported honestly as empty
      // rather than retried or, worse, silently dropped.
      return { id: ep.id, ok: false, status: res.status, error: text.slice(0, 300), data: null };
    }
    return { id: ep.id, ok: true, status: res.status, data: JSON.parse(text), error: null };
  } catch (err) {
    return { id: ep.id, ok: false, status: "NETWORK_ERROR", error: err.message, data: null };
  }
}

// Fetches EVERY endpoint in the registry for one symbol + session.
// Returns both the data and an explicit completeness report, so the analysis
// layer can tell the models exactly which feeds are real and which failed —
// rather than letting a model quietly assume a missing feed said "nothing".
export async function fetchAllEndpoints({ ticker, sessionDate, startDate, endDate, contract }) {
  const endpoints = contract ? [...QD_ENDPOINTS, ...QD_CONTRACT_ENDPOINTS] : QD_ENDPOINTS;
  const params = { ticker, sessionDate, startDate, endDate, contract };
  const results = {};

  for (let i = 0; i < endpoints.length; i += CONCURRENCY) {
    const batch = endpoints.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((ep) => fetchEndpoint(ep, params)));
    settled.forEach((r) => { results[r.id] = r; });
    await sleep(DELAY_MS);
  }

  const attempted = endpoints.map((e) => e.id);
  const succeeded = attempted.filter((id) => results[id].ok);
  const failed = attempted.filter((id) => !results[id].ok);

  return {
    ticker,
    sessionDate,
    results,
    report: {
      attempted: attempted.length,
      succeeded: succeeded.length,
      failed: failed.map((id) => ({ id, status: results[id].status, error: results[id].error })),
      // If this is false, the models MUST be told the data is incomplete.
      complete: failed.length === 0,
    },
  };
}
