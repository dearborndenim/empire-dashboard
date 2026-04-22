import {
  TeamsAlertSender,
  ConsoleAlertSender,
  NullAlertSender,
  buildTeamsMessageCard,
  selectAlertSender,
  AlertFetchImpl,
  AlertMessage,
} from '../src/alertSender';

function fakeFetch(result: {
  ok?: boolean;
  status?: number;
  throws?: boolean;
  text?: string;
}): {
  impl: AlertFetchImpl;
  calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
  const impl: AlertFetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    if (result.throws) throw new Error('network blowup');
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      text: async () => result.text ?? '',
    };
  };
  return { impl, calls };
}

const baseMessage: AlertMessage = {
  title: 'Kanban webhook success < 80%',
  text: 'Kanban has dipped to 62% over 7d',
  severity: 'warning',
  facts: [
    { name: 'integration', value: 'kanban' },
    { name: 'success_rate_7d', value: '62.0%' },
  ],
  sourceUrl: 'https://dashboard.example/integrations/kanban',
};

describe('buildTeamsMessageCard', () => {
  it('builds a MessageCard with severity color + title + facts', () => {
    const card = buildTeamsMessageCard(baseMessage);
    expect(card['@type']).toBe('MessageCard');
    expect(card.themeColor).toBe('f2c744'); // warning
    expect(card.summary).toBe(baseMessage.title);
    const sections = card.sections as Array<Record<string, unknown>>;
    expect(sections[0].activityTitle).toBe(baseMessage.title);
    expect(sections[0].facts).toEqual([
      { name: 'integration', value: 'kanban' },
      { name: 'success_rate_7d', value: '62.0%' },
    ]);
    const actions = card.potentialAction as Array<Record<string, unknown>>;
    expect(actions[0]['@type']).toBe('OpenUri');
  });

  it('uses red themeColor for critical severity', () => {
    const card = buildTeamsMessageCard({ ...baseMessage, severity: 'critical' });
    expect(card.themeColor).toBe('d83b01');
  });

  it('uses grey themeColor for info severity', () => {
    const card = buildTeamsMessageCard({ ...baseMessage, severity: 'info' });
    expect(card.themeColor).toBe('808080');
  });
});

describe('TeamsAlertSender', () => {
  it('POSTs JSON to the webhook URL and returns delivered=true on 2xx', async () => {
    const fake = fakeFetch({ ok: true, status: 200 });
    const sender = new TeamsAlertSender({
      webhookUrl: 'https://teams.example/webhook',
      fetchImpl: fake.impl,
    });
    const res = await sender.send(baseMessage);
    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('teams');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].headers['content-type']).toBe('application/json');
    const body = JSON.parse(fake.calls[0].body);
    expect(body.title).toBe(baseMessage.title);
    expect(body.themeColor).toBe('f2c744');
  });

  it('signals retryable=true on 5xx responses', async () => {
    const fake = fakeFetch({ ok: false, status: 503, text: 'upstream down' });
    const sender = new TeamsAlertSender({
      webhookUrl: 'https://teams.example/webhook',
      fetchImpl: fake.impl,
    });
    const res = await sender.send(baseMessage);
    expect(res.delivered).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.error).toContain('HTTP 503');
    expect(res.error).toContain('upstream down');
  });

  it('signals retryable=false on 4xx responses', async () => {
    const fake = fakeFetch({ ok: false, status: 404 });
    const sender = new TeamsAlertSender({
      webhookUrl: 'https://teams.example/webhook',
      fetchImpl: fake.impl,
    });
    const res = await sender.send(baseMessage);
    expect(res.delivered).toBe(false);
    expect(res.retryable).toBe(false);
    expect(res.error).toContain('HTTP 404');
  });

  it('signals retryable=true when fetch throws (network error)', async () => {
    const fake = fakeFetch({ throws: true });
    const sender = new TeamsAlertSender({
      webhookUrl: 'https://teams.example/webhook',
      fetchImpl: fake.impl,
    });
    const res = await sender.send(baseMessage);
    expect(res.delivered).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.error).toContain('network blowup');
  });

  it('throws when constructed without a webhook URL', () => {
    expect(
      () => new TeamsAlertSender({ webhookUrl: '' } as unknown as { webhookUrl: string }),
    ).toThrow(/webhookUrl is required/);
  });
});

describe('ConsoleAlertSender', () => {
  it('logs critical alerts via console.error and returns delivered=true', async () => {
    const error = jest.fn();
    const warn = jest.fn();
    const log = jest.fn();
    const sender = new ConsoleAlertSender({ logger: { error, warn, log } });
    const res = await sender.send({
      title: 'DOWN',
      text: 'po-receiver is red',
      severity: 'critical',
    });
    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('console');
    expect(error).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs warning alerts via console.warn', async () => {
    const error = jest.fn();
    const warn = jest.fn();
    const log = jest.fn();
    const sender = new ConsoleAlertSender({ logger: { error, warn, log } });
    await sender.send({ ...baseMessage, severity: 'warning' });
    expect(warn).toHaveBeenCalled();
  });

  it('logs info alerts via console.log', async () => {
    const error = jest.fn();
    const warn = jest.fn();
    const log = jest.fn();
    const sender = new ConsoleAlertSender({ logger: { error, warn, log } });
    await sender.send({ ...baseMessage, severity: 'info' });
    expect(log).toHaveBeenCalled();
  });
});

describe('NullAlertSender', () => {
  it('always returns delivered=true with transport=null', async () => {
    const s = new NullAlertSender();
    const res = await s.send(baseMessage);
    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('null');
  });
});

describe('selectAlertSender', () => {
  it('returns NullAlertSender when ALERTS_DISABLED=1', () => {
    const sel = selectAlertSender({ ALERTS_DISABLED: '1' });
    expect(sel.disabled).toBe(true);
    expect(sel.transport).toBe('null');
  });

  it('returns TeamsAlertSender when TEAMS_WEBHOOK_URL is set', () => {
    const sel = selectAlertSender({ TEAMS_WEBHOOK_URL: 'https://teams.example/x' });
    expect(sel.transport).toBe('teams');
    expect(sel.disabled).toBe(false);
  });

  it('falls back to ConsoleAlertSender when no env vars set', () => {
    const sel = selectAlertSender({});
    expect(sel.transport).toBe('console');
    expect(sel.disabled).toBe(false);
  });
});
