// FRONTIER VOLUME SEARCH — find new scans that clear:
//   ≤ $1,000 / trade · ≥ $250 avg $/day · ~30 trades / month
// while keeping Frontier v7 (PUT pts≥12 runner) as an optional core sleeve.
//
// Scans: ORB fail (0DTE), VWAP reclaim (0DTE), weekly PDH/PDL drive (3–7 DTE).
// Run: node server/frontierVolumeSearch.js
// Completion: [frontier-volume-search] complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fetchAlpacaBars, fetchAlpacaOptionBars, occSymbol } from "./alpacaClient.js";
import { pickOtmStrike } from "./zeroDTE.js";
import { walkBracketBars } from "./zeroDTEOptionSim.js";
import {
  FRONTIER_HARD_STOP_MIN, FRONTIER_PAPER_DOLLARS, FRONTIER_SL_MULT, FRONTIER_TP_MULT,
  passesFrontierV3, selectFrontierBestPerDay, frontierPaperPnl, frontierDeployedNotional,
} from "./frontierV3.js";
import { frontierDedupeKey, frontierLanePriority } from "./zeroDTE.js";
import {
  detectVolumeScanFires, etParts, paperDeployed, paperPnl, pickWeeklyExpiration,
  priorDayHl, sessionRthBars,
} from "./scanLib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "data", "frontier-volume");
const BAR_CACHE = path.join(OUT_DIR, "spy-cache");
const OPT_CACHE = path.join(OUT_DIR, "opt-cache");
const CODE_VERSION = process.env.FRONTIER_V3_CODE_VERSION || "1a20ea38464b";
const HOLDOUT_START = "2026-01-01";
const TARGET_AVG = Number(process.env.VOLUME_TARGET_AVG || 250);
const TARGET_TPM = Number(process.env.VOLUME_TARGET_TPM || 30);
const MAX_DATES = Number(process.env.VOLUME_MAX_DATES || 120);
const SLEEP_MS = Number(process.env.VOLUME_SLEEP_MS || 250);
const PAPER = FRONTIER_PAPER_DOLLARS;

const EXITS = {
  runner50: { id: "runner50", tp: FRONTIER_TP_MULT, sl: FRONTIER_SL_MULT, hard: FRONTIER_HARD_STOP_MIN },
  tp50_sl25: { id: "tp50_sl25", tp: 1.50, sl: 0.75, hard: 675 },
  tp40_sl20: { id: "tp40_sl20", tp: 1.40, sl: 0.80, hard: 675 },
  tp30_sl15: { id: "tp30_sl15", tp: 1.30, sl: 0.85, hard: 675 },
  playbook: { id: "playbook", tp: 1.20, sl: 0.875, hard: 675 },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function dbUrl() { return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL; }

function scoreTrades(trades, { months = null, sessions = null } = {}) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.sessionDate)) byDay.set(t.sessionDate, { pnl: 0, trades: 0, deployed: 0 });
    const d = byDay.get(t.sessionDate);
    d.pnl += t.pnl;
    d.trades += 1;
    d.deployed += t.deployed || 0;
  }
  const days = [...byDay.entries()].map(([date, v]) => ({ date, ...v }));
  const winDays = days.filter((d) => d.pnl > 0);
  const pnl = days.reduce((s, d) => s + d.pnl, 0);
  const tradesN = trades.length;
  const spanMonths = months || Math.max(1, new Set(days.map((d) => d.date.slice(0, 7))).size);
  return {
    trades: tradesN,
    days: days.length,
    pnl: +pnl.toFixed(2),
    avgDay: days.length ? +(pnl / days.length).toFixed(2) : 0,
    dayWR: days.length ? +(100 * winDays.length / days.length).toFixed(1) : 0,
    tpm: +(tradesN / spanMonths).toFixed(1),
    months: spanMonths,
    avgDeployed: days.length ? +(days.reduce((s, d) => s + d.deployed, 0) / days.length).toFixed(0) : 0,
    sessionCoveragePct: sessions ? +(100 * days.length / sessions).toFixed(1) : null,
    hitAvg: days.length ? pnl / days.length >= TARGET_AVG : false,
    hitTpm: tradesN / spanMonths >= TARGET_TPM * 0.9, // 90% of target counts as near-hit during search
  };
}

async function loadSpyDay(sessionDate) {
  fs.mkdirSync(BAR_CACHE, { recursive: true });
  const file = path.join(BAR_CACHE, `${sessionDate}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const start = new Date(`${sessionDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 10);
  const startDate = start.toISOString().slice(0, 10);
  await sleep(SLEEP_MS);
  const allBars = await fetchAlpacaBars({ symbol: "SPY", startDate, endDate: sessionDate });
  fs.writeFileSync(file, JSON.stringify(allBars));
  return allBars;
}

async function loadOptBars(occ, sessionDate) {
  fs.mkdirSync(OPT_CACHE, { recursive: true });
  const file = path.join(OPT_CACHE, `${sessionDate}_${occ}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  for (let a = 0; a < 4; a++) {
    try {
      await sleep(SLEEP_MS * (a + 1));
      const bars = await fetchAlpacaOptionBars({ occ, sessionDate });
      fs.writeFileSync(file, JSON.stringify(bars || []));
      return bars || [];
    } catch (err) {
      if (!/429|too many/i.test(String(err.message))) throw err;
      await sleep(2000 * (a + 1));
    }
  }
  return [];
}

function simulateFire(fire, bars, exit) {
  if (!bars?.length) return null;
  const entryIdx = bars.findIndex((b) => etParts(b.ts).minutes >= fire.etMinute);
  if (entryIdx < 0) return null;
  const entryPrice = Number(bars[entryIdx].close);
  if (!(entryPrice > 0) || entryPrice * 100 > PAPER) return null; // need ≥1 contract under $1k
  const tpPrice = +(entryPrice * exit.tp).toFixed(2);
  const slPrice = +(entryPrice * exit.sl).toFixed(2);
  const { exitPrice, exitReason } = walkBracketBars({
    bars, entryIdx, tpPrice, slPrice,
    cutoffMin: exit.hard,
    enforceHardStop: fire.etMinute < exit.hard,
    tpLabel: exit.id, slLabel: exit.id,
  });
  const pnl = paperPnl(entryPrice, exitPrice, PAPER);
  if (pnl == null) return null;
  return {
    sessionDate: fire.sessionDate,
    scan: fire.scan,
    direction: fire.direction,
    etMinute: fire.etMinute,
    entryPrice,
    exitPrice,
    exitReason,
    pnl,
    deployed: paperDeployed(entryPrice, PAPER),
    expiration: fire.expiration,
    contract: fire.contract,
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
  const { rows: dateRows } = await client.query(
    `SELECT DISTINCT session_date FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
     ORDER BY session_date`,
    [CODE_VERSION],
  );
  const { rows: frontierRows } = await client.query(
    `SELECT session_date, lane, counted, direction, level_type, tier, points, et_minute,
            entry_price, exit_price, touch_number, frontier_pnl, frontier_exit_price
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
       AND entry_price IS NOT NULL AND pnl IS NOT NULL`,
    [CODE_VERSION],
  );
  await client.end();

  const allDates = dateRows.map((r) => r.session_date);
  const holdDates = allDates.filter((d) => d >= HOLDOUT_START);
  const trainDates = allDates.filter((d) => d < HOLDOUT_START);
  // Balanced recent sample for speed; prefer full holdout + last N train.
  const sampleDates = [...trainDates.slice(-Math.floor(MAX_DATES / 2)), ...holdDates.slice(-Math.ceil(MAX_DATES / 2))];
  const sampleSet = new Set(sampleDates);
  console.log(`[frontier-volume-search] dates=${allDates.length} sample=${sampleDates.length} holdout=${holdDates.length}`);

  // Frontier v7 core from stored frontier_* (no re-sim needed).
  // Restrict to sampleSet so avgDay/tpm are comparable to newly simulated scans.
  const coreByDay = new Map();
  for (const r of frontierRows) {
    if (!sampleSet.has(r.session_date)) continue;
    const entry = Number(r.entry_price);
    if (!passesFrontierV3({
      direction: r.direction, levelType: r.level_type, tier: r.tier,
      points: Number(r.points), etMinute: Number(r.et_minute), entryPrice: entry,
      touchNumber: Number(r.touch_number),
    })) continue;
    const pnl = r.frontier_pnl != null
      ? Number(r.frontier_pnl)
      : frontierPaperPnl(entry, r.frontier_exit_price ?? r.exit_price);
    if (pnl == null || Number.isNaN(pnl)) continue;
    const key = frontierDedupeKey({
      sessionDate: r.session_date, etMinute: Number(r.et_minute),
      direction: r.direction, levelType: r.level_type, touchNumber: Number(r.touch_number),
    });
    const rank = frontierLanePriority(r.lane, { counted: !!r.counted });
    if (!coreByDay.has(r.session_date)) coreByDay.set(r.session_date, new Map());
    const m = coreByDay.get(r.session_date);
    const prev = m.get(key);
    if (!prev || rank < prev.rank) {
      m.set(key, {
        sessionDate: r.session_date, scan: "FRONTIER_V7", direction: r.direction,
        etMinute: Number(r.et_minute), points: Number(r.points),
        pnl, deployed: frontierDeployedNotional(entry) || 0,
      });
    }
  }
  const coreTrades = [];
  for (const [, m] of coreByDay) {
    for (const t of selectFrontierBestPerDay([...m.values()])) coreTrades.push(t);
  }
  console.log(`[frontier-volume-search] frontier v7 core trades in range=${coreTrades.length}`);

  // Detect + simulate new scans on sample dates.
  const simulated = []; // { fire meta + pnl per exit id }
  for (let i = 0; i < sampleDates.length; i++) {
    const sessionDate = sampleDates[i];
    process.stdout.write(`[frontier-volume-search] day ${i + 1}/${sampleDates.length} ${sessionDate}\r`);
    let allBars;
    try { allBars = await loadSpyDay(sessionDate); }
    catch (err) { console.warn(`\n[frontier-volume-search] spy skip ${sessionDate}: ${err.message}`); continue; }
    const rth = sessionRthBars(allBars, sessionDate);
    const prior = priorDayHl(allBars, sessionDate);
    if (!rth.length || !prior) continue;
    const fires = detectVolumeScanFires({
      rthBars: rth, sessionDate, pdh: prior.high, pdl: prior.low,
    });
    for (const fire of fires) {
      let expiration = sessionDate;
      if (fire.expirationMode === "WEEKLY") {
        const w = pickWeeklyExpiration(sessionDate);
        if (!w) continue;
        expiration = w.expiration;
        fire.dte = w.dte;
      }
      const strike = pickOtmStrike({ level: fire.level, direction: fire.direction });
      const occ = occSymbol({
        underlying: "SPY", expiration, contractType: fire.direction, strike,
      });
      fire.expiration = expiration;
      fire.contract = occ;
      fire.strike = strike;
      let bars;
      try { bars = await loadOptBars(occ, sessionDate); }
      catch (err) {
        console.warn(`\n[frontier-volume-search] opt skip ${occ}: ${err.message}`);
        continue;
      }
      const byExit = {};
      for (const exit of Object.values(EXITS)) {
        // Weeklies: use hold-to-close style hard stop (no 11:15) for non-playbook exits.
        const use = fire.expirationMode === "WEEKLY" && exit.hard < 900
          ? { ...exit, hard: 960 }
          : exit;
        const sim = simulateFire(fire, bars, use);
        if (sim) byExit[exit.id] = sim;
      }
      if (Object.keys(byExit).length) simulated.push({ fire, byExit });
    }
  }
  console.log(`\n[frontier-volume-search] simulated signals=${simulated.length}`);

  // Portfolio recipes: which scans + which exit + include v7 core?
  const recipes = [];
  const scanSets = [
    ["orb", ["ORB_FAIL"]],
    ["vwap", ["VWAP_RECLAIM"]],
    ["weekly", ["WEEKLY_DRIVE"]],
    ["orb_vwap", ["ORB_FAIL", "VWAP_RECLAIM"]],
    ["all_new", ["ORB_FAIL", "VWAP_RECLAIM", "WEEKLY_DRIVE"]],
  ];
  for (const [name, scans] of scanSets) {
    for (const exit of Object.values(EXITS)) {
      for (const withCore of [false, true]) {
        recipes.push({
          id: `${name}__${exit.id}${withCore ? "__plus_v7" : ""}`,
          scans, exitId: exit.id, withCore,
        });
      }
    }
  }

  const holdSet = new Set(holdDates);
  const results = [];
  for (const recipe of recipes) {
    const trades = [];
    for (const row of simulated) {
      if (!recipe.scans.includes(row.fire.scan)) continue;
      const sim = row.byExit[recipe.exitId];
      if (!sim) continue;
      trades.push(sim);
    }
    if (recipe.withCore) {
      for (const t of coreTrades) trades.push(t);
    }
    // Dedupe identical scan+minute+direction
    const seen = new Set();
    const deduped = [];
    for (const t of trades) {
      const k = `${t.sessionDate}|${t.scan}|${t.direction}|${t.etMinute || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(t);
    }

    const train = deduped.filter((t) => t.sessionDate < HOLDOUT_START);
    const hold = deduped.filter((t) => t.sessionDate >= HOLDOUT_START);
    const trainScore = scoreTrades(train);
    const holdScore = scoreTrades(hold);
    const fullScore = scoreTrades(deduped);
    const gate = holdScore.avgDay >= TARGET_AVG && holdScore.tpm >= TARGET_TPM * 0.9 && trainScore.avgDay > 0;
    const near = holdScore.avgDay >= TARGET_AVG * 0.8 && holdScore.tpm >= 15 && trainScore.avgDay > 0;
    results.push({
      id: recipe.id, scans: recipe.scans, exitId: recipe.exitId, withCore: recipe.withCore,
      train: trainScore, holdout: holdScore, full: fullScore, gate, near,
    });
    if (gate || near) {
      console.log(`[frontier-volume-search] ${gate ? "GATE" : "near"} ${recipe.id} holdAvg=${holdScore.avgDay} tpm=${holdScore.tpm} trainAvg=${trainScore.avgDay}`);
    }
  }

  results.sort((a, b) => {
    if (a.gate !== b.gate) return a.gate ? -1 : 1;
    if (a.near !== b.near) return a.near ? -1 : 1;
    return (b.holdout.avgDay - a.holdout.avgDay) || (b.holdout.tpm - a.holdout.tpm);
  });

  const gates = results.filter((r) => r.gate);
  const nears = results.filter((r) => r.near);
  const champion = gates[0] || nears[0] || results[0];
  const report = {
    generatedAt: new Date().toISOString(),
    targets: { avgDay: TARGET_AVG, tpm: TARGET_TPM, paper: PAPER },
    sampleDates: sampleDates.length,
    simulatedSignals: simulated.length,
    coreTrades: coreTrades.length,
    gateCount: gates.length,
    nearCount: nears.length,
    champion,
    top: results.slice(0, 20),
    decision: gates.length
      ? `PROMOTE ${champion.id}: holdout avgDay $${champion.holdout.avgDay}, tpm ${champion.holdout.tpm}`
      : nears.length
        ? `NEAR ${champion.id}: holdout avgDay $${champion.holdout.avgDay}, tpm ${champion.holdout.tpm} (below full gate)`
        : `NO_GATE best=${champion?.id} holdAvg=$${champion?.holdout?.avgDay} tpm=${champion?.holdout?.tpm}`,
  };
  const outPath = path.join(OUT_DIR, `volume-search-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "volume-search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-volume-search] decision: ${report.decision}`);
  console.log(`[frontier-volume-search] top5:`);
  for (const r of results.slice(0, 5)) {
    console.log(`  ${r.id} holdAvg=${r.holdout.avgDay} tpm=${r.holdout.tpm} trainAvg=${r.train.avgDay} gate=${r.gate}`);
  }
  console.log(`[frontier-volume-search] wrote ${outPath}`);
  console.log("[frontier-volume-search] complete");
}

main().catch((err) => {
  console.error("[frontier-volume-search] FAILED:", err);
  process.exit(1);
});
