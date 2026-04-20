import request from 'supertest';
import { createApp } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';
import { SqliteHistoryStore } from '../src/historyStore';

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

describe('POST /api/incidents/:id/note', () => {
  it('returns 503 when no history store is configured', async () => {
    const app = createApp({ ...buildDeps(), incidentsAdminToken: 't' });
    const res = await request(app)
      .post('/api/incidents/1/note')
      .set('x-admin-token', 't')
      .send({ note: 'hi' });
    expect(res.status).toBe(503);
  });

  it('returns 503 when no admin token is configured', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app)
      .post('/api/incidents/1/note')
      .send({ note: 'hi' });
    expect(res.status).toBe(503);
    store.close();
  });

  it('returns 401 when the admin token is wrong', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'r');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 'correct' });
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 'wrong')
      .send({ note: 'hi' });
    expect(res.status).toBe(401);
    store.close();
  });

  it('accepts Bearer token in the Authorization header', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'r');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 'tok' });
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('Authorization', 'Bearer tok')
      .send({ note: 'ok' });
    expect(res.status).toBe(201);
    expect(res.body.note.note).toBe('ok');
    store.close();
  });

  it('rejects invalid incident ids', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const res = await request(app)
      .post('/api/incidents/abc/note')
      .set('x-admin-token', 't')
      .send({ note: 'x' });
    expect(res.status).toBe(400);
    store.close();
  });

  it('rejects missing/blank note bodies', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'r');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 't')
      .send({ note: '   ' });
    expect(res.status).toBe(400);
    const res2 = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 't')
      .send({});
    expect(res2.status).toBe(400);
    store.close();
  });

  it('rejects notes longer than 2000 chars', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'r');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const big = 'x'.repeat(2001);
    const res = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 't')
      .send({ note: big });
    expect(res.status).toBe(400);
    store.close();
  });

  it('returns 404 for unknown incident ids', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const res = await request(app)
      .post('/api/incidents/9999/note')
      .set('x-admin-token', 't')
      .send({ note: 'x' });
    expect(res.status).toBe(404);
    store.close();
  });

  it('stores the note and surfaces it on subsequent GET /api/incidents', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 500');
    const app = createApp({ ...buildDeps(), historyStore: store, incidentsAdminToken: 't' });
    const post = await request(app)
      .post(`/api/incidents/${id}/note`)
      .set('x-admin-token', 't')
      .send({ note: 'restarted worker' });
    expect(post.status).toBe(201);
    const get = await request(app).get('/api/incidents');
    expect(get.status).toBe(200);
    expect(get.body.incidents[0].notes).toBeDefined();
    expect(get.body.incidents[0].notes[0].note).toBe('restarted worker');
    store.close();
  });

  it('renders notes in the recent-incidents panel on the HTML dashboard', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const id = store.openIncident('Alpha', new Date().toISOString(), 'HTTP 500');
    store.addIncidentNote(id, 'fixed by RM');
    const app = createApp({ ...buildDeps(), historyStore: store });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fixed by RM');
    store.close();
  });
});
