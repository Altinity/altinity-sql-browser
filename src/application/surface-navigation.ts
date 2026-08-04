// The main-surface / `/sql` route navigation session (#588 phase 4 wave 4).
// Owns: the surface-generation guard cluster, `/sql` route writes, boot/
// popstate/programmatic-navigation loading, and every main-surface transition
// (open a Dashboard, return to Query, open a saved query/panel/variable tab).
//
// Deliberately NOT here — all DOM-owning, and reached only through
// `deps.hooks`, an injected callback bag this module calls but never
// implements (same layering discipline as `workspace-session.ts`, #588 phase 4
// wave 3 — this module imports `../workspace/*`, `../state.ts` (types only),
// `../core/*`, and this directory's own siblings, never `../ui/*` or
// `../editor/*`; build/check-boundaries.mjs enforces the direction, type-only
// imports included):
//   - `ensureShell`/`disposeShell` and `dashboardRenderTarget` (persistent-shell
//     mount/dispose and the Dashboard render-target projection);
//   - `beginSurfaceTransition`/`disposeCurrentSurface` (what a transition tears
//     down before this module's own route/surface write lands);
//   - `renderWorkspaceNotFound`/`renderWorkspaceLoading` (the two placeholder
//     DOM states — reached through `hooks.renderWorkspaceNotFound`/
//     `hooks.renderWorkspaceLoading`);
//   - `app.renderDashboard`/`app.renderApp` (reached through `hooks.renderDashboard`/
//     `hooks.renderApp`);
//   - `resetCorruptWorkspace` (drives `app.workspace.delete` alongside
//     `session.resolveImplicitOrProvision` — reached through
//     `hooks.onCorruptWorkspace`, and itself calls back into this module's own
//     `rewriteWorkspaceRoute`/`loadGeneration`).
//
// `app.sqlRoute`/`app.mainSurface`/`app.currentWorkspace`/
// `app.workspaceRouteStatus`/`app.surfaceCommands` remain App DATA PROPERTIES
// (read by dashboard.ts, dashboard-tree.ts, file-menu.ts, app-shell.ts,
// shortcuts.ts, saved-history.ts) — this module never owns them directly. It
// receives the live `app` object, narrowed structurally to `SurfaceStatePort`,
// through a `surface: () => SurfaceStatePort` thunk (per the plan's exact
// wording: "Decision: `surface: () => app`") and mutates through that SAME
// object identity, so none of those consumers needs to change.
//
// Two escape hatches beyond the plan's "Nav exposes" list, both needed by
// `applyCommittedWorkspace` (app.ts, stays there — real UI orchestration, not
// "zero DOM"), which the plan's frozen interface did not anticipate because
// its line-number survey predates waves 1-3's repeated shifts (see the wave 4
// worker prompt's own warning to re-verify, not trust, cited line numbers):
//   - `writeRoute` — `applyCommittedWorkspace`'s lostSelection fallback forces
//     the URL to the QUERY surface's route (`mainSurfaceRoute(QUERY_SURFACE,
//     key)`) with 'replace', REGARDLESS of the route's current surface. Neither
//     `rewriteWorkspaceRoute` (preserves the CURRENT surface — wrong when the
//     current surface is 'dashboard', which is exactly when this fallback
//     fires) nor `showQuerySurface`/`applyMainSurface` (stamp Dashboard
//     history, invalidate the tree again, and — worse — use 'push' when
//     leaving a Dashboard route, adding a history entry this projection-time
//     fallback must not create) is behavior-identical to the pre-extraction
//     inline `writeRoute(...)` call this branch made directly. Exposing the
//     primitive itself was the only way to keep behavior byte-identical.
//   - `currentRouteSearch` — `app.consumeLegacyShared` (app.ts, stays) rebuilds
//     the URL after stripping a one-shot share/OAuth payload using the LIVE
//     cached search string (it used to read the module-local `routeSearch`
//     directly, which reflects `loadWorkspaceOnBoot`'s own canonicalization by
//     the time `consumeLegacyShared` runs).

import type { StoredWorkspaceV5, SavedQueryV2 } from '../generated/json-schema.types.js';
import { activeTab } from '../state.js';
import type { AppState } from '../state.js';
import type { WorkspaceRepository, WorkspaceLoadResult } from '../workspace/workspace-repository.js';
import type { WorkspaceSession } from './workspace-session.js';
import {
  replaceDashboard, resolveCompatibilityDashboard, withCompatibilityDashboard,
} from '../workspace/workspace-dashboards.js';
import {
  QUERY_SURFACE, isSameDashboardSelection, mainSurfaceRoute, reconcileMainSurface,
  carryCurrentMember, resolveOpenDashboard, selectedDashboardId, withCurrentMember,
  dashboardHistorySnapshot, readDashboardHistorySnapshot, restoreDashboardSurface,
} from './main-surface.js';
import type {
  DashboardFocusOutcome, DashboardFocusTarget, DashboardSurfaceMode, MainSurfaceState,
  OpenDashboardRequest, SurfaceCommandPort, WorkspaceRouteStatus,
} from './main-surface.js';
import { dashboardVariables } from './dashboard-tree-model.js';
import { queryView } from '../core/saved-query.js';
import {
  buildSqlRouteSearch, normalizeSqlRouteSearch, parseSqlRoute, routeForWorkspace,
} from '../core/sql-route.js';
import type { SqlRoute } from '../core/sql-route.js';

/** The live `app` slice this module reads/mutates through the `surface` thunk
 *  — structurally `App`'s own data properties (`src/ui/app.types.ts`), never
 *  imported from there (this module names no UI type). */
export interface SurfaceStatePort {
  sqlRoute: SqlRoute;
  mainSurface: MainSurfaceState;
  currentWorkspace: StoredWorkspaceV5 | null;
  workspaceRouteStatus: WorkspaceRouteStatus;
  surfaceCommands: SurfaceCommandPort | null;
}

export interface SurfaceNavigationDeps {
  state: AppState;
  /** Returns the live `app` object, narrowed structurally. Mutations through
   *  this thunk's return value land on the real `app` — there is no copy. */
  surface: () => SurfaceStatePort;
  repository: Pick<WorkspaceRepository, 'loadByKey'>;
  session: Pick<WorkspaceSession, 'resolveImplicitOrProvision' | 'recordOpened'>;
  history: Pick<History, 'pushState' | 'replaceState'> & { state?: unknown };
  basePath(): string;
  locationHash(): string;
  locationSearch(): string;
  hooks: {
    applyCommittedWorkspace(ws: StoredWorkspaceV5): void;
    renderApp(): void;
    renderDashboard(): void;
    renderWorkspaceLoading(): void;
    renderWorkspaceNotFound(): void;
    onCorruptWorkspace(id: string): void;
    retryPendingOAuthDocumentRecovery(): void;
    closeShortcutDialog(): void;
    resetShortcutChord(): void;
    isSignedIn(): boolean;
    invalidateDashboardTree(): void;
    /** Extended beyond the plan's `toast(message: string): void` — the corrupt-
     *  workspace toast (`loadWorkspaceOnBoot`) needs the SAME recovery-action
     *  button (`flashToast`'s own `action` option) the pre-extraction inline
     *  code passed; every other call site here passes no `opts` at all, so
     *  the optional second parameter is additive, not a narrowing. */
    toast(message: string, opts?: { action?: { label: string; onClick: () => void } }): void;
    revealAssignedPanel(dashboardId: string, tileId: string): void;
    loadIntoNewTab(query: SavedQueryV2): void;
    openVariableTabUi(binding: { dashboardId: string; variableName: string }, sql: string): void;
    toEditorOnMobile(): void;
    runAction(opts: { view?: string }): void;
    dashboardScrollTop(): number | null;
    isAutoRunnableSql(sql: string): boolean;
    /**
     * Four "self-dispatch" hooks NOT in the plan's frozen list, added because
     * the pre-extraction code called these SAME four members (all of which
     * keep a flat `App` delegate) through `app.foo()` property access from
     * OTHER moved functions (`navigateSqlRoute`/`handleSqlPopState` calling
     * `app.loadWorkspaceOnBoot()`/`app.renderCurrentSurface()`;
     * `applyMainSurface`/`showDashboardSurface` calling
     * `app.renderCurrentSurface()`/`app.openDashboard()`;
     * `openQueryDocument`/`openVariableTab` calling `app.showQuerySurface()`).
     * That property access is exactly what let a test override e.g.
     * `app.renderCurrentSurface = vi.fn()` and have it observed by EVERY
     * caller — a real, test-exercised behavior (17 `app.renderCurrentSurface
     * = vi.fn()` fixtures in app.test.ts). A private nav-internal local
     * reference does not have that property, so preserving it requires
     * reading back through `app.*` here — wired in app.ts as
     * `() => app.renderCurrentSurface()` etc., which resolves to nav's own
     * real implementation by DEFAULT (the flat delegate assignment runs
     * immediately after construction) and to a test's stub once one is
     * installed, exactly like the pre-extraction code.
     */
    dispatchCurrentSurface(): void;
    dispatchLoadWorkspaceOnBoot(): Promise<StoredWorkspaceV5 | null>;
    dispatchShowQuerySurface(): void;
    dispatchOpenDashboard(request: OpenDashboardRequest): void;
  };
}

export interface SurfaceNavigation {
  navigateSqlRoute(route: SqlRoute, method: 'push' | 'replace'): Promise<void>;
  handleSqlPopState(): Promise<void>;
  syncSqlRoute(search: string): void;
  rewriteWorkspaceRoute(workspaceKey: string): void;
  /** Escape hatch — see this module's header comment. */
  writeRoute(route: SqlRoute, method: 'push' | 'replace'): void;
  /** Escape hatch — see this module's header comment. */
  currentRouteSearch(): string;
  renderCurrentSurface(): void;
  loadWorkspaceOnBoot(): Promise<StoredWorkspaceV5 | null>;
  reloadDashboardRoute(): void;
  openDashboard(request: OpenDashboardRequest): void;
  showQuerySurface(): void;
  showDashboardSurface(mode: DashboardSurfaceMode): void;
  openSavedQuery(queryId: string): void;
  openPanelQuery(target: { dashboardId: string; tileId: string; queryId: string }): void;
  openVariableTab(dashboardId: string, variableName: string): void;
  focusDashboardMember(member: DashboardFocusTarget): DashboardFocusOutcome;
  captureSurfaceGeneration(): number;
  isSurfaceGenerationCurrent(generation: number): boolean;
  refreshCurrentSurfaceAfterStale(generation: number, committed?: boolean): boolean;
  advanceSurfaceGeneration(): void;
  loadGeneration(): number;
}

export function createSurfaceNavigation(deps: SurfaceNavigationDeps): SurfaceNavigation {
  // #407 — both application surfaces live on `/sql`; the URL query string is
  // cached here (not re-read from `location` on every write) so a canonicalize/
  // stamp can build on the LAST write this module made, exactly as app.ts's own
  // pre-extraction `routeSearch` local did.
  let routeSearch = deps.locationSearch();
  let routeLoadGeneration = 0;
  // Every surface transition — mount, teardown, or sign-out — advances the
  // renderer generation so an obsolete async callback (a late Dashboard wave, a
  // pending focus target) can finish its durable work without settling against
  // a replacement renderer. Bumped on the TRANSITION, not as a side effect of a
  // mount, because a mount can be skipped when the host is already live (#425's
  // preserved Query surface).
  let surfaceGeneration = 0;

  const advanceSurfaceGeneration = (): void => {
    surfaceGeneration += 1;
    deps.surface().surfaceCommands = null;
  };
  const captureSurfaceGeneration = (): number => surfaceGeneration;
  const isSurfaceGenerationCurrent = (generation: number): boolean => generation === surfaceGeneration;
  const refreshCurrentSurfaceAfterStale = (generation: number, committed = false): boolean => {
    if (generation === surfaceGeneration) return true;
    const app = deps.surface();
    const routeKey = app.sqlRoute.workspaceKey;
    // #425: `isSignedIn()` is load-bearing, not defensive. Sign-out now advances
    // the surface generation (so a late Dashboard callback can't settle against
    // a replacement renderer) but deliberately leaves the projected workspace in
    // place for the next sign-in — which would otherwise let a write that
    // resolves just after sign-out re-mount the whole signed-in shell OVER the
    // login screen, with no credentials.
    if (committed && deps.hooks.isSignedIn() && app.workspaceRouteStatus === 'ready'
      && app.currentWorkspace && (routeKey === null || routeKey === app.currentWorkspace.key)) {
      deps.hooks.dispatchCurrentSurface();
    }
    return false;
  };
  const loadGeneration = (): number => routeLoadGeneration;
  const currentRouteSearch = (): string => routeSearch;

  const writeRoute = (route: SqlRoute, method: 'push' | 'replace'): void => {
    deps.surface().sqlRoute = route;
    routeSearch = buildSqlRouteSearch(route, routeSearch);
    deps.history[method === 'push' ? 'pushState' : 'replaceState'](
      null, '', deps.basePath() + routeSearch + (deps.locationHash() || ''),
    );
  };

  const loadWorkspaceOnBoot = async (): Promise<StoredWorkspaceV5 | null> => {
    const app = deps.surface();
    const generation = ++routeLoadGeneration;
    const explicitKey = app.sqlRoute.workspaceKey;
    const result = explicitKey !== null
      ? await deps.repository.loadByKey(explicitKey)
      : await deps.session.resolveImplicitOrProvision();
    if (generation !== routeLoadGeneration) return null;
    if (result.status === 'corrupt') {
      app.currentWorkspace = null;
      app.workspaceRouteStatus = 'error';
      deps.hooks.toast(
        'Saved workspace could not be read. Other local workspaces remain unaffected.',
        { action: { label: 'Reset workspace', onClick: () => { deps.hooks.onCorruptWorkspace(result.id); } } },
      );
      return null;
    }
    if (result.status !== 'ok') {
      app.currentWorkspace = null;
      app.workspaceRouteStatus = explicitKey !== null ? 'not-found' : 'error';
      const normalized = normalizeSqlRouteSearch(routeSearch);
      app.sqlRoute = normalized.route;
      if (normalized.search !== routeSearch) {
        routeSearch = normalized.search;
        deps.history.replaceState(null, '', deps.basePath() + routeSearch + (deps.locationHash() || ''));
      }
      return null;
    }
    const workspace = result.workspace;
    // #588 I-9 boundary ②: an external commit/reload landing here must not let
    // this stale load project or write the route.
    await deps.session.recordOpened(workspace);
    if (generation !== routeLoadGeneration) return null;
    deps.hooks.applyCommittedWorkspace(workspace);
    const canonicalRoute = routeForWorkspace(app.sqlRoute, workspace.key);
    const canonicalSearch = buildSqlRouteSearch(canonicalRoute, routeSearch);
    app.sqlRoute = canonicalRoute;
    if (canonicalSearch !== routeSearch) {
      routeSearch = canonicalSearch;
      deps.history.replaceState(null, '', deps.basePath() + routeSearch + (deps.locationHash() || ''));
    }
    // #425: this is a URL-driven open (boot, a deep link, or a workspace
    // switch), so the ROUTE decides the surface — including which Dashboard,
    // resolved through the compatibility selector because the URL carries no id.
    adoptRouteMainSurface();
    return workspace;
  };

  const renderCurrentSurface = (): void => {
    const app = deps.surface();
    if (app.workspaceRouteStatus === 'loading') {
      deps.hooks.renderWorkspaceLoading();
      return;
    }
    if (app.workspaceRouteStatus !== 'ready' || !app.currentWorkspace) {
      deps.hooks.renderWorkspaceNotFound();
      return;
    }
    if (app.sqlRoute.surface === 'dashboard') deps.hooks.renderDashboard();
    else deps.hooks.renderApp();
  };

  const navigateSqlRoute = async (route: SqlRoute, method: 'push' | 'replace'): Promise<void> => {
    deps.hooks.closeShortcutDialog();
    deps.hooks.resetShortcutChord();
    const app = deps.surface();
    const workspaceChanged = route.workspaceKey !== app.sqlRoute.workspaceKey;
    const needsWorkspaceLoad = workspaceChanged || app.currentWorkspace === null;
    writeRoute(route, method);
    if (needsWorkspaceLoad) {
      app.workspaceRouteStatus = 'loading';
      app.currentWorkspace = null;
      deps.hooks.renderWorkspaceLoading();
      const expectedGeneration = routeLoadGeneration + 1;
      // #588 I-9 boundary ③: a newer navigation/popstate landing while this
      // await is pending must leave this stale wave's project/render unrun.
      const workspace = await deps.hooks.dispatchLoadWorkspaceOnBoot();
      if (routeLoadGeneration !== expectedGeneration) return;
      if (workspace) deps.hooks.retryPendingOAuthDocumentRecovery();
    } else {
      adoptRouteMainSurface();
      if (app.currentWorkspace) deps.hooks.retryPendingOAuthDocumentRecovery();
    }
    deps.hooks.dispatchCurrentSurface();
  };

  const handleSqlPopState = async (): Promise<void> => {
    deps.hooks.closeShortcutDialog();
    deps.hooks.resetShortcutChord();
    const app = deps.surface();
    const previousKey = app.sqlRoute.workspaceKey;
    routeSearch = deps.locationSearch();
    app.sqlRoute = parseSqlRoute(routeSearch);
    if (app.sqlRoute.workspaceKey === previousKey && app.currentWorkspace !== null) {
      // #425: Back/Forward between surfaces of the SAME workspace is a surface
      // transition, not a teardown — the shell and the query column stay
      // mounted so the editor state survives it.
      adoptRouteMainSurface();
      if (app.currentWorkspace) deps.hooks.retryPendingOAuthDocumentRecovery();
      deps.hooks.dispatchCurrentSurface();
      return;
    }
    app.workspaceRouteStatus = 'loading';
    app.currentWorkspace = null;
    deps.hooks.renderWorkspaceLoading();
    const expectedGeneration = routeLoadGeneration + 1;
    // #588 I-9 boundary ④: same reasoning as boundary ③, for the popstate path.
    const workspace = await deps.hooks.dispatchLoadWorkspaceOnBoot();
    if (routeLoadGeneration !== expectedGeneration) return;
    if (workspace) deps.hooks.retryPendingOAuthDocumentRecovery();
    deps.hooks.dispatchCurrentSurface();
  };

  const syncSqlRoute = (search: string): void => {
    routeSearch = search;
    deps.surface().sqlRoute = parseSqlRoute(search);
  };

  const rewriteWorkspaceRoute = (workspaceKey: string): void => {
    writeRoute(routeForWorkspace(deps.surface().sqlRoute, workspaceKey), 'replace');
  };

  // #425 — the main-surface navigation API. Every surface transition goes
  // through these functions, so `app.mainSurface` is the ONE writer of the
  // route: the URL is always derived from the session surface, never the
  // other way round, and the two can never disagree.
  const surfaceRouteKey = (): string | null => {
    const app = deps.surface();
    return app.currentWorkspace?.key ?? deps.state.workspaceKey;
  };

  // Surface changes stay in this tab and create one useful history entry; a
  // View/Edit mode change replaces so presentation toggles do not pollute Back
  // (ADR-0003).
  // #471 — write the Dashboard the CURRENT history entry is showing onto that
  // entry, with the scroll offset the DOM has right now. It has to run BEFORE
  // the transition, because `pushState` leaves the outgoing entry's state
  // exactly as it was last written — and again after writing a Dashboard
  // route, so a freshly created entry carries its id immediately.
  const stampDashboardHistoryEntry = (): void => {
    const app = deps.surface();
    const snapshot = dashboardHistorySnapshot(
      app.mainSurface, app.sqlRoute.workspaceKey, deps.hooks.dashboardScrollTop() ?? 0,
    );
    // `null` (Query mode) is written too: it clears a snapshot this entry may
    // carry from an earlier surface, so a Query entry never restores a
    // Dashboard. Unguarded, exactly like `writeRoute` — a platform with no
    // history API fails there on the same transition either way.
    deps.history.replaceState({ dash: snapshot }, '', deps.basePath() + routeSearch + (deps.locationHash() || ''));
  };

  const applyMainSurface = (surface: MainSurfaceState, method: 'push' | 'replace'): void => {
    stampDashboardHistoryEntry();
    const app = deps.surface();
    app.mainSurface = surface;
    writeRoute(mainSurfaceRoute(surface, surfaceRouteKey()), method);
    if (surface.kind === 'dashboard') stampDashboardHistoryEntry();
    // #426: the tree lives in the PERSISTENT shell, so a surface transition
    // does not repaint it as a side effect of re-rendering the work area — it
    // needs telling. Current Dashboard/member styling is derived from this
    // state.
    deps.hooks.invalidateDashboardTree();
    deps.hooks.dispatchCurrentSurface();
  };

  // #426 — deliver focus to one member of the ALREADY-RENDERED Dashboard
  // through the route-local surface command port. `null`/wrong-surface/
  // superseded ports all report `pending`, which means "not deliverable in
  // place" rather than "gone" — the caller then takes the normal render
  // transition.
  const focusDashboardMember = (member: DashboardFocusTarget): DashboardFocusOutcome => {
    const port = deps.surface().surfaceCommands;
    if (!port || port.surface !== 'dashboard') return 'pending';
    return port.focusMember(member);
  };

  const openDashboard = (request: OpenDashboardRequest): void => {
    const app = deps.surface();
    const resolution = resolveOpenDashboard(app.currentWorkspace, request);
    if (resolution.status !== 'ok') {
      // Reported, never repaired: an ambiguous id must not be resolved by a
      // guess, and a deleted one must not silently retarget another Dashboard.
      deps.hooks.toast(resolution.status === 'duplicate'
        ? 'This workspace has more than one dashboard with that id — resolve the duplicate before opening it.'
        : 'That dashboard is no longer part of this workspace.');
      return;
    }
    const sameSelection = isSameDashboardSelection(app.mainSurface, request)
      && app.sqlRoute.surface === 'dashboard';
    if (sameSelection && resolution.surface.kind === 'dashboard') {
      // A repeated open of the SAME id in the SAME mode with NO member is a
      // no-op on the surface itself — but it still CLEARS the current member
      // (opening a Dashboard row deselects whatever member was marked), so the
      // tree repaints.
      if (resolution.surface.pendingFocus === null) {
        app.mainSurface = resolution.surface;
        deps.hooks.invalidateDashboardTree();
        return;
      }
      // #426 — IN-PLACE member navigation. The tree makes repeated
      // same-Dashboard focusing a normal operation, so it must not rebuild the
      // viewer, re-run the Dashboard, or push another history entry (#425
      // re-rendered here, which did all three).
      const member = resolution.surface.pendingFocus;
      const outcome = focusDashboardMember(member);
      if (outcome === 'ok') {
        app.mainSurface = withCurrentMember(app.mainSurface, member);
        deps.hooks.invalidateDashboardTree();
        return;
      }
      if (outcome === 'missing') {
        // Non-destructive: the Dashboard stays open and unchanged, and the
        // member is deliberately NOT marked current — nothing there to mark.
        deps.hooks.toast(member.kind === 'tile'
          ? 'That panel is no longer on this dashboard.'
          : 'That variable is no longer on this dashboard.');
        return;
      }
      // `pending` — a curated filter whose control the opening wave is about
      // to replace, or a superseded port. Fall through to the normal
      // transition, which delivers focus at the deterministic point the node
      // is stable.
    }
    // #426: reaching here with the SAME Dashboard id means the MODE changed
    // (the same-id/same-mode cases all returned above), and a View/Edit switch
    // must preserve the member the user navigated to — `resolveOpenDashboard`
    // builds the surface from the request alone and cannot know one was
    // current.
    applyMainSurface(
      carryCurrentMember(app.mainSurface, resolution.surface),
      app.sqlRoute.surface === 'dashboard' ? 'replace' : 'push',
    );
  };

  const showQuerySurface = (): void => {
    const app = deps.surface();
    if (app.mainSurface.kind === 'query' && app.sqlRoute.surface === 'workspace') return;
    applyMainSurface(QUERY_SURFACE, app.sqlRoute.surface === 'dashboard' ? 'push' : 'replace');
  };

  // The Dashboard entry points that name no Dashboard themselves: the header
  // surface switch, the Workbench "Dashboard →" nav, the `g d`/`g v`/`g e`
  // shortcuts, and the View/Edit switch. An ALREADY-selected Dashboard wins —
  // so a mode change retains the same document rather than retargeting the
  // collection's first entry — and only an unselected surface falls back to
  // the ONE compatibility Dashboard. Either way the open is addressed BY ID.
  // An empty collection still reaches the Dashboard surface so its "Create
  // dashboard" state remains available.
  const showDashboardSurface = (mode: DashboardSurfaceMode): void => {
    const app = deps.surface();
    const selectedId = app.mainSurface.kind === 'dashboard'
      ? app.mainSurface.dashboardId
      : app.currentWorkspace ? resolveCompatibilityDashboard(app.currentWorkspace).selectedId : null;
    if (selectedId !== null) {
      deps.hooks.dispatchOpenDashboard({ dashboardId: selectedId, mode });
      return;
    }
    const method = app.sqlRoute.surface === 'dashboard' ? 'replace' : 'push';
    app.mainSurface = QUERY_SURFACE;
    writeRoute({ surface: 'dashboard', workspaceKey: surfaceRouteKey(), mode }, method);
    // The one surface transition that does not go through `applyMainSurface`,
    // so it has to tell the tree itself.
    deps.hooks.invalidateDashboardTree();
    deps.hooks.dispatchCurrentSurface();
  };

  // #443 — RESOLVE BEFORE NAVIGATING. The shared pre-flight: nothing moves
  // until the id resolves.
  const savedQueryToOpen = (queryId: string): SavedQueryV2 | null => {
    const query = deps.state.savedQueries.find((saved) => saved.id === queryId);
    if (query) return query;
    deps.hooks.toast('That query is no longer part of this workspace.');
    return null;
  };

  /** Switch to Query mode and put `query` in a tab (re-selecting the tab
   *  already open on it). Spread, like saved-history.ts's own two call sites. */
  const openQueryDocument = (query: SavedQueryV2): void => {
    deps.hooks.dispatchShowQuerySurface();
    deps.hooks.loadIntoNewTab({ ...query });
    deps.hooks.toEditorOnMobile();
  };

  const openSavedQuery = (queryId: string): void => {
    const query = savedQueryToOpen(queryId);
    if (query) openQueryDocument(query);
  };

  // #535 — the tile's expand action. Order matters: the tree is revealed
  // FIRST, exactly as the Library-drop settlement does it, so the row is
  // expanded and armed as the tree's position and then the query load moves
  // focus on to the editor. Revealing afterwards would steal focus back out of
  // the editor the user was just sent to.
  const openPanelQuery = (target: { dashboardId: string; tileId: string; queryId: string }): void => {
    const query = savedQueryToOpen(target.queryId);
    if (!query) return;
    deps.hooks.revealAssignedPanel(target.dashboardId, target.tileId);
    openQueryDocument(query);
    // The tile was showing a rendered result, so the editor should too — and
    // on the query's OWN saved view, or a chart panel would arrive as a raw
    // table. A queryless (text) panel never exposes this action, so there is
    // no run-less view-restore branch to mirror from saved-history.ts here.
    //
    // Gated on the tab that ACTUALLY opened, not on `query.sql`: `loadIntoNewTab`
    // (inside `openQueryDocument`) re-selects an existing tab for the same
    // `savedId`, and that tab may hold an unsaved draft the saved document
    // knows nothing about — including a DDL statement, which must never
    // auto-run. A Spec-mode tab is skipped too, since Run silently does
    // nothing there.
    const tab = activeTab(deps.state);
    if (tab.editorMode !== 'spec' && deps.hooks.isAutoRunnableSql(tab.sqlDraft)) {
      deps.hooks.runAction({ view: queryView(query) });
    }
  };

  // #457 — opening a variable's option SQL is a Query-mode act for exactly the
  // same reason opening a saved query is, and routes the same way. The
  // variable is resolved through `dashboardVariables`, the SAME projection the
  // Dashboards tree paints its rows from, so what opens always matches what
  // was clicked.
  const openVariableTab = (dashboardId: string, variableName: string): void => {
    const app = deps.surface();
    const variable = dashboardVariables(app.currentWorkspace, dashboardId)
      .find((candidate) => candidate.name === variableName);
    if (variable === undefined) return;
    deps.hooks.dispatchShowQuerySurface();
    // A newly inferred variable opens EMPTY; a configured one opens on its
    // stored SQL. An orphan is configured by definition, so it opens on its
    // SQL.
    deps.hooks.openVariableTabUi({ dashboardId, variableName }, variable.sql ?? '');
    deps.hooks.toEditorOnMobile();
  };

  // Adopt the surface the ROUTE describes. Used at boot, on Back/Forward, and
  // after a workspace switch — the three moments the URL, not a click, decides
  // the surface. Back/Forward INSIDE the Dashboard surface keeps whatever is
  // explicitly selected: the URL carries no Dashboard id, so re-deriving one
  // here would silently retarget the surface to the collection's first entry.
  const adoptRouteMainSurface = (): void => {
    const app = deps.surface();
    const workspace = app.currentWorkspace;
    if (app.sqlRoute.surface !== 'dashboard') { app.mainSurface = QUERY_SURFACE; return; }
    const mode: DashboardSurfaceMode = app.sqlRoute.mode;
    if (app.mainSurface.kind === 'dashboard') {
      // #426: the mode change owes no new delivery, but the member the user
      // navigated to survives a View/Edit switch. The spread carries
      // `currentMember`; `reconcileMainSurface` then drops it if committed
      // truth no longer contains it.
      app.mainSurface = reconcileMainSurface({ ...app.mainSurface, mode, pendingFocus: null }, workspace);
      return;
    }
    // #471: the route says "a Dashboard" but carries no id, and the session no
    // longer holds one (we are arriving from Query — typically Back out of a
    // tile's Open-in-Workbench). The history ENTRY is the only thing that knows
    // WHICH Dashboard this was, so it is consulted before the compatibility
    // fallback.
    const snapshot = readDashboardHistorySnapshot(deps.history.state, app.sqlRoute.workspaceKey);
    if (snapshot) {
      const restored = restoreDashboardSurface(snapshot, mode, workspace);
      // A snapshot whose Dashboard is gone reconciles to Query; fall through to
      // the compatibility entry only then, exactly as a boot with no snapshot
      // does.
      if (restored.kind === 'dashboard') { app.mainSurface = restored; return; }
    }
    const selectedId = workspace ? resolveCompatibilityDashboard(workspace).selectedId : null;
    app.mainSurface = selectedId === null
      ? QUERY_SURFACE
      : {
        kind: 'dashboard', dashboardId: selectedId, mode,
        currentMember: null, pendingFocus: null, pendingScrollTop: null,
      };
  };

  const reloadDashboardRoute = (): void => {
    const app = deps.surface();
    // #424: fold the projected Dashboard back into the COLLECTION, preserving
    // every other entry. A null projection means "this workspace has no
    // Dashboard", which can only happen when the collection is already empty
    // — never a reason to drop a stored Dashboard, so the array is left alone.
    // #425: fold it back into the SELECTED entry, addressed by id.
    const selectedId = selectedDashboardId(app.mainSurface);
    const foldProjection = (workspace: StoredWorkspaceV5): StoredWorkspaceV5 => {
      if (!deps.state.dashboard) return workspace;
      if (selectedId === null) return withCompatibilityDashboard(workspace, deps.state.dashboard);
      return replaceDashboard(workspace, selectedId, deps.state.dashboard) ?? workspace;
    };
    app.currentWorkspace = app.currentWorkspace
      ? { ...foldProjection(app.currentWorkspace), queries: deps.state.savedQueries }
      : null;
    deps.hooks.renderDashboard();
  };

  return {
    navigateSqlRoute,
    handleSqlPopState,
    syncSqlRoute,
    rewriteWorkspaceRoute,
    writeRoute,
    currentRouteSearch,
    renderCurrentSurface,
    loadWorkspaceOnBoot,
    reloadDashboardRoute,
    openDashboard,
    showQuerySurface,
    showDashboardSurface,
    openSavedQuery,
    openPanelQuery,
    openVariableTab,
    focusDashboardMember,
    captureSurfaceGeneration,
    isSurfaceGenerationCurrent,
    refreshCurrentSurfaceAfterStale,
    advanceSurfaceGeneration,
    loadGeneration,
  };
}
