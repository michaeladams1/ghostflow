// STRATEGY LAB — test a strategy IDEA against real price history before any
// real trade is placed. Three steps: describe -> confirm the AI's read-back
// -> backtest. Separate from the trade-analysis system (App.jsx's main tab),
// which analyzes trades you've ALREADY made.
import { useState } from "react";
import { FlaskConical, Loader2, ChevronRight, AlertTriangle } from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceDot, Legend,
} from "recharts";

const card = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800";
const faint = "text-zinc-500 dark:text-zinc-500";
const heading = "text-[11px] uppercase tracking-wider font-mono text-zinc-500";

function StatCard({ label, value, sub, tone }) {
  const toneCls = tone === "good" ? "text-emerald-600 dark:text-emerald-400"
    : tone === "bad" ? "text-red-600 dark:text-red-400"
    : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className={`${card} rounded-lg p-3`}>
      <div className={heading}>{label}</div>
      <div className={`text-lg font-semibold mt-1 ${toneCls}`}>{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 ${faint}`}>{sub}</div>}
    </div>
  );
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
}

export default function StrategyLab() {
  const [description, setDescription] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [rule, setRule] = useState(null);
  const [error, setError] = useState(null);

  const [startDate, setStartDate] = useState("2026-05-01");
  const [endDate, setEndDate] = useState("2026-07-09");
  const [startingCapital, setStartingCapital] = useState(25000);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const [showBuyHold, setShowBuyHold] = useState(true);
  const [selectedDate, setSelectedDate] = useState(null);
  const [dayChart, setDayChart] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);

  const interpret = async () => {
    setInterpreting(true); setError(null); setRule(null); setResult(null);
    try {
      const res = await fetch("/api/strategy/interpret", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Interpretation failed");
      setRule(data);
    } catch (e) { setError(e.message); }
    setInterpreting(false);
  };

  const runBacktest = async () => {
    setRunning(true); setError(null); setResult(null); setDayChart(null); setSelectedDate(null);
    try {
      const res = await fetch("/api/strategy/backtest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule, startDate, endDate, startingCapital: Number(startingCapital) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backtest failed");
      setResult(data);
    } catch (e) { setError(e.message); }
    setRunning(false);
  };

  const viewDay = async (sessionDate) => {
    setSelectedDate(sessionDate); setDayLoading(true); setDayChart(null);
    try {
      const res = await fetch("/api/strategy/session-chart", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule, sessionDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load that day");
      setDayChart(data);
    } catch (e) { setError(e.message); }
    setDayLoading(false);
  };

  // Merge strategy + buy&hold equity curves into one array recharts can plot.
  const equityData = result?.strategyEquityCurve.map((pt, i) => ({
    date: pt.date,
    strategy: pt.equity,
    buyHold: result.buyHoldEquityCurve[i]?.equity,
  }));

  return (
    <div className="grid lg:grid-cols-[360px_1fr] gap-4">
      {/* LEFT: describe + confirm */}
      <div className="space-y-3">
        <div className={`${card} rounded-lg p-3`}>
          <div className={`${heading} mb-2 flex items-center gap-1.5`}><FlaskConical size={13} /> Describe the strategy</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. VWAP Trend Trading on QQQ: after the first 1-min candle closes at 9:31am ET, go long if price is above session VWAP, short if below. Exit when a candle closes on the wrong side of VWAP, or at 4pm close. No overnight holds, 100% equity."
            className="w-full h-40 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 font-mono"
          />
          <button onClick={interpret} disabled={interpreting || !description.trim()}
            className="mt-2 w-full flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 rounded-md">
            {interpreting ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
            {interpreting ? "Reading..." : "Interpret strategy"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg p-3 border border-red-500/40 bg-red-500/5 text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {rule && (
          <div className={`${card} rounded-lg p-3 space-y-3`}>
            <div className={heading}>What I understood — confirm before running</div>
            <p className="text-sm">{rule.summary}</p>
            {rule.warnings?.length > 0 && (
              <div className="rounded-md p-2 border border-amber-500/40 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-400 space-y-1">
                {rule.warnings.map((w, i) => <div key={i} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{w}</div>)}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className={faint}>Symbol</div>
                <div className="font-mono">{rule.symbols?.join(", ") || "—"}</div>
              </div>
              <div>
                <div className={faint}>Position sizing</div>
                <div className="font-mono">{rule.positionSizing}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={`${faint} text-[11px]`}>Start date</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-1" />
              </div>
              <div>
                <label className={`${faint} text-[11px]`}>End date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-1" />
              </div>
              <div>
                <label className={`${faint} text-[11px]`}>Capital</label>
                <input type="number" value={startingCapital} onChange={(e) => setStartingCapital(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-1" />
              </div>
            </div>
            <button onClick={runBacktest} disabled={running || !rule.symbols?.length}
              className="w-full flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 rounded-md">
              {running ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
              {running ? "Running backtest..." : "Looks right — run backtest"}
            </button>
          </div>
        )}
      </div>

      {/* RIGHT: results */}
      <div className="space-y-4">
        {!result && (
          <div className={`px-4 py-16 text-center text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 ${faint}`}>
            Describe a strategy on the left, confirm what I understood, then run the backtest. Results — equity curve, full trade log, and per-day chart overlays — show up here.
          </div>
        )}

        {result && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard label="Total return" value={`${result.totalReturnPct}%`} tone={result.totalReturnPct >= 0 ? "good" : "bad"}
                sub={`vs Buy&Hold ${result.buyHold.totalReturnPct}%`} />
              <StatCard label="Max drawdown" value={`${result.maxDrawdownPct}%`} tone="bad"
                sub={`Buy&Hold ${result.buyHold.maxDrawdownPct}%`} />
              <StatCard label="Sharpe" value={result.sharpeRatio} />
              <StatCard label="Win rate" value={`${result.winRate}%`} sub={`${result.totalTrades} trades`} />
              <StatCard label="Avg win" value={`${result.avgWinPct}%`} tone="good" />
              <StatCard label="Avg loss" value={`${result.avgLossPct}%`} tone="bad" />
              <StatCard label="Risk:Reward" value={result.riskReward ?? "—"} />
              <StatCard label="Final equity" value={`$${result.finalEquity.toLocaleString()}`} sub={`from $${result.startingCapital.toLocaleString()}`} />
            </div>

            {/* Equity curve */}
            <div className={`${card} rounded-lg p-3`}>
              <div className="flex items-center justify-between mb-2">
                <div className={heading}>Equity curve</div>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input type="checkbox" checked={showBuyHold} onChange={(e) => setShowBuyHold(e.target.checked)} />
                  Compare to Buy & Hold
                </label>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={equityData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="strategy" name="Strategy" stroke="#10b981" dot={false} strokeWidth={1.5} />
                  {showBuyHold && <Line type="monotone" dataKey="buyHold" name="Buy & Hold" stroke="#a1a1aa" dot={false} strokeWidth={1.5} strokeDasharray="4 3" />}
                </ComposedChart>
              </ResponsiveContainer>
              {result.caveats?.length > 0 && (
                <div className={`text-[11px] mt-1 ${faint}`}>Note: {result.caveats.join(" · ")}</div>
              )}
            </div>

            {/* Day inspector: price + indicator overlay + entry/exit markers */}
            <div className={`${card} rounded-lg p-3`}>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <div className={heading}>Inspect a trading day</div>
                <select value={selectedDate || ""} onChange={(e) => viewDay(e.target.value)}
                  className="text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-1">
                  <option value="" disabled>Pick a day with trades...</option>
                  {result.tradeDates.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              {dayLoading && <div className={`text-xs ${faint} flex items-center gap-1.5`}><Loader2 size={12} className="animate-spin" /> loading {selectedDate}...</div>}
              {dayChart && (
                <>
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={dayChart.bars.map((b) => ({ ...b, clock: fmtClock(b.ts) }))}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="clock" tick={{ fontSize: 10 }} minTickGap={50} />
                      <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                      <Tooltip contentStyle={{ fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="close" name="Price" stroke="#3b82f6" dot={false} strokeWidth={1.25} />
                      {dayChart.indicators.map((ind) => (
                        <Line key={ind.id} type="monotone" dataKey={ind.id} name={ind.type} stroke="#f59e0b" dot={false} strokeWidth={1.25} />
                      ))}
                      {dayChart.trades.map((t, i) => {
                        const entryBar = dayChart.bars.find((b) => b.ts === t.entryTs);
                        const exitBar = dayChart.bars.find((b) => b.ts === t.exitTs);
                        return [
                          entryBar && <ReferenceDot key={`e${i}`} x={fmtClock(entryBar.ts)} y={entryBar.close}
                            r={5} fill={t.direction === "long" ? "#10b981" : "#ef4444"} stroke="none" />,
                          exitBar && <ReferenceDot key={`x${i}`} x={fmtClock(exitBar.ts)} y={exitBar.close}
                            r={5} fill="none" stroke={t.pctReturn >= 0 ? "#10b981" : "#ef4444"} strokeWidth={2} />,
                        ];
                      })}
                    </ComposedChart>
                  </ResponsiveContainer>
                  <div className={`text-[11px] mt-1 ${faint}`}>Filled dot = entry (green long / red short). Ring = exit (green win / red loss).</div>
                </>
              )}
            </div>

            {/* Full trade log */}
            <div className={`${card} rounded-lg p-3`}>
              <div className={`${heading} mb-2`}>Full trade log ({result.trades.length})</div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-white dark:bg-zinc-900">
                    <tr className={`text-left ${faint} border-b border-zinc-200 dark:border-zinc-800`}>
                      <th className="py-1 pr-2">Date</th>
                      <th className="py-1 pr-2">Dir</th>
                      <th className="py-1 pr-2">Entry</th>
                      <th className="py-1 pr-2">Exit</th>
                      <th className="py-1 pr-2">Return</th>
                      <th className="py-1 pr-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer"
                        onClick={() => viewDay(t.sessionDate)}>
                        <td className="py-1 pr-2">{t.sessionDate}</td>
                        <td className={`py-1 pr-2 ${t.direction === "long" ? "text-emerald-600" : "text-red-600"}`}>{t.direction}</td>
                        <td className="py-1 pr-2">{fmtClock(t.entryTs)} @ {t.entryPrice}</td>
                        <td className="py-1 pr-2">{fmtClock(t.exitTs)} @ {t.exitPrice}</td>
                        <td className={`py-1 pr-2 ${t.pctReturn >= 0 ? "text-emerald-600" : "text-red-600"}`}>{t.pctReturn}%</td>
                        <td className={`py-1 pr-2 ${faint}`}>{t.exitReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
