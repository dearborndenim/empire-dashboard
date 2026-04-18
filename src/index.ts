import { Octokit } from '@octokit/rest';
import { loadConfig } from './config';
import { HealthChecker } from './healthChecker';
import { ActivityTracker, createOctokitAdapter } from './activityTracker';
import { createApp, collectStatuses } from './app';
import { SqliteHistoryStore } from './historyStore';

async function main(): Promise<void> {
  const config = loadConfig();

  const healthChecker = new HealthChecker({
    timeoutMs: config.healthTimeoutMs,
    cacheTtlSec: config.healthCacheTtlSec,
  });

  let activityTracker: ActivityTracker;
  if (config.githubToken) {
    const octokit = new Octokit({ auth: config.githubToken });
    activityTracker = new ActivityTracker({ client: createOctokitAdapter(octokit) });
  } else {
    // No token — unauthenticated GitHub calls are heavily rate-limited, so
    // wire up an unauthenticated Octokit and let it fail softly per-app.
    const octokit = new Octokit();
    activityTracker = new ActivityTracker({ client: createOctokitAdapter(octokit) });
  }

  let historyStore: SqliteHistoryStore | undefined;
  try {
    historyStore = new SqliteHistoryStore({
      filePath: config.historyDbPath,
      retentionDays: config.historyRetentionDays,
    });
    console.log(`[empire-dashboard] history store: ${config.historyDbPath}`);
  } catch (err) {
    console.error('[empire-dashboard] history store disabled:', err);
  }

  const app = createApp({ config, healthChecker, activityTracker, historyStore });

  const server = app.listen(config.port, () => {
    console.log(`[empire-dashboard] listening on :${config.port}`);
    console.log(`[empire-dashboard] monitoring ${config.apps.length} apps`);
  });

  // Warm the caches right away and then poll on interval.
  const refresh = async (): Promise<void> => {
    try {
      await collectStatuses({ config, healthChecker, activityTracker, historyStore }, { force: true });
      if (historyStore) {
        try {
          historyStore.pruneOlderThan(config.historyRetentionDays);
        } catch (err) {
          console.error('[empire-dashboard] prune failed:', err);
        }
      }
      console.log(`[empire-dashboard] refreshed statuses at ${new Date().toISOString()}`);
    } catch (err) {
      console.error('[empire-dashboard] refresh error:', err);
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), config.pollIntervalMs);

  const shutdown = (signal: string): void => {
    console.log(`[empire-dashboard] ${signal} received, shutting down`);
    clearInterval(timer);
    if (historyStore) {
      try { historyStore.close(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main().catch((err) => {
  console.error('[empire-dashboard] fatal:', err);
  process.exit(1);
});
