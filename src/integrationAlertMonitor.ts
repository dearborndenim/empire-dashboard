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
  /**
   * Phase 4: once the 7-day rate climbs back *above* this value (having been
   * below `threshold` at some earlier point), fire a recovery message and
   * auto-close the synthetic incident. Default 0.90 (90%).
   */
  recoveryThreshold?: number;
  /**
   * Phase 4: minimum interval between alert fires for the same integration,
   * in milliseconds. Independent of the per-day dedupe (which already blocks
   * repeat fires within the same UTC day). Default 1 hour.
   */
  cooldownMs?: number;
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

export interface IntegrationAlertRecovery {
  integration: string;
  successRate: number;
  windowDays: number;
  recoveryThreshold: number;
  /** Synthetic incident id that was closed (null when no incident was open). */
  incidentClosed: number | null;
  alertDelivered: boolean;
  alertTransport: string;
}

export interface IntegrationAlertResult {
  fired: IntegrationAlertFiring[];
  skipped: Array<{ integration: string; reason: string }>;
  recovered: IntegrationAlertRecovery[];
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
  private readonly recoveryThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowDays: number;
  private readonly incidentAppPrefix: string;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly integrations: string[];

  constructor(opts: IntegrationAlertMonitorOptions) {
    this.store = opts.store;
    this.alertSender = opts.alertSender;
    this.threshold = opts.threshold ?? 0.8;
    this.recoveryThreshold = opts.recoveryThreshold ?? 0.9;
    this.cooldownMs = opts.cooldownMs ?? 60 * 60 * 1000;
    this.windowDays = opts.windowDays ?? 7;
    this.incidentAppPrefix = opts.incidentAppPrefix ?? 'integration:';
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? console;
    this.integrations = opts.integrations && opts.integrations.length > 0
      ? opts.integrations
      : [...DEFAULT_INTEGRATIONS];
  }

  async check(): Promise<IntegrationAlertResult> {
    const result: IntegrationAlertResult = { fired: [], skipped: [], recovered: [] };
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
        // Phase 4 recovery path: when the rate has climbed back above the
        // recovery threshold AND there's an open synthetic incident for this
        // integration, it means we previously alerted and are now healthy.
        // Post an info-severity recovery alert and auto-close the incident.
        // The close guarantees exactly-once-per-transition because subsequent
        // checks will find no open incident.
        if (rate >= this.recoveryThreshold) {
          const recovery = await this.maybeRecover(integration, rate, nowMs);
          if (recovery) {
            result.recovered.push(recovery);
            continue;
          }
        }
        result.skipped.push({
          integration,
          reason: `rate=${(rate * 100).toFixed(1)}% >= threshold`,
        });
        continue;
      }

      // Below threshold. Per-day dedupe check (legacy behavior, preserved).
      if (this.store.hasIntegrationAlerted(integration, today)) {
        // Refresh the cooldown stamp so subsequent polls inside the hour still
        // see the most recent would-have-fired timestamp.
        this.safeTouchAlert(integration, today, new Date(nowMs).toISOString());
        result.skipped.push({ integration, reason: 'already alerted today' });
        continue;
      }

      // Per-hour cooldown check (Phase 4) — blocks a re-fire even across UTC
      // day boundaries (e.g. 23:30 yesterday, 00:15 today).
      const lastFiredAtIso = this.safeGetMostRecentAlertTs(integration);
      if (lastFiredAtIso) {
        const lastFiredMs = Date.parse(lastFiredAtIso);
        if (Number.isFinite(lastFiredMs) && nowMs - lastFiredMs < this.cooldownMs) {
          const minsLeft = Math.ceil(
            (this.cooldownMs - (nowMs - lastFiredMs)) / 60000,
          );
          result.skipped.push({
            integration,
            reason: `cooldown (fires again in ~${minsLeft}m)`,
          });
          continue;
        }
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

      // Dedupe + cooldown row.
      try {
        const nowIso = new Date(nowMs).toISOString();
        this.store.recordIntegrationAlert({
          integration_name: integration,
          date: today,
          success_rate: rate,
          alerted_at: nowIso,
          last_fired_at: nowIso,
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

  /**
   * Attempt a recovery transition for `integration`. Only fires when there is
   * an open synthetic incident (meaning we previously alerted and haven't
   * recovered yet). Returns the recovery record, or null when the integration
   * was never degraded (no open incident).
   */
  private async maybeRecover(
    integration: string,
    rate: number,
    nowMs: number,
  ): Promise<IntegrationAlertRecovery | null> {
    const incidentApp = `${this.incidentAppPrefix}${integration}`;
    let openIncident = null as ReturnType<HistoryStore['getOpenIncident']>;
    try {
      openIncident = this.store.getOpenIncident(incidentApp);
    } catch (err) {
      this.logger.error(
        `[empire-dashboard] integration recovery getOpenIncident failed for ${integration}:`,
        err,
      );
      return null;
    }
    if (!openIncident) {
      return null;
    }

    const ratePct = `${(rate * 100).toFixed(1)}%`;
    const recPct = `${(this.recoveryThreshold * 100).toFixed(0)}%`;
    const title = `${integration} webhook success recovered above ${recPct}`;
    const msgText = `${integration} is back to ${ratePct} over the last ${this.windowDays} days (recovery threshold ${recPct}). Auto-closing the synthetic incident.`;

    let alertResult: { delivered: boolean; transport: string } = {
      delivered: false,
      transport: 'error',
    };
    try {
      const res = await this.alertSender.send({
        title,
        text: msgText,
        severity: 'info',
        facts: [
          { name: 'integration', value: integration },
          { name: `${this.windowDays}d success`, value: ratePct },
          { name: 'recovery threshold', value: recPct },
        ],
      });
      alertResult = { delivered: res.delivered, transport: res.transport };
      if (!res.delivered) {
        this.logger.error(
          `[empire-dashboard] integration recovery send failed for ${integration}: ${res.error}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[empire-dashboard] integration recovery threw for ${integration}:`,
        err,
      );
    }

    let closedIncidentId: number | null = null;
    try {
      const closed = this.store.closeIncident(
        incidentApp,
        new Date(nowMs).toISOString(),
      );
      closedIncidentId = closed?.id ?? openIncident.id;
    } catch (err) {
      this.logger.error(
        `[empire-dashboard] integration recovery close-incident failed for ${integration}:`,
        err,
      );
      closedIncidentId = openIncident.id;
    }

    return {
      integration,
      successRate: rate,
      windowDays: this.windowDays,
      recoveryThreshold: this.recoveryThreshold,
      incidentClosed: closedIncidentId,
      alertDelivered: alertResult.delivered,
      alertTransport: alertResult.transport,
    };
  }

  private safeGetMostRecentAlertTs(integration: string): string | null {
    const fn = this.store.getMostRecentIntegrationAlert;
    if (typeof fn !== 'function') return null;
    try {
      return this.store.getMostRecentIntegrationAlert(integration);
    } catch (err) {
      this.logger.error(
        `[empire-dashboard] integration cooldown read failed for ${integration}:`,
        err,
      );
      return null;
    }
  }

  private safeTouchAlert(
    integration: string,
    date: string,
    firedAtIso: string,
  ): void {
    const fn = this.store.touchIntegrationAlert;
    if (typeof fn !== 'function') return;
    try {
      this.store.touchIntegrationAlert(integration, date, firedAtIso);
    } catch (err) {
      this.logger.error(
        `[empire-dashboard] integration cooldown touch failed for ${integration}:`,
        err,
      );
    }
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
