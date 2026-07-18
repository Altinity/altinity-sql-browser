import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRID_PLACEMENT, GRAFANA_GRID_MAX_COLUMNS,
  computeGrafanaGridLayout, deriveFlowFallback, deriveGrafanaGridPlacement,
  effectiveGridColumns, effectiveGridSpan, flowSpanFromGridSpan, grafanaGridLayoutPlugin,
  gridSpanFromFlowSpan, regenerateGridFallback, resolveGridPlacement, setGridPlacement,
} from '../../src/dashboard/layouts/grafana-grid-layout.js';
import { FLOW_LAYOUT_V1_SCHEMA_ID } from '../../src/dashboard/model/workspace-semantics.js';
import { jsonSchemaValidationService } from '../../src/core/library-codec.js';
import type { DashboardDocumentV1 } from '../../src/generated/json-schema.types.js';

const gridLayout = (items: Record<string, Record<string, unknown>> = {}) => ({ type: 'grafana-grid', version: 1, items });
const doc = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd', title: 'D', revision: 1, layout: gridLayout(), filters: [], tiles: [], ...over,
} as DashboardDocumentV1);

describe('constants', () => {
  it('exposes the grid default placement and max column count', () => {
    expect(GRAFANA_GRID_MAX_COLUMNS).toBe(12);
    expect(DEFAULT_GRID_PLACEMENT).toEqual({ span: 6, height: 'medium' });
  });
});

describe('gridSpanFromFlowSpan / flowSpanFromGridSpan', () => {
  it('maps flow span to grid span', () => {
    expect(gridSpanFromFlowSpan(1)).toBe(4);
    expect(gridSpanFromFlowSpan(2)).toBe(6);
    expect(gridSpanFromFlowSpan(3)).toBe(12);
  });

  it('maps grid span to flow span at each boundary', () => {
    expect(flowSpanFromGridSpan(1)).toBe(1);
    expect(flowSpanFromGridSpan(4)).toBe(1);
    expect(flowSpanFromGridSpan(5)).toBe(2);
    expect(flowSpanFromGridSpan(8)).toBe(2);
    expect(flowSpanFromGridSpan(9)).toBe(3);
    expect(flowSpanFromGridSpan(12)).toBe(3);
  });

  it('treats an invalid/missing grid span as the grid default (6), which maps to flow span 2', () => {
    expect(flowSpanFromGridSpan(undefined)).toBe(2);
    expect(flowSpanFromGridSpan(null)).toBe(2);
    expect(flowSpanFromGridSpan(0)).toBe(2);
    expect(flowSpanFromGridSpan(13)).toBe(2);
    expect(flowSpanFromGridSpan(2.5)).toBe(2);
    expect(flowSpanFromGridSpan('4')).toBe(2);
  });
});

describe('deriveGrafanaGridPlacement', () => {
  it('maps preferred size hints through flow span to grid span', () => {
    expect(deriveGrafanaGridPlacement({ preferred: 'wide' })).toEqual({ span: 12, height: 'medium' });
    expect(deriveGrafanaGridPlacement({ preferred: 'medium' })).toEqual({ span: 6, height: 'medium' });
    expect(deriveGrafanaGridPlacement({ preferred: 'compact' })).toEqual({ span: 4, height: 'medium' });
  });

  it('falls back to the grid default without a usable hint', () => {
    expect(deriveGrafanaGridPlacement(undefined)).toEqual(DEFAULT_GRID_PLACEMENT);
    expect(deriveGrafanaGridPlacement({})).toEqual(DEFAULT_GRID_PLACEMENT);
    expect(deriveGrafanaGridPlacement({ preferred: 'other' })).toEqual(DEFAULT_GRID_PLACEMENT);
  });
});

describe('resolveGridPlacement', () => {
  it('merges a stored placement with the defaults', () => {
    expect(resolveGridPlacement({ span: 4, height: 'large' })).toEqual({ span: 4, height: 'large' });
    expect(resolveGridPlacement({ span: 9 })).toEqual({ span: 9, height: 'medium' });
    expect(resolveGridPlacement({ height: 'compact' })).toEqual({ span: 6, height: 'compact' });
  });

  it('falls back to the defaults for a missing or invalid placement', () => {
    expect(resolveGridPlacement(undefined)).toEqual(DEFAULT_GRID_PLACEMENT);
    expect(resolveGridPlacement({ span: 13, height: 'huge' })).toEqual(DEFAULT_GRID_PLACEMENT);
    expect(resolveGridPlacement({ span: 0 })).toEqual(DEFAULT_GRID_PLACEMENT);
    expect(resolveGridPlacement({ span: 2.5 })).toEqual(DEFAULT_GRID_PLACEMENT);
    expect(resolveGridPlacement('nope')).toEqual(DEFAULT_GRID_PLACEMENT);
  });
});

describe('setGridPlacement', () => {
  it('sets a placement on a grid layout', () => {
    const layout = gridLayout();
    setGridPlacement(layout, 't1', { span: 4 });
    expect(layout.items).toEqual({ t1: { span: 4 } });
  });

  it('creates the items map when the grid layout is missing one', () => {
    const layout: Record<string, unknown> = { type: 'grafana-grid', version: 1 };
    setGridPlacement(layout, 't1', { span: 6 });
    expect(layout.items).toEqual({ t1: { span: 6 } });
  });

  it('is a no-op on a non-object layout', () => {
    expect(() => setGridPlacement(null, 't1', { span: 1 })).not.toThrow();
    expect(() => setGridPlacement(5, 't1', { span: 1 })).not.toThrow();
  });
});

describe('grafanaGridLayoutPlugin', () => {
  it('exposes its identity', () => {
    expect(grafanaGridLayoutPlugin.type).toBe('grafana-grid');
    expect(grafanaGridLayoutPlugin.version).toBe(1);
  });

  describe('normalize', () => {
    it('prunes placements that no longer name a tile, without mutating the input', () => {
      const input = doc({ tiles: [{ id: 't1', queryId: 'q' }] as never, layout: gridLayout({ t1: { span: 4 }, ghost: {} }) });
      const result = grafanaGridLayoutPlugin.normalize(input);
      expect(result.layout.items).toEqual({ t1: { span: 4 } });
      expect((input.layout.items as Record<string, unknown>).ghost).toBeDefined(); // input untouched
    });

    it('creates the items map when missing and tolerates a non-object layout', () => {
      const noItems = doc({ tiles: [{ id: 't1', queryId: 'q' }] as never, layout: { type: 'grafana-grid', version: 1 } as never });
      expect(grafanaGridLayoutPlugin.normalize(noItems).layout.items).toEqual({});

      const notObject = doc({ tiles: [{ id: 't1', queryId: 'q' }] as never, layout: null as never });
      expect(() => grafanaGridLayoutPlugin.normalize(notObject)).not.toThrow();
      expect(grafanaGridLayoutPlugin.normalize(notObject).layout).toBeNull();
    });

    it('tolerates a non-array tiles field — every placement becomes an orphan', () => {
      const noTiles = doc({ tiles: undefined as never, layout: gridLayout({ ghost: {} }) });
      expect(grafanaGridLayoutPlugin.normalize(noTiles).layout.items).toEqual({});
    });
  });

  describe('validatePlacement', () => {
    it('accepts a valid placement, including partials', () => {
      expect(grafanaGridLayoutPlugin.validatePlacement({ span: 4, height: 'large' })).toEqual([]);
      expect(grafanaGridLayoutPlugin.validatePlacement({ span: 12 })).toEqual([]);
      expect(grafanaGridLayoutPlugin.validatePlacement({ height: 'compact' })).toEqual([]);
      expect(grafanaGridLayoutPlugin.validatePlacement({})).toEqual([]);
    });

    it('rejects a non-object placement', () => {
      const diagnostics = grafanaGridLayoutPlugin.validatePlacement('nope', ['layout', 'items', 't1']);
      expect(diagnostics.map((d) => d.code)).toEqual(['layout-placement-invalid']);
      expect(diagnostics[0].path).toEqual(['layout', 'items', 't1']);
    });

    it('rejects unknown fields and invalid span/height', () => {
      const diagnostics = grafanaGridLayoutPlugin.validatePlacement({ span: 13, height: 'huge', bogus: true });
      const codes = diagnostics.map((d) => d.code);
      expect(codes).toContain('layout-placement-unknown-field');
      expect(codes).toContain('layout-placement-invalid-span');
      expect(codes).toContain('layout-placement-invalid-height');
    });

    it('rejects a span of 0, a non-integer span, and a too-large span', () => {
      expect(grafanaGridLayoutPlugin.validatePlacement({ span: 0 }).map((d) => d.code))
        .toContain('layout-placement-invalid-span');
      expect(grafanaGridLayoutPlugin.validatePlacement({ span: 2.5 }).map((d) => d.code))
        .toContain('layout-placement-invalid-span');
      expect(grafanaGridLayoutPlugin.validatePlacement({ span: 13 }).map((d) => d.code))
        .toContain('layout-placement-invalid-span');
    });

    it('uses the default empty path', () => {
      expect(grafanaGridLayoutPlugin.validatePlacement('nope')[0].path).toEqual([]);
    });
  });
});

describe('effectiveGridColumns', () => {
  it('maps container width to the responsive breakpoints', () => {
    expect(effectiveGridColumns(1160)).toBe(12);
    expect(effectiveGridColumns(2000)).toBe(12);
    expect(effectiveGridColumns(1159)).toBe(6);
    expect(effectiveGridColumns(720)).toBe(6);
    expect(effectiveGridColumns(719)).toBe(4);
    expect(effectiveGridColumns(470)).toBe(4);
    expect(effectiveGridColumns(469)).toBe(2);
    expect(effectiveGridColumns(0)).toBe(2);
  });

  it('defaults to the widest breakpoint (12) for an absent or non-finite width', () => {
    expect(effectiveGridColumns(undefined)).toBe(12);
    expect(effectiveGridColumns(NaN)).toBe(12);
    expect(effectiveGridColumns(Infinity)).toBe(12);
    expect(effectiveGridColumns('1200')).toBe(12);
  });
});

describe('effectiveGridSpan', () => {
  it('clamps the stored span to the active column count (min)', () => {
    expect(effectiveGridSpan(12, 12)).toBe(12);
    expect(effectiveGridSpan(12, 4)).toBe(4);
    expect(effectiveGridSpan(3, 2)).toBe(2);
  });

  it('treats an absent/invalid stored span as the default (6)', () => {
    expect(effectiveGridSpan(undefined, 12)).toBe(6);
    expect(effectiveGridSpan(13, 12)).toBe(6);
    expect(effectiveGridSpan('2', 12)).toBe(6);
  });

  it('never returns less than one even with a zero column count', () => {
    expect(effectiveGridSpan(6, 0)).toBe(1);
  });
});

describe('computeGrafanaGridLayout', () => {
  const tiles = (...ids: string[]) => ids.map((id) => ({ id }));

  it('defaults a missing placement to span 6, medium height, at the widest breakpoint', () => {
    const model = computeGrafanaGridLayout({ tiles: tiles('a'), layout: gridLayout() });
    expect(model.engine).toBe('grafana-grid');
    expect(model.columns).toBe(12);
    expect(model.tiles[0]).toMatchObject({ tileId: 'a', span: 6, height: 'medium', row: 0, colStart: 0 });
  });

  it('clamps effective span per responsive breakpoint without mutating stored spans', () => {
    const layout = gridLayout({ a: { span: 12 } });
    const model = computeGrafanaGridLayout({ tiles: tiles('a'), layout, containerWidth: 470 });
    expect(model.columns).toBe(4);
    expect(model.tiles[0].span).toBe(4); // 12 clamped to 4
    expect(layout.items.a.span).toBe(12); // persisted span untouched
  });

  it('packs tiles row-major, wrapping to a new row when the next span does not fit, with no overlaps', () => {
    // 12 columns, spans [8, 8, 4]: row0 = [8] (remaining 4 < 8 → wrap), row1 = [8], row2 = [4]
    const layout = gridLayout({ a: { span: 8 }, b: { span: 8 }, c: { span: 4 } });
    const model = computeGrafanaGridLayout({ tiles: tiles('a', 'b', 'c'), layout, containerWidth: 1200 });
    expect(model.tiles.map((t) => [t.tileId, t.row, t.colStart])).toEqual([
      ['a', 0, 0], ['b', 1, 0], ['c', 1, 8],
    ]);
    for (const render of model.tiles) expect(render.colStart + render.span).toBeLessThanOrEqual(model.columns);
  });

  it('packs several small tiles into the same row until it is full', () => {
    const layout = gridLayout({ a: { span: 4 }, b: { span: 4 }, c: { span: 4 }, d: { span: 4 } });
    const model = computeGrafanaGridLayout({ tiles: tiles('a', 'b', 'c', 'd'), layout, containerWidth: 1200 });
    expect(model.tiles.map((t) => t.row)).toEqual([0, 0, 0, 1]);
    expect(model.tiles.map((t) => t.colStart)).toEqual([0, 4, 8, 0]);
  });

  it('places KPI tiles exactly like any other tile — no banding', () => {
    const layout = gridLayout({ k1: { span: 4 }, t1: { span: 4 }, k2: { span: 4 } });
    const model = computeGrafanaGridLayout({
      tiles: [{ id: 'k1', isKpi: true }, { id: 't1' }, { id: 'k2', isKpi: true }],
      layout, containerWidth: 1200,
    });
    expect(model.tiles.map((t) => [t.tileId, t.isKpi, t.row])).toEqual([['k1', true, 0], ['t1', false, 0], ['k2', true, 0]]);
  });

  it('keeps semantic tiles[] order as the model order, ignoring items for unknown tile ids', () => {
    const layout = gridLayout({ a: { span: 4 }, ghost: { span: 12 } });
    const model = computeGrafanaGridLayout({ tiles: tiles('a'), layout });
    expect(model.order).toEqual(['a']);
    expect(model.tiles).toHaveLength(1);
  });

  it('falls back to defaults for an invalid persisted span/height', () => {
    const layout = gridLayout({ a: { span: 99, height: 'huge' } });
    const model = computeGrafanaGridLayout({ tiles: tiles('a'), layout });
    expect(model.tiles[0]).toMatchObject({ span: 6, height: 'medium' });
  });

  it('handles an empty tile list', () => {
    const model = computeGrafanaGridLayout({ tiles: [], layout: gridLayout() });
    expect(model.tiles).toEqual([]);
    expect(model.order).toEqual([]);
  });

  it('tolerates a non-object layout — every tile renders at the grid default', () => {
    const model = computeGrafanaGridLayout({ tiles: tiles('a', 'b'), layout: null });
    expect(model.tiles.map((t) => t.span)).toEqual([6, 6]);
  });
});

describe('deriveFlowFallback', () => {
  it('maps each tile\'s grid span/height to its flow equivalent', () => {
    const layout = gridLayout({
      a: { span: 4, height: 'compact' }, b: { span: 8, height: 'large' }, c: { span: 12 },
    });
    const fallback = deriveFlowFallback(layout, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(fallback).toEqual({
      type: 'flow', version: 1, preset: 'full-width',
      items: {
        a: { span: 1, height: 'compact' },
        b: { span: 2, height: 'large' },
        c: { span: 3, height: 'medium' },
      },
    });
  });

  it('resolves a tile with no persisted grid placement to the grid default (span 6 → flow span 2)', () => {
    const fallback = deriveFlowFallback(gridLayout(), [{ id: 't1' }]);
    expect(fallback.items).toEqual({ t1: { span: 2, height: 'medium' } });
  });

  it('handles an empty tile list and a non-object layout', () => {
    expect(deriveFlowFallback(gridLayout(), [])).toEqual({ type: 'flow', version: 1, preset: 'full-width', items: {} });
    const fallback = deriveFlowFallback(null, [{ id: 't1' }]);
    expect(fallback.items).toEqual({ t1: { span: 2, height: 'medium' } });
  });

  it('always produces a document that validates cleanly as a flow@1 layout', () => {
    const layout = gridLayout({ a: { span: 1, height: 'huge' as never }, b: {} });
    const fallback = deriveFlowFallback(layout, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(jsonSchemaValidationService.validate(FLOW_LAYOUT_V1_SCHEMA_ID, fallback)).toEqual([]);
  });
});

describe('regenerateGridFallback', () => {
  it('mutates a grafana-grid layout\'s fallback in place, deterministically from its current items', () => {
    const layout = gridLayout({ a: { span: 4, height: 'compact' } });
    regenerateGridFallback(layout, [{ id: 'a' }, { id: 'b' }]);
    expect((layout as { fallback?: unknown }).fallback).toEqual({
      type: 'flow', version: 1, preset: 'full-width',
      items: { a: { span: 1, height: 'compact' }, b: { span: 2, height: 'medium' } },
    });
  });

  it('overwrites a stale fallback already present on the layout', () => {
    const layout = { ...gridLayout({ a: { span: 12 } }), fallback: { type: 'flow', version: 1, preset: 'report', items: {} } };
    regenerateGridFallback(layout, [{ id: 'a' }]);
    expect(layout.fallback).toEqual({ type: 'flow', version: 1, preset: 'full-width', items: { a: { span: 3, height: 'medium' } } });
  });

  it('is a no-op on a non-grid layout or a non-object value', () => {
    const flow = { type: 'flow', version: 1, preset: 'full-width', items: {} };
    regenerateGridFallback(flow, [{ id: 'a' }]);
    expect(flow).not.toHaveProperty('fallback');
    expect(() => regenerateGridFallback(null, [{ id: 'a' }])).not.toThrow();
    expect(() => regenerateGridFallback('nope', [{ id: 'a' }])).not.toThrow();
  });
});
