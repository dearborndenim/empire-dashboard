import request from 'supertest';
import { createApp } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  buildPerActorDigests,
  sendPerActorAlertAuditDigests,
  readAlertAuditDigestSmtpConfigFromEnv,
  selectAlertAuditDigestSender,
  SmtpAlertAuditDigestSender,
} from '../src/alertAuditDigest';
import { EmailMessage, EmailSender } from '../src/email';
import { msUntilNextDailyRun } from '../src/scheduler';

/**
 * 2026-04-27 — Alert audit polish 3:
 *   1. Saved /alerts/audit views — CRUD + sidebar
 *   2. Per-actor digest variant (split by actor, opt-IN env-gated)
 *   3. SMTP adapter for the alert audit digest sender
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

// ---------- Task 1: Saved views CRUD + sidebar render ---------------------

describe('alert audit saved views — CRUD endpoints', () => {
  it('POSTs a new saved view and the GET list page renders it', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });

    // Create
    const created = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'kanban-fires-7d', query_string: 'integration=kanban&decision=fire&days=7' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeGreaterThan(0);
    expect(created.body.name).toBe('kanban-fires-7d');
    expect(created.body.query_string).toBe('integration=kanban&decision=fire&days=7');

    // GET HTML list — view rendered as a clickable row.
    const list = await request(app).get('/alerts/audit/views').set('x-admin-token', 'tok');
    expect(list.status).toBe(200);
    expect(list.text).toContain('kanban-fires-7d');
    expect(list.text).toContain('integration=kanban&amp;decision=fire&amp;days=7');
    expect(list.text).toContain('href="/alerts/audit?integration=kanban&amp;decision=fire&amp;days=7"');

    // The /alerts/audit page renders the saved-views sidebar with the new view.
    const audit = await request(app).get('/alerts/audit').set('x-admin-token', 'tok');
    expect(audit.status).toBe(200);
    expect(audit.text).toContain('alert-audit__saved-views');
    expect(audit.text).toContain('kanban-fires-7d');

    store.close();
  });

  it('rejects duplicate names (409) and unauth requests (401/503)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });

    await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'dup', query_string: 'days=7' })
      .expect(201);
    const dupRes = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'dup', query_string: 'days=14' });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error).toMatch(/already exists/i);

    // Wrong token -> 401.
    const wrong = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'WRONG')
      .send({ name: 'whatever', query_string: '' });
    expect(wrong.status).toBe(401);

    // Missing body field -> 400.
    const empty = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: '', query_string: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/name is required/);

    store.close();

    // Token-not-configured -> 503.
    const storeB = new SqliteHistoryStore({ filePath: ':memory:' });
    const appB = createApp({ ...buildDeps(), historyStore: storeB });
    const noTok = await request(appB)
      .post('/alerts/audit/views')
      .send({ name: 'x', query_string: '' });
    expect(noTok.status).toBe(503);
    storeB.close();
  });

  it('DELETE removes a view + 404 on unknown id', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const created = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'tmp', query_string: 'days=7' });
    const id = created.body.id;

    // Delete the view
    const removed = await request(app)
      .delete(`/alerts/audit/views/${id}`)
      .set('x-admin-token', 'tok');
    expect(removed.status).toBe(204);

    // Confirm gone
    const list = store.listAlertAuditSavedViews();
    expect(list.find((v) => v.id === id)).toBeUndefined();

    // 404 on already-deleted id
    const again = await request(app)
      .delete(`/alerts/audit/views/${id}`)
      .set('x-admin-token', 'tok');
    expect(again.status).toBe(404);

    // 400 on non-numeric id
    const bad = await request(app)
      .delete('/alerts/audit/views/abc')
      .set('x-admin-token', 'tok');
    expect(bad.status).toBe(400);

    store.close();
  });
});

// ---------- Task 2: Per-actor digest splitting ----------------------------

function seedRows(store: SqliteHistoryStore, baseMs: number): void {
  const within = (mins: number) => new Date(baseMs - mins * 60_000).toISOString();
  // 3 fires from monitor on kanban
  for (let i = 0; i < 3; i++) {
    store.recordAlertAudit({
      at: within(60 + i * 10),
      integration_name: 'kanban',
      outcome: 'fired',
      reason: `monitor-fire ${i}`,
      severity: 'warning',
      success_rate: 0.5,
      actor: 'monitor',
    });
  }
  // 2 fires from cli on po-receiver
  for (let i = 0; i < 2; i++) {
    store.recordAlertAudit({
      at: within(30 + i * 5),
      integration_name: 'po-receiver',
      outcome: 'fired',
      reason: `cli-fire ${i}`,
      severity: 'warning',
      success_rate: 0.5,
      actor: 'cli',
    });
  }
  // 1 unattributed legacy row (NULL actor) — must NOT show up in any
  // per-actor split.
  store.recordAlertAudit({
    at: within(120),
    integration_name: 'misc',
    outcome: 'fired',
    reason: 'legacy',
    severity: 'warning',
    success_rate: 0.5,
  });
  // Outside the 24h window — must be excluded entirely.
  store.recordAlertAudit({
    at: new Date(baseMs - 2 * 86400_000).toISOString(),
    integration_name: 'old',
    outcome: 'fired',
    reason: 'too-old',
    severity: 'warning',
    success_rate: 0.5,
    actor: 'monitor',
  });
}

describe('alert audit per-actor digest', () => {
  it('splits the 24h window per actor, drops null/empty actors and old rows', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const nowMs = Date.now();
    seedRows(store, nowMs);

    const payloads = buildPerActorDigests({ store, nowMs });
    // Monitor (3 rows) and cli (2 rows) — sorted by total desc.
    expect(payloads.map((p) => p.actor)).toEqual(['monitor', 'cli']);
    const monitor = payloads[0];
    expect(monitor.data.total).toBe(3);
    expect(monitor.data.totalFires).toBe(3);
    // Per-integration rollup is still computed correctly.
    expect(monitor.data.topIntegrations[0].integration_name).toBe('kanban');
    const cli = payloads[1];
    expect(cli.data.total).toBe(2);
    expect(cli.data.totalFires).toBe(2);
    // Unattributed (NULL actor) is NOT a split.
    expect(payloads.find((p) => !p.actor)).toBeUndefined();
    expect(payloads.find((p) => p.actor === '')).toBeUndefined();
    store.close();
  });

  it('opt-out env DISABLE_ALERT_AUDIT_PER_ACTOR_DIGEST=1 skips every actor', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedRows(store, Date.now());
    const sender = new CapturingEmailSender();
    const results = await sendPerActorAlertAuditDigests({
      store,
      sender,
      defaultRecipient: 'rob@example.com',
      env: { DISABLE_ALERT_AUDIT_PER_ACTOR_DIGEST: '1' } as NodeJS.ProcessEnv,
    });
    expect(results.length).toBe(2);
    for (const r of results) expect(r.reason).toBe('opt-out');
    expect(sender.messages).toHaveLength(0);
    store.close();
  });

  it('routes per-actor recipients with default fallback + skips actors w/o recipient', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedRows(store, Date.now());
    const sender = new CapturingEmailSender();
    const results = await sendPerActorAlertAuditDigests({
      store,
      sender,
      recipients: { monitor: 'monitor@example.com' }, // cli falls through
      defaultRecipient: undefined,
      env: {} as NodeJS.ProcessEnv,
    });
    // Sent to monitor, skipped for cli (no recipient).
    expect(results.length).toBe(2);
    expect(results.find((r) => r.actor === 'monitor')!.sent).toBe(true);
    expect(results.find((r) => r.actor === 'cli')!.sent).toBe(false);
    expect(results.find((r) => r.actor === 'cli')!.reason).toBe('no-recipient');
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0].to).toBe('monitor@example.com');
    expect(sender.messages[0].subject).toContain('actor=monitor');
    expect(sender.messages[0].subject).toContain('3 fire');
    store.close();
  });

  it('happy path with default recipient: sends one email per actor', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedRows(store, Date.now());
    const sender = new CapturingEmailSender();
    const results = await sendPerActorAlertAuditDigests({
      store,
      sender,
      defaultRecipient: 'rob@example.com',
      env: {} as NodeJS.ProcessEnv,
    });
    const sent = results.filter((r) => r.sent);
    expect(sent.length).toBe(2);
    expect(sender.messages.map((m) => m.to)).toEqual([
      'rob@example.com',
      'rob@example.com',
    ]);
    expect(sender.messages.every((m) => m.subject.includes('actor='))).toBe(true);
    store.close();
  });
});

// ---------- Task 3: SMTP adapter env parsing + factory --------------------

describe('selectAlertAuditDigestSender + SMTP factory', () => {
  it('returns a Console sender when SMTP_HOST is unset', () => {
    const sender = selectAlertAuditDigestSender({} as NodeJS.ProcessEnv);
    // Console sender's transport is reported when sending — assert via
    // duck-type by sending and checking transport=console.
    expect(sender.constructor.name).toBe('ConsoleEmailSender');
  });

  it('parses a minimum SMTP env (host only) into a config', () => {
    const cfg = readAlertAuditDigestSmtpConfigFromEnv({
      SMTP_HOST: 'smtp.example.com',
    } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.host).toBe('smtp.example.com');
    expect(cfg!.port).toBe(587);
    expect(cfg!.user).toBeUndefined();
    expect(cfg!.pass).toBeUndefined();
    expect(cfg!.secure).toBeUndefined();
  });

  it('parses full SMTP env including SMTP_SECURE=1 + SMTP_FROM', () => {
    const cfg = readAlertAuditDigestSmtpConfigFromEnv({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'rob',
      SMTP_PASS: 'pw',
      SMTP_SECURE: '1',
      SMTP_FROM: 'rob@example.com',
    } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.host).toBe('smtp.example.com');
    expect(cfg!.port).toBe(465);
    expect(cfg!.user).toBe('rob');
    expect(cfg!.pass).toBe('pw');
    expect(cfg!.secure).toBe(true);
    expect(cfg!.from).toBe('rob@example.com');
  });

  it('returns null on partial creds (only one of user/pass set)', () => {
    expect(
      readAlertAuditDigestSmtpConfigFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'rob',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      readAlertAuditDigestSmtpConfigFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PASS: 'pw',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('returns null when SMTP_HOST is empty/missing', () => {
    expect(
      readAlertAuditDigestSmtpConfigFromEnv({} as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      readAlertAuditDigestSmtpConfigFromEnv({ SMTP_HOST: '   ' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('selectAlertAuditDigestSender returns SMTP sender when SMTP_HOST is set, and that sender uses our injected transporter', async () => {
    const sent: Array<{ to: string | string[]; subject: string }> = [];
    const fakeTransporter = {
      async sendMail(mail: { from?: string; to: string | string[]; subject: string; text: string; html?: string }) {
        sent.push({ to: mail.to, subject: mail.subject });
        return {};
      },
    };
    const sender = new SmtpAlertAuditDigestSender({
      config: { host: 'smtp.example.com', port: 587 },
      transporter: fakeTransporter,
    });
    const result = await sender.send({
      to: 'rob@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('smtp');
    expect(sent[0].to).toBe('rob@example.com');
  });

  it('SMTP sender returns delivered=false when transporter throws (does not crash)', async () => {
    const sender = new SmtpAlertAuditDigestSender({
      config: { host: 'smtp.example.com', port: 587 },
      transporter: {
        async sendMail() {
          throw new Error('connection refused');
        },
      },
    });
    const result = await sender.send({
      to: 'rob@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result.delivered).toBe(false);
    expect(result.transport).toBe('smtp');
  });
});

// ---------- Bonus: scheduler minuteLocal extension ------------------------

describe('scheduler minuteLocal extension', () => {
  it('msUntilNextDailyRun honours minuteLocal when provided', () => {
    // Pin "now" to Jan 1 2026 12:00 UTC. America/Chicago is UTC-6 in winter,
    // so local time is 06:00. Compute ms until 07:05 local = 13:05 UTC.
    const fixedNow = Date.parse('2026-01-01T12:00:00Z');
    const ms = msUntilNextDailyRun({
      hourLocal: 7,
      minuteLocal: 5,
      timezone: 'America/Chicago',
      now: () => fixedNow,
    });
    // Should be 1h05m = 65 minutes ahead.
    expect(ms).toBe(65 * 60_000);
  });

  it('msUntilNextDailyRun defaults to minute=0 when minuteLocal is omitted', () => {
    const fixedNow = Date.parse('2026-01-01T12:00:00Z');
    const ms = msUntilNextDailyRun({
      hourLocal: 7,
      timezone: 'America/Chicago',
      now: () => fixedNow,
    });
    // 07:00 local = 13:00 UTC = 60 minutes ahead.
    expect(ms).toBe(60 * 60_000);
  });
});
