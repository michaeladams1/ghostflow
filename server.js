// GHOSTFLOW server: serves the built frontend, gates everything behind
// HTTP Basic Auth (Railway env vars), and exposes a small trade API that
// fetches real market data from Databento + Quant Data per logged trade.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTrades, appendTrade } from "./server/store.js";
import { buildTradeDataset } from "./server/tradeData.js";
import { callClaude, callGPT, callGrok } from "./server/aiProviders.js";
import { analyzeTradeAllModels } from "./server/analysis.js";
import { runFridayTestAnalysis } from "./server/testAnalysis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = process.env.PORT || 3000;
const USER = process.env.GHOSTFLOW_USER;
const PASS = process.env.GHOSTFLOW_PASS;

const app = express();
app.use(express.json());

// --- Basic Auth gate (applies to everything, including the API) ---
app.use((req, res, next) => {
  if (!USER || !PASS) return next(); // no creds configured — see README warning
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const [u, p] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (u === USER && p === PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="GHOSTFLOW"');
  res.status(401).send("Authentication required");
});

// --- Trade API ---
app.get("/api/trades", async (req, res) => {
  try {
    res.json(await readTrades());
  } catch (err) {
    console.error("Failed to read trades:", err.message);
    res.status(500).json({ error: "Database read failed: " + err.message });
  }
});

app.post("/api/trades", async (req, res) => {
  const { symbol, direction, outcome, entryDate, exitDate, entryPrice, exitPrice, notes } = req.body;
  if (!symbol || !entryDate) {
    return res.status(400).json({ error: "symbol and entryDate are required" });
  }
  try {
    const dataset = await buildTradeDataset({ symbol, entryDate, exitDate });
    let analysis = null, analysisStatus = "failed";
    try {
      analysis = await analyzeTradeAllModels({ symbol: symbol.toUpperCase(), direction, entryDate, exitDate }, dataset);
      analysisStatus = "complete";
    } catch (err) {
      console.error("AI analysis failed for", symbol, ":", err.message);
    }
    const trade = {
      id: "t" + Date.now(),
      symbol: symbol.toUpperCase(),
      direction,
      outcome,
      entryDate, exitDate, entryPrice, exitPrice, notes,
      loggedAt: new Date().toISOString(),
      ...dataset, // prices, entryIdx, exitIdx, bars, rawFlow, dataFetchOk
      analysis, // null if analysis failed — see analysisStatus
      analysisStatus,
    };
    await appendTrade(trade);
    res.status(201).json(trade);
  } catch (err) {
    console.error("Trade dataset build failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Re-runs the 3-model analysis for an already-logged trade against its
// original symbol/entry/exit, and OVERWRITES that trade's stored analysis
// in place (same id \u2014 no duplicate row). Exists because prompt logic keeps
// improving; this lets any past trade be re-scored against the current
// prompt without re-logging it from scratch.
app.post("/api/trades/:id/reanalyze", async (req, res) => {
  try {
    const trades = await readTrades();
    const existing = trades.find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: `No trade with id ${req.params.id}` });

    const dataset = await buildTradeDataset({ symbol: existing.symbol, entryDate: existing.entryDate, exitDate: existing.exitDate });
    const analysis = await analyzeTradeAllModels(
      { symbol: existing.symbol, direction: existing.direction, entryDate: existing.entryDate, exitDate: existing.exitDate },
      dataset
    );
    const updated = {
      ...existing,
      ...dataset, // fresh prices/entryIdx/exitIdx/bars/intradayBars/rawFlow/dataFetchOk
      entryPrice: dataset.bars?.[dataset.entryIdx]?.close ?? existing.entryPrice,
      exitPrice: dataset.bars?.[dataset.exitIdx]?.close ?? existing.exitPrice,
      analysis,
      analysisStatus: "complete",
      agreement: analysis.combined.agreement,
    };
    await appendTrade(updated);
    res.json(updated);
  } catch (err) {
    console.error("Reanalyze failed for", req.params.id, ":", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Static frontend ---
app.use(express.static(DIST_DIR));
app.get("*", (req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));

app.listen(PORT, () => {
  console.log(`GHOSTFLOW serving on port ${PORT}${!USER || !PASS ? " (WARNING: no auth configured)" : " (auth enabled)"}`);
  runAIProviderHealthCheck().then(() => runFridayTestAnalysis()); // TEMPORARY — remove after reviewing this test run
});

// One-time startup check confirming each AI provider key actually works.
// Logs pass/fail only — never logs key values. Not on the request path;
// just a startup diagnostic so this shows up in Deploy Logs automatically.
async function runAIProviderHealthCheck() {
  const checks = [
    ["Claude", callClaude],
    ["GPT", callGPT],
    ["Grok", callGrok],
  ];
  for (const [name, fn] of checks) {
    try {
      await fn("Reply with exactly one word: OK");
      console.log(`AI provider check \u2014 ${name}: OK`);
    } catch (err) {
      console.error(`AI provider check \u2014 ${name}: FAILED (${err.message})`);
    }
  }
}
