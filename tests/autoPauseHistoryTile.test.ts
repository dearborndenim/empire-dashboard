import {
  IntegrationTilesFetcher,
  IntegrationFetchImpl,
  buildAutoPauseSparkline,
} from '../src/integrationTiles';
import { renderDashboard } from '../src/render';
import { AppStatus } from '../src/status';

/**
 * Auto-pause history tile (2026-04-29). The empire-dashboard reads
 * content-engine's `GET /api/integration/strict-mode-auto-pause-history?days=1`
 * endpoint and renders a 24-bucket per-hour sparkline of paused/resumed
 * transitions on the homepage.
 *
 * State machine:
 *   ok       — zero `paused` events in 24h.
 *   warn     — at least one `paused` event AND latest is followed by a
 *              `resumed` (i.e. recovered).
 *   critical — currently paused (latest event is paused with no later
 *              resumed, OR lastResumedAt is null with lastPausedAt set).
 *
 * Click-through: tile carries an `href` that points at
 * `/alerts/audit?integration=content-engine&decision=fire&days=7`.
 *
 * XSS: tile renders defensively — reasons returned by the upstream are
 * never rendered raw (we only surface paused/resumed counts + ISO
 * timestamps, never the upstream `reason` field).
 */

function fakeFetch(byUrl: Record<string, {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: boolean;
}>): { impl: IntegrationFetchImpl } {
  const impl: IntegrationFetchImpl = async (url) => {
    const match = byUrl[url];
    if (!match) throw new Error(`unexpected url ${url}`);
    if (match.throws) throw new Error('network');
    return {
      ok: match.ok ?? true,
      status: match.status ?? 200,
      json: async () => match.body ?? {},
    };
  };
  return { impl };
}

const now = Date.parse('2026-04-29T12:00:00Z');

const baseStatus: AppStatus[] = [
  {
    name: 'App One',
    repo: 'o/one',
    color: 'green',
    summary: 'Up',
    health: { name: 'App One', state: 'up', checkedAt: 'x' },
    activity: { name: 'App One', repo: 'o/one' },
  },
];

const PROMPT_QUALITY_URL = 'https://ce/api/integration/prompt-quality-stats';
const SCENE_DRIFT_URL = 'https://ce/api/integration/scene-drift';
const AUTO_PAUSE_URL = 'https://ce/api/integration/strict-mode-auto-pause-history?days=1';

describe('auto-pause history tile — state machine', () => {
  it('renders state=ok with zero pauses when events array is empty', async () => {
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: { body: { days: 1, events: [] } },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history');
    expect(tile).toBeDefined();
    expect(tile!.state).toBe('ok');
    expect(tile!.summary).toMatch(/no pauses/i);
    expect(tile!.autoPauseSparkline).toBeDefined();
    expect(tile!.autoPauseSparkline!.points).toHaveLength(24);
    expect(tile!.autoPauseSparkline!.totalPauses).toBe(0);
    expect(tile!.autoPauseSparkline!.lastPausedAt).toBeNull();
    expect(tile!.autoPauseSparkline!.lastResumedAt).toBeNull();
    expect(tile!.autoPauseSparkline!.currentlyPaused).toBe(false);
  });

  it('renders state=warn when paused was followed by resumed (recovered)', async () => {
    const pausedTs = now - 4 * 60 * 60 * 1000; // 4h ago
    const resumedTs = now - 1 * 60 * 60 * 1000; // 1h ago
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: {
        body: {
          days: 1,
          events: [
            { ts_ms: resumedTs, transition: 'resumed', reason: 'recovery' },
            { ts_ms: pausedTs, transition: 'paused', reason: 'chronic_threshold' },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    expect(tile.state).toBe('warn');
    expect(tile.autoPauseSparkline!.totalPauses).toBe(1);
    expect(tile.autoPauseSparkline!.lastPausedAt).toBe(new Date(pausedTs).toISOString());
    expect(tile.autoPauseSparkline!.lastResumedAt).toBe(new Date(resumedTs).toISOString());
    expect(tile.autoPauseSparkline!.currentlyPaused).toBe(false);
    expect(tile.summary).toMatch(/1 pause in 24h/i);
    expect(tile.summary).toMatch(/resumed/i);
  });

  it('renders state=critical when currently paused (paused after resumed)', async () => {
    const earlyResumedTs = now - 5 * 60 * 60 * 1000;
    const earlyPausedTs = now - 6 * 60 * 60 * 1000;
    const latestPausedTs = now - 30 * 60 * 1000; // 30 min ago
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: {
        body: {
          days: 1,
          events: [
            { ts_ms: latestPausedTs, transition: 'paused', reason: 'chronic_threshold' },
            { ts_ms: earlyResumedTs, transition: 'resumed', reason: 'recovery' },
            { ts_ms: earlyPausedTs, transition: 'paused', reason: 'chronic_threshold' },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    expect(tile.state).toBe('critical');
    expect(tile.autoPauseSparkline!.totalPauses).toBe(2);
    expect(tile.autoPauseSparkline!.currentlyPaused).toBe(true);
    expect(tile.summary).toMatch(/paused now/i);
  });

  it('renders state=critical when paused has no resumed at all', async () => {
    const pausedTs = now - 90 * 60 * 1000; // 1.5h ago
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: {
        body: {
          days: 1,
          events: [
            { ts_ms: pausedTs, transition: 'paused', reason: 'chronic_threshold' },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    expect(tile.state).toBe('critical');
    expect(tile.autoPauseSparkline!.lastResumedAt).toBeNull();
    expect(tile.autoPauseSparkline!.currentlyPaused).toBe(true);
  });
});

describe('auto-pause history tile — config + fallback', () => {
  it('renders state=not-configured when content-engine env vars are unset', async () => {
    const fake = fakeFetch({
      'https://po/api/integration/webhook-status': { body: {} },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: {
        poReceiverUrl: 'https://po',
        poReceiverApiKey: 'pk',
        // contentEngineUrl + contentEngineApiKey omitted
      },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    expect(tile.state).toBe('not-configured');
    expect(tile.autoPauseSparkline).toBeUndefined();
  });

  it('renders state=error on HTTP non-2xx without crashing', async () => {
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: { ok: false, status: 503 },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    expect(tile.state).toBe('error');
    expect(tile.error).toMatch(/HTTP 503/);
  });

  it('drops events with unknown transitions (forward-compat) and future-dated events', async () => {
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: {
        body: {
          days: 1,
          events: [
            { ts_ms: now + 60_000, transition: 'paused', reason: null }, // future
            { ts_ms: now - 30 * 60_000, transition: 'mystery', reason: null }, // unknown
            { ts_ms: now - 45 * 60_000, transition: 'paused', reason: null }, // valid
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    // Only one valid `paused` event landed; future + unknown dropped.
    expect(tile.autoPauseSparkline!.totalPauses).toBe(1);
  });
});

describe('auto-pause history tile — click-through href', () => {
  it('exposes the alert audit click-through href', async () => {
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: { body: { days: 1, events: [] } },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'auto-pause-history')!;
    expect(tile.href).toBe(
      '/alerts/audit?integration=content-engine&decision=fire&days=7',
    );
  });

  it('renders the tile as a click-through <a> in the dashboard HTML', async () => {
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: { body: { days: 1, events: [] } },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const html = renderDashboard(baseStatus, {
      generatedAt: '2026-04-29T12:00:00Z',
      integrationTiles: tiles,
    });
    // The href is encoded by escapeHtml (& → &amp;).
    expect(html).toContain(
      '<a class="tile tile--ok tile--linked" href="/alerts/audit?integration=content-engine&amp;decision=fire&amp;days=7"',
    );
    expect(html).toContain('Auto-pause history (24h)');
  });
});

describe('auto-pause history tile — XSS / defensive rendering', () => {
  it('does not surface raw upstream `reason` strings on the tile', async () => {
    const pausedTs = now - 60 * 60 * 1000;
    const evilReason = '<script>alert(1)</script>';
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: {
        body: {
          days: 1,
          events: [
            { ts_ms: pausedTs, transition: 'paused', reason: evilReason },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const html = renderDashboard(baseStatus, {
      generatedAt: '2026-04-29T12:00:00Z',
      integrationTiles: tiles,
    });
    // The reason text never reaches the rendered HTML — neither raw nor
    // escaped. This is by design: the tile only surfaces transition counts
    // + timestamps. The full reason history lives behind the click-through.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('alert(1)');
  });

  it('escapes ISO timestamps in the sparkline bar tooltips (defensive)', async () => {
    const pausedTs = now - 30 * 60 * 1000;
    const fake = fakeFetch({
      [PROMPT_QUALITY_URL]: { body: {} },
      [SCENE_DRIFT_URL]: { body: { scenes: [] } },
      [AUTO_PAUSE_URL]: {
        body: {
          days: 1,
          events: [{ ts_ms: pausedTs, transition: 'paused', reason: null }],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const html = renderDashboard(baseStatus, {
      generatedAt: '2026-04-29T12:00:00Z',
      integrationTiles: tiles,
    });
    expect(html).toContain('tile__pause-spark');
    // 24 bars rendered.
    const barMatches = html.match(/tile__pause-bar tile__pause-bar--/g) ?? [];
    expect(barMatches.length).toBe(24);
    // At least one paused bar in the window.
    expect(html).toContain('tile__pause-bar tile__pause-bar--paused');
  });
});

describe('buildAutoPauseSparkline — pure helper', () => {
  it('clamps negative windowMs to a single hour', () => {
    const out = buildAutoPauseSparkline([], -100, now);
    expect(out.points).toHaveLength(1);
    expect(out.totalPauses).toBe(0);
    expect(out.currentlyPaused).toBe(false);
  });

  it('drops events outside the trailing window', () => {
    const inWindow = now - 30 * 60 * 1000;
    const outOfWindow = now - 25 * 60 * 60 * 1000; // 25h ago, outside 24h window
    const out = buildAutoPauseSparkline(
      [
        { ts_ms: inWindow, transition: 'paused', reason: null },
        { ts_ms: outOfWindow, transition: 'paused', reason: null },
      ],
      24 * 60 * 60 * 1000,
      now,
    );
    expect(out.totalPauses).toBe(1);
  });
});
