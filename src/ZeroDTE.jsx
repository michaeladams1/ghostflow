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
  Zap, Loader2, AlertTriangle, ArrowUp, ArrowDown, Target, ShieldAlert, Clock, Hash, CalendarDays, FlaskConical, BookOpenCheck, Sparkles,
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
const wholeMoney = (n) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const tradeSummary = (count, winRate) => `${count || 0} trade${count === 1 ? "" : "s"} · ${winRate != null ? `${winRate}% wins` : "no sample yet"}`;
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
  const [calendarReturn, setCalendarReturn] = useState(null);
  const [sessionDate, setSessionDate] = useState(lastWeekdayISO());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [data, setData] = useState(null);

  async function run(date = sessionDate) {
    setLoading(true); setErr(null); setData(null);
    try {
      const res = await fetch("/api/0dte/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "SPY", sessionDate: date }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }

  async function openDayFromCalendar(isoDate, returnCtx) {
    setCalendarReturn(returnCtx || null);
    setSessionDate(isoDate);
    setShowCalendar(false);
    await run(isoDate);
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

  if (showCalendar) {
    return (
      <CalendarView
        onBack={() => setShowCalendar(false)}
        onOpenDay={openDayFromCalendar}
        initialReturn={calendarReturn}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div className="max-w-lg">
          {calendarReturn && (
            <button
              type="button"
              onClick={() => setShowCalendar(true)}
              className={`text-sm mb-2 ${faint} hover:text-zinc-800 dark:hover:text-zinc-200`}
            >
              ← Back to calendar
            </button>
          )}
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

const CALENDAR_LANES = {
  official: { label: "Playbook hours", pnlKey: "pnl", tradesKey: "tradePnls" },
  outside: { label: "Outside hours", pnlKey: "excludedPnl", tradesKey: "excludedTradePnls" },
  research: { label: "Research lanes", pnlKey: "experimentalPnl", tradesKey: "experimentalTradePnls" },
  shen: { label: "Shen conviction", pnlKey: "shenPnl", tradesKey: "shenTradePnls" },
  frontier: { label: "Frontier v5", pnlKey: "frontierPnl", tradesKey: "frontierTradePnls" },
};

function laneDay(day, lane) {
  if (!day) return null;
  const config = CALENDAR_LANES[lane];
  const tradePnls = day[config.tradesKey] || [];
  return { ...day, pnl: Number(day[config.pnlKey] || 0), trades: tradePnls.length, tradePnls };
}

function laneTotals(days, lane) {
  const laneDays = (days || []).map((day) => laneDay(day, lane)).filter(Boolean);
  const tradedDays = laneDays.filter((day) => day.trades > 0);
  const tradePnls = tradedDays.flatMap((day) => day.tradePnls);
  const dayPnls = tradedDays.map((day) => day.pnl);
  const wins = tradePnls.filter((pnl) => pnl > 0).length;
  const totalTrades = tradePnls.length;
  return {
    pnl: +laneDays.reduce((sum, day) => sum + day.pnl, 0).toFixed(2),
    totalTrades,
    wins,
    losses: totalTrades - wins,
    winRate: totalTrades ? +((wins / totalTrades) * 100).toFixed(1) : null,
    bestDay: dayPnls.length ? Math.max(...dayPnls) : null,
    worstDay: dayPnls.length ? Math.min(...dayPnls) : null,
    bestTrade: tradePnls.length ? Math.max(...tradePnls) : null,
    worstTrade: tradePnls.length ? Math.min(...tradePnls) : null,
  };
}

function summarizeYearTotals(months) {
  const sum = (key) => +(months.reduce((s, m) => s + Number(m?.totals?.[key] || 0), 0).toFixed(2));
  const count = (key) => months.reduce((s, m) => s + Number(m?.totals?.[key] || 0), 0);
  const wins = count("wins");
  const totalTrades = count("totalTrades");
  const excludedTrades = count("excludedTrades");
  const excludedWins = count("excludedWins");
  const experimentalTrades = count("experimentalTrades");
  const experimentalWins = count("experimentalWins");
  const shenTrades = count("shenTrades");
  const shenWins = count("shenWins");
  const frontierTrades = count("frontierTrades");
  const frontierWins = count("frontierWins");
  return {
    pnl: sum("pnl"),
    excludedPnl: sum("excludedPnl"),
    totalTrades,
    wins,
    winRate: totalTrades ? +((wins / totalTrades) * 100).toFixed(1) : null,
    excludedTrades,
    excludedWins,
    excludedWinRate: excludedTrades ? +((excludedWins / excludedTrades) * 100).toFixed(1) : null,
    experimentalPnl: sum("experimentalPnl"),
    experimentalTrades,
    experimentalWins,
    experimentalWinRate: experimentalTrades ? +((experimentalWins / experimentalTrades) * 100).toFixed(1) : null,
    shenPnl: sum("shenPnl"),
    shenTrades,
    shenWins,
    shenWinRate: shenTrades ? +((shenWins / shenTrades) * 100).toFixed(1) : null,
    frontierPnl: sum("frontierPnl"),
    frontierTrades,
    frontierWins,
    frontierWinRate: frontierTrades ? +((frontierWins / frontierTrades) * 100).toFixed(1) : null,
    nearMissReasons: {},
  };
}

function DayBox({ dayNum, data, ghost, lane, onOpen }) {
  if (ghost) return (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900/40 min-h-[86px] p-2">
      <div className={`text-sm ${faint} opacity-50`}>{dayNum}</div>
    </div>
  );
  const traded = data && (data.trades || 0) > 0;
  const pos = traded && data.pnl > 0, neg = traded && data.pnl < 0;
  const cls = pos ? "bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800"
    : neg ? "bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800"
    : "bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800";
  const interactive = typeof onOpen === "function";
  const Comp = interactive ? "button" : "div";
  return (
    <Comp
      type={interactive ? "button" : undefined}
      onClick={interactive ? onOpen : undefined}
      className={`rounded-lg min-h-[86px] p-2 text-center w-full ${cls} ${interactive ? "hover:ring-2 hover:ring-emerald-400/60 transition" : ""}`}
    >
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{dayNum}</div>
      {traded && (
        <>
          <div className={`text-sm font-bold ${pos ? "text-emerald-600 dark:text-emerald-400" : neg ? "text-red-600 dark:text-red-400" : "text-zinc-600"}`}>
            {data.pnl > 0 ? "+" : ""}{money(data.pnl)}
          </div>
          <div className={`text-[11px] ${faint}`}>{data.trades} trade{data.trades === 1 ? "" : "s"}</div>
          <div className={`text-[9px] uppercase tracking-wide ${faint}`}>{CALENDAR_LANES[lane].label}</div>
        </>
      )}
    </Comp>
  );
}

function MonthBox({ month, totals, lane, onOpen }) {
  const config = CALENDAR_LANES[lane];
  const pnl = Number(totals?.[config.pnlKey] ?? 0);
  const tradeKey = config.tradesKey === "tradePnls" ? "totalTrades"
    : config.tradesKey === "excludedTradePnls" ? "excludedTrades"
    : config.tradesKey === "experimentalTradePnls" ? "experimentalTrades"
    : config.tradesKey === "shenTradePnls" ? "shenTrades"
    : "frontierTrades";
  const trades = Number(totals?.[tradeKey] ?? 0);
  const traded = trades > 0;
  const pos = traded && pnl > 0, neg = traded && pnl < 0;
  const cls = pos ? "bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800"
    : neg ? "bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800"
    : "bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800";
  return (
    <button type="button" onClick={onOpen}
      className={`rounded-lg min-h-[110px] p-3 text-center w-full ${cls} hover:ring-2 hover:ring-emerald-400/60 transition`}>
      <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{MONTH_NAMES[month - 1]}</div>
      {traded ? (
        <>
          <div className={`text-lg font-bold mt-1 ${pos ? "text-emerald-600 dark:text-emerald-400" : neg ? "text-red-600 dark:text-red-400" : "text-zinc-600"}`}>
            {pnl > 0 ? "+" : ""}{money(pnl)}
          </div>
          <div className={`text-[11px] mt-0.5 ${faint}`}>{trades} trade{trades === 1 ? "" : "s"}</div>
          <div className={`text-[9px] uppercase tracking-wide ${faint}`}>{config.label}</div>
        </>
      ) : (
        <div className={`text-[11px] mt-3 ${faint}`}>No trades</div>
      )}
    </button>
  );
}

function CalendarView({ onBack, onOpenDay, initialReturn }) {
  const now = new Date();
  const [ym, setYm] = useState(() => initialReturn?.ym || { year: now.getFullYear(), month: now.getMonth() + 1 });
  const [timeframe, setTimeframe] = useState(() => initialReturn?.timeframe || "Month");
  const [loading, setLoading] = useState(false);
  const [bulkRun, setBulkRun] = useState(null);
  const [calendarLane, setCalendarLane] = useState(() => initialReturn?.lane || "official");
  const [err, setErr] = useState(null);
  const [data, setData] = useState(null);
  const [yearMonths, setYearMonths] = useState([]);

  async function requestSavedMonth(year, month) {
    const res = await fetch(`/api/0dte/calendar?symbol=SPY&year=${year}&month=${month}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function load(y, m) {
    setLoading(true); setErr(null);
    try { setData(await requestSavedMonth(y, m)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function loadYear(y) {
    setLoading(true); setErr(null);
    try {
      const months = [];
      for (let m = 1; m <= 12; m++) {
        if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) break;
        months.push(await requestSavedMonth(y, m));
      }
      setYearMonths(months);
      setData(months[months.length - 1] || null);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function runLast24Months() {
    setErr(null);
    try {
      const res = await fetch("/api/0dte/backtest-jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "SPY", months: 24, force: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not start backtest");
      setBulkRun(json);
    } catch (e) {
      setErr(`24-month backtest could not start: ${e.message}`);
    }
  }

  // Recover visible progress on page load, then poll PostgreSQL while Railway
  // works. Closing this page stops only the polling — never the backtest.
  useEffect(() => {
    let active = true;
    fetch("/api/0dte/backtest-jobs/latest?symbol=SPY")
      .then((res) => res.ok ? res.json() : null)
      .then((job) => { if (active && job) setBulkRun(job); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!bulkRun?.id || !["queued", "running"].includes(bulkRun.status)) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/0dte/backtest-jobs/${bulkRun.id}`);
        if (!res.ok) return;
        const job = await res.json();
        setBulkRun(job);
        if (job.status === "complete") {
          if (timeframe === "Year") await loadYear(ym.year);
          else setData(await requestSavedMonth(ym.year, ym.month));
        }
        if (job.status === "failed") setErr(`24-month backtest stopped: ${job.error}. Click retry to resume.`);
      } catch { /* Railway continues even if this browser misses a poll. */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [bulkRun?.id, bulkRun?.status, ym.year, ym.month, timeframe]);
  // Load on first render and whenever the month/year/timeframe changes.
  useEffect(() => {
    if (timeframe === "Year") loadYear(ym.year);
    else load(ym.year, ym.month);
  }, [ym.year, ym.month, timeframe]);

  const nav = (delta) => {
    if (timeframe === "Year") {
      const year = ym.year + delta;
      if (year > now.getFullYear() || year < 2020) return;
      setYm({ year, month: ym.month });
      return;
    }
    let { year, month } = ym;
    month += delta;
    if (month < 1) { month = 12; year--; }
    if (month > 12) { month = 1; year++; }
    if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1)) return;
    setYm({ year, month });
  };

  const returnCtx = () => ({ ym, timeframe, lane: calendarLane });

  // Trading calendar scaffolding: Monday-Friday only. Weekend dates are omitted,
  // while weekday ghosts keep each session under its real weekday heading.
  const daysInMonth = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
  const byDate = Object.fromEntries((data?.days || []).map((d) => [Number(d.date.slice(8, 10)), laneDay(d, calendarLane)]));
  const cells = [];
  const firstDate = new Date(Date.UTC(ym.year, ym.month - 1, 1));
  const lastDate = new Date(Date.UTC(ym.year, ym.month - 1, daysInMonth));
  const gridStart = new Date(firstDate);
  const firstDow = firstDate.getUTCDay();
  const daysToFirstMonday = firstDow === 0 ? 1 : firstDow === 6 ? 2 : -(firstDow - 1);
  gridStart.setUTCDate(firstDate.getUTCDate() + daysToFirstMonday);
  const gridEnd = new Date(lastDate);
  const lastDow = lastDate.getUTCDay();
  const daysToLastFriday = lastDow === 0 ? -2 : lastDow === 6 ? -1 : 5 - lastDow;
  gridEnd.setUTCDate(lastDate.getUTCDate() + daysToLastFriday);
  for (const date = new Date(gridStart); date <= gridEnd; date.setUTCDate(date.getUTCDate() + 1)) {
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const isCurrentMonth = date.getUTCFullYear() === ym.year && date.getUTCMonth() === ym.month - 1;
    const dayNum = date.getUTCDate();
    const iso = `${ym.year}-${String(ym.month).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    cells.push({
      ghost: !isCurrentMonth,
      dayNum,
      iso,
      data: isCurrentMonth ? byDate[dayNum] : undefined,
    });
  }

  const yearLaneDays = yearMonths.flatMap((m) => m.days || []);
  const t = timeframe === "Year"
    ? laneTotals(yearLaneDays, calendarLane)
    : (data ? laneTotals(data.days, calendarLane) : null);
  const allTotals = timeframe === "Year"
    ? summarizeYearTotals(yearMonths)
    : data?.totals;
  const selectedLane = CALENDAR_LANES[calendarLane];
  const maxDay = t ? Math.max(Math.abs(t.bestDay ?? 0), Math.abs(t.worstDay ?? 0)) : 0;
  const maxTrade = t ? Math.max(Math.abs(t.bestTrade ?? 0), Math.abs(t.worstTrade ?? 0)) : 0;
  const codeVersion = timeframe === "Year"
    ? yearMonths.find((m) => m.codeVersion)?.codeVersion
    : data?.codeVersion;
  const sessionsCovered = timeframe === "Year"
    ? yearMonths.find((m) => m.sessionsCovered)?.sessionsCovered
    : data?.sessionsCovered;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className={`text-sm ${faint} hover:text-zinc-800 dark:hover:text-zinc-200`}>
          ← Back to daily debrief
        </button>
        <div className="flex rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-1 text-sm">
          {["Week", "Month", "Year", "All Time"].map((m) => {
            const enabled = m === "Month" || m === "Year";
            return (
              <button key={m} type="button" disabled={!enabled}
                title={!enabled ? "Coming soon" : undefined}
                onClick={() => enabled && setTimeframe(m)}
                className={`px-4 py-1.5 rounded-full font-medium ${timeframe === m ? "bg-emerald-600 text-white" : enabled ? `${faint} hover:text-zinc-800 dark:hover:text-zinc-200` : `${faint} cursor-not-allowed`}`}>
                {m}
              </button>
            );
          })}
        </div>
        <div className="w-56 flex justify-end">
          <button onClick={runLast24Months} disabled={loading || ["queued", "running"].includes(bulkRun?.status)}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white px-3 py-2 text-xs font-semibold flex items-center gap-2">
            {["queued", "running"].includes(bulkRun?.status) ? <Loader2 size={14} className="animate-spin" /> : <CalendarDays size={14} />}
            {bulkRun?.status === "queued" ? "Queued on Railway"
              : bulkRun?.status === "running" && bulkRun.current
                ? `${bulkRun.completedMonths}/${bulkRun.totalMonths} · ${MONTH_NAMES[bulkRun.current.month - 1]} ${bulkRun.current.year}`
                : bulkRun?.status === "complete" ? "Rerun 24-month backtest"
                : bulkRun?.status === "failed" ? "Retry 24-month backtest"
                : "Rerun 24-month backtest"}
          </button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <button type="button" onClick={() => setCalendarLane("official")} aria-pressed={calendarLane === "official"}
          className={`rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 text-white p-5 flex items-center gap-4 text-left transition ${calendarLane === "official" ? "ring-4 ring-emerald-300 ring-offset-2 dark:ring-offset-zinc-950" : "hover:scale-[1.01]"}`}>
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><Zap size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-100">Monthly net total · playbook hours</div>
            <div className="text-3xl font-bold whitespace-nowrap">{allTotals ? (allTotals.pnl >= 0 ? "+" : "") + wholeMoney(allTotals.pnl) : "—"}</div>
            <div className="text-xs text-emerald-100">{tradeSummary(allTotals?.totalTrades, allTotals?.winRate)}</div>
          </div>
        </button>
        <button type="button" onClick={() => setCalendarLane("outside")} aria-pressed={calendarLane === "outside"}
          className={`rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 text-white p-5 flex items-center gap-4 text-left transition ${calendarLane === "outside" ? "ring-4 ring-amber-300 ring-offset-2 dark:ring-offset-zinc-950" : "hover:scale-[1.01]"}`}>
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><Clock size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-100">Outside-hours signals · not counted</div>
            <div className="text-3xl font-bold whitespace-nowrap">{allTotals ? (allTotals.excludedPnl >= 0 ? "+" : "") + wholeMoney(allTotals.excludedPnl) : "—"}</div>
            <div className="text-xs text-amber-100">{tradeSummary(allTotals?.excludedTrades, allTotals?.excludedWinRate)}</div>
          </div>
        </button>
        <button type="button" onClick={() => setCalendarLane("research")} aria-pressed={calendarLane === "research"}
          className={`rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 text-white p-5 flex items-center gap-4 text-left transition ${calendarLane === "research" ? "ring-4 ring-indigo-300 ring-offset-2 dark:ring-offset-zinc-950" : "hover:scale-[1.01]"}`}>
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><FlaskConical size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-100">Research lanes · paper only</div>
            <div className="text-3xl font-bold whitespace-nowrap">{allTotals ? (allTotals.experimentalPnl >= 0 ? "+" : "") + wholeMoney(allTotals.experimentalPnl) : "—"}</div>
            <div className="text-xs text-indigo-100">{tradeSummary(allTotals?.experimentalTrades, allTotals?.experimentalWinRate)}</div>
          </div>
        </button>
        <button type="button" onClick={() => setCalendarLane("shen")} aria-pressed={calendarLane === "shen"}
          className={`rounded-2xl bg-gradient-to-br from-sky-600 to-cyan-700 text-white p-5 flex items-center gap-4 text-left transition ${calendarLane === "shen" ? "ring-4 ring-sky-300 ring-offset-2 dark:ring-offset-zinc-950" : "hover:scale-[1.01]"}`}>
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><BookOpenCheck size={20} /></div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-sky-100">Shen conviction · paper only</div>
            <div className="text-3xl font-bold whitespace-nowrap">{allTotals ? (allTotals.shenPnl >= 0 ? "+" : "") + wholeMoney(allTotals.shenPnl) : "—"}</div>
            <div className="text-xs text-sky-100">{tradeSummary(allTotals?.shenTrades, allTotals?.shenWinRate)}</div>
          </div>
        </button>
      </div>
      <div className="mb-4">
        <button type="button" onClick={() => setCalendarLane("frontier")} aria-pressed={calendarLane === "frontier"}
          className={`w-full rounded-2xl bg-gradient-to-br from-teal-600 to-emerald-800 text-white p-5 flex items-center gap-4 text-left transition ${calendarLane === "frontier" ? "ring-4 ring-teal-300 ring-offset-2 dark:ring-offset-zinc-950" : "hover:scale-[1.01]"}`}>
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><Sparkles size={20} /></div>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-teal-100">Frontier v5 · paper only · $8k tickets · ~$250/day target</div>
            <div className="text-3xl font-bold whitespace-nowrap">{allTotals ? (allTotals.frontierPnl >= 0 ? "+" : "") + wholeMoney(allTotals.frontierPnl) : "—"}</div>
            <div className="text-xs text-teal-100">{tradeSummary(allTotals?.frontierTrades, allTotals?.frontierWinRate)} · touch 1 · from 9:45 ET · best score/day · $8k paper</div>
          </div>
        </button>
      </div>

      <div className={`${card} rounded-xl px-4 py-3 mb-4 flex items-center justify-center gap-6`}>
        <button onClick={() => nav(-1)} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">‹</button>
        <div className="text-center">
          <div className="font-semibold text-zinc-900 dark:text-zinc-100">
            {timeframe === "Year" ? ym.year : `${MONTH_NAMES[ym.month - 1]} ${ym.year}`}
          </div>
          {codeVersion && <div className={`text-[10px] ${faint}`}>Saved calendar · version {codeVersion} · {sessionsCovered} sessions</div>}
        </div>
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
          Loading saved {timeframe === "Year" ? ym.year : MONTH_NAMES[ym.month - 1]} calendar…
        </div>
      )}

      {bulkRun && ["queued", "running"].includes(bulkRun.status) && (
        <div className={`${card} rounded-lg px-4 py-3 mb-4`}>
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200">Building the 24-month history</span>
            <span className={faint}>{bulkRun.completedMonths} of {bulkRun.totalMonths} months saved</span>
          </div>
          <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all"
              style={{ width: `${(bulkRun.completedMonths / bulkRun.totalMonths) * 100}%` }} />
          </div>
          <div className={`text-[11px] mt-2 ${faint}`}>
            Railway is running this in the background. You may close the browser; progress and completed months are saved.
          </div>
        </div>
      )}

      {!loading && (timeframe === "Year" ? yearMonths.length > 0 : data) && (
        <div className="grid lg:grid-cols-[1fr_300px] gap-5">
          <div>
            {timeframe === "Year" ? (
              <>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-1">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
                    const monthData = yearMonths.find((m) => m.month === month);
                    return (
                      <MonthBox
                        key={month}
                        month={month}
                        totals={monthData?.totals}
                        lane={calendarLane}
                        onOpen={() => { setYm({ year: ym.year, month }); setTimeframe("Month"); }}
                      />
                    );
                  })}
                </div>
                <p className={`text-[11px] mt-3 ${faint}`}>
                  Click a month to open its trading-day calendar. Summary cards still filter the selected lane across the year.
                </p>
              </>
            ) : (
              <>
                <div className="grid grid-cols-5 gap-1 mb-1">
                  {["MON", "TUE", "WED", "THU", "FRI"].map((d) => (
                    <div key={d} className={`text-center text-xs font-semibold py-2 rounded bg-zinc-100 dark:bg-zinc-800/60 ${faint}`}>{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-5 gap-1">
                  {cells.map((c, i) => (
                    <DayBox
                      key={i}
                      dayNum={c.dayNum}
                      data={c.data}
                      ghost={c.ghost}
                      lane={calendarLane}
                      onOpen={!c.ghost ? () => onOpenDay?.(c.iso, returnCtx()) : undefined}
                    />
                  ))}
                </div>
                <p className={`text-[11px] mt-3 ${faint}`}>
                  Click a day to open the full debrief — option entry/exit chart plus the underlying SPY chart.
                  $1,000 base campaign per trade (playbook tiers ×4: half $500 · full $1,000 · size-up $1,500 · max $2,000).
                  Outside-hours / research / Shen / Frontier are paper comparison lanes and never change official P&L.
                  Frontier v5 (live): first touch from 9:45 ET, best Edge Lens score/day, P&L recomputed at $8,000 paper (holdout ~$250/day avg). No toxin gates; no 24-month re-sim needed.
                  $1,000 tickets cannot hit that target under the stored +20%/−12.5% bracket (full TP tops out near +$200). Wider exits would need a new backtest.
                </p>
              </>
            )}
          </div>

          <div>
            <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-3">
              {timeframe === "Year" ? ym.year : `${MONTH_NAMES[ym.month - 1]} ${ym.year}`} · {selectedLane.label}
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
              <div className={`text-xs mt-0.5 ${faint}`}>{timeframe === "Year" ? ym.year : MONTH_NAMES[ym.month - 1]} · {selectedLane.label}</div>
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
            {calendarLane === "official" && <div className={`${card} rounded-xl p-4 mt-3`}>
              <div className={`${heading} text-center mb-3`}>Why setups were missed</div>
              {Object.entries(allTotals.nearMissReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => (
                <div key={reason} className="flex justify-between text-xs py-1">
                  <span className={faint}>{reason.replaceAll("_", " ")}</span><span className="font-semibold">{count}</span>
                </div>
              ))}
              {!Object.keys(allTotals.nearMissReasons || {}).length && <div className={`text-xs text-center ${faint}`}>No near-miss data</div>}
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}
