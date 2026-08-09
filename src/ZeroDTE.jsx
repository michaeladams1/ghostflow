// SPY 0DTE — the end-of-day debrief. Run it after the close and it replays
// the session through the Edge Lens v4 scoring rules, shows every signal on
// an interactive chart with the levels that mattered, and walks you through
// what the playbook says you should have done — step by step, with the real
// option contract and its real bracket-order outcome.
//
// Separate from both the trade-analysis system and Strategy Lab: this one is
// a LEARNING tool, built to be read, not configured.
import { useState } from "react";
import { Zap, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceDot, ReferenceLine,
} from "recharts";

const card = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800";
const faint = "text-zinc-500 dark:text-zinc-500";
const heading = "text-[11px] uppercase tracking-wider font-mono text-zinc-500";

// Renders **bold** spans inside the deterministic story text.
function RichText({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**")
          ? <strong key={i} className="font-semibold text-zinc-900 dark:text-zinc-100">{p.slice(2, -2)}</strong>
          : <span key={i}>{p}</span>
      )}
    </>
  );
}

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

// Most recent weekday, as an ISO date — the default "today's session".
function lastWeekdayISO() {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

const TIER_STYLE = {
  "A+": { fill: "#10b981", label: "A+", ring: "#059669" },
  "A": { fill: "#60a5fa", label: "A", ring: "#3b82f6" },
  "RSI Extreme": { fill: "#a1a1aa", label: "RSI", ring: "#71717a" },
};

export default function ZeroDTE() {
  const [sessionDate, setSessionDate] = useState(lastWeekdayISO());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [data, setData] = useState(null);

  async function run() {
    setLoading(true); setErr(null); setData(null);
    try {
      const res = await fetch("/api/0dte/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "SPY", sessionDate }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  const rth = data?.bars?.filter((b) => b.inSession) || [];
  const chartData = rth.map((b) => ({ ...b, t: b.clock }));

  return (
    <div>
      {/* ---- Run bar ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <p className={`text-xs ${faint}`}>
            Pick a session and get the full debrief — every signal, the exact contract, and what the bracket order would have done.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className={`${heading} block mb-1`}>Session date</label>
            <input type="date" value={sessionDate} onChange={(e) => setSessionDate(e.target.value)}
              className="px-2.5 py-1.5 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900" />
          </div>
          <button onClick={run} disabled={loading}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 rounded-md">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
            {loading ? "Replaying session…" : "Run debrief"}
          </button>
        </div>
      </div>

      {err && (
        <div className="flex items-start gap-2 text-sm rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-3 py-2.5 mb-4">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <div>{err}</div>
        </div>
      )}

      {!data && !loading && !err && (
        <div className={`px-4 py-12 text-center text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 ${faint}`}>
          Nothing loaded yet. Pick a date and run the debrief.
        </div>
      )}

      {data && (
        <>
          {/* ---- Scoreboard ---- */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <StatCard label="Bias" value={data.story.bias}
              sub={data.gap.isGapUp ? "gap-up: calls blocked" : data.gap.isGapDn ? "gap-down: puts blocked" : "no gap block"} />
            <StatCard label="Signals fired" value={data.fires.length}
              sub={`${data.story.tradeableCount} with a tradeable level`} />
            <StatCard label="Winners" value={`${data.story.winCount} / ${data.story.tradeableCount}`} />
            <StatCard label="Day P&L (by the rules)"
              value={data.story.totalPnl >= 0 ? `+$${data.story.totalPnl.toFixed(2)}` : `-$${Math.abs(data.story.totalPnl).toFixed(2)}`}
              tone={data.story.totalPnl > 0 ? "good" : data.story.totalPnl < 0 ? "bad" : undefined} />
          </div>

          {/* ---- Chart ---- */}
          <div className={`${card} rounded-lg p-3 mb-5`}>
            <div className={`${heading} mb-2`}>SPY 1-min · levels + signals</div>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" opacity={0.25} />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={60} stroke="#71717a" />
                <YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} tick={{ fontSize: 10 }}
                  tickFormatter={(v) => v.toFixed(0)} stroke="#71717a" width={48} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v, n) => [typeof v === "number" ? v.toFixed(2) : v, n === "close" ? "SPY" : n.toUpperCase()]} />
                <Line type="monotone" dataKey="close" stroke="#10b981" dot={false} strokeWidth={1.6} name="close" />
                <Line type="monotone" dataKey="vwap" stroke="#60a5fa" dot={false} strokeWidth={1} strokeDasharray="4 3" name="vwap" />

                {data.levels.pdh && <ReferenceLine y={data.levels.pdh} stroke="#c084fc" strokeDasharray="5 4" label={{ value: "PDH", fontSize: 10, fill: "#c084fc", position: "right" }} />}
                {data.levels.pdl && <ReferenceLine y={data.levels.pdl} stroke="#c084fc" strokeDasharray="5 4" label={{ value: "PDL", fontSize: 10, fill: "#c084fc", position: "right" }} />}
                {data.levels.pmh && <ReferenceLine y={data.levels.pmh} stroke="#fbbf24" strokeDasharray="2 3" label={{ value: "PMH", fontSize: 10, fill: "#fbbf24", position: "right" }} />}
                {data.levels.pml && <ReferenceLine y={data.levels.pml} stroke="#fbbf24" strokeDasharray="2 3" label={{ value: "PML", fontSize: 10, fill: "#fbbf24", position: "right" }} />}

                {data.fires.map((f, i) => {
                  const s = TIER_STYLE[f.tier] || TIER_STYLE["RSI Extreme"];
                  return <ReferenceDot key={`f${i}`} x={f.clock} y={f.price} r={f.tier === "A+" ? 7 : 5}
                    fill={s.fill} stroke={s.ring} strokeWidth={2} isFront />;
                })}
              </ComposedChart>
            </ResponsiveContainer>
            <div className={`flex flex-wrap gap-3 mt-2 text-[11px] ${faint}`}>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1 align-middle" />A+ signal</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-400 mr-1 align-middle" />A-tier</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-zinc-400 mr-1 align-middle" />RSI Extreme (no level)</span>
              <span><span className="inline-block w-4 border-t border-dashed border-blue-400 mr-1 align-middle" />VWAP</span>
              <span><span className="inline-block w-4 border-t border-dashed border-purple-400 mr-1 align-middle" />PDH/PDL</span>
            </div>
          </div>

          {/* ---- The story ---- */}
          <div className="space-y-3">
            {data.story.lines.map((section, i) => {
              const f = section.fire;
              const t = f?.trade;
              const won = t?.ok && t.pctReturn > 0;
              const lost = t?.ok && t.pctReturn < 0;
              const accent = !f ? "border-zinc-200 dark:border-zinc-800"
                : won ? "border-emerald-400/60 dark:border-emerald-600/50"
                : lost ? "border-red-400/60 dark:border-red-600/50"
                : "border-zinc-300 dark:border-zinc-700";

              return (
                <div key={i} className={`bg-white dark:bg-zinc-900 border ${accent} rounded-lg p-4`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{section.heading}</div>
                    {t?.ok && (
                      <div className={`shrink-0 text-sm font-semibold ${won ? "text-emerald-600 dark:text-emerald-400" : lost ? "text-red-600 dark:text-red-400" : faint}`}>
                        {t.pctReturn > 0 ? "+" : ""}{t.pctReturn}%
                      </div>
                    )}
                  </div>

                  {section.body && (
                    <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      <RichText text={section.body} />
                    </p>
                  )}

                  {section.steps && (
                    <ol className="space-y-1.5 mt-1">
                      {section.steps.map((s, j) => (
                        <li key={j} className="flex gap-2.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                          <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono flex items-center justify-center text-zinc-500">
                            {String(j + 1).padStart(2, "0")}
                          </span>
                          <span><RichText text={s} /></span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>

          <p className={`text-[11px] mt-4 ${faint}`}>
            Retrospective simulation on real SPY consolidated (SIP) 1-min bars and real same-day option prices.
            Fills are modeled at bar closes with no slippage or commissions, so live results will differ.
          </p>
        </>
      )}
    </div>
  );
}
