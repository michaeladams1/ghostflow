# GHOSTFLOW

AI-assisted options trading research system — three independent AI analysts (Claude, GPT, Grok) build and refine evolving theses from logged trades, with a combined view synthesizing all three.

## Status

Prototype UI only, mock data. No live data vendor or AI orchestration wired up yet. See `docs/architecture.md` for the full design doc.

## Run locally

```
npm install
npm run dev
```

## What's in the prototype

- **Trade Log** — filterable by win / near-miss loss / low-info loss, with a form to log new trades
- **Trade Detail** — 4 fully independent tabs (Claude / GPT / Grok / Combined), each with its own price chart, indicator overlay (volume / GEX / dark pool / flow), verdict, and a scoped chat where you can ask that model questions about that trade only
- **Performance** — win rate, model agreement rate, thesis confidence by model
- **Theses** — all 4 thesis documents (Setup Conditions, Confidence, evidence counts)

## Not yet built

- Real data vendor integration (Quant Data, Databento)
- Real AI orchestration (Claude/GPT/Grok API calls)
- Persistent storage (currently everything resets on refresh)
- Live per-trade chat (currently a keyword-matched mock responder)
