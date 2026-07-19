// THE THESIS DOCUMENTS — the learning half of GHOSTFLOW.
//
// Every measurement the machine produces (verdicts, backtests, basket sweeps,
// option P&L) dies inside one card unless something carries it forward. This
// module is that something: each AI analyst maintains ONE evolving thesis
// document — Setup Conditions, Supporting Evidence citing specific trades,
// Confidence tied to sample size, Counter-Examples, Last Updated — revised
// after EVERY analyzed trade (wins, losses, and passes alike: a pass with a
// near-miss is evidence too). The next analysis injects the analyst's own
// document into its briefing, so the machine's findings compound instead of
// evaporating.
//
// "Making the model better" = updating these documents. Not fine-tuning.
//
// THE MERGE PRESERVES DISAGREEMENT. The shared knowledge base is the three
// documents side by side, assembled deterministically — never an AI blending
// three views into one. A 2-1 split between analysts is information.

import { pool, ensureSchema } from "./db.js";
import { callClaude, callGPT, callGrok } from "./aiProviders.js";
import { extractJsonWithRepair } from "./jsonRepair.js";

const MODELS = ["claude", "gpt", "grok"];
const CALLERS = { claude: callClaude, gpt: callGPT, grok: callGrok };

const EMPTY_DOC = () => ({ theses: [], generalNotes: "", tradesSeen: 0 });

export async function loadThesisDoc(model) {
  try {
    await ensureSchema();
    const r = await pool.query("SELECT doc FROM theses WHERE model = $1", [model]);
    return r.rows[0]?.doc || EMPTY_DOC();
  } catch (err) {
    console.warn(`[thesis] load failed for ${model} (using empty): ${err.message}`);
    return EMPTY_DOC();
  }
}

export async function saveThesisDoc(model, doc) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO theses (model, doc, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (model) DO UPDATE SET doc = $2, updated_at = now()`,
    [model, JSON.stringify(doc)],
  );
}

export async function loadAllTheses() {
  await ensureSchema();
  const r = await pool.query("SELECT model, doc, updated_at FROM theses");
  const out = {};
  for (const row of r.rows) out[row.model] = { doc: row.doc, updatedAt: row.updated_at };
  return out;
}

// Compact rendering for injection into an analyst's briefing. Capped hard —
// the briefing is already enormous, and a thesis doc that crowds out the
// actual data would be self-defeating.
export function renderThesisForPrompt(doc, { maxChars = 3000 } = {}) {
  if (!doc?.theses?.length) {
    return "Your thesis document is empty — this is early in the trade log. Anything you conclude today becomes its founding entries.";
  }
  const lines = [];
  for (const t of doc.theses) {
    lines.push(`THESIS: ${t.name}  [confidence ${t.confidence ?? "?"}/100, sample n=${t.sampleSize ?? "?"}]`);
    if (t.setupConditions) lines.push(`  Setup: ${t.setupConditions}`);
    const ev = (t.supportingEvidence || []).map((e) => `${e.ticker} ${e.sessionDate}`).join(", ");
    if (ev) lines.push(`  For: ${ev}`);
    const ce = (t.counterExamples || []).map((e) => `${e.ticker} ${e.sessionDate}: ${e.note}`.slice(0, 160)).join(" | ");
    if (ce) lines.push(`  AGAINST: ${ce}`);
  }
  if (doc.generalNotes) lines.push(`NOTES: ${doc.generalNotes}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n[...thesis document truncated for length]";
  return text;
}

// Deterministic outcome summary of one fully-analyzed trade: everything the
// machinery measured, stated as facts with numbers, for the thesis editor to
// reckon with. No AI writes this — it is the ground truth being learned from.
export function buildTradeOutcome(rec, model) {
  const a = rec.analysis?.[model];
  const lines = [];
  lines.push(`TRADE: ${rec.symbol} session ${rec.sessionDate}${rec.contract ? ` — OPTION: ${rec.contract.strikePrice} ${rec.contract.contractType} exp ${rec.contract.expirationDate}` : " — stock"}`);
  if (rec.notes) lines.push(`Michael's note: "${String(rec.notes).slice(0, 200)}"`);

  if (!a || a.failed) {
    lines.push(`Your analysis FAILED to run (${String(a?.reasoning || "unknown error").slice(0, 120)}). No verdict from you on this trade.`);
  } else {
    lines.push(`Your verdict: ${a.verdict}${a.verdict === "tradeable" ? ` @ confidence ${a.confidence}` : ""}${a.entry?.timestamp ? `, entry ${a.entry.timestamp}` : ""}`);
    if (a.reasoning) lines.push(`Your reasoning: ${String(a.reasoning).slice(0, 500)}`);
  }

  const others = MODELS.filter((m) => m !== model).map((m) => {
    const o = rec.analysis?.[m];
    return `${m}: ${o?.failed ? "failed" : o?.verdict || "?"}${o?.verdict === "tradeable" ? `@${o.confidence}` : ""}`;
  });
  lines.push(`Other analysts (for context only — do NOT adopt their reasoning): ${others.join(", ")}`);

  const bt = rec.backtests?.[model];
  if (bt) lines.push(`Home-ticker backtest of your rule: ${String(bt.verdict || bt.reason || "n/a").slice(0, 350)}`);

  const ref = rec.refinements?.[model];
  if (ref?.conclusion) lines.push(`Refinement loop: ${String(ref.conclusion).slice(0, 350)}`);

  const bk = rec.basket?.[model];
  if (bk?.aggregate) {
    const g = bk.aggregate;
    lines.push(`Basket sweep (${bk.lookbackSessions} sessions x ${g.tickersTested} other tickers): ${g.fires} fires${g.winRate != null ? `, ${g.winRate}% pooled win rate` : ""}${g.enoughData ? "" : " (sample below 20 — weak evidence)"}. Per ticker: ${(bk.perTicker || []).map((p) => `${p.ticker}=${p.error ? "err" : p.testable === false ? "n/a" : `${p.totalTrades}f${p.totalTrades ? `/${p.winRate}%` : ""}`}`).join(" ")}`);
  }

  const os = rec.optionSim?.[model];
  if (os) {
    const flow = os.flow?.n ? `flow-picked contract: ${os.flow.n} sims, ${os.flow.winRate}% win, avg ${os.flow.avgPct}%` : "flow-picked contract: no fills";
    const grid = Object.entries(os.grid || {}).map(([k, v]) => `${k}=${v.n ? `${v.avgPct}%avg/${v.n}` : "no fills"}`).join(" ");
    lines.push(`Option P&L on fired days (${os.holdMinutes}min hold): ${flow}${grid ? `; class grid: ${grid}` : ""}`);
  }

  return lines.join("\n");
}

const THESIS_SYSTEM = `You are maintaining YOUR OWN evolving thesis document inside GHOSTFLOW, a market signal discovery system. This document is your accumulated knowledge across every trade you have analyzed. It is the ONLY memory you carry between trades.

You are given your current document and the complete measured outcome of one newly analyzed trade — your verdict, the backtest of your rule, the refinement loop's conclusion, the cross-ticker basket sweep, and the option P&L simulation. Revise the document to absorb what was learned.

=== THE DISCIPLINE ===
1. EVERY claim must cite specific trades (ticker + date) as evidence. A thesis with no cited trades is a story, not a thesis.
2. CONFIDENCE IS TIED TO SAMPLE SIZE. n=1 caps confidence at 25 no matter how good it looked. n=3-5 consistent -> up to 50. Real confidence (70+) requires 10+ instances with measured, positive results.
3. COUNTER-EXAMPLES ARE FIRST-CLASS. A backtest that killed your rule, a basket sweep that showed negative edge, an option class that bled to theta — these go in counterExamples with the numbers, and they LOWER confidence. Deleting inconvenient evidence is the one unforgivable act here.
4. "Nothing was knowable" outcomes are evidence too — they refine WHERE your setups do and do not apply (e.g. "thin small caps with no options activity: repeatedly nothing knowable").
5. MERGE, don't multiply. If today's finding fits an existing thesis, update that thesis. Only create a new one for a genuinely new setup class. Keep at most 8 theses; prune the weakest (note prunings in generalNotes).
6. Machine-measured numbers (win rates, fires, P&L) outrank your narrative impressions. If they conflict, the numbers win and the narrative changes.

=== OUTPUT ===
Respond with ONLY one JSON object, no markdown fences, exactly this shape:
{
  "theses": [
    {
      "name": "short name of the setup class",
      "setupConditions": "concrete, feed-level description of the setup",
      "supportingEvidence": [ { "ticker": "X", "sessionDate": "YYYY-MM-DD", "note": "what happened, with numbers" } ],
      "counterExamples": [ { "ticker": "X", "sessionDate": "YYYY-MM-DD", "note": "what contradicted it, with numbers" } ],
      "confidence": 0-100,
      "sampleSize": <integer — total cited instances>,
      "lastUpdated": "YYYY-MM-DD"
    }
  ],
  "generalNotes": "cross-cutting observations, prunings, open questions",
  "tradesSeen": <integer — increment the previous count by 1>
}`;

export async function updateThesisForModel(model, rec) {
  const fn = CALLERS[model];
  if (!fn) throw new Error(`No caller for model ${model}`);
  const current = await loadThesisDoc(model);
  const outcome = buildTradeOutcome(rec, model);

  const user = [
    `=== YOUR CURRENT THESIS DOCUMENT (JSON) ===`,
    JSON.stringify(current, null, 1),
    ``,
    `=== NEWLY MEASURED TRADE OUTCOME ===`,
    outcome,
    ``,
    `Revise the document per the discipline. Return the COMPLETE revised JSON document.`,
  ].join("\n");

  const raw = await fn(user, { system: THESIS_SYSTEM });
  const parsed = await extractJsonWithRepair(raw, {
    modelId: model,
    callModel: (sys, usr) => fn(usr, { system: sys }),
  });

  // Minimal shape guard: refuse to overwrite a real doc with garbage.
  if (!parsed || !Array.isArray(parsed.theses)) {
    throw new Error("revised document missing 'theses' array — keeping previous version");
  }
  parsed.tradesSeen = Number(parsed.tradesSeen) || (Number(current.tradesSeen) || 0) + 1;
  await saveThesisDoc(model, parsed);
  return parsed;
}

// After each per-model update, the shared knowledge base is assembled
// DETERMINISTICALLY: the three documents side by side plus a computed list of
// setup names more than one analyst independently arrived at. No AI merge —
// blending is exactly what this system refuses to do.
export async function updateAllTheses(rec) {
  const results = {};
  for (const m of MODELS) {
    try {
      results[m] = { ok: true, doc: await updateThesisForModel(m, rec) };
      console.log(`[thesis] ${m} updated (${results[m].doc.theses.length} theses, ${results[m].doc.tradesSeen} trades seen)`);
    } catch (err) {
      console.error(`[thesis] ${m} update FAILED (previous doc kept):`, err.message);
      results[m] = { ok: false, error: err.message };
    }
  }

  try {
    const all = {};
    for (const m of MODELS) all[m] = await loadThesisDoc(m);
    const nameCounts = {};
    for (const m of MODELS) for (const t of all[m].theses || []) {
      const key = String(t.name || "").toLowerCase().trim();
      if (key) (nameCounts[key] = nameCounts[key] || []).push(m);
    }
    const convergent = Object.entries(nameCounts).filter(([, ms]) => new Set(ms).size > 1)
      .map(([name, ms]) => ({ name, models: [...new Set(ms)] }));
    await saveThesisDoc("shared", {
      mergedAt: new Date().toISOString(),
      note: "Deterministic side-by-side merge. Disagreements preserved, never blended.",
      convergentSetups: convergent,
      byModel: all,
    });
  } catch (err) {
    console.error("[thesis] shared merge failed:", err.message);
  }

  return results;
}
