# empire-dashboard — PROJECT_STATUS

## Vision
A single glanceable page that tells Robert whether every app in the McMillan
AI empire is alive and being actively developed. Green = up and recently
touched. Yellow = up but idle. Red = down. Minimal, clean, fast — a v1
monitor that we can layer features onto (alerting, incident history,
per-user views) as the empire grows.

## Current state — 91% (2026-04-25)
- Alert audit UI polish — pagination + homepage activity tile:
  * `/alerts/audit` + `/alerts/audit.csv` now paginate via `?offset=N`. The
    per-page cap dropped from 500 → **100** rows for nicer UX (constant
    `ALERT_AUDIT_PAGE_SIZE` exported from `app.ts`). Footer renders
    `Page X of Y, showing rows A-B of N` when totalMatched exceeds page
    size, the prior `N rows matched` line otherwise. Past-end offsets
    (e.g. `?offset=500` against 240 rows) render `No rows on this page
    (offset 500 of 240 total)` instead of an empty body.
  * `<nav class="alert-audit__pagination">` Prev/Next links beneath the
    table. Disabled (`aria-disabled="true"`) on the first/last page.
    Filters (`integration`, `decision`, `days`) preserved across both
    Prev/Next via a centralised `buildAlertAuditPageHref(filters, offset)`
    helper exported from `render.ts`. The `offset=0` page omits the offset
    param from the URL so page-1 links stay clean.
  * `historyStore.listAlertAudits` extended with `offset?: number` (clamped
    to ≥0, NaN/negative falls back to 0). `countAlertAudits` ignores both
    `limit` and `offset` so the "Page X of Y" math is exact.
  * `app.ts` `buildAlertAuditQueryFromReq` parses `?offset` via the same
    `clampInt` helper as `?days` (default 0, clamped [0, 1_000_000]).
  * Pagination nav is fully omitted (zero markup) when totalMatched ≤
    pageSize so quiet weeks render byte-identically pre-feature.
- Homepage "Recent alert activity (7d)" tile (5 PM-ish on the dashboard,
  rendered between integration tiles and top-root-causes widget):
  * Server-rendered list of top-5 integrations by audit volume in the last
    7 days. Each row is a click-through to
    `/alerts/audit?integration=<name>&days=7` for instant drill-down.
  * State logic: `ok` when no audits in the window OR all rows have
    `fire_count=0` (only suppressed/cooldown traffic); `warn` when **any**
    row carries `fire_count > 0` (a real fire decision occurred). State
    pill on the tile head + tile-level `--warn`/`--ok` modifier class on
    the section.
  * Per-row badge shows `N audits` (quiet) or `N audits · M fires` (red
    background) so the eye snaps to the hot integrations first.
  * New helper `historyStore.alertActivitySummary({ days, limit, nowMs })`
    runs a single GROUP BY over `alert_audit_log`. Limit clamped [1, 50],
    default 5; days defaults to 7. Reuses the same window math as the
    audit page.
  * New `renderRecentAlertActivityTile(rows)` exported from `render.ts`
    (XSS-safe via `escapeHtml`, top-5 cap enforced even if caller passes
    more rows). Empty state renders an italic "No alert activity in the
    last 7 days" with the ok pill so the tile is always present (no
    layout shift).
- HistoryStore interface gained one new method (`alertActivitySummary`); the
  4 in-memory mock stores in `app.test.ts` / `app.incidents.test.ts` /
  `app.incidentStats.test.ts` / `coverage.test.ts` were updated. No
  pre-existing test behavior changed.
- New CSS rulesets: `.alert-audit__pagination`, `.alert-audit__page`
  (+`--prev`/`--next`/`--disabled` modifiers), `.alert-audit__page-indicator`,
  `.recent-alert-activity` (+`--ok`/`--warn` modifiers),
  `.recent-alert-activity__head|title|state|list|item|link|badge|empty`.
- `tests/alertAuditPagination.test.ts` (NEW, 12 tests):
  * Pagination boundary cases: page 1 (offset=0), page 2 (offset=100),
    last page (partial rows), past-end (offset=500 against 240 rows).
  * Pagination omitted when totalMatched ≤ pageSize.
  * Negative + garbage offsets clamp to 0.
  * Filter persistence in Prev/Next hrefs (integration + decision + days).
  * `buildAlertAuditPageHref` deterministic shape including URL-escape of
    special chars in integration name.
  * Homepage tile: empty-state ok render, top-5 cap (6 integrations
    seeded → 6th omitted), warn-state when fires present, click-through
    URLs verified for all 5 rows.
  * State transition unit: ok ↔ warn flip on `fire_count > 0`; ok when
    rows undefined / empty / all-zeros; XSS escape guard on integration
    name.
  * `alertActivitySummary` direct unit: per-integration sort by total
    desc, fire_count derived from outcome, 7-day window cutoff,
    limit clamp.
- 416 → 428 tests passing (+12), 32 suites all green. Coverage holds at
  ~98% statements / 89% branches / 98% lines.

## Prior state — 90% (2026-04-24)
- Recovery banner click-through JSON endpoint:
  * `GET /api/incidents/recovered?days=N` — companion to the `/incidents`
    "Recovered integrations (24h)" banner. Lets external tooling (McSecretary,
    CLI scripts) query auto-resolved integrations without scraping HTML.
    Default `days=1`, clamped to `[1, 30]`. Optional `?app=<name>` filter.
    Response: `{generatedAt, windowDays, count, recovered: [{integration_name,
    opened_at, closed_at, mttr_seconds}]}` sorted by `closed_at` desc.
    `mttr_seconds` is the closed-minus-open delta in seconds (clamped at 0).
    Defense-in-depth filter drops rows without an `incident_end` (auto_resolved
    should imply closed but we don't trust it).
  * Auth: same `INCIDENTS_ADMIN_TOKEN` bearer/x-admin-token gate as
    `POST /api/incidents/:id/note`. 503 when token is unset, 401 on mismatch.
- Alert audit UI page:
  * `GET /alerts/audit` — server-rendered HTML browser for the `alert_audit_log`
    table (every fire/suppress/recovery/cooldown decision). Columns: timestamp,
    integration, decision pill, severity, success rate %, reason. Filters via
    query string: `?integration=<key>` (exact match), `?decision=<fire|suppress|
    recovery|cooldown>` (derived from outcome+reason+severity), `?days=N`
    (default 7, clamped to `[1, 30]`). Sort: newest first by `id`. Row cap: 500
    with a "Showing N of M matching rows" footer note when truncated. Empty
    state row when no audits match. Same `INCIDENTS_ADMIN_TOKEN` gate as the
    JSON endpoint above.
  * `GET /alerts/audit.csv` — same filters, downloads
    `alert-audit-{N}d-{YYYY-MM-DD}.csv` with a stable header `id,at,
    integration,decision,outcome,severity,success_rate,reason`. RFC-4180
    quote-wrap on commas/quotes/newlines.
  * Decision derivation (`deriveAlertDecision` exported from `historyStore.ts`):
    `recovery` = outcome=fired + severity=info; `fire` = outcome=fired (other
    severities); `cooldown` = outcome=suppressed + reason starts with
    "cooldown"; `suppress` = outcome=suppressed (other reasons). The decision
    filter is implemented in SQL (no post-filter) so `countAlertAudits`
    matches `listAlertAudits` exactly.
  * `historyStore.listAlertAudits` extended with `integration`/`days`/`nowMs`/
    `decision` filters; new `countAlertAudits(query)` method returns total
    matching rows for the truncation banner.
  * New CSS: `.alert-audit__filters`, `.alert-audit__table`,
    `.alert-audit__pill--{fire|suppress|cooldown|recovery}`,
    `.alert-audit__truncated`.
- Auth helpers refactored: new `requireAdminToken` (JSON 503/401) +
  `requireAdminTokenForHtml` (HTML 503/401) helpers in `app.ts`. POST
  `/api/incidents/:id/note` continues to use its inline token check (unchanged
  behavior).
- `tests/incidentTracker.test.ts`: pinned `nowMs` on two `listIncidents({days:
  7})` calls so the rolling 7-day window doesn't drift past 2026-04-18 fixture
  rows as wall-clock time advances. Pre-existing flake — green now.
- 416 tests passing (up from 404, +12), 31 suites all green. New file:
  `tests/recoveredAndAuditUI.test.ts` (12 tests). All pre-existing tests
  untouched behavior-wise.

## Prior state — 89% (2026-04-23)
- Alert throttling polish landed on `nightly-2026-04-23-alert-and-scenedrift`:
  * `GET /api/alerts/recent?limit=N` audit endpoint backed by new
    `alert_audit_log` SQLite table (default 50, clamped [1,500], 503 when
    historyStore unavailable). `IntegrationAlertMonitor` writes one
    `outcome="fired"` row on every actual alert/recovery delivery and one
    `outcome="suppressed"` row for both the per-day dedupe skip and the
    per-hour cooldown skip — so the audit feed is the single ground-truth
    timeline of every alert decision.
  * Cooldown is now configurable two ways: env `INTEGRATION_ALERT_COOLDOWN_SECONDS`
    (default 3600, plumbed through `RuntimeConfig.integrationAlertCooldownSeconds`
    → `IntegrationAlertMonitor.cooldownMs`), AND a per-key SQLite override on
    a new nullable `cooldown_seconds` column on `integration_alert_state`
    (idempotent ALTER TABLE migration). Override read via
    `getIntegrationCooldownOverride(name)`; write via
    `setIntegrationCooldownOverride(name, seconds)`. Override wins when
    >0; bad/zero/negative values fall back to the env default to avoid
    accidentally disabling cooldown.
  * `closeIncident` gained an optional `{ autoResolved }` flag and the
    incidents table gained an `auto_resolved INTEGER NOT NULL DEFAULT 0`
    column. `IntegrationAlertMonitor.maybeRecover` now passes
    `{ autoResolved: true }` when it closes a synthetic incident — so the
    /incidents page can render the "Recovered integrations (24h)" callout
    banner with a click-through to `?auto_resolved=true`. The
    `/api/incidents` endpoint now accepts `?auto_resolved=true|1` and
    returns `autoResolvedOnly` in the response payload.
  * `/incidents` page: new `recovered-banner` section above the toolbar.
    Shows count + "View recovered" CTA when count > 0; switches to a
    "Showing recovered only · Clear filter" affordance when the URL filter
    is active.
  * +14 new tests in `tests/alertThrottlingPolish.test.ts`: endpoint shape +
    default/clamped limits + 503 path, audit accounting (fired + suppressed
    rows from cooldown), per-key override precedence, env-default fallback,
    `INTEGRATION_ALERT_COOLDOWN_SECONDS` env loading (4 cases), audit-row
    truncation (500 chars), `setIntegrationCooldownOverride` insert/update/
    clear cycle, banner render path (3 variants), click-through filter +
    auto_resolved=1 marking via the monitor.
- Scene-drift tile v2 landed on the same branch:
  * Reads `flag_classification` per-scene from the
    Content-Engine `/api/integration/scene-drift` payload (chronic / spike /
    stable). Surfaces per-row classification pills (`tile__detail-badge--*`)
    and per-tile aggregate badge counts (`tile__badges` w/ chronic = red,
    spike = yellow, stable = green). The tile is promoted to `state=warn`
    whenever any scene is chronic, even when no scene clears the
    over-represented top-3 cutoff.
  * Aggregate counts come from the new exported helper
    `computeClassificationCounts(scenes)`. It returns `undefined` when no
    scene carries a recognized classification — that's the legacy fallback
    path so the v1 render is preserved when the upstream payload omits the
    field. Garbage classification strings are ignored (typed-string guard).
  * +7 new tests in `tests/sceneDriftTileV2.test.ts`: per-row pill mapping,
    HTML render assertions for chronic/spike/stable badges, 0-count badges
    omitted, stable-only payload stays `state=ok`, chronic alone promotes
    `state=warn`, legacy fallback path renders no badges + no crash, garbage
    classification strings ignored.
- 404 tests passing (up from 381, +23), 96.63% statement / 88.19% branch /
  97.53% line coverage. All pre-existing tests untouched behavior-wise.

## Prior state — 88% (2026-04-22)
- Incidents v6 UI landed on `incidents-v6-ui` (merged to main after
  rebasing onto the Phase 4 merge below):
  * `/incidents` page renders an inline `root_cause` editor per incident
    card — editable text input (120 char max) + save button that POSTs to
    the existing `/api/incidents/:id/note` endpoint with an `x-admin-token`
    pulled from sessionStorage (prompted once, cached per session). The
    read-only view shows an italic "(set root cause)" placeholder when
    unset.
  * Homepage (`/`) adds a "Top root causes (7d)" widget fed by
    `historyStore.topRootCauses({ days: 7, limit: 5 })` — top 5 rows with
    count badges. The section is entirely omitted when the list is empty
    (no clutter on quiet weeks). `/` route also now surfaces a
    `/incidents` footer link.
  * `/incidents` toolbar adds a CSV export button + 7/30/90-day date-range
    picker (default 30) that triggers a client-side download from the
    existing `/api/incidents/export?format=csv&days=N` endpoint via an
    anchor-click shim (no new backend endpoints).
  * XSS safety: all root_cause values escape through `escapeHtml` on both
    the readonly and editor paths.
  * New CSS tokens: `.incident__root-cause*`, `.top-root-causes*`,
    `.incidents-toolbar`, `.incidents-export*`.
  * +9 new tests in `tests/incidentsV6.test.ts`: editor pre-fill w/ current
    value, empty-state placeholder, XSS escaping, round-trip POST to note
    endpoint, top-root-causes rendering (5 rows + badges), widget omitted
    when empty, end-to-end fetch from the history store on `/`, CSV export
    toolbar options + client JS URL construction, `/api/incidents/export`
    respects the `days=30` default from the picker.
- Integration observability Phase 4 landed on `phase-4-integration-obs`:
  * Per-hour cooldown on top of the existing per-day dedupe. New
    `last_fired_at` column on `integration_alert_state` (PRAGMA-gated ALTER
    TABLE + back-fill from `alerted_at` for legacy rows). Cooldown default
    3600000 ms, configurable via `IntegrationAlertMonitorOptions.cooldownMs`.
    Per-day dedupe evaluated first (preserves legacy skip reason); cooldown
    kicks in across UTC-day boundaries so a re-fire at 00:15 after a 23:50
    fire is still blocked.
  * Same-day re-check now calls `touchIntegrationAlert` to slide the
    `last_fired_at` stamp forward so subsequent polls inside the hour keep
    the cooldown honest.
  * Recovery signal (>= `recoveryThreshold`, default 0.9): when the
    traffic-weighted 7d success rate climbs back above recovery threshold AND
    an open synthetic incident exists under `integration:<name>`, monitor
    posts a `severity: info` Teams/Console recovery message via the shared
    `AlertSender` and auto-closes the incident via `closeIncident`. Closing
    the incident guarantees exactly-once-per-transition semantics (subsequent
    polls find no open incident, recovery path no-ops). Recovery survives a
    sender throw — incident is still closed.
  * `IntegrationAlertResult` now carries a `recovered[]` array alongside
    `fired[]` + `skipped[]`.
  * New `HistoryStore` methods: `getMostRecentIntegrationAlert(name)` and
    `touchIntegrationAlert(name, date, firedAtIso)`. `recordIntegrationAlert`
    accepts an optional `last_fired_at` (defaults to `alerted_at`). Mock
    stores in all app/incidents/coverage tests updated.
  * +10 new tests in `tests/integrationAlertMonitor.phase4.test.ts`:
    cooldown-blocks-second-alert across day boundary, cooldown expires after
    >1h, last_fired_at persists across monitor restarts, same-day re-check
    slides the cooldown, recovery fires exactly once, recovery no-op when
    never degraded, recovery closes synthetic incident, recovery no-op in
    the threshold↔recovery gap, recovery closes incident even if sender
    throws, historyStore migration + touch round-trip.
- 381 tests passing (up from 371, +10), 96.83% statement / 88.18% branch /
  97.63% line coverage. All pre-existing tests untouched behavior-wise —
  the per-day dedupe skip reason `already alerted today` is preserved.

## Prior state — 85% (2026-04-21)
- Integration alerts + incidents v5 landed:
  * `AlertSender` interface with `TeamsAlertSender` (MessageCard schema, 5xx/
    network retryable signaling), `ConsoleAlertSender` fallback, `NullAlertSender`
    drop-all + `selectAlertSender` env selector (TEAMS_WEBHOOK_URL / ALERTS_DISABLED)
  * `IntegrationAlertMonitor` reads 7-day traffic-weighted success rate from
    `integration_stats_history` and fires when rate < 80%: posts Teams alert,
    logs synthetic incident under `integration:<name>`, dedupes via new
    `integration_alert_state` table (PK integration_name+date). Severity is
    `critical` when rate < 50% of threshold, else `warning`.
  * Daily 4 AM America/Chicago `integration-alert-check` job wired in index.ts
  * Scene-drift tile in `integrationTiles` — consumes content-engine
    `/api/integration/scene-drift`, severity-weights scenes by z_score +
    days_since_last_flag (recent repeat offender bonus, 14-day decay), top-3
    over-represented surfaced in tile details
- Incidents v5:
  * `GET /api/incidents/export?days=N&format=csv` — RFC-4180 CSV download
    (90-day default, clamped [1,365]); stable header includes rootCause,
    notesCount; attachment Content-Disposition
  * `root_cause` column added via ALTER TABLE; surfaced through IncidentRow,
    `setIncidentRootCause`, `topRootCauses`
  * `POST /api/incidents/:id/note` accepts optional `root_cause` (snake or
    camel, max 120 chars) alongside the note
  * `GET /api/incidents/stats` without `app` returns aggregate `perApp` +
    `topRootCauses` (breaking change — tests updated)
  * Weekly Monday 7 AM CT email now appends "Per-app MTBF / MTTR (7d)" and
    "Top root causes (7d)" sections via `buildWeeklyReportData`
- Prior-release features preserved: incident notes + admin-token POST, SMTP
  sender, longest-downtimes + fixes sections, PO Receiver / Kanban / Content
  Engine tiles, prune banner, 30-day closed-incident retention cron
- 362 tests passing (up from 323, +39), 97.13% statement / 87.7% branch /
  97.87% line coverage

## Prior state — 82% (2026-04-20)
- Incidents v4 ("stats + audit + fixes"):
  * `GET /api/incidents/stats?app=<name>&days=N` — MTBF (hours), MTTR (min),
    incident_count, total_downtime_minutes (days clamped [1,90])
  * `/incidents` page — per-app MTBF/MTTR cards + recent incidents list
  * `prune_runs` audit table (`ran_at`, `deleted_count`, `deleted_notes_count`);
    3 AM prune cron records a row each run
  * Home page renders a prune banner with the latest run age + counts
  * Weekly summary email now appends a "This week's fixes" section pulled
    from GitHub (latest commit per repo, 24h in-memory cache keyed by sha,
    graceful fallback if `GITHUB_TOKEN` missing)
- Historical integration sparklines:
  * `integration_stats_history` SQLite table (daily upsert by name+date)
  * Daily 3 AM America/Chicago snapshot cron pulls raw stats from each
    integration (po-receiver / kanban / content-engine) and persists
  * Inline sparkline rendered on each integration tile (7-day rolling window,
    color-coded green >=99% / yellow >=80% / red otherwise)
- Content Engine prompt-quality tile:
  * `fetchContentEngineTile` hits `/api/integration/prompt-quality-stats`
  * rejected_rate / avg_quality_score / top-3 scene distribution
  * state='warn' when rejected_rate > 0.2 or avg_quality_score < 0.6
  * Graceful "Not configured" when `CONTENT_ENGINE_URL`/`CONTENT_ENGINE_API_KEY`
    missing
- Prior-release features preserved: incident notes + admin-token gated POST,
  SMTP sender, longest-downtimes weekly section, PO Receiver + Kanban tiles,
  30-day closed-incident retention cron
- 323 tests passing, 97.8% statement / 90.18% branch / 98.44% line coverage

## Prior state — 78% (2026-04-19)
- Per-app incident log in SQLite (`incidents` table: start/end/duration/reason)
- `incident_notes` table + `POST /api/incidents/:id/note` admin-token gated
  endpoint (x-admin-token header or Bearer token); notes surfaced on API + UI
- Daily 3 AM America/Chicago incident prune (INCIDENTS_RETENTION_DAYS, default
  30); still-open incidents always retained; cascade-deletes incident notes
- `SmtpEmailSender` (nodemailer) + factory auto-selects SMTP when SMTP_HOST
  is set, else falls back to existing ConsoleEmailSender
- Weekly summary email now includes "Longest downtimes" section with top-3
  single-incident durations (open->close; unresolved truncated at cutoff),
  per-incident app/duration/start/end/reason/notes
- Integration observability tiles on the HTML dashboard:
  * PO Receiver Webhooks (success rate + dead-lettered count)
  * Kanban Inbound Webhooks (total_received + unmatched_count)
  * 60s in-memory cache, graceful "Not configured" + error fallbacks
- `IncidentTracker` detects green->red / red->green transitions on each poll
- `GET /api/incidents?days=N&app=NAME` JSON endpoint, now returns notes
- "Recent Incidents" panel on the HTML dashboard (last 10 rows + notes)
- In-process `startWeeklyJob` + `startDailyJob` scheduler (no node-cron dep),
  DST-aware via Intl.DateTimeFormat
- 230 tests passing, 96.18% statement / 87.36% branch / 97.07% line coverage

## Prior state — 74% (2026-04-18)
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
- Configure real SMTP creds on Railway (SMTP_HOST/PORT/USER/PASS/FROM)
- Wire PO_RECEIVER_URL + KANBAN_URL + CONTENT_ENGINE_URL + api keys on Railway so tiles light up
- Set GITHUB_TOKEN on Railway so the weekly "This week's fixes" section pulls real commits
- Configure TEAMS_WEBHOOK_URL on Railway to activate the Teams alert transport (falls back to stdout today)
- Render root_cause in the incidents HTML UI + an editor UI for setting/clearing the tag
- Extend IntegrationAlertMonitor to cover additional integrations as new tiles are added
- Alert to Telegram/Slack on each incident transition (reuse `IncidentTracker`)
- Per-app drilldown page with recent commits + incident history + notes editor
- Auto-refresh the HTML page every 60s (or use SSE/polling on client)
- Latency sparkline (response_ms) alongside the uptime sparkline
- `last deploy` column from Railway API when available
- Richer MTBF window when only 1 incident exists (currently null — we could
  fall back to "window / 1" as a floor, or extend to cross-window lookups)

## Robert's Feedback
_(none yet — newly built)_

## Build history
### 2026-04-24 — recovered JSON endpoint + alert audit UI
- Feature branch `nightly-2026-04-24`, merged to `main` via no-ff.
- `historyStore.ts`: extended `AlertAuditQuery` with `integration` / `days` /
  `nowMs` / `decision` filters; refactored `listAlertAudits` to share a SQL
  body builder (`buildAlertAuditQuery`) with the new `countAlertAudits(query)`
  helper (returns total matched rows for the audit page truncation banner);
  exported `deriveAlertDecision({outcome, reason, severity})` →
  `'fire'|'suppress'|'recovery'|'cooldown'` (recovery = fired+info;
  cooldown = suppressed + reason starts with "cooldown"). HistoryStore
  interface gained `countAlertAudits`; in-memory mock stores in
  `app.test.ts` / `app.incidents.test.ts` / `app.incidentStats.test.ts` /
  `coverage.test.ts` updated.
- `app.ts`: new `GET /api/incidents/recovered?days=N&app=<name>` JSON
  endpoint (default 1, clamped [1, 30], `INCIDENTS_ADMIN_TOKEN`-gated:
  503 unset / 401 wrong); response shape
  `{integration_name, opened_at, closed_at, mttr_seconds}` newest-first.
  New `GET /alerts/audit` HTML page + `GET /alerts/audit.csv` (same filters,
  same gate). New auth helpers `requireAdminToken` /
  `requireAdminTokenForHtml` / `readAdminToken`; new `clampInt` helper used
  by both routes; new `buildAlertAuditQueryFromReq` parser. New
  `serializeAlertAuditCsv` + `ALERT_AUDIT_CSV_HEADER` (stable column order:
  `id,at,integration,decision,outcome,severity,success_rate,reason`).
- `render.ts`: new `renderAlertAuditPage(opts)` (filter form w/ select
  options for decision + days, table w/ decision pills, truncation footer
  when `totalMatched > rows.length`, empty-state row otherwise). Re-uses
  `escapeHtml` + the existing `/styles.css` scaffold.
- `public/styles.css`: `.alert-audit__*` rulesets (filters strip, table,
  pill colors per decision, truncated footer, empty state).
- `tests/recoveredAndAuditUI.test.ts` (NEW, 12 tests):
  * Recovered endpoint: happy path (sort + mttr_seconds), empty result,
    days clamp 0→1 / 999→30 / default→1, auth (503 unset / 401 missing /
    401 wrong), `?app=` filter.
  * Audit page: full page render, integration + decision filter, empty
    state, days clamp 999→30 / 0→1, auth gate (503 / 401), CSV export
    (header + decision column + RFC-4180 escaping + auth-required).
  * Bonus unit test for `serializeAlertAuditCsv([])` empty-body behaviour.
- `tests/incidentTracker.test.ts`: pinned `nowMs` on the two pre-existing
  `listIncidents({days: 7})` calls that had drifted past their 2026-04-18
  fixture date as wall-clock time advanced. Resolves a sporadic test fail.
- Totals: 404 → 416 tests (+12), 31 suites green. No pre-existing test
  behaviors changed.

### 2026-04-23 — alert throttling polish + scene-drift tile v2
- Feature branch `nightly-2026-04-23-alert-and-scenedrift`, merged to `main`
- `historyStore.ts`: new `alert_audit_log` table (one row per attempted alert
  fire, fired/suppressed); new `recordAlertAudit` (truncates `reason` to 500
  chars) + `listAlertAudits({ limit })` (clamped [1,500]); idempotent ALTER
  TABLE adding nullable `cooldown_seconds` to `integration_alert_state` +
  `setIntegrationCooldownOverride(name, seconds|null)` /
  `getIntegrationCooldownOverride(name)`; idempotent ALTER TABLE adding
  `auto_resolved INTEGER NOT NULL DEFAULT 0` to `incidents`; `closeIncident`
  gained `{ autoResolved }` flag and now writes the column; `listIncidents`
  + `IncidentsQuery` got an `autoResolvedOnly` filter; `getOpenIncident` /
  `getIncidentById` SELECT lists extended.
- `integrationAlertMonitor.ts`: per-key cooldown override resolution
  (`resolveCooldownMs`) with bad-value fallback; audit-row writes for the
  fire path, the recovery path, the per-day-dedupe skip, and the cooldown
  skip via `safeRecordAudit`; recovery now closes the synthetic incident
  with `{ autoResolved: true }`.
- `config.ts`: new `RuntimeConfig.integrationAlertCooldownSeconds` (env
  `INTEGRATION_ALERT_COOLDOWN_SECONDS`, default 3600, with bad-value
  fallback). `index.ts` plumbs it as `cooldownMs` on the monitor.
- `app.ts`: new `GET /api/alerts/recent?limit=N` endpoint (default 50,
  clamped [1,500], 503 when no store); `/api/incidents` accepts
  `?auto_resolved=true|1` and returns `autoResolvedOnly` in the response;
  `/incidents` page route reads `?auto_resolved=...`, computes 24h
  recovered count for the banner, and passes both to `renderIncidentsPage`;
  `serializeIncidents` now emits `autoResolved: boolean`.
- `render.ts`: new `RenderIncidentsPageOptions.recoveredCount24h` +
  `autoResolvedFilterActive`; new `renderRecoveredBanner` (info-tone
  callout w/ pluralized noun + click-through CTA, or active-tone affordance
  when filter is on); `renderIntegrationTiles` extended with
  `renderClassificationBadges` (chronic/spike/stable pills above tile body)
  and per-detail `tile__detail-badge--*` pills.
- `integrationTiles.ts`: new `FlagClassification` + `FlagClassificationCounts`
  types; `IntegrationTile` extended with `classificationCounts` +
  per-detail `classification`; `parseDriftScene` reads `flag_classification`
  from upstream payload (chronic|spike|stable, ignores garbage); new
  exported helper `computeClassificationCounts` returns undefined when no
  scene carries a classification (legacy fallback); tile is promoted to
  warn when any scene is chronic.
- `public/styles.css`: new `.tile__badges`, `.tile__badge--chronic|spike|stable`,
  `.tile__detail-badge*`, `.recovered-banner*` rulesets.
- Tests: +23 (381 → 404). New files: `alertThrottlingPolish.test.ts` (16),
  `sceneDriftTileV2.test.ts` (7). Existing mock stores in `app.test.ts`,
  `app.incidents.test.ts`, `app.incidentStats.test.ts`, `coverage.test.ts`
  updated for the 4 new HistoryStore methods + the
  `integrationAlertCooldownSeconds` field on RuntimeConfig literals across
  7 test files. `serializeIncidents` round-trip test extended to assert the
  new `autoResolved: false` default. `incidentsV5.test.ts`
  `serializeIncidentsCsv` literal updated.
- Coverage: 96.63% stmt / 88.19% branch / 97.53% line (thresholds 80/70/80/80).

### 2026-04-22 — integration observability Phase 4 (hourly cooldown + recovery)
- Feature branch `phase-4-integration-obs`, merged to `main` via fast-forward
- `historyStore.ts`: added `last_fired_at` column on `integration_alert_state`
  via PRAGMA-gated ALTER TABLE + one-shot back-fill from `alerted_at`. New
  `getMostRecentIntegrationAlert(name)` and `touchIntegrationAlert(name,
  date, firedAtIso)` methods. `recordIntegrationAlert` gained an optional
  `last_fired_at` on the row shape (defaults to `alerted_at`). `HistoryStore`
  interface updated; in-memory mock stores across
  `app.test.ts` / `app.incidents.test.ts` / `app.incidentStats.test.ts` /
  `coverage.test.ts` all updated with the two new methods.
- `integrationAlertMonitor.ts`:
  * New options: `cooldownMs` (default 3600000), `recoveryThreshold`
    (default 0.9).
  * Per-day dedupe evaluated first (preserves existing skip reason). Then
    per-hour cooldown consulting `getMostRecentIntegrationAlert`. Cooldown
    blocks re-fires that cross the UTC-day boundary within the hour (which
    the per-day dedupe alone would let through).
  * Same-day re-check now calls `touchIntegrationAlert` to keep the
    `last_fired_at` stamp current, so the cooldown window slides forward
    as long as the integration remains degraded.
  * Recovery path: when rate >= `recoveryThreshold` AND an open synthetic
    `integration:<name>` incident exists, post an `info`-severity recovery
    message via `AlertSender` and call `closeIncident`. Closing the incident
    guarantees exactly-once-per-transition (next poll finds no open incident,
    recovery no-ops). Tolerates a throwing sender — incident still closes.
  * New `IntegrationAlertResult.recovered[]` array.
- Tests: +10 in `tests/integrationAlertMonitor.phase4.test.ts`.
  * Hourly cooldown: blocks-on-day-boundary, expires after >1h,
    persists across monitor restarts, same-day touch slides the stamp.
  * Recovery: fires once per transition, no-op when never degraded, closes
    incident, no-op in the threshold↔recovery gap, incident close survives
    sender throw.
  * HistoryStore migration: column add + back-fill, `touchIntegrationAlert`
    round-trip, no-op on unknown integration, null for never-alerted.
- Totals: 371 → 381 tests (+10), 96.83% stmt / 88.18% branch / 97.63% line
  coverage (thresholds 80/70/80/80 — comfortably passing).
- AlertSender contract (`AlertPayload`/`SendResult`) unchanged. No duplicated
  breaking changes.

### 2026-04-21 — integration alerts + incidents v5
- Feature branch `feat/integration-alerts-and-incidents-v5`, merged to `main`
- `alertSender.ts` (new): `AlertSender` interface, `AlertMessage`,
  `AlertSeverity`, `TeamsAlertSender` (MessageCard w/ severity colors, 5xx
  retryable signaling, error body preview), `ConsoleAlertSender` logging to
  console.log/warn/error by severity, `NullAlertSender` drop-all,
  `selectAlertSender(env)` (ALERTS_DISABLED / TEAMS_WEBHOOK_URL / fallback)
- `integrationAlertMonitor.ts` (new): traffic-weighted 7d success-rate monitor,
  per-day dedupe via `integration_alert_state`, synthetic-incident logger under
  `integration:<name>`, graceful on sender/store errors, severity escalation
- `historyStore.ts`: new `integration_alert_state` table + `recordIntegrationAlert`
  (insert-or-ignore), `hasIntegrationAlerted`. Added `root_cause` column via
  PRAGMA-gated ALTER TABLE, `setIncidentRootCause`, `topRootCauses`; select
  statements updated to surface root_cause
- `integrationTiles.ts`: new `fetchSceneDriftTile` + `computeDriftSeverity`
  (exported for tests); consumes `/api/integration/scene-drift`, renders top-3
  over-represented scenes with z-score + days_since_last_flag recency weighting
- `app.ts`: new `csvCell`, `INCIDENTS_CSV_HEADER`, `serializeIncidentsCsv`;
  new `GET /api/incidents/export?days=N&format=csv` (90d default, clamped
  [1,365], 400 on bad format, 503 w/o store); `/api/incidents/stats` without
  `app` param now returns aggregate `perApp` + `topRootCauses`; note endpoint
  accepts optional `root_cause` (max 120 chars) and persists via setIncidentRootCause
- `weeklyReport.ts`: new `WeeklyMtbfMttrRow` + `WeeklyRootCauseRow`; report
  data now carries `mtbfMttr` + `topRootCauses`; Monday 7 AM CT email renders
  "Per-app MTBF / MTTR (7d)" + "Top root causes (7d)" sections
- `index.ts`: wired `selectAlertSender` + `IntegrationAlertMonitor` into a new
  daily 4 AM CT `integration-alert-check` job (alongside the 3 AM snapshot +
  prune); shutdown stops the new job
- Tests: +39 (323 -> 362). New files: `alertSender.test.ts` (15),
  `integrationAlertMonitor.test.ts` (6), `sceneDriftTile.test.ts` (6),
  `incidentsV5.test.ts` (12). Existing mock stores + serialize/weeklyReport
  fixtures updated for new store methods + rootCause field.
- Coverage: 97.13% stmt / 87.7% branch / 97.87% line.

### 2026-04-20 — incidents v4 + historical sparklines + content-engine tile
- Feature branch `nightly-2026-04-20`, merged to `main`
- `historyStore.ts`: new `integration_stats_history` table (PRIMARY KEY
  name+date, upsert via ON CONFLICT DO UPDATE); `recordIntegrationStat` +
  `listIntegrationStats(name, days, nowMs?)`; new `prune_runs` audit table
  + `recordPruneRun` / `getLatestPruneRun`; new `computeIncidentStats`
  returning MTBF (avg gap hours), MTTR (avg closed duration min),
  incidentCount, totalDowntimeMin
- `integrationTiles.ts`: new `fetchContentEngineTile` hitting
  `/api/integration/prompt-quality-stats` (rejected_rate / avg_quality /
  scene_distribution top-3, state='warn' when rejected_rate > 0.2 or avg <
  0.6); new `fetchRawStats` + `fetchRawFor` helpers for the daily cron;
  optional `sparklineResolver` produces `IntegrationSparklinePoint[]` per
  tile; `CONTENT_ENGINE_URL` + `CONTENT_ENGINE_API_KEY` added to config
- `integrationStatsJob.ts` (new): `snapshotIntegrationStats` iterates raw
  stats, upserts daily rows, returns `{recorded, skipped}` + one-line log
- `githubFixes.ts` (new): `GithubFixesClient` with 24h in-memory cache
  keyed by sha, `fetchThisWeeksFixes`, `renderWeeksFixesSection` plain-text
  block, `octokitCommitFetcher` adapter; graceful fallback when fetcher
  throws (returns cached value if present, else null)
- `weeklyReport.ts`: `renderWeeklyReportText` appends fixes section;
  `SendWeeklyReportOptions` gains optional `fixes?: GithubFix[]`
- `render.ts`: new `renderTileSparkline`, `renderPruneBanner`,
  `formatMtbfHours`, `formatMttrMinutes`, `renderIncidentsPage`;
  `renderDashboard` gains `latestPruneRun` option and renders banner
- `app.ts`: `GET /api/incidents/stats?app=<name>&days=N` (503/400/500
  error paths); `GET /incidents` page route with per-app MTBF/MTTR cards;
  `/` now renders prune banner (graceful on error)
- `index.ts`: daily 3 AM integration-stats snapshot cron wired to
  `IntegrationTilesFetcher`; sparkline resolver reads from history store;
  daily prune cron calls `recordPruneRun`; weekly job pulls
  `fetchThisWeeksFixes` via GitHub when `GITHUB_TOKEN` set
- CSS: `.tile__spark` bars (green/yellow/red), `.prune-banner`,
  `.incident-stats__card`
- Tests: +93 (230 → 323). Coverage 97.8% stmt (up from 96.18%) / 90.18%
  branch / 98.44% line. New files: `historyStore.integrationStats.test.ts`
  (11), `integrationStatsJob.test.ts` (6), `githubFixes.test.ts` (14),
  `app.incidentStats.test.ts` (9), `coverage.test.ts` (~20 targeted
  branch/edge cases). Updated: mock stores in `app.test.ts` +
  `app.incidents.test.ts`; `integrationTiles.test.ts` updated for 3-tile
  default; render + weekly-report tests extended for new sections.

### 2026-04-19 — polish v3 (retention, SMTP, notes, integration tiles)
- Feature branch `feature/incident-polish-v3`
- `historyStore.ts`: `pruneIncidents(retentionDays)` (closed-only, cascade-deletes notes); `incident_notes` table + `addIncidentNote` / `getIncidentNotes` / `getIncidentById`; `listIncidents({ includeNotes })`
- `email.ts`: `SmtpEmailSender` (nodemailer-backed) + `selectEmailSender` picks SMTP when `SMTP_HOST` set
- `weeklyReport.ts`: `longestIncidents` (top-3 single durations, open truncated at cutoff, with notes) + "Longest downtimes" text section
- `scheduler.ts`: `startDailyJob` + `msUntilNextDailyRun` reusing `partsInZone` (DST-aware, no node-cron dep)
- `app.ts`: `POST /api/incidents/:id/note` with token gate (x-admin-token header OR `Authorization: Bearer`); returns 503 when store/token absent, 401 wrong token, 400 invalid body, 404 unknown id, 201 on success; notes surfaced in GET `/api/incidents` + HTML panel
- `integrationTiles.ts`: new `IntegrationTilesFetcher` (60s cache, graceful "Not configured", error tiles on HTTP/non-OK/thrown); PO receiver + Kanban inbound endpoints
- `render.ts`: "Integrations" section renders tiles; incidents panel renders inline notes; CSS added for tiles + notes
- `config.ts`: `INCIDENTS_RETENTION_DAYS` (default 30) + `INCIDENTS_ADMIN_TOKEN` env plumbed through `RuntimeConfig`
- `index.ts`: daily prune job wired to 3 AM America/Chicago; SMTP transport auto-selected; integration tiles fetcher wired; `incidentsAdminToken` passed to app
- Tests: +55 (175 → 230). Coverage 96.18% stmt / 87.36% branch / 97.07% line. New: pruneIncidents (4), incident notes (5), SMTP sender + selector (8), longest downtime narrative (4), integration tiles (11), note endpoint (9), daily scheduler (4), render integration tiles + notes (4), config env (3).

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
