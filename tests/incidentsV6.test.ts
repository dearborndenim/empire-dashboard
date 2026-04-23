import request from 'supertest';
import { createApp } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  renderDashboard,
  renderIncidentsPage,
  RenderIncident,
} from '../src/render';
import { AppStatus } from '../src/status';

/**
 * Incidents v6 UI tests: inline root_cause editor on /incidents, top-root-causes
 * widget on the homepage, and CSV export button/date-range picker wiring.
 */

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

const baseStatus: AppStatus[] = [
  {
    name: 'App One',
    repo: 'o/one',
    color: 'green',
    summary: 'Up',
    health: { name: 'App One', state: 'up', checkedAt: 'x' },
    activity: { name: 'App One', repo: 'o/one' },
  },
];

describe('incidents v6 — inline root_cause editor on /incidents page', () => {
  it('renders the editable root_cause input with the current value pre-filled', () => {
    const incidents: RenderIncident[] = [
      {
        id: 42,
        app: 'Alpha',
        start: '2026-04-20T10:00:00Z',
        end: '2026-04-20T10:05:00Z',
        durationMin: 5,
        reason: 'HTTP 500',
        rootCause: 'deploy regression',
        open: false,
      },
    ];
    const html = renderIncidentsPage({
      generatedAt: 'x',
      appStats: [],
      recentIncidents: incidents,
    });
    // Form exists with the correct incident id hook and the current value.
    expect(html).toContain('data-incident-id="42"');
    expect(html).toContain('incident__root-cause--edit');
    expect(html).toContain('value="deploy regression"');
    // Save button + client script wired
    expect(html).toContain('incident__root-cause-save');
    expect(html).toContain("/api/incidents/' + encodeURIComponent(id) + '/note");
  });

  it('shows the "(set root cause)" placeholder when root cause is unset (empty state)', () => {
    const incidents: RenderIncident[] = [
      {
        id: 7,
        app: 'Alpha',
        start: '2026-04-20T10:00:00Z',
        end: null,
        durationMin: null,
        reason: 'HTTP 500',
        rootCause: null,
        open: true,
      },
    ];
    const html = renderIncidentsPage({
      generatedAt: 'x',
      appStats: [],
      recentIncidents: incidents,
    });
    expect(html).toContain('placeholder="(set root cause)"');
    // Input value attribute should be empty (no pre-fill).
    expect(html).toContain('value=""');
  });

  it('POST to /api/incidents/:id/note with root_cause persists through the existing endpoint', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 500');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 'tok' });
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 'tok')
      .send({ note: 'root_cause updated', root_cause: 'bad migration' });
    expect(res.status).toBe(201);
    expect(res.body.rootCause).toBe('bad migration');
    // Round-trip: the editor should read back the persisted value on reload.
    const row = store.getIncidentById(id);
    expect(row?.root_cause).toBe('bad migration');
    store.close();
  });

  it('escapes hostile root_cause values so the inline editor is not an XSS sink', () => {
    const incidents: RenderIncident[] = [
      {
        id: 1,
        app: 'Alpha',
        start: 'x',
        end: null,
        durationMin: null,
        reason: null,
        rootCause: '<script>alert(1)</script>',
        open: true,
      },
    ];
    const html = renderIncidentsPage({
      generatedAt: 'x',
      appStats: [],
      recentIncidents: incidents,
    });
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('incidents v6 — top-root-causes widget on homepage', () => {
  it('renders the top 5 root causes with count badges', () => {
    const html = renderDashboard(baseStatus, {
      generatedAt: 'x',
      topRootCauses: [
        { root_cause: 'deploy regression', count: 4 },
        { root_cause: 'upstream outage', count: 2 },
        { root_cause: 'dns', count: 1 },
      ],
    });
    expect(html).toContain('Top root causes (7d)');
    expect(html).toContain('deploy regression');
    expect(html).toContain('upstream outage');
    expect(html).toContain('top-root-causes__count');
    // Count badges rendered numerically.
    expect(html).toMatch(/top-root-causes__count">4</);
    expect(html).toMatch(/top-root-causes__count">2</);
  });

  it('omits the widget entirely when the list is empty/undefined', () => {
    const htmlEmpty = renderDashboard(baseStatus, {
      generatedAt: 'x',
      topRootCauses: [],
    });
    expect(htmlEmpty).not.toContain('Top root causes (7d)');
    const htmlUndef = renderDashboard(baseStatus, { generatedAt: 'x' });
    expect(htmlUndef).not.toContain('Top root causes (7d)');
  });

  it('is populated from the history store when / is rendered', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const a = store.openIncident('Alpha', new Date().toISOString(), 'r');
    store.closeIncident('Alpha', new Date().toISOString());
    store.setIncidentRootCause(a, 'deploy regression');
    const b = store.openIncident('Beta', new Date().toISOString(), 'r');
    store.closeIncident('Beta', new Date().toISOString());
    store.setIncidentRootCause(b, 'deploy regression');
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Top root causes (7d)');
    expect(res.text).toContain('deploy regression');
    store.close();
  });
});

describe('incidents v6 — CSV export button + date-range picker', () => {
  it('renders the export toolbar with 7/30/90 day options and 30 as default', () => {
    const html = renderIncidentsPage({
      generatedAt: 'x',
      appStats: [],
      recentIncidents: [],
    });
    expect(html).toContain('id="incidents-export-form"');
    expect(html).toContain('id="incidents-export-days"');
    expect(html).toContain('<option value="7">Last 7 days</option>');
    expect(html).toContain('<option value="30" selected>Last 30 days</option>');
    expect(html).toContain('<option value="90">Last 90 days</option>');
    expect(html).toContain('Download CSV');
    // Client script must build the download URL from the selected value.
    expect(html).toContain(
      "'/api/incidents/export?format=csv&days=' + encodeURIComponent(days)",
    );
  });

  it('the /api/incidents/export endpoint respects the days query param the button sends', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    store.openIncident('Alpha', new Date().toISOString(), 'HTTP 502');
    store.closeIncident('Alpha', new Date().toISOString());
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/incidents/export?format=csv&days=30');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="incidents-30d-/);
    store.close();
  });
});
