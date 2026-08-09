# AGENTS.md

## Cursor Cloud specific instructions

**Current focus: the 0DTE tab only.** Treat Analyses, Strategy Lab, and Theses as out of scope unless the user explicitly asks. Prefer changes, tests, demos, and secrets work that unblocks SPY 0DTE debrief / calendar / performance / 24-month backtest.

GHOSTFLOW is a single app: a React (Vite) frontend + one Express backend (`server.js`) backed by PostgreSQL, with external vendor/AI integrations (Quant Data, Alpaca, Databento, Anthropic/OpenAI/xAI). npm scripts are the source of truth (`package.json`); the root `README.md` is outdated — `docs/architecture.md` and `docs/0DTE_HANDOFF.md` are accurate.

Dependencies (`npm install`) are refreshed automatically by the startup update script — don't reinstall unless something is missing.

### Running the app (dev)
- The backend serves the built frontend from `dist/` and exposes `/api/*`. There is **no Vite dev proxy**, so `npm run dev` alone (Vite on :5173) cannot reach the API. For a working full stack, build first then run the server:
  - `npm run build`
  - `node --env-file=.env server.js` → app at `http://localhost:3000`
- Use `node --env-file=.env server.js`, **not** `npm start` — `npm start` runs `node server.js` without loading `.env`, so `DATABASE_URL`/keys won't be picked up.
- The server always starts even when vendor/DB config is missing; it only logs failures (e.g. the AI provider health check 401s without keys). Missing keys surface as clean per-request errors, not crashes.

### PostgreSQL (local, installed in the VM)
- Start it on each boot before running the server: `sudo pg_ctlcluster 16 main start`
- Local dev DB: role `ghostflow` / password `ghostflow` / database `ghostflow`. Connect string (already in `.env`): `postgres://ghostflow:ghostflow@127.0.0.1:5432/ghostflow`. `db.js` auto-disables SSL for localhost URLs.
- If the role/DB is missing after a fresh VM, recreate it: `sudo -u postgres psql -c "CREATE ROLE ghostflow LOGIN PASSWORD 'ghostflow';"` then `sudo -u postgres createdb -O ghostflow ghostflow`.
- Schema is created automatically on first DB query via `ensureSchema()` in `server/db.js` — no migration step to run.

### Environment / secrets
- `.env` is gitignored. Copy from `.env.example`; note `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` are required by the 0DTE feature but are **missing** from `.env.example`.
- Full end-to-end flows need external secrets: Analyses → `QUANTDATA_API_KEY` + `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`XAI_API_KEY`; 0DTE → `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`; Strategy Lab → `DATABENTO_API_KEY` + `ANTHROPIC_API_KEY`. Without them, the server, UI, and DB layer all run, but vendor-backed actions return auth/coverage errors.
- **In the Cursor Cloud VM, `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`, `QUANTDATA_API_KEY`, and `DATABENTO_API_KEY` are already injected as Cursor secrets** (env vars), so live 0DTE `analyze`/24-month backtest work out of the box. The AI keys (`ANTHROPIC`/`OPENAI`/`XAI`) and `DATABASE_URL` are **not** injected. So a local `.env` only needs to set `DATABASE_URL` (local Postgres) and can leave auth blank. **Do not set the vendor keys to blank in `.env`** — omit those lines so the injected secrets pass through. (`node --env-file` doesn't override an already-set env var, but a blank line is still confusing; omitting is unambiguous.)

### Railway logs (persistent, no login)
- Cloud agents already have a project-scoped `RAILWAY_TOKEN` secret injected. That is enough for deploy/runtime log reads — do **not** run `railway login` or ask the user to re-auth.
- `railway whoami` / `railway project list` fail with project tokens by design; that is not a missing-auth signal. Use `railway status --json` or log commands instead.
- If the CLI is missing: `bash <(curl -fsSL https://railway.com/install.sh)` then `source "$HOME/.railway/env"`.
- Production app service is `ghostflow` (project `spectacular-prosperity`, env `production`, URL `https://ghostflow-production-27e9.up.railway.app`). Always pass `--service`:
  - `railway logs --service ghostflow --lines 200 --json`
  - `railway logs --service ghostflow --build --lines 200 --json`
  - `railway logs --service ghostflow --since 1h --lines 400 --json`
  - `railway logs --service ghostflow --lines 200 --filter "@level:error" --json`

### Tests / build (must pass before push)
- `npm test` — standalone 0DTE regression tests (deterministic scoring/backtest/calendar logic); no DB or vendor keys required.
- `npm run build` — frontend production build.
- Other `server/test*.js` harnesses (e.g. `node --env-file=.env server/testZeroDTE.js`) hit live vendors and need keys.

---

## Working agreement — shipping changes to GitHub

This is the process Cursor agents follow when changing this repo and pushing to GitHub.

### Identify what kind of change this is, before touching code

Every request falls into one of:

1. **A feature** — adds new behavior. Gets a branch, a PR, a deploy verification.
2. **A bugfix** — restores intended behavior. Same flow as a feature.
3. **A diagnostic question** — "is X working?" "what does the dashboard look like?" Answer it by reading the live system (logs, the deployed UI, the database, whatever the surface is) before assuming. Don't open a PR until you know there's a real defect.
4. **A discussion** — "should we do X?" Talk it through before writing code. Surface tradeoffs, recommend, then ask.

Misclassifying #3 as #2 is the most common failure. When the user asks "is it right?", read the actual artifact — don't infer from logs that the surface looks correct.

### Write the PR description before the code

Open the PR draft in your head (or in a comment block) first. State:

- What problem this solves, in one sentence.
- What the user-visible change is.
- What the code change is, structurally — which files, which functions, what new entities.
- Any required config changes outside the repo (env vars, third-party app permissions, DNS, infrastructure, etc.) flagged loudly.

If you can't write those four things crisply (~10 lines), you don't understand the change well enough to write it. Go back and think more.

This catches scope creep early. If the description balloons past ~6 paragraphs you're probably trying to do two things in one PR; split it.

### Branch and PR conventions

- Branch from latest `main`. Always sync first (`git fetch origin main` and rebase/branch from it).
- Branch names (Cursor Cloud): `cursor/<type>-<short-kebab>-f94a` where `<type>` is `feature`, `fix`, or `hotfix`. Examples: `cursor/feature-0dte-calendar-filter-f94a`, `cursor/fix-debrief-pnl-sign-f94a`.
- One concern per PR. If you find yourself touching unrelated files, stop and split.
- PR titles are imperative and specific. "Validate user input on signup" not "Signup fixes."
- PR bodies use the four-section structure above. Don't decorate with marketing language; write for the version of yourself debugging this in six months.
- Open PRs as drafts until verification in this environment is done; mark ready when the change is actually verified, then merge.

### Squash-merge trap

If PR B is opened while PR A is still in review, and B was branched from a commit that included A's changes, the squash-merge of B onto main *after* A is already merged will re-apply A's content. Result: duplicate functions, duplicate declarations, builds that fail in ways static-only checks won't catch.

Avoidance: never branch off another open PR's branch. If you must, rebase onto `main` before merging. After every squash-merge into a recently-active area, run a full production build locally and check for duplicate symbols on anything you touched in the last two PRs. Example check (should print `1`):

```bash
grep -c "<unique-signature-of-thing-you-added>" <file>
```

### Tool ordering on this project

Follow this order on each feature/fix/hotfix:

1. Sync with `main`.
2. Branch (`cursor/<type>-<short-kebab>-f94a`).
3. Edit. Run `npm test` and `npm run build`. Both must pass.
4. Commit with a real message (not "wip" or "fix").
5. Push (`git push -u origin <branch-name>`).
6. Open/update the PR (draft until verified). Capture the PR number/URL.
7. Merge to `main` (squash unless the project says otherwise). Capture the merge commit SHA.
8. Poll the deployment until it succeeds — or fails, in which case stop and read build logs.
9. Read runtime logs for the boot signal your change should produce.
10. Verify the user-facing artifact directly.

Diagnostic (#3) and discussion (#4) requests skip steps 2–7 until a real defect or an agreed change exists.

### Verification is part of the work

A merged PR is not a done PR. After every merge:

1. Watch the deploy succeed.
2. Read deploy logs for the first ~60 seconds of boot. Look for the lines your change should produce. If your change should log a completion marker, see that line.
3. Verify the user-facing artifact directly. If the change touches a database row, query it. If it touches a UI, open the page. If it touches an external system, read the state on that side. Don't trust "the logs look right" as a stand-in for "the thing the user sees is right."
4. If anything is wrong, write the next fix immediately — don't ship and walk away.

### When something seems "almost right"

Read the actual artifact. Don't reason from logs alone about what the user sees. A log line saying "wrote 9 records" doesn't mean 9 records are visible to the user — those are two separate things separated by caches, indexes, replication, rendering, or any number of intermediate layers. Always close the loop by inspecting the final surface.

### Architecture defaults for systems with persistence outside the database

When durable state lives somewhere external to your primary store (a third-party API, an inbox, a queue, a file system), prefer stateless logic over in-memory state. In-memory state is reset by process restarts; the external store isn't. If a piece of behavior must survive restart (timeouts, reconciliation, audit trails), implement it as a periodic sweep over the external store, not as a timer over an in-memory structure.

This is what makes systems recover automatically instead of requiring manual intervention every time the host reboots.

### Backfills

Whenever you add a behavior that produces a persistent artifact (a tag, a flag, a metadata field, an index row, a status), ask: should this also be applied to existing records? If yes, ship the backfill in the same PR. Backfills should be:

- **Idempotent** — safe to run multiple times. The underlying operation should accept "already done" as a no-op, not throw.
- **Bounded** — don't scan all of history by default. Pick a reasonable horizon and document why.
- **Observable** — log scanned/applied counts at completion.
- **Boot-attached or one-shot** — run at process start (in the background, not blocking startup) or as a manually-invoked script. Don't bury backfill logic inside request handlers.

### Idempotency in multi-step pipelines

Any pipeline that performs several side effects in sequence (notify, stamp, email, refresh, etc.) should be safely callable multiple times on the same entity. The third call should be a no-op, not a duplicate. Achieve this by guarding each side-effect on a persistent flag the durable store can answer:

- "Has the notification been sent?" check before sending.
- "Has the record been marked complete?" check before marking.
- "Has the downstream system been notified?" check before notifying.

The flag has to live in the durable store, not in memory. In-memory flags die with the process and cause double-fires after restart.

### Logging style

- Prefix every log line with `[subsystem]`. Makes filtering trivial.
- Log decisions, not just events. `[X] skipped: condition-not-met` tells you why something didn't happen; `[X] received event` alone doesn't.
- Log payload-relevant fields, not the whole payload. IDs, timestamps, a short preview of text. Never log full message bodies or PII unless explicitly building an audit trail, and even then think twice.
- For dropped/skipped paths, the log should answer "why didn't this fire?" in one line.
- Background jobs and boot paths that matter for deploy verification should emit a clear completion marker the post-merge log check can grep for.

### Honesty when something is wrong

If you ship something and the verification fails, say so plainly. Don't soften it, don't pretend the logs prove success when the artifact says otherwise. Diagnose, fix, ship again. The user trusts that "looks right" actually means "I read the artifact and it's right."

### When the user gives you a choice

Pick the option with fewer moving parts unless there's a strong reason otherwise. Document the choice and reasoning in the PR. Prefer extending existing 0DTE scoring/backtest/calendar paths over new subsystems. Avoid invisible complexity (clever caching, hidden state machines, multi-step coordination) when boring sequential code does the same job.

### When the user disagrees

Engage on the merits. If they're right, change course and say what changed your mind. If you think they're wrong, push back once with specifics, then defer. They have context you don't.
