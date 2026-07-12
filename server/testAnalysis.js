// Seeds one real, verified trade into the store on startup — this is how
// GHOSTFLOW gets its first non-mock trade into the dashboard. Idempotent:
// checks the store first and skips if this trade is already there, so
// restarts don't create duplicates or re-spend API credits needlessly.
//
// NOTE: because trade storage is currently an ephemeral JSON file (see
// docs/architecture.md), a full REDEPLOY wipes the store and this will
// re-seed on the next boot, re-spending API credits. A plain container
// restart (no redeploy) does not wipe the file, so the idempotency check
// still matters day-to-day. This whole mechanism goes away once real
// persistent storage (a database or Railway volume) replaces the JSON file.
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
  const already = readTrades().some(
    (t) => t.symbol === SEED_TRADE.symbol && t.entryDate === SEED_TRADE.entryDate && t.exitDate === SEED_TRADE.exitDate
  );
  if (already) {
    console.log("Seed trade (META 2026-06-25\u20132026-07-10) already present \u2014 skipping re-seed.");
    return;
  }

  console.log("Seeding real trade: META 2026-06-25 to 2026-07-10 ...");
  try {
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
    appendTrade(trade);
    console.log(`Seed trade saved. Combined verdict: ${analysis.combined.verdict}, agreement ${analysis.combined.agreement}.`);
  } catch (err) {
    console.error("Seed trade failed:", err.message);
  }
}
