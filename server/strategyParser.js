// STRATEGY PARSER — turns a plain-English (or pasted-paper) strategy
// description into a structured rule the deterministic backtest engine
// (server/priceBacktest.js) can actually execute.
//
// This is a TRANSLATION step, not a judgment step. Claude reads the
// description and maps it onto a fixed schema of primitives (indicators,
// entry conditions, exit/stop rules). It is NOT allowed to invent new
// primitives — if the description needs something the schema can't express,
// it must say so in `warnings` rather than silently approximating.
//
// The output is shown back to the user in plain English for confirmation
// BEFORE anything is backtested. This is the "say it back to me" step Michael
// asked for.

import { callClaude } from "./aiProviders.js";
import { extractJsonWithRepair } from "./jsonRepair.js";

const SCHEMA_DOC = `
You convert a trading strategy description into this EXACT JSON schema. Output ONLY the JSON object — no prose, no markdown fences.

{
  "name": string,                  // short name for the strategy
  "summary": string,                // 2-4 sentence plain-English restatement of EXACTLY what you understood. This is shown to the user to confirm before anything runs, so be precise and concrete (name the indicator, the entry trigger, the exit trigger, the stop, whether it holds overnight).
  "symbols": string[],              // ticker(s) to test, e.g. ["QQQ","TQQQ"]. If the description doesn't name one, use [] and add a warning.
  "session": "RTH",                 // always "RTH" for now (9:30am-4:00pm ET) — this engine does not yet support extended hours.
  "indicators": [                   // indicators referenced by entry/exit rules
    { "id": string, "type": "VWAP" | "SMA" | "EMA", "period": number | null }
    // VWAP has no period (session-anchored, resets daily). SMA/EMA require a period (number of 1-min bars).
  ],
  "entry": {
    "waitBars": number,             // how many 1-min bars to wait after the open before the first possible entry (0 or 1 typically)
    "conditions": [
      { "if": "price_above" | "price_below", "indicator": string, "then": "long" | "short" }
      // e.g. price above VWAP -> long, price below VWAP -> short. List every condition mentioned.
    ]
  },
  "exit": {
    "stop": 
        { "type": "indicator_cross", "indicator": string }          // exit when a bar CLOSES on the wrong side of the named indicator
      | { "type": "fixed_pct", "value": number }                     // exit at a fixed % loss from entry
      | { "type": "none" },
    "target":
        { "type": "fixed_pct", "value": number }
      | { "type": "none" },
    "endOfDay": boolean             // true if the strategy flattens at the close and never holds overnight (this is the common case)
  },
  "positionSizing": "full_equity" | "fixed_shares",
  "warnings": string[]              // anything in the description this schema CANNOT express faithfully. Be specific and honest — do not silently drop or approximate a rule. If the description is fully expressible, this is [].
}

RULES:
- If the description is ambiguous about a detail (e.g. exact stop-loss size), pick the most literal reading of the text and note the assumption in "warnings" — do not guess silently.
- Only use SMA/EMA/VWAP as indicator types. If the description needs an indicator this schema doesn't support (e.g. RSI, Bollinger Bands, options-flow metrics), do NOT invent a fake mapping — list it in "warnings" and omit it from "indicators".
- "summary" must describe the ACTUAL parsed rule, not marketing language from the source text.
`.trim();

function callModel(system, user) {
  return callClaude(user, { system });
}

// description: raw text (a strategy explanation, or pasted excerpts of a paper)
export async function parseStrategy(description) {
  const system = `You are a precise strategy-to-schema translator for a backtesting system. ${SCHEMA_DOC}`;
  const user = `Convert this strategy description into the schema:\n\n${description}`;

  const text = await callClaude(user, { system });
  const rule = await extractJsonWithRepair(text, { callModel, modelId: "strategy-parser" });

  return rule;
}
