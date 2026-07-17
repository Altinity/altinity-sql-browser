// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h, fixedAnchor } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab, KEYS, recordHistory, recordScriptHistory,
  createSavedQuery, commitSavedQuery, savedForTab, tabPanel,
  normalizeRowLimit, MOBILE_BREAKPOINT_PX,
} from '../state.js';
import type { QueryTab, AppState, SpecValidationService, HistoryResultSnapshot, QuerySpecDraft } from '../state.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import { splitStatements, leadingKeyword } from '../core/sql-split.js';
import { mergedSourceSql, analysisView, fieldControls, fieldControlKind } from '../core/param-pipeline.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { sqlString, inferQueryName, shortVersion, userShortName, withStatementBreak, formatBytes, formatRows } from '../core/format.js';
import { buildSchemaGraph, expandLineage } from '../core/schema-graph.js';
import { buildCardGraph } from '../core/schema-cards.js';
import type { SchemaCardColumnRow } from '../core/schema-cards.js';
import { toTSV } from '../core/export.js';
import { newResult, parseErrorPos } from '../core/stream.js';
import { encodeShare } from '../core/share.js';
import { queryName, queryPanel, withQuerySpec } from '../core/saved-query.js';
import { effectiveDashboardRole } from '../core/result-choice.js';
import {
  CORE_SPEC_VALIDATORS, createSpecValidatorRegistry, evaluateSpecText, formatSpecText,
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
import { SCHEMA_GRAPH_MIME } from './dnd-mime.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from './tabs.js';
import type { QueryOrName } from './tabs.js';
import { effect, batch } from '@preact/signals-core';
import { renderSchema } from './schema.js';
import { renderResults } from './results.js';
import type { Result, QueryResult, ScriptResult, ScriptEntry, ResultSchemaGraph } from './results.js';
import { renderDashboard } from './dashboard.js';
import { openSchemaView } from './explain-graph.js';
import type { SchemaLineageGraph, SchemaLineageNode, DetachedGraphApp } from './explain-graph.js';
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
import type { AssembledReference, CompletionItem } from '../core/completions.js';
import { libraryControls, renderLibraryTitle } from './file-menu.js';
import { renderLogin } from './login.js';
import { openShortcuts } from './shortcuts.js';
import { startDrag } from './splitters.js';
import type { DragCtx, DragRect, DragStartEvent, SplitterAxis } from './splitters.js';
import { flashToast } from './toast.js';
import type { App, ActionsRegistry, SchemaFocus } from './app.types.js';
import type { CreateAppEnv } from '../env.types.js';
import type { SchemaGraphFocus, SchemaGraphNode, SchemaGraphEdge } from '../core/schema-graph.js';
import type { LineageFocus } from '../net/ch-client.js';
import { createQueryExecutionService } from '../application/query-execution-service.js';
import { createConnectionSession } from '../application/connection-session.js';
import { createSchemaCatalogService } from '../application/schema-catalog-service.js';
import { createWorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import { createExportService } from '../application/export-service.js';
import type { ExportSink, FileHandleLike, DirectoryHandleLike } from '../application/export-service.js';
import { createWorkbenchSession } from './workbench/workbench-session.js';

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
    // #170 review: names of `{name:Type}` variables whose value has hardened
    // to invalid — owned by the WorkbenchParameterSession (#276 Phase 4B1,
    // application/workbench-parameter-session.ts), which the block below
    // constructs; `app.hardenedVars` is aliased (not copied) to its `Set`
    // once that session exists (see the `const params = …` block below), so
    // this placeholder is only ever read before that assignment happens.
    hardenedVars: new Set<string>(),
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
  app.saveJSON = saveJSON;
  app.saveStr = saveStr;
  app.savePref = (name, value) => saveStr(KEYS[name as keyof typeof KEYS], String(value));
  // The `{name:Type}` var-value/filter-active/recent-value persistence
  // wrappers (saveVarValues/saveFilterActive/saveVarRecent/
  // saveVarRecentDisabled) + the recent-value policy that sits on top of them
  // (recordBoundParams/clearVarRecent/clearAllVarRecent) now live in the
  // WorkbenchParameterSession (#276 Phase 4B1) — see the `const params = …`
  // block below, which wires `app.saveVarValues`/etc. as one-line delegates
  // once that session exists.
  app.FileReader = (env.FileReader || win.FileReader) as typeof FileReader;
  // Exposed seam for the header File menu (file-menu.js): the file-download
  // helper (defined below). The library title (name + dirty dot) repaints via a
  // libraryName/libraryDirty effect, so callers just mutate those signals.
  app.downloadFile = downloadFile;

  // --- identity ------------------------------------------------------------
  // app.host is a Phase-2 delegate (conn.host) — assigned below, alongside the
  // rest of the ConnectionSession delegates, once `conn` is constructed.
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
      applySpecEvaluation(tab, tab.specText, { dirty: tab.dirtySpec });
      app.specEditor.setDiagnostics(tab.specDiagnostics);
    }
    if (app.actions) app.actions.rerenderTabs();
    if (app.updateSaveBtn) app.updateSaveBtn();
    if (app.renderVarStrip) app.renderVarStrip();
  });
  const applySpecEvaluation = (
    tab: QueryTab, text: string, { dirty = true }: { dirty?: boolean } = {},
  ): { parsed: unknown; diagnostics: SpecDiagnostic[] } => {
    const evaluated = evaluateSpecText(text, specValidators, { sql: tab.sqlDraft, tab });
    tab.specText = text;
    tab.specParsed = evaluated.parsed as QueryTab['specParsed'];
    tab.specDiagnostics = evaluated.diagnostics;
    tab.dirtySpec = dirty;
    return evaluated;
  };
  // Kept as its own named local (precise `{parsed, diagnostics}` return) as
  // well as `app.evaluateSpecDraft` (the public, loosely-`Json`-typed
  // property other modules read per app.types.ts) — every in-module caller
  // that reads `.parsed`/`.diagnostics` off the result calls this directly to
  // stay precisely typed instead of going through the public property.
  function evaluateSpecDraft(
    tab: QueryTab, text: string, { dirty = true }: { dirty?: boolean } = {},
  ): { parsed: unknown; diagnostics: SpecDiagnostic[] } {
    const evaluated = applySpecEvaluation(tab, text, { dirty });
    if (tab === app.activeTab()) app.specEditor.setDiagnostics(tab.specDiagnostics);
    if (app.actions) app.actions.rerenderTabs();
    if (app.updateSaveBtn) app.updateSaveBtn();
    if (app.updateEditorModeUi) app.updateEditorModeUi();
    return evaluated;
  }
  app.evaluateSpecDraft = evaluateSpecDraft;
  app.revalidateSpecDrafts = ({ refreshUi = true } = {}) => {
    for (const tab of app.state.tabs.value) {
      applySpecEvaluation(tab, tab.specText, { dirty: tab.dirtySpec });
    }
    if (!refreshUi) return;
    const tab = app.activeTab();
    app.specEditor.setDiagnostics(tab.specDiagnostics);
    if (app.actions) app.actions.rerenderTabs();
    if (app.updateSaveBtn) app.updateSaveBtn();
    if (app.updateEditorModeUi) app.updateEditorModeUi();
  };
  app.revealFirstSpecError = (tab = app.activeTab()) => {
    const index = tab.specDiagnostics?.findIndex((diagnostic) => diagnostic.severity === 'error') ?? -1;
    if (index >= 0) app.specEditor.revealDiagnostic(index);
  };
  app.specEditor.onDocChange((value) => {
    evaluateSpecDraft(app.activeTab(), value);
  });
  app.registerSpecValidator = (path, validate) => {
    const unregister = specValidators.register(path, validate);
    app.revalidateSpecDrafts();
    return () => { unregister(); app.revalidateSpecDrafts(); };
  };
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

  // Phase-2 delegates — shells/bootstrap consume these; Phase 5 re-points them
  // to app.conn directly.
  app.basePath = conn.basePath;
  app.hostHint = conn.hostHint;
  app.host = conn.host;
  app.isSignedIn = conn.isSignedIn;
  app.email = conn.email;
  app.setTokens = conn.setTokens;
  app.loadConfig = conn.resolveConfig;
  app.loadIdps = conn.loadIdps;
  app.ensureConfig = conn.ensureConfig;
  app.ensureFreshToken = conn.ensureFreshToken;
  app.chCtx = chCtx;
  app.signOut = () => { conn.signOut(); renderLoginApp(); };
  app.showLogin = (msg) => renderLoginApp(msg);
  app.receiveAuthHandoff = (handoffEnv) => conn.receiveAuthHandoff(handoffEnv);

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
  app.loadVersion = () => catalog.loadVersion();
  app.loadSchema = () => catalog.loadSchema();
  app.loadReference = () => catalog.loadReference();
  app.rebuildCompletions = () => catalog.rebuildCompletions();
  app.entityDoc = (name) => catalog.entityDoc(name);
  // `App.refData`/`App.completions` are deliberately loose (`Json`-shaped)
  // placeholders — codemirror-adapter.ts's own narrow app slice reads the real
  // `AssembledReference`/`CompletionItem[]` shapes via its own local `as`
  // (documented there). The service owns the real precisely-typed values as
  // its OWN get/set ACCESSORS (`catalog.refData`/`catalog.completions`,
  // always current — see that interface's doc comment for why a setter
  // exists, not just a getter). These `Object.defineProperty` accessors
  // mirror BOTH directions onto `app`: a read observes the CURRENT value
  // after a `loadReference()`/columns-load rebuild (no app.ts re-mirroring
  // needed, unlike the pre-extraction `Object.assign(app, {refData})`
  // pattern), and a write (e.g. a test overwriting `app.completions`
  // directly, same as `tests/e2e/editor-cm6.spec.js` does) flows straight
  // into the service's own live value, exactly as reassigning the plain
  // property used to. `as never`/loose casts on the setter's incoming value
  // sidestep the same declared-type mismatch `Object.assign` used to
  // sidestep (see `App.refData`'s own loose `Json`-ish declared type).
  Object.defineProperty(app, 'refData', {
    get: () => catalog.refData,
    set: (v) => { catalog.refData = v as AssembledReference; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(app, 'completions', {
    get: () => catalog.completions,
    set: (v) => { catalog.completions = v as CompletionItem[]; },
    enumerable: true,
    configurable: true,
  });
  // `docCache` is a single Map instance the service owns and only ever
  // mutates in place (cleared/set), never reassigns — a direct property copy
  // of the reference (not a getter) stays valid for the object's lifetime,
  // matching the original `app.docCache = new Map()` assignment.
  app.docCache = catalog.docCache;
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

  // A ClickHouse HTTP session ties a tab's requests together so session state —
  // temporary tables, SET settings — survives across the separate HTTP requests
  // of a multiquery script (and across successive runs in the tab). ClickHouse's
  // HTTP interface runs one statement per request and is otherwise stateless, so
  // without this a `CREATE TEMPORARY TABLE …; INSERT …; SELECT …` script can't
  // see its own temp table. The id is per-tab (lazily minted) so tabs don't share
  // state and never collide on the per-session lock (only one query runs at a
  // time, guarded by `running`). No `session_timeout` override is needed:
  // ClickHouse resets the idle timer when each query is *released* (end of the
  // request, not the start) and cancels it while a query runs, so the default
  // (60s) never lapses between a script's back-to-back statements.
  function sessionParams(tab: QueryTab): { session_id: string } {
    tab.chSession = tab.chSession || uid('sess-');
    return { session_id: tab.chSession };
  }
  // Only TEMPORARY tables and session `SET`s need a session; permanent DDL/DML and
  // SELECTs are global. So we attach a session_id ONLY when the SQL needs one — or
  // when the tab already opened one (sticky, so a temp table / SET from an earlier
  // run stays visible to later runs in that tab). Ordinary scripts run session-LESS,
  // which avoids the session lock / replica-affinity reset that intermittently
  // surfaces as a "Network error". (Schema / reference loads are always
  // session-less — they fan out in parallel and would deadlock on the lock.)
  const needsSession = (sqls: string[]): boolean => sqls.some((s) => /\bTEMPORARY\b/i.test(s) || leadingKeyword(s) === 'SET');
  function sessionParamsFor(tab: QueryTab, sqls: string[]): Record<string, string> {
    return tab.chSession != null || needsSession(sqls) ? sessionParams(tab) : {};
  }
  // The `{name:Type}` query-variable POLICY — analyze/prepare/gate/execution-
  // view, the #170 hardening bookkeeping, the #172 v2 schema-cache enum-
  // suggestion inference, and the #171 recent-value + persistence policy —
  // now lives in `application/workbench-parameter-session.ts` (#276 Phase
  // 4B1), constructible without App/AppState/DOM. `renderVarStrip` (the DOM
  // view, below) and the workbench-session hooks + export block (further
  // down) call its methods directly; `app.hardenedVars` is aliased (not
  // copied) to its `Set` so `app.hardenedVars.has(...)` keeps working
  // unchanged. `sessionParams`/`needsSession`/`sessionParamsFor` above stay
  // HERE (they're `tab.chSession`/transport material, not parameter policy —
  // Phase 4C's concern).
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
  // Alias (not copy) — see `params`'s own construction comment above.
  app.hardenedVars = params.hardenedVars;
  app.saveVarValues = () => params.saveVarValues();
  app.saveFilterActive = () => params.saveFilterActive();
  app.saveVarRecent = () => params.saveVarRecent();
  app.saveVarRecentDisabled = () => params.saveVarRecentDisabled();
  app.recordBoundParams = (boundParams) => params.recordBoundParams(boundParams);
  app.clearVarRecent = (name) => params.clearVarRecent(name);
  app.clearAllVarRecent = () => params.clearAllVarRecent();

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
      loadSchema: () => { void app.loadSchema(); },
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
      loadSchema: () => { void app.loadSchema(); },
      recordHistory: (tab, sql) => app.recordHistory(tab, sql),
      recordBoundParams: (bp) => app.recordBoundParams([...bp]),
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
            app.saveVarValues();
            app.saveFilterActive();
            // Editing the value un-hardens it (#170 review): back to
            // neutral, lenient behavior until it's committed again.
            app.hardenedVars.delete(v.name);
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
          const onClearRecent = (): void => app.clearVarRecent(v.name);
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

  // Abort any in-flight schema-lineage fetch. Called both as a manual Cancel
  // (clearResult: true — the user asked to stop) and automatically whenever a
  // new operation takes over the drawer (a fresh graph request, or Run/Explain
  // replacing the tab's result outright) — in the automatic case the caller
  // overwrites tab.result itself right after, so aborting the network request
  // is all that's needed there (the identity guard in showSchemaGraph makes
  // this belt-and-suspenders, not load-bearing, for correctness).
  //
  // With clearResult, the visible result depends on how far the fetch got: if
  // Phase A (the free-edges graph) had already drawn, keep it on screen marked
  // `partial` (its view/MV source edges may be incomplete); otherwise there's
  // nothing worth keeping, so drop back to the normal empty-results placeholder.
  function cancelSchemaGraph({ clearResult = false }: { clearResult?: boolean } = {}): void {
    if (app.state.schemaGraphAbortController) app.state.schemaGraphAbortController.abort();
    app.state.schemaGraphAbortController = null;
    if (!clearResult) return;
    const tab = app.activeTab();
    const result = tab.result as QueryResult | null;
    const sg = result?.schemaGraph;
    if (!sg || !sg.loading) return;
    if (sg.nodes && sg.nodes.length) {
      sg.loading = false;
      sg.partial = true;
    } else {
      tab.result = null;
    }
    renderResults(app);
  }

  // Render the ClickHouse object-lineage graph for a dropped/clicked
  // database/table into the data pane (queries system.* + EXPLAIN AST; the
  // editor SQL is untouched). Two-phase on a large schema (#124): draws as soon
  // as the free edges (dependencies/target/engine-arg/dictionary) are known,
  // then a single second layout merges in view/MV source edges once EXPLAIN AST
  // settles — so the pane isn't blank for the whole round trip. Below
  // AST_PROGRESSIVE_THRESHOLD view/MV objects, loadSchemaLineage skips straight
  // to one draw instead (onBase/onProgress never fire) — a visible first paint
  // is just flicker when the whole fetch settles almost as fast anyway.
  async function showSchemaGraph(focus: SchemaFocus): Promise<void> {
    if (!focus || !focus.db) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    cancelSchemaGraph(); // a new click/drag replaces whatever graph was in flight
    const tab = app.activeTab();
    // Show a loading placeholder first — even Phase A (system.tables +
    // system.dictionaries) is a network round trip.
    const result: QueryResult = newResult('Table');
    result.schemaGraph = { focus, loading: true, nodes: [], edges: [] };
    Object.assign(tab, { result });
    // `result` is the stale-write guard (mirrors #97's identity-guard shape):
    // captured once, checked before every later write, so a Run/Explain or a
    // second graph request that replaces tab.result mid-fetch can never have
    // this call's (Phase A or Phase B) result land on the new tab.result.
    // `tab.result`'s declared type (state.ts's opaque `Record<string,unknown>
    // | null`) has no overlap with `QueryResult` for a direct `!==` — widen
    // `result` to `unknown` (not a further cast to another concrete type) for
    // the comparison only; the identity check itself is unaffected.
    const superseded = (): boolean => tab.result !== (result as unknown);
    renderResults(app);
    const controller = new AbortController();
    app.state.schemaGraphAbortController = controller;
    try {
      const lineage = await ch.loadSchemaLineage(chCtx, focus, {
        signal: controller.signal,
        onBase: (base) => {
          if (superseded()) return; // superseded before Phase A even landed
          const g = buildSchemaGraph(base, focus);
          result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (base.tables || []).length, loading: true };
          renderResults(app);
        },
        onProgress: (done, total) => {
          if (superseded() || !result.schemaGraph || !result.schemaGraph.loading) return;
          result.schemaGraph.progress = { done, total };
          renderResults(app);
        },
      });
      if (superseded()) return; // superseded while Phase B was resolving
      const g = buildSchemaGraph(lineage, focus);
      // tableCount lets the renderer explain an empty result ("N tables, none linked").
      result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (lineage.tables || []).length };
    } catch (e) {
      // AbortError means cancelSchemaGraph() already left the pane in a clean
      // state (partial graph or the empty placeholder) — nothing more to do.
      if (e instanceof Error && e.name === 'AbortError') return;
      if (superseded()) return;
      const errorResult: QueryResult = newResult('Table');
      errorResult.error = String((e instanceof Error && e.message) || e);
      Object.assign(tab, { result: errorResult });
    } finally {
      if (app.state.schemaGraphAbortController === controller) app.state.schemaGraphAbortController = null;
    }
    renderResults(app);
  }

  // Open the schema lineage fullscreen with RICH cards. Lazily fetches a separate
  // enriched dataset (the inline pane stays compact and untouched): re-loads
  // lineage + the per-table column / skip-index metadata (best-effort), attaches a
  // card model to each node, then opens the overlay. Re-fetch (vs reusing the inline
  // result) keeps the inline path's shape frozen and the card data off the hot path.
  // net/ch-client.ts's `CardColumnRow` (the real loader shape) has no index
  // signature; core/schema-cards.ts's `SchemaCardColumnRow` (the shape
  // `buildCardGraph` needs) does — reconstructing each row as a fresh object
  // literal satisfies it directly (every field the card model reads is
  // already there; nothing here changes what's read or its values).
  const toCardColumns = (byKey: Record<string, ch.CardColumnRow[]>): Record<string, SchemaCardColumnRow[]> => {
    const out: Record<string, SchemaCardColumnRow[]> = {};
    for (const [key, rows] of Object.entries(byKey)) out[key] = rows.map((row) => ({ ...row }));
    return out;
  };
  async function expandSchemaGraph(focus: SchemaFocus): Promise<void> {
    if (!focus || !focus.db) return;
    // Pin the result whose Expand was clicked NOW: a tab switch during the async
    // fetch must not redirect the saved-positions map to a different tab's result.
    const clickedTab = app.activeTab();
    const clickedResult = clickedTab.result as QueryResult | null;
    const sg = clickedResult?.schemaGraph || null;
    // Open the view synchronously so a real tab survives the click gesture (a
    // pop-up opened after an await is blocked); fill it once the lineage loads.
    const view = openSchemaView(app as DetachedGraphApp);
    // Everything after the synchronous open is wrapped: a token-refresh rejection,
    // a lineage/cards fetch failure, or a graph-build throw must surface in the view
    // (fail) instead of leaving the just-opened tab/overlay stranded on "Loading…".
    try {
      await ensureConfig();
      if (!(await getToken())) { chCtx.onSignedOut(); view.fail('Sign in to view the schema graph.'); return; }
      // Walk lineage transitively across DB boundaries (soft-capped) — pulls in
      // objects an other database references, instead of dead-ending at the edge.
      const lineage = await ch.loadLineageTransitive(chCtx, focus);
      const g = buildSchemaGraph(lineage.rows, focus);
      // Fresh node/edge literals (`{...n}`): `SchemaGraphNode` (buildSchemaGraph's
      // fixed-field output) has no index signature; `ExpandLineageNode` (what
      // expandLineage's graph needs) does — every field it reads is already there.
      const ex = expandLineage({ nodes: g.nodes.map((n) => ({ ...n })), edges: g.edges }, focus.db); // closure around focus.db, tags external nodes
      // Card metadata for every database the expansion reached (external nodes too).
      const dbs = [...new Set(ex.nodes.map((n) => n.db).filter(Boolean))];
      const cards = await ch.loadSchemaCards(chCtx, dbs);
      const cardGraph = buildCardGraph({ nodes: ex.nodes, edges: ex.edges },
        { tables: lineage.rows.tables, columnsByKey: toCardColumns(cards.columnsByKey) });
      // Persist manually-moved node positions per result: the map hangs off the live
      // schemaGraph result (captured above) so re-opening keeps the layout.
      const positions = (sg && sg.savedPositions) || {};
      if (sg) sg.savedPositions = positions;
      // Every real lineage/expansion node always carries `id`/`label` (schema-
      // graph.ts's `SchemaGraphNode`/`ExpandLineageNode`, both required there);
      // schema-cards.ts's own `CardGraphNode` widens them to optional for a
      // bare test fixture — reasserted here to match explain-graph.ts's
      // `SchemaLineageNode` (also required, for the SVG drawer's own layout).
      const nodes: SchemaLineageNode[] = cardGraph.nodes.map((n) => ({ ...n, id: n.id!, label: n.label! }));
      // `tableCount` isn't part of `SchemaViewController.render`'s
      // `SchemaLineageGraph` contract — only results.ts's OWN inline-pane
      // progress bookkeeping (`ResultSchemaGraph.tableCount`) reads it; the
      // fullscreen `render()`/`makeController` never did, so it never
      // travelled past this call.
      view.render({
        nodes, edges: cardGraph.edges, focus,
        truncated: lineage.truncated || ex.truncated,
        savedPositions: positions,
      });
    } catch {
      view.fail('Could not load the schema graph');
    }
  }

  // Open the detail pane for a clicked fullscreen node: lazily load the table's full
  // columns / partitions / DDL (best-effort) and mount the pane in the overlay.
  // Keyed per overlay document (same resolution as openDetailPane's own `doc`) so a
  // slow fetch for an earlier click can't clobber a newer pane once it resolves —
  // last-clicked wins, not last-resolved (#97).
  const latestDetailRequest = new WeakMap<Document, SchemaFocus>();
  async function openNodeDetail(node: SchemaFocus, targetDoc?: Document): Promise<void> {
    if (!node || !node.db || !node.name) return;
    const overlayDoc = targetDoc || (app && app.document) || document;
    latestDetailRequest.set(overlayDoc, node);
    openDetailPane(app, node as DetailNode, { columns: 'loading' }, targetDoc);
    const detail = await ch.loadTableDetail(chCtx, node.db, node.name);
    if (latestDetailRequest.get(overlayDoc) !== node) return; // superseded by a later click
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
    app.savePref('resultRowLimit', app.state.resultRowLimit);
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
  app.recordHistory = (tab, sqlText) => {
    // `tab.result` is state.ts's deliberately opaque `Record<string,unknown> |
    // null` — by the time recordHistory is ever called (only after a
    // successful run), it already holds a real `QueryResult`-shaped value
    // (rawText/rows/progress.elapsed_ns), the exact fields `HistoryResultSnapshot`
    // pins. `| null` on both sides of the cast keeps it a legal single-step
    // widen; `!` then asserts the same "already ran successfully" guarantee
    // the untyped original relied on implicitly.
    const result = (tab.result as HistoryResultSnapshot | null)!;
    recordHistory(app.state, { sqlDraft: tab.sqlDraft, result }, saveJSON, undefined, sqlText);
    if (app.state.sidePanel.value === 'history') renderSavedHistory(app);
  };

  // --- share + star ------------------------------------------------------
  function share() {
    const tab = app.activeTab();
    if (tab.editorMode !== 'sql') return;
    const evaluated = evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
    if (!evaluated.parsed || hasBlockingSpecErrors(evaluated.diagnostics)) {
      flashToast('Fix Spec errors before sharing', { document: doc });
      return;
    }
    const sql = String(tab.sqlDraft || '');
    const panel = queryPanel({ spec: evaluated.parsed });
    // The gate matches the decode side (main.js): sql OR panel — a text panel
    // legitimately has no SQL, and a sql-only check would make it unshareable.
    if (!sql.trim() && !isQuerylessPanel(panel)) return;
    const query = withQuerySpec({ id: tab.savedId, sql }, evaluated.parsed);
    const url = loc.origin + loc.pathname + loc.search + '#' + encodeShare(query);
    win.history && win.history.replaceState && win.history.replaceState(null, '', url);
    const clip = (env.navigator || win.navigator || {}).clipboard;
    if (clip && clip.writeText) {
      clip.writeText(loc.href || url)
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

  function commitLinkedQuery(): SavedQueryV2 | null {
    const tab = app.activeTab();
    const evaluated = evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
    if (!evaluated.parsed || hasBlockingSpecErrors(evaluated.diagnostics)) {
      app.revealFirstSpecError(tab);
      flashToast('Fix Spec errors before saving', { document: doc });
      return null;
    }
    const panel = queryPanel({ spec: evaluated.parsed });
    if (!String(tab.sqlDraft || '').trim() && !isQuerylessPanel(panel)) {
      flashToast('Nothing to save', { document: doc });
      return null;
    }
    const entry = commitSavedQuery(app.state, tab, evaluated.parsed as QuerySpecDraft | null, saveJSON, app.specValidators);
    if (!entry) return null;
    app.revalidateSpecDrafts();
    app.specEditor.syncFromState();
    app.updateSaveBtn();
    app.actions.rerenderTabs();
    renderSavedHistory(app);
    renderResults(app);
    app.updateEditorModeUi!();
    flashToast('Saved', { document: doc });
    return entry;
  }

  function saveActiveQuery(): SavedQueryV2 | null | undefined {
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
    const commit = (): void => {
      if (!input.value.trim()) return;
      const entry = createSavedQuery(app.state, tab, input.value, descInput.value, saveJSON, Date.now(), app.specValidators);
      if (!entry) return;
      close();
      app.revalidateSpecDrafts();
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
      evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
      app.specEditor.revealDiagnostic(0);
      return;
    }
    app.specEditor.replaceDocument(formatted.text);
  }

  function setEditorMode(mode: 'sql' | 'spec'): boolean {
    const tab = app.activeTab();
    if (mode === 'spec' && !savedForTab(app.state, tab)) {
      flashToast('Save this query to create an editable Spec.', { document: doc });
      return false;
    }
    if (mode !== 'sql' && mode !== 'spec') return false;
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
      h('div', { class: 'um-id' }, app.email()),
      logoutBtn,
      h('div', { class: 'um-build', title: 'App version / build' }, app.build));
    ({ close } = anchoredPopover(menu, app.dom.userBtn!, 'userMenu'));
    setTimeout(() => logoutBtn.focus());
  }
  app.openUserMenu = openUserMenu;

  function toggleTheme(): void {
    app.state.theme = app.state.theme === 'dark' ? 'light' : 'dark';
    app.savePref('theme', app.state.theme);
    doc.documentElement.setAttribute('data-theme', app.state.theme);
    if (app.dom.themeBtn) app.dom.themeBtn.replaceChildren(app.state.theme === 'dark' ? Icon.sun() : Icon.moon());
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

  // Open the dashboard in a new tab and stand ready to hand it our credentials
  // — the cross-tab auth-handoff GRANT side itself is the session's job now
  // (`conn.grantHandoffTo`, #276 Phase 2); this stays app-side only because
  // opening the tab (window.open) is a DOM/browser concern.
  function openDashboard(): void {
    const child = app.openWindow(loc.origin + conn.basePath + '/dashboard');
    if (child) conn.grantHandoffTo(child);
  }
  app.openDashboard = openDashboard;

  // --- actions registry --------------------------------------------------
  app.actions = {
    run: (opts) => workbench.runEntry(opts),
    cancel: () => workbench.cancel(),
    newTab: () => newTab(app),
    selectTab: (id) => selectTab(app, id),
    closeTab: (id) => closeTab(app, id),
    loadIntoNewTab: (queryOrName, sql) => { loadIntoNewTab(app, queryOrName, sql); toEditorOnMobile(); },
    login: (idpId, targetOrigin) => conn.beginOAuth(idpId, targetOrigin),
    connect: async (input) => { await conn.connectBasic(input); app.renderApp(); },
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

/** Build the signed-in shell and mount all regions. */
export function renderApp(app: App, helpers: RenderAppHelpers): void {
  const { state, document: doc } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);

  app.dom = {};
  app.dom.connStatus = h('div', { class: 'conn-status dim' }, h('span', { class: 'ver' }, 'Connecting…'));
  app.dom.themeBtn = h('button', { class: 'hd-btn', title: 'Toggle theme', onclick: helpers.toggleTheme });
  app.dom.themeBtn.appendChild(state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.userBtn = h('button', { class: 'hd-btn user-btn', title: app.email(), onclick: () => app.actions.openUserMenu() },
    h('span', { class: 'user-short' }, userShortName(app.email())), Icon.chevDown());
  const header = h('div', { class: 'app-header' },
    h('div', { class: 'logo-mark' }, Icon.brand()),
    h('div', { class: 'logo-name' }, 'Altinity® SQL Browser'),
    h('div', { class: 'env-chip' }, app.host()),
    h('div', { class: 'hd-divider' }),
    ...libraryControls(app),
    h('div', { style: { flex: '1' } }),
    app.dom.connStatus,
    h('a', {
      // hd-hide-mobile: decorative/desktop-only header items are hidden below the
      // breakpoint (#126) so the essential controls (File menu, theme, user menu)
      // fit a phone width instead of overflowing off-screen. See styles.css.
      class: 'hd-btn hd-hide-mobile', href: 'https://github.com/Altinity/altinity-sql-browser/tree/main/examples',
      target: '_blank', rel: 'noopener noreferrer', title: 'View examples',
    }, Icon.github()),
    h('button', { class: 'hd-btn hd-hide-mobile', title: 'Keyboard shortcuts (?)', onclick: () => app.actions.openShortcuts() }, Icon.shortcuts()),
    app.dom.themeBtn,
    app.dom.userBtn);

  app.dom.schemaSearchInput = h('input', {
    type: 'text', placeholder: 'Search tables, columns…',
    oninput: (e: Event) => { state.schemaFilter.value = (e.target as HTMLInputElement).value; },
  });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  const schemaPane = h('div', { class: 'side-pane schema-pane', style: { height: state.sideSplitPct + '%', flexShrink: '0', minHeight: '0' } },
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList);

  app.dom.savedTabsRow = h('div', { class: 'side-tabs' });
  app.dom.savedSearch = h('div', { class: 'saved-search' });
  app.dom.savedList = h('div', { class: 'saved-list' });
  const savedPane = h('div', { class: 'side-pane saved-pane', style: { flex: '1', minHeight: '0' } }, app.dom.savedTabsRow, app.dom.savedSearch, app.dom.savedList);

  const sidebar = h('div', { class: 'sidebar', style: { width: state.sidebarPx + 'px' } });
  const rectFor = (axis: SplitterAxis): DragRect => {
    if (axis === 'sideRow') return sidebar.getBoundingClientRect();
    return { top: app.dom.editorRegion!.getBoundingClientRect().top, bottom: app.dom.resultsRegion!.getBoundingClientRect().bottom };
  };
  const dragCtx: DragCtx = {
    state,
    rectFor,
    apply: (axis, value) => {
      if (axis === 'col') sidebar.style.width = value + 'px';
      else if (axis === 'sideRow') schemaPane.style.height = value + '%';
      else app.dom.editorRegion!.style.height = value + '%';
    },
    save: (name, value) => app.savePref(name, value),
  };
  app.dom.sideSplit = h('div', { class: 'row-resize side-split', onmousedown: (e: DragStartEvent) => helpers.startDrag(e, 'sideRow', dragCtx) });
  // Mobile Tables view (#126): a Schema | Library segmented control at the top of
  // the sidebar. CSS hides it above the breakpoint; below it, it swaps which pane
  // shows (the sidebar's data-mobile-tab drives both the active-button style and
  // the pane visibility — no JS effect needed for the active state).
  app.dom.mobileSegmented = h('div', { class: 'mobile-segmented' },
    h('button', { class: 'mseg-btn', 'data-seg': 'schema', onclick: () => { state.mobileTab.value = 'schema'; } }, Icon.database(), h('span', null, 'Schema')),
    h('button', { class: 'mseg-btn', 'data-seg': 'library', onclick: () => { state.mobileTab.value = 'library'; } }, Icon.layers(), h('span', null, 'Queries')));
  sidebar.append(app.dom.mobileSegmented, schemaPane, app.dom.sideSplit, savedPane);
  const sideHandle = h('div', { class: 'col-resize', onmousedown: (e: DragStartEvent) => helpers.startDrag(e, 'col', dragCtx) });

  app.dom.qtabsInner = h('div', { class: 'qtabs-inner' });
  const qtabsRow = h('div', { class: 'qtabs' }, app.dom.qtabsInner,
    h('button', { class: 'new-tab', title: 'New query', onclick: () => app.actions.newTab() }, Icon.plus()));

  app.dom.runBtn = h('button', { class: 'run-btn', onclick: () => app.actions.run() }, Icon.play(), h('span', null, 'Run'), h('kbd', null, '⌘↵'));
  app.dom.fmtBtn = h('button', { class: 'tb-btn', title: 'Format SQL (⌘⇧↵)', onclick: () => app.actions.formatQuery() }, Icon.braces(), 'Format');
  app.dom.explainBtn = h('button', { class: 'tb-btn', title: 'Explain this query (plan, indexes, pipeline, estimate)', onclick: () => app.actions.explainQuery() }, Icon.plan(), 'Explain');
  app.dom.formatSpecBtn = h('button', { class: 'tb-btn spec-action', title: 'Format Spec JSON (⌘⇧↵)', onclick: () => app.actions.formatSpec() }, Icon.braces(), 'Format');
  app.dom.saveBtn = h('button', { class: 'tb-btn save-btn', onclick: () => app.actions.save() });
  app.dom.sqlModeBtn = h('button', { class: 'editor-mode-btn', onclick: () => app.actions.setEditorMode('sql'), 'aria-pressed': 'true' }, 'SQL');
  app.dom.specModeBtn = h('button', { class: 'editor-mode-btn', onclick: () => app.actions.setEditorMode('spec'), 'aria-pressed': 'false' }, 'Spec');
  app.dom.editorModeSwitch = h('div', { class: 'editor-mode-switch', role: 'group', 'aria-label': 'Editor mode' }, app.dom.sqlModeBtn, app.dom.specModeBtn);
  // Chromium + secure-context only (app.canExport), and disabled while one is
  // already running (app.state.exporting — see setExportBtn's effect below).
  // Aria-disabled with a tooltip rather than natively `disabled` — a natively
  // disabled button swallows pointer events, so its title tooltip often never
  // shows, exactly where a "why is this greyed out?" explanation matters most.
  app.dom.exportBtn = h('button', {
    class: 'tb-btn', onclick: () => app.actions.exportEntry(),
  }, Icon.download(), 'Export');
  app.dom.shareBtn = h('button', { class: 'tb-btn', title: 'Share query (copies link)', onclick: () => app.actions.share() }, Icon.share(), 'Share');

  const editorToolbar = h('div', { class: 'ed-toolbar' },
    app.dom.runBtn, app.dom.fmtBtn, app.dom.explainBtn,
    app.dom.formatSpecBtn,
    app.dom.saveBtn, app.dom.editorModeSwitch,
    h('div', { style: { flex: '1' } }), app.dom.exportBtn, app.dom.shareBtn);
  // Query-variable strip (#134): one input per detected {name:Type} placeholder,
  // in a single row that scrolls horizontally (never wraps) when there are many.
  // Hidden (no vertical space) until the active tab has variables — see
  // renderVarStrip. Sits below the toolbar so it doesn't compete with the
  // splitter-sized editor for height.
  app.dom.varStrip = h('div', { class: 'var-strip', style: { display: 'none' } });
  app.dom.sqlEditorHost = h('div', { class: 'document-editor sql-document-editor' });
  app.dom.specEditorHost = h('div', { class: 'document-editor spec-document-editor' });
  app.dom.specStatus = h('div', { class: 'spec-status', role: 'status', 'aria-live': 'polite' });
  app.dom.specPane = h('div', { class: 'spec-editor-pane' }, app.dom.specEditorHost, app.dom.specStatus);
  app.dom.editorRegion = h('div', { class: 'editor-region', style: { height: state.editorPct + '%', minHeight: '0', overflow: 'hidden', flexShrink: '0' } },
    app.dom.sqlEditorHost, app.dom.specPane);
  app.dom.resultsRegion = h('div', { class: 'results-region', style: { flex: '1', minHeight: '0', overflow: 'hidden' } });
  // Drop a database/table from the schema tree here → render its lineage graph.
  // Disabled in mobile mode (#126): native drag doesn't fire from touch, and the
  // schema tree drops its drag sources below the breakpoint, so accepting a drop
  // here would be a dead affordance. (Clicking a db row still draws the graph via
  // showSchemaGraph — #124's tap-native trigger — so nothing is lost.)
  app.dom.resultsRegion.addEventListener('dragover', (e) => {
    if (state.isMobile.value) return;
    if (e.dataTransfer && [...e.dataTransfer.types].includes(SCHEMA_GRAPH_MIME)) e.preventDefault();
  });
  app.dom.resultsRegion.addEventListener('drop', (e) => {
    if (state.isMobile.value) return;
    const payload = e.dataTransfer && e.dataTransfer.getData(SCHEMA_GRAPH_MIME);
    if (!payload) return;
    e.preventDefault();
    try { app.actions.showSchemaGraph(JSON.parse(payload)); } catch { /* malformed payload */ }
  });
  app.dom.editorResultsSplit = h('div', { class: 'row-resize', onmousedown: (e: DragStartEvent) => helpers.startDrag(e, 'row', dragCtx) });

  const workbench = h('div', { class: 'workbench' }, qtabsRow, editorToolbar, app.dom.varStrip, app.dom.editorRegion, app.dom.editorResultsSplit, app.dom.resultsRegion);
  app.dom.banner = h('div', { class: 'auth-banner', style: { display: 'none' } });
  const mainRow = h('div', { class: 'main-row' }, sidebar, sideHandle, workbench);

  // Mobile bottom-tab nav (#126): one full-screen panel at a time. CSS hides it
  // above the breakpoint; below it, `mainRow[data-mobile-view]` (set by the
  // effect below) picks which of sidebar / editor / results fills the screen.
  // The Results tab carries a live badge (row count, or ● while a query streams).
  app.dom.mobileBadge = h('span', { class: 'mnav-badge' });
  const navBtn = (view: string, icon: SVGElement, label: string, extra?: HTMLElement): HTMLButtonElement => h('button', {
    class: 'mobile-nav-btn', 'data-view': view, onclick: () => { state.mobileView.value = view as 'tables' | 'editor' | 'results'; },
  }, h('span', { class: 'mnav-ic' }, icon, extra || null), h('span', { class: 'mnav-label' }, label));
  app.dom.mobileNav = h('div', { class: 'mobile-nav' },
    navBtn('tables', Icon.database(), 'Tables'),
    navBtn('editor', Icon.code(), 'Editor'),
    navBtn('results', Icon.table2(), 'Results', app.dom.mobileBadge));

  app.root!.replaceChildren(header, app.dom.banner, mainRow, app.dom.mobileNav);

  app.sqlEditor.mount(app.dom.sqlEditorHost!);
  app.specEditor.mount(app.dom.specEditorHost!);
  app.updateEditorModeUi = () => {
    const tab = app.activeTab();
    const linked = !!savedForTab(state, tab);
    if (!linked && tab.editorMode === 'spec') tab.editorMode = 'sql';
    const specMode = tab.editorMode === 'spec';
    app.dom.sqlEditorHost!.hidden = specMode;
    app.dom.specPane!.hidden = !specMode;
    for (const button of [app.dom.runBtn!, app.dom.fmtBtn!, app.dom.explainBtn!]) button.hidden = specMode;
    app.dom.formatSpecBtn!.hidden = !specMode;
    for (const button of [app.dom.exportBtn!, app.dom.shareBtn!]) button.hidden = specMode;
    app.dom.sqlModeBtn!.classList.toggle('active', !specMode);
    app.dom.specModeBtn!.classList.toggle('active', specMode);
    app.dom.sqlModeBtn!.setAttribute('aria-pressed', String(!specMode));
    app.dom.specModeBtn!.setAttribute('aria-pressed', String(specMode));
    app.dom.specModeBtn!.classList.toggle('is-disabled', !linked);
    app.dom.specModeBtn!.setAttribute('aria-disabled', String(!linked));
    app.dom.specModeBtn!.title = linked ? 'Edit saved-query Spec JSON' : 'Save this query to create an editable Spec.';
    // `tab.specDiagnostics`'s declared `SpecDiagnostic` (editor/spec-editor.
    // types.ts) doesn't carry `line`/`column` — but every diagnostic actually
    // stored there came from `evaluateSpecText`'s real `SpecValidationDiagnostic`
    // (core/spec-draft.js), which does (the JSON-syntax diagnostic in
    // particular always sets them). Widened locally rather than touching that
    // shared editor contract.
    const errors = (tab.specDiagnostics as (SpecDiagnostic & { line?: number; column?: number })[] | undefined)
      ?.filter((item) => item.severity === 'error') || [];
    const diagnostic = errors[0];
    app.dom.specStatus!.className = 'spec-status' + (diagnostic ? ' is-error' : '');
    app.dom.specStatus!.hidden = !diagnostic;
    app.dom.specStatus!.textContent = diagnostic
      ? `${diagnostic.line ? `Line ${diagnostic.line}, column ${diagnostic.column}: ` : ''}${diagnostic.message}${errors.length > 1 ? ` — ${errors.length} errors` : ''}`
      : '';
    app.dom.shareBtn!.disabled = app.specBlocked(tab);
    app.dom.shareBtn!.title = app.specBlocked(tab) ? 'Fix blocking Spec errors before sharing' : 'Share query (copies link)';
    app.dom.varStrip!.hidden = specMode;
    app.updateSaveBtn();
  };
  // Reactive repaint of the tab-dependent surface — replaces the old tabs.js
  // refresh(): re-runs whenever the tab list or active tab changes, so tab ops
  // just mutate the signals.
  effect(() => {
    app.state.tabs.value;
    app.state.activeTabId.value;
    app.revalidateSpecDrafts({ refreshUi: false });
    renderTabs(app);
    app.sqlEditor.syncFromState();
    app.specEditor.syncFromState();
    app.updateSaveBtn();
    app.renderVarStrip(); // switching tabs / opening a saved query re-detects variables
    app.updateEditorModeUi!(); // assigned just above, unconditionally, before any effect can run
  });
  // The workbench's 3 run-coupled reactive effects (#276 Phase 3a — see
  // workbench-session.ts's own `attachShell`): the results-pane repaint
  // (re-runs on a tab switch, a Table/JSON/Chart view change, or a run-state
  // flip — renderResults' activeTab() also reads tabs.value, so a tab-list
  // change repaints here too; streaming-data repaints still call renderResults
  // directly from the session's own onChunk), the Run button (label + disabled,
  // reflecting the run state and the selection — Run ↔ Run selection), and the
  // mobile Results-nav badge (● while a query streams, else the row count).
  // Idempotent: re-registers (disposing the previous set) on every renderApp()
  // re-run.
  app.workbench.attachShell({
    renderResults: () => renderResults(app),
    setRunBtn: (running) => app.setRunBtn(running),
    setMobileBadge: () => {
      const r = app.activeTab().result as QueryResult | null;
      app.dom.mobileBadge!.textContent = state.running.value
        ? '●'
        : (r && r.rawText == null && r.progress ? formatRows(r.progress.rows) : '');
    },
  });
  // The Export button reflects the exporting state — set here (not just at
  // click-time) so a second click while one export is already running is
  // blocked visually too, not just by exportDirect's own re-entrance guard.
  effect(() => { app.setExportBtn(app.state.exporting.value); });
  // Track the editor's text selection into a signal so the Run button label and
  // ⌘+Enter target just the highlighted text. `selectionchange` is the one event
  // that fires for keyboard, mouse, and programmatic selection; gate on the
  // editor being focused so selecting elsewhere (results, address bar) is ignored.
  app.syncSelection = () => {
    const sel = app.sqlEditor.hasFocus() ? app.sqlEditor.getSelection().text : '';
    app.state.hasSelection.value = sel.trim() !== '';
  };
  app.document.addEventListener('selectionchange', app.syncSelection);
  // Reactive repaint of the schema tree — replaces the scattered renderSchema()
  // calls: re-runs on schema load, load error, filter text, or expand/collapse.
  // Registered here (post-mount) so app.dom.schemaList already exists; the effect
  // also runs once now for the initial paint.
  effect(() => {
    app.state.schema.value;
    app.state.schemaError.value;
    app.state.schemaFilter.value;
    app.state.expanded.value;
    // Crossing the mobile breakpoint (#126) adds/removes each row's drag source
    // and hover title, so repaint the tree when isMobile flips.
    app.state.isMobile.value;
    renderSchema(app);
  });
  // The schema/auth-failure banner reflects schemaError (a separate surface).
  effect(() => {
    app.state.schemaError.value;
    app.updateBanner();
  });
  // Reactive repaint of the side panel: re-runs when the active panel changes
  // (Library ↔ History). Data-driven repaints (savedQueries/history mutations)
  // still call renderSavedHistory directly until those slices are signals too.
  effect(() => {
    app.state.sidePanel.value;
    renderSavedHistory(app);
  });
  // Reactive repaint of the header library title (name + unsaved-changes dot):
  // re-runs when the name or dirty flag changes. The edit-mode toggle is driven
  // separately (editingLibrary is not a signal — file-menu.js renders it directly).
  effect(() => {
    app.state.libraryName.value;
    app.state.libraryDirty.value;
    renderLibraryTitle(app);
  });
  // Mobile mode (#126): mirror the viewport width into `isMobile` (drives the
  // schema tree's drag/hover affordances, the results drop target, and the
  // auto-navigation in the action wrappers) via the injected matchMedia seam.
  // When the platform has no matchMedia the app stays in desktop JS mode — the
  // mobile CSS still applies, just without JS branching.
  const mq = app.matchMedia && app.matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
  if (mq) {
    state.isMobile.value = mq.matches;
    mq.addEventListener('change', (e) => { state.isMobile.value = e.matches; });
  }
  // Bottom-nav view switching: reflect the active mobile panel + Tables segmented
  // choice onto data-attributes the mobile CSS keys off (a no-op above the
  // breakpoint). Each runs once now for the initial paint.
  effect(() => { mainRow.dataset.mobileView = state.mobileView.value; });
  effect(() => { sidebar.dataset.mobileTab = state.mobileTab.value; });
  app.loadVersion();
  app.loadSchema();
  app.loadReference();
}
