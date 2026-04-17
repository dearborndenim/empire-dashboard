import express, { Express } from 'express';
import path from 'path';
import { RuntimeConfig } from './config';
import { HealthChecker } from './healthChecker';
import { ActivityTracker } from './activityTracker';
import { combineStatus, AppStatus } from './status';
import { renderDashboard } from './render';

export interface AppDeps {
  config: RuntimeConfig;
  healthChecker: HealthChecker;
  activityTracker: ActivityTracker;
}

export async function collectStatuses(deps: AppDeps, opts: { force?: boolean } = {}): Promise<AppStatus[]> {
  const { config, healthChecker, activityTracker } = deps;
  const [healths, activities] = await Promise.all([
    healthChecker.checkAll(config.apps, opts),
    activityTracker.trackAll(config.apps, opts),
  ]);

  const healthByName = new Map(healths.map((h) => [h.name, h]));
  const activityByName = new Map(activities.map((a) => [a.name, a]));

  return config.apps.map((app) => {
    const health = healthByName.get(app.name)!;
    const activity = activityByName.get(app.name)!;
    return combineStatus(health, activity, app.repo);
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
