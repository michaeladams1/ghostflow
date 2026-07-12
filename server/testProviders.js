// Quick connectivity test for both vendor keys. Run locally with:
//   node --env-file=.env server/testProviders.js
// Does NOT print your keys anywhere. Just confirms each connection works.

import { listDatabentoDatasets, getQuantDataNetDrift } from "./dataProviders.js";

async function main() {
  console.log("--- Databento: listing available datasets (free call) ---");
  try {
    const datasets = await listDatabentoDatasets();
    console.log("Connected. Datasets available to your key:", datasets);
  } catch (err) {
    console.error("Databento connection failed:", err.message);
  }

  console.log("\n--- Quant Data: net-drift for AAPL, a recent session ---");
  try {
    const sessionDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const data = await getQuantDataNetDrift("AAPL", sessionDate);
    console.log("Connected. Sample response:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Quant Data connection failed:", err.message);
  }
}

main();
