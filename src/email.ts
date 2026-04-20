/**
 * Minimal email interface for Empire Dashboard.
 *
 * Ships two implementations:
 *
 *  - ConsoleEmailSender: logs the message to stdout (default when
 *    EMAIL_DISABLED=1 or no other sender is configured).
 *  - SmtpEmailSender: real SMTP transport backed by `nodemailer`. Selected
 *    automatically when SMTP_HOST is set.
 *
 * Callers must only depend on `EmailSender`.
 */

// nodemailer has no ESM type export we care about; use the default import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import nodemailer from 'nodemailer';

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

/**
 * Minimal shape of the nodemailer transporter we depend on. Keeping it
 * explicit means tests can inject a fake without pulling nodemailer in.
 */
export interface SmtpTransporterLike {
  sendMail(mail: {
    from?: string;
    to: string | string[];
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from?: string;
  secure?: boolean;
}

export interface SmtpEmailSenderOptions {
  config: SmtpConfig;
  /** Optional pre-built transporter (used by tests). */
  transporter?: SmtpTransporterLike;
  /** Optional factory for nodemailer (used by tests to avoid real SMTP). */
  transporterFactory?: (config: SmtpConfig) => SmtpTransporterLike;
}

/**
 * Real SMTP transport. Uses nodemailer under the hood. `SMTP_FROM` is
 * preferred for the envelope sender; callers can still override per-message.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: SmtpTransporterLike;
  private readonly defaultFrom?: string;

  constructor(opts: SmtpEmailSenderOptions) {
    this.defaultFrom = opts.config.from;
    if (opts.transporter) {
      this.transporter = opts.transporter;
      return;
    }
    const factory = opts.transporterFactory ?? defaultTransporterFactory;
    this.transporter = factory(opts.config);
  }

  async send(message: EmailMessage): Promise<{ delivered: boolean; transport: string }> {
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
      console.error('[empire-dashboard] SMTP send failed:', err);
      return { delivered: false, transport: 'smtp' };
    }
  }
}

function defaultTransporterFactory(config: SmtpConfig): SmtpTransporterLike {
  const auth = config.user && config.pass ? { user: config.user, pass: config.pass } : undefined;
  const secure = config.secure ?? config.port === 465;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    auth,
  }) as unknown as SmtpTransporterLike;
}

export interface EmailSenderSelection {
  sender: EmailSender;
  /** Which transport we selected, used for logging on startup. */
  transport: 'console' | 'smtp';
  /** True if email is disabled (stdout-only). */
  disabled: boolean;
}

export interface SelectEmailSenderOptions {
  /** Allows injection of a transporter factory for tests. */
  transporterFactory?: (config: SmtpConfig) => SmtpTransporterLike;
}

/**
 * Pick an email sender based on env vars. SMTP is used when `SMTP_HOST` is
 * set AND email is not explicitly disabled; otherwise we fall back to the
 * stdout `ConsoleEmailSender`.
 */
export function selectEmailSender(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectEmailSenderOptions = {},
): EmailSenderSelection {
  const disabled = env.EMAIL_DISABLED === '1';
  const host = (env.SMTP_HOST ?? '').trim();
  if (!disabled && host) {
    const port = Number(env.SMTP_PORT ?? 587);
    const config: SmtpConfig = {
      host,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    };
    return {
      sender: new SmtpEmailSender({
        config,
        transporterFactory: opts.transporterFactory,
      }),
      transport: 'smtp',
      disabled: false,
    };
  }
  return {
    sender: new ConsoleEmailSender(),
    transport: 'console',
    disabled,
  };
}
