import { SqliteHistoryStore } from '../src/historyStore';
import { IncidentTracker, summarizeReason } from '../src/incidentTracker';
import { HealthResult } from '../src/healthChecker';

function mkHealth(partial: Partial<HealthResult> & { name: string; state: HealthResult['state'] }): HealthResult {
  return {
    checkedAt: '2026-04-18T00:00:00.000Z',
    ...partial,
  } as HealthResult;
}

describe('summarizeReason', () => {
  it('prefers HTTP status code when present', () => {
    expect(summarizeReason(mkHealth({ name: 'A', state: 'down', statusCode: 502 }))).toBe('HTTP 502');
  });

  it('falls back to error message', () => {
    expect(
      summarizeReason(mkHealth({ name: 'A', state: 'down', error: 'ECONNREFUSED' })),
    ).toBe('ECONNREFUSED');
  });

  it('returns "down" when no code or error', () => {
    expect(summarizeReason(mkHealth({ name: 'A', state: 'down' }))).toBe('down');
  });

  it('ignores statusCode 0', () => {
    expect(
      summarizeReason(mkHealth({ name: 'A', state: 'down', statusCode: 0, error: 'timeout' })),
    ).toBe('timeout');
  });
});

describe('IncidentTracker', () => {
  it('opens an incident on up->down transition', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store, appNames: ['A'] });
    // First observation: up. No incident.
    t.process(mkHealth({ name: 'A', state: 'up', checkedAt: '2026-04-18T00:00:00.000Z' }));
    expect(store.getOpenIncident('A')).toBeNull();
    // Now it goes down.
    const evt = t.process(
      mkHealth({ name: 'A', state: 'down', statusCode: 502, checkedAt: '2026-04-18T00:01:00.000Z' }),
    );
    expect(evt).toEqual({ app: 'A', kind: 'opened', at: '2026-04-18T00:01:00.000Z', reason: 'HTTP 502' });
    const open = store.getOpenIncident('A');
    expect(open).not.toBeNull();
    expect(open!.reason).toBe('HTTP 502');
    store.close();
  });

  it('closes the incident on down->up transition and computes duration', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store, appNames: ['A'] });
    t.process(mkHealth({ name: 'A', state: 'down', statusCode: 500, checkedAt: '2026-04-18T00:00:00.000Z' }));
    const closed = t.process(
      mkHealth({ name: 'A', state: 'up', checkedAt: '2026-04-18T00:05:00.000Z' }),
    );
    expect(closed).toMatchObject({ app: 'A', kind: 'closed', at: '2026-04-18T00:05:00.000Z' });
    expect(closed!.durationMin).toBeCloseTo(5, 5);
    expect(store.getOpenIncident('A')).toBeNull();
    store.close();
  });

  it('ignores down->down and up->up repeats', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store });
    expect(t.process(mkHealth({ name: 'A', state: 'up' }))).toBeNull();
    expect(t.process(mkHealth({ name: 'A', state: 'up' }))).toBeNull();
    expect(t.process(mkHealth({ name: 'A', state: 'down', statusCode: 500 }))).not.toBeNull();
    expect(t.process(mkHealth({ name: 'A', state: 'down', statusCode: 500 }))).toBeNull();
    // Still only one open incident.
    expect(store.listIncidents({ days: 7 })).toHaveLength(1);
    store.close();
  });

  it('treats unknown state as a non-transition', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store });
    expect(t.process(mkHealth({ name: 'A', state: 'unknown' }))).toBeNull();
    expect(store.listIncidents({ days: 7 })).toHaveLength(0);
    // Does not set lastState.
    expect(t.getLastState('A')).toBeUndefined();
    store.close();
  });

  it('first observation being down opens an incident', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store });
    const evt = t.process(
      mkHealth({ name: 'A', state: 'down', statusCode: 503, checkedAt: '2026-04-18T00:00:00.000Z' }),
    );
    expect(evt).toMatchObject({ kind: 'opened', reason: 'HTTP 503' });
    store.close();
  });

  it('rehydrates from open incidents so restart does not re-open a second row', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Seed an open incident as if a previous process had left it.
    store.openIncident('A', '2026-04-18T00:00:00.000Z', 'HTTP 500');
    const t = new IncidentTracker({ store, appNames: ['A'] });
    // If the first sample we see is also down, we should NOT open a second
    // incident — the existing one is still active.
    const evt = t.process(
      mkHealth({ name: 'A', state: 'down', statusCode: 500, checkedAt: '2026-04-18T00:01:00.000Z' }),
    );
    expect(evt).toBeNull();
    expect(store.listIncidents({ days: 7 })).toHaveLength(1);
    store.close();
  });

  it('rehydrated open incident is closed when app goes up', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    store.openIncident('A', '2026-04-18T00:00:00.000Z', 'HTTP 500');
    const t = new IncidentTracker({ store, appNames: ['A'] });
    const evt = t.process(mkHealth({ name: 'A', state: 'up', checkedAt: '2026-04-18T00:10:00.000Z' }));
    expect(evt).toMatchObject({ app: 'A', kind: 'closed' });
    expect(store.getOpenIncident('A')).toBeNull();
    store.close();
  });

  it('processBatch returns an array of transitions', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store });
    // Prime states: A up, B up.
    t.processBatch([
      mkHealth({ name: 'A', state: 'up' }),
      mkHealth({ name: 'B', state: 'up' }),
    ]);
    // Now A goes down, B stays up.
    const evts = t.processBatch([
      mkHealth({ name: 'A', state: 'down', statusCode: 500 }),
      mkHealth({ name: 'B', state: 'up' }),
    ]);
    expect(evts).toHaveLength(1);
    expect(evts[0].app).toBe('A');
    expect(evts[0].kind).toBe('opened');
    store.close();
  });

  it('independent apps maintain independent state', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    const t = new IncidentTracker({ store });
    t.process(mkHealth({ name: 'A', state: 'up' }));
    t.process(mkHealth({ name: 'B', state: 'down', statusCode: 500 }));
    expect(store.getOpenIncident('A')).toBeNull();
    expect(store.getOpenIncident('B')).not.toBeNull();
    store.close();
  });
});
