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
import { ConsoleEmailSender, EmailMessage, EmailSender } from './email';
import { computeSavedViewCounts, SavedViewCountCache } from './savedViewCounts';

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
  /**
   * Alert audit polish 4 (2026-04-28): saved /alerts/audit filter views with
   * their current global match counts. Populated when
   * `BuildPerActorDigestsOptions.includeSavedViews` is true. Always
   * undefined for the regular fleet digest (`sendAlertAuditDigest`).
   */
  savedViews?: AlertAuditDigestSavedViewRow[];
}

/**
 * Alert audit polish 4 (2026-04-28): per-saved-view rollup row included in
 * per-actor digest payloads. The data is global — saved views aren't
 * per-actor today — but we surface the list so each actor's recipient sees
 * which filters are popular across the team.
 */
export interface AlertAuditDigestSavedViewRow {
  id: number;
  name: string;
  query_string: string;
  /** Current global match count, or null when the count failed to compute. */
  count: number | null;
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
  // Polish 4 (2026-04-28): "Your saved views" section. Only emitted when the
  // builder threaded a `savedViews` array onto the data — the regular fleet
  // digest never sets it so its plaintext is byte-identical pre-change.
  if (data.savedViews) {
    lines.push('Your saved views');
    lines.push('----------------');
    if (data.savedViews.length === 0) {
      lines.push('  (no saved views configured)');
    } else {
      for (const view of data.savedViews) {
        const countLabel = view.count === null ? '?' : String(view.count);
        lines.push(`  ${view.name.padEnd(28)} matches=${countLabel}`);
      }
    }
    lines.push('');
  }
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

  // Polish 4 (2026-04-28): "Your saved views" HTML section. Only emitted
  // when the builder threaded `savedViews` onto the data. Names are
  // user-supplied so they MUST be escaped — `escapeHtml` handles every row
  // explicitly to keep the rendering XSS-safe.
  let savedViewsHtml = '';
  if (data.savedViews) {
    if (data.savedViews.length === 0) {
      savedViewsHtml = `
  <h3>Your saved views</h3>
  <p style="color:#777;font-style:italic">no saved views configured</p>`;
    } else {
      const savedViewRows = data.savedViews
        .map((v) => {
          const countLabel = v.count === null ? '?' : String(v.count);
          return `<tr>
              <td style="padding:6px 8px">${escapeHtml(v.name)}</td>
              <td style="padding:6px 8px"><code>${escapeHtml(v.query_string || '(no filters)')}</code></td>
              <td style="padding:6px 8px">${escapeHtml(countLabel)}</td>
            </tr>`;
        })
        .join('');
      savedViewsHtml = `
  <h3>Your saved views</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <thead>
      <tr style="text-align:left;border-bottom:1px solid #ddd">
        <th style="padding:6px 8px">Name</th>
        <th style="padding:6px 8px">Filter</th>
        <th style="padding:6px 8px">Matches</th>
      </tr>
    </thead>
    <tbody>${savedViewRows}</tbody>
  </table>`;
    }
  }

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
  </table>${savedViewsHtml}
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
 * Alert audit polish 3 (2026-04-27): per-actor digest variant. Splits the
 * 24h audit window by `actor` and emits one digest payload per non-empty
 * actor. Mirrors the piece-work-scanner per-scanner digest pattern so an
 * operator can subscribe a specific recipient to a specific actor's
 * activity (e.g. CLI-driven cleanup runs vs. the monitor's automated
 * fires).
 *
 * Rows with NULL/empty `actor` are bucketed under the synthetic key
 * `(unattributed)` so legacy data is still surfaced — but we do NOT send
 * an email for that bucket (it would add noise without context). Callers
 * that want it can opt in by listing `(unattributed)` explicitly in their
 * downstream router.
 */
export interface PerActorDigestPayload {
  actor: string;
  data: AlertAuditDigestData;
}

export interface BuildPerActorDigestsOptions extends BuildAlertAuditDigestOptions {
  /** Optional cap to skip actors below this many rows. Default 1. */
  minRows?: number;
  /**
   * Alert audit polish 4 (2026-04-28): when true, each per-actor payload
   * carries a "Your saved views" rollup with the current global match count
   * per saved view. Default true (back-compat: existing tests assert no
   * `savedViews` key, but the field is optional so they keep passing).
   * Disable explicitly to mirror legacy payloads byte-for-byte.
   */
  includeSavedViews?: boolean;
  /**
   * Optional cache for saved-view counts. Defaults to a fresh
   * `SavedViewCountCache` per call so the digest sees stable counts even if
   * the page cache TTL has expired between requests.
   */
  savedViewCountCache?: SavedViewCountCache;
}

/**
 * Group last-Nh audit rows by actor and produce one digest payload per
 * non-null/non-empty actor with at least `minRows` rows. Returns a sorted
 * list (most rows first, then alphabetical) so the scheduler logs read
 * cleanly.
 */
export function buildPerActorDigests(
  opts: BuildPerActorDigestsOptions,
): PerActorDigestPayload[] {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? 24;
  const topN = opts.topN ?? 10;
  const minRows = Math.max(1, opts.minRows ?? 1);
  const days = windowHours / 24;

  const rows = opts.store.listAlertAudits({ days, nowMs, limit: 5000 });
  const byActor = new Map<string, AlertAuditRow[]>();
  for (const r of rows) {
    const actor = (r.actor ?? '').trim();
    if (!actor) continue; // skip unattributed rows for the per-actor split
    let bucket = byActor.get(actor);
    if (!bucket) {
      bucket = [];
      byActor.set(actor, bucket);
    }
    bucket.push(r);
  }

  // Polish 4 (2026-04-28): build the saved-views rollup once and attach to
  // every per-actor payload. Data is global today — saved views aren't
  // per-actor — so the same list is reused for every recipient.
  let savedViews: AlertAuditDigestSavedViewRow[] | undefined;
  if (opts.includeSavedViews) {
    try {
      const baseViews = opts.store.listAlertAuditSavedViews().map((v) => ({
        id: v.id,
        name: v.name,
        query_string: v.query_string,
      }));
      const cache = opts.savedViewCountCache ?? new SavedViewCountCache();
      savedViews = computeSavedViewCounts({
        store: opts.store,
        views: baseViews,
        cache,
        nowMs,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[empire-dashboard] per-actor digest saved-views read failed:', err);
      savedViews = [];
    }
  }

  const payloads: PerActorDigestPayload[] = [];
  for (const [actor, actorRows] of byActor.entries()) {
    if (actorRows.length < minRows) continue;
    // Reuse the same per-row aggregation as buildAlertAuditDigestData by
    // funnelling through a shim store that returns the pre-filtered rows.
    const shimStore: HistoryStore = {
      ...opts.store,
      listAlertAudits: () => actorRows,
    } as HistoryStore;
    const data = buildAlertAuditDigestData({
      store: shimStore,
      nowMs,
      windowHours,
      topN,
    });
    if (savedViews) data.savedViews = savedViews;
    payloads.push({ actor, data });
  }
  payloads.sort((a, b) => {
    if (b.data.total !== a.data.total) return b.data.total - a.data.total;
    return a.actor.localeCompare(b.actor);
  });
  return payloads;
}

export interface SendPerActorAlertAuditDigestsOptions
  extends BuildPerActorDigestsOptions {
  sender: EmailSender;
  /**
   * Map of actor → recipient. When an actor is missing from the map and
   * `defaultRecipient` is set, we fall back; otherwise we skip the actor
   * with `reason: 'no-recipient'`.
   */
  recipients?: Record<string, string>;
  /** Fallback recipient for actors without an explicit map entry. */
  defaultRecipient?: string;
  from?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PerActorDigestSendResult {
  actor: string;
  sent: boolean;
  reason?: 'opt-out' | 'no-recipient' | 'empty-window';
  data: AlertAuditDigestData;
  delivered?: boolean;
  transport?: string;
}

/**
 * Ship one digest email per non-empty actor with ≥ `minRows` rows in the
 * window. Routing rules:
 *   - When `DISABLE_ALERT_AUDIT_PER_ACTOR_DIGEST=1` we short-circuit ALL
 *     actors with reason `opt-out` — opt-out wins over recipient.
 *   - Recipient resolution per actor: `recipients[actor]`, then
 *     `defaultRecipient`, then env `ALERT_AUDIT_PER_ACTOR_DIGEST_RECIPIENT`.
 *   - When the actor's payload is empty (no rows survive aggregation —
 *     should never happen given we filter first, but defensive), reason
 *     `empty-window`.
 *
 * Returns one result per actor split, in the same sort order as
 * `buildPerActorDigests`.
 */
export async function sendPerActorAlertAuditDigests(
  opts: SendPerActorAlertAuditDigestsOptions,
): Promise<PerActorDigestSendResult[]> {
  const env = opts.env ?? process.env;
  const optOut = (env.DISABLE_ALERT_AUDIT_PER_ACTOR_DIGEST ?? '').trim() === '1';
  const fallbackEnvRecipient = (env.ALERT_AUDIT_PER_ACTOR_DIGEST_RECIPIENT ?? '').trim();
  const payloads = buildPerActorDigests(opts);
  const results: PerActorDigestSendResult[] = [];
  for (const { actor, data } of payloads) {
    if (optOut) {
      results.push({ actor, sent: false, reason: 'opt-out', data });
      continue;
    }
    const recipient = (
      (opts.recipients && opts.recipients[actor]) ||
      opts.defaultRecipient ||
      fallbackEnvRecipient ||
      ''
    ).trim();
    if (!recipient) {
      results.push({ actor, sent: false, reason: 'no-recipient', data });
      continue;
    }
    if (data.total === 0) {
      results.push({ actor, sent: false, reason: 'empty-window', data });
      continue;
    }
    const text = renderAlertAuditDigestText(data);
    const html = renderAlertAuditDigestHtml(data);
    const message: EmailMessage = {
      to: recipient,
      from: opts.from ?? env.ALERT_AUDIT_DIGEST_FROM ?? undefined,
      subject: `Empire Dashboard — alert audit digest (actor=${actor}, ${data.totalFires} fire${data.totalFires === 1 ? '' : 's'} / ${data.windowHours}h)`,
      text,
      html,
    };
    const result = await opts.sender.send(message);
    results.push({
      actor,
      sent: true,
      data,
      delivered: result.delivered,
      transport: result.transport,
    });
  }
  return results;
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

/**
 * Alert audit polish 3 (2026-04-27): SMTP adapter for the alert audit digest
 * sender. Mirrors the content-engine `selectDigestSender` pattern: returns a
 * real SMTP-backed `EmailSender` when SMTP_HOST + creds are present;
 * otherwise falls back to the existing stdout `ConsoleEmailSender`. The
 * adapter lazy-requires `nodemailer` so tests that never configure SMTP
 * never load it.
 *
 * Env keys honoured (matching the empire-dashboard SMTP convention used by
 * `email.ts`):
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_SECURE,
 *   SMTP_FROM (envelope sender fallback).
 *
 * If only one of SMTP_USER/SMTP_PASS is provided we treat the env as
 * misconfigured and fall back to console — this mirrors the content-engine
 * factory so a half-configured deploy never silently sends authenticated
 * email with empty creds.
 */
export interface AlertAuditDigestSmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from?: string;
  secure?: boolean;
}

export interface AlertAuditDigestSmtpTransporterLike {
  sendMail(mail: {
    from?: string;
    to: string | string[];
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export interface AlertAuditDigestSmtpSenderOptions {
  config: AlertAuditDigestSmtpConfig;
  transporter?: AlertAuditDigestSmtpTransporterLike;
  transporterFactory?: (
    config: AlertAuditDigestSmtpConfig,
  ) => AlertAuditDigestSmtpTransporterLike;
}

/**
 * Real SMTP-backed `EmailSender` for the alert audit digest. Conforms to the
 * existing `EmailSender` contract so `sendAlertAuditDigest` doesn't need to
 * change. Failures are non-fatal — we log + return `delivered=false` so the
 * caller can decide how to surface them.
 */
export class SmtpAlertAuditDigestSender implements EmailSender {
  private readonly transporter: AlertAuditDigestSmtpTransporterLike;
  private readonly defaultFrom?: string;

  constructor(opts: AlertAuditDigestSmtpSenderOptions) {
    this.defaultFrom = opts.config.from;
    if (opts.transporter) {
      this.transporter = opts.transporter;
      return;
    }
    const factory = opts.transporterFactory ?? defaultAlertAuditDigestSmtpFactory;
    this.transporter = factory(opts.config);
  }

  async send(
    message: EmailMessage,
  ): Promise<{ delivered: boolean; transport: string }> {
    try {
      await this.transporter.sendMail({
        from: message.from ?? this.defaultFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { delivered: true, transport: 'smtp' };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[empire-dashboard] alert-audit digest SMTP send failed:', err);
      return { delivered: false, transport: 'smtp' };
    }
  }
}

function defaultAlertAuditDigestSmtpFactory(
  config: AlertAuditDigestSmtpConfig,
): AlertAuditDigestSmtpTransporterLike {
  // Lazy-require so test runtimes never load nodemailer for the console
  // path — the runtime dep is already declared in package.json (used by
  // src/email.ts too).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer');
  const auth =
    config.user && config.pass ? { user: config.user, pass: config.pass } : undefined;
  const secure = config.secure ?? config.port === 465;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    auth,
  }) as unknown as AlertAuditDigestSmtpTransporterLike;
}

/**
 * Parse SMTP env vars for the alert audit digest. Returns null when host is
 * missing or partial credentials (only one of user/pass set).
 */
export function readAlertAuditDigestSmtpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AlertAuditDigestSmtpConfig | null {
  const host = (env.SMTP_HOST ?? '').trim();
  if (!host) return null;
  const portRaw = env.SMTP_PORT;
  const port = portRaw ? Number(portRaw) : 587;
  const validPort = Number.isFinite(port) && port > 0 ? port : 587;
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS?.trim() || undefined;
  if ((user && !pass) || (!user && pass)) return null;
  const secureRaw = (env.SMTP_SECURE ?? '').trim().toLowerCase();
  let secure: boolean | undefined;
  if (secureRaw === '1' || secureRaw === 'true') secure = true;
  else if (secureRaw === '0' || secureRaw === 'false') secure = false;
  const from = env.SMTP_FROM?.trim() || undefined;
  return { host, port: validPort, user, pass, from, secure };
}

/**
 * Pick the digest transport based on env. SMTP wins when SMTP_HOST + valid
 * creds are present; otherwise we fall back to the stdout
 * `ConsoleEmailSender`. Mirrors `content-engine/src/jobs/rejectionDigestEmail.ts`'s
 * `selectDigestSender` shape so the two empires stay consistent.
 */
export function selectAlertAuditDigestSender(
  env: NodeJS.ProcessEnv = process.env,
  opts: { transporterFactory?: (config: AlertAuditDigestSmtpConfig) => AlertAuditDigestSmtpTransporterLike } = {},
): EmailSender {
  const smtpConfig = readAlertAuditDigestSmtpConfigFromEnv(env);
  if (smtpConfig) {
    return new SmtpAlertAuditDigestSender({
      config: smtpConfig,
      transporterFactory: opts.transporterFactory,
    });
  }
  return new ConsoleEmailSender();
}
