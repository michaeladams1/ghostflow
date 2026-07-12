// Shared rule vocabulary for both the analysis prompt and the refinement prompt.
// Generated from metrics.js so the prompt can never drift out of sync with what
// the backtest can actually evaluate — the previous hand-written list is exactly
// how models ended up naming feeds that did not exist.

import { buildVocabulary } from "./metrics.js";
import { TIME_FEED, TIME_METRICS } from "./backtest.js";

// SESSION gates that a trader genuinely knows BEFORE the bell. These are built
// from standing positioning (open interest, dealer exposure, skew, prior-day
// dark-pool levels), so gating on them is legitimate.
const KNOWABLE_AT_OPEN = new Set([
  "exposure_by_strike_gamma", "exposure_by_strike_delta", "exposure_by_strike_vanna",
  "exposure_by_strike_charm", "exposure_by_expiration_gamma",
  "open_interest_by_strike", "open_interest_by_expiration", "open_interest_over_time",
  "volatility_skew", "term_structure", "max_pain_over_time", "dark_pool_levels",
]);

export function ruleVocabularyBlock() {
  const v = buildVocabulary();
  const lines = [];

  lines.push(`--- BAR TRIGGERS (minute-by-minute) — these decide WHEN you enter ---`);
  lines.push(`Compared in SIGMA (z-score vs that session's own trailing baseline). A threshold of 20 means "20 sigma".`);
  for (const [feed, metrics] of Object.entries(v.bar)) {
    if (feed === "stock_price_over_time" || feed === "option_price_over_time") continue;
    lines.push(`  ${feed}: ${metrics.join(", ")}`);
  }

  lines.push(``);
  lines.push(`--- SESSION GATES (one value per day) — these decide WHETHER TO TRADE TODAY AT ALL ---`);
  lines.push(`Compared as RAW values, not sigma. A gamma wall is not a moment; it is a standing regime. The "SESSION METRICS" table above shows you the real magnitudes for this session — use it to pick a threshold that is neither impossible nor trivially always-true.`);

  const knowable = [], notKnowable = [];
  for (const [feed, metrics] of Object.entries(v.session)) {
    const line = `  ${feed}: ${metrics.join(", ")}`;
    (KNOWABLE_AT_OPEN.has(feed) ? knowable : notKnowable).push(line);
  }

  lines.push(``);
  lines.push(`  [SAFE — known before the bell; these are standing positioning, so gating on them is legitimate]`);
  knowable.forEach((l) => lines.push(l));

  lines.push(``);
  lines.push(`  [!! CAUTION — these are SAME-DAY CUMULATIVE TOTALS. A gate like "call_put_premium_ratio > 3" uses the WHOLE day's flow to decide whether to trade at 10:00am. You could NOT have known that at 10:00am. Using these as gates will flatter your backtest with lookahead bias and produce a rule that cannot be traded. Use them for REASONING, but avoid them as gates unless you explicitly acknowledge the limitation.]`);
  notKnowable.forEach((l) => lines.push(l));

  lines.push(``);
  lines.push(`--- TIME FILTER ---`);
  lines.push(`  ${TIME_FEED}: ${TIME_METRICS.join(", ")}   (minutes from 09:30 / until 16:00 — for "avoid the last hour" style filters)`);

  lines.push(``);
  lines.push(`EVERY RULE NEEDS AT LEAST ONE BAR TRIGGER. Session gates alone say which DAYS to trade but never WHEN to enter, so they can never produce a trade and the rule will be rejected.`);

  return lines.join("\n");
}
