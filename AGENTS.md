# AGENTS.md

## Cursor Cloud specific instructions

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

### Tests
- `npm test` runs standalone 0DTE regression tests (deterministic scoring/backtest/calendar logic) — no DB or vendor keys required. Other `server/test*.js` harnesses (e.g. `node --env-file=.env server/testZeroDTE.js`) hit live vendors and need keys.
