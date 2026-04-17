import { AppConfig } from './config';

export type HealthState = 'up' | 'down' | 'unknown';

export interface HealthResult {
  name: string;
  state: HealthState;
  statusCode?: number;
  latencyMs?: number;
  checkedAt: string;
  error?: string;
}

export interface FetchLike {
  (input: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number }>;
}

export interface HealthCheckerOptions {
  timeoutMs?: number;
  cacheTtlSec?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/**
 * Performs HTTP health checks against app `/health` endpoints and caches
 * results so the dashboard can render without hammering downstream apps.
 */
export class HealthChecker {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cache = new Map<string, { result: HealthResult; expiresAt: number }>();

  constructor(opts: HealthCheckerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.cacheTtlMs = (opts.cacheTtlSec ?? 60) * 1000;
    // Use a loose fetch wrapper to keep typing simple across Node versions.
    const defaultFetch: FetchLike = (input, init) =>
      (globalThis as unknown as { fetch: (i: string, init?: unknown) => Promise<{ ok: boolean; status: number }> })
        .fetch(input, init);
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Builds the URL to probe for a given app, or null if no URL configured. */
  resolveUrl(app: AppConfig): string | null {
    if (!app.url) return null;
    const base = app.url.replace(/\/$/, '');
    const path = app.healthPath ?? '/health';
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalized}`;
  }

  getCached(name: string): HealthResult | undefined {
    const hit = this.cache.get(name);
    if (!hit) return undefined;
    if (hit.expiresAt < this.now()) {
      this.cache.delete(name);
      return undefined;
    }
    return hit.result;
  }

  /** Check a single app. Uses cache if fresh; otherwise performs HTTP request. */
  async check(app: AppConfig, opts: { force?: boolean } = {}): Promise<HealthResult> {
    if (!opts.force) {
      const cached = this.getCached(app.name);
      if (cached) return cached;
    }

    const url = this.resolveUrl(app);
    if (!url) {
      const result: HealthResult = {
        name: app.name,
        state: 'unknown',
        checkedAt: new Date(this.now()).toISOString(),
        error: 'no url configured',
      };
      this.store(app.name, result);
      return result;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = this.now();
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      const latency = this.now() - startedAt;
      const result: HealthResult = {
        name: app.name,
        state: response.ok ? 'up' : 'down',
        statusCode: response.status,
        latencyMs: latency,
        checkedAt: new Date(this.now()).toISOString(),
      };
      this.store(app.name, result);
      return result;
    } catch (err) {
      const result: HealthResult = {
        name: app.name,
        state: 'down',
        checkedAt: new Date(this.now()).toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
      this.store(app.name, result);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check many apps in parallel. */
  async checkAll(apps: AppConfig[], opts: { force?: boolean } = {}): Promise<HealthResult[]> {
    return Promise.all(apps.map((a) => this.check(a, opts)));
  }

  private store(name: string, result: HealthResult): void {
    this.cache.set(name, { result, expiresAt: this.now() + this.cacheTtlMs });
  }
}
