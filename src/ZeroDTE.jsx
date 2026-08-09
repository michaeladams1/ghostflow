// SPY 0DTE — the end-of-day debrief. Run it after the close and it replays
// the session through the Edge Lens v4 scoring rules, shows every signal on
// an interactive chart, and walks you through exactly what the playbook says
// you should have done — with the real contract and its real outcome.
//
// Built to be READ, not configured. Every trade gets a card showing the
// option's own price chart with a green up-arrow where you'd have bought and
// a red down-arrow where you'd have sold.
import { useState, useEffect } from "react";
import {
  Zap, Loader2, AlertTriangle, ArrowUp, ArrowDown, Target, ShieldAlert, Clock, Hash, CalendarDays, FlaskConical, BookOpenCheck,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceDot, ReferenceLine, ReferenceArea,
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

// Playbook trade window (Shen Lao section 09): 9:45–11:15 AM ET.
const PB_OPEN_MIN = 585, PB_CLOSE_MIN = 675;
// Edge Lens "Core Window": 6:30–9:30 PST = 9:30 AM–12:30 PM ET.
const CORE_OPEN_MIN = 570, CORE_CLOSE_MIN = 750;

// Out-of-hours gray + core-window teal bands for a chart whose x-axis is
// clock-label categories. `pts` must carry {min, <xKey>}.
function windowAreas(pts, xKey) {
  if (!pts.length) return [];
  const clockFor = (m) => (pts.find((p) => p.min >= m) || pts[pts.length - 1])[xKey];
  const first = pts[0], last = pts[pts.length - 1];
  const areas = [];
  if (first.min < PB_OPEN_MIN) areas.push(
    <ReferenceArea key="gray-pre" x1={first[xKey]} x2={clockFor(PB_OPEN_MIN)} fill="#71717a" fillOpacity={0.10} strokeOpacity={0} />);
  if (last.min > PB_CLOSE_MIN) areas.push(
    <ReferenceArea key="gray-post" x1={clockFor(PB_CLOSE_MIN)} x2={last[xKey]} fill="#71717a" fillOpacity={0.10} strokeOpacity={0} />);
  if (last.min > CORE_OPEN_MIN && first.min < CORE_CLOSE_MIN) areas.push(
    <ReferenceArea key="teal-core" x1={clockFor(Math.max(CORE_OPEN_MIN, first.min))} x2={clockFor(Math.min(CORE_CLOSE_MIN, last.min))}
      fill="#14b8a6" fillOpacity={0.05} strokeOpacity={0} />);
  return areas;
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

  // ZOOM vs FULL DAY. A 4-minute trade on a full-day axis is 4 pixels wide
  // and the day's range crushes the trade zone flat — so the DEFAULT view is
  // zoomed to the trade window (30 min before entry -> 15 after exit), where
  // the y-axis auto-fits the prices that actually matter.
  const [view, setView] = useState("zoom");
  const zoomFrom = t.entryMin - 30, zoomTo = t.exitMin + 15;
  const series = (t.series || []).filter((p) => view === "day" || (p.min >= zoomFrom && p.min <= zoomTo));

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
          {fire.window !== "in" && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500 text-white">
              ⏰ OUTSIDE PLAYBOOK HOURS · NOT COUNTED
            </span>
          )}
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
          <div className="flex items-center justify-between mb-2">
            <div className={heading}>The option's price · ${t.strike}{isCall ? "C" : "P"}</div>
            <div className="flex rounded-md border border-zinc-300 dark:border-zinc-700 overflow-hidden text-[11px] font-medium">
              <button onClick={() => setView("zoom")}
                className={`px-2.5 py-1 ${view === "zoom" ? "bg-emerald-600 text-white" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
                Trade window
              </button>
              <button onClick={() => setView("day")}
                className={`px-2.5 py-1 ${view === "day" ? "bg-emerald-600 text-white" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
                Full day
              </button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <ComposedChart data={series} margin={{ top: 24, right: 58, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" opacity={0.2} />
              <XAxis dataKey="clock" tick={{ fontSize: 9 }} minTickGap={40} stroke="#71717a" />
              <YAxis tick={{ fontSize: 9 }} width={52} stroke="#71717a"
                domain={["dataMin - 0.03", "dataMax + 0.03"]} tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(v) => [`$${Number(v).toFixed(2)}`, "Option price"]} />
              {windowAreas(series, "clock")}
              {/* Vertical time markers survive any zoom level; the dots and
                  price labels only get room in the zoomed view. */}
              <ReferenceLine x={t.entryClock} stroke="#10b981" strokeWidth={1.5} strokeDasharray="3 3"
                label={{ value: `▲ BOUGHT $${t.entryPrice.toFixed(2)} · ${t.entryClock.replace(" ET", "")}`, fontSize: 10, fontWeight: 700, fill: "#10b981", position: "insideTopLeft" }} />
              <ReferenceLine x={t.exitClock} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="3 3"
                label={{ value: `▼ SOLD $${t.exitPrice.toFixed(2)} · ${t.exitClock.replace(" ET", "")}`, fontSize: 10, fontWeight: 700, fill: "#ef4444", position: "insideTopRight", dy: 16 }} />
              {view === "zoom" && (
                <>
                  <ReferenceLine y={t.tpPrice} stroke="#10b981" strokeDasharray="4 3"
                    label={{ value: `take profit $${t.tpPrice.toFixed(2)}`, fontSize: 9, fill: "#10b981", position: "insideBottomLeft" }} />
                  <ReferenceLine y={t.slPrice} stroke="#ef4444" strokeDasharray="4 3"
                    label={{ value: `stop loss $${t.slPrice.toFixed(2)}`, fontSize: 9, fill: "#ef4444", position: "insideBottomLeft" }} />
                </>
              )}
              <Line type="monotone" dataKey="price" stroke="#71717a" dot={false} strokeWidth={1.8} />
              <ReferenceDot x={t.entryClock} y={t.entryPrice} r={6} fill="#10b981" stroke="#fff" strokeWidth={2.5} isFront />
              <ReferenceDot x={t.exitClock} y={t.exitPrice} r={6} fill="#ef4444" stroke="#fff" strokeWidth={2.5} isFront />
            </ComposedChart>
          </ResponsiveContainer>
          <div className={`flex gap-4 mt-1 text-[11px] ${faint}`}>
            <span className="flex items-center gap-1"><ArrowUp size={11} className="text-emerald-500" strokeWidth={3} /> bought here</span>
            <span className="flex items-center gap-1"><ArrowDown size={11} className="text-red-500" strokeWidth={3} /> sold here</span>
            {view === "zoom" && <span>showing {Math.round(zoomTo - zoomFrom)} min around the trade</span>}
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
  const [showCalendar, setShowCalendar] = useState(false);
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
    const dollars = Number(String(f.size || "1000").replace(/[^0-9.]/g, "")) || 250;
    return Math.max(1, Math.floor(dollars / (f.trade.entryPrice * 100)));
  };
  // Story sections that aren't per-trade (setup, bias, no-trade notes, bottom line).
  const narrative = (data?.story?.lines || []).filter((s) => !s.fire);
  // Attach the story's steps back onto each trade for the expandable walkthrough.
  const stepsByClock = Object.fromEntries((data?.story?.lines || []).filter((s) => s.fire).map((s) => [s.fire.clock + s.fire.direction, s.steps]));

  if (showCalendar) return <CalendarView onBack={() => setShowCalendar(false)} />;

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
          <button onClick={() => setShowCalendar(true)}
            className="flex items-center gap-1.5 border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-sm font-medium px-3 py-1.5 rounded-md">
            <CalendarDays size={16} /> Historical calendar
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
            <StatCard label="Winners" value={`${data.story.winCount} / ${data.story.countedCount ?? data.story.tradeableCount}`}
              sub="inside playbook hours" />
            <StatCard label="Day P&L" value={money(data.story.totalPnl)}
              tone={data.story.totalPnl > 0 ? "good" : data.story.totalPnl < 0 ? "bad" : undefined}
              sub={data.story.excludedCount ? `playbook hours only · ${data.story.excludedCount} trade${data.story.excludedCount === 1 ? "" : "s"} outside hours excluded (${money(data.story.excludedPnl)})` : "playbook hours (9:45–11:15 ET) only"} />
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
            <ResponsiveContainer width="100%" height={330}>
              <ComposedChart data={chartData} margin={{ top: 14, right: 62, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" opacity={0.25} />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={60} stroke="#71717a" />
                <YAxis domain={["dataMin - 0.6", "dataMax + 0.6"]} tick={{ fontSize: 10 }}
                  tickFormatter={(v) => v.toFixed(2)} stroke="#71717a" width={56} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v, n) => [typeof v === "number" ? v.toFixed(2) : v, n === "close" ? "SPY" : n.toUpperCase()]} />
                {windowAreas(chartData, "t")}
                <Line type="monotone" dataKey="close" stroke="#10b981" dot={false} strokeWidth={1.6} name="close" />
                <Line type="monotone" dataKey="vwap" stroke="#60a5fa" dot={false} strokeWidth={1} strokeDasharray="4 3" name="vwap" />

                {/* Level labels sit INSIDE the plot area — `position:"right"`
                    pushed them past the SVG edge and they were clipped. */}
                {data.levels.pdh && <ReferenceLine y={data.levels.pdh} stroke="#c084fc" strokeDasharray="5 4"
                  label={{ value: `PDH ${data.levels.pdh.toFixed(2)}`, fontSize: 10, fill: "#c084fc", position: "insideTopRight" }} />}
                {data.levels.pdl && <ReferenceLine y={data.levels.pdl} stroke="#c084fc" strokeDasharray="5 4"
                  label={{ value: `PDL ${data.levels.pdl.toFixed(2)}`, fontSize: 10, fill: "#c084fc", position: "insideBottomRight" }} />}
                {data.levels.pmh && <ReferenceLine y={data.levels.pmh} stroke="#fbbf24" strokeDasharray="2 3"
                  label={{ value: `PMH ${data.levels.pmh.toFixed(2)}`, fontSize: 10, fill: "#fbbf24", position: "insideTopLeft" }} />}
                {data.levels.pml && <ReferenceLine y={data.levels.pml} stroke="#fbbf24" strokeDasharray="2 3"
                  label={{ value: `PML ${data.levels.pml.toFixed(2)}`, fontSize: 10, fill: "#fbbf24", position: "insideBottomLeft" }} />}

                {data.fires.map((f, i) => {
                  const s = TIER_STYLE[f.tier] || TIER_STYLE["RSI Extreme"];
                  const traded = f.level && f.trade?.ok;
                  return <ReferenceDot key={`f${i}`} x={f.clock} y={f.price} r={traded ? 7 : 4}
                    fill={s.fill} stroke={traded ? "#18181b" : s.ring} strokeWidth={traded ? 2.5 : 1.5} isFront />;
                })}
                {/* Entry/exit for each executed trade, as vertical time lines
                    + dots at SPY's price at those minutes — readable at any
                    density, unlike point labels that pile up. NOTE: flat
                    array, not <g>/<Fragment> wrappers — recharts only
                    renders recognized chart children. */}
                {trades.flatMap((f, i) => {
                  const entryBar = chartData.find((b) => b.clock === f.trade.entryClock);
                  const exitBar = chartData.find((b) => b.clock === f.trade.exitClock);
                  return [
                    <ReferenceLine key={`in${i}`} x={f.trade.entryClock} stroke="#10b981" strokeWidth={1.5} strokeDasharray="3 3"
                      label={{ value: `▲ IN ${f.trade.entryClock.replace(" ET", "")}`, fontSize: 10, fontWeight: 700, fill: "#10b981", position: "insideTopLeft" }} />,
                    <ReferenceLine key={`out${i}`} x={f.trade.exitClock} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="3 3"
                      label={{ value: `▼ OUT ${f.trade.exitClock.replace(" ET", "")}`, fontSize: 10, fontWeight: 700, fill: "#ef4444", position: "insideBottomRight" }} />,
                    entryBar && <ReferenceDot key={`ind${i}`} x={f.trade.entryClock} y={entryBar.close} r={6} fill="#10b981" stroke="#fff" strokeWidth={2} isFront />,
                    exitBar && <ReferenceDot key={`outd${i}`} x={f.trade.exitClock} y={exitBar.close} r={6} fill="#ef4444" stroke="#fff" strokeWidth={2} isFront />,
                  ].filter(Boolean);
                })}
              </ComposedChart>
            </ResponsiveContainer>

            {/* ---- RSI panel, sharing the same x-axis ---- */}
            <div className={`${heading} mt-3 mb-1`}>RSI (1-min) · 73 = puts zone · 29 = calls zone</div>
            <ResponsiveContainer width="100%" height={140}>
              <ComposedChart data={chartData} margin={{ top: 6, right: 62, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" opacity={0.25} />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={60} stroke="#71717a" />
                <YAxis domain={[0, 100]} ticks={[0, 29, 50, 73, 100]} tick={{ fontSize: 10 }} stroke="#71717a" width={56} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v) => [typeof v === "number" ? v.toFixed(1) : v, "RSI"]} />
                {windowAreas(chartData, "t")}
                <ReferenceLine y={73} stroke="#ef4444" strokeDasharray="4 3"
                  label={{ value: "73 overbought", fontSize: 9, fill: "#ef4444", position: "insideTopRight" }} />
                <ReferenceLine y={29} stroke="#10b981" strokeDasharray="4 3"
                  label={{ value: "29 oversold", fontSize: 9, fill: "#10b981", position: "insideBottomRight" }} />
                <ReferenceLine y={50} stroke="#71717a" strokeDasharray="2 4" opacity={0.5} />
                <Line type="monotone" dataKey="rsi" stroke="#a78bfa" dot={false} strokeWidth={1.5} name="rsi" />
                {data.fires.filter((f) => f.level && f.trade?.ok).map((f, i) => (
                  <ReferenceDot key={`r${i}`} x={f.clock} y={f.rsi} r={5} fill={f.direction === "CALL" ? "#10b981" : "#ef4444"}
                    stroke="#18181b" strokeWidth={2} isFront />
                ))}
              </ComposedChart>
            </ResponsiveContainer>

            <div className={`flex flex-wrap gap-3 mt-2 text-[11px] ${faint}`}>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1 align-middle" />A+ signal</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-400 mr-1 align-middle" />A-tier</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-zinc-400 mr-1 align-middle" />RSI Extreme (no level, not tradeable)</span>
              <span><span className="inline-block w-4 border-t border-dashed border-blue-400 mr-1 align-middle" />VWAP</span>
              <span><span className="inline-block w-4 border-t border-dashed border-purple-400 mr-1 align-middle" />PDH/PDL</span>
              <span><span className="inline-block w-4 border-t border-dashed border-amber-400 mr-1 align-middle" />PMH/PML</span>
              <span><span className="inline-block w-3 h-3 bg-zinc-400/30 mr-1 align-middle" />outside playbook hours (9:45–11:15 ET)</span>
              <span><span className="inline-block w-3 h-3 bg-teal-400/20 mr-1 align-middle" />Edge Lens core window</span>
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
// ===========================================================================
// HISTORICAL CALENDAR — simulates a whole month and renders it like a
// trading-journal P&L calendar: green/red day boxes (rounded, thin white
// gaps), monthly net cards, and a stats sidebar (win rate donut, totals,
// best/worst day & trade). Day P&L counts playbook-hours trades only;
// out-of-hours simulations roll up into their own amber total.
// ===========================================================================
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function WinRateDonut({ rate }) {
  const r = 26, c = 2 * Math.PI * r;
  const frac = rate != null ? Math.min(Math.max(rate / 100, 0), 1) : 0;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r={r} fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="8" />
      <circle cx="34" cy="34" r={r} fill="none" stroke="#6366f1" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 34 34)" />
    </svg>
  );
}

function PerfBar({ label, value, maxAbs, tone }) {
  const pct = maxAbs ? Math.min(Math.abs(value) / maxAbs, 1) * 100 : 0;
  const good = tone === "good";
  return (
    <div className="mb-2.5">
      <div className="flex items-center justify-between text-sm mb-1">
        <span className={faint}>{label}</span>
        <span className={`font-bold ${good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {value != null ? money(value) : "—"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
        <div className={`h-full rounded-full ${good ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DayBox({ dayNum, data, ghost }) {
  if (ghost) return (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900/40 min-h-[86px] p-2">
      <div className={`text-sm ${faint} opacity-50`}>{dayNum}</div>
    </div>
  );
  const traded = data && (data.trades || 0) > 0;
  const exclOnly = data && !traded && (data.excludedTrades || 0) > 0;
  const pos = traded && data.pnl > 0, neg = traded && data.pnl < 0;
  const cls = pos ? "bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800"
    : neg ? "bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800"
    : exclOnly ? "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900"
    : "bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800";
  return (
    <div className={`rounded-lg min-h-[86px] p-2 text-center ${cls}`}>
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{dayNum}</div>
      {traded && (
        <>
          <div className={`text-sm font-bold ${pos ? "text-emerald-600 dark:text-emerald-400" : neg ? "text-red-600 dark:text-red-400" : "text-zinc-600"}`}>
            {data.pnl > 0 ? "+" : ""}{money(data.pnl)}
          </div>
          <div className={`text-[11px] ${faint}`}>{data.trades} trade{data.trades === 1 ? "" : "s"}</div>
        </>
      )}
      {exclOnly && (
        <>
          <div className="text-xs font-semibold text-amber-600 dark:text-amber-500">
            {data.excludedPnl > 0 ? "+" : ""}{money(data.excludedPnl)}
          </div>
          <div className="text-[10px] text-amber-600/80 dark:text-amber-500/80">outside hrs</div>
        </>
      )}
    </div>
  );
}

function CalendarView({ onBack }) {
  const now = new Date();
  const [ym, setYm] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [loading, setLoading] = useState(false);
  const [bulkRun, setBulkRun] = useState(null);
  const [err, setErr] = useState(null);
  const [data, setData] = useState(null);

  async function requestMonth(year, month) {
    const res = await fetch("/api/0dte/month", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "SPY", year, month }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function load(y, m) {
    setLoading(true); setErr(null);
    try { setData(await requestMonth(y, m)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function runLast24Months() {
    setErr(null);
    const months = [];
    for (let offset = 23; offset >= 0; offset--) {
      const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - offset, 1));
      months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    }

    setBulkRun({ completed: 0, total: months.length, current: months[0] });
    try {
      for (let i = 0; i < months.length; i++) {
        const current = months[i];
        setBulkRun({ completed: i, total: months.length, current });
        await requestMonth(current.year, current.month);
        setBulkRun({ completed: i + 1, total: months.length, current });
      }
      setData(await requestMonth(ym.year, ym.month));
    } catch (e) {
      setErr(`24-month backtest stopped: ${e.message}. Click the button to safely resume.`);
    } finally {
      setBulkRun(null);
    }
  }
  // Load on first render and whenever the month changes.
  useEffect(() => { load(ym.year, ym.month); }, [ym.year, ym.month]);

  const nav = (delta) => {
    let { year, month } = ym;
    month += delta;
    if (month < 1) { month = 12; year--; }
    if (month > 12) { month = 1; year++; }
    if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1)) return;
    setYm({ year, month });
  };

  // Grid scaffolding: leading ghosts from the previous month, then real days.
  const firstDow = new Date(Date.UTC(ym.year, ym.month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
  const prevMonthDays = new Date(Date.UTC(ym.year, ym.month - 1, 0)).getUTCDate();
  const byDate = Object.fromEntries((data?.days || []).map((d) => [Number(d.date.slice(8, 10)), d]));
  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) cells.push({ ghost: true, dayNum: prevMonthDays - i });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ dayNum: d, data: byDate[d] });
  while (cells.length % 7 !== 0) cells.push({ ghost: true, dayNum: cells.length - (firstDow + daysInMonth) + 1 });

  const t = data?.totals;
  const maxDay = t ? Math.max(Math.abs(t.bestDay ?? 0), Math.abs(t.worstDay ?? 0)) : 0;
  const maxTrade = t ? Math.max(Math.abs(t.bestTrade ?? 0), Math.abs(t.worstTrade ?? 0)) : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className={`text-sm ${faint} hover:text-zinc-800 dark:hover:text-zinc-200`}>
          ← Back to daily debrief
        </button>
        <div className="flex rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-1 text-sm">
          {["Week", "Month", "Year", "All Time"].map((m) => (
            <button key={m} disabled={m !== "Month"} title={m !== "Month" ? "Coming soon" : undefined}
              className={`px-4 py-1.5 rounded-full font-medium ${m === "Month" ? "bg-emerald-600 text-white" : `${faint} cursor-not-allowed`}`}>
              {m}
            </button>
          ))}
        </div>
        <div className="w-56 flex justify-end">
          <button onClick={runLast24Months} disabled={loading || !!bulkRun}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white px-3 py-2 text-xs font-semibold flex items-center gap-2">
            {bulkRun ? <Loader2 size={14} className="animate-spin" /> : <CalendarDays size={14} />}
            {bulkRun
              ? `${bulkRun.completed}/${bulkRun.total} · ${MONTH_NAMES[bulkRun.current.month - 1]} ${bulkRun.current.year}`
              : "Backtest last 24 months"}
          </button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 text-white p-5 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><Zap size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-100">Monthly net total · playbook hours</div>
            <div className="text-3xl font-bold">{t ? (t.pnl >= 0 ? "+" : "") + money(t.pnl) : "—"}</div>
          </div>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 text-white p-5 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><Clock size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-100">Outside-hours signals · not counted</div>
            <div className="text-3xl font-bold">{t ? (t.excludedPnl >= 0 ? "+" : "") + money(t.excludedPnl) : "—"}</div>
          </div>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 text-white p-5 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><FlaskConical size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-100">Research lanes · paper only</div>
            <div className="text-3xl font-bold">{t ? (t.experimentalPnl >= 0 ? "+" : "") + money(t.experimentalPnl) : "—"}</div>
            <div className="text-xs text-indigo-100">{t?.experimentalTrades || 0} trades · {t?.experimentalWinRate != null ? `${t.experimentalWinRate}% wins` : "no sample yet"}</div>
          </div>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-sky-600 to-cyan-700 text-white p-5 flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><BookOpenCheck size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-sky-100">Shen conviction · paper only</div>
            <div className="text-3xl font-bold">{t ? (t.shenPnl >= 0 ? "+" : "") + money(t.shenPnl) : "—"}</div>
            <div className="text-xs text-sky-100">{t?.shenTrades || 0} trades · {t?.shenWinRate != null ? `${t.shenWinRate}% wins` : "no sample yet"}</div>
          </div>
        </div>
      </div>

      <div className={`${card} rounded-xl px-4 py-3 mb-4 flex items-center justify-center gap-6`}>
        <button onClick={() => nav(-1)} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">‹</button>
        <div className="font-semibold text-zinc-900 dark:text-zinc-100">{MONTH_NAMES[ym.month - 1]} {ym.year}</div>
        <button onClick={() => nav(1)} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">›</button>
      </div>

      {err && (
        <div className="flex items-start gap-2 text-sm rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-3 py-2.5 mb-4">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <div>{err}</div>
        </div>
      )}
      {loading && (
        <div className={`flex items-center gap-2 text-sm px-4 py-10 justify-center ${faint}`}>
          <Loader2 size={16} className="animate-spin" />
          Simulating every session in {MONTH_NAMES[ym.month - 1]}… first run takes a few minutes, then it's cached.
        </div>
      )}

      {bulkRun && (
        <div className={`${card} rounded-lg px-4 py-3 mb-4`}>
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200">Building the 24-month history</span>
            <span className={faint}>{bulkRun.completed} of {bulkRun.total} months saved</span>
          </div>
          <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all"
              style={{ width: `${(bulkRun.completed / bulkRun.total) * 100}%` }} />
          </div>
          <div className={`text-[11px] mt-2 ${faint}`}>
            Keep this page open while it runs. Completed months remain saved, so rerunning is safe if the connection stops.
          </div>
        </div>
      )}

      {!loading && data && (
        <div className="grid lg:grid-cols-[1fr_300px] gap-5">
          <div>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => (
                <div key={d} className={`text-center text-xs font-semibold py-2 rounded bg-zinc-100 dark:bg-zinc-800/60 ${faint}`}>{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((c, i) => <DayBox key={i} dayNum={c.dayNum} data={c.data} ghost={c.ghost} />)}
            </div>
            <p className={`text-[11px] mt-3 ${faint}`}>
              $1,000 base campaign per trade (playbook tiers ×4: half $500 · full $1,000 · size-up $1,500 · max $2,000).
              Green/red = playbook-hours result. Amber = signals fired only outside 9:45–11:15 ET; simulated, never counted.
              Purple research results are paper-only: strict 13–14 point first touches plus strict A+ setups from 11:15–12:30 ET.
              Blue Shen results are paper-only and use the PDF's original 3-check conviction stack without an Edge Lens score gate.
            </p>
          </div>

          <div>
            <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-3">
              {MONTH_NAMES[ym.month - 1]} {ym.year} Statistics
            </div>
            <div className={`${card} rounded-xl p-4 mb-3 flex items-center justify-between`}>
              <div>
                <div className={heading}>Win rate</div>
                <div className="text-3xl font-bold text-indigo-500 mt-1">{t.winRate != null ? `${t.winRate}%` : "—"}</div>
                <div className={`text-xs mt-0.5 ${faint}`}>{t.wins}W / {t.losses}L</div>
              </div>
              <WinRateDonut rate={t.winRate} />
            </div>
            <div className={`${card} rounded-xl p-4 mb-3 text-center`}>
              <div className={heading}>Total trades</div>
              <div className="text-3xl font-bold text-indigo-500 mt-1">{t.totalTrades}</div>
              <div className={`text-xs mt-0.5 ${faint}`}>{MONTH_NAMES[ym.month - 1]} · playbook hours · {t.excludedTrades} more outside hours</div>
            </div>
            <div className={`${card} rounded-xl p-4 mb-3`}>
              <div className={`${heading} text-center mb-3`}>Daily performance</div>
              <PerfBar label="Best" value={t.bestDay} maxAbs={maxDay} tone="good" />
              <PerfBar label="Worst" value={t.worstDay} maxAbs={maxDay} tone="bad" />
            </div>
            <div className={`${card} rounded-xl p-4`}>
              <div className={`${heading} text-center mb-3`}>Trade performance</div>
              <PerfBar label="Best" value={t.bestTrade} maxAbs={maxTrade} tone="good" />
              <PerfBar label="Worst" value={t.worstTrade} maxAbs={maxTrade} tone="bad" />
            </div>
            <div className={`${card} rounded-xl p-4 mt-3`}>
              <div className={`${heading} text-center mb-3`}>Why setups were missed</div>
              {Object.entries(t.nearMissReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => (
                <div key={reason} className="flex justify-between text-xs py-1">
                  <span className={faint}>{reason.replaceAll("_", " ")}</span><span className="font-semibold">{count}</span>
                </div>
              ))}
              {!Object.keys(t.nearMissReasons || {}).length && <div className={`text-xs text-center ${faint}`}>No near-miss data</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
