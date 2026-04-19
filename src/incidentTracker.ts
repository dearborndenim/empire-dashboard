/**
 * Incident tracker — detects green-to-red (service goes down) and
 * red-to-green (service recovers) transitions by comparing the current
 * health result for each app against the previously observed state, and
 * records the resulting incidents in SQLite.
 *
 * Kept stateful in memory for the last observed state per app so we don't
 * need to re-scan the history table on every refresh. Rehydrates from any
 * open incidents on construction, so restarts don't drop a current outage.
 */

import { HealthResult } from './healthChecker';
import { HistoryStore } from './historyStore';

export type IncidentState = 'up' | 'down';

export interface IncidentTransition {
  app: string;
  kind: 'opened' | 'closed';
  at: string;
  reason: string | null;
  durationMin?: number | null;
}

export interface IncidentTrackerOptions {
  store: HistoryStore;
  /**
   * Names of all apps the dashboard monitors. Used to rehydrate open
   * incidents on startup so a restart during a red event doesn't lose the
   * original start time.
   */
  appNames?: string[];
}

/**
 * Summarize a HealthResult into a short reason string for the incident row.
 * Prefers the HTTP status code; falls back to the error message; else
 * returns a generic label.
 */
export function summarizeReason(health: HealthResult): string {
  if (typeof health.statusCode === 'number' && health.statusCode > 0) {
    return `HTTP ${health.statusCode}`;
  }
  if (health.error) return health.error;
  return 'down';
}

export class IncidentTracker {
  private readonly store: HistoryStore;
  private readonly lastState = new Map<string, IncidentState>();

  constructor(opts: IncidentTrackerOptions) {
    this.store = opts.store;
    // If the process restarts while an incident is open, assume the app is
    // still down until proven otherwise. Next "up" sample will close it.
    for (const name of opts.appNames ?? []) {
      const open = this.store.getOpenIncident(name);
      if (open) this.lastState.set(name, 'down');
    }
  }

  /**
   * Process a batch of health results (one per app) and emit transitions.
   * Only two transitions matter:
   *   up  -> down : open incident
   *   down -> up  : close incident
   * Unknown states are treated as "not a transition" — we don't open an
   * incident for `unknown` because a misconfigured URL isn't really an
   * outage.
   */
  processBatch(healths: HealthResult[]): IncidentTransition[] {
    const transitions: IncidentTransition[] = [];
    for (const h of healths) {
      const transition = this.process(h);
      if (transition) transitions.push(transition);
    }
    return transitions;
  }

  process(health: HealthResult): IncidentTransition | null {
    // Ignore unknown state — it's not a real up/down signal.
    if (health.state !== 'up' && health.state !== 'down') {
      return null;
    }
    const current: IncidentState = health.state;
    const previous = this.lastState.get(health.name);
    this.lastState.set(health.name, current);

    if (previous === undefined) {
      // First sample we have ever seen for this app. If it's already down,
      // open an incident; otherwise there is nothing to record.
      if (current === 'down') {
        // Only open if the store doesn't already have an open incident
        // (rehydration handles restart case). This keeps the state machine
        // idempotent across restarts.
        const open = this.store.getOpenIncident(health.name);
        if (open) return null;
        const reason = summarizeReason(health);
        this.store.openIncident(health.name, health.checkedAt, reason);
        return { app: health.name, kind: 'opened', at: health.checkedAt, reason };
      }
      return null;
    }

    if (previous === 'up' && current === 'down') {
      const reason = summarizeReason(health);
      this.store.openIncident(health.name, health.checkedAt, reason);
      return { app: health.name, kind: 'opened', at: health.checkedAt, reason };
    }
    if (previous === 'down' && current === 'up') {
      const closed = this.store.closeIncident(health.name, health.checkedAt);
      return {
        app: health.name,
        kind: 'closed',
        at: health.checkedAt,
        reason: closed?.reason ?? null,
        durationMin: closed?.duration_min ?? null,
      };
    }
    return null;
  }

  /** Test hook: peek at the most recent state the tracker saw for an app. */
  getLastState(appName: string): IncidentState | undefined {
    return this.lastState.get(appName);
  }
}
