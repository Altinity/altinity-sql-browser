import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW_PLACEMENT, deriveFlowPlacement, flowLayoutPlugin,
  resolveActiveLayoutPlugin, setFlowPlacement,
} from '../../src/dashboard/layouts/flow-layout.js';
import type { DashboardDocumentV1 } from '../../src/generated/json-schema.types.js';

const flowLayout = (items: Record<string, Record<string, unknown>> = {}) => ({ type: 'flow', version: 1, preset: 'full-width', items });
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
    const layout: Record<string, unknown> = { type: 'flow', version: 1, preset: 'full-width' };
    setFlowPlacement(layout, 't1', { span: 1 });
    expect(layout.items).toEqual({ t1: { span: 1 } });
  });

  it('targets a valid flow@1 fallback of an unsupported layout', () => {
    const layout: Record<string, unknown> = { type: 'grid', version: 9, fallback: flowLayout() };
    setFlowPlacement(layout, 't1', { span: 3 });
    expect((layout.fallback as { items: unknown }).items).toEqual({ t1: { span: 3 } });
  });

  it('creates the items map on a fallback that lacks one', () => {
    const layout: Record<string, unknown> = { type: 'grid', version: 9, fallback: { type: 'flow', version: 1, preset: 'full-width' } };
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

describe('resolveActiveLayoutPlugin', () => {
  it('loads flow@1 and unsupported-with-valid-fallback layouts', () => {
    expect(resolveActiveLayoutPlugin(flowLayout()).ok).toBe(true);
    expect(resolveActiveLayoutPlugin({ type: 'grid', version: 9, fallback: flowLayout() }).ok).toBe(true);
    expect(flowLayoutPlugin.type).toBe('flow');
    expect(flowLayoutPlugin.version).toBe(1);
  });

  it('fails for an unsupported layout without a valid fallback and for a non-object layout', () => {
    const noFallback = resolveActiveLayoutPlugin({ type: 'grid', version: 9 });
    expect(noFallback.ok).toBe(false);
    if (!noFallback.ok) expect(noFallback.diagnostics[0].code).toBe('dashboard-layout-load-failed');
    expect(resolveActiveLayoutPlugin(null).ok).toBe(false);
    expect(resolveActiveLayoutPlugin({ type: 'grid', version: 9, fallback: { type: 'flow', version: 2 } }).ok).toBe(false);
  });
});
