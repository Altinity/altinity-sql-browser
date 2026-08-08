// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab,
  variableDoc,
  normalizeRowLimit, detachWorkspaceBoundTabs, reconcileTabsWithSavedQueries,
  setTabSpecDraft, SAVED_VIEWS,
} from '../state.js';
import type { QueryTab, AppState, SpecValidationService } from '../state.js';
import {
  findDashboard, resolveCompatibilityDashboard,
} from '../workspace/workspace-dashboards.js';
import type { StoredWorkspaceV5 } from '../generated/json-schema.types.js';
import { isAutoRunnable, splitStatements } from '../core/sql-split.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { shortVersion, withStatementBreak, formatBytes } from '../core/format.js';
// Issue #630 Phase 5 — `sqlString` (SQL Browser's one string-literal quoter)
// now comes directly from `@altinity/clickhouse-http`; the revised
// architecture Rule D allows this pure-language import outside `src/net/**`.
import { sqlString } from '@altinity/clickhouse-http';
import { toTSV } from '../core/export.js';
import { newResult, parseErrorPos } from '../core/stream.js';
import {
  CORE_SPEC_VALIDATORS, createSpecValidatorRegistry, formatSpecText,
  hasBlockingSpecErrors,
} from '../core/spec-draft.js';
import type { SpecValidatorEntry, QuerySpecValidationService } from '../core/spec-draft.js';
import type { SpecDiagnostic } from '../editor/spec-editor.types.js';
import { isQuerylessPanel } from '../core/panel-cfg.js';
import {
  cloneJson, queryName, queryPanel, queryView, upgradeSavedQuery,
} from '../core/saved-query.js';
import * as ch from '../net/ch-client.js';
import { createNoopPort } from '../editor/editor-port.js';
import type { EditorPort } from '../editor/editor-port.types.js';
import { createNoopSpecEditor } from '../editor/spec-editor.js';
import { createSpecCompletionSources } from '../editor/spec-completion-adapter.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab, openVariableTab } from './tabs.js';
import { commitVariableConfig } from '../application/dashboard-variable-config.js';
import { batch, computed, signal } from '@preact/signals-core';
import type { Signal, ReadonlySignal } from '@preact/signals-core';
import { renderResults } from './results.js';
import type { QueryResult } from './results.js';
import { dashboardScrollTop, disposeDashboardSurface, renderDashboard } from './dashboard.js';
import type { DashboardRenderTarget } from './dashboard.js';
import { toggleThemeDom } from './theme-toggle.js';
import { openSchemaView } from './explain-graph.js';
import type { SchemaLineageNode, DetachedGraphApp } from './explain-graph.js';
import { openDetailPane } from './schema-detail.js';
import type { NodeDetail, DetailNode } from './schema-detail.js';
import { openDocEntry, openDocDisambiguation, closeDocPane, isDocPaneOpen } from './doc-pane.js';
import { closeInspector } from './inspector-host.js';
import { createAnchoredPopovers } from './popover.js';
import { renderSavedHistory } from './saved-history.js';
import type { SchemaDb } from '../core/from-scope.js';
import { mountInlineLogin, renderLogin } from './login.js';
import type { InlineLoginHandle } from './login.js';
import { openShortcuts, resetShortcutChord } from './shortcuts.js';
import { startDrag } from './splitters.js';
import { flashToast } from './toast.js';
import type {
  App, ActionsRegistry, KeyboardOwner, OAuthDocumentRecoveryApplyResult,
  SchemaFocus,
} from './app.types.js';
import type { CreateAppEnv, BroadcastChannelPort } from '../env.types.js';
import { createQueryExecutionService } from '../application/query-execution-service.js';
import { createConnectionSession } from '../application/connection-session.js';
import { createWorkspaceSession } from '../application/workspace-session.js';
import type { WorkspaceSession } from '../application/workspace-session.js';
import { createSurfaceNavigation } from '../application/surface-navigation.js';
import {
  createOAuthDocumentRecoverySession,
  type OAuthDocumentRecoveryRestoreResult,
} from '../application/oauth-document-recovery-session.js';
import {
  createAuthenticatedExecutionScope,
  type AuthenticatedExecutionScope,
} from '../application/authenticated-execution-scope.js';
import { createSchemaCatalogService } from '../application/schema-catalog-service.js';
import { createWorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import { createChSessionParams } from '../application/ch-session-params.js';
import { createExportService } from '../application/export-service.js';
import type { ExportSink, FileHandleLike, DirectoryHandleLike } from '../application/export-service.js';
import { createSchemaGraphSession, SchemaGraphAuthRequiredError } from '../application/schema-graph-session.js';
import { createAppPreferences } from '../application/app-preferences.js';
import {
  QUERY_SURFACE, mainSurfaceRoute, reconcileMainSurface, selectedDashboardId, withoutPendingFocus,
} from '../application/main-surface.js';
import type { MainSurfaceState } from '../application/main-surface.js';
import { createWorkspaceRepository } from '../workspace/workspace-repository.js';
import { createIndexedDbWorkspaceStore } from '../workspace/indexeddb-workspace-store.js';
import { queryToken } from '../workspace/workspace-sync.js';
import { parseSqlRoute } from '../core/sql-route.js';
import { disposeFileMenuOverlays } from './file-menu.js';
import { createWorkbenchSession } from './workbench/workbench-session.js';
import { createVariableStrip } from './workbench/variable-strip.js';
import { createSaveController } from './workbench/save-controller.js';
import { createQueryDocumentSession } from '../application/query-document-session.js';
import { createSavedQueryService } from '../application/saved-query-service.js';
import { mountWorkbenchShell } from './workbench/workbench-shell.js';
import { mountAppShell } from './app-shell.js';
import { cancelDashboardTreeClicks, revealAssignedPanel } from './dashboard-tree.js';
import { pruneTreeUi } from '../core/dashboard-tree-ui-state.js';
import type { AppShellHandle } from './app-shell.js';
import { buildAppHeader } from './app-header.js';

/** Optional globals a plain browser page (or the CM6/Chart/dagre UMD bundles a
 *  `<script>` tag might attach) can carry that aren't in the standard `Window`
 *  type — none of `main.js`'s real production wiring relies on these; it always
 *  supplies `Chart`/`Dagre` (imported packages) via `env` directly. These are
 *  only the env-absent fallback reads below (`win.Chart`, `win.dagre`, …), kept
 *  narrow and all-optional so a plain `Window` still satisfies this widened type. */

interface WindowExtras {
  Chart?: unknown;
  dagre?: unknown;
  showSaveFilePicker?: (opts?: unknown) => Promise<unknown>;
  showDirectoryPicker?: (opts?: unknown) => Promise<unknown>;
  webkitURL?: typeof URL;
  FileReader?: typeof FileReader;
  URL?: typeof URL;
  Blob?: typeof Blob;
  // #343 §5: the real cross-tab channel constructor, when the platform has it.
  BroadcastChannel?: new (name: string) => BroadcastChannelPort;
}

/** `app.specValidators`'s full internal shape: the canonical schema +
 *  registered-rules service (core/spec-draft.js's `QuerySpecValidationService`
 *  — assignable to the narrower public `SpecValidationService` read-surface,
 *  app.types.ts, without a cast, same as state.ts's own
 *  `defaultSpecValidationService`). `.register` is app.ts-internal wiring (the
 *  `registerSpecValidator` action) that other modules never call directly. */
type AppSpecValidators = QuerySpecValidationService;

const recoveryOwnsLegacyShare = (
  recovery: OAuthDocumentRecoveryApplyResult | null,
): boolean => recovery?.kind === 'restored'
  || recovery?.kind === 'retry-deferred-retained'
  || recovery?.kind === 'workspace-unavailable-retained';

export function createApp(env: CreateAppEnv = {}): App {
  const doc = env.document || document;
  const win = (env.window || window) as Window & WindowExtras;
  const loc = env.location || win.location;
  const fetchFn = env.fetch || win.fetch.bind(win);
  const cryptoObj = env.crypto || win.crypto;
  const ss = env.sessionStorage || win.sessionStorage;
  // #343 §5/§6: cross-tab consistency seams (injected like matchMedia/
  // showSaveFilePicker — "capability or null" / a defaulted reader). The
  // channel factory yields `null` on a platform without BroadcastChannel; the
  // focus/visibility fallback (#343 step 4) still provides consistency then.
  const broadcastChannelFactory = env.broadcastChannel
    || ((name: string): BroadcastChannelPort | null =>
      (typeof win.BroadcastChannel === 'function' ? new win.BroadcastChannel(name) : null));
  const documentVisible = env.documentVisible || (() => doc.visibilityState !== 'hidden');
  // Epoch clock shared by persistence metadata and parameter execution.
  const wallNow = (): number => (env.wallNow || (() => Date.now()))();

  // #588 phase 4 wave 5: `app` is a LATE-BOUND `App` -- declared here with no
  // value yet, assigned exactly once near the end of this function as a
  // single object literal (no `as App` cast anywhere in this file -- a
  // member missing from that literal is a compile-time `TS2739`, an extra
  // one is `TS2353`). Every closure defined below that reads `app.*` (or is
  // itself stored as a property VALUE assigned later, like the `hooks`
  // objects passed to the various `create*Session` calls) captures this
  // BINDING, not a value: nothing invokes one of those closures until this
  // function has returned a fully-built `app`, so a premature (non-deferred)
  // dereference would throw a loud TDZ ReferenceError rather than silently
  // reading through a `Partial<App>` cast. The few places below that need a
  // real value SYNCHRONOUSLY, before the literal exists (not through a
  // closure -- e.g. a plain `state: app.state` config property a
  // `create*Session` call evaluates immediately), read the `state`/
  // `workspaceRepo` locals declared alongside them instead of `app.state`/
  // `app.workspace` -- see those two locals below.
  let app: App;
  const state = createState();
  // #587: null until `ensureShell()`'s first call, and null again after
  // `disposeShell()` — see both for the mirroring. Reachable as `app.shell`
  // from controller-construction time (this line) onward, including every
  // wiring point below that runs before any shell exists.
  // Chromium (+ a secure context) only — Firefox/Safari and plain-HTTP have no
  // File System Access API. The Export button feature-detects this at build
  // time and renders aria-disabled + a tooltip rather than hiding outright.
  // The script-export path additionally needs a directory picker (defensive —
  // the button's own enabled/tooltip state stays gated on canExport, since every
  // browser with showSaveFilePicker also has showDirectoryPicker).

  // --- persistence -------------------------------------------------------
  // The true-preference persist service (#276 Phase 4D) — theme/sidebarPx/
  // editorPct/sideSplitPct/rightInspectorPx/sidePanel/resultRowLimit, constructible
  // without App/AppState/DOM. Consumers (saved-history.ts/splitters.ts) call `app.prefs.save(name,
  // value)` directly (#276 Phase 5 deleted the flat `App.savePref` delegate);
  // `toggleTheme` below composes `prefs.toggleTheme()` (the state-flip +
  // persist) with its own DOM half.
  const prefs = createAppPreferences({ saveStr, state });
  // Atomic StoredWorkspaceV5 persistence: the injected IndexedDB factory seam
  // (mirrors crypto/sessionStorage) backs the workspace collection, behind
  // which the pure WorkspaceRepository validates create/replace commits.
  // Constructed lazily — no database is opened until
  // a workspace operation runs — so this never touches IndexedDB during
  // bootstrap. The favorites-driven Dashboard render still reads legacy keys in
  // this phase; wiring reads onto the aggregate is Phases 3-6 of #280.
  const workspaceStore = createIndexedDbWorkspaceStore(env.indexedDB || win.indexedDB);
  const workspaceRepo = createWorkspaceRepository({ store: workspaceStore, now: wallNow });
  // #407 — both application surfaces live on `/sql`; URL query parameters are
  // parsed once here and reparsed on Back/Forward. The resolved live workspace
  // is shared by Workbench and Dashboard. (#588 phase 4 wave 4: the
  // route-search cache and the surface-generation counter this used to seed
  // now live in `app.nav`, constructed further below — this initial parse is a
  // one-time DATA-PROPERTY seed, same as `currentWorkspace`/`workspaceRouteStatus`
  // right below it, and does not need the cache that comes later.)
  const keyboardOwners: KeyboardOwner[] = [];
  // #425: the main work surface's SESSION state — Query, or one Dashboard
  // selected by stable id. Never persisted (see application/main-surface.ts).
  // #588 phase 4 wave 4: the surface-generation guard cluster
  // (`advanceSurfaceGeneration`/`captureSurfaceGeneration`/
  // `isSurfaceGenerationCurrent`/`refreshCurrentSurfaceAfterStale` — every
  // surface transition advances the renderer generation so an obsolete async
  // callback can finish its durable work without settling against a
  // replacement renderer) now lives in `app.nav`, constructed further below;
  // `app.captureSurfaceGeneration`/`isSurfaceGenerationCurrent`/
  // `refreshCurrentSurfaceAfterStale` are assigned as flat delegates there.
  // The `{name:Type}` var-value/filter-active/recent-value persistence
  // wrappers (saveVarValues/saveFilterActive/saveVarRecent/
  // saveVarRecentDisabled) + the recent-value policy that sits on top of them
  // (recordBoundParams/clearVarRecent/clearAllVarRecent) now live in the
  // WorkbenchParameterSession (#276 Phase 4B1) — see the `const params = …`
  // block below. No flat `App` delegates for these (#276 Phase 5 deleted
  // them) except `app.saveVarRecent`, the one deliberate survivor (see its
  // own doc comment below).
  // Exposed seam for the header File menu (file-menu.js): the file-download
  // helper (defined below). The library title (name + dirty dot) repaints via a
  // libraryName/libraryDirty effect, so callers just mutate those signals.

  // --- identity ------------------------------------------------------------
  // Identity/auth reads (host/email/isSignedIn/…) live on `app.conn` itself
  // (assigned below, once `conn` is constructed) — no flat `App` delegate.

  // --- independent SQL + Spec editor seams (#143/#212) ---------------------
  const Editor = env.Editor || createNoopPort;
  const SpecEditor = env.SpecEditor || createNoopSpecEditor;
  // `env.specValidators`'s two accepted runtime shapes: a full validator
  // service (already exposing `validate` — used as-is) or an initial entry
  // list for `createSpecValidatorRegistry` to build one from. Kept as its own
  // local (not `app.specValidators`, typed to the narrower `SpecValidationService`
  // read-shape other modules rely on — see app.types.ts) so this module's own
  // `.register` calls below stay typed too; `register` is app.ts-internal
  // wiring, outside the public contract.
  const hasValidate = (v: unknown): v is AppSpecValidators =>
    !!v && typeof (v as { validate?: unknown }).validate === 'function';
  const specValidators: AppSpecValidators = hasValidate(env.specValidators)
    ? env.specValidators
    : createSpecValidatorRegistry((env.specValidators as readonly SpecValidatorEntry[] | undefined) || CORE_SPEC_VALIDATORS);
  // #313: the editor adapter opens the reference pane through this injected
  // action (never by importing ui/doc-pane itself — the editor stays a leaf
  // layer, enforced by build/check-boundaries.mjs). Bound before Editor(app)
  // only for tidiness; the adapter reads it lazily at click/F1 time.
  // #60 — the global Escape shortcut closes the pane from anywhere (layered
  // before cancel-query in shortcuts.ts's handleKeydown).
  // #315 — the F1 name-only disambiguation fallback's injected action, bound
  // the same way and for the same "editor never imports UI" reason.
  // The Spec-evaluation/document lifecycle (#276 Phase 4C) —
  // applySpecEvaluation/evaluateSpecDraft/revalidateSpecDrafts/
  // revealFirstSpecError/registerSpecValidator, plus the editor-mode POLICY
  // half of setEditorMode (below) — now lives in
  // `application/query-document-session.ts`, constructible without
  // App/AppState/DOM (check:arch bars it from importing `src/editor/**`; its
  // diagnostics are typed as core/spec-draft.js's own `SpecValidationDiagnostic`,
  // documented there as directly assignable to the editor's `SpecDiagnostic`).
  // The hooks below are the session's only DOM/editor touch points — app.ts
  // supplies them (some still guarded on an as-yet-unassigned `app.actions`/
  // `app.updateSaveBtn`/`app.updateEditorModeUi`, exactly as the pre-extraction
  // inline code guarded itself), the session itself never imports `src/ui/**`
  // or `src/editor/**`.
  const queryDoc = createQueryDocumentSession({
    state,
    activeTab: () => app.activeTab(),
    specValidators,
    hooks: {
      setDiagnostics: (diagnostics) => app.specEditor.setDiagnostics(diagnostics),
      revealDiagnostic: (index) => app.specEditor.revealDiagnostic(index),
      rerenderTabs: () => { if (app.actions) app.actions.rerenderTabs(); },
      updateSaveBtn: () => { if (app.updateSaveBtn) app.updateSaveBtn(); },
      updateEditorModeUi: () => { if (app.updateEditorModeUi) app.updateEditorModeUi(); },
    },
  });
  // The persisted OAuth checkpoint is deliberately below this shell: it can
  // replace authored tab state, but does not know how the mounted document
  // service rebuilds parsed Spec/diagnostic transients or owns the dirty-page
  // guard. Keep the coordinator private; bootstrap receives only this
  // transaction-shaped restore entry point.
  const oauthDocumentRecovery = createOAuthDocumentRecoverySession({
    storage: ss,
    now: wallNow,
    state,
    specValidators,
  });
  const finalizeOAuthDocumentRecovery = (
    restored: OAuthDocumentRecoveryRestoreResult,
  ): OAuthDocumentRecoveryApplyResult => {
    if (restored.kind !== 'restored') return restored;
    // Publication is the commit point: from here on bootstrap must render these
    // tabs even if parser or storage finalization fails. Arm the ordinary dirty
    // guard first so the authored document is protected on every exit path.
    app.syncBeforeUnload();
    // The checkpoint intentionally carries raw authored text, never derived
    // parser state. Rebuild every draft's diagnostics without rendering before
    // bootstrap's first signed-in surface. A failure retains the checkpoint
    // and surfaces a safe warning, but cannot make the published tabs
    // unreachable or allow legacy shared content to replace them.
    try {
      queryDoc.revalidateSpecDrafts({ refreshUi: false });
    } catch {
      flashToast(
        'Drafts were restored, but Spec validation is temporarily unavailable. The recovery copy was retained.',
        { document: doc },
      );
      return {
        kind: 'restored',
        finalization: 'checkpoint-retained',
        warning: 'spec-revalidation-failed',
      };
    }
    try {
      oauthDocumentRecovery.consume();
    } catch {
      flashToast(
        'Drafts were restored, but recovery cleanup could not finish. The recovery copy was retained.',
        { document: doc },
      );
      return {
        kind: 'restored',
        finalization: 'checkpoint-retained',
        warning: 'checkpoint-remove-failed',
      };
    }
    return { kind: 'restored', finalization: 'complete' };
  };
  let deferredRecoveryWarningShown = false;
  const deferOAuthDocumentRecovery = (): OAuthDocumentRecoveryApplyResult => {
    if (!deferredRecoveryWarningShown) {
      deferredRecoveryWarningShown = true;
      flashToast(
        'Unsaved drafts remain safely stored. Recovery will retry automatically.',
        { document: doc },
      );
    }
    return { kind: 'retry-deferred-retained' };
  };
  // The saved-query create/commit policy, history recording, and share-URL
  // building (#276 Phase 4C) now live in `application/saved-query-service.ts`,
  // constructible without App/AppState/DOM — this shell sequences Spec
  // evaluation (via `queryDoc` above) THEN calls this service; the two never
  // call each other (see that module's header comment). `now: () =>
  // Date.now()` is a genuine wall-clock read (NOT `app.now`/`app.wallNow` —
  // unrelated clocks), matching `createSavedQuery`'s own pre-extraction
  // inline `Date.now()` call exactly.
  const saved = createSavedQueryService({
    state,
    saveJSON,
    now: () => Date.now(),
    specValidators,
    // A thunk, not `app.mutateWorkspace` directly: the primitive is wired later
    // in `createApp` (it depends on `serializeWrite`/`applyCommittedWorkspace`
    // defined below), so defer resolution to call time when it's defined.
    mutateWorkspace: (transform) => app.mutateWorkspace(transform),
  });
  // login.ts's `LoginApp.root` is narrowed to a non-null `Element` (vs.
  // `App.root`'s `Element | null`) — deliberate there (that module always
  // writes through it unconditionally); every real renderLogin() call below
  // fires only once the app has mounted into a real `#root`, so this is a
  // structural-only reinterpretation, not a new runtime assumption (a null
  // root would already throw inside login.ts's own `app.root.replaceChildren`
  // either way).
  // Declared before the auth callbacks so they can retain or dispose the same
  // persistent document shell. Construction completes before any callback can
  // run; the actual mount helpers are installed further below.
  let shell: AppShellHandle | null = null;
  let disposeWorkbenchMount: (() => void) | null = null;
  // #590 §1.9: the former `renderLoginApp` is now the surface-retirement
  // coordinator's `retireToLogin` named op (declared further below, alongside
  // `disposeShell`/`disposeCurrentSurface`) — a forward reference, same
  // TDZ-safe closure pattern `app` itself uses throughout this function:
  // nothing below CALLS it until well after `createApp` has finished wiring
  // every closure.
  // Temporary auth loss suspends only this disposable scope. The document
  // session (tabs/editors/results/workspace/shell) stays mounted; the two UI
  // callbacks are installed once the persistent shell seam is defined below.
  let activeExecutionScope: AuthenticatedExecutionScope | null = null;
  let inlineLogin: InlineLoginHandle | null = null;
  const revealAuthenticationRequired = (detail?: string): void => {
    if (!shell) {
      retireToLogin(detail);
      return;
    }
    inlineLogin ??= mountInlineLogin(app as App & { root: Element }, shell.authHost);
    inlineLogin.show(detail);
  };
  const hideAuthenticationRequired = (): void => inlineLogin?.hide();
  // The auth + config + ClickHouse connection lifecycle (#276 Phase 2) — OAuth
  // PKCE login/refresh, Basic probing, and IdP config resolution live in
  // `application/connection-session.ts`,
  // constructible without App/AppState/DOM; this module wires it to the real
  // browser env and to `revealAuthenticationRequired`/`retireToLogin` (the
  // one piece that IS this shell's job — the session only ever calls
  // `onAuthLost`, never renders).
  // #588 phase 4 wave 3: `session` (createWorkspaceSession) owns the
  // beforeunload listener + its OAuth-redirect bypass generation tokens now,
  // but it is constructed further below (it needs `applyCommittedWorkspace`,
  // defined further down still). ConnectionSession invokes this thunk only
  // after createApp has completed, so the forward reference (exactly the
  // existing `mutateWorkspace`/`saved` thunk-forwarding pattern this function
  // already uses below) resolves to the real implementation by then.
  let session: WorkspaceSession;
  const conn = createConnectionSession({
    fetch: fetchFn, storage: ss, location: loc, crypto: cryptoObj,
    queryJson: ch.queryJson,
    onAuthLost: (detail, lease) => {
      const closing = activeExecutionScope;
      activeExecutionScope = null;
      closing?.close(lease);
      revealAuthenticationRequired(detail);
    },
    prepareOAuthRedirect: (state) => oauthDocumentRecovery.prepareTransaction(state),
    clearOAuthDocumentRecovery: () => oauthDocumentRecovery.clear(),
    armOAuthRedirectUnloadBypass: () => session.armOAuthRedirectUnloadBypass(),
  });
  // THE single live ClickHouse context — owned by the session, aliased locally
  // so every existing ch.* call site below keeps referencing the same mutated
  // object (chCtx.origin/authConfirmed are mutated in place, never replaced).
  const chCtx = conn.chCtx;
  const getToken = conn.getToken;
  const ensureConfig = conn.ensureConfig;

  // Identity/auth/config all live on `conn` (see app.types.ts's own doc
  // comment) — no flat `App` delegates (#276 Phase 5 deleted them).
  // `showLogin`/`signOut` stay app.ts-owned: they compose rendering, not
  // pure forwards.
  // Sign-out is the one real end-of-session event in a single-route tab —
  // the first production wiring of the sessions' teardown surfaces (#276
  // Phase 5). Order matters: cancel/tear down every in-flight operation
  // BEFORE clearing credentials and rendering login, so a mid-flight
  // query/export/lineage stream can never land (or repaint) after the login
  // screen is showing; invalidate the catalog so a later sign-in (possibly a
  // different server) never sees stale schema/reference caches. The
  // workbench session stays reusable after destroy(): the next renderApp
  // re-attaches its shell effects.

  // --- data loaders --------------------------------------------------------
  // The server-metadata/reference lifecycle (#276 Phase 4A) — server-version
  // probe, schema-tree load, lazy per-table column load, editor reference
  // data + completions, hover-doc cache — now lives in
  // `application/schema-catalog-service.ts`, constructible without
  // App/AppState/DOM (see that file for the ported bodies, byte-identical to
  // this file's history). `updateBanner` (DOM) and the schema/banner effects
  // stay HERE. The header connection chip is driven exclusively by
  // ConnectionSession's lifecycle signal; a metadata probe is not connection
  // authority.
  function updateOpenServerVersion(version: string): void {
    const server = app.dom.userMenu?.querySelector<HTMLElement>('.um-server');
    if (!server) return;
    server.hidden = false;
    server.textContent = `CH ${shortVersion(version)}`;
  }
  const catalog = createSchemaCatalogService({
    loadServerVersion: ch.loadServerVersion,
    loadSchema: ch.loadSchema,
    loadColumns: ch.loadColumns,
    loadReferenceData: ch.loadReferenceData,
    loadFunctionsDocColumns: ch.loadFunctionsDocColumns,
    loadFunctionDocRow: ch.loadFunctionDocRow,
    loadDocTableColumns: ch.loadDocTableColumns,
    loadDocRow: ch.loadDocRow,
    ctx: () => chCtx,
    ensureConfig,
    sqlString,
    state,
    hooks: {
      onServerVersionLoaded: updateOpenServerVersion,
      renderVarStrip: () => app.renderVarStrip(),
      refreshEditorReference: () => app.sqlEditor.refreshReference(),
    },
  });
  // `loadVersion`/`loadSchema`/`loadReference`/`rebuildCompletions`/
  // `docSummary`/`docEntry`/`refData`/`completions` all live on `catalog`
  // itself now (#276 Phase 5 deleted the flat `App` delegates) —
  // codemirror-adapter.ts and every other consumer reads `app.catalog.*`
  // directly.
  // A prominent, dismissible banner for schema/auth failures — the schema-panel
  // text alone is easy to miss on first deploy. Driven by app.state.schemaError.
  function updateBanner() {
    const b = app.dom.banner;
    if (!b) return;
    const err = app.state.schemaError.value;
    if (!err || app.state.bannerDismissedFor.value === err) {
      b.style.display = 'none';
      return;
    }
    b.style.display = '';
    b.replaceChildren(
      h('span', { class: 'auth-banner-msg' },
        'ClickHouse rejected the request — JWT auth may not be configured: ' + err),
      h('button', {
        class: 'auth-banner-x',
        title: 'Dismiss',
        onclick: () => { app.state.bannerDismissedFor.value = err; b.style.display = 'none'; },
      }, '×'),
    );
  }
  // Lazily load a table's columns (#26/#172 v2) — actions.loadColumns' target
  // below delegates to the service; kept as a local function (rather than
  // inlining `catalog.loadColumns` at the actions-registry call site) so that
  // registry entry is untouched.
  function loadColumns(db: string, table: string): Promise<void> {
    return catalog.loadColumns(db, table);
  }

  // --- query run ---------------------------------------------------------
  const now = (): number => (env.now || (() => win.performance.now()))();
  // The *wall* clock for the parameter pipeline (#173) — epoch ms, injected
  // separately from `now` above: performance.now() measures durations and is
  // wrong for epoch-relative values (#169's `now-1h`). Callers resolve one
  // wallNow() per execution wave and thread it through every prepare of that
  // wave; debounce/coalescing also live in the callers, never in the pipeline.
  // A unique id for a query_id / session_id. Prefer crypto.randomUUID; its
  // fallback (non-secure context, where randomUUID is undefined) must still be
  // unique across tabs sharing one time origin — so mix in Math.random, not just
  // `now()` (performance.now is coarsened and can repeat for back-to-back calls).
  const uid = (prefix: string): string => (cryptoObj.randomUUID
    ? cryptoObj.randomUUID()
    : prefix + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
  // One retry after this delay (ms) smooths a transient failure on the rapid,
  // same-session requests of a script (env-injectable; tests set 0).
  const retryMs = env.retryMs != null ? env.retryMs : 250;
  const sleep = (ms: number): Promise<void> => new Promise((r) => win.setTimeout(r, ms));
  // The shared request/stream/normalize + multiquery-script transport service
  // (#276 Phase 1) — `run()`'s single read and `runScript()`'s per-statement
  // retry/classify loop both delegate to it now; `ctx: () => chCtx` keeps the
  // live (possibly refreshed) auth context rather than a stale snapshot.
  const exec = createQueryExecutionService({
    runQuery: ch.runQuery, killQuery: ch.killQuery, ctx: () => chCtx, now, uid, retryMs, sleep, sqlString,
  });
  // #457 removed `app.runOptionQuery` (#447 phase 2's per-variable option-query
  // transport): it existed only for the variable DRAWER's Test action. A variable
  // tab runs through the ordinary Run action and paints into the ordinary result
  // area, so there is no second transport to wire.
  // Exposed so results.js can compute a script-export row's live elapsed time
  // (now() - e.startedAt) with the same injected clock as exportScript itself.
  // Update only the live elapsed-ms readout (no table re-render). Driven by an
  // interval while running so it ticks even for queries that emit no rows (sleep).
  function tickElapsed(): void {
    if (app.dom.runElapsedEl) app.dom.runElapsedEl.textContent = app.elapsedMs().toFixed(0) + ' ms';
  }

  // The ClickHouse HTTP `session_id` policy (#276 Phase 5 final home) —
  // `sessionParams`/`needsSession`/`sessionParamsFor` now live in
  // `application/ch-session-params.ts` (see its header comment for the full
  // rationale, ported byte-identical), so this file's own workbench-hook
  // wiring and the `exportService` dep wiring below share ONE implementation
  // instead of two independently-maintained copies.
  const { sessionParamsFor } = createChSessionParams({ uid });
  // The `{name:Type}` query-variable POLICY — analyze/prepare/gate/execution-
  // view, the #170 hardening bookkeeping, the #172 v2 schema-cache enum-
  // suggestion inference, and the #171 recent-value + persistence policy —
  // now lives in `application/workbench-parameter-session.ts` (#276 Phase
  // 4B1), constructible without App/AppState/DOM. `renderVarStrip` (the DOM
  // view — #588 W1 extracted it into `ui/workbench/variable-strip.ts`) and
  // the workbench-session hooks + export block (further down) call its
  // methods directly; `app.params.hardenedVars` reads this
  // session's own `Set` directly (#276 Phase 5 deleted the flat
  // `App.hardenedVars` alias). `sessionParamsFor` above is `ch-session-params.ts`'s
  // `tab.chSession`/transport material, not parameter policy — Phase 4C's
  // concern (or this one).
  const params = createWorkbenchParameterSession({
    varValues: () => app.state.varValues,
    filterActive: () => app.state.filterActive,
    varRecent: () => app.state.varRecent,
    setVarRecent: (map) => { app.state.varRecent = map; },
    varRecentDisabled: () => app.state.varRecentDisabled,
    schema: () => app.state.schema.value as SchemaDb[] | null,
    activeTab: () => app.activeTab(),
    wallNow,
    saveJSON,
    hooks: {
      onGateBlocked: (message) => flashToast(message, { document: doc }),
      // Routed through the mutable, test-visible `app.saveVarRecent`
      // property (a fresh property read every call) rather than
      // `params.saveVarRecent()` directly — see
      // workbench-parameter-session.ts's header comment: this keeps every
      // automatic persist `recordBoundParams`/`clearVarRecent`/
      // `clearAllVarRecent` performs observable through the exact seam
      // app.test.ts's `app.saveVarRecent = vi.fn(app.saveVarRecent)`
      // mock-substitution case exercises, byte-identical to the
      // pre-extraction code's own `app.saveVarRecent()` property call.
      saveVarRecent: () => app.saveVarRecent(),
    },
  });
  // The single deliberate delegate survivor (#276 Phase 5 — see its own doc
  // comment on app.types.ts's `App.saveVarRecent`): every other params-group
  // member (`saveVarValues`/`saveFilterActive`/`saveVarRecentDisabled`/
  // `recordBoundParams`/`clearVarRecent`/`clearAllVarRecent`/`hardenedVars`)
  // has no flat `App` delegate — every consumer reads `app.params.*` /
  // `params.*` directly.

  // The streaming single-file export (issue #87) + multi-statement script
  // export (issue #99) POLICY (#276 Phase 4B2) now lives in
  // `application/export-service.ts`, constructible without App/AppState/DOM
  // — a pure move of the export bodies (already re-pointed onto `params`'s
  // methods by Phase 4B1) wholesale. `exportSink` wraps the two File System
  // Access pickers (feature-detected as `app.showSaveFilePicker`/
  // `app.showDirectoryPicker` above — only ever called once
  // `canExport`/`canExportScript` has already gated true); `canExport`/
  // `canExportScript` themselves and `showExportProgress` (the DOM progress
  // banner, defined further below) stay app.ts-owned, injected into the
  // service. `state.exporting` stays an `AppState` signal this service is
  // the sole writer of (mirrors `workbench`'s own `running` precedent).
  const exportSink: ExportSink = {
    pickFile: (input) => app.showSaveFilePicker!(input) as Promise<FileHandleLike>,
    pickDirectory: (input) => app.showDirectoryPicker!(input) as Promise<DirectoryHandleLike>,
  };
  const exportService = createExportService({
    exportQuery: ch.exportQuery, runQuery: ch.runQuery, killQuery: ch.killQuery,
    ctx: () => chCtx, ensureConfig, getToken, sqlString, now, wallNow, uid,
    executionScope: () => app.executionScope(),
    canExport: () => app.canExport(), canExportScript: () => app.canExportScript(),
    sink: exportSink,
    state, // AppState structurally satisfies ExportStateSlice
    activeTab: () => app.activeTab(),
    params: { prepareTabSource: params.prepareTabSource, varGateBlocked: params.varGateBlocked, execStatementSql: params.execStatementSql },
    sessionParamsFor,
    hooks: {
      renderResults: () => renderResults(app),
      showExportProgress: (onCancel) => showExportProgress(onCancel),
      toast: (message) => flashToast(message, { document: doc }),
      loadSchema: () => { void catalog.loadSchema(); },
    },
  });

  // The run/runScript/runEntry/cancel orchestration (#276 Phase 3a) now lives
  // in ui/workbench/workbench-session.ts — a route-scoped session that owns
  // the run bookkeeping (runT0/runQueryId/runTick) and the in-flight
  // AbortController privately (formerly this file's own `runState` cast +
  // `app.state.abortController`). This shell supplies the DOM/render hooks
  // (results/history repaint, schema reload, the selection/toast/tick seams)
  // and the ClickHouse/param-pipeline dependencies the session's core logic
  // needs; `renderApp`'s `attachShell` call wires the 3 run-coupled reactive
  // effects (results repaint / Run button / mobile badge) the session owns.
  const workbench = createWorkbenchSession({
    exec, ensureConfig, getToken, now, wallNow, uid,
    executionScope: () => app.executionScope(),
    state, // AppState structurally satisfies WorkbenchStateSlice
    activeTab: () => app.activeTab(),
    hooks: {
      renderResults: () => renderResults(app),
      // #587 AC3: renamed from `renderSavedHistory` — called UNCONDITIONALLY
      // on every clean run now (`workbench-session.ts` no longer knows
      // `sidePanel` exists at all); which panel (if any) actually repaints is
      // this hook's own decision, delegated to the registry exactly like
      // `app.recordHistory`'s single-statement path above.
      onRunComplete: () => app.shell?.sidePanels.notifyRunComplete(),
      cancelSchemaGraph,
      loadSchema: () => { void catalog.loadSchema(); },
      recordHistory: (tab, sql) => app.recordHistory(tab, sql),
      recordBoundParams: (bp) => params.recordBoundParams([...bp]),
      prepareTabSource: params.prepareTabSource, varGateBlocked: params.varGateBlocked,
      execStatementSql: params.execStatementSql, sessionParamsFor,
      getSelectionText: () => app.sqlEditor.getSelection().text,
      tickElapsed,
      saveJSON,
      onAuthFailed: chCtx.onSignedOut,
    },
  });
  // Milliseconds since the running query started (0 when idle) — delegates to
  // the session's own private runT0 bookkeeping.
  // The Workbench `{name:Type}` query-variable STRIP — `setRunBtn` (the Run
  // button's disabled/tooltip/label sync) and `renderVarStrip` (the strip's
  // DOM view) — now lives in `ui/workbench/variable-strip.ts` (#588 W1), a
  // pure extraction: every line of the two functions moved verbatim, only
  // `app.*`/`doc`/`params.*` reads rewritten onto the `deps` thunks below.
  // `app.renderVarStrip`/`app.setRunBtn` stay flat one-line delegates — every
  // existing consumer (`WorkbenchShellDeps`, the catalog's idle-tick hook,
  // `onDocChange` above) keeps calling them exactly as before.
  const variableStrip = createVariableStrip({
    document: doc,
    state,
    activeTab: () => app.activeTab(),
    params,
    wallNow,
    varStrip: () => app.dom.varStrip,
    runBtn: () => app.dom.runBtn,
  });
  // The Export button reflects both browser support (canExport) and whether an
  // export is already running — the button stays aria-disabled (not natively
  // disabled) in either case so its tooltip still shows on hover.
  function setExportBtn(exporting: boolean): void {
    if (!app.dom.exportBtn) return;
    const can = app.canExport();
    const disabled = exporting || !can;
    app.dom.exportBtn.classList.toggle('is-disabled', disabled);
    if (disabled) app.dom.exportBtn.setAttribute('aria-disabled', 'true');
    else app.dom.exportBtn.removeAttribute('aria-disabled');
    app.dom.exportBtn.title = exporting
      ? 'Export in progress…'
      : can ? 'Export full result to a file (streams to disk, uncapped)'
        : 'Large export requires Chrome/Edge over HTTPS';
  }
  // Busy state for the Format button — formatting a multi-statement script is one
  // request per statement, so it can take a moment; show a spinner + disable.
  function setFmtBtn(busy: boolean): void {
    if (!app.dom.fmtBtn) return;
    app.dom.fmtBtn.disabled = busy;
    app.dom.fmtBtn.replaceChildren(
      busy ? h('span', { class: 'spin' }, Icon.spinner()) : Icon.braces(),
      busy ? 'Formatting…' : 'Format');
  }

  // Pretty-print the editor's SQL via ClickHouse's formatQuery(), in place. The
  // raw (untrimmed) SQL is sent so a syntax error's reported position maps 1:1
  // onto the editor text. On error we show it persistently in the results panel
  // and jump the caret to the offending token; a later successful format clears
  // that error. Success never touches real run results.
  // Clear a prior format-error result (a later successful format clears just this).
  function clearFormatError() {
    const tab = app.activeTab();
    if (tab.result && tab.result.formatError) { tab.result = null; renderResults(app); }
  }
  async function formatQuery(): Promise<void> {
    if (app.activeTab().editorMode !== 'sql') return;
    const raw = app.activeTab().sqlDraft || '';
    if (!raw.trim()) return;
    const stmts = splitStatements(raw);
    // #165 Format policy: a statement containing /*[ ]*/ optional blocks is
    // never round-tripped through server-side formatQuery() — it would drop or
    // mangle the markers, silently destroying the template. Skip it with a
    // notice; other statements in a script still format normally.
    if (stmts.length <= 1 && hasOptionalBlocks(raw)) {
      flashToast('Statement contains optional blocks — not formatted', { document: doc });
      return;
    }
    // `actions.formatQuery` enters through withAuthenticatedExecution(), so a
    // private invocation only exists while its scope is present.
    const scope = app.executionScope()!;
    const controller = new AbortController();
    const registration = scope.register({
      name: 'format query',
      abort: () => {
        controller.abort();
        setFmtBtn(false);
      },
    });
    const formatOne = async (s: string): Promise<string> => {
      const queryId = uid('q');
      const requestRegistration = scope.register({
        name: 'format statement',
        abort: () => controller.abort(),
        getQueryId: () => queryId,
      });
      try {
        if (!requestRegistration.isCurrent()) return '';
        const json = await ch.queryJson<{ q: string }>(
          chCtx,
          'SELECT formatQuery(' + sqlString(s) + ') AS q FORMAT JSON',
          controller.signal,
          { query_id: queryId },
        );
        return requestRegistration.isCurrent()
          ? (json.data && json.data[0] && json.data[0].q) || ''
          : '';
      } finally {
        requestRegistration.release();
      }
    };
    try {
      await ensureConfig();
      if (!registration.isCurrent()) return;
      if (!(await getToken())) {
        // Scope epoch, rather than the mutable current lifecycle, makes a
        // late old credential failure harmless after a successful resume.
        chCtx.onSignedOut(undefined, scope.epoch);
        return;
      }
      if (!registration.isCurrent()) return;
      const tab = app.activeTab();
      setFmtBtn(true); // formatting a script is one request per statement — show busy
      if (stmts.length > 1) {
        // Multi-statement: format each (best-effort — keep the original text for any
        // statement that won't format, like insertCreate; skip a template, #165),
        // then reassemble with a `;` and a blank line between statements.
        const skipped = stmts.filter((s) => hasOptionalBlocks(s)).length;
        const formatted = await Promise.all(stmts.map((s) => (hasOptionalBlocks(s) ? s : formatOne(s).catch(() => s))));
        if (!registration.isCurrent()) return;
        app.sqlEditor.replaceDocument(withStatementBreak(formatted.map((q, i) => q || stmts[i]).join(';\n\n')));
        clearFormatError();
        if (skipped) {
          flashToast(skipped + (skipped === 1 ? ' statement contains' : ' statements contain')
            + ' optional blocks — not formatted', { document: doc });
        }
        return;
      }
      // Single statement: send the raw (untrimmed) SQL so a syntax error's reported
      // position maps 1:1 onto the editor text; show it persistently + jump the caret.
      try {
        const q = await formatOne(raw);
        if (!registration.isCurrent()) return;
        // Terminate so the caret lands past the last token — otherwise the input
        // event from the replace re-opens autocomplete on the trailing word.
        if (q) app.sqlEditor.replaceDocument(withStatementBreak(q));
        clearFormatError();
      } catch (e) {
        if (!registration.isCurrent()) return;
        const msg = String((e instanceof Error && e.message) || e);
        // `formatError` (not a run result, so a later successful format can
        // clear just this — see clearFormatError) is app.ts/test-only, not
        // part of results.ts's own canonical `QueryResult` contract.
        const formatErrorResult: QueryResult & { formatError: true } = { ...newResult('Table'), error: msg, formatError: true };
        Object.assign(tab, { result: formatErrorResult });
        app.state.resultView.value = 'table';
        renderResults(app); // explicit: the format-error tab.result is an in-place write, and resultView may already be 'table' (no effect)
        const pos = parseErrorPos(msg);
        if (pos != null) app.sqlEditor.revealOffset(pos);
      }
    } finally {
      if (registration.isCurrent()) setFmtBtn(false);
      registration.release();
    }
  }

  // Inline schema-lineage drawer + fullscreen expand/detail flow (#276 Phase
  // 4D) — the two-phase progressive draw (#124), the stale-write guard, the
  // rich-card expand fetch, and the last-clicked-wins node-detail bookkeeping
  // all now live in `application/schema-graph-session.ts`, constructible
  // without App/AppState/DOM (byte-for-byte port — see that file for the
  // ported bodies). This shell wraps it: `cancelSchemaGraph`/`showSchemaGraph`
  // delegate straight through (the session's own `renderResults` hook below
  // repaints); `expandSchemaGraph`/`openNodeDetail` own the DOM the session
  // never sees — the fullscreen view object (opened synchronously, before the
  // session's async fetch, so it survives the click gesture) and the
  // detail-pane mount.
  const graph = createSchemaGraphSession({
    ensureConfig, getToken, ctx: () => chCtx,
    executionScope: () => app.executionScope(),
    loadSchemaLineage: ch.loadSchemaLineage,
    loadLineageTransitive: ch.loadLineageTransitive,
    loadSchemaCards: ch.loadSchemaCards,
    loadTableDetail: ch.loadTableDetail,
    activeTab: () => app.activeTab(),
    hooks: {
      renderResults: () => renderResults(app),
      onAuthFailed: chCtx.onSignedOut,
    },
  });

  function cancelSchemaGraph(opts?: { clearResult?: boolean }): void {
    graph.cancel(opts);
  }

  function showSchemaGraph(focus: SchemaFocus): Promise<void> {
    return graph.show(focus);
  }

  // Open the schema lineage fullscreen with RICH cards. The view is opened
  // synchronously (a pop-up opened after an await is blocked) so it survives
  // the click gesture; `graph.expand` never sees it — this wrapper alone
  // calls `view.render`/`view.fail`.
  async function expandSchemaGraph(focus: SchemaFocus): Promise<void> {
    if (!focus || !focus.db) return;
    const view = openSchemaView(app as DetachedGraphApp);
    try {
      const data = await graph.expand(focus);
      if (!data) return;
      // Every real lineage/expansion node always carries `id`/`label`
      // (schema-graph.ts's `SchemaGraphNode`/`ExpandLineageNode`, both
      // required there); schema-cards.ts's own `CardGraphNode` widens them to
      // optional for a bare test fixture — reasserted here to match
      // explain-graph.ts's `SchemaLineageNode` (also required, for the SVG
      // drawer's own layout).
      const nodes: SchemaLineageNode[] = data.nodes.map((n) => ({ ...n, id: n.id!, label: n.label! }));
      view.render({
        nodes, edges: data.edges, focus: data.focus,
        truncated: data.truncated, savedPositions: data.savedPositions,
      });
    } catch (e) {
      view.fail(e instanceof SchemaGraphAuthRequiredError ? e.message : 'Could not load the schema graph');
    }
  }

  // Open the detail pane for a clicked fullscreen node: mount a loading
  // placeholder synchronously (so it's visible immediately), then fill it
  // once `graph.loadNodeDetail` resolves — `null` means a later click on the
  // same overlay superseded this one (last-clicked wins, not last-resolved —
  // #97), so no mount happens.
  async function openNodeDetail(node: SchemaFocus, targetDoc?: Document): Promise<void> {
    if (!node || !node.db || !node.name) return;
    const overlayDoc = targetDoc || (app && app.document) || document;
    openDetailPane(app, node as DetailNode, { columns: 'loading' }, targetDoc);
    const detail = await graph.loadNodeDetail(node, overlayDoc);
    if (detail == null) return; // superseded by a later click
    // `columns` remapped through a fresh per-row spread: net/ch-client.ts's
    // `ColumnDetailRow` (the real loader shape) has no index signature;
    // schema-detail.ts's `DetailColumn` (via `ColumnRoleFlags`) does — every
    // field the pane reads is already there.
    const nodeDetail: NodeDetail = { ...detail, columns: detail.columns.map((c) => ({ ...c })) };
    openDetailPane(app, node as DetailNode, nodeDetail, targetDoc);
  }

  // EXPLAIN wraps the whole editor as a single statement, so it can't run against a
  // `;`-separated script (ClickHouse would reject `EXPLAIN a; b; …` with a confusing
  // parse error). Say so with our own message instead.
  function explainMultiBlocked(): boolean {
    if (splitStatements(app.activeTab().sqlDraft).length <= 1) return false;
    flashToast('Explain isn’t available for a multi-statement script — run one statement at a time.', { document: doc });
    return true;
  }
  // #465: a `dashboard-variable` tab's Run validates and executes the SQL as a
  // variable option query — `workbench.run()` dispatches to that path
  // unconditionally for such a tab and never reaches the EXPLAIN machinery at
  // all, so forwarding `{explain: true}`/`{explainView}` there would silently
  // run an ordinary probe with no indication Explain was ignored. The Explain
  // toolbar button has no variable-specific hiding (same as the multi-statement
  // case above: it stays visible and this toasts on click) — checked first
  // since option SQL is always one statement, so the multi-statement message
  // would never even apply.
  function explainVariableBlocked(): boolean {
    if (variableDoc(app.activeTab()) === null) return false;
    flashToast('Explain isn’t available for a Dashboard variable’s option SQL.', { document: doc });
    return true;
  }
  // Explain the current query without editing it: run it through the EXPLAIN
  // views (the editor SQL is left untouched; run() wraps it as needed).
  function explainQuery(): Promise<void> | undefined {
    if (app.activeTab().editorMode !== 'sql') return undefined;
    return explainVariableBlocked() || explainMultiBlocked() ? undefined : workbench.run({ explain: true });
  }
  // Switch the active EXPLAIN view (re-runs the derived query, keeps the mode).
  function setExplainView(id: string): Promise<void> | undefined {
    if (app.activeTab().editorMode !== 'sql') return undefined;
    return explainVariableBlocked() || explainMultiBlocked() ? undefined : workbench.run({ explainView: id });
  }
  // Change the global result-row cap: persist the (normalized) preference and
  // re-run the current query so a raise genuinely fetches more (server-side cap),
  // a lower one stops sooner. run() no-ops on an empty editor, so changing the
  // limit with nothing typed just saves the preference.
  function setResultRowLimit(n: number): Promise<void> | undefined {
    app.state.resultRowLimit = normalizeRowLimit(n);
    prefs.save('resultRowLimit', app.state.resultRowLimit);
    if (app.activeTab().editorMode !== 'sql') return undefined;
    return app.requireAuthenticatedExecution() ? workbench.run() : undefined;
  }

  // Fetch the DDL for `target` (e.g. 'db.table' or 'DATABASE db') with
  // SHOW CREATE and pretty-print it through formatQuery(). Two round-trips
  // by design; if formatting fails the raw DDL is returned. Returns null on
  // failure or an empty statement (having already surfaced the toast), so
  // callers can no-op without inspecting the error themselves.
  async function fetchCreateSql(target: string): Promise<string | null> {
    // Both callers are action-gated, so this private helper has a scope for
    // its whole setup window.
    const scope = app.executionScope()!;
    const controller = new AbortController();
    let queryId: string | null = null;
    const registration = scope.register({
      name: 'show create',
      abort: () => controller.abort(),
      getQueryId: () => queryId,
    });
    const current = (): boolean => registration.isCurrent();
    try {
      await ensureConfig();
      if (!current()) return null;
      if (!(await getToken())) {
        chCtx.onSignedOut(undefined, scope.epoch);
        return null;
      }
      if (!current()) return null;
      queryId = uid('q');
      const show = await ch.queryJson<{ statement: string }>(
        chCtx,
        'SHOW CREATE ' + target + ' FORMAT JSON',
        controller.signal,
        { query_id: queryId },
      );
      if (!current()) return null;
      const stmt = (show.data && show.data[0] && show.data[0].statement) || '';
      if (!stmt) return null;
      try {
        queryId = uid('q');
        const fmt = await ch.queryJson<{ q: string }>(
          chCtx,
          'SELECT formatQuery(' + sqlString(stmt) + ') AS q FORMAT JSON',
          controller.signal,
          { query_id: queryId },
        );
        return current() ? (fmt.data && fmt.data[0] && fmt.data[0].q) || stmt : null;
      } catch {
        return current() ? stmt : null; // formatting is best-effort — fall back to the raw DDL
      }
    } catch (e) {
      if (current()) {
        flashToast('SHOW CREATE failed: ' + String((e instanceof Error && e.message) || e), { document: doc });
      }
      return null;
    } finally {
      registration.release();
    }
  }

  // Replaces the active editor's content (undo restores the prior query).
  async function insertCreate(target: string): Promise<void> {
    const scope = app.executionScope();
    const sql = await fetchCreateSql(target);
    if (sql != null && scope?.isOpen() && app.executionScope() === scope) {
      app.sqlEditor.replaceDocument(sql);
    }
  }

  // Opens the DDL in a new tab, leaving the active tab untouched.
  async function openCreateInNewTab(target: string, name?: string): Promise<void> {
    const scope = app.executionScope();
    const sql = await fetchCreateSql(target);
    if (sql == null || !scope?.isOpen() || app.executionScope() !== scope) return;
    loadIntoNewTab(app, name || '', sql); // falsy → loadIntoNewTab's own 'Untitled' fallback, same as omitting name
    toEditorOnMobile();
  }

  // --- saved / history bridges ------------------------------------------
  // The history-recording POLICY itself now lives in `saved.recordHistory`
  // (#276 Phase 4C) — this wrapper's own History-panel repaint is a rendering
  // concern the service must never own (see its header comment), so it stays
  // here. #587: the "only repaint when History is the active panel" decision
  // moved INTO the registry's `notifyRunComplete` (it dispatches to the
  // active lower panel only, and only if that panel defines the hook — today
  // only History does) — this wrapper no longer string-compares a panel id.
  // `app.shell` is null before the first shell mount, so this is always a
  // safe no-op that early.

  // --- share + star ------------------------------------------------------
  function share() {
    const tab = app.activeTab();
    if (tab.editorMode !== 'sql') return;
    const evaluated = queryDoc.evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
    const result = saved.buildShareUrl({ tab, evaluated, origin: loc.origin, pathname: loc.pathname, search: loc.search });
    if (!result.ok) {
      // 'empty' matches the decode side (main.js): sql OR panel — a text
      // panel legitimately has no SQL, and a sql-only check would make it
      // unshareable — silently no-op, same as the pre-extraction inline code.
      if (result.reason === 'invalid-spec') flashToast('Fix Spec errors before sharing', { document: doc });
      return;
    }
    win.history && win.history.replaceState && win.history.replaceState(null, '', result.url);
    const clip = (env.navigator || win.navigator || {}).clipboard;
    if (clip && clip.writeText) {
      clip.writeText(loc.href || result.url)
        .then(() => flashToast('Link copied to clipboard', { document: doc }))
        .catch(() => flashToast('Link in URL — copy manually', { document: doc }));
    } else {
      flashToast('Link in URL — copy manually', { document: doc });
    }
  }
  // --- copy / export results --------------------------------------------
  // A result is exportable once it has raw text or at least one row.
  function exportableResult(): QueryResult | null {
    // `tab.result` is opaque `Record<string,unknown> | null` at the state.ts
    // boundary; a script/scriptExport result never reaches this far in
    // practice (`script`/`scriptExport` are widened in, unused, purely so a
    // per-statement grid result reads as excluded here exactly like the
    // original untyped property read did — never actually a `QueryResult`).
    const r = app.activeTab().result as (QueryResult & { script?: unknown }) | null;
    // A script result is a per-statement grid, not a single exportable table.
    return r && !r.error && !r.script && (r.rawText != null || r.rows.length > 0) ? r : null;
  }
  // `targetDoc` defaults to the main document, but a detached view (issue
  // #100's Data Pane) passes its own — the Clipboard API ties writeText's
  // permission to the *focused* document, so resolving navigator off the main
  // window unconditionally would risk a NotAllowedError when the click came
  // from a different (same-origin) top-level browsing context. `env.navigator`
  // still wins first so tests can inject a stub regardless of which doc they
  // simulate.
  function copySnapshot(r: QueryResult | null, targetDoc?: Document): void {
    const d = targetDoc || doc;
    if (!r) { flashToast('Nothing to copy', { document: d }); return; }
    const text = r.rawText != null ? r.rawText : toTSV(r.columns, r.rows);
    const clip = (env.navigator || (d.defaultView || win).navigator || {}).clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text)
        .then(() => flashToast('Copied to clipboard', { document: d }))
        .catch(() => flashToast('Copy failed', { document: d }));
    } else {
      flashToast('Copy not supported', { document: d });
    }
  }
  function copyResult(): void { copySnapshot(exportableResult(), doc); }
  // --- streaming export (issue #87 single-file / #99 script) --------------
  // The export POLICY (statement-count dispatch, the picker-first/stream/
  // hold-back-buffer path, the script-export transport loop, both cancel
  // paths) now lives in `application/export-service.ts` (#276 Phase 4B2 —
  // `exportService`, constructed above alongside `params`). `exportEntry`/
  // `exportDirect`/`cancelExport`/`cancelExportScript` below are one-line
  // delegates onto it, kept as named locals (rather than inlining
  // `exportService.*` at the actions-registry call sites) so those registry
  // entries stay untouched.
  const exportEntry = (): Promise<void> | undefined => exportService.exportEntry();
  const exportDirect = (sqlInput: string, waveMs: number): Promise<void> => exportService.exportDirect(sqlInput, waveMs);
  const cancelExport = (): void => exportService.cancelExport();
  const cancelExportScript = (): void => exportService.cancelExportScript();

  // Inline progress banner (bytes written + elapsed, with Cancel) — no extra
  // tab/window; see the issue's "Why inline, not a child tab" rationale.
  function showExportProgress(onCancel: () => void): { update(bytes: number): void; remove(): void } {
    const t0 = now();
    const stat = h('span', { class: 'exp-stat' }, formatBytes(0) + ' · 0s');
    const el = h('div', { class: 'export-progress' },
      h('span', { class: 'spin' }, Icon.spinner()),
      h('span', { class: 'exp-label' }, 'Exporting…'),
      stat,
      h('button', { class: 'exp-cancel', title: 'Cancel export', onclick: onCancel }, Icon.close(), h('span', null, 'Cancel')));
    doc.body.appendChild(el);
    return {
      update(bytes: number) {
        stat.textContent = formatBytes(bytes) + ' · ' + ((now() - t0) / 1000).toFixed(0) + 's';
      },
      remove() { el.remove(); },
    };
  }
  // Trigger a browser download. Injectable via env.download for tests.
  function downloadFile(filename: string, mime: string, content: BlobPart): void {
    if (env.download) { env.download(filename, mime, content); return; }
    const url = (win.URL || win.webkitURL)!;
    const BlobCtor = win.Blob!;
    const href = url.createObjectURL(new BlobCtor([content], { type: mime }));
    const a = doc.createElement('a');
    a.href = href;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    url.revokeObjectURL(href);
  }

  const specBlocked = (tab: QueryTab): boolean => !tab.specParsed || hasBlockingSpecErrors(tab.specDiagnostics);

  // The Save-popover/user-menu light anchored popover (non-modal — distinct
  // from `openAnchoredDialog`'s modal dialog chrome) now lives in
  // `ui/popover.ts`'s `createAnchoredPopovers` (#588 W2), a pure extraction:
  // every line of `anchoredPopover` + its closers registry moved verbatim,
  // only `app.*`/`doc`/`win` reads rewritten onto the `deps` thunks below.
  // `beginSurfaceTransition`/`disposeCurrentSurface` keep calling
  // `popovers.closeAll()` exactly as they called `closeAnchoredPopovers()`
  // before. The instance-scoped closers Set lives inside `popovers` now, not
  // as a module-global here.
  const popovers = createAnchoredPopovers({
    document: doc,
    acquireKeyboardOwner: (kind) => app.acquireKeyboardOwner(kind),
    isMobile: () => app.state.isMobile.value,
    viewportWidth: () => win.innerWidth,
    getRef: (key) => app.dom[key],
    setRef: (key, node) => { app.dom[key] = node; },
  });
  const anchoredPopover = popovers.open;
  const closeAnchoredPopovers = popovers.closeAll;

  // The Save cluster — `updateSaveBtn`, `saveActiveQuery`, and the linked
  // commit/create/conflict-chooser paths it dispatches to — now lives in
  // `ui/workbench/save-controller.ts`'s `createSaveController` (#588 W2), a
  // pure extraction: every line moved verbatim, only `app.*`/`doc`/`saved`/
  // `queryDoc` reads rewritten onto the `deps` thunks below. The #457
  // kind-dispatch-first ordering (I-15) travels with the code UNCHANGED in
  // both `updateSaveBtn` and `saveActiveQuery` — see that module's own header
  // comment. `App.openSavePopover` is DROPPED (zero production consumers —
  // #588 phase 4 plan §3-W2b); `app.updateSaveBtn` and `actions.save` stay
  // flat delegates onto the controller for their wide existing consumers.
  const saveController = createSaveController({
    document: doc,
    state,
    activeTab: () => app.activeTab(),
    saved: { commit: (tab, evaluated) => saved.commit(tab, evaluated), create: (tab, name, description) => saved.create(tab, name, description) },
    queryDoc: {
      evaluateSpecDraft: (tab, text, opts) => queryDoc.evaluateSpecDraft(tab, text, opts),
      revalidateSpecDrafts: (opts) => queryDoc.revalidateSpecDrafts(opts),
      revealFirstSpecError: (tab) => queryDoc.revealFirstSpecError(tab),
    },
    currentWorkspace: () => app.currentWorkspace,
    captureSurfaceGeneration: () => app.captureSurfaceGeneration(),
    refreshCurrentSurfaceAfterStale: (generation, committed) => app.refreshCurrentSurfaceAfterStale(generation, committed),
    syncBeforeUnload: () => app.syncBeforeUnload(),
    refreshWorkspaceFromStore: () => app.workspaceSession.refreshWorkspaceFromStore(),
    commitVariableConfig: (dashboardId, variableName, cfg) => commitVariableConfig(app, dashboardId, variableName, cfg),
    saveBtn: () => app.dom.saveBtn,
    savePopoverOpen: () => !!app.dom.savePopover,
    anchoredPopover: popovers.open,
    rerenderTabs: () => app.actions.rerenderTabs(),
    updateEditorModeUi: () => app.updateEditorModeUi!(),
    renderSavedHistory: () => renderSavedHistory(app),
    renderResults: () => renderResults(app),
    syncSpecEditorFromState: () => app.specEditor.syncFromState(),
    specBlocked,
  });

  function formatSpec(): void {
    const tab = app.activeTab();
    if (tab.editorMode !== 'spec') return;
    const formatted = formatSpecText(tab.specText);
    if (formatted.diagnostic) {
      queryDoc.evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
      app.specEditor.revealDiagnostic(0);
      return;
    }
    app.specEditor.replaceDocument(formatted.text);
  }

  // The editor-mode-switch POLICY (whether `mode` is allowed right now) now
  // lives in `queryDoc.resolveEditorMode` (#276 Phase 4C); this function keeps
  // the DOM/focus half — assigning `tab.editorMode`, repainting the
  // editor-mode chrome, focusing the target editor.
  function setEditorMode(mode: 'sql' | 'spec'): boolean {
    const tab = app.activeTab();
    const gate = queryDoc.resolveEditorMode(tab, mode);
    if (!gate.ok) {
      if (gate.message) flashToast(gate.message, { document: doc });
      return false;
    }
    tab.editorMode = mode;
    app.updateEditorModeUi!();
    const editor = mode === 'spec' ? app.specEditor : app.sqlEditor;
    (editor as EditorPort & { requestMeasure?: () => void }).requestMeasure?.();
    editor.focus();
    return true;
  }


  // User menu: dropdown under the header user button, holding the identity and
  // a Log out item. Same close model as the save popover (Esc + outside click).
  function openUserMenu(): void {
    if (app.dom.userMenu) return;
    let close: () => void;
    const logoutBtn = h('button', { class: 'um-item danger', onclick: () => { close(); app.signOut(); } }, Icon.logout(), h('span', null, 'Log out'));
    const menu = h('div', { class: 'user-menu' },
      h('div', { class: 'um-id' }, conn.email()),
      logoutBtn,
      h('div', { class: 'um-build', title: 'App version / build' }, app.build),
      h('div', {
        class: 'um-server', title: 'ClickHouse version', hidden: !app.state.serverVersion,
      }, app.state.serverVersion ? `CH ${shortVersion(app.state.serverVersion)}` : ''));
    ({ close } = anchoredPopover(menu, app.dom.userBtn!, 'userMenu'));
    setTimeout(() => logoutBtn.focus());
  }

  function toggleTheme(): void {
    // The shared DOM composition (state-flip + persist + `data-theme` +
    // icon swap) now lives in `ui/theme-toggle.ts`'s `toggleThemeDom` (#276
    // Phase 5) — the shared application header wires its theme button to this
    // thin `app.toggleTheme` wrapper, which is also kept solely for
    // explain-graph.ts's detached schema-graph overlay, which
    // takes it as an optional callback (see theme-toggle.ts's own header
    // comment for why that one seam isn't mechanical to repoint).
    toggleThemeDom({ prefs, document: doc, themeBtn: () => app.dom.themeBtn });
  }
  // Exposed so the schema-view overlay can drive the same toggle (keeps state +
  // saved pref + header icon in sync rather than flipping data-theme behind them).

  // On mobile (#126), jump the bottom-nav to the Editor panel after an action
  // that changes the editor content; a no-op on desktop.
  const toEditorOnMobile = (): void => { if (app.state.isMobile.value) app.state.mobileView.value = 'editor'; };

  // --- dashboard (#149 D1) ----------------------------------------------
  // Dashboard tiles stream their read-only SQL through the shared
  // `app.exec.executeRead` seam directly (#193/#276 — see src/ui/dashboard.js
  // `runSlotTile`), the same path run() and the detached Data view use; the
  // former bespoke `runTile`/`queryDashboardTile`/`parseJsonResult` machinery
  // was retired so cap/settings fixes can't apply to only one path.
  // #425: the persistent shell and the query column are each mounted ONCE per
  // signed-in workspace and survive every surface switch — that is what preserves
  // the editor's contents, selection and scroll, the active tab, the result view,
  // and the result-drawer size across a Dashboard round trip. Only a real
  // end-of-life event (a workspace switch, workspace-not-found/loading, or
  // sign-out) tears them down; `shell === null` is then the signal to rebuild,
  // and it MUST be nulled by everything that replaces `#root` wholesale, or the
  // next render would skip a mount that is no longer in the document.
  const ignoreExternalWorkspaceChange = (): void => {};
  const ensureShell = (): AppShellHandle => {
    shell ??= mountAppShell({
      app,
      root: app.root,
      document: doc,
      state: app.state,
      catalog,
      prefs,
      matchMedia: app.matchMedia,
      updateBanner: app.updateBanner,
      startDrag,
    });
    // #587: mirrored onto `app` so any module holding `app` (not just this
    // closure) can reach the side-panel registry through `app.shell` — e.g.
    // `saved-history.ts`'s `renderSavedHistory` compatibility export.
    app.shell = shell;
    if (!inlineLogin) {
      inlineLogin = mountInlineLogin(
        app as App & { root: Element },
        shell.authHost,
      );
      if (activeExecutionScope?.isOpen()) inlineLogin.hide();
    }
    if (!disposeWorkbenchMount) disposeWorkbenchMount = renderApp(app, { startDrag }, shell.queryHost);
    return shell;
  };
  // #590 §1.9 — the surface-retirement coordinator: exclusive mutation
  // authority over the two reactive signals `app.currentWorkspace`/
  // `app.mainSurface` project. The mutable `Signal` handles, `disposeShell`,
  // `disposeCurrentSurface`, and the two shell-destroying placeholder renders
  // below are declared ONLY between the markers below — no other code in
  // `createApp` can even NAME them (a "Cannot find name" `tsc` error, not
  // merely a lint convention), so a write-then-dispose bypass fails to
  // compile. `tests/unit/surface-lifecycle-arch.test.ts` scans this file
  // between the two marker comments and fails the build on an out-of-region
  // write to the private signals, an out-of-region `currentWorkspace =
  // null`, an out-of-region dispose call, either declaration moving outside
  // the markers, or a `mainSurface`/`currentWorkspace` write lexically
  // preceding a `retireTo*` call in one function body (the one hazard no
  // compile-time mechanism can foreclose — the named ops below are meant to
  // be called from OUTSIDE this region). Keep every coordinator declaration
  // between the markers.
  // #590-COORDINATOR-BEGIN
  const committedWorkspaceSignal: Signal<StoredWorkspaceV5 | null> = signal(null);
  const mainSurfaceSignal: Signal<MainSurfaceState> = signal(QUERY_SURFACE);
  // #426/#590 — the Dashboard tree's ONE reactive dependency: a `computed`
  // STRING key over exactly the structural fields `deriveDashboardTree`
  // reads (`kind`/`dashboardId`/`currentMember`) — never the whole
  // `MainSurfaceState`. The one-shot delivery fields (`pendingFocus`/
  // `pendingScrollTop`) are deliberately excluded, so consuming them (e.g.
  // `withoutPendingFocus`/`withPendingFocus`) notifies nothing (invariant
  // (g)). `JSON.stringify` of the tuple, never a bare-delimiter join:
  // dashboard/tile/variable ids may legally contain `:`/`"`/`\` up to 256
  // chars (schema-verified), so a naive join could conflate two distinct
  // tuples into one identical string and silently suppress a repaint
  // (invariant (h)). Grows a field ONLY if the tree gains a new structural
  // dependency — `mode` is deliberately excluded because the tree never
  // reads it.
  const treeNavigationSignal: ReadonlySignal<string> = computed(() => {
    const surface = mainSurfaceSignal.value;
    return surface.kind === 'dashboard'
      ? JSON.stringify([
        surface.kind, surface.dashboardId,
        surface.currentMember?.kind ?? null, surface.currentMember?.id ?? null,
      ])
      : JSON.stringify([surface.kind, null, null, null]);
  });
  // The non-null commit op behind the public `currentWorkspace` setter
  // (#590 §1.2) — every REAL projection writes here, through
  // `app.currentWorkspace = workspace`. The setter's write TYPE excludes
  // `null` (see app.types.ts), so this is the ONLY function that ever
  // assigns a non-null value to the signal, and the retirement ops below are
  // the only code that ever assigns `null` to it.
  const commitCurrentWorkspace = (workspace: StoredWorkspaceV5): void => {
    committedWorkspaceSignal.value = workspace;
  };
  // The navigation op behind the public `mainSurface` setter — always
  // writable (ordinary navigation never tears anything down, so it needs no
  // named-op ceremony).
  const navigateMainSurface = (surface: MainSurfaceState): void => {
    mainSurfaceSignal.value = surface;
  };
  const disposeShell = (): void => {
    disposeWorkbenchMount?.();
    disposeWorkbenchMount = null;
    inlineLogin?.dispose();
    inlineLogin = null;
    shell?.dispose();
    shell = null;
    app.shell = null;
  };
  const disposeCurrentSurface = (): void => {
    app.closeShortcutDialog();
    resetShortcutChord(app);
    app.nav.advanceSurfaceGeneration();
    for (const control of app.root?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      'button, input, select, textarea',
    ) ?? []) control.disabled = true;
    closeAnchoredPopovers();
    disposeFileMenuOverlays(app);
    disposeDashboardSurface();
    disposeShell();
    workbench.destroy();
    app.onWorkspaceExternallyChanged = ignoreExternalWorkspaceChange;
  };
  const renderWorkspaceNotFound = (): void => {
    disposeCurrentSurface();
    app.root?.replaceChildren(h('main', { class: 'workspace-not-found' },
      h('h1', null, 'Workspace not found'),
      h('p', null, `No local workspace exists for “${app.sqlRoute.workspaceKey ?? ''}”.`),
      h('a', { href: conn.basePath || '/sql' }, 'Open the last-used workspace')));
  };
  const renderWorkspaceLoading = (): void => {
    disposeCurrentSurface();
    app.root?.replaceChildren(h('main', {
      class: 'workspace-loading', 'aria-busy': 'true', 'aria-live': 'polite',
    }, h('p', null, 'Loading workspace…')));
  };
  // #590 §1.9 — the FOUR named departure ops covering every live-shell
  // teardown span the issue's whole-repo audit found, plus the zero-live-
  // shell boot failures, and one publication-free re-render for the nav
  // dispatch's re-entry arms. Each op that tears down a live shell publishes
  // its transitional state and disposes inside ONE `batch()`, so a
  // still-mounted shell's effects are unsubscribed before the batch flushes
  // — they observe NOTHING of the transitional state (invariant (j)).
  // Status is always written before the null aggregate (invariant (i)).
  const retireToWorkspaceLoading = (): void => {
    batch(() => {
      app.workspaceRouteStatus = 'loading';
      committedWorkspaceSignal.value = null;
      renderWorkspaceLoading();
    });
  };
  const retireToWorkspaceMissing = (): void => {
    batch(() => {
      app.workspaceRouteStatus = 'not-found';
      committedWorkspaceSignal.value = null;
      app.renderCurrentSurface();
    });
  };
  // #590 §1.7/§1.9 pass-6 — the two boot-time failure branches (corrupt /
  // not-found / error) have zero live shell effects (boot mounts no shell —
  // every caller disposes via `renderWorkspaceLoading` first), so this op's
  // disposal arm is empty; it still routes through the coordinator so no
  // `currentWorkspace = null` write exists anywhere else, which is what lets
  // the public setter's write type exclude `null` entirely.
  const retireToWorkspaceFailure = (status: 'not-found' | 'error'): void => {
    batch(() => {
      app.workspaceRouteStatus = status;
      committedWorkspaceSignal.value = null;
    });
  };
  // #425/#590 — the former `renderLoginApp`: login replaces `#root`
  // wholesale, so the persistent shell must be disposed AND forgotten here —
  // otherwise its effects keep repainting a detached sidebar, and the next
  // sign-in would skip re-mounting a shell that is no longer in the
  // document, leaving a blank page. The Dashboard surface goes here too:
  // this is the explicit end-of-session renderer, so no route-scoped
  // listeners or generation-matching command port may remain dispatchable
  // from the full-screen login. Involuntary auth loss does not call this
  // path (see `revealAuthenticationRequired`'s inline-host branch above); it
  // retains the Dashboard/document shell. The `mainSurface` reset is a
  // GENUINE dashboard→query structural-key change when signing out from a
  // mounted Dashboard surface (pass-5 finding) — publishing it one statement
  // before `disposeShell()` OUTSIDE a batch would fire the still-live tree
  // effect on the eve of login, a repaint current code never produces —
  // hence the whole sequence lives in one `batch()`, today's order.
  const retireToLogin = (msg?: string): void => {
    batch(() => {
      app.closeShortcutDialog();
      resetShortcutChord(app);
      disposeDashboardSurface();
      app.nav.advanceSurfaceGeneration();
      mainSurfaceSignal.value = QUERY_SURFACE;
      disposeShell();
      renderLogin(app as App & { root: Element }, msg);
    });
  };
  // Re-renders the CURRENT retired status (loading / not-found / error)
  // WITHOUT publishing anything — for the nav dispatch's re-entry paths
  // (`renderCurrentSurface`'s status !== 'ready' branch), where the status/
  // null pair was already published by one of the four ops above and only
  // the DOM needs repainting (e.g. a resumed stale-generation dispatch).
  const rerenderRetiredSurface = (): void => {
    if (app.workspaceRouteStatus === 'loading') { renderWorkspaceLoading(); return; }
    renderWorkspaceNotFound();
  };
  // #590-COORDINATOR-END
  // What the Dashboard surface renders THIS pass. `dashboardId` is `null` only
  // for the legacy empty-collection entry point, which lands on the Dashboard's
  // own "Create dashboard" state; its mode then comes from the route, since there
  // is no selection to carry one.
  const dashboardRenderTarget = (mounted: AppShellHandle): DashboardRenderTarget => {
    const surface = app.mainSurface;
    const routeMode = app.sqlRoute.surface === 'dashboard' ? app.sqlRoute.mode : 'edit';
    const target: DashboardRenderTarget = {
      host: mounted.dashboardHost,
      dashboardId: surface.kind === 'dashboard' ? surface.dashboardId : null,
      mode: surface.kind === 'dashboard' ? surface.mode : routeMode,
      focus: surface.kind === 'dashboard' ? surface.pendingFocus : null,
      // #471: the offset a history restoration owes this render, consumed with the
      // focus delivery below for the same reason.
      scrollTop: surface.kind === 'dashboard' ? surface.pendingScrollTop : null,
      setHeader: (header) => mounted.setHeader(header),
    };
    // #425: a focus target is delivered ONCE. Every later repaint of the same
    // selection — an external commit, a style switch, a stale-write refresh —
    // re-reads this target, so leaving the request on the selection would yank
    // focus back to that tile (and re-flash its highlight) long after the user
    // navigated elsewhere. #426: only the DELIVERY is consumed — `currentMember`
    // survives, because the tree paints its current-resource styling from it
    // long after the focus ring has moved on.
    app.mainSurface = withoutPendingFocus(surface);
    return target;
  };
  // Everything a transition BETWEEN the two surfaces must clear, and nothing
  // more. Notably absent: `workbench.destroy()`. It aborts the in-flight request
  // and issues KILL QUERY, and a surface change must never execute or cancel the
  // currently open editor query (#425) — it belongs to the teardown paths below.
  const beginSurfaceTransition = (): void => {
    app.closeShortcutDialog();
    resetShortcutChord(app);
    app.nav.advanceSurfaceGeneration();
    closeAnchoredPopovers();
    disposeFileMenuOverlays(app);
    // #586 REWRITE: this used to close ONLY the doc pane, on the reasoning
    // that the cell-detail drawer/rows viewer were modal and keyboard-trapped
    // — no surface control was reachable while either was open, so a surface
    // transition could never happen underneath them. #586 docked all three
    // (Cell, Rows, Reference) into ONE shell-owned `inspectorHost`, and none
    // of them holds the modal keyboard owner anymore (a docked, non-modal
    // panel must leave the rest of the app usable) — so the surface-switch
    // control IS now reachable while any of them is open, and whichever one
    // currently occupies the shared dock must be closed here, not just
    // Reference. `closeInspector` is generic over the current occupant.
    closeInspector(app);
  };

  // Project the active StoredWorkspaceV5 onto the current application surface.
  // Persistence is now a collection; this projection identifies which record
  // this tab is editing, while the repository remains independently addressable
  // by immutable id and stable URL key. #424: `state.dashboard` is the
  // COMPATIBILITY Dashboard — the single document this phase's UI exposes —
  // resolved through the one selection seam. Every other stored Dashboard
  // stays on `app.currentWorkspace` and is never projected, executed, or
  // rewritten by a Workbench action.
  // #590 — the ENTIRE body is one `batch()`: the signal setters
  // (`app.currentWorkspace`/`app.mainSurface`) run FIRST, and the lower-pane
  // renderer computes Library membership from BOTH `currentWorkspace
  // .dashboards` and the plain `state.savedQueries` array in one function
  // (`saved-history.ts`'s `libraryEntries`) — a batch scoped narrowly to the
  // `.value` writes would flush effects before `savedQueries`/`dashboard`/
  // workspace-identity are applied, and the first repaint would see a mixed
  // old/new snapshot (repo lesson: equal values/counts can't prove
  // single-sourcing). This function stays the sole non-null projection
  // funnel — the reason the #426 comment below gives stays true, only the
  // mechanism (a signal write, not a counter bump) changed.
  const applyCommittedWorkspace = (workspace: StoredWorkspaceV5): void => { batch(() => {
    app.currentWorkspace = workspace;
    app.workspaceRouteStatus = 'ready';
    // #425: re-validate the selected Dashboard against committed truth. A
    // selection that was deleted — or whose id became ambiguous — falls back to
    // QUERY mode rather than silently retargeting another Dashboard, and the
    // route follows so the URL never claims a Dashboard surface this session no
    // longer has a document for.
    //
    // A Dashboard id is unique WITHIN a workspace, not globally — two workspaces
    // can each hold a Dashboard called `main`. So a workspace change always CLEARS
    // the selection: keeping it because the incoming workspace happens to carry the
    // same id would silently open an unrelated Dashboard, and the next edit would
    // commit to the wrong resource. Only a same-workspace projection re-validates
    // an existing selection.
    const workspaceChanged = app.state.workspaceId !== workspace.id;
    const previousSurface = app.mainSurface;
    app.mainSurface = workspaceChanged
      ? QUERY_SURFACE
      : reconcileMainSurface(previousSurface, workspace);
    // Only a selection lost WITHIN one workspace completes the fallback here. A
    // workspace switch leaves the surface to its own URL-driven path
    // (`loadWorkspaceOnBoot` → `adoptRouteMainSurface` → `renderCurrentSurface`),
    // which resolves the NEW workspace's own Dashboard when the route asks for one.
    const lostSelection = !workspaceChanged
      && previousSurface.kind === 'dashboard' && app.mainSurface.kind === 'query';
    if (workspaceChanged) detachWorkspaceBoundTabs(app.state);
    app.state.savedQueries = workspace.queries;
    reconcileTabsWithSavedQueries(app.state);
    // #343: seed the in-sync baseline token for any still-linked tab that lacks
    // one (e.g. a pre-existing session, or a tab linked without going through
    // the open/create/save paths) so the linked-tab classifier can compare it on
    // a later external refresh. Only fills gaps — never overwrites a token an
    // adopt/open already set, so it can't mask a genuine external change.
    for (const tab of app.state.tabs.value) {
      if (tab.savedId && tab.lastCommittedQueryToken === undefined) {
        const q = workspace.queries.find((query) => query.id === tab.savedId);
        if (q) tab.lastCommittedQueryToken = queryToken(q);
      }
    }
    // #425: project the SELECTED Dashboard. `state.dashboard` is the single
    // compatibility document a few legacy export/import paths still read
    // (state.ts, file-menu.ts), so projecting the compatibility entry while
    // a different one is selected would misidentify which document those
    // paths operate on.
    const projectedId = selectedDashboardId(app.mainSurface);
    app.state.dashboard = projectedId === null
      ? resolveCompatibilityDashboard(workspace).dashboard
      : findDashboard(workspace, projectedId);
    app.state.workspaceId = workspace.id;
    app.state.workspaceKey = workspace.key;
    app.state.libraryName.value = workspace.name;
    app.state.libraryDirty.value = false;
    // #343 §2: this projection IS now the tab's committed baseline — record its
    // snapshot token so a later reload can cheaply tell whether anything changed.
    // Every projection funnels through here (boot, mutateWorkspace, reset), so
    // the token stays consistent with what's on screen. #588 phase 4 wave 3:
    // the token itself now lives on `app.workspaceSession` — this calls
    // `recordProjection` at the point this used to assign `lastCommittedToken`
    // directly.
    app.workspaceSession.recordProjection(workspace);
    // #426/#590: EVERY projection funnels through here — boot, a committed
    // mutation, an external refresh, and a workspace switch — which makes
    // this the one place the Dashboard tree's committed-truth input changes.
    // The `app.currentWorkspace` setter above (inside this same batch) IS
    // the notification now — no separate invalidation call exists.
    // #426: prune the tree's session UI state against committed truth, so a
    // deleted Dashboard's expansion (and its group entries) cannot linger for the
    // rest of the session — or, worse, make a RECREATED id render pre-expanded.
    // Survivors are preserved, so an ordinary mutation never collapses the tree.
    const treeUi = app.state.dashboardTreeUi.get(workspace.id);
    if (treeUi) {
      const pruned = pruneTreeUi(treeUi, workspace.dashboards.map((dashboard) => dashboard.id));
      if (pruned !== treeUi) app.state.dashboardTreeUi.set(workspace.id, pruned);
    }
    // #426: a deferred single-click was scheduled against the rows of a PROJECTION,
    // and every projection replaces them — not just a workspace switch. Deleting a
    // Dashboard inside the 300ms window would otherwise let the delayed toggle
    // re-add the id that was just pruned. Cancelling unconditionally can drop a
    // click when a background commit lands mid-gesture, which is the cheaper error:
    // the rows that click referred to are gone either way. (#443 removed the other
    // half of this rationale: a deleted panel's deferred open reaching
    // `openSavedQuery` with a dead id is now handled at the callee, which reports
    // and stays put rather than navigating nowhere.)
    cancelDashboardTreeClicks(app);
    // #464: Dashboard titles and ownership are presentation inputs for the
    // Query tab strip. A workspace commit can change either without changing a
    // tab signal (for example, renaming a Dashboard), so repaint explicitly
    // after the complete projection rather than waiting for a later tab edit.
    renderTabs(app);
    // #425: COMPLETE the fallback, don't just record it. Rewriting the route and
    // leaving the Dashboard host exposed wedges the app: every path back —
    // `showQuerySurface`, the header switch, `g w`, a Library click — early-returns
    // because state and route now agree that Query mode is active, while the
    // deleted Dashboard's DOM is still what the user sees. Both the callers that
    // would otherwise repaint (`afterLibraryChange`, `runWorkspaceRefresh`) branch
    // on `sqlRoute.surface`, which this fallback just changed under them, so the
    // render has to happen here.
    if (lostSelection) {
      if (app.sqlRoute.surface === 'dashboard') {
        // #588 phase 4 wave 4: `writeRoute` moved into `app.nav` (nav-private
        // otherwise) — exposed as an escape hatch for exactly this call, which
        // forces the QUERY surface's route with 'replace' regardless of the
        // CURRENT route surface; see surface-navigation.ts's header comment
        // for why neither `rewriteWorkspaceRoute` nor `showQuerySurface` is
        // behavior-identical here.
        app.nav.writeRoute(mainSurfaceRoute(QUERY_SURFACE, workspace.key), 'replace');
      }
      app.renderCurrentSurface();
    }
  }); };
  // #287 W5: the shared WorkspaceIdGen seam file-menu.js's New workspace /
  // Import / Replace operations use to mint fresh ids (`uid('ws-')`).

  // #588 phase 4 wave 3: queueing, repository calls, tokens, broadcasts,
  // refresh scheduling, listeners, and beforeunload now live in
  // `src/application/workspace-session.ts` — this call sites the whole thing
  // in ONE place, wired to app.ts's own closures/fields through
  // `hooks`/`routeCurrency`, exactly the layering `applyCommittedWorkspace`
  // above stays out of (it is real UI orchestration, not "zero DOM").
  // `routeCurrency`'s three thunks read today's raw app.ts closures/fields
  // directly — wave 4 (`src/application/surface-navigation.ts`) rewires their
  // BODIES onto its own accessors; this session's own interface does not
  // change then.
  session = createWorkspaceSession({
    repository: workspaceRepo,
    state,
    uid,
    genId: () => app.genId(),
    broadcastChannelFactory,
    documentVisible,
    windowSeam: win,
    documentSeam: doc,
    // #588 phase 4 wave 4: `routeWorkspaceKey`/`routeStatus` keep reading
    // app.ts's own `sqlRoute`/`workspaceRouteStatus` data properties directly
    // (unaffected by this wave — they never lived in a moved closure);
    // `loadGeneration` is rewired from wave 3's raw `routeLoadGeneration`
    // closure read onto `app.nav`'s own accessor, now that the counter itself
    // lives there. Only these THREE thunk BODIES change — `WorkspaceSession`'s
    // own `routeCurrency` interface (workspace-session.ts) is untouched.
    routeCurrency: {
      routeWorkspaceKey: () => app.sqlRoute.workspaceKey,
      routeStatus: () => app.workspaceRouteStatus,
      loadGeneration: () => app.nav.loadGeneration(),
    },
    hooks: {
      applyCommittedWorkspace: (ws) => app.applyCommittedWorkspace(ws),
      // #590 §1.9 — the coordinator's `retireToWorkspaceMissing` op: status
      // written before the null aggregate, both inside one `batch()` with
      // the `renderCurrentSurface()` dispatch, so the still-mounted shell
      // (if any) is disposed before that batch flushes.
      onWorkspaceMissing: () => { retireToWorkspaceMissing(); },
      isWorkbenchSurface: () => app.sqlRoute.surface === 'workspace',
      // Re-run the tab effect (editor doc re-sync for the active tab, parked
      // reconcile for the rest, tab strip + Save button + var strip) by
      // handing the tabs signal a fresh array reference.
      refreshWorkbenchUi: () => {
        batch(() => { app.state.tabs.value = [...app.state.tabs.value]; });
        app.updateSaveBtn();
        app.updateEditorModeUi?.();
        renderSavedHistory(app);
      },
      notifyExternallyChanged: (info) => app.onWorkspaceExternallyChanged(info),
      onExternalInvalidation: (msg) => app.onExternalWorkspaceChange(msg),
      // #343 step 4: a non-destructive warning when a reload can't reach the
      // store. The current projection stays on screen; the next focus/
      // visibility event schedules another attempt (activation always
      // refreshes), so this never wedges the workspace queue or discards data.
      warnRefreshFailed: () => {
        flashToast(
          'Couldn’t reload the latest workspace — showing the last known version; will retry when you return to this tab.',
          { document: doc },
        );
      },
      warnMarkOpenedFailed: () => {
        flashToast('Workspace opened, but its last-used timestamp could not be saved.', { document: doc });
      },
    },
  });
  // #343 step 4: the route/surface refresh hook a mounted route registers to
  // react AFTER a refresh actually projected an external change — Dashboard
  // overrides this to rebuild its viewer session from the latest committed
  // workspace. Default no-op: the Workbench route's repaint is built into
  // `app.workspaceSession.refreshWorkspaceFromStore` itself. Flat delegate
  // (wide production consumer set — see app.types.ts).
  // #343 §5/§6: invoked when another tab reports a workspace change (channel
  // receive, or a focus/visibility event) — the session's own channel
  // handler and focus/visibility listeners call `scheduleRefresh()` directly;
  // this flat delegate is what a mounted route/test overrides to observe the
  // signal itself (never receives this tab's own broadcast).
  // Flat delegates onto the session for its wide production consumer set
  // (workbench-shell.ts, oauth callbacks, save-controller.ts's thunk).

  // #588 phase 4 wave 4: `resetCorruptWorkspace` stays here (real UI
  // orchestration — drives `app.workspace.delete` alongside
  // `session.resolveImplicitOrProvision`, exactly like `applyCommittedWorkspace`
  // above stays outside `workspaceSession`), but the route-currency reads/
  // writes it used to do directly (`routeLoadGeneration`/`routeSearch`) now go
  // through `app.nav` — `nav.loadGeneration()` and `nav.rewriteWorkspaceRoute()`
  // do byte-identical work (see `surface-navigation.ts`'s own `writeRoute`).
  const resetCorruptWorkspace = async (id: string): Promise<void> => {
    const expectedGeneration = app.nav.loadGeneration();
    const deleted = await app.workspace.delete(id);
    if (!deleted.ok) return;
    const result = await session.resolveImplicitOrProvision();
    if (result.status === 'ok' && app.nav.loadGeneration() === expectedGeneration) {
      applyCommittedWorkspace(result.workspace);
      await session.recordOpened(result.workspace);
      if (app.nav.loadGeneration() !== expectedGeneration) return;
      app.nav.rewriteWorkspaceRoute(result.workspace.key);
      app.retryPendingOAuthDocumentRecovery();
      app.renderCurrentSurface();
    }
  };

  // #590: `renderWorkspaceNotFound`/`renderWorkspaceLoading` moved into the
  // surface-retirement coordinator above (they are coordinator-PRIVATE
  // disposing renders now — reached only through the named retirement ops
  // and the publication-free `rerenderRetiredSurface`), so they are not
  // redeclared here.

  // #588 phase 4 wave 4: the route locals + surface-generation guards,
  // `writeRoute`, `loadWorkspaceOnBoot`, the `renderCurrentSurface` dispatch,
  // `navigateSqlRoute`/`handleSqlPopState`, `syncSqlRoute`/
  // `rewriteWorkspaceRoute`, `surfaceRouteKey`/`stampDashboardHistoryEntry`/
  // `applyMainSurface`, `focusDashboardMember`, `openDashboard`/
  // `showQuerySurface`/`showDashboardSurface`, and the saved-query/panel/
  // variable tab openers/`adoptRouteMainSurface` all now
  // live in `application/surface-navigation.ts`'s `createSurfaceNavigation`
  // (a pure extraction — every line moved verbatim, only `app.*`/`win`/`loc`/
  // `doc` reads rewritten onto the `deps` thunks below). This shell supplies
  // every `src/ui/**` touch point the moved code made (toast, tab loading,
  // dashboard-tree reveal, dashboard scroll, render dispatch) as an INJECTED
  // HOOK — `src/application/**` may not import `src/ui/**` at all, type-only
  // imports included (build/check-boundaries.mjs). `surface: () => app` hands
  // the module the live controller, narrowed structurally to
  // `SurfaceStatePort` — mutations through it land on the real `app`, so
  // nothing outside this file needs to change.
  const nav = createSurfaceNavigation({
    state,
    surface: () => app,
    repository: workspaceRepo,
    session,
    history: win.history,
    basePath: () => conn.basePath,
    locationHash: () => loc.hash || '',
    locationSearch: () => loc.search,
    hooks: {
      applyCommittedWorkspace: (ws) => app.applyCommittedWorkspace(ws),
      renderApp: () => app.renderApp(),
      renderDashboard: () => app.renderDashboard(),
      retireToWorkspaceLoading: () => retireToWorkspaceLoading(),
      retireToWorkspaceFailure: (status) => retireToWorkspaceFailure(status),
      rerenderRetiredSurface: () => rerenderRetiredSurface(),
      onCorruptWorkspace: (id) => { void resetCorruptWorkspace(id); },
      retryPendingOAuthDocumentRecovery: () => { app.retryPendingOAuthDocumentRecovery(); },
      closeShortcutDialog: () => app.closeShortcutDialog(),
      resetShortcutChord: () => app.resetShortcutChord(),
      isSignedIn: () => conn.isSignedIn(),
      toast: (message, opts) => flashToast(message, { document: doc, action: opts?.action }),
      revealAssignedPanel: (dashboardId, tileId) => revealAssignedPanel(app, dashboardId, tileId),
      loadIntoNewTab: (query) => { loadIntoNewTab(app, { ...query }); },
      openVariableTabUi: (binding, sql) => { openVariableTab(app, binding, sql); },
      toEditorOnMobile: () => toEditorOnMobile(),
      runAction: (opts) => { app.actions.run(opts); },
      dashboardScrollTop: () => dashboardScrollTop(),
      isAutoRunnableSql: (sql) => isAutoRunnable(sql),
      // Four "self-dispatch" hooks (see surface-navigation.ts's own doc
      // comment on them): read the LIVE `app.*` property at call time, so a
      // test overriding e.g. `app.renderCurrentSurface = vi.fn()` is observed
      // by every nav-internal cross-call exactly as the pre-extraction inline
      // code was (every one of these four members was called via `app.foo()`
      // property access from ANOTHER moved function, never a private local).
      dispatchCurrentSurface: () => app.renderCurrentSurface(),
      dispatchLoadWorkspaceOnBoot: () => app.loadWorkspaceOnBoot(),
      dispatchShowQuerySurface: () => app.showQuerySurface(),
      dispatchOpenDashboard: (request) => app.openDashboard(request),
    },
  });
  // Flat delegates for every wide-consumer member (dashboard.ts,
  // dashboard-tree.ts, file-menu.ts, app-shell.ts, shortcuts.ts,
  // saved-history.ts, tests) — `handleSqlPopState`/`focusDashboardMember`
  // (router-private) and `syncSqlRoute`/`rewriteWorkspaceRoute` (repointed to
  // main.ts/file-menu.ts) have NO flat delegate; reach them via `app.nav.*`.

  // --- actions registry --------------------------------------------------
  const withAuthenticatedExecution = <T>(operation: () => T): T | undefined =>
    (app.requireAuthenticatedExecution() ? operation() : undefined);

  app = {
    state,
    dom: {},
    root: env.root || doc.getElementById('root'),
    document: doc,
    Chart: env.Chart || win.Chart,
    cssVar: env.cssVar || ((name: string) => win.getComputedStyle(doc.documentElement).getPropertyValue(name)),
    Dagre: env.Dagre || win.dagre,
    openWindow: env.openWindow || ((...a: Parameters<Window['open']>) => win.open(...a)),
    stylesText: env.stylesText || (doc.querySelector('style') ? doc.querySelector('style')!.textContent || '' : ''),
    faviconHref: env.faviconHref
      || (doc.querySelector('link[rel~="icon"]') ? doc.querySelector('link[rel~="icon"]')!.getAttribute('href') || '' : ''),
    showSaveFilePicker: env.showSaveFilePicker
      || (typeof win.showSaveFilePicker === 'function' ? win.showSaveFilePicker.bind(win) : null),
    showDirectoryPicker: env.showDirectoryPicker
      || (typeof win.showDirectoryPicker === 'function' ? win.showDirectoryPicker.bind(win) : null),
    isSecureContext: env.isSecureContext != null ? env.isSecureContext : !!win.isSecureContext,
    build: env.build || 'dev',
    matchMedia: env.matchMedia || (typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null),
    shell: null,
    canExport: () => !!app.showSaveFilePicker && app.isSecureContext,
    canExportScript: () => !!app.showDirectoryPicker && app.isSecureContext,
    prefs: prefs,
    saveJSON: saveJSON,
    saveStr: saveStr,
    workspace: workspaceRepo,
    sqlRoute: parseSqlRoute(loc.search),
    // #590 — signal-backed accessor pair (see app.types.ts's own doc
    // comment): the getter peeks (untracked, live), the setter delegates to
    // the coordinator's non-null commit op — this IS the notification, no
    // separate call needed.
    get currentWorkspace(): StoredWorkspaceV5 | null { return committedWorkspaceSignal.peek(); },
    set currentWorkspace(workspace: StoredWorkspaceV5) { commitCurrentWorkspace(workspace); },
    committedWorkspace: committedWorkspaceSignal as ReadonlySignal<StoredWorkspaceV5 | null>,
    workspaceRouteStatus: 'ready',
    keyboardOwner: null,
    resetShortcutChord: () => resetShortcutChord(app),
    acquireKeyboardOwner: (kind) => {
      const owner = { kind };
      keyboardOwners.push(owner);
      app.keyboardOwner = owner;
      resetShortcutChord(app);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const index = keyboardOwners.indexOf(owner);
        if (index >= 0) keyboardOwners.splice(index, 1);
        app.keyboardOwner = keyboardOwners.at(-1) ?? null;
        resetShortcutChord(app);
      };
    },
    shortcutDialog: null,
    closeShortcutDialog: () => {
      const dialog = app.shortcutDialog;
      app.shortcutDialog = null;
      dialog?.close();
    },
    surfaceCommands: null,
    // #590 — signal-backed accessor pair (see app.types.ts's own doc
    // comment): the getter peeks; the setter delegates to the coordinator's
    // navigation op. `treeNavigation` is the tracked structural-key
    // projection the Dashboard tree effect subscribes through.
    get mainSurface(): MainSurfaceState { return mainSurfaceSignal.peek(); },
    set mainSurface(surface: MainSurfaceState) { navigateMainSurface(surface); },
    treeNavigation: treeNavigationSignal,
    FileReader: (env.FileReader || win.FileReader) as typeof FileReader,
    downloadFile: downloadFile,
    // #588 phase 4 wave 5: genuinely missing before this wave -- masked by
    // the old `Partial<App>` + `as App` cast (file-menu.js reads/writes
    // `app.editingLibrary` directly, and a `boolean` field that's never
    // initialized here read as `undefined`, which is falsy and so behaved
    // like `false` at every existing read site -- but the field is NOT
    // optional on `App`, so the one-literal construction below made this an
    // explicit compile-time gap (`TS2739`) rather than a silent runtime one).
    editingLibrary: false,
    activeTab: () => activeTab(app.state),
    specValidators: specValidators,
    specCompletionSources: env.specCompletionSources || createSpecCompletionSources(),
    CodeViewer: env.CodeViewer || (() => ({
      setText() {}, setLanguage() {}, setWrap() {}, focus() {}, destroy() {},
    })),
    openDocEntry: (target) => {
      if (!app.requireAuthenticatedExecution()) return;
      openDocEntry(app, target);
    },
    closeDocPane: () => {
      if (!isDocPaneOpen(app)) return false;
      closeDocPane(app);
      return true;
    },
    openDocDisambiguation: (name) => {
      if (!app.requireAuthenticatedExecution()) return;
      openDocDisambiguation(app, name);
    },
    // Stage 5 (after the literal, below) overwrites both editor ports with
    // the real construction -- these are intentional placeholders so every
    // OTHER member of this literal can reference a fully-typed `EditorPort`/
    // `SpecEditorPort` shape immediately.
    sqlEditor: createNoopPort(),
    specEditor: createNoopSpecEditor(),
    queryDoc: queryDoc,
    restoreOAuthDocumentRecovery: (callbackState: string): OAuthDocumentRecoveryApplyResult => {
      // A fresh validated callback starts a new authority decision; a later
      // deferred retry deserves its own single safe notice.
      deferredRecoveryWarningShown = false;
      try {
        const restored = oauthDocumentRecovery.restore(callbackState, app.currentWorkspace);
        if (restored.kind === 'retry-deferred-retained') {
          return deferOAuthDocumentRecovery();
        }
        return finalizeOAuthDocumentRecovery(restored);
      } catch {
        // The session normally converts storage failures into explicit retained
        // outcomes. Keep this boundary defensive: an unexpected pre-publication
        // failure must not abort the signed-in shell or expose backend details.
        return deferOAuthDocumentRecovery();
      }
    },
    retryPendingOAuthDocumentRecovery: (): OAuthDocumentRecoveryApplyResult => {
      let pending: OAuthDocumentRecoveryRestoreResult;
      try {
        pending = oauthDocumentRecovery.retryPending(app.currentWorkspace);
      } catch {
        return deferOAuthDocumentRecovery();
      }
      if (pending.kind === 'retry-deferred-retained') {
        // Nothing was published: do not arm the dirty guard, revalidate, consume,
        // or replace the current workspace. The retained recovery nevertheless
        // owns callback precedence, so callers discard the legacy share handoff.
        return deferOAuthDocumentRecovery();
      }
      if (pending.kind === 'document-session-changed-retained') {
        flashToast(
          'Recovered drafts were kept because this document session changed.',
          {
            document: doc,
            action: {
              label: 'Restore drafts',
              onClick: () => {
                const forced = oauthDocumentRecovery.retryPending(
                  app.currentWorkspace,
                  { allowChangedDocumentSession: true },
                );
                finalizeOAuthDocumentRecovery(forced);
                app.renderCurrentSurface();
              },
            },
          },
        );
        return pending;
      }
      deferredRecoveryWarningShown = false;
      return finalizeOAuthDocumentRecovery(pending);
    },
    consumeLegacyShared: (allowRestore: boolean, consumedHandoff?: string | null): boolean => {
      let encoded: string | null;
      try {
        encoded = consumedHandoff === undefined
          ? ss.getItem('oauth_shared')
          : consumedHandoff;
      } catch {
        return false;
      }
      if (encoded === null) return false;
      // In-page Basic login owns the storage handoff here. Bootstrap passes its
      // already-consumed value so the same parser/application path is reused.
      if (consumedHandoff === undefined) {
        try {
          ss.removeItem('oauth_shared');
        } catch {
          // Handoff cleanup is best-effort. Recovery precedence still suppresses
          // the payload, and a storage backend failure must not abort rendering.
        }
      }
      // The handoff is one-shot regardless of whether recovery suppresses it,
      // its payload is malformed, or the current route has no Query surface.
      if (!allowRestore || app.sqlRoute.surface !== 'workspace') return false;

      let shared;
      try {
        const raw = JSON.parse(encoded) as Record<string, unknown>;
        // Pre-#166 OAuth handoffs stored `{sql, chart}` directly; the normal
        // upgrader preserves that compatibility while current v2 payloads pass
        // through with their authored Spec intact.
        shared = upgradeSavedQuery(raw.specVersion == null
          ? { name: 'Shared query', ...raw }
          : raw);
      } catch {
        return false;
      }
      const panel = queryPanel(shared);
      if (!shared.sql && !panel) return false;

      const tab = app.state.tabs.value[0];
      tab.sqlDraft = shared.sql;
      tab.name = queryName(shared);
      tab.specVersion = shared.specVersion;
      setTabSpecDraft(tab, cloneJson(shared.spec));
      const launchView = queryView(shared);
      const normalized = launchView === 'chart' ? 'panel' : launchView;
      if (SAVED_VIEWS.has(normalized ?? '')) {
        app.state.resultView.value = normalized as App['state']['resultView']['value'];
      } else if (!shared.sql && isQuerylessPanel(panel)) {
        app.state.resultView.value = 'panel';
      }
      // #588 phase 4 wave 4: the cached route-search string moved into `app.nav`
      // — this reads the LIVE value through its `currentRouteSearch()` escape
      // hatch (see surface-navigation.ts's header comment) rather than a
      // module-local `routeSearch` this file no longer keeps.
      win.history.replaceState(null, '', loc.pathname + app.nav.currentRouteSearch());
      return true;
    },
    saved: saved,
    conn: conn,
    executionScope: () => activeExecutionScope,
    resumeAuthenticatedExecution: () => {
      const epoch = conn.connection.value.epoch;
      if (activeExecutionScope?.epoch === epoch && activeExecutionScope.isOpen()) {
        hideAuthenticationRequired();
        return;
      }
      activeExecutionScope?.close();
      const scope = createAuthenticatedExecutionScope({
        epoch,
        cancelRemote: (lease, queryId) => ch.killQueryWithLease(lease, queryId, sqlString),
      });
      activeExecutionScope = scope;
      // Connection-scoped caches/panes are owners even when they have no live
      // server query id. Their own invalidation/generation guards make late
      // completion inert; query-bearing owners register their current ids.
      scope.register({ name: 'schema catalog', abort: () => catalog.invalidate() });
      scope.register({ name: 'schema graph', abort: () => graph.suspend() });
      // #586: whatever currently occupies the shared docked inspector (Cell,
      // Rows, or Reference) — not just Reference — must not survive a
      // connection-scope abort; `closeInspector` closes the current occupant
      // generically, calling its own SurfaceLifecycle teardown.
      scope.register({ name: 'docked inspector', abort: () => closeInspector(app) });
      hideAuthenticationRequired();
    },
    requireAuthenticatedExecution: () => {
      let scope = activeExecutionScope;
      // Production bootstrap establishes the first scope explicitly, but
      // controller entry points are also valid before a surface is mounted
      // (and tests exercise that contract). An already-authenticated session can
      // therefore materialize its scope lazily; an auth-required session cannot.
      if (!scope && conn.isSignedIn()) {
        app.resumeAuthenticatedExecution();
        scope = activeExecutionScope;
      }
      if (scope?.isOpen()) return scope;
      revealAuthenticationRequired(conn.connection.value.detail);
      return null;
    },
    signOut: () => {
      app.closeShortcutDialog();
      resetShortcutChord(app);
      const closing = activeExecutionScope;
      activeExecutionScope = null;
      closing?.close(conn.captureCancellationLease());
      workbench.destroy();
      // Plain abort (no clearResult settle) — the login render replaces the
      // whole DOM next, so settling the visible result would be a wasted paint.
      graph.cancel();
      exportService.cancelExport();
      exportService.cancelExportScript();
      catalog.invalidate();
      // #313/#586: docked inspector content (Cell, Rows, or Reference — not
      // just Reference) must never survive a connection change — closed
      // alongside the catalog reset, before the login screen renders.
      closeInspector(app);
      conn.signOut();
      // #425: explicit logout owns Dashboard teardown, the surface-generation
      // bump, and the main-surface reset through the full-screen login renderer.
      retireToLogin();
    },
    showLogin: (msg) => retireToLogin(msg),
    catalog: catalog,
    updateBanner: updateBanner,
    wallNow: wallNow,
    exec: exec,
    now: now,
    tickElapsed: tickElapsed,
    params: params,
    saveVarRecent: () => params.saveVarRecent(),
    exports: exportService,
    workbench: workbench,
    elapsedMs: () => workbench.elapsedMs(),
    setRunBtn: (running, gate) => variableStrip.setRunBtn(running, gate),
    renderVarStrip: () => variableStrip.renderVarStrip(),
    setExportBtn: setExportBtn,
    setFmtBtn: setFmtBtn,
    graph: graph,
    recordHistory: (tab, sqlText) => {
      saved.recordHistory(tab, sqlText);
      app.shell?.sidePanels.notifyRunComplete();
    },
    specBlocked: specBlocked,
    updateSaveBtn: saveController.updateSaveBtn,
    activateInvalidSpecDraft: (tab) => {
      if (!tab) return;
      batch(() => { app.state.activeTabId.value = tab.id; });
      tab.editorMode = 'spec';
      app.updateEditorModeUi!();
      app.specEditor.focus();
      flashToast('Fix Spec JSON first', { document: doc });
    },
    openUserMenu: openUserMenu,
    toggleTheme: toggleTheme,
    renderDashboard: () => {
      if (conn.isSignedIn() && !activeExecutionScope) app.resumeAuthenticatedExecution();
      beginSurfaceTransition();
      const mounted = ensureShell();
      // Exposed BEFORE rendering: the grafana-grid engine measures its host's real
      // width immediately after mount, and a hidden host measures 0 — which
      // silently pins every Dashboard to the widest 12-column breakpoint. happy-dom
      // always reports 0, so only a real browser can catch a regression here.
      mounted.showHost('dashboard');
      return renderDashboard(app, dashboardRenderTarget(mounted));
    },
    applyCommittedWorkspace: applyCommittedWorkspace,
    genId: () => uid('ws-'),
    workspaceSession: session,
    onWorkspaceExternallyChanged: ignoreExternalWorkspaceChange,
    onExternalWorkspaceChange: () => session.scheduleRefresh(),
    mutateWorkspace: session.mutateWorkspace,
    syncBeforeUnload: () => session.syncBeforeUnload(),
    nav: nav,
    navigateSqlRoute: nav.navigateSqlRoute,
    renderCurrentSurface: nav.renderCurrentSurface,
    loadWorkspaceOnBoot: nav.loadWorkspaceOnBoot,
    openDashboard: nav.openDashboard,
    showQuerySurface: nav.showQuerySurface,
    showDashboardSurface: nav.showDashboardSurface,
    openSavedQuery: nav.openSavedQuery,
    openPanelQuery: nav.openPanelQuery,
    openVariableTab: nav.openVariableTab,
    captureSurfaceGeneration: nav.captureSurfaceGeneration,
    isSurfaceGenerationCurrent: nav.isSurfaceGenerationCurrent,
    refreshCurrentSurfaceAfterStale: nav.refreshCurrentSurfaceAfterStale,
    actions: {
      run: (opts) => withAuthenticatedExecution(() => workbench.runEntry(opts)),
      cancel: () => workbench.cancel(),
      newTab: () => newTab(app),
      selectTab: (id) => selectTab(app, id),
      closeTab: (id) => closeTab(app, id),
      // #425: opening a query is a Query-mode act, so every EXISTING opening path
      // (the Library list, History, the schema tree's double-click) switches the
      // main surface back before loading — otherwise the new tab would land behind
      // a visible Dashboard. A no-op when the Query surface is already active.
      loadIntoNewTab: (queryOrName, sql) => {
        app.showQuerySurface();
        loadIntoNewTab(app, queryOrName, sql);
        toEditorOnMobile();
      },
      login: (idpId, targetOrigin) => conn.beginOAuth(idpId, targetOrigin),
      // Basic-auth login renders in-page (no page reload), so — unlike the OAuth
      // path, where `main.ts`'s `bootstrap` awaits it — this is the only place
      // workspace resolution runs for a username/password session. Without it,
      // basic auth would keep rendering the placeholder workspace instead of the
      // requested or last-used persisted workspace.
      connect: async (input) => {
        const resumeMountedDocument = shell !== null && activeExecutionScope === null;
        await conn.connectBasic(input);
        app.resumeAuthenticatedExecution();
        if (resumeMountedDocument) {
          // Preserve the exact mounted document/editor/result objects. Only
          // connection-scoped metadata and execution owners are refreshed.
          await Promise.allSettled([catalog.loadSchema(), catalog.loadReference()]);
          void catalog.loadVersion();
          return;
        }
        const workspace = await app.loadWorkspaceOnBoot();
        const pendingRecovery = workspace
          ? app.retryPendingOAuthDocumentRecovery()
          : null;
        app.consumeLegacyShared(
          !recoveryOwnsLegacyShare(pendingRecovery),
        );
        app.renderCurrentSurface();
        void app.catalog.loadVersion();
      },
      share,
      copyResult,
      // `ActionsRegistry.copySnapshot`'s public `result: Json | null` is looser
      // than the real always-`QueryResult`-shaped value every caller (results.ts's
      // Copy button, the detached Data view) actually passes — `Json`'s index
      // signature can't guarantee `QueryResult`'s required fields, so a wrapper
      // (not the function reference directly) bridges the two: `| null` on both
      // sides of the cast keeps it a single legal step (same pattern as
      // `recordHistory`'s above).
      copySnapshot: (result, targetDoc) => copySnapshot(result as QueryResult | null, targetDoc),
      exportEntry: () => withAuthenticatedExecution(exportEntry),
      exportDirect: (sqlInput, waveMs) =>
        withAuthenticatedExecution(() => exportDirect(sqlInput, waveMs)) ?? Promise.resolve(),
      cancelExport,
      cancelExportScript,
      save: saveController.saveActiveQuery,
      openUserMenu,
      formatQuery: () => withAuthenticatedExecution(formatQuery) ?? Promise.resolve(),
      formatSpec,
      setEditorMode,
      explainQuery: () => withAuthenticatedExecution(explainQuery),
      setExplainView: (id) => withAuthenticatedExecution(() => setExplainView(id)),
      setResultRowLimit,
      showSchemaGraph: (focus) =>
        withAuthenticatedExecution(() => showSchemaGraph(focus)) ?? Promise.resolve(),
      cancelSchemaGraph,
      expandSchemaGraph: (focus) =>
        withAuthenticatedExecution(() => expandSchemaGraph(focus)) ?? Promise.resolve(),
      openNodeDetail: (node, targetDoc) =>
        withAuthenticatedExecution(() => openNodeDetail(node, targetDoc)) ?? Promise.resolve(),
      insertCreate: async (target) => {
        if (!app.requireAuthenticatedExecution()) return;
        await insertCreate(target);
        toEditorOnMobile();
      },
      openCreateInNewTab: (target, name) =>
        withAuthenticatedExecution(() => openCreateInNewTab(target, name)) ?? Promise.resolve(),
      openShortcuts: () => {
        const dialog = openShortcuts(app, () => { app.shortcutDialog = null; });
        if (dialog) app.shortcutDialog = dialog;
      },
      // Editor-mutating actions jump the mobile bottom-nav to the Editor panel
      // (#126) so a schema tap / SHOW CREATE lands where the user can see it.
      insertAtCursor: (text) => { app.sqlEditor.insertAtCursor(text); toEditorOnMobile(); },
      replaceEditor: (text) => { app.sqlEditor.replaceDocument(text); toEditorOnMobile(); },
      loadColumns: (db, table) =>
        withAuthenticatedExecution(() => loadColumns(db, table)) ?? Promise.resolve(),
      // #466/#501-review: `renderTabs` alone repaints the strip; an in-place
      // `dirtySql`/`dirtySpec` mutation never touches the `tabs` SIGNAL itself
      // (no new array), so this is also the one place that re-syncs the
      // `beforeunload` guard for that case — the tab-list reactive effect
      // (workbench-shell.ts) covers the signal-driven case (new/closed/switched
      // tabs) on its own.
      rerenderTabs: () => { renderTabs(app); app.syncBeforeUnload(); },
      rerenderResults: () => renderResults(app),
      updateSaveBtn: () => app.updateSaveBtn(),
    },
    renderApp: () => {
      if (conn.isSignedIn() && !activeExecutionScope) app.resumeAuthenticatedExecution();
      beginSurfaceTransition();
      // The Dashboard's own route-scoped resources go; the query column does NOT
      // (it is mounted once and preserved — see `ensureShell`).
      disposeDashboardSurface();
      app.onWorkspaceExternallyChanged = ignoreExternalWorkspaceChange;
      const mounted = ensureShell();
      mounted.setHeader(buildAppHeader(app));
      mounted.showHost('query');
      // Repaint the results pane on every return to this surface. A query that
      // finished while the Dashboard was visible built its Chart.js canvas in a
      // zero-size host, and chart-render only auto-resizes a laid-out one — so
      // without this the chart comes back blank. Cheap and idempotent otherwise.
      renderResults(app);
    },
  };
  // Stage 5 -- late wiring: every statement below OVERWRITES a member the
  // literal above already declared (or registers a listener); none of them
  // is a first assignment. `app` is fully built by this point, so `Editor`/
  // `SpecEditor` (real CodeMirror adapters in production) receive a
  // completely-wired controller instead of the partially-built object they
  // used to see mid-construction.
  app.sqlEditor = Editor(app);
  app.specEditor = SpecEditor(app);
  app.sqlEditor.onDocChange((value) => {
    const tab = app.activeTab();
    tab.sqlDraft = value;
    tab.dirtySql = true;
    // #447: no re-evaluation of the Spec on a SQL keystroke any more. The ONLY
    // validator whose diagnostics depended on the SQL text was the Filter role's
    // (its source SQL had to be a single row-returning statement), and that role
    // no longer exists — every surviving rule reads the Spec alone, so
    // re-running the whole validator graph per keystroke is pure waste.
    if (app.actions) app.actions.rerenderTabs();
    if (app.updateSaveBtn) app.updateSaveBtn();
    if (app.renderVarStrip) app.renderVarStrip();
  });
  // No flat `App` delegates for `evaluateSpecDraft`/`revalidateSpecDrafts`/
  // `revealFirstSpecError`/`registerSpecValidator` (#276 Phase 5 deleted
  // them) — every consumer (including this file's own call sites further
  // down) reads `queryDoc.*` directly.
  app.specEditor.onDocChange((value) => {
    queryDoc.evaluateSpecDraft(app.activeTab(), value);
  });
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('popstate', () => { void app.nav.handleSqlPopState(); });
  }
  return app;
}

/** `renderApp`'s second argument — the one closure it can't rebuild itself
 *  (defined inside `createApp`, over that same `app`). The former `toggleTheme`
 *  member went with the header: `buildAppHeader` wires the theme button to
 *  `app.toggleTheme` off the live object, so threading it through here was
 *  already dead by the time the shell split moved the header build out. */
export interface RenderAppHelpers {
  startDrag: typeof startDrag;
}


/** Mount the QUERY surface's column into the persistent shell's `queryHost` —
 *  a thin composition call onto `ui/workbench/workbench-shell.ts`'s
 *  `mountWorkbenchShell` (#276 Phase 5, narrowed by #425's shell split): every
 *  line it runs is still the same byte-identical code, driven by a narrow
 *  `WorkbenchShellDeps` bag instead of the full `App` — see that module's header
 *  comment for what stays coupled to `app` and why.
 *
 *  The persistent frame itself (header slot, sidebar, mobile nav) is mounted by
 *  `createApp`'s own `ensureShell`, once per signed-in workspace, and this column
 *  is mounted into it exactly once too: #425 preserves the Query surface across a
 *  Dashboard round trip rather than reconstructing it. */
export function renderApp(
  app: App, helpers: RenderAppHelpers, queryHost: HTMLElement,
): () => void {
  return mountWorkbenchShell({
    app,
    document: app.document,
    state: app.state,
    actions: app.actions,
    sqlEditor: app.sqlEditor,
    specEditor: app.specEditor,
    workbench: app.workbench,
    queryDoc: app.queryDoc,
    prefs: app.prefs,
    queryHost,
    activeTab: app.activeTab,
    updateSaveBtn: app.updateSaveBtn,
    specBlocked: app.specBlocked,
    renderVarStrip: app.renderVarStrip,
    setRunBtn: app.setRunBtn,
    setExportBtn: app.setExportBtn,
    startDrag: helpers.startDrag,
  });
}
