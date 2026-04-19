/**
 * Tiny time-of-week scheduler.
 *
 * We don't want to pull in node-cron for a single weekly job. This module
 * computes the next occurrence of `dayOfWeek` + `hourLocal` for a given
 * IANA timezone and schedules a setTimeout; when it fires it invokes the
 * callback, then re-schedules for the following week.
 *
 * Timezone math uses Intl.DateTimeFormat in the `en-US` locale to read the
 * wall-clock time in the target zone — no moment / luxon dependency.
 */

export interface WeeklyScheduleOptions {
  /** 0 = Sunday, 1 = Monday ... 6 = Saturday (wall-clock in `timezone`). */
  dayOfWeek: number;
  /** 0-23 hour in wall-clock of `timezone`. */
  hourLocal: number;
  /** IANA timezone id, e.g. "America/Chicago". */
  timezone: string;
  now?: () => number;
}

/**
 * Read the wall-clock components for `epochMs` inside `timezone`. Returns
 * the parts as numbers — year, month (1-12), day (1-31), hour (0-23),
 * minute, second, and ISO day of week (0-6 where 0 is Sunday).
 */
export function partsInZone(
  epochMs: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;

  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  // `hour` in `en-US` with hour12:false returns "24" at midnight in some
  // Node builds; normalise to 0.
  const rawHour = Number(map.hour);
  const hour = rawHour === 24 ? 0 : rawHour;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    dayOfWeek: dowMap[map.weekday ?? 'Sun'] ?? 0,
  };
}

/**
 * Compute milliseconds until the next `dayOfWeek`/`hourLocal` in
 * `timezone`, strictly greater than zero. If the target moment is "right
 * now" we jump to a week from now rather than firing immediately.
 */
export function msUntilNextWeeklyRun(opts: WeeklyScheduleOptions): number {
  const now = opts.now ? opts.now() : Date.now();

  // Candidate: same calendar day as today, hh:00:00 local. Probe at 1-minute
  // resolution by stepping forward in 1-minute chunks until we find a
  // timestamp whose zone-local wall-clock matches the target dow+hour+minute=0+second=0.
  // In practice we only need per-hour precision; one-minute granularity is a
  // small constant cost (at most 7*24*60 = 10080 iterations) and avoids
  // needing to think about DST transitions.
  // We also short-circuit once we've moved at least 1 minute past "now".
  const stepMs = 60_000;
  // Start from ceil(now/step) so we don't return 0.
  const start = Math.ceil((now + 1) / stepMs) * stepMs;
  const maxSteps = 8 * 24 * 60; // 8 days of minutes - safe upper bound
  for (let i = 0; i < maxSteps; i++) {
    const candidate = start + i * stepMs;
    const parts = partsInZone(candidate, opts.timezone);
    if (
      parts.dayOfWeek === opts.dayOfWeek &&
      parts.hour === opts.hourLocal &&
      parts.minute === 0
    ) {
      return candidate - now;
    }
  }
  // Shouldn't be reachable with a valid timezone + day/hour; fall back to 7d.
  return 7 * 24 * 3600_000;
}

export interface WeeklyJobHandle {
  stop(): void;
}

export interface StartWeeklyJobOptions extends WeeklyScheduleOptions {
  name: string;
  run: () => Promise<void> | void;
  onError?: (err: unknown) => void;
  /**
   * Replaceable timer implementation for tests. Must behave like
   * `setTimeout`/`clearTimeout` (returns an opaque handle that
   * `clearTimer` accepts).
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Start a weekly job. The returned handle can be used to stop it.
 */
export function startWeeklyJob(opts: StartWeeklyJobOptions): WeeklyJobHandle {
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const onError = opts.onError ?? ((err) => console.error(`[scheduler] ${opts.name} error:`, err));

  let timer: unknown = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const delay = msUntilNextWeeklyRun(opts);
    timer = setT(() => {
      // Fire the job; swallow errors, then reschedule regardless.
      Promise.resolve()
        .then(() => opts.run())
        .catch((err) => onError(err))
        .finally(() => schedule());
    }, delay);
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}
