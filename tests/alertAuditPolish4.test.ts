import request from 'supertest';
import { createApp } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  buildPerActorDigests,
  renderAlertAuditDigestText,
  renderAlertAuditDigestHtml,
} from '../src/alertAuditDigest';
import {
  SavedViewCountCache,
  computeSavedViewCounts,
  parseAlertAuditQueryString,
} from '../src/savedViewCounts';

/**
 * 2026-04-28 — Alert audit polish 4:
 *   1. Rename saved views (PATCH/PUT) + count badges (60s cache)
 *   2. Per-actor digest "Your saved views" section (XSS-safe)
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

// ---------- Task 1a: rename happy path + 404 + 409 -----------------------

describe('alert audit saved views — PATCH rename', () => {
  it('renames a view in place and returns the updated row', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const created = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'old-name', query_string: 'days=7' });
    const id = created.body.id;

    const res = await request(app)
      .patch(`/alerts/audit/views/${id}`)
      .set('x-admin-token', 'tok')
      .send({ name: 'new-name' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.name).toBe('new-name');
    expect(res.body.query_string).toBe('days=7');

    // Confirm persistence.
    const list = store.listAlertAuditSavedViews();
    expect(list.find((v) => v.id === id)?.name).toBe('new-name');

    // PUT also works (alias).
    const put = await request(app)
      .put(`/alerts/audit/views/${id}`)
      .set('x-admin-token', 'tok')
      .send({ name: 'another' });
    expect(put.status).toBe(200);
    expect(put.body.name).toBe('another');

    store.close();
  });

  it('returns 404 for unknown id and 409 on duplicate name', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // 404 on no-such-view.
    const noSuch = await request(app)
      .patch('/alerts/audit/views/99999')
      .set('x-admin-token', 'tok')
      .send({ name: 'whatever' });
    expect(noSuch.status).toBe(404);
    expect(noSuch.body.error).toMatch(/not found/i);

    // 400 on missing name + non-numeric id.
    const a = await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'a', query_string: '' });
    const aId = a.body.id;
    const bad400 = await request(app)
      .patch(`/alerts/audit/views/${aId}`)
      .set('x-admin-token', 'tok')
      .send({});
    expect(bad400.status).toBe(400);
    const badId = await request(app)
      .patch('/alerts/audit/views/abc')
      .set('x-admin-token', 'tok')
      .send({ name: 'x' });
    expect(badId.status).toBe(400);

    // 409 on collision: rename `a` to an existing name.
    await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'b', query_string: '' });
    const dup = await request(app)
      .patch(`/alerts/audit/views/${aId}`)
      .set('x-admin-token', 'tok')
      .send({ name: 'b' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already exists/i);

    // Wrong token -> 401.
    const wrong = await request(app)
      .patch(`/alerts/audit/views/${aId}`)
      .set('x-admin-token', 'WRONG')
      .send({ name: 'x' });
    expect(wrong.status).toBe(401);

    store.close();
  });
});

// ---------- Task 1b: count-badge cache ----------------------------------

describe('SavedViewCountCache + computeSavedViewCounts', () => {
  it('memoizes count results within the TTL and re-computes after expiry', () => {
    let nowMs = 1_000_000;
    const cache = new SavedViewCountCache({ ttlMs: 60_000, now: () => nowMs });
    let calls = 0;
    const fakeStore = {
      countAlertAudits: () => {
        calls += 1;
        return 42;
      },
    };
    const views = [{ id: 1, name: 'foo', query_string: 'days=7' }];

    // First call -> compute (calls=1).
    const r1 = computeSavedViewCounts({ store: fakeStore, views, cache });
    expect(r1[0].count).toBe(42);
    expect(calls).toBe(1);

    // Second call within TTL -> cached (calls still 1).
    nowMs += 30_000;
    const r2 = computeSavedViewCounts({ store: fakeStore, views, cache });
    expect(r2[0].count).toBe(42);
    expect(calls).toBe(1);

    // Past TTL -> recomputes (calls=2).
    nowMs += 31_000;
    const r3 = computeSavedViewCounts({ store: fakeStore, views, cache });
    expect(r3[0].count).toBe(42);
    expect(calls).toBe(2);
  });

  it('returns count=null when countAlertAudits throws (does not crash)', () => {
    const cache = new SavedViewCountCache();
    const fakeStore = {
      countAlertAudits: () => {
        throw new Error('boom');
      },
    };
    const r = computeSavedViewCounts({
      store: fakeStore,
      views: [{ id: 1, name: 'foo', query_string: 'days=7' }],
      cache,
    });
    expect(r[0].count).toBeNull();
  });

  it('parseAlertAuditQueryString clamps days, drops bad decisions, caps actor', () => {
    expect(parseAlertAuditQueryString('days=7')).toEqual({ days: 7 });
    // Invalid decision is dropped.
    expect(parseAlertAuditQueryString('decision=hax&days=14')).toEqual({ days: 14 });
    // Days clamped >= 1, <= 30.
    expect(parseAlertAuditQueryString('days=999').days).toBe(30);
    expect(parseAlertAuditQueryString('days=-5').days).toBe(7);
    // Actor capped at 64 chars.
    const long = 'a'.repeat(200);
    const out = parseAlertAuditQueryString(`actor=${long}&days=7`);
    expect(out.actor!.length).toBe(64);
    // Leading "?" tolerated.
    expect(parseAlertAuditQueryString('?integration=kanban&decision=fire&days=7')).toEqual({
      integration: 'kanban',
      decision: 'fire',
      days: 7,
    });
  });
});

// ---------- Task 1c: count badge appears on /alerts/audit ----------------

describe('saved-views sidebar count badges', () => {
  it('renders (N) badges per saved view on /alerts/audit', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Seed two fired audit rows on `kanban`.
    const baseIso = new Date().toISOString();
    for (let i = 0; i < 2; i++) {
      store.recordAlertAudit({
        at: baseIso,
        integration_name: 'kanban',
        outcome: 'fired',
        reason: `f${i}`,
        severity: 'warning',
        success_rate: 0.5,
        actor: 'monitor',
      });
    }
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    await request(app)
      .post('/alerts/audit/views')
      .set('x-admin-token', 'tok')
      .send({ name: 'kanban-7d', query_string: 'integration=kanban&days=7' });

    const audit = await request(app).get('/alerts/audit').set('x-admin-token', 'tok');
    expect(audit.status).toBe(200);
    expect(audit.text).toContain('alert-audit__saved-view-count');
    // Match count is 2 — the two fired rows above. Render is "(2)".
    expect(audit.text).toMatch(/alert-audit__saved-view-count[^>]*>\(\d+\)/);
    store.close();
  });
});

// ---------- Task 2: per-actor digest saved-views section -----------------

function seedActorRows(store: SqliteHistoryStore): void {
  const iso = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    store.recordAlertAudit({
      at: iso,
      integration_name: 'kanban',
      outcome: 'fired',
      reason: `m${i}`,
      severity: 'warning',
      success_rate: 0.5,
      actor: 'monitor',
    });
  }
  for (let i = 0; i < 2; i++) {
    store.recordAlertAudit({
      at: iso,
      integration_name: 'po-receiver',
      outcome: 'fired',
      reason: `c${i}`,
      severity: 'warning',
      success_rate: 0.5,
      actor: 'cli',
    });
  }
}

describe('per-actor digest — saved views section', () => {
  it('attaches a savedViews rollup to every per-actor payload when includeSavedViews=true', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedActorRows(store);
    store.createAlertAuditSavedView('kanban-7d', 'integration=kanban&days=7');
    store.createAlertAuditSavedView('all-fires-1d', 'decision=fire&days=1');

    const payloads = buildPerActorDigests({ store, includeSavedViews: true });
    expect(payloads.length).toBe(2);
    for (const p of payloads) {
      expect(p.data.savedViews).toBeDefined();
      const names = p.data.savedViews!.map((v) => v.name).sort();
      expect(names).toEqual(['all-fires-1d', 'kanban-7d']);
      // kanban-7d filter matches the 3 monitor-fires on `kanban`.
      const kanbanRow = p.data.savedViews!.find((v) => v.name === 'kanban-7d');
      expect(kanbanRow!.count).toBe(3);
    }
    store.close();
  });

  it('omits savedViews when includeSavedViews is not set (legacy back-compat)', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedActorRows(store);
    store.createAlertAuditSavedView('kanban-7d', 'integration=kanban&days=7');
    const payloads = buildPerActorDigests({ store });
    for (const p of payloads) {
      expect(p.data.savedViews).toBeUndefined();
    }
    store.close();
  });

  it('renderers escape user-supplied saved-view names (XSS-safe)', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedActorRows(store);
    // Adversarial name with HTML special chars.
    store.createAlertAuditSavedView('<script>alert(1)</script>', 'days=7');
    const payloads = buildPerActorDigests({ store, includeSavedViews: true });
    const data = payloads[0].data;
    // Plain text — no HTML escaping needed but the literal string survives.
    const text = renderAlertAuditDigestText(data);
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('Your saved views');
    // HTML — must be escaped.
    const html = renderAlertAuditDigestHtml(data);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Your saved views');
    store.close();
  });

  it('renderers handle empty saved-view list with a friendly placeholder', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedActorRows(store);
    const payloads = buildPerActorDigests({ store, includeSavedViews: true });
    const data = payloads[0].data;
    expect(data.savedViews).toEqual([]);
    const text = renderAlertAuditDigestText(data);
    expect(text).toContain('Your saved views');
    expect(text).toContain('(no saved views configured)');
    const html = renderAlertAuditDigestHtml(data);
    expect(html).toContain('Your saved views');
    expect(html).toContain('no saved views configured');
    store.close();
  });
});
