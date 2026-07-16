// Phase-0 typed contract for the `app` controller (src/ui/app.js). Describes
// the surface OTHER modules read/call — not createApp's full internal
// ~290-property implementation — verified against real usage across
// src/ui/*.js, src/editor/*.js and src/main.js (ADR-0002 phase 0 / #262). No
// behavior change: app.js stays untouched `.js`.
//
// `State`/`Tab` below are a deliberately MINIMAL, hand-written shape covering
// only what `app.state`/tab consumers touch today — not a full type for
// src/state.js, which is its own later conversion (ADR-0002 §4, "leaf-up").
// Persisted-data shapes (Spec/SavedQuery) are intentionally loose placeholders;
// precise schema-generated types are a separate follow-up (ADR-0002 §3).

import type { Signal } from '@preact/signals-core';
import type { EditorView } from '@codemirror/view';
import type { EditorPort } from '../editor/editor-port.types.js';
import type { SpecEditorPort, SpecDiagnostic } from '../editor/spec-editor.types.js';
import type { CodeViewerFactory } from '../editor/code-viewer.types.js';

type Json = Record<string, unknown>;

export interface Tab {
  id: string;
  name: string;
  sqlDraft: string;
  specVersion: number;
  specText: string;
  specParsed: Json;
  specDiagnostics: SpecDiagnostic[];
  editorMode: 'sql' | 'spec';
  dirtySql: boolean;
  dirtySpec: boolean;
  result: Json | null;
  filterPreview: Json | null;
  lastSuccessfulResultColumns: string[];
  savedId: string | null;
  /** Set post-construction (app.js) once a query has run on this tab. */
  chSession?: unknown;
}

export interface SavedQuery extends Json {
  id: string;
  sql: string;
  specVersion: number;
  spec: Json;
}

/** A schema entity reference, e.g. the click target of a schema-graph node. */
export interface SchemaFocus {
  db: string;
  name?: string;
}

export interface State {
  nextTabId: number;
  theme: string;
  density: string;
  resultRowLimit: number;
  dashLayout: string;
  dashCols: number;
  sidebarPx: number;
  editorPct: number;
  sideSplitPct: number;
  cellDrawerPx: number;
  tabs: Signal<Tab[]>;
  activeTabId: Signal<string>;
  schema: Signal<unknown[] | null>;
  schemaError: Signal<string | null>;
  schemaFilter: Signal<string>;
  expanded: Signal<Set<string>>;
  bannerDismissedFor: Signal<string | null>;
  serverVersion: string | null;
  running: Signal<boolean>;
  abortController: AbortController | null;
  schemaGraphAbortController: AbortController | null;
  resultView: Signal<'table' | 'json' | 'panel' | 'filter'>;
  exporting: Signal<boolean>;
  detachedView: Signal<number>;
  hasSelection: Signal<boolean>;
  forceExplain: boolean;
  resultSort: { col: string | null; dir: 'asc' | 'desc' };
  varValues: Record<string, string>;
  filterActive: Record<string, boolean>;
  filterCurated: Record<string, unknown>;
  varRecent: Record<string, unknown>;
  varRecentDisabled: boolean;
  sidePanel: Signal<'saved' | 'history'>;
  savedQueries: SavedQuery[];
  savedQueryLoadDiagnostics: unknown[];
  editingSavedId: Signal<string | null>;
  history: Array<{ id: string; sql: string; ts: number; rows: number | null; ms: number }>;
  libraryName: Signal<string>;
  libraryDirty: Signal<boolean>;
  libraryFilter: string;
  shortcutsOpen: Signal<boolean>;
  isMobile: Signal<boolean>;
  mobileView: Signal<string>;
  mobileTab: Signal<string>;
}

/** `app.dom` is reset wholesale (`{}`) at the top of every renderApp() call —
 * a stable dictionary of known-consumed keys, not a closed interface. */
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
}

export interface ChCtx {
  fetch: typeof fetch;
  origin: string;
  authConfirmed: boolean;
  getToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
  authHeader(token: string): string;
  onSignedOut(detail?: string): void;
}

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
  exportEntry(): void;
  exportDirect(sqlInput: string, waveMs: number): Promise<void>;
  cancelExport(): void;
  cancelExportScript(): void;
  /** null: nothing to save (empty draft); undefined: the create-popover opened instead of returning a result. */
  save(): Json | null | undefined;
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
  openNodeDetail(node: Required<SchemaFocus>, targetDoc?: Document): Promise<void>;
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
  token: string | null;
  refreshToken: string | null;

  // Editor ports (injected seams — #143/#212).
  sqlEditor: EditorPort;
  specEditor: SpecEditorPort;
  CodeViewer: CodeViewerFactory;
  /** {validate, register} — see core/spec-draft.js. */
  specValidators: unknown;
  /** CM6 completion sources for the Spec JSON editor. */
  specCompletionSources: unknown[];

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

  // Identity / auth.
  host(): string;
  activeTab(): Tab;
  isSignedIn(): boolean;
  email(): string;
  chUsername(jwtPayload: Json): string;
  authMode: 'oauth' | 'basic';
  chAuth: 'bearer' | 'basic';
  basicUserClaim: string;
  idpId: string | null;
  hostHint: string;
  basePath: string;
  setTokens(id: string, refresh?: string): void;
  loadConfig(): Promise<Json>;
  loadIdps(): Promise<{ idps: Array<{ id: string }> }>;
  selectIdp(id: string): void;
  ensureConfig(): Promise<Json | null>;
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
  runReadInto(
    result: Json,
    opts: { sql: string; format?: string; rowLimit?: number; params?: unknown; signal?: AbortSignal; queryId?: string; onChunk?: (chunk: unknown) => void },
  ): Promise<Json>;
  setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void;
  renderVarStrip(): void;
  setExportBtn(exporting: boolean): void;
  specBlocked(tab: Tab): boolean;
  updateSaveBtn(): void;
  /** Only present after the first renderApp() call. */
  updateEditorModeUi?: () => void;
  syncSelection?: () => void;
  evaluateSpecDraft(tab: Tab, text: string, opts?: { dirty?: boolean }): Json;
  revalidateSpecDrafts(opts?: { refreshUi?: boolean }): void;
  revealFirstSpecError(tab?: Tab): void;
  registerSpecValidator(path: string, validate: (...args: unknown[]) => unknown): () => void;
  activateInvalidSpecDraft(tab: Tab): void;
  openSavePopover(): void;
  openUserMenu(): void;

  // Rendering / lifecycle.
  renderApp(): void;
  renderDashboard(): void;
  openDashboard(): void;

  actions: ActionsRegistry;
}
