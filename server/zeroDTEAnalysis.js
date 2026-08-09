// 0DTE PERFORMANCE ANALYSIS — slices persisted trades by feature to show
// which conditions separate winners from losers.
//
// DISCIPLINE: this reports what the data says, it does NOT pick a winner.
// Every slice carries its sample size, and slices below MIN_SAMPLE are
// flagged as unreliable rather than quietly ranked. Picking the best-looking
// bucket from a small sample is the p-hacking this project exists to avoid.
// A 3-trade bucket at 100% win rate means nothing; the UI must say so.

import { loadTrades } from "./zeroDTEStore.js";

const MIN_SAMPLE = 20; // below this, a bucket is a curiosity, not evidence

function summarize(rows) {
  const n = rows.length;
  if (!n) return null;
  const pnls = rows.map((r) => Number(r.pnl) || 0);
  const wins = pnls.filter((p) => p > 0).length;
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const total = pnls.reduce((a, b) => a + b, 0);
  return {
    trades: n,
    wins,
    winRate: +((wins / n) * 100).toFixed(1),
    totalPnl: +total.toFixed(2),
    avgPnl: +(total / n).toFixed(2),
    // Expectancy and profit factor beat win rate: a 40%-win bucket with big
    // winners can outperform a 70%-win bucket that bleeds on its losses.
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    avgHold: +(rows.reduce((a, r) => a + (Number(r.hold_minutes) || 0), 0) / n).toFixed(1),
    reliable: n >= MIN_SAMPLE,
  };
}

function groupBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    (out[k] ||= []).push(r);
  }
  return Object.fromEntries(
    Object.entries(out)
      .map(([k, v]) => [k, summarize(v)])
      .sort((a, b) => (b[1]?.trades || 0) - (a[1]?.trades || 0)),
  );
}

export async function analyzePerformance({ symbol = "SPY", from, to, lane = "official", countedOnly = true } = {}) {
  const rows = (await loadTrades({ symbol, from, to, lane, countedOnly }))
    .filter((r) => r.entry_price != null); // only trades that actually simulated

  const timeBucket = (m) => {
    if (m == null) return null;
    const h = Math.floor(m / 60), mm = m % 60 < 30 ? "00" : "30";
    return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
  };

  return {
    symbol, lane, from, to, minSample: MIN_SAMPLE,
    overall: summarize(rows),
    byTier: groupBy(rows, (r) => r.tier),
    byDirection: groupBy(rows, (r) => r.direction),
    byLevelType: groupBy(rows, (r) => r.level_type),
    byTouchNumber: groupBy(rows, (r) => (r.touch_number == null ? null : `touch ${r.touch_number}`)),
    byScore: groupBy(rows, (r) => (r.points == null ? null : r.points <= 11 ? "11 or less" : r.points <= 13 ? "12-13" : r.points <= 15 ? "14-15" : "16+")),
    byRsi: groupBy(rows, (r) => {
      const v = Number(r.rsi);
      if (!Number.isFinite(v)) return null;
      return v <= 25 ? "RSI <=25" : v <= 29 ? "RSI 26-29" : v >= 75 ? "RSI >=75" : v >= 71 ? "RSI 71-74" : "RSI 30-70";
    }),
    byTimeOfDay: groupBy(rows, (r) => timeBucket(r.et_minute)),
    byMtf: groupBy(rows, (r) => (r.mtf_aligned == null ? null : r.mtf_aligned ? "MTF aligned" : "not aligned")),
    byVolume: groupBy(rows, (r) => (r.vol_pts == null ? null : `vol ${r.vol_pts}/2`)),
    bySpeed: groupBy(rows, (r) => (r.speed_pts == null ? null : `speed ${r.speed_pts}/2`)),
    byWick: groupBy(rows, (r) => (r.wick_pts == null ? null : `wick ${r.wick_pts}/1`)),
    byExit: groupBy(rows, (r) => r.exit_reason),
    byEntryPrice: groupBy(rows, (r) => {
      const p = Number(r.entry_price);
      if (!Number.isFinite(p)) return null;
      return p < 0.3 ? "under $0.30" : p < 0.6 ? "$0.30-0.60" : p < 1.0 ? "$0.60-1.00" : p < 2.0 ? "$1.00-2.00" : "over $2.00";
    }),
  };
}
