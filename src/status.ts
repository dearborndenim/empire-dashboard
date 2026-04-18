import { ActivityResult } from './activityTracker';
import { HealthResult } from './healthChecker';
import { SparklineCell } from './sparkline';

export type StatusColor = 'green' | 'yellow' | 'red' | 'gray';

export interface AppStatus {
  name: string;
  repo: string;
  color: StatusColor;
  health: HealthResult;
  activity: ActivityResult;
  /** Human-readable summary of why this app has the color it has. */
  summary: string;
  /** Optional deep link to Railway logs for this service. */
  railway_logs_url?: string;
  /** Uptime percentage over the last 7 days, formatted like "99.2%". */
  uptime_7d?: string | null;
  /** 24 cells, oldest first, one per hour. */
  sparkline_24h?: SparklineCell[];
}

export interface CombineOptions {
  activityFreshHours?: number;
}

/**
 * Combines health + activity into a single status with a color.
 *
 * - green  = up AND activity within freshness window
 * - yellow = up AND no recent activity (or activity unknown)
 * - red    = down
 * - gray   = health unknown (e.g. URL not configured)
 */
export function combineStatus(
  health: HealthResult,
  activity: ActivityResult,
  repo: string,
  opts: CombineOptions = {},
): AppStatus {
  const freshHours = opts.activityFreshHours ?? 24;

  let color: StatusColor;
  let summary: string;

  if (health.state === 'down') {
    color = 'red';
    summary = `Down${health.statusCode ? ` (HTTP ${health.statusCode})` : ''}${health.error ? `: ${health.error}` : ''}`;
  } else if (health.state === 'unknown') {
    color = 'gray';
    summary = `Health unknown${health.error ? `: ${health.error}` : ''}`;
  } else {
    // state === 'up'
    const hours = activity.hoursSinceCommit;
    if (typeof hours === 'number' && hours <= freshHours) {
      color = 'green';
      summary = `Up, committed ${formatHours(hours)} ago`;
    } else if (typeof hours === 'number') {
      color = 'yellow';
      summary = `Up, last commit ${formatHours(hours)} ago`;
    } else {
      color = 'yellow';
      summary = activity.error ? `Up, activity unknown (${activity.error})` : 'Up, no commit data';
    }
  }

  return {
    name: health.name,
    repo,
    color,
    health,
    activity,
    summary,
  };
}

export function formatHours(hours: number): string {
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m}m`;
  }
  if (hours < 24) {
    return `${Math.round(hours)}h`;
  }
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}
