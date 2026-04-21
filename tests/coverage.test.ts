/**
 * Targeted tests to keep statement/branch coverage above 98%.
 * These hit defensive branches + default parameter paths that the happier
 * feature-oriented tests don't touch.
 */
import {
  IntegrationTilesFetcher,
  IntegrationFetchImpl,
  loadIntegrationTilesConfig,
} from '../src/integrationTiles';
import { snapshotIntegrationStats, toUtcDate } from '../src/integrationStatsJob';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  renderDashboard,
  renderIncidentsPage,
  formatMtbfHours,
  formatMttrMinutes,
} from '../src/render';
import { AppStatus } from '../src/status';

function fakeFetch(byUrl: Record<string, {
  ok?: boolean; status?: number; body?: unknown; throws?: boolean;
}>): IntegrationFetchImpl {
  return async (url) => {
    const m = byUrl[url];
    if (!m) throw new Error(`unexpected url ${url}`);
    if (m.throws) throw new Error('boom');
    return { ok: m.ok ?? true, status: m.status ?? 200, json: async () => m.body ?? {} };
  };
}

describe('IntegrationTilesFetcher — coverage branches', () => {
  it('picks string-numeric success_rate when it is a string', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://po/api/integration/webhook-status': {
          body: { success_rate: '0.97', dead_lettered: '1' },
        },
      }),
    });
    const tiles = await fetcher.getTiles();
    const po = tiles.find((t) => t.id === 'po-receiver')!;
    expect(po.summary).toContain('97.0%');
    expect(po.summary).toContain('1 dead-lettered');
  });

  it('content-engine ignores unknown scene_distribution types', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://ce/api/integration/prompt-quality-stats': {
          body: { scene_distribution: 'not-an-object' },
        },
      }),
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('ok');
    expect(ce.summary).toBe('no data');
  });

  it('content-engine handles string-number counts in scene_distribution', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://ce/api/integration/prompt-quality-stats': {
          body: {
            rejected_rate: 0,
            avg_quality_score: 0.9,
            scene_distribution: { suburban: '42', weird: 'oops' },
          },
        },
      }),
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    const labels = (ce.details ?? []).map((d) => d.label);
    expect(labels).toContain('suburban');
    // weird should be dropped (non-numeric).
    expect(labels).not.toContain('weird');
  });

  it('fetchRawStats infers total=0 when rejected_count=0', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://ce/api/integration/prompt-quality-stats': {
          body: { rejected_rate: 0, rejected_count: 0 },
        },
      }),
    });
    const stats = await fetcher.fetchRawStats();
    const ce = stats.find((s) => s.integration === 'content-engine')!;
    expect(ce.totalAttempts).toBe(0);
  });

  it('fetchRawStats for kanban with total=0 returns null successRate', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { kanbanUrl: 'https://kb', kanbanApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://kb/api/webhooks/po-receiver/stats': {
          body: { total_received: 0, unmatched_count: 0 },
        },
      }),
    });
    const stats = await fetcher.fetchRawStats();
    const kb = stats.find((s) => s.integration === 'kanban')!;
    expect(kb.successRate).toBeNull();
    expect(kb.totalAttempts).toBe(0);
  });

  it('fetchRawStats normalizes percent rejected_rate > 1 to fraction', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://ce/api/integration/prompt-quality-stats': {
          body: { rejected_rate: 10, rejected_count: 1 }, // 10% -> 0.1 fraction
        },
      }),
    });
    const stats = await fetcher.fetchRawStats();
    const ce = stats.find((s) => s.integration === 'content-engine')!;
    expect(ce.successRate).toBeCloseTo(0.9);
    // 1 / 0.1 = 10
    expect(ce.totalAttempts).toBe(10);
  });
});

describe('snapshotIntegrationStats — default now/logger branches', () => {
  it('uses Date.now when now option not supplied', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fakeFetch({
        'https://po/api/integration/webhook-status': {
          body: { success_rate: 0.95, total: 10 },
        },
      }),
    });
    // Suppress console.log to keep test output clean; not passing logger
    // exercises the default-logger path.
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await snapshotIntegrationStats({ store, fetcher });
      expect(result.recorded).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    store.close();
  });

  it('falls back to "insufficient data" reason when error absent', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Fake fetcher that returns a fetchRawStats with both success null + no error.
    const fakeFetcher = {
      fetchRawStats: async () => [
        { integration: 'po-receiver', successRate: null, totalAttempts: null },
      ],
    };
    const silent = { log: () => {}, error: () => {} };
    const result = await snapshotIntegrationStats({
      store,
      fetcher: fakeFetcher as unknown as IntegrationTilesFetcher,
      logger: silent,
    });
    expect(result.skipped[0].reason).toBe('insufficient data');
    store.close();
  });
});

describe('render helpers — edge cases', () => {
  it('formatMtbfHours returns "<1h" for sub-hour values', () => {
    expect(formatMtbfHours(0.5)).toBe('<1h');
  });

  it('formatMtbfHours returns days for values >=48', () => {
    expect(formatMtbfHours(72)).toBe('3.0d');
  });

  it('formatMtbfHours returns em-dash for null/non-finite', () => {
    expect(formatMtbfHours(null)).toBe('—');
    expect(formatMtbfHours(Infinity)).toBe('—');
  });

  it('formatMttrMinutes buckets sub-minute / minutes / hours', () => {
    expect(formatMttrMinutes(0.5)).toBe('<1m');
    expect(formatMttrMinutes(30)).toBe('30m');
    expect(formatMttrMinutes(60)).toBe('1h');
    expect(formatMttrMinutes(125)).toBe('2h5m');
    expect(formatMttrMinutes(null)).toBe('—');
    expect(formatMttrMinutes(NaN)).toBe('—');
  });

  it('renderIncidentsPage renders even without appStats or incidents', () => {
    const html = renderIncidentsPage({
      generatedAt: '2026-04-20T00:00:00Z',
      appStats: [],
      recentIncidents: [],
    });
    expect(html).toContain('Incidents');
  });

  it('renderDashboard renders when all optional sections absent', () => {
    const statuses: AppStatus[] = [
      {
        name: 'A',
        repo: 'o/a',
        color: 'green',
        summary: 'up',
        health: { name: 'A', state: 'up', checkedAt: 'x' },
        activity: { name: 'A', repo: 'o/a' },
      },
    ];
    const html = renderDashboard(statuses, { generatedAt: 'x' });
    expect(html).toContain('Empire Dashboard');
  });

  it('renders the prune banner with ageHours=null fallback', () => {
    const statuses: AppStatus[] = [
      {
        name: 'A',
        repo: 'o/a',
        color: 'green',
        summary: 'up',
        health: { name: 'A', state: 'up', checkedAt: 'x' },
        activity: { name: 'A', repo: 'o/a' },
      },
    ];
    const html = renderDashboard(statuses, {
      generatedAt: 'x',
      latestPruneRun: {
        ranAt: 'bad-date',
        deletedCount: 2,
        deletedNotesCount: 0,
        ageHours: null,
      },
    });
    expect(html).toContain('prune-banner');
    expect(html).toContain('unknown');
  });
});

describe('integration stats history — edge cases', () => {
  it('toUtcDate pads month/day correctly for early year dates', () => {
    expect(toUtcDate(Date.parse('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });

  it('loadIntegrationTilesConfig returns undefined for empty env strings', () => {
    const cfg = loadIntegrationTilesConfig({ PO_RECEIVER_URL: '' });
    expect(cfg.poReceiverUrl).toBeUndefined();
  });
});

describe('app.ts — additional error paths', () => {
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const { HealthChecker } = require('../src/healthChecker');
  const { ActivityTracker } = require('../src/activityTracker');

  function buildDeps() {
    const fetchImpl = async () => ({ ok: true, status: 200 });
    const healthChecker = new HealthChecker({ fetchImpl, cacheTtlSec: 0 });
    const client = {
      listCommits: async () => ({ data: [] }),
    };
    const activityTracker = new ActivityTracker({ client, cacheTtlSec: 0 });
    const config = {
      port: 0,
      githubOwner: 'dearborndenim',
      healthCacheTtlSec: 0,
      healthTimeoutMs: 5000,
      pollIntervalMs: 300000,
      historyDbPath: ':memory:',
      historyRetentionDays: 7,
      incidentsRetentionDays: 30,
      apps: [{ name: 'A', repo: 'o/a' }],
    };
    return { config, healthChecker, activityTracker };
  }

  it('/incidents returns 500 when the store throws on compute', async () => {
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
      computeIncidentStats: jest.fn(() => { throw new Error('compute boom'); }),
      close: jest.fn(),
    };
    const app = createApp({ ...buildDeps(), historyStore: broken });
    const res = await request(app).get('/incidents');
    expect(res.status).toBe(500);
    expect(res.text).toContain('Incidents page error');
  });

  it('POST /api/incidents/:id/note returns 500 when addIncidentNote throws', async () => {
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
      addIncidentNote: jest.fn(() => { throw new Error('insert fail'); }),
      getIncidentNotes: jest.fn(() => []),
      recordIntegrationStat: jest.fn(),
      listIntegrationStats: jest.fn(() => []),
      recordPruneRun: jest.fn(() => 1),
      getLatestPruneRun: jest.fn(() => null),
      computeIncidentStats: jest.fn(() => ({ incidentCount: 0, totalDowntimeMin: 0, mtbfHours: null, mttrMinutes: null })),
      close: jest.fn(),
    };
    const app = createApp({
      ...buildDeps(),
      historyStore: broken,
      incidentsAdminToken: 'secret',
    });
    const res = await request(app)
      .post('/api/incidents/1/note')
      .set('x-admin-token', 'secret')
      .send({ note: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('insert fail');
  });

  it('/ tolerates getLatestPruneRun throwing', async () => {
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
      getLatestPruneRun: jest.fn(() => { throw new Error('prune read fail'); }),
      computeIncidentStats: jest.fn(() => ({ incidentCount: 0, totalDowntimeMin: 0, mtbfHours: null, mttrMinutes: null })),
      close: jest.fn(),
    };
    const app = createApp({ ...buildDeps(), historyStore: broken });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('/ tolerates integrationTiles fetch throwing', async () => {
    const throwingTiles = {
      getTiles: async () => { throw new Error('tiles fail'); },
    };
    const app = createApp({
      ...buildDeps(),
      integrationTiles: throwingTiles,
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('/ survives an invalid ran_at by fallback age=null', async () => {
    const weirdStore = {
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
      getLatestPruneRun: jest.fn(() => ({
        id: 1,
        ran_at: 'not-a-date',
        deleted_count: 1,
        deleted_notes_count: 0,
      })),
      computeIncidentStats: jest.fn(() => ({ incidentCount: 0, totalDowntimeMin: 0, mtbfHours: null, mttrMinutes: null })),
      close: jest.fn(),
    };
    const app = createApp({ ...buildDeps(), historyStore: weirdStore });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('prune-banner');
  });

  it('/api/status surfaces 500 when collectStatuses throws', async () => {
    // We force healthChecker.checkAll to throw.
    const deps = buildDeps();
    const throwingChecker = {
      checkAll: async () => { throw new Error('checker fail'); },
    };
    const app = createApp({
      config: deps.config,
      activityTracker: deps.activityTracker,
      healthChecker: throwingChecker as unknown as import('../src/healthChecker').HealthChecker,
    });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('checker fail');
  });

  it('/ renders error page when collectStatuses throws', async () => {
    const deps = buildDeps();
    const throwingChecker = {
      checkAll: async () => { throw new Error('check boom'); },
    };
    const app = createApp({
      config: deps.config,
      activityTracker: deps.activityTracker,
      healthChecker: throwingChecker as unknown as import('../src/healthChecker').HealthChecker,
    });
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
    expect(res.text).toContain('Dashboard error');
  });
});

describe('SqliteHistoryStore — coverage branches', () => {
  it('listIntegrationStats uses current clock when nowMs omitted', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const today = new Date().toISOString().slice(0, 10);
    store.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: today,
      success_rate: 0.9,
      total_attempts: 5,
      snapshot_at: new Date().toISOString(),
    });
    const rows = store.listIntegrationStats('po-receiver', 7);
    expect(rows).toHaveLength(1);
    store.close();
  });

  it('recordPruneRun ran_at strings preserve ordering', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    store.recordPruneRun({
      ran_at: '2026-01-01T00:00:00Z',
      deleted_count: 0,
      deleted_notes_count: 0,
    });
    store.recordPruneRun({
      ran_at: '2026-04-01T00:00:00Z',
      deleted_count: 1,
      deleted_notes_count: 0,
    });
    expect(store.getLatestPruneRun()!.ran_at).toBe('2026-04-01T00:00:00Z');
    store.close();
  });

  it('computeIncidentStats handles unparseable incident start dates', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Insert an incident with a garbage start; it will still be counted but
    // contribute nothing to MTBF/MTTR gaps.
    store.openIncident('App', 'not-a-date', 'r');
    const stats = store.computeIncidentStats({ app: 'App' });
    expect(stats.incidentCount).toBe(1);
    store.close();
  });

  it('computeIncidentStats with 2+ incidents but unparseable end still works', () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    // One legit closed incident, one open.
    store.openIncident('A', new Date(now - 2 * 3600_000).toISOString(), 'r');
    store.closeIncident('A', new Date(now - 2 * 3600_000 + 10 * 60_000).toISOString());
    store.openIncident('A', new Date(now - 1 * 3600_000).toISOString(), 'r2');
    const stats = store.computeIncidentStats({ app: 'A', days: 7, nowMs: now });
    expect(stats.incidentCount).toBe(2);
    expect(stats.mtbfHours).not.toBeNull();
    store.close();
  });
});
