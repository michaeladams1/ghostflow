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
import { pool, ensureSchema } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.quantdata.us";
const KEY = () => process.env.QUANTDATA_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISK_CACHE_DIR = path.join(__dirname, "data", "quantdata");

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

export async function fetchEndpoint(ep, params, { retries = 3, timeoutMs = 20000 } = {}) {
  const body = buildBody(ep, params);
  const url = `${BASE}/v1/${ep.surface}/tool/${ep.path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // TIMEOUT — this is the fix for a real production incident: a single
    // stalled request (server accepts the connection but never responds, no
    // error, no reset) left `await fetch()` hanging with NO way to ever
    // resolve. Retry logic further down NEVER EVEN RAN, because it only
    // handles responses that actually arrive. One silent stall blocked the
    // entire sequential background pipeline for 9+ hours. An AbortController
    // timeout guarantees this call fails instead of hanging forever, which is
    // what lets the retry loop below actually do its job.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 429 = rate limited. This is TRANSIENT and must be retried, not treated
      // as "no data" — silently dropping rate-limited sessions is exactly what
      // made backtests irreproducible (same rule, same dates, different answers).
      if (res.status === 429) {
        if (attempt < retries) {
          const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
          await sleep(wait);
          continue;
        }
        return { id: ep.id, ok: false, status: 429, error: "Rate limited after retries", data: null, transient: true };
      }

      const text = await res.text();
      if (!res.ok) {
        // A 422 "data-unavailable" is an EXPECTED no-data outcome (e.g. no dark
        // pool prints that day), not a bug. Reported honestly as empty.
        return { id: ep.id, ok: false, status: res.status, error: text.slice(0, 300), data: null };
      }
      return { id: ep.id, ok: true, status: res.status, data: JSON.parse(text), error: null };
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err.name === "AbortError";
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      return {
        id: ep.id, ok: false,
        status: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        error: timedOut ? `Timed out after ${timeoutMs}ms and ${retries} retries` : err.message,
        data: null, transient: true,
      };
    }
  }
}

// TWO-TIER CACHE: memory (fast, per-process) + disk (survives restarts).
//
// WHY DISK: the in-memory cache alone was wiped on every Railway redeploy, so
// every re-run, backtest sweep, and refinement round re-bought the exact same
// immutable bytes and re-spent the 240/min rate limit on them. Data for a
// COMPLETED past session never changes, so it's written to server/data/
// (git-ignored) and never fetched again — same policy as the Databento cache.
//
// WHAT'S NEVER DISK-CACHED:
//   - endpoints with no time selector (e.g. news) — the response changes
//     over time even for old queries
//   - anything whose date range touches today — the session is still growing
const cache = new Map();

function isDiskCacheable(ep, params) {
  if (ep.timeSel === "none") return false;
  const today = new Date().toISOString().slice(0, 10);
  const effectiveEnd = ep.timeSel === "sessionDateRange"
    ? (params.endDate || params.sessionDate)
    : params.sessionDate;
  return !!effectiveEnd && effectiveEnd < today;
}

function diskPath(key) {
  // Keys contain '|' and dates; make a safe flat filename.
  return path.join(DISK_CACHE_DIR, key.replaceAll("|", "_").replaceAll("/", "-") + ".json");
}

// TIER 3: THE POSTGRES WAREHOUSE. Same cacheability rule as disk (completed
// past sessions only), but unlike disk it survives redeploys — Railway wipes
// the container filesystem on every deploy, which meant every deploy silently
// re-bought the whole disk cache from the API. The warehouse is what makes
// cross-ticker basket backtests cheap: each ticker+session+endpoint is
// purchased from the API exactly once, forever.
//
// HARD RULE: the warehouse must never break a fetch. Every DB touch is
// wrapped; on any error we fall through to the API as if the tier didn't
// exist. A down database costs money (re-fetching), never correctness.
async function warehouseGet(key) {
  try {
    await ensureSchema();
    const r = await pool.query("SELECT payload FROM feed_cache WHERE cache_key = $1", [key]);
    return r.rows[0]?.payload ?? null;
  } catch (err) {
    console.warn(`[warehouse] read failed (falling through): ${err.message}`);
    return null;
  }
}

async function warehousePut(key, ep, params, result) {
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO feed_cache (cache_key, ticker, session_date, endpoint, payload)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (cache_key) DO NOTHING`,
      [key, params.ticker, params.sessionDate || params.endDate || "", ep.id, JSON.stringify(result)],
    );
  } catch (err) {
    console.warn(`[warehouse] write failed (ignored): ${err.message}`);
  }
}

export async function fetchEndpointCached(ep, params) {
  // The contract MUST be part of the key: contract-scoped endpoints send
  // strike/expiry/type in the body, and without this two different contracts
  // on the same ticker/session would silently share one cache entry.
  const c = params.contract
    ? `${params.contract.expirationDate}-${params.contract.strikePrice}-${params.contract.contractType}`
    : "";
  const key = `${ep.id}|${params.ticker}|${params.sessionDate}|${params.startDate}|${params.endDate}|${c}`;
  if (cache.has(key)) return cache.get(key);

  const diskOk = isDiskCacheable(ep, params);
  if (diskOk) {
    const file = diskPath(key);
    if (fs.existsSync(file)) {
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      cache.set(key, result);
      return result;
    }
    // TIER 3: the warehouse. Survives redeploys; populated by every fetch
    // everywhere, so basket backtests get cheaper the longer the system runs.
    const stored = await warehouseGet(key);
    if (stored) {
      cache.set(key, stored);
      try { fs.mkdirSync(DISK_CACHE_DIR, { recursive: true }); fs.writeFileSync(diskPath(key), JSON.stringify(stored)); } catch {}
      return stored;
    }
  }

  const result = await fetchEndpoint(ep, params);
  // Only cache successes — caching a rate-limit failure would poison every
  // subsequent round with a phantom "no data".
  if (result.ok) {
    cache.set(key, result);
    if (diskOk) {
      fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
      fs.writeFileSync(diskPath(key), JSON.stringify(result));
      await warehousePut(key, ep, params, result);
    }
  }
  return result;
}

// CHEAP COVERAGE PROBE: one request for the price feed only. Used before
// committing to a full 30-feed pull for a session — this is what stops an
// uncovered ticker (Quant Data's universe is optionable, liquid names) from
// burning 15 days x 30 feeds of requests just to discover there's nothing.
export async function probePriceData({ ticker, sessionDate }) {
  const ep = QD_ENDPOINTS.find((e) => e.id === "stock_price_over_time");
  const result = await fetchEndpointCached(ep, { ticker, sessionDate });
  const hasData = result.ok && Object.keys(result.data?.data || {}).length > 0;
  return { hasData, transient: !!result.transient };
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
    // Cached (memory + disk for past sessions): analysis pulls were the ONLY
    // uncached path left, so every re-run and window walk re-bought identical
    // immutable data and re-spent the rate limit on it.
    const settled = await Promise.all(batch.map((ep) => fetchEndpointCached(ep, params)));
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

// TARGETED FETCH for backtesting.
//
// The analysis phase deliberately pulls ALL 30 feeds (Michael's requirement:
// every model must review everything before forming a view). But a BACKTEST is
// a different job: it re-runs ONE rule across many days, and that rule
// references maybe two or three feeds.
//
// Pulling all 30 feeds x 20 sessions = ~600 requests against a 240/min limit.
// That is what was silently rate-limiting sessions out of the backtest and
// making results irreproducible (89 trades one run, 41 the next).
//
// Fetching only what the rule needs (plus the price series, which is the P&L
// instrument) cuts that to ~60 requests. Ten times fewer, faster, cheaper, and
// it stays comfortably inside the rate limit.
export async function fetchFeedsForRule({ ticker, sessionDate, startDate, endDate, feedIds }) {
  // stock_price_over_time is ALWAYS required — without the underlying's price
  // there is no P&L to compute, no matter what the rule references.
  const needed = new Set([...feedIds, "stock_price_over_time"]);
  const endpoints = QD_ENDPOINTS.filter((e) => needed.has(e.id));
  const params = { ticker, sessionDate, startDate: startDate || sessionDate, endDate: endDate || sessionDate };
  const results = {};

  for (let i = 0; i < endpoints.length; i += CONCURRENCY) {
    const batch = endpoints.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((ep) => fetchEndpointCached(ep, params)));
    settled.forEach((r) => { results[r.id] = r; });
    await sleep(DELAY_MS);
  }

  const attempted = endpoints.map((e) => e.id);
  const failed = attempted.filter((id) => !results[id].ok);

  return {
    ticker,
    sessionDate,
    results,
    report: {
      attempted: attempted.length,
      succeeded: attempted.length - failed.length,
      failed: failed.map((id) => ({ id, status: results[id].status, error: results[id].error })),
      complete: failed.length === 0,
      // Distinguishes "the market had no data" from "we got rate limited",
      // because only one of those is a reason to retry.
      transientFailure: failed.some((id) => results[id].transient),
    },
  };
}
