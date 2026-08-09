// SPY 0DTE — the end-of-day debrief. Run it after the close and it replays
// the session through the Edge Lens v4 scoring rules, shows every signal on
// an interactive chart, and walks you through exactly what the playbook says
// you should have done — with the real contract and its real outcome.
//
// Built to be READ, not configured. Every trade gets a card showing the
// option's own price chart with a green up-arrow where you'd have bought and
// a red down-arrow where you'd have sold.
import { useState } from "react";
import {
  Zap, Loader2, AlertTriangle, ArrowUp, ArrowDown, Target, ShieldAlert, Clock, Hash,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceDot, ReferenceLine,
} from "recharts";

const card = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800";
const faint = "text-zinc-500 dark:text-zinc-500";
const heading = "text-[11px] uppercase tracking-wider font-mono text-zinc-500";

function RichText({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => p.startsWith("**") && p.endsWith("**")
    ? <strong key={i} className="font-semibold text-zinc-900 dark:text-zinc-100">{p.slice(2, -2)}</strong>
    : <span key={i}>{p}</span>)}</>;
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

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
function lastWeekdayISO() {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Custom chart markers: a fat arrow you can actually see at a glance.
function ArrowMarker({ cx, cy, dir }) {
  if (cx == null || cy == null) return null;
  const up = dir === "up";
  const color = up ? "#10b981" : "#ef4444";
  const y = up ? cy + 8 : cy - 8;      // sits below the buy, above the sell
  const tip = up ? y - 16 : y + 16;
  return (
    <g>
      <path d={`M ${cx} ${tip} L ${cx - 7} ${y} L ${cx + 7} ${y} Z`} fill={color} stroke="#fff" strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={2} />
    </g>
  );
}

// One row of the contract fact sheet.
function Fact({ icon: Icon, label, value, tone }) {
  const toneCls = tone === "good" ? "text-emerald-600 dark:text-emerald-400"
    : tone === "bad" ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="flex items-center gap-2 py-1.5">
      {Icon && <Icon size={13} className="text-zinc-400 shrink-0" />}
      <span className={`text-xs ${faint} w-28 shrink-0`}>{label}</span>
      <span className={`text-sm font-medium ${toneCls}`}>{value}</span>
    </div>
  );
}

// THE TRADE CARD — the piece that has to be unmistakable at a glance:
// what you bought, what you paid, when you got out, and what it made.
function TradeCard({ fire, contracts, pnl }) {
  const t = fire.trade;
  const won = t.pctReturn > 0;
  const isCall = fire.direction === "CALL";

  const series = (t.series || []).map((p) => ({
    ...p,
    entry: p.min === t.entryMin ? p.price : null,
    exit: p.min === t.exitMin ? p.price : null,
  }));

  return (
    <div className={`rounded-lg border-2 ${won ? "border-emerald-400 dark:border-emerald-700" : "border-red-400 dark:border-red-800"} bg-white dark:bg-zinc-900 overflow-hidden`}>
      {/* Banner */}
      <div className={`px-4 py-3 flex flex-wrap items-center justify-between gap-2 ${won ? "bg-emerald-50 dark:bg-emerald-950/40" : "bg-red-50 dark:bg-red-950/40"}`}>
        <div className="flex items-center gap-2.5">
          <span className={`text-xs font-mono px-2 py-0.5 rounded ${isCall ? "bg-emerald-600" : "bg-red-600"} text-white`}>
            {fire.tier} {fire.direction}
          </span>
          <span className="text-base font-bold text-zinc-900 dark:text-zinc-100">
            SPY ${t.strike}{isCall ? "C" : "P"}
          </span>
          <span className={`text-xs ${faint}`}>{t.contract}</span>
        </div>
        <div className={`text-xl font-bold ${won ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {t.pctReturn > 0 ? "+" : ""}{t.pctReturn}% · {money(pnl)}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 p-4">
        {/* ---- Left: the buy/sell fact sheet ---- */}
        <div>
          <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 mb-3">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center">
                <ArrowUp size={14} className="text-white" strokeWidth={3} />
              </div>
              <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">BOUGHT</span>
              <span className={`text-xs ${faint}`}>{t.entryClock}</span>
            </div>
            <div className="pl-8 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-semibold">{contracts}</span> contract{contracts === 1 ? "" : "s"} at{" "}
              <span className="font-semibold">${t.entryPrice.toFixed(2)}</span> each
              <span className={`${faint}`}> = {money(contracts * t.entryPrice * 100)} out of pocket</span>
            </div>
          </div>

          <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 p-3 mb-3">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-6 h-6 rounded-full bg-red-600 flex items-center justify-center">
                <ArrowDown size={14} className="text-white" strokeWidth={3} />
              </div>
              <span className="text-sm font-bold text-red-700 dark:text-red-400">SOLD</span>
              <span className={`text-xs ${faint}`}>{t.exitClock} · held {t.holdMinutes} min</span>
            </div>
            <div className="pl-8 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-semibold">{contracts}</span> contract{contracts === 1 ? "" : "s"} at{" "}
              <span className="font-semibold">${t.exitPrice.toFixed(2)}</span> each
              <span className={`${faint}`}> = {money(contracts * t.exitPrice * 100)} back</span>
            </div>
            <div className="pl-8 text-xs mt-1 font-medium text-zinc-600 dark:text-zinc-400">{t.exitReason}</div>
          </div>

          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2">
            <Fact icon={Hash} label="Underlying level" value={`$${fire.level} (SPY was $${fire.price.toFixed(2)})`} />
            <Fact icon={Target} label="Take profit" value={`$${t.tpPrice.toFixed(2)} (+20%)`} tone="good" />
            <Fact icon={ShieldAlert} label="Stop loss" value={`$${t.slPrice.toFixed(2)} (-12.5%)`} tone="bad" />
            <Fact icon={Clock} label="RSI at entry" value={`${fire.rsi} ${fire.direction === "PUT" ? "(overbought)" : "(oversold)"}`} />
            {fire.points != null && <Fact label="Setup score" value={`${fire.points} / 20 points`} />}
            {fire.size && <Fact label="Playbook size" value={fire.size} />}
          </div>
        </div>

        {/* ---- Right: the OPTION's own price chart with buy/sell arrows ---- */}
        <div>
          <div className={`${heading} mb-2`}>The option's price · ${t.strike}{isCall ? "C" : "P"}</div>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={series} margin={{ top: 20, right: 10, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" opacity={0.2} />
              <XAxis dataKey="clock" tick={{ fontSize: 9 }} minTickGap={40} stroke="#71717a" />
              <YAxis tick={{ fontSize: 9 }} width={44} stroke="#71717a"
                domain={["dataMin - 0.05", "dataMax + 0.05"]} tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(v) => [`$${Number(v).toFixed(2)}`, "Option price"]} />
              <ReferenceLine y={t.tpPrice} stroke="#10b981" strokeDasharray="4 3"
                label={{ value: "TP +20%", fontSize: 9, fill: "#10b981", position: "insideTopRight" }} />
              <ReferenceLine y={t.slPrice} stroke="#ef4444" strokeDasharray="4 3"
                label={{ value: "SL -12.5%", fontSize: 9, fill: "#ef4444", position: "insideBottomRight" }} />
              <Line type="monotone" dataKey="price" stroke="#71717a" dot={false} strokeWidth={1.8} />
              <Line dataKey="entry" stroke="none" isAnimationActive={false}
                dot={(p) => (p.value == null ? null : <ArrowMarker key={`e${p.index}`} cx={p.cx} cy={p.cy} dir="up" />)} />
              <Line dataKey="exit" stroke="none" isAnimationActive={false}
                dot={(p) => (p.value == null ? null : <ArrowMarker key={`x${p.index}`} cx={p.cx} cy={p.cy} dir="down" />)} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className={`flex gap-4 mt-1 text-[11px] ${faint}`}>
            <span className="flex items-center gap-1"><ArrowUp size={11} className="text-emerald-500" strokeWidth={3} /> bought here</span>
            <span className="flex items-center gap-1"><ArrowDown size={11} className="text-red-500" strokeWidth={3} /> sold here</span>
          </div>
        </div>
      </div>

      {/* ---- The walkthrough ---- */}
      <div className="px-4 pb-4">
        <details className="group">
          <summary className={`cursor-pointer text-xs font-medium ${faint} hover:text-zinc-700 dark:hover:text-zinc-300 select-none`}>
            Show the step-by-step reasoning ▾
          </summary>
          <ol className="space-y-1.5 mt-3">
            {(fire.steps || []).map((s, j) => (
              <li key={j} className="flex gap-2.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono flex items-center justify-center text-zinc-500">
                  {String(j + 1).padStart(2, "0")}
                </span>
                <span><RichText text={s} /></span>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </div>
  );
}

const TIER_STYLE = {
  "A+": { fill: "#10b981", ring: "#059669" },
  "A": { fill: "#60a5fa", ring: "#3b82f6" },
  "RSI Extreme": { fill: "#a1a1aa", ring: "#71717a" },
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
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "SPY", sessionDate }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }

  const rth = data?.bars?.filter((b) => b.inSession) || [];
  const chartData = rth.map((b) => ({ ...b, t: b.clock }));
  const trades = (data?.fires || []).filter((f) => f.level && f.trade?.ok);
  const contractsFor = (f) => {
    const dollars = Number(String(f.size || "250").replace(/[^0-9.]/g, "")) || 250;
    return Math.max(1, Math.floor(dollars / (f.trade.entryPrice * 100)));
  };
  // Story sections that aren't per-trade (setup, bias, no-trade notes, bottom line).
  const narrative = (data?.story?.lines || []).filter((s) => !s.fire);
  // Attach the story's steps back onto each trade for the expandable walkthrough.
  const stepsByClock = Object.fromEntries((data?.story?.lines || []).filter((s) => s.fire).map((s) => [s.fire.clock + s.fire.direction, s.steps]));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <p className={`text-xs ${faint} max-w-lg`}>
          Pick a session and get the full debrief — every signal, the exact contract, and what the bracket order would have done.
        </p>
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <StatCard label="Bias" value={data.story.bias}
              sub={data.gap.isGapUp ? "gap-up: calls blocked" : data.gap.isGapDn ? "gap-down: puts blocked" : "no gap block"} />
            <StatCard label="Signals fired" value={data.fires.length} sub={`${data.story.tradeableCount} tradeable`} />
            <StatCard label="Winners" value={`${data.story.winCount} / ${data.story.tradeableCount}`} />
            <StatCard label="Day P&L" value={money(data.story.totalPnl)}
              tone={data.story.totalPnl > 0 ? "good" : data.story.totalPnl < 0 ? "bad" : undefined}
              sub="following the rules exactly" />
          </div>

          {/* ---- The trades, front and center ---- */}
          {trades.length > 0 && (
            <div className="space-y-4 mb-5">
              <div className={`${heading}`}>The trades — {trades.length} tradeable setup{trades.length === 1 ? "" : "s"}</div>
              {trades.map((f, i) => {
                const c = contractsFor(f);
                const pnl = c * (f.trade.exitPrice - f.trade.entryPrice) * 100;
                return <TradeCard key={i} fire={{ ...f, steps: stepsByClock[f.clock + f.direction] }} contracts={c} pnl={pnl} />;
              })}
            </div>
          )}

          {/* ---- The underlying, with every signal marked ---- */}
          <div className={`${card} rounded-lg p-3 mb-5`}>
            <div className={`${heading} mb-2`}>SPY 1-min · levels + every signal</div>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" opacity={0.25} />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={60} stroke="#71717a" />
                <YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} tick={{ fontSize: 10 }}
                  tickFormatter={(v) => v.toFixed(0)} stroke="#71717a" width={48} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v, n) => [typeof v === "number" ? v.toFixed(2) : v, n === "close" ? "SPY" : n.toUpperCase()]} />
                <Line type="monotone" dataKey="close" stroke="#10b981" dot={false} strokeWidth={1.6} name="close" />
                <Line type="monotone" dataKey="vwap" stroke="#60a5fa" dot={false} strokeWidth={1} strokeDasharray="4 3" name="vwap" />

                {data.levels.pdh && <ReferenceLine y={data.levels.pdh} stroke="#c084fc" strokeDasharray="5 4" label={{ value: "PDH", fontSize: 10, fill: "#c084fc", position: "right" }} />}
                {data.levels.pdl && <ReferenceLine y={data.levels.pdl} stroke="#c084fc" strokeDasharray="5 4" label={{ value: "PDL", fontSize: 10, fill: "#c084fc", position: "right" }} />}
                {data.levels.pmh && <ReferenceLine y={data.levels.pmh} stroke="#fbbf24" strokeDasharray="2 3" label={{ value: "PMH", fontSize: 10, fill: "#fbbf24", position: "right" }} />}
                {data.levels.pml && <ReferenceLine y={data.levels.pml} stroke="#fbbf24" strokeDasharray="2 3" label={{ value: "PML", fontSize: 10, fill: "#fbbf24", position: "right" }} />}

                {data.fires.map((f, i) => {
                  const s = TIER_STYLE[f.tier] || TIER_STYLE["RSI Extreme"];
                  const traded = f.level && f.trade?.ok;
                  return <ReferenceDot key={`f${i}`} x={f.clock} y={f.price} r={traded ? 7 : 4}
                    fill={s.fill} stroke={traded ? "#18181b" : s.ring} strokeWidth={traded ? 2.5 : 1.5} isFront
                    label={traded ? { value: f.direction === "CALL" ? "▲ BUY CALL" : "▲ BUY PUT", fontSize: 10, fill: s.fill, position: f.direction === "CALL" ? "bottom" : "top" } : undefined} />;
                })}
              </ComposedChart>
            </ResponsiveContainer>
            <div className={`flex flex-wrap gap-3 mt-2 text-[11px] ${faint}`}>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1 align-middle" />A+ signal</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-400 mr-1 align-middle" />A-tier</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-zinc-400 mr-1 align-middle" />RSI Extreme (no level, not tradeable)</span>
              <span><span className="inline-block w-4 border-t border-dashed border-blue-400 mr-1 align-middle" />VWAP</span>
              <span><span className="inline-block w-4 border-t border-dashed border-purple-400 mr-1 align-middle" />PDH/PDL</span>
            </div>
          </div>

          {/* ---- Context + no-trade notes ---- */}
          <div className="space-y-3">
            {narrative.map((section, i) => (
              <div key={i} className={`${card} rounded-lg p-4`}>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">{section.heading}</div>
                {section.body && (
                  <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    <RichText text={section.body} />
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className={`text-[11px] mt-4 ${faint}`}>
            Retrospective simulation on real SPY consolidated (SIP) 1-min bars and real same-day option prices.
            Take-profits fill at the limit price; stops are modeled at the worse of the stop price and the bar close.
            No commissions or bid/ask spread — live results will be worse.
          </p>
        </>
      )}
    </div>
  );
}
