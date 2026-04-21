import { SqliteHistoryStore } from '../src/historyStore';

function store(now = () => Date.now()): SqliteHistoryStore {
  return new SqliteHistoryStore({ filePath: ':memory:', now });
}

describe('SqliteHistoryStore integration_stats_history', () => {
  it('recordIntegrationStat persists a row and lists by integration', () => {
    const s = store();
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-20',
      success_rate: 0.98,
      total_attempts: 200,
      snapshot_at: '2026-04-20T03:00:00.000Z',
    });
    const rows = s.listIntegrationStats('po-receiver', 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].integration_name).toBe('po-receiver');
    expect(rows[0].date).toBe('2026-04-20');
    expect(rows[0].success_rate).toBeCloseTo(0.98);
    expect(rows[0].total_attempts).toBe(200);
    expect(rows[0].snapshot_at).toBe('2026-04-20T03:00:00.000Z');
    s.close();
  });

  it('recordIntegrationStat upserts when same integration+date is stored twice', () => {
    const s = store();
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-20',
      success_rate: 0.5,
      total_attempts: 10,
      snapshot_at: '2026-04-20T03:00:00.000Z',
    });
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-20',
      success_rate: 0.99,
      total_attempts: 250,
      snapshot_at: '2026-04-20T03:05:00.000Z',
    });
    const rows = s.listIntegrationStats('po-receiver', 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].success_rate).toBeCloseTo(0.99);
    expect(rows[0].total_attempts).toBe(250);
    s.close();
  });

  it('listIntegrationStats filters by integration name + window (days)', () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const s = store(() => now);
    // 8 days ago
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-12',
      success_rate: 0.9,
      total_attempts: 1,
      snapshot_at: '2026-04-12T03:00:00.000Z',
    });
    // 2 days ago — inside 7-day window
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-18',
      success_rate: 0.95,
      total_attempts: 120,
      snapshot_at: '2026-04-18T03:00:00.000Z',
    });
    // different integration
    s.recordIntegrationStat({
      integration_name: 'kanban',
      date: '2026-04-18',
      success_rate: 1.0,
      total_attempts: 10,
      snapshot_at: '2026-04-18T03:00:00.000Z',
    });
    const rows = s.listIntegrationStats('po-receiver', 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-04-18');
    s.close();
  });

  it('listIntegrationStats returns rows in ascending date order', () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const s = store(() => now);
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-19',
      success_rate: 0.92,
      total_attempts: 50,
      snapshot_at: '2026-04-19T03:00:00.000Z',
    });
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-17',
      success_rate: 0.98,
      total_attempts: 80,
      snapshot_at: '2026-04-17T03:00:00.000Z',
    });
    s.recordIntegrationStat({
      integration_name: 'po-receiver',
      date: '2026-04-18',
      success_rate: 0.85,
      total_attempts: 100,
      snapshot_at: '2026-04-18T03:00:00.000Z',
    });
    const rows = s.listIntegrationStats('po-receiver', 7);
    expect(rows.map((r) => r.date)).toEqual([
      '2026-04-17',
      '2026-04-18',
      '2026-04-19',
    ]);
    s.close();
  });

  it('listIntegrationStats returns [] when no rows match', () => {
    const s = store();
    expect(s.listIntegrationStats('nonexistent', 7)).toEqual([]);
    s.close();
  });
});

describe('SqliteHistoryStore prune_runs', () => {
  it('recordPruneRun inserts and returns the row id', () => {
    const s = store();
    const id = s.recordPruneRun({
      ran_at: '2026-04-20T08:00:00.000Z',
      deleted_count: 3,
      deleted_notes_count: 5,
    });
    expect(id).toBeGreaterThan(0);
    s.close();
  });

  it('getLatestPruneRun returns the most recent row', () => {
    const s = store();
    s.recordPruneRun({
      ran_at: '2026-04-18T08:00:00.000Z',
      deleted_count: 1,
      deleted_notes_count: 0,
    });
    s.recordPruneRun({
      ran_at: '2026-04-20T08:00:00.000Z',
      deleted_count: 7,
      deleted_notes_count: 12,
    });
    const latest = s.getLatestPruneRun();
    expect(latest).not.toBeNull();
    expect(latest!.ran_at).toBe('2026-04-20T08:00:00.000Z');
    expect(latest!.deleted_count).toBe(7);
    expect(latest!.deleted_notes_count).toBe(12);
    s.close();
  });

  it('getLatestPruneRun returns null when no rows exist', () => {
    const s = store();
    expect(s.getLatestPruneRun()).toBeNull();
    s.close();
  });
});

describe('SqliteHistoryStore.computeIncidentStats', () => {
  it('returns zeros for an app with no incidents', () => {
    const now = Date.parse('2026-04-20T00:00:00.000Z');
    const s = store(() => now);
    const stats = s.computeIncidentStats({ app: 'App', days: 7, nowMs: now });
    expect(stats.incidentCount).toBe(0);
    expect(stats.totalDowntimeMin).toBe(0);
    expect(stats.mtbfHours).toBeNull();
    expect(stats.mttrMinutes).toBeNull();
    s.close();
  });

  it('computes MTTR as average duration of closed incidents', () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const s = store(() => now);
    // 10 min outage
    s.openIncident('App', new Date(now - 2 * 86400_000).toISOString(), 'r1');
    s.closeIncident('App', new Date(now - 2 * 86400_000 + 10 * 60_000).toISOString());
    // 30 min outage
    s.openIncident('App', new Date(now - 1 * 86400_000).toISOString(), 'r2');
    s.closeIncident('App', new Date(now - 1 * 86400_000 + 30 * 60_000).toISOString());
    const stats = s.computeIncidentStats({ app: 'App', days: 7, nowMs: now });
    expect(stats.incidentCount).toBe(2);
    expect(stats.totalDowntimeMin).toBeCloseTo(40);
    expect(stats.mttrMinutes).toBeCloseTo(20);
    // MTBF: time between first end and second start = ~24h - 10m ≈ 23h 50m
    // With 2 incidents and window, we expect a positive value
    expect(stats.mtbfHours).toBeGreaterThan(0);
    s.close();
  });

  it('handles a single open incident (no MTTR yet)', () => {
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const s = store(() => now);
    s.openIncident('App', new Date(now - 60 * 60_000).toISOString(), 'live');
    const stats = s.computeIncidentStats({ app: 'App', days: 7, nowMs: now });
    expect(stats.incidentCount).toBe(1);
    // Open incident contributes ~60 min of downtime
    expect(stats.totalDowntimeMin).toBeCloseTo(60, 0);
    // MTTR null because no closed incidents
    expect(stats.mttrMinutes).toBeNull();
    // MTBF null because <2 incidents
    expect(stats.mtbfHours).toBeNull();
    s.close();
  });
});
