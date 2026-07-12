import { useState, useMemo, useRef, useEffect } from "react";
import {
  Plus, X, CheckCircle2, XCircle, AlertTriangle, ChevronRight,
  Users, FileText, LayoutDashboard, Minus, Send, MessageSquare, Clock, Copy
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
  volume:   { label: "Volume",         color: "#38bdf8" },
  gex:      { label: "GEX",            color: "#f472b6" },
  darkpool: { label: "Dark Pool",      color: "#a78bfa" },
  flow:     { label: "Flow",           color: "#facc15" },
  iv:       { label: "IV",             color: "#4ade80" },
  rs:       { label: "Relative Strength", color: "#22d3ee" },
};
const MOCK_SOURCE_NOTE = "Illustrative example \u2014 not a real data pull. Real trades must cite an actual Databento/Quant Data query here.";

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
    volumeSeries: wave(0.9, 22, 0, 0.15, 0.1).map((v, i) => Math.max(0.3, i === 5 || i === 6 ? v + 1.1 : v)),
    benchmarkSeries: wave(430, 22, 0.15, 2, 0.6),
    agreement: "3/3",
    analysis: {
      claude: {
        verdict: "signal", confidence: 82, entryIdx: 5, exitIdx: 17,
        text: "Base n' Break off the 10/20 EMA on the daily, confirmed by a volume surge 40% above the 20-day average. IV was climbing into the move rather than collapsing, which matched three prior wins in the thesis.",
        flags: [
          { idx: 5, type: "volume", label: "Volume vs 20d avg", value: "1.42M shares", baseline: "1.01M shares (20d avg)", source: MOCK_SOURCE_NOTE },
          { idx: 6, type: "iv", label: "IV expanding into move", value: "38.4% IV", baseline: "31.2% IV (5d prior)", source: MOCK_SOURCE_NOTE },
        ],
      },
      gpt: {
        verdict: "signal", confidence: 78, entryIdx: 6, exitIdx: 18,
        text: "Options flow showed sustained call buying at the 190 strike two sessions before breakout, with open interest building rather than just volume — a pattern the thesis flags as high-conviction accumulation.",
        flags: [
          { idx: 4, type: "flow", label: "Call buying, 190 strike", value: "+2,140 contracts net", baseline: "vs 0 net prior session", source: MOCK_SOURCE_NOTE },
          { idx: 5, type: "gex", label: "OI building at strike", value: "8,900 OI", baseline: "6,200 OI (prior day)", source: MOCK_SOURCE_NOTE },
        ],
      },
      grok: {
        verdict: "signal", confidence: 74, entryIdx: 5, exitIdx: 16,
        text: "Relative strength vs. QQQ was positive through the prior pullback — AAPL held higher lows while the index chopped, consistent with the 'stubborn to the downside' setup condition.",
        flags: [
          { idx: 3, type: "rs", label: "RS divergence vs QQQ", value: "AAPL held higher low", baseline: "QQQ made a lower low, same window", source: MOCK_SOURCE_NOTE },
        ],
      },
      combined: {
        verdict: "signal", confidence: 80, entryIdx: 5, exitIdx: 17,
        text: "All three analysts independently flagged the same base-and-break structure with confirming volume and flow. No material disagreement on this trade — high-confidence supporting evidence.",
        flags: [
          { idx: 5, type: "volume", label: "Volume vs 20d avg", value: "1.42M shares", baseline: "1.01M shares (20d avg)", source: MOCK_SOURCE_NOTE },
          { idx: 4, type: "flow", label: "Call buying, 190 strike", value: "+2,140 contracts net", baseline: "vs 0 net prior session", source: MOCK_SOURCE_NOTE },
          { idx: 6, type: "iv", label: "IV expanding", value: "38.4% IV", baseline: "31.2% IV (5d prior)", source: MOCK_SOURCE_NOTE },
          { idx: 3, type: "rs", label: "RS divergence vs QQQ", value: "AAPL held higher low", baseline: "QQQ made a lower low, same window", source: MOCK_SOURCE_NOTE },
        ],
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
        flags: [{ idx: 3, type: "rs", label: "Stale RS divergence", value: "NVDA underperforming SOXX", baseline: "Same gap present 14 days prior", source: MOCK_SOURCE_NOTE }],
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
  claude:   {
    setup: ["Base n' Break or Wedge Pop off the 10/20 EMA", "Volume \u2265 30-40% above 20-day average on the trigger bar", "IV expanding into the move, not collapsing"],
    confidence: "Medium \u2014 see Supporting Evidence / Counter-Examples below for the trades this is based on right now.",
    notes: "Volume threshold is the main open question \u2014 I currently require +30-40% vs the 20-day average, but Grok's bar is stricter and hasn't converged with mine yet.",
    lastUpdated: "Trade #26",
  },
  gpt:      {
    setup: ["Sustained call/put buying with rising open interest (not just volume)", "Skew shift consistent with dealer hedging pressure", "Flow precedes price, not the reverse"],
    confidence: "Medium \u2014 see Supporting Evidence / Counter-Examples below for the trades this is based on right now.",
    notes: "Open interest building (not just volume) is the key discriminator I use \u2014 several near-misses had normal volume but declining OI, which is why that distinction is now a hard requirement.",
    lastUpdated: "Trade #26",
  },
  grok:     {
    setup: ["Relative strength/weakness vs. sector ETF, especially during a pullback", "Divergence must be fresh, not already priced in for 2+ weeks", "\"Stubborn to the downside\" price action on lower timeframes"],
    confidence: "Low-Medium \u2014 see Supporting Evidence / Counter-Examples below for the trades this is based on right now.",
    notes: "I'm the most conservative of the three on volume confirmation, which is why I sometimes dissent from Claude/GPT on the same trade (see Points of Disagreement on individual trades). Not yet resolved into a shared rule.",
    lastUpdated: "Trade #26",
  },
  combined: {
    setup: ["High-confidence: Base/Wedge structure + confirming volume + confirming flow, all three agree", "Open disagreement: volume threshold for a valid 'pop' (Grok wants a higher bar than Claude/GPT \u2014 tracked, not resolved)"],
    confidence: "Reflects only trades where at least 2 of 3 analysts agree \u2014 see below for exactly which ones.",
    notes: "This view merges the 3 individual theses but preserves disagreement rather than averaging it away. A claim only appears here once 2 of 3 analysts independently support it.",
    lastUpdated: "Trade #26",
  },
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

// Price chart with type-specific indicator overlays: a volume flag renders
// real volume bars (not just a tick), an "rs" (relative strength) flag
// renders an actual overlaid benchmark line so the divergence is visible,
// not just described in prose.
function PriceChart({ prices, entryIdx, exitIdx, status, flags = [], volumeSeries, benchmarkSeries }) {
  const hasVolume = Array.isArray(volumeSeries) && volumeSeries.length === prices.length && flags.some((f) => f.type === "volume");
  const hasRS = Array.isArray(benchmarkSeries) && benchmarkSeries.length === prices.length && flags.some((f) => f.type === "rs");

  const w = 640, pad = 24;
  const H = hasVolume ? 260 : 200;
  const priceBottom = hasVolume ? 150 : H - 34;
  const volumeTop = 160, volumeBottom = 208;
  const flagRowY = H - 6;

  const min = Math.min(...prices), max = Math.max(...prices);
  const x = (i) => pad + (i / (prices.length - 1)) * (w - pad * 2);
  const y = (v) => priceBottom - ((v - min) / (max - min || 1)) * (priceBottom - pad);
  const pts = prices.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const lineColor = status === "win" ? "#34d399" : status === "near-miss-loss" ? "#fbbf24" : "#71717a";

  let benchPts = null;
  if (hasRS) {
    const bMin = Math.min(...benchmarkSeries), bMax = Math.max(...benchmarkSeries);
    const by = (v) => priceBottom - ((v - bMin) / (bMax - bMin || 1)) * (priceBottom - pad);
    benchPts = benchmarkSeries.map((v, i) => `${x(i)},${by(v)}`).join(" ");
  }

  const volMax = hasVolume ? Math.max(...volumeSeries) : 1;
  const flaggedVolumeIdx = new Set(flags.filter((f) => f.type === "volume").map((f) => f.idx));

  return (
    <svg viewBox={`0 0 ${w} ${H}`} className="w-full" style={{ height: hasVolume ? 260 : 200 }}>
      {hasRS && (
        <>
          <polyline points={benchPts} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4,3" opacity="0.7" />
          <text x={w - pad} y={pad - 8} fontSize="10" fill="#22d3ee" fontFamily="monospace" textAnchor="end">- - - benchmark (normalized)</text>
        </>
      )}
      <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" />
      <circle cx={x(entryIdx)} cy={y(prices[entryIdx])} r="4.5" fill="#e4e4e7" />
      <text x={x(entryIdx)} y={y(prices[entryIdx]) - 10} fontSize="10" fill="#a1a1aa" fontFamily="monospace" textAnchor="middle">ENTRY</text>
      <circle cx={x(exitIdx)} cy={y(prices[exitIdx])} r="4.5" fill={lineColor} />
      <text x={x(exitIdx)} y={y(prices[exitIdx]) - 10} fontSize="10" fill={lineColor} fontFamily="monospace" textAnchor="middle">
        {status === "win" ? "EXIT (target)" : "EXIT (stop)"}
      </text>

      {hasVolume && (
        <>
          <text x={pad} y={volumeTop - 6} fontSize="9" fill="#71717a" fontFamily="monospace">VOLUME</text>
          {volumeSeries.map((v, i) => {
            const barW = Math.max(2, (w - pad * 2) / volumeSeries.length - 2);
            const barH = (v / (volMax || 1)) * (volumeBottom - volumeTop);
            const flagged = flaggedVolumeIdx.has(i);
            return (
              <rect key={i} x={x(i) - barW / 2} y={volumeBottom - barH} width={barW} height={barH}
                fill={flagged ? "#38bdf8" : "#3f3f46"} opacity={flagged ? 1 : 0.7} />
            );
          })}
        </>
      )}

      {/* indicator overlay ticks, connecting price/volume area down to a marker row */}
      {flags.map((f, i) => {
        const meta = INDICATOR_META[f.type] || { color: "#a1a1aa", label: f.type };
        return (
          <g key={i}>
            <line x1={x(f.idx)} y1={pad} x2={x(f.idx)} y2={flagRowY} stroke={meta.color} strokeWidth="1" strokeDasharray="2,3" opacity="0.4" />
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
    <div className="space-y-2">
      {flags.map((f, i) => {
        const meta = INDICATOR_META[f.type] || { color: "#a1a1aa", label: f.type };
        return (
          <div key={i} className="text-xs font-mono px-2.5 py-2 rounded bg-zinc-900 border border-zinc-800">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: meta.color }} />
              <span className="text-zinc-400">{meta.label}:</span>
              <span className="text-zinc-200">{f.label}</span>
            </div>
            {(f.value || f.baseline) && (
              <div className="text-zinc-500 pl-3.5">
                {f.value && <span className="text-zinc-300">{f.value}</span>}
                {f.value && f.baseline && <span> vs </span>}
                {f.baseline && <span>{f.baseline}</span>}
              </div>
            )}
            {f.source && <div className="text-zinc-600 pl-3.5 italic mt-0.5">Source: {f.source}</div>}
          </div>
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
      <PriceChart
        prices={trade.prices} entryIdx={a.entryIdx} exitIdx={a.exitIdx} status={trade.status} flags={a.flags}
        volumeSeries={trade.volumeSeries} benchmarkSeries={trade.benchmarkSeries}
      />
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

function copyToClipboard(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const diff = (new Date(b) - new Date(a)) / 86400000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}

function returnPct(entry, exit) {
  const e = Number(entry), x = Number(exit);
  if (!e || !x) return null;
  return ((x - e) / e) * 100;
}

// A compact per-trade summary widget, styled after a backtest-result card:
// status header + id, then a metric grid, then a "view trade" action.
function TradeCard({ trade, onOpen }) {
  const combined = trade.analysis?.combined;
  const isPending = trade.analysisStatus === "pending" || combined?.verdict === "pending";
  const ret = returnPct(trade.entryPrice, trade.exitPrice);
  const held = daysBetween(trade.entryDate, trade.exitDate);
  const flagCount = combined?.flags?.length ?? 0;

  const headerMeta = isPending
    ? { Icon: Clock, cls: "text-zinc-400", label: "Awaiting AI analysis" }
    : trade.status === "win"
    ? { Icon: CheckCircle2, cls: "text-emerald-400", label: "Analysis complete" }
    : trade.status === "near-miss-loss"
    ? { Icon: AlertTriangle, cls: "text-amber-400", label: "Analysis complete \u2014 counter-example" }
    : { Icon: Minus, cls: "text-zinc-500", label: "Analysis complete \u2014 low info" };
  const HeaderIcon = headerMeta.Icon;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className={`flex items-center gap-1.5 text-sm font-medium ${headerMeta.cls}`}>
          <HeaderIcon size={15} /> {headerMeta.label}
        </div>
        <button
          onClick={() => copyToClipboard(trade.id)}
          className="flex items-center gap-1 text-[11px] font-mono text-zinc-600 hover:text-zinc-400 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5"
          title="Copy trade ID">
          ID: {String(trade.id).slice(-6)} <Copy size={11} />
        </button>
      </div>

      <div className="text-base font-semibold text-zinc-100 mb-1">
        {trade.symbol} <span className="text-zinc-500 font-mono text-sm">{trade.direction}</span>
      </div>
      <div className="text-xs font-mono text-zinc-500 mb-3">
        {trade.entryDate || "\u2014"} ~ {trade.exitDate || "\u2014"}
      </div>

      <div className="border-t border-zinc-800 pt-3 grid grid-cols-3 gap-y-3 gap-x-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Return</div>
          <div className={`text-sm font-mono font-semibold ${ret == null ? "text-zinc-600" : ret >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {ret == null ? "\u2014" : `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Days held</div>
          <div className="text-sm font-mono font-semibold text-zinc-200">{held ?? "\u2014"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Agreement</div>
          <div className="text-sm font-mono font-semibold text-zinc-200">{trade.agreement || "\u2014"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Confidence</div>
          <div className="text-sm font-mono font-semibold text-zinc-200">{combined && combined.confidence > 0 ? `${combined.confidence}%` : "\u2014"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Indicators</div>
          <div className="text-sm font-mono font-semibold text-zinc-200">{flagCount || "\u2014"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Status</div>
          <div className="text-sm"><StatusPill status={trade.status} /></div>
        </div>
      </div>

      <button onClick={() => onOpen(trade.id)}
        className="mt-4 w-full flex items-center justify-center gap-1.5 bg-zinc-950 hover:bg-black border border-zinc-800 text-zinc-200 text-sm font-medium py-2 rounded-md transition">
        View trade <ChevronRight size={14} />
      </button>
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

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((t) => <TradeCard key={t.id} trade={t} onOpen={onOpen} />)}
        {filtered.length === 0 && (
          <div className="col-span-full px-4 py-8 text-center text-zinc-600 text-sm border border-zinc-800 rounded-lg">
            No trades match this filter.
          </div>
        )}
      </div>
    </div>
  );
}

// A clickable list of trades used to back up a stat — every number in
// Performance/Theses should be traceable to this kind of list, not a bare figure.
function TradeMiniList({ trades, onOpen, emptyText = "No trades match." }) {
  if (trades.length === 0) return <p className="text-xs text-zinc-600 italic px-1">{emptyText}</p>;
  return (
    <div className="space-y-1">
      {trades.map((t) => (
        <button key={t.id} onClick={() => onOpen(t.id)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-zinc-950 hover:bg-black border border-zinc-800 text-left">
          <span className="font-mono text-xs text-zinc-200">{t.symbol} <span className="text-zinc-600">{t.direction}</span></span>
          <span className="flex items-center gap-2">
            <StatusPill status={t.status} />
            <ChevronRight size={12} className="text-zinc-600" />
          </span>
        </button>
      ))}
    </div>
  );
}

// A stat card that expands in place to show the underlying trades behind the number.
function ExpandableStat({ label, value, sub, isOpen, onToggle, children }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full text-left px-4 py-3 hover:bg-zinc-900/60">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono">{label}</div>
            <div className="text-2xl font-mono text-zinc-100 mt-1">{value}</div>
            {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
          </div>
          <ChevronRight size={16} className={`text-zinc-600 mt-1 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        </div>
      </button>
      {isOpen && <div className="px-3 pb-3 pt-1 border-t border-zinc-800">{children}</div>}
    </div>
  );
}

// ---------- Tabs: Performance ----------
function PerformanceTab({ trades, onOpen }) {
  const [expanded, setExpanded] = useState(null);
  const toggle = (key) => setExpanded((cur) => (cur === key ? null : key));

  const wins = trades.filter((t) => t.status === "win");
  const nearMiss = trades.filter((t) => t.status === "near-miss-loss");
  const lowInfo = trades.filter((t) => t.status === "low-info-loss");
  const total = trades.length;
  const winRate = total ? Math.round((wins.length / total) * 100) : 0;
  const fullAgreementTrades = trades.filter((t) => t.agreement === "3/3");
  const agreementRate = total ? Math.round((fullAgreementTrades.length / total) * 100) : 0;
  const counterTrades = trades.filter((t) => t.analysis?.combined?.verdict === "contrast");

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <ExpandableStat label="Trades logged" value={total} sub={`${wins.length} win / ${nearMiss.length} near-miss / ${lowInfo.length} low-info`}
          isOpen={expanded === "total"} onToggle={() => toggle("total")}>
          <TradeMiniList trades={trades} onOpen={onOpen} />
        </ExpandableStat>
        <ExpandableStat label="Win rate" value={`${winRate}%`} sub="of logged trades"
          isOpen={expanded === "winrate"} onToggle={() => toggle("winrate")}>
          <TradeMiniList trades={wins} onOpen={onOpen} emptyText="No wins logged yet." />
        </ExpandableStat>
        <ExpandableStat label="Full agreement" value={`${agreementRate}%`} sub="all 3 analysts aligned"
          isOpen={expanded === "agreement"} onToggle={() => toggle("agreement")}>
          <TradeMiniList trades={fullAgreementTrades} onOpen={onOpen} emptyText="No trades with full 3/3 agreement yet." />
        </ExpandableStat>
        <ExpandableStat label="Counter-examples" value={counterTrades.length} sub="feeding the shared thesis"
          isOpen={expanded === "counters"} onToggle={() => toggle("counters")}>
          <TradeMiniList trades={counterTrades} onOpen={onOpen} emptyText="No counter-examples yet." />
        </ExpandableStat>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-3">
          Thesis confidence by model <span className="text-zinc-600 normal-case">(computed from the trades below \u2014 click a model to see them)</span>
        </div>
        <div className="space-y-3">
          {MODEL_ORDER.filter((m) => m !== "combined").map((m) => {
            const supporting = trades.filter((t) => t.analysis?.[m]?.verdict === "signal");
            const counter = trades.filter((t) => t.analysis?.[m]?.verdict === "contrast");
            const denom = supporting.length + counter.length;
            const pct = denom ? Math.round((supporting.length / denom) * 100) : 0;
            const key = "model-" + m;
            return (
              <div key={m}>
                <button onClick={() => toggle(key)} className="w-full text-left">
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className={MODEL_META[m].accent}>{MODEL_META[m].name}</span>
                    <span className="text-zinc-500">{supporting.length} supporting · {counter.length} counter</span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div className={`h-full ${MODEL_META[m].bg}`} style={{ width: `${pct}%` }} />
                  </div>
                </button>
                {expanded === key && (
                  <div className="mt-2 grid sm:grid-cols-2 gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-mono mb-1">Supporting</div>
                      <TradeMiniList trades={supporting} onOpen={onOpen} emptyText="None yet." />
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-mono mb-1">Counter-examples</div>
                      <TradeMiniList trades={counter} onOpen={onOpen} emptyText="None yet." />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Tabs: Theses ----------
// 4 fully independent sub-tabs (Claude/GPT/Grok/Combined), each with the same
// structure: Setup Conditions, Confidence, Supporting Evidence, Counter-Examples,
// Notes \u2014 all traceable back to the actual logged trades, not static numbers.
function ThesesTab({ trades, onOpen }) {
  const [tab, setTab] = useState("combined");
  const t = THESES[tab];
  const supporting = trades.filter((tr) => tr.analysis?.[tab]?.verdict === "signal");
  const counter = trades.filter((tr) => tr.analysis?.[tab]?.verdict === "contrast");

  return (
    <div>
      <div className="flex gap-1 mb-4 border-b border-zinc-800">
        {MODEL_ORDER.map((m) => (
          <button key={m} onClick={() => setTab(m)}
            className={`flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm font-medium transition
              ${tab === m ? "border-current " + MODEL_META[m].accent : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${MODEL_META[m].dot}`} />
            {MODEL_META[m].name}
          </button>
        ))}
      </div>

      <div className={`bg-zinc-900 border border-zinc-800 rounded-lg p-4 ${tab === "combined" ? "ring-1 " + MODEL_META[tab].ring : ""}`}>
        <div className="flex items-center gap-2 mb-4">
          <span className={`w-2 h-2 rounded-full ${MODEL_META[tab].dot}`} />
          <h4 className={`font-semibold ${MODEL_META[tab].accent}`}>{MODEL_META[tab].name} thesis</h4>
          <span className="text-[11px] text-zinc-600 font-mono ml-auto">updated {t.lastUpdated}</span>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1.5">Setup conditions</div>
            <ul className="space-y-1 mb-4">
              {t.setup.map((s, i) => (
                <li key={i} className="text-sm text-zinc-300 flex gap-2">
                  <span className="text-zinc-600">·</span>{s}
                </li>
              ))}
            </ul>

            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">Confidence</div>
            <p className="text-sm text-zinc-400 mb-4">{t.confidence}</p>

            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">Notes</div>
            <p className="text-sm text-zinc-400">{t.notes}</p>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1.5">
              Supporting evidence <span className="text-zinc-600 normal-case">({supporting.length})</span>
            </div>
            <TradeMiniList trades={supporting} onOpen={onOpen} emptyText="No supporting trades logged yet." />

            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1.5 mt-4">
              Counter-examples <span className="text-zinc-600 normal-case">({counter.length})</span>
            </div>
            <TradeMiniList trades={counter} onOpen={onOpen} emptyText="No counter-examples logged yet." />
          </div>
        </div>
      </div>
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
        {tab === "performance" && <PerformanceTab trades={trades} onOpen={setOpenTradeId} />}
        {tab === "theses" && <ThesesTab trades={trades} onOpen={setOpenTradeId} />}
      </div>

      {openTrade && <TradeDetail trade={openTrade} onClose={() => setOpenTradeId(null)} />}
      {showForm && <LogTradeForm onClose={() => setShowForm(false)} onSubmit={addTrade} error={submitError} />}
    </div>
  );
}
