// SPY 0DTE ENGINE — ports the Edge Lens v4 Pine Script's scoring logic to
// run RETROSPECTIVELY against real 1-min Alpaca SIP bars, then combines it
// with the Shen Lao playbook's strike-selection rules to tell the story of
// what would have happened in a session.
//
// This is NOT the TradingView tool itself — it's an independent
// re-implementation of the same scoring rules (levels, RSI+swing,
// confirmation, taps, MTF, regime, thresholds), run in Node against a
// different (but comparable) consolidated data source. Exact bar-for-bar
// parity with the live Pine script isn't guaranteed — smoothing seeds and
// data source will cause small differences — but the SCORING RULES are
// copied faithfully from the v4 script the user provided.

import { fetchAlpacaBars } from "./alpacaClient.js";
import {
  FRONTIER_V3_MIN_ENTRY, FRONTIER_V3_MIN_MINUTE, FRONTIER_V3_MAX_POINTS, FRONTIER_V3_MIN_POINTS,
  isFrontierV3Fire,
} from "./frontierV3.js";

// RSI thresholds: 73 puts / 29 calls — matching the DEPLOYED Pine script's
// defaults (i_rsi_put=73, i_rsi_call=29). The v4 guide text says "73 / 26";
// treated as doc drift, since the script is what actually runs on the chart.
// NOTE: 29 was re-chosen after 26 disqualified a winning trade in a 2-trade
// sample — that alone is NOT evidence 29 is better. Judge on months, not days.
const RSI_LEN = 14, RSI_PUT = 73, RSI_CALL = 29, SWING_MIN = 35, TOUCH_ZONE = 0.05;
const VELOCITY_FLOOR = 64, EXT_SWING_MIN = 45, SOFT_PUT = 68, SOFT_CALL = 32;
const VOL_MA_LEN = 20, ATR_LEN = 14, ADX_LEN = 14, ADX_STRONG = 28;
const SPEED_LOOKBACK = 4, SPEED_ATR_MULT = 0.40, WICK_RATIO = 1.5;
const APLUS_BASE = 15, A_TIER_MIN = 11;
const CALL_COOLDOWN = 30, A_COOLDOWN = 15, EXT_COOLDOWN = 20, RSI_EXT_SWING = 50;
const TREND_GUARD_LOOKBACK = 10, TREND_GUARD_ATR_MULT = 3.0;
const RESEARCH_SCORE_MIN = 13, RESEARCH_EXTENDED_END_MIN = 750; // 12:30 ET
const SHEN_FAST_MOVE_MIN = 2.0;
const SHEN_LEVEL_TYPES = new Set(["WHOLE_DOLLAR", "PDH", "PDL", "PMH", "PML"]);

export function playbookTouchPolicy({ touchNumber, exhaustionMove }) {
  const exhaustionException = touchNumber === 3 && exhaustionMove >= 4;
  return {
    eligible: touchNumber == null || touchNumber <= 2 || exhaustionException,
    dropSizeTier: touchNumber === 2,
    exhaustionException,
  };
}

export function classifyResearchCandidate({ minutes, points, aplusThreshold, levelPoints, hasTwoConfirmations, touchNumber, isAplus }) {
  if (minutes >= PB_OPEN_MIN && minutes < PB_CLOSE_MIN
      && points >= RESEARCH_SCORE_MIN && points < aplusThreshold
      && levelPoints >= 3 && hasTwoConfirmations && touchNumber === 1) return "HIGH_QUALITY_A";
  if (minutes >= PB_CLOSE_MIN && minutes < RESEARCH_EXTENDED_END_MIN && isAplus) return "EXTENDED_A_PLUS";
  return null;
}

// The discretionary playbook's original conviction stack, deliberately
// independent of Edge Lens points: first touch, a $2+ move into the level
// within the prior 30 minutes, and RSI <30 for calls / >70 for puts.
// Two checks = standard conviction; all three = full conviction.
export function classifyShenConviction({ minutes, levelType, touchNumber, exhaustionMove, moveDistance, rsi, direction, approachValid = true }) {
  if (minutes < PB_OPEN_MIN || minutes >= PB_CLOSE_MIN || !SHEN_LEVEL_TYPES.has(levelType) || !approachValid) return null;
  const touchPolicy = playbookTouchPolicy({ touchNumber, exhaustionMove });
  if (!touchPolicy.eligible) return null;
  const checks = {
    firstTouch: touchNumber === 1,
    fastMove: moveDistance >= SHEN_FAST_MOVE_MIN,
    rsiConfirmed: Number.isFinite(rsi) && (direction === "CALL" ? rsi < 30 : rsi > 70),
  };
  const convictionCount = Object.values(checks).filter(Boolean).length;
  if (convictionCount < 2) return null;
  return { checks, convictionCount, grade: convictionCount === 3 ? "FULL" : "STANDARD" };
}

// FRONTIER MODEL — paper-only selection across ALL segments. Live rules are
// Frontier v7 (PUT, pts≥12, first touch, $1k/trade, runner/-50% exits).
// See frontierV3.js. New 24-month backtest required to populate frontier_*.
export const FRONTIER_MIN_MINUTE = FRONTIER_V3_MIN_MINUTE;
export const FRONTIER_MIN_POINTS = FRONTIER_V3_MIN_POINTS;
export const FRONTIER_MAX_POINTS = FRONTIER_V3_MAX_POINTS;
export const FRONTIER_MIN_ENTRY = FRONTIER_V3_MIN_ENTRY;

export function isFrontierFire(args = {}) {
  return isFrontierV3Fire(args);
}

// Backward-compatible alias used by earlier Frontier v0 call sites/tests.
export function isFrontierOfficialFire(args = {}) {
  return isFrontierFire(args);
}

export function frontierLanePriority(lane, { counted = false } = {}) {
  if (lane === "official" && counted) return 0;
  if (lane === "HIGH_QUALITY_A" || lane === "EXTENDED_A_PLUS") return 1;
  if (lane === "official") return 2;
  if (lane === "SHEN_CONVICTION") return 3;
  return 4;
}

export function frontierDedupeKey({ sessionDate, etMinute, direction, levelType, touchNumber }) {
  return [sessionDate || "", etMinute ?? "", direction || "", levelType || "", touchNumber ?? ""].join("|");
}

// THE PLAYBOOK'S SCHEDULE (Shen Lao, section 09 + Rule R5), in ET minutes:
//   6:30 PST / 9:30 ET  observe only — "Zero trades"
//   6:45 PST / 9:45 ET  "TRADE WINDOW OPENS"
//   8:15 PST / 11:15 ET "HARD STOP — Close the platform. Physically."
// Signals outside 9:45–11:15 ET still fire (the Edge Lens tool watches the
// whole session) but are flagged so the sim can exclude them from the
// by-the-rules P&L.
const PB_OPEN_MIN = 585, PB_CLOSE_MIN = 675;

function etParts(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { dateStr: `${map.year}-${map.month}-${map.day}`, minutes: Number(map.hour) * 60 + Number(map.minute) };
}
function clockLabel(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ET`;
}

// ---- indicator series (continuous across days, like Pine — daily-reset
// state like PDH/VWAP/taps is handled separately in the session loop). ----
function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gainSum += ch; else lossSum += -ch;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch >= 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    prev = prev == null ? closes[i] : closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Wilder ATR (true range, smoothed).
function atrSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  const trs = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(
    b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close),
  ));
  let avg = null;
  for (let i = 0; i < bars.length; i++) {
    if (i < period) continue;
    if (avg == null) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += trs[j]; avg = s / period; }
    else avg = (avg * (period - 1) + trs[i]) / period;
    out[i] = avg;
  }
  return out;
}

// Wilder DMI/ADX.
function adxSeries(bars, period) {
  const n = bars.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low;
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  const smooth = (arr) => {
    const out = new Array(n).fill(null);
    let avg = null;
    for (let i = 0; i < n; i++) {
      if (i < period) continue;
      if (avg == null) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += arr[j]; avg = s; }
      else avg = avg - avg / period + arr[i];
      out[i] = avg;
    }
    return out;
  };
  const trS = smooth(tr), plusS = smooth(plusDM), minusS = smooth(minusDM);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!trS[i]) continue;
    const pDI = 100 * plusS[i] / trS[i], mDI = 100 * minusS[i] / trS[i];
    const sum = pDI + mDI;
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum;
  }
  // ADX = Wilder RMA of DX (Pine's ta.rma), seeded with a simple average.
  // (Previously used an SMA here — a different smoother than the script's,
  // which shifted the strong-trend boundary on marginal days.)
  const adx = new Array(n).fill(null);
  let rma = null, seedSum = 0, seedCount = 0;
  for (let i = 0; i < n; i++) {
    if (dx[i] == null) continue;
    if (rma == null) {
      seedSum += dx[i]; seedCount++;
      if (seedCount === period) rma = seedSum / period;
    } else {
      rma = (rma * (period - 1) + dx[i]) / period;
    }
    if (rma != null) adx[i] = rma;
  }
  return adx;
}

// 5-min / 10-min RSI, mapped back onto each 1-min bar using the LAST
// CLOSED higher-timeframe bar (mirrors Pine's request.security with
// lookahead_off — the current bar can't see its own still-forming HTF bar).
function higherTfRsiOnto(bars, binMinutes) {
  const bins = new Map(); // binKey -> {closes[]}
  const binKeyOf = (ts) => {
    const { dateStr, minutes } = etParts(ts);
    return `${dateStr}_${Math.floor(minutes / binMinutes)}`;
  };
  const order = [];
  for (const b of bars) {
    const key = binKeyOf(b.ts);
    if (!bins.has(key)) { bins.set(key, { close: null }); order.push(key); }
    bins.get(key).close = b.close; // last close in the bin
  }
  const binCloses = order.map((k) => bins.get(k).close);
  const binRsi = rsiSeries(binCloses, RSI_LEN);
  const keyToIdx = new Map(order.map((k, i) => [k, i]));
  return bars.map((b) => {
    const key = binKeyOf(b.ts);
    const idx = keyToIdx.get(key);
    const prevIdx = idx - 1;
    return prevIdx >= 0 ? binRsi[prevIdx] : null;
  });
}

// Rolling highest/lowest over a trailing window (inclusive of current bar).
function rollingExtreme(values, window, fn) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    let best = null;
    for (let j = start; j <= i; j++) {
      if (values[j] == null) continue;
      best = best == null ? values[j] : fn(best, values[j]);
    }
    out[i] = best;
  }
  return out;
}

// Aggregate 1-min RTH bars into a single daily OHLC bar per ET date.
function dailyBarsFrom(bars) {
  const byDay = new Map();
  for (const b of bars) {
    const { dateStr } = etParts(b.ts);
    if (!byDay.has(dateStr)) byDay.set(dateStr, { dateStr, open: b.open, high: b.high, low: b.low, close: b.close });
    const d = byDay.get(dateStr);
    d.high = Math.max(d.high, b.high);
    d.low = Math.min(d.low, b.low);
    d.close = b.close;
  }
  return [...byDay.values()].sort((a, b) => (a.dateStr < b.dateStr ? -1 : 1));
}

// Main entry point: replays one SPY session bar-by-bar and returns every
// A+/A/RSI-Extreme fire, the full score history, and the day's levels.
export async function analyzeZeroDTESession({ symbol = "SPY", sessionDate }) {
  // 30 calendar days back (~21 sessions): enough that the 14-day daily ATR
  // used by gap protection has a FULL 14 sessions behind it. The previous
  // 10-day lookback silently fed it only ~7 sessions.
  const start = new Date(sessionDate + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - 30);
  const startDate = start.toISOString().slice(0, 10);

  const allBars = await fetchAlpacaBars({ symbol, startDate, endDate: sessionDate });
  if (!allBars.length) return { ok: false, reason: `No Alpaca bars for ${symbol} ${startDate}..${sessionDate}.` };

  const rthOnly = allBars.filter((b) => { const { minutes } = etParts(b.ts); return minutes >= 570 && minutes < 960; });
  const daily = dailyBarsFrom(rthOnly);
  const todayIdx = daily.findIndex((d) => d.dateStr === sessionDate);
  if (todayIdx < 1) return { ok: false, reason: `No prior trading day found before ${sessionDate} in range — widen lookback or check the date.` };

  const pdh = daily[todayIdx - 1].high, pdl = daily[todayIdx - 1].low, priorClose = daily[todayIdx - 1].close;
  const dailyAtr14 = (() => {
    const days = daily.slice(0, todayIdx);
    const trs = days.map((d, i) => i === 0 ? d.high - d.low : Math.max(d.high - d.low, Math.abs(d.high - days[i - 1].close), Math.abs(d.low - days[i - 1].close)));
    const win = trs.slice(-14);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  })();

  const closes = allBars.map((b) => b.close), volumes = allBars.map((b) => b.volume);
  const rsi = rsiSeries(closes, RSI_LEN);
  const volMa = smaSeries(volumes, VOL_MA_LEN);
  const atr = atrSeries(allBars, ATR_LEN);
  const adx = adxSeries(allBars, ADX_LEN);
  const rsi5 = higherTfRsiOnto(allBars, 5);
  const rsi10 = higherTfRsiOnto(allBars, 10);
  const rsiPeak30 = rollingExtreme(rsi, 30, Math.max);
  const rsiTrough30 = rollingExtreme(rsi, 30, Math.min);

  const todayIdxs = [];
  for (let i = 0; i < allBars.length; i++) {
    const { dateStr, minutes } = etParts(allBars[i].ts);
    if (dateStr === sessionDate && minutes >= 240 && minutes < 960) todayIdxs.push(i);
  }
  if (!todayIdxs.length) return { ok: false, reason: `No bars for ${symbol} on ${sessionDate} — market may have been closed.` };

  const openIdx = todayIdxs.find((i) => etParts(allBars[i].ts).minutes >= 570) ?? todayIdxs[0];
  const todayOpen = allBars[openIdx].open;
  const gapSize = todayOpen - priorClose;
  const isGapUp = dailyAtr14 != null && gapSize >= dailyAtr14 * 2.0;
  const isGapDn = dailyAtr14 != null && gapSize <= -(dailyAtr14 * 2.0);
  const sessBase = Math.round(todayOpen);

  let pmh = null, pml = null, orHigh = null, orLow = null;
  let orb15High = null, orb15Low = null, orb15BrokeUp = false, orb15BrokeDn = false;
  let vwapCumPV = 0, vwapCumV = 0;
  let putTaps = 0, callTaps = 0;
  let softPutToday = false, softCallToday = false, softPutIdx = -999, softCallIdx = -999;
  const touchedSlots = new Set();
  const levelTouchCounts = new Map();
  let activeLevelTouches = new Set();
  let dayHighSoFar = null, dayLowSoFar = null;
  let lastCallBar = -999, lastPutBar = -999, lastCallABar = -999, lastPutABar = -999, lastCallExtBar = -999, lastPutExtBar = -999;
  let prevCallAplus = false, prevPutAplus = false;
  let prevCallA = false, prevPutA = false, prevCallExt = false, prevPutExt = false;

  const barRows = [];
  const fires = [];
  const experiments = [];
  const playbookExperiments = [];
  const nearMisses = [];
  const nearMissKeys = new Set();
  let prevCallResearch = null, prevPutResearch = null;
  const shenFiredKeys = new Set();

  for (let k = 0; k < todayIdxs.length; k++) {
    const i = todayIdxs[k];
    const bar = allBars[i];
    const { minutes } = etParts(bar.ts);
    const inSess = minutes >= 570 && minutes < 960;
    const inOrWin = minutes >= 570 && minutes < 575;
    const inPmWin = minutes >= 240 && minutes < 570;
    const inOrb15Win = minutes >= 570 && minutes < 585;
    const inPrimeAm = minutes >= 575 && minutes < 690;
    const inLunch = minutes >= 690 && minutes < 810;
    const inPrimePm = minutes >= 810 && minutes < 900;
    const inLate = minutes >= 900 && minutes < 960;

    if (inPmWin) { pmh = pmh == null ? bar.high : Math.max(pmh, bar.high); pml = pml == null ? bar.low : Math.min(pml, bar.low); }
    if (inOrWin) { orHigh = orHigh == null ? bar.high : Math.max(orHigh, bar.high); orLow = orLow == null ? bar.low : Math.min(orLow, bar.low); }
    if (inOrb15Win) { orb15High = orb15High == null ? bar.high : Math.max(orb15High, bar.high); orb15Low = orb15Low == null ? bar.low : Math.min(orb15Low, bar.low); }
    if (orb15High != null && bar.close > orb15High) orb15BrokeUp = true;
    if (orb15Low != null && bar.close < orb15Low) orb15BrokeDn = true;
    if (inSess) { const tp = (bar.high + bar.low + bar.close) / 3; vwapCumPV += tp * bar.volume; vwapCumV += bar.volume; }
    const vwap = vwapCumV > 0 ? vwapCumPV / vwapCumV : null;

    const r = rsi[i], rPeak = rsiPeak30[i], rTrough = rsiTrough30[i];
    const callSwing = (rPeak != null && r != null) ? rPeak - r : 0;
    const putSwing = (rTrough != null && r != null) ? r - rTrough : 0;
    const rPrev = i > 0 ? rsi[i - 1] : null;
    if (r != null && rPrev != null) {
      if (rPrev < RSI_PUT && r >= RSI_PUT) putTaps++;
      if (rPrev > RSI_CALL && r <= RSI_CALL) callTaps++;
    }
    if (r != null) {
      if (r >= SOFT_PUT) { softPutToday = true; softPutIdx = i; }
      if (r <= SOFT_CALL) { softCallToday = true; softCallIdx = i; }
    }

    // WICK-AWARE TOUCH DETECTION. The Pine script tests |close - level| <=
    // zone, but the playbook's own worked example is a WICK tag: "1-min
    // candle wicks to $750.20, closes at $749.75. Rejection confirmed." A
    // close-only test cannot see that trade (close is 5x outside the zone).
    // So a touch = the bar's high-low range intersecting level ± zone. Same
    // ±$0.05 zone, no padding — this also absorbs most penny-level
    // differences between Alpaca's SIP tape and TV's composite feed.
    const touches = (lv) => lv != null && bar.high >= lv - TOUCH_ZONE && bar.low <= lv + TOUCH_ZONE;

    // The whole-dollar level in play: prefer the dollar nearest the close,
    // but a wick can tag an adjacent dollar the close doesn't round to
    // (close $770.55 -> 771, wick tags $770). Check all three candidates.
    const watch = [Math.round(bar.close), Math.round(bar.high), Math.round(bar.low)]
      .find((lv) => touches(lv)) ?? Math.round(bar.close);
    const isMajor10 = watch % 10 === 0, isMajor5 = watch % 5 === 0;
    const atLevel = touches(watch);
    const atOrHigh = touches(orHigh);
    const atOrLow = touches(orLow);
    const atPdh = touches(pdh);
    const atPdl = touches(pdl);
    const atPmh = touches(pmh);
    const atPml = touches(pml);
    const atOrb15Sup = orb15BrokeUp && touches(orb15High);
    const atOrb15Res = orb15BrokeDn && touches(orb15Low);
    const atVwap = touches(vwap);

    // Preserve the actual level that made the setup eligible. `watch` is only
    // the nearest whole-dollar display level; using it for PDH/PDL, PMH/PML,
    // OR or VWAP signals can select the wrong option strike.
    const callLevelCandidates = [
      { active: atPdl, value: pdl, type: "PDL" },
      { active: atLevel, value: watch, type: "WHOLE_DOLLAR" },
      { active: atOrLow, value: orLow, type: "OR_LOW" },
      { active: atPml, value: pml, type: "PML" },
      { active: atOrb15Sup, value: orb15High, type: "ORB15_SUPPORT" },
      { active: atVwap, value: vwap, type: "VWAP" },
    ].filter((x) => x.active && x.value != null);
    const putLevelCandidates = [
      { active: atPdh, value: pdh, type: "PDH" },
      { active: atLevel, value: watch, type: "WHOLE_DOLLAR" },
      { active: atOrHigh, value: orHigh, type: "OR_HIGH" },
      { active: atPmh, value: pmh, type: "PMH" },
      { active: atOrb15Res, value: orb15Low, type: "ORB15_RESISTANCE" },
      { active: atVwap, value: vwap, type: "VWAP" },
    ].filter((x) => x.active && x.value != null);
    const callTrigger = callLevelCandidates[0] || null;
    const putTrigger = putLevelCandidates[0] || null;

    // Count distinct arrivals, not consecutive bars sitting on a level. VWAP
    // moves every bar, so its stable identity is its type; fixed levels also
    // include price so independent whole-dollar levels remain separate.
    const touchKey = (x) => x.type === "VWAP" ? "VWAP" : `${x.type}:${Number(x.value).toFixed(4)}`;
    const currentLevelTouches = new Set([...callLevelCandidates, ...putLevelCandidates].map(touchKey));
    for (const key of currentLevelTouches) {
      if (!activeLevelTouches.has(key)) levelTouchCounts.set(key, (levelTouchCounts.get(key) || 0) + 1);
    }
    activeLevelTouches = currentLevelTouches;
    const callTouchNumber = callTrigger ? (levelTouchCounts.get(touchKey(callTrigger)) || 1) : null;
    const putTouchNumber = putTrigger ? (levelTouchCounts.get(touchKey(putTrigger)) || 1) : null;

    const callCtxLv = atOrLow || atPml || atOrb15Sup || atVwap;
    const putCtxLv = atOrHigh || atPmh || atOrb15Res || atVwap;
    const callConfCount = (atLevel && isMajor5 ? 1 : 0) + (atPdl ? 1 : 0) + (atOrLow ? 1 : 0) + (atPml ? 1 : 0) + (atOrb15Sup ? 1 : 0) + (atVwap ? 1 : 0);
    const putConfCount = (atLevel && isMajor5 ? 1 : 0) + (atPdh ? 1 : 0) + (atOrHigh ? 1 : 0) + (atPmh ? 1 : 0) + (atOrb15Res ? 1 : 0) + (atVwap ? 1 : 0);

    let callLv = 0;
    if (atLevel && isMajor10 && atPdl) callLv = 6;
    else if ((atLevel && isMajor5) || atPdl) callLv = callConfCount >= 3 ? 5 : 4;
    else if (atLevel) callLv = 2;
    else if (callCtxLv) callLv = callConfCount >= 2 ? 2 : 1;

    let putLv = 0;
    if (atLevel && isMajor10 && atPdh) putLv = 6;
    else if ((atLevel && isMajor5) || atPdh) putLv = putConfCount >= 3 ? 5 : 4;
    else if (atLevel) putLv = 2;
    else if (putCtxLv) putLv = putConfCount >= 2 ? 2 : 1;

    const isPutRsi = r != null && r >= RSI_PUT, isCallRsi = r != null && r <= RSI_CALL;
    const putApproach = r != null && r >= 68 && r < RSI_PUT;
    const callApproach = r != null && r <= 33 && r > RSI_CALL;
    const putVelocity = r != null && r >= VELOCITY_FLOOR && putSwing >= EXT_SWING_MIN;
    const callVelocity = r != null && r <= (100 - VELOCITY_FLOOR) && callSwing >= EXT_SWING_MIN;

    let callRsiSwg = 0;
    if (isCallRsi && callSwing >= 48) callRsiSwg = 4;
    else if (isCallRsi || (callVelocity && callSwing >= EXT_SWING_MIN)) callRsiSwg = 3;
    else if (callApproach && callSwing >= SWING_MIN) callRsiSwg = 2;
    else if (callSwing >= SWING_MIN) callRsiSwg = 1;

    let putRsiSwg = 0;
    if (isPutRsi && putSwing >= 48) putRsiSwg = 4;
    else if (isPutRsi || (putVelocity && putSwing >= EXT_SWING_MIN)) putRsiSwg = 3;
    else if (putApproach && putSwing >= SWING_MIN) putRsiSwg = 2;
    else if (putSwing >= SWING_MIN) putRsiSwg = 1;

    const volMaV = volMa[i], atrV = atr[i], adxV = adx[i];
    // Pine's ta.highest(volume, 20) — the max over the trailing 20 bars.
    // (Was previously reading index [0] of a rolling series, which returned
    // the FIRST bar's value instead of the window max, so climax volume
    // fired far too often.)
    let vol20High = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) vol20High = Math.max(vol20High, volumes[j]);
    const volClimax = volMaV != null && (volumes[i] >= vol20High * 0.85 || volumes[i] > volMaV * 2.0);
    const volConfirm = volMaV != null && volumes[i] > volMaV * 1.4;
    const priorClose4 = i >= SPEED_LOOKBACK ? closes[i - SPEED_LOOKBACK] : null;
    const priceVelocity = priorClose4 != null ? Math.abs(bar.close - priorClose4) / SPEED_LOOKBACK : 0;
    const velocityRatio = atrV ? priceVelocity / atrV : 0;
    const isFastUp = priorClose4 != null && bar.close > priorClose4 && velocityRatio >= SPEED_ATR_MULT;
    const isFastDn = priorClose4 != null && bar.close < priorClose4 && velocityRatio >= SPEED_ATR_MULT;
    const barBody = Math.abs(bar.close - bar.open);
    const wickUpper = bar.high - Math.max(bar.open, bar.close), wickLower = Math.min(bar.open, bar.close) - bar.low;
    const putWickRej = barBody > 0 && wickUpper >= barBody * WICK_RATIO;
    const callWickRej = barBody > 0 && wickLower >= barBody * WICK_RATIO;

    const callVolPts = volClimax ? 2 : volConfirm ? 1 : 0, callSpeedPts = isFastDn ? 2 : 0, callWickPts = callWickRej ? 1 : 0;
    const putVolPts = volClimax ? 2 : volConfirm ? 1 : 0, putSpeedPts = isFastUp ? 2 : 0, putWickPts = putWickRej ? 1 : 0;
    const callConfirm = callVolPts + callSpeedPts + callWickPts, putConfirm = putVolPts + putSpeedPts + putWickPts;

    let callTapSoft = (callTaps >= 2 ? 1 : 0) + ((softCallToday && (i - softCallIdx) <= 60) ? 1 : 0);
    let putTapSoft = (putTaps >= 2 ? 1 : 0) + ((softPutToday && (i - softPutIdx) <= 60) ? 1 : 0);
    callTapSoft = Math.min(callTapSoft, 2); putTapSoft = Math.min(putTapSoft, 2);

    const mtfCallConf = r != null && rsi5[i] != null && rsi10[i] != null && r <= RSI_CALL && rsi5[i] <= RSI_CALL && rsi10[i] <= RSI_CALL;
    const mtfPutConf = r != null && rsi5[i] != null && rsi10[i] != null && r >= RSI_PUT && rsi5[i] >= RSI_PUT && rsi10[i] >= RSI_PUT;
    const mtfCallBonus = mtfCallConf ? 2 : 0, mtfPutBonus = mtfPutConf ? 2 : 0;

    let regimeAdj = 0;
    if (inPrimeAm || inPrimePm) regimeAdj = 1; else if (inLunch || inLate) regimeAdj = -1;
    if (i >= openIdx) {
      dayHighSoFar = dayHighSoFar == null ? bar.high : Math.max(dayHighSoFar, bar.high);
      dayLowSoFar = dayLowSoFar == null ? bar.low : Math.min(dayLowSoFar, bar.low);
    }
    const dayRangeSoFar = (dayHighSoFar != null && dayLowSoFar != null) ? dayHighSoFar - dayLowSoFar : 0;
    const dayProgress = dailyAtr14 ? dayRangeSoFar / dailyAtr14 : 0;
    if (dayProgress >= 0.75) regimeAdj += 1;

    // The Pine script advertises a 20-point scale even though the category
    // maxima sum to 21. Cap the replay so `/20` remains truthful.
    let callPts = Math.min(20, Math.max(0, callLv + callRsiSwg + callConfirm + callTapSoft + mtfCallBonus + regimeAdj));
    let putPts = Math.min(20, Math.max(0, putLv + putRsiSwg + putConfirm + putTapSoft + mtfPutBonus + regimeAdj));

    const strongTrend = adxV != null && adxV >= ADX_STRONG;
    const aplusThresh = APLUS_BASE + (strongTrend ? 2 : 0);

    const callElig = inSess && !isGapUp && (atLevel || atOrLow || atPdl || atPml || atOrb15Sup || atVwap) && (isCallRsi || callApproach || callSwing >= SWING_MIN);
    const putElig = inSess && !isGapDn && (atLevel || atOrHigh || atPdh || atPmh || atOrb15Res || atVwap) && (isPutRsi || putApproach || putSwing >= SWING_MIN);

    const recentHigh30 = Math.max(...allBars.slice(Math.max(0, i - 29), i + 1).map((b) => b.high));
    const recentLow30 = Math.min(...allBars.slice(Math.max(0, i - 29), i + 1).map((b) => b.low));
    const magConfirm = atrV != null && (recentHigh30 - recentLow30) >= atrV * 3;
    const callRsiExtElig = inSess && !isGapUp && isCallRsi && (callSwing >= RSI_EXT_SWING || magConfirm) && (volClimax || magConfirm);
    const putRsiExtElig = inSess && !isGapDn && isPutRsi && (putSwing >= RSI_EXT_SWING || magConfirm) && (volClimax || magConfirm);

    const closeGuardIdx = i - TREND_GUARD_LOOKBACK;
    const netMoveGuard = closeGuardIdx >= 0 ? bar.close - closes[closeGuardIdx] : 0;
    const strongUpGuard = atrV != null && netMoveGuard >= atrV * TREND_GUARD_ATR_MULT;
    const strongDnGuard = atrV != null && netMoveGuard <= -(atrV * TREND_GUARD_ATR_MULT);

    const callHasTwoConf = ((callVolPts >= 1) + (callSpeedPts >= 1) + (callWickPts >= 1)) >= 2;
    const putHasTwoConf = ((putVolPts >= 1) + (putSpeedPts >= 1) + (putWickPts >= 1)) >= 2;
    const callAplus = callElig && callPts >= aplusThresh && callLv >= 3 && callHasTwoConf;
    const putAplus = putElig && putPts >= aplusThresh && putLv >= 3 && putHasTwoConf;
    const callA = callElig && callPts >= A_TIER_MIN && callPts < aplusThresh && !strongDnGuard;
    const putA = putElig && putPts >= A_TIER_MIN && putPts < aplusThresh && !strongUpGuard;

    // Playbook touch rule: first touch is normal, second touch drops one size
    // tier, third touch is skipped unless a $4+ 30-minute exhaustion move ran
    // into the level. Fourth and later touches are always skipped.
    const callTouchPolicy = playbookTouchPolicy({ touchNumber: callTouchNumber, exhaustionMove: callTrigger == null ? 0 : recentHigh30 - callTrigger.value });
    const putTouchPolicy = playbookTouchPolicy({ touchNumber: putTouchNumber, exhaustionMove: putTrigger == null ? 0 : putTrigger.value - recentLow30 });
    const callExhaustionException = callTouchPolicy.exhaustionException;
    const putExhaustionException = putTouchPolicy.exhaustionException;
    const callTouchEligible = callTouchPolicy.eligible;
    const putTouchEligible = putTouchPolicy.eligible;

    let firstTouch = false;
    if (atLevel) {
      const slot = watch;
      if (!touchedSlots.has(slot)) { touchedSlots.add(slot); firstTouch = true; }
    }

    const callCooled = (i - lastCallBar) >= CALL_COOLDOWN, putCooled = (i - lastPutBar) >= CALL_COOLDOWN;
    const callACooled = (i - lastCallABar) >= A_COOLDOWN, putACooled = (i - lastPutABar) >= A_COOLDOWN;
    const callExtCooled = (i - lastCallExtBar) >= EXT_COOLDOWN, putExtCooled = (i - lastPutExtBar) >= EXT_COOLDOWN;

    const fireCallAp = callAplus && callTouchEligible && callCooled && (firstTouch || callTouchNumber === 2 || callExhaustionException || atOrLow || atPdl || atPml || atOrb15Sup || atVwap) && !prevCallAplus;
    const firePutAp = putAplus && putTouchEligible && putCooled && (firstTouch || putTouchNumber === 2 || putExhaustionException || atOrHigh || atPdh || atPmh || atOrb15Res || atVwap) && !prevPutAplus;
    // EDGE TRIGGERS. Pine fires these with `and not <cond>[1]` — only on the
    // bar the condition FIRST becomes true. Without that, a condition that
    // stays true for 40 bars re-fires every time its cooldown lapses, which
    // inflated the signal count well beyond what the live tool shows.
    const fireCallA = callA && callTouchEligible && callACooled && !prevCallA;
    const firePutA = putA && putTouchEligible && putACooled && !prevPutA;
    const fireCallExt = callRsiExtElig && callExtCooled && !prevCallExt;
    const firePutExt = putRsiExtElig && putExtCooled && !prevPutExt;

    const suggestedStop = atrV != null ? +(atrV * 1.8).toFixed(2) : null;
    const sizeFor = (pts, touchNumber) => {
      const tiers = ["HALF $500", "FULL $1000", "SIZE UP $1500", "MAX $2000"];
      let idx = pts >= aplusThresh + 3 ? 3 : pts >= aplusThresh + 1 ? 2 : pts >= aplusThresh ? 1 : 0;
      if (touchNumber === 2) idx = Math.max(0, idx - 1);
      return tiers[idx];
    };
    // Where this minute sits in the playbook's schedule.
    const pbWindow = minutes < PB_OPEN_MIN ? "before" : minutes < PB_CLOSE_MIN ? "in" : "after";

    // Paper-only research lanes. These never enter the official `fires` list,
    // so playbook P&L is unchanged. HIGH_QUALITY_A tests 13-14 point first
    // touches with the live script's strong-level/two-confirmation gates.
    // EXTENDED_A_PLUS measures otherwise-identical A+ setups until 12:30 ET.
    const callResearch = classifyResearchCandidate({ minutes, points: callPts, aplusThreshold: aplusThresh, levelPoints: callLv, hasTwoConfirmations: callHasTwoConf, touchNumber: callTouchNumber, isAplus: callAplus && callTouchEligible });
    const putResearch = classifyResearchCandidate({ minutes, points: putPts, aplusThreshold: aplusThresh, levelPoints: putLv, hasTwoConfirmations: putHasTwoConf, touchNumber: putTouchNumber, isAplus: putAplus && putTouchEligible });
    const pushExperiment = (lane, direction, trigger, points, rsiValue, swing, volPts, speedPts, wickPts, touchNumber) => {
      if (!lane || !trigger) return;
      experiments.push({ lane, paperOnly: true, window: lane === "HIGH_QUALITY_A" ? "in" : "extended", tier: lane === "HIGH_QUALITY_A" ? "Research 13-14" : "Extended A+", direction,
        idx: i, ts: bar.ts, clock: clockLabel(minutes), level: trigger.value, levelType: trigger.type, price: bar.close, points,
        rsi: rsiValue, swing: Math.round(swing), size: "PAPER $1000", touchNumber,
        volPts, speedPts, wickPts, suggestedStop, exitCutoffMin: lane === "HIGH_QUALITY_A" ? PB_CLOSE_MIN : RESEARCH_EXTENDED_END_MIN });
    };
    if (callResearch && callResearch !== prevCallResearch) pushExperiment(callResearch, "CALL", callTrigger, callPts, r != null ? Math.round(r) : null, callSwing, callVolPts, callSpeedPts, callWickPts, callTouchNumber);
    if (putResearch && putResearch !== prevPutResearch) pushExperiment(putResearch, "PUT", putTrigger, putPts, r != null ? Math.round(r) : null, putSwing, putVolPts, putSpeedPts, putWickPts, putTouchNumber);

    // Separate paper-only implementation of the Shen Lao playbook's simpler
    // three-check conviction stack. It does not require an Edge Lens score.
    // The source playbook caps the day at two trades, so this lane does too.
    const pushShenExperiment = (direction, trigger, touchNumber, touchPolicy, moveDistance, rsiValue, points, approachValid) => {
      if (!trigger || playbookExperiments.length >= 2) return;
      const result = classifyShenConviction({ minutes, levelType: trigger.type, touchNumber,
        exhaustionMove: moveDistance, moveDistance, rsi: rsiValue, direction, approachValid });
      const key = `${direction}:${touchKey(trigger)}:${touchNumber}`;
      if (!result || shenFiredKeys.has(key)) return;
      shenFiredKeys.add(key);
      playbookExperiments.push({ lane: "SHEN_CONVICTION", method: "Shen Lao conviction stack", paperOnly: true,
        window: "in", tier: `Shen ${result.grade} ${result.convictionCount}/3`, direction,
        idx: i, ts: bar.ts, clock: clockLabel(minutes), level: trigger.value, levelType: trigger.type,
        price: bar.close, points, rsi: rsiValue != null ? Math.round(rsiValue) : null,
        touchNumber, exhaustionException: touchPolicy.exhaustionException, size: "PAPER $1000",
        convictionCount: result.convictionCount, convictionChecks: result.checks,
        moveDistance: +moveDistance.toFixed(2), suggestedStop, exitCutoffMin: PB_CLOSE_MIN });
    };
    const close30BarsAgo = closes[Math.max(0, i - 29)];
    pushShenExperiment("CALL", callTrigger, callTouchNumber, callTouchPolicy,
      callTrigger == null ? 0 : recentHigh30 - callTrigger.value, r, callPts, bar.close < close30BarsAgo);
    pushShenExperiment("PUT", putTrigger, putTouchNumber, putTouchPolicy,
      putTrigger == null ? 0 : putTrigger.value - recentLow30, r, putPts, bar.close > close30BarsAgo);

    // Compact diagnostic sampling: one identical reason set per direction per
    // 15-minute bucket. This reveals which gate suppresses the most setups
    // without returning hundreds of duplicate bars that sat on one level.
    const captureNearMiss = (direction, eligible, trigger, points, levelPoints, hasTwoConfirmations, touchNumber) => {
      if (!eligible || !trigger || minutes < PB_OPEN_MIN || minutes >= RESEARCH_EXTENDED_END_MIN) return;
      const reasons = [];
      if (points < RESEARCH_SCORE_MIN) reasons.push("score_below_13");
      if (levelPoints < 3) reasons.push("level_below_3");
      if (!hasTwoConfirmations) reasons.push("fewer_than_2_confirmations");
      if (touchNumber !== 1) reasons.push("not_first_touch");
      if (minutes >= PB_CLOSE_MIN) reasons.push("outside_playbook_hours");
      if (!reasons.length) return;
      const key = `${direction}:${Math.floor(minutes / 15)}:${reasons.join("|")}`;
      if (nearMissKeys.has(key)) return;
      nearMissKeys.add(key);
      nearMisses.push({ direction, clock: clockLabel(minutes), points, level: trigger.value, levelType: trigger.type, reasons });
    };
    captureNearMiss("CALL", callElig, callTrigger, callPts, callLv, callHasTwoConf, callTouchNumber);
    captureNearMiss("PUT", putElig, putTrigger, putPts, putLv, putHasTwoConf, putTouchNumber);

    if (fireCallAp) {
      lastCallBar = i;
      fires.push({ window: pbWindow, tier: "A+", direction: "CALL", idx: i, ts: bar.ts, clock: clockLabel(minutes), level: callTrigger.value, levelType: callTrigger.type, price: bar.close,
        points: callPts, rsi: r != null ? Math.round(r) : null, swing: Math.round(callSwing), size: sizeFor(callPts, callTouchNumber), touchNumber: callTouchNumber, exhaustionException: callExhaustionException,
        volPts: callVolPts, speedPts: callSpeedPts, wickPts: callWickPts, mtfAligned: mtfCallConf, suggestedStop });
    }
    if (firePutAp) {
      lastPutBar = i;
      fires.push({ window: pbWindow, tier: "A+", direction: "PUT", idx: i, ts: bar.ts, clock: clockLabel(minutes), level: putTrigger.value, levelType: putTrigger.type, price: bar.close,
        points: putPts, rsi: r != null ? Math.round(r) : null, swing: Math.round(putSwing), size: sizeFor(putPts, putTouchNumber), touchNumber: putTouchNumber, exhaustionException: putExhaustionException,
        volPts: putVolPts, speedPts: putSpeedPts, wickPts: putWickPts, mtfAligned: mtfPutConf, suggestedStop });
    }
    if (fireCallA) { lastCallABar = i; fires.push({ window: pbWindow, tier: "A", direction: "CALL", idx: i, ts: bar.ts, clock: clockLabel(minutes), level: callTrigger.value, levelType: callTrigger.type, price: bar.close, points: callPts, rsi: r != null ? Math.round(r) : null, size: callTouchPolicy.dropSizeTier ? "HALF $500" : "FULL $1000", touchNumber: callTouchNumber, exhaustionException: callExhaustionException, suggestedStop }); }
    if (firePutA) { lastPutABar = i; fires.push({ window: pbWindow, tier: "A", direction: "PUT", idx: i, ts: bar.ts, clock: clockLabel(minutes), level: putTrigger.value, levelType: putTrigger.type, price: bar.close, points: putPts, rsi: r != null ? Math.round(r) : null, size: putTouchPolicy.dropSizeTier ? "HALF $500" : "FULL $1000", touchNumber: putTouchNumber, exhaustionException: putExhaustionException, suggestedStop }); }
    if (fireCallExt) { lastCallExtBar = i; fires.push({ window: pbWindow, tier: "RSI Extreme", direction: "CALL", idx: i, ts: bar.ts, clock: clockLabel(minutes), price: bar.close, rsi: r != null ? Math.round(r) : null, swing: Math.round(callSwing), suggestedStop }); }
    if (firePutExt) { lastPutExtBar = i; fires.push({ window: pbWindow, tier: "RSI Extreme", direction: "PUT", idx: i, ts: bar.ts, clock: clockLabel(minutes), price: bar.close, rsi: r != null ? Math.round(r) : null, swing: Math.round(putSwing), suggestedStop }); }

    prevCallAplus = callAplus; prevPutAplus = putAplus;
    prevCallA = callA; prevPutA = putA;
    prevCallExt = callRsiExtElig; prevPutExt = putRsiExtElig;
    prevCallResearch = callResearch; prevPutResearch = putResearch;

    barRows.push({ ts: bar.ts, min: minutes, window: pbWindow, clock: clockLabel(minutes), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
      rsi: r != null ? +r.toFixed(1) : null, callPts, putPts, vwap: vwap != null ? +vwap.toFixed(2) : null, inSession: inSess });
  }

  return {
    ok: true,
    symbol, sessionDate,
    levels: { pdh, pdl, pmh, pml, orHigh, orLow, orb15High, orb15Low, dailyAtr14 },
    gap: { isGapUp, isGapDn, gapSize: dailyAtr14 != null ? +gapSize.toFixed(2) : null },
    bars: barRows,
    fires, experiments, playbookExperiments, nearMisses,
  };
}

// 1-strike-OTM contract per the Shen Lao playbook's strike-selection rule:
// puts = 1 whole-dollar strike BELOW the level, calls = 1 strike ABOVE.
export function pickOtmStrike({ level, direction }) {
  return direction === "PUT" ? Math.ceil(level) - 1 : Math.floor(level) + 1;
}
