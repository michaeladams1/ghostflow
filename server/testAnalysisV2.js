import { fetchAllEndpoints } from "./quantDataClient.js";
import { buildBriefing } from "./compress.js";
import { analyzeAllModels, MODEL_IDS } from "./analysis.js";

const bundle = await fetchAllEndpoints({
  ticker: "META", sessionDate: "2026-07-10", startDate: "2026-06-25", endDate: "2026-07-10",
});
const briefing = buildBriefing(bundle);
console.log(`Briefing: ${briefing.endpoints.length} feeds, ${briefing.timeline.priceThrusts.length} thrusts.\nRunning 3 analysts...\n`);

const results = await analyzeAllModels(briefing);

for (const m of MODEL_IDS) {
  const r = results[m];
  console.log("=".repeat(70));
  if (r.failed) { console.log(`${m.toUpperCase()}: FAILED — ${r.reasoning}`); continue; }
  console.log(`${m.toUpperCase()}  verdict=${r.verdict}  confidence=${r.confidence}`);
  console.log(`  feeds reviewed: ${r.reviewedCount}/${briefing.endpoints.length}   used: ${r.usedCount}   complete: ${r.reviewComplete}`);
  if (r.missingReviews.length) console.log(`  !! SKIPPED: ${r.missingReviews.join(", ")}`);
  console.log(`  entry: ${r.entry.timestamp || "NONE"}  (lead ${r.entry.leadMinutes ?? "-"} min, corroborated by ${(r.entry.corroboratingFeeds || []).join(", ") || "nothing"})`);
  console.log(`  reasoning: ${r.reasoning}`);
  console.log(`  rule: ${r.rule ? r.rule.description : "NONE — model says not knowable"}`);
  console.log(`  falsification: ${r.falsification}`);
  const unused = r.endpointReview.filter((x) => !x.used && x.reviewed);
  console.log(`\n  --- sample of feeds it examined but chose NOT to use (${unused.length}) ---`);
  unused.slice(0, 3).forEach((x) => console.log(`   * ${x.id}: ${x.notes}`));
}

console.log("\n" + "=".repeat(70));
console.log(`COMBINED: ${results.combined.verdict}, agreement ${results.combined.agreement}`);
console.log("Entry timings (never averaged):");
for (const [m, e] of Object.entries(results.combined.entries)) {
  console.log(`  ${m}: ${e.timestamp || "no entry"}`);
}
