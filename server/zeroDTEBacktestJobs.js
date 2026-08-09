// DURABLE 0DTE BACKTEST JOBS — the browser starts work, PostgreSQL owns it.
//
// Each completed month is a checkpoint. A Railway restart, browser close, or
// brief network failure therefore loses at most the month currently running.
// A database lease prevents overlapping Railway deployments from processing
// the same job at the same time. The periodic sweep is intentionally stateless:
// it asks PostgreSQL what needs work instead of trusting an in-memory queue.

import crypto from "node:crypto";
import { pool, ensureSchema } from "./db.js";
import { buildInfo } from "./buildInfo.js";
import { simulateMonth } from "./zeroDTECalendar.js";

const LEASE_MINUTES = 30;
const SWEEP_MS = 60_000;
let sweepTimer = null;

export function monthRange({ endYear, endMonth, months }) {
  const count = Math.max(1, Math.min(60, Number(months) || 24));
  const result = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const d = new Date(Date.UTC(Number(endYear), Number(endMonth) - 1 - offset, 1));
    result.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return result;
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    months: row.months,
    status: row.status,
    totalMonths: row.total_months,
    completedMonths: row.completed_months,
    current: row.current_year && row.current_month
      ? { year: row.current_year, month: row.current_month }
      : null,
    start: { year: row.start_year, month: row.start_month },
    end: { year: row.end_year, month: row.end_month },
    error: row.error,
    codeVersion: row.code_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function getBacktestJob(id) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT * FROM zerodte_backtest_jobs WHERE id = $1", [id]);
  return publicJob(rows[0]);
}

export async function getLatestBacktestJob({ symbol = "SPY", months = 24 } = {}) {
  await ensureSchema();
  const build = buildInfo();
  const { rows } = await pool.query(
    `SELECT * FROM zerodte_backtest_jobs
     WHERE symbol = $1 AND months = $2 AND code_version = $3
     ORDER BY created_at DESC LIMIT 1`,
    [symbol, Number(months), build.codeVersion],
  );
  return publicJob(rows[0]);
}

export async function createBacktestJob({ symbol = "SPY", months = 24 } = {}) {
  await ensureSchema();
  const build = buildInfo();
  const now = new Date();
  const endYear = now.getUTCFullYear(), endMonth = now.getUTCMonth() + 1;
  const range = monthRange({ endYear, endMonth, months });
  const first = range[0], last = range[range.length - 1];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize starts for this symbol/version so a double-click cannot create
    // two workers before either request sees the other's row.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`0dte:${symbol}:${build.codeVersion}`]);
    const { rows } = await client.query(
      `SELECT * FROM zerodte_backtest_jobs
       WHERE symbol = $1 AND months = $2 AND code_version = $3
         AND end_year = $4 AND end_month = $5
       ORDER BY created_at DESC LIMIT 1`,
      [symbol, range.length, build.codeVersion, last.year, last.month],
    );
    let row = rows[0];
    if (row?.status === "failed") {
      ({ rows: [row] } = await client.query(
        `UPDATE zerodte_backtest_jobs SET status = 'queued', error = NULL,
           worker_id = NULL, lease_until = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`, [row.id]));
    } else if (!row) {
      ({ rows: [row] } = await client.query(
        `INSERT INTO zerodte_backtest_jobs
          (id, symbol, months, start_year, start_month, end_year, end_month,
           status, total_months, completed_months, code_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$3,0,$8) RETURNING *`,
        [crypto.randomUUID(), symbol, range.length, first.year, first.month,
          last.year, last.month, build.codeVersion]));
    }
    await client.query("COMMIT");
    queueMicrotask(() => sweepBacktestJobs().catch((err) =>
      console.error("[0dte:backfill] start sweep failed:", err.message)));
    return publicJob(row);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function claimJob(workerId, codeVersion) {
  const { rows } = await pool.query(
    `UPDATE zerodte_backtest_jobs SET
       status = 'running', worker_id = $1,
       lease_until = now() + ($2 * interval '1 minute'),
       started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = (
       SELECT id FROM zerodte_backtest_jobs
       WHERE code_version = $3 AND (
         status = 'queued'
         OR (status = 'running' AND (lease_until IS NULL OR lease_until < now()))
       )
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [workerId, LEASE_MINUTES, codeVersion],
  );
  return rows[0];
}

async function runClaimedJob(row, workerId) {
  const range = monthRange({ endYear: row.end_year, endMonth: row.end_month, months: row.total_months });
  try {
    for (let i = row.completed_months; i < range.length; i++) {
      const current = range[i];
      const renewed = await pool.query(
        `UPDATE zerodte_backtest_jobs SET current_year = $1, current_month = $2,
           lease_until = now() + ($3 * interval '1 minute'), updated_at = now()
         WHERE id = $4 AND worker_id = $5 RETURNING id`,
        [current.year, current.month, LEASE_MINUTES, row.id, workerId],
      );
      if (!renewed.rowCount) return; // another worker owns the lease now

      console.log(`[0dte:backfill] ${row.id} month ${i + 1}/${range.length}: ${current.year}-${String(current.month).padStart(2, "0")}`);
      await simulateMonth({ symbol: row.symbol, year: current.year, month: current.month });
      await pool.query(
        `UPDATE zerodte_backtest_jobs SET completed_months = $1,
           lease_until = now() + ($2 * interval '1 minute'), updated_at = now()
         WHERE id = $3 AND worker_id = $4`,
        [i + 1, LEASE_MINUTES, row.id, workerId],
      );
    }
    await pool.query(
      `UPDATE zerodte_backtest_jobs SET status = 'complete', current_year = NULL,
         current_month = NULL, worker_id = NULL, lease_until = NULL,
         completed_at = now(), updated_at = now()
       WHERE id = $1 AND worker_id = $2`, [row.id, workerId]);
    console.log(`[0dte:backfill] ${row.id} complete: ${range.length} months saved`);
  } catch (err) {
    await pool.query(
      `UPDATE zerodte_backtest_jobs SET status = 'failed', error = $1,
         worker_id = NULL, lease_until = NULL, updated_at = now()
       WHERE id = $2 AND worker_id = $3`, [err.message || String(err), row.id, workerId]);
    console.error(`[0dte:backfill] ${row.id} failed after ${row.completed_months}/${range.length} months:`, err.message);
  }
}

export async function sweepBacktestJobs() {
  await ensureSchema();
  const build = buildInfo();
  const workerId = `${build.deploymentId}:${crypto.randomUUID()}`;
  const row = await claimJob(workerId, build.codeVersion);
  if (row) await runClaimedJob(row, workerId);
}

export function startBacktestJobWorker() {
  if (sweepTimer) return;
  // A different commit must never finish an old job: its trade writer stamps
  // the current commit, which would make the job checkpoint and trade rows
  // disagree. Same-commit restarts resume; superseded jobs fail explicitly.
  (async () => {
    await ensureSchema();
    const build = buildInfo();
    const retired = await pool.query(
      `UPDATE zerodte_backtest_jobs SET status = 'failed',
         error = 'Superseded by a new code version; start a new 24-month job.',
         worker_id = NULL, lease_until = NULL, updated_at = now()
       WHERE status IN ('queued', 'running') AND code_version <> $1`,
      [build.codeVersion],
    );
    if (retired.rowCount) console.log(`[0dte:backfill] retired ${retired.rowCount} superseded job(s)`);
    await sweepBacktestJobs();
  })().catch((err) => console.error("[0dte:backfill] startup sweep failed:", err.message));
  sweepTimer = setInterval(() => {
    sweepBacktestJobs().catch((err) => console.error("[0dte:backfill] recovery sweep failed:", err.message));
  }, SWEEP_MS);
  sweepTimer.unref?.();
}
