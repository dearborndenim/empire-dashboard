import request from 'supertest';
import {
  createApp,
  serializeAlertAuditCsv,
  ALERT_AUDIT_CSV_HEADER,
} from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';

/**
 * 2026-04-24:
 *   Task 2 — recovery banner click-through JSON endpoint
 *   GET /api/incidents/recovered?days=N
 *
 *   Task 8 — Alert audit UI page
 *   GET /alerts/audit (HTML) + /alerts/audit.csv
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
    integrationAlertCooldownSeconds: 3600,
    apps: [{ name: 'Alpha', repo: 'o/alpha', url: 'https://alpha' }],
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

function seedRecovered(
  store: SqliteHistoryStore,
  appName: string,
  startedIso: string,
  endedIso: string,
): number {
  const id = store.openIncident(appName, startedIso, 'integration degraded');
  store.closeIncident(appName, endedIso, { autoResolved: true });
  return id;
}

function seedManuallyClosed(
  store: SqliteHistoryStore,
  appName: string,
  startedIso: string,
  endedIso: string,
): void {
  store.openIncident(appName, startedIso, 'manual');
  // Default closeIncident → auto_resolved = 0.
  store.closeIncident(appName, endedIso);
}

describe('GET /api/incidents/recovered — recovery banner click-through JSON', () => {
  it('returns auto-resolved incidents within the window, newest first, with mttr_seconds', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60_000).toISOString();
    const fiftyMinAgo = new Date(now - 50 * 60_000).toISOString();
    const twoHoursAgo = new Date(now - 120 * 60_000).toISOString();
    const ninetyMinAgo = new Date(now - 90 * 60_000).toISOString();
    seedRecovered(store, 'kanban', twoHoursAgo, ninetyMinAgo);
    seedRecovered(store, 'po-receiver', oneHourAgo, fiftyMinAgo);

    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'secret',
    });
    const res = await request(app)
      .get('/api/incidents/recovered')
      .set('x-admin-token', 'secret');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(1);
    expect(res.body.count).toBe(2);
    expect(res.body.recovered).toHaveLength(2);
    // Newest closed_at first → po-receiver before kanban.
    expect(res.body.recovered[0].integration_name).toBe('po-receiver');
    expect(res.body.recovered[1].integration_name).toBe('kanban');
    // mttr_seconds matches the close - open delta in seconds.
    expect(res.body.recovered[0].mttr_seconds).toBe(600);
    expect(res.body.recovered[1].mttr_seconds).toBe(1800);
    expect(res.body.recovered[0].opened_at).toBe(oneHourAgo);
    expect(res.body.recovered[0].closed_at).toBe(fiftyMinAgo);
    store.close();
  });

  it('returns an empty list when no auto-resolved incidents exist (manual closes excluded)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = Date.now();
    seedManuallyClosed(
      store,
      'kanban',
      new Date(now - 30 * 60_000).toISOString(),
      new Date(now - 5 * 60_000).toISOString(),
    );
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app)
      .get('/api/incidents/recovered')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.recovered).toEqual([]);
    store.close();
  });

  it('clamps days to [1, 30]: 0 → 1, 999 → 30, default → 1', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const r1 = await request(app)
      .get('/api/incidents/recovered?days=0')
      .set('x-admin-token', 'tok');
    expect(r1.status).toBe(200);
    expect(r1.body.windowDays).toBe(1);
    const r2 = await request(app)
      .get('/api/incidents/recovered?days=999')
      .set('x-admin-token', 'tok');
    expect(r2.status).toBe(200);
    expect(r2.body.windowDays).toBe(30);
    const r3 = await request(app)
      .get('/api/incidents/recovered')
      .set('x-admin-token', 'tok');
    expect(r3.status).toBe(200);
    expect(r3.body.windowDays).toBe(1);
    store.close();
  });

  it('returns 401 when the admin token is missing or wrong, 503 when no token configured', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // No token configured → 503.
    const noToken = createApp({ ...buildDeps(), historyStore: store });
    const r0 = await request(noToken).get('/api/incidents/recovered');
    expect(r0.status).toBe(503);
    // Token configured, missing header → 401.
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'right',
    });
    const r1 = await request(app).get('/api/incidents/recovered');
    expect(r1.status).toBe(401);
    // Token configured, wrong value → 401.
    const r2 = await request(app)
      .get('/api/incidents/recovered')
      .set('x-admin-token', 'wrong');
    expect(r2.status).toBe(401);
    store.close();
  });

  it('?app=<name> filters to a single integration', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = Date.now();
    seedRecovered(
      store,
      'kanban',
      new Date(now - 60 * 60_000).toISOString(),
      new Date(now - 30 * 60_000).toISOString(),
    );
    seedRecovered(
      store,
      'po-receiver',
      new Date(now - 45 * 60_000).toISOString(),
      new Date(now - 10 * 60_000).toISOString(),
    );
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app)
      .get('/api/incidents/recovered?app=kanban')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.recovered[0].integration_name).toBe('kanban');
    store.close();
  });
});

describe('GET /alerts/audit — alert audit UI page', () => {
  function seedAudit(
    store: SqliteHistoryStore,
    rows: Array<{
      at: string;
      integration_name: string;
      outcome: 'fired' | 'suppressed';
      reason: string;
      severity?: string | null;
      success_rate?: number | null;
    }>,
  ): void {
    for (const r of rows) {
      store.recordAlertAudit({
        at: r.at,
        integration_name: r.integration_name,
        outcome: r.outcome,
        reason: r.reason,
        severity: r.severity ?? null,
        success_rate: r.success_rate ?? null,
      });
    }
  }

  it('renders the page with all rows when no filters are set', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = new Date();
    seedAudit(store, [
      {
        at: now.toISOString(),
        integration_name: 'kanban',
        outcome: 'fired',
        reason: 'kanban success below 80%',
        severity: 'warning',
        success_rate: 0.5,
      },
      {
        at: new Date(now.getTime() - 1000).toISOString(),
        integration_name: 'po-receiver',
        outcome: 'fired',
        reason: 'po-receiver recovered',
        severity: 'info',
        success_rate: 0.95,
      },
      {
        at: new Date(now.getTime() - 2000).toISOString(),
        integration_name: 'po-receiver',
        outcome: 'suppressed',
        reason: 'cooldown (fires again in ~12m)',
        severity: null,
        success_rate: 0.6,
      },
    ]);
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app)
      .get('/alerts/audit')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Alert audit');
    // All three rows render with their decision pills.
    expect(res.text).toContain('alert-audit__pill--fire');
    expect(res.text).toContain('alert-audit__pill--recovery');
    expect(res.text).toContain('alert-audit__pill--cooldown');
    expect(res.text).toContain('kanban');
    expect(res.text).toContain('po-receiver');
    // Footer shows count, not the truncation banner.
    expect(res.text).toContain('3 rows matched');
    expect(res.text).not.toContain('Showing 3 of');
    store.close();
  });

  it('filters by integration + decision via query string', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = new Date();
    seedAudit(store, [
      {
        at: now.toISOString(),
        integration_name: 'kanban',
        outcome: 'fired',
        reason: 'kanban below threshold',
        severity: 'warning',
      },
      {
        at: new Date(now.getTime() - 1000).toISOString(),
        integration_name: 'po-receiver',
        outcome: 'suppressed',
        reason: 'cooldown',
        severity: null,
      },
      {
        at: new Date(now.getTime() - 2000).toISOString(),
        integration_name: 'po-receiver',
        outcome: 'suppressed',
        reason: 'already alerted today',
        severity: null,
      },
    ]);
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // integration=po-receiver should drop the kanban row.
    const r1 = await request(app)
      .get('/alerts/audit?integration=po-receiver')
      .set('x-admin-token', 'tok');
    expect(r1.status).toBe(200);
    expect(r1.text).not.toContain('kanban below threshold');
    expect(r1.text).toContain('po-receiver');
    expect(r1.text).toContain('2 rows matched');
    // decision=cooldown drops the "already alerted today" row.
    const r2 = await request(app)
      .get('/alerts/audit?decision=cooldown')
      .set('x-admin-token', 'tok');
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('1 row matched');
    expect(r2.text).toContain('alert-audit__pill--cooldown');
    expect(r2.text).not.toContain('alert-audit__pill--suppress');
    store.close();
  });

  it('renders an empty-state row when no audits match', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app)
      .get('/alerts/audit')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No alert audit rows match');
    expect(res.text).toContain('0 rows matched');
    store.close();
  });

  it('clamps days to [1, 30] in the filter form', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // 999 should clamp to 30 — the <select> on the page should mark 30 selected.
    const r1 = await request(app)
      .get('/alerts/audit?days=999')
      .set('x-admin-token', 'tok');
    expect(r1.status).toBe(200);
    expect(r1.text).toContain('<option value="30" selected>30 days</option>');
    // 0 should clamp to 1.
    const r2 = await request(app)
      .get('/alerts/audit?days=0')
      .set('x-admin-token', 'tok');
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('<option value="1" selected>1 day</option>');
    store.close();
  });

  it('requires the admin token (401 missing/wrong, 503 unset)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const noToken = createApp({ ...buildDeps(), historyStore: store });
    const r0 = await request(noToken).get('/alerts/audit');
    expect(r0.status).toBe(503);
    expect(r0.text).toContain('admin endpoint disabled');
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'right',
    });
    const r1 = await request(app).get('/alerts/audit');
    expect(r1.status).toBe(401);
    expect(r1.text).toContain('unauthorized');
    const r2 = await request(app)
      .get('/alerts/audit')
      .set('x-admin-token', 'wrong');
    expect(r2.status).toBe(401);
    store.close();
  });

  it('exports CSV with a stable header, decision column, and same filters as the page', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = new Date();
    store.recordAlertAudit({
      at: now.toISOString(),
      integration_name: 'kanban',
      outcome: 'fired',
      reason: 'kanban below, with "quotes" and, commas',
      severity: 'warning',
      success_rate: 0.5,
    });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app)
      .get('/alerts/audit.csv')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('alert-audit-');
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe(ALERT_AUDIT_CSV_HEADER);
    // Quote-wrap + double-quote-escape the reason field.
    expect(lines[1]).toContain('"kanban below, with ""quotes"" and, commas"');
    expect(lines[1]).toContain(',fire,fired,'); // decision column = "fire"
    // Filtered CSV still requires auth.
    const r401 = await request(app).get('/alerts/audit.csv');
    expect(r401.status).toBe(401);
    store.close();
  });
});

describe('serializeAlertAuditCsv unit', () => {
  it('renders an empty body when no rows', () => {
    const csv = serializeAlertAuditCsv([]);
    expect(csv).toBe(`${ALERT_AUDIT_CSV_HEADER}\r\n`);
  });
});
