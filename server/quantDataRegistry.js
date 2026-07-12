// THE COMPLETE QUANT DATA ENDPOINT REGISTRY.
//
// This is the single source of truth for every Quant Data endpoint GHOSTFLOW
// can pull. It is NOT guessed from documentation — every path, required
// field, and enum value below was discovered by probing the live API and
// reading back its own validation errors (see probeQuantData.js /
// probeEnums.js). If an endpoint is in this list, it has been confirmed to
// return a real 200 with a real API key.
//
// WHY A REGISTRY AND NOT 30 HAND-WRITTEN FUNCTIONS:
// The analysis layer must be able to say "fetch EVERY endpoint for this
// symbol and date" and be sure nothing was skipped. A data-driven list makes
// completeness checkable in code (see fetchAllEndpoints), instead of relying
// on an AI model remembering to call 30 separate tools.
//
// `surface` -> URL segment: https://api.quantdata.us/v1/<surface>/tool/<path>
// `scope`   -> what this endpoint tells us about:
//                "underlying"  = about the stock itself
//                "chain"       = about the whole options chain
//                "contract"    = about ONE specific option contract
// `timeSel` -> which time selector this endpoint takes (they are NOT uniform):
//                "sessionDate"      = a single session
//                "sessionDateRange" = an inclusive start/end range
//                "none"             = no time selector accepted
// `needs`   -> extra required fields beyond ticker + time.

export const QD_ENDPOINTS = [
  // ---------------- OPTIONS: flow & sentiment ----------------
  {
    id: "net_drift", surface: "options", path: "net-drift", scope: "chain", timeSel: "sessionDate",
    describes: "Call/put premium drift over the session, bucketed by time, alongside the stock price at each bucket. Shows whether option premium was building on the call side or put side as the day progressed.",
  },
  {
    id: "net_flow", surface: "options", path: "net-flow", scope: "chain", timeSel: "sessionDate",
    needs: { dataMode: "NET_PREMIUM" }, // enum: NET_PREMIUM | NET_VOLUME
    describes: "Net call/put premium over time. Large spikes here are the classic 'someone knows something' signal — a premium spike often precedes an underlying move.",
  },
  {
    id: "contract_statistics", surface: "options", path: "contract-statistics", scope: "chain", timeSel: "sessionDate",
    describes: "Total premium, trade count, and contract volume, split CALL vs PUT. The simplest bull/bear rollup for the session.",
  },
  {
    id: "contract_trade_side_statistics", surface: "options", path: "contract-trade-side-statistics", scope: "chain", timeSel: "sessionDate",
    needs: { dataMode: "PREMIUM" }, // enum: PREMIUM | TRADE_COUNT | VOLUME
    describes: "Buy-side vs sell-side aggregates by contract type. Distinguishes premium being PAID (aggressive buyers lifting the ask) from premium being SOLD — a crucial distinction raw volume hides.",
  },
  {
    id: "order_flow_consolidated", surface: "options", path: "order-flow/consolidated", scope: "chain", timeSel: "sessionDate",
    describes: "Consolidated blocks and sweeps — individual large/unusual option trades grouped into single logical orders. This is the 'unusual options activity' tape.",
  },
  {
    id: "order_flow_unconsolidated", surface: "options", path: "order-flow/unconsolidated", scope: "chain", timeSel: "sessionDate",
    describes: "Trade-by-trade raw option tape. Every print, unaggregated.",
  },
  {
    id: "gainers_losers", surface: "options", path: "gainers-losers", scope: "chain", timeSel: "sessionDate",
    describes: "Per-ticker bullish vs bearish premium ranking across the market. Useful for relative context: was this name unusually active vs everything else that day?",
  },
  {
    id: "market_share", surface: "options", path: "market-share", scope: "chain", timeSel: "sessionDate",
    describes: "Per-exchange share of options volume.",
  },

  // ---------------- OPTIONS: dealer exposure (GEX/DEX/etc) ----------------
  {
    id: "exposure_by_strike_gamma", surface: "options", path: "exposure-by-strike", scope: "chain", timeSel: "sessionDate",
    needs: { greekMode: "GAMMA", representationMode: "PER_ONE_PERCENT_MOVE" },
    describes: "GEX — gamma exposure per strike. Shows where dealer hedging pressure is stacked. Large positive gamma walls tend to pin price; negative gamma amplifies moves.",
  },
  {
    id: "exposure_by_strike_delta", surface: "options", path: "exposure-by-strike", scope: "chain", timeSel: "sessionDate",
    needs: { greekMode: "DELTA", representationMode: "PER_ONE_PERCENT_MOVE" },
    describes: "DEX — delta exposure per strike: directional dealer positioning.",
  },
  {
    id: "exposure_by_strike_vanna", surface: "options", path: "exposure-by-strike", scope: "chain", timeSel: "sessionDate",
    needs: { greekMode: "VANNA", representationMode: "PER_ONE_PERCENT_MOVE" },
    describes: "VEX — vanna exposure per strike: how dealer delta shifts as implied volatility moves.",
  },
  {
    id: "exposure_by_strike_charm", surface: "options", path: "exposure-by-strike", scope: "chain", timeSel: "sessionDate",
    needs: { greekMode: "CHARM", representationMode: "PER_ONE_PERCENT_MOVE" },
    describes: "CHEX — charm exposure per strike: how dealer delta decays with time. Drives drift into expiration.",
  },
  {
    id: "exposure_by_expiration_gamma", surface: "options", path: "exposure-by-expiration", scope: "chain", timeSel: "sessionDate",
    needs: { greekMode: "GAMMA", representationMode: "PER_ONE_PERCENT_MOVE" },
    describes: "Gamma exposure aggregated per expiration date rather than per strike — which expiry carries the hedging weight.",
  },
  {
    id: "interval_map", surface: "options", path: "interval-map", scope: "chain", timeSel: "sessionDate",
    needs: { greekMode: "GAMMA" },
    describes: "Time-bucketed exposure across the chain — how the gamma map MOVED through the day, not just where it ended. Reveals intraday shifts in dealer positioning.",
  },
  {
    id: "heat_map", surface: "options", path: "heat-map", scope: "chain", timeSel: "sessionDate",
    needs: { dataMode: "NET_PREMIUM" },
    describes: "Expiration x strike grid of activity. Shows exactly which cells of the chain lit up.",
  },
  {
    id: "max_pain_over_time", surface: "options", path: "max-pain-over-time", scope: "chain", timeSel: "sessionDate",
    describes: "Max-pain strike per expiration across the session. Price often gravitates toward max pain into expiry.",
  },

  // ---------------- OPTIONS: open interest ----------------
  {
    id: "open_interest_by_strike", surface: "options", path: "open-interest-by-strike", scope: "chain", timeSel: "sessionDate",
    describes: "Call/put open interest per strike — where positions are actually PARKED (vs volume, which is just today's churn).",
  },
  {
    id: "open_interest_by_expiration", surface: "options", path: "open-interest-by-expiration", scope: "chain", timeSel: "sessionDate",
    describes: "Call/put open interest per expiration date.",
  },
  {
    id: "open_interest_change", surface: "options", path: "open-interest-change", scope: "chain", timeSel: "sessionDate",
    describes: "Per-contract DAY-OVER-DAY open interest delta. This is how you tell NEW positions being opened from existing ones being closed — volume alone cannot tell you that.",
  },
  {
    id: "open_interest_over_time", surface: "options", path: "open-interest-over-time", scope: "chain", timeSel: "sessionDate",
    describes: "Open interest series across sessions — is positioning BUILDING over days, or was it a one-day blip?",
  },

  // ---------------- OPTIONS: volatility ----------------
  {
    id: "volatility_skew", surface: "options", path: "volatility-skew", scope: "chain", timeSel: "sessionDate",
    describes: "Strike x expiration implied-volatility surface. Skew shifts reveal where the market is paying up for protection or for upside.",
  },
  {
    id: "volatility_drift", surface: "options", path: "volatility-drift", scope: "chain", timeSel: "sessionDate",
    describes: "Per-minute REALIZED vs IMPLIED volatility over the session. When realized runs above implied, options were underpriced for the move that actually happened.",
  },
  {
    id: "term_structure", surface: "options", path: "term-structure", scope: "chain", timeSel: "sessionDate",
    describes: "Per-cell delta, IV, and moneyness across the chain. Front-month IV spiking above back-month signals an expected near-term event.",
  },

  // ---------------- EQUITIES: the underlying itself ----------------
  {
    id: "stock_price_over_time", surface: "equities", path: "stock-price-over-time", scope: "underlying", timeSel: "sessionDate",
    describes: "Per-ticker OHLC price bars. The underlying's own price action — the thing every other signal is trying to predict.",
  },
  {
    id: "dark_flow", surface: "equities", path: "dark-flow", scope: "underlying", timeSel: "sessionDate",
    describes: "Off-exchange (dark pool) notional and trade count over time. Institutional accumulation often shows up here BEFORE it shows up in price.",
  },
  {
    id: "dark_pool_levels", surface: "equities", path: "dark-pool-levels", scope: "underlying", timeSel: "sessionDateRange",
    describes: "Dark-pool prints aggregated BY PRICE LEVEL over a date range. Reveals the price zones where institutions were quietly accumulating — these often act as support.",
  },
  {
    id: "equity_prints", surface: "equities", path: "equity-prints", scope: "underlying", timeSel: "sessionDate",
    describes: "Trade-by-trade tape across both lit and dark venues.",
  },
  {
    id: "exchange_notifications", surface: "equities", path: "exchange-notifications", scope: "underlying", timeSel: "sessionDate",
    describes: "Trade halts, IPO releases, regulatory events. A halt or regulatory event can explain a move that otherwise looks like a pure technical signal.",
  },

  // ---------------- NEWS ----------------
  {
    id: "news_articles", surface: "news", path: "news-articles", scope: "underlying", timeSel: "none",
    describes: "Ticker-tagged news articles with sentiment. Critical for separating 'the signal predicted it' from 'a news headline caused it, and no signal could have known'.",
  },
];

// Endpoints that describe ONE specific option contract. Only fetched when the
// user is analyzing an options trade (they require a strike/expiry/type), which
// is why they are kept out of the main list above rather than always-fetched.
export const QD_CONTRACT_ENDPOINTS = [
  {
    id: "option_price_over_time", surface: "options", path: "option-price-over-time", scope: "contract", timeSel: "sessionDate",
    describes: "OHLC and volume bars for ONE specific option contract. This is what makes options P&L backtesting possible: it tells us what the contract was actually worth at any moment.",
  },
];
