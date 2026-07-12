// The actual thesis-generation logic: given a trade + its real pulled data
// (price/volume history from Databento, options flow from Quant Data), ask
// each AI model independently whether the data shows a genuine setup, then
// combine the three views without blending away disagreement.
//
// SCOPE NOTE: this first version treats every trade the same way (does the
// data show real supporting evidence, yes/no). The near-miss-vs-low-info
// distinction for losing trades, and comparison against each model's
// accumulated thesis document, require a real persisted thesis store that
// doesn't exist yet — that's a follow-up, not done here.

import { callClaudeWithTools, callGPTWithTools, callGrokWithTools } from "./aiProviders.js";
import { FETCH_TOOL, executeFetchTool } from "./tools.js";
import { closestIndex } from "./tradeData.js";

const PROVIDERS = { claude: callClaudeWithTools, gpt: callGPTWithTools, grok: callGrokWithTools };
const MODEL_IDS = ["claude", "gpt", "grok"];

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response: " + text.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

function buildPrompt(modelId, trade, dataset) {
  const bars = dataset.bars || [];
  const barsTable = bars.map((b) => `${b.date}\tclose=${b.close}\tvolume=${b.volume}`).join("\n");
  const flowJson = dataset.rawFlow ? JSON.stringify(dataset.rawFlow).slice(0, 6000) : "No flow data available for this trade.";
  const hasIntraday = !!(dataset.intradayBars && dataset.intradayBars.length);

  const system = `You are one of three independent AI analysts in a research system called GHOSTFLOW. The system studies real trades to build an evolving thesis about what market conditions tend to precede strong outcomes. You do not know, and should not guess at, what the other two analysts conclude \u2014 do not shape your answer around them in any way, whether that means trying to match them or trying to differ from them. Reason from the data in front of you and land wherever that honestly takes you.

Michael already made this trade and it worked out. His actual entry/exit dates are given below as CONTEXT ONLY. Do not treat his entry date as correct and write a justification for it — that is explicitly not the task, and is a bias this system is designed to avoid.

Your task has TWO SEPARATE PARTS. Do not blend them together.

PART 1 — Explain the move (hindsight allowed).
Using the full window of data (before, during, and after Michael's trade), explain what factors plausibly explain why ${trade.symbol} moved the way it did. Here you may use everything you know, including bars/flow that came later in the window — you are explaining a move that already happened, not simulating a decision in real time. This becomes your "flags" and "text" below.

PART 2 — Your own defensible entry point (NO HINDSIGHT ALLOWED).
Separately, pick the specific date (and time of day, if you use intraday data) that YOU would consider a genuinely defensible entry — a point where the evidence available AT THAT MOMENT, and only up to that moment, already looked like a real setup. This is the hard part and the one most likely to be done wrong, so read this rule carefully:

LOOKAHEAD RULE (do not violate this): if you choose an entry time of, say, 11:00am on a given day, you may ONLY cite bars, flow readings, or other facts timestamped at or before 11:00am that day. You may NOT cite an 11:30am bar, a same-day closing price, or next-day data to justify an 11:00am entry — that is lookahead bias and it silently invalidates the whole exercise even though it "reads" fine. If the best evidence for your chosen moment only exists after that moment, either move your chosen entry later to a point the evidence actually supports, or say plainly that the earliest genuinely-supported entry was later than Michael's actual entry.
Your suggested entry does not need to match Michael's actual entry date. A later, more conservative entry that gave up some of the move but had real confirmation is a perfectly good answer.

HARD RULES:
1. Every "flag" you report (Part 1) must cite a real numeric value and baseline that are literally present in data you were given or that you fetched yourself with the fetch_market_data tool. If you cannot point to a specific number in real data, do not include that flag. Do not invent percentages, dates, or comparisons.
2. You may use standard price-action vocabulary (e.g. Base n' Break, Wedge Pop, EMA reclaim, Exhaustion Extension) if it genuinely fits, but grounding in the actual numbers matters more than naming a pattern.
3. You have a fetch_market_data tool available, including an intraday_15min_ohlcv option. Use it whenever you want more granularity than the daily bars below give you — this matters most for Part 2, since you can't reason about "11am vs 11:30am" from daily bars alone. Also use it for a benchmark index (QQQ, SPY), a sector peer, or additional date range. There is no limit on how many times you can call it. Only fall back to "no data" if a fetch genuinely fails.
4. Respond with ONLY a single valid JSON object as your FINAL message (after any tool calls you make) — no markdown code fences, no commentary before or after it — matching exactly this shape:
{
  "verdict": "signal" or "noise",
  "confidence": integer 0-100 (0 if verdict is "noise"),
  "text": "2-4 sentence explanation of what drove the move (Part 1), in your own words",
  "flags": [
    { "type": "volume" | "iv" | "flow" | "gex" | "darkpool" | "rs", "label": "short label", "value": "specific number/fact from the data", "baseline": "comparison point from the data", "source": "which data field this came from, e.g. Databento OHLCV close/volume on <date>, Quant Data net-drift at <timestamp>, or a value you fetched yourself for <symbol>" }
  ],
  "suggestedEntry": {
    "date": "YYYY-MM-DD, or a full timestamp like YYYY-MM-DDTHH:MM if you're using intraday data",
    "reasoning": "2-3 sentences citing ONLY data timestamped at or before this exact moment \u2014 no lookahead"
  }
}
Use "signal" only if Part 1's data shows real supporting evidence. Use "noise" if the data is ambiguous, thin, or doesn't clearly explain the move (still fill in "suggestedEntry" with your best honest read, or explain in its reasoning why no defensible entry existed).${hasIntraday ? "" : "\nNo intraday bars were pre-loaded for this trade \u2014 call fetch_market_data with intraday_15min_ohlcv yourself if you want time-of-day granularity for Part 2, otherwise a date-level answer is fine."}`;

  const user = `TRADE: ${trade.symbol} ${trade.direction}. Michael's actual entry (context only, not to be justified): ${trade.entryDate}. Actual exit: ${trade.exitDate || "still open"}.

DAILY PRICE/VOLUME BARS (chronological, date / close / volume):
${barsTable || "No price bars available."}

OPTIONS FLOW DATA (Quant Data net-drift, keyed by session timestamp):
${flowJson}

Analyze this trade now: Part 1 (what explains the move) and Part 2 (your own lookahead-free entry point). Respond with only the JSON object described in your instructions.`;

  return { system, user };
}

// Maps a model's own freely-chosen suggestedEntry.date onto real bar
// indices, the same way the human-logged entry gets mapped in tradeData.js.
// Tries intraday bars first (so a time-of-day answer like "11:00am" actually
// lands on the right 15-min bar), falls back to daily bars, and returns nulls
// if the model didn't give a usable date or no bars exist to index into.
function indexSuggestedEntry(dateStr, dataset) {
  if (!dateStr) return { idx: null, intradayIdx: null };
  const parsedDate = new Date(dateStr);
  if (Number.isNaN(parsedDate.getTime())) return { idx: null, intradayIdx: null };
  const idx = dataset.bars && dataset.bars.length ? closestIndex(dataset.bars, dateStr) : null;
  const intradayIdx = dataset.intradayBars && dataset.intradayBars.length ? closestIndex(dataset.intradayBars, dateStr) : null;
  return { idx, intradayIdx };
}

export async function analyzeTradeWithModel(modelId, trade, dataset) {
  const fn = PROVIDERS[modelId];
  const { system, user } = buildPrompt(modelId, trade, dataset);
  const raw = await fn(system, user, [FETCH_TOOL], executeFetchTool);
  const parsed = extractJson(raw);
  const verdict = parsed.verdict === "signal" ? "signal" : "noise";
  const suggestedEntry = parsed.suggestedEntry && typeof parsed.suggestedEntry === "object"
    ? { date: parsed.suggestedEntry.date || null, reasoning: parsed.suggestedEntry.reasoning || "" }
    : { date: null, reasoning: "" };
  const { idx: suggestedEntryIdx, intradayIdx: suggestedEntryIntradayIdx } = indexSuggestedEntry(suggestedEntry.date, dataset);
  return {
    verdict,
    confidence: verdict === "signal" ? Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))) : 0,
    text: parsed.text || "",
    // The human-logged entry/exit \u2014 shown on every model's chart only as
    // reference context, never as "this model says this was the right call".
    entryIdx: dataset.entryIdx,
    exitIdx: dataset.exitIdx,
    // This model's OWN, independently-chosen, lookahead-free entry pick \u2014
    // arrived at with zero visibility into what the other two models picked.
    suggestedEntry,
    suggestedEntryIdx,
    suggestedEntryIntradayIdx,
    flags: Array.isArray(parsed.flags) ? parsed.flags.map((f) => ({
      type: f.type || "flow",
      label: f.label || "",
      value: f.value || "",
      baseline: f.baseline || "",
      source: f.source || "",
    })) : [],
  };
}

// Combines the 3 individual views WITHOUT blending away disagreement, and
// WITHOUT treating a failed/crashed analyst as if it had cast a real "noise"
// vote — a model that errored out has no opinion at all, and must be
// excluded from the agreement count rather than silently counted as dissent.
function computeCombinedAnalysis(results, dataset) {
  const respondingModels = MODEL_IDS.filter((m) => !results[m].failed);
  const failedModels = MODEL_IDS.filter((m) => results[m].failed);

  const signalModels = respondingModels.filter((m) => results[m].verdict === "signal");
  const verdict = signalModels.length * 2 >= respondingModels.length && signalModels.length > 0 ? "signal" : "noise";
  const agreeingModels = respondingModels.filter((m) => results[m].verdict === verdict);
  const disagreeingModels = respondingModels.filter((m) => results[m].verdict !== verdict);

  const confidence = agreeingModels.length
    ? Math.round(agreeingModels.reduce((sum, m) => sum + results[m].confidence, 0) / agreeingModels.length)
    : 0;

  const flagMap = new Map();
  agreeingModels.forEach((m) => {
    (results[m].flags || []).forEach((f) => {
      const key = `${f.type}:${f.label}`;
      if (!flagMap.has(key)) flagMap.set(key, f);
    });
  });

  let text = respondingModels.length === 0
    ? "All 3 analysts failed to return an analysis \u2014 no verdict can be formed."
    : `${agreeingModels.length} of ${respondingModels.length} responding analysts (${agreeingModels.join(", ") || "none"}) agree this trade shows ${verdict === "signal" ? "genuine supporting evidence" : "insufficient evidence to call it a real setup"}.`
      + (disagreeingModels.length ? ` Disagreement preserved, not blended away: ${disagreeingModels.join(", ")} did not concur.` : " No disagreement among responding analysts.");
  if (failedModels.length) {
    text += ` Note: ${failedModels.join(", ")} failed to return an analysis and ${failedModels.length > 1 ? "are" : "is"} excluded from this count, not counted as dissent.`;
  }

  // Deliberately NOT merged into one "combined entry" \u2014 each analyst's
  // entry pick is its own independent judgment call, not a fact that can be
  // averaged. The combined view lists all responding models' picks side by
  // side so you can see where they agree or diverge on timing.
  const suggestedEntries = {};
  respondingModels.forEach((m) => {
    suggestedEntries[m] = results[m].suggestedEntry || { date: null, reasoning: "" };
  });

  return {
    verdict, confidence, text,
    flags: Array.from(flagMap.values()),
    entryIdx: dataset.entryIdx, exitIdx: dataset.exitIdx,
    suggestedEntries,
    agreement: `${agreeingModels.length}/${respondingModels.length}`,
  };
}

export async function analyzeTradeAllModels(trade, dataset) {
  const settled = await Promise.allSettled(MODEL_IDS.map((m) => analyzeTradeWithModel(m, trade, dataset)));
  const results = {};
  settled.forEach((r, i) => {
    const m = MODEL_IDS[i];
    results[m] = r.status === "fulfilled"
      ? { ...r.value, failed: false }
      : {
          verdict: "noise", confidence: 0, entryIdx: dataset.entryIdx, exitIdx: dataset.exitIdx, flags: [],
          suggestedEntry: { date: null, reasoning: "" }, suggestedEntryIdx: null, suggestedEntryIntradayIdx: null,
          text: `Analysis failed: ${r.reason?.message || "unknown error"}`,
          failed: true,
        };
  });
  results.combined = computeCombinedAnalysis(results, dataset);
  return results;
}
