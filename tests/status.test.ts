import { combineStatus, formatHours } from '../src/status';
import { HealthResult } from '../src/healthChecker';
import { ActivityResult } from '../src/activityTracker';

const okHealth: HealthResult = {
  name: 'A',
  state: 'up',
  statusCode: 200,
  checkedAt: '2026-04-16T00:00:00Z',
};

const downHealth: HealthResult = {
  name: 'A',
  state: 'down',
  statusCode: 500,
  checkedAt: '2026-04-16T00:00:00Z',
  error: 'boom',
};

const unknownHealth: HealthResult = {
  name: 'A',
  state: 'unknown',
  checkedAt: '2026-04-16T00:00:00Z',
  error: 'no url configured',
};

const activity = (hours?: number, error?: string): ActivityResult => ({
  name: 'A',
  repo: 'o/a',
  hoursSinceCommit: hours,
  error,
});

describe('combineStatus', () => {
  it('green when up and recently committed', () => {
    const s = combineStatus(okHealth, activity(2), 'o/a');
    expect(s.color).toBe('green');
    expect(s.summary).toMatch(/Up, committed/);
  });

  it('yellow when up but commit is stale', () => {
    const s = combineStatus(okHealth, activity(48), 'o/a');
    expect(s.color).toBe('yellow');
  });

  it('yellow when up but commit data is missing', () => {
    const s = combineStatus(okHealth, activity(undefined), 'o/a');
    expect(s.color).toBe('yellow');
  });

  it('yellow with error message when up but activity errored', () => {
    const s = combineStatus(okHealth, activity(undefined, 'rate limited'), 'o/a');
    expect(s.color).toBe('yellow');
    expect(s.summary).toMatch(/rate limited/);
  });

  it('red when down, includes HTTP code', () => {
    const s = combineStatus(downHealth, activity(1), 'o/a');
    expect(s.color).toBe('red');
    expect(s.summary).toMatch(/500/);
  });

  it('gray when health unknown', () => {
    const s = combineStatus(unknownHealth, activity(1), 'o/a');
    expect(s.color).toBe('gray');
  });

  it('accepts custom freshness window', () => {
    const s = combineStatus(okHealth, activity(30), 'o/a', { activityFreshHours: 72 });
    expect(s.color).toBe('green');
  });
});

describe('formatHours', () => {
  it('minutes under 1h', () => {
    expect(formatHours(0.5)).toBe('30m');
  });

  it('hours under a day', () => {
    expect(formatHours(5)).toBe('5h');
  });

  it('days under two weeks', () => {
    expect(formatHours(48)).toBe('2d');
  });

  it('weeks when very stale', () => {
    expect(formatHours(24 * 30)).toBe('4w');
  });
});
