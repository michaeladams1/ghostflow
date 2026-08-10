// Pure helpers for live-paper fire identity + Alpaca client_order_id tagging.
// No I/O — unit-tested without keys/DB.
//
// LIVE EXEC ALLOWLIST: only Frontier + Volume may shadow/submit orders.
// Research sleeves (GAMMA, Shen, official, …) must never appear here.

export const LIVE_SLEEVE_FRONTIER = "FRONTIER";
export const LIVE_SLEEVE_VOLUME = "VOLUME";

/** Sleeves the live-paper worker is allowed to act on. GAMMA is intentionally absent. */
export const LIVE_EXEC_SLEEVES = Object.freeze([
  LIVE_SLEEVE_FRONTIER,
  LIVE_SLEEVE_VOLUME,
]);

export function isLiveExecSleeve(lane) {
  const note = sleeveNote(lane);
  return note != null && LIVE_EXEC_SLEEVES.includes(note);
}

/** Human-readable sleeve note stored in DB and encoded into Alpaca client_order_id. */
export function sleeveNote(lane) {
  const u = String(lane || "").toUpperCase();
  if (u === "FRONTIER") return LIVE_SLEEVE_FRONTIER;
  if (u === "VOLUME" || u === "VOL") return LIVE_SLEEVE_VOLUME;
  // Explicit reject — do not silently map research lanes into live ids.
  if (u === "GAMMA") return null;
  return null;
}

/**
 * Alpaca-visible tag. Alpaca has no freeform order note; client_order_id is
 * the supported place to mark FRONTIER vs VOLUME (max 128 chars).
 */
export function buildClientOrderId({
  sleeve, sessionDate, setup, direction, etMinute,
} = {}) {
  const note = sleeveNote(sleeve);
  if (!note || !LIVE_EXEC_SLEEVES.includes(note)) {
    throw new Error(`invalid sleeve for client_order_id: ${sleeve}`);
  }
  const ymd = String(sessionDate || "").replace(/-/g, "");
  const setupPart = String(setup || "SETUP").replace(/[^A-Za-z0-9_]/g, "").slice(0, 24) || "SETUP";
  const dir = String(direction || "").toUpperCase().startsWith("P") ? "PUT" : "CALL";
  const min = Number.isFinite(Number(etMinute)) ? String(Math.trunc(Number(etMinute))) : "0";
  const id = `gf-${note}-${ymd}-${setupPart}-${dir}-${min}`;
  if (id.length > 128) return id.slice(0, 128);
  return id;
}

/** Durable idempotency key for one live signal (independent of Alpaca). */
export function liveFireKey({
  symbol = "SPY", sessionDate, sleeve, setup, direction, etMinute, levelType,
} = {}) {
  const note = sleeveNote(sleeve);
  if (!note) {
    throw new Error(`invalid sleeve for liveFireKey: ${sleeve}`);
  }
  return [
    symbol,
    sessionDate,
    note,
    setup || levelType || "",
    String(direction || "").toUpperCase(),
    etMinute ?? "",
    levelType || "",
  ].join("|");
}

/** Parse LIVE_PAPER_MODE: off | shadow | submit (default off). */
export function parseLivePaperMode(raw = process.env.LIVE_PAPER_MODE) {
  const v = String(raw ?? "off").trim().toLowerCase();
  if (v === "shadow" || v === "log" || v === "dry-run" || v === "dryrun") return "shadow";
  if (v === "submit" || v === "live" || v === "paper" || v === "on" || v === "1" || v === "true") {
    return "submit";
  }
  return "off";
}

/** Last fully closed ET minute (do not act on the in-progress bar). */
export function lastClosedEtMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const minutes = Number(map.hour) * 60 + Number(map.minute);
  // Current clock minute is still forming; signals use the prior closed minute.
  return { dateStr, minutes: Math.max(0, minutes - 1), wallMinutes: minutes };
}

export function isRthEtMinute(minutes) {
  return Number(minutes) >= 570 && Number(minutes) < 960;
}
