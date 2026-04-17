# empire-dashboard — PROJECT_STATUS

## Vision
A single glanceable page that tells Robert whether every app in the McMillan
AI empire is alive and being actively developed. Green = up and recently
touched. Yellow = up but idle. Red = down. Minimal, clean, fast — a v1
monitor that we can layer features onto (alerting, incident history,
per-user views) as the empire grows.

## Current state — 60% (just built, 2026-04-16)
- TypeScript + Express + Node 20 project scaffolded
- HealthChecker: parallel HTTP probes with TTL cache and timeout
- ActivityTracker: GitHub last-commit lookups via @octokit/rest with TTL cache
- combineStatus() produces green/yellow/red/gray per app
- Server-rendered HTML dashboard at `/`, JSON at `/api/status`, liveness at `/healthz`
- 57 tests passing, 97.74% statement coverage / 92.17% branch coverage
- Dockerfile + railway.toml ready for deploy
- GitHub Actions CI workflow

## Apps currently monitored (10)
McSecretary, kanban-purchaser, influencer-outreach, purchase-order-receiver,
content-engine, piece-work-scanner, permitready (chicago-building-code),
dearborn-ai-agents, DDA-CS-Manager, diamond-pickaxe-returns-processor.

## Iteration backlog
- Wire up real Railway URLs via `APPS_URL_OVERRIDES` env var
- Persist health-check history to SQLite so we can chart uptime over time
- Alert to Telegram/Slack when a service flips green -> red
- Per-app drilldown page with recent commits + incident history
- Auto-refresh the HTML page every 60s (or use SSE/polling on client)
- Latency sparkline on each card
- `last deploy` column from Railway API when available

## Robert's Feedback
_(none yet — newly built)_

## Build history
### 2026-04-16 — initial build
- Created TypeScript project with full TDD
- 6 test files, 57 tests, 97.74% statement coverage
- Built HealthChecker, ActivityTracker, status combiner, HTML renderer, Express app
- Dockerfile, railway.toml, CI workflow
- Verified server boots and all endpoints respond locally
