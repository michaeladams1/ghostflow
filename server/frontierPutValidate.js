// Validate PUT-only Frontier blend on full train+holdout (bar-cache + fetch).
// Run: node server/frontierPutValidate.js
// Completion: [frontier-put-validate] complete

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
const TARGET = Number(process.env.FRONTIER_BLEND_TARGET || 250);
const SLEEP_MS = Number(process.env.FRONTIER_BLEND_SLEEP_MS || 280);
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
function score(trades, split) {
  const arr = trades.filter((t) => (split === "hold" ? t.d >= HOLDOUT_START : t.d < HOLDOUT_START));
  const by = new Map();
  for (const t of arr) by.set(t.d, (by.get(t.d) || 0) + t.pnl);
  const vals = [...by.values()];
  const pnl = vals.reduce((a, b) => a + b, 0);
  const win = vals.filter((v) => v > 0).length;
  return {
    days: vals.length,
    trades: arr.length,
    avgDay: vals.length ? +(pnl / vals.length).toFixed(2) : 0,
    pnl: +pnl.toFixed(2),
    dayWR: vals.length ? +(100 * win / vals.length).toFixed(1) : 0,
    tpd: vals.length ? +(arr.length / vals.length).toFixed(2) : 0,
  };
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
    `SELECT session_date, lane, counted, direction, level_type, points, et_minute,
            entry_price, touch_number, contract
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL AND contract IS NOT NULL
       AND touch_number = 1 AND et_minute >= 585 AND direction = 'PUT'`,
    [CODE_VERSION],
  );
  const { rows: sessRows } = await client.query(
    `SELECT COUNT(DISTINCT session_date)::int AS n FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1`,
    [CODE_VERSION],
  );
  await client.end();

  const map = new Map();
  for (const row of rows) {
    const key = frontierDedupeKey({
      sessionDate: row.session_date, etMinute: row.et_minute,
      direction: row.direction, levelType: row.level_type, touchNumber: row.touch_number,
    });
    const rank = frontierLanePriority(row.lane, { counted: !!row.counted });
    const prev = map.get(key);
    if (!prev || rank < prev.rank) map.set(key, row);
  }
  const all = [...map.values()];
  const byDay = new Map();
  for (const t of all) {
    if (!byDay.has(t.session_date)) byDay.set(t.session_date, []);
    byDay.get(t.session_date).push(t);
  }
  const fetchList = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => Number(b.points) - Number(a.points) || Number(a.et_minute) - Number(b.et_minute));
    fetchList.push(...list.slice(0, 2));
  }
  console.log(`[frontier-put-validate] putCandidates=${all.length} fetchList=${fetchList.length} days=${byDay.size} sessions=${sessRows[0].n}`);

  const walked = [];
  for (let i = 0; i < fetchList.length; i++) {
    const row = fetchList[i];
    process.stdout.write(`[frontier-put-validate] ${i + 1}/${fetchList.length} ${row.session_date}\r`);
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
      const { exitPrice } = walkBracketBars({
        bars, entryIdx,
        tpPrice: +(entryPrice * RUNNER.tp).toFixed(2),
        slPrice: +(entryPrice * RUNNER.sl).toFixed(2),
        cutoffMin: RUNNER.hardStop,
        enforceHardStop: fireMin < RUNNER.hardStop,
      });
      const pnl = pnlAt(entryPrice, exitPrice);
      if (pnl == null) continue;
      walked.push({ d: row.session_date, pnl, points: Number(row.points), fireMin, entryPrice });
    } catch (err) {
      console.warn(`\n[frontier-put-validate] skip ${row.session_date}: ${err.message}`);
    }
  }
  console.log(`\n[frontier-put-validate] walked=${walked.length}`);

  function run(name, pick) {
    const by = new Map();
    for (const w of walked) {
      if (!by.has(w.d)) by.set(w.d, []);
      by.get(w.d).push(w);
    }
    const trades = [];
    for (const [, list] of by) {
      list.sort((a, b) => b.points - a.points || a.fireMin - b.fireMin);
      for (const w of pick(list)) trades.push({ d: w.d, pnl: w.pnl });
    }
    const train = score(trades, "train");
    const hold = score(trades, "hold");
    const hit = hold.avgDay >= TARGET && train.avgDay > 0;
    console.log(`[frontier-put-validate] ${hit ? "HIT" : "miss"} ${name} hold=${hold.avgDay} train=${train.avgDay} holdDays=${hold.days} trainDays=${train.days} wr=${hold.dayWR} tpd=${hold.tpd}`);
    return { name, train, hold, hit };
  }

  const policies = [
    run("top1_PUT", (l) => l.slice(0, 1)),
    run("top2_PUT", (l) => l.slice(0, 2)),
    run("top1_PUT_pts10", (l) => l.filter((w) => w.points >= 10).slice(0, 1)),
    run("top1_PUT_pts11", (l) => l.filter((w) => w.points >= 11).slice(0, 1)),
    run("top1_PUT_pts12", (l) => l.filter((w) => w.points >= 12).slice(0, 1)),
    run("top2_PUT_pts10", (l) => l.filter((w) => w.points >= 10).slice(0, 2)),
    run("top2_PUT_pts11", (l) => l.filter((w) => w.points >= 11).slice(0, 2)),
    run("top2_PUT_pts12", (l) => l.filter((w) => w.points >= 12).slice(0, 2)),
    run("PUT2_p10_g0", (l) => {
      const out = [l[0]].filter(Boolean);
      if (l[1] && l[1].points >= 10) out.push(l[1]);
      return out;
    }),
    run("PUT2_p11_g0", (l) => {
      const out = [l[0]].filter(Boolean);
      if (l[1] && l[1].points >= 11) out.push(l[1]);
      return out;
    }),
  ];

  const hits = policies.filter((p) => p.hit)
    .sort((a, b) => b.hold.avgDay - a.hold.avgDay || b.train.avgDay - a.train.avgDay);
  // Prefer hits with more holdout days (stability) when avg is similar.
  const champ = hits.sort((a, b) =>
    (b.hold.days - a.hold.days) || (b.hold.avgDay - a.hold.avgDay) || (b.train.avgDay - a.train.avgDay)
  )[0] || [...policies].sort((a, b) => b.hold.avgDay - a.hold.avgDay)[0];

  const report = {
    generatedAt: new Date().toISOString(),
    codeVersion: CODE_VERSION,
    paper: PAPER,
    targetAvgDay: TARGET,
    walked: walked.length,
    sessions: sessRows[0].n,
    policies,
    hits,
    champion: champ,
    decision: hits.length
      ? `PROMOTE ${champ.name}: hold $${champ.hold.avgDay} train $${champ.train.avgDay} holdDays=${champ.hold.days}`
      : `NO_TARGET best=${champ?.name} hold $${champ?.hold.avgDay}`,
  };
  const outPath = path.join(OUT_DIR, `blend-put-validate-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "blend-put-validate-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-put-validate] decision: ${report.decision}`);
  console.log(`[frontier-put-validate] wrote ${outPath}`);
  console.log("[frontier-put-validate] complete");
}

main().catch((err) => {
  console.error("[frontier-put-validate] FAILED:", err);
  process.exit(1);
});
