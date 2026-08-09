// FRONTIER v3+ SEARCH — beat the live Frontier v3 champion on 2026 holdout.
// Explores tighter/looser flow thresholds, dual vetoes, net-drift, and wider
// PA nets with stronger day caps.
//
// Run: FRONTIER_V3_QD_DAYS=220 node server/frontierV3PlusSearch.js
// Completion: [frontier-v3-plus] complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { frontierDedupeKey, frontierLanePriority } from "./zeroDTE.js";
import {
  FRONTIER_V3_FLOW_VETO, FRONTIER_V3_MIN_ENTRY, FRONTIER_V3_MIN_MINUTE,
  FRONTIER_V3_MAX_POINTS, FRONTIER_V3_MIN_POINTS, frontierV3FlowVeto,
  isFrontierV3Fire, netFlowEarlyImbalance,
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

function callPutImbalance(stats) {
  const call = Number(stats?.CALL?.premium ?? stats?.call?.premium ?? 0);
  const put = Number(stats?.PUT?.premium ?? stats?.put?.premium ?? 0);
  const tot = call + put;
  return tot > 0 ? (call - put) / tot : null;
}

function flowWindowImb(flowData, startBucket, endBucket) {
  const entries = Object.entries(flowData || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const slice = entries.slice(startBucket, endBucket);
  let call = 0, put = 0;
  for (const [, v] of slice) {
    call += Number(v.callSum || v.call || 0);
    put += Number(v.putSum || v.put || 0);
  }
  const tot = call + put;
  return tot > 0 ? (call - put) / tot : null;
}

function netDriftSign(driftData) {
  // Best-effort: sum numeric drift-like fields if present.
  if (!driftData || typeof driftData !== "object") return null;
  let call = 0, put = 0, n = 0;
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const x of obj) walk(x); return; }
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (typeof v === "number" && Number.isFinite(v)) {
        if (key.includes("call")) { call += v; n++; }
        else if (key.includes("put")) { put += v; n++; }
      } else if (v && typeof v === "object") walk(v);
    }
  };
  walk(driftData);
  if (!n) return null;
  const tot = Math.abs(call) + Math.abs(put);
  return tot > 0 ? (call - put) / tot : null;
}

function scoreBook(trades) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.session_date)) byDay.set(t.session_date, []);
    byDay.get(t.session_date).push(t.pnl);
  }
  const days = [...byDay.entries()].map(([date, pnls]) => ({
    date,
    pnl: pnls.reduce((s, x) => s + x, 0),
    trades: pnls.length,
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
  if (t.direction === "CALL" && t.level_type === "PDL") return true;
  if (t.tier === "A+" || t.tier === "Extended A+") return true;
  return false;
}

function isLiveV3Pa(t) {
  return isFrontierV3Fire({
    direction: t.direction,
    levelType: t.level_type,
    tier: t.tier,
    points: t.points,
    etMinute: t.et_minute,
    entryPrice: t.entry_price,
  });
}

function firstPerDay(pool) {
  const sorted = [...pool].sort((a, b) => {
    if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
    return Number(a.et_minute) - Number(b.et_minute);
  });
  const seen = new Set();
  const out = [];
  for (const t of sorted) {
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

const PA_CANDIDATES = [
  {
    id: "live_v3_pa",
    label: "live Frontier v3 PA gates (11-15)",
    pick: (all) => all.filter(isLiveV3Pa),
  },
  {
    id: "v3_soft_11_14",
    label: "toxins + 11-14 + from10 + prem",
    pick: (all) => all.filter((t) => !toxins(t)
      && Number(t.points) >= 11 && Number(t.points) <= 14
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5),
  },
  {
    id: "v3_soft_12_15",
    label: "toxins + 12-15 + from10 + prem",
    pick: (all) => all.filter((t) => !toxins(t)
      && Number(t.points) >= 12 && Number(t.points) <= 15
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5),
  },
  {
    id: "v3_soft_11_15_no_shen",
    label: "live PA excluding Shen",
    pick: (all) => all.filter((t) => isLiveV3Pa(t) && t.lane !== "SHEN_CONVICTION"),
  },
  {
    id: "v3_soft_11_15_touch1",
    label: "live PA + first touch only",
    pick: (all) => all.filter((t) => isLiveV3Pa(t) && Number(t.touch_number) === 1),
  },
  {
    id: "v3_soft_11_15_cap1_first",
    label: "live PA capped 1/day (first)",
    pick: (all) => firstPerDay(all.filter(isLiveV3Pa)),
  },
  {
    id: "v3_soft_11_15_cap1_best",
    label: "live PA capped 1/day (best points)",
    pick: (all) => bestPointsPerDay(all.filter(isLiveV3Pa)),
  },
  {
    id: "v3_wide_ge11_cap1",
    label: "toxins+from10+prem+pts>=11 cap1 first",
    pick: (all) => firstPerDay(all.filter((t) => !toxins(t)
      && Number(t.points) >= 11
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5)),
  },
  {
    id: "v3_wide_ge10_cap1",
    label: "toxins+from10+prem+pts>=10 cap1 first",
    pick: (all) => firstPerDay(all.filter((t) => !toxins(t)
      && Number(t.points) >= 10
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5)),
  },
  {
    id: "v3_any_sim_cap1_from945",
    label: "any sim toxins+prem from 9:45 cap1 first",
    pick: (all) => firstPerDay(all.filter((t) => !toxins(t)
      && Number(t.et_minute) >= 585 && Number(t.entry_price) >= 0.5)),
  },
  {
    id: "v3_put_only_soft",
    label: "PUT-only live PA band",
    pick: (all) => all.filter((t) => isLiveV3Pa(t) && t.direction === "PUT"),
  },
  {
    id: "v3_soft_11_15_prem075",
    label: "live PA but prem>=0.75",
    pick: (all) => all.filter((t) => isLiveV3Pa(t) && Number(t.entry_price) >= 0.75),
  },
];

function opposeVeto(direction, imb, thr) {
  if (imb == null || !Number.isFinite(imb)) return false;
  if (direction === "CALL" && imb < -thr) return true;
  if (direction === "PUT" && imb > thr) return true;
  return false;
}

function agreeRequired(direction, imb, thr) {
  // return true when should VETO (fail agreement)
  if (imb == null || !Number.isFinite(imb)) return false;
  if (direction === "CALL") return !(imb > thr);
  if (direction === "PUT") return !(imb < -thr);
  return false;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function loadQdForDays(dates) {
  const flowEp = ep("net_flow");
  const csEp = ep("contract_statistics");
  const driftEp = ep("net_drift");
  const results = await mapPool(dates, 4, async (date) => {
    const [flow, cs, drift] = await Promise.all([
      fetchEndpointCached(flowEp, { ticker: "SPY", sessionDate: date }),
      fetchEndpointCached(csEp, { ticker: "SPY", sessionDate: date }),
      fetchEndpointCached(driftEp, { ticker: "SPY", sessionDate: date }),
    ]);
    const flowData = flow.ok ? (flow.data?.data || flow.data) : null;
    const csData = cs.ok ? (cs.data?.data || cs.data) : null;
    const driftData = drift.ok ? (drift.data?.data || drift.data) : null;
    return [date, {
      ok: !!(flow.ok || cs.ok || drift.ok),
      flow0_30: flow.ok ? netFlowEarlyImbalance(flowData, 30) : null,
      flow0_20: flow.ok ? flowWindowImb(flowData, 0, 20) : null,
      flow0_45: flow.ok ? flowWindowImb(flowData, 0, 45) : null,
      flow20_50: flow.ok ? flowWindowImb(flowData, 20, 50) : null,
      csImb: cs.ok ? callPutImbalance(csData) : null,
      driftImb: drift.ok ? netDriftSign(driftData) : null,
    }];
  });
  return new Map(results);
}

function withVeto(trades, qdByDay, vetoFn) {
  return trades.filter((t) => {
    const qd = qdByDay.get(t.session_date);
    if (!qd || !qd.ok) return true;
    return !vetoFn(t, qd);
  });
}

function beats(challenger, baseline) {
  if (challenger.holdout.pnl <= baseline.holdout.pnl) return false;
  if (challenger.holdout.trades < 18) return false;
  // Don't accept a collapse in day-win rate unless PnL lifts a lot.
  if (challenger.holdout.dayWinPct + 8 < baseline.holdout.dayWinPct
      && challenger.holdout.pnl < baseline.holdout.pnl * 1.2) {
    return false;
  }
  return true;
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
  console.log(`[frontier-v3-plus] loaded ${rows.length} → ${all.length} deduped · sessions=${sessionCount}`);
  console.log(`[frontier-v3-plus] live constants pts ${FRONTIER_V3_MIN_POINTS}-${FRONTIER_V3_MAX_POINTS} min=${FRONTIER_V3_MIN_MINUTE} prem=${FRONTIER_V3_MIN_ENTRY} veto=${FRONTIER_V3_FLOW_VETO}`);

  const split = (trades) => ({
    train: trades.filter((t) => t.session_date < HOLDOUT_START),
    holdout: trades.filter((t) => t.session_date >= HOLDOUT_START),
    all: trades,
  });

  const paResults = [];
  const pickedById = new Map();
  for (const cand of PA_CANDIDATES) {
    const picked = cand.pick(all);
    pickedById.set(cand.id, picked);
    const parts = split(picked);
    const row = {
      id: cand.id,
      label: cand.label,
      train: scoreBook(parts.train),
      holdout: scoreBook(parts.holdout),
      full: scoreBook(parts.all),
      dayCoveragePct: +(100 * scoreBook(parts.all).days / sessionCount).toFixed(1),
    };
    paResults.push(row);
    console.log(`[frontier-v3-plus] PA ${cand.id} holdout=${row.holdout.pnl} full=${row.full.pnl} cov=${row.dayCoveragePct}%`);
  }

  // QuantData layer
  const focusIds = [
    "live_v3_pa", "v3_soft_11_14", "v3_soft_12_15", "v3_soft_11_15_no_shen",
    "v3_soft_11_15_touch1", "v3_soft_11_15_cap1_best", "v3_wide_ge11_cap1",
    "v3_wide_ge10_cap1", "v3_any_sim_cap1_from945", "v3_soft_11_15_prem075",
  ];
  const datesNeeded = new Set();
  for (const id of focusIds) {
    for (const t of pickedById.get(id) || []) {
      if (t.session_date >= "2025-01-01") datesNeeded.add(t.session_date);
    }
  }
  const dates = [...datesNeeded].sort().slice(-QD_MAX_DAYS);
  console.log(`[frontier-v3-plus] fetching QD for ${dates.length} days`);
  const qdByDay = process.env.QUANTDATA_API_KEY ? await loadQdForDays(dates) : new Map();

  const vetoDefs = [
    {
      id: "live_flow_oppose_015",
      label: "live v3 flow oppose >0.15 first30",
      fn: (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.15),
    },
    {
      id: "flow_oppose_010",
      label: "flow oppose >0.10 first30",
      fn: (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.10),
    },
    {
      id: "flow_oppose_020",
      label: "flow oppose >0.20 first30",
      fn: (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.20),
    },
    {
      id: "flow_oppose_025",
      label: "flow oppose >0.25 first30",
      fn: (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.25),
    },
    {
      id: "flow20_oppose_015",
      label: "flow 0-20 oppose >0.15",
      fn: (t, qd) => opposeVeto(t.direction, qd.flow0_20, 0.15),
    },
    {
      id: "flow45_oppose_015",
      label: "flow 0-45 oppose >0.15",
      fn: (t, qd) => opposeVeto(t.direction, qd.flow0_45, 0.15),
    },
    {
      id: "flow2050_oppose_012",
      label: "flow 20-50 oppose >0.12",
      fn: (t, qd) => opposeVeto(t.direction, qd.flow20_50, 0.12),
    },
    {
      id: "cs_oppose_015",
      label: "CS oppose >0.15",
      fn: (t, qd) => opposeVeto(t.direction, qd.csImb, 0.15),
    },
    {
      id: "cs_oppose_025",
      label: "CS oppose >0.25",
      fn: (t, qd) => opposeVeto(t.direction, qd.csImb, 0.25),
    },
    {
      id: "drift_oppose_010",
      label: "net-drift oppose >0.10",
      fn: (t, qd) => opposeVeto(t.direction, qd.driftImb, 0.10),
    },
    {
      id: "flow_and_cs_oppose",
      label: "veto if flow0.15 OR cs0.20 oppose",
      fn: (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.15)
        || opposeVeto(t.direction, qd.csImb, 0.20),
    },
    {
      id: "flow_and_drift_oppose",
      label: "veto if flow0.15 OR drift0.10 oppose",
      fn: (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.15)
        || opposeVeto(t.direction, qd.driftImb, 0.10),
    },
    {
      id: "require_flow_agree_005",
      label: "require early flow agree >0.05 when present",
      fn: (t, qd) => agreeRequired(t.direction, qd.flow0_30, 0.05),
    },
    {
      id: "require_flow_agree_000",
      label: "require early flow non-oppose (>=0) when present",
      fn: (t, qd) => agreeRequired(t.direction, qd.flow0_30, 0),
    },
  ];

  const comboResults = [];
  for (const baseId of focusIds) {
    const baseTrades = pickedById.get(baseId) || [];
    for (const veto of vetoDefs) {
      const filtered = withVeto(baseTrades, qdByDay, veto.fn);
      const parts = split(filtered);
      comboResults.push({
        id: `${baseId}__${veto.id}`,
        label: `${baseId} + ${veto.label}`,
        train: scoreBook(parts.train),
        holdout: scoreBook(parts.holdout),
        full: scoreBook(parts.all),
        dayCoveragePct: +(100 * scoreBook(parts.all).days / sessionCount).toFixed(1),
        baseId,
        qdVeto: veto.id,
      });
    }
  }

  // Live v3 baseline = PA + live flow veto
  const liveBaselineTrades = withVeto(pickedById.get("live_v3_pa"), qdByDay, (t, qd) => frontierV3FlowVeto(t.direction, qd.flow0_30, 0.15));
  const liveParts = split(liveBaselineTrades);
  const baseline = {
    id: "live_v3",
    label: "live Frontier v3 (PA + flow oppose 0.15)",
    train: scoreBook(liveParts.train),
    holdout: scoreBook(liveParts.holdout),
    full: scoreBook(liveParts.all),
    dayCoveragePct: +(100 * scoreBook(liveParts.all).days / sessionCount).toFixed(1),
  };
  console.log(`[frontier-v3-plus] baseline live_v3 holdout=${baseline.holdout.pnl} full=${baseline.full.pnl} cov=${baseline.dayCoveragePct}%`);

  const winners = comboResults
    .filter((r) => beats(r, baseline))
    .sort((a, b) => b.holdout.pnl - a.holdout.pnl
      || b.full.pnl - a.full.pnl
      || b.dayCoveragePct - a.dayCoveragePct);

  // Also surface high-coverage positive books even if they don't beat live holdout —
  // useful for the ~75% coverage track.
  const coverageTrack = comboResults
    .filter((r) => r.dayCoveragePct >= 50 && r.holdout.pnl > 0 && r.full.pnl > 0)
    .sort((a, b) => b.holdout.pnl - a.holdout.pnl)
    .slice(0, 10);

  const champion = winners[0] || null;
  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    holdoutStart: HOLDOUT_START,
    sessionCount,
    qdDaysFetched: dates.length,
    baseline,
    paResults,
    qdTop: [...comboResults].sort((a, b) => b.holdout.pnl - a.holdout.pnl).slice(0, 25),
    winners: winners.slice(0, 15),
    coverageTrack,
    champion,
    decision: champion
      ? `PROMOTE ${champion.id}: holdout ${champion.holdout.pnl} vs live v3 ${baseline.holdout.pnl}; full ${champion.full.pnl} vs ${baseline.full.pnl}; cov ${champion.dayCoveragePct}%`
      : `NO_PROMOTION: no candidate beat live v3 holdout ${baseline.holdout.pnl}`,
  };

  const outPath = path.join(OUT_DIR, `plus-search-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "plus-search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-v3-plus] winners=${winners.length}`);
  console.log(`[frontier-v3-plus] decision: ${report.decision}`);
  if (coverageTrack[0]) {
    console.log(`[frontier-v3-plus] best >=50% cov holdout+: ${coverageTrack[0].id} holdout=${coverageTrack[0].holdout.pnl} cov=${coverageTrack[0].dayCoveragePct}%`);
  } else {
    console.log("[frontier-v3-plus] no profitable >=50% coverage candidate");
  }
  console.log(`[frontier-v3-plus] wrote ${outPath}`);
  console.log("[frontier-v3-plus] complete");
}

main().catch((err) => {
  console.error("[frontier-v3-plus] FAILED:", err);
  process.exit(1);
});
