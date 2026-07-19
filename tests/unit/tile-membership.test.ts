import { describe, expect, it } from 'vitest';
import {
  createEmptyDashboardDocument, syncFavoriteTileMembership, toggleTileMembership,
} from '../../src/dashboard/application/tile-membership.js';
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
  layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
  filters: [], tiles: [], ...over,
} as DashboardDocumentV1);

const genTileId = (): (() => string) => {
  let n = 0;
  return () => 'tile-' + (++n);
};

describe('toggleTileMembership', () => {
  it('#307: star ON on a panel-role query with no Dashboard creates a fresh Dashboard with one tile', () => {
    const next = toggleTileMembership(null, panelQuery('p1'), true, genTileId())!;
    expect(next).not.toBeNull();
    expect(next.tiles).toEqual([{ id: 'tile-2', queryId: 'p1' }]);
    expect(next.id).toBe('tile-1'); // genDashboardId defaults to genTileId — called once for the doc
    expect(next.documentVersion).toBe(1);
    expect(next.layout).toEqual({ type: 'flow', version: 1, preset: 'full-width', items: {} });
    expect(next.filters).toEqual([]);
  });

  it('#307: a caller-supplied genDashboardId mints the Dashboard id, separate from genTileId', () => {
    const genDashboardId = (): (() => string) => {
      let n = 0;
      return () => 'dash-' + (++n);
    };
    const next = toggleTileMembership(null, panelQuery('p1'), true, genTileId(), genDashboardId())!;
    expect(next.id).toBe('dash-1');
    expect(next.tiles).toEqual([{ id: 'tile-1', queryId: 'p1' }]);
  });

  it('null dashboard in + star ON on a filter/setup-role query → null out (nothing to create)', () => {
    expect(toggleTileMembership(null, filterQuery('f1'), true, genTileId())).toBeNull();
  });

  it('null dashboard in + star OFF → null out (favorite flip only, nothing to remove)', () => {
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
      layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: { span: 2, height: 'large' } } },
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
      type: 'flow', version: 1, preset: 'full-width', items: { 'tile-1': { span: 2, height: 'medium' } },
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
      type: 'flow', version: 1, preset: 'full-width', items: {},
    });
  });
});

describe('createEmptyDashboardDocument', () => {
  it('builds a fresh empty flow@1 Dashboard at revision 1 with the given id', () => {
    expect(createEmptyDashboardDocument('d1')).toEqual({
      documentVersion: 1, id: 'd1', title: 'Dashboard', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
      filters: [], tiles: [],
    });
  });
});

describe('syncFavoriteTileMembership (#307)', () => {
  const favorite = (query: SavedQueryV2): SavedQueryV2 => ({
    ...query, spec: { ...query.spec, favorite: true },
  });

  it('null dashboard + no favorited panel-role queries → stays null', () => {
    expect(syncFavoriteTileMembership(null, [filterQuery('f1'), noRoleQuery('p1')], genTileId())).toBeNull();
  });

  it('null dashboard + a favorited panel-role query → creates a Dashboard with one tile', () => {
    const next = syncFavoriteTileMembership(null, [favorite(panelQuery('p1'))], genTileId())!;
    expect(next).not.toBeNull();
    expect(next.tiles).toEqual([{ id: 'tile-2', queryId: 'p1' }]);
    expect(next.id).toBe('tile-1');
  });

  it('adds tiles only for favorited panel-role queries missing one, in queries order', () => {
    const next = syncFavoriteTileMembership(dashboard(), [
      favorite(panelQuery('p1')),
      favorite(filterQuery('f1')), // favorited but filter-role — never gets a tile
      panelQuery('p2'), // panel-role but not favorited — no tile
      favorite(panelQuery('p3')),
    ], genTileId())!;
    expect(next.tiles).toEqual([
      { id: 'tile-1', queryId: 'p1' },
      { id: 'tile-2', queryId: 'p3' },
    ]);
  });

  it('is idempotent — a second call with the same inputs is a no-op', () => {
    const first = syncFavoriteTileMembership(dashboard(), [favorite(panelQuery('p1'))], genTileId())!;
    const second = syncFavoriteTileMembership(first, [favorite(panelQuery('p1'))], genTileId())!;
    expect(second.tiles).toEqual(first.tiles);
  });

  it('never removes an existing tile, even for a now-unfavorited or now-missing query', () => {
    const d = dashboard({ tiles: [{ id: 'keep', queryId: 'gone' }] });
    const next = syncFavoriteTileMembership(d, [favorite(panelQuery('p1'))], genTileId())!;
    expect(next.tiles).toEqual([
      { id: 'keep', queryId: 'gone' },
      { id: 'tile-1', queryId: 'p1' },
    ]);
  });

  it('preserves an existing Dashboard\'s layout/filters/title when adding a tile', () => {
    const d = dashboard({
      title: 'My dash',
      layout: { type: 'flow', version: 1, preset: 'report', items: { keep: { span: 2, height: 'large' } } },
      tiles: [{ id: 'keep', queryId: 'other' }],
      filters: [{ id: 'flt1', parameter: 'x' }],
    });
    const next = syncFavoriteTileMembership(d, [favorite(panelQuery('p1'))], genTileId())!;
    expect(next.title).toBe('My dash');
    expect(next.filters).toEqual([{ id: 'flt1', parameter: 'x' }]);
    expect((next.layout as { items: Record<string, unknown> }).items).toEqual({ keep: { span: 2, height: 'large' } });
  });

  it('never mutates the input dashboard or queries', () => {
    const d = dashboard({ tiles: [{ id: 't1', queryId: 'other' }] });
    const snapshot = JSON.parse(JSON.stringify(d));
    syncFavoriteTileMembership(d, [favorite(panelQuery('p1'))], genTileId());
    expect(d).toEqual(snapshot);
  });

  it('a no-op call (nothing missing) returns the SAME dashboard reference', () => {
    const d = dashboard({ tiles: [{ id: 't1', queryId: 'p1' }] });
    const next = syncFavoriteTileMembership(d, [favorite(panelQuery('p1'))], genTileId());
    expect(next).toBe(d);
  });
});
