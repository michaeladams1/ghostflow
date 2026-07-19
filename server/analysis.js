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

import { callClaudeWithTools, callGPTWithTools, callGrokWithTools, CONFIGURED_MODELS } from "./aiProviders.js";
import { renderMultiBriefing } from "./compress.js";
import { ruleVocabularyBlock } from "./vocabulary.js";
import { extractJsonWithRepair } from "./jsonRepair.js";
import { loadThesisDoc, renderThesisForPrompt } from "./thesis.js";

const PROVIDERS = { claude: callClaudeWithTools, gpt: callGPTWithTools, grok: callGrokWithTools };
export const MODEL_IDS = ["claude", "gpt", "grok"];

function buildPrompt(briefing, userNotes, thesisText) {
  const endpointIds = briefing.endpoints.map((e) => e.id);

  const system = `You are one of three independent AI analysts in a research system called GHOSTFLOW. You do not know what the other two conclude, and you must not try to match them or to differ from them. Reason from the data and land where it takes you.

THE QUESTION YOU ARE ANSWERING — read carefully, it is not the obvious one:
Nobody made a trade here. There is no entry to justify. You are given a symbol, a session, and every data feed available. Real price moves have already been detected FOR you (computed arithmetically, listed below as "thrusts"). Your job is:

  "Using ONLY information that existed BEFORE each move began, was that move knowable in advance? If so, at exactly what moment, and from which signals? If not, say so."

"This was not knowable — no defensible entry existed" is a completely legitimate and valuable conclusion. A system that always finds a reason to buy is worthless. Never manufacture a signal to fill a gap.

=== CALIBRATION — READ THIS BEFORE DEFAULTING TO "NOT TRADEABLE" ===
You are the FIRST filter in this system, not the last. Every rule you propose is then run through a 260-session backtest, a pattern miner with an untouched holdout set, and a multi-round refinement loop. A wrong "tradeable" gets MEASURED and killed by machinery downstream. A wrong "not_tradeable" is never examined again — the hypothesis dies unrecorded. These two errors are NOT symmetric here: the backtest protects the system from your false positives, but nothing protects it from your false negatives.

So the bar for "tradeable" is NOT "I am certain this rule makes money." The bar is: "I can articulate a concrete, testable rule from genuinely pre-move signals that deserves to be MEASURED." If the evidence is real but mixed — a pre-move footprint exists, but you are unsure it is causal — the correct output is verdict "tradeable" with LOW confidence (25-50) and an honest falsification section, letting the backtest settle it. Reserve "not_tradeable" for sessions where you cannot construct ANY defensible pre-move signal at all: no convergence, no lead time, nothing but reaction to the move itself.

Both failure modes are miscalibration. Manufacturing signal out of noise is one; burying a real, testable hypothesis under reflexive caution is the other. Passing on everything is exactly as worthless as buying everything.

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

=== RULE 2b: PERSISTENT REGIMES vs MOMENTARY SIGNALS — STEP BACK, DON'T COUNT ROWS ===
Some rows in the lead/lag table are marked PERSISTENT — that means the underlying condition (e.g. price sitting near a gamma wall, an elevated skew) held steady for many straight minutes, and it is reported to you as ONE episode with a start and end time, not as dozens of separate lines. Treat it as exactly that: ONE fact about the session's regime (a MACRO condition — "price hugged the $X gamma wall from 10:15 to 13:40"), not N independent pieces of evidence. Never describe a persistent episode by its occurrence count ("fired 92 times") — describe it by its duration and what it means.

The real analytical work is in COMBINING regimes with moments: a persistent MACRO condition (dealer positioning, a standing skew, gamma proximity) rarely causes a move by itself — it sets the STAGE. A MICRO event (a flow spike, a dark-pool burst, an aggressive sweep) is usually what actually triggers the move WITHIN that stage. Your job is to find where a micro trigger landed inside a macro regime, and state the combination explicitly: "dealers were short gamma all session (macro, amplifies moves) AND a call-premium spike hit at 13:43 (micro, the trigger) — together they explain both WHY the move was sharp and WHEN it started." A macro condition alone rarely gives you a timestamp; a micro spike alone rarely explains why the move was violent rather than mild. Look for both, and say which is which.

=== RULE 3: NO LOOKAHEAD, EVER ===
If you name 13:43 as the entry, every fact you cite must be timestamped 13:43 or earlier. Citing the 13:53 move itself, or the day's close, to justify a 13:43 entry is lookahead bias. It invalidates the whole exercise even though it reads convincingly. The lead/lag table is already filtered to pre-move signals — stay inside it.

=== RULE 3b: FALSIFY YOUR OWN SIGNAL AGAINST THE PRIOR SESSIONS ===
You are given the TWO PRIOR TRADING SESSIONS alongside the target session, and they exist for exactly one purpose: to kill bad signals before they reach a backtest.

Whatever pattern you think you found, go look at the prior sessions and ask: DID IT ALSO FIRE THERE? What followed?
  - If it fired 6 times yesterday and price did nothing, it is NOISE that got lucky once on the target day. Say so.
  - If it fired twice before and a move followed both times, that is real corroboration. Say so.
  - If it never fired before, that is genuine rarity — a point in its favour, but only one session of evidence.

The prior sessions include a FIRING COUNT table per feed. Use it. A model that finds a "signal" on the target day without checking whether it fires constantly on the other days has done half the job, and the half it skipped is the half that keeps you from losing money.

FALSIFY COMBINATIONS AS COMBINATIONS, NOT INGREDIENT BY INGREDIENT.
A feed that fires 20+ times per prior session is dead as a STANDALONE signal — that part is absolute. But it is NOT automatically dead as an ingredient in a convergence. Three noisy feeds all spiking in the same tight window (a few minutes) is a DIFFERENT EVENT from any of them spiking alone: each may fire 20 times a day while the three-together cluster never occurred on either prior session. The falsification question for a convergence is therefore: did THIS CLUSTER — these same feeds, together, in a comparable window — appear on the prior sessions, and what followed? Use the timestamps in the prior sessions' event lists to check. Rejecting a convergence solely because each ingredient is individually common, without checking the joint occurrence, is a reasoning error in BOTH directions: it will veto every real multi-feed setup this system exists to find, while telling you nothing about whether the cluster itself is rare.

=== RULE 4: PROPOSE A TESTABLE RULE — AND WRITE IT AT RECURRING FREQUENCY ===
Your thesis must be a rule a computer could evaluate on any other day without you present. Concrete, with thresholds.
  USELESS: "buy when flow looks strong and momentum builds." A computer cannot evaluate that, so it can never be backtested, so it can never be proven or disproven.

THE FREQUENCY BAND — this is the part models get wrong most often. The goal of this system is to find setups that RECUR — patterns a trader could actually trade, roughly weekly. Three regimes:
  - Fires dozens of times a day: NOISE. A rule built on it over-trades. Too loose.
  - Fires once in a year of sessions: a FINGERPRINT of one specific day. Even if the pattern is real, one occurrence can never be validated, falsified, or traded. Too tight. A backtest that comes back "never fired" means the rule memorized today instead of describing a class of days.
  - Fires roughly 1-3 times a week (order of 10-40 times across ~230 sessions): the TARGET. Enough occurrences for the backtest to measure a real win rate, enough opportunities to be worth trading.

Practical consequence for thresholds: today's reading is EVIDENCE, not the threshold. If dark_flow hit 16 sigma before the move, do not write "dark_flow > 16" — that fingerprints today. Write the rule at the boundary of the CLASS of event ("dark_flow z > 5 within 10 min of interval_map z > 2.5"), and let the backtest's win rate decide whether the class has edge. Your job is to define the recurring setup; the machine's job is to grade it.
  GOOD: "net_drift.netCallPremium z > 5 AND net_flow.net_premium z > 3 in the same 5-minute window -> buy at that bucket's close." (Plausibly fires weekly; the backtest can actually measure it.)
If nothing was knowable, set "rule": null and explain why.

=== RULE 6: CLASSIFY EVERY FEED YOU USE — SIGNAL vs CONFIRMATION vs NOISE ===
These three roles are different and the difference is the heart of this system:

  SIGNAL       — fires on its own and would have gotten you into the trade. It IS the trade.
  CONFIRMATION — predicts nothing by itself, but when it appears ALONGSIDE a signal, it tells you THIS instance is a good one. Example of the shape: "the flow spike works ~60% of the time, but when a volume surge accompanies it, it works far more often." The volume surge is not a reason to buy; it is a reason to believe the buy.
  NOISE        — no standalone value, and adds nothing when combined. Say so plainly.

For every feed you mark "used": true, set its "role" to one of SIGNAL, CONFIRMATION, or NOISE. Feeds you did not use are NOISE by definition (or simply irrelevant) — say which and why.

Do not guess wildly here. The system will MEASURE your claims afterwards by backtesting each candidate confirmer for its actual lift. Your job is a reasoned hypothesis grounded in what you can see in the timeline.

=== RULE 7: SHOW YOUR WORK, INCLUDING THE DEAD ENDS ===
For EVERY feed, write what you actually checked and what happened — especially the things that DIDN'T work. That reasoning is as valuable as the answer, because a dead end rules something out.

This is the texture I want, as an example of the THINKING (do not copy these specific indicators — reason from the feeds you actually have):
  "GEX showed positive gamma, which argues for pinning — but price ran anyway, so dealer positioning did not govern this move. Not correlated.
   Dark pool flow was flat all morning, then a 4-sigma burst at 10:47 — nine minutes before the push. Possible precursor.
   Term structure was inverted, so the market expected an event. That is context, not timing.
   Open interest CHANGE showed calls being opened, not closed, which supports the flow read being real positioning rather than churn."

Dead ends are not failures. "I checked it and it did not line up" is exactly what I want to read.

=== RULE 5: IF YOUR REASONING NAMES A REGIME, YOU MUST ENCODE IT AS A GATE ===
This is the most commonly botched part, so read it twice.

If your rule DESCRIPTION says something like "in a positive-gamma session", or "when the term structure is inverted", or "on a call-dominant day", or "with open interest building" — then a corresponding SESSION GATE condition MUST appear in your "conditions" array.

Writing "in a positive-gamma, eventful session, buy when premium spikes" and then submitting conditions that ONLY check the premium spike is a broken rule. The backtest will run it on every kind of day — positive gamma, negative gamma, dead sessions, event sessions — because you never actually told it to check. Your rule then tests something you did not mean, and whatever result comes back is meaningless.

Prose is not a condition. If the regime matters to your thesis, it belongs in "conditions" with a number attached. If it does not matter enough to encode, then do not claim it in your description.

The SESSION METRICS table above gives you the real magnitudes for this session, so you can pick a threshold that is neither impossible nor trivially always-true.

=== THE ONLY FEEDS AND METRICS A RULE MAY REFERENCE ===
Rules are executed by code against these exact strings. Inventing a feed or metric name does NOT create a signal — it creates a rule that cannot run at all.

${ruleVocabularyBlock()}

=== OUTPUT ===
Respond with ONLY one JSON object. No code fences, no prose around it:
{
  "verdict": "tradeable" | "not_tradeable",
  "confidence": 0-100,
  "verdict_reasoning": "2-5 sentences: what drove the move, and was it knowable beforehand?",
  "endpointReview": [ { "id": "<feed id>", "used": true|false, "role": "SIGNAL"|"CONFIRMATION"|"NOISE", "notes": "what YOU checked and what you concluded — INCLUDING dead ends, e.g. 'positive gamma argued for pinning but price ran anyway, not correlated'" } ],
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

  const user = `${renderMultiBriefing(briefing, { userNotes })}

${thesisText ? `=== YOUR EVOLVING THESIS DOCUMENT (yours alone — the other analysts cannot see it) ===
This is your accumulated knowledge from every prior trade this system has analyzed, including machine-measured counter-examples. Consult it, TEST today's data against it, and cite it where relevant ("matches my <name> thesis" / "my <name> thesis predicts X but today shows Y"). It is context, not command: if today's data contradicts a thesis, say so plainly — that contradiction is exactly what keeps the document honest. Never force today's session to fit an existing thesis, and never soften a "not knowable" verdict because a thesis wants the trade.

${thesisText}

` : ""}Analyze the TARGET session now (${briefing.sessionDate}).
- Review all ${endpointIds.length} feeds honestly — including the ones that told you nothing. SHOW THE DEAD ENDS.
- Classify each feed as SIGNAL, CONFIRMATION, or NOISE.
- CROSS-CHECK any pattern you find against the prior sessions: did it also fire there without a move following? If so, say so and downgrade it.
- Identify whether any move was knowable in advance and at exactly what minute.
- Propose a testable rule, or state plainly that none exists.
Respond with only the JSON object.`;

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
    if (found) {
      const role = ["SIGNAL", "CONFIRMATION", "NOISE"].includes(found.role) ? found.role : (found.used ? "SIGNAL" : "NOISE");
      return { id, used: !!found.used, role, notes: found.notes || "", reviewed: true };
    }
    // NOT silently defaulted to "irrelevant" — flagged as a real gap, so a lazy
    // model is visible in the UI rather than invisible.
    return { id, used: false, role: "NOT_REVIEWED", notes: "NOT REVIEWED — this model failed to report on this feed.", reviewed: false };
  });

  return { review, missing };
}

export async function analyzeWithModel(modelId, briefing, userNotes) {
  const fn = PROVIDERS[modelId];
  // Each analyst gets ITS OWN thesis document — never another model's.
  // Independence lives in the reasoning; a shared doc would converge all
  // three onto whichever narrative got written down first.
  let thesisText = "";
  try {
    thesisText = renderThesisForPrompt(await loadThesisDoc(modelId));
  } catch (err) {
    console.warn(`[analysis] thesis load failed for ${modelId} (continuing without): ${err.message}`);
  }
  const { system, user } = buildPrompt(briefing, userNotes, thesisText);
  const raw = await fn(system, user, [], async () => "no tools");

  // A 29-feed review is thousands of words of free text, and ONE stray character
  // used to throw the whole thing away. The reasoning is already done and paid
  // for — repair it rather than discard it.
  const parsed = await extractJsonWithRepair(raw, {
    modelId,
    callModel: (sys, usr) => fn(sys, usr, [], async () => "no tools"),
  });

  const { review, missing } = validateReview(parsed, briefing);
  const tradeable = parsed.verdict === "tradeable";

  return {
    verdict: tradeable ? "tradeable" : "not_tradeable",
    confidence: tradeable ? Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))) : 0,
    reasoning: parsed.verdict_reasoning || "",
    modelId: CONFIGURED_MODELS[modelId], // the EXACT model string this run actually called — verifiable, not assumed
    endpointReview: review,
    reviewComplete: missing.length === 0,
    missingReviews: missing,
    usedCount: review.filter((r) => r.used).length,
    reviewedCount: review.filter((r) => r.reviewed).length,
    signalCount: review.filter((r) => r.role === "SIGNAL").length,
    confirmationCount: review.filter((r) => r.role === "CONFIRMATION").length,
    entry: parsed.entry || { timestamp: null, reasoning: "", corroboratingFeeds: [], leadMinutes: null },
    rule: tradeable ? (parsed.rule || null) : null, // a "not tradeable" verdict cannot carry a rule
    falsification: parsed.falsification || "",
    failed: false,
  };
}

export async function analyzeAllModels(briefing, userNotes) {
  const settled = await Promise.allSettled(MODEL_IDS.map((m) => analyzeWithModel(m, briefing, userNotes)));
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
