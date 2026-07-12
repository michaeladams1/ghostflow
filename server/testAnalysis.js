// TEMPORARY test hook — runs one real trade through the full pipeline
// (Databento + Quant Data + all 3 AI analysts) once at startup, logging the
// full result to the console so it shows up in Railway's Deploy Logs.
// Remove the call to this from server.js after reviewing the first run —
// this is not meant to run on every future deploy/restart (costs real API
// credits each time).
//
// Test case: META, a real trade from Friday July 10, 2026. Meta ran up
// roughly 22% over the 10 trading days starting June 25, 2026, capped by a
// ~6% jump on July 10 on real news (Bank of America report on Meta's AI
// compute buildout / custom chip plans). Genuine, documented, catalyst-driven
// move — not a hypothetical.

import { buildTradeDataset } from "./tradeData.js";
import { analyzeTradeAllModels } from "./analysis.js";

const TEST_TRADE = {
  symbol: "META",
  direction: "CALL",
  entryDate: "2026-06-25",
  exitDate: "2026-07-10",
};

export async function runFridayTestAnalysis() {
  console.log("\n=== TEST ANALYSIS RUN: META 2026-06-25 to 2026-07-10 ===");
  try {
    const dataset = await buildTradeDataset(TEST_TRADE);
    console.log("Data fetch status:", JSON.stringify(dataset.dataFetchOk));
    if (dataset.bars) {
      console.log(`Fetched ${dataset.bars.length} daily bars.`);
      console.log("Entry bar:", JSON.stringify(dataset.bars[dataset.entryIdx]));
      console.log("Exit bar:", JSON.stringify(dataset.bars[dataset.exitIdx]));
    } else {
      console.log("No Databento bars returned — check DATABENTO_DATASET covers META and this date range.");
    }

    const results = await analyzeTradeAllModels(TEST_TRADE, dataset);
    for (const modelId of ["claude", "gpt", "grok", "combined"]) {
      console.log(`\n--- ${modelId.toUpperCase()} ---`);
      console.log(JSON.stringify(results[modelId], null, 2));
    }
  } catch (err) {
    console.error("Test analysis run failed:", err);
  }
  console.log("=== END TEST ANALYSIS RUN ===\n");
}
