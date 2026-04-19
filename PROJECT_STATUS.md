# empire-dashboard — PROJECT_STATUS

## Vision
A single glanceable page that tells Robert whether every app in the McMillan
AI empire is alive and being actively developed. Green = up and recently
touched. Yellow = up but idle. Red = down. Minimal, clean, fast — a v1
monitor that we can layer features onto (alerting, incident history,
per-user views) as the empire grows.

## Current state — 74% (2026-04-18)
- Per-app incident log in SQLite (`incidents` table: start/end/duration/reason)
- `IncidentTracker` detects green->red / red->green transitions on each poll
- `GET /api/incidents?days=N&app=NAME` JSON endpoint (back-compat, additive)
- Weekly summary email (Mon 7 AM America/Chicago) — stdout stub transport today, SMTP-ready via `EmailSender` interface; env flag `EMAIL_DISABLED=1`
- "Recent Incidents" panel on the HTML dashboard (last 10 rows, open/closed)
- In-process `startWeeklyJob` scheduler (no node-cron dep), DST-aware via Intl.DateTimeFormat
- 175 tests passing, 97.77% statement / 90.63% branch / 98.66% line coverage

## Prior state — 68% (2026-04-17)
- TypeScript + Express + Node 20 project scaffolded
- HealthChecker: parallel HTTP probes with TTL cache and timeout
- ActivityTracker: GitHub last-commit lookups via @octokit/rest with TTL cache
- combineStatus() produces green/yellow/red/gray per app
- Server-rendered HTML dashboard at `/`, JSON at `/api/status`, liveness at `/healthz`
- 80-char commit-message truncation in the UI
- Per-app "logs" deep link to Railway (env-configurable, disabled when absent)
- SQLite-backed 7-day health history (`./data/history.db`, rolling retention)
- 7-day uptime % badge + 24-hour sparkline on each card (green >=99%, yellow >=80%, red otherwise, gray no data)
- `/api/status` now also returns `railway_logs_url`, `uptime_7d`, `sparkline_24h[]` (additive, back-compat)
- 104 tests passing, 97.61% statement coverage / 92.39% branch coverage
- Dockerfile + railway.toml ready for deploy
- GitHub Actions CI workflow

## Apps currently monitored (10)
McSecretary, kanban-purchaser, influencer-outreach, purchase-order-receiver,
content-engine, piece-work-scanner, permitready (chicago-building-code),
dearborn-ai-agents, DDA-CS-Manager, diamond-pickaxe-returns-processor.

## Iteration backlog
- Wire up real Railway URLs via `APPS_URL_OVERRIDES` env var (and `APPS_RAILWAY_LOGS_OVERRIDES` for the logs links)
- Real SMTP transport behind `EmailSender` (currently stubbed to stdout)
- Alert to Telegram/Slack on each incident transition (reuse `IncidentTracker`)
- Per-app drilldown page with recent commits + incident history
- Auto-refresh the HTML page every 60s (or use SSE/polling on client)
- Latency sparkline (response_ms) alongside the uptime sparkline
- `last deploy` column from Railway API when available
- Retention prune for `incidents` table (currently unbounded)

## Robert's Feedback
_(none yet — newly built)_

## Build history
### 2026-04-18 — polish v2 (incidents + weekly summary)
- Feature branch `feature/polish-v2-incidents`, merged to `main`
- `historyStore.ts`: new `incidents` table + `openIncident`/`closeIncident`/`getOpenIncident`/`listIncidents`
- `incidentTracker.ts`: stateful up/down transition detector; rehydrates from any open incident on restart; treats `unknown` state as a non-transition
- `email.ts`: `EmailSender` interface + `ConsoleEmailSender` stub (stdout). `selectEmailSender(env)` flags `EMAIL_DISABLED=1`
- `weeklyReport.ts`: `buildWeeklyReportData`, `renderWeeklyReportText`, `sendWeeklyReport`; rollup + top-3-downtime helpers
- `scheduler.ts`: `startWeeklyJob` / `msUntilNextWeeklyRun` / `partsInZone` — DST-aware without pulling node-cron
- `app.ts`: `/api/incidents` endpoint, incident tracker wiring in `collectStatuses`, recent incidents passed to `renderDashboard`
- `render.ts`: Recent Incidents panel + `formatIncidentDuration` helper + scoped CSS
- Tests added: `historyStore.incidents.test.ts`, `incidentTracker.test.ts`, `email.test.ts`, `weeklyReport.test.ts`, `scheduler.test.ts`, `app.incidents.test.ts`, render additions
- 71 new tests (104 -> 175), coverage 97.77%/90.63%/98.66%, all green

### 2026-04-17 — polish + expand
- Feature branch `feature/dashboard-polish-expand` merged to main
- New `truncateMessage()` helper — commit messages now cap at 80 chars with an ellipsis
- Added `railwayLogsUrl` per app + `APPS_RAILWAY_LOGS_OVERRIDES` env override; card renders a "logs" link (disabled when unset)
- SQLite history store (`better-sqlite3`): samples `app_name, checked_at, status, response_ms` on every poll; keeps 7 rolling days; prunes on each refresh
- `uptimePercent()` and `bucketLastNHours()` drive a 7d uptime badge and a 24-cell sparkline per card (>=99% green, >=80% yellow, else red, gray if no data)
- `/api/status` grew `railway_logs_url`, `uptime_7d`, `sparkline_24h[]` (additive — old consumers still work)
- 47 new tests (truncate, historyStore, sparkline, render + app shape); total 104, coverage 97.61% statements / 92.39% branches

### 2026-04-16 — initial build
- Created TypeScript project with full TDD
- 6 test files, 57 tests, 97.74% statement coverage
- Built HealthChecker, ActivityTracker, status combiner, HTML renderer, Express app
- Dockerfile, railway.toml, CI workflow
- Verified server boots and all endpoints respond locally
