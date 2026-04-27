/**
 * Alert audit polish 2 (2026-04-26): daily 7 AM CT email digest summarising
 * the last 24h of alert audit activity.
 *
 * Mirrors the established empire-dashboard digest pattern (see
 * `weeklyReport.ts`):
 *
 *  - `buildAlertAuditDigestData()` is a pure function that snapshots the
 *    audit window into a serializable shape — easy to unit test.
 *  - `renderAlertAuditDigestText()` / `renderAlertAuditDigestHtml()` produce
 *    plain-text and HTML bodies respectively.
 *  - `sendAlertAuditDigest()` glues the above together and ships the email
 *    via the same `EmailSender` adapter the weekly report uses (SMTP w/
 *    console fallback when SMTP_HOST is unset).
 *
 * Empty case: when there were zero audit rows in the window we return early
 * and DON'T send anything — Robert's inbox is precious.
 *
 * Env:
 *  - `ALERT_AUDIT_DIGEST_RECIPIENT` — when set, the digest fires daily.
 *  - `ALERT_AUDIT_DIGEST_FROM` — optional envelope sender override.
 *  - `DISABLE_ALERT_AUDIT_DIGEST=1` — opt-out, even if recipient set.
 */

import { AlertAuditRow, HistoryStore, deriveAlertDecision } from './historyStore';
import { EmailMessage, EmailSender } from './email';

export interface AlertAuditDigestIntegrationRow {
  integration_name: string;
  total: number;
  fire_count: number;
  suppress_count: number;
  recovery_count: number;
  cooldown_count: number;
}

export interface AlertAuditDigestData {
  /** ISO timestamp the digest snapshot was built. */
  generatedAt: string;
  /** Window covered by this digest, in hours. Always 24 for the daily job. */
  windowHours: number;
  /** Total audit rows in the window. */
  total: number;
  /** Total `fire`-decision rows in the window (drives the subject). */
  totalFires: number;
  /** Total `suppress`-decision rows in the window. */
  totalSuppresses: number;
  /** Total `recovery`-decision rows in the window. */
  totalRecoveries: number;
  /** Total `cooldown`-decision rows in the window. */
  totalCooldowns: number;
  /**
   * Top integrations by fire count, then total volume, then name. Capped at
   * `topN` (default 10). When the window is empty this list is empty too —
   * but `sendAlertAuditDigest()` short-circuits before we try to build the
   * email body in that case.
   */
  topIntegrations: AlertAuditDigestIntegrationRow[];
}

export interface BuildAlertAuditDigestOptions {
  store: HistoryStore;
  /** Defaults to Date.now(). */
  nowMs?: number;
  /** Defaults to 24. */
  windowHours?: number;
  /** Defaults to 10. */
  topN?: number;
}

/**
 * Snapshot the last `windowHours` hours of `alert_audit_log` and roll it up
 * for the digest.
 *
 * We call `listAlertAudits` directly with a `days` filter computed from
 * `windowHours` so the SQL `WHERE` clause does the heavy lifting (the
 * underlying call shares the body with `countAlertAudits` so the math stays
 * exact). The window is sub-day on the 24h default, so we pass a fractional
 * `days` value — `historyStore.buildAlertAuditQuery` honours fractional
 * days via the same `nowMs - days * 86400_000` formula.
 */
export function buildAlertAuditDigestData(
  opts: BuildAlertAuditDigestOptions,
): AlertAuditDigestData {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? 24;
  const topN = opts.topN ?? 10;

  // 1 day = 24h. Convert windowHours -> fractional days (works because the
  // store derives `since` from `days * 86400_000`).
  const days = windowHours / 24;

  const rows: AlertAuditRow[] = opts.store.listAlertAudits({
    days,
    nowMs,
    // Cap above the per-page UI limit — we want every row in the window for
    // an accurate aggregate. The audit table prunes naturally over time, so
    // 24h windows are bounded.
    limit: 5000,
  });

  let totalFires = 0;
  let totalSuppresses = 0;
  let totalRecoveries = 0;
  let totalCooldowns = 0;
  const byIntegration = new Map<string, AlertAuditDigestIntegrationRow>();

  for (const r of rows) {
    const decision = deriveAlertDecision(r);
    let bucket = byIntegration.get(r.integration_name);
    if (!bucket) {
      bucket = {
        integration_name: r.integration_name,
        total: 0,
        fire_count: 0,
        suppress_count: 0,
        recovery_count: 0,
        cooldown_count: 0,
      };
      byIntegration.set(r.integration_name, bucket);
    }
    bucket.total += 1;
    switch (decision) {
      case 'fire':
        bucket.fire_count += 1;
        totalFires += 1;
        break;
      case 'suppress':
        bucket.suppress_count += 1;
        totalSuppresses += 1;
        break;
      case 'recovery':
        bucket.recovery_count += 1;
        totalRecoveries += 1;
        break;
      case 'cooldown':
        bucket.cooldown_count += 1;
        totalCooldowns += 1;
        break;
    }
  }

  const topIntegrations = [...byIntegration.values()]
    .sort((a, b) => {
      // Fires-first ordering: an integration that fired even once should
      // outrank a noisy-but-suppressed neighbour.
      if (b.fire_count !== a.fire_count) return b.fire_count - a.fire_count;
      if (b.total !== a.total) return b.total - a.total;
      return a.integration_name.localeCompare(b.integration_name);
    })
    .slice(0, topN);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowHours,
    total: rows.length,
    totalFires,
    totalSuppresses,
    totalRecoveries,
    totalCooldowns,
    topIntegrations,
  };
}

export function renderAlertAuditDigestText(data: AlertAuditDigestData): string {
  const lines: string[] = [];
  lines.push(`Empire Dashboard — Alert audit digest (${data.windowHours}h)`);
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push('');
  lines.push('Decision rollup');
  lines.push('---------------');
  lines.push(`  total      ${data.total}`);
  lines.push(`  fires      ${data.totalFires}`);
  lines.push(`  suppresses ${data.totalSuppresses}`);
  lines.push(`  recoveries ${data.totalRecoveries}`);
  lines.push(`  cooldowns  ${data.totalCooldowns}`);
  lines.push('');
  lines.push('Top integrations by fire count');
  lines.push('------------------------------');
  if (data.topIntegrations.length === 0) {
    lines.push('  (none — audit log was empty)');
  } else {
    for (const row of data.topIntegrations) {
      lines.push(
        `  ${row.integration_name.padEnd(28)} fires=${row.fire_count}  total=${row.total}  ` +
          `suppress=${row.suppress_count}  recover=${row.recovery_count}  cooldown=${row.cooldown_count}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAlertAuditDigestHtml(data: AlertAuditDigestData): string {
  const rowsHtml = data.topIntegrations.length === 0
    ? `<tr><td colspan="6" style="color:#777;font-style:italic">none — audit log was empty</td></tr>`
    : data.topIntegrations
        .map((r) => {
          const fireStyle = r.fire_count > 0 ? ' style="color:#b82424;font-weight:600"' : '';
          return `<tr>
              <td>${escapeHtml(r.integration_name)}</td>
              <td${fireStyle}>${r.fire_count}</td>
              <td>${r.total}</td>
              <td>${r.suppress_count}</td>
              <td>${r.recovery_count}</td>
              <td>${r.cooldown_count}</td>
            </tr>`;
        })
        .join('');

  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:720px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 4px">Alert audit digest (${data.windowHours}h)</h2>
  <div style="color:#888;font-size:12px;margin-bottom:16px">Generated ${escapeHtml(data.generatedAt)}</div>
  <h3>Decision rollup</h3>
  <ul style="line-height:1.6">
    <li>Total: <strong>${data.total}</strong></li>
    <li>Fires: <strong>${data.totalFires}</strong></li>
    <li>Suppresses: ${data.totalSuppresses}</li>
    <li>Recoveries: ${data.totalRecoveries}</li>
    <li>Cooldowns: ${data.totalCooldowns}</li>
  </ul>
  <h3>Top integrations by fire count</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <thead>
      <tr style="text-align:left;border-bottom:1px solid #ddd">
        <th style="padding:6px 8px">Integration</th>
        <th style="padding:6px 8px">Fires</th>
        <th style="padding:6px 8px">Total</th>
        <th style="padding:6px 8px">Suppress</th>
        <th style="padding:6px 8px">Recover</th>
        <th style="padding:6px 8px">Cooldown</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body></html>`;
}

export interface SendAlertAuditDigestOptions extends BuildAlertAuditDigestOptions {
  sender: EmailSender;
  /** Defaults to env `ALERT_AUDIT_DIGEST_RECIPIENT`. */
  to?: string;
  /** Defaults to env `ALERT_AUDIT_DIGEST_FROM`. */
  from?: string;
  /** Inject env for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional logger for the no-op short-circuit notice. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface SendAlertAuditDigestResult {
  /** True iff an email was actually shipped via the sender. */
  sent: boolean;
  /** When skipped, the human-readable reason. */
  reason?: 'opt-out' | 'no-recipient' | 'empty-window';
  /** Snapshot we built before deciding to send (or not). */
  data: AlertAuditDigestData;
  delivered?: boolean;
  transport?: string;
}

/**
 * Build + send the daily digest. Idempotent: when the window is empty OR
 * the opt-out env var is set OR no recipient configured, we short-circuit
 * with a stable result shape (so the caller can log it).
 */
export async function sendAlertAuditDigest(
  opts: SendAlertAuditDigestOptions,
): Promise<SendAlertAuditDigestResult> {
  const env = opts.env ?? process.env;
  const data = buildAlertAuditDigestData(opts);

  // Opt-out wins over recipient — even if you configure the recipient, this
  // env flag silences the digest until removed.
  if ((env.DISABLE_ALERT_AUDIT_DIGEST ?? '').trim() === '1') {
    return { sent: false, reason: 'opt-out', data };
  }

  const recipient = (opts.to ?? env.ALERT_AUDIT_DIGEST_RECIPIENT ?? '').trim();
  if (!recipient) {
    return { sent: false, reason: 'no-recipient', data };
  }

  // Empty case: nothing to email about.
  if (data.total === 0) {
    return { sent: false, reason: 'empty-window', data };
  }

  const text = renderAlertAuditDigestText(data);
  const html = renderAlertAuditDigestHtml(data);
  const message: EmailMessage = {
    to: recipient,
    from: opts.from ?? env.ALERT_AUDIT_DIGEST_FROM ?? undefined,
    subject: `Empire Dashboard — alert audit digest (${data.totalFires} fire${data.totalFires === 1 ? '' : 's'} / ${data.windowHours}h)`,
    text,
    html,
  };
  const result = await opts.sender.send(message);
  return {
    sent: true,
    data,
    delivered: result.delivered,
    transport: result.transport,
  };
}
