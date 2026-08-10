// Shared helpers for Frontier volume scans (weeklies + new 0DTE patterns).
// Pure functions — no I/O. Used by frontierVolumeSearch.js and (later) live wiring.

/** Next SPY weekly Friday expiration with DTE in [minDte, maxDte]. */
export function pickWeeklyExpiration(sessionDate, { minDte = 3, maxDte = 7 } = {}) {
  const base = new Date(`${sessionDate}T16:00:00-04:00`);
  for (let add = minDte; add <= maxDte + 14; add++) {
    const dt = new Date(base.getTime() + add * 86400000);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    }).formatToParts(dt);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.weekday !== "Fri") continue;
    const iso = `${map.year}-${map.month}-${map.day}`;
    const dte = Math.round((new Date(`${iso}T16:00:00-04:00`) - base) / 86400000);
    if (dte >= minDte && dte <= maxDte) return { expiration: iso, dte };
  }
  return null;
}

export function etParts(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ts));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const minutes = Number(m.hour) * 60 + Number(m.minute);
  return { dateStr: `${m.year}-${m.month}-${m.day}`, minutes, hour: Number(m.hour), minute: Number(m.minute) };
}

export function sessionRthBars(allBars, sessionDate) {
  return allBars.filter((b) => {
    const { dateStr, minutes } = etParts(b.ts);
    return dateStr === sessionDate && minutes >= 570 && minutes < 960;
  });
}

export function priorDayHl(allBars, sessionDate) {
  const byDay = new Map();
  for (const b of allBars) {
    const { dateStr, minutes } = etParts(b.ts);
    if (minutes < 570 || minutes >= 960) continue;
    if (!byDay.has(dateStr)) byDay.set(dateStr, { high: b.high, low: b.low, close: b.close });
    const d = byDay.get(dateStr);
    d.high = Math.max(d.high, b.high);
    d.low = Math.min(d.low, b.low);
    d.close = b.close;
  }
  const days = [...byDay.keys()].sort();
  const idx = days.indexOf(sessionDate);
  if (idx < 1) return null;
  return byDay.get(days[idx - 1]);
}

/** Cumulative volume VWAP from RTH open. */
export function attachVwap(rthBars) {
  let pv = 0, vol = 0;
  return rthBars.map((b) => {
    const v = Number(b.volume) || 0;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
    return { ...b, vwap: vol > 0 ? pv / vol : b.close };
  });
}

/**
 * Detect new scan signals on one session's RTH bars.
 * Returns 0..N candidate fires (not yet simulated).
 */
export function detectVolumeScanFires({
  rthBars, sessionDate, pdh, pdl,
  enableOrbFail = true, enableVwapReclaim = true, enableWeeklyDrive = true,
} = {}) {
  if (!rthBars?.length) return [];
  const bars = attachVwap(rthBars);
  const fires = [];

  // ORB15: 9:30–9:45
  let orbHigh = null, orbLow = null;
  let brokeUp = false, brokeDn = false;
  let orbFailPut = false, orbFailCall = false;
  let belowVwapStreak = 0, aboveVwapStreak = 0;
  let vwapCall = false, vwapPut = false;
  let weeklyFired = false;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const { minutes } = etParts(b.ts);

    if (minutes >= 570 && minutes < 585) {
      orbHigh = orbHigh == null ? b.high : Math.max(orbHigh, b.high);
      orbLow = orbLow == null ? b.low : Math.min(orbLow, b.low);
      continue;
    }
    if (minutes < 585) continue;

    if (orbHigh != null && b.close > orbHigh) brokeUp = true;
    if (orbLow != null && b.close < orbLow) brokeDn = true;

    // Failed ORB: broke out, then closed back through the ORB line.
    if (enableOrbFail && !orbFailPut && brokeUp && orbHigh != null && b.close < orbHigh && minutes <= 720) {
      orbFailPut = true;
      fires.push({
        scan: "ORB_FAIL",
        direction: "PUT",
        ts: b.ts,
        etMinute: minutes,
        level: +orbHigh.toFixed(2),
        levelType: "ORB15_FAIL",
        price: b.close,
        expirationMode: "0DTE",
        sessionDate,
      });
    }
    if (enableOrbFail && !orbFailCall && brokeDn && orbLow != null && b.close > orbLow && minutes <= 720) {
      orbFailCall = true;
      fires.push({
        scan: "ORB_FAIL",
        direction: "CALL",
        ts: b.ts,
        etMinute: minutes,
        level: +orbLow.toFixed(2),
        levelType: "ORB15_FAIL",
        price: b.close,
        expirationMode: "0DTE",
        sessionDate,
      });
    }

    // VWAP reclaim: 5+ minutes on one side, then close back through VWAP.
    // Evaluate reclaim against the prior streak before updating this bar's side.
    const vwap = b.vwap;
    if (enableVwapReclaim && !vwapCall && belowVwapStreak >= 5
      && b.close > vwap && b.close > b.open && minutes >= 600 && minutes <= 780) {
      vwapCall = true;
      belowVwapStreak = 0;
      aboveVwapStreak = 0;
      fires.push({
        scan: "VWAP_RECLAIM",
        direction: "CALL",
        ts: b.ts,
        etMinute: minutes,
        level: +vwap.toFixed(2),
        levelType: "VWAP",
        price: b.close,
        expirationMode: "0DTE",
        sessionDate,
      });
    } else if (enableVwapReclaim && !vwapPut && aboveVwapStreak >= 5
      && b.close < vwap && b.close < b.open && minutes >= 600 && minutes <= 780) {
      vwapPut = true;
      belowVwapStreak = 0;
      aboveVwapStreak = 0;
      fires.push({
        scan: "VWAP_RECLAIM",
        direction: "PUT",
        ts: b.ts,
        etMinute: minutes,
        level: +vwap.toFixed(2),
        levelType: "VWAP",
        price: b.close,
        expirationMode: "0DTE",
        sessionDate,
      });
    } else if (b.close < vwap * 0.999) {
      belowVwapStreak++;
      aboveVwapStreak = 0;
    } else if (b.close > vwap * 1.001) {
      aboveVwapStreak++;
      belowVwapStreak = 0;
    } else {
      belowVwapStreak = 0;
      aboveVwapStreak = 0;
    }

    // Weekly drive: first bar at/after 10:00 — bias from PDH/PDL location.
    if (enableWeeklyDrive && !weeklyFired && minutes >= 600 && pdh != null && pdl != null) {
      weeklyFired = true;
      if (b.close > pdh) {
        fires.push({
          scan: "WEEKLY_DRIVE",
          direction: "CALL",
          ts: b.ts,
          etMinute: minutes,
          level: +pdh.toFixed(2),
          levelType: "PDH",
          price: b.close,
          expirationMode: "WEEKLY",
          sessionDate,
        });
      } else if (b.close < pdl) {
        fires.push({
          scan: "WEEKLY_DRIVE",
          direction: "PUT",
          ts: b.ts,
          etMinute: minutes,
          level: +pdl.toFixed(2),
          levelType: "PDL",
          price: b.close,
          expirationMode: "WEEKLY",
          sessionDate,
        });
      }
    }
  }

  return fires;
}

export function paperPnl(entry, exit, dollars = 1000) {
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  const contracts = Math.max(1, Math.floor(dollars / (entry * 100)));
  return +(contracts * (exit - entry) * 100).toFixed(2);
}

export function paperDeployed(entry, dollars = 1000) {
  if (!(entry > 0)) return null;
  const contracts = Math.max(1, Math.floor(dollars / (entry * 100)));
  return +(contracts * entry * 100).toFixed(2);
}
