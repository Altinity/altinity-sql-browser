// Pure parsing/building of the standalone Dashboard route's open-source
// contract (#288/#302). No DOM, no globals — the caller supplies the raw URL
// search string (e.g. `location.search`) and gets back a discriminated union
// telling it which store to read the dashboard from.
//
// Two ways a dashboard tab can be opened (see the coordinator's two-mode
// model): EDIT mode resolves `?ws=<workspaceKey>&dash=<dashboardId>` against the
// shared primary workspace store; VIEW mode's one-time handoff resolves
// `?st=<token>&dash=<dashboardId>` against the dedicated handoff store, then
// rewrites the URL to a persistent `?ws=<detachedId>` once materialized. `st`
// takes precedence over `ws` when both are present (a stale `ws` left over
// from history should never shadow a fresh handoff token).

/** Which store a standalone Dashboard tab should resolve its dashboard from. */
export type DashboardOpenSource =
  | { kind: 'current-workspace'; workspaceKey: string; dashboardId: string }
  | { kind: 'session-bundle'; token: string; dashboardId: string };

/**
 * Parse a URL search string (e.g. `location.search`, with or without a leading
 * `?`) into a `DashboardOpenSource`. Precedence: a non-empty `st` param wins as
 * `session-bundle`; else a non-empty `ws` param is `current-workspace`; else
 * `null` (the legacy bare `/dashboard` open, or garbage input). A missing
 * `dash` param becomes `''` rather than failing parse — the discriminator only
 * needs to know WHICH store to look in; a missing dashboard id inside that
 * store is the caller's not-found case to handle.
 *
 * `state` is deliberately never read here — it is main.ts's OAuth CSRF param,
 * and this contract does not use that name for its token (see the coordinator
 * spec's URL param naming rule).
 */
export function parseDashboardOpenSource(search: string): DashboardOpenSource | null {
  const params = new URLSearchParams(search);
  const dashboardId = params.get('dash') ?? '';
  const token = params.get('st');
  if (token) return { kind: 'session-bundle', token, dashboardId };
  const workspaceKey = params.get('ws');
  if (workspaceKey) return { kind: 'current-workspace', workspaceKey, dashboardId };
  return null;
}

/**
 * Build the `?`-prefixed search string for a `DashboardOpenSource`, the
 * inverse of `parseDashboardOpenSource`. `current-workspace` → `?ws=..&dash=..`;
 * `session-bundle` → `?st=..&dash=..`. Values are URL-encoded by
 * `URLSearchParams`.
 */
export function buildDashboardSearch(source: DashboardOpenSource): string {
  const params = new URLSearchParams();
  if (source.kind === 'session-bundle') {
    params.set('st', source.token);
  } else {
    params.set('ws', source.workspaceKey);
  }
  params.set('dash', source.dashboardId);
  return '?' + params.toString();
}
