import { snapshotIntegrationStats, toUtcDate } from '../src/integrationStatsJob';
import { SqliteHistoryStore } from '../src/historyStore';
import { IntegrationTilesFetcher, IntegrationFetchImpl } from '../src/integrationTiles';

describe('toUtcDate', () => {
  it('formats epoch ms as YYYY-MM-DD UTC', () => {
    const ts = Date.parse('2026-04-20T03:15:00.000Z');
    expect(toUtcDate(ts)).toBe('2026-04-20');
  });
});

describe('snapshotIntegrationStats', () => {
  function makeFetch(byUrl: Record<string, { ok?: boolean; status?: number; body?: unknown; throws?: boolean }>): IntegrationFetchImpl {
    return async (url) => {
      const m = byUrl[url];
      if (!m) throw new Error(`unexpected url ${url}`);
      if (m.throws) throw new Error('network-down');
      return {
        ok: m.ok ?? true,
        status: m.status ?? 200,
        json: async () => m.body ?? {},
      };
    };
  }

  it('records a snapshot row for each configured integration', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const fetcher = new IntegrationTilesFetcher({
      config: {
        poReceiverUrl: 'https://po',
        poReceiverApiKey: 'k',
        kanbanUrl: 'https://kb',
        kanbanApiKey: 'k2',
      },
      fetchImpl: makeFetch({
        'https://po/api/integration/webhook-status': {
          body: { success_rate: 0.97, total: 150 },
        },
        'https://kb/api/webhooks/po-receiver/stats': {
          body: { total_received: 20, unmatched_count: 2 },
        },
      }),
    });

    const silent = { log: () => {}, error: () => {} };
    const now = Date.parse('2026-04-20T03:00:00.000Z');
    const result = await snapshotIntegrationStats({
      store,
      fetcher,
      now: () => now,
      logger: silent,
    });
    expect(result.recorded).toHaveLength(2);
    const poRows = store.listIntegrationStats('po-receiver', 30, now);
    expect(poRows).toHaveLength(1);
    expect(poRows[0].date).toBe('2026-04-20');
    expect(poRows[0].success_rate).toBeCloseTo(0.97);
    expect(poRows[0].total_attempts).toBe(150);

    const kbRows = store.listIntegrationStats('kanban', 30, now);
    expect(kbRows).toHaveLength(1);
    expect(kbRows[0].success_rate).toBeCloseTo(0.9, 2);
    store.close();
  });

  it('skips integrations whose remote errored', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const fetcher = new IntegrationTilesFetcher({
      config: {
        poReceiverUrl: 'https://po',
        poReceiverApiKey: 'k',
      },
      fetchImpl: makeFetch({
        'https://po/api/integration/webhook-status': { throws: true },
      }),
    });
    const silent = { log: () => {}, error: () => {} };
    const result = await snapshotIntegrationStats({
      store,
      fetcher,
      logger: silent,
    });
    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].integration).toBe('po-receiver');
    expect(result.skipped[0].reason).toBe('network-down');
    store.close();
  });

  it('upserts so running twice on the same day does not create dupes', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: makeFetch({
        'https://po/api/integration/webhook-status': {
          body: { success_rate: 0.95, total: 100 },
        },
      }),
    });
    const silent = { log: () => {}, error: () => {} };
    const now = Date.parse('2026-04-20T03:00:00.000Z');
    await snapshotIntegrationStats({ store, fetcher, now: () => now, logger: silent });
    await snapshotIntegrationStats({ store, fetcher, now: () => now + 60_000, logger: silent });
    const rows = store.listIntegrationStats('po-receiver', 7, now);
    expect(rows).toHaveLength(1);
    store.close();
  });

  it('records empty result when no integrations configured', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const fetcher = new IntegrationTilesFetcher({ config: {} });
    const silent = { log: () => {}, error: () => {} };
    const result = await snapshotIntegrationStats({ store, fetcher, logger: silent });
    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    store.close();
  });

  it('logs a summary line via the injected logger', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: makeFetch({
        'https://po/api/integration/webhook-status': {
          body: { success_rate: 0.95, total: 100 },
        },
      }),
    });
    const logs: string[] = [];
    const logger = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
    };
    await snapshotIntegrationStats({ store, fetcher, logger });
    expect(logs.join('\n')).toMatch(/integration stats snapshot/);
    expect(logs.join('\n')).toMatch(/recorded=1 skipped=0/);
    store.close();
  });

  it('surfaces store.recordIntegrationStat errors as skipped', async () => {
    const fetcher = new IntegrationTilesFetcher({
      config: { poReceiverUrl: 'https://po', poReceiverApiKey: 'k' },
      fetchImpl: makeFetch({
        'https://po/api/integration/webhook-status': {
          body: { success_rate: 0.9, total: 10 },
        },
      }),
    });
    const mockStore = {
      recordIntegrationStat: () => {
        throw new Error('db-locked');
      },
    } as unknown as SqliteHistoryStore;
    const silent = { log: () => {}, error: () => {} };
    const result = await snapshotIntegrationStats({
      store: mockStore,
      fetcher,
      logger: silent,
    });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('db-locked');
  });
});
