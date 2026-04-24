import fs from 'fs';
import path from 'path';

export interface AppConfig {
  /** Display name of the app */
  name: string;
  /** GitHub repository (owner/repo) for activity tracking */
  repo: string;
  /** Public or internal URL of the running service (without trailing slash) */
  url?: string;
  /** Path to health endpoint. Defaults to /health */
  healthPath?: string;
  /**
   * Optional URL that jumps directly to this app's Railway logs/service page.
   * When present the dashboard renders an active "logs" link; otherwise the
   * link renders disabled.
   */
  railwayLogsUrl?: string;
}

/**
 * Default list of apps to monitor. URLs can be overridden via
 * APPS_URL_OVERRIDES env var or a JSON file at APPS_CONFIG_PATH.
 */
export const DEFAULT_APPS: AppConfig[] = [
  { name: 'McSecretary', repo: 'dearborndenim/McSecretary' },
  { name: 'kanban-purchaser', repo: 'dearborndenim/kanban-purchaser' },
  { name: 'influencer-outreach', repo: 'dearborndenim/influencer-outreach' },
  { name: 'purchase-order-receiver', repo: 'dearborndenim/purchase-order-receiver' },
  { name: 'content-engine', repo: 'dearborndenim/content-engine' },
  { name: 'piece-work-scanner', repo: 'dearborndenim/piece-work-scanner' },
  { name: 'permitready', repo: 'dearborndenim/chicago-building-code' },
  { name: 'dearborn-ai-agents', repo: 'dearborndenim/dearborn-ai-agents' },
  { name: 'DDA-CS-Manager', repo: 'dearborndenim/DDA-CS-Manager' },
  { name: 'diamond-pickaxe-returns-processor', repo: 'dearborndenim/diamond-pickaxe-returns-processor' },
];

export function parseUrlOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export function loadAppsFromFile(filePath: string): AppConfig[] {
  const data = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(data);
  if (!Array.isArray(parsed)) {
    throw new Error(`apps config must be an array at ${filePath}`);
  }
  return parsed.map((item: Partial<AppConfig>, i: number): AppConfig => {
    if (!item.name || !item.repo) {
      throw new Error(`apps config entry ${i} missing name or repo`);
    }
    return {
      name: item.name,
      repo: item.repo,
      url: item.url,
      healthPath: item.healthPath,
      railwayLogsUrl: item.railwayLogsUrl,
    };
  });
}

export function buildAppList(
  base: AppConfig[],
  overrides: Record<string, string>,
  railwayLogsOverrides: Record<string, string> = {},
): AppConfig[] {
  return base.map((app) => {
    const url = overrides[app.name] ?? app.url;
    const railwayLogsUrl = railwayLogsOverrides[app.name] ?? app.railwayLogsUrl;
    return { ...app, url, railwayLogsUrl };
  });
}

export interface RuntimeConfig {
  port: number;
  githubToken?: string;
  githubOwner: string;
  healthCacheTtlSec: number;
  healthTimeoutMs: number;
  pollIntervalMs: number;
  apps: AppConfig[];
  historyDbPath: string;
  historyRetentionDays: number;
  incidentsRetentionDays: number;
  incidentsAdminToken?: string;
  /**
   * Alert throttling polish (2026-04-23): default cooldown between alert
   * fires for the same integration. Per-key SQLite override (set via the
   * historyStore) wins when present. Default 3600 seconds.
   */
  integrationAlertCooldownSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = Number(env.PORT ?? 3000);
  const healthCacheTtlSec = Number(env.HEALTH_CACHE_TTL ?? 60);
  const healthTimeoutMs = Number(env.HEALTH_TIMEOUT_MS ?? 5000);
  const pollIntervalMs = Number(env.POLL_INTERVAL_MS ?? 300000);
  const githubOwner = env.GITHUB_OWNER ?? 'dearborndenim';
  const githubToken = env.GITHUB_TOKEN || undefined;
  const historyDbPath = env.HISTORY_DB_PATH ?? './data/history.db';
  const historyRetentionDays = Number(env.HISTORY_RETENTION_DAYS ?? 7);
  const incidentsRetentionRaw = Number(env.INCIDENTS_RETENTION_DAYS ?? 30);
  const incidentsRetentionDays =
    Number.isFinite(incidentsRetentionRaw) && incidentsRetentionRaw > 0
      ? incidentsRetentionRaw
      : 30;
  const incidentsAdminToken = env.INCIDENTS_ADMIN_TOKEN || undefined;
  const cooldownRaw = Number(env.INTEGRATION_ALERT_COOLDOWN_SECONDS ?? 3600);
  const integrationAlertCooldownSeconds =
    Number.isFinite(cooldownRaw) && cooldownRaw > 0 ? cooldownRaw : 3600;

  let apps: AppConfig[] = DEFAULT_APPS;
  if (env.APPS_CONFIG_PATH) {
    const resolved = path.isAbsolute(env.APPS_CONFIG_PATH)
      ? env.APPS_CONFIG_PATH
      : path.resolve(process.cwd(), env.APPS_CONFIG_PATH);
    apps = loadAppsFromFile(resolved);
  }
  apps = buildAppList(
    apps,
    parseUrlOverrides(env.APPS_URL_OVERRIDES),
    parseUrlOverrides(env.APPS_RAILWAY_LOGS_OVERRIDES),
  );

  return {
    port,
    githubToken,
    githubOwner,
    healthCacheTtlSec,
    healthTimeoutMs,
    pollIntervalMs,
    apps,
    historyDbPath,
    historyRetentionDays,
    incidentsRetentionDays,
    incidentsAdminToken,
    integrationAlertCooldownSeconds,
  };
}
