# GHOSTFLOW — SPY 0DTE Tab: Handoff Notes

Context for an AI assistant picking up this build. Read fully before changing code.

---

## 1. What this is

**GHOSTFLOW** is Michael's AI-driven market signal discovery platform (React/Vite/Tailwind
frontend, Express/Node backend, PostgreSQL on Railway). Its core question is *"was this
move knowable in advance?"* — with **"nothing was knowable, pass" treated as a
legitimate, first-class answer.**

The **0DTE tab** is a distinct feature inside it: an **end-of-day debrief tool** for SPY
0DTE options. Run it after the close and it replays the session bar-by-bar, identifies
every signal, picks the exact option contract the playbook's rules dictate, simulates the
bracket order against that contract's real price history, and writes the day up in plain
English.

**It is a learning/measurement tool, not a live trading system.** It never places orders.

Michael describes himself as a beginner coder with strong options-trading domain
knowledge. Explain code plainly; don't assume familiarity with JS idioms. He prefers you
make reasonable assumptions and keep moving, checking in only at genuine decision points.

---

## 2. The two source documents — AND THEY DISAGREE

Everything must trace to one of these two PDFs. **Do not invent rules.** When something
isn't in either document, say so rather than filling the gap with plausible-sounding
trading lore.

### A. Shen Lao "SPY 0DTE Playbook" (`@shentrades`, June 2026)
The **discretionary human strategy**:
- Trade only psychological levels: whole dollars, PMH/PML, PDH/PDL (Tier 1); half dollars (Tier 2)
- **Conviction stack — 3 checks:** (1) first touch? (2) how far + how fast did price travel
  here? ($2–3+ in 20–30 min = fast) (3) RSI confirmation (**>70 puts / <30 calls**)
  → all 3 = full size; 2 of 3 = standard; 1 or none = **no trade**
- **Strike selection:** 1 strike OTM *from the level*. Puts = level − 1, Calls = level + 1.
  Target premium $0.75–$1.50
- **Bracket order:** +20% TP / −12.5% SL, set immediately on fill, never moved
- **Schedule (ET):** 9:30–9:45 observe only ("zero trades") · 9:45 trade window opens ·
  **11:15 hard stop** ("Close the platform. Physically.") · max 2 trades/day
- **Touch rule:** 1st touch full size · 2nd touch drop one tier · 3rd touch skip
  (exception: 3rd touch after a $4+ exhaustion move is still valid)
- Grading matrix A+/A/B/C by level tier + touch + move size

### B. "Edge Lens Signal Guide v4" + the Pine Script
A **separate TradingView indicator** with its own, much stricter scoring:
- 0–20 point scale across 6 categories: Level (0–6), RSI+Swing (0–4), Confirmation
  (0–5: volume/speed/wick), Taps+Soft-tap (0–2), MTF bonus (0–2), Regime (−1 to +2)
- **A+ = 15+ points** (17 during ADX ≥ 28 strong trend) · **A-tier = 11–14** ·
  **RSI Extreme** = fires on RSI alone, *no level touch required*
- Guide says RSI thresholds are **73/26**; the deployed Pine script's input default is
  **73/29**. We use **29** (script wins; guide treated as doc drift) — see §5.
- Guide is explicit: A+ is the **only tier with real trade history**; A-tier and RSI
  Extreme are *"information, not instructions"* and carry no sizing recommendation.

### ⚠ The central tension
The playbook fires on **3 simple checks at any Tier 1 level**. Edge Lens requires
**11+/20 points**. We currently gate the playbook behind the Edge Lens score, which is
far stricter — this is why we produce ~6 trades/month while the playbook author's own
calendar shows ~23. **An open decision (see §8) is whether to add the playbook's
conviction stack as its own parallel lane.**

---

## 3. Data sources — what we have and don't

| Need | Source | Status |
|---|---|---|
| SPY underlying 1-min bars | Alpaca `/v2/stocks/SPY/bars`, **SIP feed** | ✅ Full OHLCV. SIP = CTA+UTP consolidated = same composite tape TradingView shows |
| SPY option 1-min bars | Alpaca `/v1beta1/options/bars` | ✅ Full OHLC back to Feb 2024. Free tier = **Indicative** feed (derived, not true OPRA prints) |
| Option **bid/ask** history | — | ❌ **Does not exist on Alpaca at any plan tier.** No historical option quotes endpoint |
| SPX underlying | — | ❌ Alpaca has SPX *options* but **not the SPX index** (`/v2/stocks/SPX/bars` → `bars: null`). Blocks any SPX port |

**Consequence:** all P&L is computed from *traded* prices with **no spread and no
commissions**. On a $0.20 contract a $0.01 spread is 5% — larger than a quarter of the
profit target. **Every number this tool produces is optimistic by an unmeasured amount.**
Say so whenever reporting results.

Databento is used elsewhere in GHOSTFLOW but **not** by the 0DTE tab. If real spreads are
ever needed, Databento `OPRA.PILLAR` (usage-priced, includes NBBO) is the recommended
route — Michael already has a Databento account.

**Bullflow is explicitly excluded from this project. Ignore it.**

---

## 4. File map

```
server/
  alpacaClient.js      SPY SIP bars + option bars (occSymbol builds OCC symbols)
  zeroDTE.js           THE ENGINE. Ports Edge Lens v4 scoring to run retrospectively.
                       Indicators (RSI/ATR/ADX/VWAP/MTF), levels, scoring, fire logic,
                       playbook touch policy, research-lane classification, near-misses
  zeroDTEOptionSim.js  Picks 1-strike-OTM contract, simulates +20%/−12.5% bracket
                       against real option OHLC
  zeroDTEStory.js      Deterministic plain-English session narrative (no AI, no invention)
  zeroDTECalendar.js   Month simulation + in-memory day cache + DB persistence
  zeroDTEStore.js      Postgres read/write for simulated trades
  zeroDTEAnalysis.js   Feature slicing + version comparison
  buildInfo.js         Deployment/commit provenance
  testZeroDTE*.js      CLI harnesses (Week / Diag / Policy)
src/
  ZeroDTE.jsx          The tab: daily debrief, trade cards, charts, historical calendar

API: POST /api/0dte/analyze · POST /api/0dte/month · GET /api/0dte/performance
     GET /api/0dte/versions · GET /api/build
```

---

## 5. Key decisions and WHY (do not silently reverse these)

**Wick-aware level touches.** A level counts as touched when the bar's **high–low range**
intersects level ± $0.05 — *not* `|close − level| ≤ $0.05` (which is what the Pine script
does). Grounded in the playbook's own worked example: *"1-min candle wicks to $750.20,
closes at $749.75. Rejection confirmed."* A close-only test cannot see that trade. This
deliberately diverges from the Pine script — **expect our replay to show more signals than
the TV chart, on purpose.** Effect on a test week: tradeable setups 4 → 9.

**RSI call threshold = 29, not 26.** The deployed script's default wins over the guide's
text. ⚠ **Honest caveat recorded in-code:** 29 was re-chosen after 26 disqualified a
winning trade *in a 2-trade sample*. That is not evidence. Judge on months.

**Playbook hours enforced but not hidden.** Signals outside 9:45–11:15 ET are still
simulated and shown (amber "OUTSIDE PLAYBOOK HOURS" badge) but **excluded from Day P&L**.
The calendar totals them separately. This matters: several of the best-looking trades fire
outside the window, and the tool must not let that flatter the strategy.

**Fill modeling.** TP fills at the limit price exactly. SL fills at the worse of the stop
price and the bar close (models slippage). Bracket is evaluated against each minute's
**high and low**, not the close — a 0DTE option can run +20% and give it back inside one
minute. When both TP and SL are touched in the same minute, **the stop is assumed first**
(pessimistic — never flatter an ambiguous bar).

**ADX uses Wilder's RMA**, not SMA (matches Pine's `ta.dmi`). Affects the strong-trend
check that raises the A+ bar from 15 to 17.

**Session lookback is 30 calendar days** so the 14-day daily ATR behind gap protection
actually has 14 sessions.

**Provenance is part of the row key.** `code_version` is in the trade id, so re-running a
day on the same commit is idempotent but a *new* commit writes a parallel set. This is
what makes "did that change help?" answerable instead of silently overwritten.

---

## 6. Bugs already found and fixed — do not reintroduce

1. **Volume climax read the wrong index** — compared against the first bar of the window
   instead of the window max. Inflated confirmation scores badly.
2. **Missing Pine edge triggers.** A-tier and RSI Extreme fires were missing
   `and not <cond>[1]`, so they re-fired every cooldown lapse instead of only when the
   condition first became true.
3. **`/api/theses` was dead code** — registered *after* `app.get("*")`, so Express served
   the HTML shell instead of JSON. **All API routes must be registered above the
   catch-all.**
4. **Exit prices were recorded at the bar close**, producing impossible results like
   −17.3% on a −12.5% stop.
5. **`window` is a reserved word in Postgres** — the column is `pb_window`.
6. **Chart labels clipped**: recharts `position="right"` places labels outside the plot
   area. Use `insideTopRight` etc.
7. **Custom `dot` renderers on all-null series don't render.** Use `ReferenceDot`.

---

## 7. Current state (as of commit `c56e160`)

Working: daily debrief with trade cards (BOUGHT/SOLD blocks, contract details, option
price chart with entry/exit markers and a zoom/full-day toggle), SPY chart with levels +
signals + IN/OUT markers, RSI panel, out-of-hours shading, historical month calendar with
stats sidebar, DB persistence, feature analysis, version comparison.

**Sizing:** $1,000 base campaign (playbook tiers ×4: half $500 / full $1,000 /
size-up $1,500 / max $2,000).

**Results so far are NOT evidence of anything.** July 2026: 6 counted trades. August: 7.
At n=6 a 50% win rate has a confidence interval roughly 12%–88%. Early feature slices hint
that PDH/PDL levels outperform plain whole dollars — on 2 and 4 trades respectively. The
analyzer flags every bucket under 20 trades as `reliable: false`. **Respect that flag.**

---

## 8. Open decisions and known gaps

**OPEN — needs Michael's call:** add the playbook's **conviction stack + grading matrix**
as a parallel entry lane (see §2's tension). Would roughly quadruple cadence and is fully
grounded in the playbook text. Options discussed: third lane for comparison / replace
Edge Lens as primary / keep Edge Lens only.

**Not implemented:**
- Spread and commission modeling (the biggest realism gap — see §3)
- The playbook's 5-min confirmation *add* (Example 2 scenario B: wait for a 5-min close
  above the level, then add). Would need position adds + blended cost basis.
- Multi-timeframe chart-bouncing beyond the 5m/10m RSI already used for MTF confluence
- Pine Script export for live automation (the eventual goal — TV alerts → webhook)

**Worth auditing:** the touch counter keys VWAP on *type alone*, so every VWAP touch all
day increments one counter and by the 3rd tag it's permanently skipped. VWAP drifts
continuously and price crosses it repeatedly — this may be suppressing more than intended.
Check what fraction of near-misses return `not_first_touch` on VWAP.

---

## 9. Discipline — the part that matters most

This project's stated purpose is honest measurement. The failure mode is tuning
parameters until backtest numbers look good, then losing real money.

- **Never adjust a threshold because it improves a small-sample result.** Changes must be
  justified by the source documents or by a bucket with 20+ trades and a large effect.
- **Report profit factor and expectancy, not just win rate.**
- **State the spread/commission caveat** whenever presenting P&L.
- **Preserve "no trade" as a valid outcome.** Days with zero signals are information.
- Version-comparison guardrail: two code versions are only comparable if they cover the
  **same sessions** — check `overlapWithLatest` and the `comparable` flag.
- The research lanes (`HIGH_QUALITY_A` testing 13–14 point setups, `EXTENDED_A_PLUS`
  testing 11:15–12:30) are **paper-only** and excluded from official P&L. Keep them that
  way; promoting a band chosen just below the A+ line on a small sample is
  threshold-shopping.

---

## 10. Practical gotchas

- **Railway Postgres needs the `zerodte_trades` table dropped once** to pick up the
  provenance columns — `CREATE TABLE IF NOT EXISTS` won't add columns to an existing table.
- The calendar's day cache is **in-memory** — restart the server after any logic change or
  you'll read stale results.
- Local dev needs `node --env-file=.env server.js`; syntax-check with `node --check`;
  capture Vite errors with `npm run build 2>&1 | tail -3`.
- Repo: `https://github.com/michaeladams1/ghostflow.git` ·
  Local: `/Users/michael/Documents/GitHub/pm-paper-trader/ghostflow` ·
  Deployed: `https://ghostflow-production-27e9.up.railway.app` (HTTP Basic Auth)
- For TradingView parity checks, the chart needs **extended hours ON** — the Pine script's
  pre-market levels can't compute without it.
- Full bar-for-bar parity with TradingView is **not achievable**: different tape, different
  warm-up depth, live ticks vs closed bars. Small divergences are expected and fine.
