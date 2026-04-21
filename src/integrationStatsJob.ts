/**
 * Daily snapshot cron for integration success rates.
 *
 * Every morning (3 AM America/Chicago), for each configured integration we
 * fetch the *current* success_rate + total_attempts and upsert a row into
 * `integration_stats_history`. The dashboard reads these rows to render a
 * 7-day sparkline inline on each tile.
 *
 * The job is intentionally tolerant — one remote failing should never take
 * down the snapshot for the others, and errors are swallowed into a summary
 * log line.
 */

import { HistoryStore } from './historyStore';
import { IntegrationTilesFetcher } from './integrationTiles';

export interface SnapshotIntegrationStatsOptions {
  store: HistoryStore;
  fetcher: IntegrationTilesFetcher;
  now?: () => number;
  /** Logger for the one-line summary; defaults to console. */
  logger?: Pick<Console, 'log' | 'error'>;
}

export interface SnapshotResult {
  recorded: Array<{ integration: string; successRate: number; totalAttempts: number }>;
  skipped: Array<{ integration: string; reason: string }>;
}

/** Format `epochMs` as "YYYY-MM-DD" in UTC. */
export function toUtcDate(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Fetch current integration stats and persist a per-day snapshot.
 * Returns a summary of what was recorded vs skipped so callers can log it.
 */
export async function snapshotIntegrationStats(
  opts: SnapshotIntegrationStatsOptions,
): Promise<SnapshotResult> {
  const now = opts.now ? opts.now() : Date.now();
  const logger = opts.logger ?? console;
  const date = toUtcDate(now);
  const snapshotAt = new Date(now).toISOString();
  const result: SnapshotResult = { recorded: [], skipped: [] };

  const stats = await opts.fetcher.fetchRawStats();
  for (const entry of stats) {
    if (entry.successRate === null || entry.totalAttempts === null) {
      result.skipped.push({
        integration: entry.integration,
        reason: entry.error ?? 'insufficient data',
      });
      continue;
    }
    try {
      opts.store.recordIntegrationStat({
        integration_name: entry.integration,
        date,
        success_rate: entry.successRate,
        total_attempts: entry.totalAttempts,
        snapshot_at: snapshotAt,
      });
      result.recorded.push({
        integration: entry.integration,
        successRate: entry.successRate,
        totalAttempts: entry.totalAttempts,
      });
    } catch (err) {
      logger.error(
        `[empire-dashboard] integration snapshot failed for ${entry.integration}:`,
        err,
      );
      result.skipped.push({
        integration: entry.integration,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.log(
    `[empire-dashboard] integration stats snapshot @ ${snapshotAt} — recorded=${result.recorded.length} skipped=${result.skipped.length}`,
  );
  return result;
}
