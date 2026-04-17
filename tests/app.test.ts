import request from 'supertest';
import { createApp, collectStatuses } from '../src/app';
import { HealthChecker, FetchLike } from '../src/healthChecker';
import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';
import { RuntimeConfig } from '../src/config';

function buildDeps(): { config: RuntimeConfig; healthChecker: HealthChecker; activityTracker: ActivityTracker } {
  const config: RuntimeConfig = {
    port: 0,
    githubOwner: 'dearborndenim',
    healthCacheTtlSec: 60,
    healthTimeoutMs: 5000,
    pollIntervalMs: 300000,
    apps: [
      { name: 'Alpha', repo: 'o/alpha', url: 'https://alpha' },
      { name: 'Beta', repo: 'o/beta', url: 'https://beta' },
    ],
  };

  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('alpha')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };
  const healthChecker = new HealthChecker({ fetchImpl, cacheTtlSec: 0 });

  const client: RepoCommitsClient = {
    listCommits: async ({ repo }) => ({
      data: [
        {
          sha: repo,
          commit: {
            author: { date: new Date().toISOString() },
            message: `${repo}-msg`,
          },
        },
      ],
    }),
  };
  const activityTracker = new ActivityTracker({ client, cacheTtlSec: 0 });

  return { config, healthChecker, activityTracker };
}

describe('collectStatuses', () => {
  it('combines health and activity per app', async () => {
    const deps = buildDeps();
    const results = await collectStatuses(deps, { force: true });
    expect(results.length).toBe(2);
    const alpha = results.find((r) => r.name === 'Alpha')!;
    const beta = results.find((r) => r.name === 'Beta')!;
    expect(alpha.color).toBe('green');
    expect(beta.color).toBe('red');
  });
});

describe('Express app', () => {
  it('GET /healthz returns ok', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/status returns statuses array', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/api/status?force=1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.statuses).toHaveLength(2);
    const names = res.body.statuses.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['Alpha', 'Beta']);
  });

  it('GET /api/status returns 500 when collect throws', async () => {
    const deps = buildDeps();
    deps.healthChecker.checkAll = async () => {
      throw new Error('boom');
    };
    const app = createApp(deps);
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });

  it('GET / renders an HTML page', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Empire Dashboard');
    expect(res.text).toContain('Alpha');
    expect(res.text).toContain('Beta');
  });

  it('GET / surfaces errors as HTML 500', async () => {
    const deps = buildDeps();
    deps.healthChecker.checkAll = async () => {
      throw new Error('bad');
    };
    const app = createApp(deps);
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
    expect(res.text).toContain('Dashboard error');
  });

  it('GET /styles.css serves static assets', async () => {
    const deps = buildDeps();
    const app = createApp(deps);
    const res = await request(app).get('/styles.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/css/);
    expect(res.text).toContain('.card');
  });
});
