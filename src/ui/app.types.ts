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
import type { ConfigDoc, ResolvedIdpConfig } from '../net/oauth-config.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { ConnectionSession, SessionChCtx } from '../application/connection-session.js';
import type { SpecValidatorFn } from '../core/spec-draft.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { DynamicSources } from '../core/spec-completion.js';
import type { WorkbenchSession } from './workbench/workbench-session.js';

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
  /** Names of `{name:Type}` variables whose value has hardened to invalid
   * (#170 review — see app.ts's construction-site comment). Read directly by
   * tests; otherwise app.ts-internal bookkeeping. */
  hardenedVars: Set<string>;
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

  // Identity / auth — Phase-2 delegates onto `conn` (see its doc comment
  // above). `authMode`/`chAuth`/`basicUserClaim`/`idpId`/`selectIdp`/
  // `chUsername` moved onto `app.conn` itself (`conn.authMode()`/
  // `conn.chAuth()`/`conn.basicUserClaim()`/`conn.idpId()`/`conn.selectIdp()`)
  // — no other module read them off `App` directly (verified #276 Phase 2),
  // so they aren't re-delegated here.
  host(): string;
  activeTab(): Tab;
  isSignedIn(): boolean;
  email(): string;
  hostHint: string;
  basePath: string;
  setTokens(id: string, refresh?: string): void;
  /** The real resolved shape (net/oauth-config.ts's `ResolvedIdpConfig`) — the
   * previous opaque `Json` undersold it; main.js's OAuth-callback path reads
   * `cfg.bearer` straight off this value. */
  loadConfig(): Promise<ResolvedIdpConfig>;
  /** The real resolved shape (net/oauth-config.ts's `ConfigDoc`) — the
   * previous `{ idps: Array<{ id: string }> }` undersold it (no
   * `basicLogin`/`hosts`, and each `idps[]` entry is a full `IdpDescriptor`,
   * not just `{id}`); login.ts read the real shape all along behind its own
   * `LoginIdpsResult` widening, now redundant (dropped there). */
  loadIdps(): Promise<ConfigDoc>;
  /** Same real shape as `loadConfig` (`null` when config couldn't be loaded —
   * fail-soft, see app.ts's own `ensureConfig`). */
  ensureConfig(): Promise<ResolvedIdpConfig | null>;
  ensureFreshToken(): Promise<boolean>;
  chCtx: ChCtx;
  showLogin(msg?: string): void;
  signOut(): void;
  receiveAuthHandoff(handoffEnv: { opener?: Window | null }): Promise<boolean>;
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
  saveJSON(key: string, value: unknown): void;
  saveStr(key: string, value: string): void;
  savePref(name: string, value: unknown): void;
  saveVarValues(): void;
  saveFilterActive(): void;
  saveVarRecent(): void;
  saveVarRecentDisabled(): void;
  recordBoundParams(boundParams: Array<{ name: string; rawValue: unknown }>): void;
  clearVarRecent(name: string): void;
  clearAllVarRecent(): void;
  recordHistory(tab: Tab, sqlText?: string): void;
  downloadFile(filename: string, mime: string, content: BlobPart): void;
  /** Whether the header library-name field is in its inline-edit state. Not a
   * signal — file-menu.js renders it directly. */
  editingLibrary: boolean;

  // Data / schema loaders.
  loadVersion(): Promise<void>;
  loadSchema(): Promise<void>;
  loadReference(): Promise<void>;
  refData: { functions: unknown; keywordDocs: unknown } & Json;
  completions: Json;
  rebuildCompletions(): void;
  /** A pending fetch while in flight; the resolved doc string once settled (a
   * failed fetch, `null`, is dropped rather than cached — see entityDoc). */
  docCache: Map<string, string | Promise<string | null>>;
  /** Resolves to `null` on a failed fetch (not cached; retried next call). */
  entityDoc(name: string): Promise<string | null>;
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
  /** The shared request/stream/normalize + multiquery-script transport
   *  service (#276 Phase 1) — `src/application/query-execution-service.ts`,
   *  constructible without App/AppState/DOM. `src/ui/**` may depend on
   *  `src/application/**`, never the reverse. */
  exec: QueryExecutionService;
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
  evaluateSpecDraft(tab: Tab, text: string, opts?: { dirty?: boolean }): Json;
  revalidateSpecDrafts(opts?: { refreshUi?: boolean }): void;
  revealFirstSpecError(tab?: Tab): void;
  /** `path` is a JSON-path segment list (array index / object key per
   * segment), not a single string — every real call site (including tests)
   * passes e.g. `['items', 0, 'kind']`, matching `core/spec-draft.js`'s own
   * `SpecValidatorEntry.path`. */
  registerSpecValidator(path: (string | number)[], validate: SpecValidatorFn): () => void;
  /** `tab` is a defensive no-op-on-falsy read (`if (!tab) return;`, app.ts) —
   *  a test exercising a no-linked-tab call site passes `null` directly. */
  activateInvalidSpecDraft(tab: Tab | null): void;
  openSavePopover(): void;
  openUserMenu(): void;

  // Rendering / lifecycle.
  renderApp(): void;
  renderDashboard(): void;
  openDashboard(): void;

  actions: ActionsRegistry;
}
