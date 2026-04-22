import request from 'supertest';
import { createApp, csvCell, serializeIncidentsCsv, INCIDENTS_CSV_HEADER } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  buildWeeklyReportData,
  renderWeeklyReportText,
} from '../src/weeklyReport';

function buildDeps() {
  const config: RuntimeConfig = {
    port: 0,
    githubOwner: 'dearborndenim',
    healthCacheTtlSec: 0,
    healthTimeoutMs: 5000,
    pollIntervalMs: 300000,
    historyDbPath: ':memory:',
    historyRetentionDays: 7,
    incidentsRetentionDays: 30,
    apps: [
      { name: 'Alpha', repo: 'o/alpha', url: 'https://alpha' },
      { name: 'Beta', repo: 'o/beta', url: 'https://beta' },
    ],
  };
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200 });
  const healthChecker = new HealthChecker({ fetchImpl, cacheTtlSec: 0 });
  const client: RepoCommitsClient = {
    listCommits: async () => ({
      data: [{ sha: 'a', commit: { author: { date: new Date().toISOString() }, message: 'm' } }],
    }),
  };
  const activityTracker = new ActivityTracker({ client, cacheTtlSec: 0 });
  return { config, healthChecker, activityTracker };
}

describe('csvCell', () => {
  it('wraps values containing commas in double quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('leaves simple values unquoted', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
  });
});

describe('serializeIncidentsCsv', () => {
  it('renders the stable column header', () => {
    const csv = serializeIncidentsCsv([]);
    expect(csv.split('\r\n')[0]).toBe(INCIDENTS_CSV_HEADER);
    expect(INCIDENTS_CSV_HEADER).toContain('rootCause');
    expect(INCIDENTS_CSV_HEADER).toContain('durationMin');
  });

  it('emits one row per incident with root cause + notes count', () => {
    const csv = serializeIncidentsCsv([
      {
        id: 1,
        app: 'Alpha',
        start: '2026-04-20T10:00:00Z',
        end: '2026-04-20T10:05:00Z',
        durationMin: 5,
        reason: 'HTTP 502',
        rootCause: 'upstream outage',
        open: false,
        notes: [
          { at: '2026-04-20T10:10:00Z', note: 'restart done' },
          { at: '2026-04-20T11:00:00Z', note: 'monitoring' },
        ],
      },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('upstream outage');
    expect(lines[1]).toContain('2'); // notesCount
  });
});

describe('GET /api/incidents/export', () => {
  it('returns CSV attachment with 90 days of incidents by default', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 502');
    store.closeIncident('Alpha', new Date().toISOString());
    store.setIncidentRootCause(id, 'upstream outage');
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="incidents-90d-/);
    expect(res.text.split('\r\n')[0]).toBe(INCIDENTS_CSV_HEADER);
    expect(res.text).toContain('upstream outage');
    store.close();
  });

  it('returns 400 for unsupported formats', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/export?format=xml');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported format/);
    store.close();
  });

  it('returns 503 when no history store is wired', async () => {
    const app = createApp(buildDeps());
    const res = await request(app).get('/api/incidents/export');
    expect(res.status).toBe(503);
  });
});

describe('POST /api/incidents/:id/note with root_cause', () => {
  it('accepts an optional root_cause in the note payload and persists it', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 500');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 't')
      .send({ note: 'investigated', root_cause: 'deploy regression' });
    expect(res.status).toBe(201);
    expect(res.body.rootCause).toBe('deploy regression');
    const row = store.getIncidentById(id);
    expect(row?.root_cause).toBe('deploy regression');
    store.close();
  });

  it('rejects oversized root_cause (> 120 chars)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 500');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const big = 'x'.repeat(121);
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 't')
      .send({ note: 'n', root_cause: big });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/root_cause/);
    store.close();
  });
});

describe('GET /api/incidents/stats aggregate mode', () => {
  it('returns perApp + topRootCauses when no app param is given', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id1 = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 500');
    store.closeIncident('Alpha', new Date().toISOString());
    store.setIncidentRootCause(id1, 'deploy regression');
    const id2 = store.openIncident('Beta', new Date().toISOString(), 'HTTP 502');
    store.closeIncident('Beta', new Date().toISOString());
    store.setIncidentRootCause(id2, 'deploy regression');
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/stats');
    expect(res.status).toBe(200);
    expect(res.body.perApp.find((r: { app: string }) => r.app === 'Alpha')).toBeDefined();
    expect(res.body.topRootCauses[0].root_cause).toBe('deploy regression');
    expect(res.body.topRootCauses[0].count).toBe(2);
    store.close();
  });
});

describe('weekly report MTBF/MTTR + root cause section', () => {
  it('populates mtbfMttr + topRootCauses + renders in the email text', () => {
    const now = Date.parse('2026-04-21T12:00:00Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    // Alpha: one closed 20m incident.
    const a1 = store.openIncident(
      'Alpha',
      new Date(now - 3 * 3600_000).toISOString(),
      'HTTP 500',
    );
    store.closeIncident(
      'Alpha',
      new Date(now - 3 * 3600_000 + 20 * 60_000).toISOString(),
    );
    store.setIncidentRootCause(a1, 'deploy regression');
    // Beta: one closed 10m incident.
    const b1 = store.openIncident(
      'Beta',
      new Date(now - 2 * 3600_000).toISOString(),
      'HTTP 502',
    );
    store.closeIncident(
      'Beta',
      new Date(now - 2 * 3600_000 + 10 * 60_000).toISOString(),
    );
    store.setIncidentRootCause(b1, 'deploy regression');

    const data = buildWeeklyReportData({
      apps: [
        { name: 'Alpha', repo: 'o/alpha' },
        { name: 'Beta', repo: 'o/beta' },
      ],
      store,
      nowMs: now,
      windowDays: 7,
    });
    expect(data.mtbfMttr).toHaveLength(2);
    const alphaMtbf = data.mtbfMttr.find((r) => r.app === 'Alpha')!;
    expect(alphaMtbf.mttrMinutes).toBeCloseTo(20);
    expect(alphaMtbf.incidentCount).toBe(1);
    expect(data.topRootCauses[0].root_cause).toBe('deploy regression');
    expect(data.topRootCauses[0].count).toBe(2);

    const text = renderWeeklyReportText(data);
    expect(text).toContain('Per-app MTBF / MTTR (7d)');
    expect(text).toContain('MTTR');
    expect(text).toContain('Top root causes (7d)');
    expect(text).toContain('deploy regression');
    store.close();
  });
});
