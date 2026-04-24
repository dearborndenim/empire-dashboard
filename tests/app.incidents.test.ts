import request from 'supertest';
import { createApp, collectStatuses, serializeIncidents } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import { IncidentTracker } from '../src/incidentTracker';

function buildDeps(downBeta = true): {
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
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('alpha')) return { ok: true, status: 200 };
    return downBeta ? { ok: false, status: 502 } : { ok: true, status: 200 };
  };
  const healthChecker = new HealthChecker({ fetchImpl, cacheTtlSec: 0 });
  const client: RepoCommitsClient = {
    listCommits: async ({ repo }) => ({
      data: [
        {
          sha: repo,
          commit: { author: { date: new Date().toISOString() }, message: 'msg' },
        },
      ],
    }),
  };
  const activityTracker = new ActivityTracker({ client, cacheTtlSec: 0 });
  return { config, healthChecker, activityTracker };
}

describe('serializeIncidents', () => {
  it('maps db rows to the API shape and flags open incidents', () => {
    const out = serializeIncidents([
      { id: 1, app_name: 'A', incident_start: 's', incident_end: null, duration_min: null, reason: 'r' },
      { id: 2, app_name: 'B', incident_start: 's', incident_end: 'e', duration_min: 4, reason: 'x' },
    ]);
    expect(out).toEqual([
      { id: 1, app: 'A', start: 's', end: null, durationMin: null, reason: 'r', rootCause: null, open: true, autoResolved: false },
      { id: 2, app: 'B', start: 's', end: 'e', durationMin: 4, reason: 'x', rootCause: null, open: false, autoResolved: false },
    ]);
  });
});

describe('GET /api/incidents', () => {
  it('returns an empty list when no history store is wired', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/api/incidents');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.incidents).toEqual([]);
  });

  it('returns incidents after a green->red transition', async () => {
    const deps = buildDeps(true);
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const tracker = new IncidentTracker({ store, appNames: ['Alpha', 'Beta'] });
    // Prime states as up for both.
    tracker.processBatch([
      { name: 'Alpha', state: 'up', checkedAt: new Date().toISOString() },
      { name: 'Beta', state: 'up', checkedAt: new Date().toISOString() },
    ]);
    const app = createApp({ ...deps, historyStore: store, incidentTracker: tracker });
    // First collect pass flips Beta to down, opening an incident.
    await request(app).get('/api/status?force=1');
    const res = await request(app).get('/api/incidents');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.incidents[0].app).toBe('Beta');
    expect(res.body.incidents[0].open).toBe(true);
    expect(res.body.incidents[0].reason).toBe('HTTP 502');
    store.close();
  });

  it('supports filtering by app', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    store.openIncident('Alpha', new Date().toISOString(), 'r1');
    store.openIncident('Beta', new Date().toISOString(), 'r2');
    const deps = buildDeps();
    const app = createApp({ ...deps, historyStore: store });
    const res = await request(app).get('/api/incidents?app=Alpha');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.incidents[0].app).toBe('Alpha');
    store.close();
  });

  it('supports custom days window and clamps to [1,90]', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const deps = buildDeps();
    const app = createApp({ ...deps, historyStore: store });
    const res = await request(app).get('/api/incidents?days=14');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(14);
    // Out-of-range values clamp.
    const res2 = await request(app).get('/api/incidents?days=999');
    expect(res2.body.windowDays).toBe(90);
    const res3 = await request(app).get('/api/incidents?days=0');
    expect(res3.body.windowDays).toBe(1);
    // Garbage value falls back to default 7.
    const res4 = await request(app).get('/api/incidents?days=abc');
    expect(res4.body.windowDays).toBe(7);
    store.close();
  });

  it('returns 500 when the store throws', async () => {
    const deps = buildDeps();
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
      listIncidents: jest.fn(() => { throw new Error('boom'); }),
      getIncidentById: jest.fn(() => null),
      addIncidentNote: jest.fn(() => null),
      getIncidentNotes: jest.fn(() => []),
      recordIntegrationStat: jest.fn(),
      listIntegrationStats: jest.fn(() => []),
      recordPruneRun: jest.fn(() => 1),
      getLatestPruneRun: jest.fn(() => null),
      computeIncidentStats: jest.fn(() => ({ incidentCount: 0, totalDowntimeMin: 0, mtbfHours: null, mttrMinutes: null })),
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
      close: jest.fn(),
    };
    const app = createApp({ ...deps, historyStore: broken });
    const res = await request(app).get('/api/incidents');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});

describe('collectStatuses incident tracking', () => {
  it('records green->red and red->green transitions via IncidentTracker', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const tracker = new IncidentTracker({ store, appNames: ['Alpha', 'Beta'] });
    const deps = buildDeps(true);
    const enriched = { ...deps, historyStore: store, incidentTracker: tracker };
    // Prime states.
    tracker.processBatch([
      { name: 'Alpha', state: 'up', checkedAt: new Date().toISOString() },
      { name: 'Beta', state: 'up', checkedAt: new Date().toISOString() },
    ]);
    // First pass — Beta is down -> incident opens.
    await collectStatuses(enriched, { force: true });
    expect(store.getOpenIncident('Beta')).not.toBeNull();
    // Flip Beta healthy and run again.
    const depsUp = buildDeps(false);
    const enriched2 = { ...depsUp, historyStore: store, incidentTracker: tracker };
    await collectStatuses(enriched2, { force: true });
    expect(store.getOpenIncident('Beta')).toBeNull();
    const list = store.listIncidents({ days: 7 });
    expect(list).toHaveLength(1);
    expect(list[0].incident_end).not.toBeNull();
    store.close();
  });

  it('does not throw when incident tracker itself fails', async () => {
    const deps = buildDeps();
    const throwingTracker = {
      processBatch: () => { throw new Error('tracker boom'); },
    } as unknown as IncidentTracker;
    const enriched = { ...deps, incidentTracker: throwingTracker };
    await expect(collectStatuses(enriched, { force: true })).resolves.toBeDefined();
  });
});

describe('GET / with recent incidents', () => {
  it('renders the recent incidents panel when store has incidents', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    store.openIncident('Beta', new Date().toISOString(), 'HTTP 502');
    const deps = buildDeps();
    const app = createApp({ ...deps, historyStore: store });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Recent Incidents');
    expect(res.text).toContain('Beta');
    expect(res.text).toContain('HTTP 502');
    store.close();
  });

  it('renders an empty state when there are no incidents', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const deps = buildDeps();
    const app = createApp({ ...deps, historyStore: store });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No incidents in the last 7 days');
    store.close();
  });

  it('does not crash when incident read fails', async () => {
    const deps = buildDeps();
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
      listIncidents: jest.fn(() => { throw new Error('read boom'); }),
      getIncidentById: jest.fn(() => null),
      addIncidentNote: jest.fn(() => null),
      getIncidentNotes: jest.fn(() => []),
      recordIntegrationStat: jest.fn(),
      listIntegrationStats: jest.fn(() => []),
      recordPruneRun: jest.fn(() => 1),
      getLatestPruneRun: jest.fn(() => null),
      computeIncidentStats: jest.fn(() => ({ incidentCount: 0, totalDowntimeMin: 0, mtbfHours: null, mttrMinutes: null })),
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
      close: jest.fn(),
    };
    const app = createApp({ ...deps, historyStore: broken });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Empire Dashboard');
  });
});
