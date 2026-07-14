// Quick manual test: feeds in the VWAP Trend Trading description from the
// SSRN paper and prints back what Claude understood.
// Run with: node --env-file=.env server/testStrategyParser.js
import { parseStrategy } from "./strategyParser.js";

const description = `
VWAP Trend Trading strategy on QQQ and TQQQ. The system waits for the first
1-minute candle to close after the market opens at 9:31am ET. If price is
above the VWAP (session VWAP, not including pre/post market) at that point, it
opens a long position. If price is below VWAP, it opens a short position.
The stop loss is set at the point where a 1-minute candle CLOSES on the wrong
side of VWAP (i.e. closes below VWAP for a long, or above VWAP for a short) --
not an intra-bar touch, only a closing cross. The position is held until it is
stopped out, or until the market close at 4pm ET, whichever comes first. No
positions are held overnight. Position sizing uses 100% of available equity,
no leverage.
`.trim();

const rule = await parseStrategy(description);
console.log(JSON.stringify(rule, null, 2));
