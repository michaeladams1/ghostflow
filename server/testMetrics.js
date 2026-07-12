// Verifies EVERY metric across all 30 feeds actually computes on live data.
// A metric that silently returns null is a metric the models can reference but
// that will never fire — the exact silent-failure class of bug we already got
// burned by twice. So each one gets checked against a real session.

import { fetchAllEndpoints } from "./quantDataClient.js";
import { BAR_METRICS, SESSION_METRICS, computeSessionMetrics, barMetricSpec } from "./metrics.js";

const bundle = await fetchAllEndpoints({
  ticker: "META", sessionDate: "2026-07-10",
  startDate: "2026-06-25", endDate: "2026-07-10",
  contract: { expirationDate: "2026-07-17", strikePrice: 700, contractType: "CALL" },
});

// Spot = last close of the session, needed by distance-based metrics.
const priceBars = Object.entries(bundle.results.stock_price_over_time?.data?.data || {})
  .sort((a, b) => Number(a[0]) - Number(b[0]));
const spot = priceBars.length ? priceBars[priceBars.length - 1][1].closePrice : null;
console.log(`spot = ${spot}\n`);

let ok = 0, bad = 0;

console.log("=== BAR METRICS (minute series -> intraday triggers) ===");
for (const [feed, metrics] of Object.entries(BAR_METRICS)) {
  const r = bundle.results[feed];
  if (!r?.ok) { console.log(`  ${feed}: FEED FAILED`); bad += Object.keys(metrics).length; continue; }
  for (const [name] of Object.entries(metrics)) {
    const spec = barMetricSpec(feed, name);
    const vals = Object.values(r.data.data).map((v) => { try { return spec.fn(v); } catch { return null; } })
      .filter((x) => Number.isFinite(x));
    const good = vals.length > 0;
    good ? ok++ : bad++;
    console.log(`  ${good ? "OK  " : "FAIL"} ${(feed + "." + name).padEnd(42)} ${String(vals.length).padStart(4)} values${spec.diff ? "  [cumulative -> differenced]" : ""}`);
  }
}

console.log("\n=== SESSION METRICS (one scalar/day -> regime gates) ===");
const sm = computeSessionMetrics(bundle.results, spot);
for (const [feed, metrics] of Object.entries(SESSION_METRICS)) {
  for (const name of Object.keys(metrics)) {
    const key = `${feed}.${name}`;
    const has = key in sm;
    has ? ok++ : bad++;
    console.log(`  ${has ? "OK  " : "FAIL"} ${key.padEnd(52)} ${has ? sm[key].toFixed(2) : "— did not compute"}`);
  }
}

console.log(`\n${ok} metrics computed, ${bad} failed.`);
