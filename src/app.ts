import express, { Express } from 'express';
import path from 'path';
import { RuntimeConfig } from './config';
import { HealthChecker } from './healthChecker';
import { ActivityTracker } from './activityTracker';
import { combineStatus, AppStatus } from './status';
import { renderDashboard } from './render';
import { HistoryStore, SampleStatus } from './historyStore';
import { bucketsToSparkline, formatUptimePercent } from './sparkline';

export interface AppDeps {
  config: RuntimeConfig;
  healthChecker: HealthChecker;
  activityTracker: ActivityTracker;
  historyStore?: HistoryStore;
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
  const { config, healthChecker, activityTracker, historyStore } = deps;
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

export function createApp(deps: AppDeps): Express {
  const app = express();

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

  app.get('/', async (_req, res) => {
    try {
      const statuses = await collectStatuses(deps);
      const html = renderDashboard(statuses, { generatedAt: new Date().toISOString() });
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
