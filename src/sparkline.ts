import { HourBucket } from './historyStore';

export type SparklineCell = 'green' | 'yellow' | 'red' | 'gray';

/**
 * Convert an ordered list of hour buckets into color cells for the
 * 24-hour sparkline on each card. Buckets with zero samples render gray
 * (no data). >= 99% uptime is green, >= 80% yellow, everything else red.
 */
export function bucketsToSparkline(buckets: HourBucket[]): SparklineCell[] {
  return buckets.map((b) => {
    if (b.total === 0) return 'gray';
    const pct = (b.up / b.total) * 100;
    if (pct >= 99) return 'green';
    if (pct >= 80) return 'yellow';
    return 'red';
  });
}

/**
 * Convenience helper used by JSON consumers: render uptime % with one
 * decimal place. Returns null when input is null (preserves "no data" state).
 */
export function formatUptimePercent(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  return `${value.toFixed(1)}%`;
}
