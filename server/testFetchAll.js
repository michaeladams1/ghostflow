// Verifies the registry end-to-end: does fetchAllEndpoints actually pull
// every endpoint successfully against the live API? Prints a per-endpoint
// pass/fail plus a sample of each payload so we can see the real shapes.

import { fetchAllEndpoints } from "./quantDataClient.js";

const bundle = await fetchAllEndpoints({
  ticker: "META",
  sessionDate: "2026-07-10",
  startDate: "2026-06-25",
  endDate: "2026-07-10",
  contract: { expirationDate: "2026-07-17", strikePrice: 700, contractType: "CALL" },
});

for (const [id, r] of Object.entries(bundle.results)) {
  if (r.ok) {
    const keys = r.data?.data ? Object.keys(r.data.data) : [];
    console.log(`OK   ${id.padEnd(32)} ${keys.length} keys  sample=${JSON.stringify(keys.slice(0, 2))}`);
  } else {
    console.log(`FAIL ${id.padEnd(32)} ${r.status} ${String(r.error).slice(0, 120)}`);
  }
}

console.log("\n--- REPORT ---");
console.log(JSON.stringify(bundle.report, null, 2));
