// Seeds one real, verified trade into the store on startup — this is how
// GHOSTFLOW gets its first non-mock trade into the dashboard. Idempotent:
// checks the store first and skips if this trade is already there, so
// restarts don't create duplicates or re-spend API credits needlessly.
//
// Trade storage is now PostgreSQL (Railway), so this only actually re-seeds
// once, ever — not on every redeploy like it used to when storage was an
// ephemeral JSON file. Safe to leave running.
//
// Real trade: META, June 25 2026 (close $544.32) to July 10 2026 (close
// $668.07), a genuine +22.7% move on real, documented news (Bank of America
// report on Meta's AI compute buildout). Verified against public reporting.

import { buildTradeDataset } from "./tradeData.js";
import { analyzeTradeAllModels } from "./analysis.js";
import { readTrades, appendTrade } from "./store.js";

const SEED_TRADE = {
  symbol: "META",
  direction: "CALL",
  outcome: "win",
  entryDate: "2026-06-25",
  exitDate: "2026-07-10",
};

export async function runFridayTestAnalysis() {
  try {
    const existing = await readTrades();
    const already = existing.some(
      (t) => t.symbol === SEED_TRADE.symbol && t.entryDate === SEED_TRADE.entryDate && t.exitDate === SEED_TRADE.exitDate
    );
    if (already) {
      console.log("Seed trade (META 2026-06-25\u20132026-07-10) already present \u2014 skipping re-seed.");
      return;
    }

    console.log("Seeding real trade: META 2026-06-25 to 2026-07-10 ...");
    const dataset = await buildTradeDataset(SEED_TRADE);
    if (!dataset.bars) {
      console.error("Seed skipped \u2014 Databento fetch failed, no bars returned.");
      return;
    }
    const analysis = await analyzeTradeAllModels(SEED_TRADE, dataset);
    const trade = {
      id: "t" + Date.now(),
      symbol: SEED_TRADE.symbol,
      direction: SEED_TRADE.direction,
      outcome: SEED_TRADE.outcome,
      status: SEED_TRADE.outcome === "win" ? "win" : "near-miss-loss",
      entryDate: SEED_TRADE.entryDate,
      exitDate: SEED_TRADE.exitDate,
      entryPrice: dataset.bars[dataset.entryIdx]?.close ?? null,
      exitPrice: dataset.bars[dataset.exitIdx]?.close ?? null,
      loggedAt: new Date().toISOString(),
      ...dataset,
      analysis,
      analysisStatus: "complete",
      agreement: analysis.combined.agreement,
    };
    await appendTrade(trade);
    console.log(`Seed trade saved. Combined verdict: ${analysis.combined.verdict}, agreement ${analysis.combined.agreement}.`);
  } catch (err) {
    // Whatever goes wrong here (DB unreachable, data fetch failure, etc.)
    // must never take down the whole server — this is a nice-to-have
    // startup step, not a required one.
    console.error("Seed trade step failed (server continues normally):", err.message);
  }
}
