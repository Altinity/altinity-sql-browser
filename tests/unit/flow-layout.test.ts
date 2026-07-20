import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW_PLACEMENT, FLOW_MOBILE_BREAKPOINT, FLOW_PRESET_COLUMNS,
  computeFlowLayout, deriveFlowPlacement, effectiveSpan, flowLayoutPlugin,
  presetColumns, resolvePlacement, setFlowPlacement,
} from '../../src/dashboard/layouts/flow-layout.js';
import type { DashboardDocumentV1 } from '../../src/generated/json-schema.types.js';

const flowLayout = (items: Record<string, Record<string, unknown>> = {}) => ({ type: 'flow', version: 1, preset: 'report', items });
const doc = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd', title: 'D', revision: 1, layout: flowLayout(), filters: [], tiles: [], ...over,
} as DashboardDocumentV1);

describe('deriveFlowPlacement', () => {
  it('maps preferred size hints to a span', () => {
    expect(deriveFlowPlacement({ preferred: 'wide' })).toEqual({ span: 3, height: 'medium' });
    expect(deriveFlowPlacement({ preferred: 'medium' })).toEqual({ span: 2, height: 'medium' });
    expect(deriveFlowPlacement({ preferred: 'compact' })).toEqual({ span: 1, height: 'medium' });
  });

  it('returns undefined without a usable hint', () => {
    expect(deriveFlowPlacement(undefined)).toBeUndefined();
    expect(deriveFlowPlacement({ preferred: 'other' })).toBeUndefined();
    expect(deriveFlowPlacement({})).toBeUndefined();
  });
});

describe('setFlowPlacement', () => {
  it('sets a placement on a flow layout', () => {
    const layout = flowLayout();
    setFlowPlacement(layout, 't1', { span: 2 });
    expect(layout.items).toEqual({ t1: { span: 2 } });
  });

  it('creates the items map when the flow layout is missing one', () => {
    const layout: Record<string, unknown> = { type: 'flow', version: 1, preset: 'report' };
    setFlowPlacement(layout, 't1', { span: 1 });
    expect(layout.items).toEqual({ t1: { span: 1 } });
  });

  it('targets a valid flow@1 fallback of an unsupported layout', () => {
    const layout: Record<string, unknown> = { type: 'grid', version: 9, fallback: flowLayout() };
    setFlowPlacement(layout, 't1', { span: 3 });
    expect((layout.fallback as { items: unknown }).items).toEqual({ t1: { span: 3 } });
  });

  it('creates the items map on a fallback that lacks one', () => {
    const layout: Record<string, unknown> = { type: 'grid', version: 9, fallback: { type: 'flow', version: 1, preset: 'report' } };
    setFlowPlacement(layout, 't1', { span: 1 });
    expect((layout.fallback as { items: unknown }).items).toEqual({ t1: { span: 1 } });
  });

  it('is a no-op when there is no flow surface', () => {
    const layout: Record<string, unknown> = { type: 'grid', version: 9 };
    expect(() => setFlowPlacement(layout, 't1', { span: 1 })).not.toThrow();
    expect(layout.items).toBeUndefined();
    // A non-object layout is tolerated too.
    expect(() => setFlowPlacement(null, 't1', { span: 1 })).not.toThrow();
  });
});

describe('flowLayoutPlugin.normalize', () => {
  it('prunes placements that no longer name a tile, without mutating the input', () => {
    const input = doc({ tiles: [{ id: 't1', queryId: 'q' }] as never, layout: flowLayout({ t1: { span: 1 }, ghost: {} }) });
    const result = flowLayoutPlugin.normalize(input);
    expect(result.layout.items).toEqual({ t1: { span: 1 } });
    expect((input.layout.items as Record<string, unknown>).ghost).toBeDefined(); // input untouched
  });

  it('normalizes an unsupported layout with a fallback and tolerates a missing flow surface', () => {
    const withFallback = doc({
      tiles: [{ id: 't1', queryId: 'q' }] as never,
      layout: { type: 'grid', version: 9, items: {}, fallback: flowLayout({ t1: {}, ghost: {} }) } as never,
    });
    const result = flowLayoutPlugin.normalize(withFallback);
    expect((result.layout.fallback as { items: unknown }).items).toEqual({ t1: {} });

    // A non-flow layout with no fallback: nothing to prune, no throw.
    const noSurface = doc({ tiles: [{ queryId: 'q' }] as never, layout: { type: 'grid', version: 9 } as never });
    expect(() => flowLayoutPlugin.normalize(noSurface)).not.toThrow();

    // A non-array tiles field is tolerated — every placement is then an orphan.
    const noTiles = doc({ tiles: undefined as never, layout: flowLayout({ ghost: {} }) });
    expect(flowLayoutPlugin.normalize(noTiles).layout.items).toEqual({});
  });
});

describe('flowLayoutPlugin.validatePlacement', () => {
  it('accepts a valid placement', () => {
    expect(flowLayoutPlugin.validatePlacement({ span: 2, height: 'large' })).toEqual([]);
    expect(flowLayoutPlugin.validatePlacement(DEFAULT_FLOW_PLACEMENT)).toEqual([]);
  });

  it('rejects a non-object placement', () => {
    const diagnostics = flowLayoutPlugin.validatePlacement('nope', ['layout', 'items', 't1']);
    expect(diagnostics.map((d) => d.code)).toEqual(['layout-placement-invalid']);
  });

  it('rejects unknown fields and invalid span/height', () => {
    const diagnostics = flowLayoutPlugin.validatePlacement({ span: 4, height: 'huge', bogus: true });
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain('layout-placement-unknown-field');
    expect(codes).toContain('layout-placement-invalid-span');
    expect(codes).toContain('layout-placement-invalid-height');
  });
});

// ── Phase 4: the normative flow@1 render model (#280) ──────────────────────

describe('presetColumns', () => {
  it('maps each preset to its desktop column count', () => {
    expect(presetColumns('report')).toBe(1);
    expect(presetColumns('columns-2')).toBe(2);
    expect(presetColumns('columns-3')).toBe(3);
    expect(FLOW_PRESET_COLUMNS['columns-3']).toBe(3);
    expect(Object.keys(FLOW_PRESET_COLUMNS).sort()).toEqual(['columns-2', 'columns-3', 'report']);
  });

  it('falls back to 1 column for an unknown or non-string preset (full-width removed, #321)', () => {
    expect(presetColumns('full-width')).toBe(1);
    expect(presetColumns('masonry')).toBe(1);
    expect(presetColumns(undefined)).toBe(1);
    expect(presetColumns(2)).toBe(1);
  });
});

describe('effectiveSpan', () => {
  it('clamps the stored span to the active column count (min)', () => {
    expect(effectiveSpan(3, 3)).toBe(3);
    expect(effectiveSpan(3, 2)).toBe(2); // preset change does not rewrite the stored span
    expect(effectiveSpan(2, 1)).toBe(1);
  });

  it('treats an absent/invalid stored span as the default 1', () => {
    expect(effectiveSpan(undefined, 3)).toBe(1);
    expect(effectiveSpan(4, 3)).toBe(1);
    expect(effectiveSpan('2', 3)).toBe(1);
  });

  it('never returns less than one even with a zero column count', () => {
    expect(effectiveSpan(2, 0)).toBe(1);
  });
});

describe('resolvePlacement', () => {
  it('merges a stored placement with the defaults', () => {
    expect(resolvePlacement({ span: 2, height: 'large' })).toEqual({ span: 2, height: 'large' });
    expect(resolvePlacement({ span: 3 })).toEqual({ span: 3, height: 'medium' });
    expect(resolvePlacement({ height: 'compact' })).toEqual({ span: 1, height: 'compact' });
  });

  it('falls back to the defaults for a missing or invalid placement', () => {
    expect(resolvePlacement(undefined)).toEqual(DEFAULT_FLOW_PLACEMENT);
    expect(resolvePlacement({ span: 9, height: 'huge' })).toEqual({ span: 1, height: 'medium' });
    expect(resolvePlacement('nope')).toEqual({ span: 1, height: 'medium' });
  });
});

describe('computeFlowLayout', () => {
  const tiles = (...ids: string[]) => ids.map((id) => ({ id }));
  const flow = (preset: string, items: Record<string, Record<string, unknown>> = {}) =>
    ({ type: 'flow', version: 1, preset, items });

  it('defaults a missing placement to span 1, medium height', () => {
    const model = computeFlowLayout({ tiles: tiles('a'), layout: flow('columns-3') });
    expect(model.rows[0].tiles[0]).toMatchObject({ tileId: 'a', span: 1, height: 'medium' });
  });

  it('clamps effective span per preset without mutating stored spans', () => {
    const layout = flow('columns-2', { a: { span: 3 } });
    const model = computeFlowLayout({ tiles: tiles('a', 'b'), layout });
    expect(model.columns).toBe(2);
    expect(model.rows[0].tiles[0].span).toBe(2); // 3 clamped to 2
    expect(layout.items.a.span).toBe(3); // persisted span untouched
  });

  it('packs tiles row-major, starting a new row when the next span does not fit, with no overlaps', () => {
    // columns-3, spans [2,2,1]: row1 = [2] (remaining 1 < 2 → wrap), row2 = [2,1]
    const layout = flow('columns-3', { a: { span: 2 }, b: { span: 2 }, c: { span: 1 } });
    const model = computeFlowLayout({ tiles: tiles('a', 'b', 'c'), layout });
    expect(model.rows.map((row) => row.tiles.map((tile) => tile.tileId))).toEqual([['a'], ['b', 'c']]);
    for (const row of model.rows) {
      const used = row.tiles.reduce((sum, tile) => sum + tile.span, 0);
      expect(used).toBeLessThanOrEqual(row.columns);
    }
  });

  it('keeps semantic = DOM = visual row-major = keyboard = print order', () => {
    const layout = flow('columns-2', { a: { span: 1 }, b: { span: 1 }, c: { span: 2 } });
    const model = computeFlowLayout({ tiles: tiles('a', 'b', 'c'), layout });
    const visual = model.rows.flatMap((row) => row.tiles.map((tile) => tile.tileId));
    expect(model.order).toEqual(['a', 'b', 'c']);
    expect(visual).toEqual(model.order); // row-major visual order == semantic order
  });

  it('normalizes to one column on mobile without mutating persistence', () => {
    const layout = flow('columns-3', { a: { span: 3 }, b: { span: 2 } });
    const model = computeFlowLayout({ tiles: tiles('a', 'b'), layout, mobile: true });
    expect(model.mobile).toBe(true);
    expect(model.columns).toBe(1);
    expect(model.rows.map((row) => row.tiles.map((tile) => tile.span))).toEqual([[1], [1]]);
    expect(layout.items.a.span).toBe(3); // still authored
    expect(layout.preset).toBe('columns-3'); // preset unchanged
    // Desktop restores the authored placement.
    const desktop = computeFlowLayout({ tiles: tiles('a', 'b'), layout });
    expect(desktop.rows[0].tiles[0].span).toBe(3);
  });

  it('groups a maximal consecutive KPI run into one full-width band row', () => {
    const model = computeFlowLayout({
      tiles: [{ id: 'k1', isKpi: true }, { id: 'k2', isKpi: true }, { id: 't1' }, { id: 'k3', isKpi: true }],
      layout: flow('columns-2'),
    });
    expect(model.rows[0]).toMatchObject({ kind: 'kpi-band', columns: 2 });
    expect(model.rows[0].tiles.map((tile) => tile.tileId)).toEqual(['k1', 'k2']);
    expect(model.rows[1]).toMatchObject({ kind: 'tiles' });
    expect(model.rows[2]).toMatchObject({ kind: 'kpi-band' });
    expect(model.rows[2].tiles.map((tile) => tile.tileId)).toEqual(['k3']);
    // The band interrupts packing but preserves the overall order.
    expect(model.rows.flatMap((row) => row.tiles.map((tile) => tile.tileId))).toEqual(model.order);
  });

  it('reads the preset/items from a valid flow@1 fallback of an unsupported layout', () => {
    const model = computeFlowLayout({
      tiles: tiles('a'),
      layout: { type: 'grid', version: 9, fallback: flow('columns-2', { a: { span: 2 } }) },
    });
    expect(model.columns).toBe(2);
    expect(model.rows[0].tiles[0].span).toBe(2);
  });

  it('falls back to report with defaults when the layout has no flow surface', () => {
    const model = computeFlowLayout({ tiles: tiles('a', 'b'), layout: { type: 'grid', version: 9 } });
    expect(model.preset).toBe('report');
    expect(model.columns).toBe(1);
    expect(model.rows.map((row) => row.tiles.map((tile) => tile.tileId))).toEqual([['a'], ['b']]);
    // A non-object layout is tolerated too.
    expect(computeFlowLayout({ tiles: tiles('a'), layout: null }).preset).toBe('report');
    // An unknown/invalid preset string on a flow surface (including the
    // removed full-width) degrades to report, the nearest single-column preset.
    expect(computeFlowLayout({ tiles: tiles('a'), layout: flow('bogus') }).preset).toBe('report');
    expect(computeFlowLayout({ tiles: tiles('a'), layout: flow('full-width') }).preset).toBe('report');
  });

  it('exposes the mobile breakpoint constant', () => {
    expect(FLOW_MOBILE_BREAKPOINT).toBe(768);
  });
});
