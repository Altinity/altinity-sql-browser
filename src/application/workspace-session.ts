// The workspace write/refresh/cross-tab session (#588 phase 4 wave 3).
// Owns: serialized writes, the read-at-dequeue `mutateWorkspace` primitive,
// this tab's snapshot-identity token bookkeeping, the BroadcastChannel
// invalidation wire + focus/visibility fallback, the coalesced refresh
// scheduler, the `beforeunload` dirty guard (incl. the OAuth-redirect
// generation-tokened bypass), and initial-workspace provisioning.
//
// Deliberately NOT here: `applyCommittedWorkspace` (src/ui/app.ts) — it
// renders tabs, cancels deferred Dashboard-tree clicks, rewrites the route on
// a lost selection, and invalidates the Dashboard tree. That is real UI
// orchestration, not "zero DOM" (the #588 issue text notwithstanding — a
// plan-stage review caught this and corrected it), so it stays in app.ts and
// is reached here only through `hooks.applyCommittedWorkspace`, an INJECTED
// callback this module calls but never implements. This keeps the dependency
// direction `workspace <- application <- UI` intact: this module imports
// `../workspace/*` and `../state.ts`, never `../ui/*`.
//
// `lastCommittedToken`'s bookkeeping half lives here too (`recordProjection`/
// `getLastCommittedToken`): `applyCommittedWorkspace` calls
// `session.recordProjection(workspace)` at the point it used to assign
// `lastCommittedToken` directly, so the one-token-per-projection invariant
// (#343 §2 — EVERY projection funnels through `applyCommittedWorkspace`, which
// makes it the one place this has to be recorded) still holds even though the
// funnel itself did not move.

import type { StoredWorkspaceV5 } from '../generated/json-schema.types.js';
import type {
  WorkspaceRepository, WorkspaceLoadResult,
} from '../workspace/workspace-repository.js';
import { createNewWorkspace, DEFAULT_WORKSPACE_NAME } from '../workspace/workspace-operations.js';
import { deriveWorkspaceKey } from '../core/workspace-key.js';
import { workspaceToken, queriesChanged } from '../workspace/workspace-sync.js';
import {
  reconcileLinkedTabsToLatest, tabSaveDirty,
} from '../state.js';
import type {
  AppState, MutateWorkspace, WorkspaceExternallyChangedInfo,
} from '../state.js';
import type { BroadcastChannelPort } from '../env.types.js';
import type { WorkspaceRouteStatus } from './main-surface.js';

/** The cross-tab invalidation signal (#343 §5) — a small "reload the record"
 *  poke, never the workspace body. `sourceTabId` lets a tab ignore its own
 *  broadcast; `workspaceId` scopes it to a specific aggregate. Moved here from
 *  `src/ui/app.types.ts` (#588 phase 4 §3-T #1) — this module is now the one
 *  place the wire shape is declared; `app.types.ts` re-exports it so every
 *  existing importer keeps compiling unchanged. */
export interface WorkspaceChangedMessage {
  type: 'workspace-changed';
  sourceTabId: string;
  workspaceId: string;
}

export interface WorkspaceSessionDeps {
  repository: WorkspaceRepository;
  state: AppState;
  uid(prefix: string): string;
  genId(): string;
  broadcastChannelFactory(name: string): BroadcastChannelPort | null;
  documentVisible(): boolean;
  windowSeam: { addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] };
  documentSeam: { addEventListener?: Document['addEventListener'] };
  /** Route-currency reads. THIS wave wires these as thunks reading app.ts's
   *  raw closures/fields directly (`() => app.sqlRoute.workspaceKey`, etc.) —
   *  wave 4 (`src/application/surface-navigation.ts`) rewires the THUNK
   *  BODIES onto its own accessors; this session's own interface is frozen
   *  and does not change then. */
  routeCurrency: {
    routeWorkspaceKey(): string | null;
    routeStatus(): WorkspaceRouteStatus;
    loadGeneration(): number;
  };
  hooks: {
    applyCommittedWorkspace(ws: StoredWorkspaceV5): void;
    onWorkspaceMissing(): void;
    isWorkbenchSurface(): boolean;
    refreshWorkbenchUi(): void;
    notifyExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
    onExternalInvalidation(msg: WorkspaceChangedMessage): void;
    warnRefreshFailed(): void;
    warnMarkOpenedFailed(): void;
  };
}

export interface WorkspaceSession {
  serializeWrite<T>(op: () => Promise<T>): Promise<T>;
  flushWorkspaceWrites(): Promise<void>;
  mutateWorkspace: MutateWorkspace;
  refreshWorkspaceFromStore(): Promise<void>;
  scheduleRefresh(): void;
  sourceTabId: string;
  getLastCommittedToken(): string;
  recordProjection(ws: StoredWorkspaceV5): void;
  syncBeforeUnload(): void;
  armOAuthRedirectUnloadBypass(): () => void;
  resolveImplicitOrProvision(): Promise<WorkspaceLoadResult>;
  recordOpened(ws: StoredWorkspaceV5): Promise<void>;
}

export function createWorkspaceSession(deps: WorkspaceSessionDeps): WorkspaceSession {
  // #287 review fix: serialize saved-query writes so overlapping async CRUD
  // commits can't interleave. Without this, a delete and a star toggle fired in
  // rapid succession each build a candidate from the same stale
  // `state.savedQueries` snapshot, and whichever commits LAST wins — resurrecting
  // a just-deleted query (or clobbering a concurrent edit). Chaining each op
  // after the previous one fully resolves means the next op reads the freshest
  // projected state. The chain swallows rejections so one failed op never
  // wedges the queue; the op's own result/rejection still reaches its caller.
  let writeChain: Promise<unknown> = Promise.resolve();
  const serializeWrite = <T,>(op: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(op, op);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  };
  // #341: resolve once every write accepted BEFORE this call has settled (export
  // waits on this so a bundle is built from the latest committed workspace, never
  // mid-flight state). Writes queued AFTER this call are intentionally not awaited.
  // `writeChain` itself is always rejection-swallowed by `serializeWrite`, so
  // awaiting it is sufficient; callers still observe their own operation's
  // rejection through the separately returned `run` promise.
  const flushWorkspaceWrites = async (): Promise<void> => { await writeChain; };
  // #343 §5: this tab's random per-session id (crypto seam, like `uid`), stamped
  // on every outgoing invalidation so a tab ignores its OWN broadcast.
  const sourceTabId = deps.uid('tab-');
  // #343 §2: snapshot-identity of the workspace this tab last committed. Only
  // used to detect whether a later reload actually changed anything (not CAS).
  let lastCommittedToken = '';
  const getLastCommittedToken = (): string => lastCommittedToken;
  // #343: EVERY projection funnels through `applyCommittedWorkspace` (app.ts),
  // which calls this at the point it used to assign `lastCommittedToken`
  // directly — the token stays consistent with what's on screen without this
  // module implementing the projection itself.
  const recordProjection = (ws: StoredWorkspaceV5): void => { lastCommittedToken = workspaceToken(ws); };

  // #343 §5: open the invalidation channel and route inbound pokes (that aren't
  // our own) to the hook. Never carries the workspace body — only a signal.
  const workspaceChannel = deps.broadcastChannelFactory('asb:workspace');
  if (workspaceChannel) {
    workspaceChannel.onmessage = (event) => {
      const msg = event.data as WorkspaceChangedMessage | null;
      if (!msg || msg.type !== 'workspace-changed' || msg.sourceTabId === sourceTabId
        || msg.workspaceId !== deps.state.workspaceId) return;
      deps.hooks.onExternalInvalidation(msg);
    };
  }

  const routeStillMatches = (requestedWorkspaceKey: string): boolean => (
    deps.routeCurrency.routeWorkspaceKey() === null
    || deps.routeCurrency.routeWorkspaceKey() === requestedWorkspaceKey
  );

  // Build every mutation from this tab's active workspace, reloaded by
  // immutable id INSIDE the queue. Repository commits can never create, so an
  // externally deleted active workspace aborts rather than resurrecting it.
  // #343 §2: on a SUCCESSFUL commit the primitive itself owns the projection
  // (`applyCommittedWorkspace`, exactly once), records the snapshot token, and
  // broadcasts ONE invalidation — callers no longer project. An aborted
  // transform (null / null candidate) commits nothing and notifies no one; a
  // failed commit surfaces its diagnostics without projecting or notifying.
  const mutateWorkspace: MutateWorkspace = (transform) => {
    const requestedWorkspaceId = deps.state.workspaceId;
    const requestedWorkspaceKey = deps.state.workspaceKey;
    const requestedRouteGeneration = deps.routeCurrency.loadGeneration();
    if (deps.routeCurrency.routeStatus() !== 'ready'
      || !routeStillMatches(requestedWorkspaceKey)) {
      return Promise.resolve({ ok: false as const, aborted: true as const });
    }
    return serializeWrite(async () => {
      if (deps.routeCurrency.routeStatus() !== 'ready'
        || deps.routeCurrency.loadGeneration() !== requestedRouteGeneration
        || deps.state.workspaceId !== requestedWorkspaceId
        || !routeStillMatches(requestedWorkspaceKey)) {
        return { ok: false as const, aborted: true as const };
      }
      const loaded = await deps.repository.loadById(requestedWorkspaceId);
      if (loaded.status === 'corrupt') {
        return { ok: false as const, diagnostics: loaded.diagnostics };
      }
      if (loaded.status !== 'ok') {
        deps.hooks.onWorkspaceMissing();
        return { ok: false as const, aborted: true as const };
      }
      const latest = loaded.workspace;
      const input = await transform(latest);
      if (!input || !input.candidate) {
        return { ok: false as const, aborted: true as const, data: input ? input.data : undefined };
      }
      // #588 I-28: the stale-route fence is RE-CHECKED here, between the async
      // `transform` and the durable commit boundary below — distinct from both
      // the pre-transform check above and the post-commit re-check further
      // down. A route/workspace switch that lands while `transform` awaited
      // (a user dialog, a Spec evaluation) must not commit its stale candidate.
      if (deps.routeCurrency.routeStatus() !== 'ready'
        || deps.routeCurrency.loadGeneration() !== requestedRouteGeneration
        || deps.state.workspaceId !== requestedWorkspaceId
        || !routeStillMatches(requestedWorkspaceKey)) {
        return { ok: false as const, aborted: true as const, data: input.data };
      }
      const result = await deps.repository.commit(input.candidate);
      if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics, data: input.data };
      const routeIsStillCurrent = deps.routeCurrency.routeStatus() === 'ready'
        && deps.routeCurrency.loadGeneration() === requestedRouteGeneration
        && deps.state.workspaceId === requestedWorkspaceId
        && routeStillMatches(requestedWorkspaceKey);
      if (routeIsStillCurrent) {
        deps.hooks.applyCommittedWorkspace(result.workspace); // #343: also records lastCommittedToken
      }
      if (workspaceChannel) {
        workspaceChannel.postMessage({
          type: 'workspace-changed', sourceTabId, workspaceId: result.workspace.id,
        });
      }
      // The persistence operation may already have crossed its commit boundary
      // when navigation began. Keep that durable write, but do not let its
      // route-local caller repaint/toast against the new URL.
      if (!routeIsStillCurrent) {
        return { ok: false as const, aborted: true as const, data: input.data };
      }
      return {
        ok: true as const, workspace: result.workspace,
        dashboardRevision: result.dashboardRevision, data: input.data,
      };
    });
  };

  // #343 steps 4/7/8: reload the committed workspace and, if it changed under
  // us, project it + reconcile linked tabs. Runs INSIDE `serializeWrite` so it
  // orders behind any pending local mutation and a token compare stops it
  // projecting an older read over a newer local commit. A failed load keeps the
  // projection and warns; it never rejects the queued op (no wedge).
  const runWorkspaceRefresh = async (): Promise<void> => {
    const requestedWorkspaceId = deps.state.workspaceId;
    const requestedRouteGeneration = deps.routeCurrency.loadGeneration();
    let loaded: StoredWorkspaceV5 | null;
    try {
      const result = await deps.repository.loadById(requestedWorkspaceId);
      if (result.status === 'corrupt') { deps.hooks.warnRefreshFailed(); return; }
      loaded = result.status === 'ok' ? result.workspace : null;
    } catch {
      deps.hooks.warnRefreshFailed();
      return;
    }
    if (deps.state.workspaceId !== requestedWorkspaceId
      || deps.routeCurrency.loadGeneration() !== requestedRouteGeneration) return;
    // Unchanged since this tab's last projection ⇒ cheap no-op (the common case
    // for an activation refresh that raced no real external write).
    if (workspaceToken(loaded) === lastCommittedToken) return;
    if (!loaded) {
      deps.hooks.onWorkspaceMissing();
      return;
    }
    // #588 I-27: reconcile linked tabs from the CURRENT (pre-projection)
    // snapshots so the orphan/detach distinction survives, THEN project
    // committed truth (which reconciles tab links + fills tokens + records
    // lastCommittedToken via `recordProjection`). `queriesDidChange` is
    // likewise computed against the PRE-projection `state.savedQueries` —
    // projecting first would compare the new collection against itself.
    const queriesDidChange = queriesChanged(deps.state.savedQueries, loaded.queries);
    reconcileLinkedTabsToLatest(deps.state, loaded);
    deps.hooks.applyCommittedWorkspace(loaded);
    // Workbench surface repaint. Dashboard reacts through the
    // `notifyExternallyChanged` hook instead.
    if (deps.hooks.isWorkbenchSurface()) {
      deps.hooks.refreshWorkbenchUi();
    }
    deps.hooks.notifyExternallyChanged({ workspace: loaded, queriesChanged: queriesDidChange });
  };
  // Public entry point (#343): a single refresh ordered through the write queue.
  const refreshWorkspaceFromStore = (): Promise<void> => serializeWrite(runWorkspaceRefresh);

  // #343 steps 4/6/7: coalesce every invalidation source (channel poke, window
  // focus, tab becoming visible) into ONE queued refresh. `refreshPending` gates
  // duplicates: pokes arriving while a refresh is already scheduled/in-flight
  // collapse into that one; it clears the instant the queued op dequeues (#588
  // I-26 — NOT at read-completion), so a poke landing during the actual store
  // read schedules a fresh follow-up. The refresh is queued through
  // `serializeWrite`, so a notification received mid local-write reloads only
  // after that write settles (marks stale now, reloads in queue order).
  let refreshPending = false;
  const scheduleRefresh = (): void => {
    if (refreshPending) return;
    refreshPending = true;
    void serializeWrite(async () => {
      refreshPending = false;
      await runWorkspaceRefresh();
    });
  };
  // #343 §6: focus/visibility fallback — required even with BroadcastChannel,
  // because a poke can be missed while a tab is created/restored/suspended (or
  // on a platform without the API). Activation ALWAYS schedules a refresh; the
  // token compare inside makes an unchanged store a no-op. Works when
  // `broadcastChannelFactory` returned null (channel absent) too.
  // Guarded so a stub `window`/`document` (some tests inject a minimal object
  // without `addEventListener`) doesn't fault at construction — the seams stay
  // optional, exactly like the BroadcastChannel "capability or null" default.
  if (typeof deps.windowSeam.addEventListener === 'function') {
    deps.windowSeam.addEventListener('focus', () => scheduleRefresh());
  }
  if (typeof deps.documentSeam.addEventListener === 'function') {
    deps.documentSeam.addEventListener('visibilitychange', () => { if (deps.documentVisible()) scheduleRefresh(); });
  }

  // #466/#501-review: warn on a whole-page reload/close too, not just a
  // tab-strip close — the same `tabSaveDirty` predicate the tab strip's dirty
  // dot and its own close-confirm (tabs.ts's `requestCloseTab`) already read.
  //
  // The listener itself is installed/removed as the aggregate dirty state
  // flips, rather than registered once and left checking inside — an earlier
  // version of this comment argued a permanent listener "costs nothing" and
  // that this app has no bfcache-restore path to give up. Both were wrong:
  // Firefox (and older Chromium) disqualify a page from bfcache merely for
  // HAVING a `beforeunload` listener attached, independent of what the
  // callback does or whether it ever calls `preventDefault()`; bfcache
  // restoration itself needs no `pageshow`/`event.persisted` handling on this
  // app's part — the browser thaws the whole in-memory page, `bootstrap()`
  // and all, without a reload ever happening. `returnValue` must be a TRUTHY
  // value (lib.dom.d.ts's own doc comment: "when set to a truthy value,
  // triggers a browser-generated confirmation dialog") — its own default is
  // the empty string, so assigning that back would be a no-op for the legacy
  // UAs that key off it rather than `preventDefault()`.
  // A successful OAuth checkpoint authorizes precisely one intentional
  // navigation. The listener remains attached (so all ordinary unloads retain
  // their warning); ownership tokens ensure an older failed redirect cannot
  // disarm a newer arm (#588 I-13).
  let nextUnloadBypassGeneration = 0;
  let armedUnloadBypassGeneration: number | null = null;
  const beforeUnload = (e: BeforeUnloadEvent): void => {
    if (armedUnloadBypassGeneration !== null) {
      armedUnloadBypassGeneration = null;
      return;
    }
    e.preventDefault();
    e.returnValue = true;
  };
  const armOAuthRedirectUnloadBypass = (): (() => void) => {
    const generation = ++nextUnloadBypassGeneration;
    armedUnloadBypassGeneration = generation;
    return () => {
      if (armedUnloadBypassGeneration === generation) armedUnloadBypassGeneration = null;
    };
  };
  let beforeUnloadInstalled = false;
  const canToggleBeforeUnload = typeof deps.windowSeam.addEventListener === 'function'
    && typeof deps.windowSeam.removeEventListener === 'function';
  // Called from every place that can change the aggregate dirty state: the
  // tab-list reactive effect (`workbench-shell.ts`, for a new/closed/switched
  // tab — anything that touches the `tabs` SIGNAL's own identity) and
  // `actions.rerenderTabs` (for an in-place `dirtySql`/`dirtySpec` mutation,
  // which never touches that signal at all — the SQL editor's `onDocChange`
  // already calls `rerenderTabs()` right after setting `dirtySql = true`, so
  // this reuses that existing repaint path rather than a new aggregate
  // signal). Idempotent: a redundant call when the aggregate hasn't actually
  // flipped is a no-op, never a duplicate registration.
  const syncBeforeUnload = (): void => {
    if (!canToggleBeforeUnload) return;
    const needed = deps.state.tabs.value.some(tabSaveDirty);
    if (needed === beforeUnloadInstalled) return;
    beforeUnloadInstalled = needed;
    if (needed) deps.windowSeam.addEventListener!('beforeunload', beforeUnload);
    else deps.windowSeam.removeEventListener!('beforeunload', beforeUnload);
  };

  const provisionInitialWorkspace = async (): Promise<WorkspaceLoadResult> => {
    const listed = await deps.repository.list();
    const key = deriveWorkspaceKey(DEFAULT_WORKSPACE_NAME, listed.summaries.map((item) => item.key));
    const created = await deps.repository.create(createNewWorkspace(deps.genId, key, DEFAULT_WORKSPACE_NAME));
    if (created.ok) return { status: 'ok', workspace: created.workspace };
    // A different tab may have provisioned the collection after our empty
    // resolution. Re-resolve instead of creating a second fallback workspace.
    return deps.repository.resolveImplicit();
  };

  const resolveImplicitOrProvision = async (): Promise<WorkspaceLoadResult> => {
    const resolved = await deps.repository.resolveImplicit();
    return resolved.status === 'empty' ? provisionInitialWorkspace() : resolved;
  };

  const recordOpened = async (workspace: StoredWorkspaceV5): Promise<void> => {
    const result = await deps.repository.markOpened(workspace.key);
    if (!result.ok) deps.hooks.warnMarkOpenedFailed();
  };

  return {
    serializeWrite,
    flushWorkspaceWrites,
    mutateWorkspace,
    refreshWorkspaceFromStore,
    scheduleRefresh,
    sourceTabId,
    getLastCommittedToken,
    recordProjection,
    syncBeforeUnload,
    armOAuthRedirectUnloadBypass,
    resolveImplicitOrProvision,
    recordOpened,
  };
}
