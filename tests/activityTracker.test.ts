import { ActivityTracker, RepoCommitsClient } from '../src/activityTracker';

function fakeClient(
  commits: Array<{ sha: string; date?: string; message?: string } | Error>,
): { client: RepoCommitsClient; calls: Array<{ owner: string; repo: string }> } {
  let i = 0;
  const calls: Array<{ owner: string; repo: string }> = [];
  return {
    client: {
      listCommits: async ({ owner, repo }) => {
        calls.push({ owner, repo });
        const next = commits[i++];
        if (next instanceof Error) throw next;
        if (!next) return { data: [] };
        return {
          data: [
            {
              sha: next.sha,
              commit: {
                author: next.date ? { date: next.date } : null,
                message: next.message ?? 'msg',
              },
            },
          ],
        };
      },
    },
    calls,
  };
}

describe('ActivityTracker.parseRepo', () => {
  const t = new ActivityTracker();

  it('parses owner/repo', () => {
    expect(t.parseRepo('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns null on bad format', () => {
    expect(t.parseRepo('just-one')).toBeNull();
    expect(t.parseRepo('a/b/c')).toBeNull();
  });
});

describe('ActivityTracker.track', () => {
  it('returns error when no client is configured', async () => {
    const t = new ActivityTracker();
    const res = await t.track({ name: 'A', repo: 'o/a' });
    expect(res.error).toMatch(/no github client/);
  });

  it('returns error on invalid repo format', async () => {
    const { client } = fakeClient([]);
    const t = new ActivityTracker({ client });
    const res = await t.track({ name: 'A', repo: 'oopsnoslash' });
    expect(res.error).toMatch(/invalid repo/);
  });

  it('returns commit info with hoursSinceCommit', async () => {
    const commitDate = '2026-04-16T00:00:00Z';
    const { client } = fakeClient([
      { sha: 'abc123', date: commitDate, message: 'fix: something\nlonger body' },
    ]);
    const now = Date.parse('2026-04-16T06:00:00Z');
    const t = new ActivityTracker({ client, now: () => now });
    const res = await t.track({ name: 'A', repo: 'o/a' });
    expect(res.lastCommitSha).toBe('abc123');
    expect(res.lastCommitMessage).toBe('fix: something');
    expect(res.hoursSinceCommit).toBeCloseTo(6, 1);
  });

  it('handles missing author date gracefully', async () => {
    const { client } = fakeClient([{ sha: 'abc', message: 'msg' }]);
    const t = new ActivityTracker({ client });
    const res = await t.track({ name: 'A', repo: 'o/a' });
    expect(res.lastCommitSha).toBe('abc');
    expect(res.hoursSinceCommit).toBeUndefined();
  });

  it('handles empty commit list', async () => {
    const { client } = fakeClient([]);
    const t = new ActivityTracker({ client });
    const res = await t.track({ name: 'A', repo: 'o/a' });
    expect(res.error).toMatch(/no commits/);
  });

  it('surfaces client errors', async () => {
    const { client } = fakeClient([new Error('boom')]);
    const t = new ActivityTracker({ client });
    const res = await t.track({ name: 'A', repo: 'o/a' });
    expect(res.error).toBe('boom');
  });

  it('uses cache within TTL and bypasses on force', async () => {
    const { client, calls } = fakeClient([
      { sha: '1', date: '2026-04-16T00:00:00Z' },
      { sha: '2', date: '2026-04-16T00:00:00Z' },
    ]);
    const t = new ActivityTracker({ client, cacheTtlSec: 600, now: () => 1000 });
    await t.track({ name: 'A', repo: 'o/a' });
    await t.track({ name: 'A', repo: 'o/a' });
    expect(calls.length).toBe(1);
    await t.track({ name: 'A', repo: 'o/a' }, { force: true });
    expect(calls.length).toBe(2);
  });

  it('expires cache after TTL', async () => {
    const { client, calls } = fakeClient([
      { sha: '1', date: '2026-04-16T00:00:00Z' },
      { sha: '2', date: '2026-04-16T00:00:00Z' },
    ]);
    let t = 0;
    const tr = new ActivityTracker({ client, cacheTtlSec: 1, now: () => t });
    await tr.track({ name: 'A', repo: 'o/a' });
    t = 5000;
    await tr.track({ name: 'A', repo: 'o/a' });
    expect(calls.length).toBe(2);
  });

  it('trackAll runs in parallel', async () => {
    const { client } = fakeClient([
      { sha: '1', date: '2026-04-16T00:00:00Z' },
      { sha: '2', date: '2026-04-16T00:00:00Z' },
    ]);
    const tr = new ActivityTracker({ client });
    const results = await tr.trackAll([
      { name: 'A', repo: 'o/a' },
      { name: 'B', repo: 'o/b' },
    ]);
    expect(results.map((r) => r.lastCommitSha)).toEqual(['1', '2']);
  });
});
