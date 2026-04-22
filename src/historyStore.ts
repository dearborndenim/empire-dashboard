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
  closeIncident(appName: string, endedAtIso: string): IncidentRow | null;
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
  /** Aggregate counts of incidents grouped by root_cause in a window. */
  topRootCauses(query: { days?: number; nowMs?: number; limit?: number }): Array<{
    root_cause: string;
    count: number;
  }>;
  /** Set/overwrite the root_cause column on an incident row. */
  setIncidentRootCause(incidentId: number, rootCause: string | null): boolean;
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
    `);

    // Incidents v5: add root_cause column if missing. sqlite lets us check
    // via PRAGMA table_info.
    const incidentColumns = this.db
      .prepare("PRAGMA table_info('incidents')")
      .all() as Array<{ name: string }>;
    if (!incidentColumns.some((c) => c.name === 'root_cause')) {
      this.db.exec('ALTER TABLE incidents ADD COLUMN root_cause TEXT');
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
   */
  closeIncident(appName: string, endedAtIso: string): IncidentRow | null {
    const open = this.getOpenIncident(appName);
    if (!open) return null;
    const startMs = Date.parse(open.incident_start);
    const endMs = Date.parse(endedAtIso);
    const durationMin = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, (endMs - startMs) / 60000)
      : null;
    this.db
      .prepare('UPDATE incidents SET incident_end = ?, duration_min = ? WHERE id = ?')
      .run(endedAtIso, durationMin, open.id);
    return {
      ...open,
      incident_end: endedAtIso,
      duration_min: durationMin,
    };
  }

  getOpenIncident(appName: string): IncidentRow | null {
    const row = this.db
      .prepare(
        'SELECT id, app_name, incident_start, incident_end, duration_min, reason, root_cause FROM incidents WHERE app_name = ? AND incident_end IS NULL ORDER BY incident_start DESC LIMIT 1',
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
      'SELECT id, app_name, incident_start, incident_end, duration_min, reason, root_cause FROM incidents WHERE incident_start >= ?';
    params.push(since);
    if (query.app) {
      sql += ' AND app_name = ?';
      params.push(query.app);
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
        'SELECT id, app_name, incident_start, incident_end, duration_min, reason, root_cause FROM incidents WHERE id = ?',
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
   */
  recordIntegrationAlert(row: IntegrationAlertStateRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO integration_alert_state
           (integration_name, date, success_rate, alerted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(row.integration_name, row.date, row.success_rate, row.alerted_at);
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

  close(): void {
    this.db.close();
  }
}
