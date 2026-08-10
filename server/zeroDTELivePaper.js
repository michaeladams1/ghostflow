// LIVE PAPER WORKER — Frontier + Volume sleeves during RTH.
//
// Modes (LIVE_PAPER_MODE):
//   off     — worker idle (default)
//   shadow  — detect fires, persist would-be orders, do NOT call Alpaca Trading API
//   submit  — same + submit paper brackets; client_order_id tags FRONTIER vs VOLUME
//
// LIVE EXEC ALLOWLIST: LIVE_EXEC_SLEEVES = {FRONTIER, VOLUME} only.
// GAMMA (and Shen / official / research) are never collected, shadowed, or submitted.
// Do not import frontierGamma into the submit path.

import { randomUUID } from "node:crypto";
import { occSymbol } from "./alpacaClient.js";
import {
  alpacaTradingConfigured, closeAlpacaPosition, fetchAlpacaOptionLatestQuote,
  submitAlpacaBracketBuy,
} from "./alpacaTrading.js";
import {
  FRONTIER_HARD_STOP_MIN, FRONTIER_PAPER_DOLLARS, FRONTIER_SL_MULT, FRONTIER_TP_MULT,
  FRONTIER_V3_VERSION, frontierContracts, selectFrontierBestPerDay,
} from "./frontierV3.js";
import {
  VOLUME_HARD_STOP_MIN, VOLUME_ORB_SL_MULT, VOLUME_PAPER_DOLLARS,
  VOLUME_SL_MULT, VOLUME_TP_MULT, VOLUME_VERSION, buildVolumeFires, volumeEntryAllowed,
} from "./frontierVolume.js";
import {
  LIVE_EXEC_SLEEVES, LIVE_SLEEVE_FRONTIER, LIVE_SLEEVE_VOLUME, buildClientOrderId,
  isLiveExecSleeve, isRthEtMinute, lastClosedEtMinute, liveFireKey,
  parseLivePaperMode, sleeveNote,
} from "./livePaperIds.js";
import {
  findLiveOrderByFireKey, insertLiveOrder, listOpenVolumeLiveOrders, updateLiveOrder,
} from "./zeroDTELiveStore.js";
import {
  analyzeZeroDTESession, frontierDedupeKey, frontierLanePriority, isFrontierFire,
  pickOtmStrike,
} from "./zeroDTE.js";

const TICK_MS = Number(process.env.LIVE_PAPER_TICK_MS || 60_000);
const SYMBOL = "SPY";

let tickTimer = null;
let tickInFlight = false;
let lastProcessedKey = null; // `${date}|${closedMinute}`

function etMinuteOf(ts) {
  if (ts == null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return Number(map.hour) * 60 + Number(map.minute);
}

function entryPriceFromQuote(q) {
  if (!q) return null;
  // Buy: prefer ask, else mid.
  if (q.ask > 0) return q.ask;
  if (q.mid > 0) return q.mid;
  if (q.bid > 0) return q.bid;
  return null;
}

function contractsFor(entry, dollars) {
  const e = Number(entry);
  if (!(e > 0)) return null;
  return Math.max(1, Math.floor(dollars / (e * 100)));
}

function buildContract({ sessionDate, direction, level }) {
  const strike = pickOtmStrike({ level, direction });
  const occ = occSymbol({
    underlying: SYMBOL,
    expiration: sessionDate,
    contractType: direction === "PUT" ? "P" : "C",
    strike,
  });
  return { strike, occ };
}

/** Collect actionable Frontier + Volume signals for closed minutes only. */
export async function collectLiveSignals({ sessionDate, closedMinute }) {
  const session = await analyzeZeroDTESession({ symbol: SYMBOL, sessionDate });
  if (!session.ok) return { ok: false, reason: session.reason, signals: [] };

  const signals = [];

  // --- VOLUME ---
  const volumeFires = buildVolumeFires({
    bars: session.bars,
    sessionDate,
    pdh: session.levels?.pdh,
    pdl: session.levels?.pdl,
  });
  for (const f of volumeFires) {
    const etMinute = f.etMinute ?? etMinuteOf(f.ts);
    if (etMinute == null || etMinute > closedMinute) continue;
    if (!f.level || !f.direction) continue;
    const { strike, occ } = buildContract({
      sessionDate, direction: f.direction, level: f.level,
    });
    signals.push({
      sleeve: LIVE_SLEEVE_VOLUME,
      setup: f.scan || f.tier || "VOLUME",
      direction: f.direction,
      levelType: f.levelType || f.scan,
      level: f.level,
      etMinute,
      points: f.points ?? null,
      strike,
      contract: occ,
      tpMult: f.tpMult ?? VOLUME_TP_MULT,
      slMult: f.slMult ?? (f.scan === "ORB_HOLD" ? VOLUME_ORB_SL_MULT : VOLUME_SL_MULT),
      dollars: VOLUME_PAPER_DOLLARS,
      method: f.method || VOLUME_VERSION,
      hardStopMin: VOLUME_HARD_STOP_MIN,
    });
  }

  // --- FRONTIER (max 1/day after quote-aware filter) ---
  const frontierByKey = new Map();
  const consider = (f, lane, countedFlag) => {
    const etMinute = f.ts ? etMinuteOf(f.ts) : (f.etMinute ?? null);
    if (etMinute == null || etMinute > closedMinute) return;
    // Structural pre-check with a dummy entry so we don't quote every miss.
    if (!isFrontierFire({
      direction: f.direction,
      levelType: f.levelType,
      tier: f.tier,
      points: f.points,
      etMinute,
      entryPrice: 1,
      touchNumber: f.touchNumber,
    })) return;
    if (!f.level) return;
    const key = frontierDedupeKey({
      sessionDate, etMinute, direction: f.direction, levelType: f.levelType, touchNumber: f.touchNumber,
    });
    const rank = frontierLanePriority(lane, { counted: countedFlag });
    const prev = frontierByKey.get(key);
    if (!prev || rank < prev.rank) frontierByKey.set(key, { f, etMinute, rank });
  };

  for (const f of session.fires || []) {
    consider(f, "official", f.window === "in");
  }
  for (const f of session.experiments || []) {
    consider(f, f.lane || "HIGH_QUALITY_A", false);
  }
  for (const f of session.playbookExperiments || []) {
    consider(f, "SHEN_CONVICTION", false);
  }

  const frontierCandidates = [];
  for (const { f, etMinute } of frontierByKey.values()) {
    const { strike, occ } = buildContract({
      sessionDate, direction: f.direction, level: f.level,
    });
    frontierCandidates.push({
      sleeve: LIVE_SLEEVE_FRONTIER,
      setup: f.levelType || "FRONTIER",
      direction: f.direction,
      levelType: f.levelType,
      level: f.level,
      etMinute,
      points: f.points,
      touchNumber: f.touchNumber,
      strike,
      contract: occ,
      tpMult: FRONTIER_TP_MULT,
      slMult: FRONTIER_SL_MULT,
      dollars: FRONTIER_PAPER_DOLLARS,
      method: FRONTIER_V3_VERSION,
      hardStopMin: FRONTIER_HARD_STOP_MIN,
      sessionDate,
    });
  }

  // Hard allowlist — research sleeves (incl. GAMMA) can never leak into ticks.
  const liveSignals = signals.filter((s) => isLiveExecSleeve(s.sleeve));
  const liveFrontier = frontierCandidates.filter((s) => isLiveExecSleeve(s.sleeve));
  if (liveSignals.length !== signals.length || liveFrontier.length !== frontierCandidates.length) {
    console.warn(
      `[live-paper] stripped non-exec sleeves: signals ${signals.length}->${liveSignals.length} `
      + `frontier ${frontierCandidates.length}->${liveFrontier.length} allowlist=${LIVE_EXEC_SLEEVES.join(",")}`,
    );
  }

  // Frontier candidates are returned un-capped; tickLivePaper applies
  // selectFrontierBestPerDay after quotes so a dead quote doesn't eat the day slot.
  return {
    ok: true,
    signals: liveSignals,
    frontierCandidates: liveFrontier,
    sessionDate,
    levels: session.levels,
  };
}

async function enrichWithQuote(signal) {
  const quote = await fetchAlpacaOptionLatestQuote(signal.contract);
  const entry = entryPriceFromQuote(quote);
  if (!(entry > 0)) {
    return { ...signal, skip: "no_option_quote", quote };
  }
  if (signal.sleeve === LIVE_SLEEVE_VOLUME && !volumeEntryAllowed(entry, signal.dollars)) {
    return { ...signal, skip: "premium_over_cap", entry, quote };
  }
  if (signal.sleeve === LIVE_SLEEVE_FRONTIER) {
    if (!isFrontierFire({
      direction: signal.direction,
      levelType: signal.levelType,
      points: signal.points,
      etMinute: signal.etMinute,
      entryPrice: entry,
      touchNumber: signal.touchNumber,
    })) {
      return { ...signal, skip: "frontier_entry_gate", entry, quote };
    }
  }
  const qty = signal.sleeve === LIVE_SLEEVE_FRONTIER
    ? frontierContracts(entry, signal.dollars)
    : contractsFor(entry, signal.dollars);
  if (!(qty > 0)) return { ...signal, skip: "qty_zero", entry, quote };
  const tp = entry * signal.tpMult;
  const sl = entry * signal.slMult;
  return { ...signal, entry, qty, tp, sl, quote, skip: null };
}

async function persistAndMaybeSubmit({ signal, mode, sessionDate }) {
  const note = sleeveNote(signal.sleeve);
  if (!note || !isLiveExecSleeve(signal.sleeve)) {
    console.log(`[live-paper] skipped: sleeve-not-in-live-allowlist sleeve=${signal.sleeve}`);
    return { action: "rejected_sleeve", row: null };
  }
  const fireKey = liveFireKey({
    symbol: SYMBOL,
    sessionDate,
    sleeve: signal.sleeve,
    setup: signal.setup,
    direction: signal.direction,
    etMinute: signal.etMinute,
    levelType: signal.levelType,
  });
  const existing = await findLiveOrderByFireKey(fireKey);
  if (existing) {
    console.log(`[live-paper] skipped: already-recorded fire_key=${fireKey} status=${existing.status}`);
    return { action: "duplicate", row: existing };
  }

  const clientOrderId = buildClientOrderId({
    sleeve: signal.sleeve,
    sessionDate,
    setup: signal.setup,
    direction: signal.direction,
    etMinute: signal.etMinute,
  });

  if (signal.skip) {
    const row = await insertLiveOrder({
      id: randomUUID(),
      fireKey,
      symbol: SYMBOL,
      sessionDate,
      sleeve: note,
      sleeveNote: note,
      setup: signal.setup,
      direction: signal.direction,
      levelType: signal.levelType,
      level: signal.level,
      etMinute: signal.etMinute,
      contract: signal.contract,
      strike: signal.strike,
      qty: null,
      entryRef: signal.entry ?? null,
      tpPrice: null,
      slPrice: null,
      clientOrderId,
      alpacaOrderId: null,
      mode,
      status: "skipped",
      detail: { reason: signal.skip, method: signal.method },
    });
    console.log(`[live-paper] skipped: ${signal.skip} sleeve=${note} setup=${signal.setup} min=${signal.etMinute}`);
    return { action: "skipped", row };
  }

  if (mode === "shadow") {
    const row = await insertLiveOrder({
      id: randomUUID(),
      fireKey,
      symbol: SYMBOL,
      sessionDate,
      sleeve: note,
      sleeveNote: note,
      setup: signal.setup,
      direction: signal.direction,
      levelType: signal.levelType,
      level: signal.level,
      etMinute: signal.etMinute,
      contract: signal.contract,
      strike: signal.strike,
      qty: signal.qty,
      entryRef: signal.entry,
      tpPrice: signal.tp,
      slPrice: signal.sl,
      clientOrderId,
      alpacaOrderId: null,
      mode: "shadow",
      status: "shadowed",
      detail: {
        method: signal.method,
        wouldSubmit: true,
        sleeveNote: note,
        clientOrderId,
        quote: signal.quote || null,
      },
    });
    console.log(
      `[live-paper] shadowed sleeve=${note} setup=${signal.setup} dir=${signal.direction} `
      + `min=${signal.etMinute} occ=${signal.contract} qty=${signal.qty} `
      + `client_order_id=${clientOrderId}`,
    );
    return { action: "shadowed", row };
  }

  // submit
  let order;
  try {
    order = await submitAlpacaBracketBuy({
      symbol: signal.contract,
      qty: signal.qty,
      takeProfit: signal.tp,
      stopLoss: signal.sl,
      clientOrderId,
    });
  } catch (err) {
    const row = await insertLiveOrder({
      id: randomUUID(),
      fireKey,
      symbol: SYMBOL,
      sessionDate,
      sleeve: note,
      sleeveNote: note,
      setup: signal.setup,
      direction: signal.direction,
      levelType: signal.levelType,
      level: signal.level,
      etMinute: signal.etMinute,
      contract: signal.contract,
      strike: signal.strike,
      qty: signal.qty,
      entryRef: signal.entry,
      tpPrice: signal.tp,
      slPrice: signal.sl,
      clientOrderId,
      alpacaOrderId: null,
      mode: "submit",
      status: "error",
      detail: { error: err.message, method: signal.method, sleeveNote: note },
    });
    console.error(`[live-paper] submit failed sleeve=${note}: ${err.message}`);
    return { action: "error", row };
  }

  const row = await insertLiveOrder({
    id: randomUUID(),
    fireKey,
    symbol: SYMBOL,
    sessionDate,
    sleeve: note,
    sleeveNote: note,
    setup: signal.setup,
    direction: signal.direction,
    levelType: signal.levelType,
    level: signal.level,
    etMinute: signal.etMinute,
    contract: signal.contract,
    strike: signal.strike,
    qty: signal.qty,
    entryRef: signal.entry,
    tpPrice: signal.tp,
    slPrice: signal.sl,
    clientOrderId,
    alpacaOrderId: order.id || null,
    mode: "submit",
    status: "submitted",
    detail: {
      method: signal.method,
      sleeveNote: note,
      alpacaStatus: order.status || null,
      orderClass: order.order_class || "bracket",
    },
  });
  console.log(
    `[live-paper] submitted sleeve=${note} setup=${signal.setup} occ=${signal.contract} `
    + `qty=${signal.qty} alpaca_order_id=${order.id} client_order_id=${clientOrderId}`,
  );
  return { action: "submitted", row, order };
}

async function flattenVolumeIfNeeded(sessionDate, wallMinutes) {
  if (wallMinutes < VOLUME_HARD_STOP_MIN) return { flattened: 0 };
  const open = await listOpenVolumeLiveOrders(SYMBOL, sessionDate);
  let n = 0;
  for (const row of open) {
    if (!row.contract) continue;
    try {
      await closeAlpacaPosition(row.contract);
      await updateLiveOrder(row.fire_key, {
        status: "flattened",
        detail: { ...(row.detail || {}), flattenedAtMin: wallMinutes, reason: "volume_hard_stop_1115" },
      });
      console.log(`[live-paper] flattened VOLUME occ=${row.contract} fire_key=${row.fire_key}`);
      n++;
    } catch (err) {
      console.error(`[live-paper] flatten failed occ=${row.contract}: ${err.message}`);
    }
  }
  return { flattened: n };
}

export async function tickLivePaper({ now = new Date() } = {}) {
  const mode = parseLivePaperMode();
  if (mode === "off") return { ok: true, mode, skipped: "mode_off" };
  if (!alpacaTradingConfigured()) {
    console.log("[live-paper] skipped: missing Alpaca keys");
    return { ok: false, mode, skipped: "missing_keys" };
  }

  const { dateStr, minutes: closedMinute, wallMinutes } = lastClosedEtMinute(now);
  if (!isRthEtMinute(wallMinutes) && wallMinutes < 570) {
    return { ok: true, mode, skipped: "pre_rth" };
  }
  // Allow a short post-11:15 window for Volume flatten even if we stop new entries later.
  if (wallMinutes >= 960) return { ok: true, mode, skipped: "after_rth" };

  const tickKey = `${dateStr}|${closedMinute}`;

  if (mode === "submit") {
    await flattenVolumeIfNeeded(dateStr, wallMinutes);
  }

  if (!isRthEtMinute(closedMinute)) {
    return { ok: true, mode, skipped: "closed_minute_outside_rth", closedMinute };
  }

  if (tickKey === lastProcessedKey) {
    return { ok: true, mode, skipped: "minute_already_processed", tickKey };
  }

  const collected = await collectLiveSignals({ sessionDate: dateStr, closedMinute });
  if (!collected.ok) {
    console.log(`[live-paper] session analyze failed: ${collected.reason}`);
    return { ok: false, mode, reason: collected.reason };
  }

  const results = [];
  for (const raw of collected.signals) {
    const signal = await enrichWithQuote(raw);
    const r = await persistAndMaybeSubmit({ signal, mode, sessionDate: dateStr });
    results.push(r);
  }

  const frontierEnriched = [];
  for (const raw of collected.frontierCandidates || []) {
    frontierEnriched.push(await enrichWithQuote(raw));
  }
  const frontierReady = frontierEnriched.filter((s) => !s.skip);
  const frontierPicked = selectFrontierBestPerDay(
    frontierReady.map((s) => ({ ...s, sessionDate: dateStr })),
  );
  for (const signal of frontierPicked) {
    const r = await persistAndMaybeSubmit({ signal, mode, sessionDate: dateStr });
    results.push(r);
  }

  lastProcessedKey = tickKey;
  const summary = {
    ok: true,
    mode,
    sessionDate: dateStr,
    closedMinute,
    signals: collected.signals.length + frontierPicked.length,
    shadowed: results.filter((r) => r.action === "shadowed").length,
    submitted: results.filter((r) => r.action === "submitted").length,
    skipped: results.filter((r) => r.action === "skipped" || r.action === "duplicate").length,
    errors: results.filter((r) => r.action === "error").length,
  };
  console.log(
    `[live-paper] tick complete mode=${mode} date=${dateStr} closedMin=${closedMinute} `
    + `signals=${summary.signals} shadowed=${summary.shadowed} submitted=${summary.submitted} `
    + `skipped=${summary.skipped} errors=${summary.errors}`,
  );
  return summary;
}

export function startLivePaperWorker() {
  if (tickTimer) return;
  const mode = parseLivePaperMode();
  console.log(`[live-paper] worker starting mode=${mode} tickMs=${TICK_MS} tradeApi=${process.env.ALPACA_BASE_URL || "paper-default"}`);
  if (mode === "off") {
    console.log("[live-paper] mode=off — set LIVE_PAPER_MODE=shadow|submit to enable");
  }
  const run = () => {
    if (tickInFlight) {
      console.log("[live-paper] skipped: tick-in-flight");
      return;
    }
    tickInFlight = true;
    tickLivePaper()
      .catch((err) => console.error("[live-paper] tick failed:", err.message))
      .finally(() => { tickInFlight = false; });
  };
  // Delay first tick slightly so boot logs stay readable.
  setTimeout(run, 5_000).unref?.();
  tickTimer = setInterval(run, TICK_MS);
  tickTimer.unref?.();
}

// Re-exports for tests
export {
  buildClientOrderId, liveFireKey, parseLivePaperMode, sleeveNote, lastClosedEtMinute,
};
