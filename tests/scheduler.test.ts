import {
  msUntilNextWeeklyRun,
  partsInZone,
  startWeeklyJob,
  msUntilNextDailyRun,
  startDailyJob,
} from '../src/scheduler';

describe('partsInZone', () => {
  it('returns correct parts for a known UTC moment in America/Chicago', () => {
    // 2026-04-20 12:00 UTC -> 07:00 CDT in Chicago (DST in effect)
    const ms = Date.parse('2026-04-20T12:00:00.000Z');
    const p = partsInZone(ms, 'America/Chicago');
    expect(p.year).toBe(2026);
    expect(p.month).toBe(4);
    expect(p.day).toBe(20);
    expect(p.hour).toBe(7);
    expect(p.minute).toBe(0);
    expect(p.dayOfWeek).toBe(1); // Monday
  });

  it('maps Sun-Sat correctly', () => {
    const sunday = Date.parse('2026-04-19T18:00:00.000Z'); // Sun 1pm CDT
    expect(partsInZone(sunday, 'America/Chicago').dayOfWeek).toBe(0);
    const saturday = Date.parse('2026-04-18T18:00:00.000Z'); // Sat 1pm CDT
    expect(partsInZone(saturday, 'America/Chicago').dayOfWeek).toBe(6);
  });
});

describe('msUntilNextWeeklyRun', () => {
  it('computes delay to the upcoming Mon 7am in Chicago', () => {
    // Sunday 2026-04-19 12:00 UTC = 07:00 CDT.
    const now = Date.parse('2026-04-19T12:00:00.000Z');
    const delay = msUntilNextWeeklyRun({
      dayOfWeek: 1, hourLocal: 7, timezone: 'America/Chicago', now: () => now,
    });
    // Next Monday 7am CDT = 2026-04-20T12:00:00Z -> 24h from now.
    expect(delay).toBe(24 * 3600_000);
  });

  it('returns a positive delay even when now == target moment', () => {
    // Monday 2026-04-20T12:00:00Z = 7am CDT exactly.
    const now = Date.parse('2026-04-20T12:00:00.000Z');
    const delay = msUntilNextWeeklyRun({
      dayOfWeek: 1, hourLocal: 7, timezone: 'America/Chicago', now: () => now,
    });
    // Should jump to next Monday, not fire now.
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(7 * 24 * 3600_000);
  });

  it('works for other days of the week', () => {
    // Thursday 2026-04-16T12:00:00Z = 7am CDT.
    const now = Date.parse('2026-04-16T12:00:00.000Z');
    const delay = msUntilNextWeeklyRun({
      dayOfWeek: 5, hourLocal: 7, timezone: 'America/Chicago', now: () => now,
    });
    // Next Friday 7am CDT = 2026-04-17T12:00:00Z -> 24h.
    expect(delay).toBe(24 * 3600_000);
  });
});

describe('startWeeklyJob', () => {
  it('schedules the job via the injected setTimer and stops cleanly', () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const clears: unknown[] = [];
    const handle = startWeeklyJob({
      name: 'test',
      dayOfWeek: 1,
      hourLocal: 7,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'), // Sunday midnight UTC
      run: async () => { /* noop */ },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => clears.push(t),
    });
    expect(timers.length).toBe(1);
    // Next Monday 07:00 UTC = 2026-04-20T07:00:00Z -> 31h from ref.
    expect(timers[0].ms).toBe(31 * 3600_000);
    handle.stop();
    expect(clears.length).toBe(1);
  });

  it('invokes the run function when the timer fires and reschedules', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;
    startWeeklyJob({
      name: 'test',
      dayOfWeek: 1,
      hourLocal: 7,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'),
      run: () => { calls += 1; },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => { /* noop */ },
    });
    expect(timers.length).toBe(1);
    // Fire the first timer and flush the microtask queue.
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    // Should have scheduled itself again.
    expect(timers.length).toBe(2);
  });

  it('calls onError when the job throws and still reschedules', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const errors: unknown[] = [];
    startWeeklyJob({
      name: 'test',
      dayOfWeek: 1,
      hourLocal: 7,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'),
      run: async () => { throw new Error('boom'); },
      onError: (e) => errors.push(e),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => { /* noop */ },
    });
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(timers.length).toBe(2);
  });

  it('stop() prevents further reschedules after an in-flight fire', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const handle = startWeeklyJob({
      name: 'test',
      dayOfWeek: 1,
      hourLocal: 7,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'),
      run: () => { /* noop */ },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => { /* noop */ },
    });
    handle.stop();
    // Firing the original timer should not schedule another.
    const countBefore = timers.length;
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.length).toBe(countBefore);
  });
});

describe('msUntilNextDailyRun', () => {
  it('computes delay to the next 3 AM America/Chicago from midnight Chicago', () => {
    // 2026-04-19T05:00:00Z = midnight CDT.
    const now = Date.parse('2026-04-19T05:00:00.000Z');
    const delay = msUntilNextDailyRun({
      hourLocal: 3,
      timezone: 'America/Chicago',
      now: () => now,
    });
    expect(delay).toBe(3 * 3600_000);
  });

  it('returns a positive delay when now equals the target moment', () => {
    const now = Date.parse('2026-04-19T08:00:00.000Z'); // 3am CDT exactly
    const delay = msUntilNextDailyRun({
      hourLocal: 3,
      timezone: 'America/Chicago',
      now: () => now,
    });
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 3600_000);
  });
});

describe('startDailyJob', () => {
  it('schedules via the injected setTimer and stops cleanly', () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const clears: unknown[] = [];
    const handle = startDailyJob({
      name: 'test-daily',
      hourLocal: 3,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'), // midnight UTC
      run: () => { /* noop */ },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => clears.push(t),
    });
    expect(timers.length).toBe(1);
    expect(timers[0].ms).toBe(3 * 3600_000);
    handle.stop();
    expect(clears.length).toBe(1);
  });

  it('invokes run on fire and reschedules', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;
    startDailyJob({
      name: 'test-daily',
      hourLocal: 3,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'),
      run: () => { calls += 1; },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => { /* noop */ },
    });
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(timers.length).toBe(2);
  });

  it('calls onError on thrown run and reschedules', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const errors: unknown[] = [];
    startDailyJob({
      name: 'test-daily',
      hourLocal: 3,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'),
      run: async () => { throw new Error('bad'); },
      onError: (e) => errors.push(e),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => { /* noop */ },
    });
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.length).toBe(1);
    expect(timers.length).toBe(2);
  });

  it('stop() prevents further reschedules', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const handle = startDailyJob({
      name: 'test-daily',
      hourLocal: 3,
      timezone: 'UTC',
      now: () => Date.parse('2026-04-19T00:00:00.000Z'),
      run: () => { /* noop */ },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => { /* noop */ },
    });
    handle.stop();
    const before = timers.length;
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.length).toBe(before);
  });
});
