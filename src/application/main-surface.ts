// The main work surface's SESSION state (#425): which of the two mutually
// exclusive surfaces — Query (SQL editor + result/data drawer) or Dashboard —
// owns the right-hand work area, and, for a Dashboard, WHICH stored Dashboard
// is selected, in which presentation mode, with an optional navigation focus
// target.
//
// Deliberately session state, never persisted workspace content:
// `StoredWorkspaceV5` carries no `activeDashboardId`/`defaultDashboardId`, and
// a Dashboard is identified ONLY by its stable `DashboardDocumentV2.id` —
// never by its position in `dashboards[]`. Sign-out and a workspace switch
// therefore clear or re-validate the selection rather than migrating it.
//
// Pure: no DOM, no persistence, no globals. Lives in `src/application/` (not
// `src/core/`) because it resolves against the workspace aggregate, and the
// dependency direction is `workspace <- application <- UI`; `src/core/` must
// never import `src/workspace/` (build/check-boundaries.mjs).

import { findDashboardStrict, type WorkspaceDashboards } from '../workspace/workspace-dashboards.js';
import type { SqlRoute } from '../core/sql-route.js';
import type { DashboardDocumentV2 } from '../generated/json-schema.types.js';

/** Where a caller wants navigation to land INSIDE the opened Dashboard. A tile
 *  is addressed by its Dashboard-local TILE id (never the saved-query id it
 *  renders); a variable by its EXACT inferred name, which is the only identity a
 *  variable has (#447 — there is no filter id any more). */
export type DashboardFocusTarget =
  | { kind: 'tile'; id: string }
  | { kind: 'variable'; id: string };

/** View is a presentation choice over the same live document, not an
 *  authorization boundary (ADR-0003). */
export type DashboardSurfaceMode = 'view' | 'edit';

/**
 * #426 splits what #425 carried as one `focus` field into two independent facts,
 * because the Dashboard tree needs to distinguish them:
 *
 *   - `currentMember` — WHICH member the user most recently navigated to inside
 *     this Dashboard. Retained until another member, another Dashboard, or a
 *     query is opened, because it is what the tree paints its current-resource
 *     styling from.
 *   - `pendingFocus` — a DOM focus delivery still owed to the surface. Consumed
 *     exactly once, then dropped, so a later repaint cannot re-focus and
 *     re-highlight a node the user has since navigated away from.
 *
 * They move independently: consuming a delivery must not erase the styling, and
 * a View/Edit switch preserves the current member while owing no new delivery.
 */
export type MainSurfaceState =
  | { kind: 'query' }
  | {
    kind: 'dashboard';
    dashboardId: string;
    mode: DashboardSurfaceMode;
    currentMember: DashboardFocusTarget | null;
    pendingFocus: DashboardFocusTarget | null;
    /**
     * #471 — a scroll offset still owed to the surface, consumed exactly once
     * alongside `pendingFocus`.
     *
     * A second delivery field rather than part of `pendingFocus` because it has a
     * different origin: focus comes from a navigation REQUEST, this comes from
     * history. Opening a tile's query tears the Dashboard DOM down (the Workbench
     * disposes it), so Back rebuilds it from scratch — and #471 removed the global
     * control that used to make that round trip avoidable, which is what turns
     * "scroll is lost" from a wart into a broken requirement. `null` means "start
     * where a fresh render starts", i.e. the top.
     */
    pendingScrollTop: number | null;
  };

/** The one application-level Dashboard navigation request (#425). */
export interface OpenDashboardRequest {
  dashboardId: string;
  mode: DashboardSurfaceMode;
  focus?: DashboardFocusTarget;
  /** #471: only history restoration supplies this — see `restoreDashboardSurface`. */
  scrollTop?: number;
}

/**
 * What a Dashboard history entry has to remember (#471).
 *
 * Everything here is absent from the URL by design: #425 keeps the selected Dashboard
 * id, the current member and the scroll offset as session state, so a history entry
 * that records none of them cannot be returned to faithfully. Held in
 * `history.state`, which is per-entry and invisible to the user, so multiple
 * Back steps across several Dashboards each restore their own.
 */
export interface DashboardHistorySnapshot {
  workspaceKey: string | null;
  dashboardId: string;
  currentMember: DashboardFocusTarget | null;
  scrollTop: number;
}

/** Read a snapshot back out of an opaque `history.state`, or `null` when the entry
 *  carries none (a fresh load, an entry written before this existed) or when it
 *  belongs to a DIFFERENT workspace — a Dashboard id is unique per workspace, not
 *  globally, so a coincidental match must not resolve. */
export function readDashboardHistorySnapshot(
  state: unknown, workspaceKey: string | null,
): DashboardHistorySnapshot | null {
  if (typeof state !== 'object' || state === null) return null;
  const dash = (state as { dash?: unknown }).dash;
  if (typeof dash !== 'object' || dash === null) return null;
  const candidate = dash as Partial<DashboardHistorySnapshot>;
  if (typeof candidate.dashboardId !== 'string' || candidate.dashboardId === '') return null;
  if ((candidate.workspaceKey ?? null) !== workspaceKey) return null;
  return {
    workspaceKey,
    dashboardId: candidate.dashboardId,
    currentMember: candidate.currentMember ?? null,
    scrollTop: typeof candidate.scrollTop === 'number' && Number.isFinite(candidate.scrollTop)
      ? candidate.scrollTop
      : 0,
  };
}

/** The snapshot for the surface currently on screen, or `null` in Query mode —
 *  written onto the history entry being LEFT, with the live scroll offset the DOM
 *  has right now. */
export function dashboardHistorySnapshot(
  surface: MainSurfaceState, workspaceKey: string | null, scrollTop: number,
): DashboardHistorySnapshot | null {
  if (surface.kind !== 'dashboard') return null;
  return {
    workspaceKey,
    dashboardId: surface.dashboardId,
    currentMember: surface.currentMember,
    scrollTop,
  };
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
  // A request that names a member both SELECTS it (styling) and OWES a delivery;
  // one that names none clears the selection, per #426's "opening a Dashboard row
  // without a member clears currentMember".
  //
  // The two fields validate DIFFERENTLY, on purpose:
  //   - `currentMember` is styling, so it is checked against the resolved document.
  //     Marking a tile/filter this Dashboard does not have would leave a phantom id
  //     sitting there until the next reconciliation — and light up spuriously if an
  //     import later reintroduced that id.
  //   - `pendingFocus` is the REQUEST, and is passed through unchecked. The delivery
  //     path is what reports a miss ("That panel is no longer on this dashboard"),
  //     and dropping the request here would silently swallow that diagnostic.
  const requested = request.focus ?? null;
  return {
    status: 'ok',
    surface: {
      kind: 'dashboard',
      dashboardId: request.dashboardId,
      mode: request.mode,
      currentMember: presentMember(lookup.dashboard, requested),
      pendingFocus: requested,
      // #471: an OPEN request never restores a scroll offset — only history does
      // (`restoreDashboardSurface`). Opening a Dashboard deliberately starts at the
      // top; carrying a stale offset here would land the user mid-page for a
      // Dashboard they navigated to fresh.
      pendingScrollTop: request.scrollTop ?? null,
    },
  };
}

/**
 * Rebuild a Dashboard selection from a history entry (#471).
 *
 * The URL carries no Dashboard id (#425 keeps it session state), so returning to a
 * Dashboard entry with Back had nothing to resolve and fell back to the collection's
 * FIRST Dashboard — the wrong document whenever the user had selected another. The
 * snapshot rides in `history.state` instead of the URL, which keeps the shareable URL
 * unchanged and makes the memory per-history-entry rather than one global "last
 * Dashboard".
 *
 * Validated like any other selection: a snapshot whose Dashboard is gone (or
 * ambiguous) falls back to Query mode rather than retargeting, and a stale member
 * reference drops itself.
 */
export function restoreDashboardSurface(
  snapshot: DashboardHistorySnapshot, mode: DashboardSurfaceMode, workspace: WorkspaceDashboards | null,
): MainSurfaceState {
  return reconcileMainSurface({
    kind: 'dashboard',
    dashboardId: snapshot.dashboardId,
    // The MODE comes from the route, not the snapshot: the URL does carry it, and it
    // is the authority for what the entry describes.
    mode,
    currentMember: snapshot.currentMember,
    pendingFocus: null,
    pendingScrollTop: snapshot.scrollTop,
  }, workspace);
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
  const lookup = workspace
    ? findDashboardStrict(workspace, surface.dashboardId)
    : { status: 'missing' as const };
  if (lookup.status !== 'ok') return QUERY_SURFACE;
  // #426: the Dashboard survived, but the member it was pointing at may not
  // have. Stale current-member styling has to clear on its own — the tree paints
  // from this field, and a removed tile/filter would otherwise stay highlighted.
  // A pending delivery for a gone member is dropped for the same reason; the
  // surface's own delivery path reports the miss non-destructively.
  return retainMember(surface, lookup.dashboard);
}

/** A member reference the document actually contains, or `null`. Resolved against
 *  the member's OWN collection, so a tile id colliding with a filter id cannot
 *  cross-resolve. The one definition of "this member exists", shared by open-time
 *  validation and post-commit reconciliation. */
function presentMember(
  dashboard: DashboardDocumentV2, member: DashboardFocusTarget | null,
): DashboardFocusTarget | null {
  if (member === null) return null;
  // A VARIABLE is always retained. Whether a variable still exists is decided by
  // inference over the workspace's panel queries, which this pure surface model
  // deliberately does not hold — it sees one Dashboard document, and a variable
  // with no stored option SQL leaves no trace in that document at all. Retaining
  // the name is the safe direction: a name that no longer resolves focuses
  // nothing, whereas dropping it on every commit would lose a live focus.
  if (member.kind === 'variable') return member;
  return dashboard.tiles.some((entry) => entry.id === member.id) ? member : null;
}

/** Keep only the member references the committed document still contains. */
function retainMember(
  surface: Extract<MainSurfaceState, { kind: 'dashboard' }>, dashboard: DashboardDocumentV2,
): MainSurfaceState {
  const present = (member: DashboardFocusTarget | null): DashboardFocusTarget | null =>
    presentMember(dashboard, member);
  const currentMember = present(surface.currentMember);
  const pendingFocus = present(surface.pendingFocus);
  if (currentMember === surface.currentMember && pendingFocus === surface.pendingFocus) return surface;
  return { ...surface, currentMember, pendingFocus };
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
 *  already-active mode — the caller then keeps the live viewer session and
 *  delivers the new focus target in place (#426), so a repeated open never
 *  builds a duplicate Dashboard session. */
export function isSameDashboardSelection(
  surface: MainSurfaceState, request: OpenDashboardRequest,
): boolean {
  return surface.kind === 'dashboard'
    && surface.dashboardId === request.dashboardId
    && surface.mode === request.mode;
}

/** Drop a consumed focus DELIVERY, keeping both the Dashboard selection and the
 *  current member. Applied once the focus has been delivered (or reported
 *  missing) so a later repaint — an external workspace change, a style switch —
 *  cannot re-focus and re-highlight a tile the user has since navigated away
 *  from. #426: it deliberately leaves `currentMember` alone, so the tree keeps
 *  marking the member the user navigated to after its one-shot delivery is
 *  spent. */
export function withoutPendingFocus(surface: MainSurfaceState): MainSurfaceState {
  if (surface.kind !== 'dashboard') return surface;
  // #471: `pendingScrollTop` is handed to the same render pass and consumed with it,
  // for the same reason — a later repaint must not yank the page back to an offset
  // the user has since scrolled away from.
  if (surface.pendingFocus === null && surface.pendingScrollTop === null) return surface;
  return { ...surface, pendingFocus: null, pendingScrollTop: null };
}

/**
 * Carry the current member across a transition that REBUILDS the surface from an
 * open request (#426).
 *
 * `resolveOpenDashboard` builds a fresh surface from the request alone, so it
 * cannot know a member was already current. A View/Edit switch through Dashboard
 * chrome goes down exactly that path — same Dashboard, different mode — and the
 * spec requires it to preserve the current member. Carried ONLY when the request
 * names the same Dashboard and no member of its own, so opening a Dashboard row
 * still clears the selection.
 */
export function carryCurrentMember(
  previous: MainSurfaceState, next: MainSurfaceState,
): MainSurfaceState {
  if (previous.kind !== 'dashboard' || next.kind !== 'dashboard') return next;
  if (previous.dashboardId !== next.dashboardId) return next;
  if (next.currentMember !== null || previous.currentMember === null) return next;
  return { ...next, currentMember: previous.currentMember };
}

/** Select a member INSIDE the already-open Dashboard without owing a render-time
 *  delivery: #426's in-place focus path delivers through the surface command
 *  port directly, so only the styling fact changes here. */
export function withCurrentMember(
  surface: MainSurfaceState, member: DashboardFocusTarget,
): MainSurfaceState {
  if (surface.kind !== 'dashboard') return surface;
  return { ...surface, currentMember: member };
}
