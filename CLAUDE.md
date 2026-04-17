# Empire Dashboard — Claude build notes

## What it is
Health monitor for the McMillan AI empire. One page, one grid, one color
per app (green/yellow/red/gray). Polls each app's `/health` and the GitHub
API for last-commit data.

## Tech
- Node 20, TypeScript, Express 4
- `@octokit/rest` for GitHub activity tracking
- Jest + ts-jest + supertest for tests
- Server-rendered HTML (escaped template strings in `src/render.ts`) + one CSS file in `src/public/styles.css`
- No database — everything is in-memory with TTL caches

## Layout
```
src/
  index.ts            # Entry: wires config, checkers, app, starts polling
  app.ts              # Express app + collectStatuses()
  config.ts           # RuntimeConfig loader + DEFAULT_APPS list
  healthChecker.ts    # HTTP health probes with TTL cache
  activityTracker.ts  # GitHub last-commit probes with TTL cache
  status.ts           # combineStatus() + formatHours()
  render.ts           # renderDashboard() HTML template
  public/styles.css   # dashboard CSS
tests/                # unit + integration (supertest) tests
Dockerfile            # multi-stage node:20-alpine build
railway.toml          # Railway deploy config
```

## Build / test / run
```bash
npm install
npm test          # runs all jest tests with coverage
npm run build     # tsc -> dist/
npm start         # node dist/index.js
npm run dev       # ts-node src/index.ts
```

## Key contracts
- `HealthChecker.check(app)` -> `HealthResult { state: 'up' | 'down' | 'unknown' }`
  Cached by app name for `HEALTH_CACHE_TTL` seconds. Pass `{ force: true }` to bypass.
- `ActivityTracker.track(app)` -> `ActivityResult` with `lastCommitAt`, `hoursSinceCommit`, etc. Cached for 10 min.
- `combineStatus(health, activity, repo)` -> `AppStatus` with `color`.
- `collectStatuses(deps)` -> `AppStatus[]` for rendering.

## Adding an app
Either:
1. Add to `DEFAULT_APPS` in `src/config.ts`, or
2. Provide an `APPS_CONFIG_PATH` pointing at a JSON array of `{ name, repo, url?, healthPath? }`.

Then optionally set `APPS_URL_OVERRIDES` to inject Railway URLs without editing code.

## Deploy
`railway.toml` sets a Dockerfile builder, `/healthz` healthcheck, and
`node dist/index.js` start command. Required env vars on Railway:

- `GITHUB_TOKEN` (strongly recommended — avoids 60/hr anon rate limit)
- `APPS_URL_OVERRIDES` — JSON map of app name to URL

Optional:
- `GITHUB_OWNER` (default `dearborndenim`)
- `HEALTH_CACHE_TTL`, `HEALTH_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `PORT`

## Test strategy
Every module has a unit test. `app.test.ts` uses supertest to hit all three
HTTP endpoints plus the error paths. Fakes/mocks are used for `fetch` and
Octokit so no tests hit the network. Coverage is enforced at 80% lines /
70% branches in `package.json`.
