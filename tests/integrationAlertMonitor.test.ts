import { IntegrationAlertMonitor } from '../src/integrationAlertMonitor';
import { SqliteHistoryStore } from '../src/historyStore';
import { AlertSender, AlertMessage, AlertSendResult } from '../src/alertSender';

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

function seedHistory(store: SqliteHistoryStore, integration: string, days: Array<{
  date: string;
  successRate: number;
  totalAttempts: number;
}>): void {
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

const NOW_MS = Date.parse('2026-04-21T12:00:00Z');

describe('IntegrationAlertMonitor', () => {
  it('fires when 7d weighted rate is below threshold, posts alert, logs incident, dedupes', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-15', successRate: 0.70, totalAttempts: 100 },
      { date: '2026-04-16', successRate: 0.60, totalAttempts: 100 },
      { date: '2026-04-17', successRate: 0.65, totalAttempts: 50 },
      { date: '2026-04-18', successRate: 0.70, totalAttempts: 120 },
      { date: '2026-04-19', successRate: 0.55, totalAttempts: 80 },
      { date: '2026-04-20', successRate: 0.68, totalAttempts: 90 },
      { date: '2026-04-21', successRate: 0.62, totalAttempts: 110 },
    ]);
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => NOW_MS,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    expect(res.fired).toHaveLength(1);
    const firing = res.fired[0];
    expect(firing.integration).toBe('kanban');
    expect(firing.successRate).toBeLessThan(0.8);
    expect(firing.incidentId).not.toBeNull();
    expect(firing.alertDelivered).toBe(true);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0].title).toContain('kanban');
    expect(sender.messages[0].severity === 'warning' || sender.messages[0].severity === 'critical').toBe(true);
    // Incident logged under synthetic app name.
    const incidents = store.listIncidents({ days: 1, nowMs: NOW_MS });
    expect(incidents.some((i) => i.app_name === 'integration:kanban')).toBe(true);
    // Dedupe row written.
    expect(store.hasIntegrationAlerted('kanban', '2026-04-21')).toBe(true);
    store.close();
  });

  it('does not fire when 7d weighted rate is above threshold', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'po-receiver', [
      { date: '2026-04-18', successRate: 0.98, totalAttempts: 100 },
      { date: '2026-04-19', successRate: 0.99, totalAttempts: 120 },
      { date: '2026-04-20', successRate: 0.97, totalAttempts: 90 },
      { date: '2026-04-21', successRate: 0.995, totalAttempts: 100 },
    ]);
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => NOW_MS,
      logger: silentLogger(),
      integrations: ['po-receiver'],
    });
    const res = await monitor.check();
    expect(res.fired).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
    expect(res.skipped.some((s) => s.integration === 'po-receiver')).toBe(true);
    store.close();
  });

  it('dedupes repeat calls within the same day', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'content-engine', [
      { date: '2026-04-20', successRate: 0.50, totalAttempts: 50 },
      { date: '2026-04-21', successRate: 0.55, totalAttempts: 60 },
    ]);
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => NOW_MS,
      logger: silentLogger(),
      integrations: ['content-engine'],
    });
    const first = await monitor.check();
    const second = await monitor.check();
    expect(first.fired).toHaveLength(1);
    expect(second.fired).toHaveLength(0);
    expect(second.skipped.some((s) => s.reason.includes('already alerted'))).toBe(true);
    // Still only one alert posted.
    expect(sender.messages).toHaveLength(1);
    store.close();
  });

  it('skips integrations with no stats recorded or zero attempts', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    // Only a zero-attempts row.
    seedHistory(store, 'kanban', [
      { date: '2026-04-20', successRate: 0, totalAttempts: 0 },
    ]);
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => NOW_MS,
      logger: silentLogger(),
      integrations: ['po-receiver', 'kanban'],
    });
    const res = await monitor.check();
    expect(res.fired).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
    expect(res.skipped.find((s) => s.integration === 'po-receiver')?.reason).toMatch(/no stats recorded/);
    expect(res.skipped.find((s) => s.integration === 'kanban')?.reason).toMatch(/zero attempts/);
    store.close();
  });

  it('uses critical severity when rate is far below threshold (< 50% of threshold)', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      // Threshold 0.8, rate will be 0.4 < 0.8 * 0.625 = 0.5 → critical.
      { date: '2026-04-20', successRate: 0.40, totalAttempts: 200 },
      { date: '2026-04-21', successRate: 0.40, totalAttempts: 200 },
    ]);
    const sender = new RecordingSender();
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => NOW_MS,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    expect(res.fired).toHaveLength(1);
    expect(sender.messages[0].severity).toBe('critical');
    store.close();
  });

  it('survives alert-sender throwing without corrupting dedupe or incident log', async () => {
    const store = new SqliteHistoryStore({ filePath: ':memory:' });
    seedHistory(store, 'kanban', [
      { date: '2026-04-21', successRate: 0.5, totalAttempts: 100 },
    ]);
    const sender = new RecordingSender();
    sender.throwNext = true;
    const monitor = new IntegrationAlertMonitor({
      store,
      alertSender: sender,
      now: () => NOW_MS,
      logger: silentLogger(),
      integrations: ['kanban'],
    });
    const res = await monitor.check();
    // Still "fired" from our bookkeeping perspective, though delivered=false.
    expect(res.fired).toHaveLength(1);
    expect(res.fired[0].alertDelivered).toBe(false);
    // Incident row + dedupe row still written.
    expect(store.hasIntegrationAlerted('kanban', '2026-04-21')).toBe(true);
    expect(
      store.listIncidents({ days: 1, nowMs: NOW_MS }).some((i) => i.app_name === 'integration:kanban'),
    ).toBe(true);
    store.close();
  });
});
