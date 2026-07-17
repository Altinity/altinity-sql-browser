// Dashboard query resolver (#280 suggested `dashboard-query-resolver`). A
// narrow read-only view over the workspace's saved-query collection that the
// authoring commands and session use to look a query up by ID and read its
// Dashboard role and declared variants — without any command touching the
// query collection shape directly. Pure; first occurrence of a duplicate ID
// wins (the collection's own duplicate-ID check is a validation concern).

import { queryDashboardRole } from '../model/workspace-semantics.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export interface QueryResolver {
  /** The saved query with this ID, or `undefined`. */
  get(queryId: string): unknown;
  /** Whether a query with this ID exists. */
  has(queryId: string): boolean;
  /** The query's effective Dashboard role (`panel` when undeclared), or
   *  `undefined` when no such query exists. */
  role(queryId: string): string | undefined;
  /** The query's declared presentation variants, or `undefined`. */
  variants(queryId: string): Record<string, unknown> | undefined;
}

/** Build a `QueryResolver` over a saved-query collection. */
export function createQueryResolver(queries: readonly unknown[]): QueryResolver {
  const byId = new Map<string, unknown>();
  for (const query of queries) {
    if (isObject(query) && typeof query.id === 'string' && !byId.has(query.id)) byId.set(query.id, query);
  }
  const get = (queryId: string): unknown => byId.get(queryId);
  return {
    get,
    has: (queryId) => byId.has(queryId),
    role: (queryId) => (byId.has(queryId) ? queryDashboardRole(byId.get(queryId)) : undefined),
    variants: (queryId) => {
      const query = byId.get(queryId);
      const dashboard = isObject(query) && isObject(query.spec) ? query.spec.dashboard : undefined;
      return isObject(dashboard) && isObject(dashboard.variants) ? dashboard.variants : undefined;
    },
  };
}
