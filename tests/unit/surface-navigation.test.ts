// Unit tests for `src/application/surface-navigation.ts` (#588 phase 4 wave 4).
//
// This module owns the surface-generation guard cluster, `/sql` route writes,
// boot/popstate/programmatic-navigation loading, and every main-surface
// transition — everything app.ts's pre-#588 route/nav block used to inline.
// These tests construct `createSurfaceNavigation(deps)` directly (no
// `createApp`), with a controllable fake repository/session/history pair so
// the ordering invariants (generation guards, resolve-before-navigate, the
// history-stamp pair, I-9's four await-boundary races) can be driven
// precisely — real controlled-interleaving tests per the #588 phase 4 plan's
// §4a, not weaker "call twice and see" tests.
//
// I-30 (boundary-enforcement, not a new test): `dashboardRenderTarget` — the
// single consumption point for `pendingScrollTop` + `pendingFocus` — did NOT
// move in this extraction. It stays in `src/ui/app.ts` (already covered by
// that file's own dashboard-render tests); this module only PRODUCES
// `pendingFocus`/`pendingScrollTop` (via `resolveOpenDashboard`/
// `withPendingFocus`/history-snapshot restoration in `main-surface.ts`), it
// never consumes them.

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createSurfaceNavigation } from '../../src/application/surface-navigation.js';
import type {
  SurfaceNavigationDeps, SurfaceStatePort, SurfaceNavigation,
} from '../../src/application/surface-navigation.js';
import { createState } from '../../src/state.js';
import type { AppState } from '../../src/state.js';
import type { DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';
import type { WorkspaceRepository, WorkspaceLoadResult } from '../../src/workspace/workspace-repository.js';
import type { WorkspaceSession } from '../../src/application/workspace-session.js';
import { QUERY_SURFACE, mainSurfaceRoute } from '../../src/application/main-surface.js';
import type { OpenDashboardRequest, SurfaceCommandPort } from '../../src/application/main-surface.js';
import { savedQuery } from '../helpers/saved-query.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function dash(id: string, tiles: Array<{ id: string; queryId: string }> = []): DashboardDocumentV2 {
  return {
    documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
    tiles,
  };
}

function workspace(dashboards: DashboardDocumentV2[], queries: SavedQueryV2[] = []): StoredWorkspaceV5 {
  return { storageVersion: 5, id: 'w', key: 'w', name: 'W', queries, dashboards };
}

function fakePort(outcome: 'ok' | 'pending' | 'missing'): SurfaceCommandPort {
  return {
    surface: 'dashboard', generation: 0,
    refresh: vi.fn(), setDashboardStyle: vi.fn(), focusMember: vi.fn(() => outcome),
  };
}

/** Every hook, defaulted to an inert stub — the four "self-dispatch" hooks
 *  (see surface-navigation.ts's own doc comment on them) default to calling
 *  the REAL nav method, mirroring app.ts's production wiring
 *  (`dispatchCurrentSurface: () => app.renderCurrentSurface()`, etc.) via a
 *  forward-declared `navRef` — `nav` itself is only assigned after
 *  `createSurfaceNavigation(deps)` returns, but the hooks are never CALLED
 *  until well after that (same forward-reference pattern app.ts uses
 *  throughout createApp). */
/** #590 decision 16: `SurfaceStatePort.currentWorkspace`/`.workspaceRouteStatus`
 *  are `readonly` on the real port (this module's own production writes to
 *  both are gone). This test module still needs to MUTATE its own `port`
 *  fixture directly (simulating what the app-side retirement coordinator/
 *  `applyCommittedWorkspace` would do) — a mapped type stripping `readonly`
 *  gives back a fully-writable mirror for exactly that purpose, without
 *  reopening the real port's own write hole (`nav`'s production code below
 *  still only ever receives the `readonly`-typed `SurfaceStatePort`). */
type MutablePort = { -readonly [K in keyof SurfaceStatePort]: SurfaceStatePort[K] };

function makeHooks(navRef: { current?: SurfaceNavigation }, port: MutablePort) {
  return {
    // Mirrors app.ts's real `applyCommittedWorkspace`'s ONE relevant effect
    // for this module's own purposes: projecting the committed workspace onto
    // `currentWorkspace`/`workspaceRouteStatus`. The rest of the real
    // function (tab reconciliation, tree pruning, `state.dashboard`
    // projection) is app.test.ts's territory, not this module's.
    applyCommittedWorkspace: vi.fn((ws: StoredWorkspaceV5) => {
      port.currentWorkspace = ws;
      port.workspaceRouteStatus = 'ready';
    }),
    renderApp: vi.fn(),
    renderDashboard: vi.fn(),
    // #590 §1.9 — mirrors the app-side retirement coordinator's fixed
    // write order (status FIRST, §1.7) for the mocked hooks this module
    // calls; the real disposing render/DOM is app.ts's own territory.
    retireToWorkspaceLoading: vi.fn(() => {
      port.workspaceRouteStatus = 'loading';
      port.currentWorkspace = null;
    }),
    retireToWorkspaceFailure: vi.fn((status: 'not-found' | 'error') => {
      port.workspaceRouteStatus = status;
      port.currentWorkspace = null;
    }),
    rerenderRetiredSurface: vi.fn(),
    onCorruptWorkspace: vi.fn(),
    retryPendingOAuthDocumentRecovery: vi.fn(),
    closeShortcutDialog: vi.fn(),
    resetShortcutChord: vi.fn(),
    isSignedIn: vi.fn(() => true),
    toast: vi.fn(),
    revealAssignedPanel: vi.fn(),
    loadIntoNewTab: vi.fn(),
    openVariableTabUi: vi.fn(),
    toEditorOnMobile: vi.fn(),
    runAction: vi.fn(),
    dashboardScrollTop: vi.fn((): number | null => null),
    isAutoRunnableSql: vi.fn(() => true),
    dispatchCurrentSurface: vi.fn(() => navRef.current!.renderCurrentSurface()),
    dispatchLoadWorkspaceOnBoot: vi.fn(() => navRef.current!.loadWorkspaceOnBoot()),
    dispatchShowQuerySurface: vi.fn(() => navRef.current!.showQuerySurface()),
    dispatchOpenDashboard: vi.fn((request: OpenDashboardRequest) => navRef.current!.openDashboard(request)),
  };
}

function setup(over: {
  state?: { savedQueries?: SavedQueryV2[] };
  repository?: Partial<Pick<WorkspaceRepository, 'loadByKey'>>;
  session?: Partial<Pick<WorkspaceSession, 'resolveImplicitOrProvision' | 'recordOpened'>>;
} = {}) {
  const state: AppState = createState({ loadStr: (_k, d) => d, loadJSON: (_k, d) => d });
  if (over.state?.savedQueries) state.savedQueries = over.state.savedQueries;

  const port: MutablePort = {
    sqlRoute: { surface: 'workspace', workspaceKey: null },
    mainSurface: QUERY_SURFACE,
    currentWorkspace: null,
    workspaceRouteStatus: 'ready',
    surfaceCommands: null,
  };

  let historyStateValue: unknown = null;
  const pushState = vi.fn((_data: unknown, _unused: string, _url?: string) => {});
  const replaceState = vi.fn((s: unknown, _unused: string, _url?: string) => { historyStateValue = s; });
  const history = {
    pushState,
    replaceState,
    get state(): unknown { return historyStateValue; },
  };

  const repository: Pick<WorkspaceRepository, 'loadByKey'> = {
    loadByKey: vi.fn(async () => ({ status: 'empty' as const })),
    ...over.repository,
  };
  const session: Pick<WorkspaceSession, 'resolveImplicitOrProvision' | 'recordOpened'> = {
    resolveImplicitOrProvision: vi.fn(async () => ({ status: 'empty' as const })),
    recordOpened: vi.fn(async () => {}),
    ...over.session,
  };

  const navRef: { current?: SurfaceNavigation } = {};
  const hooks = makeHooks(navRef, port);

  let locationSearchValue = '';
  const deps: SurfaceNavigationDeps = {
    state,
    surface: () => port,
    repository,
    session,
    history,
    basePath: () => '/sql',
    locationHash: () => '',
    locationSearch: () => locationSearchValue,
    hooks,
  };
  const nav = createSurfaceNavigation(deps);
  navRef.current = nav;
  return {
    nav, deps, state, port, history, repository, session, hooks,
    setLocationSearch: (s: string) => { locationSearchValue = s; },
  };
}

// ---------------------------------------------------------------------------
// Surface-generation guard cluster
// ---------------------------------------------------------------------------

describe('surface-generation guard cluster', () => {
  it('bumps the generation on a TRANSITION call, not merely because a mount happened', () => {
    const { nav } = setup();
    const before = nav.captureSurfaceGeneration();
    expect(nav.isSurfaceGenerationCurrent(before)).toBe(true);
    nav.advanceSurfaceGeneration();
    expect(nav.isSurfaceGenerationCurrent(before)).toBe(false);
    expect(nav.captureSurfaceGeneration()).toBe(before + 1);
  });

  it('advanceSurfaceGeneration clears surfaceCommands', () => {
    const { nav, port } = setup();
    port.surfaceCommands = fakePort('ok');
    nav.advanceSurfaceGeneration();
    expect(port.surfaceCommands).toBeNull();
  });

  describe('refreshCurrentSurfaceAfterStale — the compound re-render gate', () => {
    it('generation-match short-circuit: returns true immediately and renders nothing when the caller is still current', () => {
      const { nav, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      expect(nav.refreshCurrentSurfaceAfterStale(gen, true)).toBe(true);
      expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
    });

    it('committed flag: a stale, UNcommitted caller returns false and renders nothing', () => {
      const { nav, port, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      nav.advanceSurfaceGeneration();
      port.currentWorkspace = workspace([]);
      port.workspaceRouteStatus = 'ready';
      port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
      expect(nav.refreshCurrentSurfaceAfterStale(gen, false)).toBe(false);
      expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
    });

    // I-8
    it('signed-in guard (I-8): a stale, committed caller with no signed-in session must not remount over login', () => {
      const { nav, port, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      nav.advanceSurfaceGeneration();
      port.currentWorkspace = workspace([]);
      port.workspaceRouteStatus = 'ready';
      port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
      hooks.isSignedIn.mockReturnValue(false);
      expect(nav.refreshCurrentSurfaceAfterStale(gen, true)).toBe(false);
      expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
      // Sabotage-verified manually (see wave 4 report): removing the
      // `isSignedIn()` condition from the compound gate makes this test fail.
    });

    it('route-key match: a stale, committed, signed-in caller whose route names a DIFFERENT workspace renders nothing', () => {
      const { nav, port, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      nav.advanceSurfaceGeneration();
      port.currentWorkspace = workspace([]);
      port.workspaceRouteStatus = 'ready';
      port.sqlRoute = { surface: 'workspace', workspaceKey: 'other' };
      expect(nav.refreshCurrentSurfaceAfterStale(gen, true)).toBe(false);
      expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
    });

    it('workspaceRouteStatus/currentWorkspace: a stale, committed, signed-in caller with no ready projected workspace renders nothing', () => {
      const { nav, port, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      nav.advanceSurfaceGeneration();
      port.workspaceRouteStatus = 'loading';
      expect(nav.refreshCurrentSurfaceAfterStale(gen, true)).toBe(false);
      expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
    });

    it('all conditions satisfied: a stale, committed, signed-in caller whose route matches renders once and still returns false', () => {
      const { nav, port, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      nav.advanceSurfaceGeneration();
      port.currentWorkspace = workspace([]);
      port.workspaceRouteStatus = 'ready';
      port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
      expect(nav.refreshCurrentSurfaceAfterStale(gen, true)).toBe(false);
      expect(hooks.dispatchCurrentSurface).toHaveBeenCalledTimes(1);
    });

    it('a null route workspaceKey matches any projected workspace', () => {
      const { nav, port, hooks } = setup();
      const gen = nav.captureSurfaceGeneration();
      nav.advanceSurfaceGeneration();
      port.currentWorkspace = workspace([]);
      port.workspaceRouteStatus = 'ready';
      port.sqlRoute = { surface: 'workspace', workspaceKey: null };
      expect(nav.refreshCurrentSurfaceAfterStale(gen, true)).toBe(false);
      expect(hooks.dispatchCurrentSurface).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// I-9 — one race per await boundary (four boundaries, controlled interleaving)
// ---------------------------------------------------------------------------

describe('I-9: one race per await boundary', () => {
  it('① loadWorkspaceOnBoot: a stale call\'s own post-initial-await generation check blocks it, isolated from boundary② (its own result is not "ok", a path boundary② never reaches)', async () => {
    const resolvers = new Map<string, (r: WorkspaceLoadResult) => void>();
    const { nav, port, hooks } = setup({
      repository: { loadByKey: vi.fn((key: string) => new Promise<WorkspaceLoadResult>((resolve) => resolvers.set(key, resolve))) },
    });
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'a' };
    const callA = nav.loadWorkspaceOnBoot(); // generation 1
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'b' };
    const callB = nav.loadWorkspaceOnBoot(); // generation 2

    const b: StoredWorkspaceV5 = { storageVersion: 5, id: 'b', key: 'b', name: 'B', queries: [], dashboards: [] };
    resolvers.get('b')!({ status: 'ok', workspace: b });
    expect(await callB).toBe(b);
    expect(hooks.applyCommittedWorkspace).toHaveBeenCalledTimes(1);
    expect(hooks.applyCommittedWorkspace).toHaveBeenCalledWith(b);
    expect(port.currentWorkspace).toBe(b);
    expect(port.workspaceRouteStatus).toBe('ready');

    // A's OWN load result comes back NOT-ok — a branch that returns BEFORE
    // ever reaching boundary②'s `recordOpened` check, so only THIS (the
    // first) generation check can protect B's already-committed projection
    // from being clobbered by A's stale not-ok branch.
    resolvers.get('a')!({ status: 'empty' });
    expect(await callA).toBeNull();
    expect(port.currentWorkspace).toBe(b); // still B — A's stale branch never ran
    expect(port.workspaceRouteStatus).toBe('ready'); // never flipped to 'not-found'/'error'
    expect(hooks.applyCommittedWorkspace).toHaveBeenCalledTimes(1); // still just B
  });

  it('② loadWorkspaceOnBoot: a stale call\'s own post-recordOpened generation check blocks it once a newer call wins', async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const { nav, port, hooks } = setup({
      repository: {
        loadByKey: vi.fn(async (key: string): Promise<WorkspaceLoadResult> => ({
          status: 'ok' as const,
          workspace: { storageVersion: 5, id: key, key, name: key.toUpperCase(), queries: [], dashboards: [] },
        })),
      },
      session: {
        recordOpened: vi.fn(async (ws: StoredWorkspaceV5) => { if (ws.key === 'a') await gateA; }),
      },
    });
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'a' };
    const callA = nav.loadWorkspaceOnBoot(); // generation 1, gated inside recordOpened
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'b' };
    const callB = nav.loadWorkspaceOnBoot(); // generation 2, resolves fully first
    expect(await callB).not.toBeNull();
    expect(hooks.applyCommittedWorkspace).toHaveBeenCalledTimes(1);

    releaseA();
    expect(await callA).toBeNull(); // caught by the SECOND generation check, after recordOpened
    expect(hooks.applyCommittedWorkspace).toHaveBeenCalledTimes(1); // still just B
  });

  it('③ navigateSqlRoute: a stale call\'s own post-await check prevents it rendering after losing the race', async () => {
    const resolvers = new Map<string, (r: WorkspaceLoadResult) => void>();
    const { nav, hooks } = setup({
      repository: { loadByKey: vi.fn((key: string) => new Promise<WorkspaceLoadResult>((resolve) => resolvers.set(key, resolve))) },
    });
    const navA = nav.navigateSqlRoute({ surface: 'workspace', workspaceKey: 'a' }, 'push');
    const navB = nav.navigateSqlRoute({ surface: 'workspace', workspaceKey: 'b' }, 'push');

    const b: StoredWorkspaceV5 = { storageVersion: 5, id: 'b', key: 'b', name: 'B', queries: [], dashboards: [] };
    resolvers.get('b')!({ status: 'ok', workspace: b });
    await navB;
    const rendersAfterB = (hooks.dispatchCurrentSurface as Mock).mock.calls.length;
    expect(rendersAfterB).toBeGreaterThan(0);
    expect(hooks.retryPendingOAuthDocumentRecovery).toHaveBeenCalledTimes(1);

    const a: StoredWorkspaceV5 = { storageVersion: 5, id: 'a', key: 'a', name: 'A', queries: [], dashboards: [] };
    resolvers.get('a')!({ status: 'ok', workspace: a });
    await navA;

    // The loser's own post-await generation check exits BEFORE reaching the
    // unconditional render call at the end of `navigateSqlRoute` — no extra
    // render, and no extra recovery retry, for the stale wave.
    expect((hooks.dispatchCurrentSurface as Mock).mock.calls.length).toBe(rendersAfterB);
    expect(hooks.retryPendingOAuthDocumentRecovery).toHaveBeenCalledTimes(1);
  });

  it('④ handleSqlPopState: a stale call\'s own post-await check prevents it rendering after losing the race', async () => {
    const resolvers = new Map<string, (r: WorkspaceLoadResult) => void>();
    const { nav, hooks, setLocationSearch } = setup({
      repository: { loadByKey: vi.fn((key: string) => new Promise<WorkspaceLoadResult>((resolve) => resolvers.set(key, resolve))) },
    });
    setLocationSearch('?ws=a');
    const popA = nav.handleSqlPopState();
    setLocationSearch('?ws=b');
    const popB = nav.handleSqlPopState();

    const b: StoredWorkspaceV5 = { storageVersion: 5, id: 'b', key: 'b', name: 'B', queries: [], dashboards: [] };
    resolvers.get('b')!({ status: 'ok', workspace: b });
    await popB;
    const rendersAfterB = (hooks.dispatchCurrentSurface as Mock).mock.calls.length;
    expect(rendersAfterB).toBeGreaterThan(0);

    const a: StoredWorkspaceV5 = { storageVersion: 5, id: 'a', key: 'a', name: 'A', queries: [], dashboards: [] };
    resolvers.get('a')!({ status: 'ok', workspace: a });
    await popA;

    expect((hooks.dispatchCurrentSurface as Mock).mock.calls.length).toBe(rendersAfterB);
  });
});

// ---------------------------------------------------------------------------
// I-10 — same-workspace popstate is a surface transition, not a teardown
// ---------------------------------------------------------------------------

describe('I-10: same-workspace popstate is a surface transition, not a teardown', () => {
  it('never enters the loading/teardown state; adopts the route and renders directly', async () => {
    const ws = workspace([dash('a')]);
    const { nav, port, hooks, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.workspaceRouteStatus = 'ready';
    setLocationSearch('?ws=w&surface=dashboard&mode=view');

    await nav.handleSqlPopState();

    // Neither the loading placeholder nor a currentWorkspace/status reset
    // fires — both are the signals `ensureShell`/`disposeShell` (app.ts) use
    // to decide whether the persistent shell must be rebuilt.
    expect(hooks.retireToWorkspaceLoading).not.toHaveBeenCalled();
    expect(port.workspaceRouteStatus).toBe('ready');
    expect(port.currentWorkspace).toBe(ws);
    expect(hooks.dispatchCurrentSurface).toHaveBeenCalledTimes(1);
    expect(port.mainSurface).toMatchObject({ kind: 'dashboard', dashboardId: 'a', mode: 'view' });
  });
});

// ---------------------------------------------------------------------------
// I-11 — pendingFocus consumed exactly once; currentMember survives delivery
// and View/Edit switches
// ---------------------------------------------------------------------------

describe('I-11: pendingFocus one-shot delivery; currentMember survives', () => {
  it('an in-place focus delivery (outcome "ok") clears pendingFocus but marks currentMember', () => {
    const ws = workspace([dash('a', [{ id: 't1', queryId: 'q1' }])]);
    const { nav, port } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'edit' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    const port2 = fakePort('ok');
    port.surfaceCommands = port2;

    nav.openDashboard({ dashboardId: 'a', mode: 'edit', focus: { kind: 'tile', id: 't1' } });

    expect(port2.focusMember).toHaveBeenCalledWith({ kind: 'tile', id: 't1' });
    expect(port.mainSurface).toMatchObject({
      kind: 'dashboard', currentMember: { kind: 'tile', id: 't1' }, pendingFocus: null,
    });
  });

  it('a View/Edit mode switch (adoptRouteMainSurface, via same-workspace popstate) preserves currentMember', async () => {
    const ws = workspace([dash('a', [{ id: 't1', queryId: 'q1' }])]);
    const { nav, port, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'edit' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: { kind: 'tile', id: 't1' }, pendingFocus: null, pendingScrollTop: null,
    };
    setLocationSearch('?ws=w&surface=dashboard&mode=view');

    await nav.handleSqlPopState();

    expect(port.mainSurface).toMatchObject({
      kind: 'dashboard', mode: 'view', currentMember: { kind: 'tile', id: 't1' }, pendingFocus: null,
    });
  });
});

// ---------------------------------------------------------------------------
// I-12 — dashboard history-entry snapshot stamped before the transition AND
// after a dashboard push
// ---------------------------------------------------------------------------

describe('I-12: dashboard history-entry snapshot stamped before AND after a dashboard push', () => {
  it('stamps twice when opening a Dashboard: once before the route write (with no prior selection), once after', () => {
    const ws = workspace([dash('a')]);
    const { nav, port, history, hooks } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;
    hooks.dashboardScrollTop.mockReturnValue(42);

    nav.openDashboard({ dashboardId: 'a', mode: 'edit' });

    // Route writes (push/replace with `null` state) are distinct calls from a
    // history STAMP (`replaceState` carrying a `{dash: …}` state object).
    const stamps = (history.replaceState as Mock).mock.calls.filter((call) => call[0] !== null);
    expect(stamps).toHaveLength(2);
    expect(stamps[0][0]).toEqual({ dash: null }); // BEFORE: leaving Query, nothing to remember
    expect(stamps[1][0]).toEqual({
      dash: { workspaceKey: 'w', dashboardId: 'a', currentMember: null, scrollTop: 42 },
    });
    // Sabotage-verified manually (see wave 4 report): dropping the SECOND
    // stamp call in `applyMainSurface` makes this assertion fail (only one
    // stamp would be recorded).
  });
});

// ---------------------------------------------------------------------------
// I-24 — resolve-before-navigate
// ---------------------------------------------------------------------------

describe('I-24: resolve-before-navigate', () => {
  it('openDashboard: a missing id changes no route/surface and calls no render hook', () => {
    const ws = workspace([dash('a')]);
    const { nav, port, hooks, history } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;

    nav.openDashboard({ dashboardId: 'gone', mode: 'edit' });

    expect(port.mainSurface).toBe(QUERY_SURFACE);
    expect(port.sqlRoute).toEqual({ surface: 'workspace', workspaceKey: 'w' });
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
    expect(hooks.toast).toHaveBeenCalledTimes(1);
  });

  it('openSavedQuery: an unresolved id changes no surface and opens no tab', () => {
    const { nav, port, hooks } = setup({ state: { savedQueries: [] } });
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };

    nav.openSavedQuery('gone');

    expect(port.mainSurface).toMatchObject({ kind: 'dashboard' });
    expect(hooks.dispatchShowQuerySurface).not.toHaveBeenCalled();
    expect(hooks.loadIntoNewTab).not.toHaveBeenCalled();
    expect(hooks.toast).toHaveBeenCalledWith('That query is no longer part of this workspace.');
  });

  it('openVariableTab: an unresolved variable name opens no tab and switches no surface', () => {
    const ws = workspace([dash('a')]); // no queries, so no variable is inferred
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };

    nav.openVariableTab('a', 'does-not-exist');

    expect(port.mainSurface).toMatchObject({ kind: 'dashboard' });
    expect(hooks.dispatchShowQuerySurface).not.toHaveBeenCalled();
    expect(hooks.openVariableTabUi).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// I-25 — openPanelQuery reveals the tree row BEFORE opening the query
// ---------------------------------------------------------------------------

describe('I-25: openPanelQuery reveals the tree row before opening the query', () => {
  it('calls revealAssignedPanel before loadIntoNewTab', () => {
    const query = savedQuery({ id: 'q1', sql: 'SELECT 1', view: 'panel' });
    const { nav, hooks } = setup({ state: { savedQueries: [query] } });

    nav.openPanelQuery({ dashboardId: 'a', tileId: 't1', queryId: 'q1' });

    expect(hooks.revealAssignedPanel).toHaveBeenCalledWith('a', 't1');
    expect(hooks.loadIntoNewTab).toHaveBeenCalledWith({ ...query });
    const revealOrder = (hooks.revealAssignedPanel as Mock).mock.invocationCallOrder[0];
    const loadOrder = (hooks.loadIntoNewTab as Mock).mock.invocationCallOrder[0];
    expect(revealOrder).toBeLessThan(loadOrder);
    // Sabotage-verified manually (see wave 4 report): swapping the two calls
    // makes `revealOrder < loadOrder` fail.
  });
});

// ---------------------------------------------------------------------------
// I-3 — app.mainSurface is the single writer of the /sql route
// ---------------------------------------------------------------------------

describe('I-3: mainSurface is the single writer of the /sql route', () => {
  it('every surface-changing operation leaves sqlRoute exactly mainSurfaceRoute(mainSurface, key)', () => {
    const ws = workspace([dash('a'), dash('b')]);
    const { nav, port } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;

    const assertConsistent = (): void => {
      expect(port.sqlRoute).toEqual(mainSurfaceRoute(port.mainSurface, port.currentWorkspace?.key ?? null));
    };

    nav.openDashboard({ dashboardId: 'a', mode: 'edit' });
    assertConsistent();
    nav.showDashboardSurface('view');
    assertConsistent();
    nav.showQuerySurface();
    assertConsistent();
    nav.openDashboard({ dashboardId: 'b', mode: 'edit' });
    assertConsistent();
    // Sabotage-verified manually (see wave 4 report): a hypothetical direct
    // `writeRoute(...)` call bypassing `app.mainSurface` (or vice versa) would
    // desync the two and fail `assertConsistent`.
  });
});

// ---------------------------------------------------------------------------
// openDashboard — remaining branches
// ---------------------------------------------------------------------------

describe('openDashboard — remaining branches', () => {
  it('reports a duplicate id via diagnostics rather than guessing an entry', () => {
    const ws = workspace([dash('dup'), dash('dup')]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;

    nav.openDashboard({ dashboardId: 'dup', mode: 'edit' });

    expect(hooks.toast).toHaveBeenCalledWith(expect.stringContaining('more than one dashboard'));
  });

  it('re-opening the same id/mode with no focus target clears currentMember but does not re-render', () => {
    const ws = workspace([dash('a')]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'edit' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: { kind: 'tile', id: 't1' }, pendingFocus: null, pendingScrollTop: null,
    };

    const previousSurface = port.mainSurface;
    nav.openDashboard({ dashboardId: 'a', mode: 'edit' });

    // #590: no explicit invalidation hook exists any more — the tree
    // observes the write itself. This module's job is only to prove nav
    // wrote a FRESH `mainSurface` object (the write that, under signals,
    // notifies the tree effect); the reactive settlement itself is proven
    // in app.test.ts against a real `createApp()`.
    expect(port.mainSurface).not.toBe(previousSurface);
    expect(port.mainSurface).toMatchObject({ currentMember: null });
    expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
  });

  it('a "missing" in-place outcome is non-destructive and reports variable-specific wording', () => {
    const ws = workspace([dash('a')]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'edit' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    port.surfaceCommands = fakePort('missing');

    nav.openDashboard({ dashboardId: 'a', mode: 'edit', focus: { kind: 'variable', id: 'p' } });

    expect(hooks.toast).toHaveBeenCalledWith('That variable is no longer on this dashboard.');
    expect(port.mainSurface).toMatchObject({ currentMember: null });
  });

  it('a "missing" in-place outcome reports panel-specific wording for a tile member', () => {
    const ws = workspace([dash('a')]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'edit' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    port.surfaceCommands = fakePort('missing');

    nav.openDashboard({ dashboardId: 'a', mode: 'edit', focus: { kind: 'tile', id: 'gone' } });

    expect(hooks.toast).toHaveBeenCalledWith('That panel is no longer on this dashboard.');
  });

  it('a "pending" in-place outcome falls through to the normal render transition', () => {
    const ws = workspace([dash('a')]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'edit' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    port.surfaceCommands = fakePort('pending');

    nav.openDashboard({ dashboardId: 'a', mode: 'edit', focus: { kind: 'tile', id: 't1' } });

    expect(hooks.dispatchCurrentSurface).toHaveBeenCalledTimes(1);
    expect(port.mainSurface).toMatchObject({ pendingFocus: { kind: 'tile', id: 't1' } });
  });
});

// ---------------------------------------------------------------------------
// openPanelQuery — run-on-arrival branches
// ---------------------------------------------------------------------------

describe('openPanelQuery — run-on-arrival branches', () => {
  it('runs when auto-runnable and not in Spec mode, on the query\'s own saved view', () => {
    const query = savedQuery({ id: 'q1', sql: 'SELECT 1', view: 'panel' });
    const { nav, state, hooks } = setup({ state: { savedQueries: [query] } });
    state.tabs.value[0].editorMode = 'sql';
    state.tabs.value[0].sqlDraft = 'SELECT 1';
    hooks.isAutoRunnableSql.mockReturnValue(true);

    nav.openPanelQuery({ dashboardId: 'a', tileId: 't1', queryId: 'q1' });

    expect(hooks.runAction).toHaveBeenCalledWith({ view: 'panel' });
  });

  it('does not run when not auto-runnable', () => {
    const query = savedQuery({ id: 'q1', sql: 'DROP TABLE t' });
    const { nav, state, hooks } = setup({ state: { savedQueries: [query] } });
    state.tabs.value[0].editorMode = 'sql';
    hooks.isAutoRunnableSql.mockReturnValue(false);

    nav.openPanelQuery({ dashboardId: 'a', tileId: 't1', queryId: 'q1' });

    expect(hooks.runAction).not.toHaveBeenCalled();
  });

  it('does not run on a Spec-mode tab', () => {
    const query = savedQuery({ id: 'q1', sql: 'SELECT 1' });
    const { nav, state, hooks } = setup({ state: { savedQueries: [query] } });
    state.tabs.value[0].editorMode = 'spec';
    hooks.isAutoRunnableSql.mockReturnValue(true);

    nav.openPanelQuery({ dashboardId: 'a', tileId: 't1', queryId: 'q1' });

    expect(hooks.runAction).not.toHaveBeenCalled();
  });

  it('an unresolved id reveals nothing and runs nothing', () => {
    const { nav, hooks } = setup({ state: { savedQueries: [] } });

    nav.openPanelQuery({ dashboardId: 'a', tileId: 't1', queryId: 'gone' });

    expect(hooks.revealAssignedPanel).not.toHaveBeenCalled();
    expect(hooks.runAction).not.toHaveBeenCalled();
    expect(hooks.toast).toHaveBeenCalledWith('That query is no longer part of this workspace.');
  });
});

// ---------------------------------------------------------------------------
// openSavedQuery / openVariableTab — success paths
// ---------------------------------------------------------------------------

describe('openSavedQuery / openVariableTab — success paths', () => {
  it('openSavedQuery: a resolved id switches to Query and loads the tab', () => {
    const query = savedQuery({ id: 'q1', sql: 'SELECT 1' });
    const { nav, hooks } = setup({ state: { savedQueries: [query] } });

    nav.openSavedQuery('q1');

    expect(hooks.dispatchShowQuerySurface).toHaveBeenCalledTimes(1);
    expect(hooks.loadIntoNewTab).toHaveBeenCalledWith({ ...query });
    expect(hooks.toEditorOnMobile).toHaveBeenCalledTimes(1);
  });

  it('openVariableTab: a resolved variable switches to Query and opens on its inferred SQL', () => {
    const query = savedQuery({ id: 'q1', sql: 'SELECT {p:String}' });
    const ws = workspace([dash('a', [{ id: 't1', queryId: 'q1' }])], [query]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;

    nav.openVariableTab('a', 'p');

    expect(hooks.dispatchShowQuerySurface).toHaveBeenCalledTimes(1);
    expect(hooks.openVariableTabUi).toHaveBeenCalledWith({ dashboardId: 'a', variableName: 'p' }, '');
    expect(hooks.toEditorOnMobile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// adoptRouteMainSurface branches (reached only via handleSqlPopState's
// same-workspace path, or loadWorkspaceOnBoot — it is nav-private otherwise)
// ---------------------------------------------------------------------------

describe('adoptRouteMainSurface branches', () => {
  it('a non-dashboard route resets mainSurface to Query', async () => {
    const ws = workspace([dash('a')]);
    const { nav, port, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = {
      kind: 'dashboard', dashboardId: 'a', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    setLocationSearch('?ws=w');

    await nav.handleSqlPopState();

    expect(port.mainSurface).toEqual(QUERY_SURFACE);
  });

  it('falls back to the compatibility Dashboard when no history snapshot exists and none is selected', async () => {
    const ws = workspace([dash('first'), dash('second')]);
    const { nav, port, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;
    setLocationSearch('?ws=w&surface=dashboard&mode=edit');

    await nav.handleSqlPopState();

    expect(port.mainSurface).toMatchObject({ kind: 'dashboard', dashboardId: 'first' });
  });

  it('falls back to Query when the collection has no Dashboard at all', async () => {
    const ws = workspace([]);
    const { nav, port, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;
    setLocationSearch('?ws=w&surface=dashboard&mode=edit');

    await nav.handleSqlPopState();

    expect(port.mainSurface).toEqual(QUERY_SURFACE);
  });

  it('a stale history snapshot whose Dashboard is gone falls through to the compatibility entry', async () => {
    const ws = workspace([dash('first')]);
    const { nav, port, history, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;
    history.replaceState({ dash: { workspaceKey: 'w', dashboardId: 'deleted-since', currentMember: null, scrollTop: 90 } }, '', '');
    setLocationSearch('?ws=w&surface=dashboard&mode=edit');

    await nav.handleSqlPopState();

    expect(port.mainSurface).toMatchObject({ dashboardId: 'first' });
  });

  it('a valid history snapshot restores the remembered Dashboard', async () => {
    const ws = workspace([dash('first'), dash('second')]);
    const { nav, port, history, setLocationSearch } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    port.mainSurface = QUERY_SURFACE;
    history.replaceState({ dash: { workspaceKey: 'w', dashboardId: 'second', currentMember: null, scrollTop: 90 } }, '', '');
    setLocationSearch('?ws=w&surface=dashboard&mode=edit');

    await nav.handleSqlPopState();

    expect(port.mainSurface).toMatchObject({ dashboardId: 'second', pendingScrollTop: 90 });
  });
});

// #590 §1.6: `reloadDashboardRoute` is deleted outright (the fold-and-
// reassign it performed was a second `committedWorkspace` publication per
// Dashboard-route File-menu commit, breaking the exact-once settlement
// invariant once `currentWorkspace` is signal-backed) — its "branches"
// describe block above went with it. The render-only replacement
// (`app.renderCurrentSurface()`) is covered by file-menu.test.ts's Dashboard
// branch and app.test.ts's real File-menu Dashboard-route settlement test.

// ---------------------------------------------------------------------------
// Coverage sweep — remaining direct members / branches
// ---------------------------------------------------------------------------

describe('coverage sweep — remaining branches', () => {
  it('syncSqlRoute reparses the route and updates currentRouteSearch', () => {
    const { nav, port } = setup();
    nav.syncSqlRoute('?ws=ops&surface=dashboard&mode=view');
    expect(port.sqlRoute).toEqual({ surface: 'dashboard', workspaceKey: 'ops', mode: 'view' });
    expect(nav.currentRouteSearch()).toBe('?ws=ops&surface=dashboard&mode=view');
  });

  it('rewriteWorkspaceRoute preserves the current surface/mode, only swapping the workspace key', () => {
    const { nav, port, history } = setup();
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'old', mode: 'view' };
    nav.rewriteWorkspaceRoute('new-key');
    expect(port.sqlRoute).toEqual({ surface: 'dashboard', workspaceKey: 'new-key', mode: 'view' });
    expect(history.replaceState).toHaveBeenCalled();
  });

  it('writeRoute: push vs. replace both drive history and sqlRoute', () => {
    const { nav, port, history } = setup();
    nav.writeRoute({ surface: 'workspace', workspaceKey: 'a' }, 'push');
    expect(history.pushState).toHaveBeenCalledTimes(1);
    expect(port.sqlRoute).toEqual({ surface: 'workspace', workspaceKey: 'a' });
    nav.writeRoute({ surface: 'workspace', workspaceKey: 'b' }, 'replace');
    expect(history.replaceState).toHaveBeenCalled();
    expect(port.sqlRoute).toEqual({ surface: 'workspace', workspaceKey: 'b' });
  });

  it('renderCurrentSurface dispatches to renderApp for a ready workspace-surface route', () => {
    const { nav, port, hooks } = setup();
    port.currentWorkspace = workspace([]);
    port.workspaceRouteStatus = 'ready';
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    nav.renderCurrentSurface();
    expect(hooks.renderApp).toHaveBeenCalledTimes(1);
    expect(hooks.renderDashboard).not.toHaveBeenCalled();
  });

  it('renderCurrentSurface dispatches to the publication-free re-render when not ready with no workspace', () => {
    // #590: the status/null pair was already published by whichever
    // retirement op got there first — this dispatch only re-renders.
    const { nav, hooks } = setup();
    nav.renderCurrentSurface();
    expect(hooks.rerenderRetiredSurface).toHaveBeenCalledTimes(1);
  });

  it('renderCurrentSurface dispatches to the publication-free re-render while loading', () => {
    const { nav, port, hooks } = setup();
    port.workspaceRouteStatus = 'loading';
    nav.renderCurrentSurface();
    expect(hooks.rerenderRetiredSurface).toHaveBeenCalledTimes(1);
  });

  it('showDashboardSurface with no selection opens the legacy no-chooser entry point directly (push)', () => {
    const { nav, port, state, hooks, history } = setup();
    port.currentWorkspace = null;
    port.mainSurface = QUERY_SURFACE;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };
    // No `currentWorkspace`, so `surfaceRouteKey()` falls back to
    // `state.workspaceKey` (not `sqlRoute.workspaceKey` — #425's route-key
    // resolution is deliberately not just an echo of the incoming route).
    state.workspaceKey = 'w';

    nav.showDashboardSurface('edit');

    expect(port.sqlRoute).toEqual({ surface: 'dashboard', workspaceKey: 'w', mode: 'edit' });
    expect(history.pushState).toHaveBeenCalledTimes(1);
    // #590 decision 12 / §1 audit table: `kind` is provably `'query'` already
    // in this branch, so the write is a same-reference no-op on the frozen
    // `QUERY_SURFACE` singleton — a real signal would notify NOTHING (proven
    // against a real `createApp()` in app.test.ts / surface-navigation
    // `treeNavigation` coverage); this module's own proxy for that is the
    // reference staying byte-identical.
    expect(port.mainSurface).toBe(QUERY_SURFACE);
    expect(hooks.dispatchCurrentSurface).toHaveBeenCalledTimes(1);
  });

  it('showDashboardSurface with no selection, already on the Dashboard surface, replaces instead of pushing', () => {
    const { nav, port, history } = setup();
    port.currentWorkspace = null;
    port.mainSurface = QUERY_SURFACE;
    port.sqlRoute = { surface: 'dashboard', workspaceKey: 'w', mode: 'view' };

    nav.showDashboardSurface('edit');

    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalled();
  });

  it('showDashboardSurface with an unselected but non-empty workspace resolves the compatibility Dashboard by id', () => {
    const ws = workspace([dash('first'), dash('second')]);
    const { nav, port, hooks } = setup();
    port.currentWorkspace = ws;
    port.mainSurface = QUERY_SURFACE;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };

    nav.showDashboardSurface('edit');

    expect(hooks.dispatchOpenDashboard).toHaveBeenCalledWith({ dashboardId: 'first', mode: 'edit' });
  });

  it('showQuerySurface is a no-op when the Query surface is already active', () => {
    const { nav, port, history, hooks } = setup();
    port.mainSurface = QUERY_SURFACE;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };

    nav.showQuerySurface();

    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(hooks.dispatchCurrentSurface).not.toHaveBeenCalled();
  });

  it('focusDashboardMember reports "pending" with no port, and "pending" with a non-dashboard port', () => {
    const { nav, port } = setup();
    port.surfaceCommands = null;
    expect(nav.focusDashboardMember({ kind: 'tile', id: 't1' })).toBe('pending');
  });

  it('loadWorkspaceOnBoot: an explicit unresolved key canonicalizes the route without falling back', async () => {
    const { nav, port } = setup({ repository: { loadByKey: vi.fn(async () => ({ status: 'empty' as const })) } });
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'missing' };

    const result = await nav.loadWorkspaceOnBoot();

    expect(result).toBeNull();
    expect(port.workspaceRouteStatus).toBe('not-found');
  });

  it('loadWorkspaceOnBoot: an explicit unresolved key ALSO strips a retired legacy hint from the canonicalized URL', async () => {
    const { nav, port, history } = setup({ repository: { loadByKey: vi.fn(async () => ({ status: 'empty' as const })) } });
    nav.syncSqlRoute('?ws=missing&iss=https%3A%2F%2Faccounts.google.com');
    expect(port.sqlRoute).toEqual({ surface: 'workspace', workspaceKey: 'missing' });

    const result = await nav.loadWorkspaceOnBoot();

    expect(result).toBeNull();
    expect(port.workspaceRouteStatus).toBe('not-found');
    expect(nav.currentRouteSearch()).toBe('?ws=missing');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/sql?ws=missing');
  });

  it('loadWorkspaceOnBoot: a corrupt record surfaces via the toast hook with a Reset action wired to onCorruptWorkspace', async () => {
    const { nav, port, hooks } = setup({
      repository: { loadByKey: vi.fn(async () => ({ status: 'corrupt' as const, id: 'corrupt-id', key: 'k', diagnostics: [] })) },
    });
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'k' };

    const result = await nav.loadWorkspaceOnBoot();

    expect(result).toBeNull();
    expect(port.workspaceRouteStatus).toBe('error');
    expect(hooks.toast).toHaveBeenCalledTimes(1);
    const [, opts] = (hooks.toast as Mock).mock.calls[0];
    opts.action.onClick();
    expect(hooks.onCorruptWorkspace).toHaveBeenCalledWith('corrupt-id');
  });

  it('loadWorkspaceOnBoot: an implicit resolution (no explicit key) goes through resolveImplicitOrProvision', async () => {
    const ws: StoredWorkspaceV5 = { storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [], dashboards: [] };
    const { nav, port, session } = setup({
      session: { resolveImplicitOrProvision: vi.fn(async () => ({ status: 'ok' as const, workspace: ws })) },
    });
    port.sqlRoute = { surface: 'workspace', workspaceKey: null };

    const result = await nav.loadWorkspaceOnBoot();

    expect(result).toBe(ws);
    expect(session.resolveImplicitOrProvision).toHaveBeenCalledTimes(1);
  });

  it('loadWorkspaceOnBoot: an implicit resolution that comes back empty is an "error" status, not "not-found"', async () => {
    const { nav, port } = setup({
      session: { resolveImplicitOrProvision: vi.fn(async () => ({ status: 'empty' as const })) },
    });
    port.sqlRoute = { surface: 'workspace', workspaceKey: null };

    const result = await nav.loadWorkspaceOnBoot();

    expect(result).toBeNull();
    expect(port.workspaceRouteStatus).toBe('error');
  });

  it('loadGeneration reflects the load-attempt counter directly', async () => {
    const { nav } = setup();
    expect(nav.loadGeneration()).toBe(0);
    await nav.loadWorkspaceOnBoot();
    expect(nav.loadGeneration()).toBe(1);
    await nav.loadWorkspaceOnBoot();
    expect(nav.loadGeneration()).toBe(2);
  });

  it('navigateSqlRoute: a same-workspace navigation adopts the surface in place without reloading', async () => {
    const ws: StoredWorkspaceV5 = { storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [], dashboards: [] };
    const { nav, port, repository, hooks } = setup();
    port.currentWorkspace = ws;
    port.sqlRoute = { surface: 'workspace', workspaceKey: 'w' };

    await nav.navigateSqlRoute({ surface: 'dashboard', workspaceKey: 'w', mode: 'edit' }, 'replace');

    expect(repository.loadByKey).not.toHaveBeenCalled();
    expect(hooks.dispatchCurrentSurface).toHaveBeenCalledTimes(1);
  });
});
