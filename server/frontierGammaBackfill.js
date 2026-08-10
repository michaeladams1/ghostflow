// Backfill GAMMA research lane onto an existing calendar code_version.
// Does NOT touch live-paper. Does NOT wipe Frontier/Volume/official rows.
//
// Run: node --env-file=.env server/frontierGammaBackfill.js
// Env:
//   GAMMA_BACKFILL_CODE_VERSION  (default: widest calendar version helper below)
//   GAMMA_BACKFILL_MAX_DATES     (default 60)
// Completion marker: [frontier-gamma-backfill] complete

if (process.env.DATABASE_PUBLIC_URL
  && (!process.env.DATABASE_URL || /railway\.internal/.test(process.env.DATABASE_URL))) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const pg = (await import("pg")).default;
const {
  GAMMA_LANE, GAMMA_VERSION, buildGammaFires, summarizeGammaFires, gammaPaperPnl,
  assertGammaNotLive,
} = await import("./frontierGamma.js");
const { simulateAllFires } = await import("./zeroDTEOptionSim.js");
const { saveGammaTrades, saveGammaFeatures } = await import("./zeroDTEGammaStore.js");

const MAX = Number(process.env.GAMMA_BACKFILL_MAX_DATES || 60);
const SLEEP = Number(process.env.GAMMA_SLEEP_MS || 150);
const CODE_VERSION = process.env.GAMMA_BACKFILL_CODE_VERSION || null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function dbUrl() { return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL; }

async function resolveCodeVersion(client) {
  if (CODE_VERSION) return CODE_VERSION;
  const { rows } = await client.query(
    `SELECT code_version, COUNT(DISTINCT session_date)::int AS n
     FROM zerodte_trades WHERE symbol='SPY'
     GROUP BY code_version ORDER BY n DESC, code_version DESC LIMIT 1`,
  );
  if (!rows.length) throw new Error("no zerodte_trades code_version to attach gamma onto");
  return rows[0].code_version;
}

async function main() {
  assertGammaNotLive();
  const url = dbUrl();
  if (!url) throw new Error("missing DATABASE_URL");
  if (!process.env.QUANTDATA_API_KEY) throw new Error("missing QUANTDATA_API_KEY");
  if (!process.env.ALPACA_API_KEY) throw new Error("missing ALPACA_API_KEY");

  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const codeVersion = await resolveCodeVersion(client);
  const { rows } = await client.query(
    `SELECT DISTINCT session_date FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
     ORDER BY session_date DESC
     LIMIT $2`,
    [codeVersion, MAX],
  );
  await client.end();
  const dates = rows.map((r) => r.session_date).reverse();
  console.log(
    `[frontier-gamma-backfill] code_version=${codeVersion} dates=${dates.length} `
    + `lane=${GAMMA_LANE} method=${GAMMA_VERSION}`,
  );

  let wrote = 0, signals = 0, featureRows = 0, errors = 0, scanned = 0;
  for (let i = 0; i < dates.length; i++) {
    const sessionDate = dates[i];
    scanned += 1;
    process.stdout.write(`[frontier-gamma-backfill] ${i + 1}/${dates.length} ${sessionDate}\r`);
    try {
      await sleep(SLEEP);
      const fires = await buildGammaFires({ sessionDate, ticker: "SPY" });
      // Persist detector candidates even when sim fails — research warehouse.
      featureRows += await saveGammaFeatures({
        symbol: "SPY",
        sessionDate,
        codeVersion,
        rows: fires.map((f) => ({
          etMinute: f.etMinute,
          strike: f.strike,
          direction: f.direction,
          askProxy: f.maxEntryPrice,
          volume: f.featuresExtra?.premium ?? null,
          volumeZ: null,
          gex: f.featuresExtra?.strikeGex ?? null,
          netGex: f.featuresExtra?.netGex ?? null,
          features: {
            expiration: f.expiration,
            dte: f.dte,
            score: f.featuresExtra?.score,
            spot: f.featuresExtra?.spot,
            method: GAMMA_VERSION,
          },
        })),
      });
      if (!fires.length) {
        await saveGammaTrades({
          symbol: "SPY", sessionDate, rows: [], codeVersion, environment: "production",
        });
        continue;
      }
      const simmed = await simulateAllFires({ ticker: "SPY", sessionDate, fires });
      const ok = summarizeGammaFires(simmed).selected;
      signals += ok.length;
      const rowsOut = ok.map((f) => ({
        ...f,
        contracts: Math.max(1, Math.floor(1000 / (f.trade.entryPrice * 100))),
        pnl: gammaPaperPnl(f.trade.entryPrice, f.trade.exitPrice),
        counted: false,
      }));
      await saveGammaTrades({
        symbol: "SPY", sessionDate, rows: rowsOut, codeVersion, environment: "production",
      });
      wrote += rowsOut.length;
    } catch (err) {
      errors += 1;
      console.warn(`\n[frontier-gamma-backfill] skip ${sessionDate}: ${err.message}`);
    }
  }

  console.log(
    `\n[frontier-gamma-backfill] complete scanned=${scanned} wrote=${wrote} `
    + `signals=${signals} features=${featureRows} errors=${errors} `
    + `code_version=${codeVersion} lane=${GAMMA_LANE}`,
  );
}

main().catch((err) => {
  console.error(`[frontier-gamma-backfill] fatal: ${err.message}`);
  process.exit(1);
});
