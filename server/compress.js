// COMPRESSION + TIMELINE ENGINE
//
// The raw bundle is far too big to reason over: dark_pool_levels alone came
// back with 12,716 price levels, and six endpoints return ~391 one-minute
// buckets each. Dumping that into a prompt would make the models reason WORSE
// (drowning in rows), not better.
//
// So this layer does the work a good analyst does before forming a view:
//   1. Builds a single unified minute-by-minute TIMELINE across every
//      time-series endpoint, so signals from different feeds are directly
//      comparable at the same timestamp.
//   2. Detects EVENTS (statistically unusual spikes) with a z-score vs that
//      session's own rolling baseline — so "unusual" means unusual for THIS
//      name on THIS day, not an arbitrary hardcoded threshold.
//   3. Detects PRICE THRUSTS (the moves we're trying to predict).
//   4. Computes LEAD/LAG: for every price thrust, which signals fired BEFORE
//      it, and how many minutes ahead. This is the raw material for
//      "net flow spiked at 10:00, price moved at 10:10, so 10:00 was the
//      knowable entry" — computed arithmetically, never guessed by a model.
//
// Everything here is deterministic. The models get FACTS with timestamps and
// then do the reasoning. That division is the whole point: models are bad at
// arithmetic over thousands of rows and good at judgment over clean facts.

const NY_TZ = "America/New_York";

export function toClock(ts) {
  return new Date(Number(ts)).toLocaleTimeString("en-US", {
    timeZone: NY_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Regular US session only, in minutes-from-midnight NY time (09:30-16:00).
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;

function nyMinutes(ts) {
  const [h, m] = new Date(Number(ts))
    .toLocaleTimeString("en-US", { timeZone: NY_TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":").map(Number);
  return h * 60 + m;
}

// BUG FIX (found while reviewing the first real briefing): a rolling baseline
// that includes pre-market minutes makes the 09:30 opening bell look like a
// 284-sigma event, because the open is ALWAYS a volume explosion relative to
// thin pre-market. That artifact then showed up as a "precursor" to every
// early-session move — a completely spurious signal that would have poisoned
// the theses. Restricting every series to regular trading hours means
// "unusual" is measured against other regular-hours minutes, which is the
// only comparison that means anything.
export function regularHoursOnly(series) {
  return series.filter((p) => {
    const m = nyMinutes(p.ts);
    return m >= SESSION_OPEN_MIN && m <= SESSION_CLOSE_MIN;
  });
}

// BUG FIX: reading the LAST bucket of a series returned zeros, because the
// final buckets sit after the close and are empty. This takes the last bucket
// that actually has a non-zero reading.
function lastMeaningful(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].value !== 0 && Number.isFinite(series[i].value)) return series[i];
  }
  return series[series.length - 1] ?? null;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// Rolling z-score: how unusual is this bucket vs the LOOKBACK buckets before
// it? Using a trailing window (never future buckets) keeps this lookahead-free
// even when we compute it over a full session.
function rollingZScores(series, lookback = 30) {
  return series.map((pt, i) => {
    const prior = series.slice(Math.max(0, i - lookback), i).map((p) => p.value);
    if (prior.length < 5) return { ...pt, z: 0 };
    const sd = stdev(prior);
    const z = sd === 0 ? 0 : (pt.value - mean(prior)) / sd;
    return { ...pt, z };
  });
}

// Pulls a named metric out of a bucket-keyed endpoint into a clean time series.
// Regular-hours filtering is applied HERE, at the source, so every endpoint
// inherits it and no compressor can accidentally reintroduce the pre-market
// baseline artifact described above.
function seriesFrom(result, pick) {
  if (!result?.ok || !result.data?.data) return [];
  const raw = Object.entries(result.data.data)
    .map(([ts, v]) => ({ ts: Number(ts), value: pick(v) }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.ts - b.ts);
  return regularHoursOnly(raw);
}

// ---------------------------------------------------------------------------
// PRICE THRUSTS: the moves we are trying to have predicted.
// A "thrust" is a sustained move over the next `horizon` minutes that is large
// relative to the session's typical minute-to-minute noise.
// ---------------------------------------------------------------------------
export function detectPriceThrusts(priceSeries, { horizon = 15, minZ = 2.0 } = {}) {
  if (priceSeries.length < horizon + 10) return [];

  // Baseline: typical absolute move over the same horizon, this session.
  const fwdReturns = [];
  for (let i = 0; i + horizon < priceSeries.length; i++) {
    fwdReturns.push((priceSeries[i + horizon].value - priceSeries[i].value) / priceSeries[i].value);
  }
  const sd = stdev(fwdReturns);
  if (sd === 0) return [];

  const thrusts = [];
  for (let i = 0; i + horizon < priceSeries.length; i++) {
    const from = priceSeries[i], to = priceSeries[i + horizon];
    const ret = (to.value - from.value) / from.value;
    const z = ret / sd;
    if (Math.abs(z) >= minZ) {
      thrusts.push({
        startTs: from.ts, startClock: toClock(from.ts), startPrice: from.value,
        endTs: to.ts, endClock: toClock(to.ts), endPrice: to.value,
        pctMove: +(ret * 100).toFixed(2),
        direction: ret > 0 ? "UP" : "DOWN",
        z: +z.toFixed(2),
      });
    }
  }

  // Collapse overlapping thrusts into one event each (a 30-min rally shouldn't
  // report as 20 separate thrusts).
  const merged = [];
  for (const t of thrusts) {
    const last = merged[merged.length - 1];
    if (last && t.direction === last.direction && t.startTs <= last.endTs) {
      if (Math.abs(t.pctMove) > Math.abs(last.pctMove)) {
        last.endTs = t.endTs; last.endClock = t.endClock; last.endPrice = t.endPrice;
        last.pctMove = +(((t.endPrice - last.startPrice) / last.startPrice) * 100).toFixed(2);
        last.z = t.z;
      }
    } else {
      merged.push({ ...t });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// SIGNAL EVENTS: statistically unusual readings in any time-series feed.
// ---------------------------------------------------------------------------
export function detectSignalEvents(series, { endpoint, metric, minZ = 2.5 } = {}) {
  const scored = rollingZScores(series);
  return scored
    .filter((p) => Math.abs(p.z) >= minZ)
    .map((p) => ({
      ts: p.ts, clock: toClock(p.ts), endpoint, metric,
      value: +p.value.toFixed(2), z: +p.z.toFixed(2),
      direction: p.z > 0 ? "SPIKE_UP" : "SPIKE_DOWN",
    }));
}

// ---------------------------------------------------------------------------
// LEAD/LAG: for each price thrust, which signals fired BEFORE it and how far
// ahead. This is the core "was it knowable in advance?" computation.
//
// CRITICAL: only events strictly BEFORE the thrust's start are counted. An
// event at or after the thrust start is not a predictor, it's a reaction —
// and conflating the two is exactly the lookahead bias this system exists to
// avoid. leadMinutes > 0 always.
// ---------------------------------------------------------------------------
export function computeLeadLag(thrusts, events, { maxLeadMin = 90 } = {}) {
  return thrusts.map((t) => {
    const precursors = events
      .filter((e) => e.ts < t.startTs && (t.startTs - e.ts) <= maxLeadMin * 60_000)
      .map((e) => ({ ...e, leadMinutes: Math.round((t.startTs - e.ts) / 60_000) }))
      .sort((a, b) => a.leadMinutes - b.leadMinutes);

    // Which distinct feeds corroborated each other ahead of this move? A move
    // foreshadowed by 4 independent feeds is a very different claim from one
    // foreshadowed by a single noisy feed.
    const feeds = [...new Set(precursors.map((p) => p.endpoint))];

    return {
      thrust: t,
      precursorCount: precursors.length,
      corroboratingFeeds: feeds,
      corroborationScore: feeds.length,
      precursors: precursors.slice(0, 25),
    };
  });
}

// ---------------------------------------------------------------------------
// PER-ENDPOINT COMPRESSORS
//
// One entry per endpoint id in the registry. Each returns a compact summary
// object AND (where the endpoint is a time series) contributes events to the
// shared timeline. Every one of the 30 endpoints is represented — that is what
// lets the analysis layer hand each model a complete, itemized picture and
// require it to account for all 30.
// ---------------------------------------------------------------------------

// Sorts a strike/level-keyed map and returns the biggest N by some measure.
function topLevels(obj, valueOf, n = 8) {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([k, v]) => ({ level: parseFloat(k), value: valueOf(v) }))
    .filter((x) => Number.isFinite(x.value) && x.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, n);
}

function firstExpiryMap(result) {
  const per = result?.data?.data?.[Object.keys(result.data.data)[0]];
  const map = per?.exposureMap;
  if (!map) return null;
  const firstDate = Object.keys(map)[0];
  return { date: firstDate, strikes: map[firstDate] };
}

export const COMPRESSORS = {
  // ---- Time-series feeds (these drive the timeline) ----
  stock_price_over_time: (r) => {
    const s = seriesFrom(r, (v) => v.closePrice);
    if (!s.length) return { summary: "No price data.", series: [] };
    const open = s[0].value, close = s[s.length - 1].value;
    const high = Math.max(...s.map((p) => p.value)), low = Math.min(...s.map((p) => p.value));
    return {
      summary: `Session ${toClock(s[0].ts)}-${toClock(s[s.length - 1].ts)}: open ${open.toFixed(2)}, high ${high.toFixed(2)}, low ${low.toFixed(2)}, close ${close.toFixed(2)}, net ${(((close - open) / open) * 100).toFixed(2)}%.`,
      series: s,
    };
  },

  net_flow: (r) => {
    const call = seriesFrom(r, (v) => v.callSum);
    const put = seriesFrom(r, (v) => v.putSum);
    // Net = call premium minus put premium. Its CHANGE per minute is the
    // "flow spike" traders actually watch, not the cumulative level.
    const net = call.map((c, i) => ({ ts: c.ts, value: c.value - (put[i]?.value ?? 0) }));
    const deltas = net.slice(1).map((p, i) => ({ ts: p.ts, value: p.value - net[i].value }));
    const events = detectSignalEvents(deltas, { endpoint: "net_flow", metric: "net premium change/min" });
    const last = lastMeaningful(net);
    const peak = net.length ? net.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a)) : null;
    return {
      summary: `Net call-minus-put premium finished at ${last ? (last.value / 1e6).toFixed(1) : "?"}M; largest reading ${peak ? (peak.value / 1e6).toFixed(1) : "?"}M at ${peak ? toClock(peak.ts) : "?"}. ${events.length} unusual minute-over-minute flow spikes detected.`,
      events,
    };
  },

  net_drift: (r) => {
    const netCall = seriesFrom(r, (v) => v.netCallPremium);
    const netPut = seriesFrom(r, (v) => v.netPutPremium);
    const events = [
      ...detectSignalEvents(netCall, { endpoint: "net_drift", metric: "netCallPremium" }),
      ...detectSignalEvents(netPut, { endpoint: "net_drift", metric: "netPutPremium" }),
    ];
    // Use the last MEANINGFUL bucket, not the literal last one — trailing
    // post-close buckets are empty and were reporting a bogus "0.00M vs 0.00M".
    const lastC = lastMeaningful(netCall)?.value ?? 0;
    const lastP = lastMeaningful(netPut)?.value ?? 0;
    const peakC = netCall.length ? Math.max(...netCall.map((p) => p.value)) : 0;
    return {
      summary: `Final netCallPremium ${(lastC / 1e6).toFixed(2)}M vs netPutPremium ${(lastP / 1e6).toFixed(2)}M (${Math.abs(lastC) > Math.abs(lastP) ? "call-dominant" : "put-dominant"}); intraday peak call drift ${(peakC / 1e6).toFixed(2)}M. ${events.length} unusual drift spikes.`,
      events,
    };
  },

  volatility_drift: (r) => {
    const iv = seriesFrom(r, (v) => v.iv);
    const arv = seriesFrom(r, (v) => v.arv);
    const events = detectSignalEvents(iv, { endpoint: "volatility_drift", metric: "implied vol" });
    const lastIv = lastMeaningful(iv)?.value, lastArv = lastMeaningful(arv)?.value;
    return {
      // Realized running ABOVE implied means options were underpriced for the
      // move that actually happened — a tell that the move was not anticipated.
      summary: lastIv != null
        ? `Ended IV ${lastIv.toFixed(1)} vs realized ${lastArv?.toFixed(1)}. ${lastArv > lastIv ? "Realized EXCEEDED implied (move was underpriced by the options market)." : "Implied above realized (options priced in more than actually happened)."} ${events.length} IV spikes.`
        : "No volatility data.",
      events,
    };
  },

  dark_flow: (r) => {
    const notional = seriesFrom(r, (v) => v.notionalValue);
    const events = detectSignalEvents(notional, { endpoint: "dark_flow", metric: "dark pool notional" });
    const total = notional.reduce((a, b) => a + b.value, 0);
    return {
      summary: `Total off-exchange notional ${(total / 1e6).toFixed(1)}M across ${notional.length} buckets. ${events.length} unusual dark-pool bursts.`,
      events,
    };
  },

  interval_map: (r) => {
    // Bucket -> expiry -> strike -> {CALL, PUT}. Collapse to net exposure/min.
    const s = seriesFrom(r, (v) => {
      let net = 0;
      for (const byStrike of Object.values(v || {})) {
        for (const leg of Object.values(byStrike || {})) {
          net += (leg.CALL || 0) + (leg.PUT || 0);
        }
      }
      return net;
    });
    const events = detectSignalEvents(s, { endpoint: "interval_map", metric: "net gamma exposure" });
    return {
      summary: `Intraday gamma map tracked across ${s.length} buckets. ${events.length} significant shifts in dealer gamma positioning.`,
      events,
    };
  },
};

// ---- Snapshot feeds (no timeline; they describe positioning/state) ----
// These do NOT emit timeline events. That's not a defect: a gamma wall is a
// standing structure, not a moment. A model is expected to say so, and to say
// plainly when such a feed had no bearing on the move.

Object.assign(COMPRESSORS, {
  exposure_by_strike_gamma: (r) => {
    const m = firstExpiryMap(r);
    if (!m) return { summary: "No gamma exposure data." };
    const calls = topLevels(m.strikes, (v) => v.callExposure || 0, 5);
    const puts = topLevels(m.strikes, (v) => v.putExposure || 0, 5);
    const netByStrike = Object.entries(m.strikes).map(([k, v]) => ({ strike: parseFloat(k), net: (v.callExposure || 0) + (v.putExposure || 0) }));
    const totalNet = netByStrike.reduce((a, b) => a + b.net, 0);
    return {
      summary: `GEX (exp ${m.date}): net gamma ${totalNet.toFixed(0)} (${totalNet >= 0 ? "POSITIVE gamma — dealers dampen moves, price tends to pin/chop" : "NEGATIVE gamma — dealers amplify moves, price tends to trend and extend"}). Largest call-gamma walls: ${calls.map((c) => `${c.level}(${c.value.toFixed(0)})`).join(", ")}. Largest put-gamma: ${puts.map((p) => `${p.level}(${p.value.toFixed(0)})`).join(", ")}.`,
    };
  },
  exposure_by_strike_delta: (r) => {
    const m = firstExpiryMap(r);
    if (!m) return { summary: "No delta exposure data." };
    const top = topLevels(m.strikes, (v) => (v.callExposure || 0) + (v.putExposure || 0), 6);
    return { summary: `DEX (exp ${m.date}): heaviest net delta at strikes ${top.map((t) => `${t.level}(${(t.value / 1e6).toFixed(1)}M)`).join(", ")}.` };
  },
  exposure_by_strike_vanna: (r) => {
    const m = firstExpiryMap(r);
    if (!m) return { summary: "No vanna exposure data." };
    const top = topLevels(m.strikes, (v) => (v.callExposure || 0) + (v.putExposure || 0), 5);
    return { summary: `VEX (exp ${m.date}): dealer delta most sensitive to IV shifts at strikes ${top.map((t) => t.level).join(", ")}.` };
  },
  exposure_by_strike_charm: (r) => {
    const m = firstExpiryMap(r);
    if (!m) return { summary: "No charm exposure data." };
    const top = topLevels(m.strikes, (v) => (v.callExposure || 0) + (v.putExposure || 0), 5);
    return { summary: `CHEX (exp ${m.date}): time-decay-driven dealer delta drift concentrated at strikes ${top.map((t) => t.level).join(", ")}.` };
  },
  exposure_by_expiration_gamma: (r) => {
    const m = firstExpiryMap(r);
    if (!m) return { summary: "No exposure-by-expiration data." };
    return { summary: `Gamma exposure by expiration, nearest expiry ${m.date} carrying ${Object.keys(m.strikes).length} active strikes.` };
  },

  open_interest_by_strike: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No open interest data." };
    const calls = topLevels(d, (v) => v.callOpenInterest, 5);
    const puts = topLevels(d, (v) => v.putOpenInterest, 5);
    return { summary: `Open interest parked heaviest — CALLS at ${calls.map((c) => `${c.level}(${c.value})`).join(", ")}; PUTS at ${puts.map((p) => `${p.level}(${p.value})`).join(", ")}. These are standing positions, not today's churn.` };
  },
  open_interest_by_expiration: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No OI-by-expiration data." };
    const top = Object.entries(d).map(([k, v]) => ({ exp: k, oi: (v.callOpenInterest || 0) + (v.putOpenInterest || 0), c: v.callOpenInterest, p: v.putOpenInterest }))
      .sort((a, b) => b.oi - a.oi).slice(0, 4);
    return { summary: `Heaviest OI expirations: ${top.map((t) => `${t.exp} (${t.c}C/${t.p}P)`).join("; ")}.` };
  },
  open_interest_change: (r) => {
    const rows = Object.values(r?.data?.data || {});
    if (!rows.length) return { summary: "No OI-change records." };
    const movers = rows.filter((x) => Math.abs(x.changeInOpenInterest) > 0)
      .sort((a, b) => Math.abs(b.changeInOpenInterest) - Math.abs(a.changeInOpenInterest)).slice(0, 6);
    return {
      // OI *rising* alongside volume = NEW positions opening. OI falling =
      // positions being closed. Volume alone cannot distinguish these.
      summary: movers.length
        ? `Biggest day-over-day open-interest changes (NEW positioning vs closing): ${movers.map((m) => `${m.strikePrice}${m.contractType[0]} ${m.expirationDate} ${m.changeInOpenInterest > 0 ? "+" : ""}${m.changeInOpenInterest}`).join("; ")}.`
        : "No meaningful open-interest changes in the sampled page.",
    };
  },
  open_interest_over_time: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No OI history." };
    const entries = Object.entries(d).sort();
    const recent = entries.slice(-10);
    const first = recent[0], last = recent[recent.length - 1];
    const callDelta = last[1].callOpenInterest - first[1].callOpenInterest;
    return {
      summary: `OI history spans ${entries.length} sessions (${entries[0][0]} to ${entries[entries.length - 1][0]}). Over last 10 sessions call OI ${callDelta >= 0 ? "BUILT" : "DECLINED"} by ${Math.abs(callDelta).toLocaleString()} — tells you whether positioning was accumulating over days or was a one-day blip.`,
    };
  },

  volatility_skew: (r) => {
    const d = r?.data?.data;
    const spot = r?.data?.stockPrice;
    if (!d) return { summary: "No skew data." };
    const firstExp = Object.keys(d)[0];
    const strikes = d[firstExp] || {};
    const near = Object.entries(strikes)
      .map(([k, v]) => ({ strike: parseFloat(k), call: v.CALL, put: v.PUT }))
      .filter((x) => spot && Math.abs(x.strike - spot) / spot < 0.1)
      .sort((a, b) => a.strike - b.strike);
    const otmPut = near[0], otmCall = near[near.length - 1];
    return {
      summary: `Skew (exp ${firstExp}, spot ${spot?.toFixed(2)}): near-money IV ranges roughly ${otmPut?.put?.toFixed(0) ?? "?"} (downside) to ${otmCall?.call?.toFixed(0) ?? "?"} (upside). Upside IV above downside IV means the market is paying up for CALLS, not protection.`,
    };
  },
  term_structure: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No term structure." };
    const exps = Object.keys(d).sort();
    const ivAt = (exp) => {
      const cells = Object.values(d[exp] || {});
      const ivs = cells.flatMap((c) => Object.values(c).map((x) => x.iv)).filter(Number.isFinite);
      return ivs.length ? mean(ivs) : null;
    };
    const front = ivAt(exps[0]), back = ivAt(exps[exps.length - 1]);
    return {
      summary: `Term structure across ${exps.length} expirations. Front (${exps[0]}) avg IV ${front?.toFixed(1)} vs back (${exps[exps.length - 1]}) ${back?.toFixed(1)}. ${front > back ? "INVERTED (front > back) — market expects a near-term event." : "Normal upward slope."}`,
    };
  },

  contract_statistics: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No contract statistics." };
    const c = d.CALL || {}, p = d.PUT || {};
    const ratio = p.premium ? (c.premium / p.premium) : null;
    return { summary: `Call premium ${((c.premium || 0) / 1e6).toFixed(1)}M (${c.volume?.toLocaleString()} contracts) vs Put ${((p.premium || 0) / 1e6).toFixed(1)}M (${p.volume?.toLocaleString()}). Call/put premium ratio ${ratio?.toFixed(2)} — ${ratio > 1.2 ? "call-heavy" : ratio < 0.8 ? "put-heavy" : "balanced"}.` };
  },
  contract_trade_side_statistics: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No trade-side data." };
    const fmt = (leg) => {
      const x = d[leg] || {};
      const aggressive = (x.ASK?.premium || 0) + (x.ABOVE_ASK?.premium || 0);
      const passive = (x.BID?.premium || 0) + (x.BELOW_BID?.premium || 0);
      return `${leg}: ${(aggressive / 1e6).toFixed(1)}M lifted at/above ASK (aggressive BUYING) vs ${(passive / 1e6).toFixed(1)}M hit at/below BID (SELLING)`;
    };
    return {
      // This is the single most important nuance in options flow: raw volume
      // cannot tell you whether premium was BOUGHT or SOLD. This can.
      summary: `${fmt("CALL")}. ${fmt("PUT")}. Premium lifted at the ask = someone paying up, a far stronger signal than raw volume.`,
    };
  },
  order_flow_consolidated: (r) => {
    const rows = Object.values(r?.data?.data || {}).filter((x) => x && x.premium);
    if (!rows.length) return { summary: "No consolidated order flow rows returned." };
    const top = rows.sort((a, b) => (b.premium || 0) - (a.premium || 0)).slice(0, 6);
    return {
      summary: `Largest blocks/sweeps: ${top.map((t) => `${t.strikePrice ?? "?"}${(t.contractType || "?")[0]} ${t.expirationDate ?? ""} $${((t.premium || 0) / 1000).toFixed(0)}K${t.tradeSide ? ` @${t.tradeSide}` : ""}${t.sentimentType ? ` (${t.sentimentType})` : ""}`).join("; ")}.`,
      rows: top,
    };
  },
  order_flow_unconsolidated: (r) => {
    const rows = Object.values(r?.data?.data || {}).filter((x) => x && x.premium);
    return { summary: rows.length ? `Raw tape: ${rows.length} prints in sampled page; largest $${(Math.max(...rows.map((x) => x.premium || 0)) / 1000).toFixed(0)}K.` : "No raw tape rows." };
  },
  gainers_losers: (r) => {
    const d = r?.data?.data;
    const t = d ? Object.values(d)[0] : null;
    if (!t) return { summary: "No gainers/losers entry for this ticker." };
    return { summary: `Market-wide context: bullish premium ${(t.bullishPremium / 1e6).toFixed(0)}M vs bearish ${(t.bearishPremium / 1e6).toFixed(0)}M (ratio ${t.premiumRatio?.toFixed(2)}), total ${(t.premium / 1e6).toFixed(0)}M across ${t.tradeCount?.toLocaleString()} trades.` };
  },
  market_share: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No market share data." };
    return { summary: `Volume spread across ${Object.keys(d).length} exchanges. Mostly venue-routing colour; rarely predictive on its own.` };
  },
  heat_map: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No heat map." };
    const exps = Object.keys(d);
    const firstExp = exps[0];
    const cells = topLevels(d[firstExp], (v) => (v.callValue || 0) - (v.putValue || 0), 5);
    return { summary: `Chain activity concentrated (exp ${firstExp}) at strikes ${cells.map((c) => `${c.level}(${c.value > 0 ? "call" : "put"}-side ${(Math.abs(c.value) / 1e6).toFixed(1)}M)`).join(", ")}.` };
  },
  max_pain_over_time: (r) => {
    const d = r?.data?.data;
    if (!d) return { summary: "No max pain data." };
    const entries = Object.entries(d).slice(0, 4);
    return { summary: `Max-pain strike by expiration: ${entries.map(([e, v]) => `${e}=${v}`).join(", ")}. Price often gravitates toward max pain into expiry.` };
  },

  dark_pool_levels: (r) => {
    const d = r?.data?.data;
    const spot = r?.data?.latestStockPrice;
    if (!d) return { summary: "No dark pool levels." };
    const levels = topLevels(d, (v) => v.notionalValue, 8);
    const totalNotional = Object.values(d).reduce((a, v) => a + (v.notionalValue || 0), 0);
    return {
      // These accumulation zones frequently act as support/resistance — a
      // heavy dark-pool level BELOW spot is a floor institutions defended.
      summary: `Dark-pool accumulation zones (spot ${spot?.toFixed(2)}): heaviest prints at ${levels.map((l) => `$${l.level} (${(l.value / 1e6).toFixed(1)}M)`).join(", ")}. Total ${(totalNotional / 1e9).toFixed(2)}B across ${Object.keys(d).length} levels. Levels below spot often act as institutional support.`,
    };
  },
  equity_prints: (r) => {
    const rows = Object.values(r?.data?.data || {}).filter((x) => x && x.size);
    if (!rows.length) return { summary: "No equity prints." };
    const dark = rows.filter((x) => x.printType === "DARK_POOL");
    const biggest = rows.sort((a, b) => (b.notionalValue || 0) - (a.notionalValue || 0))[0];
    return { summary: `${rows.length} prints sampled, ${dark.length} dark. Largest single print $${((biggest.notionalValue || 0) / 1e6).toFixed(2)}M at ${biggest.price} (${biggest.tradeSide}).` };
  },
  exchange_notifications: (r) => {
    const n = Object.keys(r?.data?.data || {}).length;
    return {
      // Empty here is genuinely meaningful: it RULES OUT a halt/regulatory
      // event as the cause, which strengthens any technical explanation.
      summary: n === 0
        ? "No halts, IPO releases, or regulatory events for this session. This RULES OUT an exchange-level event as the cause of any move."
        : `${n} exchange notifications this session — check whether one explains the move.`,
    };
  },
  news_articles: (r) => {
    const rows = Object.values(r?.data?.data || {}).filter((x) => x && x.title);
    if (!rows.length) return { summary: "No news articles." };
    const relevant = rows.slice(0, 6);
    return {
      // Decisive for separating "a signal predicted it" from "a headline caused
      // it and NO signal could have known in advance".
      summary: `Recent headlines: ${relevant.map((a) => `[${new Date(a.publishedTime).toISOString().slice(0, 16)}] ${a.title.slice(0, 90)}`).join(" | ")}. Use these to separate a predictable flow-driven move from an unpredictable news shock.`,
      rows: relevant.map((a) => ({ ts: a.publishedTime, clock: toClock(a.publishedTime), title: a.title })),
    };
  },
  option_price_over_time: (r) => {
    const s = seriesFrom(r, (v) => v.closePrice);
    if (!s.length) return { summary: "No contract price data." };
    const open = s[0].value, close = s[s.length - 1].value;
    const high = Math.max(...s.map((p) => p.value));
    return { summary: `Contract price: opened ${open.toFixed(2)}, high ${high.toFixed(2)}, closed ${close.toFixed(2)} (${(((close - open) / open) * 100).toFixed(1)}% on the session). This is the actual P&L instrument.`, series: s };
  },
});

// ---------------------------------------------------------------------------
// THE BRIEFING: assembles everything into what the models actually receive.
//
// Guarantees, enforced here in code rather than hoped for in a prompt:
//   - EVERY endpoint in the registry appears in `endpoints`, with its fetch
//     status. A model cannot silently skip one, because the briefing itself
//     enumerates all 30 and the response schema requires a note on each.
//   - A failed fetch is labelled FAILED, never silently treated as "nothing
//     there". Absence of data and absence of signal are different claims.
//   - The timeline is pre-computed, so "flow spiked at 10:00, price moved at
//     10:10" is arithmetic we did, not a story a model invented.
// ---------------------------------------------------------------------------

import { QD_ENDPOINTS, QD_CONTRACT_ENDPOINTS } from "./quantDataRegistry.js";
import { BAR_METRICS, barMetricSpec, computeSessionMetrics, gammaProximitySeries } from "./metrics.js";

function eventsForAllBarMetrics(results, priceSeries) {
  let all = [];
  for (const [feed, metrics] of Object.entries(BAR_METRICS)) {
    const r = results[feed];
    if (!r?.ok) continue;
    // Price series are the P&L instruments, not signals.
    if (feed === "stock_price_over_time" || feed === "option_price_over_time") continue;

    for (const metric of Object.keys(metrics)) {
      const spec = barMetricSpec(feed, metric);
      if (!spec) continue;
      let series = seriesFrom(r, spec.fn);
      // Cumulative series must be differenced first — z-scoring a running total
      // just says "later in the day is more extreme", which is a clock, not a
      // signal. See the note in metrics.js.
      if (spec.diff) {
        series = series.slice(1).map((p, i) => ({ ts: p.ts, value: p.value - series[i].value }));
      }
      all = all.concat(detectSignalEvents(series, { endpoint: feed, metric }));
    }
  }

  // INTRADAY GAMMA PROXIMITY. Gamma-at-spot and distance-to-wall change every
  // minute as price moves through the strike map, even though the strikes
  // themselves are near-static intraday. Treating gamma as purely session-level
  // was a real error; this restores it as a minute-by-minute trigger.
  if (results.exposure_by_strike_gamma?.ok && priceSeries?.length) {
    const prox = gammaProximitySeries(results.exposure_by_strike_gamma, priceSeries);
    for (const [metric, series] of Object.entries(prox)) {
      if (series?.length) {
        all = all.concat(detectSignalEvents(series, { endpoint: "gamma_proximity", metric }));
      }
    }
  }

  return all;
}

export function buildBriefing(bundle, { contract } = {}) {
  const fullRegistry = contract ? [...QD_ENDPOINTS, ...QD_CONTRACT_ENDPOINTS] : QD_ENDPOINTS;
  // A backtest deliberately fetches only the feeds its rule references, so we
  // must NOT then report the other 27 as "FAILED" — they were never requested.
  // Only endpoints actually present in the bundle are considered.
  const registry = fullRegistry.filter((ep) => bundle.results[ep.id] !== undefined);

  const endpoints = [];
  let allEvents = [];
  let priceSeries = [];
  let contractSeries = [];

  for (const ep of registry) {
    const result = bundle.results[ep.id];

    if (!result || !result.ok) {
      endpoints.push({
        id: ep.id,
        describes: ep.describes,
        status: "FAILED",
        summary: `FETCH FAILED (${result?.status ?? "not attempted"}). No data — you must NOT treat this as "no signal". It is unknown.`,
      });
      continue;
    }

    const compressor = COMPRESSORS[ep.id];
    let compressed;
    try {
      compressed = compressor ? compressor(result) : { summary: "No compressor defined for this endpoint." };
    } catch (err) {
      compressed = { summary: `Compression error: ${err.message}` };
    }

    if (compressed.events?.length) allEvents = allEvents.concat(compressed.events);
    if (ep.id === "stock_price_over_time") priceSeries = compressed.series || [];
    if (ep.id === "option_price_over_time") contractSeries = compressed.series || [];

    endpoints.push({
      id: ep.id,
      describes: ep.describes,
      status: "OK",
      summary: compressed.summary,
      eventCount: compressed.events?.length ?? 0,
      rows: compressed.rows,
    });
  }

  // EVENTS FOR EVERY BAR METRIC, not just the ones the human-written compressors
  // happened to emit. A model can name any bar metric in a rule, so every bar
  // metric must be able to produce an event — otherwise the rule would reference
  // a signal the backtest is structurally blind to.
  allEvents = eventsForAllBarMetrics(bundle.results, priceSeries);

  // SESSION METRICS — the regime gates. One scalar per feed per day.
  const spot = priceSeries.length ? priceSeries[priceSeries.length - 1].value : null;
  const sessionMetrics = computeSessionMetrics(bundle.results, spot);

  // The move(s) we're trying to have predicted, and what fired beforehand.
  const thrusts = detectPriceThrusts(priceSeries);
  allEvents.sort((a, b) => a.ts - b.ts);
  const leadLag = computeLeadLag(thrusts, allEvents);

  return {
    ticker: bundle.ticker,
    sessionDate: bundle.sessionDate,
    fetchReport: bundle.report,
    endpoints,
    sessionMetrics,
    timeline: {
      priceThrusts: thrusts,
      totalSignalEvents: allEvents.length,
      // CRITICAL DISTINCTION (this was a real bug):
      //   `events`       = the COMPLETE set. The backtest MUST use this one.
      //   `promptEvents` = capped, purely so the text prompt stays readable.
      // Previously the backtest read the capped list and was silently blind to
      // every signal after the 120th of each day — quietly invalidating results.
      // Never point computation at the display-truncated list.
      events: allEvents,
      promptEvents: allEvents.slice(0, 120),
      leadLag,
    },
    contractSeries,
  };
}

// Renders the briefing as the text block a model sees. Kept separate from
// buildBriefing so the same structured briefing can also feed the UI (which
// renders the per-endpoint checklist) without re-deriving anything.
export function renderBriefing(b) {
  const lines = [];

  lines.push(`TICKER: ${b.ticker}   SESSION: ${b.sessionDate}`);
  lines.push(`DATA COMPLETENESS: ${b.fetchReport.succeeded}/${b.fetchReport.attempted} endpoints fetched successfully.`);
  if (b.fetchReport.failed.length) {
    lines.push(`FAILED FEEDS (treat as UNKNOWN, not as "no signal"): ${b.fetchReport.failed.map((f) => f.id).join(", ")}`);
  }

  lines.push(`\n=== ALL ${b.endpoints.length} DATA FEEDS ===`);
  lines.push(`You must review every one of these and report a note on each. "I looked at it and it was irrelevant / uncorrelated / showed nothing" is a completely acceptable and useful finding — do NOT invent a signal to justify an endpoint.\n`);
  b.endpoints.forEach((e, i) => {
    lines.push(`[${i + 1}] ${e.id} (${e.status})`);
    lines.push(`    what it is: ${e.describes}`);
    lines.push(`    reading:    ${e.summary}`);
  });

  lines.push(`\n=== PRICE MOVES TO EXPLAIN (computed from real data, not opinion) ===`);
  if (!b.timeline.priceThrusts.length) {
    lines.push(`No statistically significant price thrust detected this session. It is entirely valid to conclude there was nothing to trade.`);
  } else {
    b.timeline.priceThrusts.forEach((t, i) => {
      lines.push(`Thrust ${i + 1}: ${t.direction} ${t.pctMove}% from ${t.startClock} ($${t.startPrice.toFixed(2)}) to ${t.endClock} ($${t.endPrice.toFixed(2)})  [${t.z} sigma vs this session's noise]`);
    });
  }

  lines.push(`\n=== SESSION METRICS (measured values — use these to choose realistic rule thresholds) ===`);
  lines.push(`These are RAW numbers for this session. They are SESSION GATES: they describe the day's regime (is gamma positive? is skew favouring calls? is OI building?), not a moment in time.`);
  lines.push(`CRITICAL — THRESHOLDS MUST BE IN THESE EXACT UNITS. The numbers below are printed in FULL, unabbreviated, because that is exactly how the backtest compares them. If net_gamma reads 65426346, then a gate of "> 50" is TRUE ON EVERY DAY and does nothing at all; you would need something like "> 30000000" to mean "strongly positive gamma". Read the magnitude carefully before you pick a number.\n`);
  const sm = b.sessionMetrics || {};
  const smKeys = Object.keys(sm).sort();
  if (!smKeys.length) {
    lines.push(`(none computed)`);
  } else {
    smKeys.forEach((k) => {
      // Printed RAW and in full. Abbreviating to "65.43M" caused a model to set
      // a gate of "> 50" against a raw value of 65,426,346 — a gate that passes
      // every single day and silently does nothing. Display units and comparison
      // units MUST be identical.
      lines.push(`  ${k.padEnd(52)} = ${sm[k]}`);
    });
  }

  lines.push(`\n=== SIGNAL EVENTS DETECTED: ${b.timeline.totalSignalEvents} total across all feeds ===`);
  lines.push(`\n=== LEAD/LAG: WHAT FIRED *BEFORE* EACH MOVE ===`);
  lines.push(`Only signals timestamped STRICTLY BEFORE the move's start are listed. Anything at or after the move is a reaction, not a predictor, and is excluded by construction.\n`);
  if (!b.timeline.leadLag.length) {
    lines.push(`(No moves to analyze.)`);
  } else {
    b.timeline.leadLag.forEach((ll, i) => {
      lines.push(`--- For thrust ${i + 1} (${ll.thrust.direction} ${ll.thrust.pctMove}% starting ${ll.thrust.startClock}) ---`);
      lines.push(`    ${ll.precursorCount} precursor signals across ${ll.corroborationScore} independent feeds: ${ll.corroboratingFeeds.join(", ") || "NONE"}`);
      if (!ll.precursors.length) {
        lines.push(`    NOTHING fired in advance. This move may simply not have been knowable — saying so is a legitimate, valuable conclusion.`);
      }
      ll.precursors.slice(0, 15).forEach((p) => {
        lines.push(`    ${p.clock}  (${p.leadMinutes} min before)  ${p.endpoint}.${p.metric} = ${p.value}  [${p.z} sigma, ${p.direction}]`);
      });
    });
  }

  return lines.join("\n");
}
