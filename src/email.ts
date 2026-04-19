/**
 * Minimal email interface for Empire Dashboard.
 *
 * The dashboard doesn't have SMTP wired up yet — rather than pull in
 * nodemailer and force Robert to configure SMTP creds, we define a small
 * `EmailSender` interface and ship two implementations:
 *
 *  - ConsoleEmailSender: logs the message to stdout (default when
 *    EMAIL_DISABLED=1 or no other sender is configured)
 *  - A future SMTP sender can implement the same interface without any
 *    caller changes.
 *
 * Callers must only depend on `EmailSender`.
 */

export interface EmailMessage {
  to: string | string[];
  from?: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ delivered: boolean; transport: string }>;
}

export interface ConsoleEmailSenderOptions {
  logger?: Pick<Console, 'log'>;
  now?: () => Date;
}

/**
 * Logs the email to stdout. Used when EMAIL_DISABLED=1 or no SMTP env vars
 * are present. Treated as "delivered" for the caller's purposes because the
 * message has been recorded somewhere Robert can find it (Railway logs).
 */
export class ConsoleEmailSender implements EmailSender {
  private readonly logger: Pick<Console, 'log'>;
  private readonly now: () => Date;

  constructor(opts: ConsoleEmailSenderOptions = {}) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
  }

  async send(message: EmailMessage): Promise<{ delivered: boolean; transport: string }> {
    const ts = this.now().toISOString();
    const toStr = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    this.logger.log(
      `[empire-dashboard] email (stub) @ ${ts}\n  to:      ${toStr}\n  subject: ${message.subject}\n  body:\n${indent(message.text, '    ')}`,
    );
    return { delivered: true, transport: 'console' };
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export interface EmailSenderSelection {
  sender: EmailSender;
  /** Which transport we selected, used for logging on startup. */
  transport: 'console';
  /** True if email is disabled (stdout-only). */
  disabled: boolean;
}

/**
 * Pick an email sender based on env vars. Today we only support the stdout
 * stub; SMTP is a TODO. Returns metadata so the index.ts can log which
 * transport is being used.
 */
export function selectEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSenderSelection {
  const disabled = env.EMAIL_DISABLED === '1';
  return {
    sender: new ConsoleEmailSender(),
    transport: 'console',
    disabled,
  };
}
