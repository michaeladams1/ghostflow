import { analyzeZeroDTESession } from "./zeroDTE.js";
import { simulateAllFires } from "./zeroDTEOptionSim.js";

const sessionDate = process.argv[2] || "2026-08-07";
const result = await analyzeZeroDTESession({ symbol: "SPY", sessionDate });
if (!result.ok) { console.log("FAILED:", result.reason); process.exit(1); }

console.log(`SPY ${sessionDate} — ${result.bars.length} bars, ${result.fires.length} fires\n`);

const withTrades = await simulateAllFires({ ticker: "SPY", sessionDate, fires: result.fires });
for (const f of withTrades) {
  console.log(`${f.clock}  ${f.tier} ${f.direction}  level=${f.level ?? "-"}  rsi=${f.rsi}`);
  if (f.trade.ok) {
    console.log(`   -> ${f.trade.contract}: entry ${f.trade.entryClock} @ $${f.trade.entryPrice} | exit ${f.trade.exitClock} @ $${f.trade.exitPrice} | ${f.trade.exitReason} | ${f.trade.pctReturn}% | ${f.trade.holdMinutes}min`);
  } else {
    console.log(`   -> no trade sim: ${f.trade.reason}`);
  }
}
