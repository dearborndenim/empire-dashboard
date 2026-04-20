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
}

export interface IntegrationTilesOptions {
  config: IntegrationTilesConfig;
  fetchImpl?: IntegrationFetchImpl;
  now?: () => number;
  cacheTtlMs?: number;
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
  private cache: CacheEntry | null = null;

  constructor(opts: IntegrationTilesOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
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
    ]);
    this.cache = {
      tiles,
      expiresAt: this.now() + this.cacheTtlMs,
    };
    return tiles;
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
  };
}
