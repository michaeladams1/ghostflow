// GAMMA research persistence — feature cache + lane-scoped trade upsert.
// Isolated from live-paper. Day re-sims (saveSessionTrades) preserve GAMMA
// lane rows; this module is the only writer for GAMMA trades/features.

import { pool, ensureSchema } from "./db.js";
import { buildInfo } from "./buildInfo.js";
import { GAMMA_LANE, GAMMA_VERSION } from "./frontierGamma.js";

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

function tradeId({ symbol, sessionDate, direction, clock, tier, codeVersion }) {
  return `${symbol}:${sessionDate}:${codeVersion}:${GAMMA_LANE}:${tier}:${direction}:${clock}`.replace(/\s+/g, "");
}

function featureId({ symbol, sessionDate, etMinute, strike, direction, codeVersion }) {
  return [
    symbol, sessionDate, codeVersion || "na", etMinute ?? "", strike ?? "", direction || "",
  ].join(":").replace(/\s+/g, "");
}

/** Upsert derived gamma features for a session (idempotent). */
export async function saveGammaFeatures({
  symbol = "SPY", sessionDate, rows = [], codeVersion,
} = {}) {
  await ensureSchema();
  const build = buildInfo();
  const version = codeVersion || build.codeVersion;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let applied = 0;
    for (const r of rows) {
      const id = featureId({
        symbol, sessionDate, etMinute: r.etMinute, strike: r.strike,
        direction: r.direction, codeVersion: version,
      });
      await client.query(
        `INSERT INTO zerodte_gamma_features (
           id, symbol, session_date, et_minute, strike, direction,
           ask_proxy, volume, volume_z, gex, net_gex, features, code_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           ask_proxy = EXCLUDED.ask_proxy,
           volume = EXCLUDED.volume,
           volume_z = EXCLUDED.volume_z,
           gex = EXCLUDED.gex,
           net_gex = EXCLUDED.net_gex,
           features = EXCLUDED.features`,
        [
          id, symbol, sessionDate, num(r.etMinute), num(r.strike), r.direction || null,
          num(r.askProxy), num(r.volume), num(r.volumeZ), num(r.gex), num(r.netGex),
          JSON.stringify({ method: GAMMA_VERSION, ...(r.features || {}) }),
          version,
        ],
      );
      applied += 1;
    }
    await client.query("COMMIT");
    console.log(`[gamma-store] features saved symbol=${symbol} date=${sessionDate} applied=${applied}`);
    return applied;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upsert GAMMA lane trade rows onto an existing code_version without wiping
 * Frontier / Volume / official rows.
 */
export async function saveGammaTrades({
  symbol = "SPY", sessionDate, rows, codeVersion, environment = "production",
} = {}) {
  if (!codeVersion) throw new Error("codeVersion required for gamma upsert");
  await ensureSchema();
  const build = (await import("./buildInfo.js")).buildInfo();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM zerodte_trades
       WHERE symbol = $1 AND session_date = $2 AND code_version = $3 AND lane = $4`,
      [symbol, sessionDate, codeVersion, GAMMA_LANE],
    );
    for (const r of rows) {
      const t = r.trade || {};
      await client.query(
        `INSERT INTO zerodte_trades (
           id, symbol, session_date, fired_at, clock, et_minute, pb_window, lane, tier, direction,
           level_type, level, touch_number, points, rsi, swing, vol_pts, speed_pts, wick_pts, mtf_aligned,
           contract, strike, entry_price, exit_price, entry_clock, exit_clock, hold_minutes, exit_reason,
           pct_return, contracts, pnl, counted, features,
           frontier_exit_price, frontier_pct_return, frontier_pnl, frontier_exit_reason,
           deployment_id, commit_sha, code_version, branch, environment
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                   $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,
                   $39,$40,$41,$42)
         ON CONFLICT (id) DO UPDATE SET
           pnl = EXCLUDED.pnl, pct_return = EXCLUDED.pct_return,
           exit_reason = EXCLUDED.exit_reason, features = EXCLUDED.features`,
        [
          tradeId({
            symbol, sessionDate, direction: r.direction,
            clock: r.clock, tier: r.tier || r.scan || "GAMMA", codeVersion,
          }),
          symbol, sessionDate, r.ts ? new Date(r.ts) : null, r.clock || null, num(r.etMinute),
          r.window || "research", GAMMA_LANE, r.tier || r.scan || null, r.direction || null,
          r.levelType || "GAMMA", num(r.level ?? r.strike), num(r.touchNumber) ?? 1, null,
          null, null, null, null, null, null,
          t.contract || null, num(t.strike ?? r.strike), num(t.entryPrice), num(t.exitPrice),
          t.entryClock || null, t.exitClock || null, num(t.holdMinutes), t.exitReason || null,
          num(t.pctReturn), num(r.contracts), num(r.pnl), false,
          JSON.stringify({
            size: r.size, method: r.method || GAMMA_VERSION, liveEnabled: false,
            scan: r.scan, ...(r.featuresExtra || {}),
          }),
          null, null, null, null,
          build.deploymentId, build.commitSha, codeVersion, build.branch, environment,
        ],
      );
    }
    await client.query("COMMIT");
    console.log(`[gamma-store] trades saved symbol=${symbol} date=${sessionDate} rows=${rows.length} lane=${GAMMA_LANE}`);
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
