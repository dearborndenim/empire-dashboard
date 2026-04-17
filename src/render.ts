import { AppStatus } from './status';

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

export function renderDashboard(statuses: AppStatus[], opts: RenderOptions): string {
  const cards = statuses
    .map((s) => {
      const name = escapeHtml(s.name);
      const repo = escapeHtml(s.repo);
      const summary = escapeHtml(s.summary);
      const colorClass = `card card--${s.color}`;
      const commit = s.activity.lastCommitMessage
        ? escapeHtml(s.activity.lastCommitMessage)
        : '';
      return `
        <a class="${colorClass}" href="https://github.com/${repo}" target="_blank" rel="noopener">
          <div class="card__dot" aria-hidden="true"></div>
          <div class="card__name">${name}</div>
          <div class="card__summary">${summary}</div>
          ${commit ? `<div class="card__commit">${commit}</div>` : ''}
        </a>`;
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
