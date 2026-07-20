import { describe, expect, it } from 'vitest';
import { toggleTileMembership } from '../../src/dashboard/application/tile-membership.js';
import type { DashboardDocumentV1, SavedQueryV2 } from '../../src/generated/json-schema.types.js';

const panelQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, dashboard: { role: 'panel' } },
} as SavedQueryV2);
const filterQuery = (id: string): SavedQueryV2 => ({
  id, sql: "SELECT ['a'] AS x", specVersion: 1, spec: { name: id, dashboard: { role: 'filter' } },
} as SavedQueryV2);
const noRoleQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id },
} as SavedQueryV2);

const dashboard = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'dash', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
} as DashboardDocumentV1);

const genTileId = (): (() => string) => {
  let n = 0;
  return () => 'tile-' + (++n);
};

describe('toggleTileMembership', () => {
  it('null dashboard in → null out (no Dashboard yet, favorite flip only)', () => {
    expect(toggleTileMembership(null, panelQuery('p1'), true, genTileId())).toBeNull();
    expect(toggleTileMembership(null, panelQuery('p1'), false, genTileId())).toBeNull();
  });

  it('star ON on a panel-role query with no existing tile appends one', () => {
    const next = toggleTileMembership(dashboard(), panelQuery('p1'), true, genTileId())!;
    expect(next.tiles).toEqual([{ id: 'tile-1', queryId: 'p1' }]);
  });

  it('a query with no declared role defaults to panel (mirrors queryDashboardRole)', () => {
    const next = toggleTileMembership(dashboard(), noRoleQuery('p1'), true, genTileId())!;
    expect(next.tiles).toEqual([{ id: 'tile-1', queryId: 'p1' }]);
  });

  it('star ON is idempotent when a tile already references the query', () => {
    const d = dashboard({ tiles: [{ id: 't1', queryId: 'p1' }] });
    const next = toggleTileMembership(d, panelQuery('p1'), true, genTileId())!;
    expect(next.tiles).toEqual([{ id: 't1', queryId: 'p1' }]);
  });

  it('star ON on a filter-role query creates no tile (favorite flip only)', () => {
    const next = toggleTileMembership(dashboard(), filterQuery('f1'), true, genTileId())!;
    expect(next.tiles).toEqual([]);
  });

  it('star ON on a setup-role query creates no tile', () => {
    const setupQuery: SavedQueryV2 = {
      id: 's1', sql: 'CREATE TABLE t (x Int32) ENGINE=Memory', specVersion: 1,
      spec: { name: 's1', dashboard: { role: 'setup' } },
    } as SavedQueryV2;
    const next = toggleTileMembership(dashboard(), setupQuery, true, genTileId())!;
    expect(next.tiles).toEqual([]);
  });

  it('star OFF removes every tile referencing the query and scrubs filter targets', () => {
    const d = dashboard({
      tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p1' }, { id: 't3', queryId: 'p2' }],
      filters: [
        { id: 'flt1', parameter: 'x', targets: ['t1', 't3'] },
        { id: 'flt2', parameter: 'y', targets: ['t2'] },
        { id: 'flt3', parameter: 'z' }, // no targets — untouched
      ],
    });
    const next = toggleTileMembership(d, panelQuery('p1'), false, genTileId())!;
    expect(next.tiles).toEqual([{ id: 't3', queryId: 'p2' }]);
    expect(next.filters).toEqual([
      { id: 'flt1', parameter: 'x', targets: ['t3'] },
      { id: 'flt2', parameter: 'y', targets: [] },
      { id: 'flt3', parameter: 'z' },
    ]);
  });

  it('star OFF on a query with no tile is a no-op', () => {
    const d = dashboard({ tiles: [{ id: 't1', queryId: 'other' }] });
    const next = toggleTileMembership(d, panelQuery('p1'), false, genTileId())!;
    expect(next.tiles).toEqual([{ id: 't1', queryId: 'other' }]);
  });

  it('never mutates the input dashboard', () => {
    const d = dashboard({ tiles: [{ id: 't1', queryId: 'p1' }] });
    const snapshot = JSON.parse(JSON.stringify(d));
    toggleTileMembership(d, panelQuery('p1'), false, genTileId());
    expect(d).toEqual(snapshot);
  });

  it('normalizes the result — a removed tile drops its layout placement, a new tile gets none stored', () => {
    const d = dashboard({
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: { span: 2, height: 'large' } } },
      tiles: [{ id: 't1', queryId: 'p1' }],
    });
    const removed = toggleTileMembership(d, panelQuery('p1'), false, genTileId())!;
    expect((removed.layout as { items: Record<string, unknown> }).items).toEqual({});

    const added = toggleTileMembership(dashboard(), panelQuery('p2'), true, genTileId())!;
    expect((added.layout as { items: Record<string, unknown> }).items).toEqual({});
  });
});

describe('toggleTileMembership — grafana-grid@1 engine awareness (#291)', () => {
  it('normalizes through the ACTIVE grid plugin (not a hardcoded flow one) and regenerates the flow@1 fallback on star ON', () => {
    const d = dashboard({ layout: { type: 'grafana-grid', version: 1, items: {} } });
    const next = toggleTileMembership(d, panelQuery('p1'), true, genTileId())!;
    expect(next.layout.type).toBe('grafana-grid');
    expect(next.tiles).toEqual([{ id: 'tile-1', queryId: 'p1' }]);
    // No explicit grid placement is seeded here either (parity with flow's own
    // pre-#291 behavior) — the new tile resolves to the grid default (span 6)
    // at render time, which the regenerated fallback reflects (flow span 2).
    expect((next.layout as { items: Record<string, unknown> }).items).toEqual({});
    expect((next.layout as { fallback?: unknown }).fallback).toEqual({
      type: 'flow', version: 1, preset: 'columns-2', items: { 'tile-1': { span: 2, height: 'medium' } },
    });
  });

  it('regenerates the flow@1 fallback (dropping the removed tile) on star OFF', () => {
    const d = dashboard({
      layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 12 } } },
      tiles: [{ id: 't1', queryId: 'p1' }],
    });
    const next = toggleTileMembership(d, panelQuery('p1'), false, genTileId())!;
    expect(next.tiles).toEqual([]);
    expect((next.layout as { items: Record<string, unknown> }).items).toEqual({});
    expect((next.layout as { fallback?: unknown }).fallback).toEqual({
      type: 'flow', version: 1, preset: 'columns-2', items: {},
    });
  });
});
