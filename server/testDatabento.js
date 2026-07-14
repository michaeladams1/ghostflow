// Quick manual test: pulls one day of 1-min QQQ bars and prints a few rows.
// Run with: node --env-file=.env server/testDatabento.js
import { fetchOhlcvBars } from "./databentoClient.js";

const bars = await fetchOhlcvBars({
  symbol: "QQQ",
  startDate: "2026-07-08",
  endDate: "2026-07-09",
});

console.log(`Got ${bars.length} bars for QQQ on 2026-07-08`);
console.log("First 3 bars:", bars.slice(0, 3));
console.log("Last 3 bars:", bars.slice(-3));
