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
}

export interface IncidentsQuery {
  days?: number;
  app?: string;
  limit?: number;
  nowMs?: number;
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
  openIncident(appName: string, startedAtIso: string, reason: string | null): number;
  closeIncident(appName: string, endedAtIso: string): IncidentRow | null;
  getOpenIncident(appName: string): IncidentRow | null;
  listIncidents(query?: IncidentsQuery): IncidentRow[];
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
    `);
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
        'SELECT id, app_name, incident_start, incident_end, duration_min, reason FROM incidents WHERE app_name = ? AND incident_end IS NULL ORDER BY incident_start DESC LIMIT 1',
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
      'SELECT id, app_name, incident_start, incident_end, duration_min, reason FROM incidents WHERE incident_start >= ?';
    params.push(since);
    if (query.app) {
      sql += ' AND app_name = ?';
      params.push(query.app);
    }
    sql += ' ORDER BY incident_start DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params) as IncidentRow[];
  }

  close(): void {
    this.db.close();
  }
}
