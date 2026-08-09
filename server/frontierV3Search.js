// FRONTIER v3 SEARCH — find a paper book that beats Frontier v2 on holdout.
// Price-action candidates first; optional QuantData veto when coverage exists.
//
// Run: DATABASE_PUBLIC_URL=... QUANTDATA_API_KEY=... node server/frontierV3Search.js
// Completion: [frontier-v3-search] complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { frontierDedupeKey, frontierLanePriority } from "./zeroDTE.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_VERSION = process.env.FRONTIER_V3_CODE_VERSION || "89d991cddb31";
const HOLDOUT_START = "2026-01-01";
const OUT_DIR = path.join(__dirname, "data", "frontier-v3");
const QD_MAX_DAYS = Number(process.env.FRONTIER_V3_QD_DAYS || 80);

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
    call += Number(v.callSum || 0);
    put += Number(v.putSum || 0);
  }
  const tot = call + put;
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

function isV2(t) {
  if (t.direction === "CALL" && t.level_type === "PDL") return false;
  if (t.tier === "A+" || t.tier === "Extended A+") return false;
  const pts = Number(t.points);
  if (!(pts >= 12 && pts <= 14)) return false;
  if (!(Number(t.et_minute) >= 600)) return false;
  if (!(Number(t.entry_price) >= 0.5)) return false;
  return true;
}

const CANDIDATES = [
  {
    id: "v2_baseline",
    label: "Frontier v2 Option B",
    test: isV2,
  },
  {
    id: "v3_soft_score_11_15_from10",
    label: "toxins + pts 11-15 + from 10:00 + prem>=0.50",
    test: (t) => !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.points) >= 11 && Number(t.points) <= 15
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5,
  },
  {
    id: "v3_no_a_plus_from10_prem050",
    label: "no CALL@PDL/A+ + from 10:00 + prem>=0.50 (no score band)",
    test: (t) => !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5,
  },
  {
    id: "v3_playbook_hours_score_12_14",
    label: "toxins + 12-14 + 9:45-11:15 + prem>=0.50",
    test: (t) => !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.points) >= 12 && Number(t.points) <= 14
      && Number(t.et_minute) >= 585 && Number(t.et_minute) < 675
      && Number(t.entry_price) >= 0.5,
  },
  {
    id: "v3_exclude_shen_v2",
    label: "v2 rules but exclude Shen lane",
    test: (t) => isV2(t) && t.lane !== "SHEN_CONVICTION",
  },
  {
    id: "v3_non_shen_soft",
    label: "non-Shen + toxins + pts>=11 + from10 + prem>=0.50",
    test: (t) => t.lane !== "SHEN_CONVICTION"
      && !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.points) >= 11
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5,
  },
  {
    id: "v3_put_bias_v2_or_put",
    label: "v2 OR (PUT + pts>=11 + from10 + prem>=0.50 + !A+)",
    test: (t) => isV2(t) || (
      t.direction === "PUT"
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.points) >= 11
      && Number(t.et_minute) >= 600
      && Number(t.entry_price) >= 0.5
    ),
  },
  {
    id: "v3_first_touch_from10_score_ge12",
    label: "touch1 + pts>=12 + from10 + toxins + prem>=0.50",
    test: (t) => Number(t.touch_number) === 1
      && !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.points) >= 12
      && Number(t.et_minute) >= 600
      && Number(t.entry_price) >= 0.5,
  },
  {
    id: "v3_rsi_extreme_pocket",
    label: "toxins + from10 + prem>=0.50 + ((PUT rsi>=76) or (CALL rsi<=25) or v2)",
    test: (t) => {
      if (t.direction === "CALL" && t.level_type === "PDL") return false;
      if (t.tier === "A+" || t.tier === "Extended A+") return false;
      if (!(Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5)) return false;
      if (isV2(t)) return true;
      const rsi = Number(t.rsi);
      if (t.direction === "PUT" && rsi >= 76) return true;
      if (t.direction === "CALL" && rsi <= 25) return true;
      return false;
    },
  },
  {
    id: "v3_one_trade_per_day_best_v2ish",
    label: "among day candidates (toxins+from10+prem), keep highest points then earliest",
    // special handled below
    special: "best_per_day",
    prefilter: (t) => !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5
      && Number(t.points) >= 11,
  },
  {
    id: "v3_wide_cap1_pts_ge11",
    label: "wide toxins+from10+prem+pts>=11, cap 1 trade/day (first by time)",
    special: "first_per_day",
    prefilter: (t) => !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5
      && Number(t.points) >= 11,
  },
  {
    id: "v3_wide_cap1_any_sim_from10",
    label: "any sim from10 + toxins + prem, cap 1/day first",
    special: "first_per_day",
    prefilter: (t) => !(t.direction === "CALL" && t.level_type === "PDL")
      && t.tier !== "A+" && t.tier !== "Extended A+"
      && Number(t.et_minute) >= 600 && Number(t.entry_price) >= 0.5,
  },
];

function applyCandidate(all, cand) {
  if (cand.special === "first_per_day") {
    const pool = all.filter(cand.prefilter).sort((a, b) => {
      if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
      return Number(a.et_minute) - Number(b.et_minute);
    });
    const seen = new Set();
    const out = [];
    for (const t of pool) {
      if (seen.has(t.session_date)) continue;
      seen.add(t.session_date);
      out.push(t);
    }
    return out;
  }
  if (cand.special === "best_per_day") {
    const pool = all.filter(cand.prefilter);
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
  return all.filter(cand.test);
}

function beats(challenger, baseline, sessionCount) {
  // Primary: higher holdout PnL. Secondary: day coverage toward 75% without
  // destroying PnL. Reject if holdout PnL worse or day-win collapses hard.
  if (challenger.holdout.pnl <= baseline.holdout.pnl) return false;
  if (challenger.holdout.trades < 20) return false;
  if (challenger.holdout.dayWinPct + 5 < baseline.holdout.dayWinPct && challenger.holdout.pnl < baseline.holdout.pnl * 1.25) {
    return false;
  }
  return true;
}

async function loadQdForDays(dates) {
  const out = new Map();
  const csEp = ep("contract_statistics");
  const flowEp = ep("net_flow");
  for (const date of dates) {
    const cs = await fetchEndpointCached(csEp, { ticker: "SPY", sessionDate: date });
    const flow = await fetchEndpointCached(flowEp, { ticker: "SPY", sessionDate: date });
    const csData = cs.ok ? (cs.data?.data || cs.data) : null;
    const flowData = flow.ok ? (flow.data?.data || flow.data) : null;
    out.set(date, {
      ok: !!(cs.ok || flow.ok),
      csImb: cs.ok ? callPutImbalance(csData) : null,
      flow0_30: flow.ok ? flowWindowImb(flowData, 0, 30) : null,
      flow30_60: flow.ok ? flowWindowImb(flowData, 30, 60) : null,
      flow0_90: flow.ok ? flowWindowImb(flowData, 0, 90) : null,
    });
  }
  return out;
}

function withQdVeto(trades, qdByDay, vetoFn) {
  return trades.filter((t) => {
    const qd = qdByDay.get(t.session_date);
    if (!qd || !qd.ok) return true; // no QD coverage → keep (don't shrink sample blindly)
    return !vetoFn(t, qd);
  });
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
  console.log(`[frontier-v3-search] loaded ${rows.length} rows → ${all.length} deduped · sessions=${sessionCount}`);

  const split = (trades) => ({
    train: trades.filter((t) => t.session_date < HOLDOUT_START),
    holdout: trades.filter((t) => t.session_date >= HOLDOUT_START),
    all: trades,
  });

  const results = [];
  for (const cand of CANDIDATES) {
    const picked = applyCandidate(all, cand);
    const parts = split(picked);
    const row = {
      id: cand.id,
      label: cand.label,
      train: scoreBook(parts.train),
      holdout: scoreBook(parts.holdout),
      full: scoreBook(parts.all),
      dayCoveragePct: +(100 * scoreBook(parts.all).days / sessionCount).toFixed(1),
    };
    results.push(row);
    console.log(`[frontier-v3-search] ${cand.id} fullPnl=${row.full.pnl} holdoutPnl=${row.holdout.pnl} days=${row.full.days} cov=${row.dayCoveragePct}% dayWR=${row.full.dayWinPct}`);
  }

  const baseline = results.find((r) => r.id === "v2_baseline");
  let winners = results.filter((r) => r.id !== "v2_baseline" && beats(r, baseline, sessionCount));
  winners.sort((a, b) => b.holdout.pnl - a.holdout.pnl || b.full.pnl - a.full.pnl);

  // QuantData veto layer on top of best high-coverage PA candidates + v2.
  let qdResults = [];
  if (process.env.QUANTDATA_API_KEY) {
    const focusIds = ["v2_baseline", "v3_soft_score_11_15_from10", "v3_wide_cap1_pts_ge11", "v3_non_shen_soft", "v3_rsi_extreme_pocket"];
    const focusTrades = new Map(focusIds.map((id) => {
      const cand = CANDIDATES.find((c) => c.id === id);
      return [id, applyCandidate(all, cand)];
    }));
    const datesNeeded = new Set();
    for (const trades of focusTrades.values()) {
      for (const t of trades) {
        if (t.session_date >= "2025-01-01") datesNeeded.add(t.session_date);
      }
    }
    const dates = [...datesNeeded].sort().slice(-QD_MAX_DAYS);
    console.log(`[frontier-v3-search] fetching QuantData for ${dates.length} recent days`);
    const qdByDay = await loadQdForDays(dates);

    const vetos = [
      {
        id: "veto_flow_oppose_first30",
        label: "skip if early flow (0-30) opposes trade direction by >0.15",
        fn: (t, qd) => {
          if (qd.flow0_30 == null) return false;
          if (t.direction === "CALL" && qd.flow0_30 < -0.15) return true;
          if (t.direction === "PUT" && qd.flow0_30 > 0.15) return true;
          return false;
        },
      },
      {
        id: "veto_cs_oppose_020",
        label: "skip if session CS imbalance opposes direction by >0.20",
        fn: (t, qd) => {
          if (qd.csImb == null) return false;
          if (t.direction === "CALL" && qd.csImb < -0.20) return true;
          if (t.direction === "PUT" && qd.csImb > 0.20) return true;
          return false;
        },
      },
      {
        id: "veto_flow30_60_oppose",
        label: "skip if flow 30-60 opposes direction by >0.12",
        fn: (t, qd) => {
          if (qd.flow30_60 == null) return false;
          if (t.direction === "CALL" && qd.flow30_60 < -0.12) return true;
          if (t.direction === "PUT" && qd.flow30_60 > 0.12) return true;
          return false;
        },
      },
      {
        id: "keep_flow_agree_or_missing",
        label: "require early flow agree (>0.05) when QD present",
        fn: (t, qd) => {
          // veto = fail agreement
          if (qd.flow0_30 == null) return false;
          if (t.direction === "CALL") return !(qd.flow0_30 > 0.05);
          if (t.direction === "PUT") return !(qd.flow0_30 < -0.05);
          return false;
        },
      },
    ];

    for (const baseId of focusIds) {
      const baseTrades = focusTrades.get(baseId);
      for (const veto of vetos) {
        const filtered = withQdVeto(baseTrades, qdByDay, veto.fn);
        const parts = split(filtered);
        const row = {
          id: `${baseId}__${veto.id}`,
          label: `${baseId} + ${veto.label}`,
          train: scoreBook(parts.train),
          holdout: scoreBook(parts.holdout),
          full: scoreBook(parts.all),
          dayCoveragePct: +(100 * scoreBook(parts.all).days / sessionCount).toFixed(1),
          qdVeto: veto.id,
          baseId,
        };
        qdResults.push(row);
      }
    }
    qdResults.sort((a, b) => b.holdout.pnl - a.holdout.pnl);
    const qdWinners = qdResults.filter((r) => beats(r, baseline, sessionCount));
    console.log(`[frontier-v3-search] QD combos beating v2 holdout: ${qdWinners.length}`);
    winners = [...winners, ...qdWinners].sort((a, b) => b.holdout.pnl - a.holdout.pnl || b.full.pnl - a.full.pnl);
  } else {
    console.log("[frontier-v3-search] QUANTDATA_API_KEY missing — PA-only search");
  }

  // Prefer winner with best holdout PnL; if tie, higher coverage.
  const champion = winners[0] || null;
  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    holdoutStart: HOLDOUT_START,
    sessionCount,
    baseline,
    priceActionResults: results,
    qdTop: qdResults.slice(0, 15),
    winners: winners.slice(0, 10),
    champion,
    decision: champion
      ? `PROMOTE ${champion.id}: holdout PnL ${champion.holdout.pnl} vs v2 ${baseline.holdout.pnl}; full ${champion.full.pnl} vs ${baseline.full.pnl}; coverage ${champion.dayCoveragePct}%`
      : "NO_PROMOTION: no candidate beat v2 holdout PnL with adequate sample",
  };

  const outPath = path.join(OUT_DIR, `search-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-v3-search] champion: ${champion ? champion.id : "none"}`);
  console.log(`[frontier-v3-search] decision: ${report.decision}`);
  console.log(`[frontier-v3-search] wrote ${outPath}`);
  console.log("[frontier-v3-search] complete");
}

main().catch((err) => {
  console.error("[frontier-v3-search] FAILED:", err);
  process.exit(1);
});
