# AI Options Trading Research System — Architecture

*Living document. Update this file as decisions are made or changed. Last major revision: reflects pivot from batch backtesting to trade-by-trade thesis accumulation.*

## 1. Purpose

Build a system where three AI models (Claude, GPT, Grok) each independently study options trades that Michael manually identifies as successful, and build up a working thesis on what conditions tend to precede a great outcome. This is NOT machine learning / model fine-tuning. It is closer to how a discretionary trading desk's analysts keep and refine written notes over time.

## 2. Core Loop (Settled)

1. **Trade Input UI** — Michael manually logs a trade, marked as a **win or a loss** (symbol, date, entry, exit, contract details, ~30 day window). Losses don't need to be pre-judged as "near-misses" — that's determined later in the pipeline.
2. **Three AI Analysts Pull Historical Data** — Claude, GPT, and Grok each independently use tools (Quant Data, Databento, etc.) to pull the real historical data leading up to that trade — volume, IV, flow, price action. This happens the same way for wins and losses.
3. **Near-Miss Check (losses only)** — for a logged loss, an analyst checks whether it showed the Setup Conditions currently in the thesis. If yes, it's a genuine near-miss and becomes real contrast evidence. If no (never looked like a real setup), it's logged but flagged as low information value and mostly ignored by the thesis.
4. **Each AI Forms/Updates a Thesis** — wins reinforce Setup Conditions; qualifying near-miss losses populate Counter-Examples. Not "was this good" (already known) but "what conditions lined up beforehand, and what distinguishes this from a similar trade that failed."
5. **Individual Knowledge Bases** — Each AI keeps its own evolving thesis document, revised after every trade.
6. **Shared Knowledge Base** — After every trade, the three individual theses are compared and merged into one collaborative view.

## 3. Key Decisions & Why

| Decision | Reasoning |
|---|---|
| Thesis documents, not fine-tuning | Anthropic has no self-serve fine-tuning API for Claude (Haiku-only via AWS Bedrock, enterprise-gated); Grok has no public fine-tuning; 30 trades/month is nowhere near enough data for fine-tuning anyway. A growing document that's re-read each time achieves the same "gets smarter" effect without any of those blockers. |
| Human-selected trades over ~30 days | Michael identifies winning trades manually. Known limitation: this is a selected sample, not random. |
| Full scope from the start (not a scoped-down MVP) | Michael made this call explicitly, overruling scope-reduction advice. All noted vendors/models/engines are in scope for v1. |
| Kell's price-action glossary as optional reference | Gives the 3 AI analysts a shared vocabulary (Wedge Pop, EMA Crossback, Base n' Break, Exhaustion/Reversal Extension, etc.) so their theses are easier to compare and merge — but it's a reference, not gospel. |
| Thesis document = structured sections | Setup Conditions, Supporting Evidence (linked trades), Confidence Level (tied to sample size), Counter-Examples, Last Updated. |
| Merge cadence = after every trade | Keeps the shared KB current rather than batching; simplest to implement first. |
| Survivorship bias = win + loss logging with AI-judged near-miss check | Michael logs both wins and losses from day one. For each loss, an analyst checks it against the thesis's current Setup Conditions using the same data pull as wins. Genuine near-misses become real Counter-Examples; obviously-bad losses are flagged low-value. |
| Disagreement handling = preserved, not blended | The shared KB keeps each AI's attributed view plus a "Points of Disagreement" note. A claim only gets promoted to a high-confidence shared thesis once 2 of 3 AIs independently agree. |
| Vendor timing = Quant Data + Databento only for now | ThetaData/ORATS are deferred until a real data gap appears in the working pipeline. |
| Build order = thesis schema → UI → data integration → AI orchestration → merge logic | Thesis schema first since it defines exactly what the trade input UI needs to capture. |
| Data vendor division confirmed | Quant Data = options analytics (flow, GEX, dark pool, IV), has native MCP support (`https://api.quantdata.us/mcp`). Databento = raw underlying stock price/tick/order book history, which Quant Data doesn't cover. Bullflow (already MCP-connected in Michael's account) explicitly not used for this project. |
| Indicator-overlay explanations = AI-generated, not hardcoded rules | When the chart overlay flags a combination (e.g. GEX + dark pool + volume), the written explanation comes from each AI's own reasoning tied to its thesis — not a fixed rules engine. |
| Project codename | GHOSTFLOW |
| Per-trade Q&A | Each trade has its own scoped chat, per model, using only that trade's data + that model's thesis — not a general chat about the whole system. |

## 4. Components To Build

- [x] **Trade Log UI (prototype)** — mock data, filterable by win/near-miss/low-info
- [x] **Trade Detail UI (prototype)** — 4 fully independent model tabs, each with its own chart, indicator overlay, verdict, and scoped chat
- [x] **Data vendor integration** — Quant Data + Databento wired into a real `/api/trades` endpoint; logging a trade now pulls real price history + options flow (storage is a temporary JSON file — see note below)
- [x] **AI provider connection layer** — `server/aiProviders.js` has working Claude/GPT/Grok client functions + a connectivity test script (`server/testAIProviders.js`).
- [x] **AI analyst orchestration (v1)** — `server/analysis.js` builds a real per-trade prompt (real price/volume bars + real options flow), calls all 3 models, and combines their views without treating a failed/crashed model as a real dissenting vote. First real test: META, 2026-06-25 to 2026-07-10 (+22.7%, verified against public reporting) — GPT returned signal/74%, Grok returned noise/0% with real grounded reasoning, Claude initially failed (empty response due to too-small max_tokens, now fixed). Mock example trades have been removed from the UI; the Trade Log now shows only real trades from `/api/trades`.
- [x] **Real trade seeding** — `server/testAnalysis.js` seeds the verified META trade into the store on startup, idempotently (skips if already present, so restarts don't duplicate or re-spend API credits). This is a stopgap until real persistent storage exists — see limitation below.
- [x] **Interactive candlestick chart** — real OHLC candlesticks (not a line), 15-minute intraday bars by default (Databento has no native 15-min schema; we fetch 1-min bars and aggregate ourselves), a real crosshair + hover tooltip (date/OHLC/volume), and an "Expand" view (70% chart / 30% commentary, full screen). Claude's tab overlays the EMA10/EMA20 it actually reasons about; GPT's tab emphasizes the volume subplot. Grok's tab does NOT fake a relative-strength overlay — flagged honestly since we don't have a real benchmark (QQQ) series fetched yet.
- [ ] **Grok relative-strength benchmark overlay** — needs a real QQQ (or sector ETF) intraday series fetched alongside the trade's own data, so Grok's tab can show an actual RS comparison line instead of nothing.
- [ ] **Thesis document schema** — persisted, evolving per-model thesis documents (Setup Conditions, Confidence, Counter-Examples) that accumulate across trades. Current analysis treats every trade independently with no memory of prior trades — this is the next real gap.
- [ ] **Near-miss vs low-info distinction for losses** — requires the thesis document above to compare a loss against; not implemented in v1 of analysis.js.
- [ ] **Individual knowledge base storage** — one growing document/record per AI
- [ ] **Merge/synthesis process** — job that compares the 3 theses and produces a shared version
- [ ] **Real per-trade chat** — replace the mock keyword-matched responder with a live scoped API call per model
- [ ] **Persistent trade storage** — current storage is a JSON file on Railway's ephemeral filesystem; trades do NOT survive a redeploy yet. Needs a real database (or a Railway volume) before relying on this for real trade logging.

## 5. Future Phase 3 — Live Daily Screening (Not Yet Started, Depends on Mature Thesis)

Once the shared thesis is mature, the same Setup Conditions can be applied to scan today's live market instead of one past trade at a time: streaming data ingestion, a screening step across the live universe, and a ranked top 3-5 candidates for the day. Should not start until the thesis has real Counter-Examples and a reasonable sample size.

## 6. Reference Material

- Oliver Kell, *Victory in Stock Trading* — optional shared price-action vocabulary for the AI analysts. Not a mandatory framework.

## 7. Known Limitations (Accepted, Not Blockers)

- Survivorship bias from human-selected winning trades — mitigated via mandatory loss logging + AI-judged near-miss check, not fully eliminated.
