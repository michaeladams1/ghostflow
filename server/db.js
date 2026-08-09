// PostgreSQL connection + schema setup.
//
// IMPORTANT: DATABASE_URL must be set on GHOSTFLOW's own Railway service —
// being in the same Railway *project* as the Postgres service does NOT
// automatically inject its variables into this service. In Railway:
//   ghostflow service -> Variables tab -> New Variable -> name it
//   DATABASE_URL and reference the Postgres service's DATABASE_URL
//   (Railway's variable picker will suggest it).

import pg from "pg";
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

// SSL is required by Railway's PUBLIC Postgres URL, but NOT supported by
// Railway's internal URL, and NOT supported by a plain local Postgres. Forcing
// it unconditionally made local testing impossible ("The server does not
// support SSL connections"), which is how a re-run bug went undiagnosed.
// Detect rather than assume.
const isLocal = !connectionString
  || connectionString.includes("localhost")
  || connectionString.includes("127.0.0.1")
  || connectionString.includes("railway.internal");

export const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

let schemaReady = null;
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        entry_date TEXT,
        exit_date TEXT,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      );
      -- THE FEED WAREHOUSE. Immutable market data for COMPLETED past sessions,
      -- keyed exactly like the in-process cache. Written once, never updated.
      -- This is the tier that survives redeploys (the disk cache lives on the
      -- container filesystem and is wiped every deploy) — it is what makes
      -- basket backtests across many tickers progressively cheaper: every
      -- session's feeds are bought from the API exactly once, ever.
      CREATE TABLE IF NOT EXISTS feed_cache (
        cache_key TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        session_date TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS feed_cache_lookup
        ON feed_cache (ticker, session_date, endpoint);
      -- THE THESIS DOCUMENTS: one evolving doc per analyst plus the 'shared'
      -- side-by-side merge. This is the learning layer — the only memory that
      -- carries between trades.
      CREATE TABLE IF NOT EXISTS theses (
        model TEXT PRIMARY KEY,
        doc JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- 0DTE SIMULATED TRADES. Every signal the replay produces, with the
      -- FULL feature set that generated it and the outcome it produced. This
      -- is the analysis substrate: without it, each calendar view recomputes
      -- from Alpaca and nothing is ever learnable across sessions.
      --
      -- One row per (session_date, fire) — re-running a day REPLACES its rows
      -- so a logic change re-simulates cleanly instead of double-counting.
      CREATE TABLE IF NOT EXISTS zerodte_trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        session_date TEXT NOT NULL,
        fired_at TIMESTAMPTZ,
        clock TEXT,
        et_minute INT,
        pb_window TEXT,           -- before | in | after (playbook hours)
        lane TEXT,                -- official | research lane name
        tier TEXT,                -- A+ | A | RSI Extreme | Research...
        direction TEXT,           -- CALL | PUT
        level_type TEXT,          -- WHOLE_DOLLAR | PDH | VWAP | ...
        level NUMERIC,
        touch_number INT,
        points INT,
        rsi INT,
        swing INT,
        vol_pts INT, speed_pts INT, wick_pts INT,
        mtf_aligned BOOLEAN,
        contract TEXT,
        strike NUMERIC,
        entry_price NUMERIC, exit_price NUMERIC,
        entry_clock TEXT, exit_clock TEXT, hold_minutes INT,
        exit_reason TEXT,
        pct_return NUMERIC,
        contracts INT,
        pnl NUMERIC,
        counted BOOLEAN,          -- did it count toward playbook-hours P&L
        features JSONB NOT NULL,  -- everything else, for later analysis
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS zerodte_by_session ON zerodte_trades (symbol, session_date);
      CREATE INDEX IF NOT EXISTS zerodte_by_lane ON zerodte_trades (lane, counted);
    `).catch((err) => {
      schemaReady = null; // allow retry on next call if this failed
      throw err;
    });
  }
  return schemaReady;
}
