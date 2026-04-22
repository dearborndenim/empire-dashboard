/**
 * Integration observability tiles.
 *
 * The main dashboard surfaces a handful of cross-service "glue" tiles so
 * Robert can see at a glance whether upstream webhook integrations between
 * apps are healthy. Today we render two tiles:
 *
 *   - PO Receiver webhook status (success rate + dead-lettered count)
 *   - Kanban inbound webhook stats (total_received + unmatched)
 *
 * Each tile fetches its own remote endpoint, caches responses for ~60s, and
 * falls back to a "Not configured" state when required env vars are missing.
 * Remote errors never crash the dashboard — we render a small error label
 * and let the underlying app's monitor card communicate the truth.
 */

export interface IntegrationTile {
  id: string;
  title: string;
  /** High-level state the UI renders styling for. */
  state: 'ok' | 'warn' | 'error' | 'not-configured';
  /**
   * Short one-line summary (e.g. "98.4% — 2 dead-lettered").
   * The UI renders this under the title.
   */
  summary: string;
  /** Optional structured key/value pairs the UI can render as a mini table. */
  details?: Array<{ label: string; value: string }>;
  /** If the tile is "error" we may have a short reason for Railway logs. */
  error?: string;
  /** Historical daily success-rate points (ascending date) used for a sparkline. */
  sparkline?: IntegrationSparklinePoint[];
}

export interface IntegrationFetchImpl {
  (url: string, init: { headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface IntegrationTilesConfig {
  poReceiverUrl?: string;
  poReceiverApiKey?: string;
  kanbanUrl?: string;
  kanbanApiKey?: string;
  contentEngineUrl?: string;
  contentEngineApiKey?: string;
}

/**
 * Per-integration daily sparkline data pulled from
 * `integration_stats_history`. Rendered inline in each tile when available.
 */
export interface IntegrationSparklinePoint {
  date: string;
  successRate: number;
  totalAttempts: number;
}

export interface IntegrationSparklineResolver {
  (integrationName: string): IntegrationSparklinePoint[];
}

export interface IntegrationTilesOptions {
  config: IntegrationTilesConfig;
  fetchImpl?: IntegrationFetchImpl;
  now?: () => number;
  cacheTtlMs?: number;
  /** Optional resolver that returns daily-snapshot sparkline data per tile. */
  sparklineResolver?: IntegrationSparklineResolver;
}

interface CacheEntry {
  tiles: IntegrationTile[];
  expiresAt: number;
}

/**
 * Fetches + caches integration tiles. Stateful so the 60s TTL actually
 * works across multiple HTTP requests.
 */
export class IntegrationTilesFetcher {
  private readonly config: IntegrationTilesConfig;
  private readonly fetchImpl: IntegrationFetchImpl;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly sparklineResolver?: IntegrationSparklineResolver;
  private cache: CacheEntry | null = null;

  constructor(opts: IntegrationTilesOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.sparklineResolver = opts.sparklineResolver;
  }

  /**
   * Return tiles — from cache if still fresh, otherwise fetch + cache.
   * `force` bypasses the cache (used by tests + explicit refresh).
   */
  async getTiles(opts: { force?: boolean } = {}): Promise<IntegrationTile[]> {
    if (!opts.force && this.cache && this.cache.expiresAt > this.now()) {
      return this.cache.tiles;
    }
    const tiles = await Promise.all([
      fetchPoReceiverTile(this.config, this.fetchImpl),
      fetchKanbanTile(this.config, this.fetchImpl),
      fetchContentEngineTile(this.config, this.fetchImpl),
      fetchSceneDriftTile(this.config, this.fetchImpl),
    ]);
    if (this.sparklineResolver) {
      for (const tile of tiles) {
        if (tile.state === 'not-configured') continue;
        try {
          const spark = this.sparklineResolver(tile.id);
          if (spark && spark.length > 0) tile.sparkline = spark;
        } catch {
          // Never let sparkline errors bubble.
        }
      }
    }
    this.cache = {
      tiles,
      expiresAt: this.now() + this.cacheTtlMs,
    };
    return tiles;
  }

  /**
   * Fetch the raw success_rate + total_attempts for each configured
   * integration. Used by the daily snapshot cron. Returns one entry per
   * configured integration; integrations with no env wiring return null so
   * the caller can skip them.
   */
  async fetchRawStats(): Promise<
    Array<{
      integration: string;
      successRate: number | null;
      totalAttempts: number | null;
      error?: string;
    }>
  > {
    const results: Array<{
      integration: string;
      successRate: number | null;
      totalAttempts: number | null;
      error?: string;
    }> = [];
    if (this.config.poReceiverUrl && this.config.poReceiverApiKey) {
      results.push(await fetchRawFor('po-receiver', this.config, this.fetchImpl));
    }
    if (this.config.kanbanUrl && this.config.kanbanApiKey) {
      results.push(await fetchRawFor('kanban', this.config, this.fetchImpl));
    }
    if (this.config.contentEngineUrl && this.config.contentEngineApiKey) {
      results.push(await fetchRawFor('content-engine', this.config, this.fetchImpl));
    }
    return results;
  }
}

/**
 * Safe default fetch wrapper around the global fetch. Exposed so tests can
 * swap it out without monkey-patching globals.
 */
const defaultFetchImpl: IntegrationFetchImpl = async (url, init) => {
  const res = await (globalThis as unknown as {
    fetch: (u: string, i: unknown) => Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }>;
  }).fetch(url, init);
  return res;
};

async function fetchPoReceiverTile(
  config: IntegrationTilesConfig,
  fetchImpl: IntegrationFetchImpl,
): Promise<IntegrationTile> {
  if (!config.poReceiverUrl || !config.poReceiverApiKey) {
    return notConfigured('po-receiver', 'PO Receiver Webhooks');
  }
  const url = `${stripTrailing(config.poReceiverUrl)}/api/integration/webhook-status`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': config.poReceiverApiKey },
    });
    if (!res.ok) {
      return errorTile('po-receiver', 'PO Receiver Webhooks', `HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const successRate = pickNumber(body, ['success_rate', 'successRate']);
    const deadLettered = pickNumber(body, ['dead_lettered', 'deadLettered', 'dead_letter_count']);
    const total = pickNumber(body, ['total', 'total_webhooks']);
    const details: IntegrationTile['details'] = [];
    if (successRate !== null) details.push({ label: 'Success', value: `${formatPct(successRate)}` });
    if (deadLettered !== null) details.push({ label: 'Dead-lettered', value: String(deadLettered) });
    if (total !== null) details.push({ label: 'Total', value: String(total) });
    let state: IntegrationTile['state'] = 'ok';
    if (deadLettered !== null && deadLettered > 0) state = 'warn';
    if (successRate !== null && successRate < 0.9) state = 'warn';
    const summaryBits: string[] = [];
    if (successRate !== null) summaryBits.push(`${formatPct(successRate)} success`);
    if (deadLettered !== null) summaryBits.push(`${deadLettered} dead-lettered`);
    return {
      id: 'po-receiver',
      title: 'PO Receiver Webhooks',
      state,
      summary: summaryBits.length > 0 ? summaryBits.join(' · ') : 'no data',
      details,
    };
  } catch (err) {
    return errorTile(
      'po-receiver',
      'PO Receiver Webhooks',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function fetchKanbanTile(
  config: IntegrationTilesConfig,
  fetchImpl: IntegrationFetchImpl,
): Promise<IntegrationTile> {
  if (!config.kanbanUrl || !config.kanbanApiKey) {
    return notConfigured('kanban', 'Kanban Inbound Webhooks');
  }
  const url = `${stripTrailing(config.kanbanUrl)}/api/webhooks/po-receiver/stats`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': config.kanbanApiKey },
    });
    if (!res.ok) {
      return errorTile('kanban', 'Kanban Inbound Webhooks', `HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const totalReceived = pickNumber(body, ['total_received', 'totalReceived']);
    const unmatched = pickNumber(body, ['unmatched_count', 'unmatched']);
    const details: IntegrationTile['details'] = [];
    if (totalReceived !== null) details.push({ label: 'Received', value: String(totalReceived) });
    if (unmatched !== null) details.push({ label: 'Unmatched', value: String(unmatched) });
    let state: IntegrationTile['state'] = 'ok';
    if (unmatched !== null && unmatched > 0) state = 'warn';
    const summaryBits: string[] = [];
    if (totalReceived !== null) summaryBits.push(`${totalReceived} received`);
    if (unmatched !== null) summaryBits.push(`${unmatched} unmatched`);
    return {
      id: 'kanban',
      title: 'Kanban Inbound Webhooks',
      state,
      summary: summaryBits.length > 0 ? summaryBits.join(' · ') : 'no data',
      details,
    };
  } catch (err) {
    return errorTile(
      'kanban',
      'Kanban Inbound Webhooks',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function fetchContentEngineTile(
  config: IntegrationTilesConfig,
  fetchImpl: IntegrationFetchImpl,
): Promise<IntegrationTile> {
  if (!config.contentEngineUrl || !config.contentEngineApiKey) {
    return notConfigured('content-engine', 'Content Engine Quality');
  }
  const url = `${stripTrailing(config.contentEngineUrl)}/api/integration/prompt-quality-stats`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': config.contentEngineApiKey },
    });
    if (!res.ok) {
      return errorTile('content-engine', 'Content Engine Quality', `HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const rejectedRate = pickNumber(body, ['rejected_rate', 'rejectedRate']);
    const rejectedCount = pickNumber(body, ['rejected_count', 'rejectedCount']);
    const avgQuality = pickNumber(body, ['avg_quality_score', 'avgQualityScore']);
    const distributionRaw = body.scene_distribution ?? body.sceneDistribution;
    const topScenes: Array<{ scene: string; count: number }> = [];
    if (distributionRaw && typeof distributionRaw === 'object' && !Array.isArray(distributionRaw)) {
      const entries = Object.entries(distributionRaw as Record<string, unknown>);
      for (const [scene, raw] of entries) {
        const count =
          typeof raw === 'number' && Number.isFinite(raw)
            ? raw
            : typeof raw === 'string' && Number.isFinite(Number(raw))
              ? Number(raw)
              : null;
        if (count !== null) topScenes.push({ scene, count });
      }
      topScenes.sort((a, b) => b.count - a.count);
    }
    const top3 = topScenes.slice(0, 3);
    const details: IntegrationTile['details'] = [];
    if (rejectedRate !== null) details.push({ label: 'Rejected', value: formatPct(rejectedRate) });
    if (avgQuality !== null) details.push({ label: 'Avg score', value: avgQuality.toFixed(2) });
    if (rejectedCount !== null) details.push({ label: 'Rejected #', value: String(rejectedCount) });
    for (const s of top3) {
      details.push({ label: s.scene, value: String(s.count) });
    }
    let state: IntegrationTile['state'] = 'ok';
    if (rejectedRate !== null && rejectedRate > 0.2) state = 'warn';
    if (avgQuality !== null && avgQuality < 0.6) state = 'warn';
    const summaryBits: string[] = [];
    if (rejectedRate !== null) summaryBits.push(`${formatPct(rejectedRate)} rejected`);
    if (avgQuality !== null) summaryBits.push(`avg ${avgQuality.toFixed(2)}`);
    return {
      id: 'content-engine',
      title: 'Content Engine Quality',
      state,
      summary: summaryBits.length > 0 ? summaryBits.join(' · ') : 'no data',
      details,
    };
  } catch (err) {
    return errorTile(
      'content-engine',
      'Content Engine Quality',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Scene-drift tile. Consumes the content-engine `/api/integration/scene-drift`
 * endpoint which emits per-scene distribution stats (count, expected,
 * z_score, days_since_last_flag). We surface the top over-represented scenes
 * (positive z-score) and pick a severity based on z-score combined with how
 * long the scene has been flagged — the less time since last flag, the more
 * severe (repeat offender).
 */
async function fetchSceneDriftTile(
  config: IntegrationTilesConfig,
  fetchImpl: IntegrationFetchImpl,
): Promise<IntegrationTile> {
  if (!config.contentEngineUrl || !config.contentEngineApiKey) {
    return notConfigured('scene-drift', 'Scene Distribution Drift');
  }
  const url = `${stripTrailing(config.contentEngineUrl)}/api/integration/scene-drift`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': config.contentEngineApiKey },
    });
    if (!res.ok) {
      return errorTile('scene-drift', 'Scene Distribution Drift', `HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const scenesRaw = Array.isArray(body.scenes)
      ? (body.scenes as Array<Record<string, unknown>>)
      : [];
    const flagged = scenesRaw
      .map((s) => parseDriftScene(s))
      .filter((s): s is SceneDriftScene => s !== null);

    // Over-represented scenes are z > 0. Sort by severity (weighted).
    const overRepresented = flagged
      .filter((s) => s.zScore > 0)
      .map((s) => ({ ...s, severity: computeDriftSeverity(s) }))
      .sort((a, b) => b.severity - a.severity);

    const top = overRepresented.slice(0, 3);

    const details: IntegrationTile['details'] = [];
    for (const s of top) {
      // e.g. "z=2.1  flagged 1d ago"
      const bits: string[] = [`z=${s.zScore.toFixed(2)}`];
      if (s.daysSinceLastFlag !== null) {
        bits.push(
          s.daysSinceLastFlag < 1
            ? '<1d ago'
            : `${Math.round(s.daysSinceLastFlag)}d ago`,
        );
      }
      details.push({ label: s.scene, value: bits.join(' · ') });
    }

    // State: ok if nothing flagged, warn if any flagged, error-ish if any
    // repeat offender within 2 days and z > 2.
    let state: IntegrationTile['state'] = 'ok';
    if (top.length > 0) state = 'warn';

    const summary =
      top.length === 0
        ? 'All scenes balanced'
        : `${top.length} over-represented`;

    return {
      id: 'scene-drift',
      title: 'Scene Distribution Drift',
      state,
      summary,
      details,
    };
  } catch (err) {
    return errorTile(
      'scene-drift',
      'Scene Distribution Drift',
      err instanceof Error ? err.message : String(err),
    );
  }
}

interface SceneDriftScene {
  scene: string;
  zScore: number;
  count: number | null;
  expected: number | null;
  daysSinceLastFlag: number | null;
}

function parseDriftScene(raw: Record<string, unknown>): SceneDriftScene | null {
  const scene = typeof raw.scene === 'string' ? raw.scene : typeof raw.name === 'string' ? raw.name : null;
  if (!scene) return null;
  const zScore = pickNumber(raw, ['z_score', 'zScore']);
  if (zScore === null) return null;
  const count = pickNumber(raw, ['count']);
  const expected = pickNumber(raw, ['expected']);
  const daysSinceLastFlag = pickNumber(raw, [
    'days_since_last_flag',
    'daysSinceLastFlag',
  ]);
  return { scene, zScore, count, expected, daysSinceLastFlag };
}

/**
 * Severity weighting. Scenes with higher z-scores are more severe. Scenes
 * that were flagged recently (low days_since_last_flag) get a bonus — a
 * repeat offender at the same z-score is worse than a first-time offender.
 */
export function computeDriftSeverity(scene: SceneDriftScene): number {
  const z = Math.max(0, scene.zScore);
  const days = scene.daysSinceLastFlag;
  if (days === null || !Number.isFinite(days)) return z;
  // Recent repeat offenders get a boost that decays over 14 days.
  const recencyBoost = Math.max(0, 1 - days / 14);
  return z * (1 + recencyBoost);
}

async function fetchRawFor(
  integration: 'po-receiver' | 'kanban' | 'content-engine',
  config: IntegrationTilesConfig,
  fetchImpl: IntegrationFetchImpl,
): Promise<{
  integration: string;
  successRate: number | null;
  totalAttempts: number | null;
  error?: string;
}> {
  try {
    if (integration === 'po-receiver') {
      const url = `${stripTrailing(config.poReceiverUrl!)}/api/integration/webhook-status`;
      const res = await fetchImpl(url, {
        headers: { 'x-api-key': config.poReceiverApiKey! },
      });
      if (!res.ok) {
        return { integration, successRate: null, totalAttempts: null, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const rate = pickNumber(body, ['success_rate', 'successRate']);
      const normRate = rate !== null && rate > 1 ? rate / 100 : rate;
      const total = pickNumber(body, ['total', 'total_webhooks']);
      return { integration, successRate: normRate, totalAttempts: total };
    }
    if (integration === 'kanban') {
      const url = `${stripTrailing(config.kanbanUrl!)}/api/webhooks/po-receiver/stats`;
      const res = await fetchImpl(url, {
        headers: { 'x-api-key': config.kanbanApiKey! },
      });
      if (!res.ok) {
        return { integration, successRate: null, totalAttempts: null, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const total = pickNumber(body, ['total_received', 'totalReceived']) ?? 0;
      const unmatched = pickNumber(body, ['unmatched_count', 'unmatched']) ?? 0;
      const rate = total > 0 ? Math.max(0, (total - unmatched) / total) : null;
      return { integration, successRate: rate, totalAttempts: total };
    }
    // content-engine
    const url = `${stripTrailing(config.contentEngineUrl!)}/api/integration/prompt-quality-stats`;
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': config.contentEngineApiKey! },
    });
    if (!res.ok) {
      return { integration, successRate: null, totalAttempts: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const rejectedRate = pickNumber(body, ['rejected_rate', 'rejectedRate']);
    const normRejected =
      rejectedRate !== null && rejectedRate > 1 ? rejectedRate / 100 : rejectedRate;
    const rate = normRejected !== null ? Math.max(0, 1 - normRejected) : null;
    const rejectedCount = pickNumber(body, ['rejected_count', 'rejectedCount']) ?? 0;
    // We don't always have a "total" — fall back to rejectedCount / rejected_rate.
    let total: number | null = null;
    if (normRejected !== null && normRejected > 0) {
      total = Math.round(rejectedCount / normRejected);
    } else if (rejectedCount === 0) {
      total = 0;
    }
    return { integration, successRate: rate, totalAttempts: total };
  } catch (err) {
    return {
      integration,
      successRate: null,
      totalAttempts: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function notConfigured(id: string, title: string): IntegrationTile {
  return {
    id,
    title,
    state: 'not-configured',
    summary: 'Not configured',
  };
}

function errorTile(id: string, title: string, error: string): IntegrationTile {
  return {
    id,
    title,
    state: 'error',
    summary: 'Error fetching integration status',
    error,
  };
}

function stripTrailing(url: string): string {
  return url.replace(/\/+$/, '');
}

function pickNumber(body: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function formatPct(value: number): string {
  // Accept both fractions (0.98) and percents (98).
  const pct = value > 1 ? value : value * 100;
  return `${pct.toFixed(1)}%`;
}

/**
 * Read integration tiles configuration from env. Returns `undefined` URLs /
 * keys when not set so callers can render "Not configured" without crashing.
 */
export function loadIntegrationTilesConfig(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationTilesConfig {
  return {
    poReceiverUrl: env.PO_RECEIVER_URL || undefined,
    poReceiverApiKey: env.PO_RECEIVER_API_KEY || undefined,
    kanbanUrl: env.KANBAN_URL || undefined,
    kanbanApiKey: env.KANBAN_API_KEY || undefined,
    contentEngineUrl: env.CONTENT_ENGINE_URL || undefined,
    contentEngineApiKey: env.CONTENT_ENGINE_API_KEY || undefined,
  };
}
