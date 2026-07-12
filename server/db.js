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

export const pool = new Pool({
  connectionString,
  // Railway's internal/private-network Postgres URL doesn't need SSL; the
  // public one does. This handles both without a separate config flag.
  ssl: connectionString && connectionString.includes("railway.internal")
    ? false
    : { rejectUnauthorized: false },
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
    `).catch((err) => {
      schemaReady = null; // allow retry on next call if this failed
      throw err;
    });
  }
  return schemaReady;
}
