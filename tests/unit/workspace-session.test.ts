// Unit tests for `src/application/workspace-session.ts` (#588 phase 4 wave 3).
//
// This module owns queueing, repository calls, this tab's snapshot-identity
// token, the BroadcastChannel wire + focus/visibility refresh fallback, the
// `beforeunload` dirty guard, and initial-workspace provisioning — everything
// `app.ts`'s pre-#588 write/refresh/cross-tab block used to inline. These tests
// construct `createWorkspaceSession(deps)` directly (no `createApp`), with a
// small controllable fake repository/event-target pair so the ordering
// invariants (queue serialization, read-at-dequeue, stale-route re-checks,
// generation-tokened bypass) can be driven precisely.
//
// Real controlled-interleaving tests per the #588 phase 4 plan's §4a (NOT
// weaker "call twice and see" tests): every gate below is released explicitly,
// at a chosen point, so the assertion proves ORDER, not just eventual outcome.

import { describe, it, expect, vi } from 'vitest';
import { createWorkspaceSession } from '../../src/application/workspace-session.js';
import type { WorkspaceSessionDeps } from '../../src/application/workspace-session.js';
import { createState } from '../../src/state.js';
import type { AppState } from '../../src/state.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';
import type { WorkspaceRepository } from '../../src/workspace/workspace-repository.js';
import { workspaceToken, queryToken } from '../../src/workspace/workspace-sync.js';
import type { BroadcastChannelPort } from '../../src/env.types.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** A minimal DOM-EventTarget-shaped fake — `addEventListener`/`removeEventListener`
 *  really register/unregister, and `dispatch` really invokes the registered
 *  listeners, so the beforeunload/focus/visibility tests exercise the REAL
 *  registration lifecycle rather than asserting on a spy's call args alone. */
function fakeEventTarget() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, event: unknown = {}): void {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

class FakeBeforeUnloadEvent {
  defaultPrevented = false;
  returnValue: unknown = '';
  preventDefault(): void { this.defaultPrevented = true; }
}

/** A controllable in-memory `WorkspaceRepository` — `gateLoadById`/`gateCommit`
 *  let a test hold either call open until it releases a promise, mirroring the
 *  plan's "injected fake repository with per-call deferreds" (§4a). Logs every
 *  `loadById`/`commit` call (id / candidate) so a test can assert ORDER and
 *  COUNT, not just the final persisted value. */
function makeFakeRepository(initial: StoredWorkspaceV5 | null) {
  let current = initial;
  let loadByIdGate: (() => Promise<void>) | null = null;
  let commitGate: (() => Promise<void>) | null = null;
  let rejectNextLoadById: Error | null = null;
  const loadByIdLog: string[] = [];
  const commitLog: StoredWorkspaceV5[] = [];
  const repository: WorkspaceRepository = {
    list: async () => ({ summaries: [], corrupt: [] }),
    loadById: async (id) => {
      loadByIdLog.push(id);
      if (rejectNextLoadById) {
        const err = rejectNextLoadById;
        rejectNextLoadById = null;
        throw err;
      }
      if (loadByIdGate) await loadByIdGate();
      return current && current.id === id
        ? { status: 'ok' as const, workspace: current }
        : { status: 'empty' as const };
    },
    loadByKey: async () => ({ status: 'empty' as const }),
    create: async (candidate) => {
      current = candidate;
      return { ok: true as const, workspace: candidate, dashboardRevision: null };
    },
    commit: async (candidate) => {
      commitLog.push(candidate);
      if (commitGate) await commitGate();
      current = candidate;
      return { ok: true as const, workspace: candidate, dashboardRevision: null };
    },
    delete: async (id) => {
      const deleted = current?.id === id;
      if (deleted) current = null;
      return { ok: true as const, deleted };
    },
    resolveImplicit: async () => (
      current ? { status: 'ok' as const, workspace: current } : { status: 'empty' as const }
    ),
    markOpened: async () => ({ ok: true as const }),
  };
  return {
    repository,
    loadByIdLog,
    commitLog,
    gateLoadById: (gate: () => Promise<void>) => { loadByIdGate = gate; },
    gateCommit: (gate: () => Promise<void>) => { commitGate = gate; },
    rejectNextLoadByIdWith: (err: Error) => { rejectNextLoadById = err; },
    getCurrent: () => current,
  };
}

function makeHooks() {
  return {
    applyCommittedWorkspace: vi.fn<(ws: StoredWorkspaceV5) => void>(),
    onWorkspaceMissing: vi.fn<() => void>(),
    isWorkbenchSurface: vi.fn(() => true),
    refreshWorkbenchUi: vi.fn(),
    notifyExternallyChanged: vi.fn(),
    onExternalInvalidation: vi.fn(),
    warnRefreshFailed: vi.fn(),
    warnMarkOpenedFailed: vi.fn(),
  };
}

function setup(over: {
  initial?: StoredWorkspaceV5 | null;
  broadcastChannelFactory?: (name: string) => BroadcastChannelPort | null;
} = {}) {
  const state: AppState = createState({ loadStr: (_k, d) => d, loadJSON: (_k, d) => d });
  const fakeRepo = makeFakeRepository(over.initial ?? null);
  const hooks = makeHooks();
  const win = fakeEventTarget();
  const doc = fakeEventTarget();
  const routeStatusBox: { value: 'loading' | 'ready' | 'not-found' | 'error' } = { value: 'ready' };
  const loadGenBox = { value: 0 };
  let uidCounter = 0;
  const deps: WorkspaceSessionDeps = {
    repository: fakeRepo.repository,
    state,
    uid: (prefix) => `${prefix}${++uidCounter}`,
    genId: () => `gen-${++uidCounter}`,
    broadcastChannelFactory: over.broadcastChannelFactory ?? (() => null),
    documentVisible: () => true,
    windowSeam: win,
    documentSeam: doc,
    routeCurrency: {
      routeWorkspaceKey: () => state.workspaceKey,
      routeStatus: () => routeStatusBox.value,
      loadGeneration: () => loadGenBox.value,
    },
    hooks,
  };
  const session = createWorkspaceSession(deps);
  return { session, deps, state, hooks, fakeRepo, win, doc, routeStatusBox, loadGenBox };
}

const microtask = (): Promise<void> => Promise.resolve();
const settle = async (n = 2): Promise<void> => { for (let i = 0; i < n; i++) await microtask(); };

// ---------------------------------------------------------------------------
// I-1 — queue serialization
// ---------------------------------------------------------------------------

describe('I-1: queue serialization', () => {
  it('holds mutation A open; a concurrent refresh queued behind it does not read until A settles; a rejected read warns without wedging the chain; a later mutation still commits', async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'Base', queries: [], dashboards: [] };
    const { session, state, fakeRepo, hooks } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';

    let releaseCommit: () => void = () => {};
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    fakeRepo.gateCommit(() => commitGate);

    // Mutation A enters the queue and reaches its (gated) commit.
    const mutationA = session.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'A' } }));
    // A refresh is requested WHILE A is still pending — it must queue behind A,
    // not race it.
    const refreshPromise = session.refreshWorkspaceFromStore();
    await settle();

    // A's own `loadById` (the read-at-dequeue) has fired, but the refresh's
    // read must NOT have — it is still queued behind A's gated commit.
    expect(fakeRepo.loadByIdLog).toEqual(['w1']);

    releaseCommit();
    await mutationA;
    await refreshPromise;

    // Now that A settled, the refresh's own read DID fire.
    expect(fakeRepo.loadByIdLog).toEqual(['w1', 'w1']);

    // A rejected read warns internally and does not reject the chain.
    fakeRepo.rejectNextLoadByIdWith(new Error('idb down'));
    await expect(session.refreshWorkspaceFromStore()).resolves.toBeUndefined();
    expect(hooks.warnRefreshFailed).toHaveBeenCalledTimes(1);

    // The queue is not wedged: a later mutation still commits.
    const mutationC = await session.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'C' } }));
    expect(mutationC.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-2 — read-at-dequeue
// ---------------------------------------------------------------------------

describe('I-2: read-at-dequeue', () => {
  it("mutation B, invoked while A is pending, reads the aggregate AFTER A's commit and its transform sees A's committed value", async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'Base', queries: [], dashboards: [] };
    const { session, state, fakeRepo } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const mutationA = session.mutateWorkspace(async (latest) => {
      await gateA; // A's transform is held open
      return { candidate: { ...latest!, name: 'V1' } };
    });
    await settle();

    // B is invoked while A is still pending.
    const seenByB: string[] = [];
    const mutationB = session.mutateWorkspace((latest) => {
      seenByB.push(latest!.name);
      return { candidate: { ...latest!, name: 'V2-over-' + latest!.name } };
    });

    releaseA();
    await mutationA;
    await mutationB;

    // B's transform ran only after A committed, and saw A's committed 'V1' —
    // not the 'Base' value that was current when B was invoked.
    expect(seenByB).toEqual(['V1']);
    expect(fakeRepo.commitLog.map((ws) => ws.name)).toEqual(['V1', 'V2-over-V1']);
  });
});

// ---------------------------------------------------------------------------
// I-13 — beforeunload generation tokens
// ---------------------------------------------------------------------------

describe('I-13: beforeunload OAuth-redirect bypass generation tokens', () => {
  it("an older arm's release cannot disarm a newer arm", () => {
    const { session, state, win } = setup();
    state.tabs.value[0].dirtySql = true; // make the guard actually install
    session.syncBeforeUnload();
    expect(win.listenerCount('beforeunload')).toBe(1);

    const releaseOld = session.armOAuthRedirectUnloadBypass();
    const releaseNew = session.armOAuthRedirectUnloadBypass();
    releaseOld(); // stale — must be a no-op against the newer arm

    const stillArmed = new FakeBeforeUnloadEvent();
    win.dispatch('beforeunload', stillArmed);
    expect(stillArmed.defaultPrevented).toBe(false); // the NEW arm is still armed

    const afterConsumed = new FakeBeforeUnloadEvent();
    win.dispatch('beforeunload', afterConsumed);
    expect(afterConsumed.defaultPrevented).toBe(true); // the arm is one-shot; ordinary unloads warn again
    void releaseNew; // exercised above (its arm was the one `stillArmed` consumed)
  });
});

// ---------------------------------------------------------------------------
// I-22 — cross-tab wire compat
// ---------------------------------------------------------------------------

describe('I-22: cross-tab wire compat', () => {
  it('pins the BroadcastChannel name', () => {
    const seen: string[] = [];
    setup({ broadcastChannelFactory: (name) => { seen.push(name); return null; } });
    expect(seen).toEqual(['asb:workspace']);
  });

  it('pins the WorkspaceChangedMessage wire shape posted on a successful commit', async () => {
    const posted: unknown[] = [];
    const channel: BroadcastChannelPort = { onmessage: null, postMessage: (m) => posted.push(m), close: () => {} };
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    const { session, state } = setup({ initial: ws1, broadcastChannelFactory: () => channel });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';

    await session.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'Changed' } }));

    expect(posted).toEqual([{ type: 'workspace-changed', sourceTabId: session.sourceTabId, workspaceId: 'w1' }]);
  });
});

// ---------------------------------------------------------------------------
// I-26 — refreshPending clears at DEQUEUE, not read-completion
// ---------------------------------------------------------------------------

describe('I-26: refreshPending clears at dequeue', () => {
  it('a poke arriving while the store read is still in flight schedules a fresh follow-up (not coalesced away)', async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    const { session, state, fakeRepo } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';

    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    fakeRepo.gateLoadById(() => readGate);

    session.scheduleRefresh(); // 1st poke
    await settle();
    // The queued op has DEQUEUED (its read has started) — `refreshPending`
    // must already be false at this point, even though the read itself is
    // still gated (not yet resolved).
    expect(fakeRepo.loadByIdLog).toHaveLength(1);

    session.scheduleRefresh(); // a 2nd poke arriving mid-read
    releaseRead();
    await session.flushWorkspaceWrites();

    // Two SEPARATE reads: the second poke was not coalesced into the first
    // (which had already dequeued), because `refreshPending` had already
    // cleared before the read resolved.
    expect(fakeRepo.loadByIdLog).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// I-27 — queriesDidChange computed from a PRE-projection snapshot
// ---------------------------------------------------------------------------

describe('I-27: queriesDidChange from the pre-projection snapshot', () => {
  it('compares state.savedQueries as it stood BEFORE applyCommittedWorkspace projects the new collection', async () => {
    const oldQuery: SavedQueryV2 = { id: 'q1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'q1', favorite: false } };
    const newQuery: SavedQueryV2 = { id: 'q1', sql: 'SELECT 2', specVersion: 1, spec: { name: 'q1', favorite: false } };
    const ws2: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [newQuery], dashboards: [] };
    const { session, state, hooks } = setup({ initial: ws2 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';
    state.savedQueries = [oldQuery]; // the PRE-projection snapshot, different from the store
    // Mirrors app.ts's own `applyCommittedWorkspace`: projects `savedQueries`.
    hooks.applyCommittedWorkspace.mockImplementation((ws) => { state.savedQueries = ws.queries; });

    await session.refreshWorkspaceFromStore();

    expect(hooks.notifyExternallyChanged).toHaveBeenCalledWith({ workspace: ws2, queriesChanged: true });
  });
});

// ---------------------------------------------------------------------------
// I-28 — pre-commit stale-route re-check (distinct from the post-commit check)
// ---------------------------------------------------------------------------

describe('I-28: pre-commit stale-route re-check', () => {
  it('a workspace switch landing DURING the transform aborts before commit is ever called', async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    const { session, state, fakeRepo } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';

    const result = await session.mutateWorkspace(async (latest) => {
      // A route/workspace switch lands while this transform is still
      // resolving (e.g. a user dialog, an async Spec evaluation) — before any
      // candidate ever reaches the durable commit boundary below.
      state.workspaceId = 'w2';
      return { candidate: { ...latest!, name: 'Should never commit' } };
    });

    expect(result).toEqual({ ok: false, aborted: true, data: undefined });
    expect(fakeRepo.commitLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// I-4 (session-owned half) — token recording via recordProjection
// ---------------------------------------------------------------------------

describe('I-4 (session-owned half): recordProjection / getLastCommittedToken', () => {
  it('starts empty, and recordProjection sets the snapshot token to the given workspace', () => {
    const { session } = setup();
    expect(session.getLastCommittedToken()).toBe('');
    const ws: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    session.recordProjection(ws);
    expect(session.getLastCommittedToken()).toBe(workspaceToken(ws));
    expect(session.getLastCommittedToken().length).toBeGreaterThan(0);
  });

  it('a successful mutateWorkspace commit records the new token via the applyCommittedWorkspace hook path', async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    const { session, state, hooks } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';
    // Mirrors app.ts's applyCommittedWorkspace: it is the ONE place that calls
    // `recordProjection` (#588 — the token half of I-4 stays enforced even
    // though the projection funnel itself lives in app.ts).
    hooks.applyCommittedWorkspace.mockImplementation((ws) => session.recordProjection(ws));

    await session.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'Changed' } }));

    expect(session.getLastCommittedToken()).toBe(workspaceToken({ ...ws1, name: 'Changed' }));
  });
});

// ---------------------------------------------------------------------------
// I-5 — broadcast fires exactly once after a real commit, even when the route
// went stale DURING the commit await (distinct from I-28's pre-commit check)
// ---------------------------------------------------------------------------

describe('I-5: broadcast ordering', () => {
  it('posts exactly one invalidation after a successful commit, even when the route goes stale while the commit is in flight', async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    const posted: unknown[] = [];
    const channel: BroadcastChannelPort = { onmessage: null, postMessage: (m) => posted.push(m), close: () => {} };
    const { session, state, fakeRepo, hooks } = setup({ initial: ws1, broadcastChannelFactory: () => channel });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';

    let releaseCommit: () => void = () => {};
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    fakeRepo.gateCommit(() => commitGate);

    const pending = session.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'Changed' } }));
    await settle();
    // The durable write already began (past I-28's pre-commit check); the
    // route now goes stale WHILE the commit is in flight.
    state.workspaceId = 'w2';
    releaseCommit();
    const result = await pending;

    // This tab's own caller sees the abort (it left the route) …
    expect(result).toEqual({ ok: false, aborted: true, data: undefined });
    expect(hooks.applyCommittedWorkspace).not.toHaveBeenCalled();
    // … but the OTHER tab is still told about the durable write that landed.
    expect(posted).toEqual([{ type: 'workspace-changed', sourceTabId: session.sourceTabId, workspaceId: 'w1' }]);
  });
});

// ---------------------------------------------------------------------------
// I-6 (session-owned half) — reconcile linked tabs from the PRE-projection
// snapshot, before applyCommittedWorkspace projects the new collection
// ---------------------------------------------------------------------------

describe('I-6 (session-owned half): reconcile-then-project ordering', () => {
  it('a clean linked tab whose query vanished externally detaches — proof reconcileLinkedTabsToLatest ran against pre-projection state', async () => {
    const query: SavedQueryV2 = { id: 'q1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'q1', favorite: false } };
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] }; // q1 deleted externally
    const { session, state, hooks } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';
    state.savedQueries = [query];
    const tab = state.tabs.value[0];
    tab.savedId = 'q1';
    tab.dirtySql = false;
    tab.lastCommittedQueryToken = queryToken(query);
    hooks.applyCommittedWorkspace.mockImplementation((ws) => { state.savedQueries = ws.queries; });

    await session.refreshWorkspaceFromStore();

    expect(tab.savedId).toBeNull(); // clean + deleted externally → detach
  });
});

// ---------------------------------------------------------------------------
// General wiring sanity (onWorkspaceMissing / isWorkbenchSurface /
// provisioning) — not a named invariant row on their own, but the surrounding
// hook plumbing these tests exercise IS what I-1/I-2/I-26/I-27/I-28 above run
// through.
// ---------------------------------------------------------------------------

describe('supporting hook wiring', () => {
  it('onWorkspaceMissing fires when the active record is gone during a mutation, and the transform never runs', async () => {
    const { session, state, hooks } = setup({ initial: null });
    state.workspaceId = 'missing'; state.workspaceKey = 'k1';
    const transform = vi.fn();

    const result = await session.mutateWorkspace(transform);

    expect(result).toEqual({ ok: false, aborted: true });
    expect(transform).not.toHaveBeenCalled();
    expect(hooks.onWorkspaceMissing).toHaveBeenCalledTimes(1);
  });

  it('onWorkspaceMissing fires when a refresh discovers the workspace was deleted', async () => {
    const ws1: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'k1', name: 'N', queries: [], dashboards: [] };
    const { session, state, fakeRepo, hooks } = setup({ initial: ws1 });
    state.workspaceId = 'w1'; state.workspaceKey = 'k1';
    session.recordProjection(ws1); // seed a real baseline token so this isn't a no-op
    await fakeRepo.repository.delete('w1');

    await session.refreshWorkspaceFromStore();

    expect(hooks.onWorkspaceMissing).toHaveBeenCalledTimes(1);
  });

  it('resolveImplicitOrProvision provisions a fresh workspace when the collection is empty, and recordOpened warns on a failed markOpened', async () => {
    const { session, hooks, fakeRepo } = setup({ initial: null });

    const result = await session.resolveImplicitOrProvision();
    expect(result.status).toBe('ok');

    fakeRepo.repository.markOpened = async () => ({ ok: false, diagnostics: [] });
    if (result.status === 'ok') await session.recordOpened(result.workspace);
    expect(hooks.warnMarkOpenedFailed).toHaveBeenCalledTimes(1);
  });
});
