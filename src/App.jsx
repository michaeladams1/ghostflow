import { useState, useMemo, useRef, useEffect } from "react";
import {
  Plus, X, CheckCircle2, XCircle, AlertTriangle, ChevronRight,
  Users, FileText, LayoutDashboard, Minus, Send, MessageSquare
} from "lucide-react";

// ---------- Design tokens ----------
const MODEL_META = {
  claude:   { name: "Claude",   accent: "text-amber-400",   ring: "ring-amber-400/40",   bg: "bg-amber-400",   dot: "bg-amber-400" },
  gpt:      { name: "GPT",      accent: "text-emerald-400", ring: "ring-emerald-400/40", bg: "bg-emerald-400", dot: "bg-emerald-400" },
  grok:     { name: "Grok",     accent: "text-violet-400",  ring: "ring-violet-400/40",  bg: "bg-violet-400",  dot: "bg-violet-400" },
  combined: { name: "Combined", accent: "text-zinc-200",    ring: "ring-zinc-300/30",    bg: "bg-zinc-300",    dot: "bg-zinc-300" },
};
const MODEL_ORDER = ["claude", "gpt", "grok", "combined"];

const INDICATOR_META = {
  volume:   { label: "Volume",    color: "#38bdf8" },
  gex:      { label: "GEX",       color: "#f472b6" },
  darkpool: { label: "Dark Pool", color: "#a78bfa" },
  flow:     { label: "Flow",      color: "#facc15" },
  iv:       { label: "IV",        color: "#4ade80" },
};

// ---------- Mock data ----------
function wave(base, points, drift, amp, noise = 1) {
  const arr = [];
  let v = base;
  for (let i = 0; i < points; i++) {
    v += drift + Math.sin(i / 2.3) * amp * 0.3 + (Math.random() - 0.5) * noise;
    arr.push(Math.round(v * 100) / 100);
  }
  return arr;
}

const MOCK_TRADES = [
  {
    id: "t1", symbol: "AAPL", direction: "CALL", status: "win",
    loggedAt: "Trade #18", entryDate: "2026-05-04", exitDate: "2026-05-22",
    entryPrice: 187.2, exitPrice: 204.6,
    prices: wave(184, 22, 0.9, 3), entryIdx: 5, exitIdx: 17,
    agreement: "3/3",
    analysis: {
      claude: {
        verdict: "signal", confidence: 82, entryIdx: 5, exitIdx: 17,
        text: "Base n' Break off the 10/20 EMA on the daily, confirmed by a volume surge 40% above the 20-day average. IV was climbing into the move rather than collapsing, which matched three prior wins in the thesis.",
        flags: [{ idx: 5, type: "volume", label: "Volume +40% vs 20d avg" }, { idx: 6, type: "iv", label: "IV expanding into move" }],
      },
      gpt: {
        verdict: "signal", confidence: 78, entryIdx: 6, exitIdx: 18,
        text: "Options flow showed sustained call buying at the 190 strike two sessions before breakout, with open interest building rather than just volume — a pattern the thesis flags as high-conviction accumulation.",
        flags: [{ idx: 4, type: "flow", label: "Call buying, 190 strike" }, { idx: 5, type: "gex", label: "OI building at strike" }],
      },
      grok: {
        verdict: "signal", confidence: 74, entryIdx: 5, exitIdx: 16,
        text: "Relative strength vs. QQQ was positive through the prior pullback — AAPL held higher lows while the index chopped, consistent with the 'stubborn to the downside' setup condition.",
        flags: [{ idx: 3, type: "volume", label: "RS divergence vs QQQ" }],
      },
      combined: {
        verdict: "signal", confidence: 80, entryIdx: 5, exitIdx: 17,
        text: "All three analysts independently flagged the same base-and-break structure with confirming volume and flow. No material disagreement on this trade — high-confidence supporting evidence.",
        flags: [{ idx: 5, type: "volume", label: "Volume +40%" }, { idx: 5, type: "flow", label: "Call buying, 190 strike" }, { idx: 6, type: "iv", label: "IV expanding" }],
      },
    },
  },
  {
    id: "t2", symbol: "TSLA", direction: "CALL", status: "win",
    loggedAt: "Trade #21", entryDate: "2026-05-19", exitDate: "2026-05-28",
    entryPrice: 241.0, exitPrice: 268.5,
    prices: wave(236, 20, 1.1, 4), entryIdx: 6, exitIdx: 16,
    agreement: "2/3",
    analysis: {
      claude: {
        verdict: "signal", confidence: 71, entryIdx: 6, exitIdx: 16,
        text: "Wedge Pop back through the 10/20 EMA after a reversal extension off the 50-day. Entry timing lines up with two prior wins that also popped through tightened moving averages.",
        flags: [{ idx: 6, type: "volume", label: "EMA reclaim" }],
      },
      gpt: {
        verdict: "signal", confidence: 65, entryIdx: 7, exitIdx: 15,
        text: "Elevated call skew and a jump in short-dated gamma exposure ahead of the move — flow was consistent with dealers being pushed to hedge upside.",
        flags: [{ idx: 6, type: "gex", label: "Gamma exposure jump" }, { idx: 7, type: "flow", label: "Call skew elevated" }],
      },
      grok: {
        verdict: "noise", confidence: 38, entryIdx: 6, exitIdx: 16,
        text: "I'm less convinced here — the volume on the pop was only slightly above average, and this looks closer to a low-conviction bounce than the high-volume 'ignite bar' the thesis usually requires. Logged as a disagreement, not excluded.",
        flags: [{ idx: 6, type: "volume", label: "Volume only slightly elevated" }],
      },
      combined: {
        verdict: "signal", confidence: 62, entryIdx: 6, exitIdx: 16,
        text: "2 of 3 analysts support this as a genuine setup. Grok's dissent is preserved: volume confirmation was weaker than the thesis' usual bar. Won't be promoted to a hard rule until this pattern repeats with clearer volume.",
        flags: [{ idx: 6, type: "gex", label: "Gamma exposure jump" }, { idx: 7, type: "flow", label: "Call skew elevated" }],
      },
    },
  },
  {
    id: "t3", symbol: "NVDA", direction: "PUT", status: "near-miss-loss",
    loggedAt: "Trade #24", entryDate: "2026-06-02", exitDate: "2026-06-10",
    entryPrice: 118.4, exitPrice: 121.9,
    prices: wave(119, 18, -0.2, 3.5, 2.2), entryIdx: 5, exitIdx: 13,
    agreement: "3/3",
    analysis: {
      claude: {
        verdict: "contrast", confidence: 0, entryIdx: 5, exitIdx: 13,
        text: "This looked like an Exhaustion Extension on paper — extended from the 10 EMA, similar shape to two winning shorts. The difference: no volume spike on the reversal bar. I'd avoid this one; capitulation volume is now a required condition, not optional.",
        flags: [{ idx: 5, type: "volume", label: "No capitulation volume (missing)" }],
      },
      gpt: {
        verdict: "contrast", confidence: 0, entryIdx: 5, exitIdx: 13,
        text: "Flow read as distribution at first glance, but open interest at the nearby strikes was actually declining, not building — the opposite of the accumulation signature behind our winning puts. Would avoid on this data alone.",
        flags: [{ idx: 5, type: "flow", label: "OI declining, not building" }],
      },
      grok: {
        verdict: "contrast", confidence: 0, entryIdx: 5, exitIdx: 13,
        text: "Relative weakness vs. SOXX was present, but it was already priced in — the underperformance had been going on for two weeks with no fresh trigger. Would avoid; nothing here was new information.",
        flags: [{ idx: 3, type: "volume", label: "Stale RS divergence" }],
      },
      combined: {
        verdict: "contrast", confidence: 0, entryIdx: 5, exitIdx: 13,
        text: "Genuine near-miss: this matched the surface shape of the thesis but failed the volume/flow confirmation all three analysts independently require. Logged as a Counter-Example — this is exactly the kind of trade that keeps the thesis honest.",
        flags: [{ idx: 5, type: "volume", label: "Missing volume confirmation" }, { idx: 5, type: "flow", label: "OI declining" }],
      },
    },
  },
  {
    id: "t4", symbol: "MSFT", direction: "CALL", status: "low-info-loss",
    loggedAt: "Trade #26", entryDate: "2026-06-15", exitDate: "2026-06-19",
    entryPrice: 412.0, exitPrice: 405.1,
    prices: wave(412, 15, -0.4, 1.5, 1.8), entryIdx: 4, exitIdx: 10,
    agreement: "3/3",
    analysis: {
      claude: {
        verdict: "low-info", confidence: 0, entryIdx: 4, exitIdx: 10,
        text: "No basing pattern, no volume signature, no relative strength divergence — this doesn't resemble any setup condition currently in the thesis. Would avoid; flagged as low information value rather than a true counter-example.",
        flags: [],
      },
      gpt: {
        verdict: "low-info", confidence: 0, entryIdx: 4, exitIdx: 10,
        text: "Flow was flat and unremarkable heading into entry. There's nothing here to learn from either direction — this trade doesn't stress-test the thesis, it just didn't have a setup.",
        flags: [],
      },
      grok: {
        verdict: "low-info", confidence: 0, entryIdx: 4, exitIdx: 10,
        text: "Agreed — no divergence from the index, no volume tell. This is noise, not a near-miss.",
        flags: [],
      },
      combined: {
        verdict: "low-info", confidence: 0, entryIdx: 4, exitIdx: 10,
        text: "Unanimous: this trade never looked like a real setup. Logged for completeness but excluded from Counter-Examples so it doesn't dilute the thesis with low-signal data.",
        flags: [],
      },
    },
  },
];

const THESES = {
  claude:   { setup: ["Base n' Break or Wedge Pop off the 10/20 EMA", "Volume \u2265 30-40% above 20-day average on the trigger bar", "IV expanding into the move, not collapsing"], confidence: "Medium \u2014 14 supporting trades, 3 counter-examples", lastUpdated: "Trade #26", evidence: 14, counters: 3 },
  gpt:      { setup: ["Sustained call/put buying with rising open interest (not just volume)", "Skew shift consistent with dealer hedging pressure", "Flow precedes price, not the reverse"], confidence: "Medium \u2014 12 supporting trades, 4 counter-examples", lastUpdated: "Trade #26", evidence: 12, counters: 4 },
  grok:     { setup: ["Relative strength/weakness vs. sector ETF, especially during a pullback", "Divergence must be fresh, not already priced in for 2+ weeks", "\"Stubborn to the downside\" price action on lower timeframes"], confidence: "Low-Medium \u2014 9 supporting trades, 5 counter-examples", lastUpdated: "Trade #26", evidence: 9, counters: 5 },
  combined: { setup: ["High-confidence: Base/Wedge structure + confirming volume + confirming flow, all three agree", "Open disagreement: volume threshold for a valid 'pop' (Grok wants a higher bar than Claude/GPT \u2014 tracked, not resolved)"], confidence: "26 trades logged \u2014 14 wins, 5 near-miss losses, 7 low-info losses", lastUpdated: "Trade #26", evidence: 14, counters: 8 },
};

// ---------- Small building blocks ----------
function VerdictBadge({ verdict }) {
  const map = {
    signal:   { label: "SIGNAL",   cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", Icon: CheckCircle2 },
    noise:    { label: "NOISE",    cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",           Icon: Minus },
    contrast: { label: "AVOID \u2014 NEAR-MISS", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", Icon: AlertTriangle },
    "low-info": { label: "AVOID \u2014 LOW INFO", cls: "bg-zinc-600/20 text-zinc-500 border-zinc-600/30", Icon: XCircle },
  };
  const m = map[verdict] || map.noise;
  const I = m.Icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-mono tracking-wide ${m.cls}`}>
      <I size={13} /> {m.label}
    </span>
  );
}

function StatusPill({ status }) {
  const map = {
    win: { label: "WIN", cls: "bg-emerald-500/15 text-emerald-400" },
    "near-miss-loss": { label: "NEAR-MISS LOSS", cls: "bg-amber-500/15 text-amber-400" },
    "low-info-loss": { label: "LOW-INFO LOSS", cls: "bg-zinc-600/20 text-zinc-500" },
  };
  const m = map[status];
  return <span className={`px-2 py-0.5 rounded text-[11px] font-mono ${m.cls}`}>{m.label}</span>;
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono">{label}</div>
      <div className="text-2xl font-mono text-zinc-100 mt-1">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// Price chart with indicator overlay markers along the bottom axis.
// Each flag renders as a small colored tick + label so you can see WHICH
// indicator(s) the model is pointing to, not just read about it in prose.
function PriceChart({ prices, entryIdx, exitIdx, status, flags = [] }) {
  const w = 640, h = 200, pad = 24, flagRowY = h - 6;
  const min = Math.min(...prices), max = Math.max(...prices);
  const x = (i) => pad + (i / (prices.length - 1)) * (w - pad * 2);
  const y = (v) => (h - 34) - pad - ((v - min) / (max - min || 1)) * (h - 34 - pad * 2);
  const pts = prices.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const lineColor = status === "win" ? "#34d399" : status === "near-miss-loss" ? "#fbbf24" : "#71717a";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-52">
      <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" />
      <circle cx={x(entryIdx)} cy={y(prices[entryIdx])} r="4.5" fill="#e4e4e7" />
      <text x={x(entryIdx)} y={y(prices[entryIdx]) - 10} fontSize="10" fill="#a1a1aa" fontFamily="monospace" textAnchor="middle">ENTRY</text>
      <circle cx={x(exitIdx)} cy={y(prices[exitIdx])} r="4.5" fill={lineColor} />
      <text x={x(exitIdx)} y={y(prices[exitIdx]) - 10} fontSize="10" fill={lineColor} fontFamily="monospace" textAnchor="middle">
        {status === "win" ? "EXIT (target)" : "EXIT (stop)"}
      </text>
      {/* indicator overlay ticks */}
      {flags.map((f, i) => {
        const meta = INDICATOR_META[f.type] || { color: "#a1a1aa", label: f.type };
        return (
          <g key={i}>
            <line x1={x(f.idx)} y1={pad} x2={x(f.idx)} y2={flagRowY} stroke={meta.color} strokeWidth="1" strokeDasharray="2,3" opacity="0.5" />
            <rect x={x(f.idx) - 3} y={flagRowY} width="6" height="6" fill={meta.color} rx="1" />
          </g>
        );
      })}
    </svg>
  );
}

function IndicatorLegend({ flags = [] }) {
  if (flags.length === 0) {
    return <p className="text-xs text-zinc-600 italic">No indicator combination flagged — no real setup detected here.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {flags.map((f, i) => {
        const meta = INDICATOR_META[f.type] || { color: "#a1a1aa", label: f.type };
        return (
          <span key={i} className="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-900 border border-zinc-800">
            <span className="w-2 h-2 rounded-sm" style={{ background: meta.color }} />
            <span className="text-zinc-400">{meta.label}:</span>
            <span className="text-zinc-300">{f.label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ---------- Per-trade, per-model Q&A ----------
// Scoped ONLY to this trade + this model's analysis + this model's thesis excerpt.
// PROTOTYPE NOTE: this is a canned keyword-matched responder, not a live model call.
// In the real system this becomes an actual API call to that model, with a system
// prompt containing only: this trade's pulled data, this model's analysis, and the
// relevant slice of this model's thesis document \u2014 nothing else.
function mockReply(trade, modelId, question) {
  const a = trade.analysis[modelId];
  const thesis = THESES[modelId];
  const q = question.toLowerCase();

  if (q.includes("why") && (q.includes("buy") || q.includes("enter") || q.includes("this") || q.includes("do"))) {
    return a.text;
  }
  if (q.includes("exit") || q.includes("sell") || q.includes("out")) {
    return a.verdict === "signal"
      ? `Exit was tied to price reaching the target zone shown on the chart. In this thesis, once a trade like this extends the way ${trade.symbol} did, ${MODEL_META[modelId].name === "Combined" ? "the group" : MODEL_META[modelId].name} treats further upside as lower-probability and books the win rather than pushing for more.`
      : `There wasn't a clean exit thesis here \u2014 this trade didn't confirm the setup in the first place, so the "exit" is really just where the stop got taken.`;
  }
  if (q.includes("not") || q.includes("avoid") || q.includes("risk") || q.includes("why not")) {
    return a.verdict === "signal" || a.verdict === "noise"
      ? `The main risk I flagged going in: ${a.flags[0] ? a.flags[0].label.toLowerCase() : "confirmation was thinner than my strongest setups"}. That's why confidence here is ${a.confidence}%, not higher.`
      : `I'd avoid this one. ${a.text}`;
  }
  if (q.includes("indicator") || q.includes("gex") || q.includes("volume") || q.includes("dark pool") || q.includes("flow")) {
    return a.flags.length
      ? `The specific combination I weighted here: ${a.flags.map((f) => (INDICATOR_META[f.type] || {}).label + " (" + f.label + ")").join(", ")}.`
      : `No indicator combination cleared my bar on this trade \u2014 that's exactly why it's flagged as low information rather than a real counter-example.`;
  }
  return `On this specific trade: ${a.text} This ties into the broader thesis (${thesis.confidence}), but my answer above is scoped to ${trade.symbol} only \u2014 ask me about the thesis in general from the Theses tab.`;
}

function ChatPanel({ trade, modelId }) {
  const [messages, setMessages] = useState([
    { role: "assistant", text: `Ask me anything about this ${trade.symbol} trade \u2014 why I entered, why not something else, what I'd need to see to be more confident. I'll only use this trade's data and my own thesis.` },
  ]);
  const [input, setInput] = useState("");
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    const reply = mockReply(trade, modelId, text);
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: reply }]);
    setInput("");
  };

  return (
    <div className="border border-zinc-800 rounded-lg mt-4">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <MessageSquare size={14} className={MODEL_META[modelId].accent} />
        <span className="text-xs font-mono text-zinc-400">Ask {MODEL_META[modelId].name} about this trade only</span>
        <span className="ml-auto text-[10px] font-mono text-zinc-600">prototype — canned replies</span>
      </div>
      <div className="max-h-56 overflow-y-auto px-3 py-2 space-y-2">
        {messages.map((m, i) => (
          <div key={i} className={`text-sm ${m.role === "user" ? "text-zinc-300 pl-4" : "text-zinc-400"}`}>
            <span className={`text-[11px] font-mono mr-2 ${m.role === "user" ? "text-zinc-600" : MODEL_META[modelId].accent}`}>
              {m.role === "user" ? "you" : MODEL_META[modelId].name.toLowerCase()}
            </span>
            {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 p-2 border-t border-zinc-800">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Why this trade, and not another setup?"
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
        <button onClick={send} className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------- Log Trade form ----------
function LogTradeForm({ onClose, onSubmit, error }) {
  const [form, setForm] = useState({ symbol: "", direction: "CALL", outcome: "win", entryDate: "", exitDate: "", entryPrice: "", exitPrice: "", notes: "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-zinc-100 font-semibold">Log a trade</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500 font-mono">SYMBOL</label>
              <input value={form.symbol} onChange={set("symbol")} placeholder="AAPL"
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 font-mono">DIRECTION</label>
              <select value={form.direction} onChange={set("direction")}
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40">
                <option>CALL</option><option>PUT</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 font-mono">OUTCOME</label>
            <select value={form.outcome} onChange={set("outcome")}
              className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40">
              <option value="win">Win</option>
              <option value="loss">Loss (near-miss or not — the analysts will judge)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500 font-mono">ENTRY DATE</label>
              <input type="date" value={form.entryDate} onChange={set("entryDate")}
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 font-mono">EXIT DATE</label>
              <input type="date" value={form.exitDate} onChange={set("exitDate")}
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500 font-mono">ENTRY PRICE</label>
              <input value={form.entryPrice} onChange={set("entryPrice")} placeholder="187.20"
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 font-mono">EXIT PRICE</label>
              <input value={form.exitPrice} onChange={set("exitPrice")} placeholder="204.60"
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 font-mono">NOTES (optional)</label>
            <textarea value={form.notes} onChange={set("notes")} rows={2}
              className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded border border-zinc-800 text-zinc-400 text-sm hover:bg-zinc-900">Cancel</button>
          <button
            onClick={async () => { const ok = await onSubmit(form); if (ok) onClose(); }}
            disabled={!form.symbol}
            className="flex-1 py-2 rounded bg-emerald-600 text-zinc-950 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600">
            Log trade
          </button>
        </div>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        <p className="text-[11px] text-zinc-600 mt-3 leading-relaxed">
          Logging a trade now pulls real historical price data (Databento) and options flow (Quant Data) for this symbol.
          AI thesis analysis isn't wired up yet — that's the next build phase.
        </p>
      </div>
    </div>
  );
}

// ---------- Trade detail: 4 fully independent panels ----------
// Each model tab is self-contained: its own chart + indicator overlay + verdict +
// justification + its own scoped chat. Nothing is shared between tabs except the
// underlying trade record (symbol/dates/prices) \u2014 each model's read is independent.
function ModelPanel({ trade, modelId }) {
  const a = trade.analysis[modelId];
  return (
    <div>
      <PriceChart prices={trade.prices} entryIdx={a.entryIdx} exitIdx={a.exitIdx} status={trade.status} flags={a.flags} />
      <div className="flex justify-between text-xs font-mono text-zinc-500 mt-1 px-1 mb-3">
        <span>{trade.entryDate} · ${trade.entryPrice}</span>
        <span>{trade.exitDate} · ${trade.exitPrice}</span>
      </div>

      <div className="flex items-center justify-between mb-2">
        <VerdictBadge verdict={a.verdict} />
        {a.confidence > 0 && <span className="text-xs font-mono text-zinc-500">confidence {a.confidence}%</span>}
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed mb-3">{a.text}</p>

      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1.5">Indicator combination used</div>
      <IndicatorLegend flags={a.flags} />

      <ChatPanel trade={trade} modelId={modelId} />
    </div>
  );
}

function TradeDetail({ trade, onClose }) {
  const [tab, setTab] = useState("combined");
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="flex items-center gap-3">
            <h3 className="text-zinc-100 font-semibold text-lg">{trade.symbol} <span className="text-zinc-500 font-mono text-sm">{trade.direction}</span></h3>
            <StatusPill status={trade.status} />
            <span className="text-xs text-zinc-600 font-mono">agreement {trade.agreement}</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X size={18} /></button>
        </div>

        <div className="flex gap-1 px-5 pt-4 border-b border-zinc-800">
          {MODEL_ORDER.map((m) => (
            <button key={m} onClick={() => setTab(m)}
              className={`flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm font-medium transition
                ${tab === m ? "border-current " + MODEL_META[m].accent : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${MODEL_META[m].dot}`} />
              {MODEL_META[m].name}
            </button>
          ))}
        </div>

        <div className="p-5">
          <ModelPanel trade={trade} modelId={tab} />
        </div>
      </div>
    </div>
  );
}

// ---------- Tabs: Trade Log ----------
function TradeLogTab({ trades, onOpen, onAdd }) {
  const [filter, setFilter] = useState("all");
  const filtered = trades.filter((t) => filter === "all" ? true : t.status === filter);
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {[["all", "All"], ["win", "Wins"], ["near-miss-loss", "Near-miss"], ["low-info-loss", "Low-info"]].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3 py-1.5 rounded-md text-xs font-mono ${filter === k ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={onAdd} className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-zinc-950 text-sm font-medium px-3 py-1.5 rounded-md">
          <Plus size={16} /> Log trade
        </button>
      </div>

      <div className="border border-zinc-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-12 px-4 py-2 text-[11px] uppercase tracking-wider text-zinc-500 font-mono border-b border-zinc-800 bg-zinc-900/50">
          <div className="col-span-2">Symbol</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Entry</div>
          <div className="col-span-2">Exit</div>
          <div className="col-span-2">Agreement</div>
          <div className="col-span-2 text-right">Logged</div>
        </div>
        {filtered.map((t) => (
          <button key={t.id} onClick={() => onOpen(t.id)}
            className="w-full grid grid-cols-12 px-4 py-3 text-sm text-left hover:bg-zinc-900/60 border-b border-zinc-900 last:border-0 items-center">
            <div className="col-span-2 font-mono text-zinc-100">{t.symbol} <span className="text-zinc-600">{t.direction}</span></div>
            <div className="col-span-2"><StatusPill status={t.status} /></div>
            <div className="col-span-2 text-zinc-400 font-mono text-xs">{t.entryDate}</div>
            <div className="col-span-2 text-zinc-400 font-mono text-xs">{t.exitDate}</div>
            <div className="col-span-2 text-zinc-400 font-mono text-xs">{t.agreement}</div>
            <div className="col-span-2 text-right text-zinc-600 font-mono text-xs flex items-center justify-end gap-1">
              {t.loggedAt} <ChevronRight size={14} />
            </div>
          </button>
        ))}
        {filtered.length === 0 && <div className="px-4 py-8 text-center text-zinc-600 text-sm">No trades match this filter.</div>}
      </div>
    </div>
  );
}

// ---------- Tabs: Performance ----------
function PerformanceTab({ trades }) {
  const wins = trades.filter((t) => t.status === "win").length;
  const nearMiss = trades.filter((t) => t.status === "near-miss-loss").length;
  const lowInfo = trades.filter((t) => t.status === "low-info-loss").length;
  const total = trades.length;
  const winRate = total ? Math.round((wins / total) * 100) : 0;
  const fullAgreement = trades.filter((t) => t.agreement === "3/3").length;
  const agreementRate = total ? Math.round((fullAgreement / total) * 100) : 0;

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Trades logged" value={total} sub={`${wins} win / ${nearMiss} near-miss / ${lowInfo} low-info`} />
        <StatCard label="Win rate" value={`${winRate}%`} sub="of logged trades" />
        <StatCard label="Full agreement" value={`${agreementRate}%`} sub="all 3 analysts aligned" />
        <StatCard label="Counter-examples" value={THESES.combined.counters} sub="feeding the shared thesis" />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-3">Thesis confidence by model</div>
        <div className="space-y-3">
          {MODEL_ORDER.filter((m) => m !== "combined").map((m) => {
            const t = THESES[m];
            const pct = Math.min(100, Math.round((t.evidence / (t.evidence + t.counters)) * 100));
            return (
              <div key={m}>
                <div className="flex justify-between text-xs font-mono mb-1">
                  <span className={MODEL_META[m].accent}>{MODEL_META[m].name}</span>
                  <span className="text-zinc-500">{t.evidence} supporting · {t.counters} counter</span>
                </div>
                <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div className={`h-full ${MODEL_META[m].bg}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Tabs: Theses ----------
function ThesesTab() {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {MODEL_ORDER.map((m) => {
        const t = THESES[m];
        return (
          <div key={m} className={`bg-zinc-900 border border-zinc-800 rounded-lg p-4 ${m === "combined" ? "md:col-span-2 ring-1 " + MODEL_META[m].ring : ""}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full ${MODEL_META[m].dot}`} />
              <h4 className={`font-semibold ${MODEL_META[m].accent}`}>{MODEL_META[m].name} thesis</h4>
              <span className="text-[11px] text-zinc-600 font-mono ml-auto">updated {t.lastUpdated}</span>
            </div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1.5">Setup conditions</div>
            <ul className="space-y-1 mb-3">
              {t.setup.map((s, i) => (
                <li key={i} className="text-sm text-zinc-300 flex gap-2">
                  <span className="text-zinc-600">·</span>{s}
                </li>
              ))}
            </ul>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">Confidence</div>
            <p className="text-sm text-zinc-400">{t.confidence}</p>
          </div>
        );
      })}
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [tab, setTab] = useState("log");
  const [trades, setTrades] = useState(MOCK_TRADES);
  const [openTradeId, setOpenTradeId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    fetch("/api/trades")
      .then((r) => r.json())
      .then((realTrades) => {
        if (realTrades.length) setTrades((prev) => [...realTrades, ...prev]);
      })
      .catch(() => {}); // fine if this fails locally without the server running
  }, []);

  const openTrade = useMemo(() => trades.find((t) => t.id === openTradeId), [trades, openTradeId]);

  const addTrade = async (form) => {
    setSubmitError(null);
    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to log trade");
      const trade = await res.json();
      setTrades((prev) => [
        {
          ...trade,
          status: trade.outcome === "win" ? "win" : "near-miss-loss",
          agreement: "\u2014",
          analysis: Object.fromEntries(MODEL_ORDER.map((m) => [m, {
            verdict: "pending", confidence: 0, entryIdx: trade.entryIdx, exitIdx: trade.exitIdx, flags: [],
            text: trade.dataFetchOk && trade.dataFetchOk.databento
              ? "Real price data pulled successfully. AI analysis isn't wired up yet \u2014 this trade is stored and ready for the next build phase."
              : "Data pull had an issue (check server logs) \u2014 this trade is stored but the chart may be incomplete.",
          }])),
        },
        ...prev,
      ]);
      return true;
    } catch (err) {
      setSubmitError(err.message);
      return false;
    }
  };

  const NAV = [
    { id: "log", label: "Trade Log", Icon: FileText },
    { id: "performance", label: "Performance", Icon: LayoutDashboard },
    { id: "theses", label: "Theses", Icon: Users },
  ];

  return (
    <div className="min-h-full bg-black text-zinc-100 font-sans">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">GHOSTFLOW</h1>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">options research · 3-analyst thesis engine</p>
          </div>
          <span className="text-[11px] font-mono text-zinc-600 border border-zinc-800 rounded px-2 py-1">prototype · mock data</span>
        </div>

        <div className="flex gap-1 mb-6 border-b border-zinc-800">
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition
                ${tab === id ? "border-emerald-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === "log" && <TradeLogTab trades={trades} onOpen={setOpenTradeId} onAdd={() => setShowForm(true)} />}
        {tab === "performance" && <PerformanceTab trades={trades} />}
        {tab === "theses" && <ThesesTab />}
      </div>

      {openTrade && <TradeDetail trade={openTrade} onClose={() => setOpenTradeId(null)} />}
      {showForm && <LogTradeForm onClose={() => setShowForm(false)} onSubmit={addTrade} error={submitError} />}
    </div>
  );
}
