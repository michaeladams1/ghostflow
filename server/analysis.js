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

import { callClaude, callGPT, callGrok } from "./aiProviders.js";

const PROVIDERS = { claude: callClaude, gpt: callGPT, grok: callGrok };
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

  const system = `You are one of three independent AI analysts in a research system called GHOSTFLOW. The system studies real trades to build an evolving thesis about what market conditions tend to precede strong outcomes. You do not know, and should not guess at, what the other two analysts conclude.

Your task: given the real historical price/volume data and options flow data below for one specific trade, determine whether the data shows a genuine, recognizable setup that plausibly explains the trade's outcome. You are reverse-engineering causes, not grading the outcome.

HARD RULES:
1. Every "flag" you report must cite a real numeric value and baseline that are literally present in the data provided below. If you cannot point to a specific number in the provided data, do not include that flag. Do not invent percentages, dates, or comparisons.
2. You may use standard price-action vocabulary (e.g. Base n' Break, Wedge Pop, EMA reclaim, Exhaustion Extension) if it genuinely fits, but grounding in the actual numbers matters more than naming a pattern.
3. Respond with ONLY a single valid JSON object — no markdown code fences, no commentary before or after it — matching exactly this shape:
{
  "verdict": "signal" or "noise",
  "confidence": integer 0-100 (0 if verdict is "noise"),
  "text": "2-4 sentence justification in your own words",
  "flags": [
    { "type": "volume" | "iv" | "flow" | "gex" | "darkpool" | "rs", "label": "short label", "value": "specific number/fact from the data", "baseline": "comparison point from the data", "source": "which data field this came from, e.g. Databento OHLCV close/volume on <date>, or Quant Data net-drift at <timestamp>" }
  ]
}
Use "signal" only if the data shows real supporting evidence. Use "noise" if the data is ambiguous, thin, or doesn't clearly explain the move.`;

  const user = `TRADE: ${trade.symbol} ${trade.direction}. Entry: ${trade.entryDate}. Exit: ${trade.exitDate || "still open"}.

DAILY PRICE/VOLUME BARS (chronological, date / close / volume):
${barsTable || "No price bars available."}

OPTIONS FLOW DATA (Quant Data net-drift, keyed by session timestamp):
${flowJson}

Analyze this trade now and respond with only the JSON object described in your instructions.`;

  return { system, user };
}

export async function analyzeTradeWithModel(modelId, trade, dataset) {
  const fn = PROVIDERS[modelId];
  const { system, user } = buildPrompt(modelId, trade, dataset);
  const raw = await fn(user, { system });
  const parsed = extractJson(raw);
  const verdict = parsed.verdict === "signal" ? "signal" : "noise";
  return {
    verdict,
    confidence: verdict === "signal" ? Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))) : 0,
    text: parsed.text || "",
    entryIdx: dataset.entryIdx,
    exitIdx: dataset.exitIdx,
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

  return {
    verdict, confidence, text,
    flags: Array.from(flagMap.values()),
    entryIdx: dataset.entryIdx, exitIdx: dataset.exitIdx,
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
          text: `Analysis failed: ${r.reason?.message || "unknown error"}`,
          failed: true,
        };
  });
  results.combined = computeCombinedAnalysis(results, dataset);
  return results;
}
