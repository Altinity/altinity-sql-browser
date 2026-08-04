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
import type {
  WorkspaceExternallyChangedInfo, WorkspaceMutationInput, WorkspaceMutationOutcome,
} from '../state.js';
import type { DocTarget } from '../core/doc-types.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { ConnectionSession, SessionChCtx } from '../application/connection-session.js';
import type { AuthenticatedExecutionScope } from '../application/authenticated-execution-scope.js';
import type { SchemaCatalogService } from '../application/schema-catalog-service.js';
import type { SchemaGraphSession } from '../application/schema-graph-session.js';
import type { AppPreferences } from '../application/app-preferences.js';
import type {
  DashboardFocusTarget, DashboardSurfaceMode, MainSurfaceState, OpenDashboardRequest,
} from '../application/main-surface.js';
import type { WorkspaceRepository } from '../workspace/workspace-repository.js';
import type { StoredWorkspaceV5 } from '../generated/json-schema.types.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { SqlRoute } from '../core/sql-route.js';
import type { DashboardFocusOutcome, SurfaceCommandPort } from './shortcuts.js';
import type { DynamicSources } from '../core/spec-completion.js';
import type { WorkbenchSession } from './workbench/workbench-session.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { ExportService } from '../application/export-service.js';
import type { QueryDocumentSession } from '../application/query-document-session.js';
import type { SavedQueryService } from '../application/saved-query-service.js';
import type { OAuthDocumentRecoveryRestoreResult } from '../application/oauth-document-recovery-session.js';
// Type-only, and circular with `app-shell.ts` (which imports `App` from this
// file) — TypeScript erases `import type` entirely, so this introduces no
// runtime cycle. `AppShellHandle` is the ONE seam `app.shell` exposes: the
// side-panel registry (`refreshActiveSidePanels`/`notifyRunComplete`), which
// must be reachable from controller-construction time (before any shell
// exists) through shell disposal — see `app-shell.ts`'s own header comment
// and `saved-history.ts`'s `renderSavedHistory` compatibility export.
import type { AppShellHandle } from './app-shell.js';

export type { QueryTab as Tab, AppState as State } from '../state.js';
// #457: the `mutateWorkspace` contract types are DECLARED in `state.ts`, beside
// `MutateWorkspace` itself, and re-exported here so this file remains the one
// place the App contract is read from. They used to be declared HERE and imported
// by state.ts, which pointed the dependency the wrong way: `src/application/**`
// may not import `src/ui/**` at all (`import type` included), so an
// application-layer producer had no way to name what the primitive it commits
// through resolves.
export type {
  WorkspaceExternallyChangedInfo, WorkspaceMutationInput, WorkspaceMutationOutcome,
} from '../state.js';

type Json = Record<string, unknown>;

/** Application-shell recovery outcome. `kind: 'restored'` means bootstrap must
 * render the published tabs; `kind: 'retry-deferred-retained'` means the normal
 * workspace remains visible while validated recovery authority is retained.
 * Both suppress legacy shared content. A retained finalization warning means
 * the authored document is live and guarded, but its checkpoint remains
 * available because revalidation or storage cleanup could not complete. */
export type OAuthDocumentRecoveryApplyResult =
  | Exclude<OAuthDocumentRecoveryRestoreResult, { kind: 'restored' }>
  | { kind: 'restored'; finalization: 'complete' }
  | {
    kind: 'restored';
    finalization: 'checkpoint-retained';
    warning: 'spec-revalidation-failed' | 'checkpoint-remove-failed';
  };

/** The cross-tab invalidation signal (#343 §5) — a small "reload the record"
 *  poke, never the workspace body. `sourceTabId` lets a tab ignore its OWN
 *  broadcast; `workspaceId` scopes it to a specific aggregate. */
export interface WorkspaceChangedMessage {
  type: 'workspace-changed';
  sourceTabId: string;
  workspaceId: string;
}

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
  libraryTitle?: HTMLElement;
  /** #426 — the upper sidebar pane's `Databases | Dashboards` role tab row. */
  upperRoleTabs?: HTMLElement;
  /** #426 — the Dashboard hierarchy tree's `role="tree"` row container. */
  dashboardTreeList?: HTMLElement;
  /** #426 — the Dashboard tree's search box. Built once, OUTSIDE the repainted row
   *  list, so typing keeps the caret. */
  dashboardSearchInput?: HTMLInputElement;
  qtabsInner?: HTMLElement;
  resultsRegion?: HTMLElement;
  /** #586 — the shell-owned docked right-inspector slot (a layout sibling of
   *  `queryHost`/`dashboardHost` in app-shell.ts's `mainRow`) and its resize
   *  handle. Content mounts here via `inspector-host.ts`'s `showInInspector`/
   *  `releaseInspector` — never `document.body` directly. */
  inspectorHost?: HTMLElement;
  inspectorResize?: HTMLElement;
  /** #586 findings 1/2b — shell-owned hooks `inspector-host.ts` calls at the
   *  two points it folds/unfolds the host: `cancelInspectorDrag` stops a
   *  still-live 'rightInspector' drag before folding (so it can't keep
   *  mutating a now-hidden host or persist an abandoned width);
   *  `reclampInspectorWidth` recomputes the DISPLAYED width against the
   *  current viewport/sidebar before unfolding (the persisted preference may
   *  be stale). See `inspector-host.ts`'s `InspectorHostApp` for the full
   *  rationale — this is the same `dom` bag that module already reads
   *  `inspectorHost`/`inspectorResize` off of. */
  cancelInspectorDrag?: () => void;
  reclampInspectorWidth?: () => void;
  runElapsedEl?: HTMLElement;
  // #587: `savedList`/`savedSearch`/`savedTabsRow` are GONE — the Library and
  // History panels each own a persistent host built by
  // `side-panel-registry.ts`'s `buildSidePanelRegistry`, reachable via
  // `app.shell.sidePanels`, not through named `AppDom` fields. Adding a new
  // side panel needs no `AppDom` field at all (#587 AC5).
  schemaList?: HTMLElement;
  specEditorView?: EditorView;
  sqlEditorView?: EditorView;
  themeBtn?: HTMLElement;

  // app.ts-internal only (renderApp()'s own mounted chrome + renderVarStrip()'s
  // rebuild bookkeeping) — not read by any other module.
  banner?: HTMLElement;
  /** Stable in-shell mount for temporary authentication recovery controls. */
  authHost?: HTMLElement;
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

/** The currently open UI primitive that has exclusive keyboard handling. */
export interface KeyboardOwner {
  kind: 'modal' | 'menu' | 'popover';
}
export type KeyboardOwnerRelease = () => void;

export interface ShortcutDialogHandle {
  backdrop: HTMLElement;
  close(): void;
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
  /** The UNCONDITIONAL primitive (`tabs.ts`'s own `closeTab`) — never asks
   *  first, even for a dirty draft. The tab strip's own close button does NOT
   *  call this: it goes through `tabs.ts`'s `requestCloseTab`, which confirms
   *  a dirty tab before delegating here (#466). Wiring a future trigger
   *  (keybinding, command palette, context menu) to this action directly
   *  would silently skip that guard — prefer `requestCloseTab` for anything
   *  reachable from user interaction. */
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
  /** null: nothing to save (empty draft, or the aggregate strictly rejected
   * the commit — #287 W4); undefined: the create-popover opened instead of
   * returning a result. A committed/created save resolves the real generated
   * `SavedQueryV2` entry (state.ts's `commitSavedQuery`/`createSavedQuery`,
   * both async now) — `Json` undersold it as opaque. */
  save(): Promise<SavedQueryV2 | null | undefined>;
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
  // #452 removed `exportDashboard`/`importDashboard`: both existed only so the
  // Dashboard's own File menu could reach implementations in file-menu.ts. With
  // one shared menu those calls are module-local, and the actions took no
  // target — which is what let them fall back to the compatibility Dashboard.
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
  /** #587 (#425/#586 precedent): the persistent app frame's handle, `null`
   *  before the first `mountAppShell` call and after a teardown
   *  (`ensureShell`/`disposeShell` in app.ts keep this mirrored). Exposes the
   *  side-panel registry through `shell.sidePanels` — the seam
   *  `saved-history.ts`'s `renderSavedHistory` compatibility export and the
   *  workbench's clean-run hook address, both of which must stay safe to call
   *  before any shell exists or after it is torn down. */
  shell: AppShellHandle | null;
  /** Set by shared overlay primitives for the duration of their open lifecycle. */
  keyboardOwner: KeyboardOwner | null;
  /** Acquire exclusive application-keyboard ownership. The returned idempotent
   * release removes only this acquisition, preserving any owner below it. */
  acquireKeyboardOwner(kind: KeyboardOwner['kind']): KeyboardOwnerRelease;
  resetShortcutChord(): void;
  shortcutDialog: ShortcutDialogHandle | null;
  closeShortcutDialog(): void;

  /** The auth + config + ClickHouse connection lifecycle (#276 Phase 2) —
   *  OAuth PKCE login/refresh, Basic probing, and IdP config resolution,
   *  constructible without App/AppState/DOM
   *  (`src/application/connection-session.ts`). The identity/auth members
   *  below (`isSignedIn`/`email`/`host`/…) are Phase-2 delegates onto this —
   *  shells/bootstrap consume those; a future phase re-points them to
   *  `app.conn` directly. */
  conn: ConnectionSession;
  /** Current disposable authenticated execution scope, or null while the
   * mounted document session is suspended for reauthentication. */
  executionScope(): AuthenticatedExecutionScope | null;
  /** Start a fresh scope for the session's current credential epoch. Bootstrap
   * and successful in-place Basic authentication call this before server work. */
  resumeAuthenticatedExecution(): void;
  /** Shared gate for server-dependent commands. A null return also reveals and
   * focuses the mounted recovery controls when the document shell is alive. */
  requireAuthenticatedExecution(): AuthenticatedExecutionScope | null;

  // Editor ports (injected seams — #143/#212).
  sqlEditor: EditorPort;
  specEditor: SpecEditorPort;
  CodeViewer: CodeViewerFactory;
  // #457 removed `VariableEditor` and `runOptionQuery`: both existed only for the
  // per-variable option-SQL DRAWER (a second SQL editing surface, with its own
  // editor seam and its own Test transport). Option SQL is edited in the main
  // editor as a `dashboard-variable` tab now, so it reuses `sqlEditor` and the
  // ordinary Run action — there is nothing left for a second seam to inject.
  /** #313: the open-the-reference-pane action the CM6 adapter's hover button
   *  and F1 command invoke — bound by app.ts to ui/doc-pane.ts's
   *  `openDocEntry(app, target)` so the editor layer never imports UI
   *  modules (build/check-boundaries.mjs enforces the direction). */
  openDocEntry: (target: DocTarget) => void;
  /** #315 — the open-the-disambiguation-state action the F1 command falls
   *  back to when no strong target resolves for a bare word — bound by
   *  app.ts to ui/doc-pane.ts's `openDocDisambiguation(app, name)`, for the
   *  identical "editor never imports UI" reason as `openDocEntry` above. */
  openDocDisambiguation: (name: string) => void;
  /** #60 — closes the docs reference pane when open (true) / no-op (false);
   *  the global Escape shortcut calls it so Esc works from anywhere. */
  closeDocPane: () => boolean;
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
  // `loadConfig`/`loadIdps`/`ensureConfig`/`ensureFreshToken`/`chCtx`) were
  // deleted in #276 Phase 5 — every consumer reads
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
  /** Atomic StoredWorkspaceV5 aggregate persistence (#280 Phase 2 / #284),
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
   *  `rebuildCompletions`/`docSummary`/`docEntry`/`refData`/`completions` all
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
  renderCurrentSurface(): void;
  /** #466/#501-review: re-syncs the `beforeunload` listener to whether ANY
   *  tab is currently `tabSaveDirty` — installs it on a clean→dirty flip,
   *  removes it on dirty→clean, idempotent otherwise. Called from the tab-list
   *  reactive effect (`workbench-shell.ts`) and `actions.rerenderTabs`; see
   *  `createApp`'s own definition for why both are needed. */
  syncBeforeUnload(): void;
  /** Restore a callback-state-bound OAuth document checkpoint into the
   * already-loaded authoritative workspace. The shell revalidates raw Spec
   * drafts, reinstalls the ordinary dirty guard, then consumes only a fully
   * restored checkpoint. Once tabs have been published, finalization failures
   * remain a restored outcome so bootstrap cannot hide them behind a shared
   * placeholder or abort first render. */
  restoreOAuthDocumentRecovery(callbackState: string): OAuthDocumentRecoveryApplyResult;
  /** Retry only a recovery explicitly marked pending by a successful callback
   * whose authoritative workspace was temporarily unavailable. Ordinary
   * checkpoints without that marker remain inert. An unsafe authority-retire
   * attempt stays unpublished, retains recovery data, and surfaces one safe
   * retry notice through the application shell. */
  retryPendingOAuthDocumentRecovery(): OAuthDocumentRecoveryApplyResult;
  /** Consume the one-shot legacy `oauth_shared` handoff. When `allowRestore`
   * is false (a recovered OAuth document won precedence), discard it without
   * applying; otherwise seed the loaded Query workspace before first render.
   * Bootstrap may pass the already-consumed serialized value; in-page Basic
   * login omits it and lets the app take its own sessionStorage handoff.
   * Returns whether authored shared content was applied. */
  consumeLegacyShared(allowRestore: boolean, consumedHandoff?: string | null): boolean;
  /** #425 — which main work surface owns the right-hand work area, and, for a
   *  Dashboard, WHICH stored Dashboard is selected in which presentation mode,
   *  plus (#426) the member currently navigated to inside it and any focus
   *  delivery still owed to the surface. SESSION state: never persisted,
   *  cleared on sign-out, re-validated against every committed workspace, and
   *  identified only by `DashboardDocumentV2.id` — never by collection position.
   *  It is also the ONE writer of the `/sql` route's surface/mode, so the URL is
   *  always derived from this and the two can never disagree. */
  mainSurface: MainSurfaceState;
  /** #425 — the one application-level Dashboard navigation entry point. Resolves
   *  the Dashboard by exact id in the active workspace; a missing or duplicate id
   *  is reported through the shared diagnostic path and changes no state. Never
   *  mutates the Dashboard merely by opening it. A repeated open of the same
   *  id+mode with no focus target is a no-op that leaves the live viewer session
   *  alone; #426 makes one WITH a focus target an IN-PLACE navigation through the
   *  surface command port — no rebuild, no rerun, no extra history entry — rather
   *  than the full re-render #425 used to deliver it. */
  openDashboard(request: OpenDashboardRequest): void;
  /** #426 — deliver focus to ONE member of the already-rendered Dashboard through
   *  the route-local surface command port, without rebuilding or re-running it.
   *  `pending` means "not deliverable in place right now" (mid-wave curated
   *  filter, or a superseded/absent port) and is the caller's cue to take the
   *  normal render transition — never a diagnostic. */
  focusDashboardMember(member: DashboardFocusTarget): DashboardFocusOutcome;
  /** #426 — bump the Dashboard tree's explicit repaint invalidation. The tree
   *  projects the committed workspace aggregate plus main-surface navigation
   *  state, neither of which is a signal. */
  invalidateDashboardTree(): void;
  /** #425 — return to the preserved Query surface (editor + result drawer). */
  showQuerySurface(): void;
  /** #425 — the legacy no-chooser Dashboard entry point: resolves the
   *  compatibility Dashboard and opens it by id, falling back to the Dashboard
   *  surface's own "Create dashboard" state for an empty collection. */
  showDashboardSurface(mode: DashboardSurfaceMode): void;
  /** #425 — open a saved query into a tab, switching back to Query mode first.
   *  #443 — the id is resolved BEFORE anything moves: one that names no saved
   *  query reports a diagnostic and changes no surface, no route and no tab. */
  openSavedQuery(queryId: string): void;
  /**
   * #535 — a Dashboard TILE's own expand action: everything `openSavedQuery`
   * does, plus the two things that make it an act of "go work on this panel"
   * rather than "go look at some query".
   *
   *  - the query RUNS on arrival (when it is auto-runnable), on its own saved
   *    view, so the editor shows the same result the tile was showing;
   *  - the Dashboards tree is revealed with this panel's row expanded and armed,
   *    so leaving the Dashboard does not lose the user's place in it.
   *
   * The tile is addressed by all three ids because each answers a different
   * question: `queryId` is the document to open, and `dashboardId`+`tileId` are
   * the tree row to reveal — a tile's row cannot be derived from its query.
   */
  openPanelQuery(target: { dashboardId: string; tileId: string; queryId: string }): void;
  /** #457 — open (or re-select) the main-editor tab that edits ONE Dashboard
   *  variable's option SQL, switching back to Query mode first. A variable is
   *  addressed by Dashboard id + exact name, which is the only identity it has:
   *  it is not a saved query, and no `SavedQueryV2` is created for it. A name
   *  that no longer resolves opens nothing. */
  openVariableTab(dashboardId: string, variableName: string): void;
  /** Current canonical `/sql` route and the live workspace resolved for it. */
  sqlRoute: SqlRoute;
  currentWorkspace: StoredWorkspaceV5 | null;
  workspaceRouteStatus: 'loading' | 'ready' | 'not-found' | 'error';
  /** Route-local commands registered by the mounted surface. They are cleared
   * before every transition, so a disposed Dashboard viewer cannot be called. */
  surfaceCommands: SurfaceCommandPort | null;
  /** Renderer lifetime, distinct from workspace-load ordering. Any surface
   * teardown/remount advances it so obsolete async callbacks can finish their
   * durable work without settling against a replacement renderer. */
  captureSurfaceGeneration(): number;
  isSurfaceGenerationCurrent(generation: number): boolean;
  /** Return true while the caller still owns the mounted renderer. A stale
   * caller gets no settlement rights; after a successful durable commit, the
   * currently selected ready surface is refreshed from shared projection. */
  refreshCurrentSurfaceAfterStale(generation: number, committed?: boolean): boolean;
  /** Navigate within the single artifact. Surface changes use push; mode and
   * canonicalization use replace. */
  navigateSqlRoute(route: SqlRoute, method: 'push' | 'replace'): Promise<void>;
  /** Reparse the browser URL after Back/Forward and mount the selected surface. */
  handleSqlPopState(): Promise<void>;
  /** Synchronize route state after bootstrap rewrites an OAuth callback URL. */
  syncSqlRoute(search: string): void;
  /** Point the current surface/mode at an already-projected workspace. */
  rewriteWorkspaceRoute(workspaceKey: string): void;
  /** Repaint Dashboard after an in-tab import, retaining its route mode. */
  reloadDashboardRoute(): void;
  /** Resolve the explicit or implicit route workspace and, when it
   *  resolves a real aggregate, PROJECTS it onto `state` (`savedQueries`,
   *  `dashboard`, `workspaceId`, `libraryName`) so the whole app (not only
   *  the /dashboard route) treats the aggregate as the saved-query
   *  collection's single source of truth. `main.ts`'s `bootstrap` awaits
   *  this before the first `renderApp()`. On a null/failed load, `state`
   *  keeps whatever the legacy-projected `createState()` synchronous read
   *  already populated (a brand-new install, or a degraded IndexedDB). */
  loadWorkspaceOnBoot(): Promise<StoredWorkspaceV5 | null>;
  /** #287 W5: project a committed `StoredWorkspaceV5` onto `state`
   *  (`savedQueries`/`dashboard`/`workspaceId`/`libraryName`, and clear
   *  `libraryDirty` — a fresh committed workspace is, by construction, in
   *  sync with what's persisted) — the exact projection `loadWorkspaceOnBoot`
   *  inlined pre-#287 W5, now shared with every file-menu commit (New/Import/
   *  Replace/rename) so they never fork from the boot projection. Repaint
   *  (`updateSaveBtn`/`updateEditorModeUi`/`renderSavedHistory`) is the
   *  caller's job — this never touches `app.dom` (it also runs during boot,
   *  before the first `renderApp()`/mount). */
  applyCommittedWorkspace(workspace: StoredWorkspaceV5): void;
  /** #287 W5: a fresh, unguessable id (`uid('ws-')`), exposed here as the
   *  injected `WorkspaceIdGen` the file-menu's New workspace / Import /
   *  Replace operations pass to `createNewWorkspace`/the import planner. One
   *  shared generator: a minted id only needs to be unique, never to encode
   *  which op minted it. */
  genId(): string;
  /** #287 review fix: serialize saved-query write operations per-app so two
   *  overlapping async CRUD commits can't interleave. Each queued op runs only
   *  after the previous fully resolved (compute → commit → project), so it
   *  reads the freshest `state.savedQueries` — without this, a delete and a
   *  star toggle fired in rapid succession could each build a candidate from the
   *  same stale snapshot and the later commit would resurrect the deleted query
   *  (or clobber a concurrent edit). Rejections propagate to the caller; the
   *  queue itself never rejects. */
  serializeWrite<T>(op: () => Promise<T>): Promise<T>;
  /** #341: resolve once every write already queued through `serializeWrite`
   *  has settled — the flush point exports use so a bundle is built from the
   *  latest COMMITTED workspace, never mid-flight state. A write queued AFTER
   *  this call is intentionally not awaited by it. */
  flushWorkspaceWrites(): Promise<void>;
  /** #341/#344 review fix: the ONLY way a workspace mutation should build its
   *  candidate. A queue around independently pre-built full-workspace
   *  snapshots does not prevent lost updates — several `file-menu.ts`
   *  producers used to build a whole candidate from `state` BEFORE entering
   *  `serializeWrite`, so a mutation that committed while they awaited a user
   *  dialog (or just lost the race) got silently clobbered by the later,
   *  stale write. `mutateWorkspace` closes that window: the queued op reads
   *  the latest committed aggregate via `app.workspace.loadById()` at
   *  DEQUEUE time (never cached in a variable outside the op — every other
   *  producer commits through the same repository, so only a read taken
   *  inside the queue slot is guaranteed fresh), hands it to `transform`, and
   *  commits whatever `transform` returns. `transform` returning `null`/
   *  `undefined` aborts the op — nothing is committed and this resolves
   *  `null`. Rejections propagate to the caller like `serializeWrite`'s own;
   *  the queue itself never wedges. */
  mutateWorkspace<T = unknown>(
    transform: (latest: StoredWorkspaceV5 | null) =>
      WorkspaceMutationInput<T> | null | Promise<WorkspaceMutationInput<T> | null>,
  ): Promise<WorkspaceMutationOutcome<T>>;
  /** #343 §5: this tab's random per-session id, minted through the crypto seam.
   *  Stamped on every outgoing invalidation so a tab can ignore its own poke. */
  sourceTabId: string;
  /** #343 §6: whether this tab is currently visible (injected seam; see
   *  `CreateAppEnv.documentVisible`). Read by the focus/visibility refresh. */
  documentVisible(): boolean;
  /** #343 §2: the snapshot-identity token of the workspace this tab last
   *  committed/projected (`workspaceToken`), used only to detect whether a
   *  later reload actually changed anything. `''` before the first commit. */
  getLastCommittedToken(): string;
  /** #343 §5/§6: invoked when another tab reports a workspace change (channel
   *  receive, or a focus/visibility event). A no-op by default; the
   *  cross-tab-refresh work (#343 step 4) replaces it with the coalesced
   *  `refreshWorkspaceFromStore` scheduler. Never receives this tab's own
   *  broadcast. */
  onExternalWorkspaceChange(message: WorkspaceChangedMessage): void;
  /** #343 step 4: reload the committed workspace and, when it changed under this
   *  tab, project it + reconcile linked tabs — ordered through the same
   *  `serializeWrite` queue as mutations (so it can't project an older read over
   *  a newer local commit). A no-op when the store is unchanged since this tab's
   *  last projection; a failed load keeps the projection, warns, and never
   *  wedges the queue. The channel-receive + focus/visibility listeners drive a
   *  coalesced version of this internally; this public entry is the direct,
   *  un-coalesced one (tests + explicit callers). */
  refreshWorkspaceFromStore(): Promise<void>;
  /** #343 step 4: the route/surface refresh hook invoked AFTER a refresh
   *  actually projected an external change — a mounted route (the standalone
   *  Dashboard, a later step) overrides it to rebuild from the latest committed
   *  workspace. `queriesChanged` reports whether the query collection moved
   *  (a query-only change still needs a Dashboard viewer rebuild even when the
   *  Dashboard document is byte-identical). Default no-op; the Workbench route's
   *  own repaint is built into `refreshWorkspaceFromStore`. */
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;

  actions: ActionsRegistry;
}
