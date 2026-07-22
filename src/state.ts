// Application state: a plain object plus pure operations over it. Persistence
// is injected as a `save(key, value)` function (defaulting to storage.js), so
// every operation is unit-testable with a spy and no real localStorage.

import { clamp as clampUntyped } from './core/format.js';
import {
  SPEC_VERSION, cloneJson, patchQuerySpec, queryDescription, queryFavorite, queryName,
  queryPanel, queryView, withQuerySpec,
} from './core/saved-query.js';
import type { QueryRoot } from './core/saved-query.js';
import { decodeStoredSavedQueries as decodeStoredSavedQueriesUntyped } from './core/library-codec.js';
import { normalizeDashLayout, normalizeDashCols } from './core/dashboard.js';
import {
  loadJSON as loadJSONUntyped, saveJSON as saveJSONUntyped,
  loadStr as loadStrUntyped,
} from './core/storage.js';
import { emptyRecentMap as emptyRecentMapUntyped } from './core/recent-values.js';
import { toggleTileMembership } from './dashboard/application/tile-membership.js';
import type { ResultSort } from './core/sort.js';
import {
  defaultSpecValidationService as defaultSpecValidationServiceUntyped,
  evaluateSpecText as evaluateSpecTextUntyped,
  hasBlockingSpecErrors as hasBlockingSpecErrorsUntyped,
  normalizeSpec as normalizeSpecUntyped,
  serializeSpec as serializeSpecUntyped,
} from './core/spec-draft.js';
import { signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import type { QuerySpecV1, SavedQueryV2, DashboardDocumentV1, StoredWorkspaceV1 } from './generated/json-schema.types.js';
import type { SpecDiagnostic } from './editor/spec-editor.types.js';
import type { WorkspaceMutationInput, WorkspaceMutationOutcome } from './ui/app.types.js';
import type { WorkspaceDiagnostic } from './dashboard/model/workspace-diagnostics.js';
import { queryToken, reconcileLinkedTabs } from './workspace/workspace-sync.js';
import type { LinkedTabSnapshot } from './workspace/workspace-sync.js';

// ── Persisted-data types (schema-generated) ─────────────────────────────────

/** A tab's in-memory parsed Spec draft — the same document shape the canonical
 * query-spec v1 schema describes (extension fields ride along in the index
 * signature). */
export type QuerySpecDraft = QuerySpecV1;

/** A complete `spec.panel` payload (cfg/key/fieldConfig + future siblings). */
export type PanelSpec = NonNullable<QuerySpecV1['panel']>;

// ── Injected persistence seam types ─────────────────────────────────────────

/** The read half of the persistence seam `createState` consumes. */
export interface StateReader {
  /** Read + JSON.parse `key`; the stored shape is unknowable here — decoding
   * (or an explicit trust assertion) happens at each field's ingress. */
  loadJSON(key: string, fallback: unknown): unknown;
  loadStr(key: string, fallback: string): string;
}

export type SaveJSON = (key: string, value: unknown) => void;
export type SaveStr = (key: string, value: string) => void;

// ── Read-before-write mutation seam (#287 W4 / #343) ───────────────────────
// The saved-query CRUD ops below persist through the StoredWorkspaceV1
// aggregate (IndexedDB), never the flat `asb:saved` localStorage key. #343:
// they no longer take a raw `commit(candidate)` callback that would let them
// build a whole candidate from stale in-memory `AppState` and clobber a change
// another browser tab committed. Instead they take the shared read-before-write
// primitive `app.mutateWorkspace` (src/ui/app.ts): each op builds its candidate
// INSIDE the transform, folding its change into the `latest` COMMITTED
// aggregate (read at dequeue time) — the envelope id/name/dashboard/queries all
// come from `latest`, never from `AppState` as committed baseline. On success
// the primitive itself projects committed truth (`applyCommittedWorkspace`,
// exactly once) + broadcasts one invalidation; these ops then only apply their
// own TAB-side post-commit state from the returned `result.workspace`. `app.ts`
// injects `app.mutateWorkspace`; tests inject an in-memory fake (see
// `fakeMutateWorkspace`) so this module never imports a concrete IndexedDB
// adapter or the App type at runtime.

/** The injected read-before-write mutation primitive — structurally
 *  `App['mutateWorkspace']` (src/ui/app.ts), depended on type-only so `state.ts`
 *  never imports the App runtime graph. `transform` receives the latest
 *  committed workspace (or `null` when nothing is persisted yet) and returns the
 *  complete candidate to commit — or `null` to abort committing nothing. */
export type MutateWorkspace = <T = unknown>(
  transform: (latest: StoredWorkspaceV1 | null) =>
    WorkspaceMutationInput<T> | null | Promise<WorkspaceMutationInput<T> | null>,
) => Promise<WorkspaceMutationOutcome<T>>;

/** A saved-query CRUD op's async result once its candidate is strictly
 *  committed (validate-then-atomically-replace — see WorkspaceRepository.commit).
 *  `entry: null` on failure covers BOTH a pre-commit compute/plan guard (bad
 *  name, blank SQL, a blocking Spec diagnostic, or a target the operation no
 *  longer applies to in `latest` — the same early-return semantics the pre-#287
 *  sync code had, `diagnostics` absent) and a real repository rejection
 *  (`diagnostics` present, straight from the aggregate's whole-candidate
 *  validation). Either way NOTHING is mutated — no `state`/`tabs` write happens
 *  until the mutation resolves `ok: true`. */
export type SavedEntryResult =
  | { ok: true; entry: SavedQueryV2 }
  /** `deletedExternally: true` marks the one abort where the transform found
   *  the target query missing from `latest.queries` (#343 — deleted in another
   *  tab). Callers must surface it and refresh the tab association; every other
   *  failure keeps the pre-#343 semantics. */
  | { ok: false; entry: null; diagnostics?: WorkspaceDiagnostic[]; deletedExternally?: true };

/** Bridge a workspace-commit rejection's diagnostics onto the narrower
 *  `SpecDiagnostic` shape `PatchSavedResult`/the Spec editor already expect
 *  (`WorkspaceDiagnostic.severity` adds `'information'`, not a member of
 *  `SpecDiagnostic.severity`'s narrower union — this maps it to `'warning'`,
 *  the closest non-error severity, so nothing here needs a third severity
 *  tier just for this one bridge). */
const asSpecDiagnostics = (diagnostics: readonly WorkspaceDiagnostic[]): SpecDiagnostic[] =>
  diagnostics.map((d) => ({
    message: d.message, code: d.code, path: d.path,
    severity: d.severity === 'warning' || d.severity === 'error' ? d.severity : 'warning',
  }));

/** The base aggregate a saved-query mutation folds its change into: the `latest`
 *  COMMITTED workspace, or — ONLY when nothing is persisted yet (first-ever
 *  save, `latest === null`) — a fallback synthesized from local `state` (its
 *  synchronously-minted `workspaceId`, `libraryName`, the current `savedQueries`
 *  and `dashboard`). Envelope + queries + dashboard always come from `latest`
 *  when it exists, so once the aggregate is persisted a mutation NEVER rebuilds
 *  a candidate from a stale in-memory projection (#343). Pure. */
function baselineWorkspace(
  state: Pick<AppState, 'libraryName' | 'workspaceId' | 'dashboard' | 'savedQueries'>,
  latest: StoredWorkspaceV1 | null,
): StoredWorkspaceV1 {
  return latest ?? {
    storageVersion: 1, id: state.workspaceId, name: state.libraryName.value,
    queries: state.savedQueries, dashboard: state.dashboard,
  };
}

/** A complete candidate over a resolved `base`: the base envelope (id/name)
 *  carried through unchanged, the op's own next `queries`, and — unless the op
 *  explicitly changes it — the base Dashboard byte-for-byte. Pure. */
const candidateFrom = (
  base: StoredWorkspaceV1, queries: SavedQueryV2[],
  dashboard: DashboardDocumentV1 | null = base.dashboard,
): StoredWorkspaceV1 => ({ storageVersion: 1, id: base.id, name: base.name, queries, dashboard });

/** The committed entry, re-read from the just-committed canonical `queries`
 *  array (not the locally-computed candidate entry) — the aggregate's commit
 *  is the single source of truth for what actually persisted. Falls back to
 *  `fallback` defensively; every real call site's `id` is always present in
 *  the array it just committed. */
const committedEntry = (queries: SavedQueryV2[], id: string, fallback: SavedQueryV2): SavedQueryV2 =>
  queries.find((q) => q.id === id) ?? fallback;

// ── Spec validation seam types ──────────────────────────────────────────────

/** Context handed to Spec validators (core/spec-schema.js): the linked SQL
 * document plus whichever tab/query the Spec belongs to. */
export interface SpecValidationContext {
  sql?: string;
  tab?: QueryTab | null;
  query?: SavedQueryV2;
  [k: string]: unknown;
}

/** The app-owned Spec validation service (core/spec-draft.js): canonical
 * schema validation plus registered feature rules. */
export interface SpecValidationService {
  validate(spec: unknown, context?: SpecValidationContext): SpecDiagnostic[];
}

/** A committed-Spec patch: top-level field updates (`undefined` deletes a
 * field) or a function over the cloned current draft (which is null while a
 * tab's textual Spec isn't parseable — see `QueryTab.specParsed`). */
export type SpecPatch =
  | Partial<QuerySpecV1>
  | ((spec: QuerySpecDraft | null) => QuerySpecDraft);

// ── Typed wrappers over still-untyped .js dependencies ──────────────────────
// Each const pins exactly the signature state.ts relies on; the runtime module
// stays `.js` until its own leaf-up conversion (ADR-0002).

const clamp: (v: number, lo: number, hi: number) => number = clampUntyped;

const loadJSON: StateReader['loadJSON'] = loadJSONUntyped;
const saveJSON: SaveJSON = saveJSONUntyped;
const loadStr: StateReader['loadStr'] = loadStrUntyped;

// decodeStoredSavedQueries fails closed: `ok: false` carries diagnostics and
// no usable value (createState substitutes []); `ok: true` value entries are
// schema-validated canonical v2 documents. `as`: the .js return type infers as
// non-discriminated `ok: boolean` branches; the runtime pairs `ok: true`
// exclusively with a validated canonical `value`.
const decodeStoredSavedQueries = decodeStoredSavedQueriesUntyped as (value: unknown) =>
  | { ok: true; value: SavedQueryV2[]; diagnostics: SpecDiagnostic[] }
  | { ok: false; diagnostics: SpecDiagnostic[] };

const emptyRecentMap: () => RecentMap = emptyRecentMapUntyped;

const defaultSpecValidationService: SpecValidationService = defaultSpecValidationServiceUntyped;
// `as`: the .js signature infers `validators` as the full concrete registry
// object; the runtime only ever calls `validators.validate` (the
// SpecValidationService seam, which injected test doubles also implement).
const evaluateSpecText = evaluateSpecTextUntyped as (
  text: string, validators: SpecValidationService, context: SpecValidationContext,
) => { parsed: QuerySpecDraft | null; diagnostics: SpecDiagnostic[] };
const hasBlockingSpecErrors: (diagnostics?: SpecDiagnostic[]) => boolean = hasBlockingSpecErrorsUntyped;
const normalizeSpec: (spec: QuerySpecDraft) => QuerySpecDraft = normalizeSpecUntyped;
const serializeSpec: (spec: QuerySpecDraft) => string = serializeSpecUntyped;

// withQuerySpec/patchQuerySpec return the looser QueryRoot (`id` may be
// null/undefined for a not-yet-saved draft); every call below passes a query
// root that already carries its minted string id, so the persisted
// SavedQueryV2 shape holds by construction.
const asSavedEntry = (root: QueryRoot): SavedQueryV2 => root as SavedQueryV2;

// ── State value types ───────────────────────────────────────────────────────

/** One open query tab: the SQL document plus its complete authored Spec. */
export interface QueryTab {
  id: string;
  name: string;
  sqlDraft: string;
  specVersion: number;
  specText: string;
  /** null exactly when `specDiagnostics` has an invalid-json diagnostic (the
   * textual Spec isn't parseable JSON); a parsed draft object otherwise. */
  specParsed: QuerySpecDraft | null;
  specDiagnostics: SpecDiagnostic[];
  editorMode: 'sql' | 'spec';
  dirtySql: boolean;
  dirtySpec: boolean;
  /** Opaque run-result holder — owned and shaped by ui/results.js. */
  result: Record<string, unknown> | null;
  /** Opaque Filter-role preview result — owned by ui/results.js (#244). */
  filterPreview: Record<string, unknown> | null;
  /** Snapshot of the last successful run's column descriptors (`{name, type}`
   *  spreads — see app.js's post-run assignment); read by the Spec completion
   *  adapter's dynamic sources. */
  lastSuccessfulResultColumns: { name: string; type?: string }[];
  savedId: string | null;
  /** #343: this tab's classification against the latest committed workspace once
   *  it went stale — `'conflict'` (a dirty tab whose linked saved query changed
   *  in another tab; ordinary Save must route to the resolution chooser, never
   *  silently overwrite the external version) or `'deleted'` (a dirty tab whose
   *  linked saved query was deleted in another tab; kept as an unsaved draft, so
   *  Save follows the normal Save-as-new flow and never implicitly recreates it).
   *  `null`/absent = normal (clean, or unsaved, or in sync). */
  externalState?: 'conflict' | 'deleted' | null;
  /** #343: the canonical `queryToken` of the committed saved query this tab was
   *  last in sync with — recorded every time the tab syncs with a committed
   *  query (open-from-saved / create / save / adopt). The linked-tab classifier
   *  (`reconcileLinkedTabs`) compares it against the latest committed query's
   *  token to decide whether the saved query changed in another tab. Absent for
   *  unsaved tabs (`savedId === null`). */
  lastCommittedQueryToken?: string;
  /** ClickHouse HTTP session id (lazily minted `sess-…` uid) — set
   *  post-construction (app.js) once a query has run on this tab. */
  chSession?: string;
}

/** One executed-query history entry (most-recent first, capped at 50). */
export interface HistoryEntry {
  id: string;
  sql: string;
  ts: number;
  /** Row count of the recorded run; null for raw-FORMAT results and scripts. */
  rows: number | null;
  ms: number;
}

// The global results-table sort — moved to core/sort.ts (#276 Phase 1) so
// the pure sort module owns its own type; re-exported here so every existing
// importer of ResultSort-from-state keeps compiling unchanged.
export type { ResultSort } from './core/sort.js';

/** One recorded recent value for a variable (core/recent-values.js). */
export interface RecentValueEntry {
  value: string;
  /** Strictly-increasing global counter — one true recency order across names. */
  seq: number;
}

/** The versioned per-variable MRU map persisted at `asb:varRecent` (#171). */
export interface RecentMap {
  version: number;
  nextSeq: number;
  byName: Record<string, RecentValueEntry[]>;
}

/** The complete application state `createState` builds. */
export interface AppState {
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
  /** The docs pane's own persisted resize width (#313) — a sibling of
   *  `cellDrawerPx`, read/written only by the 'docPane' splitter axis
   *  (splitters.ts) and `attachDrawerResize`'s `stateKey: 'docPanePx'` option
   *  (drawer.ts); never shared with the cell-detail/rows-viewer drawer. */
  docPanePx: number;
  tabs: Signal<QueryTab[]>;
  activeTabId: Signal<string>;
  schema: Signal<unknown[] | null>;
  schemaError: Signal<string | null>;
  schemaFilter: Signal<string>;
  expanded: Signal<Set<string>>;
  bannerDismissedFor: Signal<string | null>;
  serverVersion: string | null;
  running: Signal<boolean>;
  resultView: Signal<'table' | 'json' | 'panel' | 'filter'>;
  exporting: Signal<boolean>;
  detachedView: Signal<number>;
  hasSelection: Signal<boolean>;
  forceExplain: boolean;
  resultSort: ResultSort;
  varValues: Record<string, string>;
  filterActive: Record<string, boolean>;
  filterCurated: Record<string, unknown>;
  varRecent: RecentMap;
  varRecentDisabled: boolean;
  /** 'saved' | 'history' at every write site; typed string because the
   * initial value is an undecoded localStorage read (`asb:sidePanel`). */
  sidePanel: Signal<string>;
  savedQueries: SavedQueryV2[];
  savedQueryLoadDiagnostics: SpecDiagnostic[];
  editingSavedId: Signal<string | null>;
  history: HistoryEntry[];
  libraryName: Signal<string>;
  libraryDirty: Signal<boolean>;
  /** #287 W4: the current committed StoredWorkspaceV1's Dashboard document —
   *  the Workbench NEVER mutates this (that's the /dashboard route's job); it
   *  is only carried through, unchanged, in every saved-query CRUD commit
   *  candidate. `null` until the boot projection (app.ts's
   *  `loadWorkspaceOnBoot`) resolves the aggregate, or when the workspace
   *  genuinely has no Dashboard yet. */
  dashboard: DashboardDocumentV1 | null;
  /** #287 W4: the current committed StoredWorkspaceV1's id, carried forward
   *  unchanged by every saved-query CRUD commit candidate. `createState`
   *  mints a session-local placeholder synchronously (never blank — the
   *  stored-workspace schema requires a non-empty id), so a CRUD op run
   *  before the boot projection resolves still succeeds, committing the
   *  first-ever aggregate under that id; `loadWorkspaceOnBoot` overwrites it
   *  with the real committed id (existing or freshly migrated) once
   *  resolved. See `createState`'s own comment on `mintWorkspaceId`. */
  workspaceId: string;
  libraryFilter: string;
  shortcutsOpen: Signal<boolean>;
  isMobile: Signal<boolean>;
  mobileView: Signal<'tables' | 'editor' | 'results'>;
  mobileTab: Signal<'schema' | 'library'>;
}

/** Result of `patchSpecDraft`: the patched draft, or which tab blocked it. */
export type PatchDraftResult =
  | { ok: true; invalidTab: null; spec: QuerySpecDraft }
  | { ok: false; invalidTab: QueryTab | null; diagnostics?: SpecDiagnostic[] };

/** Result of `patchSavedSpec` (and the pencil/star ops built on it). */
export type PatchSavedResult =
  | { ok: true; invalidTab: null; entry: SavedQueryV2 }
  | { ok: false; invalidTab: QueryTab | null; entry: null; diagnostics?: SpecDiagnostic[] };

/**
 * A tab's complete `spec.panel` payload, cloned for safe use/persistence. The
 * cfg/key fields drive today's renderer; future siblings ride along unchanged.
 */
export function tabPanel(tab: Pick<QueryTab, 'specParsed'> | null | undefined): PanelSpec | null {
  const panel = queryPanel(tab && { spec: tab.specParsed });
  return panel ? cloneJson(panel) : null;
}

/** Result views a saved query can remember (a raw FORMAT-clause view is
 * transient). 'panel' replaced 'chart' in #166 — upgradeSavedEntry maps the
 * legacy value at every ingress. */
export const SAVED_VIEWS = new Set(['table', 'json', 'panel']);

export const KEYS = {
  theme: 'asb:theme',
  sidebarPx: 'asb:sidebarPx',
  editorPct: 'asb:editorPct',
  sideSplitPct: 'asb:sideSplitPct',
  cellDrawerPx: 'asb:cellDrawerPx',
  docPanePx: 'asb:docPanePx',
  sidePanel: 'asb:sidePanel',
  saved: 'asb:saved',
  history: 'asb:history',
  libraryName: 'asb:libraryName',
  resultRowLimit: 'asb:resultRowLimit',
  varValues: 'asb:varValues',
  filterActive: 'asb:filterActive',
  filterCurated: 'asb:filterCurated',
  dashLayout: 'asb:dashLayout',
  dashCols: 'asb:dashCols',
  varRecent: 'asb:varRecent',
  varRecentDisabled: 'asb:varRecentDisabled',
  /** Isolated per-dashboard Dashboard-filter persistence (#303 Option B) — a
   *  single blob keyed `dashboardId -> filterId -> {value,active}`, read/written
   *  through `dashboard/model/dashboard-filter-store.js`. Deliberately separate
   *  from the Workbench's `varValues`/`filterActive` keys above. */
  dashFilters: 'asb:dashFilters',
};

/** Row-limit options for the result cap selector (shared between state + UI).
 * `readonly number[]` (not a literal tuple) so `includes(n)` accepts any
 * number a caller parsed. */
export const RESULT_ROW_LIMIT_OPTIONS: readonly number[] = [100, 500, 1000, 5000, 10000];

/** Default row cap when none is persisted (or a stored value is unrecognized). */
export const DEFAULT_RESULT_ROW_LIMIT = 500;

/** Snap a row-limit to a known option, falling back to the default. Pure. */
export function normalizeRowLimit(n: number): number {
  return RESULT_ROW_LIMIT_OPTIONS.includes(n) ? n : DEFAULT_RESULT_ROW_LIMIT;
}

/** Default name for a fresh / unnamed saved-query library. */
export const DEFAULT_LIBRARY_NAME = 'SQL Library';

/**
 * Viewport width (px) at/below which the shell drops into best-effort mobile
 * mode (#126) — a single value, not a range, so the CSS/JS branching stays
 * unambiguous. The matching CSS lives in a `@media (max-width: 768px)` block in
 * styles.css; keep the two literals in sync. app.js wires an injected
 * `matchMedia('(max-width: <this>px)')` listener that drives `isMobile`.
 */
export const MOBILE_BREAKPOINT_PX = 768;

/** A blank query tab. Its complete Spec is the sole tab-side authoring source;
 * SQL remains the separate editor document. */
export function newTabObj(id: string): QueryTab {
  const specParsed = { name: 'Untitled', favorite: false };
  return {
    id, name: 'Untitled', sqlDraft: '', specVersion: SPEC_VERSION,
    specText: serializeSpec(specParsed), specParsed, specDiagnostics: [],
    editorMode: 'sql', dirtySql: false, dirtySpec: false,
    result: null, filterPreview: null, lastSuccessfulResultColumns: [], savedId: null,
  };
}

/** Overall tab dirty state is always the OR of the independent documents. */
export const tabDirty = (tab: Partial<Pick<QueryTab, 'dirtySql' | 'dirtySpec'>> | null | undefined): boolean =>
  !!(tab && (tab.dirtySql || tab.dirtySpec));

/** Replace a tab's complete parsed Spec draft and serialized text together. */
export function setTabSpecDraft(
  tab: QueryTab,
  spec: QuerySpecDraft,
  { dirty = false, validationService = defaultSpecValidationService }:
    { dirty?: boolean; validationService?: SpecValidationService } = {},
): QueryTab {
  const parsed = cloneJson(spec);
  tab.specParsed = parsed;
  tab.specText = serializeSpec(parsed);
  tab.specDiagnostics = evaluateSpecText(tab.specText, validationService, { sql: tab.sqlDraft, tab }).diagnostics;
  tab.dirtySpec = dirty;
  return tab;
}

/**
 * Build the initial state, reading persisted prefs through `read` (an object
 * with loadJSON/loadStr, defaulting to storage.js over localStorage).
 */
export function createState(read: StateReader = { loadJSON, loadStr }): AppState {
  const num = (key: string, dflt: number, lo: number, hi: number) =>
    clamp(parseFloat(read.loadStr(key, String(dflt))), lo, hi);
  const storedQueries = decodeStoredSavedQueries(read.loadJSON(KEYS.saved, []));
  return {
    nextTabId: 2,
    theme: read.loadStr(KEYS.theme, 'light'),
    density: 'comfortable',
    // Global cap on how many rows a normal SELECT fetches (server-side
    // max_result_rows + a client-side guard; see runQuery / applyStreamLine).
    // One persisted preference, default 500; a non-option stored value snaps
    // back to the default so the selector always reflects a real choice.
    resultRowLimit: normalizeRowLimit(parseInt(read.loadStr(KEYS.resultRowLimit, '500'), 10)),
    // Dashboard layout prefs (#149 D2), persisted per browser. Plain (non-signal)
    // like theme/density — the standalone dashboard page reads them at build time
    // and mutates + re-saves on the Arrange/Report + column-count controls.
    dashLayout: normalizeDashLayout(read.loadStr(KEYS.dashLayout, 'arrange')),
    dashCols: normalizeDashCols(parseInt(read.loadStr(KEYS.dashCols, '3'), 10)),
    sidebarPx: clamp(parseInt(read.loadStr(KEYS.sidebarPx, '248'), 10), 180, 420),
    editorPct: num(KEYS.editorPct, 45, 15, 85),
    sideSplitPct: num(KEYS.sideSplitPct, 58, 25, 85),
    // Cell-detail / rows-viewer drawer width (issue #101). The 92vw upper
    // bound depends on the live viewport, not this load-time default, so only
    // the floor is enforced here — clampDrawerWidth (splitters.js) applies the
    // full [320, 92vw] clamp whenever the drawer is opened or resized.
    cellDrawerPx: clamp(parseInt(read.loadStr(KEYS.cellDrawerPx, '560'), 10), 320, Infinity),
    // The docs pane's own persisted width (#313) — same floor-only load-time
    // clamp as cellDrawerPx above (clampDrawerWidth applies the full
    // [320, 92vw] bound whenever the pane is opened/resized against the live
    // viewport).
    docPanePx: clamp(parseInt(read.loadStr(KEYS.docPanePx, '420'), 10), 320, Infinity),
    // Reactive (signals): mutating these drives repaints via effects in
    // createApp — no manual refresh() list to keep in sync. Read/write through
    // `.value`. tabs/activeTabId drive renderTabs + the editor + the save button;
    // the results pane + Run button react to resultView/running (below).
    tabs: signal([newTabObj('t1')]),
    activeTabId: signal('t1'),
    // Schema panel (signals): the tree repaints via an effect in createApp that
    // reads these (no manual renderSchema list). `schema` is the db→table array;
    // each `tb.columns` is a lazily-loaded completion cache replaced by reference
    // (see loadColumns) — never mutated in place. `expanded` is a Set of expand
    // keys ('db:'+name / 'tb:'+db.table) replaced copy-on-write. Read/write via
    // `.value`. (The 'db:'/'tb:' prefixes mirror the dbl-click tracker's keys in
    // schema.js — a separate store, not shared state.)
    schema: signal(null),
    schemaError: signal(null),
    schemaFilter: signal(''),
    expanded: signal(new Set<string>()),
    // The last schemaError text the user dismissed from the auth banner
    // (updateBanner, in app.js) — re-shown only if a *different* error occurs.
    // Session-only, never persisted.
    bannerDismissedFor: signal(null),
    serverVersion: null,
    // Run state (signals): `running` flips the Run button + results pane via
    // effects; `resultView` is the active Table/JSON/Chart tab. Via `.value`.
    running: signal(false),
    resultView: signal<'table' | 'json' | 'panel' | 'filter'>('table'),
    // True while a streaming Export (issue #87) is in flight — separate from
    // `running` (the grid run) so an export and a grid run never clobber each
    // other's button/cancel state.
    exporting: signal(false),
    // Count of currently-open detached views (issue #100) — a schema/pipeline
    // graph or Data Pane grid, each opened either as a real browser tab or an
    // in-app overlay fallback. A count (not a bool) so several can be open at
    // once without one's close() clobbering the others' "is anything open"
    // signal. Via `.value`.
    detachedView: signal(0),
    // True while the editor has a non-empty (non-whitespace) text selection, so
    // ⌘+Enter / Run target just that text. Drives the Run button's
    // "Run" ↔ "Run selection" label (an effect in createApp). Via `.value`.
    hasSelection: signal(false),
    // `forceExplain` is set by the Explain button to put an ordinary query into
    // EXPLAIN-view mode; a normal Run clears it (session-only). The active view is
    // derived per-run from the typed statement / clicked tab, not stored here.
    forceExplain: false,
    resultSort: { col: null, dir: 'asc' },
    // Entered values for `{name:Type}` query parameters (#134), keyed by variable
    // name and shared across every tab/query, so a value typed once is reused
    // wherever the same variable appears. Persisted (asb:varValues) so it also
    // survives reloads. A plain object, mutated in place + re-saved by app.js.
    // The `as` trusts the localStorage shape verbatim — no decoder exists
    // today (unlike savedQueries).
    varValues: read.loadJSON(KEYS.varValues, {}) as Record<string, string>,
    // Explicit filter activation for optional SQL blocks (#165), keyed by
    // param name and shared/persisted exactly like varValues (its own key;
    // never carried in share links — varValues aren't either). true ⇒ the
    // param's optional blocks are included; false ⇒ omitted, whatever dormant
    // value varValues still holds. Text controls keep it in sync with the
    // value (blank ⇒ false, typed ⇒ true); a name with no entry derives its
    // activation from the stored value (effectiveFilterActive below), so
    // pre-#165 persisted values keep working on first load.
    // The `as` trusts the localStorage shape verbatim — no decoder exists today.
    filterActive: read.loadJSON(KEYS.filterActive, {}) as Record<string, boolean>,
    // Last-known curated Dashboard Filter fields (#234), keyed by param name —
    // the merged `{options, sourceType, …}` bundle each Filter favorite last
    // produced. Seeded synchronously at the top of renderDashboard so a curated
    // field paints as the searchable-combobox shape immediately (with
    // possibly-stale options) instead of flashing a plain text input for one
    // frame; the live Filter wave replaces it silently on completion.
    // The `as` trusts the localStorage shape verbatim — no decoder exists today.
    filterCurated: read.loadJSON(KEYS.filterCurated, {}) as Record<string, unknown>,
    // Per-variable MRU recent-value history (#171): recorded from a
    // successful statement's `boundParams` (#173's immutable snapshots) —
    // never from a keystroke — keyed by variable name and shared/persisted
    // exactly like varValues (its own key; never carried in share links).
    // See core/recent-values.js for the shape and its pure ops.
    // The `as` trusts the localStorage shape verbatim — no decoder exists today.
    varRecent: read.loadJSON(KEYS.varRecent, emptyRecentMap()) as RecentMap,
    // Disable-history preference (#171, "settings"): when true, new values
    // stop being recorded but existing history is retained until explicitly
    // cleared (Clear all recent values / per-field Clear recent).
    // The `as` trusts the localStorage shape verbatim — no decoder exists today.
    varRecentDisabled: read.loadJSON(KEYS.varRecentDisabled, false) as boolean,
    sidePanel: signal(read.loadStr(KEYS.sidePanel, 'saved')),
    // The localStorage startup ingress: v1 entries become canonical v2 in
    // memory without an eager write; future Spec versions fail closed here.
    savedQueries: storedQueries.ok ? storedQueries.value : [],
    // Retain startup diagnostics without deleting or rewriting the stored
    // bytes. The next ordinary successful Library write persists canonical
    // entries; corrupt/future storage fails closed to an empty in-memory view.
    savedQueryLoadDiagnostics: storedQueries.diagnostics || [],
    // Which saved row (if any) is showing its inline edit form (saved-history.js).
    // Session-only, never persisted.
    editingSavedId: signal(null),
    // The `as` trusts the localStorage shape verbatim — no decoder exists today.
    history: read.loadJSON(KEYS.history, []) as HistoryEntry[],
    // The saved-query collection treated as a named document ("the Library").
    // Signals: the header title (name + unsaved-changes dot) repaints via an
    // effect that reads these. `libraryName` is persisted; `libraryDirty`
    // (unsaved changes since the last file Save/Replace/New) is session-only and
    // resets on reload. Read/write via `.value`.
    libraryName: signal(read.loadStr(KEYS.libraryName, DEFAULT_LIBRARY_NAME)),
    libraryDirty: signal(false),
    // #287 W4: the aggregate projection. `dashboard` has no aggregate to read
    // yet at this synchronous constructor — it starts `null` and is populated
    // once app.ts's async boot step (`loadWorkspaceOnBoot`) resolves the real
    // StoredWorkspaceV1 (after the one-shot legacy migration). `workspaceId`
    // is minted here rather than left blank: the stored-workspace schema
    // requires a non-empty id, so a save attempted in the window before boot
    // projection completes (or by a fixture that never runs it at all — e.g.
    // a unit test driving `createApp` directly) still succeeds, committing
    // the FIRST-ever aggregate under this freshly-minted id; `loadCurrent`'s
    // migration marker is keyed on store record existence, so that commit is
    // simply treated as "already migrated" rather than raced/overwritten.
    // `loadWorkspaceOnBoot` overwrites this with the real committed id once
    // it resolves (a pre-existing aggregate, or the one migration just built).
    dashboard: null,
    workspaceId: mintWorkspaceId(),
    // Transient search text for the Library/History side panel (session-only,
    // cleared on a tab switch); never persisted.
    libraryFilter: '',
    // Whether the keyboard-shortcuts modal is open (shortcuts.js). Session-only;
    // a signal for consistency with the rest of the state (no reactive reader
    // today — shortcuts.js drives its own mount/unmount).
    shortcutsOpen: signal(false),
    // Best-effort mobile mode (#126). `isMobile` mirrors the viewport width
    // against MOBILE_BREAKPOINT_PX — set once and on `change` by app.js's
    // injected matchMedia listener. Read by the schema tree (to drop
    // touch-useless drag/hover affordances) and the results drop target.
    // `mobileView` is the bottom-tab-nav's active full-screen panel and
    // `mobileTab` the Tables view's Schema|Library segmented choice (a separate
    // axis from `sidePanel`, which still drives the saved-pane's own
    // Library/History sub-tabs). All session-only, never persisted; a no-op
    // above the breakpoint (the CSS only reads them there). Via `.value`.
    isMobile: signal(false),
    mobileView: signal('editor'),
    mobileTab: signal('schema'),
  };
}

/** The currently-active tab object (falls back to the first tab). */
export function activeTab(state: AppState): QueryTab {
  return state.tabs.value.find((t) => t.id === state.activeTabId.value) || state.tabs.value[0];
}

/**
 * The effective optional-block activation map (#165) the parameter pipeline
 * consumes: an explicit `filterActive` entry wins; a param with no entry
 * derives activation from its stored value (non-empty ⇒ active), so persisted
 * pre-#165 varValues keep working on first load — and a first load with
 * neither entry defaults to inactive without throwing. Pure.
 */
export function effectiveFilterActive(
  values: Record<string, unknown> = {},
  filterActive: Record<string, unknown> = {},
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, v] of Object.entries(values)) out[name] = v != null && v !== '';
  for (const [name, a] of Object.entries(filterActive)) out[name] = !!a;
  return out;
}

/** Allocate a new tab id ('t2', 't3', ...). */
export function allocTabId(state: AppState): string {
  return 't' + state.nextTabId++;
}

const rnd = () => Math.random().toString(36).slice(2, 6);
const makeId = (prefix: string, now: number) => prefix + now + rnd();

// #287 W4: `createState`'s synchronous placeholder workspace id (see its own
// doc comment) — a session-local id, distinct enough that two tabs opened at
// once don't collide before either resolves the real aggregate.
const mintWorkspaceId = (): string => 'ws-' + Date.now().toString(36) + rnd() + rnd();
// Narrowed to `Pick<AppState, 'tabs'>` (#276 Phase 4C) — the only field read
// — so `patchSavedSpec`'s own narrowed `state` param (below) can pass it
// through unchanged; every real caller already passes a full `AppState`,
// which satisfies this directly.
export const tabsForSaved = (state: Pick<AppState, 'tabs'>, id: string): QueryTab[] =>
  state.tabs.value.filter((t) => t.savedId === id);

/** First linked tab whose textual Spec is not currently parseable JSON.
 *  Narrowed to `Pick<AppState, 'tabs'>` for the same reason as
 *  `tabsForSaved` above (which this delegates to). */
export const invalidSpecTabForSaved = (state: Pick<AppState, 'tabs'>, id: string): QueryTab | null =>
  tabsForSaved(state, id).find((tab) =>
    tab.specDiagnostics?.some((diagnostic) => diagnostic.code === 'invalid-json')) || null;

const patchedSpec = (spec: QuerySpecDraft | null, patch: SpecPatch): QuerySpecDraft => (typeof patch === 'function'
  ? patch(cloneJson(spec))
  : patchQuerySpec({ spec }, patch).spec);

/**
 * Patch one valid open Spec draft without replacing unrelated unsaved fields.
 * External writers use this helper so text and parsed state stay synchronized.
 */
export function patchSpecDraft(
  tab: QueryTab | null | undefined,
  patch: SpecPatch,
  { dirty = true, validationService = defaultSpecValidationService }:
    { dirty?: boolean; validationService?: SpecValidationService } = {},
): PatchDraftResult {
  if (!tab) return { ok: false, invalidTab: null };
  if (tab.specDiagnostics?.some((diagnostic) => diagnostic.code === 'invalid-json')) {
    return { ok: false, invalidTab: tab };
  }
  const spec = patchedSpec(tab.specParsed, patch);
  const diagnostics = validationService.validate(spec, { sql: tab.sqlDraft, tab });
  if (hasBlockingSpecErrors(diagnostics)) return { ok: false, invalidTab: tab, diagnostics };
  setTabSpecDraft(tab, spec, { dirty, validationService });
  tab.name = queryName({ spec: tab.specParsed });
  // `!`: setTabSpecDraft above just assigned a parsed (non-null) draft — see
  // the QueryTab.specParsed invariant.
  return { ok: true, invalidTab: null, spec: tab.specParsed! };
}

/** The saved query a tab is linked to (via tab.savedId), or null. Narrowed to
 *  exactly the slice it reads (`savedQueries`) — not the full `AppState` —
 *  so a caller (e.g. `WorkbenchSession`'s own state slice) can pass a Pick
 *  without a bridging cast. */
export function savedForTab(
  state: Pick<AppState, 'savedQueries'>, tab: Pick<QueryTab, 'savedId'> | null | undefined,
): SavedQueryV2 | null {
  return (tab && tab.savedId && state.savedQueries.find((q) => q.id === tab.savedId)) || null;
}

/** Clear links from open tabs to saved queries that are absent from a newly
 * committed workspace. The SQL draft stays open; only the invalid association
 * and its Spec-only editor mode are reset, matching deleteSaved(). */
export function reconcileTabsWithSavedQueries(
  state: Pick<AppState, 'tabs' | 'savedQueries'>,
): void {
  const savedIds = new Set(state.savedQueries.map((query) => query.id));
  for (const tab of state.tabs.value) {
    if (tab.savedId && !savedIds.has(tab.savedId)) {
      tab.savedId = null;
      tab.editorMode = 'sql';
      tab.lastCommittedQueryToken = undefined; // #343: no linked query ⇒ no in-sync baseline
    }
  }
}

/** Adopt a committed saved query wholesale into a linked tab (#343 §8): replace
 *  its SQL, parsed Spec + Spec text, name, and saved version from `query`; keep
 *  the link; clear both dirty flags and any external-change flag; and record the
 *  query's token as this tab's new in-sync baseline. Used by the clean-tab
 *  `adopt` reconcile action and by the "Reload saved version" conflict
 *  resolution. Pure tab mutation — the caller re-syncs the editor + repaints. */
export function adoptSavedIntoTab(
  tab: QueryTab, query: SavedQueryV2,
  validationService: SpecValidationService = defaultSpecValidationService,
): void {
  tab.name = queryName(query);
  tab.sqlDraft = query.sql;
  tab.specVersion = query.specVersion;
  setTabSpecDraft(tab, cloneJson(query.spec), { dirty: false, validationService });
  tab.dirtySql = false;
  tab.lastCommittedQueryToken = queryToken(query);
  tab.externalState = null;
}

/** Summary of one linked-tab reconcile pass (`reconcileLinkedTabsToLatest`). */
export interface LinkedTabReconcileSummary {
  /** Any tab's content, link, or external-change flag changed — the caller must
   *  repaint the tab strip and re-sync the editors from state. */
  changed: boolean;
  /** How many tabs are left in an unresolved `'conflict'` state after the pass. */
  conflicts: number;
}

/** Reconcile every open linked tab against the latest committed workspace
 *  (#343 §8): classify each tab with the pure `reconcileLinkedTabs` planner,
 *  then apply the tab-side effect —
 *   - `adopt`    (clean, its saved query changed): adopt the latest query;
 *   - `conflict` (dirty, its saved query changed): keep the draft, flag it;
 *   - `detach`   (clean, its saved query was deleted): drop the link, SQL mode;
 *   - `orphan`   (dirty, its saved query was deleted): keep the draft as an
 *                 unsaved tab, flag `'deleted'` (Save then follows Save-as-new,
 *                 never recreating the query);
 *   - `noop`: nothing.
 *  Snapshots are taken from the CURRENT tabs, so the caller must run this
 *  BEFORE projecting the loaded workspace — projection (via
 *  `reconcileTabsWithSavedQueries`) nulls deleted links, which would otherwise
 *  erase the orphan/detach distinction. Pure over the tab objects. */
export function reconcileLinkedTabsToLatest(
  state: Pick<AppState, 'tabs'>,
  latest: StoredWorkspaceV1 | null,
  validationService: SpecValidationService = defaultSpecValidationService,
): LinkedTabReconcileSummary {
  const tabs = state.tabs.value;
  const snapshots: LinkedTabSnapshot[] = tabs.map((tab) => ({
    id: tab.id, savedId: tab.savedId,
    dirtySql: tab.dirtySql, dirtySpec: tab.dirtySpec,
    lastCommittedQueryToken: tab.lastCommittedQueryToken ?? '',
  }));
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  let changed = false;
  let conflicts = 0;
  for (const plan of reconcileLinkedTabs(latest, snapshots)) {
    const tab = byId.get(plan.tabId)!;
    if (plan.action === 'adopt') {
      adoptSavedIntoTab(tab, plan.query!, validationService);
      changed = true;
    } else if (plan.action === 'conflict') {
      conflicts += 1;
      if (tab.externalState !== 'conflict') { tab.externalState = 'conflict'; changed = true; }
    } else if (plan.action === 'detach') {
      tab.savedId = null;
      tab.editorMode = 'sql';
      tab.lastCommittedQueryToken = undefined;
      tab.externalState = null;
      changed = true;
    } else if (plan.action === 'orphan') {
      tab.savedId = null;
      tab.lastCommittedQueryToken = undefined;
      tab.externalState = 'deleted';
      changed = true;
    } else if (tab.savedId && tab.externalState === 'conflict') {
      // `noop` on a still-linked tab: the divergence disappeared (the other tab
      // reverted, or this draft matches the baseline again) — a stale conflict
      // flag would leave "Resolve conflict" with nothing to resolve. The
      // `'deleted'` flag is NOT cleared here: an orphaned tab has savedId null
      // and keeps its badge until the user acts on the draft.
      tab.externalState = null;
      changed = true;
    }
  }
  return { changed, conflicts };
}

/**
 * Create a saved query from an unsaved or dangling-linked tab. Tabs whose link
 * still resolves use commitSavedQuery() instead, so popover metadata can never
 * compete with the textual Spec draft.
 * Narrowed to `Pick<AppState, 'savedQueries' | 'resultView' | 'libraryDirty'>`
 * (#276 Phase 4C — the exact fields read/written) instead of full `AppState`,
 * same convention as `savedForTab`/`recordScriptHistory` — every real caller
 * (app.ts's own `SavedQueryService`) already has a full `AppState` to pass,
 * which satisfies this directly.
 */
export async function createSavedQuery(
  state: Pick<AppState, 'savedQueries' | 'resultView' | 'libraryDirty' | 'libraryName' | 'workspaceId' | 'dashboard'>,
  tab: QueryTab | null | undefined, name: unknown, description: unknown,
  mutate: MutateWorkspace, now: number = Date.now(),
  validationService: SpecValidationService = defaultSpecValidationService,
): Promise<SavedEntryResult> {
  if (!tab || savedForTab(state, tab)) return { ok: false, entry: null };
  const sql = String(tab.sqlDraft || '');
  const nm = String(name || '').trim();
  const panel = tabPanel(tab);
  // The save guard relaxes per panel type (#166): a text panel is authored
  // entirely in its cfg, so `sql: ''` is allowed for that type ONLY.
  // (`cfg!`: every panel this save path sees carries a cfg — the schema marks
  // cfg optional only for forward compatibility.)
  const sqlOptional = panel && panel.cfg!.type === 'text';
  if ((!sql.trim() && !sqlOptional) || !nm) return { ok: false, entry: null };
  const desc = String(description || '').trim();
  // Remember the current result view (Table/JSON/Panel) so a restore reopens the
  // same data representation; the transient raw view isn't persisted.
  const view = SAVED_VIEWS.has(state.resultView.value) ? state.resultView.value : undefined;
  const favorite = queryFavorite({ spec: tab.specParsed });
  const draft = patchQuerySpec(withQuerySpec({ sql }, tab.specParsed), {
    name: nm,
    favorite,
    description: desc || undefined,
    panel: panel || undefined,
    view,
  });
  const entry = asSavedEntry(withQuerySpec({ ...draft, id: makeId('s', now), sql }, normalizeSpec(draft.spec)));
  if (hasBlockingSpecErrors(validationService.validate(entry.spec, { sql, query: entry, tab }))) {
    return { ok: false, entry: null };
  }
  // COMPUTE only above this line — no `state`/`tab` mutation yet. Fold the new
  // query into the LATEST committed aggregate (read at dequeue), APPENDING to
  // `latest.queries` and preserving `latest.dashboard` byte-for-byte: a new
  // query must never restore an older Dashboard from Workbench memory (#343).
  const outcome = await mutate((latest) => {
    const base = baselineWorkspace(state, latest);
    return { candidate: candidateFrom(base, [entry, ...base.queries]), data: entry };
  });
  // create never ABORTS (its transform always yields a valid candidate); the
  // only failure is a rejected commit carrying diagnostics.
  if (!outcome.ok) {
    return { ok: false, entry: null, diagnostics: outcome.aborted ? undefined : outcome.diagnostics };
  }
  // APPLY only after `ok: true` — `mutateWorkspace` already projected the
  // canonical committed queries onto `state`; link the tab to the committed
  // entry (single source of truth) and mark the Library dirty.
  const saved = committedEntry(outcome.workspace.queries, entry.id, entry);
  tab.savedId = saved.id;
  tab.specVersion = SPEC_VERSION;
  tab.sqlDraft = saved.sql;
  tab.dirtySql = false;
  tab.name = queryName(saved);
  setTabSpecDraft(tab, saved.spec, { validationService });
  // #343: the tab is now in sync with the just-committed query — record its
  // token as the in-sync baseline and clear any deleted-elsewhere flag (a
  // Save-as-new over an orphaned draft re-links this tab to a fresh query).
  tab.lastCommittedQueryToken = queryToken(saved);
  tab.externalState = null;
  state.libraryDirty.value = true;
  return { ok: true, entry: saved };
}

/** Atomically persist both documents of a linked tab in one strict aggregate
 *  commit over `latest` (#343). Narrowed to the exact fields
 *  `baselineWorkspace`/the candidate need, same convention as `createSavedQuery`
 *  above. */
export async function commitSavedQuery(
  state: Pick<AppState, 'savedQueries' | 'resultView' | 'libraryDirty' | 'libraryName' | 'workspaceId' | 'dashboard'>,
  tab: QueryTab, spec: QuerySpecDraft | null | undefined,
  mutate: MutateWorkspace,
  validationService: SpecValidationService = defaultSpecValidationService,
): Promise<SavedEntryResult> {
  if (!tab.savedId || !spec) return { ok: false, entry: null };
  const savedId = tab.savedId;
  // The result-view signal is the live UI source. Table/JSON/Panel are
  // persistable; Filter is a role-owned transient preview and must retain any
  // dormant saved view already present in the Spec (#244). These guards read
  // only the captured tab/spec (never `latest`), so they run before queueing.
  const view = state.resultView.value;
  const persistedView = SAVED_VIEWS.has(view) ? view as 'table' | 'json' | 'panel' : null;
  const normalized = normalizeSpec(persistedView ? { ...spec, view: persistedView } : spec);
  const sql = String(tab.sqlDraft || '');
  const diagnostics = validationService.validate(normalized, { sql, tab });
  if (hasBlockingSpecErrors(diagnostics)) return { ok: false, entry: null };
  const panel = queryPanel({ spec: normalized });
  if (!sql.trim() && panel?.cfg?.type !== 'text') return { ok: false, entry: null };
  // Resolve the saved resource by ID against `latest.queries` INSIDE the
  // transform (#343): if the query was deleted externally, abort (null
  // candidate) rather than recreating it; otherwise replace ONLY that query and
  // preserve every other latest query + the latest Dashboard.
  const outcome = await mutate((latest) => {
    const base = baselineWorkspace(state, latest);
    const index = base.queries.findIndex((query) => query.id === savedId);
    if (index < 0) return null;
    const entry = asSavedEntry(withQuerySpec({ id: base.queries[index].id, sql }, normalized));
    const nextQueries = base.queries.slice();
    nextQueries[index] = entry;
    return { candidate: candidateFrom(base, nextQueries), data: entry };
  });
  if (!outcome.ok) {
    // The transform's only abort is the target missing from `latest.queries`
    // (#343: deleted in another tab) — flag it so the caller can refresh the
    // tab association instead of treating it as an anonymous rejection.
    return outcome.aborted
      ? { ok: false, entry: null, deletedExternally: true }
      : { ok: false, entry: null, diagnostics: outcome.diagnostics };
  }
  const built = outcome.data!;
  const saved = committedEntry(outcome.workspace.queries, built.id, built);
  tab.specVersion = SPEC_VERSION;
  tab.name = queryName(saved);
  tab.dirtySql = false;
  setTabSpecDraft(tab, saved.spec, { validationService });
  // #343: back in sync with the committed query — refresh the baseline token and
  // clear any conflict flag ("Keep my draft" resolves a conflict via this path).
  tab.lastCommittedQueryToken = queryToken(saved);
  tab.externalState = null;
  state.libraryDirty.value = true;
  return { ok: true, entry: saved };
}

/** A pure transform folded into the SAME commit candidate as a `patchSavedSpec`
 *  write (#299) — e.g. `toggleFavorite` reflects its favorite flip onto
 *  Dashboard tile membership atomically alongside the Spec patch. Defaults to
 *  identity, so `renameSaved`/other callers that don't touch the Dashboard are
 *  unaffected. Receives the COMMITTED entry (the one about to be sent to
 *  `commit`, post-patch) so a role/id-dependent transform sees the final Spec. */
export type DashboardTransform = (dashboard: DashboardDocumentV1 | null, entry: SavedQueryV2) => DashboardDocumentV1 | null;

const identityDashboardTransform: DashboardTransform = (dashboard) => dashboard;

/**
 * Generic committed-Spec writer for pencil/star/future controls. The patch is
 * applied independently to the persisted entry and every linked valid draft,
 * preserving unrelated unsaved fields. Invalid JSON blocks the whole write.
 * Narrowed to `Pick<AppState, 'savedQueries' | 'tabs' | 'libraryDirty'>`
 * (#276 Phase 4C — `tabs` via `invalidSpecTabForSaved`/`tabsForSaved`, both
 * narrowed the same way above), same convention as `createSavedQuery`/
 * `commitSavedQuery`. `renameSaved`/`toggleFavorite` below keep passing a
 * full `AppState` through unchanged (it satisfies this directly).
 */
export async function patchSavedSpec(
  state: Pick<AppState, 'savedQueries' | 'tabs' | 'libraryDirty' | 'libraryName' | 'workspaceId' | 'dashboard'>,
  id: string, patch: SpecPatch,
  mutate: MutateWorkspace,
  validationService: SpecValidationService = defaultSpecValidationService,
  transformDashboard: DashboardTransform = identityDashboardTransform,
): Promise<PatchSavedResult> {
  const invalidTab = invalidSpecTabForSaved(state, id);
  if (invalidTab) return { ok: false, invalidTab, entry: null };
  // The PERSISTED entry patch + Dashboard membership fold into the LATEST
  // workspace (#343): resolve the entry by id against `latest.queries` (not
  // stale `state`), derive tile membership from `latest.dashboard`, and preserve
  // every other latest query. Validation runs INSIDE the transform, entry
  // FIRST then each linked draft (matching the pre-#343 order): the transform
  // returns null (aborts) when the patched entry Spec blocks (`entryDiagnostics`
  // set), a linked draft blocks (`blockedDraft` set), or the entry was deleted
  // externally (absent from `latest` — neither set).
  let entryDiagnostics: SpecDiagnostic[] | null = null;
  let blockedDraft: { tab: QueryTab; diagnostics: SpecDiagnostic[] } | null = null;
  let draftUpdates: { tab: QueryTab; spec: QuerySpecDraft; dirty: boolean }[] = [];
  const outcome = await mutate((latest) => {
    const base = baselineWorkspace(state, latest);
    const index = base.queries.findIndex((query) => query.id === id);
    if (index < 0) return null;
    const entry = asSavedEntry(withQuerySpec(base.queries[index], patchedSpec(base.queries[index].spec, patch)));
    const entryDiag = validationService.validate(entry.spec, { sql: entry.sql, query: entry });
    if (hasBlockingSpecErrors(entryDiag)) { entryDiagnostics = entryDiag; return null; }
    // The linked-DRAFT patches apply to LOCAL tabs (not `latest`); patch +
    // validate each, preserving unrelated unsaved fields.
    draftUpdates = tabsForSaved(state, id).map((tab) => ({
      tab, spec: patchedSpec(tab.specParsed, patch), dirty: tab.dirtySpec,
    }));
    for (const update of draftUpdates) {
      const draftDiag = validationService.validate(update.spec, { sql: update.tab.sqlDraft, tab: update.tab });
      if (hasBlockingSpecErrors(draftDiag)) { blockedDraft = { tab: update.tab, diagnostics: draftDiag }; return null; }
    }
    const nextQueries = base.queries.slice();
    nextQueries[index] = entry;
    return { candidate: candidateFrom(base, nextQueries, transformDashboard(base.dashboard, entry)), data: entry };
  });
  if (!outcome.ok) {
    // A rejected COMMIT (schema/persistence) surfaces its bridged diagnostics.
    if (!outcome.aborted) {
      return { ok: false, invalidTab: null, entry: null, diagnostics: asSpecDiagnostics(outcome.diagnostics) };
    }
    // ABORTED plan guard: a blocking patched entry Spec surfaces its diagnostics
    // (invalidTab null); a blocking linked draft identifies its tab; an entry no
    // longer present in `latest` (deleted externally) aborts quietly (nothing to
    // patch), leaving the tab association to be refreshed.
    if (entryDiagnostics) return { ok: false, invalidTab: null, entry: null, diagnostics: entryDiagnostics };
    // `blockedDraft` is assigned inside a `for` loop nested in the `mutate`
    // closure above; TS's control-flow narrowing loses the loop-nested closure
    // assignment and collapses it to `never` at this read. The runtime value is
    // the object-or-null the closure set, so re-assert its declared union.
    const blocked = blockedDraft as { tab: QueryTab; diagnostics: SpecDiagnostic[] } | null;
    if (blocked) return { ok: false, invalidTab: blocked.tab, entry: null, diagnostics: blocked.diagnostics };
    return { ok: false, invalidTab: null, entry: null };
  }
  // `mutateWorkspace` already projected the committed queries + Dashboard onto
  // `state` (single source of truth for whether/how tile membership landed).
  const built = outcome.data!;
  const saved = committedEntry(outcome.workspace.queries, built.id, built);
  const savedToken = queryToken(saved);
  for (const update of draftUpdates) {
    setTabSpecDraft(update.tab, update.spec, { dirty: update.dirty, validationService });
    update.tab.name = queryName({ spec: update.spec });
    // #343: each linked tab is now measured against the freshly committed entry.
    update.tab.lastCommittedQueryToken = savedToken;
  }
  state.libraryDirty.value = true;
  return { ok: true, invalidTab: null, entry: saved };
}

/**
 * Rename a saved query, keeping any linked tab's name in sync. When
 * `description` is provided (not undefined) it is set/cleared too; pass
 * undefined to leave the existing description untouched (name-only rename).
 */
export async function renameSaved(
  state: AppState, id: string, name: unknown, description: string | null | undefined,
  mutate: MutateWorkspace,
  validationService: SpecValidationService = defaultSpecValidationService,
): Promise<PatchSavedResult | undefined> {
  const nm = String(name || '').trim();
  const index = state.savedQueries.findIndex((q) => q.id === id);
  const entry = index >= 0 ? state.savedQueries[index] : null;
  if (!entry || !nm) return;
  const patch: Partial<QuerySpecV1> = { name: nm };
  if (description !== undefined) {
    const desc = String(description || '').trim(); // match saveQuery: null/non-string → '' → cleared
    patch.description = desc || undefined;
  }
  return patchSavedSpec(state, id, patch, mutate, validationService);
}

/**
 * Toggle a saved query's favorite flag, atomically committing any Dashboard
 * tile-membership change the flip implies in the SAME candidate (#299): a
 * favorited panel-role query gets a tile (unless one already references it),
 * an unfavorited query loses every tile that references it. `spec.favorite`
 * stays the star's own visual state either way — this only ADDS the tile
 * side effect, it does not retire the favorite dual-write. `genId` mints a
 * Dashboard id when needed and the fresh tile id.
 */
export async function toggleFavorite(
  state: AppState, id: string,
  mutate: MutateWorkspace,
  genId: () => string,
  validationService: SpecValidationService = defaultSpecValidationService,
): Promise<PatchSavedResult | undefined> {
  const index = state.savedQueries.findIndex((q) => q.id === id);
  const entry = index >= 0 ? state.savedQueries[index] : null;
  if (!entry) return;
  // Star = explicit DESIRED membership (#343 §Operation intent): the UI derives
  // the desired boolean from the query it displays, and the transform re-checks
  // applicability against `latest` — tile membership is derived from
  // `latest.dashboard` (passed as `dashboard` below), never stale `state.dashboard`.
  const favorite = !queryFavorite(entry);
  return patchSavedSpec(state, id, { favorite }, mutate, validationService,
    (dashboard, patchedEntry) => toggleTileMembership(dashboard, patchedEntry, favorite, genId));
}

/** Saved queries with favorites first (stable within each group). */
export function sortedSaved(state: AppState): SavedQueryV2[] {
  return state.savedQueries
    .map((q, i): [SavedQueryV2, number] => [q, i])
    .sort((a, b) => (queryFavorite(b[0]) ? 1 : 0) - (queryFavorite(a[0]) ? 1 : 0) || a[1] - b[1])
    .map(([q]) => q);
}

/**
 * Filter saved queries by a free-text query (case-insensitive substring over
 * name, description and SQL). Blank query → the list returned unchanged. Pure.
 */
export function filterSaved(list: SavedQueryV2[], query: unknown): SavedQueryV2[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((it) =>
    queryName(it).toLowerCase().includes(q) ||
    queryDescription(it).toLowerCase().includes(q) ||
    (it.sql || '').toLowerCase().includes(q));
}

/** Filter history entries by a free-text query (case-insensitive over SQL). Pure. */
export function filterHistory(list: HistoryEntry[], query: unknown): HistoryEntry[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((ent) => (ent.sql || '').toLowerCase().includes(q));
}

/** The strict-commit result of `deleteSaved`/similar whole-collection ops
 *  that have no single "entry" to hand back. */
export type CommitOnlyResult = { ok: true } | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** Delete a saved query by id and clear any tab pointer to it — a strict
 *  aggregate commit (#287 W4): on `ok: false` NOTHING is mutated (the query
 *  and every tab pointer to it are left exactly as they were). */
export async function deleteSaved(
  state: Pick<AppState, 'savedQueries' | 'libraryDirty' | 'libraryName' | 'workspaceId' | 'dashboard'>,
  id: string, mutate: MutateWorkspace,
): Promise<CommitOnlyResult> {
  // Delete by ID from the LATEST workspace (#343): the whole-workspace
  // validation/repair policy runs against `latest.dashboard` (not a stale
  // Workbench Dashboard snapshot) via the commit inside `mutateWorkspace`.
  const outcome = await mutate((latest) => {
    const base = baselineWorkspace(state, latest);
    return { candidate: candidateFrom(base, base.queries.filter((q) => q.id !== id)) };
  });
  if (!outcome.ok) {
    // A delete never ABORTS (a filtered-out absent id yields the same query
    // set, always a valid candidate), so the only failure is a rejected commit
    // carrying diagnostics — the aborted arm is unreachable but stays honest
    // to the union instead of casting it away.
    return { ok: false, diagnostics: outcome.aborted ? [] : outcome.diagnostics };
  }
  // `mutateWorkspace`'s projection (`applyCommittedWorkspace`) already reconciled
  // tab links — any tab pointing at the now-absent query is detached to `sql`
  // mode by `reconcileTabsWithSavedQueries` — so nothing tab-side is left to do.
  state.libraryDirty.value = true;
  return { ok: true };
}

// Push one history entry (most-recent first, capped at 50). Internal — the
// exported recorders below supply the sql/rows/ms. Narrowed to `history`
// (the only field it reads/writes) so `recordScriptHistory` below can pass a
// narrower-than-`AppState` slice through unchanged.
function pushHistory(
  state: Pick<AppState, 'history'>, sql: string | null | undefined, rows: number | null, ms: number,
  save: SaveJSON, now: number,
): void {
  const s = String(sql || '').trim();
  if (!s) return;
  state.history.unshift({ id: makeId('h', now), sql: s, ts: now, rows, ms });
  state.history = state.history.slice(0, 50);
  save(KEYS.history, state.history);
}

/** The slice of a run's result `recordHistory` reads — a structural subset of
 * the results.js-owned result object (`QueryTab.result` stays opaque here). */
export interface HistoryResultSnapshot {
  rawText: string | null;
  rows: readonly unknown[];
  progress: { elapsed_ns: number };
}

/**
 * Record a successful run in history. `sqlText` overrides the recorded SQL (used
 * when a selection — not the whole tab — was run); it defaults to `tab.sqlDraft`.
 * Narrowed to `Pick<AppState, 'history'>` (#276 Phase 4C) — the only field
 * read/written (via `pushHistory`, already narrowed this way) — same
 * convention as `recordScriptHistory`; app.ts's own `SavedQueryService`
 * passes a `Pick` that also carries `savedQueries`/`resultView`/
 * `libraryDirty` for its other methods, which satisfies this directly.
 */
export function recordHistory(
  state: Pick<AppState, 'history'>,
  tab: { sqlDraft: string | null; result: HistoryResultSnapshot },
  save: SaveJSON = saveJSON, now: number = Date.now(), sqlText?: string | null,
): void {
  pushHistory(
    state,
    sqlText != null ? sqlText : tab.sqlDraft,
    tab.result.rawText != null ? null : tab.result.rows.length,
    Math.round(tab.result.progress.elapsed_ns / 1e6),
    save, now,
  );
}

/** Record a successful multiquery script run as one history entry (the whole
 *  script text); per-statement row counts aren't meaningful, so rows is null.
 *  Narrowed to `Pick<AppState, 'history'>` — the only field it reads/writes —
 *  so a caller (e.g. `WorkbenchSession`'s own state slice) can pass a Pick
 *  without a bridging cast. */
export function recordScriptHistory(
  state: Pick<AppState, 'history'>, sql: string, ms: number, save: SaveJSON = saveJSON, now: number = Date.now(),
): void {
  pushHistory(state, sql, null, Math.round(ms), save, now);
}

/** Clear all history. */
export function clearHistory(state: AppState, save: SaveJSON = saveJSON): void {
  state.history = [];
  save(KEYS.history, state.history);
}

/** Delete one history entry by id. */
export function deleteHistory(state: AppState, id: string, save: SaveJSON = saveJSON): void {
  state.history = state.history.filter((h) => h.id !== id);
  save(KEYS.history, state.history);
}
