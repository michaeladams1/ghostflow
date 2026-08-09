// FRONTIER v3 RESEARCH — wide-net day coverage + QuantData day-gate probe.
//
// Goal: trade ~75% of sessions without replaying the unfiltered −$7.5k book.
// Design hypothesis: keep nearly every day that already has a simulated fire
// (ceiling ~79% on 89d991cddb31), then use QuantData to VETO bad regimes and
// later ADD entries on quiet days. This script does not change the live
// Frontier v2 calendar box.
//
// Run: node --env-file=.env server/frontierV3Research.js
//   or: railway run --service ghostflow -- node server/frontierV3Research.js
//
// Completion marker (grep-able): [frontier-v3] research pass complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { isFrontierFire, frontierDedupeKey, frontierLanePriority } from "./zeroDTE.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_VERSION = process.env.FRONTIER_V3_CODE_VERSION || "89d991cddb31";
const SAMPLE_EACH = Number(process.env.FRONTIER_V3_SAMPLE_EACH || 12); // win + lose extremes
const OUT_DIR = path.join(__dirname, "data", "frontier-v3");

function dbUrl() {
  return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

function ep(id) {
  const found = QD_ENDPOINTS.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown QD endpoint ${id}`);
  return found;
}

function callPutImbalance(stats) {
  const call = Number(stats?.CALL?.premium ?? stats?.call?.premium ?? 0);
  const put = Number(stats?.PUT?.premium ?? stats?.put?.premium ?? 0);
  const tot = call + put;
  if (!(tot > 0)) return null;
  return (call - put) / tot;
}

function netFlowEarlyImbalance(flowData, buckets = 60) {
  // net-flow keys are epoch-ms strings; take the first N buckets of the session.
  const entries = Object.entries(flowData || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, buckets);
  let call = 0, put = 0;
  for (const [, v] of entries) {
    call += Number(v.callSum || v.call || 0);
    put += Number(v.putSum || v.put || 0);
  }
  const tot = call + put;
  if (!(tot > 0)) return null;
  return (call - put) / tot;
}

function buySellImbalance(sideStats) {
  // contract-trade-side-statistics shape varies; tolerate common nests.
  const root = sideStats?.data || sideStats || {};
  let buy = 0, sell = 0;
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (typeof v === "number") {
        if (key.includes("buy") || key.includes("ask")) buy += v;
        if (key.includes("sell") || key.includes("bid")) sell += v;
      } else if (v && typeof v === "object") walk(v);
    }
  };
  walk(root);
  const tot = buy + sell;
  if (!(tot > 0)) return null;
  return (buy - sell) / tot;
}

async function loadDayBooks(client) {
  const { rows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, tier, points,
            et_minute, entry_price, pnl, touch_number
     FROM zerodte_trades
     WHERE symbol = 'SPY' AND code_version = $1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL
     ORDER BY session_date, et_minute`,
    [CODE_VERSION],
  );

  const sessions = new Set();
  const wide = new Map(); // date -> { pnl, trades }
  const v2Keys = new Map(); // date -> Map(dedupeKey -> pnl)

  for (const row of rows) {
    sessions.add(row.session_date);
    const pnl = Number(row.pnl);
    if (!wide.has(row.session_date)) wide.set(row.session_date, { pnl: 0, trades: 0 });
    const w = wide.get(row.session_date);
    w.pnl += pnl; w.trades += 1;

    if (isFrontierFire({
      direction: row.direction,
      levelType: row.level_type,
      tier: row.tier,
      points: row.points != null ? Number(row.points) : null,
      etMinute: row.et_minute != null ? Number(row.et_minute) : null,
      entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
    })) {
      if (!v2Keys.has(row.session_date)) v2Keys.set(row.session_date, new Map());
      const key = frontierDedupeKey({
        sessionDate: row.session_date,
        etMinute: row.et_minute != null ? Number(row.et_minute) : null,
        direction: row.direction,
        levelType: row.level_type,
        touchNumber: row.touch_number,
      });
      const rank = frontierLanePriority(row.lane, { counted: !!row.counted });
      const prev = v2Keys.get(row.session_date).get(key);
      if (!prev || rank < prev.rank) v2Keys.get(row.session_date).set(key, { pnl, rank });
    }
  }

  // Also count distinct sessions from any row (including non-sim) for denominator.
  const { rows: allSessions } = await client.query(
    `SELECT COUNT(DISTINCT session_date)::int AS n FROM zerodte_trades
     WHERE symbol = 'SPY' AND code_version = $1`,
    [CODE_VERSION],
  );
  const sessionCount = allSessions[0].n;

  const wideDays = [...wide.entries()].map(([date, v]) => ({
    date, pnl: +v.pnl.toFixed(2), trades: v.trades, green: v.pnl > 0,
  }));
  const v2Days = [...v2Keys.entries()].map(([date, m]) => {
    const pnls = [...m.values()].map((x) => x.pnl);
    const pnl = pnls.reduce((s, x) => s + x, 0);
    return { date, pnl: +pnl.toFixed(2), trades: pnls.length, green: pnl > 0 };
  });

  return { sessionCount, wideDays, v2Days };
}

function pickExtremes(days, each) {
  const wins = [...days].filter((d) => d.green).sort((a, b) => b.pnl - a.pnl).slice(0, each);
  const losses = [...days].filter((d) => !d.green).sort((a, b) => a.pnl - b.pnl).slice(0, each);
  return [...wins, ...losses];
}

function summarizeSeparation(labeled) {
  const wins = labeled.filter((d) => d.green);
  const losses = labeled.filter((d) => !d.green);
  const mean = (arr, key) => {
    const vals = arr.map((d) => d[key]).filter((v) => v != null && Number.isFinite(v));
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const pWinGreater = (key) => {
    let gt = 0, n = 0;
    for (const w of wins) {
      if (w[key] == null) continue;
      for (const l of losses) {
        if (l[key] == null) continue;
        n++;
        if (w[key] > l[key]) gt++;
      }
    }
    return n ? gt / n : null;
  };
  const keys = ["csImb", "flowEarlyImb", "sideImb"];
  const out = {};
  for (const key of keys) {
    out[key] = {
      winMean: mean(wins, key),
      loseMean: mean(losses, key),
      pWinGreater: pWinGreater(key),
      winN: wins.filter((d) => d[key] != null).length,
      loseN: losses.filter((d) => d[key] != null).length,
    };
  }
  return out;
}

async function main() {
  if (!process.env.QUANTDATA_API_KEY) {
    console.error("[frontier-v3] missing QUANTDATA_API_KEY");
    process.exit(1);
  }
  const url = dbUrl();
  if (!url) {
    console.error("[frontier-v3] missing DATABASE_URL / DATABASE_PUBLIC_URL");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("localhost") || url.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`[frontier-v3] connected · code_version=${CODE_VERSION}`);

  const { sessionCount, wideDays, v2Days } = await loadDayBooks(client);
  await client.end();

  const coverage = {
    sessions: sessionCount,
    wideNetDays: wideDays.length,
    wideNetPct: +(100 * wideDays.length / sessionCount).toFixed(1),
    wideNetPnl: +wideDays.reduce((s, d) => s + d.pnl, 0).toFixed(2),
    wideDayWinPct: +(100 * wideDays.filter((d) => d.green).length / wideDays.length).toFixed(1),
    v2Days: v2Days.length,
    v2Pct: +(100 * v2Days.length / sessionCount).toFixed(1),
    v2Pnl: +v2Days.reduce((s, d) => s + d.pnl, 0).toFixed(2),
    targetDayPct: 75,
    gapNote: "Wide net already clears ~75% ceiling; v3 must veto losers, not thin entries further.",
  };
  console.log("[frontier-v3] coverage", coverage);

  const sample = pickExtremes(wideDays, SAMPLE_EACH);
  console.log(`[frontier-v3] sampling ${sample.length} extreme wide-net days for QuantData`);

  const labeled = [];
  for (const day of sample) {
    const cs = await fetchEndpointCached(ep("contract_statistics"), { ticker: "SPY", sessionDate: day.date });
    const flow = await fetchEndpointCached(ep("net_flow"), { ticker: "SPY", sessionDate: day.date });
    const side = await fetchEndpointCached(ep("contract_trade_side_statistics"), {
      ticker: "SPY", sessionDate: day.date,
    });
    const row = {
      ...day,
      csOk: !!cs.ok,
      flowOk: !!flow.ok,
      sideOk: !!side.ok,
      csImb: cs.ok ? callPutImbalance(cs.data?.data || cs.data) : null,
      flowEarlyImb: flow.ok ? netFlowEarlyImbalance(flow.data?.data || flow.data) : null,
      sideImb: side.ok ? buySellImbalance(side.data) : null,
    };
    labeled.push(row);
    console.log(`[frontier-v3] ${day.date} green=${day.green} pnl=${day.pnl} cs=${row.csImb?.toFixed?.(3)} flow=${row.flowEarlyImb?.toFixed?.(3)}`);
  }

  const separation = summarizeSeparation(labeled);
  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    hypothesis: "Wide-net (~79% days) + QuantData veto toward ~75% traded days with day-win >50%",
    coverage,
    sampleSize: labeled.length,
    separation,
    sample: labeled,
    nextSteps: [
      "If csImb/flowEarlyImb pWinGreater stays near 0.5, try timed pre-10:30 flow and GEX-at-level features.",
      "Prototype veto: skip wide-net day when early flow imbalance strongly opposes the day's first trade direction.",
      "Holdout: train veto on 2024-09→2025-12, validate 2026 YTD before UI promotion.",
    ],
  };

  const outPath = path.join(OUT_DIR, `pass-${CODE_VERSION}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const latest = path.join(OUT_DIR, "latest.json");
  fs.writeFileSync(latest, JSON.stringify(report, null, 2));
  console.log(`[frontier-v3] wrote ${outPath}`);
  console.log("[frontier-v3] separation", JSON.stringify(separation, null, 2));
  console.log("[frontier-v3] research pass complete");
}

main().catch((err) => {
  console.error("[frontier-v3] FAILED:", err);
  process.exit(1);
});
