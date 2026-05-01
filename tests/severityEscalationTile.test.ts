import {
  IntegrationTilesFetcher,
  IntegrationFetchImpl,
  buildSeverityEscalationSparkline,
} from '../src/integrationTiles';
import { renderDashboard } from '../src/render';
import { AppStatus } from '../src/status';

/**
 * Severity escalation tile (2026-04-30). The empire-dashboard reads
 * content-engine's `GET /api/integration/strict-mode-severity-escalations?days=30`
 * endpoint and renders a 30-bucket per-day sparkline of strict
 * UP-transitions across the {occasional, frequent, chronic} severity
 * ladder on the homepage.
 *
 * State machine:
 *   ok       — zero escalations in 30d.
 *   warn     — at least one escalation in 30d, but none in last 24h.
 *   critical — at least one escalation in last 24h.
 *
 * Click-through: tile carries an `href` that points at
 * `/alerts/audit?integration=content-engine&decision=fire&days=30`.
 *
 * XSS: tile renders defensively — reasons returned by the upstream are
 * never rendered raw (we only surface escalation counts + ISO timestamps,
 * never the upstream `reason` field).
 */

function fakeFetch(byUrl: Record<string, {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: boolean;
}>): { impl: IntegrationFetchImpl } {
  const impl: IntegrationFetchImpl = async (url) => {
    const match = byUrl[url];
    if (!match) {
      // Default for unrelated tile URLs (po-receiver, kanban, etc.) — return
      // a benign empty body so unrelated tiles fall into a deterministic
      // state and the assertions in this test file only exercise the
      // severity-escalation tile.
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }
    if (match.throws) throw new Error('network');
    return {
      ok: match.ok ?? true,
      status: match.status ?? 200,
      json: async () => match.body ?? {},
    };
  };
  return { impl };
}

const now = Date.parse('2026-04-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

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

const SEVERITY_URL =
  'https://ce/api/integration/strict-mode-severity-escalations?days=30';

describe('severity escalation tile — state machine', () => {
  it('renders state=ok with zero escalations when events array is empty', async () => {
    const fake = fakeFetch({
      [SEVERITY_URL]: { body: { days: 30, events: [] } },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'severity-escalation');
    expect(tile).toBeDefined();
    expect(tile!.state).toBe('ok');
    expect(tile!.summary).toMatch(/no escalations/i);
    expect(tile!.severityEscalationSparkline).toBeDefined();
    expect(tile!.severityEscalationSparkline!.points).toHaveLength(30);
    expect(tile!.severityEscalationSparkline!.totalEscalations).toBe(0);
    expect(tile!.severityEscalationSparkline!.lastEscalationAt).toBeNull();
  });

  it('renders state=warn when escalations exist in 30d but not in last 24h', async () => {
    const oldEscalationTs = now - 5 * DAY; // 5 days ago
    const fake = fakeFetch({
      [SEVERITY_URL]: {
        body: {
          days: 30,
          events: [
            {
              ts_ms: oldEscalationTs,
              scene: 'URBAN_STREET',
              from_severity: 'occasional',
              to_severity: 'frequent',
              reason: 'count=3',
            },
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
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    expect(tile.state).toBe('warn');
    expect(tile.severityEscalationSparkline!.totalEscalations).toBe(1);
    expect(tile.severityEscalationSparkline!.lastEscalationAt).toBe(
      new Date(oldEscalationTs).toISOString(),
    );
    expect(tile.summary).toMatch(/1 escalation in 30d/i);
    expect(tile.summary).not.toMatch(/recent/i);
  });

  it('renders state=critical when latest escalation is in last 24h', async () => {
    const oldTs = now - 7 * DAY;
    const recentTs = now - 3 * 60 * 60 * 1000; // 3h ago
    const fake = fakeFetch({
      [SEVERITY_URL]: {
        body: {
          days: 30,
          events: [
            {
              ts_ms: recentTs,
              scene: 'SUBURBAN',
              from_severity: 'frequent',
              to_severity: 'chronic',
              reason: 'count=10',
            },
            {
              ts_ms: oldTs,
              scene: 'URBAN_STREET',
              from_severity: 'occasional',
              to_severity: 'frequent',
              reason: 'count=3',
            },
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
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    expect(tile.state).toBe('critical');
    expect(tile.severityEscalationSparkline!.totalEscalations).toBe(2);
    expect(tile.severityEscalationSparkline!.lastEscalationAt).toBe(
      new Date(recentTs).toISOString(),
    );
    expect(tile.summary).toMatch(/2 escalations in 30d/i);
    expect(tile.summary).toMatch(/recent/i);
  });
});

describe('severity escalation tile — config + fallback', () => {
  it('renders state=not-configured when content-engine env vars are unset', async () => {
    const fake = fakeFetch({});
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
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    expect(tile.state).toBe('not-configured');
    expect(tile.severityEscalationSparkline).toBeUndefined();
    expect(tile.href).toBeUndefined();
  });

  it('renders state=error on HTTP non-2xx without crashing', async () => {
    const fake = fakeFetch({
      [SEVERITY_URL]: { ok: false, status: 503 },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    expect(tile.state).toBe('error');
    expect(tile.error).toMatch(/HTTP 503/);
  });

  it('renders state=error when fetch throws (network failure)', async () => {
    const fake = fakeFetch({
      [SEVERITY_URL]: { throws: true },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    expect(tile.state).toBe('error');
    expect(tile.error).toMatch(/network/);
  });

  it('drops future-skewed events, down-transitions, same-level rows, and unknown severity (forward-compat)', async () => {
    const fake = fakeFetch({
      [SEVERITY_URL]: {
        body: {
          days: 30,
          events: [
            // future-skewed — dropped
            {
              ts_ms: now + 60_000,
              scene: 'URBAN',
              from_severity: 'occasional',
              to_severity: 'chronic',
              reason: null,
            },
            // down-transition — dropped
            {
              ts_ms: now - 2 * DAY,
              scene: 'URBAN',
              from_severity: 'chronic',
              to_severity: 'occasional',
              reason: null,
            },
            // same-level — dropped
            {
              ts_ms: now - 3 * DAY,
              scene: 'URBAN',
              from_severity: 'frequent',
              to_severity: 'frequent',
              reason: null,
            },
            // unknown severity label — dropped
            {
              ts_ms: now - 4 * DAY,
              scene: 'URBAN',
              from_severity: 'occasional',
              to_severity: 'cataclysmic',
              reason: null,
            },
            // valid up-transition — counted (5d ago, so warn not critical)
            {
              ts_ms: now - 5 * DAY,
              scene: 'URBAN',
              from_severity: 'occasional',
              to_severity: 'frequent',
              reason: null,
            },
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
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    // Only the one valid up-transition lands.
    expect(tile.severityEscalationSparkline!.totalEscalations).toBe(1);
    expect(tile.state).toBe('warn');
  });
});

describe('severity escalation tile — click-through href', () => {
  it('exposes the alert audit click-through href with days=30', async () => {
    const fake = fakeFetch({
      [SEVERITY_URL]: { body: { days: 30, events: [] } },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const tile = tiles.find((t) => t.id === 'severity-escalation')!;
    expect(tile.href).toBe(
      '/alerts/audit?integration=content-engine&decision=fire&days=30',
    );
  });

  it('renders the tile as a click-through <a> in the dashboard HTML', async () => {
    const fake = fakeFetch({
      [SEVERITY_URL]: { body: { days: 30, events: [] } },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
      now: () => now,
    });
    const tiles = await fetcher.getTiles();
    const html = renderDashboard(baseStatus, {
      generatedAt: '2026-04-30T12:00:00Z',
      integrationTiles: tiles,
    });
    // The href is encoded by escapeHtml (& → &amp;).
    expect(html).toContain(
      '<a class="tile tile--ok tile--linked" href="/alerts/audit?integration=content-engine&amp;decision=fire&amp;days=30"',
    );
    expect(html).toContain('Severity escalations (30d)');
  });
});

describe('severity escalation tile — XSS / defensive rendering', () => {
  it('does not surface raw upstream `reason` strings on the tile', async () => {
    const escalationTs = now - 6 * 60 * 60 * 1000; // 6h ago — critical
    const evilReason = '<script>alert(1)</script>';
    const fake = fakeFetch({
      [SEVERITY_URL]: {
        body: {
          days: 30,
          events: [
            {
              ts_ms: escalationTs,
              scene: 'URBAN',
              from_severity: 'occasional',
              to_severity: 'frequent',
              reason: evilReason,
            },
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
      generatedAt: '2026-04-30T12:00:00Z',
      integrationTiles: tiles,
    });
    // The reason text never reaches the rendered HTML — neither raw nor
    // escaped. By design the tile only surfaces escalation counts +
    // timestamps. The full reason history lives behind the click-through.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('alert(1)');
  });

  it('also does not surface raw upstream `scene` strings on the tile', async () => {
    const escalationTs = now - 12 * 60 * 60 * 1000;
    const evilScene = '<img src=x onerror=alert(2)>';
    const fake = fakeFetch({
      [SEVERITY_URL]: {
        body: {
          days: 30,
          events: [
            {
              ts_ms: escalationTs,
              scene: evilScene,
              from_severity: 'occasional',
              to_severity: 'frequent',
              reason: null,
            },
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
      generatedAt: '2026-04-30T12:00:00Z',
      integrationTiles: tiles,
    });
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).not.toContain('onerror=alert');
  });

  it('renders 30 sparkline bars in the dashboard HTML', async () => {
    const escalationTs = now - 6 * 60 * 60 * 1000;
    const fake = fakeFetch({
      [SEVERITY_URL]: {
        body: {
          days: 30,
          events: [
            {
              ts_ms: escalationTs,
              scene: 'URBAN',
              from_severity: 'occasional',
              to_severity: 'frequent',
              reason: null,
            },
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
      generatedAt: '2026-04-30T12:00:00Z',
      integrationTiles: tiles,
    });
    expect(html).toContain('tile__esc-spark');
    const barMatches = html.match(/tile__esc-bar tile__esc-bar--/g) ?? [];
    expect(barMatches.length).toBe(30);
    // At least one warn-class bar (single escalation) lands in the window.
    expect(html).toContain('tile__esc-bar tile__esc-bar--warn');
  });
});

describe('buildSeverityEscalationSparkline — pure helper', () => {
  it('clamps negative windowMs to a single day', () => {
    const out = buildSeverityEscalationSparkline([], -100, now);
    expect(out.points).toHaveLength(1);
    expect(out.totalEscalations).toBe(0);
    expect(out.lastEscalationAt).toBeNull();
  });

  it('clamps zero windowMs to a single day', () => {
    const out = buildSeverityEscalationSparkline([], 0, now);
    expect(out.points).toHaveLength(1);
    expect(out.totalEscalations).toBe(0);
  });

  it('clamps non-finite windowMs (NaN, Infinity) to a single day', () => {
    const nanOut = buildSeverityEscalationSparkline([], Number.NaN, now);
    expect(nanOut.points).toHaveLength(1);
    const infOut = buildSeverityEscalationSparkline([], Number.POSITIVE_INFINITY, now);
    // Math.trunc(Infinity) is not finite — falls through Number.isFinite
    // guard to 0, then clamped to DAY.
    expect(infOut.points).toHaveLength(1);
  });

  it('handles a 30-day window cleanly (no 32-bit `windowMs | 0` overflow bug)', () => {
    // 30 days in ms is 2,592,000,000 — overflows signed 32-bit when treated
    // as `windowMs | 0`. The implementation uses Math.trunc to dodge that.
    const out = buildSeverityEscalationSparkline([], 30 * DAY, now);
    expect(out.points).toHaveLength(30);
    expect(out.totalEscalations).toBe(0);
  });

  it('drops events outside the trailing window', () => {
    const inWindow = now - 5 * DAY;
    const outOfWindow = now - 35 * DAY; // 35d ago — outside 30d window
    const out = buildSeverityEscalationSparkline(
      [
        {
          ts_ms: inWindow,
          scene: null,
          from_severity: 'occasional',
          to_severity: 'frequent',
          reason: null,
        },
        {
          ts_ms: outOfWindow,
          scene: null,
          from_severity: 'occasional',
          to_severity: 'frequent',
          reason: null,
        },
      ] as any,
      30 * DAY,
      now,
    );
    expect(out.totalEscalations).toBe(1);
  });

  it('emits oldest → newest points', () => {
    const out = buildSeverityEscalationSparkline([], 30 * DAY, now);
    const isos = out.points.map((p) => p.dayIso);
    expect(isos).toEqual([...isos].sort());
  });
});
