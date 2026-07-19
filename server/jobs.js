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
import { mineNegativePattern } from "./patternMiner.js";

const MODELS = ["claude", "gpt", "grok"];

// ~365 calendar days of lookback. priorSessions() only counts weekdays (no
// weekends/holidays baked into the count itself — those get skipped when a
// session returns no data), so 365 calendar days ≈ 260 weekdays.
const BACKTEST_LOOKBACK_SESSIONS = 260;

// CONFIRMERS GET A SHORTER WINDOW — ON PURPOSE.
// The confirmers job is combinatorial: ~17 candidate feeds x 2 backtests each
// x N sessions x up to 3 models. When the lookback was raised from 40 to 260
// sessions for the plain backtest, this job silently inherited the raise and
// became ~6.5x slower — hours of grinding per analysis (the stuck-"confirming"
// cards). 60 sessions (~3 months) is enough to measure lift directionally;
// the winner still gets validated by the full-depth backtest and refinement.
const CONFIRMER_LOOKBACK_SESSIONS = 60;

// Re-reads the record before every write. These jobs run concurrently and each
// writes a different key; without re-reading, the last writer would clobber the
// others' results with its own stale snapshot.
// (Exported: server.js's background analysis runner uses the same pattern.)
export async function patchRecord(id, mutate) {
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
  const sessions = priorSessions(sessionDate, BACKTEST_LOOKBACK_SESSIONS);

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
// PATTERN MINER: the "step 4" Michael described — of the times the trigger
// fired (gates stripped, so there's a real sample), what separated winners
// from losers? Mines a filter on the first 70% chronologically, validates it
// against the untouched last 30%, and only reports it as real if it survives
// that holdout. Runs on the SAME rule the plain backtest just tested, so it's
// natural to do it right after — but it deliberately reruns the trigger
// ungated rather than reusing runBacktests' gated result, since the whole
// point is to get a sample the gates would otherwise have starved.
// ---------------------------------------------------------------------------
async function runPatternMiner(id, { ticker, sessionDate, analysis }) {
  await setJobStatus(id, "patternMiner", "running");

  for (const m of MODELS) {
    const rule = analysis[m]?.rule;
    if (!rule) continue;
    try {
      console.log(`[job:patternMiner] ${m} on ${ticker}...`);
      const result = await mineNegativePattern(rule, {
        ticker, fromDate: sessionDate, sessions: BACKTEST_LOOKBACK_SESSIONS, holdMinutes: 15,
      });
      await patchRecord(id, (rec) => {
        rec.patternMiner = rec.patternMiner || {};
        rec.patternMiner[m] = result;
      });
      console.log(`[job:patternMiner] ${m}: ${result.verdict || result.reason}`);
    } catch (err) {
      console.error(`[job:patternMiner] ${m} FAILED:`, err.message);
      await patchRecord(id, (rec) => {
        rec.patternMiner = rec.patternMiner || {};
        rec.patternMiner[m] = { ok: false, reason: `Pattern mining failed: ${err.message}` };
      });
    }
  }
  await setJobStatus(id, "patternMiner", "done");
}

// ---------------------------------------------------------------------------
// CONFIRMERS: which feeds actually LIFT the base signal?
// ---------------------------------------------------------------------------
async function runConfirmers(id, { ticker, sessionDate, analysis }) {
  await setJobStatus(id, "confirmers", "running");
  const sessions = priorSessions(sessionDate, CONFIRMER_LOOKBACK_SESSIONS);

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
    // better than leaving the panels in a permanent "pending" state. Awaited
    // sequentially inside an IIFE — same lost-update race as the queued writes.
    (async () => {
      await setJobStatus(id, "backtests", "skipped", "No model proposed a rule — nothing to backtest.");
      await setJobStatus(id, "patternMiner", "skipped", "No model proposed a rule — nothing to mine.");
      await setJobStatus(id, "confirmers", "skipped", "No model proposed a rule — nothing to test.");
      await setJobStatus(id, "refinements", "skipped", "No model proposed a rule — nothing to refine.");
    })().catch((err) => console.error(`[jobs] skipped-status writes failed for ${id}:`, err));
    return;
  }

  // Sequential, not parallel: both hammer the same rate-limited data API, and
  // running them at once was what caused sessions to get silently dropped.
  // The four "queued" writes are AWAITED INSIDE the async chain for the same
  // reason: each setJobStatus is a read-modify-write of the whole record, so
  // firing four of them unawaited (and racing the chain's own status writes)
  // caused lost updates — cards showing impossible states like backtests
  // "queued" next to refinements "done" left over from a previous run.
  (async () => {
    try {
      await setJobStatus(id, "backtests", "queued");
      await setJobStatus(id, "patternMiner", "queued");
      await setJobStatus(id, "confirmers", "queued");
      await setJobStatus(id, "refinements", "queued");
      await runBacktests(id, { ticker, sessionDate, analysis });
      await runPatternMiner(id, { ticker, sessionDate, analysis });
      await runConfirmers(id, { ticker, sessionDate, analysis });
      await runRefinement(id, { ticker, sessionDate, analysis });
      console.log(`[jobs] all background work complete for ${id}`);
    } catch (err) {
      console.error(`[jobs] fatal error for ${id}:`, err);
    }
  })();
}
