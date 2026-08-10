// Offline exit asymmetry search for live Volume sleeve (ORB_HOLD + VWAP).
// Idea: let winners run further (higher TP) and cut losers sooner (tighter SL).
// Uses cached option bars when present; does not change live constants.
//
// Run: node server/frontierVolumeExitSearch.js
// Completion: [frontier-volume-exit-search] complete

if (process.env.DATABASE_PUBLIC_URL
  && (!process.env.DATABASE_URL || /railway\.internal/.test(process.env.DATABASE_URL))) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const pg = (await import("pg")).default;
const fs = await import("node:fs");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { occSymbol, fetchAlpacaOptionBars } = await import("./alpacaClient.js");
const { pickOtmStrike } = await import("./zeroDTE.js");
const { walkBracketBars } = await import("./zeroDTEOptionSim.js");
const { etParts, paperPnl, paperDeployed } = await import("./scanLib.js");
const { VOLUME_HARD_STOP_MIN, VOLUME_PAPER_DOLLARS, VOLUME_SCANS } = await import("./frontierVolume.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "data", "frontier-volume");
const OPT_CACHE = path.join(OUT_DIR, "opt-cache");
const CODE = process.env.VOLUME_BACKFILL_CODE_VERSION || "1a20ea38464b";
const SLEEP = Number(process.env.VOLUME_SLEEP_MS || 60);

const EXITS = [
  { id: "tp30_sl15", tp: 1.30, sl: 0.85 }, // live baseline
  { id: "tp30_sl12", tp: 1.30, sl: 0.875 },
  { id: "tp30_sl10", tp: 1.30, sl: 0.90 },
  { id: "tp40_sl15", tp: 1.40, sl: 0.85 },
  { id: "tp40_sl10", tp: 1.40, sl: 0.90 },
  { id: "tp50_sl15", tp: 1.50, sl: 0.85 },
  { id: "tp50_sl12", tp: 1.50, sl: 0.875 },
  { id: "tp50_sl10", tp: 1.50, sl: 0.90 },
  { id: "tp100_sl15", tp: 2.00, sl: 0.85 },
  { id: "tp100_sl10", tp: 2.00, sl: 0.90 },
  { id: "runner_sl35", tp: 10.0, sl: 0.65 },
  { id: "runner_sl50", tp: 10.0, sl: 0.50 },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadBars(occ, sessionDate) {
  fs.mkdirSync(OPT_CACHE, { recursive: true });
  const file = path.join(OPT_CACHE, `${sessionDate}_${occ}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  await sleep(SLEEP);
  try {
    const bars = await fetchAlpacaOptionBars({ occ, sessionDate });
    fs.writeFileSync(file, JSON.stringify(bars || []));
    return bars || [];
  } catch {
    return [];
  }
}

function sim(bars, etMinute, exit) {
  if (!bars?.length) return null;
  const entryIdx = bars.findIndex((b) => etParts(b.ts).minutes >= etMinute);
  if (entryIdx < 0) return null;
  const entry = Number(bars[entryIdx].close);
  if (!(entry > 0) || entry * 100 > VOLUME_PAPER_DOLLARS) return null;
  const { exitPrice } = walkBracketBars({
    bars, entryIdx,
    tpPrice: +(entry * exit.tp).toFixed(2),
    slPrice: +(entry * exit.sl).toFixed(2),
    cutoffMin: VOLUME_HARD_STOP_MIN,
    enforceHardStop: etMinute < VOLUME_HARD_STOP_MIN,
  });
  const pnl = paperPnl(entry, exitPrice, VOLUME_PAPER_DOLLARS);
  if (pnl == null) return null;
  return { pnl, win: pnl > 0, deployed: paperDeployed(entry, VOLUME_PAPER_DOLLARS) };
}

function score(trades) {
  if (!trades.length) return { n: 0, wr: 0, pnl: 0, avgDay: 0, avgWin: 0, avgLoss: 0, tpm: 0 };
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const byDay = new Map();
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) || 0) + t.pnl);
  const days = [...byDay.values()];
  const months = Math.max(1, new Set(trades.map((t) => t.date.slice(0, 7))).size);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    n: trades.length,
    wr: +(100 * wins.length / trades.length).toFixed(1),
    pnl: +pnl.toFixed(0),
    avgDay: days.length ? +(pnl / days.length).toFixed(0) : 0,
    dayWR: days.length ? +(100 * days.filter((p) => p > 0).length / days.length).toFixed(1) : 0,
    avgWin: wins.length ? +(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0) : 0,
    avgLoss: losses.length ? +(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0) : 0,
    tpm: +(trades.length / months).toFixed(1),
  };
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT session_date, direction, tier, et_minute, level, features, pnl
     FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1 AND lane='VOLUME' AND pnl IS NOT NULL
     ORDER BY session_date, et_minute`,
    [CODE],
  );
  await client.end();

  const fires = rows.map((r) => {
    let scan = r.tier;
    try {
      const f = typeof r.features === "string" ? JSON.parse(r.features) : r.features;
      scan = f?.scan || r.tier;
    } catch { /* ignore */ }
    return {
      date: r.session_date, dir: r.direction, scan,
      et: Number(r.et_minute), level: Number(r.level), baselinePnl: Number(r.pnl),
    };
  }).filter((t) => VOLUME_SCANS.includes(t.scan) && t.level > 0);

  console.log(`[frontier-volume-exit-search] fires=${fires.length}`);

  // Preload bars once per fire
  const loaded = [];
  for (let i = 0; i < fires.length; i++) {
    const t = fires[i];
    if (i % 40 === 0) process.stdout.write(`[frontier-volume-exit-search] load ${i}/${fires.length}\r`);
    const strike = pickOtmStrike({ level: t.level, direction: t.dir });
    const occ = occSymbol({ underlying: "SPY", expiration: t.date, contractType: t.dir, strike });
    const bars = await loadBars(occ, t.date);
    loaded.push({ ...t, bars });
  }
  console.log(`\n[frontier-volume-exit-search] loaded=${loaded.length}`);

  const results = [];
  for (const exit of EXITS) {
    const trades = [];
    for (const t of loaded) {
      const s = sim(t.bars, t.et, exit);
      if (!s) continue;
      trades.push({ date: t.date, ...s });
    }
    const full = score(trades);
    const y2026 = score(trades.filter((t) => t.date >= "2026-01-01"));
    results.push({ id: exit.id, ...exit, full, y2026 });
    console.log(`[frontier-volume-exit-search] ${exit.id} fullWR=${full.wr} pnl=${full.pnl} avgWin=${full.avgWin} avgLoss=${full.avgLoss} | 2026 WR=${y2026.wr} pnl=${y2026.pnl}`);
  }

  results.sort((a, b) => (b.y2026.pnl - a.y2026.pnl) || (b.y2026.wr - a.y2026.wr));
  const baseline = results.find((r) => r.id === "tp30_sl15");
  const best = results[0];
  const report = {
    generatedAt: new Date().toISOString(),
    fires: fires.length,
    baseline,
    best,
    ranked: results,
    decision: baseline && best && best.id !== baseline.id && best.y2026.pnl > baseline.y2026.pnl
      ? `CANDIDATE ${best.id}: 2026 pnl $${best.y2026.pnl} (baseline $${baseline.y2026.pnl}), WR ${best.y2026.wr}% vs ${baseline.y2026.wr}%`
      : `KEEP baseline tp30_sl15 — no clear 2026 improvement`,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "volume-exit-search-latest.json"), JSON.stringify(report, null, 2));
  console.log(`[frontier-volume-exit-search] decision: ${report.decision}`);
  console.log("[frontier-volume-exit-search] complete");
}

main().catch((err) => {
  console.error("[frontier-volume-exit-search] FAILED:", err);
  process.exit(1);
});
