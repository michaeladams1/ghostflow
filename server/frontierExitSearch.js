// FRONTIER EXIT SEARCH — find TP/SL brackets at $1,000 paper that beat the
// playbook +20%/-12.5% book on holdout, without $8k sizing.
//
// Re-walks Alpaca option bars for first-touch / from-9:45 candidate fires.
// Run: node server/frontierExitSearch.js
// Completion: [frontier-exit-search] complete

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
const OUT_DIR = path.join(__dirname, "data", "frontier-v3");
const MAX_DATES = Number(process.env.FRONTIER_EXIT_MAX_DATES || 160);

function dbUrl() {
  return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

function etMinutesFromClock(clock) {
  // "10:12 AM ET" / "1:05 PM ET"
  const m = String(clock || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
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
  };
}

function bestPerDay(rows) {
  const by = new Map();
  for (const t of rows) {
    const prev = by.get(t.session_date);
    if (!prev
      || Number(t.points) > Number(prev.points)
      || (Number(t.points) === Number(prev.points) && Number(t.et_minute) < Number(prev.et_minute))) {
      by.set(t.session_date, t);
    }
  }
  return [...by.values()];
}

const BRACKETS = [
  { id: "playbook_20_12", tp: 1.20, sl: 0.875, hardStop: 675, label: "+20% / -12.5% hard 11:15" },
  { id: "tp30_sl12", tp: 1.30, sl: 0.875, hardStop: 675, label: "+30% / -12.5% hard 11:15" },
  { id: "tp40_sl12", tp: 1.40, sl: 0.875, hardStop: 675, label: "+40% / -12.5% hard 11:15" },
  { id: "tp50_sl12", tp: 1.50, sl: 0.875, hardStop: 675, label: "+50% / -12.5% hard 11:15" },
  { id: "tp50_sl20", tp: 1.50, sl: 0.80, hardStop: 675, label: "+50% / -20% hard 11:15" },
  { id: "tp75_sl20", tp: 1.75, sl: 0.80, hardStop: 675, label: "+75% / -20% hard 11:15" },
  { id: "tp100_sl25", tp: 2.00, sl: 0.75, hardStop: 675, label: "+100% / -25% hard 11:15" },
  { id: "tp100_sl50", tp: 2.00, sl: 0.50, hardStop: 675, label: "+100% / -50% hard 11:15" },
  { id: "tp40_sl12_nohard", tp: 1.40, sl: 0.875, hardStop: 960, label: "+40% / -12.5% hold to close" },
  { id: "tp50_sl20_nohard", tp: 1.50, sl: 0.80, hardStop: 960, label: "+50% / -20% hold to close" },
  { id: "tp100_sl25_nohard", tp: 2.00, sl: 0.75, hardStop: 960, label: "+100% / -25% hold to close" },
  { id: "tp100_sl50_nohard", tp: 2.00, sl: 0.50, hardStop: 960, label: "+100% / -50% hold to close" },
  { id: "runner_sl25_nohard", tp: 10.0, sl: 0.75, hardStop: 960, label: "runner (TP +900%) / -25% hold to close" },
  { id: "runner_sl50_nohard", tp: 10.0, sl: 0.50, hardStop: 960, label: "runner / -50% hold to close" },
];

async function walkTrade(row, bracket) {
  const bars = await fetchAlpacaOptionBars({ occ: row.contract, sessionDate: row.session_date });
  if (!bars || bars.length < 2) return null;
  const fireMin = Number(row.et_minute);
  const entryIdx = bars.findIndex((b) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(b.ts));
    const map = {}; for (const p of parts) map[p.type] = p.value;
    return Number(map.hour) * 60 + Number(map.minute) >= fireMin;
  });
  if (entryIdx < 0) return null;
  const entryPrice = Number(row.entry_price) || Number(bars[entryIdx].close);
  if (!(entryPrice > 0)) return null;
  const tpPrice = +(entryPrice * bracket.tp).toFixed(2);
  const slPrice = +(entryPrice * bracket.sl).toFixed(2);
  const { exitPrice } = walkBracketBars({
    bars,
    entryIdx,
    tpPrice,
    slPrice,
    cutoffMin: bracket.hardStop,
    enforceHardStop: fireMin < bracket.hardStop,
  });
  const pnl = pnlAt(entryPrice, exitPrice, PAPER);
  if (pnl == null) return null;
  return { session_date: row.session_date, pnl, entryPrice, exitPrice };
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
  // Dedupe setups then best-per-day (Frontier v5 selection, $1k exits vary).
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
    if (!prev || rank < prev.rank) map.set(key, row);
  }
  const candidates = bestPerDay([...map.values()])
    .sort((a, b) => a.session_date < b.session_date ? -1 : 1);
  // Balanced sample: half train (pre-2026), half holdout — avoids holdout-only overfitting.
  const trainPool = candidates.filter((t) => t.session_date < HOLDOUT_START);
  const holdPool = candidates.filter((t) => t.session_date >= HOLDOUT_START);
  const nEach = Math.max(20, Math.floor(MAX_DATES / 2));
  const sample = [...trainPool.slice(-nEach), ...holdPool.slice(-nEach)];
  console.log(`[frontier-exit-search] candidates=${candidates.length} sample=${sample.length} sessions=${sessionCount}`);

  // Cache bars walk inputs — one fetch per trade, apply all brackets
  const walked = [];
  for (let i = 0; i < sample.length; i++) {
    const row = sample[i];
    process.stdout.write(`[frontier-exit-search] fetch ${i + 1}/${sample.length} ${row.session_date}\r`);
    try {
      const bars = await fetchAlpacaOptionBars({ occ: row.contract, sessionDate: row.session_date });
      if (!bars || bars.length < 2) continue;
      const fireMin = Number(row.et_minute);
      let entryIdx = -1;
      for (let bi = 0; bi < bars.length; bi++) {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(bars[bi].ts));
        const m = {}; for (const p of parts) m[p.type] = p.value;
        if (Number(m.hour) * 60 + Number(m.minute) >= fireMin) { entryIdx = bi; break; }
      }
      if (entryIdx < 0) continue;
      const entryPrice = Number(row.entry_price) || Number(bars[entryIdx].close);
      if (!(entryPrice > 0)) continue;
      walked.push({ row, bars, entryIdx, entryPrice, fireMin });
    } catch (err) {
      console.warn(`\n[frontier-exit-search] skip ${row.session_date}: ${err.message}`);
    }
  }
  console.log(`\n[frontier-exit-search] walked=${walked.length}`);

  const results = [];
  for (const bracket of BRACKETS) {
    const trades = [];
    for (const w of walked) {
      const tpPrice = +(w.entryPrice * bracket.tp).toFixed(2);
      const slPrice = +(w.entryPrice * bracket.sl).toFixed(2);
      const { exitPrice } = walkBracketBars({
        bars: w.bars,
        entryIdx: w.entryIdx,
        tpPrice,
        slPrice,
        cutoffMin: bracket.hardStop,
        enforceHardStop: w.fireMin < bracket.hardStop,
      });
      const pnl = pnlAt(w.entryPrice, exitPrice, PAPER);
      if (pnl == null) continue;
      trades.push({ session_date: w.row.session_date, pnl });
    }
    const train = trades.filter((t) => t.session_date < HOLDOUT_START);
    const holdout = trades.filter((t) => t.session_date >= HOLDOUT_START);
    const row = {
      id: bracket.id,
      label: bracket.label,
      tp: bracket.tp,
      sl: bracket.sl,
      hardStop: bracket.hardStop,
      paper: PAPER,
      train: scoreBook(train),
      holdout: scoreBook(holdout),
      full: scoreBook(trades),
      dayCoveragePct: +(100 * scoreBook(trades).days / sessionCount).toFixed(1),
    };
    results.push(row);
    console.log(`[frontier-exit-search] ${bracket.id} holdAvg=${row.holdout.avgDay} holdPnl=${row.holdout.pnl} dayWR=${row.holdout.dayWinPct} cov=${row.dayCoveragePct}%`);
  }

  results.sort((a, b) => b.holdout.avgDay - a.holdout.avgDay || b.holdout.pnl - a.holdout.pnl);
  const baseline = results.find((r) => r.id === "playbook_20_12");
  const champion = results.find((r) => r.holdout.avgDay > (baseline?.holdout.avgDay || 0) && r.holdout.trades >= 15) || results[0];
  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    paper: PAPER,
    sampleSize: walked.length,
    baseline,
    results,
    champion,
    decision: champion
      ? `PROMOTE ${champion.id}: holdout avgDay $${champion.holdout.avgDay} vs playbook $${baseline?.holdout.avgDay} (both @ $1000)`
      : "NO_PROMOTION",
  };
  const outPath = path.join(OUT_DIR, `exit-search-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "exit-search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-exit-search] decision: ${report.decision}`);
  console.log(`[frontier-exit-search] wrote ${outPath}`);
  console.log("[frontier-exit-search] complete");
}

main().catch((err) => {
  console.error("[frontier-exit-search] FAILED:", err);
  process.exit(1);
});
