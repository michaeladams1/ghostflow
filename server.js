// GHOSTFLOW server: serves the built frontend, gates everything behind HTTP
// Basic Auth, and exposes the session-analysis API.
//
// THE CORE ENDPOINT IS NOW /api/analyze. You give it a SYMBOL and a SESSION
// DATE — not a trade. There is no entry, no exit, no win/loss anywhere in this
// API, because Michael never enters a trade before the system runs. The system
// finds the moves itself and asks whether they were knowable in advance.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTrades, appendTrade, deleteTrade } from "./server/store.js";
import { fetchAllEndpoints, probePriceData } from "./server/quantDataClient.js";
import { buildBriefing, buildMultiBriefing } from "./server/compress.js";
import { analyzeAllModels } from "./server/analysis.js";
import { backtestRule, priorSessions } from "./server/backtest.js";
import { refineRule } from "./server/refine.js";
import { analyzeConfirmers } from "./server/confirmation.js";
import { startBackgroundJobs, patchRecord } from "./server/jobs.js";
import { callClaude, callGPT, callGrok } from "./server/aiProviders.js";
import { parseStrategy } from "./server/strategyParser.js";
import { fetchOhlcvBars } from "./server/databentoClient.js";
import { runBacktest, getSessionChart } from "./server/priceBacktest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = process.env.PORT || 3000;
const USER = process.env.GHOSTFLOW_USER;
const PASS = process.env.GHOSTFLOW_PASS;

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!USER || !PASS) return next();
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const [u, p] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (u === USER && p === PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="GHOSTFLOW"');
  res.status(401).send("Authentication required");
});

// Past analyses (stored in the same Postgres table; the JSONB column doesn't
// care that the shape changed).
app.get("/api/analyses", async (req, res) => {
  try {
    res.json(await readTrades());
  } catch (err) {
    console.error("DB read failed:", err.message);
    res.status(500).json({ error: "Database read failed: " + err.message });
  }
});

// THE MAIN EVENT.
// Input: { symbol, sessionDate, contract? }  — that is ALL Michael types.
// Steps: fetch all 30 feeds -> compress into a timeline + lead/lag ->
//        3 models independently review every feed and propose a testable rule.
// Fetches the target session PLUS the N prior TRADING sessions. Weekends and
// market holidays simply return no data and get skipped, so "3 sessions" always
// means 3 real sessions of tape — not 3 calendar days. Run on a Tuesday, this
// pulls Tuesday + Monday + Friday, exactly as a human would look at the tape.
//
// PROBE-FIRST: each candidate day is first checked with ONE cheap request for
// the price feed before committing to the full 30-feed pull. Before this, a
// ticker outside Quant Data's coverage (their universe is optionable, liquid
// names — a thin micro-cap like SHPH trades fine on Nasdaq but has nothing
// there) burned 15 days x 30 feeds of requests just to discover emptiness,
// then blamed it on "no trading data" as if the ticker didn't exist.
// PROBE WALK (fast, ~1 request per weekday checked): finds which of the
// target date and prior days actually have data, WITHOUT pulling any feeds.
// Kept synchronous in the request so the user gets an instant, honest error
// for uncovered tickers instead of a stub record that fails minutes later.
async function findSessionDates({ ticker, sessionDate, sessionCount = 3 }) {
  const dates = [];
  const d = new Date(sessionDate + "T00:00:00Z");
  let guard = 0;
  let weekdaysProbed = 0;
  let transientProbes = 0;

  while (dates.length < sessionCount && guard < 15) {
    guard++;
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();

    if (dow !== 0 && dow !== 6) {
      weekdaysProbed++;
      const probe = await probePriceData({ ticker, sessionDate: iso });
      if (probe.transient) transientProbes++;
      if (probe.hasData) dates.push(iso);
      else console.log(`[window] ${iso} has no price data (holiday or not covered) — skipping`);
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  // Distinguish the failure modes honestly. A run of 10+ weekdays with zero
  // price data is not a stretch of holidays — the ticker isn't in Quant
  // Data's coverage universe, and the error should say so instead of
  // implying the ticker doesn't trade.
  let noDataReason = null;
  if (!dates.length) {
    noDataReason = transientProbes > 0
      ? `Quant Data requests for ${ticker} kept failing (rate limit or network). This is transient — try again in a minute.`
      : `Quant Data has no price data for ${ticker} on any of the last ${weekdaysProbed} trading days. The ticker may trade fine on an exchange, but it's outside Quant Data's coverage universe (typically optionable, liquid names) — so this options-flow analysis engine has nothing to analyze for it.`;
  }
  return { dates, noDataReason };
}

// FULL PULL for a known-good list of session dates (the slow part — runs in
// the background, never inside a request).
async function fetchBundlesForDates({ ticker, dates, contract }) {
  const bundles = [];
  for (const iso of dates) {
    const start = new Date(iso + "T00:00:00Z");
    start.setUTCDate(start.getUTCDate() - 15); // lookback for OI history etc.
    bundles.push(await fetchAllEndpoints({
      ticker, sessionDate: iso,
      startDate: start.toISOString().slice(0, 10),
      endDate: iso,
      contract,
    }));
  }
  return bundles;
}

// (Both /api/analyze and /rerun share findSessionDates + fetchBundlesForDates
// in the same fast-probe-then-background shape.)

app.post("/api/analyze", async (req, res) => {
  const { symbol, sessionDate, contract, notes, sessionCount = 3 } = req.body;
  if (!symbol || !sessionDate) {
    return res.status(400).json({ error: "symbol and sessionDate are required" });
  }

  const ticker = String(symbol).toUpperCase();

  try {
    // FAST PATH ONLY. Everything in this handler must finish in seconds:
    // (1) probe which days have data (instant coverage error if none),
    // (2) create a stub record with status "analyzing",
    // (3) respond so the popup can close and the card can appear.
    // The feed pull + 3-analyst review runs in the background and patches the
    // record as it completes; the UI polls and fills the card in.
    console.log(`[analyze] ${ticker} ${sessionDate} — probing session window...`);
    const { dates, noDataReason } = await findSessionDates({ ticker, sessionDate, sessionCount });
    if (!dates.length) {
      return res.status(400).json({ error: noDataReason });
    }

    const record = {
      id: "a" + Date.now(),
      symbol: ticker,
      sessionDate: dates[0],
      window: dates,
      contract: contract || null,
      notes: notes || null,
      loggedAt: new Date().toISOString(),
      status: "analyzing",
      jobs: { analysis: { status: "running", at: new Date().toISOString() } },
    };

    // The stub MUST persist before we respond — the background runner writes
    // its results into this row, and the UI polls it. No row, no analysis.
    try {
      await appendTrade(record);
    } catch (err) {
      console.error("[analyze] DB write failed — cannot run in background without persistence:", err.message);
      return res.status(500).json({ error: `Database unavailable (${err.message}) — the analysis can't run in the background without somewhere to store its results.` });
    }

    res.status(201).json(record);

    // ---- Background: the actual work. ----
    (async () => {
      try {
        console.log(`[analyze:bg] ${ticker} pulling ${dates.length} sessions of feeds...`);
        const bundles = await fetchBundlesForDates({ ticker, dates, contract });
        const briefing = buildMultiBriefing(bundles, { contract });
        console.log(`[analyze:bg] window ${briefing.window.join(", ")} | ${briefing.timeline.priceThrusts.length} thrusts | ${briefing.timeline.totalSignalEvents} events`);

        const analysis = await analyzeAllModels(briefing, notes);
        console.log(`[analyze:bg] ${analysis.combined.verdict} ${analysis.combined.agreement}`);

        await patchRecord(record.id, (rec) => {
          rec.sessionDate = briefing.sessionDate;
          rec.window = briefing.window;
          rec.briefing = {
            endpoints: briefing.endpoints,
            timeline: briefing.timeline,
            sessionMetrics: briefing.sessionMetrics,
            priceSeries: briefing.priceSeries,
            fetchReport: briefing.fetchReport,
            window: briefing.window,
            // Compact per-session summary so the UI can show the window honestly.
            sessions: briefing.sessions.map((s) => ({
              sessionDate: s.sessionDate,
              thrusts: s.timeline.priceThrusts.length,
              events: s.timeline.totalSignalEvents,
              feeds: s.fetchReport.succeeded,
            })),
          };
          rec.analysis = analysis;
          rec.agreement = analysis.combined.agreement;
          rec.status = "complete";
          rec.jobs = rec.jobs || {};
          rec.jobs.analysis = { status: "done", at: new Date().toISOString() };
        });

        startBackgroundJobs(record.id, { ticker, sessionDate: briefing.sessionDate, analysis });
      } catch (err) {
        console.error(`[analyze:bg] FAILED for ${record.id}:`, err);
        await patchRecord(record.id, (rec) => {
          rec.status = "failed";
          rec.analysisError = err.message || String(err);
          rec.jobs = rec.jobs || {};
          rec.jobs.analysis = { status: "failed", detail: err.message, at: new Date().toISOString() };
        }).catch((e) => console.error("[analyze:bg] couldn't even record the failure:", e.message));
      }
    })();
  } catch (err) {
    console.error("[analyze] FAILED:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Single record — the UI polls this while background jobs fill in findings.
app.get("/api/analyses/:id", async (req, res) => {
  try {
    const all = await readTrades();
    const rec = all.find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backtests one model's proposed rule from a stored analysis against N prior
// sessions it has never seen. This is the step that separates a real rule from
// a story fitted to one afternoon — and it is deliberately a SEPARATE call,
// because it's slow (one full feed pull per session) and you won't want it on
// every analysis.
app.post("/api/analyses/:id/backtest", async (req, res) => {
  const { modelId, sessions = 20, holdMinutes = 15 } = req.body;
  try {
    const all = await readTrades();
    const record = all.find((r) => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: `No analysis with id ${req.params.id}` });

    const rule = record.analysis?.[modelId]?.rule;
    if (!rule) {
      return res.status(400).json({ error: `${modelId} proposed no rule for this session (it concluded nothing was tradeable).` });
    }

    const sessionList = priorSessions(record.sessionDate, sessions);
    console.log(`[backtest] ${modelId}'s rule on ${record.symbol} across ${sessionList.length} sessions...`);

    const result = await backtestRule(rule, {
      ticker: record.symbol,
      sessions: sessionList,
      holdMinutes,
    });
    console.log(`[backtest] ${result.verdict}`);

    // Persist the backtest onto the record, so a rule's real track record
    // travels with the thesis that produced it and can't be quietly forgotten.
    record.backtests = record.backtests || {};
    record.backtests[modelId] = result;
    await appendTrade(record);

    res.json(result);
  } catch (err) {
    console.error("[backtest] FAILED:", err);
    res.status(500).json({ error: err.message });
  }
});

// THE REFINEMENT LOOP: propose -> backtest -> read your own losses -> revise ->
// backtest again. This is where the system actually learns rather than just
// reporting a one-day story. Slow (many sessions x many rounds), so it's an
// explicit action, not something that fires automatically.
app.post("/api/analyses/:id/refine", async (req, res) => {
  const { modelId, sessions = 60, maxRounds = 4, holdMinutes = 15 } = req.body;
  try {
    const all = await readTrades();
    const record = all.find((r) => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: `No analysis with id ${req.params.id}` });

    const rule = record.analysis?.[modelId]?.rule;
    if (!rule) {
      return res.status(400).json({ error: `${modelId} proposed no rule — it concluded nothing was tradeable. Nothing to refine.` });
    }

    console.log(`[refine] ${modelId} on ${record.symbol}, ${sessions} sessions, up to ${maxRounds} rounds...`);
    const result = await refineRule({
      modelId, initialRule: rule, ticker: record.symbol,
      fromDate: record.sessionDate, sessions, maxRounds, holdMinutes,
      onRound: (e) => console.log(`[refine] round ${e.round}: ${e.backtest.testable ? `${e.backtest.totalTrades} trades, ${e.backtest.winRate}% win` : "not testable"}`),
    });
    console.log(`[refine] ${result.conclusion}`);

    record.refinements = record.refinements || {};
    record.refinements[modelId] = result;
    try { await appendTrade(record); } catch (e) { console.error("[refine] DB write failed:", e.message); }

    res.json(result);
  } catch (err) {
    console.error("[refine] FAILED:", err);
    res.status(500).json({ error: err.message });
  }
});

// CONFIRMATION ANALYSIS: separates SIGNAL from CONFIRMATION from NOISE by
// MEASURING them. Backtests the base rule alone, then base+each candidate, then
// each candidate alone — and reports the actual lift. This is how "works 60% of
// the time, but 90% when a volume spike accompanies it" becomes a fact rather
// than a hunch.
app.post("/api/analyses/:id/confirmers", async (req, res) => {
  const { modelId, sessions = 40, holdMinutes = 15 } = req.body;
  try {
    const all = await readTrades();
    const record = all.find((r) => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: `No analysis with id ${req.params.id}` });

    const rule = record.analysis?.[modelId]?.rule;
    if (!rule) return res.status(400).json({ error: `${modelId} proposed no rule — nothing to find confirmers for.` });

    const sessionList = priorSessions(record.sessionDate, sessions);
    console.log(`[confirmers] ${modelId} on ${record.symbol}, ${sessionList.length} sessions...`);

    const result = await analyzeConfirmers(rule, {
      ticker: record.symbol, sessions: sessionList, holdMinutes,
      onProgress: (row) => console.log(`[confirmers] ${row.key}: ${row.role} (lift ${row.lift})`),
    });

    record.confirmers = record.confirmers || {};
    record.confirmers[modelId] = result;
    try { await appendTrade(record); } catch (e) { console.error("[confirmers] DB write failed:", e.message); }

    res.json(result);
  } catch (err) {
    console.error("[confirmers] FAILED:", err);
    res.status(500).json({ error: err.message });
  }
});

// RE-RUN an existing analysis against the CURRENT engine, in place (same id).
// The engine keeps improving — new feeds, new metrics, fixed bugs — so old
// records go stale and their conclusions can no longer be trusted. Rather than
// leave misleading results sitting in the log, this re-pulls every feed and
// re-runs all 3 analysts with today's code, overwriting the record.
// Any backtests/refinements/confirmers attached to the OLD analysis are dropped,
// because they were computed against a rule that no longer exists.
app.post("/api/analyses/:id/rerun", async (req, res) => {
  try {
    const all = await readTrades();
    const old = all.find((r) => r.id === req.params.id);
    if (!old) return res.status(404).json({ error: `No analysis with id ${req.params.id}` });

    const ticker = old.symbol;

    // LEGACY RECORDS. The oldest records predate the architecture pivot: they
    // were TRADES (entryDate/exitDate/outcome), not session analyses, so they
    // have no `sessionDate` at all. Doing `new Date(undefined + "T00:00:00Z")`
    // produced an Invalid Date, and `.toISOString()` on it threw the useless
    // "Invalid time value". Fall back to the trade's entry date, which is the
    // session the old record was actually about.
    const sessionDate = old.sessionDate || old.entryDate || null;

    if (!ticker || !sessionDate) {
      return res.status(400).json({
        error: `This record is too old to re-run: it has ${!ticker ? "no symbol" : "no session date (and no legacy entryDate to fall back on)"}. It predates the current schema entirely. Delete it and run a fresh analysis for the symbol/date you want.`,
      });
    }
    // A malformed date string would throw the same cryptic error deeper in.
    if (Number.isNaN(new Date(sessionDate + "T00:00:00Z").getTime())) {
      return res.status(400).json({ error: `This record's date ("${sessionDate}") isn't a valid date, so it can't be re-run. Delete it and start a fresh analysis.` });
    }

    const contract = old.contract || null;
    const notes = req.body?.notes ?? old.notes ?? null;

    // SAME ASYNC SHAPE AS /api/analyze: probe fast, flag the record as
    // analyzing, respond immediately, do the heavy work in the background.
    // The OLD analysis stays on the record until the new one replaces it, so
    // the detail view keeps showing something real while the card carries the
    // ANALYZING badge.
    console.log(`[rerun] ${ticker} ${sessionDate} — probing session window...`);
    const { dates, noDataReason } = await findSessionDates({ ticker, sessionDate, sessionCount: 3 });
    if (!dates.length) return res.status(400).json({ error: noDataReason });

    const flagged = await patchRecord(old.id, (rec) => {
      rec.status = "analyzing";
      rec.rerunAt = new Date().toISOString();
      rec.jobs = { ...(rec.jobs || {}), analysis: { status: "running", at: new Date().toISOString() } };
      // Old findings belong to the old analysis — drop them now so stale
      // results never sit next to a new verdict.
      rec.backtests = undefined;
      rec.refinements = undefined;
      rec.confirmers = undefined;
    });
    if (!flagged) return res.status(404).json({ error: `Record ${old.id} disappeared mid-rerun.` });

    res.json(flagged);

    // ---- Background: the actual re-analysis. ----
    (async () => {
      try {
        console.log(`[rerun:bg] ${ticker} pulling ${dates.length} sessions of feeds...`);
        const bundles = await fetchBundlesForDates({ ticker, dates, contract });
        const briefing = buildMultiBriefing(bundles, { contract });
        console.log(`[rerun:bg] window ${briefing.window.join(", ")} | ${briefing.timeline.priceThrusts.length} thrusts`);

        const analysis = await analyzeAllModels(briefing, notes);

        await patchRecord(old.id, (rec) => {
          rec.symbol = ticker;
          rec.sessionDate = briefing.sessionDate;
          rec.window = briefing.window;
          rec.notes = notes;
          rec.entryDate = undefined;
          rec.exitDate = undefined;
          rec.outcome = undefined;
          rec.briefing = {
            endpoints: briefing.endpoints,
            timeline: briefing.timeline,
            sessionMetrics: briefing.sessionMetrics,
            priceSeries: briefing.priceSeries,
            fetchReport: briefing.fetchReport,
            window: briefing.window,
            sessions: briefing.sessions.map((s) => ({
              sessionDate: s.sessionDate,
              thrusts: s.timeline.priceThrusts.length,
              events: s.timeline.totalSignalEvents,
              feeds: s.fetchReport.succeeded,
            })),
          };
          rec.analysis = analysis;
          rec.agreement = analysis.combined.agreement;
          rec.status = "complete";
          rec.jobs = rec.jobs || {};
          rec.jobs.analysis = { status: "done", at: new Date().toISOString() };
        });

        console.log(`[rerun:bg] done. ${analysis.combined.verdict} ${analysis.combined.agreement}`);
        startBackgroundJobs(old.id, { ticker, sessionDate: briefing.sessionDate, analysis });
      } catch (err) {
        console.error(`[rerun:bg] FAILED for ${old.id}:`, err);
        // The OLD analysis is still on the record and still valid — a failed
        // RE-run must not brick it into the "failed" card state. Restore
        // "complete" if there's an analysis to show; only mark "failed" if
        // this was somehow a record with nothing on it.
        await patchRecord(old.id, (rec) => {
          rec.status = rec.analysis ? "complete" : "failed";
          if (!rec.analysis) rec.analysisError = err.message || String(err);
          rec.jobs = rec.jobs || {};
          rec.jobs.analysis = { status: "failed", detail: `Re-run failed (previous analysis kept): ${err.message}`, at: new Date().toISOString() };
        }).catch((e) => console.error("[rerun:bg] couldn't even record the failure:", e.message));
      }
    })();
  } catch (err) {
    console.error("[rerun] FAILED:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Delete a record. Needed because some legacy records are genuinely
// unrecoverable (no symbol/date), and leaving broken rows in the log is worse
// than removing them.
app.delete("/api/analyses/:id", async (req, res) => {
  try {
    await deleteTrade(req.params.id);
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error("[delete] FAILED:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// STRATEGY LAB — a SEPARATE feature from the trade-analysis system above.
// This tests a strategy IDEA (e.g. a published paper) against real price
// history BEFORE any real trade is ever placed, rather than analyzing a trade
// you already made. Three steps, each its own endpoint:
//   1. /interpret   — AI reads a plain-English description, returns a
//                     structured rule + a plain-English summary for the user
//                     to confirm BEFORE anything is backtested.
//   2. /backtest    — deterministic code (no AI) simulates that exact rule
//                     against real 1-min Databento bars.
//   3. /session-chart — full detail for ONE day, for the "inspect this trade"
//                     view (price + indicator overlay + entry/exit markers).
// ===========================================================================

app.post("/api/strategy/interpret", async (req, res) => {
  const { description } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: "description is required" });
  }
  try {
    const rule = await parseStrategy(description);
    res.json(rule);
  } catch (err) {
    console.error("[strategy/interpret] FAILED:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/strategy/backtest", async (req, res) => {
  const { rule, startDate, endDate, startingCapital = 25000 } = req.body;
  if (!rule?.symbols?.length) return res.status(400).json({ error: "rule.symbols must have at least one symbol" });
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });

  const symbol = rule.symbols[0];
  try {
    console.log(`[strategy/backtest] fetching ${symbol} bars ${startDate} -> ${endDate}...`);
    const bars = await fetchOhlcvBars({ symbol, startDate, endDate });
    if (!bars.length) return res.status(400).json({ error: `No bars returned for ${symbol} in that range.` });

    const result = runBacktest(rule, bars, { startingCapital });
    console.log(`[strategy/backtest] ${symbol}: ${result.totalTrades} trades, ${result.totalReturnPct}% return`);
    res.json(result);
  } catch (err) {
    console.error("[strategy/backtest] FAILED:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/strategy/session-chart", async (req, res) => {
  const { rule, sessionDate } = req.body;
  if (!rule?.symbols?.length || !sessionDate) {
    return res.status(400).json({ error: "rule and sessionDate are required" });
  }
  const symbol = rule.symbols[0];
  try {
    // Fetch just this one day (end exclusive, so +1 day).
    const d = new Date(sessionDate + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDay = d.toISOString().slice(0, 10);

    const bars = await fetchOhlcvBars({ symbol, startDate: sessionDate, endDate: nextDay });
    const chart = getSessionChart(rule, bars);
    if (!chart) return res.status(400).json({ error: `No RTH bars found for ${symbol} on ${sessionDate}.` });
    res.json(chart);
  } catch (err) {
    console.error("[strategy/session-chart] FAILED:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.use(express.static(DIST_DIR));
app.get("*", (req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));

app.listen(PORT, () => {
  console.log(`GHOSTFLOW on port ${PORT}${!USER || !PASS ? " (WARNING: no auth)" : " (auth enabled)"}`);
  runAIProviderHealthCheck();
});

async function runAIProviderHealthCheck() {
  for (const [name, fn] of [["Claude", callClaude], ["GPT", callGPT], ["Grok", callGrok]]) {
    try {
      await fn("Reply with exactly one word: OK");
      console.log(`AI provider check — ${name}: OK`);
    } catch (err) {
      console.error(`AI provider check — ${name}: FAILED (${err.message})`);
    }
  }
}
