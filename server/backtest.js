// THE BACKTEST ENGINE — all 30 feeds, session gates + intraday triggers.
//
// A rule now has two kinds of condition, and they do different jobs:
//
//   SESSION GATE   ("is today a day I should trade at all?")
//     e.g. exposure_by_strike_gamma.net_gamma < 0   — dealers short gamma, so
//          moves get AMPLIFIED rather than pinned. A regime, not a moment.
//     Evaluated ONCE per day against a RAW value. If any gate fails, the whole
//     day is skipped and no trade is taken.
//
//   BAR TRIGGER    ("at what minute do I enter?")
//     e.g. net_drift.netCallPremium > 20   — a 20-sigma premium spike.
//     Evaluated per-minute against a Z-SCORE (trailing baseline, no lookahead).
//
// This mirrors how a real trader operates: a regime filter decides whether to
// be in the market at all, and a trigger decides the moment. Previously only 6
// feeds were expressible and every condition was treated as a trigger — which
// made GEX, OI, skew, and dark-pool structure untestable even though the models
// kept (correctly) reaching for them.
//
// LOOKAHEAD SAFETY:
//   - Bar z-scores use a TRAILING window only; a bar's score never depends on
//     later bars.
//   - Entry is at the CLOSE of the firing bar. Not the day's low, not a perfect
//     fill. Something you could actually have gotten.
//   - Exit is a fixed horizon decided in advance — never "sell at the top".
//   - SESSION GATES ARE THE ONE PLACE LOOKAHEAD COULD SNEAK IN, and it is
//     handled explicitly: see the note on gate honesty below.

import { fetchFeedsForRule } from "./quantDataClient.js";
import { buildBriefing } from "./compress.js";
import { BAR_METRICS, SESSION_METRICS, computeSessionMetrics, buildVocabulary } from "./metrics.js";

// Time-of-day is not a feed, but the models keep (correctly) reaching for it —
// "late-day spikes are exhaustion, not continuation" is a real market read.
export const TIME_FEED = "time_of_day";
export const TIME_METRICS = ["minutes_since_open", "minutes_to_close"];

// ---------------------------------------------------------------------------
// VALIDATION. Every failure here previously surfaced as a SILENT "0 trades",
// which is indistinguishable from a real result and caused GPT to burn two
// refinement rounds misdiagnosing a phantom.
// ---------------------------------------------------------------------------
export function validateRule(rule) {
  if (!rule?.conditions?.length) return { valid: false, errors: ["Rule has no conditions."] };

  const vocab = buildVocabulary();
  const errors = [];

  for (const c of rule.conditions) {
    if (c.feed === TIME_FEED) {
      if (!TIME_METRICS.includes(c.metric)) {
        errors.push(`time_of_day metric "${c.metric}" is invalid. Valid: ${TIME_METRICS.join(", ")}`);
      }
    } else {
      const isBar = vocab.bar[c.feed]?.includes(c.metric);
      const isSession = vocab.session[c.feed]?.includes(c.metric);
      if (!isBar && !isSession) {
        const barOpts = vocab.bar[c.feed];
        const sessOpts = vocab.session[c.feed];
        if (!barOpts && !sessOpts) {
          errors.push(`Feed "${c.feed}" does not exist.`);
        } else {
          errors.push(`Metric "${c.metric}" does not exist on feed "${c.feed}". Valid: ${[...(barOpts || []), ...(sessOpts || [])].join(", ")}`);
        }
      }
    }
    if (!Number.isFinite(Number(c.threshold))) {
      errors.push(`Threshold on ${c.feed}.${c.metric} is not a number: ${c.threshold}`);
    }
  }

  // CONTRADICTION CHECK. GPT once wrote:
  //   minutes_since_open <= 120 AND minutes_since_open >= 240
  // No bar can be both under 2 hours and over 4 hours from the open. The rule
  // was UNSATISFIABLE, fired zero times, and GPT read that as "thresholds too
  // extreme" and loosened them. An impossible rule must be called impossible.
  const byField = new Map();
  for (const c of rule.conditions) {
    const key = `${c.feed}.${c.metric}`;
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key).push(c);
  }
  for (const [key, conds] of byField) {
    let lo = -Infinity, hi = Infinity;
    for (const c of conds) {
      const t = Number(c.threshold);
      if (c.operator === ">" || c.operator === ">=") lo = Math.max(lo, t);
      if (c.operator === "<" || c.operator === "<=") hi = Math.min(hi, t);
    }
    if (lo > hi) {
      errors.push(`CONTRADICTION on ${key}: requires >= ${lo} AND <= ${hi} simultaneously. No value satisfies both — this rule can NEVER fire. This is not a threshold problem, it is a logically impossible condition.`);
    }
  }

  // A rule of only session gates has no entry moment — it says WHICH days to
  // trade but never WHEN. It cannot produce a trade, so it must be rejected
  // rather than silently returning zero.
  const vocab2 = buildVocabulary();
  const hasTrigger = rule.conditions.some((c) =>
    c.feed !== TIME_FEED && vocab2.bar[c.feed]?.includes(c.metric));
  if (!hasTrigger && errors.length === 0) {
    errors.push(`This rule contains only session-level gates (and/or time filters) and no intraday TRIGGER. It specifies which DAYS to trade but never WHEN to enter, so it can never produce a trade. Add at least one bar-level condition (a minute-by-minute feed) to define the entry moment.`);
  }

  return { valid: errors.length === 0, errors };
}

// Session gates built on SAME-DAY CUMULATIVE totals. A gate like
// "contract_statistics.call_put_premium_ratio > 3" uses the WHOLE day's flow to
// decide whether to trade at 10:00am — which you could not possibly have known
// at 10:00am. It is lookahead bias, it silently flatters a backtest, and GPT
// reached for it even after being warned in the prompt. So it is also caught
// here in code: the rule still runs, but the result carries a loud warning
// rather than pretending to be tradeable.
const LOOKAHEAD_GATE_FEEDS = new Set([
  "contract_statistics", "contract_trade_side_statistics", "gainers_losers",
  "order_flow_consolidated", "order_flow_unconsolidated", "equity_prints",
  "heat_map", "market_share", "news_articles", "stock_price_over_time",
  "volatility_drift", "dark_flow",
]);

export function auditGates(rule) {
  const { gates } = splitConditions(rule);
  const lookahead = gates
    .filter((g) => LOOKAHEAD_GATE_FEEDS.has(g.feed))
    .map((g) => `${g.feed}.${g.metric}`);
  return { lookahead };
}

function cmp(subject, op, t) {
  switch (op) {
    case ">": return subject > t;
    case ">=": return subject >= t;
    case "<": return subject < t;
    case "<=": return subject <= t;
    case "==": return subject === t;
    default: return false;
  }
}

function timeOfDay(ts) {
  const [h, m] = new Date(Number(ts))
    .toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":").map(Number);
  const mins = h * 60 + m;
  return { minutes_since_open: mins - (9 * 60 + 30), minutes_to_close: (16 * 60) - mins };
}

function splitConditions(rule) {
  const vocab = buildVocabulary();
  const gates = [], triggers = [], timeFilters = [];
  for (const c of rule.conditions) {
    if (c.feed === TIME_FEED) timeFilters.push(c);
    else if (vocab.bar[c.feed]?.includes(c.metric)) triggers.push(c);
    else gates.push(c);
  }
  return { gates, triggers, timeFilters };
}

// ---------------------------------------------------------------------------
// FIRINGS: session gates first (skip the day entirely), then bar triggers.
// COOLDOWN: one signal EVENT = one trade. Without it, a drift spanning 10
// minutes re-triggers on consecutive buckets and 6 real events masquerade as 41
// independent draws, inflating the sample and corrupting every statistic.
// ---------------------------------------------------------------------------
function findFirings(rule, briefing, sessionMetrics, { windowMin = 2, cooldownMin = 30 } = {}) {
  const { gates, triggers, timeFilters } = splitConditions(rule);

  // --- Session gates: is today even a day we trade? ---
  for (const g of gates) {
    const key = `${g.feed}.${g.metric}`;
    const v = sessionMetrics[key];
    // A gate whose metric could not be computed is NOT quietly treated as
    // passing. Unknown is not the same as satisfied — assuming otherwise would
    // let a rule trade days it explicitly said it wouldn't.
    if (!Number.isFinite(v)) return { firings: [], gateBlocked: true, gateReason: `${key} unavailable` };
    if (!cmp(v, g.operator, Number(g.threshold))) {
      return { firings: [], gateBlocked: true, gateReason: `${key}=${v.toFixed(2)} failed ${g.operator} ${g.threshold}` };
    }
  }

  // --- Bar triggers: at what minute? ---
  const events = briefing.timeline.events;
  const firings = [];
  let lastTs = -Infinity;

  for (const anchor of events) {
    if (anchor.ts - lastTs < cooldownMin * 60_000) continue;

    const tod = timeOfDay(anchor.ts);
    if (!timeFilters.every((c) => cmp(tod[c.metric], c.operator, Number(c.threshold)))) continue;

    const nearby = events.filter((e) => Math.abs(e.ts - anchor.ts) <= windowMin * 60_000);

    const allMet = triggers.every((cond) => nearby.some((e) => {
      if (e.endpoint !== cond.feed) return false;
      if (cond.metric && e.metric !== cond.metric) return false;
      // Bar triggers are compared in SIGMA — "unusual" only means something
      // relative to a baseline, and raw premium numbers span many orders of
      // magnitude across tickers.
      return cmp(e.z, cond.operator, Number(cond.threshold));
    }));

    if (allMet) {
      firings.push({ ts: anchor.ts, clock: anchor.clock });
      lastTs = anchor.ts;
    }
  }
  return { firings, gateBlocked: false };
}

function evaluateTrade(firing, priceBars, { holdMinutes = 15, direction = 1 }) {
  const entryBar = priceBars.find((b) => b.ts >= firing.ts);
  if (!entryBar) return null;
  const exitTs = entryBar.ts + holdMinutes * 60_000;
  const exitBar = [...priceBars].reverse().find((b) => b.ts <= exitTs && b.ts > entryBar.ts);
  if (!exitBar) return null;
  const pct = ((exitBar.value - entryBar.value) / entryBar.value) * 100 * direction;
  return {
    entryClock: firing.clock,
    entryPrice: +entryBar.value.toFixed(2),
    exitPrice: +exitBar.value.toFixed(2),
    pctReturn: +pct.toFixed(3),
    win: pct > 0,
  };
}

function directionOf(rule) {
  return rule?.action === "BUY_PUT" ? -1 : 1;
}

// ---------------------------------------------------------------------------
// THE MAIN SWEEP.
// ---------------------------------------------------------------------------
export async function backtestRule(rule, { ticker, sessions, holdMinutes = 15, onProgress } = {}) {
  const validation = validateRule(rule);
  if (!validation.valid) {
    return {
      testable: false,
      invalidRule: true,
      errors: validation.errors,
      reason: `RULE CANNOT RUN — this is NOT a backtest result and does NOT mean your signal never fired:\n  - ${validation.errors.join("\n  - ")}\nFix the rule using the exact feed/metric names, then it can actually be tested.`,
    };
  }

  const trades = [];
  const sessionResults = [];
  const errors = [];
  const direction = directionOf(rule);
  const { gates, triggers } = splitConditions(rule);

  // Tracks whether each gate ever actually BLOCKED a day. A gate that passes on
  // every single session is doing nothing — it is decoration, not a filter, and
  // the rule is not testing what the model thinks it is testing. This happened
  // for real: a model set net_gamma > 50 against a raw value of 65,426,346.
  const gateBlockCounts = Object.fromEntries(gates.map((g) => [`${g.feed}.${g.metric}`, 0]));

  // `gamma_proximity` is a DERIVED bar feed (strike map + live spot), not an
  // endpoint. Referencing it requires fetching the gamma exposure endpoint.
  const rawFeeds = [...new Set(rule.conditions.map((c) => c.feed))].filter((f) => f !== TIME_FEED);
  const feedIds = [...new Set(rawFeeds.flatMap((f) =>
    f === "gamma_proximity" ? ["exposure_by_strike_gamma"] : [f]))];

  let gateBlockedDays = 0;

  for (const sessionDate of sessions) {
    try {
      const bundle = await fetchFeedsForRule({ ticker, sessionDate, feedIds });

      if (bundle.report.transientFailure) {
        errors.push({ sessionDate, error: "TRANSIENT (rate limit/network) — NOT a real 'no data' result", transient: true });
        continue;
      }

      const priceBars = bundle.results.stock_price_over_time?.ok
        ? Object.entries(bundle.results.stock_price_over_time.data.data)
            .map(([ts, v]) => ({ ts: Number(ts), value: v.closePrice }))
            .sort((a, b) => a.ts - b.ts)
        : [];
      if (!priceBars.length) {
        errors.push({ sessionDate, error: "no price bars (likely a market holiday)" });
        continue;
      }

      // GATE HONESTY — the one place lookahead could sneak in.
      // Session metrics are computed from the WHOLE session's data, so a gate
      // like "call_put_premium_ratio > 3" technically uses end-of-day totals to
      // decide whether to trade at 10:00am. That is a REAL limitation and it is
      // stated plainly rather than hidden: gates derived from positioning that
      // exists at the OPEN (open interest, gamma exposure, prior-day OI change,
      // skew, term structure, dark-pool levels from prior sessions) are sound,
      // because a trader genuinely knows those before the bell. Gates built on
      // same-day cumulative FLOW (contract_statistics, gainers_losers,
      // order_flow_*) are NOT knowable at 10:00am and will flatter a backtest.
      // The models are told this explicitly in the prompt.
      const spot = priceBars[priceBars.length - 1].value;
      const sessionMetrics = computeSessionMetrics(bundle.results, spot);

      const briefing = buildBriefing(bundle);
      const { firings, gateBlocked, gateReason } = findFirings(rule, briefing, sessionMetrics);

      if (gateBlocked) {
        gateBlockedDays++;
        // Record WHICH gate did the blocking, so a gate that never blocks
        // anything can be exposed as the no-op it is.
        if (gateReason) {
          const key = gateReason.split("=")[0].split(" ")[0];
          if (key in gateBlockCounts) gateBlockCounts[key]++;
        }
        sessionResults.push({ sessionDate, firings: 0, trades: 0, gateBlocked: true, gateReason });
        onProgress?.({ sessionDate, firings: 0, gateBlocked: true, gateReason });
        continue;
      }

      const dayTrades = firings
        .map((f) => evaluateTrade(f, priceBars, { holdMinutes, direction }))
        .filter(Boolean)
        .map((t) => ({ ...t, sessionDate }));

      trades.push(...dayTrades);
      sessionResults.push({ sessionDate, firings: firings.length, trades: dayTrades.length });
      onProgress?.({ sessionDate, firings: firings.length });
    } catch (err) {
      errors.push({ sessionDate, error: err.message });
    }
  }

  // ---- The verdict. No spin. ----
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalReturn = trades.reduce((a, t) => a + t.pctReturn, 0);
  const avgReturn = trades.length ? totalReturn / trades.length : 0;
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const grossWin = wins.reduce((a, t) => a + t.pctReturn, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pctReturn, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // A rule that fires twice and wins twice proves nothing.
  const enoughData = trades.length >= 20;
  const sessionsActuallyTested = sessionResults.length;

  const dataIntegrity = errors.length === 0
    ? "All requested sessions returned data."
    : `WARNING: ${errors.length}/${sessions.length} sessions returned no data (${errors.map((e) => e.sessionDate).join(", ")}). Based on ${sessionsActuallyTested} sessions, not ${sessions.length}.`;

  // ---- Two warnings that would otherwise pass silently and corrupt the result ----

  // (1) NO-OP GATES. A gate that never blocked a single day is not filtering
  // anything. The model believes its rule only trades (say) positive-gamma days;
  // in reality it trades every day, and the backtest is measuring something the
  // model never intended.
  const noOpGates = Object.entries(gateBlockCounts)
    .filter(([, count]) => count === 0)
    .map(([key]) => key);

  // (2) LOOKAHEAD GATES. Same-day cumulative totals used to decide whether to
  // trade earlier that same day. Not knowable at entry time; flatters results.
  const { lookahead } = auditGates(rule);

  const warnings = [];
  if (noOpGates.length) {
    warnings.push(`NO-OP GATE(S): ${noOpGates.join(", ")} never blocked a single one of the ${sessionsActuallyTested} sessions tested. These gates are doing NOTHING — check the threshold against the real magnitude of the metric (e.g. net_gamma is in the tens of millions, so "> 50" passes every day). Your rule is not testing what you think it is testing.`);
  }
  if (lookahead.length) {
    warnings.push(`LOOKAHEAD BIAS: ${lookahead.join(", ")} are SAME-DAY CUMULATIVE totals. Gating on them uses the full day's data to decide whether to trade earlier that same day — information you would NOT have had at entry. These results are optimistic and NOT tradeable as-is.`);
  }

  return {
    testable: true,
    rule: rule.description,
    ticker,
    gateCount: gates.length,
    triggerCount: triggers.length,
    gateBlockedDays,
    gateBlockCounts,
    warnings,
    hasLookahead: lookahead.length > 0,
    sessionsRequested: sessions.length,
    sessionsTested: sessionsActuallyTested,
    sessionsWithErrors: errors.length,
    dataIntegrity,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +winRate.toFixed(1),
    avgReturnPct: +avgReturn.toFixed(3),
    totalReturnPct: +totalReturn.toFixed(2),
    profitFactor: profitFactor === Infinity ? "Inf" : +profitFactor.toFixed(2),
    bestTrade: trades.length ? trades.reduce((a, b) => (b.pctReturn > a.pctReturn ? b : a)) : null,
    worstTrade: trades.length ? trades.reduce((a, b) => (b.pctReturn < a.pctReturn ? b : a)) : null,
    enoughData,
    verdict: !trades.length
      ? (gateBlockedDays > 0
          ? `NEVER FIRED. Your session gates blocked ${gateBlockedDays} of ${sessionsActuallyTested} days outright, and the trigger never fired on the rest. The gates may be too restrictive.`
          : "NEVER FIRED. Conditions were never met on any tested session. This is not a rule, it is a description of one specific afternoon.")
      : !enoughData
      ? `INSUFFICIENT SAMPLE. Only ${trades.length} firings across ${sessionsActuallyTested} sessions${gateBlockedDays ? ` (gates blocked ${gateBlockedDays} days)` : ""}. Any win rate here is noise — you need 20+ to say anything.`
      : winRate >= 55 && avgReturn > 0
      ? `HOLDS UP SO FAR. ${trades.length} trades, ${winRate.toFixed(0)}% win rate, ${avgReturn.toFixed(2)}% average return per trade.`
      : `DOES NOT HOLD UP. ${trades.length} trades, ${winRate.toFixed(0)}% win rate, ${avgReturn.toFixed(2)}% average per trade. The single-day story did not survive contact with other days.`,
    trades,
    sessionResults,
    errors,
  };
}

export function priorSessions(fromDate, count) {
  const out = [];
  const d = new Date(fromDate + "T00:00:00Z");
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}
