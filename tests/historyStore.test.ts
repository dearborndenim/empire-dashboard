import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteHistoryStore, ensureParentDir } from '../src/historyStore';

function makeStore(now: () => number = () => Date.now()): SqliteHistoryStore {
  return new SqliteHistoryStore({ filePath: ':memory:', now });
}

describe('ensureParentDir', () => {
  it('creates a missing parent directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empire-hist-'));
    const target = path.join(tmp, 'nested', 'deeper', 'history.db');
    try {
      ensureParentDir(target);
      expect(fs.existsSync(path.dirname(target))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is a noop for :memory:', () => {
    expect(() => ensureParentDir(':memory:')).not.toThrow();
  });

  it('is a noop for empty string', () => {
    expect(() => ensureParentDir('')).not.toThrow();
  });
});

describe('SqliteHistoryStore insert + read', () => {
  it('persists a sample and includes it in uptime computation', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 60_000).toISOString(),
      status: 'up',
      response_ms: 42,
    });
    expect(store.uptimePercent('A', 24, now)).toBe(100);
    store.close();
  });

  it('insertMany inserts rows in a single transaction', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    store.insertMany([
      { app_name: 'A', checked_at: new Date(now - 1_000).toISOString(), status: 'up' },
      { app_name: 'A', checked_at: new Date(now - 2_000).toISOString(), status: 'down' },
      { app_name: 'A', checked_at: new Date(now - 3_000).toISOString(), status: 'up' },
    ]);
    const pct = store.uptimePercent('A', 1, now);
    expect(pct).toBeCloseTo((2 / 3) * 100, 5);
    store.close();
  });
});

describe('SqliteHistoryStore.uptimePercent', () => {
  it('returns null when no samples exist in the window', () => {
    const store = makeStore();
    expect(store.uptimePercent('ghost', 168)).toBeNull();
    store.close();
  });

  it('computes 7-day uptime correctly', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    // 9 up, 1 down over the last 6 days => 90%
    for (let i = 0; i < 9; i++) {
      store.insert({
        app_name: 'A',
        checked_at: new Date(now - (i + 1) * 3600_000).toISOString(),
        status: 'up',
      });
    }
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 10 * 3600_000).toISOString(),
      status: 'down',
    });
    expect(store.uptimePercent('A', 24 * 7, now)).toBeCloseTo(90, 5);
    store.close();
  });

  it('excludes samples older than the window', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    // One old down outside window
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 30 * 24 * 3600_000).toISOString(),
      status: 'down',
    });
    // One recent up inside window
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 1_000).toISOString(),
      status: 'up',
    });
    expect(store.uptimePercent('A', 24 * 7, now)).toBe(100);
    store.close();
  });

  it('counts unknown status as non-up', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 1_000).toISOString(),
      status: 'up',
    });
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 2_000).toISOString(),
      status: 'unknown',
    });
    expect(store.uptimePercent('A', 24, now)).toBe(50);
    store.close();
  });
});

describe('SqliteHistoryStore.bucketLastNHours', () => {
  it('returns N buckets in chronological order', () => {
    const now = Date.parse('2026-04-17T12:00:00Z');
    const store = makeStore(() => now);
    const buckets = store.bucketLastNHours('A', 24, now);
    expect(buckets).toHaveLength(24);
    // All empty
    expect(buckets.every((b) => b.total === 0 && b.up === 0)).toBe(true);
    // Oldest first
    expect(Date.parse(buckets[0].hour)).toBeLessThan(Date.parse(buckets[23].hour));
    store.close();
  });

  it('buckets samples by hour correctly', () => {
    const now = Date.parse('2026-04-17T12:00:00Z');
    const store = makeStore(() => now);
    // Put 2 ups and 1 down in the hour 3h before now
    const threeHoursAgo = now - 3 * 3600_000 - 60_000;
    const twoHoursAgo = now - 2 * 3600_000 - 60_000;
    store.insertMany([
      { app_name: 'A', checked_at: new Date(threeHoursAgo).toISOString(), status: 'up' },
      { app_name: 'A', checked_at: new Date(threeHoursAgo + 1_000).toISOString(), status: 'up' },
      { app_name: 'A', checked_at: new Date(threeHoursAgo + 2_000).toISOString(), status: 'down' },
      { app_name: 'A', checked_at: new Date(twoHoursAgo).toISOString(), status: 'up' },
    ]);

    const buckets = store.bucketLastNHours('A', 24, now);
    const nonEmpty = buckets.filter((b) => b.total > 0);
    expect(nonEmpty.length).toBe(2);
    const [older, newer] = nonEmpty;
    expect(older.total).toBe(3);
    expect(older.up).toBe(2);
    expect(newer.total).toBe(1);
    expect(newer.up).toBe(1);
    store.close();
  });

  it('ignores samples with unparseable dates', () => {
    const now = Date.parse('2026-04-17T12:00:00Z');
    const store = makeStore(() => now);
    store.insert({ app_name: 'A', checked_at: 'not-a-date', status: 'up' });
    const buckets = store.bucketLastNHours('A', 24, now);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
    store.close();
  });
});

describe('SqliteHistoryStore.pruneOlderThan', () => {
  it('deletes rows older than the given day-count', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 10 * 24 * 3600_000).toISOString(),
      status: 'up',
    });
    store.insert({
      app_name: 'A',
      checked_at: new Date(now - 1 * 3600_000).toISOString(),
      status: 'up',
    });
    const removed = store.pruneOlderThan(7, now);
    expect(removed).toBe(1);
    // The remaining row should still count toward uptime.
    expect(store.uptimePercent('A', 24 * 7, now)).toBe(100);
    store.close();
  });

  it('returns 0 when nothing to prune', () => {
    const now = Date.parse('2026-04-17T00:00:00Z');
    const store = makeStore(() => now);
    expect(store.pruneOlderThan(7, now)).toBe(0);
    store.close();
  });
});
