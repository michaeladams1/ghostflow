import { analyzeZeroDTESession } from "./zeroDTE.js";

for (const date of process.argv.slice(2)) {
  const s = await analyzeZeroDTESession({ symbol: "SPY", sessionDate: date });
  if (!s.ok) { console.log(date, "FAILED", s.reason); continue; }

  const rth = s.bars.filter((b) => b.inSession);
  const inWin = rth.filter((b) => b.min >= 585 && b.min < 675);
  const maxCall = Math.max(...rth.map((b) => b.callPts));
  const maxPut = Math.max(...rth.map((b) => b.putPts));
  const maxCallWin = inWin.length ? Math.max(...inWin.map((b) => b.callPts)) : 0;
  const maxPutWin = inWin.length ? Math.max(...inWin.map((b) => b.putPts)) : 0;
  const over11 = rth.filter((b) => b.callPts >= 11 || b.putPts >= 11).length;
  const over11Win = inWin.filter((b) => b.callPts >= 11 || b.putPts >= 11).length;

  const reasons = {};
  for (const nm of s.nearMisses || []) for (const r of nm.reasons) reasons[r] = (reasons[r] || 0) + 1;

  console.log(`\n=== ${date} ===`);
  console.log(`  peak score all-session: call ${maxCall} put ${maxPut} | inside 9:45-11:15: call ${maxCallWin} put ${maxPutWin}`);
  console.log(`  bars scoring >=11 (A-tier bar): ${over11} all-session, ${over11Win} in-window`);
  console.log(`  fires: ${s.fires.map((f) => `${f.tier}${f.level ? "@" + f.levelType : ""}`).join(", ") || "none"}`);
  console.log(`  near-miss reasons:`, Object.keys(reasons).length ? reasons : "none captured");
}
