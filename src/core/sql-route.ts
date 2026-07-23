// Pure parser/builder for the single `/sql` application route (#407).
// The caller supplies `location.search`; this module owns only `ws`, `surface`,
// and `mode`, leaving OAuth callback and other application parameters intact.

export type SqlRoute =
  | { surface: 'workspace'; workspaceKey: string | null }
  | { surface: 'dashboard'; workspaceKey: string | null; mode: 'edit' | 'view' };

/** Parse route-owned parameters into their normalized application meaning. */
export function parseSqlRoute(search: string): SqlRoute {
  const params = new URLSearchParams(search);
  const workspaceKey = params.has('ws') ? (params.get('ws') ?? '') : null;
  if (params.get('surface') === 'dashboard') {
    return {
      surface: 'dashboard',
      workspaceKey,
      mode: params.get('mode') === 'view' ? 'view' : 'edit',
    };
  }
  return { surface: 'workspace', workspaceKey };
}

/**
 * Build a canonical search string for `route`, preserving every parameter this
 * route contract does not own. The result is empty or begins with `?`.
 */
export function buildSqlRouteSearch(route: SqlRoute, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch);
  params.delete('ws');
  params.delete('surface');
  params.delete('mode');
  // Retired Dashboard snapshot route state (#407); never carry it forward.
  params.delete('st');
  params.delete('dash');
  if (route.workspaceKey !== null) params.set('ws', route.workspaceKey);
  if (route.surface === 'dashboard') {
    params.set('surface', 'dashboard');
    if (route.mode === 'view') params.set('mode', 'view');
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/** Parse and canonicalize a raw search string in one step. */
export function normalizeSqlRouteSearch(search: string): { route: SqlRoute; search: string } {
  const route = parseSqlRoute(search);
  return { route, search: buildSqlRouteSearch(route, search) };
}

/** Return the same route pointed at another workspace key. */
export function routeForWorkspace(route: SqlRoute, workspaceKey: string): SqlRoute {
  return route.surface === 'dashboard'
    ? { surface: 'dashboard', workspaceKey, mode: route.mode }
    : { surface: 'workspace', workspaceKey };
}
