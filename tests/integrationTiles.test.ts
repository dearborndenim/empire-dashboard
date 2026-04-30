import {
  IntegrationTilesFetcher,
  loadIntegrationTilesConfig,
  IntegrationFetchImpl,
} from '../src/integrationTiles';

function fakeFetch(byUrl: Record<string, {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: boolean;
}>): { impl: IntegrationFetchImpl; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: IntegrationFetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const match = byUrl[url];
    if (!match) throw new Error(`unexpected url ${url}`);
    if (match.throws) throw new Error('network');
    return {
      ok: match.ok ?? true,
      status: match.status ?? 200,
      json: async () => match.body ?? {},
    };
  };
  return { impl, calls };
}

describe('loadIntegrationTilesConfig', () => {
  it('reads env vars into a config object', () => {
    const cfg = loadIntegrationTilesConfig({
      PO_RECEIVER_URL: 'https://po',
      PO_RECEIVER_API_KEY: 'a',
      KANBAN_URL: 'https://kb',
      KANBAN_API_KEY: 'b',
    });
    expect(cfg.poReceiverUrl).toBe('https://po');
    expect(cfg.poReceiverApiKey).toBe('a');
    expect(cfg.kanbanUrl).toBe('https://kb');
    expect(cfg.kanbanApiKey).toBe('b');
  });

  it('leaves entries undefined when env is empty', () => {
    const cfg = loadIntegrationTilesConfig({});
    expect(cfg.poReceiverUrl).toBeUndefined();
    expect(cfg.kanbanApiKey).toBeUndefined();
  });
});

describe('IntegrationTilesFetcher', () => {
  it('returns "Not configured" tiles when env is missing', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: {},
      fetchImpl: async () => { throw new Error('should not call fetch'); },
    });
    const tiles = await fetcher.getTiles();
    // 5 tiles: po-receiver, kanban, content-engine, scene-drift,
    // auto-pause-history (added 2026-04-29).
    expect(tiles).toHaveLength(5);
    expect(tiles.every((t) => t.state === 'not-configured')).toBe(true);
    for (const t of tiles) expect(t.summary).toBe('Not configured');
  });

  it('fetches PO receiver tile with success rate + dead-lettered count', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': {
        body: { success_rate: 0.987, dead_lettered: 3, total: 200 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po/', poReceiverApiKey: 'key' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const po = tiles.find((t) => t.id === 'po-receiver')!;
    expect(po.state).toBe('warn'); // dead-lettered > 0
    expect(po.summary).toContain('98.7%');
    expect(po.summary).toContain('3 dead-lettered');
    expect(fake.calls[0].headers['x-api-key']).toBe('key');
  });

  it('accepts both fraction and percent success_rate values', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': {
        body: { success_rate: 99.3, dead_lettered: 0 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const po = tiles.find((t) => t.id === 'po-receiver')!;
    expect(po.summary).toContain('99.3%');
    expect(po.state).toBe('ok');
  });

  it('fetches kanban tile with total_received + unmatched_count', async () => {
    const fake = fakeFetch({
      'https://kb/api/webhooks/po-receiver/stats': {
        body: { total_received: 42, unmatched_count: 2 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { kanbanUrl: 'https://kb', kanbanApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const kb = tiles.find((t) => t.id === 'kanban')!;
    expect(kb.state).toBe('warn');
    expect(kb.summary).toContain('42 received');
    expect(kb.summary).toContain('2 unmatched');
  });

  it('renders error tile when remote returns non-OK', async () => {
    const fake = fakeFetch({
      'https://kb/api/webhooks/po-receiver/stats': { ok: false, status: 500, body: {} },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { kanbanUrl: 'https://kb', kanbanApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const kb = tiles.find((t) => t.id === 'kanban')!;
    expect(kb.state).toBe('error');
    expect(kb.error).toContain('HTTP 500');
  });

  it('renders error tile when remote throws', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': { throws: true },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const po = tiles.find((t) => t.id === 'po-receiver')!;
    expect(po.state).toBe('error');
    expect(po.error).toContain('network');
  });

  it('caches responses for the TTL and refetches after expiry', async () => {
    let callCount = 0;
    const impl: IntegrationFetchImpl = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success_rate: 0.99, dead_lettered: 0 }),
      };
    };
    let t = 1_000_000;
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: impl,
      now: () => t,
      cacheTtlMs: 60_000,
    });
    await fetcher.getTiles();
    await fetcher.getTiles();
    await fetcher.getTiles();
    expect(callCount).toBe(1); // kanban is not-configured so only 1 fetch
    t += 61_000;
    await fetcher.getTiles();
    expect(callCount).toBe(2);
  });

  it('respects the force flag to bypass the cache', async () => {
    let callCount = 0;
    const impl: IntegrationFetchImpl = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success_rate: 1 }),
      };
    };
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: impl,
    });
    await fetcher.getTiles();
    await fetcher.getTiles({ force: true });
    expect(callCount).toBe(2);
  });

  it('marks tile as warn when success_rate is below 90%', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': {
        body: { success_rate: 0.72, dead_lettered: 0 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const po = tiles.find((t) => t.id === 'po-receiver')!;
    expect(po.state).toBe('warn');
  });

  it('returns "Not configured" content-engine tile when env missing', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: {},
      fetchImpl: async () => { throw new Error('should not fetch'); },
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce).toBeDefined();
    expect(ce.state).toBe('not-configured');
    expect(ce.summary).toBe('Not configured');
  });

  it('fetches content-engine prompt-quality tile w/ rejected_rate + avg score + top-3 scenes', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': {
        body: {
          rejected_count: 4,
          rejected_rate: 0.12,
          avg_quality_score: 0.78,
          scene_distribution: { suburban: 12, city: 5, beach: 3, mountain: 1 },
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('ok');
    expect(ce.summary).toContain('12.0% rejected');
    expect(ce.summary).toContain('avg 0.78');
    // top-3 scenes should be in details
    const labels = (ce.details ?? []).map((d) => d.label);
    expect(labels).toContain('suburban');
    expect(labels).toContain('city');
    expect(labels).toContain('beach');
    expect(labels).not.toContain('mountain');
    expect(fake.calls[0].headers['x-api-key']).toBe('ck');
  });

  it('marks content-engine tile as warn when rejected_rate > 20%', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': {
        body: { rejected_count: 100, rejected_rate: 0.3, avg_quality_score: 0.7 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('warn');
  });

  it('marks content-engine tile as warn when avg_quality_score below 0.6', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': {
        body: { rejected_count: 0, rejected_rate: 0, avg_quality_score: 0.4 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('warn');
  });

  it('content-engine error tile when remote is down', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': {
        ok: false,
        status: 502,
        body: {},
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('error');
    expect(ce.error).toContain('HTTP 502');
  });

  it('content-engine error tile on network throw', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { throws: true },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('error');
    expect(ce.error).toContain('network');
  });

  it('content-engine tile emits a summary of "no data" when body is empty', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const ce = tiles.find((t) => t.id === 'content-engine')!;
    expect(ce.state).toBe('ok');
    expect(ce.summary).toBe('no data');
  });

  it('attaches sparkline data from the resolver to each configured tile', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': {
        body: { success_rate: 0.99, dead_lettered: 0 },
      },
    });
    const calls: string[] = [];
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
      sparklineResolver: (id) => {
        calls.push(id);
        if (id !== 'po-receiver') return [];
        return [
          { date: '2026-04-19', successRate: 0.97, totalAttempts: 100 },
          { date: '2026-04-20', successRate: 0.99, totalAttempts: 120 },
        ];
      },
    });
    const tiles = await fetcher.getTiles();
    const po = tiles.find((t) => t.id === 'po-receiver')!;
    expect(po.sparkline).toHaveLength(2);
    expect(po.sparkline![1].successRate).toBeCloseTo(0.99);
    // Not-configured tiles don't invoke the resolver.
    expect(calls).toContain('po-receiver');
  });

  it('swallows resolver errors and still returns tiles', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': {
        body: { success_rate: 0.99, dead_lettered: 0 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
      sparklineResolver: () => { throw new Error('boom'); },
    });
    const tiles = await fetcher.getTiles();
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles[0].sparkline).toBeUndefined();
  });
});

describe('IntegrationTilesFetcher.fetchRawStats', () => {
  it('returns normalized success rates for configured integrations', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': {
        body: { success_rate: 98.5, total: 200 },
      },
      'https://kb/api/webhooks/po-receiver/stats': {
        body: { total_received: 10, unmatched_count: 1 },
      },
      'https://ce/api/integration/prompt-quality-stats': {
        body: { rejected_rate: 0.1, rejected_count: 5 },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: {
        poReceiverUrl: 'https://po',
        poReceiverApiKey: 'k',
        kanbanUrl: 'https://kb',
        kanbanApiKey: 'k2',
        contentEngineUrl: 'https://ce',
        contentEngineApiKey: 'k3',
      },
      fetchImpl: fake.impl,
    });
    const stats = await fetcher.fetchRawStats();
    expect(stats).toHaveLength(3);
    const po = stats.find((s) => s.integration === 'po-receiver')!;
    expect(po.successRate).toBeCloseTo(0.985);
    expect(po.totalAttempts).toBe(200);
    const kb = stats.find((s) => s.integration === 'kanban')!;
    expect(kb.successRate).toBeCloseTo(0.9, 2);
    expect(kb.totalAttempts).toBe(10);
    const ce = stats.find((s) => s.integration === 'content-engine')!;
    expect(ce.successRate).toBeCloseTo(0.9, 5);
    // total inferred from rejected_count / rejected_rate = 5/0.1 = 50
    expect(ce.totalAttempts).toBe(50);
  });

  it('skips integrations that have no env wiring', async () => {
    const fake = fakeFetch({});
    const fetcher = new IntegrationTilesFetcher({
      config: {},
      fetchImpl: fake.impl,
    });
    const stats = await fetcher.fetchRawStats();
    expect(stats).toHaveLength(0);
  });

  it('records error when a remote returns non-OK', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': { ok: false, status: 500, body: {} },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const stats = await fetcher.fetchRawStats();
    expect(stats[0].error).toContain('HTTP 500');
    expect(stats[0].successRate).toBeNull();
  });

  it('records error when a remote throws', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': { throws: true },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: fake.impl,
    });
    const stats = await fetcher.fetchRawStats();
    expect(stats[0].error).toBe('network');
  });
});

describe('loadIntegrationTilesConfig content-engine env', () => {
  it('reads CONTENT_ENGINE_URL + CONTENT_ENGINE_API_KEY', () => {
    const cfg = loadIntegrationTilesConfig({
      CONTENT_ENGINE_URL: 'https://ce',
      CONTENT_ENGINE_API_KEY: 'ck',
    });
    expect(cfg.contentEngineUrl).toBe('https://ce');
    expect(cfg.contentEngineApiKey).toBe('ck');
  });
});
