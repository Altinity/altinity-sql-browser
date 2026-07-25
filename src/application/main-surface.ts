// The main work surface's SESSION state (#425): which of the two mutually
// exclusive surfaces — Query (SQL editor + result/data drawer) or Dashboard —
// owns the right-hand work area, and, for a Dashboard, WHICH stored Dashboard
// is selected, in which presentation mode, with an optional navigation focus
// target.
//
// Deliberately session state, never persisted workspace content:
// `StoredWorkspaceV3` carries no `activeDashboardId`/`defaultDashboardId`, and
// a Dashboard is identified ONLY by its stable `DashboardDocumentV1.id` —
// never by its position in `dashboards[]`. Sign-out and a workspace switch
// therefore clear or re-validate the selection rather than migrating it.
//
// Pure: no DOM, no persistence, no globals. Lives in `src/application/` (not
// `src/core/`) because it resolves against the workspace aggregate, and the
// dependency direction is `workspace <- application <- UI`; `src/core/` must
// never import `src/workspace/` (build/check-boundaries.mjs).

import { findDashboardStrict, type WorkspaceDashboards } from '../workspace/workspace-dashboards.js';
import type { SqlRoute } from '../core/sql-route.js';

/** Where a caller wants navigation to land INSIDE the opened Dashboard. A tile
 *  is addressed by its Dashboard-local TILE id (never the saved-query id it
 *  renders); a curated filter by its filter-definition id. */
export type DashboardFocusTarget =
  | { kind: 'tile'; id: string }
  | { kind: 'filter'; id: string };

/** View is a presentation choice over the same live document, not an
 *  authorization boundary (ADR-0003). */
export type DashboardSurfaceMode = 'view' | 'edit';

export type MainSurfaceState =
  | { kind: 'query' }
  | {
    kind: 'dashboard';
    dashboardId: string;
    mode: DashboardSurfaceMode;
    focus: DashboardFocusTarget | null;
  };

/** The one application-level Dashboard navigation request (#425). */
export interface OpenDashboardRequest {
  dashboardId: string;
  mode: DashboardSurfaceMode;
  focus?: DashboardFocusTarget;
}

/** The Query surface carries no parameters, so one frozen value serves every
 *  transition to it — and identity comparison is a legitimate test for "we
 *  fell back to Query mode". */
export const QUERY_SURFACE: MainSurfaceState = Object.freeze({ kind: 'query' as const });

/** `resolveOpenDashboard`'s outcome. `missing`/`duplicate` are reported through
 *  the caller's diagnostic path and change NO state: opening a Dashboard must
 *  never mutate anything, and an ambiguous id must never be resolved by a
 *  guess. */
export type OpenDashboardResolution =
  | { status: 'ok'; surface: MainSurfaceState }
  | { status: 'missing' }
  | { status: 'duplicate' };

/**
 * Resolve an open request against the ACTIVE workspace's Dashboard collection,
 * by exact id. A `null` workspace (none loaded, or a corrupt/not-found route)
 * resolves as `missing` — there is nothing to address an id against.
 */
export function resolveOpenDashboard(
  workspace: WorkspaceDashboards | null, request: OpenDashboardRequest,
): OpenDashboardResolution {
  if (!workspace) return { status: 'missing' };
  const lookup = findDashboardStrict(workspace, request.dashboardId);
  if (lookup.status !== 'ok') return { status: lookup.status };
  return {
    status: 'ok',
    surface: {
      kind: 'dashboard',
      dashboardId: request.dashboardId,
      mode: request.mode,
      focus: request.focus ?? null,
    },
  };
}

/**
 * Re-validate a selection against committed truth. A selected Dashboard that
 * was removed — or whose id became ambiguous — falls back to **Query** mode
 * rather than silently retargeting to another Dashboard. Called after every
 * committed workspace projection and after a workspace switch, which is exactly
 * what makes "switching workspaces clears the selection unless the new
 * workspace contains the same explicitly selected id" fall out for free.
 */
export function reconcileMainSurface(
  surface: MainSurfaceState, workspace: WorkspaceDashboards | null,
): MainSurfaceState {
  if (surface.kind === 'query') return surface;
  if (workspace && findDashboardStrict(workspace, surface.dashboardId).status === 'ok') return surface;
  return QUERY_SURFACE;
}

/** The canonical `/sql` route for a surface. #425 leaves URLs unchanged: the
 *  selected Dashboard id is session state and never appears in the URL, so the
 *  route still carries only workspace + surface + mode. */
export function mainSurfaceRoute(
  surface: MainSurfaceState, workspaceKey: string | null,
): SqlRoute {
  return surface.kind === 'dashboard'
    ? { surface: 'dashboard', workspaceKey, mode: surface.mode }
    : { surface: 'workspace', workspaceKey };
}

/** The selected Dashboard id, or `null` in Query mode — the render target's
 *  `dashboardId`, where `null` also covers "this workspace has no Dashboard
 *  yet" and lands on the Create-dashboard placeholder. */
export function selectedDashboardId(surface: MainSurfaceState): string | null {
  return surface.kind === 'dashboard' ? surface.dashboardId : null;
}

/** True when an open request targets the ALREADY-selected Dashboard in the
 *  already-active mode — the caller then keeps the live viewer session and only
 *  applies the new focus target, so a repeated open never builds a duplicate
 *  Dashboard session. */
export function isSameDashboardSelection(
  surface: MainSurfaceState, request: OpenDashboardRequest,
): boolean {
  return surface.kind === 'dashboard'
    && surface.dashboardId === request.dashboardId
    && surface.mode === request.mode;
}

/** Drop a consumed focus target, keeping the selection. Applied once the focus
 *  has been delivered (or reported missing) so a later repaint — an external
 *  workspace change, a style switch — cannot re-focus and re-highlight a tile
 *  the user has since navigated away from. */
export function withoutFocus(surface: MainSurfaceState): MainSurfaceState {
  if (surface.kind !== 'dashboard' || surface.focus === null) return surface;
  return { ...surface, focus: null };
}
