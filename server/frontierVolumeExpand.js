// Offline filter expand over cached volume-search simulations.
// Goal: clear ≥$250 holdout avgDay and ~30 tpm without diluting v7 Core.
// Run after frontierVolumeSearch.js:
//   node server/frontierVolumeExpand.js
// Completion: [frontier-volume-expand] complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "data", "frontier-volume");
const SIM_PATH = path.join(OUT_DIR, "volume-sim-latest.json");
const TARGET_AVG = Number(process.env.VOLUME_TARGET_AVG || 250);
const TARGET_TPM = Number(process.env.VOLUME_TARGET_TPM || 30);
const HOLDOUT_START = "2026-01-01";

function scoreTrades(trades) {
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
  const spanMonths = Math.max(1, new Set(days.map((d) => d.date.slice(0, 7))).size);
  return {
    trades: tradesN,
    days: days.length,
    pnl: +pnl.toFixed(2),
    avgDay: days.length ? +(pnl / days.length).toFixed(2) : 0,
    dayWR: days.length ? +(100 * winDays.length / days.length).toFixed(1) : 0,
    tpm: +(tradesN / spanMonths).toFixed(1),
    months: spanMonths,
    avgDeployed: days.length ? +(days.reduce((s, d) => s + d.deployed, 0) / days.length).toFixed(0) : 0,
  };
}

function applyFilters(trade, f) {
  if (f.scans && !f.scans.includes(trade.scan)) return false;
  if (f.dirs && !f.dirs.includes(trade.direction)) return false;
  if (f.minMinute != null && trade.etMinute < f.minMinute) return false;
  if (f.maxMinute != null && trade.etMinute > f.maxMinute) return false;
  if (f.excludeScans && f.excludeScans.includes(trade.scan)) return false;
  return true;
}

/** Keep earliest N new-scan trades/day (core always kept separately). */
function capPerDay(trades, maxPerDay) {
  if (!maxPerDay || maxPerDay <= 0) return trades;
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.sessionDate)) byDay.set(t.sessionDate, []);
    byDay.get(t.sessionDate).push(t);
  }
  const out = [];
  for (const [, list] of byDay) {
    list.sort((a, b) => (a.etMinute - b.etMinute) || String(a.scan).localeCompare(b.scan));
    out.push(...list.slice(0, maxPerDay));
  }
  return out;
}

function main() {
  if (!fs.existsSync(SIM_PATH)) {
    throw new Error(`missing ${SIM_PATH} — run frontierVolumeSearch.js first`);
  }
  const pack = JSON.parse(fs.readFileSync(SIM_PATH, "utf8"));
  const { simulated, coreTrades, sampleDates } = pack;
  const sampleSet = new Set(sampleDates);

  const exitIds = ["runner50", "tp50_sl25", "tp40_sl20", "tp30_sl15", "playbook"];
  const scanCombos = [
    { id: "orb", scans: ["ORB_FAIL"] },
    { id: "orb_hold", scans: ["ORB_HOLD"] },
    { id: "vwap", scans: ["VWAP_RECLAIM"] },
    { id: "weekly", scans: ["WEEKLY_DRIVE"] },
    { id: "orb_vwap", scans: ["ORB_FAIL", "VWAP_RECLAIM"] },
    { id: "orb_pair", scans: ["ORB_FAIL", "ORB_HOLD"] },
    { id: "orb_weekly", scans: ["ORB_FAIL", "WEEKLY_DRIVE"] },
    { id: "hold_weekly", scans: ["ORB_HOLD", "WEEKLY_DRIVE"] },
    { id: "vwap_weekly", scans: ["VWAP_RECLAIM", "WEEKLY_DRIVE"] },
    { id: "volume", scans: ["ORB_FAIL", "ORB_HOLD", "VWAP_RECLAIM", "WEEKLY_DRIVE"] },
  ];
  const dirSets = [
    { id: "any", dirs: null },
    { id: "put", dirs: ["PUT"] },
    { id: "call", dirs: ["CALL"] },
  ];
  const minuteWindows = [
    { id: "allday", minMinute: null, maxMinute: null },
    { id: "to1100", minMinute: null, maxMinute: 660 },
    { id: "to1130", minMinute: null, maxMinute: 690 },
    { id: "from1000", minMinute: 600, maxMinute: null },
    { id: "1000_1130", minMinute: 600, maxMinute: 690 },
  ];
  const caps = [0, 1, 2]; // 0 = unlimited new-scan trades/day

  const recipes = [];
  for (const sc of scanCombos) {
    for (const ex of exitIds) {
      for (const dir of dirSets) {
        for (const win of minuteWindows) {
          for (const cap of caps) {
            for (const withCore of [true, false]) {
              recipes.push({
                id: `${sc.id}__${ex}__${dir.id}__${win.id}__cap${cap}${withCore ? "__plus_v7" : ""}`,
                scans: sc.scans,
                exitId: ex,
                dirs: dir.dirs,
                minMinute: win.minMinute,
                maxMinute: win.maxMinute,
                cap,
                withCore,
              });
            }
          }
        }
      }
    }
  }
  console.log(`[frontier-volume-expand] recipes=${recipes.length} simulated=${simulated.length}`);

  const results = [];
  for (const recipe of recipes) {
    let trades = [];
    for (const row of simulated) {
      const fire = row.fire;
      const sim = row.byExit[recipe.exitId];
      if (!sim) continue;
      const t = { ...sim, scan: fire.scan, direction: fire.direction, etMinute: fire.etMinute };
      if (!applyFilters(t, recipe)) continue;
      trades.push(t);
    }
    trades = capPerDay(trades, recipe.cap);
    if (recipe.withCore) {
      for (const t of coreTrades) {
        if (sampleSet.has(t.sessionDate)) trades.push({ ...t, etMinute: t.etMinute || 0 });
      }
    }
    // Dedupe
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
    const gate = holdScore.avgDay >= TARGET_AVG && holdScore.tpm >= TARGET_TPM * 0.9
      && trainScore.avgDay >= TARGET_AVG * 0.5; // require train not catastrophic
    const near = holdScore.avgDay >= TARGET_AVG * 0.9 && holdScore.tpm >= 20 && trainScore.avgDay > 0;
    results.push({
      id: recipe.id, scans: recipe.scans, exitId: recipe.exitId, dirs: recipe.dirs,
      minMinute: recipe.minMinute, maxMinute: recipe.maxMinute, cap: recipe.cap,
      withCore: recipe.withCore,
      train: trainScore, holdout: holdScore, full: fullScore, gate, near,
    });
  }

  results.sort((a, b) => {
    if (a.gate !== b.gate) return a.gate ? -1 : 1;
    if (a.near !== b.near) return a.near ? -1 : 1;
    const aScore = a.holdout.avgDay + a.holdout.tpm * 5;
    const bScore = b.holdout.avgDay + b.holdout.tpm * 5;
    return bScore - aScore;
  });

  const gates = results.filter((r) => r.gate);
  const nears = results.filter((r) => r.near);
  const champion = gates[0] || nears[0] || results[0];
  const report = {
    generatedAt: new Date().toISOString(),
    targets: { avgDay: TARGET_AVG, tpm: TARGET_TPM },
    recipeCount: recipes.length,
    gateCount: gates.length,
    nearCount: nears.length,
    champion,
    gates: gates.slice(0, 15),
    top: results.slice(0, 30),
    decision: gates.length
      ? `PROMOTE ${champion.id}: holdout avgDay $${champion.holdout.avgDay}, tpm ${champion.holdout.tpm}, train $${champion.train.avgDay}`
      : nears.length
        ? `NEAR ${champion.id}: holdout avgDay $${champion.holdout.avgDay}, tpm ${champion.holdout.tpm}`
        : `NO_GATE best=${champion?.id} holdAvg=$${champion?.holdout?.avgDay} tpm=${champion?.holdout?.tpm}`,
  };
  fs.writeFileSync(path.join(OUT_DIR, "volume-expand-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-volume-expand] decision: ${report.decision}`);
  console.log(`[frontier-volume-expand] gates=${gates.length} nears=${nears.length}`);
  for (const r of results.slice(0, 12)) {
    console.log(`  ${r.gate ? "GATE" : r.near ? "near" : "----"} ${r.id} hold=${r.holdout.avgDay}/${r.holdout.tpm}tpm train=${r.train.avgDay}`);
  }
  console.log("[frontier-volume-expand] complete");
}

main();
