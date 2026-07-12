// THE COMPLETE METRIC VOCABULARY — all 30 feeds, expressible in rules.
//
// THE PROBLEM THIS SOLVES:
// The models reason over all 30 feeds, but could only ENCODE rules using 6.
// GEX walls, OI change, skew, term structure, dark-pool support — all things
// the models kept reaching for and could not express. So the backtest could
// never test the ideas they actually had. That is a hole straight through the
// middle of the system.
//
// THE KEY DISTINCTION (this is not a limitation, it is how markets work):
//
//   BAR metrics   — minute-by-minute series (6 feeds). These are TRIGGERS:
//                   they answer "at what moment do I enter?" Compared in SIGMA
//                   (z-score vs that session's own trailing baseline), because
//                   "unusual" only means anything relative to a baseline.
//
//   SESSION metrics — one scalar per day (24 feeds). These are REGIME GATES:
//                   they answer "is today the kind of day I should trade at
//                   all?" Compared as RAW values, because a gamma wall or a
//                   call/put ratio is a standing structure, not an event.
//
// A gamma wall is not a moment. Open interest is not a moment. Asking "when did
// GEX spike?" is a category error. The right question is "given that dealers
// are short gamma today, do I take the flow trigger when it fires?" — and THAT
// is a rule this vocabulary can now express and backtest.

const NY_TZ = "America/New_York";

function num(x) { return Number.isFinite(Number(x)) ? Number(x) : null; }
function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
function safeDiv(a, b) { return b ? a / b : null; }

// Pulls the strike->exposure map out of the greek-exposure endpoints, which
// nest as: data -> TICKER -> exposureMap -> sessionDate -> strike -> {call,put}
function exposureStrikes(result) {
  const perTicker = result?.data?.data;
  if (!perTicker) return null;
  const first = Object.values(perTicker)[0];
  const map = first?.exposureMap;
  if (!map) return null;
  const firstDate = Object.keys(map)[0];
  return map[firstDate] || null;
}

function netExposure(strikes) {
  if (!strikes) return null;
  return sum(Object.values(strikes).map((v) => (v.callExposure || 0) + (v.putExposure || 0)));
}

// ---------------------------------------------------------------------------
// BAR METRICS — minute series. Each entry is either a plain function, or
// { fn, diff: true } meaning the series is CUMULATIVE and must be differenced
// before z-scoring.
//
// WHY `diff` MATTERS (a bug caught in verification):
// net_flow.callSum read 5.86B mid-session while the ENTIRE day's call premium
// was 1.96B — because it is a running total, not a per-minute reading.
// Z-scoring a monotonically rising series is meaningless: it says "later in the
// day is always more extreme", so any rule built on it fires every afternoon by
// construction and looks like a signal when it is just a clock. Differencing
// turns the running total into the per-minute FLOW, which is the thing traders
// actually watch and the only version that can carry information.
export const BAR_METRICS = {
  net_drift: {
    netCallPremium: (v) => num(v.netCallPremium),
    netPutPremium: (v) => num(v.netPutPremium),
    netCallVolume: (v) => num(v.netCallVolume),
    netPutVolume: (v) => num(v.netPutVolume),
  },
  net_flow: {
    // All cumulative -> differenced into per-minute flow.
    callSum: { fn: (v) => num(v.callSum), diff: true },
    putSum: { fn: (v) => num(v.putSum), diff: true },
    net_premium: { fn: (v) => num(v.callSum) - num(v.putSum), diff: true },
  },
  dark_flow: {
    notionalValue: (v) => num(v.notionalValue),
    size: (v) => num(v.size),
    tradeCount: (v) => num(v.tradeCount),
  },
  volatility_drift: {
    iv: (v) => num(v.iv),
    arv: (v) => num(v.arv),
    // Realized above implied => the options market UNDERPRICED the move.
    iv_minus_realized: (v) => num(v.iv) - num(v.arv),
  },
  interval_map: {
    // bucket -> expiry -> strike -> {CALL, PUT}; collapse to one net number.
    net_gamma_exposure: (v) => {
      let net = 0;
      for (const byStrike of Object.values(v || {})) {
        for (const leg of Object.values(byStrike || {})) {
          net += (leg.CALL || 0) + (leg.PUT || 0);
        }
      }
      return net;
    },
  },
  stock_price_over_time: {
    closePrice: (v) => num(v.closePrice),
  },
  option_price_over_time: {
    closePrice: (v) => num(v.closePrice),
    volume: (v) => num(v.volume),
  },
};

// Normalizes a BAR_METRICS entry into { fn, diff }.
export function barMetricSpec(feed, metric) {
  const entry = BAR_METRICS[feed]?.[metric];
  if (!entry) return null;
  return typeof entry === "function" ? { fn: entry, diff: false } : { fn: entry.fn, diff: !!entry.diff };
}

// ---------------------------------------------------------------------------
// SESSION METRICS — one scalar per day. Raw values, used as regime gates.
// Each receives (result, ctx) where ctx.spot is the session's closing price.
// ---------------------------------------------------------------------------
export const SESSION_METRICS = {
  contract_statistics: {
    call_premium: (r) => num(r.data?.data?.CALL?.premium),
    put_premium: (r) => num(r.data?.data?.PUT?.premium),
    call_put_premium_ratio: (r) => safeDiv(num(r.data?.data?.CALL?.premium), num(r.data?.data?.PUT?.premium)),
    call_volume: (r) => num(r.data?.data?.CALL?.volume),
    put_volume: (r) => num(r.data?.data?.PUT?.volume),
    call_put_volume_ratio: (r) => safeDiv(num(r.data?.data?.CALL?.volume), num(r.data?.data?.PUT?.volume)),
  },

  contract_trade_side_statistics: {
    // Premium LIFTED at/above the ask = aggressive buyers paying up. Premium hit
    // at/below the bid = sellers. Raw volume cannot distinguish these, and the
    // distinction is the single most important nuance in options flow.
    call_aggressive_premium: (r) => {
      const c = r.data?.data?.CALL || {};
      return (c.ASK?.premium || 0) + (c.ABOVE_ASK?.premium || 0);
    },
    call_passive_premium: (r) => {
      const c = r.data?.data?.CALL || {};
      return (c.BID?.premium || 0) + (c.BELOW_BID?.premium || 0);
    },
    call_aggression_ratio: (r) => {
      const c = r.data?.data?.CALL || {};
      const aggr = (c.ASK?.premium || 0) + (c.ABOVE_ASK?.premium || 0);
      const pass = (c.BID?.premium || 0) + (c.BELOW_BID?.premium || 0);
      return safeDiv(aggr, pass);
    },
    put_aggression_ratio: (r) => {
      const p = r.data?.data?.PUT || {};
      const aggr = (p.ASK?.premium || 0) + (p.ABOVE_ASK?.premium || 0);
      const pass = (p.BID?.premium || 0) + (p.BELOW_BID?.premium || 0);
      return safeDiv(aggr, pass);
    },
  },

  order_flow_consolidated: {
    max_block_premium: (r) => {
      const rows = Object.values(r.data?.data || {}).filter((x) => x?.premium);
      return rows.length ? Math.max(...rows.map((x) => x.premium)) : 0;
    },
    call_block_premium: (r) => sum(Object.values(r.data?.data || {}).filter((x) => x?.contractType === "CALL").map((x) => x.premium || 0)),
    put_block_premium: (r) => sum(Object.values(r.data?.data || {}).filter((x) => x?.contractType === "PUT").map((x) => x.premium || 0)),
    block_count: (r) => Object.values(r.data?.data || {}).filter((x) => x?.premium).length,
  },

  order_flow_unconsolidated: {
    print_count: (r) => Object.values(r.data?.data || {}).filter((x) => x?.premium).length,
    max_print_premium: (r) => {
      const rows = Object.values(r.data?.data || {}).filter((x) => x?.premium);
      return rows.length ? Math.max(...rows.map((x) => x.premium)) : 0;
    },
  },

  gainers_losers: {
    // Market-wide context: was this name unusually active vs everything else?
    premium_ratio: (r) => num(Object.values(r.data?.data || {})[0]?.premiumRatio),
    bullish_premium: (r) => num(Object.values(r.data?.data || {})[0]?.bullishPremium),
    bearish_premium: (r) => num(Object.values(r.data?.data || {})[0]?.bearishPremium),
    total_premium: (r) => num(Object.values(r.data?.data || {})[0]?.premium),
    trade_count: (r) => num(Object.values(r.data?.data || {})[0]?.tradeCount),
  },

  market_share: {
    exchange_count: (r) => Object.keys(r.data?.data || {}).length,
    top_exchange_call_premium: (r) => {
      const vals = Object.values(r.data?.data || {}).map((v) => v.equityCallPremium || 0);
      return vals.length ? Math.max(...vals) : 0;
    },
  },

  // ---- Dealer exposure (GEX / DEX / VEX / CHEX) — the regime gates ----
  exposure_by_strike_gamma: {
    // POSITIVE net gamma => dealers dampen moves (price pins/chops).
    // NEGATIVE net gamma => dealers amplify moves (price trends and extends).
    // This is arguably the single most useful regime filter in the whole system.
    net_gamma: (r) => netExposure(exposureStrikes(r)),
    call_gamma: (r) => {
      const s = exposureStrikes(r);
      return s ? sum(Object.values(s).map((v) => v.callExposure || 0)) : null;
    },
    put_gamma: (r) => {
      const s = exposureStrikes(r);
      return s ? sum(Object.values(s).map((v) => v.putExposure || 0)) : null;
    },
    // How far (%) is spot from the biggest call-gamma wall? A wall just overhead
    // is resistance; price far from any wall has room to run.
    call_wall_distance_pct: (r, ctx) => {
      const s = exposureStrikes(r);
      if (!s || !ctx?.spot) return null;
      const walls = Object.entries(s)
        .map(([k, v]) => ({ strike: parseFloat(k), exp: v.callExposure || 0 }))
        .filter((x) => x.exp > 0);
      if (!walls.length) return null;
      const biggest = walls.reduce((a, b) => (b.exp > a.exp ? b : a));
      return ((biggest.strike - ctx.spot) / ctx.spot) * 100;
    },
    put_wall_distance_pct: (r, ctx) => {
      const s = exposureStrikes(r);
      if (!s || !ctx?.spot) return null;
      const walls = Object.entries(s)
        .map(([k, v]) => ({ strike: parseFloat(k), exp: Math.abs(v.putExposure || 0) }))
        .filter((x) => x.exp > 0);
      if (!walls.length) return null;
      const biggest = walls.reduce((a, b) => (b.exp > a.exp ? b : a));
      return ((biggest.strike - ctx.spot) / ctx.spot) * 100;
    },
  },

  exposure_by_strike_delta: {
    net_delta: (r) => netExposure(exposureStrikes(r)),
  },
  exposure_by_strike_vanna: {
    net_vanna: (r) => netExposure(exposureStrikes(r)),
  },
  exposure_by_strike_charm: {
    net_charm: (r) => netExposure(exposureStrikes(r)),
  },
  exposure_by_expiration_gamma: {
    front_expiry_gamma: (r) => netExposure(exposureStrikes(r)),
  },

  heat_map: {
    net_heat: (r) => {
      const d = r.data?.data;
      if (!d) return null;
      let net = 0;
      for (const byStrike of Object.values(d)) {
        for (const cell of Object.values(byStrike || {})) {
          net += (cell.callValue || 0) - (cell.putValue || 0);
        }
      }
      return net;
    },
    max_call_cell: (r) => {
      const d = r.data?.data;
      if (!d) return null;
      let mx = 0;
      for (const byStrike of Object.values(d)) {
        for (const cell of Object.values(byStrike || {})) mx = Math.max(mx, cell.callValue || 0);
      }
      return mx;
    },
  },

  max_pain_over_time: {
    front_max_pain: (r) => {
      const d = r.data?.data;
      const first = d ? Object.values(d)[0] : null;
      return num(first);
    },
    // Price tends to gravitate TOWARD max pain into expiry. Negative = spot is
    // above max pain (gravity pulls down); positive = below (pulls up).
    max_pain_distance_pct: (r, ctx) => {
      const d = r.data?.data;
      const mp = d ? num(Object.values(d)[0]) : null;
      if (mp == null || !ctx?.spot) return null;
      return ((mp - ctx.spot) / ctx.spot) * 100;
    },
  },

  open_interest_by_strike: {
    total_call_oi: (r) => sum(Object.values(r.data?.data || {}).map((v) => v.callOpenInterest || 0)),
    total_put_oi: (r) => sum(Object.values(r.data?.data || {}).map((v) => v.putOpenInterest || 0)),
    call_put_oi_ratio: (r) => safeDiv(
      sum(Object.values(r.data?.data || {}).map((v) => v.callOpenInterest || 0)),
      sum(Object.values(r.data?.data || {}).map((v) => v.putOpenInterest || 0)),
    ),
  },

  open_interest_by_expiration: {
    front_expiry_call_oi: (r) => num(Object.values(r.data?.data || {})[0]?.callOpenInterest),
    front_expiry_put_oi: (r) => num(Object.values(r.data?.data || {})[0]?.putOpenInterest),
  },

  open_interest_change: {
    // OI RISING alongside volume = NEW positions being opened.
    // OI FALLING = existing positions being closed. Volume alone can't tell you.
    net_oi_change: (r) => sum(Object.values(r.data?.data || {}).map((v) => v.changeInOpenInterest || 0)),
    call_oi_change: (r) => sum(Object.values(r.data?.data || {}).filter((v) => v.contractType === "CALL").map((v) => v.changeInOpenInterest || 0)),
    put_oi_change: (r) => sum(Object.values(r.data?.data || {}).filter((v) => v.contractType === "PUT").map((v) => v.changeInOpenInterest || 0)),
  },

  open_interest_over_time: {
    // Is positioning BUILDING over days, or was it a one-day blip?
    call_oi_5d_change_pct: (r) => {
      const entries = Object.entries(r.data?.data || {}).sort();
      if (entries.length < 6) return null;
      const recent = entries.slice(-6);
      const first = recent[0][1].callOpenInterest, last = recent[recent.length - 1][1].callOpenInterest;
      return first ? ((last - first) / first) * 100 : null;
    },
    put_oi_5d_change_pct: (r) => {
      const entries = Object.entries(r.data?.data || {}).sort();
      if (entries.length < 6) return null;
      const recent = entries.slice(-6);
      const first = recent[0][1].putOpenInterest, last = recent[recent.length - 1][1].putOpenInterest;
      return first ? ((last - first) / first) * 100 : null;
    },
  },

  volatility_skew: {
    // Upside IV above downside IV = the market is paying up for CALLS rather
    // than protection. A meaningful regime tell.
    skew_call_minus_put: (r) => {
      const d = r.data?.data;
      const spot = num(r.data?.stockPrice);
      if (!d || !spot) return null;
      const firstExp = Object.keys(d)[0];
      const near = Object.entries(d[firstExp] || {})
        .map(([k, v]) => ({ strike: parseFloat(k), call: v.CALL, put: v.PUT }))
        // Within 10% of spot, and rejecting numerically unstable deep-ITM IVs
        // (one strike was reporting 463% IV, which would swamp any average).
        .filter((x) => Math.abs(x.strike - spot) / spot < 0.1);
      const calls = near.map((x) => x.call).filter((x) => Number.isFinite(x) && x > 0 && x < 300);
      const puts = near.map((x) => x.put).filter((x) => Number.isFinite(x) && x > 0 && x < 300);
      if (!calls.length || !puts.length) return null;
      return (sum(calls) / calls.length) - (sum(puts) / puts.length);
    },
  },

  term_structure: {
    // Front-month IV ABOVE back-month (inverted) = market expects a near-term
    // event. A strong signal that something is coming.
    //
    // NEAR-THE-MONEY ONLY (a bug caught in verification): averaging IV across
    // ALL strikes gave front_minus_back_iv = 250, because a deep-ITM strike was
    // showing 463% IV and swamped the mean. Deep ITM/OTM implied vols are
    // numerically unstable garbage — the only IVs that carry information are the
    // ones near spot, which is what an actual trader reads.
    front_minus_back_iv: (r) => {
      const d = r.data?.data;
      const spot = num(r.data?.stockPrice);
      if (!d || !spot) return null;
      const exps = Object.keys(d).sort();
      const ivAt = (exp) => {
        const ivs = Object.entries(d[exp] || {})
          .filter(([strike]) => Math.abs(parseFloat(strike) - spot) / spot < 0.05) // within 5% of spot
          .flatMap(([, cell]) => Object.values(cell).map((x) => x.iv))
          .filter((x) => Number.isFinite(x) && x > 0 && x < 300); // reject absurd IVs
        return ivs.length ? sum(ivs) / ivs.length : null;
      };
      const front = ivAt(exps[0]), back = ivAt(exps[exps.length - 1]);
      return front != null && back != null ? front - back : null;
    },
    front_atm_iv: (r) => {
      const d = r.data?.data;
      const spot = num(r.data?.stockPrice);
      if (!d || !spot) return null;
      const exps = Object.keys(d).sort();
      const ivs = Object.entries(d[exps[0]] || {})
        .filter(([strike]) => Math.abs(parseFloat(strike) - spot) / spot < 0.05)
        .flatMap(([, cell]) => Object.values(cell).map((x) => x.iv))
        .filter((x) => Number.isFinite(x) && x > 0 && x < 300);
      return ivs.length ? sum(ivs) / ivs.length : null;
    },
  },

  dark_pool_levels: {
    total_notional: (r) => sum(Object.values(r.data?.data || {}).map((v) => v.notionalValue || 0)),
    // The heaviest dark-pool print BELOW spot — institutions accumulated there,
    // and it frequently acts as support. Distance to it is a real tradeable fact.
    dp_support_distance_pct: (r, ctx) => {
      const d = r.data?.data;
      const spot = ctx?.spot || num(r.data?.latestStockPrice);
      if (!d || !spot) return null;
      const below = Object.entries(d)
        .map(([k, v]) => ({ level: parseFloat(k), notional: v.notionalValue || 0 }))
        .filter((x) => x.level < spot);
      if (!below.length) return null;
      const heaviest = below.reduce((a, b) => (b.notional > a.notional ? b : a));
      return ((spot - heaviest.level) / spot) * 100;
    },
    dp_resistance_distance_pct: (r, ctx) => {
      const d = r.data?.data;
      const spot = ctx?.spot || num(r.data?.latestStockPrice);
      if (!d || !spot) return null;
      const above = Object.entries(d)
        .map(([k, v]) => ({ level: parseFloat(k), notional: v.notionalValue || 0 }))
        .filter((x) => x.level > spot);
      if (!above.length) return null;
      const heaviest = above.reduce((a, b) => (b.notional > a.notional ? b : a));
      return ((heaviest.level - spot) / spot) * 100;
    },
  },

  equity_prints: {
    dark_print_ratio: (r) => {
      const rows = Object.values(r.data?.data || {}).filter((x) => x?.size);
      if (!rows.length) return null;
      return rows.filter((x) => x.printType === "DARK_POOL").length / rows.length;
    },
    max_print_notional: (r) => {
      const rows = Object.values(r.data?.data || {}).filter((x) => x?.notionalValue);
      return rows.length ? Math.max(...rows.map((x) => x.notionalValue)) : 0;
    },
  },

  exchange_notifications: {
    // ZERO here is meaningful: it RULES OUT a halt or regulatory event as the
    // cause of a move, which strengthens any technical explanation.
    notification_count: (r) => Object.keys(r.data?.data || {}).length,
  },

  news_articles: {
    article_count: (r) => Object.values(r.data?.data || {}).filter((x) => x?.title).length,
    // Decisive for separating "a signal predicted it" from "a headline caused it
    // and no signal could possibly have known".
    bullish_article_count: (r) => Object.values(r.data?.data || {})
      .filter((a) => a?.tickers?.some((t) => t.sentiment === "BULLISH")).length,
    bearish_article_count: (r) => Object.values(r.data?.data || {})
      .filter((a) => a?.tickers?.some((t) => t.sentiment === "BEARISH")).length,
  },

  stock_price_over_time: {
    session_return_pct: (r) => {
      const bars = Object.entries(r.data?.data || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
      if (bars.length < 2) return null;
      const open = bars[0][1].openPrice, close = bars[bars.length - 1][1].closePrice;
      return open ? ((close - open) / open) * 100 : null;
    },
    session_range_pct: (r) => {
      const bars = Object.values(r.data?.data || {});
      if (!bars.length) return null;
      const hi = Math.max(...bars.map((b) => b.highPrice));
      const lo = Math.min(...bars.map((b) => b.lowPrice));
      return lo ? ((hi - lo) / lo) * 100 : null;
    },
  },
};

// ---------------------------------------------------------------------------
// INTRADAY GAMMA PROXIMITY — bar-level metrics derived from the strike map.
//
// CORRECTION TO AN EARLIER MISTAKE: I originally classed ALL gamma exposure as
// a session-level "gate", on the reasoning that a gamma wall is a standing
// structure rather than a moment. That was half right and half wrong, and the
// wrong half matters:
//
//   - The STRIKE LOCATIONS of the walls are built from open interest, which
//     only updates daily. Those really are near-static intraday.
//   - But DEALER GAMMA EXPOSURE AT SPOT changes every single minute, because
//     gamma is a function of where price sits RELATIVE to those strikes. Price
//     moving 665 -> 670 walks into a completely different part of the profile.
//     The wall doesn't move; the price's relationship to it moves constantly.
//
// So "is price approaching a call wall RIGHT NOW" is a genuine minute-by-minute
// trigger, and it was previously impossible to express. These metrics fix that
// by combining the (static) strike map with the (live) per-minute spot price.
// `interval_map` separately gives true time-bucketed exposure straight from the
// vendor; these complement it with proximity, which it does not provide.
// ---------------------------------------------------------------------------
export function gammaProximitySeries(gammaResult, priceBars) {
  const strikes = exposureStrikes(gammaResult);
  if (!strikes || !priceBars?.length) return {};

  const walls = Object.entries(strikes).map(([k, v]) => ({
    strike: parseFloat(k),
    call: v.callExposure || 0,
    put: v.putExposure || 0,
    net: (v.callExposure || 0) + (v.putExposure || 0),
  }));

  const callWalls = walls.filter((w) => w.call > 0);
  const putWalls = walls.filter((w) => w.put < 0);
  const biggestCall = callWalls.length ? callWalls.reduce((a, b) => (b.call > a.call ? b : a)) : null;
  const biggestPut = putWalls.length ? putWalls.reduce((a, b) => (Math.abs(b.put) > Math.abs(a.put) ? b : a)) : null;

  // Gamma "at spot": exposure concentrated in the strikes price is currently
  // sitting among. This genuinely swings minute to minute as price moves.
  const gammaAtSpot = (spot) => {
    const band = spot * 0.01; // strikes within 1% of current price
    return sum(walls.filter((w) => Math.abs(w.strike - spot) <= band).map((w) => w.net));
  };

  const out = {
    call_wall_distance_pct: [],
    put_wall_distance_pct: [],
    gamma_at_spot: [],
  };

  for (const bar of priceBars) {
    const spot = bar.value;
    if (!spot) continue;
    if (biggestCall) out.call_wall_distance_pct.push({ ts: bar.ts, value: ((biggestCall.strike - spot) / spot) * 100 });
    if (biggestPut) out.put_wall_distance_pct.push({ ts: bar.ts, value: ((spot - biggestPut.strike) / spot) * 100 });
    out.gamma_at_spot.push({ ts: bar.ts, value: gammaAtSpot(spot) });
  }
  return out;
}

export const GAMMA_PROXIMITY_METRICS = ["call_wall_distance_pct", "put_wall_distance_pct", "gamma_at_spot"];

// Flat vocabulary for validation + prompting.
export function buildVocabulary() {
  const bar = {}, session = {};
  for (const [feed, metrics] of Object.entries(BAR_METRICS)) bar[feed] = Object.keys(metrics);
  for (const [feed, metrics] of Object.entries(SESSION_METRICS)) session[feed] = Object.keys(metrics);
  // Gamma proximity is bar-level, computed from the strike map + live spot.
  bar.gamma_proximity = [...GAMMA_PROXIMITY_METRICS];
  return { bar, session };
}

// Computes every session metric for one feed bundle.
export function computeSessionMetrics(results, spot) {
  const out = {};
  for (const [feed, metrics] of Object.entries(SESSION_METRICS)) {
    const r = results[feed];
    if (!r?.ok) continue;
    for (const [name, fn] of Object.entries(metrics)) {
      try {
        const v = fn(r, { spot });
        if (Number.isFinite(v)) out[`${feed}.${name}`] = v;
      } catch { /* a metric that can't compute is simply absent, never fabricated */ }
    }
  }
  return out;
}
