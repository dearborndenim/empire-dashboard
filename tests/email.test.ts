import { ConsoleEmailSender, selectEmailSender } from '../src/email';

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
});
