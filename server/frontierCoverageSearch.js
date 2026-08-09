// FRONTIER COVERAGE SEARCH — chase ~75% session-day coverage without
// destroying EV. Baselines against live Frontier v3.1.
//
// Strategies under test:
//   - wide PA nets + 1 trade/day
//   - day-level QuantData gates (only fire on clear early flow days)
//   - direction alignment with early flow
//
// Run: FRONTIER_V3_QD_DAYS=220 node server/frontierCoverageSearch.js
// Completion: [frontier-coverage] complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { frontierDedupeKey, frontierLanePriority } from "./zeroDTE.js";
import {
  FRONTIER_V3_FLOW_VETO, frontierV3FlowVeto, isFrontierV3Fire,
  netFlowEarlyImbalance,
} from "./frontierV3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_VERSION = process.env.FRONTIER_V3_CODE_VERSION || "89d991cddb31";
const HOLDOUT_START = "2026-01-01";
const OUT_DIR = path.join(__dirname, "data", "frontier-v3");
const QD_MAX_DAYS = Number(process.env.FRONTIER_V3_QD_DAYS || 220);

function dbUrl() {
  return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}
function ep(id) {
  return QD_ENDPOINTS.find((e) => e.id === id);
}

function scoreBook(trades) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.session_date)) byDay.set(t.session_date, []);
    byDay.get(t.session_date).push(t.pnl);
  }
  const days = [...byDay.entries()].map(([date, pnls]) => ({
    date, pnl: pnls.reduce((s, x) => s + x, 0), trades: pnls.length,
  }));
  const winDays = days.filter((d) => d.pnl > 0).length;
  const loseDays = days.filter((d) => d.pnl < 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  return {
    trades: trades.length,
    days: days.length,
    winDays,
    loseDays,
    dayWinPct: days.length ? +(100 * winDays / days.length).toFixed(1) : 0,
    tradeWinPct: trades.length ? +(100 * wins / trades.length).toFixed(1) : 0,
    pnl: +pnl.toFixed(2),
    avgWinDay: winDays ? +(days.filter((d) => d.pnl > 0).reduce((s, d) => s + d.pnl, 0) / winDays).toFixed(2) : 0,
    avgLoseDay: loseDays ? +(days.filter((d) => d.pnl < 0).reduce((s, d) => s + d.pnl, 0) / loseDays).toFixed(2) : 0,
  };
}

function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = frontierDedupeKey({
      sessionDate: row.session_date,
      etMinute: row.et_minute,
      direction: row.direction,
      levelType: row.level_type,
      touchNumber: row.touch_number,
    });
    const rank = frontierLanePriority(row.lane, { counted: !!row.counted });
    const prev = map.get(key);
    if (!prev || rank < prev.rank) map.set(key, { ...row, rank, pnl: Number(row.pnl) });
  }
  return [...map.values()];
}

function toxins(t) {
  return (t.direction === "CALL" && t.level_type === "PDL")
    || t.tier === "A+" || t.tier === "Extended A+";
}

function firstPerDay(pool, directionFilter = null) {
  const sorted = [...pool].sort((a, b) => {
    if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
    return Number(a.et_minute) - Number(b.et_minute);
  });
  const seen = new Set();
  const out = [];
  for (const t of sorted) {
    if (directionFilter && t.direction !== directionFilter(t)) continue;
    if (seen.has(t.session_date)) continue;
    seen.add(t.session_date);
    out.push(t);
  }
  return out;
}

function bestPointsPerDay(pool) {
  const byDay = new Map();
  for (const t of pool) {
    const prev = byDay.get(t.session_date);
    if (!prev
      || Number(t.points) > Number(prev.points)
      || (Number(t.points) === Number(prev.points) && Number(t.et_minute) < Number(prev.et_minute))) {
      byDay.set(t.session_date, t);
    }
  }
  return [...byDay.values()];
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return out;
}

async function loadQd(dates) {
  const flowEp = ep("net_flow");
  const csEp = ep("contract_statistics");
  const rows = await mapPool(dates, 4, async (date) => {
    const [flow, cs] = await Promise.all([
      fetchEndpointCached(flowEp, { ticker: "SPY", sessionDate: date }),
      fetchEndpointCached(csEp, { ticker: "SPY", sessionDate: date }),
    ]);
    const flowData = flow.ok ? (flow.data?.data || flow.data) : null;
    const csData = cs.ok ? (cs.data?.data || cs.data) : null;
    let csImb = null;
    if (cs.ok) {
      const call = Number(csData?.CALL?.premium ?? csData?.call?.premium ?? 0);
      const put = Number(csData?.PUT?.premium ?? csData?.put?.premium ?? 0);
      const tot = call + put;
      csImb = tot > 0 ? (call - put) / tot : null;
    }
    return [date, {
      ok: !!(flow.ok || cs.ok),
      flow0_30: flow.ok ? netFlowEarlyImbalance(flowData, 30) : null,
      csImb,
    }];
  });
  return new Map(rows);
}

function flowDir(imb, thr = 0.05) {
  if (imb == null || !Number.isFinite(imb)) return null;
  if (imb > thr) return "CALL";
  if (imb < -thr) return "PUT";
  return null;
}

function summarize(picked, sessionCount, split) {
  const parts = split(picked);
  return {
    train: scoreBook(parts.train),
    holdout: scoreBook(parts.holdout),
    full: scoreBook(parts.all),
    dayCoveragePct: +(100 * scoreBook(parts.all).days / sessionCount).toFixed(1),
  };
}

async function main() {
  const url = dbUrl();
  if (!url) throw new Error("missing DATABASE_URL");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, tier, points, rsi,
            et_minute, entry_price, pnl, touch_number
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL`,
    [CODE_VERSION],
  );
  const { rows: sessRows } = await client.query(
    `SELECT COUNT(DISTINCT session_date)::int AS n FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1`,
    [CODE_VERSION],
  );
  await client.end();

  const sessionCount = sessRows[0].n;
  const all = dedupeRows(rows);
  const allSessionDates = [...new Set(rows.map((r) => r.session_date))];
  console.log(`[frontier-coverage] loaded ${rows.length} → ${all.length} deduped · sessions=${sessionCount}`);

  const split = (trades) => ({
    train: trades.filter((t) => t.session_date < HOLDOUT_START),
    holdout: trades.filter((t) => t.session_date >= HOLDOUT_START),
    all: trades,
  });

  const dates = [...new Set(all.map((t) => t.session_date))]
    .filter((d) => d >= "2025-01-01")
    .sort()
    .slice(-QD_MAX_DAYS);
  console.log(`[frontier-coverage] fetching QD for ${dates.length} days`);
  const qd = process.env.QUANTDATA_API_KEY ? await loadQd(dates) : new Map();

  const liveV31 = all.filter((t) => {
    if (!isFrontierV3Fire({
      direction: t.direction, levelType: t.level_type, tier: t.tier,
      points: t.points, etMinute: t.et_minute, entryPrice: t.entry_price,
      touchNumber: t.touch_number,
    })) return false;
    const imb = qd.get(t.session_date)?.flow0_30 ?? null;
    return !frontierV3FlowVeto(t.direction, imb, FRONTIER_V3_FLOW_VETO);
  });
  const baseline = {
    id: "live_v3_1",
    label: "live Frontier v3.1",
    ...summarize(liveV31, sessionCount, split),
  };
  console.log(`[frontier-coverage] baseline holdout=${baseline.holdout.pnl} full=${baseline.full.pnl} cov=${baseline.dayCoveragePct}%`);

  const pools = {
    any_from945: all.filter((t) => !toxins(t) && Number(t.et_minute) >= 585 && Number(t.entry_price) >= 0.5),
    any_from10: all.filter((t) => !toxins(t) && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5),
    pts_ge10_from10: all.filter((t) => !toxins(t) && Number(t.points) >= 10 && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5),
    pts_ge11_from10: all.filter((t) => !toxins(t) && Number(t.points) >= 11 && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5),
    touch1_from10: all.filter((t) => !toxins(t) && Number(t.touch_number) === 1 && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5),
    live_pa: all.filter((t) => isFrontierV3Fire({
      direction: t.direction, levelType: t.level_type, tier: t.tier,
      points: t.points, etMinute: t.et_minute, entryPrice: t.entry_price,
      touchNumber: t.touch_number,
    })),
  };

  const results = [];

  // 1) Cap-1 variants without QD
  for (const [name, pool] of Object.entries(pools)) {
    for (const [capName, picker] of [
      ["cap1_first", firstPerDay],
      ["cap1_best", bestPointsPerDay],
    ]) {
      const picked = picker(pool);
      results.push({
        id: `${name}__${capName}`,
        label: `${name} ${capName}`,
        ...summarize(picked, sessionCount, split),
        family: "pa_cap",
      });
    }
  }

  // 2) Day-level flow gates: only take first trade when |flow| >= thr
  for (const thr of [0.05, 0.10, 0.15, 0.20, 0.25]) {
    for (const [name, pool] of Object.entries(pools)) {
      const gated = firstPerDay(pool.filter((t) => {
        const imb = qd.get(t.session_date)?.flow0_30;
        return imb != null && Math.abs(imb) >= thr;
      }));
      results.push({
        id: `${name}__dayflow_abs_${String(thr).replace(".", "")}_cap1`,
        label: `${name} only days |flow|>=${thr}, cap1`,
        ...summarize(gated, sessionCount, split),
        family: "day_gate",
        thr,
      });
    }
  }

  // 3) Align trade direction with early flow, cap1
  for (const thr of [0.05, 0.10, 0.15]) {
    for (const [name, pool] of Object.entries(pools)) {
      const aligned = firstPerDay(pool, (t) => flowDir(qd.get(t.session_date)?.flow0_30, thr));
      // firstPerDay with directionFilter: need custom
      const sorted = [...pool].sort((a, b) => {
        if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
        return Number(a.et_minute) - Number(b.et_minute);
      });
      const seen = new Set();
      const out = [];
      for (const t of sorted) {
        const want = flowDir(qd.get(t.session_date)?.flow0_30, thr);
        if (!want || t.direction !== want) continue;
        if (seen.has(t.session_date)) continue;
        seen.add(t.session_date);
        out.push(t);
      }
      results.push({
        id: `${name}__align_flow_${String(thr).replace(".", "")}_cap1`,
        label: `${name} direction aligns flow>${thr}, cap1`,
        ...summarize(out, sessionCount, split),
        family: "align",
        thr,
      });
      void aligned;
    }
  }

  // 4) Live v3.1 OR (wide align-flow on days without a v3.1 fire)
  const v31Days = new Set(liveV31.map((t) => t.session_date));
  for (const thr of [0.10, 0.15]) {
    const fillerPool = pools.any_from10;
    const sorted = [...fillerPool].sort((a, b) => {
      if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
      return Number(a.et_minute) - Number(b.et_minute);
    });
    const seen = new Set(v31Days);
    const extra = [];
    for (const t of sorted) {
      if (seen.has(t.session_date)) continue;
      const want = flowDir(qd.get(t.session_date)?.flow0_30, thr);
      if (!want || t.direction !== want) continue;
      seen.add(t.session_date);
      extra.push(t);
    }
    const combined = [...liveV31, ...extra];
    results.push({
      id: `v31_plus_align_fill_${String(thr).replace(".", "")}`,
      label: `live v3.1 + fill empty days with flow-aligned any_from10`,
      ...summarize(combined, sessionCount, split),
      family: "hybrid",
      thr,
      extraDays: extra.length,
    });
  }

  // Rank: positive holdout + full, prefer higher coverage, then holdout pnl
  const profitableCoverage = results
    .filter((r) => r.holdout.pnl > 0 && r.full.pnl > 0 && r.dayCoveragePct >= 45)
    .sort((a, b) => b.dayCoveragePct - a.dayCoveragePct
      || b.holdout.pnl - a.holdout.pnl);

  const beatLive = results
    .filter((r) => r.holdout.pnl > baseline.holdout.pnl
      && r.holdout.trades >= 18
      && r.dayCoveragePct >= baseline.dayCoveragePct)
    .sort((a, b) => b.holdout.pnl - a.holdout.pnl || b.dayCoveragePct - a.dayCoveragePct);

  const topByHoldout = [...results].sort((a, b) => b.holdout.pnl - a.holdout.pnl).slice(0, 20);

  // Ceiling: any simulated trade days
  const anyTradeDays = new Set(all.map((t) => t.session_date)).size;
  const ceiling = {
    anySimTradeDayCoveragePct: +(100 * anyTradeDays / sessionCount).toFixed(1),
    sessions: sessionCount,
    anySimTradeDays: anyTradeDays,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    holdoutStart: HOLDOUT_START,
    sessionCount,
    qdDaysFetched: dates.length,
    ceiling,
    baseline,
    profitableCoverage: profitableCoverage.slice(0, 20),
    beatLiveWithMoreCoverage: beatLive.slice(0, 15),
    topByHoldout,
    decision: beatLive[0]
      ? `COVERAGE_PROMOTE ${beatLive[0].id}: holdout ${beatLive[0].holdout.pnl} vs ${baseline.holdout.pnl}; cov ${beatLive[0].dayCoveragePct}% vs ${baseline.dayCoveragePct}%`
      : profitableCoverage[0]
        ? `COVERAGE_CANDIDATE ${profitableCoverage[0].id}: cov ${profitableCoverage[0].dayCoveragePct}% holdout ${profitableCoverage[0].holdout.pnl} (does not beat live holdout)`
        : "NO_COVERAGE_WINNER: no profitable >=45% coverage book found",
  };

  const outPath = path.join(OUT_DIR, `coverage-search-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "coverage-search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-coverage] ceiling any-sim-day ${ceiling.anySimTradeDayCoveragePct}%`);
  console.log(`[frontier-coverage] profitable>=45% cov: ${profitableCoverage.length}`);
  console.log(`[frontier-coverage] beat-live+more-cov: ${beatLive.length}`);
  console.log(`[frontier-coverage] decision: ${report.decision}`);
  if (profitableCoverage[0]) {
    const c = profitableCoverage[0];
    console.log(`[frontier-coverage] top cov+profit: ${c.id} cov=${c.dayCoveragePct}% holdout=${c.holdout.pnl} full=${c.full.pnl}`);
  }
  if (beatLive[0]) {
    const c = beatLive[0];
    console.log(`[frontier-coverage] top beat-live: ${c.id} cov=${c.dayCoveragePct}% holdout=${c.holdout.pnl}`);
  }
  console.log(`[frontier-coverage] wrote ${outPath}`);
  console.log("[frontier-coverage] complete");
}

main().catch((err) => {
  console.error("[frontier-coverage] FAILED:", err);
  process.exit(1);
});
