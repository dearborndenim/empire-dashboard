/**
 * Alert audit polish 4 (2026-04-28): per-saved-view match count helpers.
 *
 * Each saved view stores a URL-style query string (no leading `?`). The
 * `/alerts/audit` page renders a sidebar with a count badge per view —
 * "kanban-fires-7d (12)" — so an operator can see at-a-glance how much each
 * filter is currently matching without clicking through.
 *
 * Computing the count means parsing the stored `query_string` into an
 * `AlertAuditQuery`, then calling `historyStore.countAlertAudits(query)`.
 * Both pieces are pure — but `countAlertAudits` hits SQLite once per view
 * and we may have N views on the page. To keep the page snappy we
 * memoize the counts in-process for 60s. Cache is keyed on the raw query
 * string so two views with identical filters share a cache entry.
 */
import { AlertAuditQuery, HistoryStore } from './historyStore';

/** Default TTL for the in-memory count cache. */
export const SAVED_VIEW_COUNT_CACHE_TTL_MS = 60_000;

/**
 * Parse a saved-view query string (no leading `?`) into an
 * `AlertAuditQuery`. Mirrors `buildAlertAuditQueryFromReq` in app.ts but
 * works off a string instead of an Express Request.
 *
 * Unknown / malformed entries are silently dropped so a malformed query
 * string degrades to an empty query (i.e. matches all rows in the default
 * 7d window) instead of throwing.
 */
export function parseAlertAuditQueryString(qs: string): AlertAuditQuery {
  const cleaned = (qs ?? '').replace(/^\?+/, '').trim();
  const params = new URLSearchParams(cleaned);
  const integration = (params.get('integration') ?? '').trim();
  const decisionRaw = (params.get('decision') ?? '').trim();
  const validDecisions = ['fire', 'suppress', 'recovery', 'cooldown'] as const;
  const decision = (validDecisions as readonly string[]).includes(decisionRaw)
    ? (decisionRaw as AlertAuditQuery['decision'])
    : undefined;
  const daysRaw = Number(params.get('days') ?? '');
  const daysNum = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 7;
  const days = Math.max(1, Math.min(30, daysNum));
  const actorRaw = (params.get('actor') ?? '').trim();
  const actor = actorRaw.slice(0, 64);
  const out: AlertAuditQuery = { days };
  if (integration) out.integration = integration;
  if (decision) out.decision = decision;
  if (actor) out.actor = actor;
  return out;
}

interface CacheEntry {
  count: number;
  expiresAt: number;
}

/**
 * In-memory TTL cache for saved-view match counts. Exposed as a class so
 * tests can construct an isolated instance with an injected clock — the
 * shared module-level singleton is built below as `defaultSavedViewCountCache`.
 */
export class SavedViewCountCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? SAVED_VIEW_COUNT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Return the cached match count for `queryString`, or compute via
   * `compute()` + memoize. Cache key is the verbatim query string so
   * cosmetically-different but semantically-identical strings get separate
   * entries (defensive — keeps the helper purely textual).
   */
  get(queryString: string, compute: () => number): number {
    const key = queryString ?? '';
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      return entry.count;
    }
    const count = compute();
    this.entries.set(key, { count, expiresAt: now + this.ttlMs });
    return count;
  }

  /**
   * Clear all cached entries. Used by tests so each `it()` block starts
   * with a fresh slate.
   */
  clear(): void {
    this.entries.clear();
  }

  /** Current cache size. Useful for tests. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Compute match counts for a list of saved views. Uses the supplied cache
 * (or the module default) to memoize counts for 60s. Errors on individual
 * views are swallowed and surfaced as `count: null` so a misconfigured view
 * can't take down the whole sidebar.
 */
export function computeSavedViewCounts(opts: {
  store: Pick<HistoryStore, 'countAlertAudits'>;
  views: Array<{ id: number; name: string; query_string: string }>;
  cache?: SavedViewCountCache;
  nowMs?: number;
}): Array<{ id: number; name: string; query_string: string; count: number | null }> {
  const cache = opts.cache ?? defaultSavedViewCountCache;
  return opts.views.map((v) => {
    try {
      const count = cache.get(v.query_string, () => {
        const query = parseAlertAuditQueryString(v.query_string);
        if (typeof opts.nowMs === 'number') query.nowMs = opts.nowMs;
        return opts.store.countAlertAudits(query);
      });
      return { id: v.id, name: v.name, query_string: v.query_string, count };
    } catch {
      return { id: v.id, name: v.name, query_string: v.query_string, count: null };
    }
  });
}

/**
 * Module-level default cache. The /alerts/audit route reuses this so the
 * 60s TTL is shared across requests on the same process.
 */
export const defaultSavedViewCountCache = new SavedViewCountCache();
