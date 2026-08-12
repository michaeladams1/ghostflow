// Local-only FAT-WINNER sleeve bakeoff. NO Postgres writes. NO deploy.
//
// Success bar (user):
//   • Aim for ≥ +25% option return per winner (TP +25% / +30%)
//   • ~1 trade per day (expansion days only)
//   • Score fat-win rate + $1k paper P&L — not "scrapes green"
//   • Heavy Quant Data: net_flow, order_flow, net_drift, GEX, price
//
// Universe defaults: QQQ, SPY, NVDA (liquid optionable names).
//
//   node --env-file=.env server/evalFatWinnerBakeoff.js
//   FAT_EVAL_MAX_DATES=80 FAT_EVAL_TICKERS=QQQ,SPY node server/evalFatWinnerBakeoff.js
//
// Completion: [fat-eval] complete

if (process.env.DATABASE_PUBLIC_URL
  && (!process.env.DATABASE_URL || /railway\.internal/.test(process.env.DATABASE_URL))) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fetchAlpacaBars } from "./alpacaClient.js";
import { fetchEndpointCached } from "./quantDataClient.js";
import { QD_ENDPOINTS } from "./quantDataRegistry.js";
import { sessionRthBars, priorDayHl, attachVwap, paperPnl } from "./scanLib.js";
import { simulateBracketTrade } from "./zeroDTEOptionSim.js";
import { pickOtmStrike } from "./zeroDTE.js";
import { parseGexByExpiry } from "./frontierGamma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "data", "fat-winner-eval");
const MAX = Number(process.env.FAT_EVAL_MAX_DATES || 240);
const CODE = process.env.FAT_EVAL_CODE_VERSION || "89d991cddb31";
const TICKERS = (process.env.FAT_EVAL_TICKERS || "QQQ,SPY,NVDA")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const DOLLARS = 1000;
const FAT_PCT = Number(process.env.FAT_EVAL_FAT_PCT || 25); // ≥25% = fat win
const EXP_RANGE_PCT = Number(process.env.FAT_EVAL_EXP_RANGE || 0.50); // early range % of open
const FLOW_SPIKE_USD = Number(process.env.FAT_EVAL_FLOW_SPIKE || 120_000);
const BLOCK_MIN_USD = Number(process.env.FAT_EVAL_BLOCK_MIN || 100_000);
const FLOW_MAX_PAGES = Number(process.env.FAT_EVAL_FLOW_PAGES || 120);
const WINDOW_END = 840;   // 14:00 ET
const ENTRY_AFTER_EXP = 600; // expansion measured through 10:00; fires after

const netFlowEp = QD_ENDPOINTS.find((e) => e.id === "net_flow");
const netDriftEp = QD_ENDPOINTS.find((e) => e.id === "net_drift");
const gexEp = QD_ENDPOINTS.find((e) => e.id === "exposure_by_strike_gamma");
const priceEp = QD_ENDPOINTS.find((e) => e.id === "stock_price_over_time");

const FLOW_CACHE_DIR = path.join(OUT_DIR, "flow");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Independent RTH flow walk (does not reuse Gamma disk caches that often stop at noon).
 * Newest-first pagination until oldest row ≤ ENTRY_AFTER_EXP or page cap.
 */
async function fetchRthFlow({ ticker, sessionDate }) {
  fs.mkdirSync(FLOW_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(FLOW_CACHE_DIR, `${ticker}_${sessionDate}_p${FLOW_MAX_PAGES}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (cached?.ok && Array.isArray(cached?.data?.rows)
        && (cached.data.oldestMin == null || cached.data.oldestMin <= ENTRY_AFTER_EXP + 45)) {
        return cached;
      }
    } catch { /* refetch */ }
  }
  if (!process.env.QUANTDATA_API_KEY) {
    return { ok: false, data: { rows: [] } };
  }

  const rows = [];
  const seen = new Set();
  let searchAfter = null;
  let pages = 0;
  let oldestMin = Infinity;

  while (pages < FLOW_MAX_PAGES) {
    const body = { filter: { ticker }, sessionDate, pageSize: 100 };
    if (searchAfter) body.searchAfter = searchAfter;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let json;
    try {
      const res = await fetch("https://api.quantdata.us/v1/options/tool/order-flow/consolidated", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.QUANTDATA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (res.status === 429) {
        await sleep(2000 * (pages % 3 + 1));
        continue;
      }
      if (!res.ok) break;
      json = JSON.parse(text);
    } catch {
      clearTimeout(timer);
      break;
    }
    const batch = Array.isArray(json.data) ? json.data : Object.values(json.data || {});
    if (!batch.length) break;
    pages += 1;
    for (const row of batch) {
      const id = row.id || `${row.tradeTime}|${row.strikePrice}|${row.premium}|${row.contractType}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      const min = etMin(row.tradeTime ?? row.timestamp);
      if (Number.isFinite(min)) oldestMin = Math.min(oldestMin, min);
    }
    const next = json.nextSearchAfter;
    if (!next || next === searchAfter) break;
    searchAfter = next;
    if (Number.isFinite(oldestMin) && oldestMin <= ENTRY_AFTER_EXP) break;
    await sleep(60);
  }

  const result = {
    ok: true,
    data: { rows, pages, oldestMin: Number.isFinite(oldestMin) ? oldestMin : null },
  };
  try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch { /* ignore */ }
  if (pages > 0) {
    console.log(`[fat-eval] flow ${ticker} ${sessionDate} pages=${pages} rows=${rows.length} oldest=${result.data.oldestMin}`);
  }
  return result;
}

const STRATEGY_IDS = [
  "FLOW_SPIKE_25",
  "FLOW_SPIKE_30",
  "BLOCK_FOLLOW_30",
  "DRIFT_ALIGN_30",
  "NEG_GEX_FLOW_30",
];

function etMin(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(Number.isFinite(Number(ts)) ? Number(ts) : ts));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return Number(map.hour) * 60 + Number(map.minute);
}

function minToClock(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  return `${((h24 + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h24 >= 12 ? "PM" : "AM"}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dbUrl() {
  return process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

function rowsOf(result) {
  const raw = result?.data?.data;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((row, i) => [String(i), row]);
  return Object.entries(raw);
}

/** Differenced per-minute call/put premium from cumulative net_flow. */
function netFlowSeries(flowResult) {
  const entries = rowsOf(flowResult)
    .map(([k, v]) => {
      const ts = Number(v?.timestamp ?? k);
      const min = Number.isFinite(ts) ? etMin(ts) : null;
      return {
        min,
        call: Number(v?.callSum ?? v?.call ?? 0),
        put: Number(v?.putSum ?? v?.put ?? 0),
      };
    })
    .filter((r) => r.min != null && r.min >= 570 && r.min <= 960)
    .sort((a, b) => a.min - b.min);

  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    const prev = i > 0 ? entries[i - 1] : { call: 0, put: 0 };
    const dCall = cur.call - prev.call;
    const dPut = cur.put - prev.put;
    out.push({
      min: cur.min,
      dCall,
      dPut,
      net: dCall - dPut,
      abs: Math.abs(dCall) + Math.abs(dPut),
    });
  }
  return out;
}

function driftSeries(driftResult) {
  return rowsOf(driftResult)
    .map(([k, v]) => {
      const ts = Number(v?.timestamp ?? k);
      const min = Number.isFinite(ts) ? etMin(ts) : null;
      return {
        min,
        netCall: Number(v?.netCallPremium ?? 0),
        netPut: Number(v?.netPutPremium ?? 0),
        spot: Number(v?.closePrice ?? v?.price ?? NaN),
      };
    })
    .filter((r) => r.min != null)
    .sort((a, b) => a.min - b.min);
}

/** Net GEX for session 0DTE expiry if present, else sum across expiries. */
function parseNetGex(gexResult, sessionDate) {
  const byExp = parseGexByExpiry(gexResult);
  if (!byExp.size) return null;
  if (byExp.has(sessionDate)) return byExp.get(sessionDate).net;
  let net = 0;
  for (const v of byExp.values()) net += v.net;
  return net;
}

function earlyExpansion({ rth, open }) {
  if (!(open > 0) || !rth?.length) return { ok: false, rangePct: 0 };
  const early = rth.filter((b) => {
    const m = etMin(b.ts);
    return m >= 570 && m < ENTRY_AFTER_EXP;
  });
  if (early.length < 5) return { ok: false, rangePct: 0 };
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of early) {
    hi = Math.max(hi, Number(b.high ?? b.close));
    lo = Math.min(lo, Number(b.low ?? b.close));
  }
  const rangePct = ((hi - lo) / open) * 100;
  return { ok: rangePct >= EXP_RANGE_PCT, rangePct: +rangePct.toFixed(3), hi, lo };
}

/** Build a UTC ms timestamp whose America/New_York clock equals etMinute on sessionDate. */
function tsForEtMinute(sessionDate, etMinute) {
  const h = Math.floor(etMinute / 60);
  const m = etMinute % 60;
  // Probe noon UTC on the calendar date — enough to know EST vs EDT offset that day.
  const probe = new Date(`${sessionDate}T17:00:00Z`);
  const etHourAtProbe = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false,
  }).format(probe));
  const offsetHours = 17 - etHourAtProbe; // 4 (EDT) or 5 (EST)
  const iso = `${sessionDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  return Date.parse(`${iso}Z`) + offsetHours * 3600_000;
}

function fireBase(sessionDate, ticker, {
  etMinute, direction, level, levelType, scan, tpMult, slMult, strike, useFireStrike, barTs,
}) {
  return {
    ts: barTs ?? tsForEtMinute(sessionDate, etMinute),
    etMinute,
    clock: minToClock(etMinute),
    direction,
    level: level ?? null,
    levelType: levelType || "FLOW",
    tier: scan,
    scan,
    window: "fat_eval",
    size: `FULL $${DOLLARS}`,
    paperOnly: true,
    expiration: sessionDate,
    expirationMode: "0DTE",
    dte: 0,
    tpMult,
    slMult,
    exitCutoffMin: 945, // 15:45 ET
    skipFrontierWalk: true,
    maxPremiumDollars: DOLLARS,
    touchNumber: 1,
    method: `fat_eval_${scan}`,
    ticker,
    strike: strike ?? null,
    useFireStrike: !!useFireStrike,
  };
}

function barAt(rth, min) {
  return rth.find((x) => etMin(x.ts) >= min) || rth[rth.length - 1] || null;
}
function spotAt(rth, min) {
  const b = barAt(rth, min);
  return b ? Number(b.close) : null;
}

/** Build at most one candidate fire per strategy for this ticker/day. */
export function buildFatCandidates({ sessionDate, ticker, bars, feeds }) {
  const rth = sessionRthBars(bars, sessionDate);
  if (rth.length < 40) return {};
  const prior = priorDayHl(bars, sessionDate);
  const withVwap = attachVwap(rth);
  const open = withVwap[0]?.open ?? withVwap[0]?.close;
  const exp = earlyExpansion({ rth: withVwap, open });
  if (!exp.ok) return { _meta: { expand: false, rangePct: exp.rangePct } };

  const flow = netFlowSeries(feeds.net_flow);
  const drift = driftSeries(feeds.net_drift);
  const netGex = parseNetGex(feeds.gex, sessionDate);
  // Paginated flow stores rows at data.rows; single-page cache uses data.data.
  const rawBlocks = Array.isArray(feeds.order_flow?.data?.rows)
    ? feeds.order_flow.data.rows
    : rowsOf(feeds.order_flow).map(([, row]) => row);
  const blocks = rawBlocks
    .map((row) => {
      const ts = row?.tradeTime ?? row?.timestamp;
      const min = ts != null ? etMin(ts) : null;
      const type = String(row?.contractType || "").toUpperCase();
      return {
        min,
        premium: Number(row?.premium || 0),
        type: type.startsWith("P") ? "PUT" : (type.startsWith("C") ? "CALL" : type),
        strike: Number(row?.strikePrice),
        expiration: row?.expirationDate ? String(row.expirationDate).slice(0, 10) : null,
        sentiment: String(row?.sentimentType || ""),
      };
    })
    .filter((b) => b.min != null && b.premium > 0 && (b.type === "CALL" || b.type === "PUT"));

  const out = { _meta: { expand: true, rangePct: exp.rangePct, netGex } };

  // --- FLOW_SPIKE: largest |Δnet| premium minute in window ---
  let bestSpike = null;
  for (const f of flow) {
    if (f.min < ENTRY_AFTER_EXP || f.min > WINDOW_END) continue;
    if (Math.abs(f.net) < FLOW_SPIKE_USD) continue;
    if (!bestSpike || Math.abs(f.net) > Math.abs(bestSpike.net)) bestSpike = f;
  }
  if (bestSpike) {
    const direction = bestSpike.net > 0 ? "CALL" : "PUT";
    const bar = barAt(withVwap, bestSpike.min);
    const spot = bar ? Number(bar.close) : null;
    if (spot > 0) {
      const level = direction === "CALL" ? Math.floor(spot) : Math.ceil(spot);
      for (const [id, tp] of [["FLOW_SPIKE_25", 1.25], ["FLOW_SPIKE_30", 1.30]]) {
        out[id] = [fireBase(sessionDate, ticker, {
          etMinute: bestSpike.min,
          direction,
          level,
          levelType: "SPOT",
          scan: id,
          tpMult: tp,
          slMult: 0.85,
          barTs: bar.ts,
        })];
        out[id][0].featuresExtra = { net: bestSpike.net, rangePct: exp.rangePct };
      }
    }
  }

  // --- BLOCK_FOLLOW: largest RTH block → always trade SAME-DAY 0DTE in that direction ---
  let bestBlock = null;
  for (const b of blocks) {
    if (b.min < ENTRY_AFTER_EXP || b.min > WINDOW_END) continue;
    if (b.premium < BLOCK_MIN_USD) continue;
    const is0 = b.expiration === sessionDate;
    const score = b.premium * (is0 ? 1.4 : 1);
    if (!bestBlock || score > bestBlock.score) {
      bestBlock = { ...b, score, is0 };
    }
  }
  if (bestBlock) {
    const direction = bestBlock.type;
    const bar = barAt(withVwap, bestBlock.min);
    const spot = bar ? Number(bar.close) : null;
    if (spot > 0) {
      // Prefer the printed 0DTE strike when available; else 1-OTM from spot.
      const useStrike = bestBlock.is0 && bestBlock.strike > 0;
      const level = direction === "CALL" ? Math.floor(spot) : Math.ceil(spot);
      out.BLOCK_FOLLOW_30 = [fireBase(sessionDate, ticker, {
        etMinute: bestBlock.min,
        direction,
        level,
        levelType: useStrike ? "FLOW" : "SPOT",
        scan: "BLOCK_FOLLOW_30",
        tpMult: 1.30,
        slMult: 0.85,
        strike: useStrike ? bestBlock.strike : null,
        useFireStrike: useStrike,
        barTs: bar.ts,
      })];
      out.BLOCK_FOLLOW_30[0].featuresExtra = {
        premium: bestBlock.premium, is0: bestBlock.is0, rangePct: exp.rangePct,
      };
    }
  }

  // --- DRIFT_ALIGN: same-minute net_drift + net_flow same sign ---
  const driftByMin = new Map(drift.map((d) => [d.min, d]));
  let bestAlign = null;
  for (const f of flow) {
    if (f.min < ENTRY_AFTER_EXP || f.min > WINDOW_END) continue;
    if (Math.abs(f.net) < FLOW_SPIKE_USD * 0.6) continue;
    const d = driftByMin.get(f.min);
    if (!d) continue;
    const driftNet = d.netCall - d.netPut;
    if (Math.sign(driftNet) !== Math.sign(f.net) || driftNet === 0) continue;
    const score = Math.abs(f.net) + Math.abs(driftNet);
    if (!bestAlign || score > bestAlign.score) {
      bestAlign = { min: f.min, net: f.net, driftNet, score };
    }
  }
  if (bestAlign) {
    const direction = bestAlign.net > 0 ? "CALL" : "PUT";
    const bar = barAt(withVwap, bestAlign.min);
    const spot = bar ? Number(bar.close) : null;
    if (spot > 0) {
      out.DRIFT_ALIGN_30 = [fireBase(sessionDate, ticker, {
        etMinute: bestAlign.min,
        direction,
        level: direction === "CALL" ? Math.floor(spot) : Math.ceil(spot),
        levelType: "SPOT",
        scan: "DRIFT_ALIGN_30",
        tpMult: 1.30,
        slMult: 0.85,
        barTs: bar.ts,
      })];
      out.DRIFT_ALIGN_30[0].featuresExtra = {
        net: bestAlign.net, driftNet: bestAlign.driftNet, rangePct: exp.rangePct,
      };
    }
  }

  // --- NEG_GEX_FLOW: short gamma + flow spike ---
  if (netGex != null && netGex < 0 && bestSpike) {
    const direction = bestSpike.net > 0 ? "CALL" : "PUT";
    const bar = barAt(withVwap, bestSpike.min);
    const spot = bar ? Number(bar.close) : null;
    if (spot > 0) {
      out.NEG_GEX_FLOW_30 = [fireBase(sessionDate, ticker, {
        etMinute: bestSpike.min,
        direction,
        level: direction === "CALL" ? Math.floor(spot) : Math.ceil(spot),
        levelType: "SPOT",
        scan: "NEG_GEX_FLOW_30",
        tpMult: 1.30,
        slMult: 0.85,
        barTs: bar.ts,
      })];
      out.NEG_GEX_FLOW_30[0].featuresExtra = {
        netGex, net: bestSpike.net, rangePct: exp.rangePct,
      };
    }
  }

  return out;
}

async function loadCheapFeeds(ticker, sessionDate) {
  const [net_flow, net_drift, gex, price] = await Promise.all([
    fetchEndpointCached(netFlowEp, { ticker, sessionDate }),
    fetchEndpointCached(netDriftEp, { ticker, sessionDate }),
    fetchEndpointCached(gexEp, { ticker, sessionDate }),
    fetchEndpointCached(priceEp, { ticker, sessionDate }),
  ]);
  return { net_flow, net_drift, gex, price, order_flow: { ok: true, data: { rows: [] } } };
}

async function loadFeeds(ticker, sessionDate, { needBlocks = true } = {}) {
  const cheap = await loadCheapFeeds(ticker, sessionDate);
  if (!needBlocks) return cheap;
  const order_flow = await fetchRthFlow({ ticker, sessionDate });
  return { ...cheap, order_flow };
}

async function simulateLong(sessionDate, fire) {
  const ticker = fire.ticker || "QQQ";
  // Ensure strike exists for playbook OTM path
  if (!fire.useFireStrike && fire.level != null && !fire.strike) {
    fire.strike = pickOtmStrike({ level: fire.level, direction: fire.direction });
  }
  const r = await simulateBracketTrade({ ticker, sessionDate, fire });
  if (!r?.ok || !(r.entryPrice > 0)) return null;
  if (r.entryPrice * 100 > DOLLARS) return null;
  const pnl = paperPnl(r.entryPrice, r.exitPrice, DOLLARS);
  if (pnl == null) return null;
  const pct = ((r.exitPrice - r.entryPrice) / r.entryPrice) * 100;
  return {
    pnl,
    pct: +pct.toFixed(2),
    entry: r.entryPrice,
    exit: r.exitPrice,
    reason: r.exitReason,
    fat: pct >= FAT_PCT,
    ticker,
  };
}

function emptyAcc() {
  return {
    n: 0, wins: 0, fat: 0, pnl: 0,
    n26: 0, wins26: 0, fat26: 0, pnl26: 0,
    signals: 0, expandDays: 0, pctSum: 0,
    byTicker: {},
  };
}

function bumpTicker(a, ticker, r) {
  if (!a.byTicker[ticker]) a.byTicker[ticker] = { n: 0, fat: 0, pnl: 0 };
  const t = a.byTicker[ticker];
  t.n += 1;
  t.pnl += r.pnl;
  if (r.fat) t.fat += 1;
}

async function main() {
  if (!process.env.ALPACA_API_KEY) throw new Error("missing ALPACA_API_KEY");
  if (!process.env.QUANTDATA_API_KEY) throw new Error("missing QUANTDATA_API_KEY");

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new pg.Client({
    connectionString: dbUrl(),
    ssl: /localhost|127\.0\.0\.1/.test(dbUrl()) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT DISTINCT session_date::text AS d FROM zerodte_trades
     WHERE symbol='SPY' AND code_version=$1 ORDER BY d DESC LIMIT $2`,
    [CODE, MAX],
  );
  await client.end();
  const dates = rows.map((r) => r.d.slice(0, 10)).sort();
  console.log(`[fat-eval] dates=${dates.length} tickers=${TICKERS.join(",")} fat≥${FAT_PCT}% expRange≥${EXP_RANGE_PCT}%`);
  console.log(`[fat-eval] spike≥$${FLOW_SPIKE_USD} block≥$${BLOCK_MIN_USD} strategies=${STRATEGY_IDS.join(",")}`);

  const acc = Object.fromEntries(STRATEGY_IDS.map((id) => [id, emptyAcc()]));
  const dayLog = [];

  for (let i = 0; i < dates.length; i++) {
    const sessionDate = dates[i];
    process.stdout.write(`[fat-eval] ${i + 1}/${dates.length} ${sessionDate}\r`);

    // Per strategy, pick the strongest signal across tickers that day (max 1 fill).
    const dayCands = Object.fromEntries(STRATEGY_IDS.map((id) => [id, []]));
    let anyExpand = false;

    for (const ticker of TICKERS) {
      let bars;
      try {
        bars = await fetchAlpacaBars({
          symbol: ticker,
          startDate: addDays(sessionDate, -5),
          endDate: sessionDate,
        });
      } catch (err) {
        console.warn(`\n[fat-eval] bars fail ${ticker} ${sessionDate}: ${err.message}`);
        continue;
      }
      // Skip QD spend on quiet days (expansion filter on underlying only).
      const rthPre = sessionRthBars(bars, sessionDate);
      const openPre = rthPre[0]?.open ?? rthPre[0]?.close;
      const expPre = earlyExpansion({ rth: rthPre, open: openPre });
      if (!expPre.ok) continue;

      let feeds;
      try {
        feeds = await loadFeeds(ticker, sessionDate, { needBlocks: true });
      } catch (err) {
        console.warn(`\n[fat-eval] QD fail ${ticker} ${sessionDate}: ${err.message}`);
        continue;
      }
      const cands = buildFatCandidates({ sessionDate, ticker, bars, feeds });
      if (cands._meta?.expand) anyExpand = true;
      for (const id of STRATEGY_IDS) {
        for (const fire of cands[id] || []) {
          const strength = Math.abs(Number(fire.featuresExtra?.net || fire.featuresExtra?.premium || 0));
          dayCands[id].push({ fire, strength, ticker });
        }
      }
    }

    if (anyExpand) {
      for (const id of STRATEGY_IDS) acc[id].expandDays += 1;
    }

    for (const id of STRATEGY_IDS) {
      const list = dayCands[id].sort((a, b) => b.strength - a.strength);
      acc[id].signals += list.length;
      if (!list.length) continue;
      // Max 1/day: strongest ticker signal only
      const { fire } = list[0];
      try {
        const r = await simulateLong(sessionDate, fire);
        if (!r) continue;
        const a = acc[id];
        a.n += 1;
        a.pnl += r.pnl;
        a.pctSum += r.pct;
        if (r.pnl > 0) a.wins += 1;
        if (r.fat) a.fat += 1;
        bumpTicker(a, r.ticker, r);
        if (sessionDate.startsWith("2026")) {
          a.n26 += 1;
          a.pnl26 += r.pnl;
          if (r.pnl > 0) a.wins26 += 1;
          if (r.fat) a.fat26 += 1;
        }
        dayLog.push({
          date: sessionDate, id, ticker: r.ticker, pct: r.pct, pnl: r.pnl,
          fat: r.fat, reason: r.reason, entry: r.entry,
        });
      } catch {
        // missing contract / illiquid
      }
    }
  }

  const table = STRATEGY_IDS.map((id) => {
    const a = acc[id];
    const fatRate = a.n ? +((100 * a.fat) / a.n).toFixed(1) : 0;
    const avgPct = a.n ? +(a.pctSum / a.n).toFixed(1) : 0;
    const tradesPerDay = dates.length ? +(a.n / dates.length).toFixed(2) : 0;
    const clears =
      a.n >= 20
      && fatRate >= 30
      && avgPct >= 8
      && a.pnl > 0
      && tradesPerDay <= 1.05;
    return {
      id,
      expandDays: a.expandDays,
      signals: a.signals,
      n: a.n,
      tpd: tradesPerDay,
      wr: a.n ? +((100 * a.wins) / a.n).toFixed(1) : 0,
      fatPct: fatRate,
      avgPct,
      pnl: +a.pnl.toFixed(0),
      avg$: a.n ? +(a.pnl / a.n).toFixed(0) : 0,
      n26: a.n26,
      fat26: a.n26 ? +((100 * a.fat26) / a.n26).toFixed(1) : 0,
      pnl26: +a.pnl26.toFixed(0),
      clears: clears ? "YES" : "no",
    };
  }).sort((a, b) => b.fatPct - a.fatPct || b.pnl - a.pnl);

  console.log("\n[fat-eval] ranked by fat-win rate (≥25% option return)");
  console.table(table);
  console.log("[fat-eval] clear bar = n≥20, fatRate≥30%, avgPct≥8%, pnl>0, ≤1 trade/day");

  for (const id of STRATEGY_IDS) {
    const bt = acc[id].byTicker;
    if (Object.keys(bt).length) {
      console.log(`[fat-eval] ${id} by ticker:`, Object.fromEntries(
        Object.entries(bt).map(([t, v]) => [t, {
          n: v.n,
          fat: v.n ? +((100 * v.fat) / v.n).toFixed(0) : 0,
          pnl: +v.pnl.toFixed(0),
        }]),
      ));
    }
  }

  const outPath = path.join(OUT_DIR, `fat-eval-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    meta: {
      dates: dates.length, tickers: TICKERS, fatPct: FAT_PCT,
      expRange: EXP_RANGE_PCT, flowSpike: FLOW_SPIKE_USD, blockMin: BLOCK_MIN_USD,
    },
    table,
    dayLog,
  }, null, 2));
  console.log(`[fat-eval] wrote ${outPath}`);
  console.log(`[fat-eval] complete dates=${dates.length}`);
  console.log("[fat-eval] note: sims use traded prices (no bid/ask) — optimistic vs live fills.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[fat-eval] fatal: ${err.message}`);
    process.exit(1);
  });
}
