import {
  IntegrationTilesFetcher,
  IntegrationFetchImpl,
  IntegrationTile,
  computeClassificationCounts,
} from '../src/integrationTiles';
import { renderDashboard } from '../src/render';
import { AppStatus } from '../src/status';

/**
 * Scene-drift tile v2 (2026-04-23) tests:
 *
 *  1. flag_classification per scene drives chronic/spike/stable styling.
 *  2. classificationCounts are tallied across the FULL payload (not just the
 *     top-3) and rendered as colored badges above the tile body.
 *  3. Mixed payloads still surface correct counts.
 *  4. Stable-only payload renders green (state stays "ok") with the stable
 *     badge.
 *  5. Chronic count > 0 promotes the tile to warn even when no scene is in
 *     the top-3 over-represented list (e.g. all positive z below the
 *     visualisation cutoff).
 *  6. Fallback path: when the upstream payload OMITS flag_classification on
 *     every scene, we render the legacy view (no badges, no per-row pills,
 *     no crash).
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

describe('scene-drift tile v2 — flag_classification parsing + per-row pill', () => {
  it('reads flag_classification from each scene and exposes it on the matching detail row', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': {
        body: {
          scenes: [
            // chronic & high z → top of details, with chronic pill.
            { scene: 'suburban', z_score: 3.0, count: 50, expected: 20, days_since_last_flag: 1, flag_classification: 'chronic' },
            // spike & moderate z.
            { scene: 'beach', z_score: 1.2, count: 30, expected: 18, days_since_last_flag: 14, flag_classification: 'spike' },
            // stable → not in over-represented (z=0) but counted.
            { scene: 'mountain', z_score: 0.0, count: 10, expected: 10, days_since_last_flag: null, flag_classification: 'stable' },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.classificationCounts).toEqual({ chronic: 1, spike: 1, stable: 1 });
    const suburban = sd.details!.find((d) => d.label === 'suburban')!;
    expect(suburban.classification).toBe('chronic');
    const beach = sd.details!.find((d) => d.label === 'beach')!;
    expect(beach.classification).toBe('spike');
  });

  it('renders per-classification badge counts above the tile body in the dashboard HTML', () => {
    const tile: IntegrationTile = {
      id: 'scene-drift',
      title: 'Scene Distribution Drift',
      state: 'warn',
      summary: '3 over-represented',
      details: [
        { label: 'suburban', value: 'z=3.00 · 1d ago', classification: 'chronic' },
        { label: 'beach', value: 'z=1.20 · 14d ago', classification: 'spike' },
      ],
      classificationCounts: { chronic: 3, spike: 2, stable: 12 },
    };
    const html = renderDashboard(baseStatus, {
      generatedAt: 'x',
      integrationTiles: [tile],
    });
    expect(html).toContain('tile__badges');
    expect(html).toContain('tile__badge--chronic');
    expect(html).toContain('3 chronic');
    expect(html).toContain('tile__badge--spike');
    expect(html).toContain('2 spike');
    expect(html).toContain('tile__badge--stable');
    expect(html).toContain('12 stable');
    // Per-row pills.
    expect(html).toContain('tile__detail-badge--chronic');
    expect(html).toContain('tile__detail-badge--spike');
  });

  it('omits a 0-count badge but keeps non-zero ones (e.g. 0 chronic / 4 spike / 9 stable)', () => {
    const tile: IntegrationTile = {
      id: 'scene-drift',
      title: 'Scene Distribution Drift',
      state: 'warn',
      summary: '4 over-represented',
      details: [],
      classificationCounts: { chronic: 0, spike: 4, stable: 9 },
    };
    const html = renderDashboard(baseStatus, {
      generatedAt: 'x',
      integrationTiles: [tile],
    });
    expect(html).toContain('4 spike');
    expect(html).toContain('9 stable');
    expect(html).not.toContain('0 chronic');
  });

  it('keeps state=ok when only stable scenes are present and renders the stable badge', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': {
        body: {
          scenes: [
            { scene: 'suburban', z_score: -0.2, count: 8, expected: 10, days_since_last_flag: null, flag_classification: 'stable' },
            { scene: 'beach', z_score: 0.0, count: 10, expected: 10, days_since_last_flag: null, flag_classification: 'stable' },
            { scene: 'mountain', z_score: -0.5, count: 6, expected: 9, days_since_last_flag: null, flag_classification: 'stable' },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.state).toBe('ok');
    expect(sd.classificationCounts).toEqual({ chronic: 0, spike: 0, stable: 3 });
    const html = renderDashboard(baseStatus, {
      generatedAt: 'x',
      integrationTiles: [sd],
    });
    expect(html).toContain('3 stable');
    expect(html).not.toContain('chronic');
  });

  it('promotes state to warn when ANY scene is chronic, even if no scene is over-represented (z<=0)', async () => {
    // Edge case: all scenes have z<=0 (no over-representation ranking) but the
    // upstream still flags one chronic. Tile should still warn so the badge
    // is visible in the colored card.
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': {
        body: {
          scenes: [
            { scene: 'suburban', z_score: -0.5, count: 4, expected: 10, days_since_last_flag: 1, flag_classification: 'chronic' },
            { scene: 'beach', z_score: 0.0, count: 10, expected: 10, days_since_last_flag: null, flag_classification: 'stable' },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    expect(sd.state).toBe('warn');
    expect(sd.classificationCounts).toEqual({ chronic: 1, spike: 0, stable: 1 });
  });

  it('falls back to the legacy view when payload omits flag_classification on every scene', async () => {
    const fake = fakeFetch({
      'https://ce/api/integration/prompt-quality-stats': { body: {} },
      'https://ce/api/integration/scene-drift': {
        body: {
          scenes: [
            // No flag_classification field anywhere.
            { scene: 'suburban', z_score: 2.6, count: 40, expected: 20, days_since_last_flag: 1 },
            { scene: 'beach', z_score: 1.4, count: 25, expected: 18, days_since_last_flag: 7 },
          ],
        },
      },
    });
    const fetcher = new IntegrationTilesFetcher({
      config: { contentEngineUrl: 'https://ce', contentEngineApiKey: 'ck' },
      fetchImpl: fake.impl,
    });
    const tiles = await fetcher.getTiles();
    const sd = tiles.find((t) => t.id === 'scene-drift')!;
    // Legacy v1 behaviour preserved: state still warns (top-3 over-represented),
    // details still present, but no classification metadata.
    expect(sd.state).toBe('warn');
    expect(sd.classificationCounts).toBeUndefined();
    for (const d of sd.details ?? []) {
      expect(d.classification).toBeUndefined();
    }
    // Renderer must not crash and must NOT render the badges row.
    const html = renderDashboard(baseStatus, {
      generatedAt: 'x',
      integrationTiles: [sd],
    });
    expect(html).not.toContain('tile__badges');
    expect(html).not.toContain('tile__detail-badge');
    expect(html).toContain('Scene Distribution Drift');
  });

  it('ignores garbage flag_classification values (e.g. "panic") and treats them as missing', () => {
    // Direct unit test on computeClassificationCounts to lock down
    // the typed-string guard.
    const counts = computeClassificationCounts([
      { scene: 'a', zScore: 1, count: null, expected: null, daysSinceLastFlag: null, flagClassification: 'chronic' },
      // @ts-expect-error — deliberate garbage value to verify guard
      { scene: 'b', zScore: 1, count: null, expected: null, daysSinceLastFlag: null, flagClassification: 'panic' },
      { scene: 'c', zScore: 1, count: null, expected: null, daysSinceLastFlag: null, flagClassification: null },
    ]);
    expect(counts).toEqual({ chronic: 1, spike: 0, stable: 0 });
    const empty = computeClassificationCounts([]);
    expect(empty).toBeUndefined();
  });
});
