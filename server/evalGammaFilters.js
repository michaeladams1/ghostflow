// Local-only Gamma filter bakeoff. Does NOT write to Postgres.
// Compares re-selection variants on the calendar date list (cached QD flow).
//
//   node server/evalGammaFilters.js
//   GAMMA_EVAL_MAX_DATES=80 node server/evalGammaFilters.js
//
// Completion marker: [gamma-eval] complete

if (process.env.DATABASE_PUBLIC_URL
  && (!process.env.DATABASE_URL || /railway\.internal/.test(process.env.DATABASE_URL))) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const pg = (await import("pg")).default;
const {
  GAMMA_MIN_DTE, GAMMA_MAX_DTE, GAMMA_MAX_PER_DAY, GAMMA_VERSION,
  fetchPaginatedConsolidatedFlow, detectGammaFires, firesFromGammaCandidates,
  summarizeGammaFires, gammaPaperPnl,
} = await import("./frontierGamma.js");
const { fetchEndpointCached } = await import("./quantDataClient.js");
const { QD_ENDPOINTS } = await import("./quantDataRegistry.js");
const { simulateAllFires } = await import("./zeroDTEOptionSim.js");

const MAX = Number(process.env.GAMMA_EVAL_MAX_DATES || 600);
const CODE = process.env.GAMMA_BACKFILL_CODE_VERSION || "89d991cddb31";
const gexEp = QD_ENDPOINTS.find((e) => e.id === "exposure_by_strike_gamma");
const priceEp = QD_ENDPOINTS.find((e) => e.id === "stock_price_over_time");

const VARIANTS = [
  { id: "baseline_dte2to5", windowStart: 570, minEntry: 0, minPremium: 0, maxPerDay: 2 },
  { id: "noon_plus", windowStart: 720, minEntry: 0, minPremium: 0, maxPerDay: 2 },
  { id: "entry_ge_040", windowStart: 570, minEntry: 0.4, minPremium: 0, maxPerDay: 2 },
  { id: "noon_entry040", windowStart: 720, minEntry: 0.4, minPremium: 0, maxPerDay: 2 },
  { id: "noon_prem30k", windowStart: 720, minEntry: 0, minPremium: 30_000, maxPerDay: 2 },
  { id: "noon_entry040_prem30k", windowStart: 720, minEntry: 0.4, minPremium: 30_000, maxPerDay: 2 },
  { id: "max1_noon", windowStart: 720, minEntry: 0, minPremium: 0, maxPerDay: 1 },
];

function dbUrl() { return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL; }

async function loadDates(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT session_date::text AS d FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
     ORDER BY d ASC LIMIT $2`,
    [CODE, MAX],
  );
  return rows.map((r) => r.d.slice(0, 10));
}

async function simVariant(sessionDate, flowResult, gexResult, priceResult, v) {
  let hits = detectGammaFires({
    sessionDate, flowResult, gexResult, priceResult,
    windowStart: v.windowStart,
    minDte: GAMMA_MIN_DTE,
    maxDte: GAMMA_MAX_DTE,
    maxPerDay: 50, // over-fetch; apply entry/premium/max after sim
  });
  if (v.minPremium > 0) hits = hits.filter((h) => Number(h.premium || h.score || 0) >= v.minPremium);
  hits = hits.slice(0, Math.max(v.maxPerDay * 4, 8)); // sim budget
  const fires = firesFromGammaCandidates(hits, { sessionDate });
  if (!fires.length) return { n: 0, wins: 0, pnl: 0, trades: [] };
  const simmed = await simulateAllFires({ ticker: "SPY", sessionDate, fires });
  let ok = summarizeGammaFires(simmed).selected;
  if (v.minEntry > 0) ok = ok.filter((f) => Number(f.trade?.entryPrice) >= v.minEntry);
  // Re-cap to maxPerDay by original score/premium order
  ok = ok
    .slice()
    .sort((a, b) => (b.featuresExtra?.score || 0) - (a.featuresExtra?.score || 0)
      || (a.etMinute || 0) - (b.etMinute || 0))
    .slice(0, v.maxPerDay);
  const pnls = ok.map((f) => gammaPaperPnl(f.trade.entryPrice, f.trade.exitPrice) || 0);
  return {
    n: ok.length,
    wins: pnls.filter((p) => p > 0).length,
    pnl: pnls.reduce((s, p) => s + p, 0),
    trades: ok.map((f, i) => ({
      et: f.etMinute, dir: f.direction, entry: f.trade.entryPrice, pnl: pnls[i],
      dte: f.dte ?? f.featuresExtra?.dte,
    })),
  };
}

function summarize(acc) {
  const n = acc.n;
  return {
    n,
    wins: acc.wins,
    wr: n ? +((100 * acc.wins) / n).toFixed(1) : 0,
    pnl: +acc.pnl.toFixed(2),
    avg: n ? +(acc.pnl / n).toFixed(2) : 0,
    n26: acc.n26,
    pnl26: +acc.pnl26.toFixed(2),
    wr26: acc.n26 ? +((100 * acc.wins26) / acc.n26).toFixed(1) : 0,
  };
}

async function main() {
  if (!process.env.QUANTDATA_API_KEY) throw new Error("missing QUANTDATA_API_KEY");
  if (!process.env.ALPACA_API_KEY) throw new Error("missing ALPACA_API_KEY");
  const client = new pg.Client({
    connectionString: dbUrl(),
    ssl: /localhost|127\.0\.0\.1/.test(dbUrl()) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const dates = await loadDates(client);
  await client.end();

  console.log(`[gamma-eval] dates=${dates.length} code=${CODE} recipe=${GAMMA_VERSION} variants=${VARIANTS.length}`);
  const acc = Object.fromEntries(VARIANTS.map((v) => [v.id, {
    n: 0, wins: 0, pnl: 0, n26: 0, wins26: 0, pnl26: 0,
  }]));

  for (let i = 0; i < dates.length; i++) {
    const sessionDate = dates[i];
    process.stdout.write(`[gamma-eval] ${i + 1}/${dates.length} ${sessionDate}\r`);
    const [flowResult, gexResult, priceResult] = await Promise.all([
      fetchPaginatedConsolidatedFlow({ ticker: "SPY", sessionDate }),
      fetchEndpointCached(gexEp, { ticker: "SPY", sessionDate }),
      fetchEndpointCached(priceEp, { ticker: "SPY", sessionDate }),
    ]);
    if (!flowResult.ok) {
      console.warn(`\n[gamma-eval] skip ${sessionDate}: flow ${flowResult.error || flowResult.status}`);
      continue;
    }
    for (const v of VARIANTS) {
      try {
        const r = await simVariant(sessionDate, flowResult, gexResult, priceResult, v);
        const a = acc[v.id];
        a.n += r.n; a.wins += r.wins; a.pnl += r.pnl;
        if (sessionDate.startsWith("2026")) {
          a.n26 += r.n; a.wins26 += r.wins; a.pnl26 += r.pnl;
        }
      } catch (err) {
        console.warn(`\n[gamma-eval] ${v.id} ${sessionDate}: ${err.message}`);
      }
    }
  }

  const table = VARIANTS.map((v) => ({ id: v.id, ...summarize(acc[v.id]) }));
  console.log("\n[gamma-eval] results");
  console.table(table);
  console.log(`[gamma-eval] complete dates=${dates.length}`);
}

main().catch((err) => {
  console.error(`[gamma-eval] fatal: ${err.message}`);
  process.exit(1);
});
