// Application state: a plain object plus pure operations over it. Persistence
// is injected as a `save(key, value)` function (defaulting to storage.js), so
// every operation is unit-testable with a spy and no real localStorage.

import { clamp as clampUntyped } from './core/format.js';
import { mergeSaved as mergeSavedUntyped, validateLibraryQueries as validateLibraryQueriesUntyped } from './core/saved-io.js';
import {
  SPEC_VERSION, cloneJson, patchQuerySpec, queryDescription, queryFavorite, queryName,
  queryPanel, queryView, withQuerySpec,
} from './core/saved-query.js';
import type { QueryRoot } from './core/saved-query.js';
import { decodeStoredSavedQueries as decodeStoredSavedQueriesUntyped } from './core/library-codec.js';
import { normalizeDashLayout, normalizeDashCols } from './core/dashboard.js';
import {
  loadJSON as loadJSONUntyped, saveJSON as saveJSONUntyped,
  loadStr as loadStrUntyped, saveStr as saveStrUntyped,
} from './core/storage.js';
import { emptyRecentMap as emptyRecentMapUntyped } from './core/recent-values.js';
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
import type { QuerySpecV1, SavedQueryV2 } from './generated/json-schema.types.js';
import type { SpecDiagnostic } from './editor/spec-editor.types.js';

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
const saveStr: SaveStr = saveStrUntyped;

// mergeSaved mints a fresh string id for every merged entry that lacks one, so
// the canonical persisted SavedQueryV2 shape holds for the whole merged list.
const mergeSaved: (
  existing: SavedQueryV2[], incoming: readonly unknown[], genId: () => string,
) => { merged: SavedQueryV2[]; added: number; updated: number; skipped: number } = mergeSavedUntyped;

// validateLibraryQueries upgrades/validates each raw entry into the canonical
// `{id, sql, specVersion, spec}` shape (throwing on the first invalid one).
// `as`: the .js default parameter (`validationService = null`) makes TS infer
// the param as `null | undefined`; the runtime accepts any object with
// `.validate` (the SpecValidationService seam).
const validateLibraryQueries = validateLibraryQueriesUntyped as (
  queries: readonly unknown[], validationService: SpecValidationService | null,
) => SavedQueryV2[];

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

/**
 * Create a saved query from an unsaved tab. Linked tabs use commitSavedQuery()
 * instead, so popover metadata can never compete with the textual Spec draft.
 * Narrowed to `Pick<AppState, 'savedQueries' | 'resultView' | 'libraryDirty'>`
 * (#276 Phase 4C — the exact fields read/written) instead of full `AppState`,
 * same convention as `savedForTab`/`recordScriptHistory` — every real caller
 * (app.ts's own `SavedQueryService`) already has a full `AppState` to pass,
 * which satisfies this directly.
 */
export function createSavedQuery(
  state: Pick<AppState, 'savedQueries' | 'resultView' | 'libraryDirty'>,
  tab: QueryTab | null | undefined, name: unknown, description?: unknown,
  save: SaveJSON = saveJSON, now: number = Date.now(),
  validationService: SpecValidationService = defaultSpecValidationService,
): SavedQueryV2 | null {
  if (!tab || tab.savedId) return null;
  const sql = String(tab.sqlDraft || '');
  const nm = String(name || '').trim();
  const panel = tabPanel(tab);
  // The save guard relaxes per panel type (#166): a text panel is authored
  // entirely in its cfg, so `sql: ''` is allowed for that type ONLY.
  // (`cfg!`: every panel this save path sees carries a cfg — the schema marks
  // cfg optional only for forward compatibility.)
  const sqlOptional = panel && panel.cfg!.type === 'text';
  if ((!sql.trim() && !sqlOptional) || !nm) return null;
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
  if (hasBlockingSpecErrors(validationService.validate(entry.spec, { sql, query: entry, tab }))) return null;
  state.savedQueries.unshift(entry);
  tab.savedId = entry.id;
  tab.specVersion = SPEC_VERSION;
  tab.sqlDraft = entry.sql;
  tab.dirtySql = false;
  tab.name = queryName(entry);
  setTabSpecDraft(tab, entry.spec, { validationService });
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
  return entry;
}

/** Atomically persist both documents of a linked tab in one Library write.
 *  Narrowed to `Pick<AppState, 'savedQueries' | 'libraryDirty'>` (#276 Phase
 *  4C), same convention as `createSavedQuery` above. */
export function commitSavedQuery(
  state: Pick<AppState, 'savedQueries' | 'libraryDirty'>, tab: QueryTab, spec: QuerySpecDraft | null | undefined,
  save: SaveJSON = saveJSON,
  validationService: SpecValidationService = defaultSpecValidationService,
): SavedQueryV2 | null {
  const index = tab && tab.savedId ? state.savedQueries.findIndex((query) => query.id === tab.savedId) : -1;
  if (index < 0 || !spec) return null;
  const normalized = normalizeSpec(spec);
  const sql = String(tab.sqlDraft || '');
  const diagnostics = validationService.validate(normalized, { sql, tab });
  if (hasBlockingSpecErrors(diagnostics)) return null;
  const panel = queryPanel({ spec: normalized });
  if (!sql.trim() && panel?.cfg?.type !== 'text') return null;
  const current = state.savedQueries[index];
  const entry = asSavedEntry(withQuerySpec({ id: current.id, sql }, normalized));
  state.savedQueries[index] = entry;
  tab.specVersion = SPEC_VERSION;
  tab.name = queryName(entry);
  tab.dirtySql = false;
  setTabSpecDraft(tab, entry.spec, { validationService });
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
  return entry;
}

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
export function patchSavedSpec(
  state: Pick<AppState, 'savedQueries' | 'tabs' | 'libraryDirty'>, id: string, patch: SpecPatch,
  save: SaveJSON = saveJSON,
  validationService: SpecValidationService = defaultSpecValidationService,
): PatchSavedResult {
  const invalidTab = invalidSpecTabForSaved(state, id);
  if (invalidTab) return { ok: false, invalidTab, entry: null };
  const index = state.savedQueries.findIndex((query) => query.id === id);
  if (index < 0) return { ok: false, invalidTab: null, entry: null };
  const current = state.savedQueries[index];
  const entry = asSavedEntry(withQuerySpec(current, patchedSpec(current.spec, patch)));
  const entryDiagnostics = validationService.validate(entry.spec, { sql: entry.sql, query: entry });
  if (hasBlockingSpecErrors(entryDiagnostics)) {
    return { ok: false, invalidTab: null, entry: null, diagnostics: entryDiagnostics };
  }
  const draftUpdates = tabsForSaved(state, id).map((tab) => ({
    tab, spec: patchedSpec(tab.specParsed, patch), dirty: tab.dirtySpec,
  }));
  for (const update of draftUpdates) {
    const diagnostics = validationService.validate(update.spec, { sql: update.tab.sqlDraft, tab: update.tab });
    if (hasBlockingSpecErrors(diagnostics)) {
      return { ok: false, invalidTab: update.tab, entry: null, diagnostics };
    }
  }
  state.savedQueries[index] = entry;
  for (const update of draftUpdates) {
    setTabSpecDraft(update.tab, update.spec, { dirty: update.dirty, validationService });
    update.tab.name = queryName({ spec: update.spec });
  }
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
  return { ok: true, invalidTab: null, entry };
}

/**
 * Rename a saved query, keeping any linked tab's name in sync. When
 * `description` is provided (not undefined) it is set/cleared too; pass
 * undefined to leave the existing description untouched (name-only rename).
 */
export function renameSaved(
  state: AppState, id: string, name: unknown, description?: string | null,
  save: SaveJSON = saveJSON,
  validationService: SpecValidationService = defaultSpecValidationService,
): PatchSavedResult | undefined {
  const nm = String(name || '').trim();
  const index = state.savedQueries.findIndex((q) => q.id === id);
  const entry = index >= 0 ? state.savedQueries[index] : null;
  if (!entry || !nm) return;
  const patch: Partial<QuerySpecV1> = { name: nm };
  if (description !== undefined) {
    const desc = String(description || '').trim(); // match saveQuery: null/non-string → '' → cleared
    patch.description = desc || undefined;
  }
  return patchSavedSpec(state, id, patch, save, validationService);
}

/** Toggle a saved query's favorite flag. */
export function toggleFavorite(
  state: AppState, id: string,
  save: SaveJSON = saveJSON,
  validationService: SpecValidationService = defaultSpecValidationService,
): PatchSavedResult | undefined {
  const index = state.savedQueries.findIndex((q) => q.id === id);
  const entry = index >= 0 ? state.savedQueries[index] : null;
  if (!entry) return;
  const favorite = !queryFavorite(entry);
  return patchSavedSpec(state, id, { favorite }, save, validationService);
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

/**
 * Merge imported queries into savedQueries (dedupe by content, update by id,
 * else add). Returns { added, updated, skipped }.
 */
export function importSaved(
  state: AppState, queries: readonly unknown[],
  save: SaveJSON = saveJSON, genId: () => string = () => makeId('s', Date.now()),
): { added: number; updated: number; skipped: number } {
  const { merged, added, updated, skipped } = mergeSaved(state.savedQueries, queries, genId);
  state.savedQueries = merged;
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
  return { added, updated, skipped };
}

/** Delete a saved query by id and clear any tab pointer to it. */
export function deleteSaved(state: AppState, id: string, save: SaveJSON = saveJSON): void {
  state.savedQueries = state.savedQueries.filter((q) => q.id !== id);
  for (const t of tabsForSaved(state, id)) {
    t.savedId = null;
    t.editorMode = 'sql';
  }
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
}

// ── Library document ops ────────────────────────────────────────────────────
// The saved-query collection is a named, savable document. These ops back the
// header File menu (New / Save / Replace / Append) and the editable library
// name + unsaved-changes dot.

/** Clear tab→saved links whose entry no longer exists (after New/Replace), so a
 *  kept tab doesn't show "Saved" against a query that's gone. */
function pruneTabLinks(state: AppState): void {
  const ids = new Set(state.savedQueries.map((q) => q.id));
  for (const t of state.tabs.value) {
    if (t.savedId && !ids.has(t.savedId)) {
      t.savedId = null;
      t.editorMode = 'sql';
    }
  }
}

/** Rename the library (blank → the default name). Marks dirty; persists name. */
export function renameLibrary(state: AppState, name: unknown, saveName: SaveStr = saveStr): void {
  state.libraryName.value = String(name || '').trim() || DEFAULT_LIBRARY_NAME;
  state.libraryDirty.value = true;
  saveName(KEYS.libraryName, state.libraryName.value);
}

/** Start an empty, default-named library. Clears dirty; open tabs are kept
 *  (their now-dangling saved links are pruned). */
export function newLibrary(state: AppState, save: SaveJSON = saveJSON, saveName: SaveStr = saveStr): void {
  state.savedQueries = [];
  pruneTabLinks(state);
  state.libraryName.value = DEFAULT_LIBRARY_NAME;
  state.libraryDirty.value = false;
  save(KEYS.saved, state.savedQueries);
  saveName(KEYS.libraryName, state.libraryName.value);
}

/** Replace the library with `queries`, adopting the loaded file's base name.
 *  Unique ids are kept (lossless round-trip); missing OR duplicate ids get a fresh id.
 *  Clears dirty; open tabs are kept (dangling links pruned). */
export function replaceLibrary(
  state: AppState, queries: readonly Record<string, unknown>[], fileName: unknown,
  save: SaveJSON = saveJSON, saveName: SaveStr = saveStr,
  genId: () => string = () => makeId('s', Date.now()),
  validationService: SpecValidationService | false = defaultSpecValidationService,
): void {
  const validated = validationService === false ? queries : validateLibraryQueries(queries, validationService);
  const seen = new Set<unknown>();
  state.savedQueries = validated.map((q) => {
    // Mint a fresh id for a missing OR already-seen id so every saved row has a
    // unique id. The sidebar addresses rows by id (find/filter), so a duplicate
    // id would let one delete remove several rows and rename/favorite hit the
    // wrong one. (mergeSaved-based import already collapsed dup ids; keep parity.)
    let id = q.id;
    if (!id || seen.has(id)) { do { id = genId(); } while (seen.has(id)); }
    seen.add(id);
    return asSavedEntry(withQuerySpec({ ...q, id }, q.spec));
  });
  pruneTabLinks(state);
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  state.libraryName.value = base || DEFAULT_LIBRARY_NAME;
  state.libraryDirty.value = false;
  save(KEYS.saved, state.savedQueries);
  saveName(KEYS.libraryName, state.libraryName.value);
}

/** Append `queries` into the library via the standard merge dedupe (sets dirty
 *  through importSaved). Returns { added, updated, skipped }. */
export function appendLibrary(
  state: AppState, queries: readonly Record<string, unknown>[],
  save: SaveJSON = saveJSON,
  genId: () => string = () => makeId('s', Date.now()),
  validationService: SpecValidationService | false = defaultSpecValidationService,
): { added: number; updated: number; skipped: number } {
  return importSaved(state, validationService === false ? queries : validateLibraryQueries(queries, validationService), save, genId);
}

/** Mark the library as saved to a file (clears the unsaved-changes dot). */
export function markLibrarySaved(state: AppState): void {
  state.libraryDirty.value = false;
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
