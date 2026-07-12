// THE ANALYSIS LAYER (v2 — signal discovery, not trade justification).
//
// WHAT CHANGED AND WHY:
// The old version took a completed trade (entry, exit, win/loss) and asked the
// models to explain it. That was wrong. Michael never enters a trade — he
// enters a SYMBOL and a TIMEFRAME. The system's job is to find the move itself,
// then ask whether it was knowable in advance, and at what exact moment.
//
// THREE GUARANTEES ENFORCED HERE:
//
// 1. ALL FEEDS REVIEWED. Every model must return one `endpointReview` entry per
//    feed. validateReview() below flags any omission explicitly. A model cannot
//    quietly ignore GEX and have nobody notice.
//
// 2. "NOT CORRELATED" IS A FIRST-CLASS ANSWER. Reviewing a feed does not mean
//    using it. A model that says "I pulled GEX, it showed nothing relevant, I'm
//    not using it" has done its job perfectly. Forcing every feed into the
//    thesis would manufacture false signal — the opposite of what this is for.
//
// 3. NO LOOKAHEAD. The lead/lag table handed to the models contains only
//    signals timestamped strictly BEFORE each move. An entry cannot be
//    justified by data that didn't exist yet — enforced by arithmetic in
//    compress.js, not by asking a model to be careful.

import { callClaudeWithTools, callGPTWithTools, callGrokWithTools } from "./aiProviders.js";
import { renderBriefing } from "./compress.js";
import { ruleVocabularyBlock } from "./vocabulary.js";

const PROVIDERS = { claude: callClaudeWithTools, gpt: callGPTWithTools, grok: callGrokWithTools };
export const MODEL_IDS = ["claude", "gpt", "grok"];

function extractJson(text) {
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model response: " + cleaned.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

function buildPrompt(briefing) {
  const endpointIds = briefing.endpoints.map((e) => e.id);

  const system = `You are one of three independent AI analysts in a research system called GHOSTFLOW. You do not know what the other two conclude, and you must not try to match them or to differ from them. Reason from the data and land where it takes you.

THE QUESTION YOU ARE ANSWERING — read carefully, it is not the obvious one:
Nobody made a trade here. There is no entry to justify. You are given a symbol, a session, and every data feed available. Real price moves have already been detected FOR you (computed arithmetically, listed below as "thrusts"). Your job is:

  "Using ONLY information that existed BEFORE each move began, was that move knowable in advance? If so, at exactly what moment, and from which signals? If not, say so."

"This was not knowable — no defensible entry existed" is a completely legitimate and valuable conclusion. A system that always finds a reason to buy is worthless. Never manufacture a signal to fill a gap.

=== RULE 1: REVIEW ALL ${endpointIds.length} FEEDS ===
Return exactly one entry in "endpointReview" for EVERY one of these ids, none omitted, none invented:
${endpointIds.join(", ")}

For each, say whether you actually USED it and what you concluded.
CRITICAL: "used": false is a GOOD answer when a feed was genuinely irrelevant. An excellent review looks like:
  {"id":"exposure_by_strike_gamma","used":false,"notes":"Net gamma was positive, which argues for dealers pinning price — yet the move happened anyway, and no gamma wall lines up with the 13:53 breakout. I see no causal link, so I am not using GEX in this thesis."}
That model did its job. Do NOT force a feed into your thesis just because you were shown it. Do NOT parrot the "reading" line back at me — tell me what YOU make of it.

=== RULE 2: BE SPECIFIC ABOUT TIME AND CORROBORATION ===
Do not glaze over the data with generalities. The lead/lag table gives exact timestamps. Reason like this:
  "net_drift.netCallPremium fired at 13:43 at 54 sigma. Price didn't move until 13:53 — a 10 minute lead. Was anything else firing near 13:43? Yes: net_flow spiked at 13:43 at 31 sigma, dark_flow at 13:45. Three independent feeds converging within two minutes, ten minutes ahead of a +0.95% move. THAT is the entry, and 13:43 is the timestamp."
Then challenge yourself: did those same signals fire at OTHER times without a move following? If a signal fires ten times a day and price only moves twice, it is not a signal — say so plainly.

=== RULE 3: NO LOOKAHEAD, EVER ===
If you name 13:43 as the entry, every fact you cite must be timestamped 13:43 or earlier. Citing the 13:53 move itself, or the day's close, to justify a 13:43 entry is lookahead bias. It invalidates the whole exercise even though it reads convincingly. The lead/lag table is already filtered to pre-move signals — stay inside it.

=== RULE 4: PROPOSE A TESTABLE RULE ===
Your thesis must be a rule a computer could evaluate on any other day without you present. Concrete, with thresholds.
  GOOD: "net_drift.netCallPremium z > 5 AND net_flow z > 3 within the same 2-minute window -> buy at that bucket's close."
  USELESS: "buy when flow looks strong and momentum builds." A computer cannot evaluate that, so it can never be backtested, so it can never be proven or disproven.
If nothing was knowable, set "rule": null and explain why.

=== THE ONLY FEEDS AND METRICS A RULE MAY REFERENCE ===
Rules are executed by code against these exact strings. Inventing a feed or metric name does NOT create a signal — it creates a rule that cannot run at all.

${ruleVocabularyBlock()}

=== OUTPUT ===
Respond with ONLY one JSON object. No code fences, no prose around it:
{
  "verdict": "tradeable" | "not_tradeable",
  "confidence": 0-100,
  "verdict_reasoning": "2-5 sentences: what drove the move, and was it knowable beforehand?",
  "endpointReview": [ { "id": "<feed id>", "used": true|false, "notes": "what YOU concluded, including 'nothing here' if that is the truth" } ],
  "entry": {
    "timestamp": "HH:MM NY time, or null if not tradeable",
    "reasoning": "cite ONLY signals at or before this timestamp",
    "corroboratingFeeds": ["feed ids that independently confirmed at that moment"],
    "leadMinutes": <minutes before the move this entry sits>
  },
  "rule": {
    "description": "plain-English rule",
    "conditions": [ { "feed": "<id>", "metric": "<metric>", "operator": ">", "threshold": <number>, "window": "<e.g. same 2-min bucket>" } ],
    "action": "BUY_UNDERLYING" | "BUY_CALL" | "BUY_PUT" | "PASS"
  },
  "falsification": "What would have to be true for this rule to be WRONG? What would kill it?"
}`;

  const user = `${renderBriefing(briefing)}

Analyze this session now. Review all ${endpointIds.length} feeds honestly — including the ones that told you nothing. Identify whether any move was knowable in advance and at exactly what minute. Propose a testable rule, or state plainly that none exists. Respond with only the JSON object.`;

  return { system, user };
}

// Enforces "all feeds reviewed" in CODE. A model that skips feeds has its
// omissions recorded explicitly rather than silently passing.
function validateReview(parsed, briefing) {
  const expected = briefing.endpoints.map((e) => e.id);
  const returned = new Map((parsed.endpointReview || []).map((r) => [r.id, r]));
  const missing = expected.filter((id) => !returned.has(id));

  const review = expected.map((id) => {
    const found = returned.get(id);
    if (found) return { id, used: !!found.used, notes: found.notes || "", reviewed: true };
    // NOT silently defaulted to "irrelevant" — flagged as a real gap, so a lazy
    // model is visible in the UI rather than invisible.
    return { id, used: false, notes: "NOT REVIEWED — this model failed to report on this feed.", reviewed: false };
  });

  return { review, missing };
}

export async function analyzeWithModel(modelId, briefing) {
  const fn = PROVIDERS[modelId];
  const { system, user } = buildPrompt(briefing);
  const raw = await fn(system, user, [], async () => "no tools");
  const parsed = extractJson(raw);

  const { review, missing } = validateReview(parsed, briefing);
  const tradeable = parsed.verdict === "tradeable";

  return {
    verdict: tradeable ? "tradeable" : "not_tradeable",
    confidence: tradeable ? Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))) : 0,
    reasoning: parsed.verdict_reasoning || "",
    endpointReview: review,
    reviewComplete: missing.length === 0,
    missingReviews: missing,
    usedCount: review.filter((r) => r.used).length,
    reviewedCount: review.filter((r) => r.reviewed).length,
    entry: parsed.entry || { timestamp: null, reasoning: "", corroboratingFeeds: [], leadMinutes: null },
    rule: parsed.rule || null,
    falsification: parsed.falsification || "",
    failed: false,
  };
}

export async function analyzeAllModels(briefing) {
  const settled = await Promise.allSettled(MODEL_IDS.map((m) => analyzeWithModel(m, briefing)));
  const results = {};

  settled.forEach((r, i) => {
    const m = MODEL_IDS[i];
    results[m] = r.status === "fulfilled" ? r.value : {
      verdict: "not_tradeable", confidence: 0, reasoning: `Analysis failed: ${r.reason?.message || "unknown"}`,
      endpointReview: [], reviewComplete: false, missingReviews: [], usedCount: 0, reviewedCount: 0,
      entry: { timestamp: null, reasoning: "", corroboratingFeeds: [], leadMinutes: null },
      rule: null, falsification: "", failed: true,
    };
  });

  // A failed model has NO opinion — excluded from the count entirely, never
  // counted as a silent "not tradeable" vote.
  const responding = MODEL_IDS.filter((m) => !results[m].failed);
  const tradeableModels = responding.filter((m) => results[m].verdict === "tradeable");

  results.combined = {
    agreement: `${tradeableModels.length}/${responding.length}`,
    respondingModels: responding,
    failedModels: MODEL_IDS.filter((m) => results[m].failed),
    verdict: tradeableModels.length * 2 >= responding.length && tradeableModels.length > 0 ? "tradeable" : "not_tradeable",
    // Entry timings listed side by side, NEVER averaged. Averaging two models'
    // entry times would produce a moment neither of them actually endorsed.
    entries: Object.fromEntries(responding.map((m) => [m, results[m].entry])),
    rules: Object.fromEntries(responding.map((m) => [m, results[m].rule])),
  };

  return results;
}
