import request from 'supertest';
import { createApp } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';

function buildDeps(): {
  config: RuntimeConfig;
  healthChecker: HealthChecker;
  activityTracker: ActivityTracker;
} {
  const config: RuntimeConfig = {
    port: 0,
    githubOwner: 'dearborndenim',
    healthCacheTtlSec: 0,
    healthTimeoutMs: 5000,
    pollIntervalMs: 300000,
    historyDbPath: ':memory:',
    historyRetentionDays: 7,
    incidentsRetentionDays: 30,
    integrationAlertCooldownSeconds: 3600,
    apps: [
      { name: 'Alpha', repo: 'o/alpha', url: 'https://alpha' },
      { name: 'Beta', repo: 'o/beta', url: 'https://beta' },
    ],
  };
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200 });
  const healthChecker = new HealthChecker({ fetchImpl, cacheTtlSec: 0 });
  const client: RepoCommitsClient = {
    listCommits: async ({ repo }) => ({
      data: [
        { sha: repo, commit: { author: { date: new Date().toISOString() }, message: 'msg' } },
      ],
    }),
  };
  const activityTracker = new ActivityTracker({ client, cacheTtlSec: 0 });
  return { config, healthChecker, activityTracker };
}

describe('GET /api/incidents/stats', () => {
  it('returns 503 when the history store is not wired', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/api/incidents/stats?app=Alpha');
    expect(res.status).toBe(503);
  });

  it('returns aggregate stats when the app query param is missing (incidents v5)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/stats');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(7);
    expect(Array.isArray(res.body.perApp)).toBe(true);
    expect(Array.isArray(res.body.topRootCauses)).toBe(true);
    store.close();
  });

  it('returns zero stats for an app with no incidents', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/stats?app=Alpha');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app: 'Alpha',
      windowDays: 7,
      mtbfHours: null,
      mttrMinutes: null,
      incidentCount: 0,
      totalDowntimeMinutes: 0,
    });
    store.close();
  });

  it('computes MTTR from closed incidents', async () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    store.openIncident('Alpha', new Date(now - 3 * 3600_000).toISOString(), 'r');
    store.closeIncident('Alpha', new Date(now - 3 * 3600_000 + 20 * 60_000).toISOString());
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/stats?app=Alpha&days=7');
    expect(res.status).toBe(200);
    expect(res.body.mttrMinutes).toBeCloseTo(20);
    expect(res.body.incidentCount).toBe(1);
    store.close();
  });

  it('clamps days to [1, 90]', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const r1 = await request(app).get('/api/incidents/stats?app=Alpha&days=999');
    expect(r1.body.windowDays).toBe(90);
    const r2 = await request(app).get('/api/incidents/stats?app=Alpha&days=0');
    expect(r2.body.windowDays).toBe(1);
    const r3 = await request(app).get('/api/incidents/stats?app=Alpha&days=abc');
    expect(r3.body.windowDays).toBe(7);
    store.close();
  });

  it('returns 500 when the store throws', async () => {
    const broken = {
      insert: jest.fn(),
      insertMany: jest.fn(),
      uptimePercent: jest.fn(() => null),
      bucketLastNHours: jest.fn(() => []),
      pruneOlderThan: jest.fn(() => 0),
      pruneIncidents: jest.fn(() => 0),
      openIncident: jest.fn(() => 1),
      closeIncident: jest.fn(() => null),
      getOpenIncident: jest.fn(() => null),
      listIncidents: jest.fn(() => []),
      getIncidentById: jest.fn(() => null),
      addIncidentNote: jest.fn(() => null),
      getIncidentNotes: jest.fn(() => []),
      recordIntegrationStat: jest.fn(),
      listIntegrationStats: jest.fn(() => []),
      recordPruneRun: jest.fn(() => 1),
      getLatestPruneRun: jest.fn(() => null),
      computeIncidentStats: jest.fn(() => { throw new Error('db boom'); }),
      recordIntegrationAlert: jest.fn(() => true),
      hasIntegrationAlerted: jest.fn(() => false),
      getMostRecentIntegrationAlert: jest.fn(() => null),
      touchIntegrationAlert: jest.fn(() => false),
      topRootCauses: jest.fn(() => []),
      setIncidentRootCause: jest.fn(() => false),
      setIntegrationCooldownOverride: jest.fn(),
      getIntegrationCooldownOverride: jest.fn(() => null),
      recordAlertAudit: jest.fn(() => 1),
      listAlertAudits: jest.fn(() => []),
      countAlertAudits: jest.fn(() => 0),
      close: jest.fn(),
    };
    const app = createApp({ ...buildDeps(), historyStore: broken });
    const res = await request(app).get('/api/incidents/stats?app=Alpha');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db boom');
  });
});

describe('GET /incidents', () => {
  it('renders per-app MTBF/MTTR cards', async () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    store.openIncident('Alpha', new Date(now - 3 * 3600_000).toISOString(), 'r');
    store.closeIncident('Alpha', new Date(now - 3 * 3600_000 + 20 * 60_000).toISOString());
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/incidents');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Incidents');
    expect(res.text).toContain('Alpha');
    expect(res.text).toContain('MTTR');
    expect(res.text).toContain('MTBF');
    store.close();
  });

  it('renders even without a history store', async () => {
    const app = createApp(buildDeps());
    const res = await request(app).get('/incidents');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Incidents');
  });
});

describe('GET / with prune banner', () => {
  it('renders the prune banner when a latest prune run exists', async () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    store.recordPruneRun({
      ran_at: new Date(now - 2 * 3600_000).toISOString(),
      deleted_count: 5,
      deleted_notes_count: 3,
    });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/');
    expect(res.text).toContain('prune-banner');
    expect(res.text).toContain('5 incidents');
    store.close();
  });

  it('does not render the banner when no prune run is recorded', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/');
    expect(res.text).not.toContain('prune-banner');
    store.close();
  });
});
