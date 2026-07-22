import { describe, expect, it } from 'vitest';
import {
  arrangeBundleResources, dashboardDependencyQueryIds,
  orderBundleQueries, sortDashboardsCanonically,
} from '../../src/dashboard/model/bundle-order.js';

const dashboard = (id: string, tiles: string[], filterSources: string[] = []) => ({
  id,
  tiles: tiles.map((queryId, index) => ({ id: `${id}-t${index}`, queryId })),
  filters: filterSources.map((sourceQueryId, index) => ({ id: `${id}-f${index}`, parameter: 'p', sourceQueryId })),
});

describe('dashboardDependencyQueryIds', () => {
  it('emits tile queries first in semantic order, then filter sources, once each', () => {
    const d = dashboard('d1', ['q3', 'q1', 'q3'], ['q1', 'q9']);
    expect(dashboardDependencyQueryIds(d)).toEqual(['q3', 'q1', 'q9']);
  });

  it('tolerates missing/invalid structures', () => {
    expect(dashboardDependencyQueryIds(null)).toEqual([]);
    expect(dashboardDependencyQueryIds({})).toEqual([]);
    expect(dashboardDependencyQueryIds({ tiles: [null, { queryId: 5 }, { queryId: 'q1' }], filters: [null, { sourceQueryId: 7 }] }))
      .toEqual(['q1']);
  });

  it('ignores scalar dashboard members and empty query ids', () => {
    expect(dashboardDependencyQueryIds({
      tiles: 'not-an-array', filters: [{ sourceQueryId: '' }, 5],
    })).toEqual(['']);
    expect(dashboardDependencyQueryIds({ tiles: [5], filters: 'not-an-array' })).toEqual([]);
  });
});

describe('sortDashboardsCanonically', () => {
  it('sorts by normalized id lexicographically, keeping id-less dashboards last stably', () => {
    const a = dashboard('bravo', []);
    const b = dashboard('alpha', []);
    const c = { tiles: [] }; // no id
    const d = { id: 5 }; // non-string id → treated as id-less
    expect(sortDashboardsCanonically([a, b, c, d]).map((x) => (x as { id?: unknown }).id))
      .toEqual(['alpha', 'bravo', undefined, 5]);
  });

  it('normalizes ids (NFC) before comparing and does not mutate the input', () => {
    const composed = { id: 'é' }; // é precomposed
    const decomposed = { id: 'é' }; // é decomposed → NFC equal
    const input = [composed, decomposed];
    const sorted = sortDashboardsCanonically(input);
    expect(sorted).toHaveLength(2);
    expect(input[0]).toBe(composed); // untouched
  });

  it('keeps equal string ids stable and orders id-bearing objects before id-less values', () => {
    const first = { id: 'same', marker: 1 };
    const second = { id: 'same', marker: 2 };
    expect(sortDashboardsCanonically([null, first, second])).toEqual([first, second, null]);
  });
});

describe('orderBundleQueries', () => {
  const q = (id: string) => ({ id });
  it('orders by first reference across dashboards, then unreferenced in catalog order', () => {
    const queries = [q('q1'), q('q2'), q('q3'), q('q4')];
    const dashboards = [dashboard('d1', ['q3'], ['q2']), dashboard('d2', ['q3', 'q1'])];
    // First reference: q3 (d1 tile), q2 (d1 filter), q1 (d2 tile); q4 unreferenced last.
    expect(orderBundleQueries(queries, dashboards).map((x) => x.id)).toEqual(['q3', 'q2', 'q1', 'q4']);
  });

  it('emits each query once and ignores references to unknown queries', () => {
    const queries = [q('q1'), q('q1'), q('q2')]; // duplicate catalog entry
    const dashboards = [dashboard('d1', ['q2', 'missing'])];
    expect(orderBundleQueries(queries, dashboards).map((x) => x.id)).toEqual(['q2', 'q1']);
  });

  it('preserves id-less catalog entries while deduplicating string ids', () => {
    const anonymousA = { sql: 'SELECT 1' };
    const anonymousB = null;
    expect(orderBundleQueries([anonymousA, anonymousB, { id: 'q1' }], [])).toEqual([
      anonymousA, anonymousB, { id: 'q1' },
    ]);
  });
});

describe('arrangeBundleResources', () => {
  it('applies canonical dashboard sort then first-reference query order', () => {
    const q = (id: string) => ({ id });
    const queries = [q('qa'), q('qb'), q('qc')];
    const dashboards = [dashboard('zeta', ['qc']), dashboard('alpha', ['qb'])];
    const arranged = arrangeBundleResources({ queries, dashboards });
    expect(arranged.dashboards.map((d) => d.id)).toEqual(['alpha', 'zeta']);
    // alpha (qb) referenced first, then zeta (qc), then unreferenced qa.
    expect(arranged.queries.map((x) => x.id)).toEqual(['qb', 'qc', 'qa']);
  });
});
