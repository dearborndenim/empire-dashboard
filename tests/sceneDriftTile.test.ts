import {
  IntegrationTilesFetcher,
  IntegrationFetchImpl,
  computeDriftSeverity,
} from '../src/integrationTiles';

function fakeFetch(byUrl: Record<string, {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: boolean;
}>): { impl: IntegrationFetchImpl } {
  const impl: IntegrationFetchImpl = async (url) => {
    const match = byUrl[url];
    if (!match) throw new Error(`unexpected url ${url}`);
    if (match.throws) throw new Error('network');
    return {
      ok: match.ok ?? true,
      status: match.status ?? 200,
      json: async () => match.body ?? {},
    };
  };
  return { impl };
}

describe('scene-drift tile', () => {
  it('returns "Not configured" when content-engine env missing', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: {},
      fetchImpl: async () => { throw new Error('should not fetch'); },
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd).toBeDefined();
    expect(sd.state).toBe('not-configured');
    expect(sd.title).toBe('Scene Distribution Drift');
  });

  it('surfaces top over-represented scenes with z-score + days-since-last-flag in details', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': {
        body: {
          scenes: [
            { scene: 'suburban', z_score: 2.6, count: 40, expected: 20, days_since_last_flag: 1 },
            { scene: 'beach', z_score: 0.1, count: 15, expected: 14, days_since_last_flag: 30 },
            { scene: 'mountain', z_score: -1.5, count: 3, expected: 10, days_since_last_flag: null },
            { scene: 'city', z_score: 1.4, count: 25, expected: 18, days_since_last_flag: 7 },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.state).toBe('warn');
    expect(sd.summary).toContain('3 over-represented'); // suburban, beach, city
    const labels = (sd.details ?? []).map((d) => d.label);
    // suburban should come first (highest severity: z=2.6 and 1d ago → recent repeat).
    expect(labels[0]).toBe('suburban');
    expect(sd.details![0].value).toMatch(/z=2\.60/);
    expect(sd.details![0].value).toMatch(/1d ago/);
    // under-represented (z<0) never appears.
    expect(labels).not.toContain('mountain');
  });

  it('returns ok + "All scenes balanced" summary when no positive z-scores', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': {
        body: {
          scenes: [
            { scene: 'suburban', z_score: -0.2, count: 5, expected: 8, days_since_last_flag: null },
            { scene: 'beach', z_score: 0.0, count: 8, expected: 8, days_since_last_flag: null },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.state).toBe('ok');
    expect(sd.summary).toBe('All scenes balanced');
    expect(sd.details ?? []).toHaveLength(0);
  });

  it('renders error tile when scene-drift remote returns non-OK', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': { ok: false, status: 503, body: {} },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.state).toBe('error');
    expect(sd.error).toContain('HTTP 503');
  });

  it('renders error tile on network throw', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': { throws: true },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.state).toBe('error');
    expect(sd.error).toContain('network');
  });

  it('severity weighting favours recent repeat offenders over older equivalent z-scores', () => {
    const recent = computeDriftSeverity({
      scene: 'a', zScore: 2, count: 10, expected: 5, daysSinceLastFlag: 1,
    });
    const old = computeDriftSeverity({
      scene: 'b', zScore: 2, count: 10, expected: 5, daysSinceLastFlag: 14,
    });
    const never = computeDriftSeverity({
      scene: 'c', zScore: 2, count: 10, expected: 5, daysSinceLastFlag: null,
    });
    expect(recent).toBeGreaterThan(old);
    expect(never).toBeCloseTo(2, 5);
    expect(recent).toBeGreaterThan(never);
  });
});
