import request from 'supertest';
import { createApp, collectStatuses } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';

function buildDeps(
  overrides: Partial<RuntimeConfig> = {},
): { config: RuntimeConfig; healthChecker: HealthChecker; activityTracker: ActivityTracker; historyStore?: SqliteHistoryStore } {
  const config: RuntimeConfig = {
    port: 0,
    githubOwner: 'dearborndenim',
    healthCacheTtlSec: 60,
    healthTimeoutMs: 5000,
    pollIntervalMs: 300000,
    historyDbPath: ':memory:',
    historyRetentionDays: 7,
    incidentsRetentionDays: 30,
    apps: [
      { name: 'Alpha', repo: 'o/alpha', url: 'https://alpha', railwayLogsUrl: 'https://rail/alpha' },
      { name: 'Beta', repo: 'o/beta', url: 'https://beta' },
    ],
    ...overrides,
  };

  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('alpha')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };
  const healthChecker = new HealthChecker({ fetchImpl, cacheTtlSec: 0 });

  const client: RepoCommitsClient = {
    listCommits: async ({ repo }) => ({
      data: [
        {
          sha: repo,
          commit: {
            author: { date: new Date().toISOString() },
            message: `${repo}-msg`,
          },
        },
      ],
    }),
  };
  const activityTracker = new ActivityTracker({ client, cacheTtlSec: 0 });

  return { config, healthChecker, activityTracker };
}

describe('collectStatuses', () => {
  it('combines health and activity per app', async () => {
    const deps = buildDeps();
    const results = await collectStatuses(deps, { force: true });
    expect(results.length).toBe(2);
    const alpha = results.find((r) => r.name === 'Alpha')!;
    const beta = results.find((r) => r.name === 'Beta')!;
    expect(alpha.color).toBe('green');
    expect(beta.color).toBe('red');
  });
});

describe('Express app', () => {
  it('GET /healthz returns ok', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/status returns statuses array', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/api/status?force=1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.statuses).toHaveLength(2);
    const names = res.body.statuses.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['Alpha', 'Beta']);
  });

  it('GET /api/status returns 500 when collect throws', async () => {
    const deps = buildDeps();
    deps.healthChecker.checkAll = async () => {
      throw new Error('boom');
    };
    const app = createApp(deps);
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });

  it('GET / renders an HTML page', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Empire Dashboard');
    expect(res.text).toContain('Alpha');
    expect(res.text).toContain('Beta');
  });

  it('GET / surfaces errors as HTML 500', async () => {
    const deps = buildDeps();
    deps.healthChecker.checkAll = async () => {
      throw new Error('bad');
    };
    const app = createApp(deps);
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
    expect(res.text).toContain('Dashboard error');
  });

  it('GET /styles.css serves static assets', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/styles.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/css/);
    expect(res.text).toContain('.card');
  });
});

describe('collectStatuses with history', () => {
  it('persists one sample per app per pass', async () => {
    const deps = buildDeps();
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const enriched = { ...deps, historyStore: store };
    await collectStatuses(enriched, { force: true });
    await collectStatuses(enriched, { force: true });
    // After two passes we should have 2 samples per app.
    const alphaPct = store.uptimePercent('Alpha', 24);
    const betaPct = store.uptimePercent('Beta', 24);
    expect(alphaPct).toBe(100);
    expect(betaPct).toBe(0);
    store.close();
  });

  it('augments statuses with uptime_7d, sparkline_24h, railway_logs_url', async () => {
    const deps = buildDeps();
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const enriched = { ...deps, historyStore: store };
    const results = await collectStatuses(enriched, { force: true });
    const alpha = results.find((r) => r.name === 'Alpha')!;
    const beta = results.find((r) => r.name === 'Beta')!;
    expect(alpha.uptime_7d).toMatch(/%$/);
    expect(alpha.sparkline_24h).toHaveLength(24);
    expect(alpha.railway_logs_url).toBe('https://rail/alpha');
    expect(beta.railway_logs_url).toBeUndefined();
    store.close();
  });

  it('omits uptime_7d + sparkline when no history store is attached', async () => {
    const deps = buildDeps();
    const results = await collectStatuses(deps, { force: true });
    for (const r of results) {
      expect(r.uptime_7d ?? null).toBeNull();
      expect(r.sparkline_24h).toBeUndefined();
    }
  });

  it('does not throw when historyStore.insertMany fails', async () => {
    const deps = buildDeps();
    const throwingStore = {
      insert: jest.fn(),
      insertMany: jest.fn(() => { throw new Error('write fail'); }),
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
      computeIncidentStats: jest.fn(() => ({ incidentCount: 0, totalDowntimeMin: 0, mtbfHours: null, mttrMinutes: null })),
      recordIntegrationAlert: jest.fn(() => true),
      hasIntegrationAlerted: jest.fn(() => false),
      topRootCauses: jest.fn(() => []),
      setIncidentRootCause: jest.fn(() => false),
      close: jest.fn(),
    };
    const enriched = { ...deps, historyStore: throwingStore };
    await expect(collectStatuses(enriched, { force: true })).resolves.toBeDefined();
  });
});

describe('/api/status response shape', () => {
  it('includes new optional fields on each status', async () => {
    const deps = buildDeps();
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...deps, historyStore: store });
    const res = await request(app).get('/api/status?force=1');
    expect(res.status).toBe(200);
    const alpha = res.body.statuses.find((s: { name: string }) => s.name === 'Alpha');
    expect(alpha.railway_logs_url).toBe('https://rail/alpha');
    expect(Array.isArray(alpha.sparkline_24h)).toBe(true);
    expect(alpha.sparkline_24h).toHaveLength(24);
    expect(typeof alpha.uptime_7d).toBe('string');
    // Back-compat: original keys still present.
    expect(alpha.name).toBe('Alpha');
    expect(alpha.color).toBe('green');
    expect(alpha.health).toBeDefined();
    expect(alpha.activity).toBeDefined();
    store.close();
  });
});
