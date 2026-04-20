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
    expect(tiles).toHaveLength(2);
    expect(tiles.every((t) => t.state === 'not-configured')).toBe(true);
    expect(tiles[0].summary).toBe('Not configured');
    expect(tiles[1].summary).toBe('Not configured');
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
});
