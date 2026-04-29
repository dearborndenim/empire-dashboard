/**
 * SQLite-backed history of health checks. Retains samples for a rolling
 * window (default 7 days) so we can compute uptime %, 24h sparklines, and
 * whatever else dashboard features need over time.
 *
 * The store is intentionally tiny: one table, three read helpers, and a
 * retention prune. Writes and reads are synchronous (better-sqlite3) which
 * keeps the dashboard code straightforward.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export type SampleStatus = 'up' | 'down' | 'unknown';

export interface HistorySample {
  app_name: string;
  checked_at: string;
  status: SampleStatus;
  response_ms?: number | null;
}

export interface HourBucket {
  /** ISO timestamp at the start of the hour (UTC) */
  hour: string;
  total: number;
  up: number;
}

/**
 * Persisted incident row. `incident_end` is NULL while the incident is still
 * open (i.e. the app is still red). `duration_min` is populated when the
 * incident closes.
 */
export interface IncidentRow {
  id: number;
  app_name: string;
  incident_start: string;
  incident_end: string | null;
  duration_min: number | null;
  reason: string | null;
  /** Optional operator-tagged root cause. Added in incidents v5. */
  root_cause?: string | null;
  /**
   * Alert throttling polish (2026-04-23): 1 when this incident was closed by
   * the IntegrationAlertMonitor recovery path, 0 otherwise. Surfaced through
   * the /incidents page as the "Recovered integrations (24h)" callout.
   */
  auto_resolved?: number | null;
  notes?: IncidentNote[];
}

/**
 * Single manual note appended by an operator (Robert) on an incident row.
 * Stored in a separate `incident_notes` table keyed by `incident_id`.
 */
export interface IncidentNote {
  id: number;
  incident_id: number;
  at: string;
  note: string;
}

export interface IncidentsQuery {
  days?: number;
  app?: string;
  limit?: number;
  nowMs?: number;
  /** When true, include notes joined onto each incident row. */
  includeNotes?: boolean;
  /**
   * When true, only return incidents whose `auto_resolved` flag is 1 (closed
   * via the IntegrationAlertMonitor recovery path). Used by the
   * /incidents?auto_resolved=true filter on the recovered-integrations
   * banner.
   */
  autoResolvedOnly?: boolean;
}

/**
 * Daily snapshot of an integration's success rate (PO receiver webhooks,
 * Kanban inbound, Content Engine prompt quality, etc.). One row per
 * integration per day; newer snapshots for the same day overwrite the row
 * so the cron can run multiple times safely.
 */
export interface IntegrationStatRow {
  integration_name: string;
  /** YYYY-MM-DD (UTC by convention) */
  date: string;
  /** 0..1 fraction. */
  success_rate: number;
  total_attempts: number;
  snapshot_at: string;
}

/** Audit trail for retention prune jobs. */
export interface PruneRunRow {
  id: number;
  ran_at: string;
  deleted_count: number;
  deleted_notes_count: number;
}

/**
 * Per-integration per-day alert dedupe row. When the success-rate monitor
 * fires for integration X on date D, we persist a row so the same alert
 * doesn't re-fire on subsequent polls within the same day (mirrors the PO
 * receiver dead-letter spike dedupe pattern).
 */
export interface IntegrationAlertStateRow {
  integration_name: string;
  /** YYYY-MM-DD */
  date: string;
  /** The success rate (0..1) that triggered the alert. */
  success_rate: number;
  alerted_at: string;
  /**
   * Phase 4 integration observability: exact ISO timestamp of the most recent
   * alert fire. Used for the per-hour cooldown check (independent of the
   * per-day dedupe). When omitted, `recordIntegrationAlert` falls back to
   * `alerted_at`.
   */
  last_fired_at?: string | null;
  /**
   * Alert throttling polish (2026-04-23): per-key cooldown override in
   * seconds. When non-null this overrides the env-driven default for the
   * integration. Read via `getIntegrationCooldownOverride`.
   */
  cooldown_seconds?: number | null;
}

/**
 * Alert throttling polish (2026-04-23): one row per attempted alert fire
 * (whether it actually delivered or was suppressed). Surfaced via
 * GET /api/alerts/recent for audit + debugging.
 */
export interface AlertAuditRow {
  id: number;
  /** ISO timestamp the attempt was logged. */
  at: string;
  /** Integration / alert key (e.g. "kanban", "po-receiver"). */
  integration_name: string;
  /** "fired" | "suppressed" — whether the alert was actually sent. */
  outcome: 'fired' | 'suppressed';
  /**
   * Free-form reason. For "suppressed" rows it's the dedupe/cooldown reason
   * (e.g. "cooldown (fires again in ~12m)"). For "fired" rows it's the alert
   * title or summary. Capped at 500 chars at the call-site.
   */
  reason: string;
  /** Severity at time of fire/suppression (info|warning|critical|unknown). */
  severity: string | null;
  /** Optional 0..1 success rate at the moment the audit row was written. */
  success_rate: number | null;
  /**
   * Alert audit polish 2 (2026-04-26): who triggered the audit row. Defaults to
   * "monitor" for rows written by `IntegrationAlertMonitor`. May be null on
   * legacy rows pre-migration. Free-form short string (capped at 64 chars).
   */
  actor?: string | null;
}

export interface AlertAuditQuery {
  /** Default 50, max 500 (caller enforces clamp). */
  limit?: number;
  /**
   * Alert audit UI (2026-04-24): filter to a single integration_name. Exact
   * match. Undefined / empty string returns all integrations.
   */
  integration?: string;
  /**
   * Alert audit UI (2026-04-24): only return rows whose `at` is within the
   * last N days. Undefined returns all rows in the table.
   */
  days?: number;
  /**
   * Alert audit UI (2026-04-24): clock injector for tests so the days filter
   * is deterministic. Defaults to `Date.now()`.
   */
  nowMs?: number;
  /**
   * Alert audit UI (2026-04-24): filter to a single derived decision. The
   * underlying audit rows only carry `outcome` ("fired" | "suppressed"), but
   * the UI surfaces four buckets:
   *   - "fire"     — outcome=fired AND severity!=info
   *   - "suppress" — outcome=suppressed AND reason does NOT start with "cooldown"
   *   - "recovery" — outcome=fired AND severity=info
   *   - "cooldown" — outcome=suppressed AND reason starts with "cooldown"
   * Undefined returns all decisions.
   */
  decision?: 'fire' | 'suppress' | 'recovery' | 'cooldown';
  /**
   * Alert audit pagination (2026-04-25): skip the first N matched rows. Used
   * by the /alerts/audit page to paginate past the per-page cap. Defaults to
   * 0 (first page). Caller is expected to clamp to >= 0.
   */
  offset?: number;
  /**
   * Alert audit polish 2 (2026-04-26): exact-match filter on the `actor`
   * column. Empty string / undefined returns all actors (including legacy
   * NULL rows). When set, NULL/empty rows are excluded.
   */
  actor?: string;
}

/**
 * Alert audit pagination (2026-04-25): one row per integration with rolling
 * audit-volume + decision counts in a window. Powers the "Recent alert
 * activity (Nd)" homepage tile.
 */
export interface AlertActivitySummaryRow {
  integration_name: string;
  total: number;
  fire_count: number;
}

/**
 * Alert audit polish 3 (2026-04-27): saved /alerts/audit filter view. Stored
 * server-side so common filter combos (e.g. "kanban fires last 7d") can be
 * one-click recalled from the audit page sidebar. The `query_string` is the
 * raw URL-encoded query (without leading `?`) — the page just appends it to
 * `/alerts/audit?` for the click-through.
 */
export interface AlertAuditSavedViewRow {
  id: number;
  /** Unique short label, capped at 64 chars at the call site. */
  name: string;
  /** Raw URL query string (no leading `?`), capped at 1024 chars. */
  query_string: string;
  /** ISO timestamp the view was created. */
  created_at: string;
}

/**
 * Alert audit UI (2026-04-24): derived decision bucket surfaced on the
 * /alerts/audit UI. See `AlertAuditQuery.decision` for the rules.
 */
export type AlertAuditDecision = 'fire' | 'suppress' | 'recovery' | 'cooldown';

export function deriveAlertDecision(row: {
  outcome: string;
  reason: string | null;
  severity: string | null;
}): AlertAuditDecision {
  const reason = (row.reason ?? '').toLowerCase();
  if (row.outcome === 'fired') {
    if (row.severity === 'info') return 'recovery';
    return 'fire';
  }
  if (reason.startsWith('cooldown')) return 'cooldown';
  return 'suppress';
}

export interface IncidentStatsQuery {
  app: string;
  days?: number;
  nowMs?: number;
}

export interface IncidentStats {
  incidentCount: number;
  totalDowntimeMin: number;
  /** Mean time between failures in hours. Null when <2 incidents in window. */
  mtbfHours: number | null;
  /** Mean time to recovery in minutes. Null when no closed incidents. */
  mttrMinutes: number | null;
}

export interface HistoryStoreOptions {
  filePath: string;
  retentionDays?: number;
  now?: () => number;
}

/**
 * Compact interface so callers / tests can swap in an in-memory fake.
 */
export interface HistoryStore {
  insert(sample: HistorySample): void;
  insertMany(samples: HistorySample[]): void;
  uptimePercent(appName: string, windowHours: number, nowMs?: number): number | null;
  bucketLastNHours(appName: string, hours: number, nowMs?: number): HourBucket[];
  pruneOlderThan(days: number, nowMs?: number): number;
  pruneIncidents(retentionDays: number, nowMs?: number): number;
  openIncident(appName: string, startedAtIso: string, reason: string | null): number;
  /**
   * Close the most recently opened incident for `appName`. The optional
   * `opts.autoResolved` flag (default false) marks the row as machine-closed
   * (used by IntegrationAlertMonitor recovery).
   */
  closeIncident(
    appName: string,
    endedAtIso: string,
    opts?: { autoResolved?: boolean },
  ): IncidentRow | null;
  getOpenIncident(appName: string): IncidentRow | null;
  listIncidents(query?: IncidentsQuery): IncidentRow[];
  getIncidentById(id: number): IncidentRow | null;
  addIncidentNote(incidentId: number, note: string, atIso?: string): IncidentNote | null;
  getIncidentNotes(incidentId: number): IncidentNote[];
  recordIntegrationStat(row: IntegrationStatRow): void;
  listIntegrationStats(integrationName: string, days: number, nowMs?: number): IntegrationStatRow[];
  recordPruneRun(row: Omit<PruneRunRow, 'id'>): number;
  getLatestPruneRun(): PruneRunRow | null;
  computeIncidentStats(query: IncidentStatsQuery): IncidentStats;
  /** Insert an integration-alert dedupe row. Ignores conflicts (idempotent). */
  recordIntegrationAlert(row: IntegrationAlertStateRow): boolean;
  /** True when an integration has already alerted on `date` (YYYY-MM-DD). */
  hasIntegrationAlerted(integrationName: string, date: string): boolean;
  /**
   * Return the most recent `last_fired_at` ISO timestamp across all rows for
   * `integrationName`, or null if we have never alerted. Used for the Phase 4
   * per-hour cooldown, independent of the per-day dedupe.
   */
  getMostRecentIntegrationAlert(integrationName: string): string | null;
  /**
   * Overwrite `last_fired_at` on an existing (integration, date) row without
   * breaking the PK-level dedupe. Returns true when a row was updated, false
   * when no row existed yet.
   */
  touchIntegrationAlert(
    integrationName: string,
    date: string,
    firedAtIso: string,
  ): boolean;
  /** Aggregate counts of incidents grouped by root_cause in a window. */
  topRootCauses(query: { days?: number; nowMs?: number; limit?: number }): Array<{
    root_cause: string;
    count: number;
  }>;
  /** Set/overwrite the root_cause column on an incident row. */
  setIncidentRootCause(incidentId: number, rootCause: string | null): boolean;
  /**
   * Alert throttling polish (2026-04-23): set a per-integration cooldown
   * override (seconds). Pass `seconds=null` to clear. Idempotent — inserts
   * a stub row for today's date if none exists yet.
   */
  setIntegrationCooldownOverride(
    integrationName: string,
    seconds: number | null,
  ): void;
  /**
   * Read the current per-integration cooldown override (seconds) or null when
   * unset / no row. Reads the most-recent row by alerted_at; the override is
   * not date-specific (we only need to find a non-null value for the
   * integration).
   */
  getIntegrationCooldownOverride(integrationName: string): number | null;
  /**
   * Append an alert audit row. Returns the new row id. The reason field is
   * truncated to 500 chars; everything else is stored verbatim.
   */
  recordAlertAudit(row: Omit<AlertAuditRow, 'id'>): number;
  /**
   * Most-recent N alert audit rows ordered by id DESC (newest first). The
   * caller is expected to clamp `limit` to [1, 500].
   */
  listAlertAudits(query?: AlertAuditQuery): AlertAuditRow[];
  /**
   * Alert audit UI (2026-04-24): count rows matching `query` (excluding
   * `limit` and `offset`). Used by the /alerts/audit page to render the
   * total-rows footer + pagination "Page X of Y" math.
   */
  countAlertAudits(query?: AlertAuditQuery): number;
  /**
   * Alert audit pagination (2026-04-25): per-integration summary of audit
   * volume in the last N days, sorted by total desc. `limit` clamped [1, 50]
   * (default 5). Powers the homepage "Recent alert activity" tile.
   */
  alertActivitySummary(query?: {
    days?: number;
    limit?: number;
    nowMs?: number;
  }): AlertActivitySummaryRow[];
  /**
   * Alert audit polish 3 (2026-04-27): create a saved view. Returns the
   * persisted row. Throws when the name already exists (unique constraint),
   * so callers can map that to a 409.
   */
  createAlertAuditSavedView(name: string, queryString: string): AlertAuditSavedViewRow;
  /** List all saved views, newest first by id. */
  listAlertAuditSavedViews(): AlertAuditSavedViewRow[];
  /**
   * Delete a saved view by id. Returns true if a row was deleted, false when
   * the id wasn't found.
   */
  deleteAlertAuditSavedView(id: number): boolean;
  /**
   * Alert audit polish 4 (2026-04-28): rename a saved view in-place. Returns
   * the updated row, or null when no row with that id exists. Throws when the
   * new name collides with an existing view (callers map to 409).
   */
  renameAlertAuditSavedView(id: number, newName: string): AlertAuditSavedViewRow | null;
  close(): void;
}

/**
 * Ensure the parent directory of `filePath` exists. If `filePath` is the
 * literal ":memory:" sentinel, no directory is created.
 */
export function ensureParentDir(filePath: string): void {
  if (!filePath || filePath === ':memory:') return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class SqliteHistoryStore implements HistoryStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(opts: HistoryStoreOptions) {
    ensureParentDir(opts.filePath);
    this.db = new Database(opts.filePath);
    this.db.pragma('journal_mode = WAL');
    this.now = opts.now ?? (() => Date.now());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        status TEXT NOT NULL,
        response_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_health_history_app_time
        ON health_history(app_name, checked_at);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL,
        incident_start TEXT NOT NULL,
        incident_end TEXT,
        duration_min REAL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_app
        ON incidents(app_name, incident_start);
      CREATE INDEX IF NOT EXISTS idx_incidents_open
        ON incidents(app_name, incident_end);
      CREATE TABLE IF NOT EXISTS incident_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL,
        at TEXT NOT NULL,
        note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incident_notes_incident
        ON incident_notes(incident_id, at);
      CREATE TABLE IF NOT EXISTS integration_stats_history (
        integration_name TEXT NOT NULL,
        date TEXT NOT NULL,
        success_rate REAL NOT NULL,
        total_attempts INTEGER NOT NULL,
        snapshot_at TEXT NOT NULL,
        PRIMARY KEY (integration_name, date)
      );
      CREATE INDEX IF NOT EXISTS idx_integration_stats_name_date
        ON integration_stats_history(integration_name, date);
      CREATE TABLE IF NOT EXISTS prune_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ran_at TEXT NOT NULL,
        deleted_count INTEGER NOT NULL,
        deleted_notes_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prune_runs_ran_at
        ON prune_runs(ran_at);
      CREATE TABLE IF NOT EXISTS integration_alert_state (
        integration_name TEXT NOT NULL,
        date TEXT NOT NULL,
        success_rate REAL NOT NULL,
        alerted_at TEXT NOT NULL,
        PRIMARY KEY (integration_name, date)
      );
      CREATE TABLE IF NOT EXISTS alert_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        integration_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        severity TEXT,
        success_rate REAL
      );
      CREATE INDEX IF NOT EXISTS idx_alert_audit_log_at
        ON alert_audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_alert_audit_log_int
        ON alert_audit_log(integration_name, at);
      CREATE TABLE IF NOT EXISTS alert_audit_saved_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        query_string TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alert_audit_saved_views_created
        ON alert_audit_saved_views(created_at);
    `);

    // Incidents v5: add root_cause column if missing. sqlite lets us check
    // via PRAGMA table_info.
    const incidentColumns = this.db
      .prepare("PRAGMA table_info('incidents')")
      .all() as Array<{ name: string }>;
    if (!incidentColumns.some((c) => c.name === 'root_cause')) {
      this.db.exec('ALTER TABLE incidents ADD COLUMN root_cause TEXT');
    }

    // Phase 4 integration observability: add `last_fired_at` column to
    // `integration_alert_state` for the per-hour cooldown check. Back-fill
    // legacy rows from `alerted_at` so the cooldown respects prior fires.
    const alertStateColumns = this.db
      .prepare("PRAGMA table_info('integration_alert_state')")
      .all() as Array<{ name: string }>;
    if (!alertStateColumns.some((c) => c.name === 'last_fired_at')) {
      this.db.exec('ALTER TABLE integration_alert_state ADD COLUMN last_fired_at TEXT');
      this.db.exec(
        'UPDATE integration_alert_state SET last_fired_at = alerted_at WHERE last_fired_at IS NULL',
      );
    }
    // Alert throttling polish (2026-04-23): per-key cooldown override
    // (seconds). Nullable — falls back to env-driven default when absent.
    if (!alertStateColumns.some((c) => c.name === 'cooldown_seconds')) {
      this.db.exec(
        'ALTER TABLE integration_alert_state ADD COLUMN cooldown_seconds INTEGER',
      );
    }
    // Alert throttling polish (2026-04-23): mark incidents that were closed
    // by the IntegrationAlertMonitor recovery path so the /incidents UI can
    // render a "Recovered integrations (24h)" callout.
    if (!incidentColumns.some((c) => c.name === 'auto_resolved')) {
      this.db.exec(
        'ALTER TABLE incidents ADD COLUMN auto_resolved INTEGER NOT NULL DEFAULT 0',
      );
    }

    // Alert audit polish 2 (2026-04-26): track who triggered each audit row.
    // Idempotent ALTER TABLE (PRAGMA-gated). Legacy rows stay NULL — the UI
    // filter excludes them when an explicit actor filter is applied.
    const auditColumns = this.db
      .prepare("PRAGMA table_info('alert_audit_log')")
      .all() as Array<{ name: string }>;
    if (!auditColumns.some((c) => c.name === 'actor')) {
      this.db.exec('ALTER TABLE alert_audit_log ADD COLUMN actor TEXT');
      // Best-effort back-fill: every pre-existing row was written by
      // IntegrationAlertMonitor (the only writer in the codebase), so tag them
      // with "monitor" so the actor filter immediately yields useful results.
      this.db.exec(
        "UPDATE alert_audit_log SET actor = 'monitor' WHERE actor IS NULL",
      );
    }
  }

  insert(sample: HistorySample): void {
    this.db
      .prepare(
        'INSERT INTO health_history (app_name, checked_at, status, response_ms) VALUES (?, ?, ?, ?)',
      )
      .run(sample.app_name, sample.checked_at, sample.status, sample.response_ms ?? null);
  }

  insertMany(samples: HistorySample[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO health_history (app_name, checked_at, status, response_ms) VALUES (?, ?, ?, ?)',
    );
    const run = this.db.transaction((rows: HistorySample[]) => {
      for (const r of rows) {
        stmt.run(r.app_name, r.checked_at, r.status, r.response_ms ?? null);
      }
    });
    run(samples);
  }

  /**
   * Compute uptime % over the last `windowHours`. Returns null if no samples
   * exist in the window. "up" samples count toward the numerator;
   * "down" + "unknown" both count toward the denominator.
   */
  uptimePercent(appName: string, windowHours: number, nowMs?: number): number | null {
    const since = new Date((nowMs ?? this.now()) - windowHours * 3600 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS ups
         FROM health_history
         WHERE app_name = ? AND checked_at >= ?`,
      )
      .get(appName, since) as { total: number; ups: number | null };
    if (!row || row.total === 0) return null;
    const ups = row.ups ?? 0;
    return (ups / row.total) * 100;
  }

  /**
   * Bucket the last `hours` into hour-wide buckets and return them in
   * chronological order (oldest first). Each bucket reports total samples +
   * number of "up" samples so callers can render colors however they want.
   */
  bucketLastNHours(appName: string, hours: number, nowMs?: number): HourBucket[] {
    const end = nowMs ?? this.now();
    const endHour = Math.floor(end / 3600_000) * 3600_000;
    const startHour = endHour - (hours - 1) * 3600_000;
    const since = new Date(startHour).toISOString();

    const rows = this.db
      .prepare(
        `SELECT checked_at, status FROM health_history
         WHERE app_name = ? AND checked_at >= ?
         ORDER BY checked_at ASC`,
      )
      .all(appName, since) as Array<{ checked_at: string; status: SampleStatus }>;

    const buckets: HourBucket[] = [];
    for (let i = 0; i < hours; i++) {
      const bucketStart = startHour + i * 3600_000;
      buckets.push({ hour: new Date(bucketStart).toISOString(), total: 0, up: 0 });
    }
    for (const r of rows) {
      const ts = Date.parse(r.checked_at);
      if (Number.isNaN(ts)) continue;
      const idx = Math.floor((ts - startHour) / 3600_000);
      if (idx < 0 || idx >= hours) continue;
      buckets[idx].total += 1;
      if (r.status === 'up') buckets[idx].up += 1;
    }
    return buckets;
  }

  pruneOlderThan(days: number, nowMs?: number): number {
    const cutoff = new Date((nowMs ?? this.now()) - days * 86400_000).toISOString();
    const result = this.db
      .prepare('DELETE FROM health_history WHERE checked_at < ?')
      .run(cutoff);
    return result.changes;
  }

  /**
   * Prune closed incidents older than `retentionDays`. Still-open incidents
   * (`incident_end IS NULL`) are always retained so an active outage is never
   * silently deleted. Associated notes are cascade-deleted along with the
   * incident row. Returns the number of incidents removed.
   */
  pruneIncidents(retentionDays: number, nowMs?: number): number {
    const cutoff = new Date(
      (nowMs ?? this.now()) - retentionDays * 86400_000,
    ).toISOString();
    const run = this.db.transaction(() => {
      // Find incidents eligible for prune (closed and ended before cutoff).
      const eligible = this.db
        .prepare(
          'SELECT id FROM incidents WHERE incident_end IS NOT NULL AND incident_end < ?',
        )
        .all(cutoff) as Array<{ id: number }>;
      if (eligible.length === 0) return 0;
      const ids = eligible.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM incident_notes WHERE incident_id IN (${placeholders})`)
        .run(...ids);
      const res = this.db
        .prepare(`DELETE FROM incidents WHERE id IN (${placeholders})`)
        .run(...ids);
      return res.changes;
    });
    return run();
  }

  /**
   * Start a new open incident row for `appName`. Returns the new row id.
   * Callers are expected to only invoke this after `getOpenIncident` returns
   * null — we don't enforce the invariant in SQL so it stays cheap.
   */
  openIncident(appName: string, startedAtIso: string, reason: string | null): number {
    const result = this.db
      .prepare(
        'INSERT INTO incidents (app_name, incident_start, incident_end, duration_min, reason) VALUES (?, ?, NULL, NULL, ?)',
      )
      .run(appName, startedAtIso, reason);
    return Number(result.lastInsertRowid);
  }

  /**
   * Close the most recently opened incident for `appName` that is still open
   * (incident_end IS NULL). Populates `incident_end` + `duration_min`.
   * Returns the updated row, or null if no open incident existed.
   *
   * `opts.autoResolved=true` flips the row's `auto_resolved` flag to 1 so the
   * /incidents page can render the "Recovered integrations (24h)" callout.
   */
  closeIncident(
    appName: string,
    endedAtIso: string,
    opts: { autoResolved?: boolean } = {},
  ): IncidentRow | null {
    const open = this.getOpenIncident(appName);
    if (!open) return null;
    const startMs = Date.parse(open.incident_start);
    const endMs = Date.parse(endedAtIso);
    const durationMin = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, (endMs - startMs) / 60000)
      : null;
    const autoResolved = opts.autoResolved ? 1 : 0;
    this.db
      .prepare(
        'UPDATE incidents SET incident_end = ?, duration_min = ?, auto_resolved = ? WHERE id = ?',
      )
      .run(endedAtIso, durationMin, autoResolved, open.id);
    return {
      ...open,
      incident_end: endedAtIso,
      duration_min: durationMin,
      auto_resolved: autoResolved,
    };
  }

  getOpenIncident(appName: string): IncidentRow | null {
    const row = this.db
      .prepare(
        'SELECT id, app_name, incident_start, incident_end, duration_min, reason, root_cause, auto_resolved FROM incidents WHERE app_name = ? AND incident_end IS NULL ORDER BY incident_start DESC LIMIT 1',
      )
      .get(appName) as IncidentRow | undefined;
    return row ?? null;
  }

  listIncidents(query: IncidentsQuery = {}): IncidentRow[] {
    const days = query.days ?? 7;
    const limit = query.limit ?? 100;
    const since = new Date((query.nowMs ?? this.now()) - days * 86400_000).toISOString();
    const params: unknown[] = [];
    let sql =
      'SELECT id, app_name, incident_start, incident_end, duration_min, reason, root_cause, auto_resolved FROM incidents WHERE incident_start >= ?';
    params.push(since);
    if (query.app) {
      sql += ' AND app_name = ?';
      params.push(query.app);
    }
    if (query.autoResolvedOnly) {
      sql += ' AND auto_resolved = 1';
    }
    sql += ' ORDER BY incident_start DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as IncidentRow[];
    if (query.includeNotes) {
      for (const row of rows) {
        row.notes = this.getIncidentNotes(row.id);
      }
    }
    return rows;
  }

  /** Fetch a single incident row by id, or null if it doesn't exist. */
  getIncidentById(id: number): IncidentRow | null {
    const row = this.db
      .prepare(
        'SELECT id, app_name, incident_start, incident_end, duration_min, reason, root_cause, auto_resolved FROM incidents WHERE id = ?',
      )
      .get(id) as IncidentRow | undefined;
    return row ?? null;
  }

  /**
   * Append a manual note to an incident. Returns the new note row, or null
   * if the incident id doesn't exist. `atIso` defaults to now().
   */
  addIncidentNote(
    incidentId: number,
    note: string,
    atIso?: string,
  ): IncidentNote | null {
    if (!this.getIncidentById(incidentId)) return null;
    const at = atIso ?? new Date(this.now()).toISOString();
    const result = this.db
      .prepare(
        'INSERT INTO incident_notes (incident_id, at, note) VALUES (?, ?, ?)',
      )
      .run(incidentId, at, note);
    return {
      id: Number(result.lastInsertRowid),
      incident_id: incidentId,
      at,
      note,
    };
  }

  getIncidentNotes(incidentId: number): IncidentNote[] {
    return this.db
      .prepare(
        'SELECT id, incident_id, at, note FROM incident_notes WHERE incident_id = ? ORDER BY at ASC, id ASC',
      )
      .all(incidentId) as IncidentNote[];
  }

  /**
   * Upsert a per-integration per-day snapshot of success_rate + total_attempts.
   * `(integration_name, date)` is the primary key so repeated snapshots on the
   * same day overwrite cleanly. `snapshot_at` records when we last fetched.
   */
  recordIntegrationStat(row: IntegrationStatRow): void {
    this.db
      .prepare(
        `INSERT INTO integration_stats_history
           (integration_name, date, success_rate, total_attempts, snapshot_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(integration_name, date) DO UPDATE SET
           success_rate = excluded.success_rate,
           total_attempts = excluded.total_attempts,
           snapshot_at = excluded.snapshot_at`,
      )
      .run(
        row.integration_name,
        row.date,
        row.success_rate,
        row.total_attempts,
        row.snapshot_at,
      );
  }

  /**
   * List integration stats for an integration over the last `days`. Rows are
   * returned in ascending date order so callers can render a sparkline
   * left-to-right.
   */
  listIntegrationStats(
    integrationName: string,
    days: number,
    nowMs?: number,
  ): IntegrationStatRow[] {
    const cutoff = new Date(
      (nowMs ?? this.now()) - days * 86400_000,
    ).toISOString();
    const cutoffDate = cutoff.slice(0, 10);
    return this.db
      .prepare(
        `SELECT integration_name, date, success_rate, total_attempts, snapshot_at
           FROM integration_stats_history
          WHERE integration_name = ? AND date >= ?
          ORDER BY date ASC`,
      )
      .all(integrationName, cutoffDate) as IntegrationStatRow[];
  }

  /** Insert a prune run audit row. Returns the new row id. */
  recordPruneRun(row: Omit<PruneRunRow, 'id'>): number {
    const result = this.db
      .prepare(
        'INSERT INTO prune_runs (ran_at, deleted_count, deleted_notes_count) VALUES (?, ?, ?)',
      )
      .run(row.ran_at, row.deleted_count, row.deleted_notes_count);
    return Number(result.lastInsertRowid);
  }

  /** Most recent prune audit row (by `ran_at`), or null if none. */
  getLatestPruneRun(): PruneRunRow | null {
    const row = this.db
      .prepare(
        'SELECT id, ran_at, deleted_count, deleted_notes_count FROM prune_runs ORDER BY ran_at DESC LIMIT 1',
      )
      .get() as PruneRunRow | undefined;
    return row ?? null;
  }

  /**
   * Compute MTBF (mean time between failures) + MTTR (mean time to recovery)
   * for an app over the last `days`. Open incidents contribute to downtime
   * (their running duration is `now - start`) but not to MTTR, which only
   * averages closed incidents' durations.
   *
   * MTBF averages the gaps between consecutive incidents (end of one ->
   * start of the next). Requires at least two incidents to produce a value.
   */
  computeIncidentStats(query: IncidentStatsQuery): IncidentStats {
    const days = query.days ?? 7;
    const nowMs = query.nowMs ?? this.now();
    const rows = this.listIncidents({
      days,
      app: query.app,
      nowMs,
      limit: 10000,
    });
    if (rows.length === 0) {
      return {
        incidentCount: 0,
        totalDowntimeMin: 0,
        mtbfHours: null,
        mttrMinutes: null,
      };
    }

    let totalDowntimeMin = 0;
    let closedCount = 0;
    let closedTotal = 0;
    for (const r of rows) {
      if (typeof r.duration_min === 'number') {
        totalDowntimeMin += r.duration_min;
        closedCount += 1;
        closedTotal += r.duration_min;
      } else if (r.incident_end === null) {
        const start = Date.parse(r.incident_start);
        if (Number.isFinite(start)) {
          totalDowntimeMin += Math.max(0, (nowMs - start) / 60000);
        }
      }
    }

    const mttrMinutes = closedCount > 0 ? closedTotal / closedCount : null;

    // Sort by start ascending to compute gaps.
    const sorted = [...rows].sort((a, b) => {
      const ams = Date.parse(a.incident_start);
      const bms = Date.parse(b.incident_start);
      return ams - bms;
    });
    let mtbfHours: number | null = null;
    if (sorted.length >= 2) {
      let gapSumMs = 0;
      let gapCount = 0;
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const prevEndMs = prev.incident_end
          ? Date.parse(prev.incident_end)
          : nowMs;
        const currStartMs = Date.parse(curr.incident_start);
        if (Number.isFinite(prevEndMs) && Number.isFinite(currStartMs)) {
          const gap = Math.max(0, currStartMs - prevEndMs);
          gapSumMs += gap;
          gapCount += 1;
        }
      }
      if (gapCount > 0) mtbfHours = gapSumMs / gapCount / 3600_000;
    }

    return {
      incidentCount: rows.length,
      totalDowntimeMin,
      mtbfHours,
      mttrMinutes,
    };
  }

  /**
   * Record a "we alerted on this integration on this date" row. Returns true
   * if a new row was inserted, false if an existing row already existed for
   * (integration_name, date) — used to dedupe re-fires within the same day.
   *
   * `last_fired_at` is populated from the row's `last_fired_at` field when
   * provided, else falls back to `alerted_at` for back-compat.
   */
  recordIntegrationAlert(row: IntegrationAlertStateRow): boolean {
    const lastFiredAt = row.last_fired_at ?? row.alerted_at;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO integration_alert_state
           (integration_name, date, success_rate, alerted_at, last_fired_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        row.integration_name,
        row.date,
        row.success_rate,
        row.alerted_at,
        lastFiredAt,
      );
    return result.changes > 0;
  }

  hasIntegrationAlerted(integrationName: string, date: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS present FROM integration_alert_state WHERE integration_name = ? AND date = ?',
      )
      .get(integrationName, date) as { present: number } | undefined;
    return !!row;
  }

  /**
   * Most-recent `last_fired_at` across all dates for `integrationName`. This
   * is what the per-hour cooldown consults. Returns null if the integration
   * has never alerted.
   */
  getMostRecentIntegrationAlert(integrationName: string): string | null {
    const row = this.db
      .prepare(
        `SELECT last_fired_at
           FROM integration_alert_state
          WHERE integration_name = ?
            AND last_fired_at IS NOT NULL
          ORDER BY last_fired_at DESC
          LIMIT 1`,
      )
      .get(integrationName) as { last_fired_at: string | null } | undefined;
    if (!row || !row.last_fired_at) return null;
    return row.last_fired_at;
  }

  /**
   * Update `last_fired_at` on an existing (integration, date) row without
   * changing the primary-key-level dedupe. Returns true when the row existed.
   */
  touchIntegrationAlert(
    integrationName: string,
    date: string,
    firedAtIso: string,
  ): boolean {
    const result = this.db
      .prepare(
        'UPDATE integration_alert_state SET last_fired_at = ? WHERE integration_name = ? AND date = ?',
      )
      .run(firedAtIso, integrationName, date);
    return result.changes > 0;
  }

  /**
   * Aggregate incidents by root_cause within `days`. Null/empty root_cause
   * rows are excluded. Returns entries sorted by count DESC.
   */
  topRootCauses(query: { days?: number; nowMs?: number; limit?: number }): Array<{
    root_cause: string;
    count: number;
  }> {
    const days = query.days ?? 7;
    const limit = query.limit ?? 10;
    const since = new Date(
      (query.nowMs ?? this.now()) - days * 86400_000,
    ).toISOString();
    const rows = this.db
      .prepare(
        `SELECT root_cause, COUNT(*) AS cnt
           FROM incidents
          WHERE incident_start >= ?
            AND root_cause IS NOT NULL
            AND TRIM(root_cause) <> ''
          GROUP BY root_cause
          ORDER BY cnt DESC
          LIMIT ?`,
      )
      .all(since, limit) as Array<{ root_cause: string; cnt: number }>;
    return rows.map((r) => ({ root_cause: r.root_cause, count: r.cnt }));
  }

  /**
   * Update the root_cause column for an incident. Returns true if the row
   * existed and was updated, false otherwise. `rootCause=null` clears it.
   */
  setIncidentRootCause(incidentId: number, rootCause: string | null): boolean {
    const result = this.db
      .prepare('UPDATE incidents SET root_cause = ? WHERE id = ?')
      .run(rootCause, incidentId);
    return result.changes > 0;
  }

  /**
   * Persist a per-integration cooldown override (seconds). Idempotent: reuses
   * the most-recent row for the integration, or inserts a stub for today's
   * UTC date when none exists. `seconds=null` clears the override.
   */
  setIntegrationCooldownOverride(
    integrationName: string,
    seconds: number | null,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT date FROM integration_alert_state
          WHERE integration_name = ?
          ORDER BY alerted_at DESC, date DESC LIMIT 1`,
      )
      .get(integrationName) as { date: string } | undefined;
    if (existing) {
      // Update all rows for this integration so the override propagates
      // regardless of which row the cooldown read happens to find first.
      this.db
        .prepare(
          'UPDATE integration_alert_state SET cooldown_seconds = ? WHERE integration_name = ?',
        )
        .run(seconds, integrationName);
      return;
    }
    // No row yet — insert a stub. We need a date + alerted_at + success_rate
    // to satisfy NOT NULL columns. Use a conservative success_rate=1.0 so
    // this stub is harmless if it's ever read for "did we alert?" purposes.
    const now = new Date(this.now());
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;
    this.db
      .prepare(
        `INSERT INTO integration_alert_state
           (integration_name, date, success_rate, alerted_at, last_fired_at, cooldown_seconds)
         VALUES (?, ?, 1.0, ?, NULL, ?)`,
      )
      .run(integrationName, date, now.toISOString(), seconds);
  }

  /**
   * Read the most-recent non-null cooldown_seconds value for an integration.
   * Returns null when no override has been set (callers fall back to env
   * default).
   */
  getIntegrationCooldownOverride(integrationName: string): number | null {
    const row = this.db
      .prepare(
        `SELECT cooldown_seconds
           FROM integration_alert_state
          WHERE integration_name = ?
            AND cooldown_seconds IS NOT NULL
          ORDER BY alerted_at DESC LIMIT 1`,
      )
      .get(integrationName) as { cooldown_seconds: number | null } | undefined;
    if (!row || row.cooldown_seconds === null || row.cooldown_seconds === undefined) {
      return null;
    }
    return Number(row.cooldown_seconds);
  }

  /**
   * Append an alert audit row. Truncates `reason` to 500 chars so a runaway
   * alert message can't bloat the table.
   */
  recordAlertAudit(row: Omit<AlertAuditRow, 'id'>): number {
    const reason = (row.reason ?? '').slice(0, 500);
    // Alert audit polish 2 (2026-04-26): persist the actor (cap at 64 chars).
    const actor =
      typeof row.actor === 'string' && row.actor.trim().length > 0
        ? row.actor.trim().slice(0, 64)
        : null;
    const result = this.db
      .prepare(
        `INSERT INTO alert_audit_log
           (at, integration_name, outcome, reason, severity, success_rate, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.at,
        row.integration_name,
        row.outcome,
        reason,
        row.severity ?? null,
        row.success_rate ?? null,
        actor,
      );
    return Number(result.lastInsertRowid);
  }

  /** Most-recent N audit rows ordered newest-first. */
  listAlertAudits(query: AlertAuditQuery = {}): AlertAuditRow[] {
    const limit = Math.max(1, Math.min(500, query.limit ?? 50));
    // Alert audit pagination (2026-04-25): clamp offset to >= 0. Negative,
    // NaN, and non-finite values fall back to 0 to preserve "first page"
    // behaviour for callers that omit the field entirely.
    const rawOffset = typeof query.offset === 'number' ? query.offset : 0;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const { sql, params } = this.buildAlertAuditQuery(query);
    return this.db
      .prepare(`${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AlertAuditRow[];
  }

  /**
   * Alert audit UI (2026-04-24): count matching audit rows so the UI can
   * surface a "more rows exist" footer when the result set was truncated by
   * the limit.
   */
  countAlertAudits(query: AlertAuditQuery = {}): number {
    const { sql, params } = this.buildAlertAuditQuery(query);
    // Replace SELECT col list with COUNT(*) — keep the rest verbatim.
    const countSql = sql.replace(
      /^SELECT[\s\S]+?FROM/,
      'SELECT COUNT(*) AS c FROM',
    );
    const row = this.db.prepare(countSql).get(...params) as { c: number };
    return row?.c ?? 0;
  }

  /**
   * Alert audit pagination (2026-04-25): per-integration audit-volume +
   * decision summary in the last N days. `fire_count` includes recovery
   * rows since they share the `outcome=fired` bucket — the homepage tile
   * then promotes itself to warn when any integration has fire_count > 0.
   */
  alertActivitySummary(
    query: { days?: number; limit?: number; nowMs?: number } = {},
  ): AlertActivitySummaryRow[] {
    const limit = Math.max(1, Math.min(50, query.limit ?? 5));
    const days = typeof query.days === 'number' && Number.isFinite(query.days) && query.days > 0
      ? query.days
      : 7;
    const since = new Date((query.nowMs ?? this.now()) - days * 86400_000).toISOString();
    return this.db
      .prepare(
        `SELECT integration_name,
                COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'fired' THEN 1 ELSE 0 END) AS fire_count
         FROM alert_audit_log
         WHERE at >= ?
         GROUP BY integration_name
         ORDER BY total DESC, integration_name ASC
         LIMIT ?`,
      )
      .all(since, limit) as AlertActivitySummaryRow[];
  }

  /**
   * Build the SELECT body + params for the alert audit list/count helpers.
   * Centralised so list + count share the exact same WHERE filter behaviour.
   * The decision filter is implemented via SQL (no post-filter) so the count
   * can be computed without materialising rows.
   */
  private buildAlertAuditQuery(query: AlertAuditQuery): {
    sql: string;
    params: unknown[];
  } {
    const wheres: string[] = [];
    const params: unknown[] = [];
    const integration = (query.integration ?? '').trim();
    if (integration) {
      wheres.push('integration_name = ?');
      params.push(integration);
    }
    if (typeof query.days === 'number' && Number.isFinite(query.days) && query.days > 0) {
      const since = new Date((query.nowMs ?? this.now()) - query.days * 86400_000).toISOString();
      wheres.push('at >= ?');
      params.push(since);
    }
    if (query.decision) {
      switch (query.decision) {
        case 'fire':
          wheres.push("outcome = 'fired' AND (severity IS NULL OR severity != 'info')");
          break;
        case 'recovery':
          wheres.push("outcome = 'fired' AND severity = 'info'");
          break;
        case 'cooldown':
          wheres.push("outcome = 'suppressed' AND lower(reason) LIKE 'cooldown%'");
          break;
        case 'suppress':
          wheres.push("outcome = 'suppressed' AND lower(reason) NOT LIKE 'cooldown%'");
          break;
      }
    }
    // Alert audit polish 2 (2026-04-26): exact-match actor filter. Empty
    // string returns all actors (including legacy NULL rows). When provided,
    // NULL/empty actor rows are excluded.
    const actor = (query.actor ?? '').trim();
    if (actor) {
      wheres.push('actor = ?');
      params.push(actor);
    }
    const whereClause = wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : '';
    const sql = `SELECT id, at, integration_name, outcome, reason, severity, success_rate, actor FROM alert_audit_log${whereClause}`;
    return { sql, params };
  }

  /**
   * Alert audit polish 3 (2026-04-27): persist a named filter view. Names are
   * unique — duplicate inserts throw the underlying SQLite UNIQUE constraint
   * error (callers map to 409). Trims + caps name to 64 chars and
   * query_string to 1024.
   */
  createAlertAuditSavedView(name: string, queryString: string): AlertAuditSavedViewRow {
    const cleanName = (name ?? '').trim().slice(0, 64);
    const cleanQuery = (queryString ?? '').trim().slice(0, 1024);
    const createdAt = new Date(this.now()).toISOString();
    const result = this.db
      .prepare(
        'INSERT INTO alert_audit_saved_views (name, query_string, created_at) VALUES (?, ?, ?)',
      )
      .run(cleanName, cleanQuery, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      name: cleanName,
      query_string: cleanQuery,
      created_at: createdAt,
    };
  }

  listAlertAuditSavedViews(): AlertAuditSavedViewRow[] {
    return this.db
      .prepare(
        'SELECT id, name, query_string, created_at FROM alert_audit_saved_views ORDER BY id DESC',
      )
      .all() as AlertAuditSavedViewRow[];
  }

  deleteAlertAuditSavedView(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM alert_audit_saved_views WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /**
   * Alert audit polish 4 (2026-04-28): rename a saved view by id. Returns the
   * updated row, or null when the row does not exist. UNIQUE name violations
   * propagate as the underlying SQLite constraint error so the caller can map
   * to 409.
   */
  renameAlertAuditSavedView(
    id: number,
    newName: string,
  ): AlertAuditSavedViewRow | null {
    const cleanName = (newName ?? '').trim().slice(0, 64);
    const existing = this.db
      .prepare(
        'SELECT id, name, query_string, created_at FROM alert_audit_saved_views WHERE id = ?',
      )
      .get(id) as AlertAuditSavedViewRow | undefined;
    if (!existing) return null;
    this.db
      .prepare('UPDATE alert_audit_saved_views SET name = ? WHERE id = ?')
      .run(cleanName, id);
    return { ...existing, name: cleanName };
  }

  close(): void {
    this.db.close();
  }
}
