// A real tool the AI analysts can call during analysis to fetch whatever
// additional market data they decide they need — any symbol, any date range,
// not just the trade's own pre-fetched bundle. E.g. Grok can fetch QQQ
// itself to build a real relative-strength comparison, instead of us
// pre-deciding what data it gets.

import { getDatabentoOHLCV, getDatabentoIntraday, getQuantDataNetDrift } from "./dataProviders.js";
import { parseOHLCV, aggregateTo15Min } from "./tradeData.js";

export const FETCH_TOOL = {
  name: "fetch_market_data",
  description: "Fetch real historical data for ANY stock/ETF symbol and date range — not limited to the trade's own symbol. Use this if you want a benchmark index (e.g. QQQ, SPY), a sector peer, or any additional real data to support or challenge your analysis. There is no limit on which symbols or how many times you can call this within a single analysis. Returns real data only, or an explicit failure message if the fetch didn't work — never fabricated.",
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Ticker symbol, e.g. QQQ, SPY, AAPL" },
      dataType: {
        type: "string",
        enum: ["daily_ohlcv", "intraday_15min_ohlcv", "options_flow"],
        description: "daily_ohlcv = one bar per day. intraday_15min_ohlcv = 15-minute bars. options_flow = Quant Data net call/put premium for a single session date (uses startDate as the session date).",
      },
      startDate: { type: "string", description: "YYYY-MM-DD" },
      endDate: { type: "string", description: "YYYY-MM-DD. Ignored for options_flow." },
    },
    required: ["symbol", "dataType", "startDate"],
  },
};

function summarizeBars(bars) {
  if (!bars.length) return "No bars returned for this request.";
  return bars.map((b) => `${b.date}\tO=${b.open} H=${b.high} L=${b.low} C=${b.close} V=${b.volume}`).join("\n");
}

export async function executeFetchTool({ symbol, dataType, startDate, endDate }) {
  try {
    if (dataType === "options_flow") {
      const flow = await getQuantDataNetDrift(symbol, startDate);
      return JSON.stringify(flow).slice(0, 4000);
    }
    if (dataType === "intraday_15min_ohlcv") {
      const text = await getDatabentoIntraday(symbol, `${startDate}T00:00:00`, `${endDate || startDate}T23:59:59`);
      return summarizeBars(aggregateTo15Min(parseOHLCV(text)));
    }
    const text = await getDatabentoOHLCV(symbol, startDate, endDate || startDate);
    return summarizeBars(parseOHLCV(text));
  } catch (err) {
    return `Fetch failed: ${err.message}`;
  }
}
