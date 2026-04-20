/**
 * Build + send the weekly incident summary email.
 *
 * Pure functions here so the output is trivial to unit test — the caller
 * wires up the real EmailSender and schedules the send.
 */

import { AppConfig } from './config';
import { HistoryStore, IncidentRow } from './historyStore';
import { EmailMessage, EmailSender } from './email';

export interface WeeklyReportData {
  windowDays: number;
  generatedAt: string;
  incidentCount: number;
  closedCount: number;
  openCount: number;
  uptimeRollup: Array<{ app: string; uptimePercent: number | null }>;
  topDowntime: Array<{ app: string; totalDowntimeMin: number; incidents: number }>;
  /**
   * Top-3 longest single downtimes in the window (open->close duration).
   * Unresolved (still-open) incidents are truncated at `nowMs`. Sorted by
   * duration descending.
   */
  longestIncidents: Array<{
    app: string;
    durationMin: number;
    startedAt: string;
    endedAt: string | null;
    open: boolean;
    reason: string | null;
    notes: Array<{ at: string; note: string }>;
  }>;
}

export interface BuildReportOptions {
  apps: AppConfig[];
  store: HistoryStore;
  nowMs?: number;
  windowDays?: number;
}

/**
 * Aggregate stats for the weekly report. Returns a plain object that is
 * easy to snapshot in tests and to render as text.
 */
export function buildWeeklyReportData(opts: BuildReportOptions): WeeklyReportData {
  const windowDays = opts.windowDays ?? 7;
  const nowMs = opts.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const incidents = opts.store.listIncidents({
    days: windowDays,
    nowMs,
    limit: 10000,
    includeNotes: true,
  });
  const closedCount = incidents.filter((i) => i.incident_end !== null).length;
  const openCount = incidents.length - closedCount;

  const uptimeRollup = opts.apps.map((app) => ({
    app: app.name,
    uptimePercent: opts.store.uptimePercent(app.name, windowDays * 24, nowMs),
  }));

  // Aggregate downtime per app (sum of all closed + estimate for still-open)
  const downtimeByApp = new Map<string, { total: number; incidents: number }>();
  for (const inc of incidents) {
    const current = downtimeByApp.get(inc.app_name) ?? { total: 0, incidents: 0 };
    current.incidents += 1;
    if (typeof inc.duration_min === 'number') {
      current.total += inc.duration_min;
    } else if (inc.incident_end === null) {
      // Open incident — use now - start as the running duration.
      const start = Date.parse(inc.incident_start);
      if (Number.isFinite(start)) {
        current.total += Math.max(0, (nowMs - start) / 60000);
      }
    }
    downtimeByApp.set(inc.app_name, current);
  }
  const topDowntime = [...downtimeByApp.entries()]
    .map(([app, v]) => ({ app, totalDowntimeMin: v.total, incidents: v.incidents }))
    .sort((a, b) => b.totalDowntimeMin - a.totalDowntimeMin)
    .slice(0, 3);

  // Longest single downtimes (not per-app totals). Unresolved incidents
  // have duration = now - start (truncated at cutoff).
  const longestIncidents = incidents
    .map((inc) => {
      const startMs = Date.parse(inc.incident_start);
      let durationMin: number | null = null;
      const open = inc.incident_end === null;
      if (typeof inc.duration_min === 'number') {
        durationMin = inc.duration_min;
      } else if (open && Number.isFinite(startMs)) {
        durationMin = Math.max(0, (nowMs - startMs) / 60000);
      }
      return {
        app: inc.app_name,
        durationMin: durationMin ?? 0,
        startedAt: inc.incident_start,
        endedAt: inc.incident_end,
        open,
        reason: inc.reason ?? null,
        notes: (inc.notes ?? []).map((n) => ({ at: n.at, note: n.note })),
      };
    })
    .filter((r) => r.durationMin > 0)
    .sort((a, b) => b.durationMin - a.durationMin)
    .slice(0, 3);

  return {
    windowDays,
    generatedAt,
    incidentCount: incidents.length,
    closedCount,
    openCount,
    uptimeRollup,
    topDowntime,
    longestIncidents,
  };
}

/**
 * Render the WeeklyReportData into a plain-text email body.
 */
export function renderWeeklyReportText(data: WeeklyReportData): string {
  const lines: string[] = [];
  lines.push(`Empire Dashboard — Weekly Summary (last ${data.windowDays} days)`);
  lines.push(`Generated ${data.generatedAt}`);
  lines.push('');
  lines.push(`Incidents: ${data.incidentCount} (closed ${data.closedCount}, open ${data.openCount})`);
  lines.push('');
  lines.push('Uptime rollup');
  lines.push('-------------');
  const sortedRollup = [...data.uptimeRollup].sort((a, b) => {
    const av = a.uptimePercent ?? -1;
    const bv = b.uptimePercent ?? -1;
    return bv - av;
  });
  for (const row of sortedRollup) {
    const pct =
      typeof row.uptimePercent === 'number' ? `${row.uptimePercent.toFixed(2)}%` : 'n/a';
    lines.push(`  ${row.app.padEnd(36)} ${pct}`);
  }
  lines.push('');
  lines.push('Top 3 apps by downtime');
  lines.push('----------------------');
  if (data.topDowntime.length === 0) {
    lines.push('  (none — nothing went red this week)');
  } else {
    for (const row of data.topDowntime) {
      lines.push(
        `  ${row.app.padEnd(36)} ${formatMinutes(row.totalDowntimeMin)} across ${row.incidents} incident${row.incidents === 1 ? '' : 's'}`,
      );
    }
  }
  lines.push('');
  lines.push('Longest downtimes');
  lines.push('-----------------');
  if (data.longestIncidents.length === 0) {
    lines.push('  (none — nothing went red this week)');
  } else {
    for (const inc of data.longestIncidents) {
      const endLabel = inc.open
        ? 'ongoing (truncated at report time)'
        : inc.endedAt ?? '—';
      const reasonLabel = inc.reason ? ` — ${inc.reason}` : '';
      lines.push(
        `  ${inc.app}${reasonLabel}`,
      );
      lines.push(
        `    duration: ${formatMinutes(inc.durationMin)}  started: ${inc.startedAt}  ended: ${endLabel}`,
      );
      if (inc.notes.length > 0) {
        for (const n of inc.notes) {
          lines.push(`    note @ ${n.at}: ${n.note}`);
        }
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r === 0 ? `${h}h` : `${h}h${r}m`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr === 0 ? `${d}d` : `${d}d${hr}h`;
}

export interface SendWeeklyReportOptions extends BuildReportOptions {
  to: string;
  from?: string;
  sender: EmailSender;
}

/**
 * Build + send the weekly report in one call. Returns the computed data
 * plus the transport result for logging.
 */
export async function sendWeeklyReport(
  opts: SendWeeklyReportOptions,
): Promise<{ data: WeeklyReportData; delivered: boolean; transport: string }> {
  const data = buildWeeklyReportData(opts);
  const text = renderWeeklyReportText(data);
  const message: EmailMessage = {
    to: opts.to,
    from: opts.from,
    subject: `Empire Dashboard weekly summary — ${data.incidentCount} incident${data.incidentCount === 1 ? '' : 's'}`,
    text,
  };
  const result = await opts.sender.send(message);
  return { data, ...result };
}
