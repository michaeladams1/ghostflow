// 0DTE TRADE STORE — persists every simulated fire with the full feature set
// that produced it, so the strategy can be analyzed instead of re-guessed.
//
// Why this exists: before it, the month calendar recomputed from Alpaca on
// every view and kept results only in an in-memory Map that died on restart.
// Nothing was learnable across sessions — there was no way to ask "do PDH
// touches beat whole-dollar touches?" because no trade was ever written down.

import { pool, ensureSchema } from "./db.js";
import { buildInfo } from "./buildInfo.js";
import {
  frontierDedupeKey, frontierLanePriority,
} from "./zeroDTE.js";
import {
  frontierDeployedNotional, frontierPaperPnl, passesFrontierV3, selectFrontierBestPerDay,
} from "./frontierV3.js";
import { VOLUME_LANE } from "./frontierVolume.js";

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Dollars at entry: prefer stored contracts, else $1k paper sizing. */
function deployedNotional(entryPrice, contracts, { dollars = 1000 } = {}) {
  const entry = Number(entryPrice);
  if (!(entry > 0)) return null;
  const c = contracts != null && Number(contracts) > 0
    ? Number(contracts)
    : Math.max(1, Math.floor(dollars / (entry * 100)));
  return +(c * entry * 100).toFixed(2);
}

// Deterministic id: re-simulating a day overwrites its own rows rather than
// appending duplicates.
function tradeId({ symbol, sessionDate, lane, direction, clock, tier, codeVersion }) {
  return `${symbol}:${sessionDate}:${codeVersion}:${lane}:${tier}:${direction}:${clock}`.replace(/\s+/g, "");
}

export async function saveSessionTrades({ symbol = "SPY", sessionDate, rows }) {
  await ensureSchema();
  const build = buildInfo();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Replace-on-rerun, SCOPED TO THIS CODE VERSION: re-running a day on the
    // same commit is idempotent, but running it on new code leaves the old
    // version's rows intact so the two can be compared.
    await client.query(
      "DELETE FROM zerodte_trades WHERE symbol = $1 AND session_date = $2 AND code_version = $3",
      [symbol, sessionDate, build.codeVersion]);
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
           exit_reason = EXCLUDED.exit_reason, features = EXCLUDED.features,
           frontier_exit_price = EXCLUDED.frontier_exit_price,
           frontier_pct_return = EXCLUDED.frontier_pct_return,
           frontier_pnl = EXCLUDED.frontier_pnl,
           frontier_exit_reason = EXCLUDED.frontier_exit_reason`,
        [
          tradeId({ symbol, sessionDate, lane: r.lane || "official", direction: r.direction, clock: r.clock, tier: r.tier, codeVersion: build.codeVersion }),
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
            method: r.method, convictionCount: r.convictionCount,
            convictionChecks: r.convictionChecks, moveDistance: r.moveDistance,
            ...(r.featuresExtra || {}),
          }),
          num(t.frontierExitPrice), num(t.frontierPctReturn), num(t.frontierPnl), t.frontierExitReason || null,
          build.deploymentId, build.commitSha, build.codeVersion, build.branch, build.environment,
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

export async function loadTrades({ symbol = "SPY", from, to, lane, countedOnly, codeVersion } = {}) {
  await ensureSchema();
  const where = ["symbol = $1"], params = [symbol];
  if (from) { params.push(from); where.push(`session_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`session_date <= $${params.length}`); }
  if (lane) { params.push(lane); where.push(`lane = $${params.length}`); }
  if (countedOnly) where.push("counted = true");
  if (codeVersion) { params.push(codeVersion); where.push(`code_version = $${params.length}`); }
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

// Rebuild the calendar's compact day summaries from persisted trade rows.
// Pick the production code version with the widest session coverage; a new
// partial rerun must not replace a completed 24-month calendar halfway through.
// Ties go to the most recently written version.
export async function loadSavedCalendarDays({ symbol = "SPY", year, month }) {
  await ensureSchema();
  const versionResult = await pool.query(
    `SELECT code_version, COUNT(DISTINCT session_date)::int AS sessions,
            MAX(created_at) AS latest
     FROM zerodte_trades
     WHERE symbol = $1
       AND (environment = 'production' OR NOT EXISTS (
         SELECT 1 FROM zerodte_trades p WHERE p.symbol = $1 AND p.environment = 'production'
       ))
     GROUP BY code_version
     ORDER BY sessions DESC, latest DESC
     LIMIT 1`, [symbol]);
  const version = versionResult.rows[0];
  if (!version) return { codeVersion: null, sessionsCovered: 0, days: [] };

  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = new Date(Date.UTC(Number(year), Number(month), 1));
  const to = next.toISOString().slice(0, 10);
  // Frontier is derived at read time across every lane so the existing
  // 24-month history lights up without a full resim.
  const { rows } = await pool.query(
    `SELECT session_date, lane, pb_window, entry_price, exit_price, pnl, counted,
            contracts, direction, level_type, tier, points, et_minute, touch_number, level,
            frontier_exit_price, frontier_pnl
     FROM zerodte_trades
     WHERE symbol = $1 AND code_version = $2
       AND session_date >= $3 AND session_date < $4
     ORDER BY session_date, et_minute`,
    [symbol, version.code_version, from, to]);

  // Frontier uses frontier_* exits when present (post v6 re-sim); otherwise
  // falls back to $1k paper on playbook exit prices until the backtest lands.
  return {
    codeVersion: version.code_version,
    sessionsCovered: version.sessions,
    days: calendarDaysFromRows(rows),
  };
}

export function calendarDaysFromRows(rows, { flowByDate = null } = {}) {
  const byDate = new Map();
  const dayFor = (date) => {
    if (!byDate.has(date)) byDate.set(date, {
      date, pnl: 0, excludedPnl: 0, trades: 0, excludedTrades: 0,
      tradePnls: [], tradeDeployeds: [],
      excludedTradePnls: [], excludedTradeDeployeds: [],
      experimentalTradePnls: [], experimentalTradeDeployeds: [],
      shenTradePnls: [], shenTradeDeployeds: [],
      volumeTradePnls: [], volumeTradeDeployeds: [],
      frontierTradePnls: [], frontierTradeDeployeds: [],
      experimentalPnl: 0, experimentalTrades: 0, experimentalWins: 0,
      shenPnl: 0, shenTrades: 0, shenWins: 0,
      volumePnl: 0, volumeTrades: 0, volumeWins: 0,
      frontierPnl: 0, frontierTrades: 0, frontierWins: 0,
      deployed: 0, excludedDeployed: 0, experimentalDeployed: 0, shenDeployed: 0,
      volumeDeployed: 0, frontierDeployed: 0,
      nearMissReasons: [],
      _frontierKeys: new Map(),
    });
    return byDate.get(date);
  };

  for (const row of rows) {
    if (row.entry_price == null || row.pnl == null) continue;
    const day = dayFor(row.session_date);
    const pnl = Number(row.pnl);
    const entryPrice = row.entry_price != null ? Number(row.entry_price) : null;
    const deployed = deployedNotional(entryPrice, row.contracts) ?? 0;
    if (row.lane === "official" && row.counted) {
      day.tradePnls.push(pnl); day.tradeDeployeds.push(deployed);
      day.pnl += pnl; day.deployed += deployed; day.trades++;
    } else if (row.lane === "official" && row.pb_window !== "in") {
      day.excludedTradePnls.push(pnl); day.excludedTradeDeployeds.push(deployed);
      day.excludedPnl += pnl; day.excludedDeployed += deployed; day.excludedTrades++;
    } else if (row.lane === "SHEN_CONVICTION") {
      day.shenTradePnls.push(pnl); day.shenTradeDeployeds.push(deployed);
      day.shenPnl += pnl; day.shenDeployed += deployed; day.shenTrades++;
      if (pnl > 0) day.shenWins++;
    } else if (row.lane === VOLUME_LANE) {
      day.volumeTradePnls.push(pnl); day.volumeTradeDeployeds.push(deployed);
      day.volumePnl += pnl; day.volumeDeployed += deployed; day.volumeTrades++;
      if (pnl > 0) day.volumeWins++;
    } else if (row.lane !== "official") {
      day.experimentalTradePnls.push(pnl); day.experimentalTradeDeployeds.push(deployed);
      day.experimentalPnl += pnl; day.experimentalDeployed += deployed; day.experimentalTrades++;
      if (pnl > 0) day.experimentalWins++;
    }

    const flowImbalance = flowByDate?.get?.(row.session_date) ?? null;
    const etMinute = row.et_minute != null ? Number(row.et_minute) : null;
    const points = row.points != null ? Number(row.points) : null;
    if (passesFrontierV3({
      direction: row.direction,
      levelType: row.level_type,
      tier: row.tier,
      points,
      etMinute,
      entryPrice,
      touchNumber: row.touch_number != null ? Number(row.touch_number) : null,
      flowImbalance,
    })) {
      // Prefer Frontier-specific exit P&L from the re-sim; fall back to $1k on
      // playbook exit until those columns are populated.
      const frontierPnl = row.frontier_pnl != null
        ? Number(row.frontier_pnl)
        : frontierPaperPnl(
          entryPrice,
          row.frontier_exit_price != null ? row.frontier_exit_price : row.exit_price,
        );
      if (frontierPnl == null || Number.isNaN(frontierPnl)) continue;
      const frontierDeployed = frontierDeployedNotional(entryPrice) ?? 0;
      const key = frontierDedupeKey({
        sessionDate: row.session_date,
        etMinute,
        direction: row.direction,
        levelType: row.level_type,
        touchNumber: row.touch_number,
      });
      const rank = frontierLanePriority(row.lane, { counted: !!row.counted });
      const prev = day._frontierKeys.get(key);
      if (!prev || rank < prev.rank) {
        day._frontierKeys.set(key, {
          pnl: frontierPnl, deployed: frontierDeployed, rank, points, etMinute, sessionDate: row.session_date,
        });
      }
    }
  }

  const days = [...byDate.values()].map((day) => {
    const frontierSelected = selectFrontierBestPerDay([...day._frontierKeys.values()]);
    const frontierPnls = frontierSelected.map((x) => x.pnl);
    const frontierDeployeds = frontierSelected.map((x) => x.deployed || 0);
    const { _frontierKeys, ...rest } = day;
    return {
      ...rest,
      frontierTradePnls: frontierPnls,
      frontierTradeDeployeds: frontierDeployeds,
      frontierTrades: frontierPnls.length,
      frontierWins: frontierPnls.filter((p) => p > 0).length,
      frontierPnl: +frontierPnls.reduce((sum, p) => sum + p, 0).toFixed(2),
      frontierDeployed: +frontierDeployeds.reduce((sum, d) => sum + d, 0).toFixed(2),
      pnl: +day.pnl.toFixed(2), excludedPnl: +day.excludedPnl.toFixed(2),
      experimentalPnl: +day.experimentalPnl.toFixed(2), shenPnl: +day.shenPnl.toFixed(2),
      volumePnl: +day.volumePnl.toFixed(2),
      deployed: +day.deployed.toFixed(2),
      excludedDeployed: +day.excludedDeployed.toFixed(2),
      experimentalDeployed: +day.experimentalDeployed.toFixed(2),
      shenDeployed: +day.shenDeployed.toFixed(2),
      volumeDeployed: +day.volumeDeployed.toFixed(2),
      wins: day.tradePnls.filter((pnl) => pnl > 0).length,
    };
  });
  return days;
}

/**
 * Upsert VOLUME lane rows onto an existing code_version without wiping other lanes.
 * Used to backfill the volume sleeve onto the widest calendar version.
 */
export async function saveVolumeTrades({
  symbol = "SPY", sessionDate, rows, codeVersion, environment = "production",
} = {}) {
  if (!codeVersion) throw new Error("codeVersion required for volume upsert");
  await ensureSchema();
  const build = (await import("./buildInfo.js")).buildInfo();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM zerodte_trades
       WHERE symbol = $1 AND session_date = $2 AND code_version = $3 AND lane = $4`,
      [symbol, sessionDate, codeVersion, VOLUME_LANE],
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
            symbol, sessionDate, lane: VOLUME_LANE, direction: r.direction,
            clock: r.clock, tier: r.tier || r.scan, codeVersion,
          }),
          symbol, sessionDate, r.ts ? new Date(r.ts) : null, r.clock || null, num(r.etMinute),
          r.window || "research", VOLUME_LANE, r.tier || r.scan || null, r.direction || null,
          r.levelType || null, num(r.level), num(r.touchNumber), null, null, null,
          null, null, null, null,
          t.contract || null, num(t.strike), num(t.entryPrice), num(t.exitPrice),
          t.entryClock || null, t.exitClock || null, num(t.holdMinutes), t.exitReason || null,
          num(t.pctReturn), num(r.contracts), num(r.pnl), false,
          JSON.stringify({
            size: r.size, scan: r.scan, expirationMode: r.expirationMode,
            expiration: r.expiration || t.expiration, dte: r.dte, method: r.method,
            ...(r.featuresExtra || {}),
          }),
          null, null, null, null,
          build.deploymentId, build.commitSha, codeVersion, build.branch, environment,
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
