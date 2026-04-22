/**
 * Watches the persisted 7-day integration success-rate history (written daily
 * by `snapshotIntegrationStats`) and fires an alert whenever any integration
 * dips below a threshold.
 *
 * Alert pipeline (per integration):
 *  1. Check dedupe: has the integration already alerted today? If so, skip.
 *  2. Post the alert via AlertSender (Teams / console fallback).
 *  3. Log a synthetic incident so the MTBF/MTTR math + audit view pick it up.
 *  4. Persist an `integration_alert_state` row so we don't re-fire today.
 *
 * This mirrors the PO receiver dead-letter spike alert pattern so future
 * services can reuse the shape cleanly.
 */

import { HistoryStore } from './historyStore';
import { AlertSender } from './alertSender';

export interface IntegrationAlertMonitorOptions {
  store: HistoryStore;
  alertSender: AlertSender;
  /** 7-day rate threshold below which to alert. Default 0.80 (80%). */
  threshold?: number;
  /** Window for the rolling success rate, in days. Default 7. */
  windowDays?: number;
  /** Prefix used for the synthetic incident app_name. */
  incidentAppPrefix?: string;
  /** Injected now (ms) for tests. */
  now?: () => number;
  /** Injected logger for tests / headless runs. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Optional list of integration IDs to check; when empty, auto-discovered. */
  integrations?: string[];
}

export interface IntegrationAlertFiring {
  integration: string;
  successRate: number;
  windowDays: number;
  threshold: number;
  incidentId: number | null;
  alertDelivered: boolean;
  alertTransport: string;
  dedupeDate: string;
}

export interface IntegrationAlertResult {
  fired: IntegrationAlertFiring[];
  skipped: Array<{ integration: string; reason: string }>;
}

const DEFAULT_INTEGRATIONS = ['po-receiver', 'kanban', 'content-engine'];

/**
 * Monitor persisted stats and emit alerts. Idempotent per day.
 *
 * The caller typically wires this into a scheduler (e.g. every poll cycle
 * right after the daily snapshot), but it can also be invoked from a CLI
 * or test harness directly.
 */
export class IntegrationAlertMonitor {
  private readonly store: HistoryStore;
  private readonly alertSender: AlertSender;
  private readonly threshold: number;
  private readonly windowDays: number;
  private readonly incidentAppPrefix: string;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly integrations: string[];

  constructor(opts: IntegrationAlertMonitorOptions) {
    this.store = opts.store;
    this.alertSender = opts.alertSender;
    this.threshold = opts.threshold ?? 0.8;
    this.windowDays = opts.windowDays ?? 7;
    this.incidentAppPrefix = opts.incidentAppPrefix ?? 'integration:';
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? console;
    this.integrations = opts.integrations && opts.integrations.length > 0
      ? opts.integrations
      : [...DEFAULT_INTEGRATIONS];
  }

  async check(): Promise<IntegrationAlertResult> {
    const result: IntegrationAlertResult = { fired: [], skipped: [] };
    const nowMs = this.now();
    const today = toUtcDate(nowMs);

    for (const integration of this.integrations) {
      const stats = this.store.listIntegrationStats(integration, this.windowDays, nowMs);
      if (stats.length === 0) {
        result.skipped.push({ integration, reason: 'no stats recorded' });
        continue;
      }
      const totalAttempts = stats.reduce((a, r) => a + r.total_attempts, 0);
      if (totalAttempts === 0) {
        result.skipped.push({ integration, reason: 'zero attempts in window' });
        continue;
      }
      // Weight each day's success_rate by its total_attempts for a
      // traffic-weighted 7d success rate.
      const weightedSuccesses = stats.reduce(
        (a, r) => a + r.success_rate * r.total_attempts,
        0,
      );
      const rate = weightedSuccesses / totalAttempts;
      if (rate >= this.threshold) {
        result.skipped.push({
          integration,
          reason: `rate=${(rate * 100).toFixed(1)}% >= threshold`,
        });
        continue;
      }
      // Below threshold. Dedupe check.
      if (this.store.hasIntegrationAlerted(integration, today)) {
        result.skipped.push({ integration, reason: 'already alerted today' });
        continue;
      }

      // Fire the alert.
      const title = `${integration} webhook success below ${(this.threshold * 100).toFixed(0)}%`;
      const ratePct = `${(rate * 100).toFixed(1)}%`;
      const threshPct = `${(this.threshold * 100).toFixed(0)}%`;
      const msgText = `${integration} has dropped to ${ratePct} over the last ${this.windowDays} days (threshold ${threshPct}).`;
      const severity = rate < this.threshold * 0.625 ? 'critical' : 'warning';
      let alertResult: { delivered: boolean; transport: string };
      try {
        const res = await this.alertSender.send({
          title,
          text: msgText,
          severity,
          facts: [
            { name: 'integration', value: integration },
            { name: `${this.windowDays}d success`, value: ratePct },
            { name: 'threshold', value: threshPct },
            { name: 'total_attempts', value: String(totalAttempts) },
          ],
        });
        alertResult = { delivered: res.delivered, transport: res.transport };
        if (!res.delivered) {
          this.logger.error(
            `[empire-dashboard] integration alert send failed for ${integration}: ${res.error}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[empire-dashboard] integration alert threw for ${integration}:`,
          err,
        );
        alertResult = { delivered: false, transport: 'error' };
      }

      // Log synthetic incident.
      let incidentId: number | null = null;
      const incidentApp = `${this.incidentAppPrefix}${integration}`;
      try {
        const existing = this.store.getOpenIncident(incidentApp);
        if (existing) {
          incidentId = existing.id;
        } else {
          incidentId = this.store.openIncident(
            incidentApp,
            new Date(nowMs).toISOString(),
            `${this.windowDays}d success-rate ${ratePct} < ${threshPct}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[empire-dashboard] integration alert incident log failed for ${integration}:`,
          err,
        );
      }

      // Dedupe row.
      try {
        this.store.recordIntegrationAlert({
          integration_name: integration,
          date: today,
          success_rate: rate,
          alerted_at: new Date(nowMs).toISOString(),
        });
      } catch (err) {
        this.logger.error(
          `[empire-dashboard] integration alert dedupe write failed for ${integration}:`,
          err,
        );
      }

      result.fired.push({
        integration,
        successRate: rate,
        windowDays: this.windowDays,
        threshold: this.threshold,
        incidentId,
        alertDelivered: alertResult.delivered,
        alertTransport: alertResult.transport,
        dedupeDate: today,
      });
    }

    return result;
  }
}

/** YYYY-MM-DD in UTC. */
function toUtcDate(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
