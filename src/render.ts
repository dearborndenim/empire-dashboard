import { AppStatus } from './status';
import { truncateMessage } from './truncate';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderOptions {
  generatedAt: string;
}

function renderSparkline(cells: AppStatus['sparkline_24h']): string {
  if (!cells || cells.length === 0) return '';
  const bars = cells
    .map((c) => `<span class="spark__bar spark__bar--${c}" aria-hidden="true"></span>`)
    .join('');
  return `<div class="card__spark" role="img" aria-label="24 hour uptime sparkline">${bars}</div>`;
}

function renderLogsLink(url: string | undefined): string {
  if (url) {
    const safe = escapeHtml(url);
    return `<a class="card__logs" href="${safe}" target="_blank" rel="noopener" onclick="event.stopPropagation()">logs</a>`;
  }
  return `<span class="card__logs card__logs--disabled" aria-disabled="true" title="No Railway project/service configured">logs</span>`;
}

export function renderDashboard(statuses: AppStatus[], opts: RenderOptions): string {
  const cards = statuses
    .map((s) => {
      const name = escapeHtml(s.name);
      const repo = escapeHtml(s.repo);
      const summary = escapeHtml(s.summary);
      const colorClass = `card card--${s.color}`;
      const truncated = truncateMessage(s.activity.lastCommitMessage, 80);
      const commit = truncated ? escapeHtml(truncated) : '';
      const uptime = s.uptime_7d ? escapeHtml(s.uptime_7d) : '';
      return `
        <div class="${colorClass}">
          <div class="card__dot" aria-hidden="true"></div>
          <a class="card__name" href="https://github.com/${repo}" target="_blank" rel="noopener">${name}</a>
          <div class="card__summary">${summary}</div>
          ${commit ? `<div class="card__commit" title="${commit}">${commit}</div>` : ''}
          ${renderSparkline(s.sparkline_24h)}
          <div class="card__meta">
            ${uptime ? `<span class="card__uptime">7d ${uptime}</span>` : '<span class="card__uptime card__uptime--empty">7d &ndash;</span>'}
            ${renderLogsLink(s.railway_logs_url)}
          </div>
        </div>`;
    })
    .join('\n');

  const counts = statuses.reduce(
    (acc, s) => {
      acc[s.color] = (acc[s.color] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Empire Dashboard</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="wrap">
    <header class="head">
      <h1>Empire Dashboard</h1>
      <div class="stats">
        <span class="pill pill--green">Green ${counts.green ?? 0}</span>
        <span class="pill pill--yellow">Yellow ${counts.yellow ?? 0}</span>
        <span class="pill pill--red">Red ${counts.red ?? 0}</span>
        <span class="pill pill--gray">Gray ${counts.gray ?? 0}</span>
      </div>
      <div class="generated">Generated ${escapeHtml(opts.generatedAt)}</div>
    </header>
    <section class="grid">
${cards}
    </section>
    <footer class="foot">
      <a href="/api/status">/api/status</a>
      &middot;
      <a href="/healthz">/healthz</a>
    </footer>
  </main>
</body>
</html>`;
}
