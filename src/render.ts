import { AppStatus } from './status';
import { truncateMessage } from './truncate';
import { IntegrationTile } from './integrationTiles';
import { AlertAuditRow, deriveAlertDecision } from './historyStore';

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
  rootCause?: string | null;
  open: boolean;
  notes?: RenderIncidentNote[];
}

export interface RenderTopRootCause {
  root_cause: string;
  count: number;
}

/**
 * Alert audit pagination (2026-04-25): one row in the homepage "Recent alert
 * activity" tile. Pulled directly from `historyStore.alertActivitySummary`.
 */
export interface RenderRecentAlertActivityRow {
  integration_name: string;
  total: number;
  fire_count: number;
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
  /**
   * Incidents v6: top root causes (7d) summary widget on the homepage. When
   * undefined/empty the widget is omitted.
   */
  topRootCauses?: RenderTopRootCause[];
  /**
   * Alert audit pagination (2026-04-25): per-integration rolling alert audit
   * volume + decision counts. Drives the "Recent alert activity (7d)"
   * homepage tile. Undefined/empty omits the tile body in favour of the
   * "no alert activity" empty state. Cap to 5 rows at the call site.
   */
  recentAlertActivity?: RenderRecentAlertActivityRow[];
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

function renderRootCauseBlock(inc: RenderIncident, editable: boolean): string {
  const raw = typeof inc.rootCause === 'string' ? inc.rootCause : '';
  const safeValue = escapeHtml(raw);
  const placeholder = raw ? safeValue : '<span class="incident__root-cause-placeholder">(set root cause)</span>';
  if (!editable) {
    return `<div class="incident__root-cause"><span class="incident__root-cause-label">root cause:</span> <span class="incident__root-cause-value">${placeholder}</span></div>`;
  }
  // Editable: show current value + an inline input and save button. The
  // <form> uses a data-incident-id hook picked up by the client JS in
  // renderIncidentsPage so the POST goes to /api/incidents/:id/note with a
  // minimal note + root_cause field.
  return `<form class="incident__root-cause incident__root-cause--edit" data-incident-id="${inc.id}">
    <label class="incident__root-cause-label" for="rc-input-${inc.id}">root cause:</label>
    <input type="text" class="incident__root-cause-input" id="rc-input-${inc.id}" name="root_cause" maxlength="120" value="${safeValue}" placeholder="(set root cause)" />
    <button type="submit" class="incident__root-cause-save">save</button>
    <span class="incident__root-cause-status" aria-live="polite"></span>
  </form>`;
}

function renderIncidentsPanel(
  incidents: RenderIncident[] | undefined,
  opts: { editable?: boolean } = {},
): string {
  const editable = !!opts.editable;
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
      const rootCauseBlock = renderRootCauseBlock(inc, editable);
      return `<li class="incident ${statusClass}">
        <span class="incident__app">${app}</span>
        <span class="incident__reason">${reason}</span>
        <span class="incident__start" title="${start}">${start}</span>
        <span class="incident__duration">${duration}</span>
        <span class="incident__status">${statusLabel}</span>
        ${rootCauseBlock}
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

/**
 * Alert audit pagination (2026-04-25): server-rendered "Recent alert activity
 * (7d)" tile on the homepage. Each row is a click-through into
 * `/alerts/audit?integration=<name>&days=7`. State logic:
 *   - `ok`   when `rows` is undefined/empty (no alert traffic, no badge).
 *   - `warn` when any row has `fire_count > 0` (a real alert fired in the
 *     window, regardless of how many recoveries / suppressions joined it).
 * Capped to top 5 rows at render time so the tile stays compact.
 */
export function renderRecentAlertActivityTile(
  rows: RenderRecentAlertActivityRow[] | undefined,
): string {
  const list = (rows ?? []).slice(0, 5);
  if (list.length === 0) {
    return `<section class="recent-alert-activity recent-alert-activity--ok" aria-label="Recent alert activity (7d)">
      <div class="recent-alert-activity__head">
        <h2 class="recent-alert-activity__title">Recent alert activity (7d)</h2>
        <span class="recent-alert-activity__state recent-alert-activity__state--ok">ok</span>
      </div>
      <div class="recent-alert-activity__empty">No alert activity in the last 7 days.</div>
    </section>`;
  }
  const anyFires = list.some((r) => r.fire_count > 0);
  const tileState = anyFires ? 'warn' : 'ok';
  const totalFires = list.reduce((acc, r) => acc + (r.fire_count > 0 ? r.fire_count : 0), 0);
  const stateBadge = anyFires
    ? `<span class="recent-alert-activity__state recent-alert-activity__state--warn" title="${totalFires} fire decision${totalFires === 1 ? '' : 's'} in the window">warn</span>`
    : `<span class="recent-alert-activity__state recent-alert-activity__state--ok">ok</span>`;
  const items = list
    .map((r) => {
      const name = escapeHtml(r.integration_name);
      const total = Number.isFinite(r.total) && r.total >= 0 ? r.total : 0;
      const fires = Number.isFinite(r.fire_count) && r.fire_count >= 0 ? r.fire_count : 0;
      const href = `/alerts/audit?integration=${encodeURIComponent(r.integration_name)}&days=7`;
      const badgeClass = fires > 0
        ? 'recent-alert-activity__badge recent-alert-activity__badge--fire'
        : 'recent-alert-activity__badge recent-alert-activity__badge--quiet';
      return `<li class="recent-alert-activity__item">
        <a class="recent-alert-activity__link" href="${escapeHtml(href)}">${name}</a>
        <span class="${badgeClass}">${total} audit${total === 1 ? '' : 's'}${fires > 0 ? ` · ${fires} fire${fires === 1 ? '' : 's'}` : ''}</span>
      </li>`;
    })
    .join('');
  return `<section class="recent-alert-activity recent-alert-activity--${tileState}" aria-label="Recent alert activity (7d)">
    <div class="recent-alert-activity__head">
      <h2 class="recent-alert-activity__title">Recent alert activity (7d)</h2>
      ${stateBadge}
    </div>
    <ul class="recent-alert-activity__list">${items}</ul>
  </section>`;
}

function renderTopRootCausesWidget(
  rows: RenderTopRootCause[] | undefined,
): string {
  if (!rows || rows.length === 0) return '';
  const items = rows
    .slice(0, 5)
    .map((r) => {
      const label = escapeHtml(r.root_cause);
      const count = Number.isFinite(r.count) ? r.count : 0;
      return `<li class="top-root-causes__item"><span class="top-root-causes__label">${label}</span> <span class="top-root-causes__count">${count}</span></li>`;
    })
    .join('');
  return `<section class="top-root-causes" aria-label="Top root causes (7d)">
    <h2 class="top-root-causes__title">Top root causes (7d)</h2>
    <ul class="top-root-causes__list">${items}</ul>
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

/**
 * Scene-drift v2 (2026-04-23): per-classification badge counts rendered
 * above the tile body. chronic = red, spike = yellow, stable = green. The
 * row is omitted when the tile has no classificationCounts (legacy /
 * non-classified payloads).
 */
function renderClassificationBadges(
  counts: IntegrationTile['classificationCounts'],
): string {
  if (!counts) return '';
  const items: string[] = [];
  // Render in severity order so the eye picks up chronic first.
  if (counts.chronic > 0) {
    items.push(
      `<span class="tile__badge tile__badge--chronic" title="Chronic flags (z &gt; threshold AND recently flagged)">${counts.chronic} chronic</span>`,
    );
  }
  if (counts.spike > 0) {
    items.push(
      `<span class="tile__badge tile__badge--spike" title="Spike flags (z &gt; threshold AND not recently flagged)">${counts.spike} spike</span>`,
    );
  }
  if (counts.stable > 0) {
    items.push(
      `<span class="tile__badge tile__badge--stable" title="Stable scenes (z within tolerance)">${counts.stable} stable</span>`,
    );
  }
  if (items.length === 0) return '';
  return `<div class="tile__badges" aria-label="flag classification counts">${items.join('')}</div>`;
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
          // Scene-drift v2: optional per-row classification pill.
          const cls = d.classification;
          const clsBadge = cls
            ? ` <span class="tile__detail-badge tile__detail-badge--${cls}" title="${escapeHtml(cls)}">${escapeHtml(cls)}</span>`
            : '';
          return `<li class="tile__detail"><span class="tile__detail-label">${escapeHtml(d.label)}</span> <span class="tile__detail-value">${escapeHtml(d.value)}</span>${clsBadge}</li>`;
        })
        .join('');
      const detailsBlock = details
        ? `<ul class="tile__details">${details}</ul>`
        : '';
      const errorBlock = tile.error
        ? `<div class="tile__error">${escapeHtml(tile.error)}</div>`
        : '';
      const sparkBlock = renderTileSparkline(tile.sparkline);
      const badgesBlock = renderClassificationBadges(tile.classificationCounts);
      return `<div class="${stateClass}">
        <div class="tile__title">${title}</div>
        <div class="tile__summary">${summary}</div>
        ${badgesBlock}
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
  /** Incidents v6: admin token is not exposed; the client JS prompts for it. */
  adminTokenRequired?: boolean;
  /**
   * Alert throttling polish (2026-04-23): count of integrations that
   * auto-resolved via the recovery signal in the last 24h. When > 0 the page
   * renders a callout banner with a click-through to the auto_resolved=true
   * filter. Undefined/0 hides the banner.
   */
  recoveredCount24h?: number;
  /**
   * True when the current page render is already filtered by
   * auto_resolved=true (banner click-through). Used to render a "showing
   * recovered only · clear filter" affordance instead of the banner itself.
   */
  autoResolvedFilterActive?: boolean;
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

function renderRecoveredBanner(opts: RenderIncidentsPageOptions): string {
  if (opts.autoResolvedFilterActive) {
    return `<div class="recovered-banner recovered-banner--active" role="status">
      Showing auto-resolved (recovered) integrations only.
      <a class="recovered-banner__clear" href="/incidents">Clear filter</a>
    </div>`;
  }
  const n = opts.recoveredCount24h ?? 0;
  if (!n || n <= 0) return '';
  const noun = n === 1 ? 'integration' : 'integrations';
  return `<div class="recovered-banner recovered-banner--info" role="status">
    <span class="recovered-banner__icon" aria-hidden="true">↺</span>
    <span class="recovered-banner__text">${n} ${noun} auto-resolved in the last 24h.</span>
    <a class="recovered-banner__cta" href="/incidents?auto_resolved=true">View recovered</a>
  </div>`;
}

function renderIncidentsToolbar(): string {
  return `<section class="incidents-toolbar" aria-label="Incidents toolbar">
    <form class="incidents-export" id="incidents-export-form">
      <label class="incidents-export__label" for="incidents-export-days">Export range:</label>
      <select class="incidents-export__select" id="incidents-export-days" name="days">
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option>
      </select>
      <button type="submit" class="incidents-export__button" id="incidents-export-button">Download CSV</button>
    </form>
  </section>`;
}

function renderIncidentsClientScript(): string {
  // Client-side glue: inline root_cause saves + CSV export download. Kept as
  // a literal string (no template interpolation) so tests can assert its
  // presence. The script is defensive: it no-ops if the expected DOM nodes
  // are missing.
  return `<script>
(function(){
  function getAdminToken(){
    var cached = window.sessionStorage && window.sessionStorage.getItem('empireAdminToken');
    if (cached) return cached;
    var t = window.prompt('Admin token (x-admin-token):');
    if (t && window.sessionStorage) window.sessionStorage.setItem('empireAdminToken', t);
    return t;
  }
  document.querySelectorAll('form.incident__root-cause--edit').forEach(function(form){
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var id = form.getAttribute('data-incident-id');
      var input = form.querySelector('input[name="root_cause"]');
      var statusEl = form.querySelector('.incident__root-cause-status');
      if (!id || !input) return;
      var token = getAdminToken();
      if (!token) { if (statusEl) statusEl.textContent = 'token required'; return; }
      var value = (input.value || '').trim();
      if (statusEl) statusEl.textContent = 'saving…';
      fetch('/api/incidents/' + encodeURIComponent(id) + '/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ note: 'root_cause updated', root_cause: value })
      }).then(function(r){
        if (statusEl) statusEl.textContent = r.ok ? 'saved' : ('error ' + r.status);
      }).catch(function(){ if (statusEl) statusEl.textContent = 'network error'; });
    });
  });
  var exportForm = document.getElementById('incidents-export-form');
  if (exportForm) {
    exportForm.addEventListener('submit', function(ev){
      ev.preventDefault();
      var sel = document.getElementById('incidents-export-days');
      var days = sel ? sel.value : '30';
      var url = '/api/incidents/export?format=csv&days=' + encodeURIComponent(days);
      var a = document.createElement('a');
      a.href = url; a.download = '';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
  }
})();
</script>`;
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
    ${renderRecoveredBanner(opts)}
    ${renderIncidentsToolbar()}
    ${renderIncidentsPanel(opts.recentIncidents, { editable: true })}
    <footer class="foot">
      <a href="/">← home</a>
      &middot;
      <a href="/api/incidents">/api/incidents</a>
      &middot;
      <a href="/api/incidents/stats?app=${escapeHtml(opts.appStats[0]?.app ?? 'App')}">/api/incidents/stats</a>
    </footer>
  </main>
  ${renderIncidentsClientScript()}
</body>
</html>`;
}

/**
 * Alert audit UI (2026-04-24): server-rendered HTML page at /alerts/audit.
 * Mirrors the styling/scaffold of /incidents (wrap > head > main, /styles.css).
 */
export interface RenderAlertAuditPageOptions {
  generatedAt: string;
  rows: AlertAuditRow[];
  /** Total rows matching the active filters, ignoring `rowLimit`/`offset`. */
  totalMatched: number;
  /** Page size cap applied to `rows.length`. */
  rowLimit: number;
  /**
   * Alert audit pagination (2026-04-25): zero-based row offset for the
   * current page (rows previously skipped). Defaults to 0 when omitted so
   * pre-pagination callers continue to render page 1.
   */
  offset?: number;
  /** Currently-active filter values (used to populate the filter form). */
  filters: {
    integration: string;
    decision: string;
    days: number;
    /**
     * Alert audit polish 2 (2026-04-26): exact-match actor filter. Empty
     * string means "all actors".
     */
    actor?: string;
  };
}

/**
 * Alert audit pagination (2026-04-25): build the query string preserving
 * the active filters, swapping in a fresh `offset`. Exported for tests.
 */
export function buildAlertAuditPageHref(
  filters: { integration: string; decision: string; days: number; actor?: string },
  offset: number,
): string {
  const parts: string[] = [`days=${encodeURIComponent(String(filters.days))}`];
  if (filters.integration) {
    parts.push(`integration=${encodeURIComponent(filters.integration)}`);
  }
  if (filters.decision) {
    parts.push(`decision=${encodeURIComponent(filters.decision)}`);
  }
  // Alert audit polish 2 (2026-04-26): preserve actor across paginated nav.
  if (filters.actor) {
    parts.push(`actor=${encodeURIComponent(filters.actor)}`);
  }
  if (offset > 0) {
    parts.push(`offset=${offset}`);
  }
  return `/alerts/audit?${parts.join('&')}`;
}

export function renderAlertAuditPage(opts: RenderAlertAuditPageOptions): string {
  const { rows, totalMatched, rowLimit, filters } = opts;
  const offset = typeof opts.offset === 'number' && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  // Alert audit polish 2 (2026-04-26): row colspan grew from 6 → 7 with the
  // new actor column. Per-decision colour bands are CSS-only — every row
  // already carries an `alert-audit__row--{decision}` modifier class which
  // styles.css now tints with a subtle background.
  const rowsHtml = rows.length === 0
    ? `<tr><td colspan="7" class="alert-audit__empty">No alert audit rows match the current filters.</td></tr>`
    : rows
        .map((r) => {
          const decision = deriveAlertDecision(r);
          const reason = r.reason ?? '';
          const severity = r.severity ?? '';
          const actor = r.actor ?? '';
          return `<tr class="alert-audit__row alert-audit__row--${decision}">
            <td class="alert-audit__cell alert-audit__cell--at">${escapeHtml(r.at)}</td>
            <td class="alert-audit__cell alert-audit__cell--integration">${escapeHtml(r.integration_name)}</td>
            <td class="alert-audit__cell alert-audit__cell--decision">
              <span class="alert-audit__pill alert-audit__pill--${decision}">${escapeHtml(decision)}</span>
            </td>
            <td class="alert-audit__cell alert-audit__cell--severity">${escapeHtml(severity)}</td>
            <td class="alert-audit__cell alert-audit__cell--rate">${r.success_rate === null || r.success_rate === undefined ? '' : escapeHtml((r.success_rate * 100).toFixed(1) + '%')}</td>
            <td class="alert-audit__cell alert-audit__cell--actor">${actor ? escapeHtml(actor) : '<span class="alert-audit__cell--actor-empty">&mdash;</span>'}</td>
            <td class="alert-audit__cell alert-audit__cell--reason">${escapeHtml(reason)}</td>
          </tr>`;
        })
        .join('\n');

  // Pagination math. Page size = rowLimit. Page 1 has offset=0.
  const pageSize = rowLimit > 0 ? rowLimit : 1;
  const totalPages = totalMatched <= 0 ? 1 : Math.max(1, Math.ceil(totalMatched / pageSize));
  const currentPage = Math.min(totalPages, Math.floor(offset / pageSize) + 1);
  const firstRowOnPage = rows.length === 0 ? 0 : offset + 1;
  const lastRowOnPage = rows.length === 0 ? 0 : offset + rows.length;
  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < totalMatched;
  const filtersWithActor = { ...filters, actor: filters.actor ?? '' };
  const prevHref = buildAlertAuditPageHref(filtersWithActor, Math.max(0, offset - pageSize));
  const nextHref = buildAlertAuditPageHref(filtersWithActor, offset + pageSize);

  let footerNote: string;
  if (rows.length === 0) {
    footerNote = totalMatched === 0
      ? `<p class="alert-audit__count">0 rows matched.</p>`
      : `<p class="alert-audit__count">No rows on this page (offset ${offset} of ${totalMatched} total).</p>`;
  } else if (totalMatched > pageSize) {
    footerNote = `<p class="alert-audit__count">Page ${currentPage} of ${totalPages}, showing rows ${firstRowOnPage}-${lastRowOnPage} of ${totalMatched}.</p>`;
  } else {
    footerNote = `<p class="alert-audit__count">${rows.length} row${rows.length === 1 ? '' : 's'} matched.</p>`;
  }

  const paginationHtml = totalMatched > pageSize
    ? `<nav class="alert-audit__pagination" aria-label="Alert audit pagination">
        ${
          hasPrev
            ? `<a class="alert-audit__page alert-audit__page--prev" href="${escapeHtml(prevHref)}" rel="prev">&larr; Prev</a>`
            : `<span class="alert-audit__page alert-audit__page--disabled" aria-disabled="true">&larr; Prev</span>`
        }
        <span class="alert-audit__page-indicator">Page ${currentPage} of ${totalPages}</span>
        ${
          hasNext
            ? `<a class="alert-audit__page alert-audit__page--next" href="${escapeHtml(nextHref)}" rel="next">Next &rarr;</a>`
            : `<span class="alert-audit__page alert-audit__page--disabled" aria-disabled="true">Next &rarr;</span>`
        }
      </nav>`
    : '';

  const decisionOptions = ['', 'fire', 'suppress', 'recovery', 'cooldown']
    .map((d) => {
      const label = d === '' ? 'All' : d;
      const selected = filters.decision === d ? ' selected' : '';
      return `<option value="${escapeHtml(d)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');

  const csvHref = `/alerts/audit.csv?days=${encodeURIComponent(String(filters.days))}${
    filters.integration ? `&integration=${encodeURIComponent(filters.integration)}` : ''
  }${filters.decision ? `&decision=${encodeURIComponent(filters.decision)}` : ''}${
    filters.actor ? `&actor=${encodeURIComponent(filters.actor)}` : ''
  }`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alert audit · Empire Dashboard</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="wrap">
    <header class="head">
      <h1>Alert audit</h1>
      <div class="generated">Generated ${escapeHtml(opts.generatedAt)}</div>
    </header>
    <section class="alert-audit__filters" aria-label="Filters">
      <form class="alert-audit__form" method="get" action="/alerts/audit">
        <label class="alert-audit__label">
          Integration
          <input class="alert-audit__input" type="text" name="integration" value="${escapeHtml(filters.integration)}" placeholder="(all)" maxlength="100" />
        </label>
        <label class="alert-audit__label">
          Decision
          <select class="alert-audit__select" name="decision">
            ${decisionOptions}
          </select>
        </label>
        <label class="alert-audit__label">
          Actor
          <input class="alert-audit__input" type="text" name="actor" value="${escapeHtml(filters.actor ?? '')}" placeholder="(all)" maxlength="64" />
        </label>
        <label class="alert-audit__label">
          Last
          <select class="alert-audit__select" name="days">
            ${[1, 7, 14, 30]
              .map(
                (d) =>
                  `<option value="${d}"${filters.days === d ? ' selected' : ''}>${d} day${d === 1 ? '' : 's'}</option>`,
              )
              .join('')}
          </select>
        </label>
        <button class="alert-audit__button" type="submit">Apply</button>
        <a class="alert-audit__csv" href="${escapeHtml(csvHref)}">Download CSV</a>
      </form>
    </section>
    <section class="alert-audit__legend" aria-label="Decision legend">
      <span class="alert-audit__legend-label">Decision colour bands:</span>
      <span class="alert-audit__legend-swatch alert-audit__legend-swatch--fire">fire</span>
      <span class="alert-audit__legend-swatch alert-audit__legend-swatch--suppress">suppress</span>
      <span class="alert-audit__legend-swatch alert-audit__legend-swatch--recovery">recovery</span>
      <span class="alert-audit__legend-swatch alert-audit__legend-swatch--cooldown">cooldown</span>
    </section>
    <section class="alert-audit__table-wrap">
      <table class="alert-audit__table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Integration</th>
            <th>Decision</th>
            <th>Severity</th>
            <th>Success rate</th>
            <th>Actor</th>
            <th>Reason / detail</th>
          </tr>
        </thead>
        <tbody>
${rowsHtml}
        </tbody>
      </table>
      ${paginationHtml}
      ${footerNote}
    </section>
    <footer class="foot">
      <a href="/">← home</a>
      &middot;
      <a href="/incidents">/incidents</a>
      &middot;
      <a href="/api/alerts/recent">/api/alerts/recent</a>
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
    ${renderRecentAlertActivityTile(opts.recentAlertActivity)}
    ${renderTopRootCausesWidget(opts.topRootCauses)}
    ${renderIncidentsPanel(opts.recentIncidents)}
    <footer class="foot">
      <a href="/api/status">/api/status</a>
      &middot;
      <a href="/healthz">/healthz</a>
      &middot;
      <a href="/incidents">/incidents</a>
    </footer>
  </main>
</body>
</html>`;
}
