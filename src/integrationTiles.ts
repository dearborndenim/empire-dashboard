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

/**
 * Scene-drift v2 (2026-04-23): per-classification badge counts rendered
 * above the tile body. `chronic` = red, `spike` = yellow, `stable` = green.
 * Field is undefined for tiles that don't surface flag classifications.
 */
export interface FlagClassificationCounts {
  chronic: number;
  spike: number;
  stable: number;
}

export type FlagClassification = 'chronic' | 'spike' | 'stable';

export interface IntegrationTile {
  id: string;
  title: string;
  /** High-level state the UI renders styling for. */
  state: 'ok' | 'warn' | 'error' | 'critical' | 'not-configured';
  /**
   * Short one-line summary (e.g. "98.4% — 2 dead-lettered").
   * The UI renders this under the title.
   */
  summary: string;
  /** Optional structured key/value pairs the UI can render as a mini table. */
  details?: Array<{
    label: string;
    value: string;
    /**
     * Scene-drift v2: per-detail flag_classification (chronic/spike/stable)
     * so the renderer can colorize the row's status pill. Undefined for
     * legacy tiles or rows without classification data.
     */
    classification?: FlagClassification;
  }>;
  /** If the tile is "error" we may have a short reason for Railway logs. */
  error?: string;
  /** Historical daily success-rate points (ascending date) used for a sparkline. */
  sparkline?: IntegrationSparklinePoint[];
  /**
   * Scene-drift v2 (2026-04-23): counts per flag classification across the
   * full payload (not just the top-3 in details). Rendered as colored badges
   * above the tile body. Undefined when the upstream payload omits
   * flag_classification entirely (legacy fallback path).
   */
  classificationCounts?: FlagClassificationCounts;
  /**
   * Auto-pause history sparkline (2026-04-29): 24-bucket per-hour
   * paused/resumed counts for the strict-mode auto-pause feature in
   * content-engine. Rendered as a small inline sparkline on the
   * "Auto-pause history (24h)" tile. Undefined for tiles that don't
   * carry the data.
   */
  autoPauseSparkline?: AutoPauseSparklineData;
  /**
   * Auto-pause history (2026-04-29): optional explicit click-through
   * href the renderer should use to wrap the tile in. When undefined the
   * tile renders un-clickable (legacy behaviour for older tiles).
   */
  href?: string;
}

/**
 * Auto-pause history sparkline payload (2026-04-29). Mirrors the shape
 * content-engine's `buildAutoPauseSparkline()` returns, but constructed
 * locally inside the empire-dashboard from the raw events array exposed
 * by `GET /api/integration/strict-mode-auto-pause-history?days=N`.
 */
export interface AutoPauseSparklinePoint {
  /** UTC hour-snapped ISO timestamp. */
  hourIso: string;
  /** Count of `paused` transitions in this hour bucket. */
  paused: number;
  /** Count of `resumed` transitions in this hour bucket. */
  resumed: number;
}

export interface AutoPauseSparklineData {
  /** 24 buckets (one per hour), oldest → newest, stable shape. */
  points: AutoPauseSparklinePoint[];
  /** Number of `paused` transitions in the window. */
  totalPauses: number;
  /** Timestamp of the most-recent `paused` transition in the window, or null. */
  lastPausedAt: string | null;
  /** Timestamp of the most-recent `resumed` transition in the window, or null. */
  lastResumedAt: string | null;
  /**
   * True when the strict-mode pipeline is currently paused — i.e. the
   * latest `paused` event has no matching `resumed` after it. Drives the
   * tile's `critical` state.
   */
  currentlyPaused: boolean;
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
      fetchAutoPauseHistoryTile(this.config, this.fetchImpl, this.now),
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

    // Scene-drift v2: classification counts across the full payload (not just
    // the top-3). Only emitted when at least one scene carries a non-null
    // classification — keeps the legacy fallback path clean.
    const classificationCounts = computeClassificationCounts(flagged);

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
      const detail: NonNullable<IntegrationTile['details']>[number] = {
        label: s.scene,
        value: bits.join(' · '),
      };
      if (s.flagClassification) {
        detail.classification = s.flagClassification;
      }
      details.push(detail);
    }

    // State: ok if nothing flagged, warn if any flagged. Scene-drift v2:
    // promote to warn when ANY scene is chronic, even if not in top-3.
    let state: IntegrationTile['state'] = 'ok';
    if (top.length > 0) state = 'warn';
    if (classificationCounts && classificationCounts.chronic > 0) state = 'warn';

    const summary =
      top.length === 0
        ? 'All scenes balanced'
        : `${top.length} over-represented`;

    const tile: IntegrationTile = {
      id: 'scene-drift',
      title: 'Scene Distribution Drift',
      state,
      summary,
      details,
    };
    if (classificationCounts) {
      tile.classificationCounts = classificationCounts;
    }
    return tile;
  } catch (err) {
    return errorTile(
      'scene-drift',
      'Scene Distribution Drift',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Auto-pause history tile (2026-04-29). Reads content-engine's
 * `GET /api/integration/strict-mode-auto-pause-history?days=1` endpoint and
 * renders a 24-bucket per-hour sparkline of `paused` / `resumed` transition
 * counts plus the totals + last-pause-at / last-resume-at timestamps.
 *
 * State:
 *   ok       — zero `paused` events in the trailing 24h window.
 *   warn     — at least one `paused` event in the window AND we're not
 *              currently paused (i.e. the latest `paused` was followed by a
 *              matching `resumed`).
 *   critical — currently paused (latest event is `paused` with no later
 *              `resumed`, OR `lastPausedAt` is set with `lastResumedAt`
 *              null).
 */
async function fetchAutoPauseHistoryTile(
  config: IntegrationTilesConfig,
  fetchImpl: IntegrationFetchImpl,
  nowFn: () => number,
): Promise<IntegrationTile> {
  const id = 'auto-pause-history';
  const title = 'Auto-pause history (24h)';
  if (!config.contentEngineUrl || !config.contentEngineApiKey) {
    return notConfigured(id, title);
  }
  const url = `${stripTrailing(config.contentEngineUrl)}/api/integration/strict-mode-auto-pause-history?days=1`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': config.contentEngineApiKey },
    });
    if (!res.ok) {
      return errorTile(id, title, `HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const eventsRaw = Array.isArray(body.events) ? (body.events as unknown[]) : [];
    const events = eventsRaw
      .map(parseAutoPauseEvent)
      .filter((e): e is AutoPauseEvent => e !== null);
    const data = buildAutoPauseSparkline(events, 24 * 60 * 60 * 1000, nowFn());
    const state: IntegrationTile['state'] = data.currentlyPaused
      ? 'critical'
      : data.totalPauses > 0
        ? 'warn'
        : 'ok';
    const summary = data.currentlyPaused
      ? `Paused now · ${data.totalPauses} pause${data.totalPauses === 1 ? '' : 's'} in 24h`
      : data.totalPauses === 0
        ? 'No pauses in 24h'
        : `${data.totalPauses} pause${data.totalPauses === 1 ? '' : 's'} in 24h (resumed)`;
    const details: IntegrationTile['details'] = [];
    details.push({ label: 'Total pauses', value: String(data.totalPauses) });
    if (data.lastPausedAt) {
      details.push({ label: 'Last paused', value: data.lastPausedAt });
    }
    if (data.lastResumedAt) {
      details.push({ label: 'Last resumed', value: data.lastResumedAt });
    }
    const tile: IntegrationTile = {
      id,
      title,
      state,
      summary,
      details,
      autoPauseSparkline: data,
      href: '/alerts/audit?integration=content-engine&decision=fire&days=7',
    };
    return tile;
  } catch (err) {
    return errorTile(id, title, err instanceof Error ? err.message : String(err));
  }
}

/** One auto-pause event row from the content-engine response. */
interface AutoPauseEvent {
  ts_ms: number;
  transition: 'paused' | 'resumed';
  reason: string | null;
}

function parseAutoPauseEvent(raw: unknown): AutoPauseEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ts = pickNumber(r, ['ts_ms', 'tsMs']);
  if (ts === null) return null;
  const t = r.transition;
  if (t !== 'paused' && t !== 'resumed') return null;
  const reasonRaw = r.reason;
  const reason = typeof reasonRaw === 'string' ? reasonRaw : null;
  return { ts_ms: ts, transition: t, reason };
}

/**
 * Format auto-pause events into a 24-bucket sparkline payload mirroring
 * content-engine's `buildAutoPauseSparkline()`. Pure / defensive:
 *   - Future-dated events (ts_ms > nowMs) are dropped.
 *   - Events with unknown transitions are dropped (forward-compat).
 *   - Negative or zero windowMs is clamped to a single hour.
 *   - `currentlyPaused` is true when the most-recent event in the window
 *     is a `paused` (no later `resumed`). Also true when `lastPausedAt`
 *     exists and `lastResumedAt` is null OR is older than `lastPausedAt`.
 */
const HOUR_MS = 60 * 60 * 1000;

function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function buildAutoPauseSparkline(
  events: AutoPauseEvent[],
  windowMs: number,
  nowMs: number,
): AutoPauseSparklineData {
  const safeWindowMs = Math.max(HOUR_MS, windowMs | 0);
  const hourCount = Math.max(1, Math.floor(safeWindowMs / HOUR_MS));
  const nowHour = floorToHour(nowMs);
  const oldestHour = nowHour - (hourCount - 1) * HOUR_MS;

  const pausedCounts = new Map<number, number>();
  const resumedCounts = new Map<number, number>();
  for (let i = hourCount - 1; i >= 0; i--) {
    const hourStart = nowHour - i * HOUR_MS;
    pausedCounts.set(hourStart, 0);
    resumedCounts.set(hourStart, 0);
  }

  let totalPauses = 0;
  let lastPausedMs: number | null = null;
  let lastResumedMs: number | null = null;

  for (const ev of events) {
    if (ev.ts_ms < oldestHour) continue;
    if (ev.ts_ms > nowMs) continue;
    const key = Math.min(floorToHour(ev.ts_ms), nowHour);
    if (ev.transition === 'paused') {
      pausedCounts.set(key, (pausedCounts.get(key) ?? 0) + 1);
      totalPauses++;
      if (lastPausedMs === null || ev.ts_ms > lastPausedMs) {
        lastPausedMs = ev.ts_ms;
      }
    } else if (ev.transition === 'resumed') {
      resumedCounts.set(key, (resumedCounts.get(key) ?? 0) + 1);
      if (lastResumedMs === null || ev.ts_ms > lastResumedMs) {
        lastResumedMs = ev.ts_ms;
      }
    }
  }

  const points: AutoPauseSparklinePoint[] = [];
  for (let i = hourCount - 1; i >= 0; i--) {
    const hourStart = nowHour - i * HOUR_MS;
    points.push({
      hourIso: new Date(hourStart).toISOString(),
      paused: pausedCounts.get(hourStart) ?? 0,
      resumed: resumedCounts.get(hourStart) ?? 0,
    });
  }

  // Currently-paused logic: if there's a paused event but no resumed
  // event at all, OR the latest paused is more recent than the latest
  // resumed, then we treat the pipeline as paused.
  const currentlyPaused =
    lastPausedMs !== null &&
    (lastResumedMs === null || lastPausedMs > lastResumedMs);

  return {
    points,
    totalPauses,
    lastPausedAt: lastPausedMs !== null ? new Date(lastPausedMs).toISOString() : null,
    lastResumedAt: lastResumedMs !== null ? new Date(lastResumedMs).toISOString() : null,
    currentlyPaused,
  };
}

interface SceneDriftScene {
  scene: string;
  zScore: number;
  count: number | null;
  expected: number | null;
  daysSinceLastFlag: number | null;
  /**
   * Scene-drift v2 (2026-04-23): per-scene flag classification from the
   * Content Engine payload. `null`/undefined when the upstream omits the
   * field (graceful legacy fallback). Optional for back-compat with v1
   * callers that constructed scenes without this field.
   */
  flagClassification?: FlagClassification | null;
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
  const rawCls = raw.flag_classification ?? raw.flagClassification;
  let flagClassification: FlagClassification | null = null;
  if (rawCls === 'chronic' || rawCls === 'spike' || rawCls === 'stable') {
    flagClassification = rawCls;
  }
  return {
    scene,
    zScore,
    count,
    expected,
    daysSinceLastFlag,
    flagClassification,
  };
}

/**
 * Scene-drift v2 (2026-04-23): tally per-classification counts across the
 * full scenes payload. Returns undefined when NO scene carries a
 * classification (legacy fallback path — preserves the v1 render).
 */
export function computeClassificationCounts(
  scenes: SceneDriftScene[],
): FlagClassificationCounts | undefined {
  const counts: FlagClassificationCounts = { chronic: 0, spike: 0, stable: 0 };
  let any = false;
  for (const s of scenes) {
    const cls = s.flagClassification;
    if (cls !== 'chronic' && cls !== 'spike' && cls !== 'stable') continue;
    any = true;
    counts[cls] += 1;
  }
  return any ? counts : undefined;
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
