import { bucketsToSparkline, formatUptimePercent } from '../src/sparkline';
import { HourBucket } from '../src/historyStore';

function bucket(total: number, up: number, offsetHours = 0): HourBucket {
  return {
    hour: new Date(Date.parse('2026-04-17T00:00:00Z') + offsetHours * 3600_000).toISOString(),
    total,
    up,
  };
}

describe('bucketsToSparkline', () => {
  it('produces one cell per bucket', () => {
    const buckets = [bucket(1, 1), bucket(1, 0), bucket(0, 0)];
    const out = bucketsToSparkline(buckets);
    expect(out).toHaveLength(3);
  });

  it('maps >= 99% uptime to green', () => {
    expect(bucketsToSparkline([bucket(100, 99)])[0]).toBe('green');
    expect(bucketsToSparkline([bucket(1, 1)])[0]).toBe('green');
  });

  it('maps >= 80% uptime to yellow', () => {
    expect(bucketsToSparkline([bucket(10, 8)])[0]).toBe('yellow');
    expect(bucketsToSparkline([bucket(100, 98)])[0]).toBe('yellow');
  });

  it('maps < 80% uptime to red', () => {
    expect(bucketsToSparkline([bucket(10, 7)])[0]).toBe('red');
    expect(bucketsToSparkline([bucket(1, 0)])[0]).toBe('red');
  });

  it('renders gray for empty buckets (no data)', () => {
    expect(bucketsToSparkline([bucket(0, 0)])[0]).toBe('gray');
  });

  it('handles 24 mixed buckets', () => {
    const buckets: HourBucket[] = [];
    for (let i = 0; i < 24; i++) {
      if (i < 8) buckets.push(bucket(0, 0, i));
      else if (i < 16) buckets.push(bucket(10, 10, i));
      else buckets.push(bucket(10, 5, i));
    }
    const cells = bucketsToSparkline(buckets);
    expect(cells.slice(0, 8).every((c) => c === 'gray')).toBe(true);
    expect(cells.slice(8, 16).every((c) => c === 'green')).toBe(true);
    expect(cells.slice(16, 24).every((c) => c === 'red')).toBe(true);
  });
});

describe('formatUptimePercent', () => {
  it('formats with one decimal place', () => {
    expect(formatUptimePercent(99.23456)).toBe('99.2%');
    expect(formatUptimePercent(100)).toBe('100.0%');
  });

  it('returns null for null', () => {
    expect(formatUptimePercent(null)).toBeNull();
  });

  it('returns null for non-finite numbers', () => {
    expect(formatUptimePercent(NaN)).toBeNull();
    expect(formatUptimePercent(Infinity)).toBeNull();
  });
});
