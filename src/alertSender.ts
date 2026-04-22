/**
 * Unified alert-sender interface, aligned with the pattern used by the
 * purchase-order-receiver dead-letter spike alerting. The dashboard emits
 * alerts for integration success-rate dips (Task 1.2) and — in the future —
 * any other cross-app signals.
 *
 * Shipping three implementations:
 *
 *   - TeamsAlertSender: posts to an Microsoft Teams incoming webhook URL.
 *     Signals retryable on 5xx / network errors so callers can decide to
 *     retry or queue.
 *   - ConsoleAlertSender: logs to stdout. Always "delivered" from the caller's
 *     perspective — the message is at least recorded to Railway logs.
 *   - NullAlertSender: drop-all fallback for unit tests / disabled env.
 *
 * Callers depend only on `AlertSender`.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertMessage {
  /** Short human title, rendered bold in Teams. */
  title: string;
  /** Body text. Markdown-ish. Plain strings work fine. */
  text: string;
  severity: AlertSeverity;
  /** Optional key/value facts to render under the body. */
  facts?: Array<{ name: string; value: string }>;
  /** Optional source URL the alert should link to. */
  sourceUrl?: string;
}

export interface AlertSendResult {
  delivered: boolean;
  transport: string;
  /**
   * True when the failure looks like it would succeed on retry — 5xx, network
   * errors, timeouts. False for 4xx / bad-config failures which will keep
   * failing until fixed.
   */
  retryable?: boolean;
  error?: string;
}

export interface AlertSender {
  send(message: AlertMessage): Promise<AlertSendResult>;
}

/**
 * Minimal fetch shape. Matches what the integration tiles already use, so
 * we can share fetchImpl across the dashboard.
 */
export interface AlertFetchImpl {
  (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{
    ok: boolean;
    status: number;
    text?: () => Promise<string>;
  }>;
}

export interface TeamsAlertSenderOptions {
  webhookUrl: string;
  fetchImpl?: AlertFetchImpl;
  /** Retry is the caller's problem — but we signal retryability in the result. */
  timeoutMs?: number;
}

/**
 * Post an AlertMessage to a Microsoft Teams incoming webhook URL.
 *
 * Teams' incoming-webhook payloads use the (legacy) MessageCard schema.
 * We encode the severity into `themeColor`:
 *   info     -> grey
 *   warning  -> yellow
 *   critical -> red
 */
export class TeamsAlertSender implements AlertSender {
  private readonly webhookUrl: string;
  private readonly fetchImpl: AlertFetchImpl;

  constructor(opts: TeamsAlertSenderOptions) {
    if (!opts.webhookUrl) {
      throw new Error('TeamsAlertSender: webhookUrl is required');
    }
    this.webhookUrl = opts.webhookUrl;
    this.fetchImpl = opts.fetchImpl ?? defaultAlertFetchImpl;
  }

  async send(message: AlertMessage): Promise<AlertSendResult> {
    const payload = buildTeamsMessageCard(message);
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        return { delivered: true, transport: 'teams' };
      }
      const retryable = res.status >= 500 && res.status < 600;
      const text = res.text ? await res.text().catch(() => '') : '';
      return {
        delivered: false,
        transport: 'teams',
        retryable,
        error: `HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      };
    } catch (err) {
      // Network, DNS, timeouts — treat as retryable.
      return {
        delivered: false,
        transport: 'teams',
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

const defaultAlertFetchImpl: AlertFetchImpl = async (url, init) => {
  const res = await (globalThis as unknown as {
    fetch: (u: string, i: unknown) => Promise<{
      ok: boolean;
      status: number;
      text(): Promise<string>;
    }>;
  }).fetch(url, init);
  return res;
};

export function buildTeamsMessageCard(message: AlertMessage): Record<string, unknown> {
  const themeColor = severityColor(message.severity);
  const facts = (message.facts ?? []).map((f) => ({ name: f.name, value: f.value }));
  const sections: Array<Record<string, unknown>> = [];
  sections.push({
    activityTitle: message.title,
    text: message.text,
    facts: facts.length > 0 ? facts : undefined,
  });
  const card: Record<string, unknown> = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor,
    summary: message.title,
    title: message.title,
    sections,
  };
  if (message.sourceUrl) {
    card.potentialAction = [
      {
        '@type': 'OpenUri',
        name: 'Open',
        targets: [{ os: 'default', uri: message.sourceUrl }],
      },
    ];
  }
  return card;
}

function severityColor(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical':
      return 'd83b01'; // red
    case 'warning':
      return 'f2c744'; // amber
    case 'info':
    default:
      return '808080';
  }
}

export interface ConsoleAlertSenderOptions {
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => Date;
}

/**
 * Prints the alert to stdout/stderr. Used as the fallback when no Teams
 * webhook is configured — Robert can still see the alert in Railway logs.
 */
export class ConsoleAlertSender implements AlertSender {
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => Date;

  constructor(opts: ConsoleAlertSenderOptions = {}) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
  }

  async send(message: AlertMessage): Promise<AlertSendResult> {
    const ts = this.now().toISOString();
    const factsStr = (message.facts ?? [])
      .map((f) => `    ${f.name}: ${f.value}`)
      .join('\n');
    const lines = [
      `[empire-dashboard] ALERT ${message.severity.toUpperCase()} @ ${ts}`,
      `  title: ${message.title}`,
      `  body:  ${message.text}`,
    ];
    if (factsStr) lines.push('  facts:\n' + factsStr);
    if (message.sourceUrl) lines.push(`  link: ${message.sourceUrl}`);
    const rendered = lines.join('\n');
    if (message.severity === 'critical') this.logger.error(rendered);
    else if (message.severity === 'warning') this.logger.warn(rendered);
    else this.logger.log(rendered);
    return { delivered: true, transport: 'console' };
  }
}

/** Drops everything. Used when alerts are explicitly disabled. */
export class NullAlertSender implements AlertSender {
  async send(_message: AlertMessage): Promise<AlertSendResult> {
    return { delivered: true, transport: 'null' };
  }
}

export interface SelectAlertSenderOptions {
  fetchImpl?: AlertFetchImpl;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface AlertSenderSelection {
  sender: AlertSender;
  transport: 'teams' | 'console' | 'null';
  disabled: boolean;
}

/**
 * Pick an AlertSender based on env vars:
 *   - `ALERTS_DISABLED=1` -> null sender
 *   - `TEAMS_WEBHOOK_URL` set -> Teams
 *   - otherwise -> console
 */
export function selectAlertSender(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectAlertSenderOptions = {},
): AlertSenderSelection {
  const disabled = env.ALERTS_DISABLED === '1';
  if (disabled) {
    return { sender: new NullAlertSender(), transport: 'null', disabled: true };
  }
  const webhook = (env.TEAMS_WEBHOOK_URL ?? '').trim();
  if (webhook) {
    return {
      sender: new TeamsAlertSender({ webhookUrl: webhook, fetchImpl: opts.fetchImpl }),
      transport: 'teams',
      disabled: false,
    };
  }
  return {
    sender: new ConsoleAlertSender({ logger: opts.logger }),
    transport: 'console',
    disabled: false,
  };
}
