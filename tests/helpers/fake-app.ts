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
//      call-site type (e.g. a 2-arg `runReadInto` spy) instead of collapsing
///     to `App`'s declared (argument-erased) method signature.
// `dom`/`chCtx`/`actions` are nested objects, merged the same three-way
// (defaults, stubs, override) so a caller overriding e.g. `chCtx: { onSignedOut }`
// never has to re-spread the other `ChCtx` fields itself.
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

// Every `App` member this file's own concrete stubs (below) don't cover,
// filled with an inert placeholder never read by a fixture that doesn't
// override it — same convention as (and previously duplicated by) each of
// dashboard.test.ts / panels.test.ts / dashboard-kpi-band.test.ts /
// saved-history.test.ts / file-menu.test.ts / chart-render.test.ts /
// results.test.ts / schema.test.ts's own local copy (#267).
const appDefaults: App = {
  state: {} as AppState,
  dom: {},
  hardenedVars: new Set(),
  matchMedia: null,
  build: 'v0.0.0-test',
  root: null,
  document,
  token: null,
  refreshToken: null,
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
  chUsername: () => '',
  authMode: 'basic',
  chAuth: 'basic',
  basicUserClaim: 'sub',
  idpId: null,
  hostHint: '',
  basePath: '',
  setTokens: () => {},
  loadConfig: async () => ({}) as ResolvedIdpConfig,
  loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [] }) as ConfigDoc,
  selectIdp: () => {},
  ensureConfig: async () => null,
  ensureFreshToken: async () => true,
  chCtx: {
    fetch, origin: '', authConfirmed: true,
    getToken: async () => null, refresh: async () => false, authHeader: () => '', onSignedOut: () => {},
  },
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
  runReadInto: async (result) => result,
  setRunBtn: () => {},
  renderVarStrip: () => {},
  setExportBtn: () => {},
  setFmtBtn: () => {},
  specBlocked: () => false,
  updateSaveBtn: () => {},
  evaluateSpecDraft: () => ({}),
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
type AppOverrides = Partial<Omit<App, 'dom' | 'chCtx' | 'actions'>> & {
  dom?: Partial<AppDom>;
  chCtx?: Partial<ChCtx>;
  actions?: Partial<ActionsRegistry>;
};

// `overrides` is generic so its properties keep their OWN precise call-site
// type (e.g. a real 2-arg `runReadInto` mock) — a plain `Partial<App>`
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
    // #185 detached-read seam: no-op by default (snapshot cases never call it);
    // interactive-rerun tests override it to stream rows into the result.
    runReadInto: vi.fn(async (result: StreamResult) => result),
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
  const merged = {
    ...appDefaults,
    ...base,
    ...overrides,
    dom: { ...appDefaults.dom, ...base.dom, ...(overrides.dom ?? {}) },
    chCtx: { ...appDefaults.chCtx, ...base.chCtx, ...(overrides.chCtx ?? {}) },
    actions: { ...appDefaults.actions, ...base.actions, ...(overrides.actions ?? {}) },
  };
  // Assignability check only (a variable reference, not a fresh literal, so
  // this never trips an excess-property error) — `merged`'s own inferred type
  // (every field's REAL, often Mock-typed, shape) is what callers actually
  // get back, not this widened annotation.
  const asApp: App = merged;
  void asApp;
  return merged;
}
