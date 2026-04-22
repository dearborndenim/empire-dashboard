import { SqliteHistoryStore } from '../src/historyStore';
import {
  buildWeeklyReportData,
  renderWeeklyReportText,
  formatMinutes,
  sendWeeklyReport,
} from '../src/weeklyReport';
import { EmailMessage, EmailSender } from '../src/email';
import { AppConfig } from '../src/config';

function apps(): AppConfig[] {
  return [
    { name: 'Alpha', repo: 'o/alpha' },
    { name: 'Beta', repo: 'o/beta' },
  ];
}

function seedStore(now: number): SqliteHistoryStore {
  const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
  // Alpha 100% uptime (all up samples).
  store.insertMany([
    { app_name: 'Alpha', checked_at: new Date(now - 1000).toISOString(), status: 'up' },
    { app_name: 'Alpha', checked_at: new Date(now - 2000).toISOString(), status: 'up' },
  ]);
  // Beta 50% uptime.
  store.insertMany([
    { app_name: 'Beta', checked_at: new Date(now - 1000).toISOString(), status: 'up' },
    { app_name: 'Beta', checked_at: new Date(now - 2000).toISOString(), status: 'down' },
  ]);
  // Incidents for Beta: one closed 30 min, one open running 10 min.
  store.openIncident('Beta', new Date(now - 90 * 60_000).toISOString(), 'HTTP 502');
  store.closeIncident('Beta', new Date(now - 60 * 60_000).toISOString()); // 30 min duration
  store.openIncident('Beta', new Date(now - 10 * 60_000).toISOString(), 'HTTP 500');
  return store;
}

describe('formatMinutes', () => {
  it('formats sub-hour durations in m', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(-1)).toBe('0m');
    expect(formatMinutes(5)).toBe('5m');
    expect(formatMinutes(59)).toBe('59m');
  });
  it('formats hours with minutes', () => {
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h30m');
  });
  it('formats days with hours', () => {
    expect(formatMinutes(24 * 60)).toBe('1d');
    expect(formatMinutes(25 * 60)).toBe('1d1h');
  });
  it('returns 0m for non-finite inputs', () => {
    expect(formatMinutes(NaN)).toBe('0m');
    expect(formatMinutes(Infinity)).toBe('0m');
  });
});

describe('buildWeeklyReportData', () => {
  it('counts incidents and splits open vs closed', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = seedStore(now);
    const data = buildWeeklyReportData({ apps: apps(), store, nowMs: now });
    expect(data.windowDays).toBe(7);
    expect(data.incidentCount).toBe(2);
    expect(data.closedCount).toBe(1);
    expect(data.openCount).toBe(1);
    store.close();
  });

  it('reports uptime rollup for each app', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = seedStore(now);
    const data = buildWeeklyReportData({ apps: apps(), store, nowMs: now });
    const alpha = data.uptimeRollup.find((r) => r.app === 'Alpha')!;
    const beta = data.uptimeRollup.find((r) => r.app === 'Beta')!;
    expect(alpha.uptimePercent).toBe(100);
    expect(beta.uptimePercent).toBe(50);
    store.close();
  });

  it('identifies top downtime apps and sums open + closed durations', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = seedStore(now);
    const data = buildWeeklyReportData({ apps: apps(), store, nowMs: now });
    expect(data.topDowntime).toHaveLength(1);
    expect(data.topDowntime[0].app).toBe('Beta');
    // 30m closed + ~10m open running = ~40m.
    expect(data.topDowntime[0].totalDowntimeMin).toBeGreaterThan(39.9);
    expect(data.topDowntime[0].totalDowntimeMin).toBeLessThan(40.1);
    expect(data.topDowntime[0].incidents).toBe(2);
    store.close();
  });

  it('computes longestIncidents truncating open ones at nowMs and sorted desc', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    // Closed: 20 min
    s.openIncident('Alpha', new Date(now - 30 * 60_000).toISOString(), 'HTTP 502');
    s.closeIncident('Alpha', new Date(now - 10 * 60_000).toISOString());
    // Closed: 45 min
    s.openIncident('Beta', new Date(now - 90 * 60_000).toISOString(), 'HTTP 500');
    s.closeIncident('Beta', new Date(now - 45 * 60_000).toISOString());
    // Still-open: ~60 min truncated
    s.openIncident('Gamma', new Date(now - 60 * 60_000).toISOString(), 'conn refused');
    // Another closed 5 min, should be excluded from top-3 only if longer ones exist
    s.openIncident('Delta', new Date(now - 10 * 60_000).toISOString(), 'HTTP 504');
    s.closeIncident('Delta', new Date(now - 5 * 60_000).toISOString());
    const data = buildWeeklyReportData({
      apps: [
        { name: 'Alpha', repo: 'o/a' },
        { name: 'Beta', repo: 'o/b' },
        { name: 'Gamma', repo: 'o/g' },
        { name: 'Delta', repo: 'o/d' },
      ],
      store: s,
      nowMs: now,
    });
    expect(data.longestIncidents).toHaveLength(3);
    expect(data.longestIncidents[0].app).toBe('Gamma');
    expect(data.longestIncidents[0].open).toBe(true);
    expect(data.longestIncidents[0].durationMin).toBeGreaterThan(59);
    expect(data.longestIncidents[1].app).toBe('Beta');
    expect(data.longestIncidents[1].open).toBe(false);
    expect(data.longestIncidents[1].durationMin).toBe(45);
    expect(data.longestIncidents[2].app).toBe('Alpha');
    s.close();
  });

  it('includes notes on longestIncidents', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    const id = s.openIncident('Beta', new Date(now - 30 * 60_000).toISOString(), 'HTTP 500');
    s.closeIncident('Beta', new Date(now - 10 * 60_000).toISOString());
    s.addIncidentNote(id, 'rolled back deploy', new Date(now - 20 * 60_000).toISOString());
    const data = buildWeeklyReportData({
      apps: [{ name: 'Beta', repo: 'o/b' }],
      store: s,
      nowMs: now,
    });
    expect(data.longestIncidents).toHaveLength(1);
    expect(data.longestIncidents[0].notes).toHaveLength(1);
    expect(data.longestIncidents[0].notes[0].note).toBe('rolled back deploy');
    const text = renderWeeklyReportText(data);
    expect(text).toContain('Longest downtimes');
    expect(text).toContain('Beta');
    expect(text).toContain('HTTP 500');
    expect(text).toContain('rolled back deploy');
    s.close();
  });

  it('renders "(none ...)" under Longest downtimes when there are no incidents', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    const data = buildWeeklyReportData({
      apps: [{ name: 'Alpha', repo: 'o/a' }],
      store: s,
      nowMs: now,
    });
    const text = renderWeeklyReportText(data);
    expect(text).toContain('Longest downtimes');
    expect(text.match(/\(none — nothing went red this week\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    s.close();
  });

  it('marks unresolved incidents as ongoing in the rendered body', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const s = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    s.openIncident('Gamma', new Date(now - 30 * 60_000).toISOString(), 'HTTP 500');
    const data = buildWeeklyReportData({
      apps: [{ name: 'Gamma', repo: 'o/g' }],
      store: s,
      nowMs: now,
    });
    const text = renderWeeklyReportText(data);
    expect(text).toContain('ongoing (truncated at report time)');
    s.close();
  });

  it('caps topDowntime at 3', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      store.openIncident(name, new Date(now - 10 * 60_000).toISOString(), 'x');
      store.closeIncident(name, new Date(now - 5 * 60_000).toISOString());
    }
    const data = buildWeeklyReportData({
      apps: [
        { name: 'A', repo: 'o/a' }, { name: 'B', repo: 'o/b' }, { name: 'C', repo: 'o/c' },
        { name: 'D', repo: 'o/d' }, { name: 'E', repo: 'o/e' },
      ],
      store,
      nowMs: now,
    });
    expect(data.topDowntime).toHaveLength(3);
    store.close();
  });

  it('ignores open-incident downtime when start is unparseable', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    store.openIncident('A', 'not-a-date', 'r');
    const data = buildWeeklyReportData({
      apps: [{ name: 'A', repo: 'o/a' }],
      store,
      nowMs: now,
    });
    const row = data.topDowntime.find((r) => r.app === 'A');
    expect(row?.totalDowntimeMin).toBe(0);
    store.close();
  });
});

describe('renderWeeklyReportText', () => {
  it('includes headline, incident counts, and rollup rows', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = seedStore(now);
    const data = buildWeeklyReportData({ apps: apps(), store, nowMs: now });
    const text = renderWeeklyReportText(data);
    expect(text).toContain('Empire Dashboard');
    expect(text).toContain('Incidents: 2');
    expect(text).toContain('closed 1');
    expect(text).toContain('open 1');
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).toContain('100.00%');
    expect(text).toContain('50.00%');
    expect(text).toContain('Top 3 apps by downtime');
    store.close();
  });

  it('renders "none" when no downtime', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    const data = buildWeeklyReportData({
      apps: [{ name: 'Alpha', repo: 'o/a' }],
      store,
      nowMs: now,
    });
    const text = renderWeeklyReportText(data);
    expect(text).toContain('(none — nothing went red this week)');
    store.close();
  });

  it('renders n/a when no samples', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    const data = buildWeeklyReportData({
      apps: [{ name: 'Alpha', repo: 'o/a' }],
      store,
      nowMs: now,
    });
    const text = renderWeeklyReportText(data);
    expect(text).toContain('Alpha');
    expect(text).toContain('n/a');
    store.close();
  });

  it('renders singular "incident" when count is 1', () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    store.openIncident('A', new Date(now - 2 * 60_000).toISOString(), 'r');
    store.closeIncident('A', new Date(now - 1 * 60_000).toISOString());
    const data = buildWeeklyReportData({
      apps: [{ name: 'A', repo: 'o/a' }],
      store,
      nowMs: now,
    });
    const text = renderWeeklyReportText(data);
    expect(text).toContain('1 incident');
    expect(text).not.toContain('1 incidents');
    store.close();
  });
});

describe('sendWeeklyReport', () => {
  it('sends the rendered body via the provided sender', async () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = seedStore(now);
    const captured: EmailMessage[] = [];
    const sender: EmailSender = {
      send: async (msg) => {
        captured.push(msg);
        return { delivered: true, transport: 'console' };
      },
    };
    const result = await sendWeeklyReport({
      apps: apps(),
      store,
      sender,
      to: 'rob@dearborndenim.com',
      nowMs: now,
    });
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('console');
    expect(result.data.incidentCount).toBe(2);
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe('rob@dearborndenim.com');
    expect(captured[0].subject).toMatch(/2 incidents/);
    expect(captured[0].text).toContain('Empire Dashboard');
    store.close();
  });

  it('uses singular subject when only one incident', async () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    store.openIncident('A', new Date(now - 10 * 60_000).toISOString(), 'x');
    const captured: EmailMessage[] = [];
    const sender: EmailSender = {
      send: async (msg) => { captured.push(msg); return { delivered: true, transport: 'console' }; },
    };
    await sendWeeklyReport({
      apps: [{ name: 'A', repo: 'o/a' }],
      store,
      sender,
      to: 'x',
      nowMs: now,
    });
    expect(captured[0].subject).toMatch(/1 incident$/);
    store.close();
  });

  it('appends "This week\'s fixes" section when fixes are provided', async () => {
    const now = Date.parse('2026-04-18T00:00:00.000Z');
    const store = new SqliteHistoryStore({ filePath: ':memory:', now: () => now });
    const captured: EmailMessage[] = [];
    const sender: EmailSender = {
      send: async (msg) => { captured.push(msg); return { delivered: true, transport: 'console' }; },
    };
    await sendWeeklyReport({
      apps: apps(),
      store,
      sender,
      to: 'x',
      nowMs: now,
      fixes: [
        {
          owner: 'dearborndenim',
          repo: 'alpha',
          sha: 'abc1234',
          shortSha: 'abc1234',
          message: 'fix: X',
          date: '2026-04-17T00:00:00Z',
        },
      ],
    });
    expect(captured[0].text).toContain("This week's fixes");
    expect(captured[0].text).toContain('dearborndenim/alpha: fix: X (abc1234)');
    store.close();
  });

  it('omits the fixes section when no fixes are provided', () => {
    const data = {
      windowDays: 7,
      generatedAt: 'x',
      incidentCount: 0,
      closedCount: 0,
      openCount: 0,
      uptimeRollup: [],
      topDowntime: [],
      longestIncidents: [],
      mtbfMttr: [],
      topRootCauses: [],
    };
    const text = renderWeeklyReportText(data);
    expect(text).not.toContain("This week's fixes");
  });
});
