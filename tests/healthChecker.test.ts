import { HealthChecker, FetchLike } from '../src/healthChecker';

function fakeFetch(
  responses: Array<{ ok: boolean; status: number } | Error>,
): { fn: FetchLike; calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const fn: FetchLike = async (input) => {
    calls.push(input);
    const next = responses[i++];
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

describe('HealthChecker.resolveUrl', () => {
  const checker = new HealthChecker();

  it('returns null when url is missing', () => {
    expect(checker.resolveUrl({ name: 'x', repo: 'o/x' })).toBeNull();
  });

  it('appends /health by default', () => {
    expect(checker.resolveUrl({ name: 'x', repo: 'o/x', url: 'https://x' })).toBe(
      'https://x/health',
    );
  });

  it('strips trailing slash', () => {
    expect(checker.resolveUrl({ name: 'x', repo: 'o/x', url: 'https://x/' })).toBe(
      'https://x/health',
    );
  });

  it('respects custom healthPath', () => {
    expect(
      checker.resolveUrl({ name: 'x', repo: 'o/x', url: 'https://x', healthPath: 'ping' }),
    ).toBe('https://x/ping');
  });
});

describe('HealthChecker.check', () => {
  it('returns unknown when no url is configured', async () => {
    const checker = new HealthChecker();
    const res = await checker.check({ name: 'nourl', repo: 'o/r' });
    expect(res.state).toBe('unknown');
    expect(res.error).toMatch(/no url/);
  });

  it('marks ok responses as up with latency', async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200 }]);
    let t = 1000;
    const checker = new HealthChecker({
      fetchImpl: fn,
      now: () => (t += 50),
    });
    const res = await checker.check({ name: 'A', repo: 'o/a', url: 'https://a' });
    expect(res.state).toBe('up');
    expect(res.statusCode).toBe(200);
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(calls[0]).toBe('https://a/health');
  });

  it('marks non-ok responses as down', async () => {
    const { fn } = fakeFetch([{ ok: false, status: 502 }]);
    const checker = new HealthChecker({ fetchImpl: fn });
    const res = await checker.check({ name: 'B', repo: 'o/b', url: 'https://b' });
    expect(res.state).toBe('down');
    expect(res.statusCode).toBe(502);
  });

  it('marks thrown errors as down', async () => {
    const { fn } = fakeFetch([new Error('ECONNREFUSED')]);
    const checker = new HealthChecker({ fetchImpl: fn });
    const res = await checker.check({ name: 'C', repo: 'o/c', url: 'https://c' });
    expect(res.state).toBe('down');
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it('caches within TTL and bypasses on force', async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200 },
      { ok: false, status: 500 },
    ]);
    const checker = new HealthChecker({
      fetchImpl: fn,
      cacheTtlSec: 60,
      now: () => 1000,
    });
    const a = await checker.check({ name: 'D', repo: 'o/d', url: 'https://d' });
    const b = await checker.check({ name: 'D', repo: 'o/d', url: 'https://d' });
    expect(a).toEqual(b);
    expect(calls.length).toBe(1);

    const c = await checker.check({ name: 'D', repo: 'o/d', url: 'https://d' }, { force: true });
    expect(c.state).toBe('down');
    expect(calls.length).toBe(2);
  });

  it('expires cache when now() passes TTL', async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ]);
    let t = 0;
    const checker = new HealthChecker({
      fetchImpl: fn,
      cacheTtlSec: 1,
      now: () => t,
    });
    await checker.check({ name: 'E', repo: 'o/e', url: 'https://e' });
    t = 5000; // beyond 1s TTL
    await checker.check({ name: 'E', repo: 'o/e', url: 'https://e' });
    expect(calls.length).toBe(2);
  });

  it('checks many apps in parallel', async () => {
    const { fn } = fakeFetch([
      { ok: true, status: 200 },
      { ok: false, status: 500 },
    ]);
    const checker = new HealthChecker({ fetchImpl: fn });
    const results = await checker.checkAll([
      { name: 'A', repo: 'o/a', url: 'https://a' },
      { name: 'B', repo: 'o/b', url: 'https://b' },
    ]);
    expect(results.map((r) => r.state)).toEqual(['up', 'down']);
  });
});
