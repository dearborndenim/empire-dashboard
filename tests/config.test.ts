import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_APPS,
  buildAppList,
  loadAppsFromFile,
  loadConfig,
  parseUrlOverrides,
} from '../src/config';

describe('parseUrlOverrides', () => {
  it('returns empty object when input is missing', () => {
    expect(parseUrlOverrides(undefined)).toEqual({});
    expect(parseUrlOverrides('')).toEqual({});
  });

  it('parses a valid JSON object', () => {
    expect(parseUrlOverrides('{"a":"https://a","b":"https://b"}')).toEqual({
      a: 'https://a',
      b: 'https://b',
    });
  });

  it('filters out non-string values', () => {
    expect(parseUrlOverrides('{"a":"x","b":3}')).toEqual({ a: 'x' });
  });

  it('returns empty on malformed JSON', () => {
    expect(parseUrlOverrides('not json')).toEqual({});
  });

  it('returns empty when JSON is an array', () => {
    expect(parseUrlOverrides('[1,2,3]')).toEqual({});
  });
});

describe('buildAppList', () => {
  it('applies url overrides by name', () => {
    const result = buildAppList(
      [
        { name: 'A', repo: 'x/a' },
        { name: 'B', repo: 'x/b', url: 'https://old' },
      ],
      { A: 'https://new-a', B: 'https://new-b' },
    );
    expect(result).toEqual([
      { name: 'A', repo: 'x/a', url: 'https://new-a' },
      { name: 'B', repo: 'x/b', url: 'https://new-b' },
    ]);
  });

  it('preserves existing url when no override present', () => {
    const result = buildAppList([{ name: 'A', repo: 'x/a', url: 'https://keep' }], {});
    expect(result[0].url).toBe('https://keep');
  });
});

describe('loadAppsFromFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empire-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads a valid apps file', () => {
    const p = path.join(tmp, 'apps.json');
    fs.writeFileSync(p, JSON.stringify([{ name: 'Foo', repo: 'o/foo' }]));
    expect(loadAppsFromFile(p)).toEqual([{ name: 'Foo', repo: 'o/foo' }]);
  });

  it('throws on non-array input', () => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, JSON.stringify({ not: 'array' }));
    expect(() => loadAppsFromFile(p)).toThrow(/array/);
  });

  it('throws on missing name or repo', () => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, JSON.stringify([{ name: 'only-name' }]));
    expect(() => loadAppsFromFile(p)).toThrow(/missing/);
  });
});

describe('loadConfig', () => {
  it('uses defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(3000);
    expect(cfg.githubOwner).toBe('dearborndenim');
    expect(cfg.healthCacheTtlSec).toBe(60);
    expect(cfg.healthTimeoutMs).toBe(5000);
    expect(cfg.pollIntervalMs).toBe(300000);
    expect(cfg.apps.length).toBe(DEFAULT_APPS.length);
  });

  it('applies overrides', () => {
    const cfg = loadConfig({
      PORT: '4000',
      GITHUB_TOKEN: 'tok',
      GITHUB_OWNER: 'acme',
      HEALTH_CACHE_TTL: '30',
      HEALTH_TIMEOUT_MS: '1500',
      POLL_INTERVAL_MS: '60000',
      APPS_URL_OVERRIDES: '{"McSecretary":"https://x.up.railway.app"}',
    });
    expect(cfg.port).toBe(4000);
    expect(cfg.githubToken).toBe('tok');
    expect(cfg.githubOwner).toBe('acme');
    expect(cfg.healthCacheTtlSec).toBe(30);
    expect(cfg.healthTimeoutMs).toBe(1500);
    expect(cfg.pollIntervalMs).toBe(60000);
    const ms = cfg.apps.find((a) => a.name === 'McSecretary');
    expect(ms?.url).toBe('https://x.up.railway.app');
  });

  it('loads apps from a file path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empire-'));
    const p = path.join(tmp, 'apps.json');
    fs.writeFileSync(p, JSON.stringify([{ name: 'One', repo: 'o/one' }]));
    try {
      const cfg = loadConfig({ APPS_CONFIG_PATH: p });
      expect(cfg.apps).toEqual([
        { name: 'One', repo: 'o/one', url: undefined, railwayLogsUrl: undefined },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defaults history db path + retention', () => {
    const cfg = loadConfig({});
    expect(cfg.historyDbPath).toBe('./data/history.db');
    expect(cfg.historyRetentionDays).toBe(7);
  });

  it('applies history env overrides', () => {
    const cfg = loadConfig({ HISTORY_DB_PATH: '/tmp/h.db', HISTORY_RETENTION_DAYS: '14' });
    expect(cfg.historyDbPath).toBe('/tmp/h.db');
    expect(cfg.historyRetentionDays).toBe(14);
  });

  it('applies APPS_RAILWAY_LOGS_OVERRIDES', () => {
    const cfg = loadConfig({
      APPS_RAILWAY_LOGS_OVERRIDES: '{"McSecretary":"https://railway.com/project/abc/service/def"}',
    });
    const ms = cfg.apps.find((a) => a.name === 'McSecretary');
    expect(ms?.railwayLogsUrl).toBe('https://railway.com/project/abc/service/def');
  });
});

describe('buildAppList railway logs overrides', () => {
  it('applies railwayLogsUrl from overrides', () => {
    const result = buildAppList(
      [{ name: 'A', repo: 'x/a' }],
      {},
      { A: 'https://railway.com/project/p/service/s' },
    );
    expect(result[0].railwayLogsUrl).toBe('https://railway.com/project/p/service/s');
  });

  it('preserves existing railwayLogsUrl when not overridden', () => {
    const result = buildAppList(
      [{ name: 'A', repo: 'x/a', railwayLogsUrl: 'https://keep' }],
      {},
      {},
    );
    expect(result[0].railwayLogsUrl).toBe('https://keep');
  });
});
