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

export default function ChartView({ record, modelId, meta, onClose, onRerun, rerunning }) {
  const a = record.analysis?.[modelId];
  const price = record.briefing?.priceSeries || [];
  // Options mode: the actual instrument. Stored by analyses run after the
  // contract-overlay feature shipped; older records simply won't have it.
  const contractSeries = record.briefing?.contractSeries || [];
  const contract = record.contract || null;
  const hasContract = !!(contract && contractSeries.length > 1);
  const thrusts = record.briefing?.timeline?.priceThrusts || [];
  const events = record.briefing?.timeline?.events || [];
  const [hover, setHover] = useState(null);
  const [showRole, setShowRole] = useState({ SIGNAL: true, CONFIRMATION: true, NOISE: false });
  // Minimum sigma to plot. Defaults to 3 because a feed can fire 100+ times a
  // session at the 2.5-sigma detection floor, and plotting all of them buries
  // the handful of readings that actually mattered.
  const [minSigma, setMinSigma] = useState(3);

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

  // A feed the model called a SIGNAL that fired 40+ times in a single session is
  // not rare — it is common, and a rule built on it will fire constantly and
  // over-trade. Flagged on the chart, because it's the exact mistake the
  // backtest keeps catching only after the fact.
  //
  // NOTE: this must sit ABOVE the early `if (!geom) return` — a hook called
  // after a conditional return violates React's rules of hooks and crashes on
  // the very records that have no chart data.
  const overFiring = useMemo(() => {
    const byFeed = {};
    events.forEach((e) => {
      const role = roleByFeed[e.endpoint];
      if (role !== "SIGNAL" && role !== "CONFIRMATION") return;
      byFeed[e.endpoint] = byFeed[e.endpoint] || { feed: e.endpoint, count: 0, role };
      byFeed[e.endpoint].count++;
    });
    return Object.values(byFeed).filter((f) => f.count >= 40).sort((a, b) => b.count - a.count);
  }, [events, roleByFeed]);

  const geom = useMemo(() => {
    if (!price.length) return null;
    // Right padding widens when the contract overlay is present, to make room
    // for its own axis labels — an option at $0.45 cannot share a $14 stock's
    // y-scale, so it gets a second scale on the right.
    const W = 1000, H = 460, PAD = { l: 56, r: hasContract ? 56 : 16, t: 20, b: 34 };
    const prices = price.map((p) => p.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.08 || 1;
    const yMin = lo - pad, yMax = hi + pad;

    const minutes = price.map((p) => clockToMinutes(p.clock));
    const t0 = Math.min(...minutes), t1 = Math.max(...minutes);

    const x = (min) => PAD.l + ((min - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);

    // Contract price scale (right axis), independent of the stock scale.
    let cy = null, cyMin = 0, cyMax = 0;
    if (hasContract) {
      const cv = contractSeries.map((p) => p.value);
      const cLo = Math.min(...cv), cHi = Math.max(...cv);
      const cPad = (cHi - cLo) * 0.08 || 0.05;
      cyMin = cLo - cPad; cyMax = cHi + cPad;
      cy = (v) => PAD.t + (1 - (v - cyMin) / (cyMax - cyMin || 1)) * (H - PAD.t - PAD.b);
    }

    return { W, H, PAD, x, y, yMin, yMax, t0, t1, cy, cyMin, cyMax };
  }, [price, contractSeries, hasContract]);

  if (!geom) {
    // This analysis predates the chart data being stored. Rather than a dead
    // end, offer the fix directly — a re-run regenerates everything including
    // the price series.
    return (
      <div className="fixed inset-0 bg-white dark:bg-black z-[70] flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p className="text-base font-medium mb-2">This analysis has no chart data.</p>
          <p className="text-sm text-zinc-500 mb-5 leading-relaxed">
            It was produced before the engine stored the price series. A re-run regenerates it — along with the 3-session window, intraday gamma, and the auto-backtest. Takes 1–2 minutes.
          </p>
          <div className="flex items-center justify-center gap-2">
            {onRerun && (
              <button onClick={() => { onClose(); onRerun(); }} disabled={rerunning}
                className="text-sm px-4 py-2 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50">
                {rerunning ? "Re-running…" : "Re-run now"}
              </button>
            )}
            <button onClick={onClose}
              className="text-sm px-4 py-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { W, H, PAD, x, y, yMin, yMax, cy, cyMin, cyMax } = geom;
  const pathD = price.map((p, i) => `${i ? "L" : "M"}${x(clockToMinutes(p.clock))},${y(p.price)}`).join(" ");
  // The actual instrument (options mode): amber line on its own right-hand
  // scale. Signal dots stay pinned to the stock line — that is where the
  // timing evidence lives; this line is what the P&L actually did.
  const contractPathD = hasContract && cy
    ? contractSeries.map((p, i) => `${i ? "L" : "M"}${x(clockToMinutes(p.clock))},${cy(p.value)}`).join(" ")
    : null;
  const contractLabel = contract ? `${contract.strikePrice}${(contract.contractType || "?")[0]} ${contract.expirationDate}` : null;

  // Only the events from feeds THIS model used, in the roles it assigned,
  // above the sigma floor.
  const shown = events.filter((e) => {
    const role = roleByFeed[e.endpoint];
    return role && showRole[role] && Math.abs(e.z) >= minSigma;
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
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {["SIGNAL", "CONFIRMATION", "NOISE"].map((r) => (
              <button key={r} onClick={() => setShowRole((s) => ({ ...s, [r]: !s[r] }))}
                className={`flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded border transition
                  ${showRole[r] ? "border-zinc-400 dark:border-zinc-600" : "border-zinc-200 dark:border-zinc-800 opacity-40"}`}>
                <span className="w-2 h-2 rounded-sm" style={{ background: ROLE_COLOR[r] }} />
                {r} {counts[r]}
              </button>
            ))}

            <div className="flex items-center gap-2 ml-2">
              <span className="text-[11px] font-mono text-zinc-500">min σ</span>
              <input type="range" min="2.5" max="15" step="0.5" value={minSigma}
                onChange={(e) => setMinSigma(Number(e.target.value))} className="w-28" />
              <span className="text-[11px] font-mono w-8">{minSigma}</span>
              <span className="text-[11px] font-mono text-zinc-500">
                {shown.length} of {events.length} plotted
              </span>
            </div>
          </div>

          <p className="text-[11px] font-mono text-zinc-500 mb-3">
            Only the feeds {meta.name} used, in the roles it assigned. Dot size scales with sigma.
          </p>

          {/* If a feed the model called a SIGNAL fired dozens of times in one
              session, that is itself a finding — it means the "signal" is common,
              and a rule built on it will over-trade. Surfaced rather than buried. */}
          {overFiring.length > 0 && (
            <div className="mb-3 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10">
              <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
                <strong>Over-firing:</strong> {overFiring.map((f) => `${f.feed} fired ${f.count}x`).join(", ")} on this one session — despite being classed {overFiring[0].role}. A signal that common will over-trade. Check the backtest.
              </p>
            </div>
          )}

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

            {/* THE ACTUAL INSTRUMENT (options mode): the contract's own tape on
                its own right-hand scale. A 1.7% stock move can be a 40% contract
                move — this line is the P&L reality the verdict is about. */}
            {contractPathD && (
              <>
                <path d={contractPathD} fill="none" stroke="#f59e0b" strokeWidth="1.4" strokeDasharray="5 3" opacity="0.85" />
                {gridY.map((v, i) => {
                  const cv = cyMin + ((cyMax - cyMin) * i) / (yTicks - 1);
                  return (
                    <text key={`c${i}`} x={W - PAD.r + 8} y={y(v) + 3} fontSize="10" textAnchor="start" fill="#f59e0b" fontFamily="monospace">
                      {cv.toFixed(2)}
                    </text>
                  );
                })}
                <text x={W - PAD.r - 6} y={PAD.t + 12} fontSize="10" textAnchor="end" fill="#f59e0b" fontFamily="monospace">
                  {contractLabel} → right axis
                </text>
              </>
            )}

            {/* Signal events, coloured by the ROLE THIS MODEL assigned, and SIZED
                BY SIGMA. Sizing matters: a feed the model called a "signal" may
                have fired 100+ times in one session, and a chart of 100 equal
                dots hides the one 54-sigma spike that actually mattered. Scaling
                by magnitude makes the real event pop and lets the noise recede —
                and it also makes an over-firing feed visibly obvious. */}
            {shown.map((e, i) => {
              const role = roleByFeed[e.endpoint];
              const mx = clockToMinutes(e.clock);
              const bar = price.find((p) => clockToMinutes(p.clock) === mx);
              if (!bar) return null;
              const az = Math.abs(e.z);
              const r = Math.min(2 + az * 0.55, 11);   // 2.5σ -> ~3.4px, 54σ -> 11px
              const op = Math.min(0.25 + az * 0.06, 0.9);
              return (
                <circle key={i} cx={x(mx)} cy={y(bar.price)} r={r}
                  fill={ROLE_COLOR[role]} opacity={role === "NOISE" ? op * 0.5 : op}
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
