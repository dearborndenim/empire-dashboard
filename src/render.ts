import { AppStatus } from './status';
import { truncateMessage } from './truncate';
import { IntegrationTile } from './integrationTiles';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderIncidentNote {
  at: string;
  note: string;
}

export interface RenderIncident {
  id: number;
  app: string;
  start: string;
  end: string | null;
  durationMin: number | null;
  reason: string | null;
  open: boolean;
  notes?: RenderIncidentNote[];
}

export interface RenderPruneRun {
  ranAt: string;
  deletedCount: number;
  deletedNotesCount: number;
  ageHours: number | null;
}

export interface RenderOptions {
  generatedAt: string;
  /** Recent incidents (closed or still-open) to surface in the sidebar panel. */
  recentIncidents?: RenderIncident[];
  /** Integration observability tiles (PO receiver, kanban inbound, etc.). */
  integrationTiles?: IntegrationTile[];
  /** Latest retention prune audit row for the home page banner. */
  latestPruneRun?: RenderPruneRun | null;
}

export function formatIncidentDuration(minutes: number | null, open: boolean): string {
  if (open) return 'ongoing';
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m === 0 ? `${h}h` : `${h}h${m}m`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr === 0 ? `${d}d` : `${d}d${hr}h`;
}

function renderPruneBanner(run: RenderPruneRun | null | undefined): string {
  if (!run) return '';
  const age =
    run.ageHours !== null && Number.isFinite(run.ageHours)
      ? run.ageHours < 1
        ? '<1h ago'
        : run.ageHours < 48
          ? `${Math.round(run.ageHours)}h ago`
          : `${Math.round(run.ageHours / 24)}d ago`
      : 'unknown';
  const ran = escapeHtml(run.ranAt);
  return `<div class="prune-banner" title="Last retention prune ran ${ran}">
    Retention prune: last run ${escapeHtml(age)} (${run.deletedCount} incident${run.deletedCount === 1 ? '' : 's'}, ${run.deletedNotesCount} note${run.deletedNotesCount === 1 ? '' : 's'} deleted)
  </div>`;
}

function renderIncidentsPanel(incidents: RenderIncident[] | undefined): string {
  if (!incidents || incidents.length === 0) {
    return `<section class="incidents">
      <h2 class="incidents__title">Recent Incidents</h2>
      <div class="incidents__empty">No incidents in the last 7 days.</div>
    </section>`;
  }
  const rows = incidents
    .map((inc) => {
      const app = escapeHtml(inc.app);
      const start = escapeHtml(inc.start);
      const reason = escapeHtml(inc.reason ?? '');
      const duration = escapeHtml(formatIncidentDuration(inc.durationMin, inc.open));
      const statusClass = inc.open ? 'incident--open' : 'incident--closed';
      const statusLabel = inc.open ? 'open' : 'closed';
      const notes = (inc.notes ?? [])
        .map((n) => {
          const at = escapeHtml(n.at);
          const body = escapeHtml(n.note);
          return `<li class="incident__note"><span class="incident__note-at">${at}</span> <span class="incident__note-body">${body}</span></li>`;
        })
        .join('');
      const notesBlock = notes
        ? `<ul class="incident__notes">${notes}</ul>`
        : '';
      return `<li class="incident ${statusClass}">
        <span class="incident__app">${app}</span>
        <span class="incident__reason">${reason}</span>
        <span class="incident__start" title="${start}">${start}</span>
        <span class="incident__duration">${duration}</span>
        <span class="incident__status">${statusLabel}</span>
        ${notesBlock}
      </li>`;
    })
    .join('\n');
  return `<section class="incidents">
    <h2 class="incidents__title">Recent Incidents <span class="incidents__count">(${incidents.length})</span></h2>
    <ul class="incidents__list">
${rows}
    </ul>
  </section>`;
}

function renderTileSparkline(
  points: IntegrationTile['sparkline'] | undefined,
): string {
  if (!points || points.length === 0) return '';
  // Color bars by success rate: >=99% green, >=80% yellow, otherwise red.
  const bars = points
    .map((p) => {
      const rate = typeof p.successRate === 'number' ? p.successRate : 0;
      const normalized = rate > 1 ? rate / 100 : rate;
      const color = normalized >= 0.99 ? 'green' : normalized >= 0.8 ? 'yellow' : 'red';
      const title = `${escapeHtml(p.date)} · ${(normalized * 100).toFixed(1)}%`;
      return `<span class="tile__spark-bar tile__spark-bar--${color}" title="${title}" aria-hidden="true"></span>`;
    })
    .join('');
  return `<div class="tile__spark" role="img" aria-label="7 day success-rate sparkline">${bars}</div>`;
}

function renderIntegrationTiles(tiles: IntegrationTile[] | undefined): string {
  if (!tiles || tiles.length === 0) return '';
  const cards = tiles
    .map((tile) => {
      const title = escapeHtml(tile.title);
      const summary = escapeHtml(tile.summary);
      const stateClass = `tile tile--${tile.state}`;
      const details = (tile.details ?? [])
        .map((d) => {
          return `<li class="tile__detail"><span class="tile__detail-label">${escapeHtml(d.label)}</span> <span class="tile__detail-value">${escapeHtml(d.value)}</span></li>`;
        })
        .join('');
      const detailsBlock = details
        ? `<ul class="tile__details">${details}</ul>`
        : '';
      const errorBlock = tile.error
        ? `<div class="tile__error">${escapeHtml(tile.error)}</div>`
        : '';
      const sparkBlock = renderTileSparkline(tile.sparkline);
      return `<div class="${stateClass}">
        <div class="tile__title">${title}</div>
        <div class="tile__summary">${summary}</div>
        ${detailsBlock}
        ${sparkBlock}
        ${errorBlock}
      </div>`;
    })
    .join('\n');
  return `<section class="tiles">
    <h2 class="tiles__title">Integrations</h2>
    <div class="tiles__grid">
${cards}
    </div>
  </section>`;
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

export interface RenderIncidentsPageOptions {
  generatedAt: string;
  appStats: Array<{
    app: string;
    mtbfHours: number | null;
    mttrMinutes: number | null;
    incidentCount: number;
    totalDowntimeMin: number;
  }>;
  recentIncidents: RenderIncident[];
}

export function formatMtbfHours(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1) return '<1h';
  if (value < 48) return `${Math.round(value)}h`;
  const days = value / 24;
  return `${days.toFixed(1)}d`;
}

export function formatMttrMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1) return '<1m';
  if (value < 60) return `${Math.round(value)}m`;
  const hours = Math.floor(value / 60);
  const mins = Math.round(value % 60);
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}

export function renderIncidentsPage(opts: RenderIncidentsPageOptions): string {
  const cards = opts.appStats
    .map((s) => {
      return `<div class="incident-stats__card">
        <div class="incident-stats__app">${escapeHtml(s.app)}</div>
        <div class="incident-stats__row"><span class="incident-stats__label">incidents</span> <span class="incident-stats__value">${s.incidentCount}</span></div>
        <div class="incident-stats__row"><span class="incident-stats__label">downtime</span> <span class="incident-stats__value">${escapeHtml(formatMttrMinutes(s.totalDowntimeMin))}</span></div>
        <div class="incident-stats__row"><span class="incident-stats__label">MTTR</span> <span class="incident-stats__value">${escapeHtml(formatMttrMinutes(s.mttrMinutes))}</span></div>
        <div class="incident-stats__row"><span class="incident-stats__label">MTBF</span> <span class="incident-stats__value">${escapeHtml(formatMtbfHours(s.mtbfHours))}</span></div>
      </div>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Incidents · Empire Dashboard</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="wrap">
    <header class="head">
      <h1>Incidents</h1>
      <div class="generated">Generated ${escapeHtml(opts.generatedAt)}</div>
    </header>
    <section class="incident-stats">
      <h2 class="incident-stats__title">Per-app (7d) MTBF / MTTR</h2>
      <div class="incident-stats__grid">
${cards}
      </div>
    </section>
    ${renderIncidentsPanel(opts.recentIncidents)}
    <footer class="foot">
      <a href="/">← home</a>
      &middot;
      <a href="/api/incidents">/api/incidents</a>
      &middot;
      <a href="/api/incidents/stats?app=${escapeHtml(opts.appStats[0]?.app ?? 'App')}">/api/incidents/stats</a>
    </footer>
  </main>
</body>
</html>`;
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
    ${renderPruneBanner(opts.latestPruneRun)}
    <section class="grid">
${cards}
    </section>
    ${renderIntegrationTiles(opts.integrationTiles)}
    ${renderIncidentsPanel(opts.recentIncidents)}
    <footer class="foot">
      <a href="/api/status">/api/status</a>
      &middot;
      <a href="/healthz">/healthz</a>
    </footer>
  </main>
</body>
</html>`;
}
