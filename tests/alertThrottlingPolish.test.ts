import request from 'supertest';
import { createApp } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  renderIncidentsPage,
  RenderIncidentsPageOptions,
} from '../src/render';
import { IntegrationAlertMonitor } from '../src/integrationAlertMonitor';
import { AlertSender, AlertMessage, AlertSendResult } from '../src/alertSender';
import { loadConfig } from '../src/config';

/**
 * Alert throttling polish (2026-04-23) — covers:
 *
 *   1. GET /api/alerts/recent endpoint shape, default + clamped limits.
 *   2. Audit-log suppression accounting (cooldown + per-day dedupe both
 *      record outcome="suppressed" rows).
 *   3. Per-key cooldown override precedence over env-driven default.
 *   4. INTEGRATION_ALERT_COOLDOWN_SECONDS env loads through RuntimeConfig.
 *   5. /incidents recovered-integrations banner render path.
 *   6. /incidents?auto_resolved=true click-through filter (banner becomes
 *      "active" affordance + only auto-resolved rows surface).
 */

class RecordingSender implements AlertSender {
  messages: AlertMessage[] = [];
  next: AlertSendResult = { delivered: true, transport: 'console' };
  async send(message: AlertMessage): Promise<AlertSendResult> {
    this.messages.push(message);
    return this.next;
  }
}

function silent(): Pick<Console, 'log' | 'warn' | 'error'> {
  return { log: () => undefined, warn: () => undefined, error: () => undefined };
}

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

function seedHistory(
  store: SqliteHistoryStore,
  integration: string,
  days: Array<{ date: string; successRate: number; totalAttempts: number }>,
): void {
  for (const d of days) {
    store.recordIntegrationStat({
      integration_name: integration,
      date: d.date,
      success_rate: d.successRate,
      total_attempts: d.totalAttempts,
      snapshot_at: `${d.date}T03:00:00.000Z`,
    });
  }
}

describe('GET /api/alerts/recent — audit endpoint', () => {
  it('returns the most-recent N audit rows newest-first with the documented shape', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    store.recordAlertAudit({
      at: '2026-04-23T10:00:00Z',
      integration_name: 'kanban',
      outcome: 'fired',
      reason: 'kanban webhook success below 80%',
      severity: 'warning',
      success_rate: 0.5,
    });
    store.recordAlertAudit({
      at: '2026-04-23T10:30:00Z',
      integration_name: 'po-receiver',
      outcome: 'suppressed',
      reason: 'cooldown (fires again in ~30m)',
      severity: null,
      success_rate: 0.6,
    });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/api/alerts/recent');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.limit).toBe(50);
    // Newest first.
    expect(res.body.alerts[0].integration).toBe('po-receiver');
    expect(res.body.alerts[0].outcome).toBe('suppressed');
    expect(res.body.alerts[0].reason).toMatch(/cooldown/);
    expect(res.body.alerts[1].integration).toBe('kanban');
    expect(res.body.alerts[1].outcome).toBe('fired');
    expect(res.body.alerts[1].severity).toBe('warning');
    store.close();
  });

  it('clamps limit into [1,500] and ignores garbage', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const overshoot = await request(app).get('/api/alerts/recent?limit=999');
    expect(overshoot.status).toBe(200);
    expect(overshoot.body.limit).toBe(500);
    const tiny = await request(app).get('/api/alerts/recent?limit=0');
    expect(tiny.body.limit).toBe(1);
    const garbage = await request(app).get('/api/alerts/recent?limit=abc');
    expect(garbage.body.limit).toBe(50); // default fallback
    store.close();
  });

  it('returns 503 when no history store is wired', async () => {
    const app = createApp({ ...buildDeps() });
    const res = await request(app).get('/api/alerts/recent');
    expect(res.status).toBe(503);
  });
});

describe('IntegrationAlertMonitor — audit accounting', () => {
  it('records "fired" for the actual fire and "suppressed" for cooldown re-checks', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    let nowMs = Date.parse('2026-04-21T23:50:00Z');
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: new RecordingSender(),
      now: () => nowMs,
      logger: silent(),
      integrations: ['kanban'],
    });
    await monitor.check();
    nowMs = Date.parse('2026-04-22T00:15:00Z');
    seedHistory(store, 'kanban', [
      { date: '2026-04-22', successRate: 0.5, totalAttempts: 100 },
    ]);
    await monitor.check();

    const audits = store.listAlertAudits({ limit: 50 });
    // First call wrote a fired row; second call (different UTC day, inside
    // cooldown) wrote a suppressed row.
    const outcomes = audits.map((a) => a.outcome).sort();
    expect(outcomes).toEqual(['fired', 'suppressed']);
    const suppressed = audits.find((a) => a.outcome === 'suppressed')!;
    expect(suppressed.reason).toMatch(/cooldown/);
    expect(suppressed.integration_name).toBe('kanban');
    store.close();
  });

  it('per-key cooldown override wins over env-driven default', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    // Env-default cooldown is 1h; override the kanban-specific cooldown to 5
    // minutes so a re-fire 6 minutes later succeeds.
    store.setIntegrationCooldownOverride('kanban', 300);
    expect(store.getIntegrationCooldownOverride('kanban')).toBe(300);

    let nowMs = Date.parse('2026-04-21T12:00:00Z');
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => nowMs,
      logger: silent(),
      integrations: ['kanban'],
      cooldownMs: 60 * 60 * 1000, // env default 1h
    });
    await monitor.check();
    expect(sender.messages).toHaveLength(1);

    // Move 6 minutes forward (still well within env-default 1h, but past the
    // 300s override).
    nowMs = Date.parse('2026-04-22T00:06:00Z');
    seedHistory(store, 'kanban', [
      { date: '2026-04-22', successRate: 0.5, totalAttempts: 100 },
    ]);
    const second = await monitor.check();
    expect(second.fired).toHaveLength(1);
    expect(sender.messages).toHaveLength(2);
    store.close();
  });

  it('falls back to env-default cooldown when override is null', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    // No override.
    expect(store.getIntegrationCooldownOverride('kanban')).toBeNull();
    let nowMs = Date.parse('2026-04-21T23:55:00Z');
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => nowMs,
      logger: silent(),
      integrations: ['kanban'],
      cooldownMs: 60 * 60 * 1000,
    });
    await monitor.check();
    nowMs = Date.parse('2026-04-22T00:10:00Z');
    seedHistory(store, 'kanban', [
      { date: '2026-04-22', successRate: 0.5, totalAttempts: 100 },
    ]);
    const second = await monitor.check();
    // Env default 1h; only 15m elapsed; should still be cooled down.
    expect(second.fired).toHaveLength(0);
    expect(sender.messages).toHaveLength(1);
    store.close();
  });
});

describe('config.loadConfig — INTEGRATION_ALERT_COOLDOWN_SECONDS env', () => {
  it('reads INTEGRATION_ALERT_COOLDOWN_SECONDS into integrationAlertCooldownSeconds', () => {
    const cfg = loadConfig({ INTEGRATION_ALERT_COOLDOWN_SECONDS: '120' });
    expect(cfg.integrationAlertCooldownSeconds).toBe(120);
  });

  it('falls back to 3600 on missing or invalid env', () => {
    expect(loadConfig({}).integrationAlertCooldownSeconds).toBe(3600);
    expect(loadConfig({ INTEGRATION_ALERT_COOLDOWN_SECONDS: 'nope' }).integrationAlertCooldownSeconds).toBe(3600);
    expect(loadConfig({ INTEGRATION_ALERT_COOLDOWN_SECONDS: '0' }).integrationAlertCooldownSeconds).toBe(3600);
    expect(loadConfig({ INTEGRATION_ALERT_COOLDOWN_SECONDS: '-5' }).integrationAlertCooldownSeconds).toBe(3600);
  });
});

describe('historyStore — alert_audit_log + cooldown override', () => {
  it('truncates audit reason to 500 chars to keep the table from bloating', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const huge = 'x'.repeat(5000);
    store.recordAlertAudit({
      at: '2026-04-23T00:00:00Z',
      integration_name: 'kanban',
      outcome: 'fired',
      reason: huge,
      severity: 'warning',
      success_rate: 0.5,
    });
    const rows = store.listAlertAudits();
    expect(rows[0].reason).toHaveLength(500);
    store.close();
  });

  it('setIntegrationCooldownOverride is idempotent (insert, then update) and clearable', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // No row → inserts a stub for today.
    store.setIntegrationCooldownOverride('po-receiver', 60);
    expect(store.getIntegrationCooldownOverride('po-receiver')).toBe(60);
    // Update, not insert.
    store.setIntegrationCooldownOverride('po-receiver', 900);
    expect(store.getIntegrationCooldownOverride('po-receiver')).toBe(900);
    // Clear → null again.
    store.setIntegrationCooldownOverride('po-receiver', null);
    expect(store.getIntegrationCooldownOverride('po-receiver')).toBeNull();
    store.close();
  });
});

describe('/incidents — recovered-integrations banner', () => {
  function basePageOpts(overrides: Partial<RenderIncidentsPageOptions> = {}): RenderIncidentsPageOptions {
    return {
      generatedAt: 'x',
      appStats: [],
      recentIncidents: [],
      ...overrides,
    };
  }

  it('renders the callout banner with count + click-through CTA when recoveredCount24h > 0', () => {
    const html = renderIncidentsPage(basePageOpts({ recoveredCount24h: 3 }));
    expect(html).toContain('recovered-banner');
    expect(html).toContain('3 integrations auto-resolved');
    expect(html).toContain('href="/incidents?auto_resolved=true"');
  });

  it('renders singular noun when count is 1', () => {
    const html = renderIncidentsPage(basePageOpts({ recoveredCount24h: 1 }));
    expect(html).toContain('1 integration auto-resolved');
  });

  it('omits the banner entirely when recoveredCount24h is 0/undefined', () => {
    const html = renderIncidentsPage(basePageOpts({ recoveredCount24h: 0 }));
    expect(html).not.toContain('recovered-banner');
    const html2 = renderIncidentsPage(basePageOpts());
    expect(html2).not.toContain('recovered-banner');
  });

  it('renders the "Showing recovered only" affordance when filter is active', () => {
    const html = renderIncidentsPage(
      basePageOpts({ recoveredCount24h: 5, autoResolvedFilterActive: true }),
    );
    expect(html).toContain('recovered-banner--active');
    expect(html).toContain('Showing auto-resolved');
    expect(html).toContain('href="/incidents"'); // clear filter
  });
});

describe('/incidents click-through — auto_resolved=true filter', () => {
  it('only surfaces incidents whose auto_resolved flag is 1 when ?auto_resolved=true is on the URL', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Two incidents: one auto-resolved (recovery), one manually resolved.
    const a = store.openIncident('integration:kanban', new Date(Date.now() - 3600_000).toISOString(), 'r');
    store.closeIncident('integration:kanban', new Date().toISOString(), { autoResolved: true });
    const b = store.openIncident('Alpha', new Date(Date.now() - 3600_000).toISOString(), 'r');
    store.closeIncident('Alpha', new Date().toISOString());
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);

    const app = createApp({ ...buildDeps(), historyStore: store });

    // /api/incidents?auto_resolved=true: only the kanban one.
    const filtered = await request(app).get('/api/incidents?auto_resolved=true');
    expect(filtered.status).toBe(200);
    expect(filtered.body.count).toBe(1);
    expect(filtered.body.incidents[0].app).toBe('integration:kanban');
    expect(filtered.body.incidents[0].autoResolved).toBe(true);
    expect(filtered.body.autoResolvedOnly).toBe(true);

    // /api/incidents (no filter) returns both.
    const all = await request(app).get('/api/incidents');
    expect(all.body.count).toBe(2);
    expect(all.body.autoResolvedOnly).toBe(false);

    // /incidents page with the filter on shows the active banner and the
    // auto-resolved row in the recent-incidents list (Alpha can still appear
    // in the per-app MTBF/MTTR cards, but only the kanban incident should
    // appear in the incidents__list).
    const page = await request(app).get('/incidents?auto_resolved=true');
    expect(page.status).toBe(200);
    expect(page.text).toContain('recovered-banner--active');
    expect(page.text).toContain('integration:kanban');
    // The recent-incidents <ul> should not include Alpha as an incident__app.
    expect(page.text).not.toMatch(/incident__app">Alpha</);

    store.close();
  });

  it('marks recovery-closed incidents with auto_resolved=1 via IntegrationAlertMonitor', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-23', successRate: 0.95, totalAttempts: 200 },
    ]);
    store.openIncident('integration:kanban', '2026-04-22T10:00:00Z', 'phase4-test');
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: new RecordingSender(),
      now: () => Date.parse('2026-04-23T12:00:00Z'),
      logger: silent(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    expect(res.recovered).toHaveLength(1);
    // The incident is now closed AND flagged auto_resolved.
    const rows = store.listIncidents({ days: 7, limit: 100, autoResolvedOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].auto_resolved).toBe(1);
    expect(rows[0].app_name).toBe('integration:kanban');
    store.close();
  });
});
