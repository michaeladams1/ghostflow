// End-to-end sanity check: real data -> parsed rule -> backtest -> stats.
// Run with: node --env-file=.env server/testFullPipeline.js
import { fetchOhlcvBars } from "./databentoClient.js";
import { parseStrategy } from "./strategyParser.js";
import { runBacktest } from "./priceBacktest.js";

const description = `
VWAP Trend Trading strategy on QQQ. The system waits for the first 1-minute
candle to close after the market opens at 9:31am ET. If price is above the
VWAP (session VWAP, RTH only) at that point, it opens a long position. If
price is below VWAP, it opens a short position. The stop is a 1-minute candle
CLOSING on the wrong side of VWAP. Held until stopped out or market close at
4pm ET, whichever comes first. No overnight positions. 100% of equity, no
leverage.
`.trim();

console.log("Parsing strategy...");
const rule = await parseStrategy(description);
console.log("Parsed OK:", rule.summary);

console.log("\nFetching ~2 months of 1-min QQQ bars...");
const bars = await fetchOhlcvBars({ symbol: "QQQ", startDate: "2026-05-01", endDate: "2026-07-09" });
console.log(`Got ${bars.length} bars.`);

console.log("\nRunning backtest...");
const result = runBacktest(rule, bars, { startingCapital: 25000 });

console.log("\n--- RESULTS ---");
console.log("Sessions tested:", result.sessionsTested);
console.log("Total trades:", result.totalTrades, "| Win rate:", result.winRate + "%");
console.log("Avg win:", result.avgWinPct + "%", "| Avg loss:", result.avgLossPct + "%", "| Risk:Reward", result.riskReward);
console.log("Starting capital:", result.startingCapital, "-> Final equity:", result.finalEquity);
console.log("Total return:", result.totalReturnPct + "%", "| Avg yearly:", result.avgYearlyReturnPct + "%");
console.log("Max drawdown:", result.maxDrawdownPct + "%", "| Sharpe:", result.sharpeRatio);
console.log("\nBuy & Hold over same period:", result.buyHold);
console.log("\nCaveats:", result.caveats);
