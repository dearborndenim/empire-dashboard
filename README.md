# Empire Dashboard

Minimal health monitor for the McMillan AI Empire. Renders a grid of colored
squares — one per app — so you can see at a glance which services are up and
which have had recent development activity.

## Status logic

| Color | Meaning |
| ----- | ------- |
| Green | App `/health` is up AND last commit was within 24 hours |
| Yellow | App is up but last commit is older than 24 hours (or activity unknown) |
| Red | App `/health` is not responding or returned a non-2xx |
| Gray | No URL configured for this app yet |

## Endpoints

- `GET /` — server-rendered HTML dashboard
- `GET /api/status` — JSON array of statuses (accepts `?force=1` to bypass cache)
- `GET /healthz` — liveness probe

## Running locally

```bash
npm install
npm test          # 57 tests, ~98% statement coverage
npm run build
npm start
```

Open http://localhost:3000.

## Configuration

All config is via environment variables — see `.env.example`.

Key vars:

- `GITHUB_TOKEN` — improves GitHub rate limit for activity tracking
- `APPS_URL_OVERRIDES` — JSON map of `{ "AppName": "https://..." }`, e.g. to
  point at Railway public/internal domains
- `APPS_CONFIG_PATH` — path to a JSON file with a full apps list, overrides the
  built-in default list

Example:

```bash
APPS_URL_OVERRIDES='{"McSecretary":"https://mcsecretary.up.railway.app","kanban-purchaser":"https://kanban-purchaser.up.railway.app"}' \
GITHUB_TOKEN=ghp_xxx \
npm start
```

## Deployment

Railway Dockerfile deploy is wired up via `railway.toml`. From the repo root:

```bash
railway init
railway up
```

Set env vars in the Railway dashboard (GITHUB_TOKEN, APPS_URL_OVERRIDES, etc).
The service exposes `/healthz` for Railway's health probe.

## Design notes

- No React / no client JS — server-rendered HTML + one CSS file.
- Health checks and GitHub calls are cached; `/api/status?force=1` bypasses.
- A background poll (`POLL_INTERVAL_MS`, default 5 min) keeps caches warm so
  page loads are instant.
