// Expand Frontier blend search: full holdout coverage + Shen merge + wider fires.
// Uses bar-cache; fetches missing with backoff.
// Run: node server/frontierBlendExpand.js
// Completion: [frontier-blend-expand] complete

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
const TARGET = 250;
const SLEEP_MS = Number(process.env.FRONTIER_BLEND_SLEEP_MS || 300);
const OUT_DIR = path.join(__dirname, "data", "frontier-v3");
const BAR_CACHE = path.join(OUT_DIR, "bar-cache");
const RUNNER = { tp: 10, sl: 0.5, hardStop: 960 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function dbUrl() { return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL; }
function pnlAt(entry, exit) {
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  return Math.max(1, Math.floor(PAPER / (entry * 100))) * (exit - entry) * 100;
}
function etMin(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const m = {}; for (const p of parts) m[p.type] = p.value;
  return Number(m.hour) * 60 + Number(m.minute);
}
function cacheFile(occ, sessionDate) {
  return path.join(BAR_CACHE, `${sessionDate}_${String(occ).replace(/[^A-Za-z0-9]/g, "")}.json`);
}
async function loadBars(occ, sessionDate) {
  fs.mkdirSync(BAR_CACHE, { recursive: true });
  const file = cacheFile(occ, sessionDate);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await sleep(SLEEP_MS * (attempt + 1));
      const bars = await fetchAlpacaOptionBars({ occ, sessionDate });
      fs.writeFileSync(file, JSON.stringify(bars || []));
      return bars || [];
    } catch (err) {
      if (!/429|too many/i.test(String(err.message))) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
  return [];
}

function score(trades) {
  const by = new Map();
  for (const t of trades) by.set(t.session_date, (by.get(t.session_date) || 0) + t.pnl);
  const days = [...by.entries()];
  const pnl = days.reduce((s, [, p]) => s + p, 0);
  const win = days.filter(([, p]) => p > 0).length;
  return {
    days: days.length,
    trades: trades.length,
    avgDay: days.length ? +(pnl / days.length).toFixed(2) : 0,
    pnl: +pnl.toFixed(2),
    dayWR: days.length ? +(100 * win / days.length).toFixed(1) : 0,
    tpd: days.length ? +(trades.length / days.length).toFixed(2) : 0,
  };
}

function walkPnl(w) {
  const { exitPrice } = walkBracketBars({
    bars: w.bars, entryIdx: w.entryIdx,
    tpPrice: +(w.entryPrice * RUNNER.tp).toFixed(2),
    slPrice: +(w.entryPrice * RUNNER.sl).toFixed(2),
    cutoffMin: RUNNER.hardStop, enforceHardStop: w.fireMin < RUNNER.hardStop,
  });
  return pnlAt(w.entryPrice, exitPrice);
}

async function walkRows(rows, label) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stdout.write(`[frontier-blend-expand] ${label} ${i + 1}/${rows.length} ${row.session_date}\r`);
    try {
      const bars = await loadBars(row.contract, row.session_date);
      if (!bars || bars.length < 2) continue;
      const fireMin = Number(row.et_minute);
      let entryIdx = -1;
      for (let bi = 0; bi < bars.length; bi++) {
        if (etMin(bars[bi].ts) >= fireMin) { entryIdx = bi; break; }
      }
      if (entryIdx < 0) continue;
      const entryPrice = Number(row.entry_price) || Number(bars[entryIdx].close);
      if (!(entryPrice > 0)) continue;
      const w = {
        bars, entryIdx, entryPrice, fireMin,
        session_date: row.session_date,
        points: Number(row.points) || 0,
        direction: row.direction,
        source: row._source || "edge",
        key: frontierDedupeKey({
          sessionDate: row.session_date, etMinute: row.et_minute,
          direction: row.direction, levelType: row.level_type, touchNumber: row.touch_number,
        }),
      };
      const pnl = walkPnl(w);
      if (pnl == null) continue;
      out.push({ ...w, pnl });
    } catch (err) {
      console.warn(`\n[frontier-blend-expand] skip ${row.session_date}: ${err.message}`);
    }
  }
  console.log(`\n[frontier-blend-expand] ${label} walked=${out.length}`);
  return out;
}

function dedupeLane(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = frontierDedupeKey({
      sessionDate: row.session_date, etMinute: row.et_minute,
      direction: row.direction, levelType: row.level_type, touchNumber: row.touch_number,
    });
    const rank = frontierLanePriority(row.lane, { counted: !!row.counted });
    const prev = map.get(key);
    if (!prev || rank < prev.rank) map.set(key, { ...row, rank });
  }
  return [...map.values()];
}

function pickTopN(walked, n, pred = () => true) {
  const by = new Map();
  for (const w of walked) {
    if (!pred(w)) continue;
    if (!by.has(w.session_date)) by.set(w.session_date, []);
    by.get(w.session_date).push(w);
  }
  const trades = [];
  for (const [, list] of by) {
    list.sort((a, b) => b.points - a.points || a.fireMin - b.fireMin);
    for (const w of list.slice(0, n)) trades.push({ session_date: w.session_date, pnl: w.pnl });
  }
  return trades;
}

function mergeBooks(primary, secondary, maxPerDay) {
  const by = new Map();
  for (const t of primary) {
    if (!by.has(t.session_date)) by.set(t.session_date, []);
    by.get(t.session_date).push({ ...t, _pri: 0 });
  }
  for (const t of secondary) {
    if (!by.has(t.session_date)) by.set(t.session_date, []);
    by.get(t.session_date).push({ ...t, _pri: 1 });
  }
  const trades = [];
  for (const [, list] of by) {
    // Prefer edge-lens primary ordering already in list; cap total.
    trades.push(...list.slice(0, maxPerDay).map(({ session_date, pnl }) => ({ session_date, pnl })));
  }
  return trades;
}

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
  const { rows: edgeRows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, points, et_minute,
            entry_price, touch_number, contract
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL AND contract IS NOT NULL
       AND touch_number = 1 AND et_minute >= 585`,
    [CODE_VERSION],
  );
  const { rows: wideRows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, points, et_minute,
            entry_price, touch_number, contract
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL AND contract IS NOT NULL
       AND touch_number <= 2 AND et_minute >= 585`,
    [CODE_VERSION],
  );
  const { rows: shenRows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, points, et_minute,
            entry_price, touch_number, contract
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL AND contract IS NOT NULL
       AND lane = 'SHEN_CONVICTION'`,
    [CODE_VERSION],
  );
  const { rows: sessRows } = await client.query(
    `SELECT COUNT(DISTINCT session_date)::int AS n FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1`,
    [CODE_VERSION],
  );
  await client.end();

  const sessionCount = sessRows[0].n;
  const edge = dedupeLane(edgeRows);
  const wide = dedupeLane(wideRows);
  const shen = dedupeLane(shenRows.map((r) => ({ ...r, _source: "shen" })));

  // Full holdout + last 90 train days for balance (enough to judge $250).
  const edgeDays = [...new Set(edge.map((t) => t.session_date))].sort();
  const trainDays = edgeDays.filter((d) => d < HOLDOUT_START).slice(-90);
  const holdDays = edgeDays.filter((d) => d >= HOLDOUT_START); // FULL holdout
  const sampleDays = new Set([...trainDays, ...holdDays]);

  console.log(`[frontier-blend-expand] edge=${edge.length} wide=${wide.length} shen=${shen.length} sampleDays=${sampleDays.size} holdDays=${holdDays.length} sessions=${sessionCount}`);

  const edgeSample = edge.filter((t) => sampleDays.has(t.session_date));
  // For top-3 we need up to 3/day on sample days.
  const byDayEdge = new Map();
  for (const t of edgeSample) {
    if (!byDayEdge.has(t.session_date)) byDayEdge.set(t.session_date, []);
    byDayEdge.get(t.session_date).push(t);
  }
  const edgeFetch = [];
  for (const list of byDayEdge.values()) {
    list.sort((a, b) => Number(b.points) - Number(a.points) || Number(a.et_minute) - Number(b.et_minute));
    edgeFetch.push(...list.slice(0, 3));
  }

  const wideSample = wide.filter((t) => sampleDays.has(t.session_date));
  const byDayWide = new Map();
  for (const t of wideSample) {
    if (!byDayWide.has(t.session_date)) byDayWide.set(t.session_date, []);
    byDayWide.get(t.session_date).push(t);
  }
  const wideFetch = [];
  for (const list of byDayWide.values()) {
    list.sort((a, b) => Number(b.points) - Number(a.points) || Number(a.et_minute) - Number(b.et_minute));
    wideFetch.push(...list.slice(0, 3));
  }

  const shenFetch = shen.filter((t) => sampleDays.has(t.session_date));

  const edgeWalked = await walkRows(edgeFetch, "edge");
  const wideWalked = await walkRows(wideFetch, "wide");
  const shenWalked = await walkRows(shenFetch, "shen");

  const policies = [
    { id: "v6_top1", trades: pickTopN(edgeWalked, 1) },
    { id: "top2_runner", trades: pickTopN(edgeWalked, 2) },
    { id: "top3_runner", trades: pickTopN(edgeWalked, 3) },
    { id: "wide_top1", trades: pickTopN(wideWalked, 1) },
    { id: "wide_top2", trades: pickTopN(wideWalked, 2) },
    { id: "wide_top3", trades: pickTopN(wideWalked, 3) },
    { id: "shen_all_runner", trades: shenWalked.map((w) => ({ session_date: w.session_date, pnl: w.pnl })) },
    { id: "top1_plus_shen_cap2", trades: mergeBooks(pickTopN(edgeWalked, 1), shenWalked.map((w) => ({ session_date: w.session_date, pnl: w.pnl })), 2) },
    { id: "top1_plus_shen_cap3", trades: mergeBooks(pickTopN(edgeWalked, 1), shenWalked.map((w) => ({ session_date: w.session_date, pnl: w.pnl })), 3) },
    { id: "top2_plus_shen_cap3", trades: mergeBooks(pickTopN(edgeWalked, 2), shenWalked.map((w) => ({ session_date: w.session_date, pnl: w.pnl })), 3) },
    { id: "top2_plus_shen_cap4", trades: mergeBooks(pickTopN(edgeWalked, 2), shenWalked.map((w) => ({ session_date: w.session_date, pnl: w.pnl })), 4) },
  ];

  const results = [];
  for (const p of policies) {
    const train = score(p.trades.filter((t) => t.session_date < HOLDOUT_START));
    const holdout = score(p.trades.filter((t) => t.session_date >= HOLDOUT_START));
    const row = {
      id: p.id, train, holdout,
      hit: holdout.avgDay >= TARGET && train.avgDay > 0,
      dayCoveragePct: +(100 * score(p.trades).days / sessionCount).toFixed(1),
    };
    results.push(row);
    console.log(`[frontier-blend-expand] ${p.id} holdAvg=${holdout.avgDay} trainAvg=${train.avgDay} dayWR=${holdout.dayWR} tpd=${holdout.tpd} ${row.hit ? "HIT" : "miss"}`);
  }

  results.sort((a, b) => b.holdout.avgDay - a.holdout.avgDay || b.train.avgDay - a.train.avgDay);
  const hits = results.filter((r) => r.hit);
  const champion = hits[0] || results[0];
  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    paper: PAPER,
    targetAvgDay: TARGET,
    holdoutDaysAvailable: holdDays.length,
    trainDaysSampled: trainDays.length,
    results,
    champion,
    decision: hits.length
      ? `PROMOTE ${champion.id}: holdout $${champion.holdout.avgDay} train $${champion.train.avgDay}`
      : `NO_TARGET best=${champion?.id} holdout $${champion?.holdout.avgDay}`,
  };
  const outPath = path.join(OUT_DIR, `blend-expand-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "blend-expand-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-blend-expand] decision: ${report.decision}`);
  console.log(`[frontier-blend-expand] wrote ${outPath}`);
  console.log("[frontier-blend-expand] complete");
}

main().catch((err) => {
  console.error("[frontier-blend-expand] FAILED:", err);
  process.exit(1);
});
