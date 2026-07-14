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
import { fetchAllEndpoints } from "./server/quantDataClient.js";
import { buildBriefing, buildMultiBriefing } from "./server/compress.js";
import { analyzeAllModels } from "./server/analysis.js";
import { backtestRule, priorSessions } from "./server/backtest.js";
import { refineRule } from "./server/refine.js";
import { analyzeConfirmers } from "./server/confirmation.js";
import { startBackgroundJobs } from "./server/jobs.js";
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
async function fetchSessionWindow({ ticker, sessionDate, contract, sessionCount = 3 }) {
  const bundles = [];
  const d = new Date(sessionDate + "T00:00:00Z");
  let guard = 0;

  while (bundles.length < sessionCount && guard < 15) {
    guard++;
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();

    if (dow !== 0 && dow !== 6) {
      const start = new Date(d);
      start.setUTCDate(start.getUTCDate() - 15); // lookback for OI history etc.
      const b = await fetchAllEndpoints({
        ticker, sessionDate: iso,
        startDate: start.toISOString().slice(0, 10),
        endDate: iso,
        contract,
      });
      // A holiday returns no price bars — not a real session, so it doesn't
      // count toward the window and we keep walking back.
      const hasPrice = b.results.stock_price_over_time?.ok
        && Object.keys(b.results.stock_price_over_time.data?.data || {}).length > 0;
      if (hasPrice) bundles.push(b);
      else console.log(`[window] ${iso} has no price data (holiday?) — skipping`);
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return bundles;
}

app.post("/api/analyze", async (req, res) => {
  const { symbol, sessionDate, contract, notes, sessionCount = 3 } = req.body;
  if (!symbol || !sessionDate) {
    return res.status(400).json({ error: "symbol and sessionDate are required" });
  }

  const ticker = String(symbol).toUpperCase();

  try {
    console.log(`[analyze] ${ticker} ${sessionDate} — fetching ${sessionCount}-session window...`);
    const bundles = await fetchSessionWindow({ ticker, sessionDate, contract, sessionCount });
    if (!bundles.length) {
      return res.status(400).json({ error: `No trading data found for ${ticker} on or before ${sessionDate}.` });
    }

    const briefing = buildMultiBriefing(bundles, { contract });
    console.log(`[analyze] window ${briefing.window.join(", ")} | ${briefing.timeline.priceThrusts.length} thrusts | ${briefing.timeline.totalSignalEvents} events`);

    const analysis = await analyzeAllModels(briefing, notes);
    console.log(`[analyze] ${analysis.combined.verdict} ${analysis.combined.agreement}`);

    const record = {
      id: "a" + Date.now(),
      symbol: ticker,
      sessionDate: briefing.sessionDate,
      window: briefing.window,
      contract: contract || null,
      notes: notes || null,
      loggedAt: new Date().toISOString(),
      briefing: {
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
      },
      analysis,
      agreement: analysis.combined.agreement,
    };

    // AUTO-BACKTEST NOW RUNS IN THE BACKGROUND (jobs.js), not here.
    // It used to run inline, which held this HTTP request open for 10-20
    // minutes (3 models x 40 sessions of feed fetches). If the connection
    // dropped anywhere in that window, the UI sat on "Pulling 30 feeds..."
    // forever and the finished analysis never reached the screen. The UI
    // already polls for rules whose backtest hasn't landed, so the results
    // fill in the same way confirmers and refinements do.

    let persisted = true, persistError = null;
    try {
      await appendTrade(record);
    } catch (err) {
      persisted = false;
      persistError = err.message;
      console.error("[analyze] DB write failed (analysis still returned):", err.message);
    }

    // Respond NOW, then keep working. Confirmation analysis and the refinement
    // loop take many minutes; making them buttons made the most important steps
    // optional, and making them blocking would time out the request. They run in
    // the background and write into this record as they finish.
    res.status(201).json({ ...record, persisted, persistError });

    if (persisted) {
      startBackgroundJobs(record.id, { ticker, sessionDate: briefing.sessionDate, analysis });
    }
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

    console.log(`[rerun] ${ticker} ${sessionDate} with current engine (3-session window)...`);
    const bundles = await fetchSessionWindow({ ticker, sessionDate, contract, sessionCount: 3 });
    if (!bundles.length) return res.status(400).json({ error: `No trading data for ${ticker} on or before ${sessionDate}.` });

    const briefing = buildMultiBriefing(bundles, { contract });
    console.log(`[rerun] window ${briefing.window.join(", ")} | ${briefing.timeline.priceThrusts.length} thrusts`);

    const analysis = await analyzeAllModels(briefing, notes);

    const record = {
      ...old,
      symbol: ticker,
      sessionDate: briefing.sessionDate,
      window: briefing.window,
      notes,
      entryDate: undefined,
      exitDate: undefined,
      outcome: undefined,
      rerunAt: new Date().toISOString(),
      briefing: {
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
      },
      analysis,
      agreement: analysis.combined.agreement,
      backtests: undefined,
      refinements: undefined,
      confirmers: undefined,
    };

    // Auto-backtest on re-run happens in the background too — same reasoning
    // as /api/analyze: keeping it inline is what hung the request.

    let persisted = true;
    try { await appendTrade(record); } catch (e) { persisted = false; console.error("[rerun] DB write failed:", e.message); }

    console.log(`[rerun] done. ${analysis.combined.verdict} ${analysis.combined.agreement}`);
    res.json({ ...record, persisted });

    // Same as /analyze: the heavy findings fill in behind the response.
    if (persisted) {
      startBackgroundJobs(record.id, { ticker, sessionDate: briefing.sessionDate, analysis });
    }
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
