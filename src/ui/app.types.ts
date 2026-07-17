// Phase-final typed contract for the `app` controller (src/ui/app.ts).
// Describes the surface OTHER modules read/call — not createApp's full
// internal ~290-property implementation — verified against real usage across
// src/ui/*.ts, src/editor/*.ts and src/main.js (ADR-0002 phase 0 / #262, #267).
// app.ts's own `createApp` return value is declared against this contract
// directly (`const app = {} as App;` + property assignment — see app.ts).
//
// `State`/`Tab` are the real src/state.ts types (ADR-0002 phase 2), re-exported
// under the names this contract has always used.

import type { EditorView } from '@codemirror/view';
import type { EditorPort } from '../editor/editor-port.types.js';
import type { SpecEditorPort } from '../editor/spec-editor.types.js';
import type { CodeViewerFactory } from '../editor/code-viewer.types.js';
import type { QueryTab as Tab, AppState as State, SpecValidationService } from '../state.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { ConnectionSession, SessionChCtx } from '../application/connection-session.js';
import type { SchemaCatalogService } from '../application/schema-catalog-service.js';
import type { SchemaGraphSession } from '../application/schema-graph-session.js';
import type { AppPreferences } from '../application/app-preferences.js';
import type { WorkspaceRepository } from '../workspace/workspace-repository.js';
import type { StoredWorkspaceV1 } from '../generated/json-schema.types.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { DynamicSources } from '../core/spec-completion.js';
import type { WorkbenchSession } from './workbench/workbench-session.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { ExportService } from '../application/export-service.js';
import type { QueryDocumentSession } from '../application/query-document-session.js';
import type { SavedQueryService } from '../application/saved-query-service.js';

export type { QueryTab as Tab, AppState as State } from '../state.js';

type Json = Record<string, unknown>;

/** A schema entity reference — three real runtime shapes share this one loose
 * contract: `showSchemaGraph`/`expandSchemaGraph`'s FOCUS payload (schema.ts's
 * drag/click sources always send `{kind, db}` or `{kind, db, table}` —
 * `core/schema-graph.ts`'s own `SchemaGraphFocus`, whose own `db` is likewise
 * optional); a resolved lineage-graph NODE a click passes to `openNodeDetail`
 * (`{db, name}`, `id` optional — schema-detail.ts's `DetailNode` requires it,
 * but a caller/test may omit it, same as node.id ever being read as
 * `undefined` there); `kind` (missing pre-#267) and `table`/`id` cover all
 * three without a cast at any one call site. `db` is optional too — all three
 * real consumers (`showSchemaGraph`/`expandSchemaGraph`/`openNodeDetail`,
 * app.ts) guard `if (!focus.db) return;` before using it, a no-db focus
 * (e.g. a test exercising that guard) is a legitimate call. */
export interface SchemaFocus {
  db?: string;
  name?: string;
  table?: string;
  kind?: string;
  id?: string;
}

/** `app.dom` is reset wholesale (`{}`) at the top of every renderApp() call —
 * a stable dictionary of known-consumed keys, not a closed interface. Beyond
 * the keys other modules read (documented individually below), it also carries
 * every DOM ref + var-strip rebuild bookkeeping field app.ts's own renderApp()/
 * renderVarStrip() attach to `app.dom` (never read outside app.ts, but typed
 * here since AppDom is the one place `app.dom`'s shape is described). */
export interface AppDom {
  fileBtn?: HTMLElement;
  fileDialog?: HTMLElement;
  fileMenu?: HTMLElement;
  fileMenuOverlay?: HTMLElement;
  libraryTitle?: HTMLElement;
  qtabsInner?: HTMLElement;
  resultsRegion?: HTMLElement;
  runElapsedEl?: HTMLElement;
  savedList?: HTMLElement;
  savedSearch?: HTMLElement;
  savedTabsRow?: HTMLElement;
  schemaList?: HTMLElement;
  specEditorView?: EditorView;
  sqlEditorView?: EditorView;
  themeBtn?: HTMLElement;

  // app.ts-internal only (renderApp()'s own mounted chrome + renderVarStrip()'s
  // rebuild bookkeeping) — not read by any other module.
  banner?: HTMLElement;
  connStatus?: HTMLElement;
  editorModeSwitch?: HTMLElement;
  editorRegion?: HTMLElement;
  editorResultsSplit?: HTMLElement;
  exportBtn?: HTMLButtonElement;
  explainBtn?: HTMLButtonElement;
  fmtBtn?: HTMLButtonElement;
  formatSpecBtn?: HTMLButtonElement;
  mobileBadge?: HTMLElement;
  mobileNav?: HTMLElement;
  mobileSegmented?: HTMLElement;
  runBtn?: HTMLButtonElement;
  saveBtn?: HTMLButtonElement;
  savePopover?: HTMLElement;
  schemaSearchInput?: HTMLInputElement;
  shareBtn?: HTMLButtonElement;
  sideSplit?: HTMLElement;
  specEditorHost?: HTMLElement;
  specModeBtn?: HTMLButtonElement;
  specPane?: HTMLElement;
  specStatus?: HTMLElement;
  sqlEditorHost?: HTMLElement;
  sqlModeBtn?: HTMLButtonElement;
  userBtn?: HTMLButtonElement;
  userMenu?: HTMLElement;
  varStrip?: HTMLElement;
  varStripSig?: string;
  varStripRerenderPending?: boolean;
  varStripDeferHooked?: boolean;
}

/** The live ClickHouse auth context every query call site reads/mutates —
 * a structural alias of `application/connection-session.ts`'s own
 * `SessionChCtx` (the session is the one place that constructs and mutates
 * it now, #276 Phase 2) rather than a second, independently-maintained
 * copy of the same shape. `src/ui/**` may depend on `src/application/**`,
 * never the reverse — connection-session.ts redeclares this shape itself
 * rather than importing it from here. */
export type ChCtx = SessionChCtx;

export interface ActionsRegistry {
  run(opts?: Json): void | Promise<void>;
  cancel(): void;
  newTab(): void;
  selectTab(id: string): void;
  closeTab(id: string): void;
  loadIntoNewTab(queryOrName: string | Json, sql?: string): void;
  login(idpId?: string, targetOrigin?: string): Promise<void>;
  connect(creds: { username: string; password: string; host?: string }): Promise<void>;
  share(): void;
  copyResult(): void;
  copySnapshot(result: Json | null, targetDoc?: Document): void;
  exportEntry(): Promise<void> | undefined;
  exportDirect(sqlInput: string, waveMs: number): Promise<void>;
  cancelExport(): void;
  cancelExportScript(): void;
  /** null: nothing to save (empty draft); undefined: the create-popover opened
   * instead of returning a result. A committed/created save resolves the real
   * generated `SavedQueryV2` entry (state.ts's `commitSavedQuery`/
   * `createSavedQuery`) — `Json` undersold it as opaque. */
  save(): SavedQueryV2 | null | undefined;
  openUserMenu(): void;
  formatQuery(): Promise<void>;
  formatSpec(): void;
  setEditorMode(mode: 'sql' | 'spec'): boolean;
  explainQuery(): Promise<void> | undefined;
  setExplainView(id: string): Promise<void> | undefined;
  setResultRowLimit(n: number): Promise<void> | undefined;
  showSchemaGraph(focus: SchemaFocus): Promise<void>;
  cancelSchemaGraph(opts?: { clearResult?: boolean }): void;
  expandSchemaGraph(focus: SchemaFocus): Promise<void>;
  /** `node.db`/`node.name` are both checked at runtime (a node missing either
   * is a silent no-op) — `Required<SchemaFocus>` overstated that as a caller
   * guarantee; real callers (schema-detail.ts's clicked card, tests exercising
   * the guard) can and do omit `name`. */
  openNodeDetail(node: SchemaFocus, targetDoc?: Document): Promise<void>;
  insertCreate(target: string): Promise<void>;
  openCreateInNewTab(target: string, name?: string): Promise<void>;
  openShortcuts(): void;
  openDashboard(): void;
  insertAtCursor(text: string): void;
  replaceEditor(text: string): void;
  loadColumns(db: string, table: string): Promise<void>;
  rerenderTabs(): void;
  rerenderResults(): void;
  updateSaveBtn(): void;
}

export interface App {
  state: State;
  dom: AppDom;
  root: Element | null;
  document: Document;

  /** The auth + config + ClickHouse connection lifecycle (#276 Phase 2) —
   *  OAuth PKCE login/refresh, Basic probing, IdP config resolution, and
   *  cross-tab auth handoff, constructible without App/AppState/DOM
   *  (`src/application/connection-session.ts`). The identity/auth members
   *  below (`isSignedIn`/`email`/`host`/…) are Phase-2 delegates onto this —
   *  shells/bootstrap consume those; a future phase re-points them to
   *  `app.conn` directly. */
  conn: ConnectionSession;

  // Editor ports (injected seams — #143/#212).
  sqlEditor: EditorPort;
  specEditor: SpecEditorPort;
  CodeViewer: CodeViewerFactory;
  /** {validate, register} — see core/spec-draft.js. Typed as the service
   *  surface consumers feed into patchSpecDraft/setTabSpecDraft; `register`
   *  is app.js-internal wiring, outside this contract. */
  specValidators: SpecValidationService;
  /** CM6 completion sources for the Spec JSON editor — the `resultColumns`/
   *  `resultColumnIndexes`/`queryParameters` bag `spec-completion-adapter.ts`'s
   *  `createSpecCompletionSources()` builds (or an injected replacement),
   *  keyed by source name (`core/spec-completion.ts`'s own `DynamicSources`).
   *  Previously `unknown[]` — undersold app.ts's real assignment (#267). */
  specCompletionSources: DynamicSources;

  // Charting / graph / window seams (pass-through from env).
  Chart: unknown;
  cssVar: (name: string) => string;
  Dagre: unknown;
  openWindow: (url?: string, target?: string, features?: string) => Window | null;
  stylesText: string;
  faviconHref: string;
  toggleTheme(): void;
  /** Ad-hoc, consumer-attached (chart-render.js), not initialized by createApp. */
  chart?: { destroy(): void };

  // Identity / auth — all live on `app.conn` (see its doc comment above),
  // e.g. `conn.host()`/`conn.email()`/`conn.isSignedIn()`. `authMode`/
  // `chAuth`/`basicUserClaim`/`idpId`/`selectIdp`/`chUsername` likewise moved
  // there in Phase 2; the flat `App` delegates that used to forward onto them
  // (`isSignedIn`/`email`/`host`/`hostHint`/`basePath`/`setTokens`/
  // `loadConfig`/`loadIdps`/`ensureConfig`/`ensureFreshToken`/`chCtx`/
  // `receiveAuthHandoff`) were deleted in #276 Phase 5 — every consumer reads
  // `app.conn.*` directly now. `showLogin`/`signOut` stay here: they compose
  // rendering (`renderLoginApp`), not pure forwards.
  activeTab(): Tab;
  showLogin(msg?: string): void;
  signOut(): void;
  canExport(): boolean;
  canExportScript(): boolean;
  showSaveFilePicker: ((opts?: unknown) => Promise<unknown>) | null;
  showDirectoryPicker: ((opts?: unknown) => Promise<unknown>) | null;
  isSecureContext: boolean;
  FileReader: typeof FileReader;
  /** Mobile-breakpoint seam (#126), app.ts-internal (renderApp seeds/tracks
   * `state.isMobile` against it) — not read by any other module. */
  matchMedia: ((query: string) => MediaQueryList) | null;
  /** Build stamp shown in the user menu (app.ts's own openUserMenu) — not read
   * by any other module. */
  build: string;

  // Persistence.
  /** The true-preference persist service (#276 Phase 4D —
   *  `src/application/app-preferences.ts`), constructible without
   *  App/AppState/DOM. Consumers (dashboard.ts/saved-history.ts/splitters.ts)
   *  call `prefs.save(name, value)` directly (#276 Phase 5 deleted the flat
   *  `App.savePref` delegate); `toggleTheme`'s preference-write half also
   *  delegates here, the DOM half stays in app.ts. */
  prefs: AppPreferences;
  /** Atomic StoredWorkspaceV1 aggregate persistence (#280 Phase 2 / #284),
   *  behind the injected IndexedDB seam (`env.indexedDB`). Pure/testable — no
   *  App/AppState/DOM dependency. In this phase it is constructed but the
   *  favorites-driven Dashboard render still reads legacy keys; Phases 3-6 of
   *  #280 route reads/commits through it and retire the legacy keys. */
  workspace: WorkspaceRepository;
  saveJSON(key: string, value: unknown): void;
  saveStr(key: string, value: string): void;
  /** The one deliberate delegate survivor of #276 Phase 5's params-group
   *  cleanup (`saveVarValues`/`saveFilterActive`/`saveVarRecentDisabled`/
   *  `recordBoundParams`/`clearVarRecent`/`clearAllVarRecent`/`hardenedVars`
   *  all moved to `app.params.*` with no flat delegate) — kept as a mutable
   *  property because `WorkbenchParameterSession`'s internal hook reads the
   *  LIVE `app.saveVarRecent` on every call (not `params.saveVarRecent`
   *  directly), so a caller that substitutes it (`app.saveVarRecent =
   *  vi.fn(app.saveVarRecent)`, app.test.ts) still observes every automatic
   *  persist `recordBoundParams`/`clearVarRecent`/`clearAllVarRecent`
   *  performs — see workbench-parameter-session.ts's header comment. */
  saveVarRecent(): void;
  recordHistory(tab: Tab, sqlText?: string): void;
  downloadFile(filename: string, mime: string, content: BlobPart): void;
  /** Whether the header library-name field is in its inline-edit state. Not a
   * signal — file-menu.js renders it directly. */
  editingLibrary: boolean;

  // Data / schema loaders.
  /** The server-metadata/reference lifecycle service (#276 Phase 4A) —
   *  `src/application/schema-catalog-service.ts`, constructible without
   *  App/AppState/DOM: `loadVersion`/`loadSchema`/`loadReference`/
   *  `rebuildCompletions`/`entityDoc`/`docCache`/`refData`/`completions` all
   *  live on it now — the flat `App` delegates that used to forward onto
   *  them were deleted in #276 Phase 5; every consumer reads `app.catalog.*`
   *  directly. */
  catalog: SchemaCatalogService;
  updateBanner(): void;

  // Query-run / var-strip / editor-mode UI hooks.
  wallNow(): number;
  now(): number;
  elapsedMs(): number;
  tickElapsed(): void;
  /** The route-scoped run/runScript/runEntry/cancel session (#276 Phase 3a —
   *  `src/ui/workbench/workbench-session.ts`), constructed without App/DOM.
   *  Owns the run bookkeeping and in-flight AbortController privately; the
   *  Run/Cancel actions and the Explain/row-limit re-run paths delegate to it,
   *  and `renderApp`'s `attachShell` call wires its 3 run-coupled effects. */
  workbench: WorkbenchSession;
  /** The `{name:Type}` query-variable POLICY (#276 Phase 4B1 —
   *  `src/application/workbench-parameter-session.ts`), constructible
   *  without App/AppState/DOM: analyze/prepare/gate/execution-view, the #170
   *  hardening bookkeeping, the #172 v2 schema-cache enum-suggestion
   *  inference, and the #171 recent-value + persistence policy.
   *  `renderVarStrip`/`setRunBtn` (DOM) stay in app.ts, calling this
   *  session's methods directly; the workbench-session hooks + the export
   *  block's direct calls are re-pointed here too. `saveVarValues`/
   *  `saveFilterActive`/`saveVarRecentDisabled`/`recordBoundParams`/
   *  `clearVarRecent`/`clearAllVarRecent`/`hardenedVars` have no flat `App`
   *  delegate (#276 Phase 5 deleted them) — every consumer reads
   *  `app.params.*` directly. `saveVarRecent` is the one exception (see its
   *  own doc comment under Persistence). */
  params: WorkbenchParameterSession;
  /** The streaming single-file export (issue #87) + multi-statement script
   *  export (issue #99) POLICY (#276 Phase 4B2 —
   *  `src/application/export-service.ts`), constructible without
   *  App/AppState/DOM. `actions.exportEntry`/`.exportDirect`/`.cancelExport`/
   *  `.cancelExportScript` are one-line delegates onto this; `state.exporting`
   *  stays an `AppState` signal this service is the sole writer of.
   *  `canExport`/`canExportScript` (env capability checks) and
   *  `showExportProgress` (the DOM progress banner) stay app.ts-owned,
   *  injected into this service. */
  exports: ExportService;
  /** The shared request/stream/normalize + multiquery-script transport
   *  service (#276 Phase 1) — `src/application/query-execution-service.ts`,
   *  constructible without App/AppState/DOM. `src/ui/**` may depend on
   *  `src/application/**`, never the reverse. */
  exec: QueryExecutionService;
  /** The inline schema-lineage drawer + fullscreen expand/detail session
   *  (#276 Phase 4D — `src/application/schema-graph-session.ts`),
   *  constructible without App/AppState/DOM. `actions.showSchemaGraph`/
   *  `cancelSchemaGraph`/`expandSchemaGraph`/`openNodeDetail` delegate to it;
   *  the DOM (the fullscreen view object, the node-detail pane mount) stays
   *  in app.ts — this session never sees either. */
  graph: SchemaGraphSession;
  setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void;
  renderVarStrip(): void;
  setExportBtn(exporting: boolean): void;
  /** Format-button busy/spinner toggle (app.ts-internal — not read by any
   * other module, but directly exercised by tests). */
  setFmtBtn(busy: boolean): void;
  specBlocked(tab: Tab): boolean;
  updateSaveBtn(): void;
  /** Only present after the first renderApp() call. */
  updateEditorModeUi?: () => void;
  syncSelection?: () => void;
  /** The Spec-evaluation/document lifecycle (#276 Phase 4C —
   *  `src/application/query-document-session.ts`), constructible without
   *  App/AppState/DOM. `evaluateSpecDraft`/`revalidateSpecDrafts`/
   *  `revealFirstSpecError`/`registerSpecValidator` have no flat `App`
   *  delegate (#276 Phase 5 deleted them — every consumer reads
   *  `app.queryDoc.*` directly); `activateInvalidSpecDraft` below stays
   *  shell-owned (DOM/focus — app.ts's `setEditorMode` also calls
   *  `queryDoc.resolveEditorMode` for the editor-mode-switch POLICY half,
   *  keeping the DOM/focus half itself). */
  queryDoc: QueryDocumentSession;
  /** `tab` is a defensive no-op-on-falsy read (`if (!tab) return;`, app.ts) —
   *  a test exercising a no-linked-tab call site passes `null` directly. */
  activateInvalidSpecDraft(tab: Tab | null): void;
  /** The saved-query create/commit policy, history recording, and share-URL
   *  building (#276 Phase 4C — `src/application/saved-query-service.ts`),
   *  constructible without App/AppState/DOM. app.ts's `commitLinkedQuery`/
   *  `openSavePopover`'s commit closure/`share` call this directly and keep
   *  owning the post-commit DOM cascade + clipboard/location writes
   *  themselves (see that module's header comment). */
  saved: SavedQueryService;
  openSavePopover(): void;
  openUserMenu(): void;

  // Rendering / lifecycle.
  renderApp(): void;
  renderDashboard(): void;
  openDashboard(): void;
  /** #286 Phase 4: resolve the current StoredWorkspaceV1 for the Dashboard
   *  viewer, running the one-shot legacy migration first when no aggregate
   *  exists. Returns null when neither an aggregate nor a migratable legacy
   *  workspace is available. */
  loadDashboardWorkspace(): Promise<StoredWorkspaceV1 | null>;

  actions: ActionsRegistry;
}
