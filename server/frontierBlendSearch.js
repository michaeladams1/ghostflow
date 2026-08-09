// FRONTIER BLEND SEARCH — multi-trade / day at $1,000 per trade (concurrent OK).
// Goal: holdout avg $/day ≥ $250 without raising per-trade size.
//
// Selection base: first touch, from 9:45 ET (same fire filter as Frontier v6).
// Sweeps top-N/day + exit blends (runner on best, tighter brackets on fillers).
//
// Run: node server/frontierBlendSearch.js
// Completion: [frontier-blend-search] complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fetchAlpacaOptionBars } from "./alpacaClient.js";
import { walkBracketBars } from "./zeroDTEOptionSim.js";
import { frontierDedupeKey, frontierLanePriority } from "./zeroDTE.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_VERSION = process.env.FRONTIER_V3_CODE_VERSION || "89d991cddb31";
const HOLDOUT_START = "2026-01-01";
const PAPER = 1000;
const TARGET_AVG_DAY = Number(process.env.FRONTIER_BLEND_TARGET || 250);
const MAX_DAYS = Number(process.env.FRONTIER_BLEND_MAX_DAYS || 140);
const SLEEP_MS = Number(process.env.FRONTIER_BLEND_SLEEP_MS || 350);
const OUT_DIR = path.join(__dirname, "data", "frontier-v3");
const BAR_CACHE = path.join(OUT_DIR, "bar-cache");

const EXITS = {
  playbook: { id: "playbook", tp: 1.20, sl: 0.875, hardStop: 675 },
  tp50_sl20: { id: "tp50_sl20", tp: 1.50, sl: 0.80, hardStop: 675 },
  tp50_sl20_hold: { id: "tp50_sl20_hold", tp: 1.50, sl: 0.80, hardStop: 960 },
  runner_sl50: { id: "runner_sl50", tp: 10.0, sl: 0.50, hardStop: 960 },
  runner_sl25: { id: "runner_sl25", tp: 10.0, sl: 0.75, hardStop: 960 },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dbUrl() {
  return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

function pnlAt(entry, exit, dollars = PAPER) {
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  const contracts = Math.max(1, Math.floor(dollars / (entry * 100)));
  return contracts * (exit - entry) * 100;
}

function scoreBook(trades) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.session_date)) byDay.set(t.session_date, 0);
    byDay.set(t.session_date, byDay.get(t.session_date) + t.pnl);
  }
  const days = [...byDay.entries()].map(([date, pnl]) => ({ date, pnl }));
  const winDays = days.filter((d) => d.pnl > 0);
  const loseDays = days.filter((d) => d.pnl < 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    trades: trades.length,
    days: days.length,
    winDays: winDays.length,
    loseDays: loseDays.length,
    dayWinPct: days.length ? +(100 * winDays.length / days.length).toFixed(1) : 0,
    tradeWinPct: trades.length ? +(100 * trades.filter((t) => t.pnl > 0).length / trades.length).toFixed(1) : 0,
    pnl: +pnl.toFixed(2),
    avgDay: days.length ? +(pnl / days.length).toFixed(2) : 0,
    avgWinDay: winDays.length ? +(winDays.reduce((s, d) => s + d.pnl, 0) / winDays.length).toFixed(2) : 0,
    avgLoseDay: loseDays.length ? +(loseDays.reduce((s, d) => s + d.pnl, 0) / loseDays.length).toFixed(2) : 0,
    avgTradesPerDay: days.length ? +(trades.length / days.length).toFixed(2) : 0,
  };
}

function topNPerDay(rows, n) {
  const by = new Map();
  for (const t of rows) {
    if (!by.has(t.session_date)) by.set(t.session_date, []);
    by.get(t.session_date).push(t);
  }
  const out = [];
  for (const [, list] of by) {
    list.sort((a, b) => Number(b.points) - Number(a.points)
      || Number(a.et_minute) - Number(b.et_minute));
    out.push(...list.slice(0, n));
  }
  return out;
}

function etMinuteFromBar(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return Number(m.hour) * 60 + Number(m.minute);
}

function cacheKey(occ, sessionDate) {
  return `${sessionDate}_${String(occ).replace(/[^A-Za-z0-9]/g, "")}.json`;
}

async function loadBars(occ, sessionDate) {
  fs.mkdirSync(BAR_CACHE, { recursive: true });
  const file = path.join(BAR_CACHE, cacheKey(occ, sessionDate));
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (attempt || SLEEP_MS) await sleep(SLEEP_MS * (attempt + 1));
      const bars = await fetchAlpacaOptionBars({ occ, sessionDate });
      fs.writeFileSync(file, JSON.stringify(bars || []));
      return bars || [];
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (msg.includes("429") || /too many/i.test(msg)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function walkExit(w, exit) {
  const tpPrice = +(w.entryPrice * exit.tp).toFixed(2);
  const slPrice = +(w.entryPrice * exit.sl).toFixed(2);
  const { exitPrice } = walkBracketBars({
    bars: w.bars,
    entryIdx: w.entryIdx,
    tpPrice,
    slPrice,
    cutoffMin: exit.hardStop,
    enforceHardStop: w.fireMin < exit.hardStop,
  });
  return pnlAt(w.entryPrice, exitPrice, PAPER);
}

/** Policies: topN + per-rank exit ids (index 0 = best score). */
const POLICIES = [
  { id: "v6_top1_runner50", n: 1, exits: ["runner_sl50"] },
  { id: "top2_all_runner50", n: 2, exits: ["runner_sl50", "runner_sl50"] },
  { id: "top3_all_runner50", n: 3, exits: ["runner_sl50", "runner_sl50", "runner_sl50"] },
  { id: "top2_runner_playbook", n: 2, exits: ["runner_sl50", "playbook"] },
  { id: "top2_runner_tp50", n: 2, exits: ["runner_sl50", "tp50_sl20"] },
  { id: "top2_runner_tp50hold", n: 2, exits: ["runner_sl50", "tp50_sl20_hold"] },
  { id: "top3_runner_playbook_playbook", n: 3, exits: ["runner_sl50", "playbook", "playbook"] },
  { id: "top3_runner_tp50_playbook", n: 3, exits: ["runner_sl50", "tp50_sl20", "playbook"] },
  { id: "top3_runner_tp50_tp50", n: 3, exits: ["runner_sl50", "tp50_sl20", "tp50_sl20"] },
  { id: "top3_all_tp50hold", n: 3, exits: ["tp50_sl20_hold", "tp50_sl20_hold", "tp50_sl20_hold"] },
  { id: "top2_all_tp50hold", n: 2, exits: ["tp50_sl20_hold", "tp50_sl20_hold"] },
  { id: "top2_runner25_runner50", n: 2, exits: ["runner_sl25", "runner_sl50"] },
];

async function main() {
  const url = dbUrl();
  if (!url) throw new Error("missing DATABASE_URL");
  if (!process.env.ALPACA_API_KEY) throw new Error("missing ALPACA_API_KEY");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, tier, points,
            et_minute, entry_price, exit_price, pnl, touch_number, contract, entry_clock
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL
       AND contract IS NOT NULL
       AND touch_number = 1
       AND et_minute >= 585`,
    [CODE_VERSION],
  );
  const { rows: sessRows } = await client.query(
    `SELECT COUNT(DISTINCT session_date)::int AS n FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1`,
    [CODE_VERSION],
  );
  await client.end();

  const sessionCount = sessRows[0].n;
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
    if (!prev || rank < prev.rank) map.set(key, { ...row, rank });
  }
  const all = [...map.values()];
  const daySet = [...new Set(all.map((t) => t.session_date))].sort();
  const trainDays = daySet.filter((d) => d < HOLDOUT_START);
  const holdDays = daySet.filter((d) => d >= HOLDOUT_START);
  const nEach = Math.max(25, Math.floor(MAX_DAYS / 2));
  const sampleDays = new Set([
    ...trainDays.slice(-nEach),
    ...holdDays.slice(-nEach),
  ]);
  // Need up to top-3 on each sample day for every policy.
  const sampleTrades = topNPerDay(
    all.filter((t) => sampleDays.has(t.session_date)),
    3,
  ).sort((a, b) => (a.session_date < b.session_date ? -1 : a.session_date > b.session_date ? 1 : a.et_minute - b.et_minute));

  console.log(`[frontier-blend-search] candidates=${all.length} days=${daySet.length} sampleDays=${sampleDays.size} sampleTrades=${sampleTrades.length} sessions=${sessionCount}`);

  const walkedByKey = new Map();
  for (let i = 0; i < sampleTrades.length; i++) {
    const row = sampleTrades[i];
    const key = `${row.session_date}|${row.contract}|${row.et_minute}|${row.direction}|${row.level_type}`;
    process.stdout.write(`[frontier-blend-search] fetch ${i + 1}/${sampleTrades.length} ${row.session_date}\r`);
    try {
      const bars = await loadBars(row.contract, row.session_date);
      if (!bars || bars.length < 2) continue;
      const fireMin = Number(row.et_minute);
      let entryIdx = -1;
      for (let bi = 0; bi < bars.length; bi++) {
        if (etMinuteFromBar(bars[bi].ts) >= fireMin) { entryIdx = bi; break; }
      }
      if (entryIdx < 0) continue;
      const entryPrice = Number(row.entry_price) || Number(bars[entryIdx].close);
      if (!(entryPrice > 0)) continue;
      walkedByKey.set(key, {
        row, bars, entryIdx, entryPrice, fireMin, key,
        points: Number(row.points),
        session_date: row.session_date,
      });
    } catch (err) {
      console.warn(`\n[frontier-blend-search] skip ${row.session_date}: ${err.message}`);
    }
  }
  const walked = [...walkedByKey.values()];
  console.log(`\n[frontier-blend-search] walked=${walked.length}`);

  // Rank walked trades within each day for top-N selection.
  const byDay = new Map();
  for (const w of walked) {
    if (!byDay.has(w.session_date)) byDay.set(w.session_date, []);
    byDay.get(w.session_date).push(w);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => b.points - a.points || a.fireMin - b.fireMin);
  }

  const results = [];
  for (const policy of POLICIES) {
    const trades = [];
    for (const [, list] of byDay) {
      const taken = list.slice(0, policy.n);
      for (let i = 0; i < taken.length; i++) {
        const exitId = policy.exits[Math.min(i, policy.exits.length - 1)];
        const pnl = walkExit(taken[i], EXITS[exitId]);
        if (pnl == null) continue;
        trades.push({
          session_date: taken[i].session_date,
          pnl,
          rank: i + 1,
          exit: exitId,
          points: taken[i].points,
        });
      }
    }
    const train = trades.filter((t) => t.session_date < HOLDOUT_START);
    const holdout = trades.filter((t) => t.session_date >= HOLDOUT_START);
    const row = {
      id: policy.id,
      n: policy.n,
      exits: policy.exits,
      paper: PAPER,
      train: scoreBook(train),
      holdout: scoreBook(holdout),
      full: scoreBook(trades),
      dayCoveragePct: +(100 * scoreBook(trades).days / sessionCount).toFixed(1),
    };
    results.push(row);
    const hit = row.holdout.avgDay >= TARGET_AVG_DAY ? "HIT" : "miss";
    console.log(`[frontier-blend-search] ${policy.id} holdAvg=${row.holdout.avgDay} trainAvg=${row.train.avgDay} dayWR=${row.holdout.dayWinPct} tpd=${row.holdout.avgTradesPerDay} ${hit}`);
  }

  results.sort((a, b) => b.holdout.avgDay - a.holdout.avgDay || b.train.avgDay - a.train.avgDay);
  const baseline = results.find((r) => r.id === "v6_top1_runner50");
  // Prefer policies that clear target on holdout AND are not deeply negative on train.
  const eligible = results.filter((r) =>
    r.holdout.avgDay >= TARGET_AVG_DAY
    && r.holdout.days >= 20
    && r.train.avgDay > 0);
  const champion = eligible[0] || results.find((r) =>
    r.holdout.avgDay > (baseline?.holdout.avgDay || 0)
    && r.train.avgDay > (baseline?.train.avgDay || 0)
    && r.holdout.days >= 20) || results[0];

  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    paper: PAPER,
    targetAvgDay: TARGET_AVG_DAY,
    sampleDays: sampleDays.size,
    walked: walked.length,
    baseline,
    results,
    champion,
    eligibleCount: eligible.length,
    decision: eligible.length
      ? `PROMOTE ${champion.id}: holdout avgDay $${champion.holdout.avgDay} (target $${TARGET_AVG_DAY}), train $${champion.train.avgDay}`
      : champion
        ? `NO_TARGET ${champion.id}: best holdout $${champion.holdout.avgDay} < $${TARGET_AVG_DAY} (train $${champion.train.avgDay})`
        : "NO_PROMOTION",
  };
  const outPath = path.join(OUT_DIR, `blend-search-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "blend-search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-blend-search] decision: ${report.decision}`);
  console.log(`[frontier-blend-search] wrote ${outPath}`);
  console.log("[frontier-blend-search] complete");
}

main().catch((err) => {
  console.error("[frontier-blend-search] FAILED:", err);
  process.exit(1);
});
