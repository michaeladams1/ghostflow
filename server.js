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
import { readTrades, appendTrade } from "./server/store.js";
import { fetchAllEndpoints } from "./server/quantDataClient.js";
import { buildBriefing } from "./server/compress.js";
import { analyzeAllModels } from "./server/analysis.js";
import { backtestRule, priorSessions } from "./server/backtest.js";
import { refineRule } from "./server/refine.js";
import { analyzeConfirmers } from "./server/confirmation.js";
import { callClaude, callGPT, callGrok } from "./server/aiProviders.js";

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
app.post("/api/analyze", async (req, res) => {
  const { symbol, sessionDate, lookbackDays = 15, contract, notes } = req.body;
  if (!symbol || !sessionDate) {
    return res.status(400).json({ error: "symbol and sessionDate are required" });
  }

  const ticker = String(symbol).toUpperCase();
  const start = new Date(sessionDate + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  const startDate = start.toISOString().slice(0, 10);

  try {
    console.log(`[analyze] ${ticker} ${sessionDate} — fetching all feeds...`);
    const bundle = await fetchAllEndpoints({ ticker, sessionDate, startDate, endDate: sessionDate, contract });
    console.log(`[analyze] fetched ${bundle.report.succeeded}/${bundle.report.attempted} feeds`);

    const briefing = buildBriefing(bundle, { contract });
    console.log(`[analyze] ${briefing.timeline.priceThrusts.length} price thrusts detected; running 3 analysts...`);

    const analysis = await analyzeAllModels(briefing, notes);
    console.log(`[analyze] done. combined=${analysis.combined.verdict} agreement=${analysis.combined.agreement}`);

    const record = {
      id: "a" + Date.now(),
      symbol: ticker,
      sessionDate,
      contract: contract || null,
      notes: notes || null,
      loggedAt: new Date().toISOString(),
      briefing: {
        endpoints: briefing.endpoints,
        timeline: briefing.timeline,
        sessionMetrics: briefing.sessionMetrics,
        fetchReport: briefing.fetchReport,
      },
      analysis,
      agreement: analysis.combined.agreement,
    };

    // Persistence must NEVER destroy a completed analysis. This run cost ~2
    // minutes, 30 API pulls, and 3 LLM calls of real money — if the database
    // is unreachable, the right move is to hand the result back with a warning,
    // not to 500 and throw the whole thing away.
    let persisted = true, persistError = null;
    try {
      await appendTrade(record);
    } catch (err) {
      persisted = false;
      persistError = err.message;
      console.error("[analyze] DB write failed (analysis still returned):", err.message);
    }

    res.status(201).json({ ...record, persisted, persistError });
  } catch (err) {
    console.error("[analyze] FAILED:", err);
    res.status(500).json({ error: err.message || String(err) });
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
    const sessionDate = old.sessionDate;
    const contract = old.contract || null;
    const notes = req.body?.notes ?? old.notes ?? null;

    const start = new Date(sessionDate + "T00:00:00Z");
    start.setUTCDate(start.getUTCDate() - 15);
    const startDate = start.toISOString().slice(0, 10);

    console.log(`[rerun] ${ticker} ${sessionDate} with current engine...`);
    const bundle = await fetchAllEndpoints({ ticker, sessionDate, startDate, endDate: sessionDate, contract });
    const briefing = buildBriefing(bundle, { contract });
    console.log(`[rerun] ${bundle.report.succeeded}/${bundle.report.attempted} feeds, ${briefing.timeline.priceThrusts.length} thrusts, ${briefing.timeline.totalSignalEvents} events`);

    const analysis = await analyzeAllModels(briefing, notes);

    const record = {
      ...old,
      notes,
      rerunAt: new Date().toISOString(),
      briefing: {
        endpoints: briefing.endpoints,
        timeline: briefing.timeline,
        sessionMetrics: briefing.sessionMetrics,
        fetchReport: briefing.fetchReport,
      },
      analysis,
      agreement: analysis.combined.agreement,
      // Stale derived work — computed from a rule this re-run just replaced.
      backtests: undefined,
      refinements: undefined,
      confirmers: undefined,
    };

    let persisted = true;
    try { await appendTrade(record); } catch (e) { persisted = false; console.error("[rerun] DB write failed:", e.message); }

    console.log(`[rerun] done. ${analysis.combined.verdict} ${analysis.combined.agreement}`);
    res.json({ ...record, persisted });
  } catch (err) {
    console.error("[rerun] FAILED:", err);
    res.status(500).json({ error: err.message });
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
