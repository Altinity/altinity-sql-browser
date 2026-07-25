import { describe, expect, it } from 'vitest';
import {
  buildQueryOwnershipIndex, cloneQueryForDashboardOwner, libraryQueries,
  MultipleOwnersError, ownerOfQuery, ownersOfQuery,
  type OwnershipDashboard, type OwnershipWorkspace,
} from '../../src/dashboard/model/query-ownership.js';
import type { QuerySpecV1, SavedQueryV2 } from '../../src/generated/json-schema.types.js';

const query = (id: string, spec: Partial<QuerySpecV1> = {}): SavedQueryV2 => ({
  id, sql: `SELECT ${id}`, specVersion: 1, spec: { name: id.toUpperCase(), ...spec } as QuerySpecV1,
});

const dashboard = (
  id: string, tiles: readonly string[], filterSources: readonly (string | null)[] = [],
): OwnershipDashboard => ({
  id,
  tiles: tiles.map((queryId, index) => ({ id: `${id}-t${index}`, queryId })),
  filters: filterSources.map((sourceQueryId, index) => (sourceQueryId === null
    // A PLAIN filter — a date or free-text control with no option list. It owns
    // nothing, so it must not appear in the index at all.
    ? { id: `${id}-f${index}` }
    : { id: `${id}-f${index}`, sourceQueryId })),
});

const workspace = (
  queries: readonly SavedQueryV2[], dashboards: readonly OwnershipDashboard[],
): OwnershipWorkspace => ({ queries, dashboards });

describe('buildQueryOwnershipIndex', () => {
  it('partitions existing queries into Library (zero owners) and owned (one owner)', () => {
    const index = buildQueryOwnershipIndex(workspace(
      [query('standalone'), query('panel-copy'), query('filter-copy')],
      [dashboard('d1', ['panel-copy'], ['filter-copy'])],
    ));
    expect([...index.libraryQueryIds]).toEqual(['standalone']);
    expect([...index.dashboardOwnedQueryIds].sort()).toEqual(['filter-copy', 'panel-copy']);
    expect(index.ownersByQueryId.get('panel-copy')).toEqual([
      { kind: 'panel', dashboardId: 'd1', tileId: 'd1-t0' },
    ]);
    expect(index.ownersByQueryId.get('filter-copy')).toEqual([
      { kind: 'filter', dashboardId: 'd1', filterId: 'd1-f0' },
    ]);
    expect(index.ownersByQueryId.has('standalone')).toBe(false);
  });

  it('derives ownership ONLY from references — a favourite or a role owns nothing', () => {
    // The whole point of #427: membership is a Dashboard reference, never a flag
    // on the query. A favourited, filter-role query with no reference to it is a
    // Library query like any other.
    const index = buildQueryOwnershipIndex(workspace(
      [query('starred', { favorite: true, dashboard: { role: 'filter' } })],
      [dashboard('d1', [])],
    ));
    expect([...index.libraryQueryIds]).toEqual(['starred']);
    expect(index.dashboardOwnedQueryIds.size).toBe(0);
  });

  it('orders owners by Dashboard, then FILTERS before TILES — the migration order', () => {
    // `owners[0]` has to mean the same member here and in the migration, because
    // validation reports "every owner after the first".
    const owners = buildQueryOwnershipIndex(workspace(
      [query('shared')],
      [dashboard('d1', ['shared'], ['shared']), dashboard('d2', ['shared'], ['shared'])],
    )).ownersByQueryId.get('shared');
    expect(owners).toEqual([
      { kind: 'filter', dashboardId: 'd1', filterId: 'd1-f0' },
      { kind: 'panel', dashboardId: 'd1', tileId: 'd1-t0' },
      { kind: 'filter', dashboardId: 'd2', filterId: 'd2-f0' },
      { kind: 'panel', dashboardId: 'd2', tileId: 'd2-t0' },
    ]);
  });

  it('records every sharing shape as multiple owners, and keeps the query out of Library', () => {
    const twoPanels = buildQueryOwnershipIndex(workspace(
      [query('q')], [dashboard('d1', ['q', 'q'])],
    ));
    expect(twoPanels.ownersByQueryId.get('q')).toHaveLength(2);
    expect(twoPanels.libraryQueryIds.size).toBe(0);
    expect([...twoPanels.dashboardOwnedQueryIds]).toEqual(['q']);

    const twoFilters = buildQueryOwnershipIndex(workspace(
      [query('q')], [dashboard('d1', [], ['q', 'q'])],
    ));
    expect(twoFilters.ownersByQueryId.get('q')).toHaveLength(2);

    const crossDashboard = buildQueryOwnershipIndex(workspace(
      [query('q')], [dashboard('d1', ['q']), dashboard('d2', ['q'])],
    ));
    expect(crossDashboard.ownersByQueryId.get('q')).toEqual([
      { kind: 'panel', dashboardId: 'd1', tileId: 'd1-t0' },
      { kind: 'panel', dashboardId: 'd2', tileId: 'd2-t0' },
    ]);
  });

  it('a plain filter owns nothing', () => {
    const index = buildQueryOwnershipIndex(workspace(
      [query('q')], [dashboard('d1', [], [null, null])],
    ));
    expect(index.ownersByQueryId.size).toBe(0);
    expect([...index.libraryQueryIds]).toEqual(['q']);
  });

  it('keeps a DANGLING reference as an owner while joining neither partition', () => {
    // Ownership reports what the document says; a reference to a query that does
    // not exist stays the separate cross-resource diagnostic it already is.
    const index = buildQueryOwnershipIndex(workspace(
      [query('present')], [dashboard('d1', ['gone'], ['also-gone'])],
    ));
    expect(index.ownersByQueryId.get('gone')).toEqual([
      { kind: 'panel', dashboardId: 'd1', tileId: 'd1-t0' },
    ]);
    expect(index.ownersByQueryId.has('also-gone')).toBe(true);
    expect(index.libraryQueryIds.has('gone')).toBe(false);
    expect(index.dashboardOwnedQueryIds.has('gone')).toBe(false);
    // The query that does exist is unaffected.
    expect([...index.libraryQueryIds]).toEqual(['present']);
  });

  it('is empty for a workspace with no Dashboards and no queries', () => {
    const index = buildQueryOwnershipIndex(workspace([], []));
    expect(index.ownersByQueryId.size).toBe(0);
    expect(index.libraryQueryIds.size).toBe(0);
    expect(index.dashboardOwnedQueryIds.size).toBe(0);
  });
});

describe('libraryQueries', () => {
  it('keeps the original workspace.queries[] relative order', () => {
    const ws = workspace(
      [query('a'), query('owned'), query('b'), query('c')],
      [dashboard('d1', ['owned'])],
    );
    expect(libraryQueries(ws).map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns the queries themselves, not copies', () => {
    const entry = query('a');
    expect(libraryQueries(workspace([entry], []))[0]).toBe(entry);
  });

  it('is empty when every query is owned', () => {
    // The real shape of `examples/iceberg-catalog-dashboard.json` before
    // migration: every query referenced by exactly one tile.
    const ws = workspace(
      [query('q1'), query('q2')], [dashboard('d1', ['q1', 'q2'])],
    );
    expect(libraryQueries(ws)).toEqual([]);
  });
});

describe('ownersOfQuery', () => {
  it('is empty for a Library query and for an id no member references', () => {
    const ws = workspace([query('a')], [dashboard('d1', [])]);
    expect(ownersOfQuery(ws, 'a')).toEqual([]);
    expect(ownersOfQuery(ws, 'never-heard-of-it')).toEqual([]);
  });

  it('lists every owner of a shared query', () => {
    const ws = workspace([query('q')], [dashboard('d1', ['q']), dashboard('d2', ['q'])]);
    expect(ownersOfQuery(ws, 'q')).toHaveLength(2);
  });
});

describe('ownerOfQuery', () => {
  it('is null for a Library query', () => {
    expect(ownerOfQuery(workspace([query('a')], []), 'a')).toBeNull();
  });

  it('returns the single panel or filter owner', () => {
    const ws = workspace(
      [query('p'), query('f')], [dashboard('d1', ['p'], ['f'])],
    );
    expect(ownerOfQuery(ws, 'p')).toEqual({ kind: 'panel', dashboardId: 'd1', tileId: 'd1-t0' });
    expect(ownerOfQuery(ws, 'f')).toEqual({ kind: 'filter', dashboardId: 'd1', filterId: 'd1-f0' });
  });

  it('REFUSES to pick when a query has more than one owner', () => {
    // Picking would hand the caller an arbitrary Dashboard to mutate; #427
    // requires diagnosing the state instead.
    const ws = workspace([query('q')], [dashboard('d1', ['q']), dashboard('d2', ['q'])]);
    expect(() => ownerOfQuery(ws, 'q')).toThrow(MultipleOwnersError);
    try {
      ownerOfQuery(ws, 'q');
      expect.unreachable('ownerOfQuery must throw for two owners');
    } catch (error) {
      const failure = error as MultipleOwnersError;
      expect(failure.name).toBe('MultipleOwnersError');
      expect(failure.queryId).toBe('q');
      expect(failure.owners).toHaveLength(2);
      expect(failure.message).toContain('"q"');
      expect(failure.message).toContain('2 Dashboard owners');
    }
  });
});

describe('cloneQueryForDashboardOwner', () => {
  it('sets the owner role and clears the favourite, preserving everything else', () => {
    const source = query('src', {
      favorite: true,
      description: 'kept',
      view: 'panel',
      panel: { cfg: { type: 'timeseries' } },
    });
    const clone = cloneQueryForDashboardOwner({ source, newId: 'own-1', role: 'panel' });

    expect(clone.id).toBe('own-1');
    expect(clone.sql).toBe('SELECT src');
    expect(clone.specVersion).toBe(1);
    expect(clone.spec.dashboard).toEqual({ role: 'panel' });
    expect(Object.hasOwn(clone.spec, 'favorite')).toBe(false);
    expect(clone.spec.name).toBe('SRC');
    expect(clone.spec.description).toBe('kept');
    expect(clone.spec.view).toBe('panel');
    expect(clone.spec.panel).toEqual({ cfg: { type: 'timeseries' } });
    // The source is untouched — its favourite is the Library preference it was.
    expect(source.spec.favorite).toBe(true);
    expect(source.id).toBe('src');
  });

  it('mints a filter-role copy', () => {
    const clone = cloneQueryForDashboardOwner({
      source: query('src'), newId: 'own-2', role: 'filter',
    });
    expect(clone.spec.dashboard).toEqual({ role: 'filter' });
  });

  it('retains sibling spec.dashboard fields while overwriting only the role', () => {
    const source = query('src', {
      dashboard: { role: 'panel', variants: { small: { view: 'table' } } },
    });
    const clone = cloneQueryForDashboardOwner({ source, newId: 'own-3', role: 'filter' });
    expect(clone.spec.dashboard).toEqual({ role: 'filter', variants: { small: { view: 'table' } } });
  });

  it('preserves unknown forward-compatible Spec fields', () => {
    const source = query('src', { futureThing: { nested: [1, 2] } } as unknown as Partial<QuerySpecV1>);
    const clone = cloneQueryForDashboardOwner({ source, newId: 'own-4', role: 'panel' });
    expect((clone.spec as Record<string, unknown>).futureThing).toEqual({ nested: [1, 2] });
  });

  it('is a deep copy — mutating the clone cannot reach the source', () => {
    const source = query('src', { panel: { cfg: { type: 'timeseries' } } });
    const clone = cloneQueryForDashboardOwner({ source, newId: 'own-5', role: 'panel' });
    clone.spec.panel!.cfg!.type = 'stat';
    expect(source.spec.panel!.cfg!.type).toBe('timeseries');
  });

  it('leaves a source with no favourite and no dashboard block alone apart from the role', () => {
    const clone = cloneQueryForDashboardOwner({
      source: query('bare'), newId: 'own-6', role: 'panel',
    });
    expect(Object.hasOwn(clone.spec, 'favorite')).toBe(false);
    expect(clone.spec.dashboard).toEqual({ role: 'panel' });
    expect(clone.spec.name).toBe('BARE');
  });

  it('a clone of a clone is owned by exactly one member each', () => {
    // #427: copying one Library query into two Dashboard members creates two
    // INDEPENDENT copies — never one shared query.
    const source = query('src');
    const first = cloneQueryForDashboardOwner({ source, newId: 'own-a', role: 'panel' });
    const second = cloneQueryForDashboardOwner({ source, newId: 'own-b', role: 'panel' });
    const index = buildQueryOwnershipIndex(workspace(
      [source, first, second],
      [dashboard('d1', ['own-a']), dashboard('d2', ['own-b'])],
    ));
    expect(index.ownersByQueryId.get('own-a')).toHaveLength(1);
    expect(index.ownersByQueryId.get('own-b')).toHaveLength(1);
    expect([...index.libraryQueryIds]).toEqual(['src']);
  });
});
