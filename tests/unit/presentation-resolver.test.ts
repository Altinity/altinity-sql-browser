import { describe, expect, it } from 'vitest';
import {
  resolveDashboardPresentations, resolvePresentation,
} from '../../src/dashboard/model/presentation-resolver.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const has = (diagnostics: WorkspaceDiagnostic[], code: string): boolean => diagnostics.some((d) => d.code === code);

const basePanel = () => ({ cfg: { type: 'bar', x: 0, y: [1] }, fieldConfig: { defaults: { unit: 'x' } } });
const makeQuery = (dashboard?: Record<string, unknown>, panel: unknown = basePanel()) => ({
  id: 'q', sql: 'SELECT a,b', specVersion: 1,
  spec: { name: 'q', panel, ...(dashboard ? { dashboard } : {}) },
});
const tileFor = (presentation?: Record<string, unknown>, id: string | undefined = 't1') => ({
  ...(id === undefined ? {} : { id }), queryId: 'q', ...(presentation ? { presentation } : {}),
});

describe('resolvePresentation', () => {
  it('returns the base panel when no variant or override applies', () => {
    const result = resolvePresentation({ query: makeQuery(), tile: tileFor() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.panel).toEqual(basePanel());
  });

  it('treats the legacy explicit Table view as a Table base presentation', () => {
    const query = { id: 'q', sql: 'SELECT a,b', specVersion: 1, spec: { name: 'q', view: 'table' } };
    const result = resolvePresentation({ query, tile: tileFor() });
    expect(result).toEqual({ ok: true, panel: { cfg: { type: 'table' } } });
  });

  it('adds a Table cfg while preserving panel metadata when cfg is absent', () => {
    const emptyPanel = {
      id: 'q', sql: 'SELECT a', specVersion: 1,
      spec: { name: 'q', view: 'table', panel: {} },
    };
    const fieldConfigPanel = {
      id: 'q', sql: 'SELECT a', specVersion: 1,
      spec: { name: 'q', view: 'table', panel: { fieldConfig: { defaults: { decimals: 2 } } } },
    };
    expect(resolvePresentation({ query: emptyPanel, tile: tileFor() })).toEqual({
      ok: true, panel: { cfg: { type: 'table' } },
    });
    expect(resolvePresentation({ query: fieldConfigPanel, tile: tileFor() })).toEqual({
      ok: true, panel: { cfg: { type: 'table' }, fieldConfig: { defaults: { decimals: 2 } } },
    });
  });

  it('leaves a query without an explicit presentation unconfigured for runtime auto-detection', () => {
    const query = { id: 'q', sql: 'SELECT a,b', specVersion: 1, spec: { name: 'q' } };
    const result = resolvePresentation({ query, tile: tileFor() });
    expect(result).toEqual({ ok: true, panel: {} });
  });

  it('keeps an explicit panel authoritative over the legacy Table view', () => {
    const query = {
      id: 'q', sql: 'SELECT a', specVersion: 1,
      spec: { name: 'q', view: 'table', panel: { cfg: { type: 'kpi' } } },
    };
    const result = resolvePresentation({ query, tile: tileFor() });
    expect(result).toEqual({ ok: true, panel: { cfg: { type: 'kpi' } } });
  });

  it('applies named variants and tile overrides over the legacy Table base', () => {
    const query = {
      id: 'q', sql: 'SELECT a', specVersion: 1,
      spec: { name: 'q', view: 'table', dashboard: { variants: { compact: { fieldConfig: { defaults: { decimals: 1 } } } } } },
    };
    const result = resolvePresentation({
      query, tile: tileFor({ variant: 'compact', override: { fieldConfig: { columns: { a: { unit: 'ms' } } } } }),
    });
    expect(result).toEqual({ ok: true, panel: {
      cfg: { type: 'table' },
      fieldConfig: { defaults: { decimals: 1 }, columns: { a: { unit: 'ms' } } },
    } });
  });

  it('applies a valid named variant patch', () => {
    const query = makeQuery({ variants: { alt: { fieldConfig: { defaults: { unit: 'ms' } } } } });
    const result = resolvePresentation({ query, tile: tileFor({ variant: 'alt' }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.panel.fieldConfig).toEqual({ defaults: { unit: 'ms' } });
  });

  it('applies the tile override after the variant (override wins)', () => {
    const query = makeQuery({ variants: { alt: { fieldConfig: { defaults: { unit: 'ms' } } } } });
    const result = resolvePresentation({
      query, tile: tileFor({ variant: 'alt', override: { fieldConfig: { defaults: { unit: 'us', decimals: 2 } } } }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.panel.fieldConfig).toEqual({ defaults: { unit: 'us', decimals: 2 } });
  });

  it('replaces arrays atomically rather than merging by index', () => {
    const query = makeQuery();
    const result = resolvePresentation({ query, tile: tileFor({ override: { cfg: { y: [0] } } }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.panel.cfg as { y: number[] }).y).toEqual([0]);
  });

  it('deletes an optional property when a patch member is null', () => {
    const result = resolvePresentation({ query: makeQuery(), tile: tileFor({ override: { fieldConfig: null } }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect('fieldConfig' in result.panel).toBe(false);
  });

  it('fails final validation when a required property is deleted', () => {
    const result = resolvePresentation({ query: makeQuery(), tile: tileFor({ override: { cfg: { x: null } } }) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(has(result.diagnostics, 'schema-required')).toBe(true);
      expect(result.diagnostics[0].resource).toBe('t1');
    }
  });

  it('fails when a variant or override changes the renderer type, including deleting it', () => {
    const viaVariant = resolvePresentation({
      query: makeQuery({ variants: { alt: { cfg: { type: 'line' } } } }), tile: tileFor({ variant: 'alt' }),
    });
    expect(viaVariant.ok).toBe(false);
    const viaOverride = resolvePresentation({ query: makeQuery(), tile: tileFor({ override: { cfg: { type: 'pie' } } }) });
    expect(viaOverride.ok).toBe(false);
    const viaDelete = resolvePresentation({ query: makeQuery(), tile: tileFor({ override: { cfg: { type: null } } }) });
    expect(viaDelete.ok).toBe(false);
    if (!viaDelete.ok) expect(has(viaDelete.diagnostics, 'presentation-renderer-type-change')).toBe(true);
  });

  it('fails when the selected variant name does not exist — no silent fallback', () => {
    const query = makeQuery({ defaultVariant: 'd', variants: { d: {} } });
    const result = resolvePresentation({ query, tile: { queryId: 'q', presentation: { variant: 'nope' } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(has(result.diagnostics, 'presentation-variant-missing')).toBe(true);
      expect(result.diagnostics[0].resource).toBeUndefined(); // tile has no id
    }
  });

  it('uses defaultVariant when no variant is selected, else the base panel', () => {
    const withDefault = makeQuery({ defaultVariant: 'd', variants: { d: { fieldConfig: { defaults: { unit: 'DEF' } } } } });
    const applied = resolvePresentation({ query: withDefault, tile: tileFor() });
    expect(applied.ok && (applied.panel.fieldConfig as { defaults: { unit: string } }).defaults.unit).toBe('DEF');

    const brokenDefault = makeQuery({ defaultVariant: 'gone', variants: { other: {} } });
    const fellBack = resolvePresentation({ query: brokenDefault, tile: tileFor() });
    expect(fellBack.ok).toBe(true);
    if (fellBack.ok) expect(fellBack.panel).toEqual(basePanel());
  });

  it('validates result-column roles only when result metadata is available', () => {
    const query = makeQuery();
    const twoColumns = [{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt32' }];
    const ok = resolvePresentation({ query, tile: tileFor(), resultColumns: twoColumns });
    expect(ok.ok).toBe(true);
    // Only one column: measure index 1 is out of range → semantic failure.
    const bad = resolvePresentation({ query, tile: tileFor(), resultColumns: [{ name: 'a', type: 'String' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(has(bad.diagnostics, 'presentation-resolved-invalid-roles')).toBe(true);
  });

  it('carries no resource on a structural failure for a tile without an id', () => {
    const result = resolvePresentation({ query: makeQuery(), tile: { queryId: 'q', presentation: { override: { cfg: { x: null } } } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(has(result.diagnostics, 'schema-required')).toBe(true);
      expect(result.diagnostics.every((d) => d.resource === undefined)).toBe(true);
    }
  });

  it('skips the result-column role check when the resolved panel has no cfg', () => {
    const result = resolvePresentation({
      query: makeQuery(undefined, {}), tile: tileFor(), resultColumns: [{ name: 'a', type: 'String' }],
    });
    expect(result.ok).toBe(true);
  });

  it('resolves an empty base panel and allows a patch to introduce a renderer type', () => {
    const emptyBase = resolvePresentation({ query: null, tile: null });
    expect(emptyBase.ok).toBe(true);
    if (emptyBase.ok) expect(emptyBase.panel).toEqual({});
    const introduced = resolvePresentation({
      query: makeQuery(undefined, {}), tile: tileFor({ override: { cfg: { type: 'table' } } }),
    });
    expect(introduced.ok).toBe(true);
  });
});

describe('resolveDashboardPresentations', () => {
  const filterQuery = { id: 'f', sql: "SELECT ['a'] c", specVersion: 1, spec: { dashboard: { role: 'filter' } } };

  it('returns nothing for a non-object dashboard or one without a tiles array', () => {
    expect(resolveDashboardPresentations({ dashboard: null, queries: [] })).toEqual([]);
    expect(resolveDashboardPresentations({ dashboard: {}, queries: [] })).toEqual([]);
  });

  it('reports the diagnostics of each invalid panel-tile presentation', () => {
    const query = makeQuery({ variants: { alt: {} } });
    const dashboard = { tiles: [tileFor({ variant: 'nope' })] };
    const diagnostics = resolveDashboardPresentations({ dashboard, queries: [query], path: ['dashboard'] });
    expect(has(diagnostics, 'presentation-variant-missing')).toBe(true);
    expect(diagnostics[0].path).toEqual(['dashboard', 'tiles', 0, 'presentation', 'variant']);
  });

  it('skips non-panel tiles, tiles without a queryId, and tiles whose query is missing', () => {
    const dashboard = {
      tiles: [
        'not-object',
        { id: 't1' }, // no queryId
        { id: 't2', queryId: 'gone' }, // query missing
        { id: 't3', queryId: 'f' }, // filter role
        { queryId: 'q' }, // panel tile without id — resolves clean, exercises the id branch
      ],
    };
    const diagnostics = resolveDashboardPresentations({ dashboard, queries: [makeQuery(), filterQuery] });
    expect(diagnostics).toEqual([]);
  });

  it('applies per-tile result metadata when provided', () => {
    const dashboard = { tiles: [tileFor()] };
    const diagnostics = resolveDashboardPresentations({
      dashboard, queries: [makeQuery()], resultColumnsByTileId: { t1: [{ name: 'a', type: 'String' }] },
    });
    expect(has(diagnostics, 'presentation-resolved-invalid-roles')).toBe(true);
  });
});
