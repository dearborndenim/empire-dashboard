import { escapeHtml, renderDashboard, formatIncidentDuration } from '../src/render';
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

  it('truncates long commit messages to 80 chars with ellipsis', () => {
    const long: AppStatus[] = [
      {
        ...statuses[0],
        activity: {
          name: 'App One',
          repo: 'o/one',
          lastCommitMessage: 'feat: ' + 'x'.repeat(200),
          hoursSinceCommit: 1,
        },
      },
    ];
    const html = renderDashboard(long, { generatedAt: 'x' });
    expect(html).toContain('\u2026');
    // Original long string should not appear verbatim.
    expect(html).not.toContain('x'.repeat(100));
  });

  it('renders an active logs link when railway_logs_url is present', () => {
    const withLogs: AppStatus[] = [
      { ...statuses[0], railway_logs_url: 'https://railway.com/project/p/service/s' },
    ];
    const html = renderDashboard(withLogs, { generatedAt: 'x' });
    expect(html).toMatch(/href="https:\/\/railway\.com\/project\/p\/service\/s"/);
    expect(html).toContain('>logs<');
  });

  it('renders a disabled logs span when railway_logs_url is missing', () => {
    const html = renderDashboard(statuses, { generatedAt: 'x' });
    expect(html).toContain('card__logs--disabled');
  });

  it('renders uptime_7d and a sparkline of bar cells', () => {
    const withHistory: AppStatus[] = [
      {
        ...statuses[0],
        uptime_7d: '99.5%',
        sparkline_24h: ['green', 'green', 'yellow', 'red', 'gray'].concat(
          Array(19).fill('green'),
        ) as AppStatus['sparkline_24h'],
      },
    ];
    const html = renderDashboard(withHistory, { generatedAt: 'x' });
    expect(html).toContain('7d 99.5%');
    expect(html).toContain('spark__bar--green');
    expect(html).toContain('spark__bar--red');
    expect(html).toContain('card__spark');
  });

  it('shows an empty uptime placeholder when uptime_7d is missing', () => {
    const html = renderDashboard(statuses, { generatedAt: 'x' });
    expect(html).toContain('card__uptime--empty');
  });

  it('renders the recent incidents panel when incidents are provided', () => {
    const html = renderDashboard(statuses, {
      generatedAt: 'x',
      recentIncidents: [
        {
          id: 1,
          app: 'App Two',
          start: '2026-04-18T00:00:00.000Z',
          end: null,
          durationMin: null,
          reason: 'HTTP 502',
          open: true,
        },
        {
          id: 2,
          app: 'App One',
          start: '2026-04-17T00:00:00.000Z',
          end: '2026-04-17T00:05:00.000Z',
          durationMin: 5,
          reason: 'HTTP 500',
          open: false,
        },
      ],
    });
    expect(html).toContain('Recent Incidents');
    expect(html).toContain('App Two');
    expect(html).toContain('HTTP 502');
    expect(html).toContain('incident--open');
    expect(html).toContain('incident--closed');
    expect(html).toContain('ongoing');
    expect(html).toContain('5m');
  });

  it('renders an empty incidents message when list is empty', () => {
    const html = renderDashboard(statuses, { generatedAt: 'x', recentIncidents: [] });
    expect(html).toContain('No incidents in the last 7 days');
  });

  it('renders the empty state when recentIncidents is not supplied', () => {
    const html = renderDashboard(statuses, { generatedAt: 'x' });
    expect(html).toContain('No incidents in the last 7 days');
  });
});

describe('formatIncidentDuration', () => {
  it('returns "ongoing" when the incident is open', () => {
    expect(formatIncidentDuration(10, true)).toBe('ongoing');
    expect(formatIncidentDuration(null, true)).toBe('ongoing');
  });

  it('returns em-dash for null duration on closed incidents', () => {
    expect(formatIncidentDuration(null, false)).toBe('\u2014');
  });

  it('formats sub-minute as <1m', () => {
    expect(formatIncidentDuration(0.5, false)).toBe('<1m');
  });

  it('formats durations in m/h/d buckets', () => {
    expect(formatIncidentDuration(5, false)).toBe('5m');
    expect(formatIncidentDuration(60, false)).toBe('1h');
    expect(formatIncidentDuration(90, false)).toBe('1h30m');
    expect(formatIncidentDuration(24 * 60, false)).toBe('1d');
    expect(formatIncidentDuration(25 * 60, false)).toBe('1d1h');
  });

  it('returns em-dash for non-finite input', () => {
    expect(formatIncidentDuration(NaN, false)).toBe('\u2014');
  });
});
