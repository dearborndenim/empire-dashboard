import express, { Express } from 'express';
import path from 'path';
import { RuntimeConfig } from './config';
import { HealthChecker } from './healthChecker';
import { ActivityTracker } from './activityTracker';
import { combineStatus, AppStatus } from './status';
import { renderDashboard } from './render';
import { HistoryStore, SampleStatus, IncidentRow } from './historyStore';
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
  open: boolean;
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
      open: r.incident_end === null,
    };
    if (Array.isArray(r.notes)) {
      out.notes = r.notes.map((n) => ({ at: n.at, note: n.note }));
    }
    return out;
  });
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
      const rows = deps.historyStore.listIncidents({
        days,
        app: appName,
        includeNotes: true,
      });
      const incidents = serializeIncidents(rows);
      res.json({
        generatedAt: new Date().toISOString(),
        windowDays: days,
        count: incidents.length,
        incidents,
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
      const body = (req.body ?? {}) as { note?: unknown };
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (!note) {
        res.status(400).json({ error: 'note body is required' });
        return;
      }
      if (note.length > 2000) {
        res.status(400).json({ error: 'note exceeds 2000 characters' });
        return;
      }
      const saved = deps.historyStore.addIncidentNote(idRaw, note);
      if (!saved) {
        res.status(404).json({ error: 'incident not found' });
        return;
      }
      res.status(201).json({ note: saved });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/', async (_req, res) => {
    try {
      const statuses = await collectStatuses(deps);
      let recentIncidents: ReturnType<typeof serializeIncidents> = [];
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
      const html = renderDashboard(statuses, {
        generatedAt: new Date().toISOString(),
        recentIncidents,
        integrationTiles,
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
