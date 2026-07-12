import { useState, useEffect, useMemo } from "react";
import {
  Plus, X, CheckCircle2, XCircle, Minus, ChevronRight, Clock, Search,
  FileText, LayoutDashboard, Settings, ExternalLink, AlertTriangle, Zap, FlaskConical, Eye, EyeOff
} from "lucide-react";

const MODEL_META = {
  claude: { name: "Claude", accent: "text-amber-400", dot: "bg-amber-400", hex: "#fbbf24" },
  gpt:    { name: "GPT",    accent: "text-emerald-400", dot: "bg-emerald-400", hex: "#34d399" },
  grok:   { name: "Grok",   accent: "text-violet-400", dot: "bg-violet-400", hex: "#a78bfa" },
};
const MODEL_IDS = ["claude", "gpt", "grok"];

const BILLING_LINKS = [
  { name: "OpenAI (GPT)", url: "https://platform.openai.com/settings/organization/billing/overview", accent: "text-emerald-400", dot: "bg-emerald-400" },
  { name: "Anthropic (Claude)", url: "https://platform.claude.com/dashboard", accent: "text-amber-400", dot: "bg-amber-400" },
  { name: "xAI (Grok)", url: "https://console.x.ai", accent: "text-violet-400", dot: "bg-violet-400" },
];

// ---------- primitives ----------
function Verdict({ v }) {
  const map = {
    tradeable: { label: "TRADEABLE", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", Icon: CheckCircle2 },
    not_tradeable: { label: "NOT TRADEABLE", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30", Icon: Minus },
  };
  const m = map[v] || map.not_tradeable;
  const I = m.Icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-mono ${m.cls}`}>
      <I size={13} /> {m.label}
    </span>
  );
}

// THE FEED AUDIT — the visual proof that a model actually looked at all 30.
// Three states, and the distinction between the last two is the whole point:
//   USED     (green)  — examined AND incorporated into the thesis
//   EXAMINED (grey)   — looked at, judged irrelevant. This is a GOOD outcome.
//   SKIPPED  (red)    — the model failed to report on it. A real defect.
function FeedAudit({ review }) {
  const [showAll, setShowAll] = useState(false);
  if (!review?.length) return <p className="text-xs text-zinc-600 italic">No feed review returned.</p>;

  const used = review.filter((r) => r.used);
  const examined = review.filter((r) => !r.used && r.reviewed);
  const skipped = review.filter((r) => !r.reviewed);
  const visible = showAll ? review : [...used, ...skipped];

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 text-[11px] font-mono">
        <span className="text-emerald-400">{used.length} used</span>
        <span className="text-zinc-500">{examined.length} examined, not used</span>
        {skipped.length > 0
          ? <span className="text-red-400">{skipped.length} SKIPPED</span>
          : <span className="text-zinc-600">0 skipped</span>}
        <button onClick={() => setShowAll((s) => !s)}
          className="ml-auto flex items-center gap-1 text-zinc-500 hover:text-zinc-300">
          {showAll ? <EyeOff size={12} /> : <Eye size={12} />}
          {showAll ? "hide" : `show all ${review.length}`}
        </button>
      </div>

      {/* Compact strip: one cell per feed, so "did it look at everything?" is answerable at a glance. */}
      <div className="flex flex-wrap gap-1 mb-3">
        {review.map((r) => (
          <span key={r.id} title={`${r.id}: ${r.used ? "USED" : r.reviewed ? "examined, not used" : "SKIPPED"}`}
            className={`w-2.5 h-2.5 rounded-sm ${!r.reviewed ? "bg-red-500" : r.used ? "bg-emerald-400" : "bg-zinc-700"}`} />
        ))}
      </div>

      <div className="space-y-1.5">
        {visible.map((r) => (
          <div key={r.id} className={`text-xs px-2.5 py-2 rounded border ${
            !r.reviewed ? "bg-red-500/5 border-red-500/30"
            : r.used ? "bg-emerald-500/5 border-emerald-500/20"
            : "bg-zinc-900 border-zinc-800"}`}>
            <div className="flex items-center gap-1.5 mb-1">
              {!r.reviewed ? <XCircle size={12} className="text-red-400 flex-shrink-0" />
                : r.used ? <CheckCircle2 size={12} className="text-emerald-400 flex-shrink-0" />
                : <Minus size={12} className="text-zinc-600 flex-shrink-0" />}
              <span className="font-mono text-zinc-300">{r.id}</span>
              <span className={`ml-auto text-[10px] font-mono ${!r.reviewed ? "text-red-400" : r.used ? "text-emerald-400" : "text-zinc-600"}`}>
                {!r.reviewed ? "SKIPPED" : r.used ? "USED" : "not used"}
              </span>
            </div>
            <p className="text-zinc-400 leading-relaxed pl-[18px]">{r.notes}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function BacktestPanel({ analysisId, modelId, rule, existing, onDone }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(existing || null);
  const [err, setErr] = useState(null);

  const run = async () => {
    setRunning(true); setErr(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/backtest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, sessions: 20, holdMinutes: 15 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backtest failed");
      setResult(data); onDone?.(modelId, data);
    } catch (e) { setErr(e.message); }
    setRunning(false);
  };

  if (!rule) {
    return (
      <div className="mt-4 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-950/60">
        <p className="text-xs text-zinc-500">This model proposed no rule — it concluded nothing here was tradeable. Nothing to backtest, which is a legitimate outcome.</p>
      </div>
    );
  }

  // The verdict wording comes straight from the engine, including when it's bad
  // news. A rule that fails is displayed as prominently as one that passes.
  const failed = result && (result.verdict?.startsWith("DOES NOT") || result.verdict?.startsWith("NEVER") || result.verdict?.startsWith("INSUFFICIENT"));

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical size={14} className="text-zinc-500" />
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono">Backtest — does this rule survive other days?</span>
        {!result && (
          <button onClick={run} disabled={running}
            className="ml-auto text-xs px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50">
            {running ? "Running 20 sessions…" : "Run backtest"}
          </button>
        )}
      </div>

      {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

      {result && (
        <div className={`px-3 py-3 rounded-lg border ${failed ? "bg-red-500/5 border-red-500/30" : "bg-emerald-500/5 border-emerald-500/30"}`}>
          <div className={`text-sm font-medium mb-2 ${failed ? "text-red-400" : "text-emerald-400"}`}>
            {result.verdict}
          </div>
          {result.totalTrades > 0 && (
            <div className="grid grid-cols-4 gap-2 text-center">
              {[["Trades", result.totalTrades], ["Win rate", `${result.winRate}%`],
                ["Avg/trade", `${result.avgReturnPct}%`], ["Profit factor", result.profitFactor]].map(([k, v]) => (
                <div key={k}>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">{k}</div>
                  <div className="text-sm font-mono text-zinc-200">{v}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelPanel({ record, modelId, onBacktestDone }) {
  const a = record.analysis?.[modelId];
  if (!a) return <p className="text-sm text-zinc-500">No analysis.</p>;
  if (a.failed) {
    return (
      <div className="px-3 py-3 rounded-lg border border-red-500/30 bg-red-500/5">
        <p className="text-sm text-red-400">{a.reasoning}</p>
        <p className="text-xs text-zinc-500 mt-1">This model has NO opinion on this session — it is excluded from the agreement count, not counted as a vote.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <Verdict v={a.verdict} />
        {a.confidence > 0 && <span className="text-xs font-mono text-zinc-500">confidence {a.confidence}%</span>}
      </div>

      {a.entry?.timestamp ? (
        <div className="mb-4 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-950/60">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap size={13} style={{ color: MODEL_META[modelId].hex }} />
            <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono">Entry it would have taken</span>
          </div>
          <div className="text-lg font-mono text-zinc-100">
            {a.entry.timestamp}
            {a.entry.leadMinutes != null && <span className="text-xs text-zinc-500 ml-2">{a.entry.leadMinutes} min before the move</span>}
          </div>
          <p className="text-sm text-zinc-400 mt-1 leading-relaxed">{a.entry.reasoning}</p>
          {a.entry.corroboratingFeeds?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {a.entry.corroboratingFeeds.map((f) => (
                <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{f}</span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mb-4 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-950/60">
          <p className="text-sm text-zinc-400">No defensible entry. This model concluded the move was not knowable in advance — a legitimate and useful finding.</p>
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">Reasoning</div>
      <p className="text-sm text-zinc-300 leading-relaxed mb-4">{a.reasoning}</p>

      {a.rule && (
        <>
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">Proposed rule</div>
          <p className="text-sm text-zinc-300 leading-relaxed mb-2 font-mono bg-zinc-900 border border-zinc-800 rounded px-2.5 py-2">{a.rule.description}</p>
        </>
      )}

      {a.falsification && (
        <>
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">What would prove it wrong</div>
          <p className="text-sm text-zinc-400 leading-relaxed mb-4">{a.falsification}</p>
        </>
      )}

      <BacktestPanel analysisId={record.id} modelId={modelId} rule={a.rule}
        existing={record.backtests?.[modelId]} onDone={onBacktestDone} />

      <div className="mt-5">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-2">
          Feed audit — all {a.endpointReview?.length ?? 0} data feeds
        </div>
        <FeedAudit review={a.endpointReview} />
      </div>
    </div>
  );
}

function Timeline({ timeline }) {
  if (!timeline?.priceThrusts?.length) {
    return <p className="text-xs text-zinc-500 italic">No statistically significant price move detected this session.</p>;
  }
  return (
    <div className="space-y-2">
      {timeline.priceThrusts.map((t, i) => {
        const ll = timeline.leadLag?.[i];
        return (
          <div key={i} className="px-3 py-2 rounded border border-zinc-800 bg-zinc-900">
            <div className="flex items-center gap-2 text-sm font-mono">
              <span className={t.direction === "UP" ? "text-emerald-400" : "text-red-400"}>
                {t.direction} {t.pctMove}%
              </span>
              <span className="text-zinc-500">{t.startClock} → {t.endClock}</span>
              <span className="text-zinc-600 text-xs ml-auto">{t.z}σ</span>
            </div>
            {ll && (
              <div className="text-xs text-zinc-500 mt-1">
                {ll.precursorCount === 0
                  ? "Nothing fired in advance — this move was likely not knowable."
                  : `${ll.precursorCount} precursor signals across ${ll.corroborationScore} feeds: ${ll.corroboratingFeeds.join(", ")}`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AnalysisDetail({ record, onClose, onBacktestDone }) {
  const [tab, setTab] = useState("claude");
  const combined = record.analysis?.combined;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="flex items-center gap-3">
            <h3 className="text-zinc-100 font-semibold text-lg">{record.symbol}</h3>
            <span className="text-xs font-mono text-zinc-500">{record.sessionDate}</span>
            {combined && <Verdict v={combined.verdict} />}
            <span className="text-xs font-mono text-zinc-600">agreement {record.agreement}</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 border-b border-zinc-800">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-2">
            Price moves detected (computed, not opinion)
          </div>
          <Timeline timeline={record.briefing?.timeline} />
          {record.briefing?.fetchReport && (
            <p className="text-[11px] font-mono text-zinc-600 mt-2">
              {record.briefing.fetchReport.succeeded}/{record.briefing.fetchReport.attempted} feeds fetched successfully
            </p>
          )}
        </div>

        <div className="flex gap-1 px-5 pt-4 border-b border-zinc-800">
          {MODEL_IDS.map((m) => {
            const a = record.analysis?.[m];
            return (
              <button key={m} onClick={() => setTab(m)}
                className={`flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm font-medium transition
                  ${tab === m ? "border-current " + MODEL_META[m].accent : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${MODEL_META[m].dot}`} />
                {MODEL_META[m].name}
                {a && !a.failed && <span className="text-[10px] text-zinc-600">{a.usedCount}/{a.endpointReview?.length}</span>}
              </button>
            );
          })}
        </div>

        <div className="p-5">
          <ModelPanel record={record} modelId={tab} onBacktestDone={onBacktestDone} />
        </div>
      </div>
    </div>
  );
}

function AnalyzeForm({ onClose, onSubmit, error, running }) {
  const [mode, setMode] = useState("stock");
  const [f, setF] = useState({ symbol: "", sessionDate: "", strikePrice: "", contractType: "CALL", expirationDate: "" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-zinc-100 font-semibold">Analyze a session</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X size={18} /></button>
        </div>

        <div className="flex gap-1 mb-4 p-1 bg-zinc-900 rounded-lg">
          {[["stock", "Stock"], ["options", "Options"]].map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`flex-1 py-1.5 rounded text-sm font-medium ${mode === k ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500 font-mono">SYMBOL</label>
              <input value={f.symbol} onChange={set("symbol")} placeholder="META"
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 font-mono">SESSION DATE</label>
              <input type="date" value={f.sessionDate} onChange={set("sessionDate")}
                className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
            </div>
          </div>

          {mode === "options" && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-zinc-500 font-mono">STRIKE</label>
                <input value={f.strikePrice} onChange={set("strikePrice")} placeholder="700"
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm" />
              </div>
              <div>
                <label className="text-xs text-zinc-500 font-mono">TYPE</label>
                <select value={f.contractType} onChange={set("contractType")}
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm">
                  <option>CALL</option><option>PUT</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-500 font-mono">EXPIRY</label>
                <input type="date" value={f.expirationDate} onChange={set("expirationDate")}
                  className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm" />
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => onSubmit({
            symbol: f.symbol, sessionDate: f.sessionDate,
            contract: mode === "options" && f.strikePrice && f.expirationDate
              ? { strikePrice: f.strikePrice, contractType: f.contractType, expirationDate: f.expirationDate }
              : null,
          })}
          disabled={!f.symbol || !f.sessionDate || running}
          className="w-full mt-5 py-2 rounded bg-emerald-600 text-zinc-950 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40">
          {running ? "Pulling 30 feeds, running 3 analysts…" : "Analyze"}
        </button>

        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        <p className="text-[11px] text-zinc-600 mt-3 leading-relaxed">
          You give a symbol and a date. The system finds the moves itself, then asks all 3 analysts whether they were knowable in advance — using only data that existed before each move. Takes ~1-2 min.
        </p>
      </div>
    </div>
  );
}

function AnalysisCard({ record, onOpen }) {
  const c = record.analysis?.combined;
  const thrusts = record.briefing?.timeline?.priceThrusts?.length ?? 0;
  const entries = c?.entries ? Object.values(c.entries).filter((e) => e?.timestamp) : [];

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        {c ? <Verdict v={c.verdict} /> : <span className="text-xs text-zinc-500 font-mono">pending</span>}
        <span className="text-[11px] font-mono text-zinc-600">agreement {record.agreement}</span>
      </div>
      <div className="text-base font-semibold text-zinc-100">{record.symbol}</div>
      <div className="text-xs font-mono text-zinc-500 mb-3">{record.sessionDate}</div>

      <div className="border-t border-zinc-800 pt-3 grid grid-cols-3 gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Moves</div>
          <div className="text-sm font-mono text-zinc-200">{thrusts}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Entries</div>
          <div className="text-sm font-mono text-zinc-200">{entries.length}/3</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Feeds</div>
          <div className="text-sm font-mono text-zinc-200">{record.briefing?.fetchReport?.succeeded ?? "—"}</div>
        </div>
      </div>

      <button onClick={() => onOpen(record.id)}
        className="mt-4 w-full flex items-center justify-center gap-1.5 bg-zinc-950 hover:bg-black border border-zinc-800 text-zinc-200 text-sm font-medium py-2 rounded-md">
        View analysis <ChevronRight size={14} />
      </button>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("log");
  const [records, setRecords] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetch("/api/analyses").then((r) => r.json())
      .then((rs) => Array.isArray(rs) && setRecords(rs))
      .catch(() => {});
  }, []);

  const open = useMemo(() => records.find((r) => r.id === openId), [records, openId]);

  const analyze = async (form) => {
    setRunning(true); setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setRecords((p) => [data, ...p]);
      setShowForm(false);
      setOpenId(data.id);
    } catch (e) { setError(e.message); }
    setRunning(false);
  };

  const onBacktestDone = (modelId, result) => {
    setRecords((prev) => prev.map((r) => r.id === openId
      ? { ...r, backtests: { ...(r.backtests || {}), [modelId]: result } } : r));
  };

  const NAV = [
    { id: "log", label: "Analyses", Icon: FileText },
    { id: "settings", label: "Settings", Icon: Settings },
  ];

  return (
    <div className="min-h-full bg-black text-zinc-100 font-sans">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">GHOSTFLOW</h1>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">signal discovery · 3-analyst engine · 30 live feeds</p>
          </div>
          <span className="text-[11px] font-mono text-zinc-600 border border-zinc-800 rounded px-2 py-1">
            was it knowable in advance?
          </span>
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

        {tab === "log" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-zinc-500">Enter a symbol and a date. The system finds the moves itself.</p>
              <button onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-zinc-950 text-sm font-medium px-3 py-1.5 rounded-md">
                <Search size={16} /> Analyze session
              </button>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {records.map((r) => <AnalysisCard key={r.id} record={r} onOpen={setOpenId} />)}
              {records.length === 0 && (
                <div className="col-span-full px-4 py-10 text-center text-zinc-600 text-sm border border-zinc-800 rounded-lg">
                  No analyses yet. Run one to get started.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="max-w-xl bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono mb-1">AI provider billing</div>
            <p className="text-xs text-zinc-500 mb-3">Top up token balance for each model this system calls.</p>
            <div className="space-y-2">
              {BILLING_LINKS.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-between px-3 py-2.5 rounded bg-zinc-950 hover:bg-black border border-zinc-800">
                  <span className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full ${l.dot}`} />
                    <span className={l.accent}>{l.name}</span>
                  </span>
                  <ExternalLink size={14} className="text-zinc-600" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {showForm && <AnalyzeForm onClose={() => setShowForm(false)} onSubmit={analyze} error={error} running={running} />}
      {open && <AnalysisDetail record={open} onClose={() => setOpenId(null)} onBacktestDone={onBacktestDone} />}
    </div>
  );
}
