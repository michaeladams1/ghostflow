// Backfill VOLUME sleeve rows onto the widest production calendar code_version
// without wiping Frontier/official rows.
//
// Run: node server/frontierVolumeBackfill.js
// Env: VOLUME_BACKFILL_MAX_DATES (default 120), VOLUME_BACKFILL_CODE_VERSION
// Completion: [frontier-volume-backfill] complete

// Prefer the public Railway URL locally (internal hostname won't resolve).
if (process.env.DATABASE_PUBLIC_URL
  && (!process.env.DATABASE_URL || /railway\.internal/.test(process.env.DATABASE_URL))) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const pg = (await import("pg")).default;
const fs = await import("node:fs");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { fetchAlpacaBars } = await import("./alpacaClient.js");
const {
  buildVolumeFires, summarizeVolumeFires, volumePaperPnl, VOLUME_LANE,
} = await import("./frontierVolume.js");
const { simulateAllFires } = await import("./zeroDTEOptionSim.js");
const { saveVolumeTrades } = await import("./zeroDTEStore.js");
const { sessionRthBars } = await import("./scanLib.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, "data", "frontier-volume", "spy-cache");
const MAX = Number(process.env.VOLUME_BACKFILL_MAX_DATES || 120);
const SLEEP = Number(process.env.VOLUME_SLEEP_MS || 100);
const CODE_VERSION = process.env.VOLUME_BACKFILL_CODE_VERSION || "1a20ea38464b";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function dbUrl() { return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL; }

async function loadSpy(sessionDate) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${sessionDate}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const start = new Date(`${sessionDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 10);
  await sleep(SLEEP);
  const bars = await fetchAlpacaBars({
    symbol: "SPY", startDate: start.toISOString().slice(0, 10), endDate: sessionDate,
  });
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

function priorHl(allBars, sessionDate) {
  const byDay = new Map();
  for (const b of allBars) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(b.ts));
    const m = {}; for (const p of parts) m[p.type] = p.value;
    const dateStr = `${m.year}-${m.month}-${m.day}`;
    const minutes = Number(m.hour) * 60 + Number(m.minute);
    if (minutes < 570 || minutes >= 960) continue;
    if (!byDay.has(dateStr)) byDay.set(dateStr, { high: b.high, low: b.low });
    const d = byDay.get(dateStr);
    d.high = Math.max(d.high, b.high);
    d.low = Math.min(d.low, b.low);
  }
  const days = [...byDay.keys()].sort();
  const idx = days.indexOf(sessionDate);
  if (idx < 1) return null;
  return byDay.get(days[idx - 1]);
}

async function main() {
  const url = dbUrl();
  if (!url) throw new Error("missing DATABASE_URL");
  if (!process.env.ALPACA_API_KEY) throw new Error("missing ALPACA_API_KEY");

  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT DISTINCT session_date FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1
     ORDER BY session_date DESC
     LIMIT $2`,
    [CODE_VERSION, MAX],
  );
  await client.end();
  const dates = rows.map((r) => r.session_date).reverse();
  console.log(`[frontier-volume-backfill] code_version=${CODE_VERSION} dates=${dates.length} lane=${VOLUME_LANE}`);

  let wrote = 0, signals = 0, errors = 0;
  for (let i = 0; i < dates.length; i++) {
    const sessionDate = dates[i];
    process.stdout.write(`[frontier-volume-backfill] ${i + 1}/${dates.length} ${sessionDate}\r`);
    try {
      const allBars = await loadSpy(sessionDate);
      const prior = priorHl(allBars, sessionDate);
      if (!prior || !sessionRthBars(allBars, sessionDate).length) continue;
      const fires = buildVolumeFires({
        bars: allBars, sessionDate, pdh: prior.high, pdl: prior.low,
      });
      const simmed = await simulateAllFires({ ticker: "SPY", sessionDate, fires });
      const ok = summarizeVolumeFires(simmed).selected;
      signals += ok.length;
      const rowsOut = ok.map((f) => ({
        ...f,
        contracts: Math.max(1, Math.floor(1000 / (f.trade.entryPrice * 100))),
        pnl: volumePaperPnl(f.trade.entryPrice, f.trade.exitPrice),
        counted: false,
      }));
      await saveVolumeTrades({
        symbol: "SPY", sessionDate, rows: rowsOut, codeVersion: CODE_VERSION, environment: "production",
      });
      wrote += rowsOut.length;
    } catch (err) {
      errors++;
      console.warn(`\n[frontier-volume-backfill] skip ${sessionDate}: ${err.message}`);
    }
  }
  console.log(`\n[frontier-volume-backfill] wrote=${wrote} signals=${signals} errors=${errors}`);
  console.log("[frontier-volume-backfill] complete");
}

main().catch((err) => {
  console.error("[frontier-volume-backfill] FAILED:", err);
  process.exit(1);
});
