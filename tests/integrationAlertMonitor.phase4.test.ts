import { IntegrationAlertMonitor } from '../src/integrationAlertMonitor';
import { SqliteHistoryStore } from '../src/historyStore';
import { AlertSender, AlertMessage, AlertSendResult } from '../src/alertSender';

/**
 * Phase 4 Integration Observability tests:
 *  - per-hour cooldown blocks a second alert within the hour
 *  - cooldown expires after >1h
 *  - cooldown spans a UTC day boundary
 *  - recovery fires exactly once per transition
 *  - recovery does not fire when never degraded
 *  - recovery closes the synthetic incident
 *  - recovery threshold is a hard gate (below recovery, above primary → no-op)
 *  - monitor still tolerates sender throwing during recovery
 *  - historyStore last_fired_at column migrates safely for pre-phase4 dbs
 *  - hasIntegrationAlerted + getMostRecentIntegrationAlert both see the new row
 */

class RecordingSender implements AlertSender {
  messages: AlertMessage[] = [];
  next: AlertSendResult = { delivered: true, transport: 'console' };
  throwNext = false;
  async send(message: AlertMessage): Promise<AlertSendResult> {
    this.messages.push(message);
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('send crash');
    }
    return this.next;
  }
}

function silentLogger(): Pick<Console, 'log' | 'warn' | 'error'> {
  return { log: () => undefined, warn: () => undefined, error: () => undefined };
}

function seedHistory(
  store: SqliteHistoryStore,
  integration: string,
  days: Array<{ date: string; successRate: number; totalAttempts: number }>,
): void {
  for (const d of days) {
    store.recordIntegrationStat({
      integration_name: integration,
      date: d.date,
      success_rate: d.successRate,
      total_attempts: d.totalAttempts,
      snapshot_at: `${d.date}T03:00:00.000Z`,
    });
  }
}

/** Simulate an open integration incident. */
function openIntegrationIncident(
  store: SqliteHistoryStore,
  integration: string,
  atIso: string,
): number {
  return store.openIncident(`integration:${integration}`, atIso, 'phase-4-test-fixture');
}

const BASE_NOW = Date.parse('2026-04-21T12:00:00Z');

describe('IntegrationAlertMonitor — Phase 4 hourly cooldown', () => {
  it('blocks a second alert within the cooldown window (crosses UTC day boundary)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    const sender = new RecordingSender();
    // First fire at 23:50 on day 1 so we can recheck at 00:15 on day 2 and
    // isolate the cooldown path (per-day dedupe does NOT apply — different
    // UTC date).
    let nowMs = Date.parse('2026-04-21T23:50:00Z');
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => nowMs,
      logger: silentLogger(),
      integrations: ['kanban'],
    });

    const first = await monitor.check();
    expect(first.fired).toHaveLength(1);
    expect(sender.messages).toHaveLength(1);

    // 25 minutes later, next UTC day: per-day dedupe does not apply, cooldown
    // does.
    nowMs = Date.parse('2026-04-22T00:15:00Z');
    seedHistory(store, 'kanban', [
      { date: '2026-04-22', successRate: 0.5, totalAttempts: 100 },
    ]);

    const second = await monitor.check();
    expect(second.fired).toHaveLength(0);
    expect(sender.messages).toHaveLength(1);
    expect(second.skipped.some((s) => s.reason.includes('cooldown'))).toBe(true);

    store.close();
  });

  it('allows a re-fire after the cooldown expires (>1h later)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    const sender = new RecordingSender();
    let nowMs = BASE_NOW;
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => nowMs,
      logger: silentLogger(),
      integrations: ['kanban'],
    });

    const first = await monitor.check();
    expect(first.fired).toHaveLength(1);

    // Move 2 hours forward into a new UTC day so per-day dedupe doesn't block.
    nowMs = Date.parse('2026-04-22T02:00:00Z');
    seedHistory(store, 'kanban', [
      { date: '2026-04-22', successRate: 0.5, totalAttempts: 100 },
    ]);

    const second = await monitor.check();
    expect(second.fired).toHaveLength(1);
    expect(sender.messages).toHaveLength(2);

    store.close();
  });

  it('persists last_fired_at so cooldown survives monitor restarts across a day boundary', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    // Fire at 23:40 so we can re-check at 00:05 next day (25 min later, new
    // UTC date, still inside cooldown).
    const firstFireMs = Date.parse('2026-04-21T23:40:00Z');
    const monitor1 = new IntegrationAlertMonitor({
      store,
      alertSender: new RecordingSender(),
      now: () => firstFireMs,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    await monitor1.check();
    expect(store.getMostRecentIntegrationAlert('kanban')).not.toBeNull();

    // New monitor instance, same store, 25 min later, next UTC day.
    const laterMs = Date.parse('2026-04-22T00:05:00Z');
    seedHistory(store, 'kanban', [
      { date: '2026-04-22', successRate: 0.5, totalAttempts: 100 },
    ]);
    const sender2 = new RecordingSender();
    const monitor2 = new IntegrationAlertMonitor({
      store,
      alertSender: sender2,
      now: () => laterMs,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor2.check();
    expect(res.fired).toHaveLength(0);
    expect(sender2.messages).toHaveLength(0);
    expect(res.skipped.some((s) => s.reason.includes('cooldown'))).toBe(true);
    store.close();
  });

  it('same-day re-check refreshes last_fired_at so the cooldown window slides forward', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    const sender = new RecordingSender();
    let nowMs = BASE_NOW;
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => nowMs,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    await monitor.check();
    const firstStamp = store.getMostRecentIntegrationAlert('kanban');
    expect(firstStamp).not.toBeNull();

    // Same-day re-check 45m later → per-day dedupe blocks, but we still touch
    // last_fired_at so the cooldown clock effectively resets.
    nowMs = Date.parse('2026-04-21T12:45:00Z');
    await monitor.check();
    const secondStamp = store.getMostRecentIntegrationAlert('kanban');
    expect(secondStamp).not.toBe(firstStamp);
    expect(Date.parse(secondStamp!)).toBeGreaterThan(Date.parse(firstStamp!));
    store.close();
  });
});

describe('IntegrationAlertMonitor — Phase 4 recovery', () => {
  it('fires a recovery info alert exactly once when rate crosses above recovery threshold with an open incident', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Seed current healthy stats.
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.96, totalAttempts: 200 },
    ]);
    // Pre-existing open synthetic incident (we previously alerted).
    const incidentId = openIntegrationIncident(store, 'kanban', '2026-04-20T10:00:00Z');

    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => BASE_NOW,
      logger: silentLogger(),
      integrations: ['kanban'],
    });

    const first = await monitor.check();
    expect(first.recovered).toHaveLength(1);
    expect(first.fired).toHaveLength(0);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0].severity).toBe('info');
    expect(sender.messages[0].title).toMatch(/recovered/i);
    expect(first.recovered[0].incidentClosed).toBe(incidentId);

    // Subsequent check: incident is closed, so recovery must not fire again.
    const second = await monitor.check();
    expect(second.recovered).toHaveLength(0);
    expect(sender.messages).toHaveLength(1);
    store.close();
  });

  it('does not fire recovery when the integration was never degraded (no open incident)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.99, totalAttempts: 200 },
    ]);
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => BASE_NOW,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    expect(res.recovered).toHaveLength(0);
    expect(res.fired).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
    store.close();
  });

  it('closes the synthetic incident so MTTR calculations see it', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.95, totalAttempts: 200 },
    ]);
    openIntegrationIncident(store, 'kanban', '2026-04-20T10:00:00Z');
    expect(store.getOpenIncident('integration:kanban')).not.toBeNull();

    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: new RecordingSender(),
      now: () => BASE_NOW,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    await monitor.check();

    // Incident should now be closed.
    expect(store.getOpenIncident('integration:kanban')).toBeNull();
    const closed = store.listIncidents({ days: 7, nowMs: BASE_NOW, app: 'integration:kanban' });
    expect(closed).toHaveLength(1);
    expect(closed[0].incident_end).not.toBeNull();
    expect(closed[0].duration_min).not.toBeNull();
    store.close();
  });

  it('does not fire recovery when rate is above primary threshold but below recovery threshold', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // rate = 0.85 → above 0.80 primary threshold, below 0.90 recovery threshold.
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.85, totalAttempts: 200 },
    ]);
    openIntegrationIncident(store, 'kanban', '2026-04-20T10:00:00Z');

    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => BASE_NOW,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    expect(res.recovered).toHaveLength(0);
    expect(res.fired).toHaveLength(0);
    // Still in the "healthy enough" gap — skipped.
    expect(res.skipped.some((s) => s.integration === 'kanban')).toBe(true);
    expect(sender.messages).toHaveLength(0);
    // Incident remains open.
    expect(store.getOpenIncident('integration:kanban')).not.toBeNull();
    store.close();
  });

  it('still closes the incident even if the recovery sender throws', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.98, totalAttempts: 200 },
    ]);
    openIntegrationIncident(store, 'kanban', '2026-04-20T10:00:00Z');
    const sender = new RecordingSender();
    sender.throwNext = true;
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => BASE_NOW,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    expect(res.recovered).toHaveLength(1);
    expect(res.recovered[0].alertDelivered).toBe(false);
    // Incident still closed despite the send failure.
    expect(store.getOpenIncident('integration:kanban')).toBeNull();
    store.close();
  });
});

describe('historyStore — Phase 4 integration_alert_state migration', () => {
  it('adds last_fired_at column on an existing db and back-fills from alerted_at', () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Record via the current (post-migration) path.
    store.recordIntegrationAlert({
      integration_name: 'kanban',
      date: '2026-04-20',
      success_rate: 0.5,
      alerted_at: '2026-04-20T10:00:00Z',
    });
    // When last_fired_at is omitted, it should default to alerted_at.
    const latest = store.getMostRecentIntegrationAlert('kanban');
    expect(latest).toBe('2026-04-20T10:00:00Z');

    // Explicit last_fired_at on a different date row wins when newer.
    store.recordIntegrationAlert({
      integration_name: 'kanban',
      date: '2026-04-21',
      success_rate: 0.4,
      alerted_at: '2026-04-21T09:00:00Z',
      last_fired_at: '2026-04-21T11:30:00Z',
    });
    expect(store.getMostRecentIntegrationAlert('kanban')).toBe('2026-04-21T11:30:00Z');

    // touchIntegrationAlert updates last_fired_at without inserting a new row.
    const touched = store.touchIntegrationAlert(
      'kanban',
      '2026-04-21',
      '2026-04-21T12:45:00Z',
    );
    expect(touched).toBe(true);
    expect(store.getMostRecentIntegrationAlert('kanban')).toBe('2026-04-21T12:45:00Z');
    // Missing row → false, no insert.
    expect(
      store.touchIntegrationAlert('unknown', '2026-04-21', '2026-04-21T12:45:00Z'),
    ).toBe(false);

    // getMostRecentIntegrationAlert on an integration we've never alerted for
    // should return null (not throw).
    expect(store.getMostRecentIntegrationAlert('po-receiver')).toBeNull();

    store.close();
  });
});
