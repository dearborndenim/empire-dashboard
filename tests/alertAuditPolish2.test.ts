import request from 'supertest';
import { createApp, ALERT_AUDIT_CSV_HEADER, serializeAlertAuditCsv } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore, AlertAuditRow } from '../src/historyStore';
import {
  buildAlertAuditDigestData,
  renderAlertAuditDigestText,
  renderAlertAuditDigestHtml,
  sendAlertAuditDigest,
} from '../src/alertAuditDigest';
import { EmailMessage, EmailSender } from '../src/email';

/**
 * 2026-04-26 — Alert audit polish 2:
 *   1. ?actor filter on /alerts/audit + /alerts/audit.csv
 *   2. Per-decision colour bands in HTML rows + legend
 *   3. /alerts/audit/digest daily email summary
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

class CapturingEmailSender implements EmailSender {
  public messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<{ delivered: boolean; transport: string }> {
    this.messages.push(message);
    return { delivered: true, transport: 'capture' };
  }
}

// ---- Task 1: actor filter ----------------------------------------------

describe('alert audit ?actor filter', () => {
  it('filters HTML and CSV rows to a single actor (and includes actor column header in CSV)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const at = new Date().toISOString();
    store.recordAlertAudit({
      at,
      integration_name: 'kanban',
      outcome: 'fired',
      reason: 'fire-by-monitor',
      severity: 'warning',
      success_rate: 0.5,
      actor: 'monitor',
    });
    store.recordAlertAudit({
      at,
      integration_name: 'po-receiver',
      outcome: 'fired',
      reason: 'fire-by-cli',
      severity: 'warning',
      success_rate: 0.5,
      actor: 'cli',
    });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });

    // No filter -> both rows.
    const all = await request(app).get('/alerts/audit').set('x-admin-token', 'tok');
    expect(all.status).toBe(200);
    expect(all.text).toContain('kanban');
    expect(all.text).toContain('po-receiver');

    // actor=cli -> only po-receiver row.
    const cli = await request(app).get('/alerts/audit?actor=cli').set('x-admin-token', 'tok');
    expect(cli.status).toBe(200);
    expect(cli.text).toContain('po-receiver');
    expect(cli.text).not.toContain('fire-by-monitor');
    // Actor input round-tripped into the filter form.
    expect(cli.text).toContain('value="cli"');

    // actor=monitor -> only kanban row.
    const monitor = await request(app).get('/alerts/audit?actor=monitor').set('x-admin-token', 'tok');
    expect(monitor.status).toBe(200);
    expect(monitor.text).toContain('kanban');
    expect(monitor.text).not.toContain('fire-by-cli');

    // CSV header now includes actor; CSV filter on actor still works.
    expect(ALERT_AUDIT_CSV_HEADER).toContain('actor');
    const csv = await request(app)
      .get('/alerts/audit.csv?actor=cli')
      .set('x-admin-token', 'tok');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\r\n')[0]).toBe(ALERT_AUDIT_CSV_HEADER);
    expect(csv.text).toContain('po-receiver');
    expect(csv.text).not.toContain('kanban');
    expect(csv.text).toContain(',cli,'); // actor cell

    store.close();
  });

  it('gracefully filters when no actors are populated (legacy null rows excluded by explicit filter)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Simulate legacy row by inserting via raw SQL with NULL actor.
    const at = new Date().toISOString();
    // recordAlertAudit will null out empty actor -> stays NULL.
    store.recordAlertAudit({
      at,
      integration_name: 'kanban',
      outcome: 'fired',
      reason: 'legacy',
      severity: 'warning',
      success_rate: 0.5,
      // No actor -> NULL.
    });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });

    // Without a filter, the legacy row appears.
    const noFilter = await request(app).get('/alerts/audit').set('x-admin-token', 'tok');
    expect(noFilter.text).toContain('kanban');
    // The actor cell on legacy rows renders the empty placeholder (em-dash).
    expect(noFilter.text).toContain('alert-audit__cell--actor-empty');

    // With actor=monitor filter, the legacy NULL row is excluded.
    const filtered = await request(app)
      .get('/alerts/audit?actor=monitor')
      .set('x-admin-token', 'tok');
    expect(filtered.status).toBe(200);
    expect(filtered.text).not.toContain('legacy');
    expect(filtered.text).toContain('No alert audit rows match the current filters');

    store.close();
  });

  it('preserves the actor filter across paginated Prev/Next links', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Seed 105 actor=monitor rows + 10 actor=cli rows so monitor exceeds the
    // page-size cap of 100.
    const baseMs = Date.now();
    for (let i = 0; i < 105; i++) {
      store.recordAlertAudit({
        at: new Date(baseMs - i * 1000).toISOString(),
        integration_name: 'kanban',
        outcome: 'suppressed',
        reason: `cooldown #${i}`,
        severity: null,
        success_rate: 0.5,
        actor: 'monitor',
      });
    }
    for (let i = 0; i < 10; i++) {
      store.recordAlertAudit({
        at: new Date(baseMs - i * 1000).toISOString(),
        integration_name: 'po-receiver',
        outcome: 'suppressed',
        reason: `cooldown cli ${i}`,
        severity: null,
        success_rate: 0.5,
        actor: 'cli',
      });
    }
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // Page 1 with actor=monitor -> Next link must carry actor query param.
    const r1 = await request(app)
      .get('/alerts/audit?actor=monitor')
      .set('x-admin-token', 'tok');
    expect(r1.status).toBe(200);
    expect(r1.text).toContain('Page 1 of 2');
    // Next link must include actor=monitor AND offset=100.
    expect(r1.text).toContain('actor=monitor');
    expect(r1.text).toMatch(/href="\/alerts\/audit\?[^"]*actor=monitor[^"]*offset=100"/);

    store.close();
  });
});

// ---- Task 2: per-decision colour bands ---------------------------------

describe('alert audit per-decision colour bands', () => {
  it('emits CSS classes per decision row + a legend strip', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const at = new Date().toISOString();
    // One row per decision so all four classes render in the table.
    store.recordAlertAudit({
      at,
      integration_name: 'kanban',
      outcome: 'fired',
      reason: 'fire-row',
      severity: 'warning',
      success_rate: 0.5,
      actor: 'monitor',
    });
    store.recordAlertAudit({
      at,
      integration_name: 'po-receiver',
      outcome: 'fired',
      reason: 'recovery-row',
      severity: 'info',
      success_rate: 0.95,
      actor: 'monitor',
    });
    store.recordAlertAudit({
      at,
      integration_name: 'content-engine',
      outcome: 'suppressed',
      reason: 'cooldown for 30m',
      severity: null,
      success_rate: 0.5,
      actor: 'monitor',
    });
    store.recordAlertAudit({
      at,
      integration_name: 'misc',
      outcome: 'suppressed',
      reason: 'already alerted today',
      severity: null,
      success_rate: 0.5,
      actor: 'monitor',
    });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app).get('/alerts/audit').set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    // Each decision's row class is rendered.
    expect(res.text).toContain('alert-audit__row--fire');
    expect(res.text).toContain('alert-audit__row--recovery');
    expect(res.text).toContain('alert-audit__row--cooldown');
    expect(res.text).toContain('alert-audit__row--suppress');
    // Legend strip is rendered above the table with all 4 swatches.
    expect(res.text).toContain('alert-audit__legend');
    expect(res.text).toContain('alert-audit__legend-swatch--fire');
    expect(res.text).toContain('alert-audit__legend-swatch--suppress');
    expect(res.text).toContain('alert-audit__legend-swatch--recovery');
    expect(res.text).toContain('alert-audit__legend-swatch--cooldown');
    // Legend label appears.
    expect(res.text).toContain('Decision colour bands');

    store.close();
  });
});

// ---- Task 3: digest payload + opt-out + empty -------------------------

function seedDigestRows(
  store: SqliteHistoryStore,
  baseMs: number,
): void {
  // 3 fires on kanban (last 24h), 1 fire on po-receiver, 5 cooldowns on
  // content-engine, 2 recoveries on kanban — all within the 24h window.
  const within = (mins: number) => new Date(baseMs - mins * 60_000).toISOString();
  for (let i = 0; i < 3; i++) {
    store.recordAlertAudit({
      at: within(60 + i * 10),
      integration_name: 'kanban',
      outcome: 'fired',
      reason: `fire ${i}`,
      severity: 'warning',
      success_rate: 0.5,
      actor: 'monitor',
    });
  }
  store.recordAlertAudit({
    at: within(120),
    integration_name: 'po-receiver',
    outcome: 'fired',
    reason: 'fire',
    severity: 'critical',
    success_rate: 0.3,
    actor: 'monitor',
  });
  for (let i = 0; i < 5; i++) {
    store.recordAlertAudit({
      at: within(30 + i * 5),
      integration_name: 'content-engine',
      outcome: 'suppressed',
      reason: 'cooldown for ~12m',
      severity: null,
      success_rate: 0.5,
      actor: 'monitor',
    });
  }
  for (let i = 0; i < 2; i++) {
    store.recordAlertAudit({
      at: within(45 + i * 5),
      integration_name: 'kanban',
      outcome: 'fired',
      reason: 'recovery',
      severity: 'info',
      success_rate: 0.95,
      actor: 'monitor',
    });
  }
  // Outside the 24h window -> must NOT show up in totals.
  store.recordAlertAudit({
    at: new Date(baseMs - 2 * 86400_000).toISOString(),
    integration_name: 'misc',
    outcome: 'fired',
    reason: 'old',
    severity: 'warning',
    success_rate: 0.4,
    actor: 'monitor',
  });
}

describe('alert audit digest — payload shape', () => {
  it('rolls up the last 24h with fires-first sort and excludes older rows', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const nowMs = Date.now();
    seedDigestRows(store, nowMs);
    const data = buildAlertAuditDigestData({ store, nowMs });
    expect(data.windowHours).toBe(24);
    // 3 + 1 + 5 + 2 = 11 (the 'old' row is excluded by the 24h filter).
    expect(data.total).toBe(11);
    expect(data.totalFires).toBe(4); // 3 kanban + 1 po-receiver
    expect(data.totalSuppresses).toBe(0);
    expect(data.totalRecoveries).toBe(2);
    expect(data.totalCooldowns).toBe(5);

    // 'misc' should NOT appear in the rollup.
    const names = data.topIntegrations.map((r) => r.integration_name);
    expect(names).not.toContain('misc');

    // Fires-first ordering: kanban (3 fires) before po-receiver (1 fire)
    // before content-engine (0 fires).
    expect(names[0]).toBe('kanban');
    expect(names[1]).toBe('po-receiver');
    expect(names[2]).toBe('content-engine');

    // Per-row counts.
    const kanban = data.topIntegrations.find((r) => r.integration_name === 'kanban')!;
    expect(kanban.fire_count).toBe(3);
    expect(kanban.recovery_count).toBe(2);
    expect(kanban.total).toBe(5);

    const ce = data.topIntegrations.find((r) => r.integration_name === 'content-engine')!;
    expect(ce.fire_count).toBe(0);
    expect(ce.cooldown_count).toBe(5);

    // Text + HTML rendering smoke check.
    const text = renderAlertAuditDigestText(data);
    expect(text).toContain('Alert audit digest (24h)');
    expect(text).toContain('total      11');
    expect(text).toContain('fires      4');
    expect(text).toContain('kanban');

    const html = renderAlertAuditDigestHtml(data);
    expect(html).toContain('<h2');
    expect(html).toContain('kanban');
    // Fire counts of zero get the muted style; non-zero gets the red style.
    expect(html).toMatch(/color:#b82424[^>]*>3</);

    store.close();
  });
});

describe('alert audit digest — opt-out + empty + send path', () => {
  it('opt-out via DISABLE_ALERT_AUDIT_DIGEST=1 short-circuits without sending', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedDigestRows(store, Date.now());
    const sender = new CapturingEmailSender();
    const res = await sendAlertAuditDigest({
      store,
      sender,
      to: 'rob@example.com',
      env: { DISABLE_ALERT_AUDIT_DIGEST: '1' } as NodeJS.ProcessEnv,
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('opt-out');
    expect(sender.messages).toHaveLength(0);
    store.close();
  });

  it('skips when no recipient is configured (env or option)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedDigestRows(store, Date.now());
    const sender = new CapturingEmailSender();
    const res = await sendAlertAuditDigest({
      store,
      sender,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no-recipient');
    expect(sender.messages).toHaveLength(0);
    store.close();
  });

  it('empty audit window sends nothing', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // No rows seeded.
    const sender = new CapturingEmailSender();
    const res = await sendAlertAuditDigest({
      store,
      sender,
      to: 'rob@example.com',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('empty-window');
    expect(res.data.total).toBe(0);
    expect(sender.messages).toHaveLength(0);
    store.close();
  });

  it('happy path: builds + sends an email when there is activity and a recipient', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedDigestRows(store, Date.now());
    const sender = new CapturingEmailSender();
    const res = await sendAlertAuditDigest({
      store,
      sender,
      to: 'rob@example.com',
      from: 'noreply@example.com',
      env: { ALERT_AUDIT_DIGEST_RECIPIENT: 'env@example.com' } as NodeJS.ProcessEnv,
    });
    expect(res.sent).toBe(true);
    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('capture');
    expect(sender.messages).toHaveLength(1);
    const msg = sender.messages[0];
    expect(msg.to).toBe('rob@example.com'); // option overrides env
    expect(msg.from).toBe('noreply@example.com');
    expect(msg.subject).toContain('4 fire');
    expect(msg.subject).toContain('24h');
    expect(msg.text).toContain('kanban');
    expect(msg.html).toContain('<table');
    store.close();
  });
});
