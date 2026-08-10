# GHOSTFLOW — SPY 0DTE Tab: Handoff Notes

Context for an AI assistant picking up this build. Read fully before changing code.

> **MAINTAIN THIS DOC.** It is the project's shared memory. When a meaningful 0DTE change
> lands — a rule added or altered, a schema change, a bug fixed, a decision made, a gap
> closed — **update this file in the same commit**. A stale handoff doc is worse than
> none, because it will be trusted. Sections most likely to need edits: §4b (schema),
> §5 (decisions), §6 (bugs), §7 (state), §8 (open questions).

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
**11+/20 points**. Gating the playbook behind the Edge Lens score was far stricter and
likely contributed to low cadence. The original conviction stack now runs as its own
paper-only `SHEN_CONVICTION` comparison lane; it never changes official P&L.

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
  zeroDTEBacktestJobs.js Durable 24-month queue, DB checkpoints, lease + restart recovery
  zeroDTEStore.js      Postgres read/write for simulated trades
  zeroDTEAnalysis.js   Feature slicing + version comparison
  buildInfo.js         Deployment/commit provenance
  testZeroDTE*.js      CLI harnesses (Week / Diag / Policy)
src/
  ZeroDTE.jsx          The tab: daily debrief, trade cards, charts, historical calendar

API: POST /api/0dte/analyze · POST /api/0dte/month
     GET /api/0dte/calendar
     POST /api/0dte/backtest-jobs · GET /api/0dte/backtest-jobs/latest
     GET /api/0dte/backtest-jobs/:id · GET /api/0dte/performance
     GET /api/0dte/versions · GET /api/build
```

The calendar includes a **Backtest last 24 months** button. It persists a job in Postgres
and returns immediately; Railway processes months sequentially, oldest first, while the
browser only polls saved progress. The page may close without stopping work. Each month
is a durable checkpoint. A 30-minute database lease prevents overlapping deployments
from duplicating work, and a one-minute stateless recovery sweep resumes expired jobs
after a crash or same-commit restart. A new commit cannot honestly finish an old job
because trade provenance would change mid-run, so startup explicitly fails superseded
jobs and the new version gets its own run. Retrying a failed same-version job keeps its
completed-month checkpoint. Trade writes remain idempotent per day and code version.

The five monthly summary cards are also calendar filters. Clicking playbook hours,
outside hours, research lanes, Shen conviction, or Frontier model switches every day
cell and the full statistics sidebar to that lane. Winning days are green and losing days
are red regardless of lane color; the active summary card gets a visible focus ring. Day
summaries include per-trade P&L arrays for all five lanes so win rate and best/worst trade
are not inferred from aggregate daily P&L. Every card shows its own trade count and win
percentage; outside-hours win rate is computed from its individual simulated trades and
remains explicitly excluded from official P&L. The calendar is a five-column Monday-Friday
view; Saturday and Sunday headers and cells are intentionally omitted so trading sessions
have more horizontal room while weekday ghost cells preserve correct date alignment. The
large summary-card P&L totals display rounded whole dollars and never split the sign from
the amount; detailed calendar and trade values retain cents.

**Opening the calendar is read-only.** `GET /api/0dte/calendar` reconstructs month/day
summaries from `zerodte_trades`; it never calls Alpaca or runs the simulator. It selects
the production code version with the greatest distinct-session coverage, breaking ties
by most recent write, so a partial new run cannot displace the last complete calendar.
The explicit **Rerun 24-month backtest** button starts a new durable job even when the
same code version already has a completed job. When that run reaches equal/full coverage,
the saved-calendar reader naturally promotes it.

---

## 4b. Database — what gets logged and how to query it

PostgreSQL on Railway (`DATABASE_URL`). Schema lives in `server/db.js` → `ensureSchema()`,
called lazily on first use. Five tables; `zerodte_trades` and
`zerodte_backtest_jobs` belong to this feature —
`trades`, `feed_cache`, and `theses` belong to GHOSTFLOW's separate 3-analyst system,
**don't touch them**.

### `zerodte_trades` — one row per fired signal

Written by `server/zeroDTEStore.js` → `saveSessionTrades()`, called from
`zeroDTECalendar.js` after every day simulation. **Both official and research-lane fires
are stored**, including ones whose contract simulation failed (so gaps stay visible rather
than silently missing).

```sql
id            TEXT PRIMARY KEY   -- symbol:date:code_version:lane:tier:direction:clock
symbol        TEXT               -- 'SPY'
session_date  TEXT               -- 'YYYY-MM-DD'
fired_at      TIMESTAMPTZ        -- bar timestamp of the signal
clock         TEXT               -- '10:02 AM ET'
et_minute     INT                -- minutes past ET midnight (570 = 9:30) — use for time bucketing
pb_window     TEXT               -- 'before' | 'in' | 'after'  (playbook 9:45–11:15 window)
                                 --   NB: 'window' is a Postgres reserved word — hence pb_
lane          TEXT               -- 'official' | 'HIGH_QUALITY_A' | 'EXTENDED_A_PLUS'
                                 --   | 'SHEN_CONVICTION'
tier          TEXT               -- 'A+' | 'A' | 'RSI Extreme' | research tier labels
direction     TEXT               -- 'CALL' | 'PUT'

-- WHY it fired (the feature set — this is the analysis substrate)
level_type    TEXT               -- WHOLE_DOLLAR | PDH | PDL | PMH | PML | OR_HIGH | OR_LOW
                                 --   | ORB15_SUPPORT | ORB15_RESISTANCE | VWAP
level         NUMERIC            -- the ACTUAL trigger level price, not the rounded display level
touch_number  INT                -- 1st/2nd/3rd arrival at that level today
points        INT                -- Edge Lens score 0–20
rsi           INT
swing         INT                -- RSI swing magnitude
vol_pts       INT                -- 0–2 volume confirmation
speed_pts     INT                -- 0–2 speed of move
wick_pts      INT                -- 0–1 wick rejection
mtf_aligned   BOOLEAN            -- 1m+5m+10m RSI agreement

-- WHAT HAPPENED
contract      TEXT               -- OCC symbol, e.g. SPY260807C00772000
strike        NUMERIC
entry_price   NUMERIC            -- NULL when the contract sim failed (illiquid / no such contract)
exit_price    NUMERIC
entry_clock   TEXT
exit_clock    TEXT
hold_minutes  INT
exit_reason   TEXT               -- 'TP hit (+20%)' | 'SL hit (-12.5%)' | held-to-close | ambiguous-bar note
pct_return    NUMERIC
contracts     INT                -- position size in contracts
pnl           NUMERIC            -- dollars
counted       BOOLEAN            -- TRUE only when lane='official' AND pb_window='in' AND sim succeeded
features      JSONB              -- size tier, suggestedStop, exhaustionException, underlying price,
                                 --   simFailed reason; Shen method, conviction count/checks and
                                 --   30-minute move distance. Put NEW fields HERE before adding columns.

-- PROVENANCE (see §5)
deployment_id TEXT               -- Railway deployment id, or 'local-<sha>'
commit_sha    TEXT
code_version  TEXT               -- 12-char sha + '-dirty' if uncommitted. PART OF THE ROW ID.
branch        TEXT
environment   TEXT               -- 'production' | 'local'
created_at    TIMESTAMPTZ
```

Indexes: `(symbol, session_date)`, `(lane, counted)`, `(code_version, counted)`.

### `zerodte_backtest_jobs` — durable 24-month runner

One row per code-version/date-window backfill. It stores `status`, total/completed months,
the current year/month, errors, code version, timestamps, and a worker lease. The browser
never owns execution. A completed job is reused, a failed job resumes at its saved
`completed_months`, and a new code version gets a separate job and trade rows.

### Write semantics — important

`saveSessionTrades()` runs `DELETE ... WHERE symbol AND session_date AND code_version`
inside a transaction, then inserts. So:
- Re-running a day on the **same commit** → idempotent replace, no duplicates
- Re-running a day on a **new commit** → parallel row set; the old version's rows survive
- **Therefore `SELECT SUM(pnl)` without a `code_version` filter double-counts** across
  versions. Always filter, or use the endpoints, which handle it.

### Reading it

Prefer the API over raw SQL:
- `GET /api/0dte/performance?from=&to=&lane=official&countedOnly=true&codeVersion=`
  → slices by tier, direction, level type, touch number, score band, RSI band, time of
  day, MTF, volume/speed/wick points, exit reason, entry premium. Each slice returns
  trades, winRate, totalPnl, avgPnl, **profitFactor**, avgHold, and a **`reliable`** flag
  (`false` below `MIN_SAMPLE = 20`, defined in `zeroDTEAnalysis.js`).
- `GET /api/0dte/versions` → per-code-version rollup with `overlapWithLatest` + `comparable`.
- `GET /api/0dte/calendar?symbol=SPY&year=&month=` → instant saved calendar using the
  most complete production version. This endpoint never simulates.
- Programmatic: `loadTrades({symbol, from, to, lane, countedOnly, codeVersion})` and
  `coveredSessions({symbol})` from `zeroDTEStore.js`.

Local psql access pattern used elsewhere in this repo:
```js
import('pg').then(async ({default:pg}) => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL,
                            ssl: { rejectUnauthorized: false } });
  await c.connect(); /* ... */ await c.end();
});
```
Run with `node --env-file=.env`. `db.js` auto-detects local vs Railway and disables SSL for
localhost/`railway.internal` — Railway's *internal* URL doesn't support SSL while its
*public* URL requires it. Don't force it unconditionally; that broke local testing before.

### What is NOT logged
Per-bar series (price, RSI, running scores) are **not** persisted — only fires. The
calendar's day-level aggregates live in an **in-memory Map** that dies on restart. Adding
bar-level analysis means a new table, not a tweak.

### What a row actually represents — read before interpreting row counts

**A row is a SIGNAL, not a taken trade.** Three distinct states, distinguished by two
columns:

| State | `entry_price` | `counted` | Meaning |
|---|---|---|---|
| Not tradeable | `NULL` | `false` | Fired with no level touch (RSI Extreme) — the playbook anchors every strike to a level, so there is no contract to buy. Logged so the pass is visible. |
| Simulated, not counted | set | `false` | A real contract was priced and bracketed, but it fired outside 9:45–11:15 ET. Shown amber in the UI, excluded from P&L. |
| Counted | set | `true` | Inside playbook hours, contract simulated — **this is the real P&L.** |

Observed distribution on the first 5 sessions **across two code versions**: 56
not-tradeable RSI Extreme rows, 10 simulated-but-out-of-window, **4 counted**. Per
version that is 28 / 5 / 2. So a large row count is mostly the tool recording what it
*passed on* — which is the point.

⚠ **Known logging gap:** signals suppressed by the playbook touch policy (3rd+ touch) are
blocked *before* the fire is created, so they produce **no row at all**. They appear only
in the in-memory `nearMisses` diagnostic, which is not persisted. If "how often did the
touch rule veto a setup?" matters, that needs its own row type or table.

### Rows are per code version — don't read the table as a flat list

Because `code_version` is in the primary key, the same session simulated under two commits
produces **two visually identical rows**. In a raw table view (e.g. Railway's Data tab)
that looks like duplication; it isn't. Always group or filter by `code_version`.

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

**Shen conviction is a separate paper lane.** `SHEN_CONVICTION` implements the source
playbook's three checks without an Edge Lens score gate: first touch; a $2+ move into the
level during the prior 30 minutes (the lower bound of the document's "$2–3+" wording);
and RSI <30 for calls / >70 for puts. Two checks qualify as STANDARD, all three as FULL.
It uses only whole-dollar, PDH/PDL and PMH/PML levels, honors 9:45–11:15 ET and the touch
policy, requires the 30-bar net move to approach the level in the trade's direction, and
caps itself at two signals per day. Every entry uses a fixed paper $1,000 so
the experiment measures entry quality without inventing a dollar mapping for the PDF's
"standard" versus "full" language. Results have their own fourth calendar box and are
excluded from official and existing research totals.

**Frontier v7.1 is the live paper lane** ($1,000 max **per trade**; concurrent
capital above $1k is allowed, but selection currently keeps **1 fire/day**).
Eligibility: **PUT only**, **PDH/PDL levels only** (WHOLE_DOLLAR dropped after
it showed ~13% WR / net-negative on the stored book), Edge Lens **points ≥ 12**,
**first touch**, `et_minute >= 585`, `entry_price > 0`. Best score/day after
setup dedupe. Selection-only change — no 24mo re-sim required.
**Exits abandon the playbook +20%/−12.5% bracket**: runner target / **−50% stop**,
hold toward the close (no 11:15 hard stop). Official / research / Shen still use
playbook brackets. Frontier P&L is stored in `frontier_*` columns at **$1,000
paper**. Local evidence (`server/frontierPutValidate.js` `top1_PUT_pts12`):
holdout avg day ~**$576** (25 days) · full-period train ~**$173** (56 days) —
holdout clears the $250/day goal; train does not yet. Multi-trade and CALL-
inclusive blends missed the target on full-period samples
(`frontierBlendSearch.js`, `frontierBlendExpand.js`). **A new 24-month backtest
is required** after v7 deploy; the in-flight v6 job remains useful as a runner-
exit baseline but will not match v7 PUT/pts filters. Until a v7 re-sim finishes,
the calendar may fall back to $1k on playbook exit prices.

**Calendar capital + P&L chart:** each lane day includes `*Deployed` notionals
(contracts × entry × 100; Frontier uses $1k paper sizing). Month/Year views
plot **cumulative P&L from $0** (one green line) and **per-period deployed**
bars (that day/month's capital only — never cumulative). Day/month P&L stays
in the tooltip; it is not drawn as a second gains line (that read as −$120 on
a +$70 cumulative day).

**Volume sleeve (paper lane `VOLUME`)** sits beside Frontier v7 for cadence.
Live scans: **ORB_HOLD + VWAP_RECLAIM only** (ORB_FAIL and WEEKLY_DRIVE dropped
after 2026 YTD validation — better WR/P&L, still ~32 tpm). Sizing $1k/trade;
exits **+30% / −15%** (not Frontier runner/−50%). Official P&L unchanged.
Volume alone does not clear $250; the **combined Frontier book** does.
Persist via `simulateDay` or `frontierVolumeBackfill.js` (lane-scoped upsert
onto the widest calendar `code_version`).

**Audit layers (do not mix):** Official Day P&L = playbook +20%/−12.5% on
counted in-hours fires. Frontier Day P&L = PUT pts≥12 first-touch selection
with runner/−50% exits on the same option bars. Volume Day P&L = VOLUME lane
rows with +30%/−15%. The daily debrief shows Frontier and Volume as separate
sections with full trade cards; Frontier cards include an
`Audit: N × (exit − entry) × 100 = P&L` line so calendar totals can be
checked trade-by-trade.

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
8. **Opening the month calendar triggered a simulation.** Calendar navigation now reads
   persisted rows only; rerunning history requires the separate 24-month button.

---

## 7. Current state (after commit `30f23d9` plus the Shen-lane working change)

Working: daily debrief with trade cards (BOUGHT/SOLD blocks, contract details, option
price chart with entry/exit markers and a zoom/full-day toggle), SPY chart with levels +
signals + IN/OUT markers, RSI panel, out-of-hours shading, historical month calendar with
stats sidebar, DB persistence, feature analysis, version comparison, and a fourth
paper-only Shen conviction comparison box.

**Sizing:** $1,000 base campaign (playbook tiers ×4: half $500 / full $1,000 /
size-up $1,500 / max $2,000).

**Results so far are NOT evidence of anything.** Under the current code version, August
2026 has **2 counted trades** (+$190 on 8/3, −$120 on 8/4 = **+$70**), plus 5 more
simulated outside playbook hours (+$324) and 56 non-tradeable RSI Extreme signals.

⚠ **Headline numbers move whenever the logic changes.** Earlier drafts of this doc quoted
"July: 6 trades / +$307" and "August: 7 trades" — those came from *older code versions*
that are still sitting in the table alongside the current ones. **Do not quote a number
from this section without re-querying and filtering by the current `code_version`.** This
is precisely why provenance is in the row key.

Early feature slices hint that PDH/PDL levels outperform plain whole dollars — on a
handful of trades. The analyzer flags every bucket under 20 trades as `reliable: false`.
**Respect that flag.**

---

## 8. Open decisions and known gaps

**DECIDED:** the playbook's conviction stack is a separate paper-only comparison lane.
It does not replace Edge Lens and cannot contribute to official P&L. Promotion requires
enough same-version observations to pass the project's sample-size guardrails.

**Not implemented:**
- Spread and commission modeling (the biggest realism gap — see §3)
- The playbook's 5-min confirmation *add* (Example 2 scenario B: wait for a 5-min close
  above the level, then add). Would need position adds + blended cost basis.
- Multi-timeframe chart-bouncing beyond the 5m/10m RSI already used for MTF confluence
- Pine Script export for live automation (the eventual goal — TV alerts → webhook)
- Half-dollar Tier 2 levels in the Shen lane. The current engine only has whole-dollar
  psychological levels; adding half dollars should be a deliberate follow-up, not an
  undocumented expansion of this first comparison.

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

- **Ship 0DTE changes through a pull request.** Start from current `main`, create an
  `agent/<description>` branch, stage only the intended files, run `npm test`,
  `npm run build`, and `git diff --check`, push the branch, write a PR explaining the
  behavior and evidence, then merge the PR into `main`. Update this handoff in the same
  PR whenever the change affects rules, storage, results interpretation, or open decisions.
- **There is only ONE database.** Local `.env` `DATABASE_URL` points at the *same* Railway
  Postgres the deployed app uses — local runs and production runs write to the same table,
  distinguished only by `environment` / `code_version`. (An earlier note here claimed
  Railway needed a separate schema migration; that was wrong — verified by seeing both a
  `local-*` and a real Railway deployment UUID in the same table.)
- The calendar's day cache is **in-memory**, but the 24-month job checkpoint is durable.
  Restarting the same commit during a backfill resumes at the next unfinished month after
  its lease expires. Deploying a new commit retires the old-version job instead; start a
  new run so one result set never mixes code versions. Restart after any logic change so
  single-month calendar reads aren't stale.
- Local dev needs `node --env-file=.env server.js`; syntax-check with `node --check`;
  capture Vite errors with `npm run build 2>&1 | tail -3`.
- Repo: `https://github.com/michaeladams1/ghostflow.git` ·
  Local: `/Users/michael/Documents/GitHub/pm-paper-trader/ghostflow` ·
  Deployed: `https://ghostflow-production-27e9.up.railway.app` (HTTP Basic Auth)
- For TradingView parity checks, the chart needs **extended hours ON** — the Pine script's
  pre-market levels can't compute without it.
- Full bar-for-bar parity with TradingView is **not achievable**: different tape, different
  warm-up depth, live ticks vs closed bars. Small divergences are expected and fine.
