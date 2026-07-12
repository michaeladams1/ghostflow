// GHOSTFLOW server: serves the built frontend, gates everything behind
// HTTP Basic Auth (Railway env vars), and exposes a small trade API that
// fetches real market data from Databento + Quant Data per logged trade.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTrades, appendTrade } from "./server/store.js";
import { buildTradeDataset } from "./server/tradeData.js";
import { callClaude, callGPT, callGrok } from "./server/aiProviders.js";

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
app.get("/api/trades", (req, res) => {
  res.json(readTrades());
});

app.post("/api/trades", async (req, res) => {
  const { symbol, direction, outcome, entryDate, exitDate, entryPrice, exitPrice, notes } = req.body;
  if (!symbol || !entryDate) {
    return res.status(400).json({ error: "symbol and entryDate are required" });
  }
  try {
    const dataset = await buildTradeDataset({ symbol, entryDate, exitDate });
    const trade = {
      id: "t" + Date.now(),
      symbol: symbol.toUpperCase(),
      direction,
      outcome,
      entryDate, exitDate, entryPrice, exitPrice, notes,
      loggedAt: new Date().toISOString(),
      ...dataset, // prices, entryIdx, exitIdx, rawFlow, dataFetchOk
      analysisStatus: "pending", // AI orchestration not built yet — see docs/architecture.md
    };
    appendTrade(trade);
    res.status(201).json(trade);
  } catch (err) {
    console.error("Trade dataset build failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Static frontend ---
app.use(express.static(DIST_DIR));
app.get("*", (req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));

app.listen(PORT, () => {
  console.log(`GHOSTFLOW serving on port ${PORT}${!USER || !PASS ? " (WARNING: no auth configured)" : " (auth enabled)"}`);
  runAIProviderHealthCheck(); // fire-and-forget, doesn't block startup
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
