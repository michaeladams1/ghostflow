// Dumps a real sample VALUE (not just keys) from each endpoint so the
// compression layer is written against actual field names, not assumptions.

import { fetchAllEndpoints } from "./quantDataClient.js";

const bundle = await fetchAllEndpoints({
  ticker: "META", sessionDate: "2026-07-10",
  startDate: "2026-06-25", endDate: "2026-07-10",
  contract: { expirationDate: "2026-07-17", strikePrice: 700, contractType: "CALL" },
});

for (const [id, r] of Object.entries(bundle.results)) {
  if (!r.ok) { console.log(`\n### ${id}: FAILED`); continue; }
  const top = Object.keys(r.data);
  const d = r.data.data;
  const keys = d ? Object.keys(d) : [];
  console.log(`\n### ${id}  topLevel=${JSON.stringify(top)}  n=${keys.length}`);
  if (keys.length) {
    const k = keys[Math.floor(keys.length / 2)]; // middle sample = more representative
    console.log(`  key: ${k}`);
    console.log(`  val: ${JSON.stringify(d[k]).slice(0, 400)}`);
  }
}
