// Durable ledger for live-paper (shadow + submitted) Frontier/Volume signals.
// Separate from zerodte_trades (sim calendar) so reruns never wipe live orders.

import { ensureSchema, pool } from "./db.js";

let liveSchemaReady = null;

export function ensureLivePaperSchema() {
  if (!liveSchemaReady) {
    liveSchemaReady = ensureSchema().then(() => pool.query(`
      CREATE TABLE IF NOT EXISTS zerodte_live_orders (
        id TEXT PRIMARY KEY,
        fire_key TEXT NOT NULL UNIQUE,
        symbol TEXT NOT NULL,
        session_date TEXT NOT NULL,
        sleeve TEXT NOT NULL,              -- FRONTIER | VOLUME
        sleeve_note TEXT NOT NULL,         -- same; Alpaca-visible via client_order_id
        setup TEXT,
        direction TEXT,
        level_type TEXT,
        level NUMERIC,
        et_minute INT,
        contract TEXT,
        strike NUMERIC,
        qty INT,
        entry_ref NUMERIC,                 -- quote mid/ask used for sizing
        tp_price NUMERIC,
        sl_price NUMERIC,
        client_order_id TEXT,
        alpaca_order_id TEXT,
        mode TEXT NOT NULL,                -- shadow | submit
        status TEXT NOT NULL,              -- shadowed | submitted | skipped | error | flattened
        detail JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS zerodte_live_by_session
        ON zerodte_live_orders (symbol, session_date, sleeve);
      CREATE INDEX IF NOT EXISTS zerodte_live_by_status
        ON zerodte_live_orders (status, session_date);
    `)).catch((err) => {
      liveSchemaReady = null;
      throw err;
    });
  }
  return liveSchemaReady;
}

export async function findLiveOrderByFireKey(fireKey) {
  await ensureLivePaperSchema();
  const r = await pool.query(
    `SELECT * FROM zerodte_live_orders WHERE fire_key = $1 LIMIT 1`,
    [fireKey],
  );
  return r.rows[0] || null;
}

export async function insertLiveOrder(row) {
  await ensureLivePaperSchema();
  const r = await pool.query(
    `INSERT INTO zerodte_live_orders (
       id, fire_key, symbol, session_date, sleeve, sleeve_note, setup, direction,
       level_type, level, et_minute, contract, strike, qty, entry_ref, tp_price, sl_price,
       client_order_id, alpaca_order_id, mode, status, detail
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,$15,$16,$17,
       $18,$19,$20,$21,$22::jsonb
     )
     ON CONFLICT (fire_key) DO NOTHING
     RETURNING *`,
    [
      row.id, row.fireKey, row.symbol, row.sessionDate, row.sleeve, row.sleeveNote,
      row.setup || null, row.direction || null, row.levelType || null, row.level ?? null,
      row.etMinute ?? null, row.contract || null, row.strike ?? null, row.qty ?? null,
      row.entryRef ?? null, row.tpPrice ?? null, row.slPrice ?? null,
      row.clientOrderId || null, row.alpacaOrderId || null, row.mode, row.status,
      JSON.stringify(row.detail || {}),
    ],
  );
  return r.rows[0] || null; // null => already existed
}

export async function updateLiveOrder(fireKey, patch) {
  await ensureLivePaperSchema();
  const fields = [];
  const params = [fireKey];
  const set = (col, val) => {
    params.push(val);
    fields.push(`${col} = $${params.length}`);
  };
  if (patch.status != null) set("status", patch.status);
  if (patch.alpacaOrderId != null) set("alpaca_order_id", patch.alpacaOrderId);
  if (patch.clientOrderId != null) set("client_order_id", patch.clientOrderId);
  if (patch.detail != null) {
    params.push(JSON.stringify(patch.detail));
    fields.push(`detail = $${params.length}::jsonb`);
  }
  if (!fields.length) return null;
  fields.push("updated_at = now()");
  const r = await pool.query(
    `UPDATE zerodte_live_orders SET ${fields.join(", ")} WHERE fire_key = $1 RETURNING *`,
    params,
  );
  return r.rows[0] || null;
}

/** Open submitted VOLUME rows for a session (for 11:15 flatten sweep). */
export async function listOpenVolumeLiveOrders(symbol, sessionDate) {
  await ensureLivePaperSchema();
  const r = await pool.query(
    `SELECT * FROM zerodte_live_orders
     WHERE symbol = $1 AND session_date = $2 AND sleeve = 'VOLUME'
       AND mode = 'submit' AND status = 'submitted'`,
    [symbol, sessionDate],
  );
  return r.rows;
}
