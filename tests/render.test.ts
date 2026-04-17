import { escapeHtml, renderDashboard } from '../src/render';
import { AppStatus } from '../src/status';

describe('escapeHtml', () => {
  it('escapes all special characters', () => {
    expect(escapeHtml(`<a href="x">&"'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&quot;&#39;');
  });
});

describe('renderDashboard', () => {
  const statuses: AppStatus[] = [
    {
      name: 'App One',
      repo: 'o/one',
      color: 'green',
      summary: 'Up, committed 2h ago',
      health: { name: 'App One', state: 'up', checkedAt: 'x' },
      activity: {
        name: 'App One',
        repo: 'o/one',
        lastCommitMessage: 'feat: add thing',
        hoursSinceCommit: 2,
      },
    },
    {
      name: 'App Two',
      repo: 'o/two',
      color: 'red',
      summary: 'Down (HTTP 500)',
      health: { name: 'App Two', state: 'down', checkedAt: 'x' },
      activity: { name: 'App Two', repo: 'o/two' },
    },
  ];

  it('renders a full HTML page with one card per app', () => {
    const html = renderDashboard(statuses, { generatedAt: '2026-04-16T00:00:00Z' });
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain('App One');
    expect(html).toContain('App Two');
    expect(html).toContain('card--green');
    expect(html).toContain('card--red');
    expect(html).toContain('feat: add thing');
    expect(html).toContain('Generated 2026-04-16T00:00:00Z');
  });

  it('counts colors in the header pills', () => {
    const html = renderDashboard(statuses, { generatedAt: 'x' });
    expect(html).toMatch(/Green 1/);
    expect(html).toMatch(/Red 1/);
    expect(html).toMatch(/Yellow 0/);
    expect(html).toMatch(/Gray 0/);
  });

  it('escapes hostile names', () => {
    const hostile: AppStatus[] = [
      {
        ...statuses[0],
        name: '<script>alert(1)</script>',
        summary: '"oops"',
      },
    ];
    const html = renderDashboard(hostile, { generatedAt: 'x' });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;oops&quot;');
  });
});
