import express, { Express, Request, Response } from 'express';
import path from 'path';
import { RuntimeConfig } from './config';
import { HealthChecker } from './healthChecker';
import { ActivityTracker } from './activityTracker';
import { combineStatus, AppStatus } from './status';
import {
  renderDashboard,
  renderIncidentsPage,
  RenderPruneRun,
  renderAlertAuditPage,
  renderAlertAuditSavedViewsPage,
} from './render';
import {
  HistoryStore,
  SampleStatus,
  IncidentRow,
  AlertAuditRow,
  AlertAuditQuery,
  deriveAlertDecision,
} from './historyStore';
import { bucketsToSparkline, formatUptimePercent } from './sparkline';
import { IncidentTracker } from './incidentTracker';
import { IntegrationTilesFetcher, IntegrationTile } from './integrationTiles';

export interface AppDeps {
  config: RuntimeConfig;
  healthChecker: HealthChecker;
  activityTracker: ActivityTracker;
  historyStore?: HistoryStore;
  incidentTracker?: IncidentTracker;
  integrationTiles?: IntegrationTilesFetcher;
  /**
   * Token required to POST incident notes. When unset the note endpoint
   * returns 503 to make it obvious that admin actions are disabled.
   */
  incidentsAdminToken?: string;
}

/**
 * Map a HealthResult state to the persisted sample status. Kept in a
 * dedicated helper so the serialization is trivial to audit and test.
 */
function toSampleStatus(state: string): SampleStatus {
  if (state === 'up') return 'up';
  if (state === 'down') return 'down';
  return 'unknown';
}

export async function collectStatuses(deps: AppDeps, opts: { force?: boolean } = {}): Promise<AppStatus[]> {
  const { config, healthChecker, activityTracker, historyStore, incidentTracker } = deps;
  const [healths, activities] = await Promise.all([
    healthChecker.checkAll(config.apps, opts),
    activityTracker.trackAll(config.apps, opts),
  ]);

  const healthByName = new Map(healths.map((h) => [h.name, h]));
  const activityByName = new Map(activities.map((a) => [a.name, a]));

  // Persist a single sample row per app per collection pass.
  if (historyStore) {
    try {
      historyStore.insertMany(
        healths.map((h) => ({
          app_name: h.name,
          checked_at: h.checkedAt,
          status: toSampleStatus(h.state),
          response_ms: h.latencyMs ?? null,
        })),
      );
    } catch (err) {
      // Don't take the dashboard down if SQLite misbehaves.
      // eslint-disable-next-line no-console
      console.error('[empire-dashboard] history insert failed:', err);
    }
  }

  // Detect green->red / red->green transitions and persist incidents.
  if (incidentTracker) {
    try {
      incidentTracker.processBatch(healths);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[empire-dashboard] incident tracker failed:', err);
    }
  }

  return config.apps.map((app) => {
    const health = healthByName.get(app.name)!;
    const activity = activityByName.get(app.name)!;
    const base = combineStatus(health, activity, app.repo);

    let uptime7d: string | null = null;
    let sparkline: ReturnType<typeof bucketsToSparkline> | undefined;
    if (historyStore) {
      try {
        const raw = historyStore.uptimePercent(app.name, 24 * 7);
        uptime7d = formatUptimePercent(raw);
        const buckets = historyStore.bucketLastNHours(app.name, 24);
        sparkline = bucketsToSparkline(buckets);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[empire-dashboard] history read failed:', err);
      }
    }

    return {
      ...base,
      railway_logs_url: app.railwayLogsUrl,
      uptime_7d: uptime7d,
      sparkline_24h: sparkline,
    };
  });
}

/**
 * Fetch and serialize recent incidents. Safely returns [] if the history
 * store is unavailable. Centralised so both the HTML and JSON paths use the
 * same shape.
 */
export interface SerializedIncidentNote {
  at: string;
  note: string;
}

export interface SerializedIncident {
  id: number;
  app: string;
  start: string;
  end: string | null;
  durationMin: number | null;
  reason: string | null;
  rootCause: string | null;
  open: boolean;
  /**
   * Alert throttling polish (2026-04-23): true when the row was closed by
   * the IntegrationAlertMonitor recovery path. Surfaced through both the
   * /api/incidents JSON and the /incidents recovered-integrations callout.
   */
  autoResolved: boolean;
  notes?: SerializedIncidentNote[];
}

export function serializeIncidents(rows: IncidentRow[]): SerializedIncident[] {
  return rows.map((r) => {
    const out: SerializedIncident = {
      id: r.id,
      app: r.app_name,
      start: r.incident_start,
      end: r.incident_end,
      durationMin: r.duration_min,
      reason: r.reason,
      rootCause: r.root_cause ?? null,
      open: r.incident_end === null,
      autoResolved: r.auto_resolved === 1,
    };
    if (Array.isArray(r.notes)) {
      out.notes = r.notes.map((n) => ({ at: n.at, note: n.note }));
    }
    return out;
  });
}

/**
 * CSV-encode one cell per RFC 4180: double-quote-wrap if the value contains
 * commas/quotes/newlines, and escape embedded quotes by doubling them.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const INCIDENTS_CSV_HEADER = [
  'id',
  'app',
  'start',
  'end',
  'durationMin',
  'reason',
  'rootCause',
  'open',
  'notesCount',
].join(',');

export function serializeIncidentsCsv(incidents: SerializedIncident[]): string {
  const lines = [INCIDENTS_CSV_HEADER];
  for (const i of incidents) {
    lines.push(
      [
        csvCell(i.id),
        csvCell(i.app),
        csvCell(i.start),
        csvCell(i.end ?? ''),
        csvCell(i.durationMin ?? ''),
        csvCell(i.reason ?? ''),
        csvCell(i.rootCause ?? ''),
        csvCell(i.open ? 'true' : 'false'),
        csvCell(i.notes?.length ?? 0),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Alert audit UI (2026-04-24): CSV header for /alerts/audit.csv. Stable so
 * external tooling can rely on the column order.
 */
export const ALERT_AUDIT_CSV_HEADER = [
  'id',
  'at',
  'integration',
  'decision',
  'outcome',
  'severity',
  'success_rate',
  'actor',
  'reason',
].join(',');

export function serializeAlertAuditCsv(rows: AlertAuditRow[]): string {
  const lines = [ALERT_AUDIT_CSV_HEADER];
  for (const r of rows) {
    const decision = deriveAlertDecision(r);
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.at),
        csvCell(r.integration_name),
        csvCell(decision),
        csvCell(r.outcome),
        csvCell(r.severity ?? ''),
        csvCell(r.success_rate ?? ''),
        csvCell(r.actor ?? ''),
        csvCell(r.reason ?? ''),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Pull the configured admin token from the request (x-admin-token header
 * preferred, falls back to Authorization: Bearer). Returns null when nothing
 * is set or trimmed empty.
 */
function readAdminToken(req: Request): string | null {
  const headerToken =
    req.header('x-admin-token') ||
    (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const trimmed = (headerToken ?? '').trim();
  return trimmed ? trimmed : null;
}

/**
 * Auth gate for JSON endpoints. Returns true when the request is allowed to
 * proceed; otherwise writes the appropriate response and returns false. 503
 * when no token is configured server-side, 401 on mismatch.
 */
function requireAdminToken(
  req: Request,
  res: Response,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken) {
    res.status(503).json({ error: 'admin endpoint disabled (no admin token configured)' });
    return false;
  }
  const provided = readAdminToken(req);
  if (provided !== configuredToken) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/**
 * Same gate as `requireAdminToken` but writes plain HTML/text for the page
 * routes so we don't accidentally serve JSON to a browser.
 */
function requireAdminTokenForHtml(
  req: Request,
  res: Response,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken) {
    res.status(503).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h1>admin endpoint disabled</h1><p>No admin token configured.</p>');
    return false;
  }
  const provided = readAdminToken(req);
  if (provided !== configuredToken) {
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h1>unauthorized</h1><p>Set the <code>x-admin-token</code> header.</p>');
    return false;
  }
  return true;
}

/**
 * Clamp + parse an integer query param. Returns `defaultValue` when missing,
 * non-numeric, NaN, or out of range (after clamping). Used by the recovered
 * JSON endpoint and the alert audit page for `?days`.
 */
function clampInt(
  raw: unknown,
  opts: { defaultValue: number; min: number; max: number },
): number {
  if (typeof raw !== 'string') return opts.defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return opts.defaultValue;
  return Math.max(opts.min, Math.min(opts.max, Math.floor(parsed)));
}

/**
 * Parse the alert-audit filter query string off a request. Centralised so
 * the page route, CSV route, and tests build the exact same shape.
 *
 * Alert audit pagination (2026-04-25): also parses `offset`. We allow large
 * offsets here (up to 1_000_000) so callers can jump deep into long alert
 * histories — the page itself still caps `limit` at the per-page size, so
 * walking past the end just yields an empty page (rendered with a notice).
 */
export const ALERT_AUDIT_PAGE_SIZE = 100;

function buildAlertAuditQueryFromReq(req: Request): AlertAuditQuery {
  const integration = typeof req.query.integration === 'string' ? req.query.integration.trim() : '';
  const decisionRaw = typeof req.query.decision === 'string' ? req.query.decision.trim() : '';
  const validDecisions = ['fire', 'suppress', 'recovery', 'cooldown'] as const;
  const decision =
    (validDecisions as readonly string[]).includes(decisionRaw)
      ? (decisionRaw as AlertAuditQuery['decision'])
      : undefined;
  const days = clampInt(req.query.days, { defaultValue: 7, min: 1, max: 30 });
  const offset = clampInt(req.query.offset, { defaultValue: 0, min: 0, max: 1_000_000 });
  // Alert audit polish 2 (2026-04-26): exact-match actor filter. Cap at 64
  // chars to match the column write-side cap.
  const actorRaw = typeof req.query.actor === 'string' ? req.query.actor.trim() : '';
  const actor = actorRaw.slice(0, 64);
  const query: AlertAuditQuery = { days };
  if (integration) query.integration = integration;
  if (decision) query.decision = decision;
  if (offset > 0) query.offset = offset;
  if (actor) query.actor = actor;
  return query;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Static assets (CSS)
  app.use('/', express.static(path.join(__dirname, 'public')));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get('/api/status', async (req, res) => {
    try {
      const force = req.query.force === '1';
      const statuses = await collectStatuses(deps, { force });
      res.json({
        generatedAt: new Date().toISOString(),
        count: statuses.length,
        statuses,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/incidents/stats', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      const daysRaw = req.query.days;
      let days = 7;
      if (typeof daysRaw === 'string') {
        const parsed = Number(daysRaw);
        if (Number.isFinite(parsed)) {
          days = Math.max(1, Math.min(90, parsed));
        }
      }
      const appName = typeof req.query.app === 'string' ? req.query.app.trim() : '';
      if (!appName) {
        // Incidents v5: aggregate mode — return per-app stats + top root causes.
        const perApp = deps.config.apps.map((a) => {
          const stats = deps.historyStore!.computeIncidentStats({ app: a.name, days });
          return {
            app: a.name,
            mtbfHours: stats.mtbfHours,
            mttrMinutes: stats.mttrMinutes,
            incidentCount: stats.incidentCount,
            totalDowntimeMinutes: stats.totalDowntimeMin,
          };
        });
        const topRootCauses = deps.historyStore.topRootCauses({ days, limit: 5 });
        res.json({
          windowDays: days,
          perApp,
          topRootCauses,
        });
        return;
      }
      const stats = deps.historyStore.computeIncidentStats({ app: appName, days });
      res.json({
        app: appName,
        windowDays: days,
        mtbfHours: stats.mtbfHours,
        mttrMinutes: stats.mttrMinutes,
        incidentCount: stats.incidentCount,
        totalDowntimeMinutes: stats.totalDowntimeMin,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/incidents/export', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      const daysRaw = req.query.days;
      let days = 90;
      if (typeof daysRaw === 'string') {
        const parsed = Number(daysRaw);
        if (Number.isFinite(parsed)) {
          days = Math.max(1, Math.min(365, parsed));
        }
      }
      const format = typeof req.query.format === 'string' ? req.query.format : 'csv';
      if (format !== 'csv') {
        res.status(400).json({ error: "unsupported format (only 'csv' is supported)" });
        return;
      }
      const rows = deps.historyStore.listIncidents({
        days,
        limit: 10000,
        includeNotes: true,
      });
      const incidents = serializeIncidents(rows);
      const csv = serializeIncidentsCsv(incidents);
      const filename = `incidents-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/incidents', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.json({ generatedAt: new Date().toISOString(), count: 0, incidents: [] });
        return;
      }
      const daysRaw = req.query.days;
      let days = 7;
      if (typeof daysRaw === 'string') {
        const parsed = Number(daysRaw);
        if (Number.isFinite(parsed)) {
          days = Math.max(1, Math.min(90, parsed));
        }
      }
      const appName = typeof req.query.app === 'string' ? req.query.app : undefined;
      // Alert throttling polish (2026-04-23): allow the recovered-integrations
      // banner click-through to filter to only auto-resolved incidents.
      const autoResolvedOnly =
        typeof req.query.auto_resolved === 'string'
          ? req.query.auto_resolved === 'true' || req.query.auto_resolved === '1'
          : false;
      const rows = deps.historyStore.listIncidents({
        days,
        app: appName,
        includeNotes: true,
        autoResolvedOnly,
      });
      const incidents = serializeIncidents(rows);
      res.json({
        generatedAt: new Date().toISOString(),
        windowDays: days,
        count: incidents.length,
        autoResolvedOnly,
        incidents,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/alerts/recent', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      const limitRaw = req.query.limit;
      let limit = 50;
      if (typeof limitRaw === 'string') {
        const parsed = Number(limitRaw);
        if (Number.isFinite(parsed)) {
          limit = Math.max(1, Math.min(500, Math.floor(parsed)));
        }
      }
      const rows = deps.historyStore.listAlertAudits({ limit });
      const alerts = rows.map((r) => ({
        id: r.id,
        at: r.at,
        integration: r.integration_name,
        outcome: r.outcome,
        reason: r.reason,
        severity: r.severity,
        successRate: r.success_rate,
      }));
      res.json({
        generatedAt: new Date().toISOString(),
        limit,
        count: alerts.length,
        alerts,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/incidents/:id/note', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      if (!deps.incidentsAdminToken) {
        res.status(503).json({ error: 'incident notes disabled (no admin token configured)' });
        return;
      }
      const headerToken =
        req.header('x-admin-token') ||
        (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (headerToken !== deps.incidentsAdminToken) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const idRaw = Number(req.params.id);
      if (!Number.isInteger(idRaw) || idRaw <= 0) {
        res.status(400).json({ error: 'invalid incident id' });
        return;
      }
      const body = (req.body ?? {}) as { note?: unknown; root_cause?: unknown; rootCause?: unknown };
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (!note) {
        res.status(400).json({ error: 'note body is required' });
        return;
      }
      if (note.length > 2000) {
        res.status(400).json({ error: 'note exceeds 2000 characters' });
        return;
      }
      // Optional root_cause tag (incidents v5). Accept both snake + camel.
      const rootCauseRaw =
        typeof body.root_cause === 'string'
          ? body.root_cause
          : typeof body.rootCause === 'string'
            ? body.rootCause
            : null;
      const rootCause =
        typeof rootCauseRaw === 'string' ? rootCauseRaw.trim() : null;
      if (rootCause !== null && rootCause.length > 120) {
        res.status(400).json({ error: 'root_cause exceeds 120 characters' });
        return;
      }
      const saved = deps.historyStore.addIncidentNote(idRaw, note);
      if (!saved) {
        res.status(404).json({ error: 'incident not found' });
        return;
      }
      if (rootCause) {
        try {
          deps.historyStore.setIncidentRootCause(idRaw, rootCause);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] root_cause write failed:', err);
        }
      }
      res.status(201).json({ note: saved, rootCause: rootCause || null });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Recovery banner click-through JSON endpoint (2026-04-24). Lets external
   * tooling (e.g. McSecretary) query auto-resolved (recovered) integrations
   * over the last N days without scraping the /incidents HTML page.
   *
   * Auth: requires the same INCIDENTS_ADMIN_TOKEN as POST /note. Returns 503
   * when token is unset, 401 on mismatch.
   */
  app.get('/api/incidents/recovered', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      if (!requireAdminToken(req, res, deps.incidentsAdminToken)) return;
      const days = clampInt(req.query.days, { defaultValue: 1, min: 1, max: 30 });
      const appName = typeof req.query.app === 'string' ? req.query.app.trim() : '';
      const rows = deps.historyStore.listIncidents({
        days,
        autoResolvedOnly: true,
        app: appName || undefined,
        limit: 1000,
      });
      // Only surface closed incidents — auto_resolved should imply closed_at,
      // but defense-in-depth: filter rows without an end timestamp.
      const recovered = rows
        .filter((r) => r.incident_end !== null)
        .map((r) => {
          const startedMs = Date.parse(r.incident_start);
          const closedMs = Date.parse(r.incident_end as string);
          const mttrSeconds =
            Number.isFinite(startedMs) && Number.isFinite(closedMs)
              ? Math.max(0, Math.round((closedMs - startedMs) / 1000))
              : null;
          return {
            integration_name: r.app_name,
            opened_at: r.incident_start,
            closed_at: r.incident_end,
            mttr_seconds: mttrSeconds,
          };
        })
        // Newest closed_at first.
        .sort((a, b) => {
          const aMs = Date.parse(a.closed_at as string);
          const bMs = Date.parse(b.closed_at as string);
          return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
        });
      res.json({
        generatedAt: new Date().toISOString(),
        windowDays: days,
        count: recovered.length,
        recovered,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Alert audit UI (2026-04-24): server-rendered HTML browser for the
   * `alert_audit_log` table. Same auth gate as the recovered JSON endpoint
   * above. Filters: ?integration, ?decision (fire|suppress|recovery|cooldown),
   * ?days (default 7, max 30). Sort: newest first. Row limit: 500 with a
   * "more rows exist" footer when truncated.
   */
  app.get('/alerts/audit', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).send('<h1>history store unavailable</h1>');
        return;
      }
      if (!requireAdminTokenForHtml(req, res, deps.incidentsAdminToken)) return;
      const query = buildAlertAuditQueryFromReq(req);
      const offset = query.offset ?? 0;
      const rows = deps.historyStore.listAlertAudits({
        ...query,
        limit: ALERT_AUDIT_PAGE_SIZE,
        offset,
      });
      const totalMatched = deps.historyStore.countAlertAudits(query);
      // Alert audit polish 3 (2026-04-27): saved filter views sidebar.
      let savedViews: Array<{ id: number; name: string; query_string: string }> = [];
      try {
        savedViews = deps.historyStore.listAlertAuditSavedViews().map((v) => ({
          id: v.id,
          name: v.name,
          query_string: v.query_string,
        }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[empire-dashboard] saved-views read failed:', err);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderAlertAuditPage({
          generatedAt: new Date().toISOString(),
          rows,
          totalMatched,
          rowLimit: ALERT_AUDIT_PAGE_SIZE,
          offset,
          filters: {
            integration: query.integration ?? '',
            decision: query.decision ?? '',
            days: query.days ?? 7,
            actor: query.actor ?? '',
          },
          savedViews,
        }),
      );
    } catch (err) {
      res.status(500).send(
        `<h1>Alert audit page error</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`,
      );
    }
  });

  /**
   * Alert audit polish 3 (2026-04-27): list + manage saved /alerts/audit
   * filter views. Same admin-token gate as the audit page itself.
   *
   * Routes:
   *  - GET    /alerts/audit/views          → HTML list + new-view form
   *  - POST   /alerts/audit/views          → create (name + query_string body)
   *  - DELETE /alerts/audit/views/:id      → remove
   */
  app.get('/alerts/audit/views', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).send('<h1>history store unavailable</h1>');
        return;
      }
      if (!requireAdminTokenForHtml(req, res, deps.incidentsAdminToken)) return;
      const views = deps.historyStore.listAlertAuditSavedViews();
      const flash = typeof req.query.flash === 'string' ? req.query.flash : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderAlertAuditSavedViewsPage({
          generatedAt: new Date().toISOString(),
          views: views.map((v) => ({
            id: v.id,
            name: v.name,
            query_string: v.query_string,
            created_at: v.created_at,
          })),
          flash,
        }),
      );
    } catch (err) {
      res.status(500).send(
        `<h1>Saved views error</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`,
      );
    }
  });

  app.post('/alerts/audit/views', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      if (!requireAdminToken(req, res, deps.incidentsAdminToken)) return;
      const body = (req.body ?? {}) as { name?: unknown; query_string?: unknown; queryString?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const queryRaw =
        typeof body.query_string === 'string'
          ? body.query_string
          : typeof body.queryString === 'string'
            ? body.queryString
            : '';
      const queryString = typeof queryRaw === 'string' ? queryRaw.trim().replace(/^\?+/, '') : '';
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      if (name.length > 64) {
        res.status(400).json({ error: 'name exceeds 64 characters' });
        return;
      }
      if (queryString.length > 1024) {
        res.status(400).json({ error: 'query_string exceeds 1024 characters' });
        return;
      }
      try {
        const created = deps.historyStore.createAlertAuditSavedView(name, queryString);
        res.status(201).json({
          id: created.id,
          name: created.name,
          query_string: created.query_string,
          created_at: created.created_at,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint/i.test(msg) || /SQLITE_CONSTRAINT/i.test(msg)) {
          res.status(409).json({ error: 'a saved view with that name already exists' });
          return;
        }
        throw err;
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete('/alerts/audit/views/:id', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).json({ error: 'history store unavailable' });
        return;
      }
      if (!requireAdminToken(req, res, deps.incidentsAdminToken)) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'invalid view id' });
        return;
      }
      const removed = deps.historyStore.deleteAlertAuditSavedView(id);
      if (!removed) {
        res.status(404).json({ error: 'saved view not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** CSV export companion to /alerts/audit. Same filters + same auth gate. */
  app.get('/alerts/audit.csv', (req, res) => {
    try {
      if (!deps.historyStore) {
        res.status(503).send('history store unavailable');
        return;
      }
      if (!requireAdminToken(req, res, deps.incidentsAdminToken)) return;
      const query = buildAlertAuditQueryFromReq(req);
      const offset = query.offset ?? 0;
      const rows = deps.historyStore.listAlertAudits({
        ...query,
        limit: ALERT_AUDIT_PAGE_SIZE,
        offset,
      });
      const csv = serializeAlertAuditCsv(rows);
      const filename = `alert-audit-${query.days ?? 7}d-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      res.status(500).send(
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  app.get('/incidents', (req, res) => {
    try {
      const appStats: Array<{
        app: string;
        mtbfHours: number | null;
        mttrMinutes: number | null;
        incidentCount: number;
        totalDowntimeMin: number;
      }> = [];
      let recent: ReturnType<typeof serializeIncidents> = [];
      let recoveredCount24h = 0;
      // Alert throttling polish (2026-04-23): when ?auto_resolved=true is on
      // the URL, filter the recent list down to only auto-closed rows so the
      // banner click-through reads cleanly.
      const filterAutoResolved =
        typeof req.query.auto_resolved === 'string'
          ? req.query.auto_resolved === 'true' || req.query.auto_resolved === '1'
          : false;
      if (deps.historyStore) {
        for (const a of deps.config.apps) {
          const s = deps.historyStore.computeIncidentStats({ app: a.name, days: 7 });
          appStats.push({
            app: a.name,
            mtbfHours: s.mtbfHours,
            mttrMinutes: s.mttrMinutes,
            incidentCount: s.incidentCount,
            totalDowntimeMin: s.totalDowntimeMin,
          });
        }
        recent = serializeIncidents(
          deps.historyStore.listIncidents({
            days: 7,
            limit: 50,
            includeNotes: true,
            autoResolvedOnly: filterAutoResolved,
          }),
        );
        // Count auto-resolved incidents in the last 24h for the banner.
        try {
          const recoveredRows = deps.historyStore.listIncidents({
            days: 1,
            limit: 500,
            autoResolvedOnly: true,
          });
          recoveredCount24h = recoveredRows.length;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] recovered-count read failed:', err);
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderIncidentsPage({
          generatedAt: new Date().toISOString(),
          appStats,
          recentIncidents: recent,
          recoveredCount24h,
          autoResolvedFilterActive: filterAutoResolved,
        }),
      );
    } catch (err) {
      res.status(500).send(
        `<h1>Incidents page error</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`,
      );
    }
  });

  app.get('/', async (_req, res) => {
    try {
      const statuses = await collectStatuses(deps);
      let recentIncidents: ReturnType<typeof serializeIncidents> = [];
      let topRootCauses: Array<{ root_cause: string; count: number }> = [];
      if (deps.historyStore) {
        try {
          recentIncidents = serializeIncidents(
            deps.historyStore.listIncidents({
              days: 7,
              limit: 10,
              includeNotes: true,
            }),
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] incident read failed:', err);
        }
        try {
          topRootCauses = deps.historyStore.topRootCauses({ days: 7, limit: 5 });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] topRootCauses read failed:', err);
        }
      }
      let integrationTiles: IntegrationTile[] | undefined;
      if (deps.integrationTiles) {
        try {
          integrationTiles = await deps.integrationTiles.getTiles();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] integration tiles fetch failed:', err);
          integrationTiles = [];
        }
      }
      let latestPruneRun: RenderPruneRun | null | undefined;
      if (deps.historyStore) {
        try {
          const last = deps.historyStore.getLatestPruneRun();
          if (last) {
            const ms = Date.parse(last.ran_at);
            const ageHours = Number.isFinite(ms)
              ? (Date.now() - ms) / 3600_000
              : null;
            latestPruneRun = {
              ranAt: last.ran_at,
              deletedCount: last.deleted_count,
              deletedNotesCount: last.deleted_notes_count,
              ageHours,
            };
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] prune-run read failed:', err);
        }
      }
      let recentAlertActivity:
        | Array<{ integration_name: string; total: number; fire_count: number }>
        | undefined;
      if (deps.historyStore) {
        try {
          recentAlertActivity = deps.historyStore.alertActivitySummary({
            days: 7,
            limit: 5,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[empire-dashboard] alertActivitySummary read failed:', err);
        }
      }
      const html = renderDashboard(statuses, {
        generatedAt: new Date().toISOString(),
        recentIncidents,
        integrationTiles,
        latestPruneRun,
        topRootCauses,
        recentAlertActivity,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      res.status(500).send(
        `<h1>Dashboard error</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`,
      );
    }
  });

  return app;
}
