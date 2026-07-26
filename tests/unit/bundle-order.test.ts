import { describe, expect, it } from 'vitest';
import {
  arrangeBundleResources, dashboardDependencyQueryIds,
  orderBundleQueries, sortDashboardsCanonically,
} from '../../src/dashboard/model/bundle-order.js';

const dashboard = (id: string, tiles: string[]) => ({
  id,
  tiles: tiles.map((queryId, index) => ({ id: `${id}-t${index}`, queryId })),
});

describe('dashboardDependencyQueryIds', () => {
  // #447: a tile reference is the WHOLE closure. A curated filter used to
  // contribute its option-source query here; a variable's option SQL lives on the
  // Dashboard document itself and references no query at all.
  it('emits tile queries in semantic order, once each', () => {
    expect(dashboardDependencyQueryIds(dashboard('d1', ['q3', 'q1', 'q3']))).toEqual(['q3', 'q1']);
  });

  it('never treats a legacy filters array as a dependency source', () => {
    expect(dashboardDependencyQueryIds({
      tiles: [{ queryId: 'q1' }],
      filters: [{ id: 'f0', parameter: 'p', sourceQueryId: 'q9' }],
    })).toEqual(['q1']);
  });

  it('tolerates missing/invalid structures', () => {
    expect(dashboardDependencyQueryIds(null)).toEqual([]);
    expect(dashboardDependencyQueryIds({})).toEqual([]);
    expect(dashboardDependencyQueryIds({ tiles: [null, { queryId: 5 }, { queryId: 'q1' }] }))
      .toEqual(['q1']);
  });

  it('ignores scalar dashboard members and empty query ids', () => {
    expect(dashboardDependencyQueryIds({ tiles: 'not-an-array' })).toEqual([]);
    expect(dashboardDependencyQueryIds({ tiles: [5, { queryId: '' }] })).toEqual(['']);
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
    const dashboards = [dashboard('d1', ['q3', 'q2']), dashboard('d2', ['q3', 'q1'])];
    // First reference: q3 then q2 (d1's tiles), q1 (d2's second tile); q4 unreferenced last.
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
