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
    `).catch((err) => {
      schemaReady = null; // allow retry on next call if this failed
      throw err;
    });
  }
  return schemaReady;
}
