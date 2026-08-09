import { analyzeZeroDTESession } from "./zeroDTE.js";
import { simulateAllFires } from "./zeroDTEOptionSim.js";

const dates = process.argv.slice(2);
let grandPnl = 0, grandTradeable = 0, grandWins = 0, grandFires = 0;

for (const d of dates) {
  const s = await analyzeZeroDTESession({ symbol: "SPY", sessionDate: d });
  if (!s.ok) { console.log(`\n=== ${d} === SKIPPED: ${s.reason}`); continue; }
  const fires = await simulateAllFires({ ticker: "SPY", sessionDate: d, fires: s.fires });
  const tradeable = fires.filter((f) => f.level);
  const simmed = tradeable.filter((f) => f.trade?.ok);

  let dayPnl = 0;
  console.log(`\n=== ${d} ===  ${s.fires.length} fires | ${tradeable.length} with level | PDH ${s.levels.pdh?.toFixed(2)} PDL ${s.levels.pdl?.toFixed(2)}`);
  for (const f of fires) {
    const t = f.trade;
    if (!f.level) { console.log(`  ${f.clock}  ${f.tier} ${f.direction}  (no level — not tradeable)`); continue; }
    if (!t?.ok) { console.log(`  ${f.clock}  ${f.tier} ${f.direction} $${f.level}  -> SIM FAILED: ${t?.reason}`); continue; }
    const dollars = Number(String(f.size || "250").replace(/[^0-9.]/g, "")) || 250;
    const contracts = Math.max(1, Math.floor(dollars / (t.entryPrice * 100)));
    const pnl = contracts * (t.exitPrice - t.entryPrice) * 100;
    dayPnl += pnl;
    console.log(`  ${f.clock}  ${f.tier} ${f.direction} $${f.level} (${f.points ?? "-"}pts, RSI ${f.rsi})`);
    console.log(`     ${t.contract} | in ${t.entryClock} $${t.entryPrice} x${contracts} | out ${t.exitClock} $${t.exitPrice} | ${t.exitReason} | ${t.pctReturn > 0 ? "+" : ""}${t.pctReturn}% | ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`);
  }
  console.log(`  DAY: ${simmed.length} traded, ${simmed.filter(f=>f.trade.pctReturn>0).length} won, ${dayPnl >= 0 ? "+" : "-"}$${Math.abs(dayPnl).toFixed(2)}`);
  grandPnl += dayPnl; grandTradeable += simmed.length; grandFires += s.fires.length;
  grandWins += simmed.filter(f=>f.trade.pctReturn>0).length;
}

console.log(`\n======== WEEK TOTAL ========`);
console.log(`${grandFires} signals fired | ${grandTradeable} tradeable | ${grandWins} winners (${grandTradeable ? Math.round(grandWins/grandTradeable*100) : 0}%) | ${grandPnl >= 0 ? "+" : "-"}$${Math.abs(grandPnl).toFixed(2)}`);
