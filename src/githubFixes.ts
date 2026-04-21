/**
 * "This week's fixes" fetcher for the weekly summary email.
 *
 * Pulls the latest commit per app from GitHub for a set of apps under an
 * owner (e.g. `dearborndenim`). The output is a short, flat list suitable
 * for rendering in the weekly email's "This week's fixes" section:
 *
 *   - owner/repo: <short message>  (sha)
 *
 * Design notes
 * ------------
 * - We never hard-fail. If `GITHUB_TOKEN` is absent the factory returns a
 *   no-op fetcher that always resolves to `null` so the caller can omit the
 *   section from the email body.
 * - We maintain a 24h in-memory cache keyed by repo so we don't hammer the
 *   GitHub API on every weekly render (and also so tests can inject a
 *   deterministic clock). The cache also keys by latest sha, meaning a new
 *   commit invalidates the cached entry even inside the 24h window.
 * - Errors on individual repos are swallowed with a warning; we just omit
 *   that repo from the resulting list.
 */

export interface GithubLatestCommitFetcher {
  (opts: { owner: string; repo: string }): Promise<{
    sha: string;
    message: string;
    date: string;
  } | null>;
}

export interface GithubFixesOptions {
  owner: string;
  repos: string[];
  fetcher: GithubLatestCommitFetcher;
  now?: () => number;
  cacheTtlMs?: number;
  maxMessageLen?: number;
}

export interface GithubFix {
  owner: string;
  repo: string;
  sha: string;
  shortSha: string;
  message: string;
  date: string;
}

interface CacheEntry {
  sha: string;
  expiresAt: number;
  value: GithubFix;
}

export class GithubFixesClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxMessageLen: number;

  constructor(private readonly opts: { fetcher: GithubLatestCommitFetcher; now?: () => number; cacheTtlMs?: number; maxMessageLen?: number }) {
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? 24 * 3600_000;
    this.maxMessageLen = opts.maxMessageLen ?? 72;
  }

  /** Fetch the latest commit for a single repo, using the cache when fresh. */
  async getLatestCommit(owner: string, repo: string): Promise<GithubFix | null> {
    const key = `${owner}/${repo}`;
    const entry = this.cache.get(key);
    const now = this.now();
    try {
      const fresh = await this.opts.fetcher({ owner, repo });
      if (!fresh) return null;
      if (entry && entry.sha === fresh.sha && entry.expiresAt > now) {
        return entry.value;
      }
      const short = truncate(firstLine(fresh.message), this.maxMessageLen);
      const value: GithubFix = {
        owner,
        repo,
        sha: fresh.sha,
        shortSha: fresh.sha.slice(0, 7),
        message: short,
        date: fresh.date,
      };
      this.cache.set(key, {
        sha: fresh.sha,
        expiresAt: now + this.cacheTtlMs,
        value,
      });
      return value;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[empire-dashboard] github fix fetch failed for ${key}:`, err);
      return entry?.value ?? null;
    }
  }
}

/**
 * Pull "this week's fixes" (latest commit per repo) for all apps. Returns
 * a list of fix summaries. Empty array means nothing resolved — callers
 * should omit the email section entirely when that happens.
 */
export async function fetchThisWeeksFixes(
  opts: GithubFixesOptions,
): Promise<GithubFix[]> {
  const client = new GithubFixesClient({
    fetcher: opts.fetcher,
    now: opts.now,
    cacheTtlMs: opts.cacheTtlMs,
    maxMessageLen: opts.maxMessageLen,
  });
  const out: GithubFix[] = [];
  for (const repo of opts.repos) {
    const fix = await client.getLatestCommit(opts.owner, repo);
    if (fix) out.push(fix);
  }
  return out;
}

/**
 * Render the "This week's fixes" section. Callers pass the fix list (already
 * fetched + cached) and the renderer emits a plain-text block suitable for
 * the text body of the weekly email. Returns an empty string when the list
 * is empty so the caller can concatenate unconditionally.
 */
export function renderWeeksFixesSection(fixes: GithubFix[]): string {
  if (fixes.length === 0) return '';
  const lines: string[] = [];
  lines.push("This week's fixes");
  lines.push('-----------------');
  for (const fix of fixes) {
    lines.push(`  ${fix.owner}/${fix.repo}: ${fix.message} (${fix.shortSha})`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build a GithubLatestCommitFetcher from a minimal Octokit-like client.
 * We intentionally don't import Octokit here so tests can inject a fake;
 * the real wiring happens in `index.ts` where Octokit is already present.
 */
export interface OctokitLike {
  repos: {
    listCommits(opts: {
      owner: string;
      repo: string;
      per_page: number;
    }): Promise<{ data: Array<{ sha: string; commit: { message: string; author?: { date?: string } | null } }> }>;
  };
}

export function octokitCommitFetcher(octokit: OctokitLike): GithubLatestCommitFetcher {
  return async ({ owner, repo }) => {
    const res = await octokit.repos.listCommits({ owner, repo, per_page: 1 });
    const first = res.data?.[0];
    if (!first) return null;
    return {
      sha: first.sha,
      message: first.commit.message ?? '',
      date: first.commit.author?.date ?? '',
    };
  };
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return idx >= 0 ? s.slice(0, idx) : s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
