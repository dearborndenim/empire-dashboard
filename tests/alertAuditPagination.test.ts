import request from 'supertest';
import { createApp, ALERT_AUDIT_PAGE_SIZE } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';
import {
  buildAlertAuditPageHref,
  renderRecentAlertActivityTile,
} from '../src/render';

/**
 * 2026-04-25 — Task 3
 *   Alert audit pagination + homepage "Recent alert activity (7d)" tile.
 *
 * Covers:
 *   - offset pagination boundary cases (offset=0, mid, last page, past end)
 *   - filter persistence across paginated Prev/Next links
 *   - homepage tile rendering (rows, top-5 cap, link click-through)
 *   - tile state transitions (ok → warn when any fire decision present)
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

function seedManyAudits(store: SqliteHistoryStore, count: number, integration = 'kanban'): void {
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    store.recordAlertAudit({
      // Newer rows first by id (insertion order). `at` deterministic.
      at: new Date(base - i * 1000).toISOString(),
      integration_name: integration,
      outcome: i % 3 === 0 ? 'fired' : 'suppressed',
      reason: i % 3 === 0 ? `fire row ${i}` : `cooldown row ${i}`,
      severity: i % 3 === 0 ? 'warning' : null,
      success_rate: 0.5,
    });
  }
}

describe('Alert audit pagination — offset query param', () => {
  it('paginates past the per-page cap with ?offset=N', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Seed 240 rows so we have 3 full pages at pageSize=100.
    seedManyAudits(store, 240);
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // Page 1 (offset=0).
    const r1 = await request(app)
      .get('/alerts/audit')
      .set('x-admin-token', 'tok');
    expect(r1.status).toBe(200);
    expect(r1.text).toContain('Page 1 of 3');
    expect(r1.text).toContain('showing rows 1-100 of 240');
    // Prev should be disabled on page 1.
    expect(r1.text).toMatch(/alert-audit__page--disabled[^>]*aria-disabled="true"[^<]*&larr; Prev/);
    // Next link should exist with offset=100.
    expect(r1.text).toContain('href="/alerts/audit?days=7&amp;offset=100"');
    // Page 2 (offset=100).
    const r2 = await request(app)
      .get('/alerts/audit?offset=100')
      .set('x-admin-token', 'tok');
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('Page 2 of 3');
    expect(r2.text).toContain('showing rows 101-200 of 240');
    // Both Prev and Next active on page 2.
    expect(r2.text).toContain('href="/alerts/audit?days=7"');
    expect(r2.text).toContain('href="/alerts/audit?days=7&amp;offset=200"');
    // Page 3 (offset=200) — last page, only 40 rows.
    const r3 = await request(app)
      .get('/alerts/audit?offset=200')
      .set('x-admin-token', 'tok');
    expect(r3.status).toBe(200);
    expect(r3.text).toContain('Page 3 of 3');
    expect(r3.text).toContain('showing rows 201-240 of 240');
    expect(r3.text).toContain('href="/alerts/audit?days=7&amp;offset=100"');
    // Next should be disabled on the last page.
    expect(r3.text).toMatch(/alert-audit__page--disabled[^>]*aria-disabled="true"[^<]*Next &rarr;/);
    // Past-end (offset=500) — no rows on page, total still shown.
    const r4 = await request(app)
      .get('/alerts/audit?offset=500')
      .set('x-admin-token', 'tok');
    expect(r4.status).toBe(200);
    expect(r4.text).toContain('No rows on this page (offset 500 of 240 total)');
    store.close();
  });

  it('omits the pagination nav entirely when totalMatched <= pageSize', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedManyAudits(store, 5);
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    const res = await request(app)
      .get('/alerts/audit')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('alert-audit__pagination');
    expect(res.text).toContain('5 rows matched.');
    store.close();
  });

  it('clamps invalid/negative offset to 0 (page 1) and very-large offsets render an out-of-range page', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedManyAudits(store, 150);
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // Negative offset → clamped to 0 → page 1.
    const r1 = await request(app)
      .get('/alerts/audit?offset=-50')
      .set('x-admin-token', 'tok');
    expect(r1.status).toBe(200);
    expect(r1.text).toContain('Page 1 of 2');
    // Garbage offset → 0.
    const r2 = await request(app)
      .get('/alerts/audit?offset=banana')
      .set('x-admin-token', 'tok');
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('Page 1 of 2');
    // Confirm the constant is the one we expect.
    expect(ALERT_AUDIT_PAGE_SIZE).toBe(100);
    store.close();
  });
});

describe('Alert audit pagination — filter persistence across paginated links', () => {
  it('preserves integration + decision + days filters in Prev/Next hrefs', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Seed 250 fire-only rows for a single integration so all 3 pages exist
    // when integration+decision filters are applied.
    const base = Date.now();
    for (let i = 0; i < 250; i++) {
      store.recordAlertAudit({
        at: new Date(base - i * 1000).toISOString(),
        integration_name: 'po-receiver',
        outcome: 'fired',
        reason: `fire ${i}`,
        severity: 'warning',
        success_rate: 0.4,
      });
    }
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
      incidentsAdminToken: 'tok',
    });
    // Page 2 with all three filters set.
    const res = await request(app)
      .get('/alerts/audit?integration=po-receiver&decision=fire&days=14&offset=100')
      .set('x-admin-token', 'tok');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Page 2 of 3');
    // Prev href back to page 1 (offset omitted since 0).
    expect(res.text).toContain(
      'href="/alerts/audit?days=14&amp;integration=po-receiver&amp;decision=fire"',
    );
    // Next href to page 3 with offset=200 + filters preserved.
    expect(res.text).toContain(
      'href="/alerts/audit?days=14&amp;integration=po-receiver&amp;decision=fire&amp;offset=200"',
    );
    store.close();
  });

  it('buildAlertAuditPageHref handles all filter shapes deterministically', () => {
    expect(
      buildAlertAuditPageHref(
        { integration: '', decision: '', days: 7 },
        0,
      ),
    ).toBe('/alerts/audit?days=7');
    expect(
      buildAlertAuditPageHref(
        { integration: 'kanban', decision: 'fire', days: 30 },
        100,
      ),
    ).toBe('/alerts/audit?days=30&integration=kanban&decision=fire&offset=100');
    // Special chars in integration name are URL-escaped.
    expect(
      buildAlertAuditPageHref(
        { integration: 'po receiver/v2', decision: '', days: 1 },
        0,
      ),
    ).toBe('/alerts/audit?days=1&integration=po%20receiver%2Fv2');
  });
});

describe('Recent alert activity tile — homepage', () => {
  it('renders the empty-state ok tile when no audits in window', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
    });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Recent alert activity (7d)');
    expect(res.text).toContain('recent-alert-activity--ok');
    expect(res.text).toContain('No alert activity in the last 7 days');
    expect(res.text).not.toContain('recent-alert-activity__item');
    store.close();
  });

  it('renders top-5 by total + click-through links + warn state when fires present', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = Date.now();
    // Seed a mix: 6 distinct integrations, varying volumes, varying outcomes.
    const seed = (name: string, total: number, fires: number) => {
      for (let i = 0; i < total; i++) {
        store.recordAlertAudit({
          at: new Date(now - i * 60_000).toISOString(),
          integration_name: name,
          outcome: i < fires ? 'fired' : 'suppressed',
          reason: i < fires ? `fire ${i}` : 'cooldown',
          severity: i < fires ? 'warning' : null,
          success_rate: 0.5,
        });
      }
    };
    seed('kanban', 30, 2);
    seed('po-receiver', 20, 0);
    seed('content-engine', 15, 1);
    seed('mcsecretary', 10, 0);
    seed('dda', 5, 0);
    // 6th integration — should NOT render (cap to 5).
    seed('zzz-extra', 1, 0);
    const app = createApp({
      ...buildDeps(),
      historyStore: store,
    });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    // Tile in warn state because kanban + content-engine have fires.
    expect(res.text).toContain('recent-alert-activity--warn');
    expect(res.text).toContain('recent-alert-activity__state--warn');
    // Top 5 by total: kanban(30), po-receiver(20), content-engine(15), mcsecretary(10), dda(5).
    expect(res.text).toContain('href="/alerts/audit?integration=kanban&amp;days=7"');
    expect(res.text).toContain('href="/alerts/audit?integration=po-receiver&amp;days=7"');
    expect(res.text).toContain('href="/alerts/audit?integration=content-engine&amp;days=7"');
    expect(res.text).toContain('href="/alerts/audit?integration=mcsecretary&amp;days=7"');
    expect(res.text).toContain('href="/alerts/audit?integration=dda&amp;days=7"');
    // 6th integration omitted by top-5 cap.
    expect(res.text).not.toContain('zzz-extra');
    // Fire badge surfaces fire counts.
    expect(res.text).toContain('30 audits · 2 fires');
    expect(res.text).toContain('15 audits · 1 fire');
    // Quiet badge for the 0-fire row.
    expect(res.text).toContain('20 audits<');
    store.close();
  });
});

describe('Recent alert activity tile — state transitions (unit)', () => {
  it('returns ok state when undefined / empty / all-zero-fires', () => {
    const html1 = renderRecentAlertActivityTile(undefined);
    expect(html1).toContain('recent-alert-activity--ok');
    expect(html1).toContain('No alert activity');

    const html2 = renderRecentAlertActivityTile([]);
    expect(html2).toContain('recent-alert-activity--ok');

    const html3 = renderRecentAlertActivityTile([
      { integration_name: 'kanban', total: 12, fire_count: 0 },
      { integration_name: 'po-receiver', total: 8, fire_count: 0 },
    ]);
    expect(html3).toContain('recent-alert-activity--ok');
    expect(html3).toContain('recent-alert-activity__state--ok');
    expect(html3).not.toContain('recent-alert-activity--warn');
  });

  it('promotes to warn state when any row has fire_count > 0', () => {
    const html = renderRecentAlertActivityTile([
      { integration_name: 'kanban', total: 5, fire_count: 0 },
      { integration_name: 'po-receiver', total: 3, fire_count: 1 },
    ]);
    expect(html).toContain('recent-alert-activity--warn');
    expect(html).toContain('recent-alert-activity__state--warn');
    expect(html).toContain('recent-alert-activity__badge--fire');
  });

  it('caps to top 5 rows even if more are passed', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      integration_name: `int-${i}`,
      total: 10 - i,
      fire_count: 0,
    }));
    const html = renderRecentAlertActivityTile(rows);
    expect(html).toContain('int-0');
    expect(html).toContain('int-4');
    expect(html).not.toContain('int-5');
    expect(html).not.toContain('int-7');
  });

  it('escapes integration names in links and labels (XSS guard)', () => {
    const html = renderRecentAlertActivityTile([
      { integration_name: '<script>alert(1)</script>', total: 1, fire_count: 0 },
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('historyStore.alertActivitySummary — direct unit', () => {
  it('returns per-integration counts sorted by total desc, capped to limit', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const now = Date.now();
    const insert = (name: string, outcome: 'fired' | 'suppressed', offsetMs: number) => {
      store.recordAlertAudit({
        at: new Date(now - offsetMs).toISOString(),
        integration_name: name,
        outcome,
        reason: 'r',
        severity: outcome === 'fired' ? 'warning' : null,
        success_rate: 0.5,
      });
    };
    // kanban: 4 audits (2 fired)
    insert('kanban', 'fired', 1000);
    insert('kanban', 'fired', 2000);
    insert('kanban', 'suppressed', 3000);
    insert('kanban', 'suppressed', 4000);
    // po-receiver: 1 audit (0 fired)
    insert('po-receiver', 'suppressed', 5000);
    // out-of-window (older than 7 days) should not count
    insert('kanban', 'fired', 8 * 86400_000);

    const rows = store.alertActivitySummary({ days: 7, limit: 5 });
    expect(rows).toEqual([
      { integration_name: 'kanban', total: 4, fire_count: 2 },
      { integration_name: 'po-receiver', total: 1, fire_count: 0 },
    ]);
    // Limit clamp.
    const top1 = store.alertActivitySummary({ days: 7, limit: 1 });
    expect(top1).toHaveLength(1);
    expect(top1[0].integration_name).toBe('kanban');
    store.close();
  });
});
