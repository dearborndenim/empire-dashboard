import { ConsoleEmailSender, SmtpEmailSender, selectEmailSender, SmtpTransporterLike } from '../src/email';

describe('ConsoleEmailSender', () => {
  it('logs the email body and returns delivered=true', async () => {
    const lines: string[] = [];
    const sender = new ConsoleEmailSender({
      logger: { log: (s: string) => lines.push(s) },
      now: () => new Date('2026-04-18T00:00:00.000Z'),
    });
    const result = await sender.send({
      to: 'rob@dearborndenim.com',
      subject: 'Test',
      text: 'line one\nline two',
    });
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('console');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('rob@dearborndenim.com');
    expect(lines[0]).toContain('Test');
    expect(lines[0]).toContain('    line one');
    expect(lines[0]).toContain('    line two');
    expect(lines[0]).toContain('2026-04-18T00:00:00.000Z');
  });

  it('handles an array of recipients', async () => {
    const lines: string[] = [];
    const sender = new ConsoleEmailSender({ logger: { log: (s: string) => lines.push(s) } });
    await sender.send({ to: ['a@x', 'b@x'], subject: 's', text: 't' });
    expect(lines[0]).toContain('a@x, b@x');
  });

  it('uses the default console logger when none provided', async () => {
    const sender = new ConsoleEmailSender();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = await sender.send({ to: 'rob@x', subject: 's', text: 't' });
      expect(r.delivered).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('selectEmailSender', () => {
  it('returns the console sender and flags disabled=false by default', () => {
    const sel = selectEmailSender({});
    expect(sel.transport).toBe('console');
    expect(sel.disabled).toBe(false);
    expect(typeof sel.sender.send).toBe('function');
  });

  it('flags disabled=true when EMAIL_DISABLED=1', () => {
    const sel = selectEmailSender({ EMAIL_DISABLED: '1' });
    expect(sel.disabled).toBe(true);
  });

  it('selects SMTP when SMTP_HOST is set', () => {
    const fakeTransporter: SmtpTransporterLike = { sendMail: async () => ({}) };
    const sel = selectEmailSender(
      { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'no-reply@x' },
      { transporterFactory: () => fakeTransporter },
    );
    expect(sel.transport).toBe('smtp');
    expect(sel.disabled).toBe(false);
  });

  it('falls back to console when SMTP_HOST is set but EMAIL_DISABLED=1', () => {
    const sel = selectEmailSender({ SMTP_HOST: 'x', EMAIL_DISABLED: '1' });
    expect(sel.transport).toBe('console');
    expect(sel.disabled).toBe(true);
  });

  it('falls back to console when SMTP_HOST is missing', () => {
    const sel = selectEmailSender({ SMTP_USER: 'u', SMTP_PASS: 'p' });
    expect(sel.transport).toBe('console');
  });

  it('normalises a bad SMTP_PORT value to 587', () => {
    const captured: Array<Record<string, unknown>> = [];
    const sel = selectEmailSender(
      { SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'not-a-number' },
      {
        transporterFactory: (cfg) => {
          captured.push(cfg as unknown as Record<string, unknown>);
          return { sendMail: async () => ({}) };
        },
      },
    );
    expect(sel.transport).toBe('smtp');
    expect(captured[0].port).toBe(587);
  });
});

describe('SmtpEmailSender', () => {
  it('delivers via the injected transporter and returns transport=smtp', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fakeTransporter: SmtpTransporterLike = {
      sendMail: async (mail) => {
        captured.push(mail as unknown as Record<string, unknown>);
        return { messageId: 'abc' };
      },
    };
    const sender = new SmtpEmailSender({
      config: { host: 'smtp.example.com', port: 587, from: 'no-reply@x' },
      transporter: fakeTransporter,
    });
    const res = await sender.send({ to: 'rob@x', subject: 'Hi', text: 'body' });
    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('smtp');
    expect(captured).toHaveLength(1);
    expect(captured[0].from).toBe('no-reply@x');
    expect(captured[0].to).toBe('rob@x');
    expect(captured[0].subject).toBe('Hi');
    expect(captured[0].text).toBe('body');
  });

  it('returns delivered=false when the transporter throws', async () => {
    const fakeTransporter: SmtpTransporterLike = {
      sendMail: async () => { throw new Error('network down'); },
    };
    const sender = new SmtpEmailSender({
      config: { host: 'smtp.example.com', port: 587 },
      transporter: fakeTransporter,
    });
    const prev = console.error;
    console.error = () => {};
    try {
      const res = await sender.send({ to: 'r@x', subject: 's', text: 't' });
      expect(res.delivered).toBe(false);
      expect(res.transport).toBe('smtp');
    } finally {
      console.error = prev;
    }
  });

  it('respects message.from when provided', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fakeTransporter: SmtpTransporterLike = {
      sendMail: async (mail) => { captured.push(mail as unknown as Record<string, unknown>); return {}; },
    };
    const sender = new SmtpEmailSender({
      config: { host: 'smtp.example.com', port: 587, from: 'default@x' },
      transporter: fakeTransporter,
    });
    await sender.send({ to: 'r@x', subject: 's', text: 't', from: 'override@x' });
    expect(captured[0].from).toBe('override@x');
  });

  it('uses the factory when no transporter is provided', () => {
    const created: Array<unknown> = [];
    const factory = (cfg: unknown) => {
      created.push(cfg);
      return { sendMail: async () => ({}) };
    };
    new SmtpEmailSender({
      config: { host: 'smtp.example.com', port: 2525 },
      transporterFactory: factory,
    });
    expect(created).toHaveLength(1);
  });
});
