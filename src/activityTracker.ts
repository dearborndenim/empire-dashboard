import { AppConfig } from './config';

export interface ActivityResult {
  name: string;
  repo: string;
  lastCommitAt?: string;
  lastCommitMessage?: string;
  lastCommitSha?: string;
  hoursSinceCommit?: number;
  error?: string;
}

/** Minimal shape we need from the Octokit client — keeps tests easy to mock. */
export interface RepoCommitsClient {
  listCommits(params: {
    owner: string;
    repo: string;
    per_page?: number;
  }): Promise<{
    data: Array<{
      sha: string;
      commit: { author?: { date?: string } | null; message: string };
    }>;
  }>;
}

export interface ActivityTrackerOptions {
  /** Cache TTL in seconds (default 600 = 10 min) */
  cacheTtlSec?: number;
  client?: RepoCommitsClient;
  now?: () => number;
}

/**
 * Tracks the most recent commit on each project's GitHub repo.
 * Results are cached to avoid burning GitHub API rate limit on every page view.
 */
export class ActivityTracker {
  private readonly cacheTtlMs: number;
  private readonly client?: RepoCommitsClient;
  private readonly now: () => number;
  private readonly cache = new Map<string, { result: ActivityResult; expiresAt: number }>();

  constructor(opts: ActivityTrackerOptions = {}) {
    this.cacheTtlMs = (opts.cacheTtlSec ?? 600) * 1000;
    this.client = opts.client;
    this.now = opts.now ?? (() => Date.now());
  }

  parseRepo(full: string): { owner: string; repo: string } | null {
    const parts = full.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  getCached(name: string): ActivityResult | undefined {
    const hit = this.cache.get(name);
    if (!hit) return undefined;
    if (hit.expiresAt < this.now()) {
      this.cache.delete(name);
      return undefined;
    }
    return hit.result;
  }

  async track(app: AppConfig, opts: { force?: boolean } = {}): Promise<ActivityResult> {
    if (!opts.force) {
      const cached = this.getCached(app.name);
      if (cached) return cached;
    }

    if (!this.client) {
      const result: ActivityResult = {
        name: app.name,
        repo: app.repo,
        error: 'no github client configured',
      };
      this.store(app.name, result);
      return result;
    }

    const parsed = this.parseRepo(app.repo);
    if (!parsed) {
      const result: ActivityResult = {
        name: app.name,
        repo: app.repo,
        error: `invalid repo format: ${app.repo}`,
      };
      this.store(app.name, result);
      return result;
    }

    try {
      const response = await this.client.listCommits({
        owner: parsed.owner,
        repo: parsed.repo,
        per_page: 1,
      });
      const commit = response.data[0];
      if (!commit) {
        const result: ActivityResult = {
          name: app.name,
          repo: app.repo,
          error: 'no commits found',
        };
        this.store(app.name, result);
        return result;
      }
      const dateStr = commit.commit.author?.date;
      const lastCommitAt = dateStr;
      let hoursSinceCommit: number | undefined;
      if (dateStr) {
        const ts = Date.parse(dateStr);
        if (!Number.isNaN(ts)) {
          hoursSinceCommit = (this.now() - ts) / (1000 * 60 * 60);
        }
      }
      const result: ActivityResult = {
        name: app.name,
        repo: app.repo,
        lastCommitAt,
        lastCommitMessage: commit.commit.message.split('\n')[0],
        lastCommitSha: commit.sha,
        hoursSinceCommit,
      };
      this.store(app.name, result);
      return result;
    } catch (err) {
      const result: ActivityResult = {
        name: app.name,
        repo: app.repo,
        error: err instanceof Error ? err.message : String(err),
      };
      this.store(app.name, result);
      return result;
    }
  }

  async trackAll(apps: AppConfig[], opts: { force?: boolean } = {}): Promise<ActivityResult[]> {
    return Promise.all(apps.map((a) => this.track(a, opts)));
  }

  private store(name: string, result: ActivityResult): void {
    this.cache.set(name, { result, expiresAt: this.now() + this.cacheTtlMs });
  }
}

/** Adapter that turns an Octokit instance into the RepoCommitsClient. */
export function createOctokitAdapter(octokit: {
  rest: { repos: { listCommits: (params: { owner: string; repo: string; per_page?: number }) => Promise<unknown> } };
}): RepoCommitsClient {
  return {
    listCommits: async (params) => {
      const res = (await octokit.rest.repos.listCommits(params)) as {
        data: Array<{ sha: string; commit: { author?: { date?: string } | null; message: string } }>;
      };
      return res;
    },
  };
}
