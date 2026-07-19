// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h, fixedAnchor } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab,
  savedForTab, tabPanel,
  normalizeRowLimit,
} from '../state.js';
import type { QueryTab, AppState, SpecValidationService } from '../state.js';
import type { SavedQueryV2, StoredWorkspaceV1 } from '../generated/json-schema.types.js';
import { splitStatements } from '../core/sql-split.js';
import { analysisView, fieldControls, fieldControlKind } from '../core/param-pipeline.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { sqlString, inferQueryName, shortVersion, withStatementBreak, formatBytes } from '../core/format.js';
import { toTSV } from '../core/export.js';
import { newResult, parseErrorPos } from '../core/stream.js';
import { effectiveDashboardRole } from '../core/result-choice.js';
import {
  CORE_SPEC_VALIDATORS, createSpecValidatorRegistry, formatSpecText,
  hasBlockingSpecErrors,
} from '../core/spec-draft.js';
import type { SpecValidatorEntry, QuerySpecValidationService } from '../core/spec-draft.js';
import type { SpecDiagnostic } from '../editor/spec-editor.types.js';
import { isQuerylessPanel } from '../core/panel-cfg.js';
import * as ch from '../net/ch-client.js';
import { createNoopPort } from '../editor/editor-port.js';
import type { EditorPort } from '../editor/editor-port.types.js';
import { createNoopSpecEditor } from '../editor/spec-editor.js';
import { createSpecCompletionSources } from '../editor/spec-completion-adapter.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from './tabs.js';
import type { QueryOrName } from './tabs.js';
import { batch } from '@preact/signals-core';
import { renderResults } from './results.js';
import type { Result, QueryResult, ScriptResult, ScriptEntry } from './results.js';
import { renderDashboard } from './dashboard.js';
import { toggleThemeDom } from './theme-toggle.js';
import { openSchemaView } from './explain-graph.js';
import type { SchemaLineageNode, DetachedGraphApp } from './explain-graph.js';
import { openDetailPane } from './schema-detail.js';
import type { NodeDetail, DetailNode } from './schema-detail.js';
import { renderSavedHistory } from './saved-history.js';
import { applyFieldState } from './var-field.js';
import { buildRelativeTimeField } from './relative-time-field.js';
import type { RelativeTimeField } from './relative-time-field.js';
import { buildRecentField } from './recent-field.js';
import type { RecentField } from './recent-field.js';
import { buildEnumField } from './enum-field.js';
import type { EnumField } from './enum-field.js';
import { wireComboInput } from './combobox.js';
import type { ComboField } from './combobox.js';
import { recentOptions } from '../core/recent-values.js';
import { paramComparisonColumns } from '../core/param-comparison.js';
import type { SchemaDb } from '../core/from-scope.js';
import { renderLogin } from './login.js';
import { openShortcuts } from './shortcuts.js';
import { startDrag } from './splitters.js';
import { flashToast } from './toast.js';
import type { App, ActionsRegistry, SchemaFocus } from './app.types.js';
import type { CreateAppEnv } from '../env.types.js';
import { createQueryExecutionService } from '../application/query-execution-service.js';
import { createConnectionSession } from '../application/connection-session.js';
import { createSchemaCatalogService } from '../application/schema-catalog-service.js';
import { createWorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import { createChSessionParams } from '../application/ch-session-params.js';
import { createExportService } from '../application/export-service.js';
import type { ExportSink, FileHandleLike, DirectoryHandleLike } from '../application/export-service.js';
import { createSchemaGraphSession, SchemaGraphAuthRequiredError } from '../application/schema-graph-session.js';
import { createAppPreferences } from '../application/app-preferences.js';
import { createWorkspaceRepository } from '../workspace/workspace-repository.js';
import { createIndexedDbWorkspaceStore } from '../workspace/indexeddb-workspace-store.js';
import { createIndexedDbHandoffStore } from '../workspace/indexeddb-handoff-store.js';
import { createIndexedDbDetachedViewsStore } from '../workspace/indexeddb-detached-views-store.js';
import { migrateLegacyWorkspaceIfNeeded } from '../workspace/legacy-migration.js';
import { isDashboardRoute } from '../core/dashboard.js';
import { parseDashboardOpenSource, buildDashboardSearch } from '../dashboard/application/dashboard-open-source.js';
import { buildViewHandoffRecord, materializeDetachedWorkspace } from '../dashboard/application/session-bundle.js';
import { randomHandoffToken } from '../core/handoff-token.js';
import { exportDashboardAction, triggerImportDashboard } from './file-menu.js';
import { createWorkbenchSession } from './workbench/workbench-session.js';
import { createQueryDocumentSession } from '../application/query-document-session.js';
import { createSavedQueryService } from '../application/saved-query-service.js';
import { mountWorkbenchShell } from './workbench/workbench-shell.js';

/** Optional globals a plain browser page (or the CM6/Chart/dagre UMD bundles a
 *  `<script>` tag might attach) can carry that aren't in the standard `Window`
 *  type — none of `main.js`'s real production wiring relies on these; it always
 *  supplies `Chart`/`Dagre` (imported packages) via `env` directly. These are
 *  only the env-absent fallback reads below (`win.Chart`, `win.dagre`, …), kept
 *  narrow and all-optional so a plain `Window` still satisfies this widened type. */
/** The var-strip's combobox-based field controller — whichever of
 *  `buildEnumField`/`buildRelativeTimeField`/`buildRecentField` `ctl.kind`
 *  picks. Only `RelativeTimeField` actually declares `previewEl` (the #169
 *  live date preview `applyFieldState` points `aria-describedby` at); the
 *  intersection makes reading it a safe optional no-op for the other two
 *  control kinds, which never populate it. */
type VarStripCombo = (EnumField | RecentField | RelativeTimeField) & { previewEl?: HTMLElement };

interface WindowExtras {
  Chart?: unknown;
  dagre?: unknown;
  showSaveFilePicker?: (opts?: unknown) => Promise<unknown>;
  showDirectoryPicker?: (opts?: unknown) => Promise<unknown>;
  webkitURL?: typeof URL;
  FileReader?: typeof FileReader;
  URL?: typeof URL;
  Blob?: typeof Blob;
}

/** `app.specValidators`'s full internal shape: the canonical schema +
 *  registered-rules service (core/spec-draft.js's `QuerySpecValidationService`
 *  — assignable to the narrower public `SpecValidationService` read-surface,
 *  app.types.ts, without a cast, same as state.ts's own
 *  `defaultSpecValidationService`). `.register` is app.ts-internal wiring (the
 *  `registerSpecValidator` action) that other modules never call directly. */
type AppSpecValidators = QuerySpecValidationService;

/** #288 Phase 6 — how long a one-time view-mode handoff token stays consumable
 *  (ADR-0003). Long enough to survive a cold viewer tab's OAuth round-trip,
 *  short enough to bound exposure; the real guarantee is delete-on-consume, not
 *  the TTL. 5 minutes. */
const VIEW_HANDOFF_TTL_MS = 5 * 60_000;

export function createApp(env: CreateAppEnv = {}): App {
  const doc = env.document || document;
  const win = (env.window || window) as Window & WindowExtras;
  const loc = env.location || win.location;
  const fetchFn = env.fetch || win.fetch.bind(win);
  const cryptoObj = env.crypto || win.crypto;
  const ss = env.sessionStorage || win.sessionStorage;

  // Built up as a `Partial<App>` first (every field below has a real,
  // App-typed value already — `Partial` just lets this literal typecheck
  // without every OTHER `App` member also being present yet), then widened to
  // `App` in one step: every member this function doesn't assign inline below
  // is attached via a later `app.foo = …` statement (the closures those
  // values need aren't defined until further down this function), exactly
  // like tests/unit/dashboard.test.ts's own `asApp` helper reinterprets a real
  // `createApp(env)` object as `App` without copying it.
  const appBase: Partial<App> = {
    state: createState(),
    dom: {},
    root: env.root || doc.getElementById('root'),
    document: doc,
    // Charting seam: the Chart.js constructor (injected so tests stub it) and a
    // CSS-custom-property reader (canvas needs real colors, not `var(--x)`).
    Chart: env.Chart || win.Chart,
    cssVar: env.cssVar || ((name: string) => win.getComputedStyle(doc.documentElement).getPropertyValue(name)),
    // Pipeline-graph layout seam: dagre (injected like Chart). The DOT parser and
    // SVG drawer are ours; dagre only computes node positions + edge bend points.
    Dagre: env.Dagre || win.dagre,
    // The schema graph opens in a real browser tab driven by this window. All
    // three are injected seams: openWindow so tests can stub window.open,
    // stylesText/faviconHref so the child tab can inline the page's CSS and
    // favicon (about:blank ships neither).
    openWindow: env.openWindow || ((...a: Parameters<Window['open']>) => win.open(...a)),
    stylesText: env.stylesText || (doc.querySelector('style') ? doc.querySelector('style')!.textContent || '' : ''),
    faviconHref: env.faviconHref
      || (doc.querySelector('link[rel~="icon"]') ? doc.querySelector('link[rel~="icon"]')!.getAttribute('href') || '' : ''),
    // Streaming Export (issue #87) needs the File System Access API and a
    // secure context; both are injected seams (like openWindow) so tests can
    // stub them without a real browser. Fixed for the session (browser +
    // origin don't change), so this is computed once rather than as a signal.
    showSaveFilePicker: env.showSaveFilePicker
      || (typeof win.showSaveFilePicker === 'function' ? win.showSaveFilePicker.bind(win) : null),
    // Script export (issue #99) needs a whole directory, not one file — same
    // File System Access family as showSaveFilePicker (every browser that has
    // one has the other), so this is the same seam pattern.
    showDirectoryPicker: env.showDirectoryPicker
      || (typeof win.showDirectoryPicker === 'function' ? win.showDirectoryPicker.bind(win) : null),
    isSecureContext: env.isSecureContext != null ? env.isSecureContext : !!win.isSecureContext,
    // Build stamp ("v0.1.4 (abc1234)") injected at build time via main.js; shown
    // in the user menu so a bug report can be tied to a build. 'dev' in tests /
    // an un-built run where the placeholder was never replaced.
    build: env.build || 'dev',
    // Mobile-breakpoint seam (#126): matchMedia, injected so tests can drive the
    // breakpoint. renderApp uses it to seed + track `state.isMobile` against
    // MOBILE_BREAKPOINT_PX. null when the platform has no matchMedia (treated as
    // always-desktop — the mobile CSS still applies, just no JS branching).
    matchMedia: env.matchMedia || (typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null),
  };
  const app = appBase as App;
  // Chromium (+ a secure context) only — Firefox/Safari and plain-HTTP have no
  // File System Access API. The Export button feature-detects this at build
  // time and renders aria-disabled + a tooltip rather than hiding outright.
  app.canExport = () => !!app.showSaveFilePicker && app.isSecureContext;
  // The script-export path additionally needs a directory picker (defensive —
  // the button's own enabled/tooltip state stays gated on canExport, since every
  // browser with showSaveFilePicker also has showDirectoryPicker).
  app.canExportScript = () => !!app.showDirectoryPicker && app.isSecureContext;

  // --- persistence -------------------------------------------------------
  // The true-preference persist service (#276 Phase 4D) — theme/sidebarPx/
  // editorPct/sideSplitPct/cellDrawerPx/sidePanel/resultRowLimit/dashLayout/
  // dashCols, constructible without App/AppState/DOM. Consumers
  // (dashboard.ts/saved-history.ts/splitters.ts) call `app.prefs.save(name,
  // value)` directly (#276 Phase 5 deleted the flat `App.savePref` delegate);
  // `toggleTheme` below composes `prefs.toggleTheme()` (the state-flip +
  // persist) with its own DOM half.
  const prefs = createAppPreferences({ saveStr, state: app.state });
  app.prefs = prefs;
  app.saveJSON = saveJSON;
  app.saveStr = saveStr;
  // Atomic StoredWorkspaceV1 persistence (#280 Phase 2 / #284): the injected
  // IndexedDB factory seam (mirrors crypto/sessionStorage) backs a single-record
  // WorkspaceStore, behind which the pure WorkspaceRepository does validate-then-
  // atomically-replace commits. Constructed lazily — no database is opened until
  // a workspace operation runs — so this never touches IndexedDB during
  // bootstrap. The favorites-driven Dashboard render still reads legacy keys in
  // this phase; wiring reads onto the aggregate is Phases 3-6 of #280.
  const workspaceStore = createIndexedDbWorkspaceStore(env.indexedDB || win.indexedDB);
  app.workspace = createWorkspaceRepository({ store: workspaceStore });
  // #288 Phase 6 — Dashboard viewing. Two dedicated IndexedDB stores (own
  // databases, same injected factory + lazy-open pattern as the workspace
  // store): `handoff` is the one-time cross-tab token transport that carries a
  // view-mode Dashboard snapshot to a new tab; `detachedViews` is the
  // persistent store that the consumed handoff materializes into (a read-only
  // copy under its own fresh workspace id, detached from the editable primary
  // workspace — see ADR-0003). `dashboardOpenSource` is THIS tab's parsed
  // /dashboard route: `?ws=&dash=` (edit, current-workspace) or `?st=&dash=`
  // (a one-time view handoff), or null on a bare/legacy `/dashboard` open.
  app.handoff = createIndexedDbHandoffStore(env.indexedDB || win.indexedDB);
  app.detachedViews = createIndexedDbDetachedViewsStore(env.indexedDB || win.indexedDB);
  app.dashboardOpenSource = parseDashboardOpenSource(loc.search);
  // Static per-tab flag: is THIS tab the standalone `/dashboard` route (vs the
  // Workbench)? Lets shared post-commit logic (`afterLibraryChange`) repaint the
  // right surface — a Dashboard-page import re-renders the dashboard, not the
  // absent Workbench chrome.
  app.dashboardRoute = isDashboardRoute(loc.pathname);
  // The `{name:Type}` var-value/filter-active/recent-value persistence
  // wrappers (saveVarValues/saveFilterActive/saveVarRecent/
  // saveVarRecentDisabled) + the recent-value policy that sits on top of them
  // (recordBoundParams/clearVarRecent/clearAllVarRecent) now live in the
  // WorkbenchParameterSession (#276 Phase 4B1) — see the `const params = …`
  // block below. No flat `App` delegates for these (#276 Phase 5 deleted
  // them) except `app.saveVarRecent`, the one deliberate survivor (see its
  // own doc comment below).
  app.FileReader = (env.FileReader || win.FileReader) as typeof FileReader;
  // Exposed seam for the header File menu (file-menu.js): the file-download
  // helper (defined below). The library title (name + dirty dot) repaints via a
  // libraryName/libraryDirty effect, so callers just mutate those signals.
  app.downloadFile = downloadFile;

  // --- identity ------------------------------------------------------------
  // Identity/auth reads (host/email/isSignedIn/…) live on `app.conn` itself
  // (assigned below, once `conn` is constructed) — no flat `App` delegate.
  app.activeTab = () => activeTab(app.state);

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
  app.specValidators = specValidators;
  app.specCompletionSources = env.specCompletionSources || createSpecCompletionSources();
  app.CodeViewer = env.CodeViewer || (() => ({
    setText() {}, setLanguage() {}, setWrap() {}, focus() {}, destroy() {},
  }));
  app.sqlEditor = Editor(app);
  app.specEditor = SpecEditor(app);
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
    state: app.state,
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
  app.queryDoc = queryDoc;
  // The saved-query create/commit policy, history recording, and share-URL
  // building (#276 Phase 4C) now live in `application/saved-query-service.ts`,
  // constructible without App/AppState/DOM — this shell sequences Spec
  // evaluation (via `queryDoc` above) THEN calls this service; the two never
  // call each other (see that module's header comment). `now: () =>
  // Date.now()` is a genuine wall-clock read (NOT `app.now`/`app.wallNow` —
  // unrelated clocks), matching `createSavedQuery`'s own pre-extraction
  // inline `Date.now()` call exactly.
  const saved = createSavedQueryService({
    state: app.state,
    saveJSON,
    now: () => Date.now(),
    specValidators,
    workspace: app.workspace,
  });
  app.saved = saved;
  app.sqlEditor.onDocChange((value) => {
    const tab = app.activeTab();
    tab.sqlDraft = value;
    tab.dirtySql = true;
    // Only a Filter-role Spec's diagnostics depend on the SQL text (the Filter
    // source SQL must be a single row-returning statement, no params/FORMAT —
    // filter-execution.js). For every other tab the Spec is independent of the
    // SQL, so re-evaluating the whole validator graph on each keystroke is
    // wasted work — gate it to filter tabs.
    if (effectiveDashboardRole(tab.specParsed) === 'filter') {
      queryDoc.applySpecEvaluation(tab, tab.specText, { dirty: tab.dirtySpec });
      app.specEditor.setDiagnostics(tab.specDiagnostics);
    }
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
  // login.ts's `LoginApp.root` is narrowed to a non-null `Element` (vs.
  // `App.root`'s `Element | null`) — deliberate there (that module always
  // writes through it unconditionally); every real renderLogin() call below
  // fires only once the app has mounted into a real `#root`, so this is a
  // structural-only reinterpretation, not a new runtime assumption (a null
  // root would already throw inside login.ts's own `app.root.replaceChildren`
  // either way).
  const renderLoginApp = (msg?: string): void => renderLogin(app as App & { root: Element }, msg);
  // The auth + config + ClickHouse connection lifecycle (#276 Phase 2) — OAuth
  // PKCE login/refresh, Basic probing, IdP config resolution, and cross-tab
  // auth handoff all now live in `application/connection-session.ts`,
  // constructible without App/AppState/DOM; this module wires it to the real
  // browser env and to `renderLoginApp` (the one piece that IS this shell's
  // job — the session only ever calls `onAuthLost`, never renders). The two
  // handoff windows (how long the child waits for a grant vs. how long the
  // opener keeps listening) are env-injectable seams whose defaults are
  // documented in full on `ConnectionSessionDeps` itself.
  const conn = createConnectionSession({
    fetch: fetchFn, storage: ss, location: loc, crypto: cryptoObj, win,
    queryJson: ch.queryJson,
    handoffMs: env.handoffMs != null ? env.handoffMs : 4000,
    handoffListenMs: env.handoffListenMs != null ? env.handoffListenMs : 30000,
    onAuthLost: (detail) => renderLoginApp(detail),
  });
  app.conn = conn;
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
  app.signOut = () => {
    workbench.destroy();
    // Plain abort (no clearResult settle) — the login render replaces the
    // whole DOM next, so settling the visible result would be a wasted paint.
    graph.cancel();
    exportService.cancelExport();
    exportService.cancelExportScript();
    catalog.invalidate();
    conn.signOut();
    renderLoginApp();
  };
  app.showLogin = (msg) => renderLoginApp(msg);

  // --- data loaders --------------------------------------------------------
  // The server-metadata/reference lifecycle (#276 Phase 4A) — server-version
  // probe, schema-tree load, lazy per-table column load, editor reference
  // data + completions, hover-doc cache — now lives in
  // `application/schema-catalog-service.ts`, constructible without
  // App/AppState/DOM (see that file for the ported bodies, byte-identical to
  // this file's history). `setConn`/`updateBanner` (DOM) and the schema/
  // banner effects stay HERE, driven by the same `state.serverVersion`/
  // `state.schemaError` the service writes — those signals/effects are
  // exactly as before.
  function setConn(online: boolean): void {
    if (!app.dom.connStatus) return;
    app.dom.connStatus.classList.toggle('dim', !online);
    const full = app.state.serverVersion;
    // Show a short version (e.g. 26.3.10); full string on hover so the header
    // doesn't crowd/overflow on a narrow window.
    app.dom.connStatus.title = online ? 'ClickHouse ' + full : '';
    app.dom.connStatus.replaceChildren(h('span', { class: 'ver' },
      online ? 'ClickHouse ' + shortVersion(full) : 'offline'));
  }
  const catalog = createSchemaCatalogService({
    loadServerVersion: ch.loadServerVersion,
    loadSchema: ch.loadSchema,
    loadColumns: ch.loadColumns,
    loadReferenceData: ch.loadReferenceData,
    loadEntityDoc: ch.loadEntityDoc,
    loadFunctionsDocColumns: ch.loadFunctionsDocColumns,
    loadFunctionDocRow: ch.loadFunctionDocRow,
    ctx: () => chCtx,
    ensureConfig,
    sqlString,
    state: app.state,
    hooks: {
      onConnStatusChanged: setConn,
      renderVarStrip: () => app.renderVarStrip(),
      refreshEditorReference: () => app.sqlEditor.refreshReference(),
    },
  });
  app.catalog = catalog;
  // `loadVersion`/`loadSchema`/`loadReference`/`rebuildCompletions`/
  // `entityDoc`/`refData`/`completions`/`docCache` all live on `catalog`
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
  app.updateBanner = updateBanner;
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
  const wallNow = (): number => (env.wallNow || (() => Date.now()))();
  app.wallNow = wallNow;
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
  app.exec = exec;
  // Exposed so results.js can compute a script-export row's live elapsed time
  // (now() - e.startedAt) with the same injected clock as exportScript itself.
  app.now = now;
  // Update only the live elapsed-ms readout (no table re-render). Driven by an
  // interval while running so it ticks even for queries that emit no rows (sleep).
  function tickElapsed(): void {
    if (app.dom.runElapsedEl) app.dom.runElapsedEl.textContent = app.elapsedMs().toFixed(0) + ' ms';
  }
  app.tickElapsed = tickElapsed;

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
  // view, below) and the workbench-session hooks + export block (further
  // down) call its methods directly; `app.params.hardenedVars` reads this
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
  app.params = params;
  // The single deliberate delegate survivor (#276 Phase 5 — see its own doc
  // comment on app.types.ts's `App.saveVarRecent`): every other params-group
  // member (`saveVarValues`/`saveFilterActive`/`saveVarRecentDisabled`/
  // `recordBoundParams`/`clearVarRecent`/`clearAllVarRecent`/`hardenedVars`)
  // has no flat `App` delegate — every consumer reads `app.params.*` /
  // `params.*` directly.
  app.saveVarRecent = () => params.saveVarRecent();

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
    canExport: () => app.canExport(), canExportScript: () => app.canExportScript(),
    sink: exportSink,
    state: app.state, // AppState structurally satisfies ExportStateSlice
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
  app.exports = exportService;

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
    state: app.state, // AppState structurally satisfies WorkbenchStateSlice
    activeTab: () => app.activeTab(),
    hooks: {
      renderResults: () => renderResults(app),
      renderSavedHistory: () => renderSavedHistory(app),
      cancelSchemaGraph,
      loadSchema: () => { void catalog.loadSchema(); },
      recordHistory: (tab, sql) => app.recordHistory(tab, sql),
      recordBoundParams: (bp) => params.recordBoundParams([...bp]),
      prepareTabSource: params.prepareTabSource, varGateBlocked: params.varGateBlocked,
      execStatementSql: params.execStatementSql, sessionParamsFor,
      getSelectionText: () => app.sqlEditor.getSelection().text,
      tickElapsed,
      saveJSON,
      onAuthFailed: () => chCtx.onSignedOut(),
    },
  });
  app.workbench = workbench;
  // Milliseconds since the running query started (0 when idle) — delegates to
  // the session's own private runT0 bookkeeping.
  app.elapsedMs = () => workbench.elapsedMs();
  // hardenVar/inputGate (#170 review bookkeeping) now live on `params` (see
  // its construction above) — setRunBtn's fallback and renderVarStrip's tail
  // call `params.inputGate`/`params.hardenVar` directly.
  function setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void {
    if (!app.dom.runBtn) return;
    // Disabled while running, or while any detected {name:Type} query variable
    // is missing, invalid (#170), or fails to serialize (#170 review finding:
    // the button's visible disabled state must match varGateBlocked's actual
    // gate, which already blocks on missing+invalid+errors) — with a tooltip
    // so the greyed-out button explains itself. Execution paths (run/
    // runScript) enforce the same gate via varGateBlocked. A caller that
    // already has the prepared source (renderVarStrip) passes its
    // {missing, invalid, errors} to avoid re-preparing; otherwise we compute
    // it here via inputGate — a merely 'incomplete' value (#170) stays
    // display-only and doesn't grey out the button while still focused.
    const tab = app.activeTab();
    if (gate == null) {
      gate = running || !tab
        ? { missing: [], invalid: [], errors: [] }
        : params.inputGate(params.tabAnalysis(tab.sqlDraft));
    }
    const blockers = gate.missing.concat(gate.invalid);
    app.dom.runBtn!.disabled = running || blockers.length > 0 || gate.errors.length > 0;
    app.dom.runBtn!.title = blockers.length
      ? 'Enter a value for: ' + blockers.join(', ')
      : gate.errors.length ? gate.errors[0] : '';
    // "Run selection" while the editor has a non-empty selection (so the mode is
    // discoverable); plain "Run" otherwise. Build the children and drop the null
    // (replaceChildren would coerce a null arg into a "null" text node).
    const label = running ? 'Running…' : (app.state.hasSelection.value ? 'Run selection' : 'Run');
    app.dom.runBtn!.replaceChildren(
      ...[Icon.play(), h('span', null, label),
        running ? null : h('kbd', null, '⌘↵')].filter((c): c is SVGElement | HTMLElement => c != null));
  }
  app.setRunBtn = setRunBtn;
  // Repaint the query-variable strip (#134) for the active tab. Values live in
  // the shared, persisted `state.varValues` (keyed by variable name), so a value
  // typed once is reused by every query that references the same variable and is
  // restored on reload. The listed set comes from the all-active analysis view
  // (#165): a param confined to /*[ ]*/ optional blocks stays listed — marked
  // optional (blank allowed; blank keeps its blocks inactive) — while a param
  // outside blocks stays required. Typing keeps `state.filterActive` in sync
  // (blank ⇒ inactive, typed ⇒ active). Inputs rebuild only when the detected
  // {name:Type} set changes (signature guard) — so typing in the SQL editor
  // doesn't thrash the row or steal focus, and switching between tabs with the
  // same variables keeps the (already-correct, shared) values in place. Always
  // re-syncs the Run button's disabled/tooltip state.
  //
  // #172 v2 (schema-cache inference — the SUGGESTION tier) now lives on
  // `params.inferredEnumOptions` (see its construction above) — pure over
  // schema + analysis, no DOM.
  function renderVarStrip(): void {
    const strip = app.dom.varStrip;
    if (!strip) return;
    const tab = app.activeTab();
    // One analysis per repaint (review F9): fieldControls, the #172 v2
    // comparison scan, a rebuild's initial field paint, and the tail's Run-
    // button gate all feed off this single pass instead of re-analyzing the
    // same SQL a second time per editor keystroke.
    const analysis = tab ? params.tabAnalysis(tab.sqlDraft) : null;
    const vars = analysis ? fieldControls(analysis) : [];
    // #172 v2 scans the tab SQL's ANALYSIS materialization (review F2): in
    // the raw text a comparison inside a /*[ ]*/ optional block is one opaque
    // comment span and could never match. `resolveComparisonColumnType`
    // resolves each match's position against this same text. (Workbench-only
    // — the Dashboard has no schema cache and gets v1 straight from the type.)
    const scanSql = tab ? analysisView(tab.sqlDraft) : '';
    const comparisonColumns = tab ? paramComparisonColumns(scanSql) : {};
    // Each field's control kind + member list (shared enum > date-like > text
    // priority; a type-conflicted field degrades to text — fieldControlKind).
    const controls = vars.map((v) => fieldControlKind(v, params.inferredEnumOptions(v, scanSql, comparisonColumns)));
    // The signature folds in each var's control kind and resolved enum
    // options — not just name/type/optional — so a column landing on the
    // idle-tick loader (loadColumns calls renderVarStrip on completion)
    // upgrades a v2 field from plain input to the dropdown, and a type
    // conflict appearing or resolving restyles the field, even though the
    // {name:Type} set itself never changed.
    const sig = vars.map((v, i) => {
      const c = controls[i];
      return v.name + ':' + v.type + (v.optional ? '?' : '') + (v.conflict ? '!' : '')
        + ':' + c.kind + (c.enumOptions ? c.enumOptions.length : '');
    }).join(',');
    // The Run button's gate from this SAME analysis (review F9: setRunBtn's
    // gate-less fallback would re-analyze the identical SQL). Lazy so the
    // running / tab-less states (whose gate setRunBtn hard-empties anyway)
    // skip the prepare entirely.
    const runGate = () => (analysis && !app.state.running.value ? params.inputGate(analysis) : undefined);
    if (sig !== app.dom.varStripSig) {
      // A signature change while the user is focused INSIDE the strip would
      // replaceChildren() every field out from under them — a background
      // column load (loadColumns → renderVarStrip, the #172 v2 upgrade path)
      // completing mid-typing would steal focus, wipe the in-progress text
      // repaint, and destroy any open dropdown. Defer the rebuild until focus
      // leaves the strip: the upgrade only matters on the NEXT interaction
      // anyway. (Typing in the SQL editor also lands here on every keystroke,
      // but then focus is in the editor, not the strip — no deferral.)
      const active = doc.activeElement;
      if (active && strip.contains(active)) {
        app.dom.varStripRerenderPending = true;
        if (!app.dom.varStripDeferHooked) {
          app.dom.varStripDeferHooked = true;
          // One listener for the strip's lifetime (the strip node itself is
          // never replaced, only its children). `focusout` bubbles; when
          // focus merely moves BETWEEN fields of the strip, relatedTarget is
          // still inside it and the deferral holds.
          strip.addEventListener('focusout', (e: FocusEvent) => {
            if (!app.dom.varStripRerenderPending) return;
            if (e.relatedTarget && strip.contains(e.relatedTarget as Node)) return;
            app.dom.varStripRerenderPending = false;
            renderVarStrip();
          });
        }
        setRunBtn(app.state.running.value, runGate());
        return;
      }
      app.dom.varStripRerenderPending = false;
      app.dom.varStripSig = sig;
      if (!vars.length) {
        strip.replaceChildren();
        strip.style.display = 'none';
      } else {
        strip.style.display = '';
        // The freshly-(re)built strip paints each field's already-committed
        // state ('execute' mode — no field is mid-typing right after a
        // rebuild, e.g. a tab switch restoring a previously-invalid value).
        const initialFields = params.prepareAnalyzedBatch(analysis!, wallNow(), 'execute').fields;
        strip.replaceChildren(...vars.map((v, i) => {
          // controls[i] (fieldControlKind above) picks the field's control:
          // #172 enum members (v1 declared or v2 inferred) > #169 date-like
          // preset combobox + live preview > plain text with recents (#171).
          // The field stays free-text in every case (absolute values / non-
          // members keep working); persistence/#170 validation stays exactly
          // the shared logic below — the combobox only adds its own focus/
          // keydown-nav/composition hooks, called first from the same
          // handlers (wireComboInput; see relative-time-field.js's header
          // comment on why this beats two independent listeners).
          const ctl = controls[i];
          // #173 acceptance (review F1): a type-conflicted field degrades to
          // the plain text control (ctl.kind above) and says so visibly — a
          // warning style distinct from is-invalid (the VALUE isn't wrong;
          // the declarations disagree) plus a tooltip listing them.
          const conflictNote = v.conflict
            ? 'Conflicting type declarations: ' + v.conflict.join(' vs ') : null;
          const baseTitle = v.name + ': ' + v.type
            + (v.optional ? ' — optional: blank leaves its filter block out' : '')
            + (conflictNote ? ' — ' + conflictNote : '');
          let combo: VarStripCombo;
          let input: HTMLInputElement;
          const onValueInput = (): void => {
            app.state.varValues[v.name] = input.value;
            // Text controls sync activation with the value (#165).
            app.state.filterActive[v.name] = input.value !== '';
            params.saveVarValues();
            params.saveFilterActive();
            // Editing the value un-hardens it (#170 review): back to
            // neutral, lenient behavior until it's committed again.
            params.hardenedVars.delete(v.name);
            // 'input' mode (#170): a plausible prefix stays neutral while
            // the field is focused — only a value that's already certainly
            // wrong shows the inline error here.
            const inputBatch = params.prepareTabBatch(tab.sqlDraft, wallNow(), 'input');
            applyFieldState(input, inputBatch.fields[v.name], baseTitle, combo?.previewEl);
            setRunBtn(app.state.running.value, inputBatch.sources[0]);
          };
          const onCommitHard = (): void => {
            // Hardens 'incomplete' → 'invalid' on commit (#170).
            const commitBatch = params.prepareTabBatch(tab.sqlDraft, wallNow(), 'execute');
            params.hardenVar(v.name, commitBatch.fields[v.name]);
            applyFieldState(input, commitBatch.fields[v.name], baseTitle, combo?.previewEl);
            setRunBtn(app.state.running.value, commitBatch.sources[0]);
          };
          // #171: live-filtered recents for this field (type + typed text),
          // called fresh on every dropdown open/keystroke — never a snapshot
          // — so a value recorded by a run that completes without changing
          // the strip's {name:Type} signature is never stale. (#160's
          // curated-param opt-out hook: nothing to check yet — no curated
          // param exists before #160 lands.)
          const getRecents = (text: string): string[] => recentOptions(app.state.varRecent, v.name, v.type, text);
          const onClearRecent = (): void => params.clearVarRecent(v.name);
          const fieldOpts = {
            document: doc, name: v.name, type: v.type, value: app.state.varValues[v.name] || '',
            baseTitle, onValueInput, onCommit: onCommitHard, getRecents, onClearRecent,
          };
          if (ctl.kind === 'enum') combo = buildEnumField({ ...fieldOpts, values: ctl.enumOptions! });
          else if (ctl.kind === 'date') combo = buildRelativeTimeField({ ...fieldOpts, wallNow });
          else combo = buildRecentField(fieldOpts);
          input = combo.input;
          wireComboInput(combo, { onValueInput, onCommit: onCommitHard });
          if (conflictNote) input.classList.add('is-conflict');
          params.hardenVar(v.name, initialFields[v.name]);
          applyFieldState(input, initialFields[v.name], baseTitle, combo?.previewEl);
          return h('label', { class: 'var-field' + (v.optional ? ' is-optional' : '') },
            h('span', { class: 'var-name' }, v.name), combo.el);
        }));
      }
    }
    setRunBtn(app.state.running.value, runGate());
  }
  app.renderVarStrip = renderVarStrip;
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
  app.setExportBtn = setExportBtn;
  // Busy state for the Format button — formatting a multi-statement script is one
  // request per statement, so it can take a moment; show a spinner + disable.
  function setFmtBtn(busy: boolean): void {
    if (!app.dom.fmtBtn) return;
    app.dom.fmtBtn.disabled = busy;
    app.dom.fmtBtn.replaceChildren(
      busy ? h('span', { class: 'spin' }, Icon.spinner()) : Icon.braces(),
      busy ? 'Formatting…' : 'Format');
  }
  app.setFmtBtn = setFmtBtn;

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
  // Format one statement via ClickHouse's formatQuery(); returns the formatted text.
  const formatOne = async (s: string): Promise<string> => {
    const json = await ch.queryJson<{ q: string }>(chCtx, 'SELECT formatQuery(' + sqlString(s) + ') AS q FORMAT JSON');
    return (json.data && json.data[0] && json.data[0].q) || '';
  };

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
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    const tab = app.activeTab();
    setFmtBtn(true); // formatting a script is one request per statement — show busy
    try {
      if (stmts.length > 1) {
        // Multi-statement: format each (best-effort — keep the original text for any
        // statement that won't format, like insertCreate; skip a template, #165),
        // then reassemble with a `;` and a blank line between statements.
        const skipped = stmts.filter((s) => hasOptionalBlocks(s)).length;
        const formatted = await Promise.all(stmts.map((s) => (hasOptionalBlocks(s) ? s : formatOne(s).catch(() => s))));
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
        // Terminate so the caret lands past the last token — otherwise the input
        // event from the replace re-opens autocomplete on the trailing word.
        if (q) app.sqlEditor.replaceDocument(withStatementBreak(q));
        clearFormatError();
      } catch (e) {
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
      setFmtBtn(false);
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
    loadSchemaLineage: ch.loadSchemaLineage,
    loadLineageTransitive: ch.loadLineageTransitive,
    loadSchemaCards: ch.loadSchemaCards,
    loadTableDetail: ch.loadTableDetail,
    activeTab: () => app.activeTab(),
    hooks: {
      renderResults: () => renderResults(app),
      onAuthFailed: () => chCtx.onSignedOut(),
    },
  });
  app.graph = graph;

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
  // Explain the current query without editing it: run it through the EXPLAIN
  // views (the editor SQL is left untouched; run() wraps it as needed).
  function explainQuery(): Promise<void> | undefined {
    if (app.activeTab().editorMode !== 'sql') return undefined;
    return explainMultiBlocked() ? undefined : workbench.run({ explain: true });
  }
  // Switch the active EXPLAIN view (re-runs the derived query, keeps the mode).
  function setExplainView(id: string): Promise<void> | undefined {
    if (app.activeTab().editorMode !== 'sql') return undefined;
    return explainMultiBlocked() ? undefined : workbench.run({ explainView: id });
  }
  // Change the global result-row cap: persist the (normalized) preference and
  // re-run the current query so a raise genuinely fetches more (server-side cap),
  // a lower one stops sooner. run() no-ops on an empty editor, so changing the
  // limit with nothing typed just saves the preference.
  function setResultRowLimit(n: number): Promise<void> | undefined {
    app.state.resultRowLimit = normalizeRowLimit(n);
    prefs.save('resultRowLimit', app.state.resultRowLimit);
    return app.activeTab().editorMode === 'sql' ? workbench.run() : undefined;
  }

  // Fetch the DDL for `target` (e.g. 'db.table' or 'DATABASE db') with
  // SHOW CREATE and pretty-print it through formatQuery(). Two round-trips
  // by design; if formatting fails the raw DDL is returned. Returns null on
  // failure or an empty statement (having already surfaced the toast), so
  // callers can no-op without inspecting the error themselves.
  async function fetchCreateSql(target: string): Promise<string | null> {
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return null; }
    try {
      const show = await ch.queryJson<{ statement: string }>(chCtx, 'SHOW CREATE ' + target + ' FORMAT JSON');
      const stmt = (show.data && show.data[0] && show.data[0].statement) || '';
      if (!stmt) return null;
      try {
        const fmt = await ch.queryJson<{ q: string }>(chCtx, 'SELECT formatQuery(' + sqlString(stmt) + ') AS q FORMAT JSON');
        return (fmt.data && fmt.data[0] && fmt.data[0].q) || stmt;
      } catch { return stmt; /* formatting is best-effort — fall back to the raw DDL */ }
    } catch (e) {
      flashToast('SHOW CREATE failed: ' + String((e instanceof Error && e.message) || e), { document: doc });
      return null;
    }
  }

  // Replaces the active editor's content (undo restores the prior query).
  async function insertCreate(target: string): Promise<void> {
    const sql = await fetchCreateSql(target);
    if (sql != null) app.sqlEditor.replaceDocument(sql);
  }

  // Opens the DDL in a new tab, leaving the active tab untouched.
  async function openCreateInNewTab(target: string, name?: string): Promise<void> {
    const sql = await fetchCreateSql(target);
    if (sql == null) return;
    loadIntoNewTab(app, name || '', sql); // falsy → loadIntoNewTab's own 'Untitled' fallback, same as omitting name
    toEditorOnMobile();
  }

  // --- saved / history bridges ------------------------------------------
  // The history-recording POLICY itself now lives in `saved.recordHistory`
  // (#276 Phase 4C) — this wrapper's own conditional History-panel repaint is
  // a rendering concern the service must never own (see its header comment),
  // so it stays here, unchanged.
  app.recordHistory = (tab, sqlText) => {
    saved.recordHistory(tab, sqlText);
    if (app.state.sidePanel.value === 'history') renderSavedHistory(app);
  };

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
  app.specBlocked = specBlocked;

  app.updateSaveBtn = () => {
    if (!app.dom.saveBtn) return;
    const tab = app.activeTab();
    const entry = savedForTab(app.state, tab);
    const clean = !!entry && !tab.dirtySql && !tab.dirtySpec;
    const blocked = !!entry && specBlocked(tab);
    app.dom.saveBtn.classList.toggle('saved', clean);
    app.dom.saveBtn.replaceChildren(Icon.bookmark(), h('span', null, clean ? 'Saved' : 'Save'));
    app.dom.saveBtn.disabled = blocked;
    app.dom.saveBtn.title = blocked
      ? 'Fix blocking Spec errors before saving'
      : clean ? 'Saved — edit to re-save (⌘S)' : 'Save query (⌘S)';
  };
  // Open `node` as a popover anchored under `anchorEl`: fixed-position below the
  // button, Esc + click-outside close (capture listeners), stored at
  // app.dom[refKey] and cleared on close. Returns { close }.
  function anchoredPopover(
    node: HTMLElement, anchorEl: HTMLElement, refKey: 'savePopover' | 'userMenu',
  ): { close: () => void } {
    const close = (): void => {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('mousedown', onOutside, true);
      if (app.dom[refKey]) { app.dom[refKey]!.remove(); app.dom[refKey] = undefined; }
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const onOutside = (e: MouseEvent): void => {
      if (app.dom[refKey] && !node.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) close();
    };
    app.dom[refKey] = node;
    const r = anchorEl.getBoundingClientRect();
    // Right-align under the button.
    const a = fixedAnchor(r, { viewportW: win.innerWidth || 0 }) as { top: number; right: number };
    node.style.position = 'fixed';
    node.style.top = a.top + 'px';
    if (app.state.isMobile.value) {
      // Mobile (#126): the trigger can sit mid-toolbar (the toolbar scrolls), so
      // right-aligning to it pushes a fixed-width popover off the narrow
      // viewport's left edge. Center it horizontally instead (still dropped below
      // the trigger via `top`); the mobile max-width clamps keep it in-bounds.
      node.style.left = '50%';
      node.style.transform = 'translateX(-50%)';
    } else {
      node.style.right = a.right + 'px';
    }
    doc.body.appendChild(node);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('mousedown', onOutside, true);
    return { close };
  }

  async function commitLinkedQuery(): Promise<SavedQueryV2 | null> {
    const tab = app.activeTab();
    const evaluated = queryDoc.evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
    // Serialized with every other saved-query write so a save can't interleave
    // with a concurrent star/delete and commit a stale whole-workspace candidate
    // (#287 review fix — see `app.serializeWrite`).
    const result = await app.serializeWrite(() => saved.commit(tab, evaluated));
    if (!result.ok) {
      // 'rejected' (commit's own defensive re-check inside the service, OR the
      // aggregate strictly rejecting the whole-workspace commit — #287 W4)
      // stays a silent no-op for the tab/editor state (nothing was mutated),
      // but a real commit rejection still surfaces its first diagnostic.
      if (result.reason === 'invalid-spec') {
        queryDoc.revealFirstSpecError(tab);
        flashToast('Fix Spec errors before saving', { document: doc });
      } else if (result.reason === 'empty') {
        flashToast('Nothing to save', { document: doc });
      } else if (result.diagnostics?.length) {
        flashToast('Save failed: ' + result.diagnostics[0].message, { document: doc });
      }
      return null;
    }
    queryDoc.revalidateSpecDrafts();
    app.specEditor.syncFromState();
    app.updateSaveBtn();
    app.actions.rerenderTabs();
    renderSavedHistory(app);
    renderResults(app);
    app.updateEditorModeUi!();
    flashToast('Saved', { document: doc });
    return result.entry;
  }

  async function saveActiveQuery(): Promise<SavedQueryV2 | null | undefined> {
    if (savedForTab(app.state, app.activeTab())) return commitLinkedQuery();
    openSavePopover();
    return undefined;
  }

  // Creation-only Name/Description popover. Once linked, the textual Spec is
  // authoritative and Save bypasses this UI entirely.
  function openSavePopover(): void {
    const tab = app.activeTab();
    // A queryless panel (text, #166) is authored entirely in its cfg, so it
    // saves with empty SQL — the same per-type relaxation saveQuery applies.
    if (!String(tab.sqlDraft || '').trim() && !isQuerylessPanel(tabPanel(tab))) {
      flashToast('Nothing to save', { document: doc });
      return;
    }
    if (app.dom.savePopover) return;
    const prefill = tab.name && tab.name !== 'Untitled' ? tab.name : inferQueryName(tab.sqlDraft);
    const input = h('input', { class: 'sp-input', value: prefill });
    const descInput = h('textarea', { class: 'sp-desc', rows: '3', placeholder: 'What this query does — included in Markdown export' });
    let close: () => void;
    const commit = async (): Promise<void> => {
      if (!input.value.trim()) return;
      const result = await app.serializeWrite(() => saved.create(tab, input.value, descInput.value));
      if (!result.ok) {
        if (result.diagnostics?.length) flashToast('Save failed: ' + result.diagnostics[0].message, { document: doc });
        return;
      }
      close();
      queryDoc.revalidateSpecDrafts();
      app.specEditor.syncFromState();
      app.updateSaveBtn();
      app.updateEditorModeUi!();
      app.actions.rerenderTabs();
      renderSavedHistory(app);
      flashToast('Saved', { document: doc });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    // In the multiline description, plain Enter inserts a newline; ⌘/Ctrl+Enter commits.
    descInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); } });
    const pop = h('div', { class: 'save-popover' },
      h('div', { class: 'sp-label' }, 'Save query as'),
      input,
      h('div', { class: 'sp-label' }, 'Description', h('span', { class: 'sp-opt' }, ' — optional')),
      descInput,
      h('div', { class: 'sp-actions' },
        h('button', { class: 'sp-cancel', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'sp-save', onclick: commit }, 'Save')));
    ({ close } = anchoredPopover(pop, app.dom.saveBtn!, 'savePopover'));
    setTimeout(() => { input.focus(); input.select(); });
  }
  app.openSavePopover = openSavePopover;

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

  app.activateInvalidSpecDraft = (tab) => {
    if (!tab) return;
    batch(() => { app.state.activeTabId.value = tab.id; });
    tab.editorMode = 'spec';
    app.updateEditorModeUi!();
    app.specEditor.focus();
    flashToast('Fix Spec JSON first', { document: doc });
  };

  // User menu: dropdown under the header user button, holding the identity and
  // a Log out item. Same close model as the save popover (Esc + outside click).
  function openUserMenu(): void {
    if (app.dom.userMenu) return;
    let close: () => void;
    const logoutBtn = h('button', { class: 'um-item danger', onclick: () => { close(); app.signOut(); } }, Icon.logout(), h('span', null, 'Log out'));
    const menu = h('div', { class: 'user-menu' },
      h('div', { class: 'um-id' }, conn.email()),
      logoutBtn,
      h('div', { class: 'um-build', title: 'App version / build' }, app.build));
    ({ close } = anchoredPopover(menu, app.dom.userBtn!, 'userMenu'));
    setTimeout(() => logoutBtn.focus());
  }
  app.openUserMenu = openUserMenu;

  function toggleTheme(): void {
    // The shared DOM composition (state-flip + persist + `data-theme` +
    // icon swap) now lives in `ui/theme-toggle.ts`'s `toggleThemeDom` (#276
    // Phase 5) — both route shells (workbench header, dashboard) wire their
    // own theme button to it; this thin wrapper is kept as `app.toggleTheme`
    // solely for explain-graph.ts's detached schema-graph overlay, which
    // takes it as an optional callback (see theme-toggle.ts's own header
    // comment for why that one seam isn't mechanical to repoint).
    toggleThemeDom({ prefs, document: doc, themeBtn: () => app.dom.themeBtn });
  }
  // Exposed so the schema-view overlay can drive the same toggle (keeps state +
  // saved pref + header icon in sync rather than flipping data-theme behind them).
  app.toggleTheme = toggleTheme;

  // On mobile (#126), jump the bottom-nav to the Editor panel after an action
  // that changes the editor content; a no-op on desktop.
  const toEditorOnMobile = (): void => { if (app.state.isMobile.value) app.state.mobileView.value = 'editor'; };

  // --- dashboard (#149 D1) ----------------------------------------------
  // Dashboard tiles stream their read-only SQL through the shared
  // `app.exec.executeRead` seam directly (#193/#276 — see src/ui/dashboard.js
  // `runSlotTile`), the same path run() and the detached Data view use; the
  // former bespoke `runTile`/`queryDashboardTile`/`parseJsonResult` machinery
  // was retired so cap/settings fixes can't apply to only one path.
  app.renderDashboard = () => renderDashboard(app);

  // #286 Phase 4: run the one-shot legacy migration (favorites → tiles,
  // dashLayout/dashCols → flow@1) — it only actually does anything when no
  // aggregate record exists yet (`migrateLegacyWorkspaceIfNeeded` keys on raw
  // record existence via the store, never on `loadCurrent`/`loadCurrentResult`
  // validity, so a present-but-corrupt record is never clobbered by a re-run
  // — #300). Shared by `loadDashboardWorkspace` below and the boot path
  // (`loadWorkspaceOnBoot`) so both read the SAME migration deps built off the
  // current `app.state` snapshot.
  const runLegacyMigrationIfNeeded = () => migrateLegacyWorkspaceIfNeeded({
    store: workspaceStore,
    repository: app.workspace,
    legacy: {
      name: app.state.libraryName.value,
      queries: app.state.savedQueries,
      dashLayout: app.state.dashLayout,
      dashCols: app.state.dashCols,
    },
    genId: () => uid('ws-'),
  });

  // #286 Phase 4: resolve the current StoredWorkspaceV1 the Dashboard viewer
  // reads from. Reads via `loadCurrent` (not `loadCurrentResult`), so a
  // corrupt-but-present record still collapses to `null` here — the /dashboard
  // route's own render just falls back to its empty state; the user-visible
  // corrupt-record surface (#300) lives in the boot path below, which both
  // `main.ts`'s OAuth bootstrap and the basic-auth `connect` action go through.
  app.loadDashboardWorkspace = async () => {
    await runLegacyMigrationIfNeeded();
    return app.workspace.loadCurrent();
  };

  // #287 W4: the async boot-init step — migrate-if-needed + loadCurrent (via
  // `loadDashboardWorkspace` above), then PROJECT the resolved aggregate onto
  // `state` so the Workbench (not only the /dashboard route) treats it as the
  // saved-query collection's single source of truth. `main.ts`'s `bootstrap`
  // awaits this before the first `renderApp()`. A null/failed load leaves
  // `state` exactly as `createState()`'s synchronous legacy read already
  // populated it (a brand-new install with nothing to migrate yet, or a
  // degraded IndexedDB) — including its own synchronously-minted
  // `workspaceId` placeholder (see `createState`'s `mintWorkspaceId`), so a
  // saved-query CRUD op run in this window (or by a caller that never awaits
  // this step at all) still succeeds rather than failing closed.
  // #287 W5: the projection every commit of the aggregate onto `state`
  // shares — extracted from this same assignment's pre-W5 inline body so
  // `loadWorkspaceOnBoot` and every file-menu.js write (New/Import/Replace/
  // rename) apply it identically. `libraryDirty` clears here too: a workspace
  // that was JUST committed (boot's own load, or a file-menu op's commit) is
  // by construction in sync with what's persisted, matching the pre-#287
  // New/Replace-clears-dirty behavior file-menu.js's own ops used to apply
  // directly.
  const applyCommittedWorkspace = (workspace: StoredWorkspaceV1): void => {
    app.state.savedQueries = workspace.queries;
    app.state.dashboard = workspace.dashboard;
    app.state.workspaceId = workspace.id;
    app.state.libraryName.value = workspace.name;
    app.state.libraryDirty.value = false;
  };
  app.applyCommittedWorkspace = applyCommittedWorkspace;
  // #287 W5: the shared WorkspaceIdGen seam file-menu.js's New workspace /
  // Import / Replace operations mint fresh ids through — the same generator
  // `loadDashboardWorkspace`'s one-shot legacy migration already uses inline
  // above (`uid('ws-')`).
  app.genId = () => uid('ws-');

  // #287 review fix: serialize saved-query writes so overlapping async CRUD
  // commits can't interleave. Without this, a delete and a star toggle fired in
  // rapid succession each build a candidate from the same stale
  // `state.savedQueries` snapshot, and whichever commits LAST wins — resurrecting
  // a just-deleted query (or clobbering a concurrent edit). Chaining each op
  // after the previous one fully resolves means the next op reads the freshest
  // projected state. The chain swallows rejections so one failed op never
  // wedges the queue; the op's own result/rejection still reaches its caller.
  let writeChain: Promise<unknown> = Promise.resolve();
  app.serializeWrite = <T,>(op: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(op, op);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  };

  // #300: the Reset action offered on the corrupt-workspace toast below.
  // `loadCurrent()`/`clearCurrent()`'s callers rely on a corrupt record
  // collapsing to `null`/being silently removable — here that removal is
  // deliberate and user-initiated. Clearing makes the store look exactly like
  // a fresh install to `migrateLegacyWorkspaceIfNeeded`'s existence check, so
  // it rebuilds a brand-new aggregate from the CURRENT legacy/local state
  // (favorites, layout prefs) rather than leaving the next random CRUD op to
  // silently mint one over nothing. Only projects + re-renders on success —
  // an immediately-re-corrupt or still-empty outcome (unexpected; the store
  // was just cleared) leaves the legacy `createState()` projection standing,
  // same as any other failed load.
  const resetCorruptWorkspace = async (): Promise<void> => {
    await app.workspace.clearCurrent();
    await runLegacyMigrationIfNeeded();
    const result = await app.workspace.loadCurrentResult();
    if (result.status === 'ok') {
      applyCommittedWorkspace(result.workspace);
      app.renderApp();
    }
  };

  app.loadWorkspaceOnBoot = async () => {
    await runLegacyMigrationIfNeeded();
    const result = await app.workspace.loadCurrentResult();
    if (result.status === 'corrupt') {
      // #300: a corrupt-but-present aggregate is surfaced instead of silently
      // continuing on the legacy projection (which would otherwise let the
      // next saved-query CRUD commit orphan the corrupt record with no
      // user-visible error). State is left untouched — same as any other
      // null/failed load below.
      flashToast(
        'Saved workspace could not be read — your queries and dashboard layout are unaffected until you reset it.',
        { document: app.document, action: { label: 'Reset workspace', onClick: () => { void resetCorruptWorkspace(); } } },
      );
      return null;
    }
    const workspace = result.status === 'ok' ? result.workspace : null;
    if (workspace) applyCommittedWorkspace(workspace);
    return workspace;
  };

  // Open the dashboard in a new EDIT-mode tab (#288/#302): the route carries
  // the current workspace + dashboard ids (`?ws=&dash=`) so the viewer verifies
  // both and shares the primary workspace store with this Workbench tab. We
  // stand ready to hand it our credentials — the cross-tab auth-handoff GRANT
  // side is the session's job (`conn.grantHandoffTo`, #276 Phase 2); this stays
  // app-side only because opening the tab (window.open) is a DOM/browser
  // concern. A workspace with no dashboard opens the bare route (legacy).
  function openDashboard(): void {
    const dashId = app.state.dashboard?.id;
    const wsId = app.state.workspaceId;
    const search = (wsId && dashId)
      ? buildDashboardSearch({ kind: 'current-workspace', workspaceId: wsId, dashboardId: dashId })
      : '';
    const child = app.openWindow(loc.origin + conn.basePath + '/dashboard' + search);
    if (child) conn.grantHandoffTo(child);
  }
  app.openDashboard = openDashboard;

  // #288 Phase 6 — open the current dashboard in a new READ-ONLY VIEW-mode tab
  // via the one-time IndexedDB token handoff (ADR-0003). The token is generated
  // synchronously so the child tab can be opened in the SAME user-gesture task
  // (popup-safe) already pointed at `?st=<token>&dash=`; the validated bundle is
  // written to the handoff store in parallel, and the viewer retries the
  // one-time `take` briefly to cover the write/read race. The detached workspace
  // id minted here is what the consumed handoff materializes under, detached
  // from (and unaffected by later edits to) this primary workspace.
  function openDashboardForViewing(): void {
    const dashboard = app.state.dashboard;
    if (!dashboard) { flashToast('No dashboard to view', { document: doc }); return; }
    const token = randomHandoffToken(cryptoObj);
    const detachedWorkspaceId = uid('wsview-');
    const built = buildViewHandoffRecord(dashboard, app.state.savedQueries, {
      detachedWorkspaceId, expiresAt: wallNow() + VIEW_HANDOFF_TTL_MS,
      nowISO: new Date(wallNow()).toISOString(),
    });
    if (!built.ok) { flashToast('✕ ' + (built.diagnostics[0]?.message || 'Could not prepare dashboard for viewing'), { document: doc }); return; }
    const search = buildDashboardSearch({ kind: 'session-bundle', token, dashboardId: dashboard.id });
    const child = app.openWindow(loc.origin + conn.basePath + '/dashboard' + search);
    // A blocked popup means nothing will ever consume the token — don't write a
    // (potentially multi-MB) orphan record the store never sweeps. Only persist
    // the handoff once we know a viewer tab is actually opening.
    if (!child) { flashToast('Allow pop-ups to open the dashboard view', { document: doc }); return; }
    conn.grantHandoffTo(child);
    // Write AFTER opening the child (open must stay in the gesture task); the
    // child only reads the token after a full load + auth handoff, well after
    // this fast IndexedDB write lands.
    app.handoff.put(token, built.record).catch(() => {
      flashToast('✕ Could not prepare dashboard for viewing', { document: doc });
    });
  }
  app.openDashboardForViewing = openDashboardForViewing;

  // #288 Phase 6 — the VIEW-mode viewer's side of the one-time handoff
  // (ADR-0003). Atomically consume this tab's `?st=` token, materialize the
  // carried bundle into the persistent detached store under its own id, then
  // rewrite the URL to the durable `?ws=<detachedId>&dash=` form (dropping the
  // dead token) so a relogin/reload re-opens the detached view rather than a
  // spent token. Returns the detached workspace, or null (missing/expired
  // token, or an undecodable bundle) → the viewer shows not-found. The opener
  // writes the token before opening this tab, and this tab only reaches here
  // after a full load + auth handoff, so the record is present by now.
  app.consumeDashboardHandoff = async () => {
    const src = app.dashboardOpenSource;
    if (!src || src.kind !== 'session-bundle') return null;
    const record = await app.handoff.take(src.token, wallNow());
    if (!record) return null;
    const materialized = materializeDetachedWorkspace(record.text, record.dashboardId, record.detachedWorkspaceId);
    if (!materialized.ok) return null;
    await app.detachedViews.put({ workspace: materialized.workspace, savedAt: wallNow() });
    const search = buildDashboardSearch({
      kind: 'current-workspace', workspaceId: materialized.workspace.id, dashboardId: record.dashboardId,
    });
    win.history.replaceState(null, '', loc.origin + conn.basePath + '/dashboard' + search);
    app.dashboardOpenSource = parseDashboardOpenSource(search);
    return materialized.workspace;
  };

  // #302 — after an import committed FROM the standalone Dashboard page, point
  // the tab's URL at the (possibly new) current dashboard id and re-render the
  // viewer. Import replaces the current dashboard (new id), so the pre-import
  // URL's `dash=` would otherwise fail the viewer's strict id verification.
  app.reloadDashboardRoute = () => {
    const dash = app.state.dashboard;
    const wsId = app.state.workspaceId;
    if (dash && wsId) {
      const search = buildDashboardSearch({ kind: 'current-workspace', workspaceId: wsId, dashboardId: dash.id });
      win.history.replaceState(null, '', loc.origin + conn.basePath + '/dashboard' + search);
      app.dashboardOpenSource = parseDashboardOpenSource(search);
    }
    app.renderDashboard();
  };

  // --- actions registry --------------------------------------------------
  app.actions = {
    run: (opts) => workbench.runEntry(opts),
    cancel: () => workbench.cancel(),
    newTab: () => newTab(app),
    selectTab: (id) => selectTab(app, id),
    closeTab: (id) => closeTab(app, id),
    loadIntoNewTab: (queryOrName, sql) => { loadIntoNewTab(app, queryOrName, sql); toEditorOnMobile(); },
    login: (idpId, targetOrigin) => conn.beginOAuth(idpId, targetOrigin),
    // Basic-auth login renders in-page (no page reload), so — unlike the OAuth
    // path, where `main.ts`'s `bootstrap` awaits it — this is the ONLY place the
    // aggregate load + legacy migration runs for a username/password session.
    // Without it a first basic-auth session would render on the placeholder
    // workspaceId and skip `migrateLegacyWorkspaceIfNeeded`, so the first CRUD
    // commit would mint an orphan aggregate the migration marker then treats as
    // "already migrated" — permanently stranding legacy favorites/layout (#287).
    connect: async (input) => { await conn.connectBasic(input); await app.loadWorkspaceOnBoot(); app.renderApp(); },
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
    exportEntry,
    exportDirect,
    cancelExport,
    cancelExportScript,
    save: saveActiveQuery,
    openUserMenu,
    formatQuery,
    formatSpec,
    setEditorMode,
    explainQuery,
    setExplainView,
    setResultRowLimit,
    showSchemaGraph,
    cancelSchemaGraph,
    expandSchemaGraph,
    openNodeDetail,
    insertCreate: async (target) => { await insertCreate(target); toEditorOnMobile(); },
    openCreateInNewTab: (target, name) => openCreateInNewTab(target, name),
    openShortcuts: () => openShortcuts(app),
    openDashboard,
    openDashboardForViewing,
    // #302: Dashboard import/export invoked from the Dashboard page's own File
    // menu (and still from the Workbench during the transition). Export is a
    // read-only bundle download; import runs the transactional planner and, on
    // the standalone Dashboard route, re-renders the dashboard on success.
    exportDashboard: () => exportDashboardAction(app),
    importDashboard: () => triggerImportDashboard(app),
    // Editor-mutating actions jump the mobile bottom-nav to the Editor panel
    // (#126) so a schema tap / SHOW CREATE lands where the user can see it.
    insertAtCursor: (text) => { app.sqlEditor.insertAtCursor(text); toEditorOnMobile(); },
    replaceEditor: (text) => { app.sqlEditor.replaceDocument(text); toEditorOnMobile(); },
    loadColumns,
    rerenderTabs: () => renderTabs(app),
    rerenderResults: () => renderResults(app),
    updateSaveBtn: () => app.updateSaveBtn(),
  };

  app.renderApp = () => renderApp(app, { toggleTheme, startDrag });
  return app;
}

/** `renderApp`'s second argument — the two closures it can't rebuild itself
 *  (both defined inside `createApp`, over that same `app`). */
export interface RenderAppHelpers {
  toggleTheme: () => void;
  startDrag: typeof startDrag;
}


/** Build the signed-in shell and mount all regions — a thin composition call
 *  onto `ui/workbench/workbench-shell.ts`'s `mountWorkbenchShell` (#276 Phase
 *  5): the entire former body (header/sidebar/splitters/workbench DOM/every
 *  effect/`attachShell`/the catalog bootstrap tail) now lives there,
 *  byte-identically, driven by a narrow `WorkbenchShellDeps` bag instead of
 *  the full `App` — see that module's header comment for what stays coupled
 *  to `app` and why. */
export function renderApp(app: App, helpers: RenderAppHelpers): void {
  mountWorkbenchShell({
    app,
    root: app.root,
    document: app.document,
    state: app.state,
    actions: app.actions,
    conn: app.conn,
    catalog: app.catalog,
    sqlEditor: app.sqlEditor,
    specEditor: app.specEditor,
    workbench: app.workbench,
    queryDoc: app.queryDoc,
    prefs: app.prefs,
    matchMedia: app.matchMedia,
    activeTab: app.activeTab,
    updateSaveBtn: app.updateSaveBtn,
    specBlocked: app.specBlocked,
    renderVarStrip: app.renderVarStrip,
    updateBanner: app.updateBanner,
    setRunBtn: app.setRunBtn,
    setExportBtn: app.setExportBtn,
    toggleTheme: helpers.toggleTheme,
    startDrag: helpers.startDrag,
  });
}
