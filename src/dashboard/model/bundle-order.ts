// Canonical resource ordering for portable bundles (#280 "Canonical output
// ordering"): Dashboard dependency-closure query order, multi-Dashboard
// tooling order, and the lexicographic Dashboard sort. Pure structural
// helpers — the canonical encoder handles key ordering, these handle which
// resources appear where. A full current-workspace export deliberately has
// no helper here: it preserves catalog query order and emits the zero-or-one
// current Dashboard as-is.

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const idOf = (value: unknown): string | undefined => {
  if (!isObject(value)) return undefined;
  return typeof value.id === 'string' ? value.id : undefined;
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Referenced query IDs of one Dashboard in canonical dependency order:
 *  tiles in semantic order first (first occurrence wins), then filter
 *  sources in filter order; every ID once. Setup references are absent in
 *  v1 by contract, so nothing here special-cases them. */
export function dashboardDependencyQueryIds(dashboard: unknown): string[] {
  if (!isObject(dashboard)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id !== 'string' || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  const tiles = Array.isArray(dashboard.tiles) ? dashboard.tiles : [];
  for (const tile of tiles) {
    if (isObject(tile)) add(tile.queryId);
  }
  const filters = Array.isArray(dashboard.filters) ? dashboard.filters : [];
  for (const filter of filters) {
    if (isObject(filter)) add(filter.sourceQueryId);
  }
  return out;
}

/** Sort dashboards lexicographically by normalized (NFC) Dashboard ID —
 *  multi-Dashboard bundle array order carries no catalog meaning in v1.
 *  Returns a new array; a Dashboard without a string ID sorts last in its
 *  original relative order. */
export function sortDashboardsCanonically<T>(dashboards: readonly T[]): T[] {
  return dashboards
    .map((dashboard, index) => ({ dashboard, index, id: idOf(dashboard)?.normalize('NFC') }))
    .sort((a, b) => {
      if (a.id === undefined || b.id === undefined) {
        return a.id === b.id ? a.index - b.index : (a.id === undefined ? 1 : -1);
      }
      return compareStrings(a.id, b.id) || a.index - b.index;
    })
    .map((entry) => entry.dashboard);
}

/** Order `queries` for a multi-Dashboard bundle produced by tooling: first
 *  reference across the given Dashboard order (tile order, then filter
 *  order, per Dashboard), then unreferenced queries in their original
 *  catalog order; every query once. */
export function orderBundleQueries<T>(queries: readonly T[], dashboards: readonly unknown[]): T[] {
  const byId = new Map<string, T>();
  for (const query of queries) {
    const id = idOf(query);
    if (id !== undefined && !byId.has(id)) byId.set(id, query);
  }
  const emittedIds = new Set<string>();
  const out: T[] = [];
  const emit = (query: T, id: string | undefined): void => {
    if (id !== undefined) {
      if (emittedIds.has(id)) return;
      emittedIds.add(id);
    }
    out.push(query);
  };
  for (const dashboard of dashboards) {
    for (const id of dashboardDependencyQueryIds(dashboard)) {
      const query = byId.get(id);
      if (query !== undefined) emit(query, id);
    }
  }
  // Unreferenced queries follow in catalog order; a duplicate catalog entry
  // for an already-emitted id is dropped so every query id appears once.
  for (const query of queries) emit(query, idOf(query));
  return out;
}

/** Apply the complete multi-Dashboard tooling arrangement: canonical
 *  Dashboard sort plus first-reference query order. */
export function arrangeBundleResources<Q, D>(
  { queries, dashboards }: { queries: readonly Q[]; dashboards: readonly D[] },
): { queries: Q[]; dashboards: D[] } {
  const orderedDashboards = sortDashboardsCanonically(dashboards);
  return {
    dashboards: orderedDashboards,
    queries: orderBundleQueries(queries, orderedDashboards),
  };
}
