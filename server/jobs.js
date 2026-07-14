// BACKGROUND JOB RUNNER.
//
// THE PROBLEM THIS SOLVES:
// Backtest, confirmation analysis, and the refinement loop are all essential —
// a rule with no backtest is just a story. But they are SLOW:
//   backtest      ~40 sessions
//   confirmers    ~17 candidate feeds x 2 backtests x 40 sessions
//   refinement    up to 4 rounds x 60 sessions
// Running them inside the /api/analyze request would hang it for 20+ minutes
// and time out. So they were buttons — which made the most important steps
// OPTIONAL, and an analysis could sit there showing a confident "TRADEABLE"
// verdict with nobody ever finding out the rule loses money.
//
// THE FIX: the analysis returns immediately (with its auto-backtest), and the
// heavy work runs in the background, writing each result into the record's DB
// row as it completes. The UI polls and fills in the findings as they arrive.
// Nothing is optional; it just takes a few minutes to fully populate.
//
// This is deliberately simple in-process work, not a real queue. If the server
// restarts mid-job the job is lost — which is why `status` is persisted, so a
// stuck "running" is visible rather than looking like it never started.

import { readTrades, appendTrade } from "./store.js";
import { backtestRule, priorSessions } from "./backtest.js";
import { analyzeConfirmers } from "./confirmation.js";
import { refineRule } from "./refine.js";

const MODELS = ["claude", "gpt", "grok"];

// Re-reads the record before every write. These jobs run concurrently and each
// writes a different key; without re-reading, the last writer would clobber the
// others' results with its own stale snapshot.
async function patchRecord(id, mutate) {
  const all = await readTrades();
  const rec = all.find((r) => r.id === id);
  if (!rec) return null;
  mutate(rec);
  await appendTrade(rec);
  return rec;
}

async function setJobStatus(id, job, status, detail) {
  return patchRecord(id, (rec) => {
    rec.jobs = rec.jobs || {};
    rec.jobs[job] = { status, detail: detail || null, at: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// BACKTESTS: the auto-backtest that used to run INSIDE /api/analyze.
// It was the single biggest reason the analyze request could hang for 10-20
// minutes (3 models x 40 sessions of feed fetches) and strand the UI on
// "Pulling 30 feeds..." forever if the connection dropped. The UI already
// polls for a rule with no backtest, so moving it here needs no frontend work.
// Runs FIRST because confirmers/refinement build on the same base rule.
// ---------------------------------------------------------------------------
async function runBacktests(id, { ticker, sessionDate, analysis }) {
  await setJobStatus(id, "backtests", "running");
  const sessions = priorSessions(sessionDate, 40);

  for (const m of MODELS) {
    const rule = analysis[m]?.rule;
    if (!rule) continue;
    try {
      console.log(`[job:backtest] ${m} on ${ticker}...`);
      const result = await backtestRule(rule, { ticker, sessions, holdMinutes: 15 });
      await patchRecord(id, (rec) => {
        rec.backtests = rec.backtests || {};
        rec.backtests[m] = result;
      });
      console.log(`[job:backtest] ${m}: ${result.verdict || result.reason}`);
    } catch (err) {
      console.error(`[job:backtest] ${m} FAILED:`, err.message);
      await patchRecord(id, (rec) => {
        rec.backtests = rec.backtests || {};
        rec.backtests[m] = { testable: false, reason: `Backtest failed: ${err.message}` };
      });
    }
  }
  await setJobStatus(id, "backtests", "done");
}

// ---------------------------------------------------------------------------
// CONFIRMERS: which feeds actually LIFT the base signal?
// ---------------------------------------------------------------------------
async function runConfirmers(id, { ticker, sessionDate, analysis }) {
  await setJobStatus(id, "confirmers", "running");
  const sessions = priorSessions(sessionDate, 40);

  for (const m of MODELS) {
    const rule = analysis[m]?.rule;
    if (!rule) continue;
    try {
      console.log(`[job:confirmers] ${m} on ${ticker}...`);
      const result = await analyzeConfirmers(rule, { ticker, sessions, holdMinutes: 15 });
      await patchRecord(id, (rec) => {
        rec.confirmers = rec.confirmers || {};
        rec.confirmers[m] = result;
      });
      console.log(`[job:confirmers] ${m} done`);
    } catch (err) {
      console.error(`[job:confirmers] ${m} FAILED:`, err.message);
      await patchRecord(id, (rec) => {
        rec.confirmers = rec.confirmers || {};
        rec.confirmers[m] = { ok: false, reason: `Failed: ${err.message}` };
      });
    }
  }
  await setJobStatus(id, "confirmers", "done");
}

// ---------------------------------------------------------------------------
// REFINEMENT: read your own losses, revise, retest — or abandon honestly.
// ---------------------------------------------------------------------------
async function runRefinement(id, { ticker, sessionDate, analysis }) {
  await setJobStatus(id, "refinements", "running");

  for (const m of MODELS) {
    const rule = analysis[m]?.rule;
    if (!rule) continue;
    try {
      console.log(`[job:refine] ${m} on ${ticker}...`);
      const result = await refineRule({
        modelId: m, initialRule: rule, ticker,
        fromDate: sessionDate, sessions: 60, maxRounds: 4, holdMinutes: 15,
      });
      await patchRecord(id, (rec) => {
        rec.refinements = rec.refinements || {};
        rec.refinements[m] = result;
      });
      console.log(`[job:refine] ${m}: ${result.conclusion}`);
    } catch (err) {
      console.error(`[job:refine] ${m} FAILED:`, err.message);
      await patchRecord(id, (rec) => {
        rec.refinements = rec.refinements || {};
        rec.refinements[m] = { error: err.message, history: [], conclusion: `Refinement failed: ${err.message}` };
      });
    }
  }
  await setJobStatus(id, "refinements", "done");
}

// Fired after /api/analyze responds. Deliberately NOT awaited by the request —
// the caller gets its analysis immediately and the findings fill in behind it.
export function startBackgroundJobs(id, { ticker, sessionDate, analysis }) {
  const anyRule = MODELS.some((m) => analysis[m]?.rule);
  if (!anyRule) {
    // Every model passed. There is nothing to test, and saying so explicitly is
    // better than leaving the panels in a permanent "pending" state.
    setJobStatus(id, "backtests", "skipped", "No model proposed a rule — nothing to backtest.");
    setJobStatus(id, "confirmers", "skipped", "No model proposed a rule — nothing to test.");
    setJobStatus(id, "refinements", "skipped", "No model proposed a rule — nothing to refine.");
    return;
  }

  setJobStatus(id, "backtests", "queued");
  setJobStatus(id, "confirmers", "queued");
  setJobStatus(id, "refinements", "queued");

  // Sequential, not parallel: both hammer the same rate-limited data API, and
  // running them at once was what caused sessions to get silently dropped.
  (async () => {
    try {
      await runBacktests(id, { ticker, sessionDate, analysis });
      await runConfirmers(id, { ticker, sessionDate, analysis });
      await runRefinement(id, { ticker, sessionDate, analysis });
      console.log(`[jobs] all background work complete for ${id}`);
    } catch (err) {
      console.error(`[jobs] fatal error for ${id}:`, err);
    }
  })();
}
