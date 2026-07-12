import { useState, useMemo } from "react";
import { X, Zap, TrendingUp, TrendingDown } from "lucide-react";

// THE CHART — a model showing its work visually.
//
// This is not decoration. Each model gets its OWN chart, overlaid with only the
// feeds IT chose to use, colour-coded by the role IT assigned (signal /
// confirmation), plus its entry pick and the price moves it was asked to
// explain. Three models, three different-looking charts over identical price
// data — which is precisely the point: you can SEE where they disagreed about
// what mattered.
//
// It also forces the honest case to be visual: when a model says "not
// tradeable", the chart shows the moves it declined to trade and the signals it
// examined and rejected. "Nothing was knowable" becomes something you can look
// at rather than just a sentence.

const ROLE_COLOR = {
  SIGNAL: "#10b981",       // emerald — this IS the trade
  CONFIRMATION: "#0ea5e9", // sky — believes the trade, doesn't cause it
  NOISE: "#a1a1aa",        // zinc — examined, rejected
};

function parseEntryClock(ts) {
  if (!ts) return null;
  const m = String(ts).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function clockToMinutes(clock) {
  const [h, m] = String(clock).split(":").map(Number);
  return h * 60 + m;
}

export default function ChartView({ record, modelId, meta, onClose }) {
  const a = record.analysis?.[modelId];
  const price = record.briefing?.priceSeries || [];
  const thrusts = record.briefing?.timeline?.priceThrusts || [];
  const events = record.briefing?.timeline?.events || [];
  const [hover, setHover] = useState(null);
  const [showRole, setShowRole] = useState({ SIGNAL: true, CONFIRMATION: true, NOISE: false });

  // Which feeds did THIS model actually use, and what role did it give them?
  // The overlay is filtered to that model's own judgment — this is why the three
  // charts differ even though the underlying price data is identical.
  const roleByFeed = useMemo(() => {
    const map = {};
    (a?.endpointReview || []).forEach((r) => { map[r.id] = r.role; });
    // gamma_proximity is derived from the gamma feed, so it inherits its role.
    if (map.exposure_by_strike_gamma) map.gamma_proximity = map.exposure_by_strike_gamma;
    return map;
  }, [a]);

  const geom = useMemo(() => {
    if (!price.length) return null;
    const W = 1000, H = 460, PAD = { l: 56, r: 16, t: 20, b: 34 };
    const prices = price.map((p) => p.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.08 || 1;
    const yMin = lo - pad, yMax = hi + pad;

    const minutes = price.map((p) => clockToMinutes(p.clock));
    const t0 = Math.min(...minutes), t1 = Math.max(...minutes);

    const x = (min) => PAD.l + ((min - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);

    return { W, H, PAD, x, y, yMin, yMax, t0, t1 };
  }, [price]);

  if (!geom) {
    return (
      <div className="fixed inset-0 bg-white dark:bg-black z-[70] flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-zinc-500 mb-3">No price data stored for this analysis.</p>
          <p className="text-xs text-zinc-500 mb-4">Re-run it to capture the chart data.</p>
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-700">Close</button>
        </div>
      </div>
    );
  }

  const { W, H, PAD, x, y, yMin, yMax } = geom;
  const pathD = price.map((p, i) => `${i ? "L" : "M"}${x(clockToMinutes(p.clock))},${y(p.price)}`).join(" ");

  // Only the events from feeds THIS model used, in the roles it assigned.
  const shown = events.filter((e) => {
    const role = roleByFeed[e.endpoint];
    return role && showRole[role];
  });

  const entryMin = parseEntryClock(a?.entry?.timestamp);

  const yTicks = 5;
  const gridY = Array.from({ length: yTicks }, (_, i) => yMin + ((yMax - yMin) * i) / (yTicks - 1));
  const xTicks = [570, 630, 690, 750, 810, 870, 930, 960].filter((m) => m >= geom.t0 && m <= geom.t1);
  const fmtClock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  const counts = {
    SIGNAL: events.filter((e) => roleByFeed[e.endpoint] === "SIGNAL").length,
    CONFIRMATION: events.filter((e) => roleByFeed[e.endpoint] === "CONFIRMATION").length,
    NOISE: events.filter((e) => roleByFeed[e.endpoint] === "NOISE").length,
  };

  const usedFeeds = (a?.endpointReview || []).filter((r) => r.used);

  return (
    <div className="fixed inset-0 bg-white dark:bg-black z-[70] flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          <span className={`font-semibold ${meta.accent}`}>{meta.name}</span>
          <span className="text-sm font-mono text-zinc-500">{record.symbol} · {record.sessionDate}</span>
          <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
            a?.verdict === "tradeable"
              ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
              : "border-zinc-400/40 text-zinc-500"}`}>
            {a?.verdict === "tradeable" ? "TRADEABLE" : "NOT TRADEABLE"}
          </span>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"><X size={20} /></button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ---------- 70% CHART ---------- */}
        <div className="flex-[7] p-4 overflow-y-auto border-r border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {["SIGNAL", "CONFIRMATION", "NOISE"].map((r) => (
              <button key={r} onClick={() => setShowRole((s) => ({ ...s, [r]: !s[r] }))}
                className={`flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded border transition
                  ${showRole[r] ? "border-zinc-400 dark:border-zinc-600" : "border-zinc-200 dark:border-zinc-800 opacity-40"}`}>
                <span className="w-2 h-2 rounded-sm" style={{ background: ROLE_COLOR[r] }} />
                {r} {counts[r]}
              </button>
            ))}
            <span className="text-[11px] font-mono text-zinc-500 ml-2">
              showing only the feeds {meta.name} used, in the roles it assigned
            </span>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: "62vh" }}>
            {/* grid */}
            {gridY.map((v, i) => (
              <g key={i}>
                <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="currentColor" strokeWidth="0.5" className="text-zinc-200 dark:text-zinc-800" />
                <text x={PAD.l - 8} y={y(v) + 3} fontSize="10" textAnchor="end" fill="currentColor" className="text-zinc-500" fontFamily="monospace">
                  {v.toFixed(1)}
                </text>
              </g>
            ))}
            {xTicks.map((m) => (
              <text key={m} x={x(m)} y={H - 10} fontSize="10" textAnchor="middle" fill="currentColor" className="text-zinc-500" fontFamily="monospace">
                {fmtClock(m)}
              </text>
            ))}

            {/* PRICE MOVES the model had to explain — shaded so you can see what it
                was reacting to (or declining to trade). */}
            {thrusts.map((t, i) => {
              const x1 = x(clockToMinutes(t.startClock)), x2 = x(clockToMinutes(t.endClock));
              const up = t.direction === "UP";
              return (
                <g key={i}>
                  <rect x={x1} y={PAD.t} width={Math.max(x2 - x1, 2)} height={H - PAD.t - PAD.b}
                    fill={up ? "#10b981" : "#ef4444"} opacity="0.07" />
                  <text x={(x1 + x2) / 2} y={PAD.t + 12} fontSize="9" textAnchor="middle" fontFamily="monospace"
                    fill={up ? "#10b981" : "#ef4444"}>
                    {up ? "+" : ""}{t.pctMove}%
                  </text>
                </g>
              );
            })}

            {/* price */}
            <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1.4" className="text-zinc-800 dark:text-zinc-200" />

            {/* signal events, coloured by the ROLE THIS MODEL assigned */}
            {shown.map((e, i) => {
              const role = roleByFeed[e.endpoint];
              const mx = clockToMinutes(e.clock);
              const bar = price.find((p) => clockToMinutes(p.clock) === mx);
              if (!bar) return null;
              const r = role === "SIGNAL" ? 4.5 : role === "CONFIRMATION" ? 3.5 : 2;
              return (
                <circle key={i} cx={x(mx)} cy={y(bar.price)} r={r}
                  fill={ROLE_COLOR[role]} opacity={role === "NOISE" ? 0.35 : 0.85}
                  onMouseEnter={() => setHover({ ...e, role, price: bar.price })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: "pointer" }} />
              );
            })}

            {/* THE MODEL'S OWN ENTRY */}
            {entryMin != null && (() => {
              const bar = price.reduce((best, p) =>
                Math.abs(clockToMinutes(p.clock) - entryMin) < Math.abs(clockToMinutes(best.clock) - entryMin) ? p : best, price[0]);
              const ex = x(clockToMinutes(bar.clock));
              return (
                <g>
                  <line x1={ex} y1={PAD.t} x2={ex} y2={H - PAD.b} stroke={meta.hex} strokeWidth="1.5" strokeDasharray="4,3" />
                  <circle cx={ex} cy={y(bar.price)} r="6" fill="none" stroke={meta.hex} strokeWidth="2" />
                  <rect x={ex - 32} y={H - PAD.b - 20} width="64" height="16" rx="3" fill={meta.hex} />
                  <text x={ex} y={H - PAD.b - 9} fontSize="9" textAnchor="middle" fill="#fff" fontWeight="700" fontFamily="monospace">
                    ENTRY {bar.clock}
                  </text>
                </g>
              );
            })()}
          </svg>

          {hover && (
            <div className="mt-2 px-3 py-2 rounded border border-zinc-200 dark:border-zinc-800 text-xs font-mono">
              <span style={{ color: ROLE_COLOR[hover.role] }}>{hover.role}</span>
              {"  "}{hover.clock}{"  "}{hover.endpoint}.{hover.metric} = {hover.value}
              {"  "}[{hover.z}σ]{"  "}price ${hover.price}
            </div>
          )}

          {!entryMin && (
            <div className="mt-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                <strong>{meta.name} took no entry.</strong> The shaded bands are the moves it was asked to explain; the dots are the signals it examined. It looked at these and concluded none of them justified a trade in advance. That refusal is the finding.
              </p>
            </div>
          )}
        </div>

        {/* ---------- 30% COMMENTARY ---------- */}
        <div className="flex-[3] p-4 overflow-y-auto">
          {a?.entry?.timestamp && (
            <div className="mb-4 px-3 py-2.5 rounded-lg border" style={{ borderColor: meta.hex + "60" }}>
              <div className="flex items-center gap-1.5 mb-1">
                <Zap size={13} style={{ color: meta.hex }} />
                <span className="text-[11px] uppercase tracking-wider font-mono text-zinc-500">Entry</span>
              </div>
              <div className="text-lg font-mono">{a.entry.timestamp}</div>
              {a.entry.leadMinutes != null && (
                <div className="text-xs text-zinc-500">{a.entry.leadMinutes} min before the move</div>
              )}
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1.5 leading-relaxed">{a.entry.reasoning}</p>
            </div>
          )}

          <div className="text-[11px] uppercase tracking-wider font-mono text-zinc-500 mb-1">Why</div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed mb-4">{a?.reasoning}</p>

          <div className="text-[11px] uppercase tracking-wider font-mono text-zinc-500 mb-1.5">
            Moves it had to explain
          </div>
          <div className="space-y-1.5 mb-4">
            {thrusts.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs font-mono px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-800">
                {t.direction === "UP"
                  ? <TrendingUp size={12} className="text-emerald-500" />
                  : <TrendingDown size={12} className="text-red-500" />}
                <span className={t.direction === "UP" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                  {t.pctMove}%
                </span>
                <span className="text-zinc-500">{t.startClock}→{t.endClock}</span>
              </div>
            ))}
            {!thrusts.length && <p className="text-xs italic text-zinc-500">No significant moves this session.</p>}
          </div>

          <div className="text-[11px] uppercase tracking-wider font-mono text-zinc-500 mb-1.5">
            Feeds it used ({usedFeeds.length})
          </div>
          <div className="space-y-1.5">
            {usedFeeds.map((r) => (
              <div key={r.id} className="px-2.5 py-2 rounded border text-xs"
                style={{ borderColor: (ROLE_COLOR[r.role] || "#a1a1aa") + "50" }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="w-2 h-2 rounded-sm" style={{ background: ROLE_COLOR[r.role] }} />
                  <span className="font-mono">{r.id}</span>
                </div>
                <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">{r.notes}</p>
              </div>
            ))}
            {!usedFeeds.length && (
              <p className="text-xs italic text-zinc-500">
                It used none of them — it examined all {a?.endpointReview?.length ?? 0} and rejected every one. See the full feed audit for its reasoning on each.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
