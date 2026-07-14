import { useState, useEffect, useMemo } from "react";
import {
  X, CheckCircle2, XCircle, Minus, ChevronRight, Search, Sun, Moon,
  FileText, Settings, ExternalLink, AlertTriangle, Zap, FlaskConical,
  RefreshCw, Target, ListFilter, Table2, LineChart, Users, CalendarDays
} from "lucide-react";
import ChartView from "./ChartView.jsx";
import StrategyLab from "./StrategyLab.jsx";

const MODEL_META = {
  claude: { name: "Claude", accent: "text-amber-500", dot: "bg-amber-500", hex: "#f59e0b" },
  gpt:    { name: "GPT",    accent: "text-emerald-500", dot: "bg-emerald-500", hex: "#10b981" },
  grok:   { name: "Grok",   accent: "text-violet-500", dot: "bg-violet-500", hex: "#8b5cf6" },
};
const MODEL_IDS = ["claude", "gpt", "grok"];

const BILLING_LINKS = [
  { name: "OpenAI (GPT)", url: "https://platform.openai.com/settings/organization/billing/overview", accent: "text-emerald-500", dot: "bg-emerald-500" },
  { name: "Anthropic (Claude)", url: "https://platform.claude.com/dashboard", accent: "text-amber-500", dot: "bg-amber-500" },
  { name: "xAI (Grok)", url: "https://console.x.ai", accent: "text-violet-500", dot: "bg-violet-500" },
];

// Role colours. The SIGNAL/CONFIRMATION/NOISE distinction is the core mental
// model, so it gets a consistent visual language everywhere it appears.
const ROLE_STYLE = {
  SIGNAL:       { cls: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10", label: "SIGNAL" },
  CONFIRMATION: { cls: "text-sky-600 dark:text-sky-400 border-sky-500/40 bg-sky-500/10", label: "CONFIRMATION" },
  NOISE:        { cls: "text-zinc-500 border-zinc-400/30 bg-zinc-500/5", label: "noise" },
  NOT_REVIEWED: { cls: "text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10", label: "NOT REVIEWED" },
  "ANTI-CONFIRMATION": { cls: "text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10", label: "ANTI-CONFIRM" },
  UNTESTABLE:   { cls: "text-zinc-500 border-zinc-400/30 bg-zinc-500/5", label: "untestable" },
  ERROR:        { cls: "text-red-500 border-red-500/40 bg-red-500/10", label: "error" },
};

function RoleBadge({ role }) {
  const s = ROLE_STYLE[role] || ROLE_STYLE.NOISE;
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${s.cls}`}>{s.label}</span>;
}

// A record is STALE if it lacks fields the current engine always produces.
// Old records were generated before gamma_proximity, session metrics, feed
// roles, etc. existed — their conclusions were reached without that data and
// should not be trusted or quietly displayed as if they were current.
function isStale(record) {
  const b = record.briefing;
  if (!b) return true;
  if (!b.sessionMetrics || !Object.keys(b.sessionMetrics).length) return true;
  if (!b.fetchReport) return true;
  // Chart data. Records made before priceSeries existed pass every other check
  // (they have feed roles, session metrics) and therefore looked "current" —
  // right up until you clicked Chart and got an empty screen. A record without
  // the data its own UI needs IS stale, so it belongs in this check.
  if (!b.priceSeries?.length) return true;
  // The multi-session window. Single-session records predate it.
  if (!b.sessions?.length) return true;
  // Feed roles (SIGNAL/CONFIRMATION/NOISE) only exist in the new schema.
  const anyReview = MODEL_IDS.map((m) => record.analysis?.[m]?.endpointReview).find((r) => r?.length);
  if (anyReview && !anyReview[0].role) return true;
  return false;
}

function RerunBanner({ record, onRerun, running, onDelete }) {
  // Legacy trade-era records have no sessionDate at all — they predate the
  // pivot away from trade logging. A re-run can still salvage them via
  // entryDate, but if neither exists there is nothing to re-run.
  const salvageable = !!(record.sessionDate || record.entryDate) && !!record.symbol;

  return (
    <div className="px-3 py-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 flex items-start gap-2">
      <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
          <strong>This analysis is stale.</strong> It was produced by an older engine — before intraday gamma, the full metric vocabulary, session metrics, and feed roles existed.
          {!salvageable && " It also predates the current schema entirely (no symbol or session date), so it can't be re-run — delete it and start fresh."}
        </p>
      </div>
      {salvageable ? (
        <button onClick={onRerun} disabled={running}
          className="flex-shrink-0 text-xs px-2.5 py-1 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50">
          {running ? "Re-running…" : "Re-run"}
        </button>
      ) : (
        <button onClick={onDelete}
          className="flex-shrink-0 text-xs px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-500">
          Delete
        </button>
      )}
    </div>
  );
}

function Verdict({ v }) {
  const map = {
    tradeable: { label: "TRADEABLE", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30", Icon: CheckCircle2 },
    not_tradeable: { label: "NOT TRADEABLE", cls: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30", Icon: Minus },
  };
  const m = map[v] || map.not_tradeable;
  const I = m.Icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-mono ${m.cls}`}>
      <I size={13} /> {m.label}
    </span>
  );
}

const card = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800";
const sub = "text-zinc-600 dark:text-zinc-400";
const faint = "text-zinc-500 dark:text-zinc-500";
const heading = "text-[11px] uppercase tracking-wider font-mono text-zinc-500";

// ---------------------------------------------------------------------------
// THE FEED AUDIT — every feed, always fully visible. This is the model showing
// its work, including the dead ends. Nothing is collapsed or hidden by default,
// because "I checked GEX and it didn't line up" is exactly the reasoning that
// needs to be readable.
// ---------------------------------------------------------------------------
function FeedAudit({ review }) {
  const [filter, setFilter] = useState("ALL");
  if (!review?.length) return <p className={`text-xs italic ${faint}`}>No feed review returned.</p>;

  const counts = {
    ALL: review.length,
    SIGNAL: review.filter((r) => r.role === "SIGNAL").length,
    CONFIRMATION: review.filter((r) => r.role === "CONFIRMATION").length,
    NOISE: review.filter((r) => r.role === "NOISE").length,
    NOT_REVIEWED: review.filter((r) => !r.reviewed).length,
  };
  const shown = filter === "ALL" ? review : review.filter((r) => (filter === "NOT_REVIEWED" ? !r.reviewed : r.role === filter));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {["ALL", "SIGNAL", "CONFIRMATION", "NOISE", "NOT_REVIEWED"].map((f) => (
          counts[f] > 0 || f === "ALL" ? (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-[10px] font-mono px-2 py-1 rounded border transition
                ${filter === f
                  ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-zinc-900 dark:border-zinc-100"
                  : "border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400"}`}>
              {f === "NOT_REVIEWED" ? "SKIPPED" : f} {counts[f]}
            </button>
          ) : null
        ))}
      </div>

      {/* One cell per feed — "did it look at everything?" answerable at a glance. */}
      <div className="flex flex-wrap gap-1 mb-4">
        {review.map((r) => (
          <span key={r.id} title={`${r.id}: ${r.role}`}
            className={`w-2.5 h-2.5 rounded-sm ${
              !r.reviewed ? "bg-red-500"
              : r.role === "SIGNAL" ? "bg-emerald-500"
              : r.role === "CONFIRMATION" ? "bg-sky-500"
              : "bg-zinc-300 dark:bg-zinc-700"}`} />
        ))}
      </div>

      <div className="space-y-2">
        {shown.map((r) => (
          <div key={r.id} className={`text-xs px-3 py-2.5 rounded-lg border ${
            !r.reviewed ? "border-red-500/40 bg-red-500/5"
            : r.role === "SIGNAL" ? "border-emerald-500/30 bg-emerald-500/5"
            : r.role === "CONFIRMATION" ? "border-sky-500/30 bg-sky-500/5"
            : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900"}`}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="font-mono text-zinc-800 dark:text-zinc-200">{r.id}</span>
              <span className="ml-auto"><RoleBadge role={r.reviewed ? r.role : "NOT_REVIEWED"} /></span>
            </div>
            <p className={`leading-relaxed ${sub}`}>{r.notes}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BACKTEST INSPECTOR — every single trade, clickable. No summarised numbers
// without the underlying trades available to check.
// ---------------------------------------------------------------------------
function TradeInspector({ result, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className={`${card} rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 ${card}`}>
          <div>
            <h3 className="font-semibold">Every trade this rule took</h3>
            <p className={`text-xs ${faint} mt-0.5`}>{result.totalTrades} trades across {result.sessionsTested} sessions — winners and losers, nothing hidden.</p>
          </div>
          <button onClick={onClose} className={faint}><X size={18} /></button>
        </div>

        <div className="p-5">
          <p className={`text-xs font-mono mb-3 ${sub}`}>{result.dataIntegrity}</p>

          {result.sessionResults?.some((s) => s.gateBlocked) && (
            <div className="mb-4">
              <div className={`${heading} mb-1.5`}>Days your session gates blocked outright</div>
              <div className="space-y-1">
                {result.sessionResults.filter((s) => s.gateBlocked).map((s) => (
                  <div key={s.sessionDate} className={`text-xs font-mono px-2.5 py-1.5 rounded border border-zinc-200 dark:border-zinc-800 ${faint}`}>
                    {s.sessionDate} — {s.gateReason}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={`${heading} mb-1.5`}>Trades</div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className={`text-left ${faint} border-b border-zinc-200 dark:border-zinc-800`}>
                <th className="py-1.5">Date</th><th>Entry</th><th className="text-right">In</th>
                <th className="text-right">Out</th><th className="text-right">Return</th>
              </tr>
            </thead>
            <tbody>
              {result.trades?.map((t, i) => (
                <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800/50">
                  <td className="py-1.5">{t.sessionDate}</td>
                  <td>{t.entryClock}</td>
                  <td className="text-right">${t.entryPrice}</td>
                  <td className="text-right">${t.exitPrice}</td>
                  <td className={`text-right font-medium ${t.win ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                    {t.pctReturn > 0 ? "+" : ""}{t.pctReturn}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Shown while a background job is still working. These steps take minutes, so
// the honest thing is to say what's running and roughly how long — not to leave
// a blank panel that looks broken.
function JobPending({ label, detail }) {
  return (
    <div className="px-3 py-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 flex items-center gap-2">
      <RefreshCw size={13} className="text-sky-500 animate-spin flex-shrink-0" />
      <p className="text-xs text-sky-700 dark:text-sky-300">{label}{detail ? ` — ${detail}` : ""}</p>
    </div>
  );
}

function JobSkipped({ detail }) {
  return (
    <div className="px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <p className={`text-xs ${sub}`}>{detail || "Nothing to run."}</p>
    </div>
  );
}

// BACKTEST — now auto-run, so this only ever DISPLAYS a result.
function BacktestPanel({ record, modelId, rule }) {
  const [inspect, setInspect] = useState(false);
  const result = record.backtests?.[modelId];

  if (!rule) {
    return (
      <div className="mt-5">
        <div className="flex items-center gap-2 mb-2">
          <FlaskConical size={14} className={faint} />
          <span className={heading}>Backtest</span>
        </div>
        <JobSkipped detail="No rule proposed — this model concluded nothing here was tradeable. Nothing to backtest, which is a legitimate outcome." />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="mt-5">
        <div className="flex items-center gap-2 mb-2">
          <FlaskConical size={14} className={faint} />
          <span className={heading}>Backtest</span>
        </div>
        <JobPending label="Backtesting this rule across 40 unseen sessions" />
      </div>
    );
  }

  const failed = /^(DOES NOT|NEVER|INSUFFICIENT)/.test(result.verdict || "");

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical size={14} className={faint} />
        <span className={heading}>Backtest — does this rule survive other days?</span>
      </div>

      {!result.testable ? (
        <div className="px-3 py-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10">
          <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed whitespace-pre-line">{result.reason}</p>
        </div>
      ) : (
        <div className={`px-3 py-3 rounded-lg border ${failed ? "border-red-500/30 bg-red-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
          <div className={`text-sm font-medium mb-2 ${failed ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
            {result.verdict}
          </div>

          {result.warnings?.map((w, i) => (
            <div key={i} className="flex gap-1.5 mb-2 px-2.5 py-2 rounded border border-amber-500/40 bg-amber-500/10">
              <AlertTriangle size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">{w}</p>
            </div>
          ))}

          {result.gateCount > 0 && (
            <p className={`text-[11px] font-mono mb-2 ${faint}`}>
              {result.gateCount} gate{result.gateCount > 1 ? "s" : ""} · {result.triggerCount} trigger{result.triggerCount > 1 ? "s" : ""}
              {result.gateBlockedDays > 0 && ` · gates blocked ${result.gateBlockedDays}/${result.sessionsTested} days`}
            </p>
          )}

          {result.totalTrades > 0 && (
            <>
              <div className="grid grid-cols-4 gap-2 text-center mb-3">
                {[["Trades", result.totalTrades], ["Win rate", `${result.winRate}%`],
                  ["Avg/trade", `${result.avgReturnPct}%`], ["Profit factor", result.profitFactor]].map(([k, v]) => (
                  <div key={k}>
                    <div className={heading}>{k}</div>
                    <div className="text-sm font-mono">{v}</div>
                  </div>
                ))}
              </div>
              <button onClick={() => setInspect(true)}
                className="w-full flex items-center justify-center gap-1.5 text-xs py-1.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Table2 size={13} /> Inspect all {result.totalTrades} trades
              </button>
            </>
          )}
        </div>
      )}

      {inspect && <TradeInspector result={result} onClose={() => setInspect(false)} />}
    </div>
  );
}

// CONFIRMATION ANALYSIS — auto-run in the background.
function ConfirmersPanel({ record, modelId, rule }) {
  const result = record.confirmers?.[modelId];
  const job = record.jobs?.confirmers;

  if (!rule) return null;

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 mb-2">
        <Target size={14} className={faint} />
        <span className={heading}>Confirmation analysis — what lifts this signal?</span>
      </div>

      {!result && job?.status === "skipped" && <JobSkipped detail={job.detail} />}
      {!result && job?.status !== "skipped" && (
        <JobPending label="Measuring every other feed's lift on this rule (slow — many backtests)" />
      )}

      {result && !result.ok && (
        <div className="px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
          <p className={`text-xs ${sub}`}>{result.reason}</p>
        </div>
      )}

      {result?.ok && (
        <>
          <div className="px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 mb-3">
            <p className={`text-sm ${sub} leading-relaxed`}>{result.summary}</p>
          </div>
          <div className="space-y-1.5">
            {[...result.confirmations, ...result.signals, ...result.antiConfirmations, ...result.noise].map((r) => (
              <div key={r.key} className={`px-3 py-2 rounded-lg border text-xs ${
                r.role === "CONFIRMATION" ? "border-sky-500/30 bg-sky-500/5"
                : r.role === "SIGNAL" ? "border-emerald-500/30 bg-emerald-500/5"
                : r.role === "ANTI-CONFIRMATION" ? "border-red-500/30 bg-red-500/5"
                : "border-zinc-200 dark:border-zinc-800"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono">{r.key}</span>
                  <RoleBadge role={r.role} />
                  {r.lift != null && (
                    <span className={`ml-auto font-mono ${r.lift > 0 ? "text-emerald-600 dark:text-emerald-400" : r.lift < 0 ? "text-red-600 dark:text-red-400" : faint}`}>
                      {r.lift > 0 ? "+" : ""}{r.lift} pts
                    </span>
                  )}
                </div>
                <p className={`leading-relaxed ${sub}`}>{r.why}</p>
                {r.confirmedTrades != null && (
                  <p className={`mt-1 font-mono text-[10px] ${faint}`}>
                    base {r.baseWinRate}% / {result.baseTrades} trades → with it {r.confirmedWinRate}% / {r.confirmedTrades} trades ({r.tradesRetainedPct}% retained) · alone {r.aloneWinRate ?? "—"}% / {r.aloneTrades}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// REFINEMENT LOOP — auto-run in the background.
function RefinePanel({ record, modelId, rule }) {
  const result = record.refinements?.[modelId];
  const job = record.jobs?.refinements;

  if (!rule) return null;
  const survived = result && !result.abandoned && result.best;

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 mb-2">
        <RefreshCw size={14} className={faint} />
        <span className={heading}>Refinement loop — learn from losses, revise, retest</span>
      </div>

      {!result && job?.status === "skipped" && <JobSkipped detail={job.detail} />}
      {!result && job?.status !== "skipped" && (
        <JobPending label="Reading its own losing trades, revising the rule, retesting (up to 4 rounds x 60 sessions)" />
      )}

      {result?.error && (
        <div className="px-3 py-2.5 rounded-lg border border-red-500/40 bg-red-500/10">
          <p className="text-xs text-red-700 dark:text-red-300">{result.conclusion}</p>
        </div>
      )}

      {result && !result.error && (
        <>
          <div className={`px-3 py-3 rounded-lg border mb-3 ${survived ? "border-emerald-500/30 bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
            <div className={`text-sm font-medium ${survived ? "text-emerald-600 dark:text-emerald-400" : sub}`}>{result.conclusion}</div>
          </div>

          <div className="space-y-2">
            {result.history?.map((h) => {
              const b = h.backtest;
              return (
                <div key={h.round} className="px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-mono">ROUND {h.round}</span>
                    {h.action && (
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                        h.action === "abandon" ? "text-red-600 dark:text-red-400 border-red-500/40"
                        : h.action === "filter" ? "text-sky-600 dark:text-sky-400 border-sky-500/40"
                        : "border-zinc-300 dark:border-zinc-700 " + faint}`}>{h.action}</span>
                    )}
                    {b?.testable && (
                      <span className={`ml-auto text-xs font-mono ${sub}`}>
                        {b.totalTrades} trades · {b.winRate}% win · PF {b.profitFactor}
                        {!b.enoughData && b.totalTrades > 0 && <span className="text-amber-500 ml-1.5">sample too small</span>}
                      </span>
                    )}
                  </div>
                  <div className={`text-[11px] font-mono mb-1.5 ${faint}`}>
                    {h.rule.conditions.map((c) => `${c.feed}.${c.metric} ${c.operator} ${c.threshold}`).join("  AND  ")}
                  </div>
                  {b?.invalidRule && <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">Rule invalid, never ran — {b.errors?.join("; ")}</p>}
                  {h.diagnosis && <p className={`text-xs leading-relaxed ${sub}`}><span className={faint}>diagnosis: </span>{h.diagnosis}</p>}
                  {h.stopReason && <p className={`text-xs leading-relaxed mt-1 italic ${faint}`}>{h.stopReason}</p>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// COMBINED — the three models side by side. Deliberately NOT a merged verdict.
// Entry timings are never averaged: averaging two models' entries produces a
// moment neither of them endorsed. Disagreement is preserved and displayed,
// because a 2-1 split is information, not a problem to be smoothed away.
function CombinedPanel({ record, onChart }) {
  const c = record.analysis?.combined;
  if (!c) return <p className={`text-sm ${sub}`}>No combined view.</p>;

  const responding = c.respondingModels || [];
  const failed = c.failedModels || [];

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Verdict v={c.verdict} />
        <span className={`text-sm font-mono ${sub}`}>{c.agreement} models say tradeable</span>
      </div>

      {failed.length > 0 && (
        <div className="mb-4 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10">
          <p className="text-xs text-red-700 dark:text-red-300">
            {failed.map((m) => MODEL_META[m].name).join(", ")} failed and {failed.length > 1 ? "are" : "is"} excluded from the count entirely — NOT counted as a silent "no" vote.
          </p>
        </div>
      )}

      <div className={`${heading} mb-2`}>Entry timings (side by side — never averaged)</div>
      <div className="space-y-2 mb-5">
        {responding.map((m) => {
          const a = record.analysis[m];
          const bt = record.backtests?.[m];
          return (
            <div key={m} className="px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2 h-2 rounded-full ${MODEL_META[m].dot}`} />
                <span className={`text-sm font-medium ${MODEL_META[m].accent}`}>{MODEL_META[m].name}</span>
                <span className={`text-xs font-mono ml-auto ${sub}`}>
                  {a.entry?.timestamp || "no entry — passed"}
                </span>
                <button onClick={() => onChart(m)} title="Open chart"
                  className={`p-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${faint}`}>
                  <LineChart size={12} />
                </button>
              </div>
              {a.rule && <p className={`text-xs font-mono ${faint} mb-1`}>{a.rule.description}</p>}
              {bt?.testable && (
                <p className={`text-xs font-mono ${bt.winRate >= 55 && bt.avgReturnPct > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  backtest: {bt.totalTrades} trades · {bt.winRate}% win · {bt.avgReturnPct}%/trade
                </p>
              )}
              {bt && !bt.testable && <p className={`text-xs ${faint}`}>rule not testable</p>}
            </div>
          );
        })}
      </div>

      {/* Where the models agreed vs diverged on WHICH feeds mattered. */}
      <div className={`${heading} mb-2`}>Feed roles — where they agreed and where they didn't</div>
      <FeedRoleMatrix record={record} responding={responding} />
    </div>
  );
}

// Shows, per feed, what role EACH model gave it. Rows where the three disagree
// are the interesting ones — that's a genuine difference of interpretation over
// identical data, and it's exactly what you'd lose by merging them.
function FeedRoleMatrix({ record, responding }) {
  const feeds = record.analysis?.[responding[0]]?.endpointReview?.map((r) => r.id) || [];
  const roleOf = (m, id) => record.analysis?.[m]?.endpointReview?.find((r) => r.id === id)?.role;

  const rows = feeds.map((id) => {
    const roles = responding.map((m) => roleOf(m, id));
    const disagree = new Set(roles).size > 1;
    return { id, roles, disagree };
  });
  // Disagreements first — they're the signal in this table.
  rows.sort((a, b) => (b.disagree ? 1 : 0) - (a.disagree ? 1 : 0));

  const dot = (role) => role === "SIGNAL" ? "bg-emerald-500"
    : role === "CONFIRMATION" ? "bg-sky-500"
    : role === "NOISE" ? "bg-zinc-300 dark:bg-zinc-700"
    : "bg-red-500";

  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className={`flex items-center gap-2 text-xs px-2.5 py-1.5 rounded border ${
          r.disagree ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
          <span className="font-mono flex-1 truncate">{r.id}</span>
          {r.roles.map((role, i) => (
            <span key={i} title={`${MODEL_META[responding[i]].name}: ${role}`}
              className={`w-3 h-3 rounded-sm ${dot(role)}`} />
          ))}
          {r.disagree && <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400 ml-1">split</span>}
        </div>
      ))}
    </div>
  );
}

function ModelPanel({ record, modelId, cb, onChart }) {
  const a = record.analysis?.[modelId];
  if (!a) return <p className={`text-sm ${sub}`}>No analysis.</p>;
  if (a.failed) {
    return (
      <div className="px-3 py-3 rounded-lg border border-red-500/40 bg-red-500/5">
        <p className="text-sm text-red-600 dark:text-red-400">{a.reasoning}</p>
        <p className={`text-xs mt-1 ${faint}`}>This model has NO opinion — it is excluded from the agreement count, not counted as a vote.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <Verdict v={a.verdict} />
        <div className="flex items-center gap-2">
          {a.confidence > 0 && <span className={`text-xs font-mono ${faint}`}>confidence {a.confidence}%</span>}
          <button onClick={() => onChart(modelId)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <LineChart size={13} /> Chart
          </button>
        </div>
      </div>

      {a.entry?.timestamp ? (
        <div className={`mb-4 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800`}>
          <div className="flex items-center gap-1.5 mb-1">
            <Zap size={13} style={{ color: MODEL_META[modelId].hex }} />
            <span className={heading}>Entry it would have taken</span>
          </div>
          <div className="text-lg font-mono">
            {a.entry.timestamp}
            {a.entry.leadMinutes != null && <span className={`text-xs ml-2 ${faint}`}>{a.entry.leadMinutes} min before the move</span>}
          </div>
          <p className={`text-sm mt-1 leading-relaxed ${sub}`}>{a.entry.reasoning}</p>
        </div>
      ) : (
        <div className={`mb-4 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800`}>
          <p className={`text-sm ${sub}`}>No defensible entry. This model concluded the move was not knowable in advance — a legitimate finding, not a failure.</p>
        </div>
      )}

      <div className={`${heading} mb-1`}>Reasoning</div>
      <p className={`text-sm leading-relaxed mb-4 ${sub}`}>{a.reasoning}</p>

      {a.rule && (
        <>
          <div className={`${heading} mb-1`}>Proposed rule</div>
          <p className={`text-sm mb-2 font-mono px-2.5 py-2 rounded border border-zinc-200 dark:border-zinc-800 ${sub}`}>{a.rule.description}</p>
          <div className="space-y-1 mb-3">
            {a.rule.conditions?.map((c, i) => (
              <div key={i} className={`text-[11px] font-mono px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 ${sub}`}>
                {c.feed}.{c.metric} {c.operator} {c.threshold}
              </div>
            ))}
          </div>
        </>
      )}

      {a.falsification && (
        <>
          <div className={`${heading} mb-1`}>What would prove it wrong</div>
          <p className={`text-sm leading-relaxed mb-2 ${sub}`}>{a.falsification}</p>
        </>
      )}

      <BacktestPanel record={record} modelId={modelId} rule={a.rule} />
      <ConfirmersPanel record={record} modelId={modelId} rule={a.rule} />
      <RefinePanel record={record} modelId={modelId} rule={a.rule} />

      <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 mb-2">
          <ListFilter size={14} className={faint} />
          <span className={heading}>Feed audit — all {a.endpointReview?.length ?? 0} feeds, including the dead ends</span>
        </div>
        <FeedAudit review={a.endpointReview} />
      </div>
    </div>
  );
}

function Timeline({ timeline }) {
  if (!timeline?.priceThrusts?.length) {
    return <p className={`text-xs italic ${faint}`}>No statistically significant price move detected this session. There may simply have been nothing to trade.</p>;
  }
  return (
    <div className="space-y-2">
      {timeline.priceThrusts.map((t, i) => {
        const ll = timeline.leadLag?.[i];
        return (
          <div key={i} className={`px-3 py-2 rounded border border-zinc-200 dark:border-zinc-800`}>
            <div className="flex items-center gap-2 text-sm font-mono">
              <span className={t.direction === "UP" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                {t.direction} {t.pctMove}%
              </span>
              <span className={faint}>{t.startClock} → {t.endClock}</span>
              <span className={`text-xs ml-auto ${faint}`}>{t.z}σ</span>
            </div>
            {ll && (
              <div className={`text-xs mt-1 ${sub}`}>
                {ll.precursorCount === 0
                  ? "Nothing fired in advance — this move was likely not knowable."
                  : `${ll.precursorCount} precursors across ${ll.corroborationScore} feeds: ${ll.corroboratingFeeds.join(", ")}`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SessionMetrics({ metrics }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(metrics || {}).sort();
  if (!keys.length) return null;
  return (
    <div className="mt-3">
      <button onClick={() => setOpen((o) => !o)} className={`text-xs font-mono ${faint} hover:underline`}>
        {open ? "hide" : "show"} all {keys.length} measured session metrics
      </button>
      {open && (
        <div className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1">
          {keys.map((k) => (
            <div key={k} className="flex justify-between text-[11px] font-mono gap-2">
              <span className={faint}>{k}</span>
              <span className={sub}>{typeof metrics[k] === "number" ? metrics[k].toLocaleString(undefined, { maximumFractionDigits: 2 }) : metrics[k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalysisDetail({ record, onClose, cb, onRerun, rerunning, rerunError, onDelete, onChart }) {
  const [tab, setTab] = useState("claude");
  const combined = record.analysis?.combined;
  const stale = isStale(record);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className={`${card} rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-10 ${card}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="font-semibold text-lg">{record.symbol}</h3>
            <span className={`text-xs font-mono ${faint}`}>{record.sessionDate}</span>
            {combined && <Verdict v={combined.verdict} />}
            <span className={`text-xs font-mono ${faint}`}>agreement {record.agreement}</span>
          </div>
          <div className="flex items-center gap-2">
            {!stale && (
              <button onClick={onRerun} disabled={rerunning} title="Re-run with the current engine"
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 ${faint}`}>
                <RefreshCw size={12} className={rerunning ? "animate-spin" : ""} /> {rerunning ? "Re-running…" : "Re-run"}
              </button>
            )}
            <button onClick={onClose} className={faint}><X size={18} /></button>
          </div>
        </div>

        {stale && (
          <div className="px-5 pt-4">
            <RerunBanner record={record} onRerun={onRerun} running={rerunning} onDelete={onDelete} />
          </div>
        )}

        {/* A re-run takes 1-2 minutes (30 feed pulls + 3 LLM calls). Without
            this, the button looked like it did nothing at all. */}
        {rerunning && (
          <div className="px-5 pt-3">
            <div className="px-3 py-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 flex items-center gap-2">
              <RefreshCw size={14} className="text-sky-500 animate-spin flex-shrink-0" />
              <p className="text-xs text-sky-700 dark:text-sky-300">
                Re-running: pulling all 30 feeds, rebuilding the timeline, and running all 3 analysts. This takes 1–2 minutes — leave this open.
              </p>
            </div>
          </div>
        )}

        {rerunError && (
          <div className="px-5 pt-3">
            <div className="px-3 py-2.5 rounded-lg border border-red-500/40 bg-red-500/10 flex items-start gap-2">
              <AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">{rerunError}</p>
            </div>
          </div>
        )}

        {/* Background work status. Everything runs automatically now — this
            tells you what's still cooking rather than leaving panels blank. */}
        {(() => {
          const jc = record.jobs?.confirmers?.status;
          const jr = record.jobs?.refinements?.status;
          const working = ["queued", "running"].includes(jc) || ["queued", "running"].includes(jr);
          if (!working) return null;
          return (
            <div className="px-5 pt-3">
              <div className="px-3 py-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 flex items-center gap-2">
                <RefreshCw size={14} className="text-sky-500 animate-spin flex-shrink-0" />
                <p className="text-xs text-sky-700 dark:text-sky-300">
                  Still working in the background: {jc === "running" ? "measuring confirmers" : jr === "running" ? "running the refinement loop" : "queued"}.
                  Results appear below as they land — you can close this and come back.
                </p>
              </div>
            </div>
          );
        })()}

        {record.notes && (
          <div className="px-5 pt-4">
            <div className="px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10">
              <div className={`${heading} mb-1`}>Your note (given to all 3 as a hunch to check, not a rule)</div>
              <p className="text-sm text-amber-800 dark:text-amber-300">{record.notes}</p>
            </div>
          </div>
        )}

        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          {/* THE DATA WINDOW, stated plainly. It is NOT "the last 24 hours" — it
              is the target session plus the two prior TRADING sessions, so a
              Tuesday run covers Tue + Mon + Fri. */}
          {record.briefing?.sessions?.length > 0 && (
            <div className="mb-4 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-1.5 mb-2">
                <CalendarDays size={13} className={faint} />
                <span className={heading}>Data window — {record.briefing.sessions.length} trading sessions analyzed</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {record.briefing.sessions.map((s) => {
                  const isTarget = s.sessionDate === record.sessionDate;
                  return (
                    <div key={s.sessionDate}
                      className={`px-2.5 py-1.5 rounded border text-xs font-mono ${
                        isTarget ? "border-emerald-500/50 bg-emerald-500/10" : "border-zinc-200 dark:border-zinc-800"}`}>
                      <div className={isTarget ? "text-emerald-600 dark:text-emerald-400 font-medium" : sub}>
                        {s.sessionDate}{isTarget && " ← target"}
                      </div>
                      <div className={faint}>{s.thrusts} moves · {s.events} events</div>
                    </div>
                  );
                })}
              </div>
              <p className={`text-[11px] mt-2 ${faint}`}>
                Prior sessions exist to FALSIFY: if a signal also fired there without a move following, it's noise. Weekends and market holidays are skipped automatically.
              </p>
            </div>
          )}

          <div className={`${heading} mb-2`}>Price moves on the target session (computed, not opinion)</div>
          <Timeline timeline={record.briefing?.timeline} />
          {record.briefing?.fetchReport && (
            <p className={`text-[11px] font-mono mt-2 ${faint}`}>
              {record.briefing.fetchReport.succeeded}/{record.briefing.fetchReport.attempted} feeds fetched · {record.briefing.timeline?.totalSignalEvents ?? 0} signal events
              {!record.contract && " · (the 30th feed, option_price_over_time, applies only in options mode)"}
            </p>
          )}
          <SessionMetrics metrics={record.briefing?.sessionMetrics} />
        </div>

        <div className="flex gap-1 px-5 pt-4 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto">
          {MODEL_IDS.map((m) => {
            const a = record.analysis?.[m];
            return (
              <button key={m} onClick={() => setTab(m)}
                className={`flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm font-medium whitespace-nowrap
                  ${tab === m ? "border-current " + MODEL_META[m].accent : "border-transparent " + faint}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${MODEL_META[m].dot}`} />
                {MODEL_META[m].name}
                {a && !a.failed && (
                  <span className={`text-[10px] font-mono ${faint}`} title="feeds this model chose to USE (out of all reviewed)">
                    {a.usedCount} used
                  </span>
                )}
              </button>
            );
          })}
          <button onClick={() => setTab("combined")}
            className={`flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm font-medium whitespace-nowrap
              ${tab === "combined" ? "border-current text-zinc-900 dark:text-zinc-100" : "border-transparent " + faint}`}>
            <Users size={13} /> Combined
          </button>
        </div>

        <div className="p-5">
          {tab === "combined"
            ? <CombinedPanel record={record} onChart={onChart} />
            : <ModelPanel record={record} modelId={tab} cb={cb} onChart={onChart} />}
        </div>
      </div>
    </div>
  );
}

function AnalyzeForm({ onClose, onSubmit, error, running }) {
  const [mode, setMode] = useState("stock");
  const [f, setF] = useState({ symbol: "", sessionDate: "", strikePrice: "", contractType: "CALL", expirationDate: "", notes: "" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const inp = "w-full mt-1 bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className={`${card} rounded-xl w-full max-w-md p-5 max-h-[92vh] overflow-y-auto`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Analyze a session</h3>
          <button onClick={onClose} className={faint}><X size={18} /></button>
        </div>

        <div className="flex gap-1 mb-4 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
          {[["stock", "Stock"], ["options", "Options"]].map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`flex-1 py-1.5 rounded text-sm font-medium ${mode === k ? "bg-white dark:bg-zinc-900 shadow-sm" : faint}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-mono ${faint}`}>SYMBOL</label>
              <input value={f.symbol} onChange={set("symbol")} placeholder="META" className={inp} />
            </div>
            <div>
              <label className={`text-xs font-mono ${faint}`}>SESSION DATE</label>
              <input type="date" value={f.sessionDate} onChange={set("sessionDate")} className={inp} />
            </div>
          </div>

          {mode === "options" && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={`text-xs font-mono ${faint}`}>STRIKE</label>
                <input value={f.strikePrice} onChange={set("strikePrice")} placeholder="700" className={inp} />
              </div>
              <div>
                <label className={`text-xs font-mono ${faint}`}>TYPE</label>
                <select value={f.contractType} onChange={set("contractType")} className={inp}>
                  <option>CALL</option><option>PUT</option>
                </select>
              </div>
              <div>
                <label className={`text-xs font-mono ${faint}`}>EXPIRY</label>
                <input type="date" value={f.expirationDate} onChange={set("expirationDate")} className={inp} />
              </div>
            </div>
          )}

          {/* The hunch box. Explicitly a hint to CHECK, never a rule to obey — the
              prompt tells all three models that agreeing when the data doesn't
              support it is the worst thing they can do. */}
          <div>
            <label className={`text-xs font-mono ${faint}`}>NOTES (optional)</label>
            <textarea value={f.notes} onChange={set("notes")} rows={3}
              placeholder="Something you noticed and want them to consider — e.g. 'saw a possible bear trap around 10:30, worth a look?'"
              className={inp + " resize-none"} />
            <p className={`text-[11px] mt-1 ${faint}`}>
              Passed to all 3 as a hunch to <em>check</em>, not a rule to follow. They're instructed to tell you plainly if the data contradicts it.
            </p>
          </div>
        </div>

        <button
          onClick={() => onSubmit({
            symbol: f.symbol, sessionDate: f.sessionDate, notes: f.notes || null,
            contract: mode === "options" && f.strikePrice && f.expirationDate
              ? { strikePrice: f.strikePrice, contractType: f.contractType, expirationDate: f.expirationDate }
              : null,
          })}
          disabled={!f.symbol || !f.sessionDate || running}
          className="w-full mt-5 py-2 rounded bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-40">
          {running ? "Pulling 30 feeds, running 3 analysts…" : "Analyze"}
        </button>

        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
      </div>
    </div>
  );
}

function AnalysisCard({ record, onOpen }) {
  const c = record.analysis?.combined;
  const thrusts = record.briefing?.timeline?.priceThrusts?.length ?? 0;
  const entries = c?.entries ? Object.values(c.entries).filter((e) => e?.timestamp) : [];
  const stale = isStale(record);

  return (
    <div className={`${card} rounded-lg p-4 flex flex-col ${stale ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        {c ? <Verdict v={c.verdict} /> : <span className={`text-xs font-mono ${faint}`}>pending</span>}
        <span className={`text-[11px] font-mono ${faint}`}>agreement {record.agreement}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold">{record.symbol}</span>
        {stale && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
            STALE
          </span>
        )}
      </div>
      <div className={`text-xs font-mono mb-3 ${faint}`}>{record.sessionDate}</div>

      <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3 grid grid-cols-3 gap-2">
        {[["Moves", thrusts], ["Entries", `${entries.length}/3`], ["Feeds", record.briefing?.fetchReport?.succeeded ?? "—"]].map(([k, v]) => (
          <div key={k}>
            <div className={heading}>{k}</div>
            <div className="text-sm font-mono">{v}</div>
          </div>
        ))}
      </div>

      <button onClick={() => onOpen(record.id)}
        className="mt-4 w-full flex items-center justify-center gap-1.5 border border-zinc-300 dark:border-zinc-700 text-sm font-medium py-2 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800">
        {stale ? "Open & re-run" : "View full analysis"} <ChevronRight size={14} />
      </button>
    </div>
  );
}

export default function App() {
  // Light by default, with a working sun/moon toggle — this got lost in the
  // rebuild and is restored here.
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState("log");
  const [records, setRecords] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [chartModel, setChartModel] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    fetch("/api/analyses").then((r) => r.json())
      .then((rs) => Array.isArray(rs) && setRecords(rs))
      .catch(() => {});
  }, []);

  const open = useMemo(() => records.find((r) => r.id === openId), [records, openId]);

  // POLL while background jobs are still running. Confirmation analysis and the
  // refinement loop take several minutes; without this, their findings would sit
  // finished in the database while the UI kept showing a spinner forever.
  const jobsPending = open && (
    ["queued", "running"].includes(open.jobs?.confirmers?.status) ||
    ["queued", "running"].includes(open.jobs?.refinements?.status) ||
    // Also poll if a rule exists but its backtest hasn't landed yet.
    MODEL_IDS.some((m) => open.analysis?.[m]?.rule && !open.backtests?.[m])
  );

  useEffect(() => {
    if (!openId || !jobsPending) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/analyses/${openId}`);
        if (!res.ok) return;
        const fresh = await res.json();
        setRecords((prev) => prev.map((r) => (r.id === openId ? fresh : r)));
      } catch { /* transient — the next tick retries */ }
    }, 8000);
    return () => clearInterval(t);
  }, [openId, jobsPending]);

  const analyze = async (form) => {
    setRunning(true); setError(null);
    // ABORT GUARD. The analyze request is legitimately slow (feed pulls + 3 AI
    // analysts), but it should never be INFINITE. Without this, a dropped
    // connection left the button on "Pulling 30 feeds..." forever with no way
    // to recover except a page refresh. 10 minutes is beyond any legitimate
    // run now that the auto-backtest happens in the background.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setRecords((p) => [data, ...p]);
      setShowForm(false);
      setOpenId(data.id);
    } catch (e) {
      setError(e.name === "AbortError"
        ? "The request took over 10 minutes and was cancelled. The server may still be finishing in the background — refresh in a minute to check the Analyses list before re-running."
        : e.message);
    }
    clearTimeout(timeout);
    setRunning(false);
  };

  const patch = (field) => (modelId, result) => {
    setRecords((prev) => prev.map((r) => r.id === openId
      ? { ...r, [field]: { ...(r[field] || {}), [modelId]: result } } : r));
  };
  const cb = { backtest: patch("backtests"), refine: patch("refinements"), confirm: patch("confirmers") };

  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState(null);

  const rerun = async () => {
    if (!openId) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const res = await fetch(`/api/analyses/${openId}/rerun`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });

      // The server may reply with HTML rather than JSON — most commonly a 404
      // when this route doesn't exist yet on the deployed build, or a 401 when
      // auth fails. Blindly calling res.json() on HTML throws a parse error
      // that says nothing useful, which is exactly why this button appeared to
      // "do nothing". Read the status first and report it honestly.
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          res.status === 404
            ? "Re-run endpoint not found (HTTP 404). The deployed server is still running an older build — wait for Railway to finish redeploying, then try again."
            : `Server returned HTTP ${res.status} with a non-JSON response: ${text.slice(0, 120)}`
        );
      }

      if (!res.ok) throw new Error(data.error || `Re-run failed (HTTP ${res.status})`);

      setRecords((prev) => prev.map((r) => (r.id === openId ? data : r)));
      if (data.persisted === false) {
        setRerunError("Re-run completed, but the result could NOT be saved to the database. It's shown here, but will be lost on refresh.");
      }
    } catch (e) {
      setRerunError(e.message);
    }
    setRerunning(false);
  };

  const del = async () => {
    if (!openId) return;
    if (!window.confirm("Delete this analysis permanently? This can't be undone.")) return;
    try {
      const res = await fetch(`/api/analyses/${openId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
      setRecords((prev) => prev.filter((r) => r.id !== openId));
      setOpenId(null);
    } catch (e) {
      setRerunError(e.message);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-black text-zinc-900 dark:text-zinc-100 font-sans transition-colors">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">GHOSTFLOW</h1>
            <p className={`text-xs font-mono mt-0.5 ${faint}`}>signal discovery · 3-analyst engine · 30 live feeds</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-mono border rounded px-2 py-1 border-zinc-300 dark:border-zinc-700 ${faint}`}>
              was it knowable in advance?
            </span>
            <button onClick={() => setDark((d) => !d)} aria-label="Toggle theme"
              className="p-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>

        <div className="flex gap-1 mb-6 border-b border-zinc-200 dark:border-zinc-800">
          {[{ id: "log", label: "Analyses", Icon: FileText }, { id: "strategy", label: "Strategy Lab", Icon: FlaskConical }, { id: "settings", label: "Settings", Icon: Settings }].map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px
                ${tab === id ? "border-emerald-500 text-zinc-900 dark:text-zinc-100" : "border-transparent " + faint}`}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === "log" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className={`text-xs ${faint}`}>Enter a symbol and a date. The system finds the moves itself.</p>
              <button onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-3 py-1.5 rounded-md">
                <Search size={16} /> Analyze session
              </button>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {records.map((r) => <AnalysisCard key={r.id} record={r} onOpen={setOpenId} />)}
              {records.length === 0 && (
                <div className={`col-span-full px-4 py-10 text-center text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 ${faint}`}>
                  No analyses yet. Run one to get started.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "strategy" && <StrategyLab />}

        {tab === "settings" && (
          <div className={`max-w-xl ${card} rounded-lg p-4`}>
            <div className={`${heading} mb-1`}>AI provider billing</div>
            <p className={`text-xs mb-3 ${faint}`}>Top up token balance for each model this system calls.</p>
            <div className="space-y-2">
              {BILLING_LINKS.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-between px-3 py-2.5 rounded border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <span className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full ${l.dot}`} />
                    <span className={l.accent}>{l.name}</span>
                  </span>
                  <ExternalLink size={14} className={faint} />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {showForm && <AnalyzeForm onClose={() => setShowForm(false)} onSubmit={analyze} error={error} running={running} />}
      {open && <AnalysisDetail record={open} onClose={() => setOpenId(null)} cb={cb} onRerun={rerun} rerunning={rerunning} rerunError={rerunError} onDelete={del} onChart={setChartModel} />}
      {open && chartModel && (
        <ChartView record={open} modelId={chartModel} meta={MODEL_META[chartModel]}
          onClose={() => setChartModel(null)} onRerun={rerun} rerunning={rerunning} />
      )}
    </div>
  );
}
