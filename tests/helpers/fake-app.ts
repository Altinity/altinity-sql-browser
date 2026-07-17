// Shared test helper: a full `App`-contract test double for exercising the UI
// render modules in isolation under happy-dom. Not under src/, so it does not
// count toward coverage.
//
// `makeApp(overrides)` layers three sources into ONE object literal, in this
// order (a later key always wins on both VALUE and TYPE — the same
// last-spread-wins convention every per-file `appDefaults`/`withApp` pair this
// helper now replaces relied on, never `Object.assign`'s widening `T & U`
// intersection):
//   1. `appDefaults` — every `App` member this file's own concrete stubs (2)
//      don't cover, filled with an inert placeholder (never read by a fixture
//      that doesn't override it).
//   2. the concrete stubs below (`state`/`root`/`sqlEditor`/the `vi.fn()`
//      actions/…) — this helper's long-standing real fixture values.
//   3. `overrides` — generic in `O`, so a caller's own mock keeps its exact
//      call-site type (e.g. a 2-arg `exec.executeRead` spy) instead of
//      collapsing to `App`'s declared (argument-erased) method signature.
// `dom`/`chCtx`/`actions`/`exec` are nested objects, merged the same three-way
// (defaults, stubs, override) so a caller overriding e.g. `chCtx: { onSignedOut }`
// or `exec: { executeRead }` never has to re-spread the other sibling fields.
import { vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { createState, activeTab } from '../../src/state.js';
import { createNoopPort } from '../../src/editor/editor-port.js';
import { createNoopSpecEditor } from '../../src/editor/spec-editor.js';
import type { App, ActionsRegistry, AppDom, ChCtx } from '../../src/ui/app.types.js';
import type { AppState } from '../../src/state.js';
import type { ConfigDoc, ResolvedIdpConfig } from '../../src/net/oauth-config.js';
import type { StreamResult } from '../../src/core/stream.js';
import type { ChartJsConfigResult } from '../../src/core/chart-data.js';
import type { ChartInstance } from '../../src/ui/chart-render.js';
import type { QueryExecutionService } from '../../src/application/query-execution-service.js';
import type { ConnectionSession } from '../../src/application/connection-session.js';
import type { SchemaCatalogService } from '../../src/application/schema-catalog-service.js';
import type { SchemaGraphSession } from '../../src/application/schema-graph-session.js';
import type { AppPreferences } from '../../src/application/app-preferences.js';
import type { WorkbenchSession } from '../../src/ui/workbench/workbench-session.js';
import type { WorkbenchParameterSession } from '../../src/application/workbench-parameter-session.js';
import type { ExportService } from '../../src/application/export-service.js';
import type { QueryDocumentSession } from '../../src/application/query-document-session.js';
import type {
  SavedQueryService, CreateSavedResult, CommitLinkedResult, ShareResult,
} from '../../src/application/saved-query-service.js';
import { assembleReferenceData, buildCompletions } from '../../src/core/completions.js';
import type { AssembledReference } from '../../src/core/completions.js';

// Production invariant (#276 Phase 2): `app.chCtx` and `app.conn.chCtx` are
// THE SAME live object (app.ts aliases `conn.chCtx`) — the defaults + the
// makeApp merge below preserve that identity so a fixture mutation through
// either alias observes shared state, exactly like the real app.
const chCtxDefaults: ChCtx = {
  fetch, origin: '', authConfirmed: true,
  getToken: async () => null, refresh: async () => false, authHeader: () => '', onSignedOut: () => {},
};

// A minimal `ConnectionSession` stub (#276 Phase 2) — every render-module test
// exercises `app.conn` only incidentally (through the `App`-level auth
// delegates it backs, e.g. `isSignedIn`/`email`/`ensureConfig`), never
// directly; this is inert, never-called-by-default plumbing so `appDefaults`
// still satisfies the full `App` contract.
const connDefaults: ConnectionSession = {
  basePath: '',
  hostHint: '',
  chCtx: chCtxDefaults,
  token: () => null,
  refreshToken: () => null,
  authMode: () => 'basic',
  idpId: () => null,
  chAuth: () => 'basic',
  basicUserClaim: () => 'sub',
  isSignedIn: () => true,
  email: () => '',
  host: () => '',
  loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [] }) as ConfigDoc,
  selectIdp: () => {},
  resolveConfig: async () => ({}) as ResolvedIdpConfig,
  ensureConfig: async () => null,
  setTokens: () => {},
  getToken: async () => null,
  beginOAuth: async () => {},
  connectBasic: async () => {},
  signOut: () => {},
  ensureFreshToken: async () => true,
  grantHandoffTo: () => {},
  receiveAuthHandoff: async () => false,
};

// A stand-in for the Chart.js constructor: records its canvas + config and
// exposes a destroy() spy, so the chart glue is testable without a real
// canvas. `config`'s type is `chartJsConfig`'s real return shape (the only
// shape `new app.Chart(canvas, config)` is ever called with in production —
// see chart-render.ts) so tests can read `chart.config.data.datasets[...]`/
// `.options...` etc. without a cast.
export class FakeChart implements ChartInstance {
  canvas: HTMLCanvasElement;
  config: ChartJsConfigResult;
  destroyed = false;
  lastResize?: [number, number];
  lastUpdateMode?: string;
  constructor(canvas: HTMLCanvasElement, config: ChartJsConfigResult) {
    this.canvas = canvas;
    this.config = config;
  }
  // Real Chart.js's resize()/update() — results.js calls these explicitly to
  // work around cross-window responsive-sizing (see renderChart's comment).
  resize(w: number, h: number): void { this.lastResize = [w, h]; }
  update(mode: string): void { this.lastUpdateMode = mode; }
  destroy(): void { this.destroyed = true; }
}

// A minimal `WorkbenchSession` stub (#276 Phase 3a) — no render-module fixture
// exercises the session's own run/cancel orchestration directly (that's
// workbench-session.test.ts's job); this just satisfies the `App.workbench`
// contract. const-first (not inlined below): a `vi.fn()` written directly
// inside a nested object literal loses its mock-specific type to the
// surrounding literal's contextual typing (a known inference footgun) — see
// this file's own header note on `exec`/`chCtx`.
const workbenchDefaults: WorkbenchSession = {
  run: vi.fn(async () => {}),
  runScript: vi.fn(async () => {}),
  runEntry: vi.fn(),
  cancel: vi.fn(),
  elapsedMs: () => 0,
  attachShell: vi.fn(),
  destroy: vi.fn(),
};

// A minimal `SchemaCatalogService` stub (#276 Phase 4A) — no render-module
// fixture exercises the service directly (that's schema-catalog-service.test.ts's
// job); `App`'s own top-level `refData`/`completions`/`docCache`/`entityDoc`/
// `loadVersion`/`loadSchema`/`loadReference` stubs below are independent of
// this (same dual pattern as `conn` vs. the top-level auth delegates) — this
// just satisfies the `App.catalog` contract. `refData`/`completions` use the
// real built-in fallback (`assembleReferenceData(null)`/`buildCompletions`)
// rather than a cast, so they stay structurally real `AssembledReference`/
// `CompletionItem[]` values.
const catalogRefDataDefault: AssembledReference = assembleReferenceData(null);
const catalogDefaults: SchemaCatalogService = {
  loadVersion: vi.fn(async () => {}),
  loadSchema: vi.fn(async () => {}),
  loadColumns: vi.fn(async () => {}),
  loadReference: vi.fn(async () => {}),
  rebuildCompletions: vi.fn(),
  entityDoc: vi.fn(async () => null),
  refData: catalogRefDataDefault,
  completions: buildCompletions(catalogRefDataDefault, null),
  docCache: new Map(),
  invalidate: vi.fn(),
};

// A minimal `WorkbenchParameterSession` stub (#276 Phase 4B1) — no
// render-module fixture exercises the session directly (that's
// workbench-parameter-session.test.ts's job); this just satisfies the
// `App.params` contract. `hardenedVars` is the SAME `Set` instance as
// `appDefaults.hardenedVars` below (the production aliasing invariant —
// app.ts assigns `app.hardenedVars = params.hardenedVars`).
const paramsHardenedVarsDefault = new Set<string>();
const paramsDefaults: WorkbenchParameterSession = {
  hardenedVars: paramsHardenedVarsDefault,
  tabAnalysis: vi.fn(() => ({ fields: {}, sources: [], sourceErrors: {}, diagnostics: [] })),
  prepareAnalyzedBatch: vi.fn(() => ({ fields: {}, sources: [], diagnostics: [] })),
  prepareTabBatch: vi.fn(() => ({ fields: {}, sources: [], diagnostics: [] })),
  prepareTabSource: vi.fn(() => ({ id: 'tab', statements: [], missing: [], invalid: [], errors: [], runnable: true })),
  execStatementSql: vi.fn((stmt: string) => stmt),
  varGateBlocked: vi.fn(() => false),
  hardenVar: vi.fn(),
  inputGate: vi.fn(() => ({ missing: [], invalid: [], errors: [] })),
  inferredEnumOptions: vi.fn(() => null),
  recordBoundParams: vi.fn(),
  clearVarRecent: vi.fn(),
  clearAllVarRecent: vi.fn(),
  saveVarValues: vi.fn(),
  saveFilterActive: vi.fn(),
  saveVarRecent: vi.fn(),
  saveVarRecentDisabled: vi.fn(),
};

// A minimal `ExportService` stub (#276 Phase 4B2) — no render-module fixture
// exercises the service directly (that's export-service.test.ts's job); this
// just satisfies the `App.exports` contract.
const exportsDefaults: ExportService = {
  exportEntry: vi.fn(),
  exportDirect: vi.fn(async () => {}),
  cancelExport: vi.fn(),
  cancelExportScript: vi.fn(),
};

// A minimal `QueryDocumentSession` stub (#276 Phase 4C) — no render-module
// fixture exercises the session directly (that's
// query-document-session.test.ts's job); this just satisfies the
// `App.queryDoc` contract.
const queryDocDefaults: QueryDocumentSession = {
  applySpecEvaluation: vi.fn(() => ({ parsed: null, diagnostics: [] })),
  evaluateSpecDraft: vi.fn(() => ({ parsed: null, diagnostics: [] })),
  revalidateSpecDrafts: vi.fn(),
  revealFirstSpecError: vi.fn(),
  registerSpecValidator: vi.fn(() => () => {}),
  resolveEditorMode: vi.fn(() => ({ ok: true })),
};

// A minimal `SavedQueryService` stub (#276 Phase 4C) — no render-module
// fixture exercises the service directly (that's
// saved-query-service.test.ts's job); this just satisfies the `App.saved`
// contract.
const savedDefaults: SavedQueryService = {
  create: vi.fn((): CreateSavedResult => ({ ok: false })),
  commit: vi.fn((): CommitLinkedResult => ({ ok: false, reason: 'empty' })),
  recordHistory: vi.fn(),
  buildShareUrl: vi.fn((): ShareResult => ({ ok: false, reason: 'empty' })),
};

// A minimal `SchemaGraphSession` stub (#276 Phase 4D) — no render-module
// fixture exercises the session directly (that's schema-graph-session.test.ts's
// job); this just satisfies the `App.graph` contract.
const graphDefaults: SchemaGraphSession = {
  show: vi.fn(async () => {}),
  cancel: vi.fn(),
  expand: vi.fn(async () => ({ nodes: [], edges: [], focus: {}, truncated: false, savedPositions: {} })),
  loadNodeDetail: vi.fn(async () => null),
};

// A minimal `AppPreferences` stub (#276 Phase 4D) — no render-module fixture
// exercises the service directly (that's app-preferences.test.ts's job); this
// just satisfies the `App.prefs` contract.
const prefsDefaults: AppPreferences = {
  save: vi.fn(),
  toggleTheme: vi.fn(() => 'light'),
};

// Every `App` member this file's own concrete stubs (below) don't cover,
// filled with an inert placeholder never read by a fixture that doesn't
// override it — same convention as (and previously duplicated by) each of
// dashboard.test.ts / panels.test.ts / dashboard-kpi-band.test.ts /
// saved-history.test.ts / file-menu.test.ts / chart-render.test.ts /
// results.test.ts / schema.test.ts's own local copy (#267).
const appDefaults: App = {
  state: {} as AppState,
  dom: {},
  // The SAME `Set` instance as `paramsDefaults.hardenedVars` — the production
  // aliasing invariant (app.ts's `app.hardenedVars = params.hardenedVars`).
  hardenedVars: paramsHardenedVarsDefault,
  matchMedia: null,
  build: 'v0.0.0-test',
  root: null,
  document,
  conn: connDefaults,
  catalog: catalogDefaults,
  params: paramsDefaults,
  graph: graphDefaults,
  prefs: prefsDefaults,
  sqlEditor: {} as App['sqlEditor'],
  specEditor: {} as App['specEditor'],
  CodeViewer: () => ({ setText: () => {}, setLanguage: () => {}, setWrap: () => {}, focus: () => {}, destroy: () => {} }),
  specValidators: { validate: () => [] },
  specCompletionSources: {},
  Chart: undefined,
  cssVar: () => '',
  Dagre: undefined,
  openWindow: () => null,
  stylesText: '',
  faviconHref: '',
  toggleTheme: () => {},
  chart: undefined,
  host: () => '',
  activeTab: () => ({}) as App['activeTab'] extends () => infer T ? T : never,
  isSignedIn: () => true,
  email: () => '',
  hostHint: '',
  basePath: '',
  setTokens: () => {},
  loadConfig: async () => ({}) as ResolvedIdpConfig,
  loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [] }) as ConfigDoc,
  ensureConfig: async () => null,
  ensureFreshToken: async () => true,
  chCtx: chCtxDefaults,
  showLogin: () => {},
  signOut: () => {},
  receiveAuthHandoff: async () => false,
  canExport: () => false,
  canExportScript: () => false,
  showSaveFilePicker: null,
  showDirectoryPicker: null,
  isSecureContext: true,
  FileReader: globalThis.FileReader,
  saveJSON: () => {},
  saveStr: () => {},
  savePref: () => {},
  saveVarValues: () => {},
  saveFilterActive: () => {},
  saveVarRecent: () => {},
  saveVarRecentDisabled: () => {},
  recordBoundParams: () => {},
  clearVarRecent: () => {},
  clearAllVarRecent: () => {},
  recordHistory: () => {},
  downloadFile: () => {},
  editingLibrary: false,
  loadVersion: async () => {},
  loadSchema: async () => {},
  loadReference: async () => {},
  refData: { functions: {}, keywordDocs: {} },
  completions: {},
  rebuildCompletions: () => {},
  docCache: new Map(),
  entityDoc: async () => null,
  updateBanner: () => {},
  wallNow: () => 0,
  now: () => 0,
  elapsedMs: () => 0,
  tickElapsed: () => {},
  workbench: workbenchDefaults,
  exports: exportsDefaults,
  queryDoc: queryDocDefaults,
  saved: savedDefaults,
  exec: {
    executeRead: async (result) => result,
    executeScript: async () => ({ entries: [], aborted: false }),
    kill: async () => {},
  },
  setRunBtn: () => {},
  renderVarStrip: () => {},
  setExportBtn: () => {},
  setFmtBtn: () => {},
  specBlocked: () => false,
  updateSaveBtn: () => {},
  evaluateSpecDraft: () => ({ parsed: null, diagnostics: [] }),
  revalidateSpecDrafts: () => {},
  revealFirstSpecError: () => {},
  registerSpecValidator: () => () => {},
  activateInvalidSpecDraft: () => {},
  openSavePopover: () => {},
  openUserMenu: () => {},
  renderApp: () => {},
  renderDashboard: () => {},
  openDashboard: () => {},
  actions: {} as ActionsRegistry,
};

/** `makeApp`'s own override bag — `Partial<App>` except `dom`/`chCtx`/
 * `actions`, each further loosened to `Partial<...>` too: `Partial<App>`
 * alone only shallowly optionalizes App's OWN members, so `chCtx: {
 * onSignedOut }` (a caller overriding one ChCtx member, not the whole
 * service) would otherwise fail the constraint even though the nested merge
 * below happily accepts a partial sub-object. */
type AppOverrides = Partial<Omit<App, 'dom' | 'chCtx' | 'actions' | 'exec' | 'conn' | 'workbench' | 'params' | 'queryDoc' | 'saved' | 'exports' | 'graph' | 'prefs'>> & {
  dom?: Partial<AppDom>;
  chCtx?: Partial<ChCtx>;
  actions?: Partial<ActionsRegistry>;
  /** Partial like `dom`/`chCtx`/`actions` above — most fixtures only care
   *  about overriding `executeRead` (the #185 detached-read seam / dashboard
   *  tile transport); `executeScript`/`kill` fall back to the base stubs. */
  exec?: Partial<QueryExecutionService>;
  /** Partial like the rest. `conn.chCtx` cannot be overridden here — the
   *  merge below always re-points it at the shared merged `chCtx` object
   *  (the production identity invariant); override `chCtx` at the top level
   *  and both aliases see it. */
  conn?: Partial<Omit<ConnectionSession, 'chCtx'>>;
  /** Partial like the rest (#276 Phase 3a) — most fixtures never touch the
   *  session directly; a test asserting `workbench.run`/`.cancel` was called
   *  can override just that method. */
  workbench?: Partial<WorkbenchSession>;
  /** Partial like `workbench` above (#276 Phase 4B1) — most fixtures never
   *  touch the session directly; a test asserting e.g. `params.clearVarRecent`
   *  was called can override just that method. */
  params?: Partial<WorkbenchParameterSession>;
  /** Partial like `workbench`/`params` above (#276 Phase 4C) — most fixtures
   *  never touch the session directly; a test asserting e.g.
   *  `queryDoc.resolveEditorMode`'s return can override just that method. */
  queryDoc?: Partial<QueryDocumentSession>;
  /** Partial like `queryDoc` above (#276 Phase 4C) — a test asserting e.g.
   *  `saved.commit`'s return can override just that method. */
  saved?: Partial<SavedQueryService>;
  /** Partial like the rest (#276 Phase 4B2/4D — same convention as their
   *  sibling sessions above). */
  exports?: Partial<ExportService>;
  graph?: Partial<SchemaGraphSession>;
  prefs?: Partial<AppPreferences>;
};

// `overrides` is generic so its properties keep their OWN precise call-site
// type (e.g. a real 2-arg `exec.executeRead` mock) — a plain `Partial<App>`
// parameter would widen every override to App's declared (argument-erased)
// signature, losing `.mock`/`.mockClear` for the rest of the test. No
// explicit return-type annotation: inferring it keeps every OTHER concrete
// stub's own precise type too (`ensureFreshToken`, `recordBoundParams`, the
// `actions.*` spies, …) — annotating would widen all of them to App's
// argument-erased method signatures, the same loss `O` exists to avoid for
// the explicit overrides.
export function makeApp<O extends AppOverrides = Record<string, never>>(overrides: O = {} as O) {
  const state = createState({ loadStr: (k, d) => d, loadJSON: (k, d) => d });
  const root = document.createElement('div');
  const base = {
    state,
    root,
    document,
    Chart: FakeChart,
    Dagre: dagre, // real dagre — it's pure (no DOM), so tests use it directly
    cssVar: () => '', // blank → chartColors() uses its dark-theme fallbacks
    host: () => 'test.host',
    build: 'v0.0.0-test',
    activeTab: () => activeTab(state),
    sqlEditor: createNoopPort(),
    specEditor: createNoopSpecEditor(),
    isSignedIn: () => true,
    // Dashboard (#149) surface: auth is resolved once before tiles fan out, the
    // Back link derives from the SPA base, and onSignedOut redirects on failure.
    ensureFreshToken: vi.fn(async () => true),
    chCtx: { onSignedOut: vi.fn() },
    basePath: '/sql',
    toggleTheme: vi.fn(),
    email: () => 'me@example.com',
    savePref: vi.fn(),
    saveVarValues: vi.fn(),
    saveFilterActive: vi.fn(),
    saveVarRecent: vi.fn(),
    saveVarRecentDisabled: vi.fn(),
    recordBoundParams: vi.fn(),
    // #185 detached-read seam + #193 dashboard-tile transport + #83 script
    // transport, now the shared QueryExecutionService (#276 Phase 1):
    // `executeRead` is no-op by default (snapshot cases never call it);
    // interactive-rerun tests override it to stream rows into the result.
    exec: {
      executeRead: vi.fn(async (result: StreamResult) => result),
      executeScript: vi.fn(async () => ({ entries: [], aborted: false })),
      kill: vi.fn(async () => {}),
    },
    clearVarRecent: vi.fn(),
    clearAllVarRecent: vi.fn(),
    saveJSON: vi.fn(),
    saveStr: vi.fn(),
    downloadFile: vi.fn(),
    updateSaveBtn: vi.fn(),
    updateEditorModeUi: vi.fn(),
    revalidateSpecDrafts: vi.fn(),
    activateInvalidSpecDraft: vi.fn(),
    elapsedMs: () => 0,
    now: () => 0,
    wallNow: () => 0, // the #173 wave wall clock (epoch ms; fixed in tests)
    showLogin: vi.fn(),
    signOut: vi.fn(),
    loadVersion: vi.fn(),
    loadSchema: vi.fn(),
    entityDoc: vi.fn(async () => ''), // lazy hover-doc loader (#27); overridden per test
    loadIdps: async (): Promise<ConfigDoc> => ({ idps: [], basicLogin: true, hosts: [] }),
    // Concrete (non-optional) elements — most consumers read these
    // unconditionally; a test that clears one back to `undefined` (a "no
    // mount point" guard) widens its own local read, same convention as
    // results.test.ts's `(app.dom as {...}).resultsRegion = null` cast.
    dom: {
      qtabsInner: document.createElement('div'),
      schemaList: document.createElement('div'),
      resultsRegion: document.createElement('div'),
      savedTabsRow: document.createElement('div'),
      savedSearch: document.createElement('div'),
      savedList: document.createElement('div'),
      saveBtn: document.createElement('button'),
    },
    actions: {
      run: vi.fn(),
      cancel: vi.fn(),
      newTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      loadIntoNewTab: vi.fn(),
      login: vi.fn(),
      connect: vi.fn(),
      share: vi.fn(),
      copyResult: vi.fn(),
      copySnapshot: vi.fn(),
      exportEntry: vi.fn(),
      exportDirect: vi.fn(),
      cancelExport: vi.fn(),
      cancelExportScript: vi.fn(),
      save: vi.fn(),
      formatQuery: vi.fn(),
      formatSpec: vi.fn(),
      setEditorMode: vi.fn(),
      explainQuery: vi.fn(),
      setExplainView: vi.fn(),
      setResultRowLimit: vi.fn(),
      showSchemaGraph: vi.fn(),
      cancelSchemaGraph: vi.fn(),
      expandSchemaGraph: vi.fn(),
      openNodeDetail: vi.fn(),
      insertCreate: vi.fn(),
      openCreateInNewTab: vi.fn(),
      openShortcuts: vi.fn(),
      openDashboard: vi.fn(),
      openUserMenu: vi.fn(),
      insertAtCursor: vi.fn(),
      replaceEditor: vi.fn(),
      loadColumns: vi.fn(),
      rerenderTabs: vi.fn(),
      rerenderResults: vi.fn(),
      updateSaveBtn: vi.fn(),
    },
  };
  // One merged chCtx object shared by BOTH aliases (app.chCtx and
  // app.conn.chCtx) — the production identity invariant (#276 Phase 2).
  const chCtx = { ...appDefaults.chCtx, ...base.chCtx, ...(overrides.chCtx ?? {}) };
  const merged = {
    ...appDefaults,
    ...base,
    ...overrides,
    dom: { ...appDefaults.dom, ...base.dom, ...(overrides.dom ?? {}) },
    chCtx,
    actions: { ...appDefaults.actions, ...base.actions, ...(overrides.actions ?? {}) },
    exec: { ...appDefaults.exec, ...base.exec, ...(overrides.exec ?? {}) },
    conn: { ...connDefaults, ...(overrides.conn ?? {}), chCtx },
    workbench: { ...workbenchDefaults, ...(overrides.workbench ?? {}) },
    params: { ...paramsDefaults, ...(overrides.params ?? {}) },
    queryDoc: { ...queryDocDefaults, ...(overrides.queryDoc ?? {}) },
    saved: { ...savedDefaults, ...(overrides.saved ?? {}) },
    exports: { ...exportsDefaults, ...(overrides.exports ?? {}) },
    graph: { ...graphDefaults, ...(overrides.graph ?? {}) },
    prefs: { ...prefsDefaults, ...(overrides.prefs ?? {}) },
  };
  // Assignability check only (a variable reference, not a fresh literal, so
  // this never trips an excess-property error) — `merged`'s own inferred type
  // (every field's REAL, often Mock-typed, shape) is what callers actually
  // get back, not this widened annotation.
  const asApp: App = merged;
  void asApp;
  return merged;
}
