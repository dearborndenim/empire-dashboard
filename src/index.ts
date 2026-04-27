import { Octokit } from '@octokit/rest';
import { loadConfig } from './config';
import { HealthChecker } from './healthChecker';
import { ActivityTracker, createOctokitAdapter } from './activityTracker';
import { createApp, collectStatuses } from './app';
import { SqliteHistoryStore } from './historyStore';
import { IncidentTracker } from './incidentTracker';
import { selectEmailSender } from './email';
import { sendWeeklyReport } from './weeklyReport';
import { startWeeklyJob, startDailyJob } from './scheduler';
import {
  IntegrationTilesFetcher,
  loadIntegrationTilesConfig,
} from './integrationTiles';
import { snapshotIntegrationStats } from './integrationStatsJob';
import {
  GithubFixesClient,
  fetchThisWeeksFixes,
  octokitCommitFetcher,
} from './githubFixes';
import { selectAlertSender } from './alertSender';
import { IntegrationAlertMonitor } from './integrationAlertMonitor';
import { sendAlertAuditDigest } from './alertAuditDigest';

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

  let incidentTracker: IncidentTracker | undefined;
  if (historyStore) {
    incidentTracker = new IncidentTracker({
      store: historyStore,
      appNames: config.apps.map((a) => a.name),
    });
  }

  // Email transport selection — stubbed to stdout unless future SMTP wiring.
  const emailSelection = selectEmailSender(process.env);
  console.log(
    `[empire-dashboard] email transport: ${emailSelection.transport}${emailSelection.disabled ? ' (EMAIL_DISABLED=1)' : ''}`,
  );

  // Integration observability tiles (PO receiver / kanban webhooks).
  const integrationConfig = loadIntegrationTilesConfig(process.env);
  const integrationTiles = new IntegrationTilesFetcher({
    config: integrationConfig,
    sparklineResolver: historyStore
      ? (id) =>
          historyStore!.listIntegrationStats(id, 7).map((r) => ({
            date: r.date,
            successRate: r.success_rate,
            totalAttempts: r.total_attempts,
          }))
      : undefined,
  });

  const app = createApp({
    config,
    healthChecker,
    activityTracker,
    historyStore,
    incidentTracker,
    integrationTiles,
    incidentsAdminToken: config.incidentsAdminToken,
  });

  const server = app.listen(config.port, () => {
    console.log(`[empire-dashboard] listening on :${config.port}`);
    console.log(`[empire-dashboard] monitoring ${config.apps.length} apps`);
  });

  // Warm the caches right away and then poll on interval.
  const refresh = async (): Promise<void> => {
    try {
      await collectStatuses(
        { config, healthChecker, activityTracker, historyStore, incidentTracker },
        { force: true },
      );
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

  // Optional GitHub "This week's fixes" section on the weekly report. Only
  // activates when GITHUB_TOKEN is set; otherwise we gracefully omit.
  const fixesClient = config.githubToken
    ? new GithubFixesClient({
        fetcher: octokitCommitFetcher(
          new Octokit({ auth: config.githubToken }) as unknown as Parameters<typeof octokitCommitFetcher>[0],
        ),
      })
    : null;

  // Weekly summary email — Monday 7 AM CT (America/Chicago).
  const weeklyReportTo = process.env.WEEKLY_REPORT_TO ?? 'rob@dearborndenim.com';
  const weeklyReportFrom = process.env.WEEKLY_REPORT_FROM;
  let weeklyJob: { stop(): void } | undefined;
  if (historyStore) {
    weeklyJob = startWeeklyJob({
      name: 'weekly-report',
      dayOfWeek: 1,
      hourLocal: 7,
      timezone: 'America/Chicago',
      run: async () => {
        try {
          // If we have a GitHub client, pull per-app latest commits.
          const fixes = fixesClient
            ? await fetchThisWeeksFixes({
                owner: config.githubOwner,
                repos: config.apps.map((a) => {
                  // repo field is "owner/repo"; we want just the repo portion
                  const slash = a.repo.indexOf('/');
                  return slash >= 0 ? a.repo.slice(slash + 1) : a.repo;
                }),
                fetcher: (opts) => fixesClient.getLatestCommit(opts.owner, opts.repo).then((fix) =>
                  fix
                    ? { sha: fix.sha, message: fix.message, date: fix.date }
                    : null,
                ),
              })
            : [];
          const result = await sendWeeklyReport({
            apps: config.apps,
            store: historyStore!,
            sender: emailSelection.sender,
            to: weeklyReportTo,
            from: weeklyReportFrom,
            fixes,
          });
          console.log(
            `[empire-dashboard] weekly report sent via ${result.transport} (incidents=${result.data.incidentCount}, fixes=${fixes.length})`,
          );
        } catch (err) {
          console.error('[empire-dashboard] weekly report failed:', err);
        }
      },
    });
  }

  // Daily incident-retention prune — 3 AM America/Chicago.
  let dailyPruneJob: { stop(): void } | undefined;
  if (historyStore) {
    dailyPruneJob = startDailyJob({
      name: 'incident-prune',
      hourLocal: 3,
      timezone: 'America/Chicago',
      run: () => {
        try {
          const removed = historyStore!.pruneIncidents(config.incidentsRetentionDays);
          historyStore!.recordPruneRun({
            ran_at: new Date().toISOString(),
            // We don't currently track note deletions separately from
            // cascading, but leave this pre-computed for future audits.
            deleted_count: removed,
            deleted_notes_count: 0,
          });
          console.log(
            `[empire-dashboard] incident prune removed ${removed} closed incidents older than ${config.incidentsRetentionDays}d`,
          );
        } catch (err) {
          console.error('[empire-dashboard] incident prune failed:', err);
        }
      },
    });
  }

  // Daily integration stats snapshot — 3 AM America/Chicago (alongside prune).
  let dailyIntegrationSnapshotJob: { stop(): void } | undefined;
  if (historyStore) {
    dailyIntegrationSnapshotJob = startDailyJob({
      name: 'integration-stats-snapshot',
      hourLocal: 3,
      timezone: 'America/Chicago',
      run: async () => {
        try {
          await snapshotIntegrationStats({
            store: historyStore!,
            fetcher: integrationTiles,
          });
        } catch (err) {
          console.error('[empire-dashboard] integration stats snapshot failed:', err);
        }
      },
    });
  }

  // Alert sender + integration success-rate monitor (Task 1.2 / 1.4).
  const alertSelection = selectAlertSender(process.env);
  console.log(
    `[empire-dashboard] alert transport: ${alertSelection.transport}${alertSelection.disabled ? ' (ALERTS_DISABLED=1)' : ''}`,
  );

  let integrationAlertJob: { stop(): void } | undefined;
  if (historyStore) {
    const monitor = new IntegrationAlertMonitor({
      store: historyStore,
      alertSender: alertSelection.sender,
      cooldownMs: config.integrationAlertCooldownSeconds * 1000,
    });
    integrationAlertJob = startDailyJob({
      name: 'integration-alert-check',
      hourLocal: 4,
      timezone: 'America/Chicago',
      run: async () => {
        try {
          const res = await monitor.check();
          if (res.fired.length > 0) {
            console.log(
              `[empire-dashboard] integration alerts fired=${res.fired.length} skipped=${res.skipped.length}`,
            );
          }
        } catch (err) {
          console.error('[empire-dashboard] integration alert check failed:', err);
        }
      },
    });
  }

  // Daily alert audit digest — 7 AM America/Chicago. Mirrors the CFO/PWS/
  // content-engine digest pattern: env-gated (ALERT_AUDIT_DIGEST_RECIPIENT
  // must be set), opt-out via DISABLE_ALERT_AUDIT_DIGEST=1, empty case sends
  // nothing.
  let alertAuditDigestJob: { stop(): void } | undefined;
  if (historyStore) {
    alertAuditDigestJob = startDailyJob({
      name: 'alert-audit-digest',
      hourLocal: 7,
      timezone: 'America/Chicago',
      run: async () => {
        try {
          const res = await sendAlertAuditDigest({
            store: historyStore!,
            sender: emailSelection.sender,
          });
          if (res.sent) {
            console.log(
              `[empire-dashboard] alert audit digest sent via ${res.transport ?? 'unknown'} (fires=${res.data.totalFires}, total=${res.data.total})`,
            );
          } else {
            console.log(
              `[empire-dashboard] alert audit digest skipped: ${res.reason}`,
            );
          }
        } catch (err) {
          console.error('[empire-dashboard] alert audit digest failed:', err);
        }
      },
    });
  }

  const shutdown = (signal: string): void => {
    console.log(`[empire-dashboard] ${signal} received, shutting down`);
    clearInterval(timer);
    if (weeklyJob) weeklyJob.stop();
    if (dailyPruneJob) dailyPruneJob.stop();
    if (dailyIntegrationSnapshotJob) dailyIntegrationSnapshotJob.stop();
    if (integrationAlertJob) integrationAlertJob.stop();
    if (alertAuditDigestJob) alertAuditDigestJob.stop();
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
