// Trade storage — PostgreSQL (Railway), replacing the old ephemeral JSON
// file. Each trade is stored as a single JSONB blob (the exact same shape
// the UI/analysis code already expects — no other file had to change),
// plus a few plain columns (symbol, dates) for future querying once we
// build things like "all trades for this symbol" or thesis aggregation.

import { pool, ensureSchema } from "./db.js";

export async function readTrades() {
  await ensureSchema();
  const { rows } = await pool.query("SELECT data FROM trades ORDER BY logged_at DESC");
  return rows.map((r) => r.data);
}

export async function deleteTrade(id) {
  await ensureSchema();
  await pool.query("DELETE FROM trades WHERE id = $1", [id]);
  return id;
}

export async function appendTrade(trade) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO trades (id, symbol, entry_date, exit_date, logged_at, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [
      trade.id,
      trade.symbol,
      trade.entryDate || null,
      trade.exitDate || null,
      trade.loggedAt || new Date().toISOString(),
      JSON.stringify(trade),
    ]
  );
  return trade;
}
