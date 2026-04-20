import { SqliteHistoryStore } from '../src/historyStore';

function store(now = () => Date.now()): SqliteHistoryStore {
  return new SqliteHistoryStore({ filePath: ':memory:', now });
}

describe('SqliteHistoryStore incidents', () => {
  it('openIncident creates an open row with null end and null duration', () => {
    const s = store();
    const id = s.openIncident('A', '2026-04-18T00:00:00.000Z', 'HTTP 502');
    expect(id).toBeGreaterThan(0);
    const open = s.getOpenIncident('A');
    expect(open).not.toBeNull();
    expect(open!.app_name).toBe('A');
    expect(open!.incident_start).toBe('2026-04-18T00:00:00.000Z');
    expect(open!.incident_end).toBeNull();
    expect(open!.duration_min).toBeNull();
    expect(open!.reason).toBe('HTTP 502');
    s.close();
  });

  it('getOpenIncident returns null when no open incident exists', () => {
    const s = store();
    expect(s.getOpenIncident('B')).toBeNull();
    s.close();
  });

  it('closeIncident sets end timestamp and computes duration_min', () => {
    const s = store();
    const startIso = '2026-04-18T00:00:00.000Z';
    const endIso = '2026-04-18T00:05:30.000Z'; // 5.5 minutes
    s.openIncident('A', startIso, 'HTTP 500');
    const closed = s.closeIncident('A', endIso);
    expect(closed).not.toBeNull();
    expect(closed!.incident_end).toBe(endIso);
    expect(closed!.duration_min).toBeCloseTo(5.5, 5);
    // And it's no longer open.
    expect(s.getOpenIncident('A')).toBeNull();
    s.close();
  });

  it('closeIncident with no open incident returns null', () => {
    const s = store();
    expect(s.closeIncident('ghost', '2026-04-18T00:01:00.000Z')).toBeNull();
    s.close();
  });

  it('closeIncident with unparseable timestamps still records the end', () => {
    const s = store();
    s.openIncident('A', 'not-a-date', null);
    const closed = s.closeIncident('A', 'also-garbage');
    expect(closed).not.toBeNull();
    expect(closed!.incident_end).toBe('also-garbage');
    expect(closed!.duration_min).toBeNull();
    s.close();
  });

  it('openIncident allows multiple sequential incidents for the same app', () => {
    const s = store();
    s.openIncident('A', '2026-04-18T00:00:00.000Z', 'first');
    s.closeIncident('A', '2026-04-18T00:01:00.000Z');
    s.openIncident('A', '2026-04-18T01:00:00.000Z', 'second');
    const open = s.getOpenIncident('A');
    expect(open).not.toBeNull();
    expect(open!.reason).toBe('second');
    s.close();
  });

  it('listIncidents returns rows for the last N days, newest first', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    s.openIncident('A', new Date(now - 1 * 3600_000).toISOString(), 'HTTP 502');
    s.closeIncident('A', new Date(now - 30 * 60_000).toISOString());
    s.openIncident('B', new Date(now - 2 * 3600_000).toISOString(), 'HTTP 500');
    // Older than the window
    s.openIncident(
      'C',
      new Date(now - 30 * 24 * 3600_000).toISOString(),
      'ancient',
    );
    const list = s.listIncidents({ days: 7, nowMs: now });
    expect(list.map((r) => r.app_name)).toEqual(['A', 'B']);
    s.close();
  });

  it('listIncidents filters by app name', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    s.openIncident('A', new Date(now - 1 * 3600_000).toISOString(), 'a');
    s.openIncident('B', new Date(now - 2 * 3600_000).toISOString(), 'b');
    const list = s.listIncidents({ days: 7, app: 'A', nowMs: now });
    expect(list).toHaveLength(1);
    expect(list[0].app_name).toBe('A');
    s.close();
  });

  it('listIncidents honors the limit', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    for (let i = 0; i < 12; i++) {
      s.openIncident('A', new Date(now - (i + 1) * 60_000).toISOString(), `#${i}`);
      s.closeIncident('A', new Date(now - (i + 1) * 60_000 + 1_000).toISOString());
    }
    const list = s.listIncidents({ days: 7, limit: 5, nowMs: now });
    expect(list).toHaveLength(5);
    s.close();
  });

  it('listIncidents defaults to days=7 and limit=100', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    s.openIncident('A', new Date(now - 1 * 3600_000).toISOString(), 'r');
    const list = s.listIncidents();
    expect(list.length).toBeGreaterThanOrEqual(1);
    s.close();
  });
});

describe('SqliteHistoryStore.pruneIncidents', () => {
  it('removes closed incidents older than the retention window', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    // Closed 40 days ago — should be pruned.
    s.openIncident('A', new Date(now - 40 * 86400_000).toISOString(), 'old');
    s.closeIncident('A', new Date(now - 40 * 86400_000 + 60_000).toISOString());
    // Closed 5 days ago — should be kept.
    s.openIncident('B', new Date(now - 5 * 86400_000).toISOString(), 'recent');
    s.closeIncident('B', new Date(now - 5 * 86400_000 + 60_000).toISOString());
    const removed = s.pruneIncidents(30, now);
    expect(removed).toBe(1);
    const list = s.listIncidents({ days: 90, nowMs: now });
    expect(list.map((r) => r.app_name)).toEqual(['B']);
    s.close();
  });

  it('keeps still-open incidents regardless of age', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    // Open incident started 90 days ago — must NOT be pruned.
    s.openIncident('A', new Date(now - 90 * 86400_000).toISOString(), 'long outage');
    const removed = s.pruneIncidents(30, now);
    expect(removed).toBe(0);
    expect(s.getOpenIncident('A')).not.toBeNull();
    s.close();
  });

  it('cascade-deletes notes when incident is pruned', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    const id = s.openIncident('A', new Date(now - 60 * 86400_000).toISOString(), 'ancient');
    s.closeIncident('A', new Date(now - 60 * 86400_000 + 120_000).toISOString());
    s.addIncidentNote(id, 'post-mortem', new Date(now - 59 * 86400_000).toISOString());
    expect(s.getIncidentNotes(id)).toHaveLength(1);
    s.pruneIncidents(30, now);
    expect(s.getIncidentNotes(id)).toHaveLength(0);
    expect(s.getIncidentById(id)).toBeNull();
    s.close();
  });

  it('returns 0 when there is nothing to prune', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    expect(s.pruneIncidents(30, now)).toBe(0);
    s.close();
  });
});

describe('SqliteHistoryStore incident notes', () => {
  it('addIncidentNote appends a note row and returns it', () => {
    const s = store();
    const id = s.openIncident('A', '2026-04-18T00:00:00.000Z', 'HTTP 502');
    const note = s.addIncidentNote(id, 'rebooted service', '2026-04-18T00:05:00.000Z');
    expect(note).not.toBeNull();
    expect(note!.incident_id).toBe(id);
    expect(note!.note).toBe('rebooted service');
    expect(note!.at).toBe('2026-04-18T00:05:00.000Z');
    const notes = s.getIncidentNotes(id);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toBe('rebooted service');
    s.close();
  });

  it('addIncidentNote returns null when incident id is unknown', () => {
    const s = store();
    const note = s.addIncidentNote(9999, 'no such incident');
    expect(note).toBeNull();
    s.close();
  });

  it('listIncidents includes notes when includeNotes=true', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = store(() => now);
    const id = s.openIncident('A', new Date(now - 60_000).toISOString(), 'HTTP 500');
    s.addIncidentNote(id, 'first', new Date(now - 30_000).toISOString());
    s.addIncidentNote(id, 'second', new Date(now - 10_000).toISOString());
    const rows = s.listIncidents({ days: 7, nowMs: now, includeNotes: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBeDefined();
    expect(rows[0].notes).toHaveLength(2);
    expect(rows[0].notes![0].note).toBe('first');
    expect(rows[0].notes![1].note).toBe('second');
    s.close();
  });

  it('listIncidents omits notes when includeNotes is not set', () => {
    const s = store();
    const id = s.openIncident('A', new Date().toISOString(), 'r');
    s.addIncidentNote(id, 'x');
    const rows = s.listIncidents();
    expect(rows[0].notes).toBeUndefined();
    s.close();
  });

  it('getIncidentById returns the row or null', () => {
    const s = store();
    const id = s.openIncident('A', new Date().toISOString(), 'r');
    const row = s.getIncidentById(id);
    expect(row).not.toBeNull();
    expect(row!.app_name).toBe('A');
    expect(s.getIncidentById(9999)).toBeNull();
    s.close();
  });
});
