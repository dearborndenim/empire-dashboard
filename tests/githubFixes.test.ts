import {
  GithubFixesClient,
  fetchThisWeeksFixes,
  renderWeeksFixesSection,
  octokitCommitFetcher,
} from '../src/githubFixes';

function fakeFetcher(byRepo: Record<string, { sha: string; message: string; date: string } | null>): {
  fetcher: Parameters<typeof fetchThisWeeksFixes>[0]['fetcher'];
  calls: Array<{ owner: string; repo: string }>;
} {
  const calls: Array<{ owner: string; repo: string }> = [];
  const fetcher: Parameters<typeof fetchThisWeeksFixes>[0]['fetcher'] = async ({ owner, repo }) => {
    calls.push({ owner, repo });
    const result = byRepo[repo];
    if (result === undefined) throw new Error(`unexpected repo ${repo}`);
    return result;
  };
  return { fetcher, calls };
}

describe('GithubFixesClient', () => {
  it('returns truncated first-line message + 7-char shortSha', async () => {
    const { fetcher } = fakeFetcher({
      alpha: {
        sha: 'abcdef1234567890',
        message: 'fix: foo bar\n\nlong body text',
        date: '2026-04-20T12:00:00Z',
      },
    });
    const c = new GithubFixesClient({ fetcher, maxMessageLen: 50 });
    const fix = await c.getLatestCommit('o', 'alpha');
    expect(fix).not.toBeNull();
    expect(fix!.message).toBe('fix: foo bar');
    expect(fix!.shortSha).toBe('abcdef1');
    expect(fix!.date).toBe('2026-04-20T12:00:00Z');
  });

  it('truncates messages exceeding maxMessageLen with an ellipsis', async () => {
    const { fetcher } = fakeFetcher({
      alpha: { sha: 'a'.repeat(40), message: 'x'.repeat(200), date: '2026-04-20T00:00:00Z' },
    });
    const c = new GithubFixesClient({ fetcher, maxMessageLen: 20 });
    const fix = await c.getLatestCommit('o', 'alpha');
    expect(fix!.message.endsWith('…')).toBe(true);
    expect(fix!.message.length).toBeLessThanOrEqual(20);
  });

  it('caches by sha for 24h; returns cached value when sha unchanged and TTL fresh', async () => {
    let currentSha = 'sha-1';
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { sha: currentSha, message: `msg ${calls}`, date: '2026-04-20T00:00:00Z' };
    };
    let t = 1_000_000;
    const c = new GithubFixesClient({ fetcher, now: () => t, cacheTtlMs: 24 * 3600_000 });
    const first = await c.getLatestCommit('o', 'alpha');
    expect(first!.message).toBe('msg 1');
    // Advance 1h, same sha -> still cached (should still return the cached value).
    t += 3600_000;
    const second = await c.getLatestCommit('o', 'alpha');
    expect(second!.message).toBe('msg 1');
  });

  it('invalidates cache when sha changes even within TTL', async () => {
    let callIdx = 0;
    const shas = ['sha-1', 'sha-2'];
    const messages = ['msg 1', 'msg 2'];
    const fetcher = async () => {
      const r = { sha: shas[callIdx], message: messages[callIdx], date: 'x' };
      callIdx += 1;
      return r;
    };
    let t = 1_000_000;
    const c = new GithubFixesClient({ fetcher, now: () => t, cacheTtlMs: 24 * 3600_000 });
    await c.getLatestCommit('o', 'alpha');
    t += 60_000;
    const second = await c.getLatestCommit('o', 'alpha');
    expect(second!.message).toBe('msg 2');
  });

  it('refetches after TTL expiry', async () => {
    let callIdx = 0;
    const fetcher = async () => {
      callIdx += 1;
      return { sha: `sha-${callIdx}`, message: `msg ${callIdx}`, date: 'x' };
    };
    let t = 1_000_000;
    const c = new GithubFixesClient({ fetcher, now: () => t, cacheTtlMs: 60_000 });
    await c.getLatestCommit('o', 'alpha');
    t += 61_000;
    await c.getLatestCommit('o', 'alpha');
    expect(callIdx).toBe(2);
  });

  it('falls back to cached value when fetcher throws', async () => {
    let shouldThrow = false;
    const fetcher = async () => {
      if (shouldThrow) throw new Error('rate-limited');
      return { sha: 'sha-1', message: 'msg', date: 'x' };
    };
    const c = new GithubFixesClient({ fetcher });
    const first = await c.getLatestCommit('o', 'alpha');
    shouldThrow = true;
    const second = await c.getLatestCommit('o', 'alpha');
    expect(second).toEqual(first);
  });

  it('returns null when fetcher throws and there is no cache', async () => {
    const fetcher = async () => { throw new Error('rate-limited'); };
    const c = new GithubFixesClient({ fetcher });
    const result = await c.getLatestCommit('o', 'alpha');
    expect(result).toBeNull();
  });

  it('returns null when fetcher returns null', async () => {
    const fetcher = async () => null;
    const c = new GithubFixesClient({ fetcher });
    expect(await c.getLatestCommit('o', 'alpha')).toBeNull();
  });
});

describe('fetchThisWeeksFixes', () => {
  it('iterates through repos, omitting null + throwing ones', async () => {
    const repos = ['alpha', 'beta', 'gamma'];
    const { fetcher, calls } = fakeFetcher({
      alpha: { sha: 'a1', message: 'fix: alpha', date: 'x' },
      beta: null,
      gamma: { sha: 'g1', message: 'fix: gamma', date: 'x' },
    });
    const fixes = await fetchThisWeeksFixes({
      owner: 'o',
      repos,
      fetcher,
    });
    expect(fixes.map((f) => f.repo)).toEqual(['alpha', 'gamma']);
    expect(calls).toHaveLength(3);
  });

  it('returns an empty array when every repo resolves to null', async () => {
    const fetcher = async () => null;
    const fixes = await fetchThisWeeksFixes({ owner: 'o', repos: ['a', 'b'], fetcher });
    expect(fixes).toEqual([]);
  });
});

describe('renderWeeksFixesSection', () => {
  it('returns empty string for an empty list', () => {
    expect(renderWeeksFixesSection([])).toBe('');
  });

  it('renders one line per fix with owner/repo and shortSha', () => {
    const text = renderWeeksFixesSection([
      {
        owner: 'dearborndenim',
        repo: 'alpha',
        sha: 'abc1234567',
        shortSha: 'abc1234',
        message: 'fix: stuff',
        date: '2026-04-20T00:00:00Z',
      },
    ]);
    expect(text).toContain("This week's fixes");
    expect(text).toContain('dearborndenim/alpha: fix: stuff (abc1234)');
  });
});

describe('octokitCommitFetcher', () => {
  it('calls octokit.repos.listCommits with per_page=1 and normalises the result', async () => {
    const listCommits = jest.fn(async () => ({
      data: [
        {
          sha: 'abc1234567',
          commit: {
            message: 'fix: thing',
            author: { date: '2026-04-20T00:00:00Z' },
          },
        },
      ],
    }));
    const octokit = { repos: { listCommits } };
    const fetcher = octokitCommitFetcher(octokit);
    const res = await fetcher({ owner: 'o', repo: 'alpha' });
    expect(listCommits).toHaveBeenCalledWith({ owner: 'o', repo: 'alpha', per_page: 1 });
    expect(res).toEqual({
      sha: 'abc1234567',
      message: 'fix: thing',
      date: '2026-04-20T00:00:00Z',
    });
  });

  it('returns null when the repo has no commits', async () => {
    const octokit = {
      repos: { listCommits: async () => ({ data: [] }) },
    };
    const fetcher = octokitCommitFetcher(octokit);
    const res = await fetcher({ owner: 'o', repo: 'alpha' });
    expect(res).toBeNull();
  });

  it('tolerates missing author date', async () => {
    const octokit = {
      repos: {
        listCommits: async () => ({
          data: [{ sha: 'sha1', commit: { message: 'msg' } }],
        }),
      },
    };
    const fetcher = octokitCommitFetcher(octokit);
    const res = await fetcher({ owner: 'o', repo: 'alpha' });
    expect(res?.date).toBe('');
  });
});
