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
// `dom`/`conn`/`catalog`/`actions`/`exec` are nested objects, merged the same
// three-way (defaults, stubs, override) so a caller overriding e.g.
// `chCtx: { onSignedOut }` (feeds `conn.chCtx` — #276 Phase 5 deleted the flat
// `App.chCtx` alias) or `exec: { executeRead }` never has to re-spread the
// other sibling fields.
import { vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { createState, activeTab, reconcileTabsWithSavedQueries } from '../../src/state.js';
import type { MutateWorkspace } from '../../src/state.js';
import { createNoopPort } from '../../src/editor/editor-port.js';
import { createNoopSpecEditor } from '../../src/editor/spec-editor.js';
import { createWorkspaceRepository } from '../../src/workspace/workspace-repository.js';
import type { WorkspaceStore } from '../../src/workspace/workspace-store.types.js';
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
import type { WorkspaceRepository } from '../../src/workspace/workspace-repository.js';
import type { StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';
import type {
  SavedQueryService, CreateSavedResult, CommitLinkedResult, ShareResult,
} from '../../src/application/saved-query-service.js';
import { assembleReferenceData, buildCompletions } from '../../src/core/completions.js';
import type { AssembledReference } from '../../src/core/completions.js';

// #287 W4: an in-memory `WorkspaceStore` fake (mirrors
// workspace-repository.test.ts's own `memStore`) — every saved-query CRUD op
// now awaits a real `WorkspaceRepository.commit`, not a bare stub, so a test
// exercising `createSavedQuery`/`toggleFavorite`/`deleteSaved`/etc. through
// `app.workspace.commit` gets genuine whole-candidate schema validation
// rather than an always-succeeds/always-fails placeholder.
export function memWorkspaceStore(initial: string | null = null): WorkspaceStore {
  let value = initial;
  return {
    read: async () => value,
    write: async (text: string) => { value = text; },
    clear: async () => { value = null; },
  };
}

/** A fresh real `WorkspaceRepository.commit` (backed by its own private
 *  `memWorkspaceStore`), wrapped in a `vi.fn` spy so a test can assert call
 *  counts the same way it used to assert on the retired `save: SaveJSON`
 *  spy — `vi.fn(impl)` still delegates to the real implementation. */
export function fakeWorkspaceCommit() {
  return vi.fn(createWorkspaceRepository({ store: memWorkspaceStore() }).commit);
}

/** A `MutateWorkspace` (`App['mutateWorkspace']`, structurally) over a private
 *  in-memory repository, for unit-testing the state.ts saved-query planners and
 *  the SavedQueryService without a full `makeApp()` (#343). It faithfully
 *  mirrors `app.mutateWorkspace`: read `latest` (default: empty store → `null`,
 *  so a planner falls back to the passed `state`), run the transform, commit,
 *  then PROJECT committed truth onto `state` (savedQueries/dashboard/id/name +
 *  reconcile tab links when `state` carries `tabs`, clearing libraryDirty)
 *  exactly once. `commit`/`loadCurrent` are `vi.fn` spies (assert call counts as
 *  with the retired `fakeWorkspaceCommit`); pass `commit`/`loadCurrent`
 *  overrides to exercise a rejecting commit or a distinct committed `latest`. */
export function fakeMutateWorkspace(
  state: Pick<AppState, 'savedQueries' | 'dashboard' | 'workspaceId' | 'libraryName' | 'libraryDirty'>,
  opts: { commit?: WorkspaceRepository['commit']; loadCurrent?: WorkspaceRepository['loadCurrent'] } = {},
): MutateWorkspace & { commit: ReturnType<typeof vi.fn>; loadCurrent: ReturnType<typeof vi.fn> } {
  const repo = createWorkspaceRepository({ store: memWorkspaceStore() });
  const commit = vi.fn(opts.commit ?? repo.commit);
  const loadCurrent = vi.fn(opts.loadCurrent ?? repo.loadCurrent);
  const mutate = (async (transform) => {
    const latest = await loadCurrent();
    const input = await transform(latest);
    if (!input || !input.candidate) {
      return { ok: false as const, aborted: true as const, data: input ? input.data : undefined };
    }
    const result = await commit(input.candidate);
    if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics, data: input.data };
    state.savedQueries = result.workspace.queries;
    const withTabs = state as Partial<Pick<AppState, 'tabs'>> & typeof state;
    if (withTabs.tabs) reconcileTabsWithSavedQueries(state as Pick<AppState, 'tabs' | 'savedQueries'>);
    state.dashboard = result.workspace.dashboard;
    state.workspaceId = result.workspace.id;
    state.libraryName.value = result.workspace.name;
    state.libraryDirty.value = false;
    return {
      ok: true as const, workspace: result.workspace,
      dashboardRevision: result.dashboardRevision, data: input.data,
    };
  }) as MutateWorkspace;
  return Object.assign(mutate, { commit, loadCurrent });
}

/** A STATEFUL in-memory `WorkspaceRepository` fake (#341/#344 review fix):
 *  `commit` stores the candidate and `loadCurrent`/`loadCurrentResult` return
 *  the LAST committed value — unlike the module-default `appDefaults.workspace`
 *  (a stateless echo `commit` paired with a `loadCurrent` that always answers
 *  `null`), so a mixed-producer test (a pending write, then a second op queued
 *  through `app.mutateWorkspace` behind it) can assert the second op's
 *  transform actually observed the first commit's effect. No schema
 *  validation (unlike `fakeWorkspaceCommit`'s real-repository-backed spy) —
 *  just enough state to make read-after-write hold. */
export function statefulWorkspaceRepo(initial: StoredWorkspaceV1 | null = null): WorkspaceRepository {
  let current = initial;
  return {
    loadCurrent: async () => current,
    loadCurrentResult: async () => (current ? { status: 'ok', workspace: current } : { status: 'empty' }),
    commit: async (candidate) => {
      current = candidate;
      return { ok: true, workspace: candidate, dashboardRevision: candidate.dashboard === null ? null : candidate.dashboard.revision };
    },
    clearCurrent: async () => { current = null; },
  };
}

// `app.conn.chCtx`'s defaults (#276 Phase 2; Phase 5 deleted the flat
// `App.chCtx` alias this file used to also mirror it onto).
const chCtxDefaults: ChCtx = {
  fetch, origin: '', authConfirmed: true,
  getToken: async () => null, refresh: async () => false, authHeader: () => '', onSignedOut: () => {},
};

// A minimal `ConnectionSession` stub (#276 Phase 2) — most render-module
// tests read `app.conn.isSignedIn`/`.email`/`.ensureConfig`/etc. only
// incidentally, never directly; this is inert, never-called-by-default
// plumbing so `appDefaults`
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
// job); this just satisfies the `App.catalog` contract (Phase 5 deleted the
// flat `App` delegates this file used to also mirror it onto). `refData`/
// `completions` use the real built-in fallback (`assembleReferenceData(null)`/
// `buildCompletions`) rather than a cast, so they stay structurally real
// `AssembledReference`/`CompletionItem[]` values.
const catalogRefDataDefault: AssembledReference = assembleReferenceData(null);
const catalogDefaults: SchemaCatalogService = {
  loadVersion: vi.fn(async () => {}),
  loadSchema: vi.fn(async () => {}),
  loadColumns: vi.fn(async () => {}),
  loadReference: vi.fn(async () => {}),
  rebuildCompletions: vi.fn(),
  docSummary: vi.fn(async () => ({ status: 'unavailable' as const })),
  docEntry: vi.fn(async () => ({ status: 'unavailable' as const })),
  docMarkdown: vi.fn(async () => ({ status: 'unavailable' as const })),
  docDisambiguate: vi.fn(async () => ({ status: 'unavailable' as const })),
  docKindAvailable: vi.fn(() => null),
  refData: catalogRefDataDefault,
  completions: buildCompletions(catalogRefDataDefault, null),
  invalidate: vi.fn(),
};

// A minimal `WorkbenchParameterSession` stub (#276 Phase 4B1) — no
// render-module fixture exercises the session directly (that's
// workbench-parameter-session.test.ts's job); this just satisfies the
// `App.params` contract. No flat `App.hardenedVars` alias to also mirror
// this onto (#276 Phase 5 deleted it) — a fixture reads `app.params.hardenedVars`
// directly now.
const paramsDefaults: WorkbenchParameterSession = {
  hardenedVars: new Set<string>(),
  tabAnalysis: vi.fn(() => ({ fields: {}, sources: [], sourceErrors: {}, diagnostics: [] })),
  prepareAnalyzedBatch: vi.fn(() => ({ fields: {}, sources: [], diagnostics: [] })),
  prepareTabBatch: vi.fn(() => ({ fields: {}, sources: [], diagnostics: [] })),
  prepareTabSource: vi.fn(() => ({ id: 'tab', statements: [], missing: [], invalid: [], errors: [], runnable: true })),
  prepareFilterPreview: vi.fn(() => ({
    readiness: 'runnable' as const, diagnostics: [], dependsOn: [], missing: [], invalid: [], errors: [],
    error: null, execSql: '', params: {}, format: 'Filter' as const, rowLimit: 2, boundParams: [],
  })),
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
  create: vi.fn(async (): Promise<CreateSavedResult> => ({ ok: false })),
  commit: vi.fn(async (): Promise<CommitLinkedResult> => ({ ok: false, reason: 'empty' })),
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
  matchMedia: null,
  build: 'v0.0.0-test',
  root: null,
  document,
  conn: connDefaults,
  catalog: catalogDefaults,
  params: paramsDefaults,
  graph: graphDefaults,
  prefs: prefsDefaults,
  // Default commit is a permissive ECHO (not real schema validation, unlike
  // `fakeWorkspaceCommit()` above): it always succeeds and publishes back
  // exactly the candidate it was given, so a generic UI-focused fixture that
  // never overrides `workspace` still gets a coherent `state.savedQueries =
  // result.workspace.queries` projection (#287 W4) without also having to set
  // `state.workspaceId` to satisfy the real repository's non-empty-id schema
  // rule. A test asserting real validate-then-persist behavior overrides this
  // with `fakeWorkspaceCommit()` (or its own stub) instead.
  workspace: {
    loadCurrent: async () => null,
    // #300: default mirrors `loadCurrent`'s own default (no record) — a
    // fixture testing the corrupt-record surface overrides this directly.
    loadCurrentResult: async () => ({ status: 'empty' }),
    commit: async (candidate) => ({
      ok: true, workspace: candidate, dashboardRevision: candidate.dashboard === null ? null : candidate.dashboard.revision,
    }),
    clearCurrent: async () => {},
  },
  // #288 Phase 6 — Dashboard viewing seams. In-memory no-op stores by default;
  // a test exercising the handoff/detached-view flow overrides these.
  handoff: {
    put: async () => {},
    take: async () => null,
  },
  detachedViews: {
    put: async () => {},
    get: async () => null,
  },
  dashboardOpenSource: null,
  dashboardRoute: false,
  dashboardReadOnly: false,
  reloadDashboardRoute: () => {},
  consumeDashboardHandoff: async () => null,
  loadDashboardWorkspace: async () => null,
  loadWorkspaceOnBoot: async () => null,
  // Inert placeholders — `base` below overrides both with real, state-backed
  // implementations (mirroring app.ts's own #287 W5 wiring) so a file-menu
  // fixture that never overrides `workspace.commit` still observes a coherent
  // post-commit projection.
  applyCommittedWorkspace: () => {},
  genId: () => 'gen-id',
  // #343 §5/§6: inert cross-tab-consistency seams — a fixture exercising
  // invalidation overrides these (or uses two real `createApp()` instances).
  sourceTabId: 'tab-fake',
  documentVisible: () => true,
  getLastCommittedToken: () => '',
  onExternalWorkspaceChange: () => {},
  refreshWorkspaceFromStore: async () => {},
  onWorkspaceExternallyChanged: () => {},
  // Inert passthrough — `base` overrides with a real per-instance queue.
  serializeWrite: <T,>(op: () => Promise<T>): Promise<T> => op(),
  // #341: inert no-op — `base` overrides with the real per-instance flush that
  // shares `serializeWrite`'s own queue.
  flushWorkspaceWrites: async () => {},
  // #341/#344: inert placeholder — `transform` still runs (so a fixture that
  // never overrides this still exercises the caller's build-from-latest
  // logic), but `latest` is always `null` (no queue, no read-back) and the
  // result is never actually persisted anywhere. `base` overrides with the
  // real per-instance queue backed by `workspaceRepo`.
  mutateWorkspace: async (transform) => {
    const input = await transform(null);
    if (!input || !input.candidate) {
      return { ok: false, aborted: true, data: input ? input.data : undefined };
    }
    const result = await appDefaults.workspace.commit(input.candidate);
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics, data: input.data };
    // #343 §2: the primitive owns projection now (inert here, but faithful).
    appDefaults.applyCommittedWorkspace(result.workspace);
    return { ok: true, workspace: result.workspace, dashboardRevision: result.dashboardRevision, data: input.data };
  },
  sqlEditor: {} as App['sqlEditor'],
  specEditor: {} as App['specEditor'],
  // #313 — inert placeholder; a fixture exercising the reference-pane action
  // (hover button, F1, a schema-surface action) overrides this directly.
  openDocEntry: vi.fn(),
  // #315 — same inert-placeholder convention for the F1 disambiguation
  // fallback's injected action.
  openDocDisambiguation: vi.fn(),
  // #60 — the global-Escape close hook; the inert fixture has no pane open.
  closeDocPane: vi.fn(() => false),
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
  activeTab: () => ({}) as App['activeTab'] extends () => infer T ? T : never,
  showLogin: () => {},
  signOut: () => {},
  canExport: () => false,
  canExportScript: () => false,
  showSaveFilePicker: null,
  showDirectoryPicker: null,
  isSecureContext: true,
  FileReader: globalThis.FileReader,
  saveJSON: () => {},
  saveStr: () => {},
  // The one deliberate delegate survivor of #276 Phase 5's params-group
  // cleanup — see `App.saveVarRecent`'s own doc comment (app.types.ts).
  // Every OTHER params-group member (`saveVarValues`/`saveFilterActive`/
  // `saveVarRecentDisabled`/`recordBoundParams`/`clearVarRecent`/
  // `clearAllVarRecent`/`hardenedVars`) lives only on `paramsDefaults` above.
  saveVarRecent: () => {},
  recordHistory: () => {},
  downloadFile: () => {},
  editingLibrary: false,
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
  // `evaluateSpecDraft`/`revalidateSpecDrafts`/`revealFirstSpecError`/
  // `registerSpecValidator` have no flat `App` member (#276 Phase 5 deleted
  // them) — a fixture reads `queryDocDefaults`/`app.queryDoc.*` for those now.
  activateInvalidSpecDraft: () => {},
  openSavePopover: () => {},
  openUserMenu: () => {},
  renderApp: () => {},
  renderDashboard: () => {},
  openDashboard: () => {},
  openDashboardForViewing: () => {},
  actions: {} as ActionsRegistry,
};

/** `makeApp`'s own override bag — `Partial<App>` except `dom`/`chCtx`/
 * `actions`, each further loosened to `Partial<...>` too: `Partial<App>`
 * alone only shallowly optionalizes App's OWN members, so `chCtx: {
 * onSignedOut }` (a caller overriding one ChCtx member, not the whole
 * service) would otherwise fail the constraint even though the nested merge
 * below happily accepts a partial sub-object. `chCtx` is a fake-app-only
 * convenience key (#276 Phase 5 deleted `App.chCtx` — `app.conn.chCtx` is
 * the only live alias now), kept so existing `makeApp({ chCtx: {...} })`
 * call sites don't all need to become `conn: { chCtx: {...} }`. */
// Exported (as `MakeAppOverrides`, distinct from any test file's own local
// `AppOverrides`) so a fixture's own `mount()`-style wrapper (e.g.
// file-menu.test.ts's, which needs `workspace: { commit }` — a genuinely
// nested-partial override `Partial<App>` alone can't express) can type its
// parameter as exactly what `makeApp` itself accepts, instead of
// re-declaring a narrower `Partial<App>` that would reject it.
export type MakeAppOverrides = AppOverrides;
type AppOverrides = Partial<Omit<App, 'dom' | 'actions' | 'exec' | 'conn' | 'catalog' | 'workbench' | 'params' | 'queryDoc' | 'saved' | 'exports' | 'graph' | 'prefs' | 'workspace'>> & {
  /** Partial like the rest (#286 Phase 4) — the Dashboard viewer reads a
   *  StoredWorkspaceV1 through `loadDashboardWorkspace`/`workspace.loadCurrent`;
   *  a dashboard test overrides just the method(s) it drives. */
  workspace?: Partial<WorkspaceRepository>;
  dom?: Partial<AppDom>;
  chCtx?: Partial<ChCtx>;
  actions?: Partial<ActionsRegistry>;
  /** Partial like `dom`/`chCtx`/`actions` above — most fixtures only care
   *  about overriding `executeRead` (the #185 detached-read seam / dashboard
   *  tile transport); `executeScript`/`kill` fall back to the base stubs. */
  exec?: Partial<QueryExecutionService>;
  /** Partial like the rest. `conn.chCtx` cannot be overridden here — the
   *  merge below always re-points it at the shared merged `chCtx` object
   *  built from the top-level `chCtx` override above. */
  conn?: Partial<Omit<ConnectionSession, 'chCtx'>>;
  /** Partial like `conn` above (#276 Phase 5 — `SchemaCatalogService` no
   *  longer has flat `App` delegates); most fixtures never touch it, a test
   *  asserting e.g. `catalog.loadSchema` was called can override just that
   *  method. */
  catalog?: Partial<SchemaCatalogService>;
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
  // Resolved BEFORE `base` so the `mutateWorkspace` queue below (which needs to
  // call `.loadCurrent()`/`.commit()` on the SAME repository the rest of the
  // fake app sees) can close over it directly — the final `workspace` field is
  // this exact object, not a fresh merge (`overrides.workspace` layers under
  // `appDefaults.workspace`, same three-way convention as `dom`/`conn`/etc.).
  const workspaceRepo: WorkspaceRepository = { ...appDefaults.workspace, ...(overrides.workspace ?? {}) };
  // #287 W5 / #343 §2: the one state-backed projection both `applyCommittedWorkspace`
  // and the `mutateWorkspace` success path share (mirrors app.ts, where the
  // primitive projects exactly once so callers no longer do).
  const applyCommittedWorkspace = (workspace: StoredWorkspaceV1): void => {
    state.savedQueries = workspace.queries;
    // #343: mirror app.ts's own projection — detach any open tab whose linked
    // saved query is absent from the committed collection (deleted elsewhere).
    reconcileTabsWithSavedQueries(state);
    state.dashboard = workspace.dashboard;
    state.workspaceId = workspace.id;
    state.libraryName.value = workspace.name;
    state.libraryDirty.value = false;
  };
  const base = {
    state,
    root,
    document,
    Chart: FakeChart,
    Dagre: dagre, // real dagre — it's pure (no DOM), so tests use it directly
    cssVar: () => '', // blank → chartColors() uses its dark-theme fallbacks
    build: 'v0.0.0-test',
    activeTab: () => activeTab(state),
    sqlEditor: createNoopPort(),
    specEditor: createNoopSpecEditor(),
    // Identity/auth (#276 Phase 5 — all live on `conn` now, no flat `App`
    // delegates). Dashboard (#149) surface: auth is resolved once before
    // tiles fan out, the Back link derives from the SPA base, and
    // onSignedOut redirects on failure.
    conn: {
      host: () => 'test.host',
      isSignedIn: () => true,
      ensureFreshToken: vi.fn(async () => true),
      basePath: '/sql',
      email: () => 'me@example.com',
      loadIdps: async (): Promise<ConfigDoc> => ({ idps: [], basicLogin: true, hosts: [] }),
    },
    // The server-metadata/reference lifecycle (#276 Phase 4A) — no flat `App`
    // delegates (Phase 5 deleted them); `docSummary`/`docEntry` overridden
    // per test (#313) where a fixture needs them.
    catalog: {
      loadVersion: vi.fn(),
      loadSchema: vi.fn(),
      // #314 — a fresh-per-call vi.fn() (see this file's own note on
      // `saveVarRecent`/the `params` group below): a fixture asserting
      // `docKindAvailable`'s call count/args needs its OWN mock, not the
      // shared `catalogDefaults` singleton every `makeApp()` call would
      // otherwise accumulate calls onto. Defaults to `null` (unknown) —
      // permissive, same as the real service before any probe.
      docKindAvailable: vi.fn(() => null),
    },
    toggleTheme: vi.fn(),
    // #287 W5: real, state-backed implementations (mirroring app.ts's own
    // projection + WorkspaceIdGen wiring) so a file-menu fixture exercising a
    // real commit (default echo `workspace.commit`, or `fakeWorkspaceCommit()`)
    // observes a coherent post-commit projection without overriding either.
    // `genId` mints a fresh, test-deterministic id per call — its own counter,
    // not `appDefaults`' shared placeholder, so ids never leak across tests.
    applyCommittedWorkspace,
    genId: (() => { let n = 0; return () => 'gen-' + (++n); })(),
    // #287 review fix: a real per-instance serialization queue (mirrors app.ts)
    // so a test firing two overlapping CRUD ops observes them applied in order,
    // not interleaved. Per-instance (own `chain`), so no leak across makeApp calls.
    ...(() => {
      let chain: Promise<unknown> = Promise.resolve();
      const serializeWrite = <T,>(op: () => Promise<T>): Promise<T> => {
        const run = chain.then(op, op);
        chain = run.then(() => undefined, () => undefined);
        return run;
      };
      // #341: shares the SAME `chain` `serializeWrite` advances, so a test
      // awaiting `app.flushWorkspaceWrites()` sees every write queued before
      // this call resolve — mirrors app.ts's own `writeChain`-backed pair.
      const flushWorkspaceWrites = (): Promise<void> => chain.then(() => undefined, () => undefined);
      // #341/#344: mirrors app.ts's own `mutateWorkspace` — reads `workspaceRepo
      // .loadCurrent()` (the SAME repo `workspace.commit` below publishes
      // through) at DEQUEUE time, never a value captured at enqueue time, so a
      // mixed-producer test (a pending saved-query-style commit, then a
      // rename/import queued behind it) observes the first commit's effect.
      // #343 §2: on success the primitive projects committed truth exactly once
      // and threads `data` back — callers no longer project (mirrors app.ts).
      const mutateWorkspace: App['mutateWorkspace'] = (transform) => serializeWrite(async () => {
        const latest = await workspaceRepo.loadCurrent();
        const input = await transform(latest);
        if (!input || !input.candidate) {
          return { ok: false as const, aborted: true as const, data: input ? input.data : undefined };
        }
        const result = await workspaceRepo.commit(input.candidate);
        if (!result.ok) return { ok: false as const, diagnostics: result.diagnostics, data: input.data };
        applyCommittedWorkspace(result.workspace);
        return {
          ok: true as const, workspace: result.workspace,
          dashboardRevision: result.dashboardRevision, data: input.data,
        };
      });
      return { serializeWrite, flushWorkspaceWrites, mutateWorkspace };
    })(),
    // The one deliberate delegate survivor of #276 Phase 5's params-group
    // cleanup — see `App.saveVarRecent`'s own doc comment.
    saveVarRecent: vi.fn(),
    // #314 — fresh-per-call (same reasoning as `saveVarRecent` above): a
    // schema-surface-action fixture asserts `openDocEntry`'s call count/args
    // directly, so it can't share `appDefaults.openDocEntry`'s singleton.
    openDocEntry: vi.fn(),
    // #315 — same fresh-per-call reasoning for the F1 disambiguation fallback.
    openDocDisambiguation: vi.fn(),
    // #60 — fresh-per-call for the same reason (shortcut tests assert calls).
    closeDocPane: vi.fn(() => false),
    // `paramsDefaults`/`prefsDefaults` above are typed `: WorkbenchParameterSession`/
    // `: AppPreferences` — module-scoped SINGLETONS shared by every `makeApp()`
    // call in a test file. Widened members lose `.mock`/`.mockClear` the same
    // way `catalog`/`conn`'s do (hence their own untyped `base` stub layers
    // below); worse, since they're shared across every `it()` in the file, a
    // default (non-overridden) `vi.fn()` there ACCUMULATES call counts across
    // unrelated tests instead of resetting per `makeApp()` call. Every
    // params-group/prefs member a fixture asserts `.toHaveBeenCalled*`/`.mock.*`
    // against WITHOUT an explicit `overrides.params`/`.prefs` override gets its
    // own FRESH-per-call `vi.fn()` here — same as `saveVarRecent` above.
    params: {
      recordBoundParams: vi.fn(),
      clearVarRecent: vi.fn(),
      clearAllVarRecent: vi.fn(),
      saveVarValues: vi.fn(),
      saveFilterActive: vi.fn(),
      saveVarRecentDisabled: vi.fn(),
    },
    prefs: { save: vi.fn() },
    // #185 detached-read seam + #193 dashboard-tile transport + #83 script
    // transport, now the shared QueryExecutionService (#276 Phase 1):
    // `executeRead` is no-op by default (snapshot cases never call it);
    // interactive-rerun tests override it to stream rows into the result.
    exec: {
      executeRead: vi.fn(async (result: StreamResult) => result),
      executeScript: vi.fn(async () => ({ entries: [], aborted: false })),
      kill: vi.fn(async () => {}),
    },
    saveJSON: vi.fn(),
    saveStr: vi.fn(),
    downloadFile: vi.fn(),
    updateSaveBtn: vi.fn(),
    updateEditorModeUi: vi.fn(),
    activateInvalidSpecDraft: vi.fn(),
    elapsedMs: () => 0,
    now: () => 0,
    wallNow: () => 0, // the #173 wave wall clock (epoch ms; fixed in tests)
    showLogin: vi.fn(),
    signOut: vi.fn(),
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
      openDashboardForViewing: vi.fn(),
      exportDashboard: vi.fn(),
      importDashboard: vi.fn(),
      openUserMenu: vi.fn(),
      insertAtCursor: vi.fn(),
      replaceEditor: vi.fn(),
      loadColumns: vi.fn(),
      rerenderTabs: vi.fn(),
      rerenderResults: vi.fn(),
      updateSaveBtn: vi.fn(),
    },
  };
  // `app.conn.chCtx` — built from the defaults + this fixture's own
  // `onSignedOut` mock + a caller's top-level `chCtx` override (#276 Phase 5:
  // no more flat `App.chCtx` alias to also mirror it onto).
  const chCtx = { ...chCtxDefaults, onSignedOut: vi.fn(), ...(overrides.chCtx ?? {}) };
  const merged = {
    ...appDefaults,
    ...base,
    ...overrides,
    dom: { ...appDefaults.dom, ...base.dom, ...(overrides.dom ?? {}) },
    actions: { ...appDefaults.actions, ...base.actions, ...(overrides.actions ?? {}) },
    exec: { ...appDefaults.exec, ...base.exec, ...(overrides.exec ?? {}) },
    conn: { ...connDefaults, ...base.conn, ...(overrides.conn ?? {}), chCtx },
    catalog: { ...catalogDefaults, ...base.catalog, ...(overrides.catalog ?? {}) },
    workbench: { ...workbenchDefaults, ...(overrides.workbench ?? {}) },
    params: { ...paramsDefaults, ...base.params, ...(overrides.params ?? {}) },
    queryDoc: { ...queryDocDefaults, ...(overrides.queryDoc ?? {}) },
    saved: { ...savedDefaults, ...(overrides.saved ?? {}) },
    exports: { ...exportsDefaults, ...(overrides.exports ?? {}) },
    graph: { ...graphDefaults, ...(overrides.graph ?? {}) },
    prefs: { ...prefsDefaults, ...base.prefs, ...(overrides.prefs ?? {}) },
    workspace: workspaceRepo,
  };
  // Assignability check only (a variable reference, not a fresh literal, so
  // this never trips an excess-property error) — `merged`'s own inferred type
  // (every field's REAL, often Mock-typed, shape) is what callers actually
  // get back, not this widened annotation.
  const asApp: App = merged;
  void asApp;
  return merged;
}
