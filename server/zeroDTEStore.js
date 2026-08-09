// 0DTE TRADE STORE — persists every simulated fire with the full feature set
// that produced it, so the strategy can be analyzed instead of re-guessed.
//
// Why this exists: before it, the month calendar recomputed from Alpaca on
// every view and kept results only in an in-memory Map that died on restart.
// Nothing was learnable across sessions — there was no way to ask "do PDH
// touches beat whole-dollar touches?" because no trade was ever written down.

import { pool, ensureSchema } from "./db.js";

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// Deterministic id: re-simulating a day overwrites its own rows rather than
// appending duplicates.
function tradeId({ symbol, sessionDate, lane, direction, clock, tier }) {
  return `${symbol}:${sessionDate}:${lane}:${tier}:${direction}:${clock}`.replace(/\s+/g, "");
}

export async function saveSessionTrades({ symbol = "SPY", sessionDate, rows }) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Replace-on-rerun: a logic change re-simulates the day cleanly.
    await client.query("DELETE FROM zerodte_trades WHERE symbol = $1 AND session_date = $2", [symbol, sessionDate]);
    for (const r of rows) {
      const t = r.trade || {};
      await client.query(
        `INSERT INTO zerodte_trades (
           id, symbol, session_date, fired_at, clock, et_minute, pb_window, lane, tier, direction,
           level_type, level, touch_number, points, rsi, swing, vol_pts, speed_pts, wick_pts, mtf_aligned,
           contract, strike, entry_price, exit_price, entry_clock, exit_clock, hold_minutes, exit_reason,
           pct_return, contracts, pnl, counted, features
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                   $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
         ON CONFLICT (id) DO UPDATE SET
           pnl = EXCLUDED.pnl, pct_return = EXCLUDED.pct_return,
           exit_reason = EXCLUDED.exit_reason, features = EXCLUDED.features`,
        [
          tradeId({ symbol, sessionDate, lane: r.lane || "official", direction: r.direction, clock: r.clock, tier: r.tier }),
          symbol, sessionDate, r.ts ? new Date(r.ts) : null, r.clock || null, num(r.etMinute),
          r.window || null, r.lane || "official", r.tier || null, r.direction || null,
          r.levelType || null, num(r.level), num(r.touchNumber), num(r.points), num(r.rsi), num(r.swing),
          num(r.volPts), num(r.speedPts), num(r.wickPts), r.mtfAligned ?? null,
          t.contract || null, num(t.strike), num(t.entryPrice), num(t.exitPrice),
          t.entryClock || null, t.exitClock || null, num(t.holdMinutes), t.exitReason || null,
          num(t.pctReturn), num(r.contracts), num(r.pnl), r.counted ?? false,
          JSON.stringify({
            size: r.size, suggestedStop: r.suggestedStop, exhaustionException: r.exhaustionException,
            price: r.price, simFailed: t.ok === false ? t.reason : undefined,
          }),
        ],
      );
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function loadTrades({ symbol = "SPY", from, to, lane, countedOnly } = {}) {
  await ensureSchema();
  const where = ["symbol = $1"], params = [symbol];
  if (from) { params.push(from); where.push(`session_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`session_date <= $${params.length}`); }
  if (lane) { params.push(lane); where.push(`lane = $${params.length}`); }
  if (countedOnly) where.push("counted = true");
  const { rows } = await pool.query(
    `SELECT * FROM zerodte_trades WHERE ${where.join(" AND ")} ORDER BY session_date, et_minute`, params);
  return rows;
}

export async function coveredSessions({ symbol = "SPY" } = {}) {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT DISTINCT session_date FROM zerodte_trades WHERE symbol = $1 ORDER BY session_date", [symbol]);
  return rows.map((r) => r.session_date);
}
